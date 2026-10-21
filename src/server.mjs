// The HTTP(S) server: the page, its language files, and the small JSON API behind it.
//
// Threat model in one line: whoever can send requests here can type into your terminals, which is the same as running
// commands as you. So every request goes through, in order: the source-IP allow-list, (without a token) a Host-header
// check against DNS rebinding, the access token, and for writes a JSON content type (which a cross-site form cannot send).

import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { describeAgent } from "./agents.mjs";
import { listClaudeSessions, loadTranscript } from "./claude-transcript.mjs";
import { fail } from "./errors.mjs";
import { hostHeaderOk, ipAllowed } from "./netguard.mjs";
import { MAX_HISTORY_LINES, PANE_RE, WINDOW_RE, agentDetector, listWindows, readScreen, sendInput, tmuxOrThrow } from "./tmux.mjs";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
const UI_FILE = path.join(WEB_DIR, "index.html");
export const LOCALE_DIR = path.join(WEB_DIR, "locales");

const TRANSCRIPT_PAGE_MAX = 200;
const MAX_BODY_BYTES = 1_000_000;
const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const LANG_ORDER = ["zh-CN", "en", "zh-TW", "ja", "ko", "es", "fr", "de", "pt", "ru"];   // order in the language menu; others follow by code

// ---------- language files ----------

export async function listLocales() {
  let names = [];
  try { names = await readdir(LOCALE_DIR); } catch { return []; }
  const out = [];
  for (const file of names) {
    const code = file.endsWith(".json") ? file.slice(0, -5) : "";
    if (!LANG_RE.test(code)) continue;
    try { out.push({ code, name: JSON.parse(await readFile(path.join(LOCALE_DIR, file), "utf8"))._name || code }); } catch { /* skip a broken file */ }
  }
  const rank = code => { const i = LANG_ORDER.indexOf(code); return i < 0 ? LANG_ORDER.length : i; };
  return out.sort((a, b) => rank(a.code) - rank(b.code) || a.code.localeCompare(b.code));
}

async function serveLocale(request, response, name) {
  if (name === "index.json") {
    sendJson(request, response, 200, { languages: await listLocales() });
    return;
  }
  // only "xx" / "xx-YY" shapes ever reach the file system path, so no "../" can
  const m = /^([A-Za-z0-9-]+)\.json$/.exec(name);
  if (!m || !LANG_RE.test(m[1])) throw fail("not_found", 404, "not found");
  let raw;
  try { raw = await readFile(path.join(LOCALE_DIR, `${m[1]}.json`)); } catch { throw fail("not_found", 404, "not found"); }
  // a few KB over a flaky mobile link: send an ETag so an unchanged file costs one 304
  const gz = acceptsGzip(request);
  const etag = `"${createHash("sha1").update(raw).digest("hex").slice(0, 16)}${gz ? "-gz" : ""}"`;
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, { etag, "cache-control": "no-cache", vary: "Accept-Encoding" });
    response.end();
    return;
  }
  respond(request, response, 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache", etag }, raw);
}

// ---------- small HTTP helpers ----------

const acceptsGzip = request => /\bgzip\b/i.test(String(request.headers["accept-encoding"] || ""));

// Everything over 1 KB is gzipped when the browser accepts it: the page shrinks from ~66 KB to ~20 KB and a full screen
// of JSON from ~8 KB to ~1.5 KB, which matters on a weak mobile connection (fewer packets, fewer retransmissions).
function respond(request, response, status, headers, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (buf.length > 1024 && acceptsGzip(request)) {
    response.writeHead(status, { ...headers, "content-encoding": "gzip", vary: "Accept-Encoding" });
    response.end(gzipSync(buf, { level: 6 }));
  } else {
    response.writeHead(status, { ...headers, vary: "Accept-Encoding" });
    response.end(buf);
  }
}

function sendJson(request, response, status, payload) {
  respond(request, response, status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, JSON.stringify(payload));
}

async function readJsonBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) throw fail("body_too_large", 413, "request body too large");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw fail("bad_json", 400, "request body is not valid JSON");
  }
}

