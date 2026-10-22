import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPairPage, hasDesktop, isWsl, openCommands, openFile, shouldOpenPairPage, writePairPage } from "../src/pair-page.mjs";

const LAN = { label: "Wi-Fi / LAN · wlan0", url: "http://192.168.1.23:8787/?token=abc123&lang=en" };
const VPN = { label: "VPN · tailscale0", url: "http://100.101.102.103:8787/?token=abc123&lang=en" };
const HERE = { label: "this computer", url: "http://127.0.0.1:8787/?token=abc123&lang=en" };

test("the page has one big code for the first address, a small one for each other, and the links as text", () => {
  const html = buildPairPage({ links: [LAN, VPN, HERE], version: "1.2.3" });
  assert.equal((html.match(/<svg /g) || []).length, 2, "LAN big, VPN small; this computer is no use to a phone");
  assert.match(html, /class="card">/);
  assert.match(html, /class="card small">/);
  assert.ok(html.includes("http://192.168.1.23:8787/?token=abc123&amp;lang=en"), "the link, HTML-escaped");
  assert.ok(html.includes("VPN · tailscale0"));
  assert.ok(!html.includes("127.0.0.1"));
  assert.match(html, /1\.2\.3/);
});

test("when this computer is the only address it is shown anyway", () => {
  const html = buildPairPage({ links: [HERE] });
  assert.equal((html.match(/<svg /g) || []).length, 1);
  assert.ok(html.includes("127.0.0.1"));
});

test("the page loads nothing and runs nothing, and escapes whatever it is given", () => {
  const html = buildPairPage({ links: [{ label: "<img src=x onerror=alert(1)>", url: "http://h/?a=1&b=\"2\"" }] });
  assert.ok(!/<script/i.test(html));
  assert.ok(!/(src|href)=["']?https?:/i.test(html), "no external resources");
  assert.ok(!html.includes("<img src=x"), "label escaped");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("a=1&amp;b=&quot;2&quot;"));
});

test("the warning about the token is there when there is a token, and not when there is none", () => {
  assert.match(buildPairPage({ links: [LAN], hasToken: true }), /access token/);
  assert.ok(!/access token/.test(buildPairPage({ links: [LAN], hasToken: false })));
});

test("a link too long for a QR code still gets its text", () => {
  const html = buildPairPage({ links: [{ label: "long", url: "http://h/?x=" + "a".repeat(400) }] });
  assert.ok(!html.includes("<svg"));
  assert.ok(html.includes("aaaaaaaaaa"));
});

test("hasDesktop: never over SSH; macOS, Windows and WSL have one; other Linux needs a display", () => {
  assert.equal(hasDesktop({ SSH_CONNECTION: "1 2 3 4" }, "darwin"), false);
  assert.equal(hasDesktop({ SSH_TTY: "/dev/pts/0", DISPLAY: ":0" }, "linux"), false);
  assert.equal(hasDesktop({}, "darwin"), true);
  assert.equal(hasDesktop({}, "win32"), true);
  assert.equal(hasDesktop({ DISPLAY: ":0" }, "linux"), true);
  assert.equal(hasDesktop({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
  assert.equal(hasDesktop({}, "linux"), false);
  assert.equal(hasDesktop({ WSL_DISTRO_NAME: "Ubuntu" }, "linux"), true, "WSL reaches Windows' browser without an X server");
  assert.equal(hasDesktop({ WSL_DISTRO_NAME: "Ubuntu", SSH_CONNECTION: "x" }, "linux"), false);
});

test("isWsl looks at the variables WSL sets", () => {
  assert.equal(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }), true);
  assert.equal(isWsl({ WSL_INTEROP: "/run/WSL/1_interop" }), true);
  assert.equal(isWsl({}), false);
});

test("shouldOpenPairPage: flags win; otherwise only a first run (new token) in a terminal on a desktop", () => {
  const base = { tokenCreated: true, isTTY: true, env: { DISPLAY: ":0" }, platform: "linux" };
  assert.equal(shouldOpenPairPage({ ...base, open: "auto" }), true);
  assert.equal(shouldOpenPairPage({ ...base, open: "auto", tokenCreated: false }), false, "later runs only print the code");
  assert.equal(shouldOpenPairPage({ ...base, open: "auto", isTTY: false }), false, "no popup from a service or a pipe");
  assert.equal(shouldOpenPairPage({ ...base, open: "auto", env: {} }), false, "headless");
  assert.equal(shouldOpenPairPage({ ...base, open: "auto", env: { DISPLAY: ":0", SSH_CONNECTION: "x" } }), false, "over SSH");
  assert.equal(shouldOpenPairPage({ ...base, open: false }), false);
  assert.equal(shouldOpenPairPage({ open: true, tokenCreated: false, isTTY: false, env: {}, platform: "linux" }), true, "--open is always honoured");
});

test("openCommands lists the openers of each system in the order to try them", () => {
  assert.deepEqual(openCommands("darwin", "/x/pair.html"), [{ cmd: "open", args: ["/x/pair.html"] }]);
  assert.deepEqual(openCommands("win32", "C:\\x\\pair.html"), [{ cmd: "cmd", args: ["/c", "start", "", "C:\\x\\pair.html"] }]);
  assert.deepEqual(openCommands("linux", "/x/pair.html", {}), [{ cmd: "xdg-open", args: ["/x/pair.html"] }]);
  assert.deepEqual(openCommands("linux", "/x/pair.html", { WSL_DISTRO_NAME: "Ubuntu" }).map(o => o.cmd), ["wslview", "xdg-open"], "WSL: Windows' browser first");
});

test("openFile falls back to the next opener, and reports whether any started", async () => {
  const calls = [];
  const spawnWith = working => cmd => {
    calls.push(cmd);
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => (working.includes(cmd) ? child.emit("spawn") : child.emit("error", new Error("ENOENT"))));
    return child;
  };
  const wsl = { WSL_DISTRO_NAME: "Ubuntu" };
  assert.equal(await openFile("/x", { platform: "linux", env: wsl, spawnFn: spawnWith(["wslview", "xdg-open"]) }), true);
  assert.deepEqual(calls.splice(0), ["wslview"], "the first one that starts is enough");
  assert.equal(await openFile("/x", { platform: "linux", env: wsl, spawnFn: spawnWith(["xdg-open"]) }), true);
  assert.deepEqual(calls.splice(0), ["wslview", "xdg-open"], "no wslview installed: xdg-open");
  assert.equal(await openFile("/x", { platform: "linux", env: wsl, spawnFn: spawnWith([]) }), false);
  assert.equal(await openFile("/x", { platform: "linux", env: {}, spawnFn: () => { throw new Error("boom"); } }), false);
});

test("the page is written for the owner only", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pair-page-"));
  try {
    const state = path.join(dir, "state");
    const file = await writePairPage(state, "<p>x</p>");
    assert.equal(path.basename(file), "pair.html");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(state)).mode & 0o777, 0o700);
    assert.equal(await readFile(file, "utf8"), "<p>x</p>");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
