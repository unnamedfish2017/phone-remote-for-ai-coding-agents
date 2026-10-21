# Troubleshooting

## The phone cannot open the link

1. Is the phone on the same Wi-Fi as the computer, or both on the same VPN (Tailscale, WireGuard …)? Use the link line tagged for that network.
2. Is the port open on the computer's firewall? On Ubuntu with `ufw`:
   ```bash
   sudo ufw allow 8787/tcp
   # or only from your VPN / LAN:
   sudo ufw allow in on tailscale0 to any port 8787 proto tcp
   ```
   A symptom of a firewall drop is that `curl` on the computer works but the phone spins forever.
3. The phone must open the address Phone Remote printed. If it needs a different name (a VPN host name, a reverse proxy), start with `--public-url http://that-name:8787` so the link and QR code use it.
4. Binding: Phone Remote listens on `0.0.0.0` by default. If you passed `--host`, that address must exist on this machine.

## "Your IP address is not allowed" (403)

The phone's address is outside the allow-list. By default that is loopback, `10/8`, `172.16/12`, `192.168/16`, `100.64/10` and the IPv6 local ranges. Add yours:

```bash
phone-remote --allow-from 192.168.0.0/16,203.0.113.0/24
```

The refused address is printed in Phone Remote's log: `refused 203.0.113.9: not in the allow-list`.

## Requests time out over a VPN or mobile data, but small things work

**Symptoms.** The page opens (or half opens), then the status line keeps saying *Request timed out* or *Failed to load the window list*. A screen that does not change still works (that reply is 44 bytes), but anything bigger stalls — often only on mobile data, and sometimes only for stretches of half a minute.

**Cause: a path-MTU black hole.** Somewhere on the path (typically a mobile network under a VPN) packets above a certain size are silently dropped, and the ICMP "fragmentation needed" message that would tell the sender to shrink them never arrives. Full-size TCP segments vanish, are retransmitted, vanish again; small ones get through. A TLS handshake is the classic victim because its first reply is one big packet. Many VPNs are configured for a larger MTU than the path really carries (OpenVPN's default `mssfix 1450` is an example).

**Diagnose** (Linux, on the computer running Phone Remote). While the phone is stuck:

```bash
ss -tni '( sport = :8787 )'
```

A connection from the phone showing `unacked:2`, a growing `retrans:` / `bytes_retrans` that is a multiple of the same segment size (`mss:1346`, say), and almost nothing received from the phone, is this problem. To measure where the cliff is, send pings of increasing size without fragmentation and compare the loss:

```bash
ping -M do -c 20 -s 1000 PHONE_VPN_IP
ping -M do -c 20 -s 1372 PHONE_VPN_IP
```

Random payloads are more honest than `ping`'s pattern payload (a compressing VPN shrinks that). In the case that led to this page, IP packets up to 1378 bytes passed and packets of 1398 bytes — exactly one full TCP segment — were dropped in bursts of about 30 seconds.

**Fix.** Make the computer send smaller packets towards the VPN network, for example by clamping the route's MTU (adjust the subnet, gateway and device to your VPN):

```bash
sudo ip route replace 10.8.0.0/24 via 10.8.0.1 dev tun0 mtu lock 1300
```

New connections pick it up straight away; reload the page on the phone. It lasts until the VPN reconnects. To undo it, run the same command without `mtu lock 1300`. A permanent fix belongs in the VPN configuration (a lower `mssfix` / `tun-mtu` for OpenVPN, `MTU = 1280` on the WireGuard interface).

Phone Remote already helps a little: replies are gzipped, so most fit in one or two packets, and requests time out after 6 s and are retried instead of freezing the screen.

## A window is missing, or shows the wrong program

- Phone Remote talks to tmux's **default server**. If your agents run in another one (`tmux -L work`), start Phone Remote with `--socket-name work` (or `--socket-path /path/to/socket`).
- Program detection reads the process tree under each window, so it sees `claude`, `codex` and `opencode` whatever they are called in tmux. If an agent runs on another machine through `ssh`, the local tree only shows `ssh`: it is treated as a plain terminal.
- On macOS, detection uses `ps`. If a window is not recognised, run `ps -axo pid=,ppid=,args=` and check that the command line contains `claude`, `codex` or `opencode`; please file an issue with that output.

## Codex needs a second Enter

Phone Remote handles Codex's "paste burst" detection for you when it recognises the window. If it still happens, the window was not recognised (see above). Codex also has a switch that removes the cause on its side: set `disable_paste_burst = true` in `~/.codex/config.toml`.

## Colours look washed out or black bars appear

Terminal programs usually assume a dark background. In the light theme their colours can be unreadable (OpenCode paints its own dark panels). Use **⚙ → Theme → Dark**.

## Keep it running

Inside tmux itself (handy, but Phone Remote then lists its own window):

```bash
tmux new -d -s phone-remote 'node /path/to/phone-remote-for-ai-coding-agents/bin/phone-remote.mjs --no-qr'
```

Or as a systemd user service (`~/.config/systemd/user/phone-remote.service`):

```ini
[Unit]
Description=Phone Remote for AI Coding Agents

[Service]
ExecStart=/usr/bin/env node /path/to/phone-remote-for-ai-coding-agents/bin/phone-remote.mjs --no-qr
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now phone-remote
cat ~/.phone-remote/token                      # your token
```

## Start over

Stop Phone Remote, delete `~/.phone-remote`, start again: you get a fresh token and the old link stops working. Browsers keep the token and preferences in local storage; clear the site data on the phone (or use **⚙ → Change access token**).
