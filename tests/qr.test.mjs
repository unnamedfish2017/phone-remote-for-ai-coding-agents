import assert from "node:assert/strict";
import test from "node:test";

import { MAX_BYTES, chooseQrScale, encodeQr, qrSvg, renderQr } from "../src/qr.mjs";

// This exact symbol was rendered to an image and decoded back to the URL below with OpenCV's QR reader, so a change in
// the encoder's output is a change in something a phone camera would see: look at it before updating the fixture.
const URL_FOR_FIXTURE = "http://192.168.100.100:8787/?token=demo-token-0123456789abcdef&lang=zh-CN";
const FIXTURE = [
  "#######.#..####..##...#.#.#######",
  "#.....#..##..#..#..#.##...#.....#",
  "#.###.#...#.##..#....#.#..#.###.#",
  "#.###.#.....##..##.####...#.###.#",
  "#.###.#..#.#..#.#.##..#.#.#.###.#",
  "#.....#...#.#.#.#...##.##.#.....#",
  "#######.#.#.#.#.#.#.#.#.#.#######",
  "........#.##.#.#..#...#.#........",
  "##.##.#..####.#####....#..#.....#",
  "..###..#.#..#.##.###...###..#..#.",
  "#..######.####.###..####..####..#",
  ".#####..###.....##..#.#..#.#.##..",
  "...#..#.##..#.###.##...#.###.#.##",
  "#...##.#.#...####....#.##....#...",
  "..#.####.##...##..###...##.###...",
  "###.##.#.####.#.#.#.....#.#...#.#",
  "#.#.###..#####..#.###.#...#.##.##",
  "###..#.#...#.#.###.#.##.###.#..##",
  "#..#..#....#.#.#####..######....#",
  "#...##.#..#..##.......######..###",
  "#.######.####.#..##....#.#...#...",
  "##...#..#..##.###..#..###...#.##.",
  "#.##..###.###.###.#..#####....###",
  "#..###.#.####.##.##.#..##.#.###..",
  "###...##.##.#..#..#.#..######..#.",
  "........#..#..##.....#.##...#..#.",
  "#######..#..#.#######..##.#.###..",
  "#.....#....##.##......#.#...#.###",
  "#.###.#.#.#..#.##.#.#..######....",
  "#.###.#.#.#....###.###.##..#.##..",
  "#.###.#...##...#.#.###.##..###..#",
  "#.....#.##...#..#.##..##.##.#.###",
  "#######.#.##...#.###....#........",
];

const art = matrix => matrix.map(row => row.map(c => (c ? "#" : ".")).join(""));

test("the encoder reproduces the fixture that a real QR reader decoded", () => {
  assert.deepEqual(art(encodeQr(URL_FOR_FIXTURE)), FIXTURE);
});

test("the version (symbol size) grows with the payload and refuses what does not fit", () => {
  const size = n => encodeQr("a".repeat(n)).length;
  assert.equal(size(1), 21);
  assert.equal(size(17), 21);     // version 1 holds 17 bytes at level L
  assert.equal(size(18), 25);
  assert.equal(size(32), 25);
  assert.equal(size(33), 29);
  assert.equal(size(140), 45);    // version 7: the first one that carries version information
  assert.equal(size(MAX_BYTES), 57);
  assert.throws(() => encodeQr("a".repeat(MAX_BYTES + 1)), /too long/);
});

test("finder patterns sit in three corners and the timing pattern alternates", () => {
  const m = encodeQr("phone-remote");
  const n = m.length;
  const finder = (x0, y0) => {
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        assert.equal(m[y0 + y][x0 + x], ring !== 2, `finder at ${x0},${y0} cell ${x},${y}`);
      }
    }
  };
  finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
  for (let i = 8; i < n - 8; i += 1) { assert.equal(m[6][i], i % 2 === 0); assert.equal(m[i][6], i % 2 === 0); }
});

test("the format information is a valid BCH codeword for error-correction level L and the mask in use", () => {
  const m = encodeQr("phone-remote");
  let bits = 0;
  for (let i = 0; i <= 5; i += 1) bits |= (m[i][8] ? 1 : 0) << i;
  bits |= (m[7][8] ? 1 : 0) << 6; bits |= (m[8][8] ? 1 : 0) << 7; bits |= (m[8][7] ? 1 : 0) << 8;
  for (let i = 9; i < 15; i += 1) bits |= (m[8][14 - i] ? 1 : 0) << i;
  const raw = bits ^ 0x5412;
  let rem = raw;
  for (let i = 14; i >= 10; i -= 1) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  assert.equal(rem, 0, "BCH remainder must be zero");
  assert.equal(raw >>> 13, 1, "error-correction level L is encoded as 01");
  for (let mask = 0; mask < 8; mask += 1) assert.equal(encodeQr("phone-remote", { mask }).length, 21);
});

