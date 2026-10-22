# How it works

Phone Remote is one Node process with no dependencies. The browser page is a single HTML file; the server answers a handful of JSON requests by running `tmux` commands.

```text
src/
  cli.mjs                options, token, startup banner (links + QR code)
  server.mjs             HTTP(S) server, routes, language files, gzip
  tmux.mjs               list windows, read a pane's screen, send input
  agents.mjs             which program is in a window, and how to type to it
  claude-transcript.mjs  earlier conversation, read from Claude Code's session log
  netguard.mjs           source-IP allow-list, Host-header check
  qr.mjs                 QR code for the terminal (two sizes) and as SVG (≈260 lines, decoder-verified)
  pair-page.mjs          the full-size QR page opened in a browser (--open)
  web/index.html         the whole phone UI
  web/locales/*.json     interface languages
```

## The screen

No pty, no terminal emulator. For each pane Phone Remote runs

```bash
tmux capture-pane -p -e -t %3      # the visible screen, with colours as SGR escape codes
```

and the page turns the SGR codes into coloured `<span>`s (a few dozen lines: 16 / 256 / true colour, bold, dim, italic, underline, reverse, wide characters). Every other escape sequence is dropped.

The page polls every 350 ms. Each reply carries a hash of the screen; the page sends the last hash back, and if nothing changed the answer is `{"unchanged":true,…}` — 44 bytes. Only changed screens are sent in full, gzipped when the browser accepts it. Polling (instead of a WebSocket) keeps the server stateless and makes recovery after a phone sleeps trivial: the next poll simply works. Read requests time out after 6 s so one half-dead connection cannot freeze the screen; writes never time out, because a timeout does not mean the keys did not arrive.

**Scrollback.** Programs on the alternate screen (Claude Code, Codex, OpenCode, vim …) have no scrollback in a real terminal. tmux still keeps whatever the shell printed *before* they started; Phone Remote does not send that, since showing it above the live screen would only confuse. For Claude Code, earlier conversation comes from its session log instead: `~/.claude/sessions/<pid>.json` registers each running process with its tmux pane, and the log is `~/.claude/projects/<cwd>/<session>.jsonl`. Pane ids such as `%3` repeat across tmux servers, so a registration is only attached to a window when its process really sits inside that pane's process tree.

## Input

Text goes in with `tmux send-keys -l` (literal, as if typed) or, for multi-line text, as a bracketed paste (`load-buffer` + `paste-buffer -p`) so the program takes it as one block. Special keys come from a fixed allow-list of tmux key names.

### Why each agent gets its own way of being typed to

A page has one way to send a message: put the characters in, then press Enter. Measured on Codex 0.163.0, OpenCode 1.18.33 and Claude Code, that is not equally safe for all of them.

**Codex** has a "paste burst" heuristic for terminals without bracketed paste: three or more characters arriving at intervals of a few milliseconds are treated as a paste, and an Enter during that burst, or within about 120 ms after it, becomes a *newline* instead of "submit" (constants from its source: 3 characters, 8 ms, 120 ms). `send-keys -l text` followed immediately by `Enter` is exactly such a burst, so the message sat in the box until you pressed Enter a second time.

| Way of sending | Codex submits on the first Enter? |
|---|---|
| typed, Enter right away | ❌ |
| typed, wait 100 ms or more, Enter | ✅ up to ~800 characters |
| typed, any wait | ❌ from ~1500 characters (it never settles) |
| bracketed paste, Enter right away | ✅ at any length |
| slash command (`/status`) typed + wait | ✅ |

So Phone Remote types short text and waits 250 ms before Enter, and sends anything over 200 characters (or multi-line) as a paste. **OpenCode** and **Claude Code** accept the plain way. Windows it does not recognise get a 150 ms pause, which costs nothing in a shell and keeps other TUIs with paste detection safe. The plan for one request is a pure function (`planSend` in `src/agents.mjs`) that the tests pin down.

## Which program is in a window

Looking at the window name or tmux's `pane_current_command` does not work: tmux reports `node` for Codex's npm launcher, and the same shell window runs a different program every day. Phone Remote walks the **process tree** under the pane's process, level by level, and the match closest to the pane wins (so a `codex exec` that Claude Code ran in its Bash tool does not turn a Claude window into a Codex one). A few layers of `bash` / `su` in between are fine. On Linux it reads `/proc`; elsewhere it falls back to one `ps -axo pid=,ppid=,args=`. Native binaries are matched by name (also by `argv[0]`, because on macOS a binary can be called `2.1.284` while it was started as `claude`); npm installs run as `node …/bin/codex`, so the script path counts.

Detection is re-run right before every send (the program may just have changed), and cached for 1.5 s for the window list.

## Languages

The default language's dictionary is embedded in the page by the server, so first paint needs no extra request. Any other language is fetched once from `/locales/<code>.json` (with an ETag), falling back to the default if that fails or takes more than 4 s. Server errors carry a stable `code`; the page translates `err.<code>`. [Adding a language](../src/web/locales/README.md) is one JSON file, and the tests fail if a key, a placeholder or an error-code translation is missing.

## Concise mode

The page appends a sentence to prompts when the **Concise** box is ticked; it is skipped for slash commands, `!` and `#` lines, one-character answers and windows that are not AI programs. The sentence is per language and was chosen by [A/B testing real replies](../README.md#concise-mode).
