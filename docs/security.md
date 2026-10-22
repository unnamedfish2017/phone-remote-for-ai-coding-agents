# Security

## Threat model

Phone Remote types into your terminals on your behalf. **Whoever can talk to it can run commands as you** — in every tmux window it can see. Everything below is about making sure only you can.

Phone Remote itself makes **no outbound network connections**, has no accounts, no telemetry, and the page loads nothing from the internet (no CDN fonts, no analytics).

## What protects it

Every request passes these checks, in this order:

1. **Source-IP allow-list.** By default only this machine, the private ranges `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, the CGNAT range `100.64.0.0/10` (Tailscale and many VPNs), and the IPv6 equivalents get in. Anyone else is refused before they can even try a token — so a machine with a public IP is not exposed just because the port is open. Change it with `--allow-from` (CIDRs, single IPs, or `*`).
2. **Host-header check** (only with `--no-auth`): DNS-rebinding protection. A web page on `evil.example` that resolves to `127.0.0.1` arrives with that name in `Host` and is refused; only IP literals and `localhost` pass.
3. **Access token.** 144 random bits, created on first start in `~/.phone-remote/token` (mode `0600`), compared in constant time, accepted **in a header only**. A token in a URL would end up in server logs, proxy logs, browser history and screenshots; the page strips `?token=` from the address bar after reading it. The full-size QR page that `--open` (or a first run on a desktop) shows is a file in the same private directory (`pair.html`, mode `0600`, no scripts, nothing loaded from the network); it contains the token and is deleted when Phone Remote stops.
4. **JSON writes only.** `POST` must be `application/json`, which a cross-site HTML form cannot send.

Input is validated before it reaches tmux: pane and window ids must look like `%3` / `@3`, key names come from a fixed allow-list, and text is typed literally (`send-keys -l`) or pasted — never interpreted by a shell.

## Which network

- ✅ **Tailscale / WireGuard / another VPN** — traffic is encrypted, and Phone Remote lists the VPN address. This is the recommended setup, with plain HTTP.
- ✅ **Your home or office LAN you trust** — plain HTTP is acceptable; anyone on that Wi-Fi who can sniff traffic could read the token, so prefer [HTTPS](#https) on shared networks.
- ⛔ **The internet** — don't. Not through a port forward, not on a public IP. If you really must, put it behind an authenticating reverse proxy and HTTPS, and think twice.

## Limit what it can reach

Phone Remote sees every window of the tmux server it connects to. To keep it away from your other sessions, run agents in a **separate tmux server** and point Phone Remote at it:

```bash
tmux -L agents new -s api          # start your agents here
phone-remote --socket-name agents        # Phone Remote only sees this server
```

## HTTPS

Plain HTTP exposes the token and everything on screen to anyone who can capture your network traffic. Options:

**Tailscale (best).** Real certificate, no browser warning:

```bash
tailscale cert my-machine.my-tailnet.ts.net       # writes my-machine.my-tailnet.ts.net.crt / .key
phone-remote --cert my-machine.my-tailnet.ts.net.crt --key my-machine.my-tailnet.ts.net.key \
       --public-url https://my-machine.my-tailnet.ts.net:8787
```

(HTTPS certificates must be enabled for your tailnet; see Tailscale's documentation.)

**Self-signed.** Works anywhere; the browser warns once.

```bash
scripts/make-cert.sh                      # creates ~/.phone-remote/tls/cert.pem and key.pem for this machine's addresses
phone-remote --cert ~/.phone-remote/tls/cert.pem --key ~/.phone-remote/tls/key.pem
```

On the phone choose *Advanced → continue*. (To avoid the warning, install `cert.pem` as a trusted certificate on the phone; how depends on the OS.)

**Behind a reverse proxy** (Caddy, nginx …) that terminates TLS: run `phone-remote --host 127.0.0.1` and proxy to it. Note that Phone Remote then sees every client as `127.0.0.1`, so the allow-list no longer protects you — the token still does, and the proxy should restrict who may connect. Phone Remote does not trust `X-Forwarded-For`.

## Rotating the token

Delete `~/.phone-remote/token` and restart Phone Remote; a new one is generated and the old link stops working. Or pass your own: `phone-remote --token "$(openssl rand -base64 24)"`.

## `--no-auth`

For quick experiments on one machine only. It refuses to start unless the bind address is loopback, and it checks the `Host` header. Never combine it with a tunnel or port forward.

## Reporting a vulnerability

Please open a private security advisory on the repository (Security → Report a vulnerability) rather than a public issue.
