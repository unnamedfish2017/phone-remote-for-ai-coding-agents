// Which AI coding tool is running in a tmux window, and how to talk to it.
//
// Why this exists: these tools do not treat keyboard input alike, but a web page has only one way to send text
// (put the characters in, then press Enter). Measured with Codex 0.163.0, OpenCode 1.18.33 and Claude Code:
//
//   * Codex treats ≥3 characters arriving within a few milliseconds as a *paste* (its "paste burst" heuristic).
//     An Enter during that burst, or within ~120 ms after it, becomes a newline instead of "submit" — so
//     `send-keys -l text` followed immediately by Enter needed a second Enter. Waiting a moment before Enter
//     fixes short text; very long typed text (≥ ~1500 chars) never settles, even after 600 ms, so long text goes in
//     as a bracketed paste instead (an explicit paste event has no such window).
//   * OpenCode and Claude Code do not have this problem.
//   * What runs in a window changes all the time (quit one tool, start another), so detection looks at the
//     current process tree, never at the window name.

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

// send.enterDelayMs : pause between typed text and the Enter that follows it
// send.typedMaxChars: single-line text longer than this goes in as a bracketed paste instead of being typed
export const AGENT_PROFILES = {
  claude: { label: "Claude Code", send: { enterDelayMs: 0, typedMaxChars: Infinity } },
  codex: { label: "Codex", send: { enterDelayMs: 250, typedMaxChars: 200 } },
  opencode: { label: "OpenCode", send: { enterDelayMs: 0, typedMaxChars: Infinity } },
};
// Windows we did not recognise (a plain shell, some other tool): behave as before, with a little slack so other TUIs
// with paste detection do not trip the same way (150 ms is invisible in a shell).
export const UNKNOWN_SEND = { enterDelayMs: 150, typedMaxChars: Infinity };
// After a bracketed paste, give the application a moment to take in the whole block before Enter arrives.
export const PASTE_SETTLE_MS = 80;

export function describeAgent(kind) {
  const profile = AGENT_PROFILES[kind];
  return profile ? { kind, label: profile.label } : null;
}

// ---------- process detection ----------

const SCRIPT_HOSTS = new Set(["node", "nodejs", "bun", "deno"]);
const baseName = p => String(p || "").split("/").pop();
const NATIVE = { claude: "claude", codex: "codex", opencode: "opencode" };

// `comm` is the kernel's process name (15 chars max on Linux; a full path on macOS), `argv` the full command line.
// Native binaries are recognised by name — by comm, or by argv[0] because on macOS the executable can be called
// `2.1.284` while it was started as `claude`. npm installs run as `node /…/bin/codex`, so for those the script path counts.
export function classifyProcess(comm, argv = []) {
  for (const name of [baseName(comm), baseName(argv[0])]) if (NATIVE[name]) return NATIVE[name];
  if (!SCRIPT_HOSTS.has(baseName(comm)) && !SCRIPT_HOSTS.has(baseName(argv[0]))) return null;
  const script = argv.slice(1).find(a => a && !a.startsWith("-")) || "";
  const name = baseName(script);
  if (name === "codex" || script.includes("/@openai/codex/")) return "codex";
  if (name === "claude" || script.includes("/@anthropic-ai/claude-code/")) return "claude";
  if (name === "opencode" || script.includes("/opencode-ai/")) return "opencode";
  return null;
}

export function buildProcIndex(rows) {
  const byPid = new Map();
  const children = new Map();
  for (const row of rows) {
    byPid.set(row.pid, row);
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  return { byPid, children };
}

// Walk down from the window's own process level by level; the match closest to the window wins, so a `codex exec`
// that Claude Code ran in its Bash tool does not turn a Claude window into a Codex one. A few layers of bash / su in
// between do not matter (seen in the wild: bash → su → bash → su → bash → node → codex).
export async function findAgent(index, rootPid, readArgs, maxDepth = 12) {
  const seen = new Set();
  let level = [rootPid];
  for (let depth = 0; level.length && depth <= maxDepth; depth += 1) {
    const next = [];
    for (const pid of level) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const row = index.byPid.get(pid);
      if (row) {
        const kind = classifyProcess(row.comm, await readArgs(pid));
        if (kind) return { kind, pid };
      }
      for (const child of index.children.get(pid) || []) next.push(child);
    }
    level = next;
  }
  return null;
}

