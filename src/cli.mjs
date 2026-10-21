// Command line: options, the access token, the startup banner (links + QR code), and starting the server.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { DEFAULT_ALLOW_FROM, isLoopbackHost, parseAllowList, parseIp } from "./netguard.mjs";
import { renderQr } from "./qr.mjs";
import { listLocales, startServer } from "./server.mjs";
import { runTmux } from "./tmux.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const DEFAULT_PORT = 8787;
const DEFAULT_LANG = "zh-CN";

export const HELP = `Phone Remote for AI Coding Agents ${VERSION}

Usage: phone-remote [options]

Run it on the machine where your tmux sessions live, then open the printed link (or scan the QR code) on your phone.

  --port <n>          port to listen on (default ${DEFAULT_PORT}; 0 = pick a free one)
  --host <address>    address to bind (default 0.0.0.0, all interfaces)
  --token <token>     access token (default: generated once and saved to <state-dir>/token; env PHONE_REMOTE_TOKEN)
  --no-auth           no token at all — only allowed on a loopback address
  --allow-from <list> who may connect: comma-separated CIDRs / IPs / prefixes, "*" for anyone
                      (default: this machine and private networks incl. Tailscale; env PHONE_REMOTE_ALLOW_FROM)
  --allow-any         same as --allow-from "*"  (unwise on a machine with a public IP)
  --cert <file> --key <file>
                      serve HTTPS with this certificate (see docs/security.md)
  --lang <code>       interface language in the printed link (default: from your system locale)
  --default-lang <c>  language the page uses when nothing else is chosen (default ${DEFAULT_LANG}; env PHONE_REMOTE_DEFAULT_LANG)
  --public-url <url>  address your phone should use, if it is not one of this machine's (VPN name, reverse proxy …)
  --no-qr / --qr      never / always print the QR code (default: only when stdout is a terminal)
  --state-dir <dir>   where the token is kept (default ~/.phone-remote; env PHONE_REMOTE_HOME)
  --tmux-bin <path>   tmux executable (default tmux; env TMUX_BIN)
  --socket-name <n>   talk to tmux -L <n>          --socket-path <p>  talk to tmux -S <p>
  --claude-dir <dir>  Claude Code's config dir, for earlier conversation (default $CLAUDE_CONFIG_DIR or ~/.claude)
  -v, --version       print the version
  -h, --help          this text
`;

export function parseArgs(argv, env = process.env) {
  const config = {
    host: "0.0.0.0",
    port: DEFAULT_PORT,
    cert: "",
    key: "",
    token: env.PHONE_REMOTE_TOKEN || "",
    noAuth: false,
    allowAny: false,
    allowText: env.PHONE_REMOTE_ALLOW_FROM || DEFAULT_ALLOW_FROM,
    lang: "",
    defaultLang: env.PHONE_REMOTE_DEFAULT_LANG || DEFAULT_LANG,
    publicUrl: "",
    qr: "auto",
    stateDir: env.PHONE_REMOTE_HOME || path.join(os.homedir(), ".phone-remote"),
    tmuxBin: env.TMUX_BIN || "tmux",
    socketArgs: [],
    claudeDir: env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => {
      if (++i >= argv.length) throw new Error(`missing value for ${argv[i - 1]}`);
      return argv[i];
    };
    const flag = argv[i];
    if (flag === "--host") config.host = next();
    else if (flag === "--port") config.port = Number(next());
    else if (flag === "--cert") config.cert = next();
    else if (flag === "--key") config.key = next();
    else if (flag === "--token") config.token = next();
    else if (flag === "--no-auth") config.noAuth = true;
    else if (flag === "--allow-from") config.allowText = next();
    else if (flag === "--allow-any") config.allowAny = true;
    else if (flag === "--lang") config.lang = next();
    else if (flag === "--default-lang") config.defaultLang = next();
    else if (flag === "--public-url") config.publicUrl = next().replace(/\/+$/, "");
    else if (flag === "--no-qr") config.qr = false;
    else if (flag === "--qr") config.qr = true;
    else if (flag === "--state-dir") config.stateDir = next();
    else if (flag === "--tmux-bin") config.tmuxBin = next();
    else if (flag === "--socket-name") config.socketArgs = ["-L", next()];
    else if (flag === "--socket-path") config.socketArgs = ["-S", next()];
    else if (flag === "--claude-dir") config.claudeDir = next();
    else if (flag === "--help" || flag === "-h") config.help = true;
    else if (flag === "--version" || flag === "-v") config.version = true;
    else throw new Error(`unknown option: ${flag} (try --help)`);
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error("--port must be between 0 and 65535 (0 = pick a free port)");
  }
  if ((config.cert && !config.key) || (!config.cert && config.key)) throw new Error("--cert and --key go together");
  if (config.noAuth && !isLoopbackHost(config.host)) {
    throw new Error("--no-auth is only allowed together with a loopback --host (127.0.0.1, ::1 or localhost): without a token, anyone who can reach the port can type into your terminals");
  }
  config.allowRules = config.allowAny ? [] : parseAllowList(config.allowText);
  return config;
}

// The language to put in the printed link, from the machine's own locale: zh_CN.UTF-8 → zh-CN, ja_JP → ja, C / POSIX → en.
export function langFromEnv(env, available) {
  const raw = String(env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE || "");
  const first = raw.split(":")[0].split(".")[0].split("@")[0];
  if (!first || first === "C" || first === "POSIX") return "en";
  const tag = first.replace("_", "-");
  const lower = tag.toLowerCase();
  const has = code => available.includes(code);
  if (lower.startsWith("zh")) {
    const code = /tw|hk|mo|hant/.test(lower) ? "zh-TW" : "zh-CN";
    return has(code) ? code : "en";
  }
  const [primary, region] = tag.split("-");
  for (const candidate of [region ? `${primary.toLowerCase()}-${region.toUpperCase()}` : "", primary.toLowerCase()]) {
    if (candidate && has(candidate)) return candidate;
  }
  return "en";
}