function clientIp(request) {
  return String(request.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

function tokenOk(config, request) {
  if (!config.token) return true;
  const given = Buffer.from(String(request.headers["x-auth-token"] || ""));
  const expected = Buffer.from(config.token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const redact = url => String(url).replace(/([?&]token=)[^&\s]*/g, "$1…");

// ---------- the page ----------

async function pageHtml(config) {
  // The default language's dictionary goes straight into the page (the first paint already has its words); "<" is
  // escaped so no text in a dictionary can close the <script> tag early.
  const dict = JSON.stringify(JSON.parse(await readFile(path.join(LOCALE_DIR, `${config.defaultLang}.json`), "utf8"))).replace(/</g, "\\u003c");
  return (await readFile(UI_FILE, "utf8"))
    .replace("/*__I18N_DEFAULT__*/null", () => dict)
    .replace('/*__DEFAULT_LANG__*/"zh-CN"', () => JSON.stringify(config.defaultLang));
}

// ---------- the server ----------

export function createHandler(config, log = console) {
  const seenClients = new Set();
  return async (request, response) => {
    try {
      const ip = clientIp(request);
      if (!config.allowAny && !ipAllowed(config.allowRules, ip)) {
        log.error(`[phone-remote] refused ${ip}: not in the allow-list (--allow-from)`);
        throw fail("ip_not_allowed", 403, "source IP is not allowed");
      }
      if (!seenClients.has(ip)) {
        seenClients.add(ip);
        log.log(`[phone-remote] new client ${ip}`);
      }
      if (config.noAuth && !hostHeaderOk(request.headers.host)) throw fail("bad_host", 403, "unexpected Host header");
      const url = new URL(request.url || "/", "http://local");
      const route = url.pathname;

      if (request.method === "GET" && (route === "/" || route === "/index.html")) {
        respond(request, response, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, await pageHtml(config));
        return;
      }
      if (request.method === "GET" && route === "/health") {
        sendJson(request, response, 200, { status: "ok", auth: Boolean(config.token), tls: config.tls });
        return;
      }
      if (request.method === "GET" && route.startsWith("/locales/")) {
        await serveLocale(request, response, route.slice("/locales/".length));
        return;
      }
      if (!route.startsWith("/api/")) throw fail("not_found", 404, "not found");
      if (!tokenOk(config, request)) throw fail("token_required", 401, "access token required");
      if (request.method === "POST" && !/^application\/json\b/i.test(String(request.headers["content-type"] || ""))) {
        throw fail("bad_content_type", 415, "requests must be sent as application/json");
      }

      if (request.method === "GET" && route === "/api/windows") {
        const windows = await listWindows(config);
        // which window runs which Claude Code session, and whether it is busy
        const byPane = new Map((await listClaudeSessions(config.claudeDir)).map(s => [s.pane_id, s]));
        // what program each window runs (Claude Code / Codex / OpenCode): the page swaps labels and the quick menu on it
        const found = await Promise.all(windows.map(w => agentDetector.detect(w.pane_pid)));
        windows.forEach((w, i) => {
          const s = byPane.get(w.pane_id);
          if (s) w.claude = { name: s.name, status: s.status, session_id: s.session_id, updated_at: s.updated_at };
          const agent = describeAgent(found[i] ? found[i].kind : (s ? "claude" : ""));
          if (agent) w.agent = agent;
        });
        sendJson(request, response, 200, { windows });
        return;
      }
      // The Claude Code conversation of a pane, paged backwards: no `before` = from the newest, next_before null = reached the start.
      if (request.method === "GET" && route === "/api/transcript") {
        const pane = url.searchParams.get("pane") || "";
        if (!PANE_RE.test(pane)) throw fail("bad_pane", 400, "pane should look like %3");
        const match = (await listClaudeSessions(config.claudeDir)).find(s => s.pane_id === pane);
        if (!match) { sendJson(request, response, 200, { available: false, reason: "no Claude Code session in this window" }); return; }
        let entries;
        try { entries = await loadTranscript(match.transcript); }
        catch { sendJson(request, response, 200, { available: false, reason: "session log not found" }); return; }
        const total = entries.length;
        const limit = Math.max(1, Math.min(TRANSCRIPT_PAGE_MAX, Number(url.searchParams.get("limit") || 20) || 20));
        const beforeRaw = url.searchParams.get("before");
        const before = (beforeRaw === null || beforeRaw === "") ? total : Math.max(0, Math.min(total, Number(beforeRaw) || 0));
        const start = Math.max(0, before - limit);
        sendJson(request, response, 200, {
          available: true, session_id: match.session_id, name: match.name, status: match.status,
          total, start, entries: entries.slice(start, before), next_before: start > 0 ? start : null,
        });
        return;
      }
      if (request.method === "GET" && route === "/api/screen") {
        const pane = url.searchParams.get("pane") || "";
        if (!PANE_RE.test(pane)) throw fail("bad_pane", 400, "pane should look like %3");
        const lines = Math.max(0, Math.min(MAX_HISTORY_LINES, Number(url.searchParams.get("lines") || 200) || 0));
        const payload = await readScreen(config, pane, lines);
        if (url.searchParams.get("hash") === payload.hash) {
          sendJson(request, response, 200, { unchanged: true, hash: payload.hash });
          return;
        }
        sendJson(request, response, 200, payload);
        return;
      }
      if (request.method === "POST" && route === "/api/send") {
        const body = await readJsonBody(request);
        const pane = String(body.pane || "");
        if (!PANE_RE.test(pane)) throw fail("bad_pane", 400, "pane should look like %3");
        sendJson(request, response, 200, { status: "ok", ...(await sendInput(config, pane, body)) });
        return;
      }
      // Also switch the real tmux client (the one on the desktop) to this window; the page's own view does not depend on it.
      if (request.method === "POST" && route === "/api/select") {
        const body = await readJsonBody(request);
        const windowId = String(body.window_id || "");
        if (!WINDOW_RE.test(windowId)) throw fail("bad_window_id", 400, "window_id should look like @3");
        await tmuxOrThrow(config, ["select-window", "-t", windowId]);
        sendJson(request, response, 200, { status: "ok" });
        return;
      }
      throw fail("not_found", 404, "not found");
    } catch (error) {
      const status = error.status || 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) log.error(`[phone-remote] ${request.method} ${redact(request.url)}: ${message}`);
      if (response.headersSent) response.end();
      else sendJson(request, response, status, { error: { ...(error.params || {}), code: error.code, message } });
    }
  };
}

// config: { host, port, cert, key, token, noAuth, allowAny, allowRules, tmuxBin, socketArgs, claudeDir, defaultLang }
export async function startServer(config, log = console) {
  const tls = Boolean(config.cert && config.key);
  const handler = createHandler({ ...config, tls }, log);
  const server = tls
    ? createHttps({ cert: await readFile(config.cert), key: await readFile(config.key) }, handler)
    : createHttp(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  return {
    server,
    port: server.address().port,
    scheme: tls ? "https" : "http",
    close() {
      return new Promise(resolve => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        setTimeout(resolve, 1500).unref();
      });
    },
  };
}
