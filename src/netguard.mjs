// Who may talk to the server.
//
// Anyone who gets through can type into your terminals, so the source-IP check is a second lock behind the token:
// even if the port is reachable from the internet (public IP, a forwarded port, a firewall rule that got widened),
// strangers are refused in-process before they can even try a token.

// Loopback, the three RFC 1918 private ranges, CGNAT (Tailscale and friends), IPv6 loopback / unique-local / link-local.
export const DEFAULT_ALLOW_FROM = [
  "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10",
  "::1/128", "fc00::/7", "fe80::/10",
].join(",");

// "1.2.3.4" / "::1" / "::ffff:1.2.3.4" → { v: 4 | 6, n: BigInt }, or null when it is not an IP address.
export function parseIp(text) {
  const s = String(text || "").trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");     // [::1] and zone ids (fe80::1%eth0)
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some(o => o > 255)) return null;
    return { v: 4, n: octets.reduce((acc, o) => (acc << 8n) | BigInt(o), 0n) };
  }
  if (!s.includes(":")) return null;
  // IPv6, possibly with an embedded dotted-quad tail
  let head = s, tailGroups = [];
  const dotted = /(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const tail = parseIp(dotted[2]);
    if (!tail) return null;
    // "::ffff:" + "1.2.3.4": drop the colon that joined them, unless it is half of a "::"
    head = dotted[1].endsWith("::") ? dotted[1] : dotted[1].slice(0, -1);
    tailGroups = [Number((tail.n >> 16n) & 0xffffn), Number(tail.n & 0xffffn)];
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const parse = part => (part === "" ? [] : part.split(":"));
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  const groups = [...left, ...right];
  const total = groups.length + tailGroups.length;
  if (halves.length === 1 ? total !== 8 : total > 7) return null;
  const toNum = g => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN);
  const nums = [...left.map(toNum), ...Array(halves.length === 2 ? 8 - total : 0).fill(0), ...right.map(toNum), ...tailGroups];
  if (nums.length !== 8 || nums.some(Number.isNaN)) return null;
  const n = nums.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n);
  // ::ffff:a.b.c.d is an IPv4 client reaching a dual-stack socket
  if ((n >> 32n) === 0xffffn) return { v: 4, n: n & 0xffffffffn };
  return { v: 6, n };
}

// One allow-list entry: "*", an exact IP, a CIDR ("192.168.0.0/16", "fc00::/7"), or the old-style prefix ("10.20.").
export function parseRule(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (s === "*") return { any: true };
  const cidr = /^(.+)\/(\d{1,3})$/.exec(s);
  if (cidr) {
    const ip = parseIp(cidr[1]);
    const bits = Number(cidr[2]);
    if (!ip || bits > (ip.v === 4 ? 32 : 128)) return null;
    return { v: ip.v, n: ip.n, bits };
  }
  const ip = parseIp(s);
  if (ip) return { v: ip.v, n: ip.n, bits: ip.v === 4 ? 32 : 128 };
  if (/^[0-9a-fA-F.:]+[.:]$/.test(s)) return { prefix: s.toLowerCase() };           // "10.20." or "fd00:"
  return null;
}

export function parseAllowList(text) {
  const rules = [];
  for (const part of String(text || "").split(",").map(p => p.trim()).filter(Boolean)) {
    const rule = parseRule(part);
    if (!rule) throw new Error(`invalid --allow-from entry: "${part}" (use CIDR like 192.168.0.0/16, an IP, or a prefix like 10.20.)`);
    rules.push(rule);
  }
  return rules;
}

export function ipAllowed(rules, ipText) {
  const ip = parseIp(ipText);
  const shown = String(ipText || "").replace(/^::ffff:/i, "").toLowerCase();
  return rules.some(rule => {
    if (rule.any) return true;
    if (rule.prefix) return shown.startsWith(rule.prefix);
    if (!ip || ip.v !== rule.v) return false;
    const width = BigInt(rule.v === 4 ? 32 : 128);
    const shift = width - BigInt(rule.bits);
    return (ip.n >> shift) === (rule.n >> shift);
  });
}

export function isLoopbackHost(host) {
  const h = String(host || "").trim().toLowerCase();
  if (h === "localhost") return true;
  const ip = parseIp(h);
  if (!ip) return false;
  return ip.v === 4 ? (ip.n >> 24n) === 127n : ip.n === 1n;
}

// Without a token the server is only safe if a *web page* cannot reach it on the user's behalf. DNS rebinding
// (evil.example resolving to 127.0.0.1) arrives with that name in the Host header, so accept only IP literals and localhost.
export function hostHeaderOk(hostHeader) {
  const raw = String(hostHeader || "").trim();
  if (!raw) return false;
  const host = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.replace(/:\d+$/, "");
  return host.toLowerCase() === "localhost" || parseIp(host) !== null;
}
