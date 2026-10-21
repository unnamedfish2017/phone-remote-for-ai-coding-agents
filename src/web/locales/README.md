# Interface languages / 界面语言

One JSON file per language: `<code>.json` (`en.json`, `zh-CN.json`, `pt-BR.json` …).
The page picks them up automatically — **adding a language means adding one file here**, nothing else.

## Add a language

1. Copy `en.json` to `<code>.json` (a BCP-47 code such as `it`, `pt-BR`, `zh-TW`).
2. Set `"_name"` to the language's own name (`"Italiano"`). That is what the language menu shows.
3. Translate every value. Keep the `{placeholders}` exactly as they are (`{n}`, `{label}`, `{error}` …) — you may move them around in the sentence.
4. Run `npm test`. It checks that no key is missing, no placeholder is lost, and that every key the page asks for exists.

`zh-CN.json` is the source of truth (its dictionary is embedded in the page, so the default language costs no extra request);
every other language falls back to it for a key it does not have.

## The `concise.default` sentence — please read before translating it

The "Concise" tick box next to the input appends this sentence to what the user sends, so that the AI answers with a short numbered list.
Its wording was chosen by A/B-testing real replies (Haiku 4.5 and Sonnet 5.5, 11 questions), not by taste:

* **Do not spell out numbers such as "1, 2, 3, 4".** With four numbers in the sentence the model answered with exactly four points
  7–8 times out of 11, even for a yes/no question.
* Saying only "any number of items" makes the count vary, but the replies got ~30 % longer (the model tries to be complete).
* What worked: **one sentence per item**, **key points only**, **as many items as there are points**, **don't pad, don't aim for completeness**.
  The count then follows the content (a yes/no question gets one item) and replies are no longer than before.

So translate the meaning of all of those parts, not word for word. If you can, try your wording on a few real questions
(count the items, compare the length) before sending a pull request.

## Server errors

The server answers errors as `{"error": {"code": "bad_pane", "message": "<fallback text>", …}}`.
The page looks up `err.<code>` in the dictionary; a code without an entry falls back to the server's own `message`.
