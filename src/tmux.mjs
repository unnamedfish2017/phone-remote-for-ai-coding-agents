// Everything that touches tmux: listing windows, reading a pane's screen, typing into it.
//
// No pty, no xterm.js, no node-pty: the screen is read with `tmux capture-pane -e` (the output holds only SGR colour
// sequences, a few dozen lines of JavaScript render them) and input goes in with `tmux send-keys` / `paste-buffer`.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";

import { createAgentDetector, planSend } from "./agents.mjs";
import { listClaudeSessions } from "./claude-transcript.mjs";
import { fail } from "./errors.mjs";

export const TMUX_TIMEOUT_MS = 5000;
export const MAX_HISTORY_LINES = 2000;
export const MAX_TEXT_CHARS = 200000;

// Key names the page may send (tmux send-keys syntax). Anything else is rejected, never typed as text.
const KEY_RE = /^(Enter|Escape|Tab|BTab|Space|BSpace|DC|IC|Up|Down|Left|Right|Home|End|PPage|NPage|F[1-9]|F1[0-2]|C-[a-z[\]\\^_]|M-[a-zA-Z0-9]|S-(Up|Down|Left|Right)|C-(Up|Down|Left|Right))$/;
export const PANE_RE = /^%\d+$/;
export const WINDOW_RE = /^@\d+$/;

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function runTmux(config, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.tmuxBin, [...config.socketArgs, ...args], {
      stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(fail("tmux_timeout", 504, `tmux ${args[0]} timed out`, { cmd: args[0] }));
    }, TMUX_TIMEOUT_MS);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      clearTimeout(timer);
      reject(fail("tmux_spawn_failed", 502, `could not start ${config.tmuxBin}: ${error.message}`, { bin: config.tmuxBin, detail: error.message }));
    });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr: stderr.trim() }); });
    if (input != null) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

export async function tmuxOrThrow(config, args, input) {
  const result = await runTmux(config, args, input);
  if (result.code !== 0) {
    throw fail("tmux_failed", 502, result.stderr || `tmux ${args[0]} failed (exit ${result.code})`, { detail: result.stderr || `${args[0]} (exit ${result.code})` });
  }
  return result.stdout;
}

// With list-windows -a the pane_* variables describe each window's active pane. The page addresses panes by id, which
// is steadier than "session:window": session names may be plain numbers or contain dots, and base-index differs per setup.
const WINDOW_FORMAT = [
  "#{session_name}", "#{window_index}", "#{window_id}", "#{window_name}", "#{window_active}",
  "#{session_attached}", "#{window_activity}", "#{pane_id}", "#{pane_current_command}",
  "#{pane_width}", "#{pane_height}", "#{pane_title}", "#{window_panes}", "#{pane_dead}", "#{pane_pid}",
].join("\t");

export async function listWindows(config) {
  const result = await runTmux(config, ["list-windows", "-a", "-F", WINDOW_FORMAT]);
  if (result.code !== 0) {
    if (/no server running|No such file|error connecting/i.test(result.stderr)) return [];
    throw fail("tmux_failed", 502, result.stderr || "tmux list-windows failed", { detail: result.stderr || "list-windows" });
  }
  const items = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const f = line.split("\t");
    if (f.length < 15) continue;
    items.push({
      session: f[0], index: Number(f[1]), window_id: f[2], name: f[3], active: f[4] === "1",
      attached: Number(f[5]) > 0, activity: Number(f[6]) || 0, pane_id: f[7], command: f[8],
      width: Number(f[9]) || 0, height: Number(f[10]) || 0, title: f[11],
      panes: Number(f[12]) || 1, dead: f[13] === "1", pane_pid: Number(f[14]) || 0,
    });
  }
  items.sort((a, b) => a.session.localeCompare(b.session) || a.index - b.index);
  return items;
}

const PANE_FORMAT = [
  "#{cursor_x}", "#{cursor_y}", "#{pane_width}", "#{pane_height}", "#{history_size}",
  "#{alternate_on}", "#{pane_in_mode}", "#{session_name}", "#{window_index}", "#{window_name}",
  "#{pane_current_command}", "#{window_id}",
].join("\t");

