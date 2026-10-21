import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_ALLOW_FROM, hostHeaderOk, ipAllowed, isLoopbackHost, parseAllowList, parseIp, parseRule } from "../src/netguard.mjs";

const defaults = parseAllowList(DEFAULT_ALLOW_FROM);

test("parseIp understands IPv4, IPv6, brackets, zone ids and IPv4-mapped addresses", () => {
  assert.deepEqual(parseIp("192.168.1.5"), { v: 4, n: 0xc0a80105n });
  assert.equal(parseIp("::1").v, 6);
  assert.equal(parseIp("::1").n, 1n);
  assert.equal(parseIp("[::1]").n, 1n);
  assert.equal(parseIp("fe80::1%eth0").v, 6);
  assert.deepEqual(parseIp("::ffff:10.0.0.7"), { v: 4, n: 0x0a000007n });
  assert.equal(parseIp("2001:db8:0:0:0:0:0:1").n, parseIp("2001:db8::1").n);
  for (const bad of ["", "hello", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1:2:3:4:5:6:7:8:9", ":::", "12345::1", "1.2.3.4/24"]) {
    assert.equal(parseIp(bad), null, `${bad} must not parse`);
  }
});

test("default allow-list: loopback, private networks, CGNAT (Tailscale) and IPv6 local ranges are in", () => {
  for (const ip of ["127.0.0.1", "127.8.8.8", "::1", "::ffff:127.0.0.1", "10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.255",
    "192.168.0.10", "100.64.0.1", "100.101.102.103", "100.127.255.255", "fd12:3456::1", "fc00::5", "fe80::abcd"]) {
    assert.ok(ipAllowed(defaults, ip), `${ip} should be allowed`);
  }
});

test("default allow-list: public addresses and the edges just outside private ranges are out", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1", "11.0.0.1",
    "2001:4860:4860::8888", "fe00::1", "::ffff:8.8.8.8", "", "not-an-ip"]) {
    assert.ok(!ipAllowed(defaults, ip), `${ip} must be refused`);
  }
});

test("CIDR, exact IP, old-style prefix and wildcard entries", () => {
  const rules = parseAllowList("203.0.113.0/24, 198.51.100.7, 10.20., *");
  assert.ok(ipAllowed(rules, "1.2.3.4"), "* lets everything in");
  const narrow = parseAllowList("203.0.113.0/24, 198.51.100.7, 10.20.");
  assert.ok(ipAllowed(narrow, "203.0.113.200"));
  assert.ok(!ipAllowed(narrow, "203.0.114.1"));
  assert.ok(ipAllowed(narrow, "198.51.100.7"));
  assert.ok(!ipAllowed(narrow, "198.51.100.8"));
  assert.ok(ipAllowed(narrow, "10.20.4.5"));
  assert.ok(!ipAllowed(narrow, "10.21.4.5"));
  assert.ok(ipAllowed(parseAllowList("0.0.0.0/0"), "9.9.9.9"));
  assert.ok(!ipAllowed(parseAllowList("0.0.0.0/0"), "::1"), "an IPv4 rule never matches an IPv6 client");
});

test("an invalid allow-list entry is an error, not a silent hole", () => {
  assert.throws(() => parseAllowList("192.168.0.0/16, banana"), /invalid --allow-from entry: "banana"/);
  assert.throws(() => parseAllowList("10.0.0.0/33"), /10\.0\.0\.0\/33/);
  assert.equal(parseRule("  "), null);
});

test("loopback detection for the --no-auth rule", () => {
  for (const h of ["127.0.0.1", "127.3.4.5", "localhost", "LOCALHOST", "::1", "[::1]"]) assert.ok(isLoopbackHost(h), h);
  for (const h of ["0.0.0.0", "192.168.1.2", "example.com", "::", "10.0.0.1", ""]) assert.ok(!isLoopbackHost(h), h);
});

test("Host header check accepts IP literals and localhost, refuses names (DNS rebinding)", () => {
  for (const h of ["127.0.0.1:8787", "localhost:8787", "localhost", "192.168.1.9:80", "[::1]:8787", "[::1]"]) assert.ok(hostHeaderOk(h), h);
  for (const h of ["evil.example", "evil.example:8787", "127.0.0.1.evil.example", "", undefined]) assert.ok(!hostHeaderOk(h), String(h));
});
