import assert from "node:assert/strict";
import test from "node:test";

import { buildLinks, classifyAddress, interfaceAddresses, langFromEnv, parseArgs } from "../src/cli.mjs";

const LOCALES = ["zh-CN", "en", "zh-TW", "ja", "ko", "es", "fr", "de", "pt", "ru"];
const env = {};     // parseArgs reads defaults from the environment: start from a clean one

test("defaults: listen everywhere, token required, private networks only", () => {
  const c = parseArgs([], env);
  assert.equal(c.host, "0.0.0.0");
  assert.equal(c.port, 8787);
  assert.equal(c.noAuth, false);
  assert.equal(c.allowAny, false);
  assert.ok(c.allowRules.length >= 8, "default allow-list should cover loopback, private and CGNAT ranges");
  assert.equal(c.defaultLang, "zh-CN");
});

test("environment variables set the defaults, flags win", () => {
  const c = parseArgs(["--port", "9000", "--token", "from-flag"], { PHONE_REMOTE_TOKEN: "from-env", PHONE_REMOTE_ALLOW_FROM: "203.0.113.0/24", PHONE_REMOTE_DEFAULT_LANG: "en", PHONE_REMOTE_HOME: "/tmp/w" });
  assert.equal(c.port, 9000);
  assert.equal(c.token, "from-flag");
  assert.equal(c.defaultLang, "en");
  assert.equal(c.stateDir, "/tmp/w");
  assert.equal(c.allowRules.length, 1);
  assert.equal(parseArgs([], { PHONE_REMOTE_TOKEN: "from-env" }).token, "from-env");
});

test("--no-auth is refused unless the address is loopback", () => {
  assert.throws(() => parseArgs(["--no-auth"], env), /only allowed together with a loopback/);
  assert.throws(() => parseArgs(["--no-auth", "--host", "192.168.1.5"], env), /loopback/);
  assert.equal(parseArgs(["--no-auth", "--host", "127.0.0.1"], env).noAuth, true);
  assert.equal(parseArgs(["--no-auth", "--host", "localhost"], env).noAuth, true);
});

test("bad options fail loudly", () => {
  assert.throws(() => parseArgs(["--port", "99999"], env), /--port/);
  assert.throws(() => parseArgs(["--port", "abc"], env), /--port/);
  assert.throws(() => parseArgs(["--port"], env), /missing value/);
  assert.throws(() => parseArgs(["--nope"], env), /unknown option: --nope/);
  assert.throws(() => parseArgs(["--cert", "a.pem"], env), /go together/);
  assert.throws(() => parseArgs(["--allow-from", "10.0.0.0/8,banana"], env), /invalid --allow-from entry/);
  assert.equal(parseArgs(["--port", "0"], env).port, 0);
});

test("--allow-any turns the allow-list off, --socket-name / --socket-path become tmux arguments", () => {
  assert.equal(parseArgs(["--allow-any"], env).allowAny, true);
  assert.deepEqual(parseArgs(["--socket-name", "work"], env).socketArgs, ["-L", "work"]);
  assert.deepEqual(parseArgs(["--socket-path", "/tmp/x"], env).socketArgs, ["-S", "/tmp/x"]);
  assert.equal(parseArgs(["--public-url", "http://phone.example:8787/"], env).publicUrl, "http://phone.example:8787");
});