export async function readScreen(config, paneId, historyLines) {
  const meta = (await tmuxOrThrow(config, ["display-message", "-p", "-t", paneId, PANE_FORMAT]))
    .replace(/\n$/, "").split("\t");
  const height = Number(meta[3]) || 0;
  // The visible screen is captured on its own: exactly pane_height lines, so the cursor row lines up directly.
  const visible = await tmuxOrThrow(config, ["capture-pane", "-p", "-e", "-t", paneId]);
  const screen = visible.replace(/\n$/, "").split("\n");
  while (screen.length < height) screen.push("");
  if (height > 0 && screen.length > height) screen.length = height;
  const historySize = Number(meta[4]) || 0;
  // Programs on the alternate screen (Claude Code, Codex, OpenCode, vim …) cannot be scrolled back in a real terminal.
  // The scrollback tmux still holds is whatever the shell printed before the program started; showing it above the
  // live screen only confuses, and costs tens of KB per update.
  const want = meta[5] === "1" ? 0 : Math.min(historyLines, historySize);
  let history = [];
  if (want > 0) {
    const raw = await tmuxOrThrow(config, ["capture-pane", "-p", "-e", "-t", paneId, "-S", String(-want), "-E", "-1"]);
    history = raw.replace(/\n$/, "").split("\n");
  }
  const payload = {
    pane_id: paneId,
    cursor: { x: Number(meta[0]) || 0, y: Number(meta[1]) || 0 },
    size: { width: Number(meta[2]) || 0, height },
    history_size: historySize,
    alternate: meta[5] === "1",
    in_mode: meta[6] === "1",
    session: meta[7],
    window_index: Number(meta[8]) || 0,
    window_name: meta[9],
    command: meta[10],
    window_id: meta[11],
    screen,
    history,
  };
  payload.hash = createHash("sha1").update(JSON.stringify([screen, history, payload.cursor])).digest("hex").slice(0, 16);
  return payload;
}

// ---------- which program is in a pane ----------
// Look at the process tree, not the window name: the same shell window runs Claude today and Codex tomorrow.
export const agentDetector = createAgentDetector();

export async function panePidOf(config, paneId) {
  return Number((await tmuxOrThrow(config, ["display-message", "-p", "-t", paneId, "#{pane_pid}"])).trim()) || 0;
}

// Pane ids (%3) are only unique inside one tmux server. With two servers on the machine (the default one and a
// `tmux -L work`, say), a Claude Code registered from the other server's %3 must not be taken for ours — so the
// registered process also has to sit below the pane's own process. "Cannot tell" counts as a match.
export async function claudeSessionOfPane(sessions, paneId, panePid) {
  if (!panePid) return null;
  for (const session of sessions) {
    if (session.pane_id === paneId && await agentDetector.contains(panePid, session.pid) !== false) return session;
  }
  return null;
}

// Rescan right before sending (the program may just have changed); if the tree shows nothing, fall back to
// Claude Code's own registration.
export async function paneAgentKind(config, paneId) {
  try {
    const pid = await panePidOf(config, paneId);
    const found = pid ? await agentDetector.detect(pid, { fresh: true }) : null;
    if (found) return found.kind;
    return await claudeSessionOfPane(await listClaudeSessions(config.claudeDir), paneId, pid) ? "claude" : null;
  } catch {
    return null;       // unrecognised is fine: send the generic way rather than fail the request
  }
}

export async function sendInput(config, paneId, body) {
  const text = typeof body.text === "string" ? body.text : "";
  const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
  if (text.length > MAX_TEXT_CHARS) throw fail("text_too_long", 413, "text too long");
  for (const key of keys) {
    if (!KEY_RE.test(key)) throw fail("bad_key", 400, `unsupported key: ${key}`, { key });
  }
  // Only "text + Enter" needs to know who is on the other end (Codex wants a pause in between, see agents.mjs).
  const agent = text ? await paneAgentKind(config, paneId) : null;
  const sentKeys = [];
  for (const step of planSend(agent, { text, keys, enter: Boolean(body.enter) })) {
    if (step.op === "type") {
      await tmuxOrThrow(config, ["send-keys", "-t", paneId, "-l", "--", step.text]);
    } else if (step.op === "paste") {
      // Bracketed paste: the application takes it as one block instead of running into it line by line.
      const buffer = `phone-remote-${process.pid}-${Date.now()}`;
      await tmuxOrThrow(config, ["load-buffer", "-b", buffer, "-"], step.text);
      await tmuxOrThrow(config, ["paste-buffer", "-p", "-d", "-b", buffer, "-t", paneId]);
    } else if (step.op === "sleep") {
      await sleep(step.ms);
    } else if (step.op === "keys") {
      await tmuxOrThrow(config, ["send-keys", "-t", paneId, ...step.keys]);
      sentKeys.push(...step.keys);
    }
  }
  return { sent_text: text.length, sent_keys: sentKeys, agent };
}
