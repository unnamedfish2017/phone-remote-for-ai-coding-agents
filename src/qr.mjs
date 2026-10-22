// A small QR Code encoder, so the startup banner can show a code your phone's camera opens directly.
//
// Scope on purpose: byte mode, error-correction level L, versions 1–10 (up to 271 bytes) — plenty for a link.
// The algorithm follows ISO/IEC 18004; the structure mirrors the well-known public-domain/MIT reference
// implementations (e.g. Project Nayuki's). tests/qr.test.mjs pins a fixture that was decoded with a real QR reader.

// [error-correction codewords per block, [[block count, data codewords per block], …]] for level L, indexed by version
const EC_L = [
  null,
  [7, [[1, 19]]], [10, [[1, 34]]], [15, [[1, 55]]], [20, [[1, 80]]], [26, [[1, 108]]],
  [18, [[2, 68]]], [20, [[2, 78]]], [24, [[2, 97]]], [30, [[2, 116]]], [18, [[2, 68], [2, 69]]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
export const MAX_BYTES = 271;

const dataCapacity = version => EC_L[version][1].reduce((sum, [blocks, per]) => sum + blocks * per, 0);

// ---- Reed–Solomon over GF(256), polynomial 0x11D ----
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsGenerator(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}
export function rsRemainder(data, generator) {
  const result = new Array(generator.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    generator.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

// ---- codewords ----
function dataCodewords(bytes, version) {
  const bits = [];
  const push = (value, count) => { for (let i = count - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1); };
  push(0b0100, 4);                                   // byte mode
  push(bytes.length, version < 10 ? 8 : 16);         // character count
  bytes.forEach(b => push(b, 8));
  const capacityBits = dataCapacity(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length));  // terminator
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; out.length < dataCapacity(version); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

export function interleave(data, version) {
  const [ecLen, groups] = EC_L[version];
  const generator = rsGenerator(ecLen);
  const blocks = [];
  let at = 0;
  for (const [count, per] of groups) {
    for (let i = 0; i < count; i += 1) {
      const chunk = data.slice(at, at + per);
      at += per;
      blocks.push({ data: chunk, ec: rsRemainder(chunk, generator) });
    }
  }
  const out = [];
  const longest = Math.max(...blocks.map(b => b.data.length));
  for (let i = 0; i < longest; i += 1) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecLen; i += 1) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// ---- the matrix ----
function buildMatrix(version, codewords, mask) {
  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };
  const bit = (value, i) => ((value >>> i) & 1) !== 0;

  for (let i = 0; i < size; i += 1) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }       // timing
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const positions = ALIGN[version];
  positions.forEach((cy, i) => positions.forEach((cx, j) => {
    const onFinder = (i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0);
    if (onFinder) return;
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));

  // format information (level L = 01) — drawn now to reserve the cells, redrawn for each candidate mask below
  const drawFormat = m => {
    const data = (1 << 3) | m;
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i += 1) setFn(8, i, bit(bits, i));
    setFn(8, 7, bit(bits, 6)); setFn(8, 8, bit(bits, 7)); setFn(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i += 1) setFn(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i += 1) setFn(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i += 1) setFn(8, size - 15 + i, bit(bits, i));
    setFn(8, size - 8, true);                                                                       // the always-dark module
  };
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      setFn(a, b, bit(bits, i)); setFn(b, a, bit(bits, i));
    }
  }

  // data, in the zig-zag order of the spec
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!isFn[y][x] && k < codewords.length * 8) {
          modules[y][x] = bit(codewords[k >>> 3], 7 - (k & 7));
          k += 1;
        }
      }
    }
  }

  const maskFn = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = m => {
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (!isFn[y][x] && maskFn[m](x, y)) modules[y][x] = !modules[y][x];
  };

  const penalty = () => {
    let score = 0;
    const runs = line => {                                   // rule 1: five or more in a row
      let run = 1, s = 0;
      for (let i = 1; i <= line.length; i += 1) {
        if (i < line.length && line[i] === line[i - 1]) run += 1;
        else { if (run >= 5) s += 3 + (run - 5); run = 1; }
      }
      return s;
    };
    const finderLike = line => {                             // rule 3: 1:1:3:1:1 finder look-alikes with a light margin
      let s = 0;
      const str = line.map(v => (v ? "1" : "0")).join("");
      for (const pattern of ["10111010000", "00001011101"]) for (let i = str.indexOf(pattern); i >= 0; i = str.indexOf(pattern, i + 1)) s += 40;
      return s;
    };
    for (let i = 0; i < size; i += 1) {
      const row = modules[i], col = modules.map(r => r[i]);
      score += runs(row) + runs(col) + finderLike(row) + finderLike(col);
    }
    for (let y = 0; y < size - 1; y += 1) {                  // rule 2: 2×2 blocks
      for (let x = 0; x < size - 1; x += 1) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
      }
    }
    const dark = modules.reduce((sum, r) => sum + r.filter(Boolean).length, 0);
    score += (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) * 10;   // rule 4: dark/light balance
    return score;
  };

  let best = 0, bestScore = Infinity;
  const chosen = mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask];
  for (const m of chosen) {
    applyMask(m); drawFormat(m);
    const score = penalty();
    if (score < bestScore) { best = m; bestScore = score; }
    applyMask(m);                                            // XOR again = undo
  }
  applyMask(best); drawFormat(best);
  return { modules, mask: best };
}

