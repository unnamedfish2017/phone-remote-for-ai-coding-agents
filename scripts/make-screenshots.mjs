#!/usr/bin/env node
// Regenerates the README screenshots (docs/img/*.png) from a throw-away demo: an isolated tmux server whose windows
// look like AI-agent sessions, the server serving it, and headless Chrome taking phone-sized pictures.
//
//   node scripts/make-screenshots.mjs            # needs: Node 22+ (global WebSocket), tmux, Chrome or Chromium
//   CHROME_BIN=/path/to/chrome node scripts/make-screenshots.mjs
//
// Nothing here touches your real tmux server: it uses its own socket file in a temp directory.
// The windows run harmless stand-in processes (a copy of `cat` called claude / codex / opencode) so that the server's
// program detection does what it does for real; what you see on screen is canned demo text, not a real agent.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../src/cli.mjs";
import { startServer } from "../src/server.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "img");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = n => `\x1b[${n}m`;
const paint = (n, s) => `${esc(n)}${s}${esc(0)}`;
const C = { prompt: s => paint("1;36", s), step: s => paint("33", s), dim: s => paint("2", s), ok: s => paint("32", s), bad: s => paint("31", s), bold: s => paint(1, s), blue: s => paint("34", s) };

// ---------- demo content (every line fits 40 columns, so nothing wraps at 15px on a phone) ----------
const CONCISE = {
  en: "(Reply style: be as concise as possible, one sentence per item, numbered list 1. 2. 3. …; keep only the key points, as many items as there are points, no padding, don't aim for completeness.)",
  "zh-CN": "（回复要求：最精简，每条一句话，按 1. 2. 3. … 编号逐条列出；只保留关键要点，有几点列几条，不凑数、不求全。）",
};
const DEMO = {
  en: {
    names: { ci: "ci-debug", api: "api-refactor", web: "frontend", docs: "docs", db: "db-migrate", srv: "server" },
    wins: { ci: "main", api: "main", web: "main", docs: "readme", db: "migration", srv: "dev" },
    titles: { ci: "Why is CI failing?", api: "Refactor auth middleware", web: "Add date picker" },
    ci: [
      `${C.prompt(">")} Why is the build failing on CI?`,
      C.dim("  (Reply style: be as concise as"),
      C.dim("  possible, one sentence per item,"),
      C.dim("  numbered list 1. 2. 3. …; key"),
      C.dim("  points only, no padding.)"),
      "",
      `${C.step("▸")} Checked the CI log and package.json`,
      "",
      `${C.bold("1.")} CI runs Node 18; needs ≥ 20.`,
      `${C.bold("2.")} Lockfile: npm 10, CI has npm 8.`,
      `${C.bold("3.")} DATABASE_URL missing in test job.`,
      "",
      `${C.prompt(">")} Fix them and re-run`,
      `${C.step("▸")} Editing .github/workflows/ci.yml`,
      `  ${C.bad("- node-version: 18")}`,
      `  ${C.ok("+ node-version: 20")}`,
      `  ${C.ok("+ DATABASE_URL: ${{ secrets.DB }}")}`,
      `${C.step("▸")} Running npm test`,
      `  ${C.ok("✓")} 128 passed ${C.dim("(11.4s)")}`,
      "",
      `${C.ok("Done.")} Pushed to fix/ci-node.`,
    ],
    api: [
      `${C.prompt(">")} Refactor auth middleware: async/await`,
      "",
      `${C.step("▸")} Reading src/middleware/auth.js`,
      C.dim("  118 lines · 4 callbacks to flatten"),
      "",
      `${C.step("▸")} Plan`,
      "  1. verifyToken() → async/await",
      "  2. requireRole(): no nested callbacks",
      "  3. tests: expired / malformed tokens",
      "",
      `${C.step("▸")} Editing src/middleware/auth.js`,
      `  ${C.bad("- jwt.verify(t, key, (err, p) => {")}`,
      `  ${C.bad("-   if (err) return next(err);")}`,
      `  ${C.ok("+ const p = await verify(t, key);")}`,
      `  ${C.ok("+ req.user = p;")}`,
      "",
      `${C.step("▸")} Running npm test -- auth`,
      `  ${C.ok("✓")} 14 passed ${C.dim("(0.9s)")}`,
      "",
      C.dim("Working… (42s · esc to interrupt)"),
    ],
    web: [
      `${C.prompt(">")} Add a date picker to the booking form`,
      "",
      `${C.step("▸")} I'd like to install a package:`,
      "",
      `  ${C.bold("npm install date-fns")}`,
      "",
      "  Do you want to proceed?",
      `  ${C.blue("❯ 1. Yes")}`,
      "    2. Yes, and don't ask again",
      "    3. No, tell me what to do instead",
    ],
    docs: [C.bold("Writing the README"), "", `${C.ok("✓")} Overview`, `${C.ok("✓")} Quick start`, `${C.step("▸")} Configuration reference…`, C.dim("  (esc to interrupt)")],
    db: [C.bold("Migration plan"), "", "  1. add column users.last_seen", "  2. backfill in batches of 5k", "  3. add index (concurrently)", "", `${C.step("▸")} Applying step 2 of 3…`],
    srv: ["$ npm run dev", "", C.dim("> app@1.0.0 dev"), "", `  ${C.ok("ready")} on http://localhost:3000`, `  ${C.dim("compiled in 412 ms")}`, `  ${C.dim("GET /api/health 200 3 ms")}`],
    draft: "Run the tests again and tell me what broke",
  },
  "zh-CN": {
    names: { ci: "ci-debug", api: "api-refactor", web: "frontend", docs: "docs", db: "db-migrate", srv: "server" },
    wins: { ci: "main", api: "main", web: "main", docs: "readme", db: "migration", srv: "dev" },
    titles: { ci: "CI 为什么挂了", api: "重构鉴权中间件", web: "加日期选择器" },
    ci: [
      `${C.prompt(">")} CI 上的构建为什么失败？`,
      C.dim("  （回复要求：最精简，每条一句话，"),
      C.dim("  按 1. 2. 3. … 编号逐条列出；"),
      C.dim("  只保留关键要点，不凑数。）"),
      "",
      `${C.step("▸")} 已查看 CI 日志和 package.json`,
      "",
      `${C.bold("1.")} CI 是 Node 18，项目要求 ≥ 20。`,
      `${C.bold("2.")} 锁文件 npm 10，CI 是 npm 8。`,
      `${C.bold("3.")} 测试任务缺少 DATABASE_URL。`,
      "",
      `${C.prompt(">")} 都改掉，再跑一遍`,
      `${C.step("▸")} 修改 .github/workflows/ci.yml`,
      `  ${C.bad("- node-version: 18")}`,
      `  ${C.ok("+ node-version: 20")}`,
      `  ${C.ok("+ DATABASE_URL: ${{ secrets.DB }}")}`,
      `${C.step("▸")} 运行 npm test`,
      `  ${C.ok("✓")} 128 项通过 ${C.dim("(11.4s)")}`,
      "",
      `${C.ok("完成。")}已推送到 fix/ci-node。`,
    ],
    api: [
      `${C.prompt(">")} 鉴权中间件改成 async/await`,
      "",
      `${C.step("▸")} 读取 src/middleware/auth.js`,
      C.dim("  118 行 · 有 4 层回调要拍平"),
      "",
      `${C.step("▸")} 计划`,
      "  1. verifyToken() 改 async/await",
      "  2. requireRole() 去掉嵌套回调",
      "  3. 补过期 / 畸形令牌的测试",
      "",
      `${C.step("▸")} 修改 src/middleware/auth.js`,
      `  ${C.bad("- jwt.verify(t, key, (err, p) => {")}`,
      `  ${C.bad("-   if (err) return next(err);")}`,
      `  ${C.ok("+ const p = await verify(t, key);")}`,
      `  ${C.ok("+ req.user = p;")}`,
      "",
      `${C.step("▸")} 运行 npm test -- auth`,
      `  ${C.ok("✓")} 14 项通过 ${C.dim("(0.9s)")}`,
      "",
      C.dim("工作中…（42 秒 · esc 中断）"),
    ],
    web: [
      `${C.prompt(">")} 给预订表单加一个日期选择器`,
      "",
      `${C.step("▸")} 我想安装一个依赖：`,
      "",
      `  ${C.bold("npm install date-fns")}`,
      "",
      "  要继续吗？",
      `  ${C.blue("❯ 1. 是")}`,
      "    2. 是，并且不再询问",
      "    3. 否，告诉我该怎么做",
    ],
    docs: [C.bold("正在写 README"), "", `${C.ok("✓")} 项目简介`, `${C.ok("✓")} 快速开始`, `${C.step("▸")} 配置说明……`, C.dim("  （esc 中断）")],
    db: [C.bold("迁移计划"), "", "  1. 加列 users.last_seen", "  2. 每 5000 行一批回填", "  3. 并发建索引", "", `${C.step("▸")} 正在执行第 2 / 3 步……`],
    srv: ["$ npm run dev", "", C.dim("> app@1.0.0 dev"), "", `  ${C.ok("就绪")} http://localhost:3000`, `  ${C.dim("编译耗时 412 ms")}`, `  ${C.dim("GET /api/health 200 3 ms")}`],
    draft: "再跑一遍测试，告诉我哪里挂了",
  },
};

