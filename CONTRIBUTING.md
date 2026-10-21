# Contributing

Thanks for helping! This project is small on purpose: **no runtime dependencies**, one HTML file for the UI, plain Node.js. Please keep it that way — if something needs a library, it probably belongs elsewhere.

## Setup

```bash
git clone https://github.com/YOUR-NAME/phone-remote-for-ai-coding-agents.git && cd phone-remote-for-ai-coding-agents
npm test            # needs Node 18+ and tmux; no network
node bin/phone-remote.mjs --socket-path /tmp/phone-remote-dev.sock     # a throw-away tmux server to play with
```

The tests start the real CLI against a throw-away tmux server (own socket file), so they never touch your sessions.

## Add a language

One JSON file, nothing else — see [src/web/locales/README.md](src/web/locales/README.md). `npm test` tells you what is missing. **Read the section about `concise.default` before translating that sentence**: its wording was A/B-tested, and the obvious translation (spelling out "1, 2, 3, 4") makes models answer with exactly four points.

## Add an agent (or fix how one is typed to)

Everything lives in [`src/agents.mjs`](src/agents.mjs):

1. **Recognise it** in `classifyProcess()` — by the process name, or, for npm launchers that run as `node /…/bin/<name>`, by the script path. Add the cases to `tests/agents.test.mjs`.
2. **Give it a profile** in `AGENT_PROFILES`: the label, and `send.enterDelayMs` / `send.typedMaxChars` if it needs special treatment. Measure, don't guess: type a message with `tmux send-keys -l`, press Enter immediately, and see whether it submits (a scratch tmux server with `-S` makes this safe). Write what you found in the comment, as the existing profiles do.
3. **Teach the page** (`src/web/index.html`): `conciseApplies()` and the `data-for` attributes of the quick menu decide where the concise sentence and each menu entry show up.

## Code style

- Zero runtime dependencies; Node built-ins only. It must run on Node 18, 20 and 22.
- Comments explain *why* — a measurement, a bug that bit someone — not what the next line does.
- A user-visible string goes into the locale files, never into the code. A new server error gets a `code` (see `src/errors.mjs`) and an `err.<code>` entry in every language.
- Prefer a test that exercises the real thing (real tmux, the real CLI) over a mock.

## Screenshots

`node scripts/make-screenshots.mjs` rebuilds `docs/img/` from a throw-away demo (needs Node 22+, tmux and Chrome / Chromium; it never touches your own tmux).

## Pull requests

Describe what you saw and what you measured. Keep changes focused; run `npm test`; if you touched the UI, include a screenshot from a phone-sized window.
