// Earlier conversation of a Claude Code window.
//
// Claude Code runs on the terminal's alternate screen, so tmux has no scrollback for it: "what was said before"
// can only come from Claude Code's own session log. ~/.claude/sessions/<pid>.json registers every running Claude Code
// process (session id, working directory, and the tmux pane it sits in); the log itself is
// ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl. Matching by pane id keeps two windows in the same directory apart.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export function encodeProjectDir(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export async function listClaudeSessions(claudeDir) {
  const dir = path.join(claudeDir, "sessions");
  let names;
  try { names = await readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const info = JSON.parse(await readFile(path.join(dir, name), "utf8"));
      if (!info || typeof info.pid !== "number" || !info.sessionId || !info.cwd) continue;
      if (!pidAlive(info.pid)) continue;                       // left behind by a process that has exited
      const m = /\.(%\d+)$/.exec(String(info.tmux || ""));
      out.push({
        pid: info.pid, session_id: info.sessionId, cwd: info.cwd, pane_id: m ? m[1] : "",
        name: info.name || "", status: info.status || "", updated_at: info.updatedAt || 0,
        transcript: path.join(claudeDir, "projects", encodeProjectDir(info.cwd), `${info.sessionId}.jsonl`),
      });
    } catch { /* skip a broken file */ }
  }
  return out;
}

// User entries carry injected material (<system-reminder>, local command output …); keep only what the person wrote.
function stripInjected(text) {
  return String(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-(stdout|caveat)>[\s\S]*?<\/local-command-\1>/g, "")
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, "");
}

function userText(content) {
  if (typeof content === "string") return stripInjected(content).trim();
  if (!Array.isArray(content)) return "";
  // tool_result blocks are not shown: they are already on the screen and often thousands of characters long
  return content
    .filter(b => b && b.type === "text" && typeof b.text === "string")
    .map(b => stripInjected(b.text)).join("\n").trim();
}

function toolSummary(block) {
  const input = block.input || {};
  const value = input.command || input.file_path || input.pattern || input.path || input.query || input.description || input.prompt || "";
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? `: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}` : "";
}

function assistantPiece(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === "text" && block.text) parts.push(String(block.text).trim());
    else if (block.type === "tool_use") parts.push(`🔧 ${block.name || "tool"}${toolSummary(block)}`);
    // thinking is not shown
  }
  return parts.filter(Boolean).join("\n");
}

export function parseTranscript(raw) {
  const entries = [];
  let lastAssistant = null;   // one reply is split over several log lines (same message.id); merge them back
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.isSidechain || ev.isMeta) continue;
    const ts = ev.timestamp ? (Date.parse(ev.timestamp) || 0) : 0;
    if (ev.type === "user") {
      const text = userText(ev.message?.content);
      if (!text) continue;
      entries.push({ role: "user", text, ts });
      lastAssistant = null;
    } else if (ev.type === "assistant") {
      const piece = assistantPiece(ev.message?.content);
      if (!piece) continue;
      const mid = ev.message?.id || "";
      if (lastAssistant && lastAssistant.mid === mid) {
        lastAssistant.text += `\n${piece}`;
      } else {
        lastAssistant = { role: "assistant", text: piece, ts, mid };
        entries.push(lastAssistant);
      }
    }
  }
  return entries.map(({ role, text, ts }) => ({ role, text, ts }));
}

// Parsing a long log takes a moment; keep the result until the file changes.
const cache = new Map();   // file -> { mtimeMs, size, entries }
export async function loadTranscript(file) {
  const info = await stat(file);
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.entries;
  const entries = parseTranscript(await readFile(file, "utf8"));
  cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, entries });
  if (cache.size > 32) cache.delete(cache.keys().next().value);
  return entries;
}