// ---------- a tiny CDP client ----------
async function launchChrome(profile) {
  const bin = process.env.CHROME_BIN || ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find(b => {
    try { execFileSync("which", [b], { stdio: "ignore" }); return true; } catch { return false; }
  });
  if (!bin) throw new Error("Chrome or Chromium not found (set CHROME_BIN)");
  const port = 9300 + Math.floor(Math.random() * 500);
  const child = spawn(bin, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  let targets;
  for (let i = 0; i < 100 && !targets; i += 1) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(150); }
  }
  if (!targets) throw new Error("Chrome did not start");
  const ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0, loaded = false;
  const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    else if (m.method === "Page.loadEventFired") loaded = true;
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  await send("Page.enable"); await send("Runtime.enable");
  // the pictures use the dark theme and a larger font: legible even when shrunk into the README banner
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem("tmuxWebPrefs", JSON.stringify({ theme: "dark", font: 15 })); } catch (e) {}` });
  return {
    send,
    kill: () => { try { ws.close(); child.kill("SIGKILL"); } catch { /* gone */ } },
    async ev(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async visit(url, settle = 1500) {
      loaded = false;
      await send("Page.navigate", { url });
      for (let i = 0; i < 100 && !loaded; i += 1) await sleep(100);
      await sleep(settle);
    },
    async shot(file, clip) {
      const r = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
      writeFileSync(file, Buffer.from(r.data, "base64"));
    },
    phone: () => send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }),
    desktop: (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }),
  };
}

function hero(lang, files) {
  const zh = lang === "zh-CN";
  const t = zh
    ? { h1: "手机遥控<br>AI 编程助手", sub: "在手机上看着它、对着它说", line: "遥控电脑里的 Claude Code / Codex / OpenCode", badge: "🎙️ 配合豆包输入法使用，体验极佳", caps: ["说完就发，精简编号回复", "所有窗口一眼看清，谁在干活谁在等你", "按程序自动换菜单，Codex 的坑也替你填了"], h1size: 84 }
    : { h1: "Phone Remote<br>for AI Coding Agents", sub: "Watch and talk to them from your phone", line: "Works with Claude Code, Codex and OpenCode running in tmux", badge: "🎙️ Works great with Doubao (豆包) voice input", caps: ["Speak, send, get short numbered replies", "Every window at a glance: who works, who waits", "Menus follow the program — Codex quirks handled"], h1size: 58 };
  const img = f => `file://${f}`;
  return `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;width:1600px;height:900px;background:linear-gradient(135deg,#0f1626 0%,#1b2a4a 55%,#243b6b 100%);color:#fff;font-family:-apple-system,"PingFang SC","Noto Sans CJK SC","Segoe UI",Roboto,sans-serif;overflow:hidden}
  .wrap{display:flex;height:100%;align-items:center;padding:0 70px;gap:60px}
  .copy{flex:0 0 600px}
  h1{font-size:${t.h1size}px;line-height:1.08;margin:0 0 18px;letter-spacing:-1px}
  .sub{font-size:28px;font-weight:600;color:#9fc2ff;margin-bottom:22px}
  .line{font-size:24px;line-height:1.5;color:#d6e2ff;margin-bottom:34px}
  .badge{display:inline-block;background:#ffd166;color:#2b2100;font-weight:700;font-size:22px;padding:12px 22px;border-radius:40px}
  .phones{display:flex;gap:34px;flex:1;justify-content:flex-end;align-items:flex-start}
  figure{margin:0;width:250px;text-align:center}
  .frame{border:7px solid #05070d;border-radius:34px;overflow:hidden;background:#000;box-shadow:0 18px 50px rgba(0,0,0,.55)}
  .frame img{display:block;width:100%}
  figcaption{margin-top:16px;font-size:19px;line-height:1.35;color:#cfe0ff}
  figure:nth-child(2){margin-top:46px}
  </style><div class="wrap"><div class="copy"><h1>${t.h1}</h1><div class="sub">${t.sub}</div><div class="line">${t.line}</div><div class="badge">${t.badge}</div></div>
  <div class="phones">${files.map((f, i) => `<figure><div class="frame"><img src="${img(f)}"></div><figcaption>${t.caps[i]}</figcaption></figure>`).join("")}</div></div>`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dir = mkdtempSync(path.join(os.tmpdir(), "phone-remote-shots-"));
  const env = { ...process.env }; delete env.TMUX;
  const socks = [];
  let tmux = () => "";
  const bin = path.join(dir, "bin"); mkdirSync(bin);
  for (const n of ["claude", "codex", "opencode"]) symlinkSync("/bin/cat", path.join(bin, n));
  let chrome, running;
  try {
    for (const lang of Object.keys(DEMO)) {
      const D = DEMO[lang];
      const sock = path.join(dir, `tmux-${lang}.sock`);        // a fresh tmux server per language: no race with one that is still shutting down
      socks.push(sock);
      tmux = (...a) => execFileSync("tmux", ["-S", sock, ...a], { env, encoding: "utf8" });
      const make = (key, agent, lines, size = "40x40") => {
        const file = path.join(dir, `${lang}-${key}.txt`);
        writeFileSync(file, lines.join("\n") + "\n");
        const [w, h] = size.split("x");
        tmux("new-session", "-d", "-s", D.names[key], ...(D.wins[key] ? ["-n", D.wins[key]] : []), "-x", w, "-y", h, `bash --norc -c 'cat "${file}"; exec "${path.join(bin, agent)}"'`);
        return tmux("display-message", "-p", "-t", D.names[key], "#{pane_id}|#{pane_pid}").trim().split("|");
      };
      const reg = [];
      const claude = (key, status) => { const [pane, pid] = make(key, "claude", D[key]); reg.push({ pid: Number(pid), pane, status, name: D.titles[key] }); };
      claude("ci", "idle"); claude("api", "busy"); claude("web", "waiting");
      make("docs", "opencode", D.docs); make("db", "codex", D.db);
      tmux("new-session", "-d", "-s", D.names.srv, "-n", D.wins.srv, "-x", "40", "-y", "40", `bash --norc -c 'cat "${path.join(dir, `${lang}-srv.txt`)}"; exec bash --norc'`);
      writeFileSync(path.join(dir, `${lang}-srv.txt`), D.srv.join("\n") + "\n");
      const claudeDir = path.join(dir, `claude-${lang}`); mkdirSync(path.join(claudeDir, "sessions"), { recursive: true });
      for (const r of reg) writeFileSync(path.join(claudeDir, "sessions", `${r.pid}.json`), JSON.stringify({ pid: r.pid, sessionId: `demo-${r.pid}`, cwd: "/demo", tmux: `x.${r.pane}`, status: r.status, name: r.name }));
      await sleep(600);

      const config = parseArgs(["--no-auth", "--host", "127.0.0.1", "--port", "0", "--socket-path", sock, "--claude-dir", claudeDir, "--state-dir", path.join(dir, "state")], {});
      running = await startServer(config, { log() {}, error() {} });
      chrome ||= await launchChrome(path.join(dir, "chrome"));
      const base = `http://127.0.0.1:${running.port}`;
      await chrome.phone();
      await chrome.visit(`${base}/?lang=${lang}`);
      const select = async name => {
        const pane = (await (await fetch(`${base}/api/windows`)).json()).windows.find(w => w.session === name).pane_id;
        await chrome.ev(`document.getElementById("winBtn").click()`); await sleep(250);
        await chrome.ev(`document.querySelector('.win-row[data-pane="${pane}"]').click()`); await sleep(1300);
      };
      // 1. the window list
      await chrome.ev(`document.getElementById("winBtn").click()`); await sleep(500);
      await chrome.shot(path.join(OUT, `windows.${lang}.png`));
      await chrome.ev(`document.getElementById("closeSheet").click()`); await sleep(200);
      // 2. a session with a dictated sentence waiting in the input box
      await select(D.names.ci);
      await chrome.ev(`(function(){ var t = document.getElementById("text"); t.value = ${JSON.stringify(D.draft)}; t.dispatchEvent(new Event("input")); })()`);
      await sleep(300);
      await chrome.shot(path.join(OUT, `session.${lang}.png`));
      // 3. the quick menu of a Codex window
      await select(D.names.db);
      await chrome.ev(`document.getElementById("quickBtn").click()`); await sleep(400);
      await chrome.shot(path.join(OUT, `menu.${lang}.png`));
      await chrome.ev(`document.getElementById("menuMask").click()`); await sleep(200);
      // 4. settings with the language menu and the concise phrase
      await chrome.ev(`document.getElementById("openSettings").click()`); await sleep(900);
      await chrome.shot(path.join(OUT, `settings.${lang}.png`));
      // 5. the hero picture
      await chrome.desktop(1600, 900);
      const html = path.join(dir, `hero-${lang}.html`);
      writeFileSync(html, hero(lang, ["session", "windows", "menu"].map(n => path.join(OUT, `${n}.${lang}.png`))));
      await chrome.visit(`file://${html}`, 600);
      await chrome.shot(path.join(OUT, `hero.${lang}.png`));
      await running.close();
      console.log(`${lang}: windows, session, menu, settings, hero written to docs/img/`);
    }
  } finally {
    if (chrome) chrome.kill();
    for (const sock of socks) { try { execFileSync("tmux", ["-S", sock, "kill-server"], { env, stdio: "ignore" }); } catch { /* none */ } }
    await sleep(500);                                   // let Chrome finish writing its profile before it is deleted
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp dir: the OS cleans up */ }
  }
}

main().catch(error => { console.error(error); process.exit(1); });
