# Running Phone Remote on Windows · 在 Windows 上运行

Phone Remote needs **tmux**, and there is no tmux for Windows itself (PowerShell and CMD cannot run it). The way is **WSL2**, the Linux that ships with Windows: tmux, Node.js, your agents and Phone Remote all run inside an Ubuntu terminal, and your phone connects to it over Wi-Fi. This page follows Microsoft's [WSL networking guide](https://learn.microsoft.com/en-us/windows/wsl/networking); the author has not tried it on a Windows machine, so reports are welcome.

[中文说明在下面 ↓](#中文说明)

## 1. Install WSL2 and Ubuntu (once)

In PowerShell **as Administrator**:

```powershell
wsl --install
```

Reboot if it asks, then open **Ubuntu** from the Start menu and create a Linux user.

## 2. Install tmux and Node.js 18+ inside Ubuntu

```bash
sudo apt update && sudo apt install -y tmux git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version        # v22.x (Ubuntu's own nodejs package is too old)
```

## 3. Get it and run it — in the Linux home folder, not under `/mnt/c`

```bash
cd ~
git clone https://github.com/unnamedfish2017/phone-remote-for-ai-coding-agents.git
cd phone-remote-for-ai-coding-agents
node bin/phone-remote.mjs
```

The terminal shows a QR code and the links. (Windows Terminal draws the code fine; make the window tall enough and it gets twice as big. `--open` tries to open a page with a full-size code in your Windows browser through `wslview`, which comes with the `wslu` package; if that is missing, use the terminal code.)

## 4. Run your agents inside WSL, in tmux

Install `claude`, `codex` or `opencode` **inside Ubuntu** (a Windows-side install is invisible to the tmux in WSL), then:

```bash
tmux new -s api
claude          # or codex / opencode
```

Every tmux window shows up on the phone.

## 5. Let the phone reach it

WSL2 has its own virtual network by default (NAT): the address in the banner (`172.x.x.x`) works from the PC only. Pick one of these.

### A. Mirrored networking — Windows 11 22H2 or newer (recommended)

WSL then shares the PC's network, so the banner shows the PC's own Wi-Fi address.

1. Create or edit `%UserProfile%\.wslconfig` (that is `C:\Users\<you>\.wslconfig`):

   ```ini
   [wsl2]
   networkingMode=mirrored
   ```

2. In PowerShell **as Administrator**: restart WSL and allow inbound connections to it:

   ```powershell
   wsl --shutdown
   Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow
   ```

3. Open Ubuntu again, run Phone Remote, scan the code with the phone **on the same Wi-Fi**.

If the phone still cannot connect, also allow the port in Windows Defender Firewall (PowerShell as Administrator):

```powershell
New-NetFirewallRule -DisplayName "Phone Remote" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow
```

### B. Port forwarding — Windows 10, or when mirrored mode is not available

In PowerShell **as Administrator** (the WSL address changes after a reboot, so run it again then):

```powershell
$ip = (wsl hostname -I).Trim().Split(" ")[0]
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8787 connectaddress=$ip connectport=8787
New-NetFirewallRule -DisplayName "Phone Remote" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow
```

Find the PC's Wi-Fi address with `ipconfig` (the "IPv4 Address" of the Wi-Fi adapter) and tell Phone Remote to use it, so the link and the QR code carry the address your phone can reach:

```bash
node bin/phone-remote.mjs --public-url http://192.168.1.50:8787
```

To undo the forwarding: `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=8787`.

With forwarding, every connection reaches Phone Remote from the WSL gateway address (`172.x`), so `--allow-from` cannot tell your phone from other devices on the Wi-Fi: the access token is what protects it. Keep the link private.

### C. Tailscale

Install [Tailscale](https://tailscale.com) on the phone and inside Ubuntu (WSL needs systemd for that: put `[boot]` and `systemd=true` on two lines in `/etc/wsl.conf`, then `wsl --shutdown`). Phone Remote then lists the Tailscale address and works from anywhere, no router or firewall changes.

## Good to know

- The first run creates the access token in `~/.phone-remote/` inside Ubuntu, not in your Windows profile.
- Stopping the terminal stops Phone Remote; tmux and your agents keep running. Start it again any time.
- To start it automatically, run it in its own tmux window: `tmux new -d -s phone-remote 'node ~/phone-remote-for-ai-coding-agents/bin/phone-remote.mjs --no-qr'`.

---

# 中文说明

Phone Remote 依赖 **tmux**，而 Windows 本身没有 tmux（PowerShell / CMD 都跑不了）。办法是用 **WSL2**（Windows 自带的 Linux）：tmux、Node.js、你的 AI 助手和 Phone Remote 都装在 Ubuntu 里运行，手机通过 Wi-Fi 连过来。本文网络部分参考微软的 [WSL 网络文档](https://learn.microsoft.com/zh-cn/windows/wsl/networking)；作者没有在 Windows 上实际试过，欢迎反馈。

1. **装 WSL2 和 Ubuntu**（一次）：以管理员身份打开 PowerShell，运行 `wsl --install`，按提示重启，然后从开始菜单打开 **Ubuntu** 并创建用户。
2. **在 Ubuntu 里装 tmux 和 Node.js 18+**：命令见上面第 2 步（Ubuntu 自带的 nodejs 太旧，要用 NodeSource 那条）。
3. **在 Linux 主目录里克隆并运行**（不要放在 `/mnt/c` 下）：`git clone …`、`cd …`、`node bin/phone-remote.mjs`，终端里会显示二维码和链接。
4. **在 WSL 里的 tmux 中运行助手**：`claude`、`codex`、`opencode` 都要装在 **Ubuntu 里**（装在 Windows 上的 tmux 看不到）。
5. **让手机连得上**——WSL2 默认是独立的虚拟网络（NAT），横幅里的 `172.x.x.x` 只有电脑自己能访问，三选一：
   - **A. 镜像网络（Windows 11 22H2 及以上，推荐）**：在 `C:\Users\你的用户名\.wslconfig` 里写 `[wsl2]` 和 `networkingMode=mirrored`；管理员 PowerShell 里运行 `wsl --shutdown`，再运行 `Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow`；重新打开 Ubuntu 运行，手机在**同一个 Wi-Fi** 下扫码。还连不上就在 Windows 防火墙里放行 8787 端口（命令见上文）。
   - **B. 端口转发（Windows 10 或没有镜像模式）**：用上文的 `netsh interface portproxy …` 命令（WSL 地址重启后会变，需要重新运行），用 `ipconfig` 查电脑的 Wi-Fi 地址，然后 `node bin/phone-remote.mjs --public-url http://电脑的Wi-Fi地址:8787`，这样链接和二维码里才是手机能访问的地址。
   - **C. Tailscale**：手机和 Ubuntu 里都装 Tailscale（WSL 里需要先启用 systemd），之后不用改路由器和防火墙，在哪都能连。

`--open` 会通过 `wslview`（`wslu` 软件包）在 Windows 浏览器里打开整页大二维码；没有 `wslview` 时直接用终端里的二维码。
