import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "phone-remote.mjs");
const hasTmux = (() => { try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = !hasTmux && "tmux is not installed";

// A scratch world: its own tmux server (own socket file), its own state dir, its own Claude dir.
async function scratch() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "phone-remote-test-"));
  const sock = path.join(dir, "tmux.sock");
  const env = { ...process.env };
  delete env.TMUX;
  const tmux = (...args) => execFileSync("tmux", ["-S", sock, ...args], { env, encoding: "utf8" });
  return {
    dir, sock, tmux, env,
    async cleanup() {
      try { tmux("kill-server"); } catch { /* none running */ }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// Starts the real CLI and waits for its banner. Returns the first printed link and what is needed to talk to it.
async function startServerProcess(world, extraArgs = [], { env = {}, wait = true } = {}) {
  const args = [CLI, "--port", "0", "--no-qr", "--socket-path", world.sock, "--state-dir", path.join(world.dir, "state"),
    "--claude-dir", path.join(world.dir, "claude"), ...extraArgs];
  const child = spawn(process.execPath, args, { env: { ...world.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", c => { stdout += c; });
  child.stderr.on("data", c => { stderr += c; });
  const exited = new Promise(resolve => child.on("exit", code => resolve(code)));
  if (!wait) return { child, exited, get stdout() { return stdout; }, get stderr() { return stderr; } };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the server did not start:\n${stdout}\n${stderr}`)), 10000);
    const tick = setInterval(() => { if (/Press Ctrl-C/.test(stdout)) { clearInterval(tick); clearTimeout(timer); resolve(); } }, 30);
    exited.then(code => { clearInterval(tick); clearTimeout(timer); reject(new Error(`the server exited (${code}):\n${stdout}\n${stderr}`)); });
  });
  const link = /(https?:\/\/127\.0\.0\.1:\d+)\/(?:\?([^\s]*))?/.exec(stdout);
  const query = new URLSearchParams(link[2] || "");
  return {
    child, exited, base: link[1], token: query.get("token") || "", lang: query.get("lang") || "",
    get stdout() { return stdout; }, get stderr() { return stderr; },
    async stop() { child.kill("SIGTERM"); await Promise.race([exited, new Promise(r => setTimeout(r, 3000))]); child.kill("SIGKILL"); },
    api: (p, init = {}) => fetch(link[1] + p, { ...init, headers: { "x-auth-token": query.get("token") || "", ...(init.headers || {}) } }),
    post: (p, body) => fetch(link[1] + p, { method: "POST", headers: { "x-auth-token": query.get("token") || "", "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
}

async function withServer(extraArgs, fn, options) {
  const world = await scratch();
  let w;
  try {
    w = await startServerProcess(world, extraArgs, options);
    await fn(w, world);
  } finally {
    if (w && w.stop) await w.stop();
    await world.cleanup();
  }
}

// ---------- the page and its languages ----------

test("the page embeds the default dictionary and the default language code", { skip }, async () => {
  await withServer([], async w => {
    const html = await (await fetch(`${w.base}/`)).text();
    assert.ok(!html.includes("/*__I18N_DEFAULT__*/null") && !html.includes("/*__DEFAULT_LANG__*/"), "placeholders were not replaced");
    const zh = JSON.parse(await readFile(path.join(ROOT, "src/web/locales/zh-CN.json"), "utf8"));
    assert.ok(html.includes(JSON.stringify(zh["composer.send"])), "default dictionary is not embedded");
    assert.ok(html.includes('var DEFAULT_LANG = "zh-CN"'));
    assert.equal(html.split("</script>").length - 1, 1, "dictionary text must not be able to close the <script> tag");
  });
  await withServer(["--default-lang", "en"], async w => {
    const html = await (await fetch(`${w.base}/`)).text();
    assert.ok(html.includes('var DEFAULT_LANG = "en"'));
    assert.ok(html.includes('"composer.send":"Send"'));
  });
});

test("language files: ETag and 304, the index, and nothing outside the locale folder", { skip }, async () => {
  await withServer([], async w => {
    const res = await fetch(`${w.base}/locales/en.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal((await res.json())._name, "English");
    assert.equal((await fetch(`${w.base}/locales/en.json`, { headers: { "if-none-match": res.headers.get("etag") } })).status, 304);
    const { languages } = await (await fetch(`${w.base}/locales/index.json`)).json();
    assert.equal(languages[0].code, "zh-CN");
    assert.ok(languages.length >= 10);
    for (const p of ["/locales/..%2Fserver.mjs", "/locales/%2e%2e%2fserver.mjs", "/locales/xx.json", "/locales/en", "/locales/en.json%00",
      "/locales/.json", "/locales/a.b.json", "/locales/index.json.bak", "/locales/..%5Cserver.mjs"]) {
      assert.equal((await fetch(`${w.base}${p}`)).status, 404, `${p} should be 404`);
    }
  });
});

// ---------- who gets in ----------

test("a token is required, in a header only; /health and the page are open", { skip }, async () => {
  await withServer([], async w => {
    assert.equal((await fetch(`${w.base}/health`)).status, 200);
    assert.equal((await fetch(`${w.base}/`)).status, 200);
    for (const init of [{}, { headers: { "x-auth-token": "wrong" } }]) {
      const res = await fetch(`${w.base}/api/windows`, init);
      assert.equal(res.status, 401);
      assert.equal((await res.json()).error.code, "token_required");
    }
    // a token in the query string would end up in logs and history: it must not work
    assert.equal((await fetch(`${w.base}/api/windows?token=${w.token}`)).status, 401);
    assert.equal((await w.api("/api/windows")).status, 200);
  });
});

test("writes must be JSON (a cross-site form cannot send that)", { skip }, async () => {
  await withServer([], async w => {
    const res = await fetch(`${w.base}/api/send`, { method: "POST", headers: { "x-auth-token": w.token }, body: "{}" });
    assert.equal(res.status, 415);
    assert.equal((await res.json()).error.code, "bad_content_type");
    const text = await fetch(`${w.base}/api/send`, { method: "POST", headers: { "x-auth-token": w.token, "content-type": "text/plain" }, body: "{}" });
    assert.equal(text.status, 415);
    assert.equal((await w.post("/api/send", { pane: "zzz" })).status, 400);
  });
});

test("the source-IP allow-list refuses everyone else, and --allow-any opens it", { skip }, async () => {
  await withServer(["--allow-from", "203.0.113.0/24"], async w => {
    const res = await w.api("/api/windows");
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, "ip_not_allowed");
    assert.equal((await fetch(`${w.base}/`)).status, 403, "even the page is refused");
  });
  await withServer(["--allow-any"], async w => {
    assert.equal((await w.api("/api/windows")).status, 200);
    assert.match(w.stdout, /--allow-any/);
  });
});

test("--no-auth only starts on loopback, and then refuses requests that arrive under a foreign Host name", { skip }, async () => {
  const world = await scratch();
  try {
    const refused = await startServerProcess(world, ["--no-auth"], { wait: false });
    assert.equal(await refused.exited, 2);
    assert.match(refused.stderr, /loopback/);
  } finally { await world.cleanup(); }

  await withServer(["--no-auth", "--host", "127.0.0.1"], async w => {
    assert.equal((await fetch(`${w.base}/api/windows`)).status, 200, "no token needed");
    const port = new URL(w.base).port;
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/windows", headers: { host: "evil.example" } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(status, 403, "DNS rebinding: a page on evil.example resolving to 127.0.0.1 must not get in");
  });
});

// ---------- the token ----------

test("the token is generated once, kept private, and reused on the next start", { skip }, async () => {
  const world = await scratch();
  try {
    const first = await startServerProcess(world);
    const file = path.join(world.dir, "state", "token");
    assert.ok(existsSync(file));
    assert.equal(statSync(file).mode & 0o777, 0o600, "token file must be private");
    assert.equal((await readFile(file, "utf8")).trim(), first.token);
    assert.ok(first.token.length >= 20);
    await first.stop();
    const second = await startServerProcess(world);
    assert.equal(second.token, first.token);
    await second.stop();
    const given = await startServerProcess(world, ["--token", "my-own-token"]);
    assert.equal(given.token, "my-own-token");
    await given.stop();
  } finally { await world.cleanup(); }
});

// ---------- the banner ----------

test("the banner has a link with token and language; the QR code appears with --qr", { skip }, async () => {
  await withServer(["--lang", "ja"], async w => {
    assert.equal(w.lang, "ja");
    assert.match(w.stdout, /Open on your phone/);
    assert.ok(!w.stdout.includes("\x1b[30;47m"), "no QR code unless asked for when stdout is not a terminal");
  });
  await withServer(["--qr"], async w => {
    assert.ok(w.stdout.includes("\x1b[30;47m"), "QR code missing");
  });
  const world = await scratch();
  try {
    const noTmux = await startServerProcess(world, ["--tmux-bin", "/nonexistent/tmux"], { wait: false });
    assert.equal(await noTmux.exited, 2);
    assert.match(noTmux.stderr, /could not run tmux/);
    const taken = net.createServer();
    await new Promise(resolve => taken.listen(0, "127.0.0.1", resolve));
    const inUse = await startServerProcess(world, ["--host", "127.0.0.1", "--port", String(taken.address().port)], { wait: false });
    assert.equal(await inUse.exited, 1);
    assert.match(inUse.stderr, /could not listen/);
    taken.close();
  } finally { await world.cleanup(); }
});

test("the QR code comes last, as big or as small as asked, after the links and the notes", { skip }, async () => {
  await withServer(["--qr", "--qr-size", "large"], async w => {
    assert.ok(w.stdout.includes("\x1b[48;5;231m"), "big code (background colours)");
    assert.ok(!w.stdout.includes("\x1b[30;47m"));
    const at = text => w.stdout.indexOf(text);
    assert.ok(at("Open on your phone") < at("Token kept in"), "links, then notes");
    assert.ok(at("Token kept in") < at("Scan this with your phone"), "then the code");
    assert.ok(at("Scan this with your phone") < at("Press Ctrl-C"), "and it is the last thing before the prompt line");
  });
  await withServer(["--qr", "--qr-size", "compact"], async w => {
    assert.ok(w.stdout.includes("\x1b[30;47m") && !w.stdout.includes("\x1b[48;5;231m"));
  });
  await withServer(["--qr"], async w => {
    assert.ok(w.stdout.includes("\x1b[30;47m"), "auto: not a terminal, so no size to go by: compact");
  });
  const world = await scratch();
  try {
    const bad = await startServerProcess(world, ["--qr-size", "huge"], { wait: false });
    assert.equal(await bad.exited, 2);
    assert.match(bad.stderr, /--qr-size must be auto, large or compact/);
  } finally { await world.cleanup(); }
});

test("--open opens a private page with the code and deletes it again; nothing opens on its own from a pipe", { skip: skip || (process.platform !== "linux" && "the opener is stubbed for Linux") }, async () => {
  const world = await scratch();
  try {
    // an `xdg-open` that only records what it was asked to open
    mkdirSync(path.join(world.dir, "bin"));
    const opener = path.join(world.dir, "bin", "xdg-open");
    writeFileSync(opener, `#!/bin/sh\necho "$1" > "${path.join(world.dir, "opened.txt")}"\n`);
    chmodSync(opener, 0o755);
    const env = { PATH: `${path.join(world.dir, "bin")}:${process.env.PATH}`, DISPLAY: ":0" };

    // first run, but stdout is a pipe: no popup on its own
    const quiet = await startServerProcess(world, [], { env });
    await new Promise(r => setTimeout(r, 400));
    assert.ok(!existsSync(path.join(world.dir, "opened.txt")), "no popup from a pipe");
    await quiet.stop();

    const w = await startServerProcess(world, ["--open"], { env });
    try {
      let opened = "";
      for (let i = 0; i < 60 && !opened; i += 1) {
        try { opened = (await readFile(path.join(world.dir, "opened.txt"), "utf8")).trim(); } catch { await new Promise(r => setTimeout(r, 50)); }
      }
      assert.equal(opened, path.join(world.dir, "state", "pair.html"));
      assert.equal(statSync(opened).mode & 0o777, 0o600, "the page holds the token: owner only");
      const html = await readFile(opened, "utf8");
      assert.ok(html.includes("<svg") && html.includes(w.token), "the big code and the link with the token");
      assert.match(w.stdout, /just opened in your browser/);
      w.child.kill("SIGTERM");
      await w.exited;
      assert.ok(!existsSync(opened), "deleted when Phone Remote stops");
    } finally { await w.stop(); }

    rmOpened(world);
    const off = await startServerProcess(world, ["--open", "--no-open"], { env });
    await new Promise(r => setTimeout(r, 400));
    assert.ok(!existsSync(path.join(world.dir, "opened.txt")), "--no-open wins");
    await off.stop();
  } finally { await world.cleanup(); }
});

test("in a real terminal on a desktop the page opens by itself on the first run only", { skip: skip || (process.platform !== "linux" && "the opener is stubbed for Linux") }, async () => {
  const world = await scratch();
  try {
    mkdirSync(path.join(world.dir, "bin"));
    const opener = path.join(world.dir, "bin", "xdg-open");
    const opened = path.join(world.dir, "opened.txt");
    writeFileSync(opener, `#!/bin/sh\necho "$1" > "${opened}"\n`);
    chmodSync(opener, 0o755);
    // inside a tmux pane the CLI really has a terminal (isTTY, columns, rows); a desktop is faked with DISPLAY and no SSH variables
    const run = session => world.tmux("new-session", "-d", "-s", session, "-x", "100", "-y", "50",
      `env -u SSH_CONNECTION -u SSH_TTY PATH=${path.join(world.dir, "bin")}:$PATH DISPLAY=:0 node ${CLI} --port 0 --host 127.0.0.1 ` +
      `--socket-path ${world.sock} --state-dir ${path.join(world.dir, "state")} --claude-dir ${path.join(world.dir, "claude")}`);
    const screen = session => world.tmux("capture-pane", "-p", "-t", session);
    const waitFor = async (what, ok) => { for (let i = 0; i < 100; i += 1) { if (ok()) return; await new Promise(r => setTimeout(r, 50)); } assert.fail(what); };

    run("first");
    await waitFor("the banner of the first run", () => /Press Ctrl-C/.test(screen("first")));
    await waitFor("the opener was called on the first run", () => existsSync(opened));
    assert.equal(readFileSync(opened, "utf8").trim(), path.join(world.dir, "state", "pair.html"));
    assert.match(screen("first"), /Scan this with your phone/);
    assert.match(screen("first"), /just opened in your browser/);
    world.tmux("send-keys", "-t", "first", "C-c");
    await waitFor("the page is deleted when the first run stops", () => !existsSync(path.join(world.dir, "state", "pair.html")));
    rmOpened(world);

    run("second");                                                 // the token exists now: nothing new to pair
    await waitFor("the banner of the second run", () => /Press Ctrl-C/.test(screen("second")));
    await new Promise(r => setTimeout(r, 500));
    assert.ok(!existsSync(opened), "no popup on later runs");
    assert.match(screen("second"), /Scan this with your phone/, "but the code is still printed");
    world.tmux("send-keys", "-t", "second", "C-c");
  } finally { await world.cleanup(); }
});

function rmOpened(world) { try { rmSync(path.join(world.dir, "opened.txt")); } catch { /* not there */ } }

// ---------- the real thing: windows, agents, screen, input ----------

test("windows are listed with the program recognised; input goes in; the screen shows it", { skip }, async () => {
  const world = await scratch();
  try {
    // a process whose name is "claude" (a symlink to cat, so it just echoes what it is sent) and a plain shell
    mkdirSync(path.join(world.dir, "bin"));
    symlinkSync("/bin/cat", path.join(world.dir, "bin", "claude"));
    world.tmux("new-session", "-d", "-s", "demo", "-x", "100", "-y", "24", path.join(world.dir, "bin", "claude"));
    world.tmux("new-session", "-d", "-s", "plain", "-x", "100", "-y", "24", "bash --norc");
    const w = await startServerProcess(world);
    try {
      const { windows } = await (await w.api("/api/windows")).json();
      const byName = Object.fromEntries(windows.map(x => [x.session, x]));
      assert.equal(byName.demo.agent.kind, "claude");
      assert.equal(byName.demo.agent.label, "Claude Code");
      assert.equal(byName.plain.agent, undefined, "a plain shell is not an agent");

      const pane = byName.demo.pane_id;
      const sent = await (await w.post("/api/send", { pane, text: "hello from the phone", enter: true })).json();
      assert.deepEqual(sent.sent_keys, ["Enter"]);
      assert.equal(sent.agent, "claude");
      await new Promise(r => setTimeout(r, 400));
      const screen = await (await w.api(`/api/screen?pane=${encodeURIComponent(pane)}`)).json();
      assert.equal(screen.screen.filter(l => l.includes("hello from the phone")).length, 2, "echoed once by the tty and once by cat");
      // an unchanged screen is answered with a tiny reply, not the whole thing again
      const again = await (await w.api(`/api/screen?pane=${encodeURIComponent(pane)}&hash=${screen.hash}`)).json();
      assert.deepEqual(again, { unchanged: true, hash: screen.hash });

      // multi-line text is pasted as one block
      await w.post("/api/send", { pane, text: "first line\nsecond line", enter: true });
      await new Promise(r => setTimeout(r, 400));
      const multi = await (await w.api(`/api/screen?pane=${encodeURIComponent(pane)}`)).json();
      assert.ok(multi.screen.some(l => l.includes("second line")));

      // unknown keys are refused, never typed
      const bad = await w.post("/api/send", { pane, keys: ["rm -rf /"] });
      assert.equal(bad.status, 400);
      const body = await bad.json();
      assert.equal(body.error.code, "bad_key");
      assert.equal(body.error.key, "rm -rf /");
      // a pane that does not exist is a translated tmux error, not a crash
      const gone = await w.api(`/api/screen?pane=${encodeURIComponent("%99")}`);
      assert.equal(gone.status, 502);
      assert.equal((await gone.json()).error.code, "tmux_failed");
    } finally { await w.stop(); }
  } finally { await world.cleanup(); }
});

test("alternate-screen programs are sent without the scrollback tmux still holds", { skip }, async () => {
  const world = await scratch();
  try {
    world.tmux("new-session", "-d", "-s", "alt", "-x", "80", "-y", "20", "bash --norc -c 'seq 1 100; tput smcup; echo ON-ALT-SCREEN; sleep 60'");
    world.tmux("new-session", "-d", "-s", "norm", "-x", "80", "-y", "20", "bash --norc -c 'seq 1 100; echo NORMAL; sleep 60'");
    await new Promise(r => setTimeout(r, 800));
    const w = await startServerProcess(world);
    try {
      const { windows } = await (await w.api("/api/windows")).json();
      const pane = name => windows.find(x => x.session === name).pane_id;
      const alt = await (await w.api(`/api/screen?pane=${encodeURIComponent(pane("alt"))}&lines=200`)).json();
      assert.equal(alt.alternate, true);
      assert.ok(alt.history_size > 0);
      assert.equal(alt.history.length, 0);
      const norm = await (await w.api(`/api/screen?pane=${encodeURIComponent(pane("norm"))}&lines=200`)).json();
      assert.equal(norm.alternate, false);
      assert.ok(norm.history.length > 50);
    } finally { await w.stop(); }
  } finally { await world.cleanup(); }
});

test("an earlier Claude Code conversation is served in pages, newest first, from the session log", { skip }, async () => {
  const world = await scratch();
  try {
    mkdirSync(path.join(world.dir, "bin"));
    symlinkSync("/bin/cat", path.join(world.dir, "bin", "claude"));
    world.tmux("new-session", "-d", "-s", "demo", "-x", "100", "-y", "24", path.join(world.dir, "bin", "claude"));
    const pid = Number(world.tmux("display-message", "-p", "-t", "demo", "#{pane_pid}").trim());
    const pane = world.tmux("display-message", "-p", "-t", "demo", "#{pane_id}").trim();
    const cwd = "/work/demo project";
    const claude = path.join(world.dir, "claude");
    mkdirSync(path.join(claude, "sessions"), { recursive: true });
    const projects = path.join(claude, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(projects, { recursive: true });
    writeFileSync(path.join(claude, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: "s1", cwd, tmux: `sock.${pane}`, status: "busy", name: "demo" }));
    const lines = [];
    for (let i = 1; i <= 5; i += 1) {
      lines.push(JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:0" + i + "Z", message: { content: `question ${i} <system-reminder>noise</system-reminder>` } }));
      lines.push(JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:01:0" + i + "Z", message: { id: `m${i}`, content: [{ type: "text", text: `answer ${i}` }, { type: "tool_use", name: "Bash", input: { command: "ls -la" } }] } }));
    }
    writeFileSync(path.join(projects, "s1.jsonl"), lines.join("\n") + "\n");
    const w = await startServerProcess(world);
    try {
      const { windows } = await (await w.api("/api/windows")).json();
      assert.equal(windows[0].claude.status, "busy");
      assert.equal(windows[0].claude.name, "demo");
      const page1 = await (await w.api(`/api/transcript?pane=${encodeURIComponent(pane)}&limit=3`)).json();
      assert.equal(page1.available, true);
      assert.equal(page1.total, 10);
      assert.deepEqual(page1.entries.map(e => e.text.split("\n")[0]), ["answer 4", "question 5", "answer 5"]);
      assert.ok(page1.entries[2].text.includes("🔧 Bash: ls -la"));
      assert.ok(!page1.entries.some(e => e.text.includes("noise")), "injected reminders are stripped");
      assert.equal(page1.next_before, 7);
      const page2 = await (await w.api(`/api/transcript?pane=${encodeURIComponent(pane)}&before=${page1.next_before}&limit=100`)).json();
      assert.equal(page2.entries.length, 7);
      assert.equal(page2.next_before, null, "reached the start");
      const none = await (await w.api(`/api/transcript?pane=${encodeURIComponent("%77")}`)).json();
      assert.equal(none.available, false);
    } finally { await w.stop(); }
  } finally { await world.cleanup(); }
});

test("a Claude Code registered from another tmux server's pane with the same id is not attached to this window", { skip }, async () => {
  const world = await scratch();
  try {
    mkdirSync(path.join(world.dir, "bin"));
    symlinkSync("/bin/cat", path.join(world.dir, "bin", "claude"));
    world.tmux("new-session", "-d", "-s", "demo", "-x", "100", "-y", "24", path.join(world.dir, "bin", "claude"));
    const pane = world.tmux("display-message", "-p", "-t", "demo", "#{pane_id}").trim();
    const claude = path.join(world.dir, "claude");
    mkdirSync(path.join(claude, "sessions"), { recursive: true });
    // this test runner is alive but not inside the pane — what a registration made through a different tmux server looks like
    writeFileSync(path.join(claude, "sessions", `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: "other", cwd: "/elsewhere", tmux: `other:@0.${pane}`, status: "busy", name: "stranger" }));
    const w = await startServerProcess(world);
    try {
      const { windows } = await (await w.api("/api/windows")).json();
      assert.equal(windows[0].claude, undefined, "the stranger's name and status do not show up on our window");
      const transcript = await (await w.api(`/api/transcript?pane=${encodeURIComponent(pane)}`)).json();
      assert.equal(transcript.available, false, "and neither does its conversation");
    } finally { await w.stop(); }
  } finally { await world.cleanup(); }
});

// ---------- HTTPS ----------

const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("--cert / --key serve HTTPS, and scripts/make-cert.sh produces a certificate the server accepts", { skip: skip || (!hasOpenssl && "openssl is not installed") }, async () => {
  const world = await scratch();
  try {
    const home = path.join(world.dir, "home");
    execFileSync(path.join(ROOT, "scripts", "make-cert.sh"), ["remote.test"], { env: { ...world.env, PHONE_REMOTE_HOME: home }, stdio: "ignore" });
    const cert = path.join(home, "tls", "cert.pem");
    const key = path.join(home, "tls", "key.pem");
    assert.equal(statSync(key).mode & 0o777, 0o600, "private key must be private");
    const w = await startServerProcess(world, ["--cert", cert, "--key", key, "--host", "127.0.0.1"]);
    try {
      assert.match(w.base, /^https:/);
      const status = await new Promise((resolve, reject) => {
        https.get(`${w.base}/health`, { rejectUnauthorized: false }, res => {
          let body = ""; res.on("data", c => { body += c; }); res.on("end", () => resolve({ code: res.statusCode, body: JSON.parse(body) }));
        }).on("error", reject);
      });
      assert.equal(status.code, 200);
      assert.equal(status.body.tls, true);
      assert.ok(!/Plain HTTP/.test(w.stdout), "no plain-HTTP advice when serving HTTPS");
    } finally { await w.stop(); }
  } finally { await world.cleanup(); }
});

// ---------- compression ----------

test("pages and big replies are gzipped for browsers that accept it, small replies and old clients get plain bytes", { skip }, async () => {
  await withServer([], async w => {
    const get = (p, headers) => new Promise((resolve, reject) => {
      http.get(`${w.base}${p}`, { headers: { "x-auth-token": w.token, ...headers } }, res => {
        const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => resolve({ res, body: Buffer.concat(chunks) }));
      }).on("error", reject);
    });
    const plain = await get("/", {});
    assert.equal(plain.res.headers["content-encoding"], undefined);
    const gz = await get("/", { "accept-encoding": "gzip" });
    assert.equal(gz.res.headers["content-encoding"], "gzip");
    assert.equal(gz.res.headers.vary, "Accept-Encoding");
    assert.ok(gz.body.length < plain.body.length / 2, `gzip should at least halve the page (${gz.body.length} vs ${plain.body.length})`);
    assert.equal((await import("node:zlib")).gunzipSync(gz.body).toString(), plain.body.toString(), "same bytes after decompression");
    // a tiny reply is not worth compressing
    const tiny = await get("/health", { "accept-encoding": "gzip" });
    assert.equal(tiny.res.headers["content-encoding"], undefined);
    // the ETag differs per encoding, so a cache can never mix them up
    const a = await get("/locales/en.json", { "accept-encoding": "gzip" });
    const b = await get("/locales/en.json", {});
    assert.notEqual(a.res.headers.etag, b.res.headers.etag);
    assert.equal((await get("/locales/en.json", { "accept-encoding": "gzip", "if-none-match": a.res.headers.etag })).res.statusCode, 304);
  });
});
