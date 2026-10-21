# Voice input · 语音输入

[English](#english) · [中文](#中文)

---

## English

### Why there is no speech recognition of its own

Putting an AI agent on your phone is mostly about *not typing*. But browser speech recognition (the Web Speech API) needs a secure context (HTTPS) and a microphone permission prompt, and it is not available in every mobile browser. Your phone's **keyboard** already does dictation, better integrated and without any of that.

So the input is a plain text box that is careful about input methods (it ignores Enter while an IME is composing, so confirming dictated text never sends half a sentence). Whatever voice keyboard you have fills it. As a bonus, the page never touches the microphone: **plain HTTP on your LAN or VPN is enough**.

### Doubao Input Method (豆包输入法) — the author's setup

The author drives it every day with Doubao voice input, and it feels great.

1. Install Doubao Input Method on your phone and select it as the keyboard.
2. Open the page and tap the input box.
3. Tap the 🎙️ key on the keyboard, talk, stop.
4. Look at the text, fix a word if you need to, tap **Send**.

Tips that make it smoother:

- **Leave "Concise" ticked** (next to the Enter checkbox). Spoken prompts are long and chatty; the agent's answer comes back as a short numbered list that fits on a phone screen.
- **One request per breath.** Dictate one task, send it, read the answer, dictate the next. Agents handle a stream of small instructions better than one 600-word monologue.
- **"Enter sends"** (⚙ Settings) lets the keyboard's return key send the message once the IME has finished composing. If your voice keyboard uses return for a new line, leave it off and tap **Send**.
- **Approvals by voice or thumb.** When an agent asks *"Do you want to proceed?"*, type or say `1` / `y`; the key bar also has Enter, Esc and the arrow keys. Concise mode never appends anything to such short answers.
- **Slash commands** (`/compact`, `/new`, `/status` …) are one tap away in the ⚡ menu, which changes with the program in the window. Dictating them is possible but fiddly.
- **Names and code.** Dictation is great for intent ("rename the config loader to read from environment variables") and weaker for exact identifiers. Say the intent, let the agent find the identifier — or type the one odd word by hand.

### Other voice keyboards

Gboard, iOS dictation, Sogou, iFlytek, Samsung Keyboard … anything that types into a text box works the same way.

---

## 中文

### 为什么它自己不做语音识别

把 AI 助手装进手机，图的就是"不用打字"。但浏览器自带的语音识别（Web Speech API）需要安全上下文（HTTPS）和麦克风授权弹窗，而且不是所有手机浏览器都有。你手机的 **键盘** 本来就有语音输入，集成得更好，还没有这些麻烦。

所以它的输入就是一个处理好了输入法细节的文本框（输入法组词期间会忽略回车，确认语音识别的文字时不会把半句话发出去）。你有什么语音输入法，就用它来填。顺带的好处：页面完全不碰麦克风，**局域网或 VPN 里用普通 HTTP 就够了**。

### 豆包输入法——作者的用法

作者每天用豆包输入法的语音输入来操作它，体验很好。

1. 在手机上安装豆包输入法，并设为当前键盘。
2. 打开页面，点输入框。
3. 点键盘上的 🎙️，说话，说完。
4. 扫一眼识别出的文字，有错字就改一下，点 **发送**。

让它更顺手的小技巧：

- **保持"精简"打勾**（在"回车"旁边）。口语提示词又长又啰嗦；助手的回答会变成适合手机屏幕的简短编号清单。
- **一口气只说一件事。** 说一个任务、发出去、看回答、再说下一个。助手处理一连串小指令，比处理一段 600 字的独白要好。
- **"回车即发送"**（⚙ 设置）让键盘的回车键在输入法组词结束后直接发送。如果你的语音输入法把回车用作换行，就保持关闭，点 **发送** 按钮。
- **用嘴或用拇指做确认。** 助手问 *"要继续吗？"* 时，打字或说 `1` / `y` 都行；按键条里还有 Enter、Esc 和方向键。精简模式绝不会往这种短答复后面追加东西。
- **斜杠命令**（`/compact`、`/new`、`/status` ……）在 ⚡ 菜单里一点就发，而且菜单会随窗口里的程序变化。语音说斜杠命令可以，但比较别扭。
- **名字和代码。** 语音很适合表达意图（"把配置加载器改成从环境变量读取"），不太适合精确的标识符。说意图，让助手去找标识符——或者那一个奇怪的词手打。

### 其他语音输入法

讯飞、搜狗、Gboard、iOS 听写、三星键盘……任何能往文本框里打字的输入法，用起来都一样。
