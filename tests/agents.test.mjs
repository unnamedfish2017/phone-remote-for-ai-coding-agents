import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildProcIndex,
  classifyProcess,
  createAgentDetector,
  describeAgent,
  findAgent,
  isInTree,
  parsePsRows,
  planSend,
} from "../src/agents.mjs";

const noArgs = async () => [];

test("classifyProcess: native binaries are recognised by name", () => {
  assert.equal(classifyProcess("claude"), "claude");
  assert.equal(classifyProcess("codex"), "codex");
  assert.equal(classifyProcess("opencode"), "opencode");
});

test("classifyProcess: npm launchers run as `node <script>`; only the script counts", () => {
  assert.equal(classifyProcess("node", ["node", "/home/u/node/bin/codex", "--yolo"]), "codex");
  assert.equal(classifyProcess("node", ["node", "--no-warnings", "/home/u/node/bin/claude"]), "claude");
  assert.equal(classifyProcess("node", ["node", "/x/lib/node_modules/@openai/codex/bin/codex.js"]), "codex");
  assert.equal(classifyProcess("bun", ["bun", "/x/node_modules/opencode-ai/bin/opencode"]), "opencode");
  // an argument that merely says "codex" is not the program
  assert.equal(classifyProcess("node", ["node", "server.js", "codex"]), null);
  assert.equal(classifyProcess("node", ["node", "build.js"]), null);
});

test("classifyProcess: unrelated programs and look-alike names are not agents", () => {
  assert.equal(classifyProcess("bash", ["-bash"]), null);
  assert.equal(classifyProcess("vim", ["vim", "codex.md"]), null);
  assert.equal(classifyProcess("codex-voice-host"), null);
  assert.equal(classifyProcess("claudette"), null);
});

function table(rows) {
  return buildProcIndex(rows.map(([pid, ppid, comm]) => ({ pid, ppid, comm })));
}

test("findAgent: sees through nested shells and su, and reads the launcher's script path", async () => {
  // the shape seen on a real machine: bash → su → bash → su → bash → node(codex launcher) → codex
  const index = table([
    [100, 1, "bash"], [101, 100, "su"], [102, 101, "bash"], [103, 102, "su"], [104, 103, "bash"],
    [105, 104, "node"], [106, 105, "codex"],
  ]);
  const found = await findAgent(index, 100, async pid => (pid === 105 ? ["node", "/n/bin/codex", "--yolo"] : []));
  assert.deepEqual(found, { kind: "codex", pid: 105 });
});

test("findAgent: the match closest to the pane wins, so a codex run inside Claude Code is still a Claude window", async () => {
  const index = table([[200, 1, "bash"], [201, 200, "claude"], [202, 201, "bash"], [203, 202, "codex"]]);
  assert.deepEqual(await findAgent(index, 200, noArgs), { kind: "claude", pid: 201 });
});

test("findAgent: the pane's own process can be the agent; nothing found gives null", async () => {
  assert.deepEqual(await findAgent(table([[300, 1, "opencode"]]), 300, noArgs), { kind: "opencode", pid: 300 });
  assert.equal(await findAgent(table([[400, 1, "bash"], [401, 400, "vim"]]), 400, noArgs), null);
  assert.equal(await findAgent(table([[400, 1, "bash"]]), 999, noArgs), null);
});

test("findAgent: a process loop in a corrupted table cannot hang the search", async () => {
  const index = table([[500, 501, "bash"], [501, 500, "bash"]]);
  assert.equal(await findAgent(index, 500, noArgs), null);
});

test("isInTree: a registered process counts only when it is the pane's own process or sits below it", () => {
  const index = table([[100, 1, "tmux"], [200, 100, "bash"], [300, 200, "node"], [400, 300, "claude"], [500, 1, "claude"]]);
  assert.equal(isInTree(index, 200, 400), true, "below the shell, through node");
  assert.equal(isInTree(index, 200, 200), true, "the pane's own process");
  assert.equal(isInTree(index, 200, 500), false, "a Claude Code elsewhere, e.g. in another tmux server");
  assert.equal(isInTree(index, 400, 200), false, "the tree is not symmetric");
  assert.equal(isInTree(index, 200, 999), null, "unknown to the table: cannot tell");
});

test("isInTree: a loop in a corrupted table ends instead of hanging", () => {
  assert.equal(isInTree(table([[10, 20, "a"], [20, 10, "b"]]), 99, 10), false);
});

test("planSend: Codex gets a pause between typed text and Enter", () => {
  assert.deepEqual(planSend("codex", { text: "hello", enter: true }), [
    { op: "type", text: "hello" }, { op: "sleep", ms: 250 }, { op: "keys", keys: ["Enter"] },
  ]);
});

test("planSend: Codex gets long and multi-line text as a bracketed paste, then the usual short settle", () => {
  const long = "x".repeat(201);
  assert.deepEqual(planSend("codex", { text: long, enter: true }), [
    { op: "paste", text: long }, { op: "sleep", ms: 80 }, { op: "keys", keys: ["Enter"] },
  ]);
  assert.deepEqual(planSend("codex", { text: "a\r\nb", enter: true }), [
    { op: "paste", text: "a\nb" }, { op: "sleep", ms: 80 }, { op: "keys", keys: ["Enter"] },
  ]);
  // exactly at the limit still counts as typed
  assert.equal(planSend("codex", { text: "x".repeat(200), enter: true })[0].op, "type");
});

