// v8 Part 1b: the in-repo QR encoder (src/qr.ts). Byte mode, level M, versions 1 to 10, checked module for module against
// reference matrices from an independent encoder (src/tests/qr-vectors.ts), plus Reed–Solomon, capacity and SVG checks.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { byteCapacity, encodeQr, penalty, QR_MAX_VERSION, qrSvg, qrSvgPath, rsRemainder } from "../qr";
import { QR_VECTORS } from "./qr-vectors";

const toHexRows = (m: boolean[][]) => m.map(row => {
  const bits = row.map(b => (b ? "1" : "0")).join("").padEnd(Math.ceil(row.length / 4) * 4, "0");
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
});

describe("QR encoder", () => {
  test("Reed–Solomon: the ISO/IEC 18004 Annex I example (version 1-M, \"01234567\")", () => {
    // Data codewords for "01234567" in numeric mode at 1-M and their 10 error-correction codewords, from the standard.
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    assert.deepEqual(rsRemainder(data, 10), [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
  });

  test("byte capacity at level M, versions 1 to 10", () => {
    assert.deepEqual(Array.from({ length: QR_MAX_VERSION }, (_, i) => byteCapacity(i + 1)), [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]);
  });

  for (const v of QR_VECTORS) {
    test(`reference vector: version ${v.version}, mask ${v.mask}, ${JSON.stringify(v.text.length > 30 ? `${v.text.slice(0, 30)}…` : v.text)}`, () => {
      const m = encodeQr(v.text, { mask: v.mask });
      assert.equal(m.version, v.version);
      assert.equal(m.size, v.version * 4 + 17);
      assert.deepEqual(toHexRows(m.modules), v.rows);
    });
  }

  test("automatic mask: the lowest penalty of the eight wins", () => {
    for (const v of QR_VECTORS) {
      const auto = encodeQr(v.text);
      const scores = Array.from({ length: 8 }, (_, k) => penalty(encodeQr(v.text, { mask: k }).modules));
      assert.equal(penalty(auto.modules), Math.min(...scores), v.text.slice(0, 20));
      assert.equal(scores.indexOf(Math.min(...scores)), auto.mask);
    }
  });

  test("picks the smallest version that fits; a real RSVP link fits; longer than 213 bytes throws", () => {
    assert.equal(encodeQr("a".repeat(14)).version, 1);
    assert.equal(encodeQr("a".repeat(15)).version, 2);
    assert.equal(encodeQr("é".repeat(7)).version, 1, "UTF-8: 14 bytes");
    const link = `https://utsav-event-planner-rho.vercel.app/guest/${"A".repeat(22)}#k=${"b".repeat(43)}`;
    assert.ok(encodeQr(link).version <= 7);
    assert.equal(encodeQr("a".repeat(213)).version, 10);
    assert.throws(() => encodeQr("a".repeat(214)), /too long/);
  });

  test("structure: finder patterns, timing pattern and the dark module are where the standard puts them", () => {
    const m = encodeQr("https://example.com").modules, n = m.length;
    const finder = (x0: number, y0: number) => {
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        assert.equal(m[y0 + y]![x0 + x], d !== 2, `finder at ${x0},${y0}`);
      }
    };
    finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
    for (let i = 8; i < n - 8; i++) { assert.equal(m[6]![i], i % 2 === 0); assert.equal(m[i]![6], i % 2 === 0); }
    assert.equal(m[n - 8]![8], true);
  });

  test("SVG: one path with a 4-module quiet zone, an accessible name, escaped text", () => {
    const m = encodeQr("hi");
    const d = qrSvgPath(m);
    assert.match(d, /^M4 4h7v1h-7z/, "the top-left finder starts inside the quiet zone");
    const svg = qrSvg("https://u.example/guest/E#k=t", `QR for "A & B"`);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 37 37" /);
    assert.match(svg, /role="img" aria-label="QR for &quot;A &amp; B&quot;"/);
    assert.match(svg, /<title>QR for &quot;A &amp; B&quot;<\/title>/);
    assert.match(svg, /fill="#ffffff"/);
  });
});