// text → boolean[][] (true = dark module). Throws when the text does not fit.
export function encodeQr(text, { mask } = {}) {
  const bytes = [...Buffer.from(String(text), "utf8")];
  let version = 1;
  while (version <= 10 && bytes.length > dataCapacity(version) - (version < 10 ? 2 : 3)) version += 1;
  if (version > 10) throw new Error(`QR payload too long (${bytes.length} bytes, max ${MAX_BYTES})`);
  const codewords = interleave(dataCodewords(bytes, version), version);
  return buildMatrix(version, codewords, mask).modules;
}

// The matrix as text for a terminal: black modules on a white block whatever the terminal theme is
// (inverted codes are not read by every camera app).
//   scale 1: two module rows per text line, drawn with half blocks — the smallest.
//   scale 2: every module is two spaces wide and one line tall, painted with background colours (block glyphs can leave
//            hairline gaps between lines in terminals that add line spacing) — exactly twice as big in both directions.
export function renderQr(text, { quiet = 2, mask, scale = 1 } = {}) {
  const m = encodeQr(text, { mask });
  const n = m.length;
  const dark = (x, y) => x >= 0 && y >= 0 && x < n && y < n && m[y][x];
  const lines = [];
  if (scale >= 2) {
    const BLACK = "\x1b[48;5;16m", WHITE = "\x1b[48;5;231m";   // pure black / white of the 256-colour cube
    for (let y = -quiet; y < n + quiet; y += 1) {
      let line = "", current = "";
      for (let x = -quiet; x < n + quiet; x += 1) {
        const color = dark(x, y) ? BLACK : WHITE;
        if (color !== current) { line += color; current = color; }
        line += "  ";
      }
      lines.push(`${line}\x1b[0m`);
    }
    return lines.join("\n");
  }
  for (let y = -quiet; y < n + quiet; y += 2) {
    let line = "";
    for (let x = -quiet; x < n + quiet; x += 1) {
      const top = dark(x, y), bottom = dark(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(`\x1b[30;47m${line}\x1b[0m`);
  }
  return lines.join("\n");
}

// The biggest rendering that still fits the terminal. `modules` is the symbol size (encodeQr(...).length); the code is the
// last thing the banner prints, so only the lines around it are reserved (`reserve`: its heading, the blank lines, the
// "Press Ctrl-C" line and the prompt) — whatever the banner printed before may scroll up out of sight. `indent` is the margin.
export function chooseQrScale(modules, { columns, rows, quiet = 2, indent = 4, reserve = 6 } = {}) {
  const side = modules + 2 * quiet;
  return columns >= indent + 2 * side && rows >= reserve + side ? 2 : 1;
}

// The matrix as an SVG for a web page: one path made of horizontal runs, quiet zone included, crisp at any size.
export function qrSvg(text, { quiet = 4, mask } = {}) {
  const m = encodeQr(text, { mask });
  const n = m.length, side = n + 2 * quiet;
  let d = "";
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (!m[y][x]) continue;
      let end = x;
      while (end + 1 < n && m[y][end + 1]) end += 1;
      d += `M${x + quiet} ${y + quiet}h${end - x + 1}v1h-${end - x + 1}z`;
      x = end;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${side}" height="${side}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
