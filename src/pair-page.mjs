// The pairing page: a local HTML file with a big QR code and the link under it, opened in the browser so a phone camera has
// something large to scan (a terminal can only draw a code as big as its font and window allow).
//
// It holds the access token, so it lives in the private state directory (mode 0600) and is deleted when Phone Remote stops.
// It has no scripts and loads nothing from the network.

import { spawn } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { qrSvg } from "./qr.mjs";

export const PAIR_FILE = "pair.html";

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function card(link, small) {
  let svg = "";
  try { svg = qrSvg(link.url); } catch { svg = ""; }       // a link too long for a QR code still gets its text
  return `<section class="card${small ? " small" : ""}">
  ${svg}
  <div class="label">${escapeHtml(link.label)}</div>
  <code>${escapeHtml(link.url)}</code>
</section>`;
}

// links: [{ label, url }] as printed in the banner. The first one is the big code; a phone cannot use "this computer",
// so that one only appears when it is all there is.
export function buildPairPage({ links, version = "", hasToken = true }) {
  const usable = links.filter(l => l.label !== "this computer");
  const shown = usable.length ? usable : links;
  const [main, ...others] = shown;
  const note = hasToken
    ? `<p class="note">The code contains your access token: anyone who sees it can type into your terminals. This page is deleted when Phone Remote stops.<br>二维码里包含访问令牌，别让别人看到或拍走；Phone Remote 停止运行后，这个页面会被自动删除。</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Phone Remote — scan to connect</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 22px; padding: 28px 16px; background: Canvas; color: CanvasText;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; }
  h1 { margin: 0; text-align: center; font-size: clamp(22px, 4vw, 34px); }
  h1 small { display: block; font-size: .6em; font-weight: 500; opacity: .7; }
  h2 { margin: 6px 0 0; font-size: 16px; font-weight: 600; opacity: .8; text-align: center; }
  .card { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .card svg { width: min(78vmin, 640px); height: auto; border-radius: 14px; background: #fff; box-shadow: 0 6px 30px rgba(0, 0, 0, .25); }
  .card.small svg { width: min(36vmin, 240px); }
  .label { font-weight: 600; }
  code { display: block; max-width: min(92vw, 900px); box-sizing: border-box; padding: 10px 14px; border-radius: 10px; word-break: break-all;
    background: color-mix(in srgb, CanvasText 8%, Canvas); font: 14px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; user-select: all; }
  .note { max-width: 640px; margin: 0; text-align: center; font-size: 14px; opacity: .75; }
  .others { display: flex; flex-wrap: wrap; justify-content: center; gap: 28px; }
</style>
</head>
<body>
<h1>Scan with your phone's camera<small>用手机相机扫码连接</small></h1>
${main ? card(main, false) : ""}
${note}
${others.length ? `<h2>Other addresses · 其他地址</h2>\n<div class="others">\n${others.map(l => card(l, true)).join("\n")}\n</div>` : ""}
<p class="note">Phone Remote for AI Coding Agents ${escapeHtml(version)}</p>
</body>
</html>
`;
}

// ---------- when to open it, and how ----------

// A desktop session where a browser window can appear: not over SSH, and on Linux only with a display.
export function hasDesktop(env, platform) {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform === "darwin" || platform === "win32") return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

// open: true (--open) / false (--no-open) / "auto". Automatic = the first run on a desktop, in a terminal: a new token means a
// phone that has not been paired yet. Later runs only print the code; --open brings the page back whenever it is needed.
export function shouldOpenPairPage({ open, tokenCreated, isTTY, env, platform }) {
  if (open === true || open === false) return open;
  return Boolean(tokenCreated && isTTY && hasDesktop(env, platform));
}

export function openCommand(platform, file) {
  if (platform === "darwin") return { cmd: "open", args: [file] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", file] };
  return { cmd: "xdg-open", args: [file] };
}

// → true once the opener has started, false when there is none (headless machine) or it could not run.
export function openFile(file, { platform = process.platform, spawnFn = spawn } = {}) {
  const { cmd, args } = openCommand(platform, file);
  return new Promise(resolve => {
    let child;
    try { child = spawnFn(cmd, args, { stdio: "ignore", detached: true }); } catch { resolve(false); return; }
    child.once("error", () => resolve(false));
    child.once("spawn", () => { child.unref(); resolve(true); });
  });
}

export async function writePairPage(stateDir, html) {
  const file = path.join(stateDir, PAIR_FILE);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(file, html, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

export const removePairPage = file => rm(file, { force: true });