// /proc/<pid>/stat looks like "123 (name with ) paren) S 100 …": the name may hold spaces and parentheses,
// so cut from the last ")".
async function procRows(procRoot) {
  let names;
  try { names = await readdir(procRoot); } catch { return null; }
  const pids = names.filter(n => /^\d+$/.test(n));
  if (!pids.length) return null;
  const rows = await Promise.all(pids.map(async name => {
    try {
      const stat = await readFile(`${procRoot}/${name}/stat`, "utf8");
      const open = stat.indexOf("(");
      const close = stat.lastIndexOf(")");
      if (open < 0 || close < open) return null;
      const rest = stat.slice(close + 2).split(" ");   // [state, ppid, …]
      return { pid: Number(name), ppid: Number(rest[1]), comm: stat.slice(open + 1, close) };
    } catch { return null; }                            // the process exited while we were reading
  }));
  return rows.filter(Boolean);
}

// `ps -axo pid=,ppid=,args=` (macOS and other systems without /proc): "  123   1 /usr/bin/tool --flag value".
// One call returns every command line; the first word stands in for the process name.
export function parsePsRows(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const args = m[3].split(/\s+/);
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: baseName(args[0]), args });
  }
  return rows;
}

const ps = args => new Promise(resolve => {
  execFile("ps", args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : stdout));
});

export async function readProcRows(procRoot = "/proc") {
  return (await procRows(procRoot)) || parsePsRows(await ps(["-axo", "pid=,ppid=,args="]));
}

export async function readProcArgs(pid, procRoot = "/proc") {
  try {
    return (await readFile(`${procRoot}/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
  } catch { return []; }
}

// Reading the process table touches a few hundred files; the window list polls every few seconds and several
// windows share one scan, so reuse a snapshot for a short while.
export function createAgentDetector({ procRoot = "/proc", ttlMs = 1500, now = Date.now } = {}) {
  let snap = null;
  let building = null;
  async function snapshot(fresh) {
    if (!fresh && snap && now() - snap.at < ttlMs) return snap;
    if (!building) {
      building = readProcRows(procRoot)
        .then(rows => { snap = { at: now(), index: buildProcIndex(rows), args: new Map() }; return snap; })
        .finally(() => { building = null; });
    }
    return building;
  }
  return {
    // → { kind, pid } or null. `fresh` skips the cache (used right before sending: the program may just have changed).
    async detect(panePid, { fresh = false } = {}) {
      if (!panePid) return null;
      const s = await snapshot(fresh);
      const readArgs = pid => {
        const row = s.index.byPid.get(pid);
        if (row && row.args) return row.args;               // `ps` already gave us the command lines
        if (!s.args.has(pid)) s.args.set(pid, readProcArgs(pid, procRoot));
        return s.args.get(pid);
      };
      return findAgent(s.index, panePid, readArgs);
    },
  };
}

// ---------- the plan for sending input ----------

// Turns "text + keys + Enter" into steps to run in order. A pure function so the tests can pin it down.
//   type  : tmux send-keys -l (as if typed)
//   paste : bracketed paste
//   sleep : wait
//   keys  : send-keys by key name
export function planSend(kind, { text = "", keys = [], enter = false } = {}) {
  const send = (AGENT_PROFILES[kind] || { send: UNKNOWN_SEND }).send;
  const steps = [];
  const multiline = /[\r\n]/.test(text);
  let how = "";
  if (text) {
    how = (multiline || text.length > send.typedMaxChars) ? "paste" : "type";
    steps.push({ op: how, text: how === "paste" ? text.replace(/\r\n?/g, "\n") : text });
  }
  const tail = [...keys, ...(enter ? ["Enter"] : [])];
  if (tail.length) {
    const wait = how === "paste" ? PASTE_SETTLE_MS : how === "type" ? send.enterDelayMs : 0;
    if (wait > 0) steps.push({ op: "sleep", ms: wait });
    steps.push({ op: "keys", keys: tail });
  }
  return steps;
}
