// v8 Part 1b: a small, zero-dependency QR Code encoder for the event's RSVP link (printed cards, a phone held up at the
// door). Byte mode, error correction level M, versions 1 to 10 (up to 213 bytes, plenty for a link), all eight masks
// scored with the standard penalty rules. Follows ISO/IEC 18004; checked against reference matrices in src/tests/qr.test.ts.
// Rendered as one SVG <path>, so it stays sharp at any print size.

/** The largest version this encoder makes (57 × 57 modules). */
export const QR_MAX_VERSION = 10;

// Level M per version: [error-correction codewords per block, blocks in group 1, data codewords per group-1 block,
// blocks in group 2, data codewords per group-2 block]. Index 0 is unused.
const M_BLOCKS: readonly (readonly [number, number, number, number, number])[] = [
  [0, 0, 0, 0, 0],
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
];
const ALIGN: readonly (readonly number[])[] = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];
/** Format bits for level M are 00. */
const ECC_M = 0;

const dataCodewords = (v: number) => { const b = M_BLOCKS[v]!; return b[1] * b[2] + b[3] * b[4]; };
/** Bytes that fit at version v in byte mode: 4 mode bits plus an 8-bit (v1–9) or 16-bit (v10+) length. */
export const byteCapacity = (v: number) => Math.floor((dataCodewords(v) * 8 - 4 - (v < 10 ? 8 : 16)) / 8);

// ---------- Reed–Solomon over GF(256), polynomial 0x11D ----------
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

/** The generator polynomial of the given degree (coefficients, highest first, leading 1 dropped). */
function rsGenerator(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] = next[j]! ^ g[j]!; next[j + 1] = next[j + 1]! ^ mul(g[j]!, EXP[i]!); }
    g = next;
  }
  return g.slice(1);
}
/** The error-correction codewords for one block. */
export function rsRemainder(data: readonly number[], degree: number): number[] {
  const gen = rsGenerator(degree);
  const rem = new Array<number>(degree).fill(0);
  for (const b of data) {
    const f = b ^ rem.shift()!;
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] = rem[i]! ^ mul(gen[i]!, f);
  }
  return rem;
}

// ---------- the bit stream ----------
function utf8(text: string): number[] { return Array.from(new TextEncoder().encode(text)); }

function encodeData(bytes: readonly number[], v: number): number[] {
  const bits: number[] = [];
  const put = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(v) * 8;
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < dataCodewords(v); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Split into blocks, add error correction, interleave. */
function withEcc(data: readonly number[], v: number): number[] {
  const [ec, n1, d1, n2, d2] = M_BLOCKS[v]!;
  const blocks: number[][] = [];
  let k = 0;
  for (let i = 0; i < n1 + n2; i++) { const len = i < n1 ? d1 : d2; blocks.push(data.slice(k, k + len)); k += len; }
  const eccs = blocks.map(b => rsRemainder(b, ec));
  const out: number[] = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < ec; i++) for (const e of eccs) out.push(e[i]!);
  return out;
}

// ---------- the matrix ----------
type Grid = { size: number; dark: boolean[][]; fn: boolean[][] };

function newGrid(v: number): Grid {
  const size = v * 4 + 17;
  return { size, dark: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)), fn: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)) };
}
const setFn = (g: Grid, x: number, y: number, on: boolean) => { g.dark[y]![x] = on; g.fn[y]![x] = true; };

