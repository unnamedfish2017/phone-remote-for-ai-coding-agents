#!/usr/bin/env bash
# Creates a self-signed certificate so the server can serve HTTPS:  ~/.phone-remote/tls/cert.pem and key.pem
#
#   scripts/make-cert.sh [extra IPs or host names …]     (this machine's own addresses are included automatically)
#   phone-remote --cert ~/.phone-remote/tls/cert.pem --key ~/.phone-remote/tls/key.pem
#
# A self-signed certificate makes the browser show a warning once (tap "advanced → continue"). If you use Tailscale,
# `tailscale cert <machine>.<tailnet>.ts.net` gives you a real certificate with no warning — see docs/security.md.
set -euo pipefail

command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
DIR="${PHONE_REMOTE_HOME:-$HOME/.phone-remote}/tls"
mkdir -p "$DIR"
chmod 700 "$DIR"

SAN="DNS:localhost,IP:127.0.0.1"
# every IPv4 address of this machine (node is already a requirement, so use it: no platform-specific tools)
for ip in $(node -e 'for (const l of Object.values(require("os").networkInterfaces())) for (const i of l) if (i.family === "IPv4" && !i.internal) console.log(i.address)'); do
  SAN="$SAN,IP:$ip"
done
for extra in "$@"; do
  if [[ "$extra" =~ ^[0-9.]+$ ]]; then SAN="$SAN,IP:$extra"; else SAN="$SAN,DNS:$extra"; fi
done

openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" -subj "/CN=phone-remote" -addext "subjectAltName=$SAN" 2>/dev/null
chmod 600 "$DIR/key.pem"

echo "Certificate for: ${SAN//,/  }"
echo "  $DIR/cert.pem"
echo "  $DIR/key.pem"
echo
echo "Start the server with:  phone-remote --cert $DIR/cert.pem --key $DIR/key.pem"
