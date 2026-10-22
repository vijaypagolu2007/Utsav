// Run: npm test. Accessibility helpers (no browser needed): budget meter text and palette contrast.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { envelopeA11y, inr, sponsorProgress, stripFlagGlyph } from "../budget-a11y";

const item = (planned: number, committed: number, extra: Partial<{ quotedPaise: number | null; locked: boolean }> = {}) =>
  ({ label: "Haldi marigold decor", plannedPaise: planned * 100, committedPaise: committed * 100, quotedPaise: null, locked: false, ...extra });

describe("budget envelope semantics", () => {
  test("partially committed: meter in whole rupees with the full sentence", () => {
    const a = envelopeA11y(item(80_000, 30_000));
    assert.equal(a.role, "meter");
    if (a.role !== "meter") return;
    assert.deepEqual([a.valueMin, a.valueNow, a.valueMax], [0, 30_000, 80_000]);
    assert.equal(a.label, "Haldi marigold decor budget");
    assert.equal(a.valueText, "Haldi marigold decor: ₹30,000 committed of ₹80,000 planned, ₹50,000 not yet committed.");
  });
  test("nothing committed and fully committed", () => {
    const z = envelopeA11y(item(80_000, 0));
    assert.ok(z.role === "meter" && z.valueNow === 0 && /₹0 committed of ₹80,000 planned, ₹80,000 not yet committed/.test(z.valueText));
    const f = envelopeA11y(item(2_00_000, 2_00_000, { locked: true }));
    assert.ok(f.role === "meter" && f.valueNow === f.valueMax && /₹0 not yet committed, locked, so AI cuts skip it/.test(f.valueText));
  });
  test("over the plan: value is clamped to the max and the overage is spelled out", () => {
    const a = envelopeA11y(item(80_000, 1_20_000));
    assert.ok(a.role === "meter");
    if (a.role !== "meter") return;
    assert.equal(a.valueNow, 80_000);
    assert.match(a.valueText, /₹1,20,000 committed of ₹80,000 planned, ₹40,000 over the plan/);
  });
  test("zero planned budget is a labelled image, never a meter with a fake range", () => {
    assert.deepEqual(envelopeA11y(item(0, 0)), { role: "img", label: "Haldi marigold decor: no budget planned and nothing committed." });
    const b = envelopeA11y(item(0, 5_000));
    assert.equal(b.role, "img");
    assert.match(b.role === "img" ? b.label : "", /₹5,000 committed with no budget planned/);
  });
  test("quote marker and large values keep Indian grouping", () => {
    const a = envelopeA11y(item(1_50_00_000, 75_00_000, { quotedPaise: 1_85_00_000 * 100 }));
    assert.ok(a.role === "meter");
    if (a.role !== "meter") return;
    assert.equal(a.valueMax, 1_50_00_000);
    assert.match(a.valueText, /₹75,00,000 committed of ₹1,50,00,000 planned, ₹75,00,000 not yet committed, vendor quote ₹1,85,00,000, above the plan/);
    assert.equal(inr(-250_000), "−₹2,500");
  });
  test("sponsor progress: genuine progress, none for in-kind, overage noted", () => {
    assert.equal(sponsorProgress({ name: "SpiceRoute", pledgedPaise: 0, receivedPaise: 0 }), null);
    assert.deepEqual(sponsorProgress({ name: "SpiceRoute", pledgedPaise: 1_00_000_00, receivedPaise: 40_000_00 }),
      { label: "SpiceRoute sponsorship received", valueNow: 40_000, valueMax: 1_00_000, valueText: "₹40,000 received of ₹1,00,000 pledged" });
    assert.match(sponsorProgress({ name: "X", pledgedPaise: 100_00, receivedPaise: 150_00 })!.valueText, /₹50 above the pledge/);
  });
  test("red-flag glyphs are stripped for display (the card shows its own icon)", () => {
    assert.equal(stripFlagGlyph("⚠️ 25% non-refundable deposit"), "25% non-refundable deposit");
    assert.equal(stripFlagGlyph("plain"), "plain");
  });
});

// ---------- colour contrast of the text/background pairs the UI now uses (Tailwind v4 oklch palette) ----------
const css = readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8");
const palette = new Map<string, [number, number, number]>([["white", [1, 0, 0]]]);
for (const m of css.matchAll(/--color-([a-z]+-\d+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/g)) palette.set(m[1]!, [Number(m[2]) / 100, Number(m[3]), Number(m[4])]);
function luminance(name: string): number {
  const c = palette.get(name);
  assert.ok(c, `unknown colour ${name}`);
  const [L, C, h] = c;
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
    .map(x => Math.min(1, Math.max(0, x)));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}
const ratio = (fg: string, bg: string) => { const a = luminance(fg), b = luminance(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };

describe("palette contrast (WCAG 1.4.3 / 1.4.11)", () => {
  // Normal-size text pairs in use after the fix (fg on bg). Every one must reach 4.5:1.
  const text: [string, string][] = [
    ["slate-500", "white"], ["slate-600", "white"], ["slate-600", "slate-50"], ["slate-600", "slate-100"], ["slate-700", "slate-100"],
    ["white", "emerald-700"], ["white", "rose-700"], ["white", "amber-700"], ["white", "sky-700"], ["white", "violet-700"], ["white", "violet-600"],
    ["white", "slate-800"], ["white", "slate-900"], ["white", "indigo-600"], ["white", "violet-800"], ["white", "fuchsia-800"],
    ["emerald-700", "emerald-50"], ["emerald-800", "emerald-50"], ["rose-700", "rose-50"], ["rose-800", "rose-100"], ["amber-800", "amber-50"],
    ["amber-900", "amber-100"], ["sky-700", "sky-50"], ["violet-700", "violet-50"], ["indigo-700", "indigo-50"], ["violet-800", "white"],
    ["emerald-700", "white"], ["emerald-800", "white"], ["rose-700", "white"], ["amber-800", "white"], ["sky-700", "white"], ["slate-700", "white"],
  ];
  for (const [fg, bg] of text) test(`${fg} on ${bg} ≥ 4.5:1`, () => assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg} = ${ratio(fg, bg).toFixed(2)}`));
  test("focus outline (violet-700) ≥ 3:1 against white and slate-50", () => {
    assert.ok(ratio("violet-700", "white") >= 3 && ratio("violet-700", "slate-50") >= 3);
  });
  test("the shades that were replaced really failed (guards against regressions back to them)", () => {
    for (const [fg, bg] of [["slate-400", "white"], ["white", "emerald-600"], ["white", "amber-500"], ["white", "sky-600"], ["slate-500", "slate-100"], ["violet-400", "white"]] as const)
      assert.ok(ratio(fg, bg) < 4.5, `${fg} on ${bg} unexpectedly passes`);
  });
});

describe("one visual per action", () => {
  test("UI components carry no pictographic emoji next to their lucide icons", () => {
    const dir = new URL("../components/", import.meta.url);
    for (const f of readdirSync(dir).filter(n => n.endsWith(".tsx"))) {
      const src = readFileSync(new URL(f, dir), "utf8");
      const hit = src.match(/\p{Extended_Pictographic}/u);
      assert.equal(hit, null, `${f} contains ${hit?.[0]}`);
    }
  });
});