// ---------- token ----------

export async function resolveToken(config) {
  if (config.noAuth) return "";
  if (config.token) return config.token;
  const file = path.join(config.stateDir, "token");
  try {
    const saved = (await readFile(file, "utf8")).trim();
    if (saved) return saved;
  } catch { /* first run */ }
  const fresh = randomBytes(18).toString("base64url");
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await writeFile(file, `${fresh}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return fresh;
}

// ---------- links for the banner ----------

export function classifyAddress(ip) {
  const p = parseIp(ip);
  if (!p || p.v !== 4) return "other";
  const a = Number(p.n >> 24n), b = Number((p.n >> 16n) & 0xffn);
  if (a === 100 && b >= 64 && b <= 127) return "vpn";                              // CGNAT range: Tailscale, many VPNs
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "lan";
  if (a === 127) return "local";
  return "other";
}

// Interfaces that cannot be reached from a phone (containers, virtual bridges), and names that are VPNs.
const VIRTUAL_NIC = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|cali|kube|lxc|lxd)/i;
const VPN_NIC = /^(tun|tap|wg|utun|ppp|tailscale|ts\d|zt|nordlynx)/i;

export function interfaceAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (VIRTUAL_NIC.test(name)) continue;
    for (const info of list || []) {
      if (info.family !== "IPv4" && info.family !== 4) continue;
      const kind = classifyAddress(info.address);
      // 100.64.0.0/10 and anything on a tunnel device is a VPN; the rest of the private ranges is the local network
      out.push({ name, address: info.address, kind: kind === "vpn" || (kind === "lan" && VPN_NIC.test(name)) ? "vpn" : kind });
    }
  }
  return out;
}

// → [{ label, url }] in the order worth showing: LAN, VPN, then this machine itself.
export function buildLinks({ scheme, port, token, lang, host, publicUrl, addresses }) {
  const query = `?${[token ? `token=${token}` : "", lang ? `lang=${lang}` : ""].filter(Boolean).join("&")}`;
  const link = base => `${base}/${query === "?" ? "" : query}`;
  if (publicUrl) return [{ label: "public-url", url: link(publicUrl) }];
  if (host && host !== "0.0.0.0" && host !== "::") {
    return [{ label: classifyAddress(host) === "local" ? "this computer" : "address", url: link(`${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}`) }];
  }
  const rank = { lan: 0, vpn: 1 };
  const links = addresses.filter(a => a.kind in rank).sort((a, b) => rank[a.kind] - rank[b.kind])
    .map(a => ({ label: a.kind === "vpn" ? `VPN · ${a.name}` : `Wi-Fi / LAN · ${a.name}`, url: link(`${scheme}://${a.address}:${port}`) }));
  links.push({ label: "this computer", url: link(`${scheme}://127.0.0.1:${port}`) });
  return links;
}

// ---------- main ----------

export async function main(argv, { env = process.env, out = process.stdout, err = process.stderr } = {}) {
  let config;
  try {
    config = parseArgs(argv, env);
  } catch (error) {
    err.write(`phone-remote: ${error.message}\n`);
    return 2;
  }
  if (config.help) { out.write(HELP); return 0; }
  if (config.version) { out.write(`${VERSION}\n`); return 0; }

  const locales = (await listLocales()).map(l => l.code);
  if (!locales.includes(config.defaultLang)) {
    err.write(`phone-remote: --default-lang "${config.defaultLang}" has no file in src/web/locales (have: ${locales.join(", ")})\n`);
    return 2;
  }
  config.token = await resolveToken(config);
  const tmuxVersion = (await runTmux(config, ["-V"]).catch(error => ({ stdout: "", stderr: error.message }))).stdout.trim();
  if (!tmuxVersion) {
    err.write("phone-remote: could not run tmux. Install it first (for example `sudo apt install tmux` or `brew install tmux`) or point --tmux-bin at it.\n");
    return 2;
  }

  let running;
  try {
    running = await startServer(config);
  } catch (error) {
    err.write(`phone-remote: could not listen on ${config.host}:${config.port}: ${error.message}\n`);
    return 1;
  }

  const lang = config.lang || langFromEnv(env, locales);
  const links = buildLinks({
    scheme: running.scheme, port: running.port, token: config.token, lang,
    host: config.host, publicUrl: config.publicUrl, addresses: interfaceAddresses(),
  });
  out.write(`\n  Phone Remote for AI Coding Agents ${VERSION}\n  ${tmuxVersion}\n\n  Open on your phone:\n\n`);
  for (const l of links) out.write(`    ${l.url}\n      ↳ ${l.label}\n`);
  if (config.qr === true || (config.qr === "auto" && out.isTTY)) {
    try { out.write(`\n${renderQr(links[0].url).split("\n").map(l => `    ${l}`).join("\n")}\n`); } catch { /* link too long for a QR code: skip it */ }
  }
  out.write("\n");
  if (config.noAuth) out.write("  ⚠ No access token: only this computer can reach it.\n");
  else out.write(`  Token kept in ${path.join(config.stateDir, "token")} — anyone holding it can type into your terminals, so keep the link private.\n`);
  if (config.allowAny) out.write("  ⚠ --allow-any: connections from every address are accepted.\n");
  if (!running.scheme.endsWith("s") && !config.noAuth) out.write("  Plain HTTP: fine on a trusted LAN or an encrypted VPN (Tailscale, WireGuard); see docs/security.md for HTTPS.\n");
  out.write("  Press Ctrl-C to stop.\n\n");

  const stop = () => { running.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return null;       // null = keep running
}