test("the link language comes from the system locale", () => {
  const lang = e => langFromEnv(e, LOCALES);
  assert.equal(lang({ LANG: "zh_CN.UTF-8" }), "zh-CN");
  assert.equal(lang({ LANG: "zh_TW.UTF-8" }), "zh-TW");
  assert.equal(lang({ LANG: "zh_HK.UTF-8" }), "zh-TW");
  assert.equal(lang({ LANG: "ja_JP.UTF-8" }), "ja");
  assert.equal(lang({ LANG: "pt_BR.UTF-8" }), "pt");
  assert.equal(lang({ LANG: "de_AT.UTF-8" }), "de");
  assert.equal(lang({ LC_ALL: "fr_FR.UTF-8", LANG: "en_US.UTF-8" }), "fr", "LC_ALL wins over LANG");
  assert.equal(lang({ LANG: "en_US.UTF-8" }), "en");
  assert.equal(lang({ LANG: "C.UTF-8" }), "en");
  assert.equal(lang({ LANG: "C" }), "en");
  assert.equal(lang({}), "en");
  assert.equal(lang({ LANG: "tlh_XX.UTF-8" }), "en", "a language without a dictionary falls back to English");
  assert.equal(langFromEnv({ LANG: "it_IT.UTF-8" }, [...LOCALES, "it"]), "it", "a newly added dictionary is picked up");
});

test("addresses are classified: private LAN, VPN (CGNAT / tunnels), loopback, everything else", () => {
  assert.equal(classifyAddress("192.168.1.5"), "lan");
  assert.equal(classifyAddress("10.0.0.7"), "lan");
  assert.equal(classifyAddress("172.20.1.1"), "lan");
  assert.equal(classifyAddress("172.32.1.1"), "other");
  assert.equal(classifyAddress("100.101.102.103"), "vpn");
  assert.equal(classifyAddress("100.63.0.1"), "other");
  assert.equal(classifyAddress("127.0.0.1"), "local");
  assert.equal(classifyAddress("8.8.8.8"), "other");
  assert.equal(classifyAddress("fe80::1"), "other");
});

test("interfaceAddresses skips containers and bridges, and calls tunnel devices VPNs", () => {
  const nic = (address, family = "IPv4") => [{ address, family, internal: false }];
  const found = interfaceAddresses({
    lo: nic("127.0.0.1"), eth0: nic("192.168.1.20"), docker0: nic("172.17.0.1"), "br-1a2b": nic("172.18.0.1"), veth9: nic("172.19.0.5"),
    tailscale0: nic("100.100.1.1"), wg0: nic("10.8.0.2"), tun0: nic("10.9.0.2"), wlan0: [...nic("fe80::1", "IPv6"), ...nic("192.168.1.21")],
  });
  const byName = Object.fromEntries(found.map(f => [f.name, f.kind]));
  assert.deepEqual(byName, { eth0: "lan", tailscale0: "vpn", wg0: "vpn", tun0: "vpn", wlan0: "lan" });
});

test("links: LAN first, then VPN, then this computer; token and language ride in the query", () => {
  const links = buildLinks({
    scheme: "http", port: 8787, token: "abc", lang: "en", host: "0.0.0.0", publicUrl: "",
    addresses: [{ name: "tailscale0", address: "100.1.2.3", kind: "vpn" }, { name: "wlan0", address: "192.168.1.9", kind: "lan" }, { name: "x", address: "8.8.8.8", kind: "other" }],
  });
  assert.deepEqual(links.map(l => l.url), [
    "http://192.168.1.9:8787/?token=abc&lang=en", "http://100.1.2.3:8787/?token=abc&lang=en", "http://127.0.0.1:8787/?token=abc&lang=en",
  ]);
  assert.match(links[0].label, /Wi-Fi \/ LAN/);
  assert.match(links[1].label, /VPN/);
});

test("links: a fixed host, a public URL, no token and no language", () => {
  const base = { scheme: "https", port: 443, token: "", lang: "", addresses: [] };
  assert.equal(buildLinks({ ...base, host: "10.0.0.5", publicUrl: "" })[0].url, "https://10.0.0.5:443/");
  assert.equal(buildLinks({ ...base, host: "::1", publicUrl: "" })[0].url, "https://[::1]:443/");
  assert.equal(buildLinks({ ...base, token: "t", host: "0.0.0.0", publicUrl: "https://remote.example.net" })[0].url, "https://remote.example.net/?token=t");
});