test("every one of the eight masks yields a different symbol of the same size", () => {
  const seen = new Set();
  for (let mask = 0; mask < 8; mask += 1) seen.add(art(encodeQr("phone-remote", { mask })).join("|"));
  assert.equal(seen.size, 8);
});

test("the terminal rendering is the matrix plus a quiet zone, black on white, two rows per line", () => {
  const url = "http://10.0.0.5:8787/";
  const m = encodeQr(url);
  const lines = renderQr(url, { quiet: 2 }).split("\n").map(l => l.replace(/\x1b\[[0-9;]*m/g, ""));
  const n = m.length;
  assert.equal(lines.length, Math.ceil((n + 4) / 2));
  const dark = (x, y) => x >= 0 && y >= 0 && x < n && y < n && m[y][x];
  lines.forEach((line, row) => {
    const y = -2 + row * 2;
    [...line].forEach((ch, col) => {
      const x = -2 + col;
      const want = dark(x, y) && dark(x, y + 1) ? "█" : dark(x, y) ? "▀" : dark(x, y + 1) ? "▄" : " ";
      assert.equal(ch, want, `row ${row} col ${col}`);
    });
  });
  assert.ok(renderQr(url).startsWith("\x1b[30;47m"), "forced black-on-white colours");
});

test("same text, same symbol", () => {
  assert.deepEqual(encodeQr("deterministic"), encodeQr("deterministic"));
});

test("the big terminal rendering is the matrix doubled: every module two background-coloured spaces, quiet zone included", () => {
  const url = "http://10.0.0.5:8787/";
  const m = encodeQr(url);
  const n = m.length;
  const lines = renderQr(url, { quiet: 2, scale: 2 }).split("\n");
  assert.equal(lines.length, n + 4, "one text line per module row");
  const dark = (x, y) => x >= 0 && y >= 0 && x < n && y < n && m[y][x];
  lines.forEach((line, row) => {
    // cells = the characters after each colour switch; every module is exactly two columns wide
    let color = "", cells = [];
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      if (part.startsWith("\x1b[")) { color = part; continue; }
      for (let i = 0; i < part.length; i += 1) { assert.equal(part[i], " ", "only spaces are drawn; the colour does the work"); cells.push(color); }
    }
    assert.equal(cells.length, 2 * (n + 4), `row ${row} width`);
    cells.forEach((c, col) => {
      const x = Math.floor(col / 2) - 2, y = row - 2;
      assert.equal(c, dark(x, y) ? "\x1b[48;5;16m" : "\x1b[48;5;231m", `row ${row} col ${col}`);
    });
  });
});

test("chooseQrScale takes the big rendering only when the terminal is wide and tall enough for it", () => {
  const modules = 33;                                      // quiet zone 2 → 37 modules → 74 columns + 4 margin, 37 lines + 6 around it
  assert.equal(chooseQrScale(modules, { columns: 78, rows: 43 }), 2);
  assert.equal(chooseQrScale(modules, { columns: 77, rows: 43 }), 1);
  assert.equal(chooseQrScale(modules, { columns: 78, rows: 42 }), 1);
  assert.equal(chooseQrScale(modules, { columns: 80, rows: 24 }), 1, "a classic 80x24 terminal gets the compact one");
  assert.equal(chooseQrScale(modules, {}), 1, "unknown size (not a terminal) stays compact");
  assert.equal(chooseQrScale(21, { columns: 60, rows: 40 }), 2, "a short link makes a smaller symbol that fits sooner");
});

test("the SVG is the same matrix: runs of dark modules, quiet zone of four, crisp edges", () => {
  const url = "http://192.168.1.23:8787/?token=abc";
  const m = encodeQr(url);
  const n = m.length;
  const svg = qrSvg(url);
  assert.match(svg, new RegExp(`viewBox="0 0 ${n + 8} ${n + 8}"`));
  assert.match(svg, /shape-rendering="crispEdges"/);
  const got = Array.from({ length: n }, () => Array(n).fill(false));
  const path = /<path d="([^"]*)"/.exec(svg)[1];
  for (const [, x, y, w] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    for (let i = 0; i < Number(w); i += 1) got[Number(y) - 4][Number(x) - 4 + i] = true;
  }
  assert.deepEqual(art(got), art(m));
  assert.ok(!/<script|href=|src=/i.test(svg), "nothing to fetch, nothing to run");
});