function drawFunctionPatterns(g: Grid, v: number) {
  const n = g.size;
  for (let i = 0; i < n; i++) { setFn(g, 6, i, i % 2 === 0); setFn(g, i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      setFn(g, x, y, d !== 2 && d !== 4);
    }
  }
  const pos = ALIGN[v]!;
  for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(g, pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormatBits(g, 0); // reserves the format areas; redrawn with the chosen mask
  if (v >= 7) {
    let rem = v;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (v << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1, a = n - 11 + (i % 3), b = Math.floor(i / 3);
      setFn(g, a, b, on); setFn(g, b, a, on);
    }
  }
}

function drawFormatBits(g: Grid, mask: number) {
  const data = (ECC_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const n = g.size;
  for (let i = 0; i <= 5; i++) setFn(g, 8, i, bit(i));
  setFn(g, 8, 7, bit(6)); setFn(g, 8, 8, bit(7)); setFn(g, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFn(g, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) setFn(g, n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFn(g, 8, n - 15 + i, bit(i));
  setFn(g, 8, n - 8, true); // the dark module
}

function drawCodewords(g: Grid, codewords: readonly number[]) {
  const n = g.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? n - 1 - vert : vert;
      if (g.fn[y]![x] || i >= codewords.length * 8) continue;
      g.dark[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
      i++;
    }
  }
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
function applyMask(g: Grid, mask: number) {
  const f = MASKS[mask]!;
  for (let y = 0; y < g.size; y++) for (let x = 0; x < g.size; x++) if (!g.fn[y]![x] && f(x, y)) g.dark[y]![x] = !g.dark[y]![x];
}

/** The ISO/IEC 18004 penalty score (rules N1 to N4); the mask with the lowest score wins. */
export function penalty(m: readonly (readonly boolean[])[]): number {
  const n = m.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let s = 0, run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) { run++; continue; }
      if (run >= 5) s += 3 + (run - 5);
      run = 1;
    }
    // 1:1:3:1:1 finder-like patterns with 4 light modules on either side (light outside the symbol counts).
    const at = (i: number) => (i < 0 || i >= n ? false : get(i));
    for (let i = -4; i < n; i++) {
      const core = at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6);
      if (!core) continue;
      const before = !at(i - 1) && !at(i - 2) && !at(i - 3) && !at(i - 4);
      const after = !at(i + 7) && !at(i + 8) && !at(i + 9) && !at(i + 10);
      if (before || after) s += 40;
    }
    return s;
  };
  for (let y = 0; y < n; y++) score += line(x => m[y]![x]!);
  for (let x = 0; x < n; x++) score += line(y => m[y]![x]!);
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const c = m[y]![x];
    if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
  }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const total = n * n;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

export type QrMatrix = { version: number; mask: number; size: number; modules: boolean[][] };

/**
 * Encode text (UTF-8, byte mode, level M) at the smallest version that fits. `opts.mask` forces a mask (tests);
 * `opts.minVersion` forces a larger symbol. Throws when the text needs more than version 10.
 */
export function encodeQr(text: string, opts: { mask?: number; minVersion?: number } = {}): QrMatrix {
  const bytes = utf8(text);
  let v = Math.max(1, opts.minVersion ?? 1);
  while (v <= QR_MAX_VERSION && bytes.length > byteCapacity(v)) v++;
  if (v > QR_MAX_VERSION) throw new Error(`Text too long for a QR code (${bytes.length} bytes; at most ${byteCapacity(QR_MAX_VERSION)})`);
  const codewords = withEcc(encodeData(bytes, v), v);
  const g = newGrid(v);
  drawFunctionPatterns(g, v);
  drawCodewords(g, codewords);
  let best = opts.mask ?? -1;
  if (best < 0) {
    let low = Infinity;
    for (let k = 0; k < 8; k++) {
      applyMask(g, k); drawFormatBits(g, k);
      const p = penalty(g.dark);
      if (p < low) { low = p; best = k; }
      applyMask(g, k); // undo (XOR)
    }
  }
  applyMask(g, best); drawFormatBits(g, best);
  return { version: v, mask: best, size: g.size, modules: g.dark.map(r => [...r]) };
}

/** One SVG path for the dark modules, with a quiet zone of `border` modules (the standard asks for 4). */
export function qrSvgPath(m: QrMatrix, border = 4): string {
  const parts: string[] = [];
  for (let y = 0; y < m.size; y++) {
    let x = 0;
    while (x < m.size) {
      if (!m.modules[y]![x]) { x++; continue; }
      const start = x;
      while (x < m.size && m.modules[y]![x]) x++;
      parts.push(`M${start + border} ${y + border}h${x - start}v1h${start - x}z`);
    }
  }
  return parts.join("");
}

/**
 * A standalone SVG document (for the PNG/SVG download and printing): dark modules on white, whatever the app theme,
 * because scanners need the contrast. `title` becomes the SVG's accessible name.
 */
export function qrSvg(text: string, title: string, scale = 8, border = 4): string {
  const m = encodeQr(text);
  const dim = m.size + border * 2;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim * scale}" height="${dim * scale}" shape-rendering="crispEdges" role="img" aria-label="${esc(title)}">` +
    `<title>${esc(title)}</title><rect width="${dim}" height="${dim}" fill="#ffffff"/><path fill="#000000" d="${qrSvgPath(m, border)}"/></svg>`;
}
