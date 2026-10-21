import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCALE_DIR = path.join(ROOT, "src", "web", "locales");
const HTML = path.join(ROOT, "src", "web", "index.html");
const DEFAULT_LANG = "zh-CN";   // its dictionary is embedded in the page; the others are measured against it

async function loadLocales() {
  const files = (await readdir(LOCALE_DIR)).filter(f => f.endsWith(".json")).sort();
  const out = {};
  for (const f of files) out[f.slice(0, -5)] = JSON.parse(await readFile(path.join(LOCALE_DIR, f), "utf8"));
  return out;
}
const placeholders = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test("every language file has exactly the keys of the default language, with the same placeholders", async () => {
  const locales = await loadLocales();
  const base = locales[DEFAULT_LANG];
  assert.ok(base, `${DEFAULT_LANG}.json must exist`);
  const keys = Object.keys(base).filter(k => k !== "_name").sort();
  assert.ok(Object.keys(locales).length >= 10, "expected the shipped languages");
  for (const [code, dict] of Object.entries(locales)) {
    assert.ok(typeof dict._name === "string" && dict._name.trim(), `${code}: _name (the language's own name) is missing`);
    assert.deepEqual(Object.keys(dict).filter(k => k !== "_name").sort(), keys, `${code}: key set differs from ${DEFAULT_LANG}`);
    for (const k of keys) {
      assert.ok(typeof dict[k] === "string" && dict[k].trim(), `${code}/${k}: empty`);
      assert.deepEqual(placeholders(dict[k]), placeholders(base[k]), `${code}/${k}: placeholders differ from ${DEFAULT_LANG}`);
    }
  }
});

test("language codes in file names are well-formed", async () => {
  for (const code of Object.keys(await loadLocales())) {
    assert.match(code, /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/, `bad locale file name: ${code}.json`);
  }
});

test("every key the page asks for exists, and no key is dead", async () => {
  const { [DEFAULT_LANG]: base } = await loadLocales();
  // comments mention T("key", …) as an example; only real code should count
  const html = (await readFile(HTML, "utf8")).replace(/(^|\s)\/\/.*$/gm, "$1");
  const asked = new Set();
  for (const m of html.matchAll(/data-i18n(?:-title|-placeholder)?="([\w.]+)"/g)) asked.add(m[1]);
  for (const m of html.matchAll(/\bT\("([\w.]+)"/g)) asked.add(m[1]);
  for (const key of asked) assert.ok(key in base, `the page uses "${key}" but ${DEFAULT_LANG}.json has no such key`);

  // keys built at run time, plus keys named in tables (statusKey: "menu.status")
  const dynamicFamilies = ["state.", "err."];
  const stringsInHtml = new Set([...html.matchAll(/"([\w]+\.[\w]+)"/g)].map(m => m[1]));
  for (const key of Object.keys(base)) {
    if (key === "_name" || dynamicFamilies.some(p => key.startsWith(p))) continue;
    assert.ok(asked.has(key) || stringsInHtml.has(key), `"${key}" is in ${DEFAULT_LANG}.json but nothing in the page uses it`);
  }
});

test("every error code the server can send has a translation, and every err.* entry belongs to a real code", async () => {
  const { [DEFAULT_LANG]: base } = await loadLocales();
  const codes = new Set();
  for (const f of (await readdir(path.join(ROOT, "src"))).filter(f => f.endsWith(".mjs"))) {
    for (const m of (await readFile(path.join(ROOT, "src", f), "utf8")).matchAll(/\bfail\("(\w+)"/g)) codes.add(m[1]);
  }
  assert.ok(codes.size >= 10, "expected the server to define several error codes");
  for (const code of codes) assert.ok(`err.${code}` in base, `server error code "${code}" has no err.${code} entry`);
  const translated = Object.keys(base).filter(k => k.startsWith("err.")).map(k => k.slice(4));
  for (const code of translated) {
    assert.ok(codes.has(code) || code === "timeout", `err.${code} matches no error the server sends (err.timeout is raised by the page itself)`);
  }
});

test("the state.* words cover every status Claude Code reports", async () => {
  const { [DEFAULT_LANG]: base } = await loadLocales();
  for (const s of ["busy", "idle", "waiting", "shell"]) assert.ok(`state.${s}` in base, `state.${s}`);
});

test("the concise sentence never spells out a count (it made models answer with exactly four points)", async () => {
  for (const [code, dict] of Object.entries(await loadLocales())) {
    assert.ok(!/\b1\s*[.、,)]\s*2\s*[.、,)]\s*3\s*[.、,)]\s*4\b/.test(dict["concise.default"]), `${code}: concise.default lists "1, 2, 3, 4" — see locales/README.md`);
    assert.ok(/1\.\s*2\.\s*3\./.test(dict["concise.default"]) || /1\./.test(dict["concise.default"]), `${code}: concise.default should show the numbered style`);
  }
});

test("every language has a descriptive page title, not a bare brand", async () => {
  for (const [code, dict] of Object.entries(await loadLocales())) assert.ok([...dict["app.title"]].length >= 8, `${code}: app.title is too short to say what this is`);
});