test("planSend: Claude Code and OpenCode keep the original no-delay path", () => {
  for (const kind of ["claude", "opencode"]) {
    assert.deepEqual(planSend(kind, { text: "hi", enter: true }), [
      { op: "type", text: "hi" }, { op: "keys", keys: ["Enter"] },
    ]);
    // long single-line text is still typed for them
    assert.equal(planSend(kind, { text: "y".repeat(5000), enter: true })[0].op, "type");
  }
});

test("planSend: unrecognised windows get a small buffer, and key-only requests never wait", () => {
  assert.deepEqual(planSend(null, { text: "ls", enter: true }), [
    { op: "type", text: "ls" }, { op: "sleep", ms: 150 }, { op: "keys", keys: ["Enter"] },
  ]);
  assert.deepEqual(planSend("codex", { keys: ["Enter"] }), [{ op: "keys", keys: ["Enter"] }]);
  assert.deepEqual(planSend("codex", {}), []);
});

test("planSend: extra keys go out together with Enter in one step", () => {
  assert.deepEqual(planSend("claude", { text: "/compact", keys: ["Escape"], enter: true }), [
    { op: "type", text: "/compact" }, { op: "keys", keys: ["Escape", "Enter"] },
  ]);
});

test("describeAgent: label for known kinds, null otherwise", () => {
  assert.deepEqual(describeAgent("codex"), { kind: "codex", label: "Codex" });
  assert.equal(describeAgent("vim"), null);
  assert.equal(describeAgent(null), null);
});

test("detector on the real /proc: finds an agent-named child process of this test runner", { skip: process.platform !== "linux" }, async () => {
  // a process whose kernel name is "opencode": a symlink to sleep, so nothing real gets started
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-detect-"));
  const link = path.join(dir, "opencode");
  await symlink("/bin/sleep", link);
  const child = spawn(link, ["30"], { stdio: "ignore" });
  try {
    await new Promise(resolve => setTimeout(resolve, 150));
    const detector = createAgentDetector();
    const found = await detector.detect(process.pid, { fresh: true });
    assert.deepEqual(found, { kind: "opencode", pid: child.pid });
    assert.equal(await detector.detect(0), null);
    assert.equal(await detector.contains(process.pid, child.pid, { fresh: true }), true);
    assert.equal(await detector.contains(child.pid, process.pid), false, "a parent is not inside its child");
    assert.equal(await detector.contains(process.pid, 2 ** 22 + 12345), null, "a pid the table has never seen");
    assert.equal(await detector.contains(0, child.pid), null);
  } finally {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("classifyProcess: a native binary whose file name is a version number is still found through argv[0] (macOS)", () => {
  assert.equal(classifyProcess("2.1.284", ["claude", "--dangerously-skip-permissions"]), "claude");
  assert.equal(classifyProcess("/Users/me/.local/share/claude/versions/2.1.284", ["/Users/me/.local/bin/claude"]), "claude");
  assert.equal(classifyProcess("/usr/local/bin/node", ["node", "/usr/local/bin/codex", "--yolo"]), "codex");
  assert.equal(classifyProcess("/bin/zsh", ["-zsh"]), null);
});

test("parsePsRows reads `ps -axo pid=,ppid=,args=` output: first word is the name, the words are the command line", () => {
  const rows = parsePsRows([
    "    1     0 /sbin/launchd",
    "  501   1 /bin/zsh -l",
    "  777 501 node /Users/me/.nvm/bin/codex --yolo",
    "  778 777 /Users/me/.nvm/lib/node_modules/@openai/codex/vendor/codex",
    "garbage line",
    "",
  ].join("\n"));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[2], { pid: 777, ppid: 501, comm: "node", args: ["node", "/Users/me/.nvm/bin/codex", "--yolo"] });
  assert.equal(rows[3].comm, "codex");
});

test("findAgent works on rows that already carry their command line (the ps path, no /proc)", async () => {
  const rows = parsePsRows([" 10 1 /bin/zsh", " 11 10 node /home/me/bin/codex", " 12 11 /x/vendor/codex"].join("\n"));
  const index = buildProcIndex(rows);
  assert.deepEqual(await findAgent(index, 10, async pid => index.byPid.get(pid).args), { kind: "codex", pid: 11 });
});

test("detector without /proc falls back to ps (a directory that is not a process table)", { skip: process.platform === "win32" }, async () => {
  // procRoot points at an empty temp dir: the detector must take the `ps` route and still see this very process tree
  const dir = await mkdtemp(path.join(os.tmpdir(), "no-proc-"));
  const link = path.join(dir, "claude");
  await symlink("/bin/sleep", link);
  const child = spawn(link, ["30"], { stdio: "ignore" });
  try {
    await new Promise(resolve => setTimeout(resolve, 150));
    const found = await createAgentDetector({ procRoot: dir }).detect(process.pid, { fresh: true });
    assert.deepEqual(found, { kind: "claude", pid: child.pid });
  } finally {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
