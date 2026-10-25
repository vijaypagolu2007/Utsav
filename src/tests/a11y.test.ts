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

// ---------- colour contrast of the text/background pairs the UI now uses (Tailwind v4 oklch palette + the Utsav brand scales) ----------
const css = readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8");
const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const palette = new Map<string, [number, number, number]>([["white", [1, 0, 0]]]);
const shadeRe = /--color-([a-z]+-\d+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/g;
for (const m of css.matchAll(shadeRe)) palette.set(m[1]!, [Number(m[2]) / 100, Number(m[3]), Number(m[4])]);
// The brand scales (sand, brand, maroon, peacock, marigold) are defined in globals.css @theme blocks (never in the dark block).
const brandScales = [...globals.matchAll(/@theme\s*\{([^}]*)\}/g)].map(m => m[1]!).join("\n");
for (const m of brandScales.matchAll(shadeRe)) palette.set(m[1]!, [Number(m[2]) / 100, Number(m[3]), Number(m[4])]);
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
    ["sand-600", "white"], ["sand-700", "white"], ["sand-600", "sand-50"], ["sand-600", "sand-100"], ["sand-700", "sand-100"],
    ["white", "emerald-700"], ["white", "red-700"], ["white", "amber-700"], ["white", "peacock-700"], ["white", "brand-700"], ["white", "brand-800"],
    ["white", "sand-800"], ["white", "sand-900"], ["white", "maroon-700"], ["white", "maroon-800"], ["white", "maroon-900"],
    ["emerald-700", "emerald-50"], ["emerald-800", "emerald-50"], ["red-700", "red-50"], ["red-800", "red-100"], ["amber-800", "amber-50"],
    ["amber-900", "amber-100"], ["peacock-700", "peacock-50"], ["brand-700", "brand-50"], ["maroon-700", "maroon-50"], ["brand-800", "white"],
    ["emerald-700", "white"], ["emerald-800", "white"], ["red-700", "white"], ["amber-800", "white"], ["peacock-700", "white"], ["sand-700", "white"],
  ];
  for (const [fg, bg] of text) test(`${fg} on ${bg} ≥ 4.5:1`, () => assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg} = ${ratio(fg, bg).toFixed(2)}`));
  test("focus outline (brand-700) ≥ 3:1 against white, sand-50 and sand-100", () => {
    assert.ok(ratio("brand-700", "white") >= 3 && ratio("brand-700", "sand-50") >= 3 && ratio("brand-700", "sand-100") >= 3);
  });
  test("the shades that were replaced really failed (guards against regressions back to them)", () => {
    for (const [fg, bg] of [["slate-400", "white"], ["white", "emerald-600"], ["white", "amber-500"], ["white", "sky-600"], ["slate-500", "slate-100"], ["violet-400", "white"],
      // Gold and the light sand shades are decoration only: they must never be used for text.
      ["marigold-400", "white"], ["marigold-500", "sand-50"], ["sand-500", "sand-50"], ["brand-500", "white"]] as const)
      assert.ok(ratio(fg, bg) < 4.5, `${fg} on ${bg} unexpectedly passes`);
  });
});

// ---------- redesign tokens (src/app/globals.css @theme): each names a palette shade, resolved here and checked in pairs ----------
const themeBlock = globals.match(/@theme\s*\{([^}]*--color-canvas[^}]*)\}/)?.[1] ?? "";
const tokens = new Map<string, string>();
for (const m of themeBlock.matchAll(/--color-([a-z-]+):\s*var\(--color-([a-z]+-\d+|white)\)/g)) tokens.set(m[1]!, m[2]!);
const shade = (name: string) => tokens.get(name) ?? name;

describe("Utsav palette (ivory sand surfaces, kumkum primary, maroon / peacock / marigold accents, emerald / amber / red status)", () => {
  test("every design token resolves to a known palette shade", () => {
    for (const t of ["canvas", "surface", "surface-muted", "ink", "ink-muted", "line", "line-soft", "line-strong", "primary", "primary-hover", "primary-soft",
      "secondary", "secondary-soft", "info", "info-soft", "gold", "success", "success-soft", "warning", "warning-soft", "danger", "danger-soft"]) {
      assert.ok(tokens.has(t), `token ${t} missing from globals.css`);
      assert.ok(palette.has(shade(t)), `token ${t} → unknown shade ${shade(t)}`);
    }
  });
  // Text pairs the redesign introduces (tokens or palette names). Every one must reach 4.5:1.
  const text: [string, string][] = [
    ["ink", "canvas"], ["ink", "surface"], ["ink", "surface-muted"], ["ink-muted", "canvas"], ["ink-muted", "surface"], ["ink-muted", "surface-muted"],
    ["white", "primary"], ["white", "primary-hover"], ["primary", "surface"], ["primary", "canvas"], ["primary", "primary-soft"], ["brand-800", "brand-50"], ["brand-800", "brand-100"],
    ["white", "secondary"], ["secondary", "surface"], ["secondary", "secondary-soft"], ["info", "surface"], ["info", "info-soft"], ["info", "canvas"],
    ["success", "surface"], ["success", "success-soft"], ["warning", "surface"], ["warning", "warning-soft"], ["danger", "surface"], ["danger", "danger-soft"],
    ["sand-600", "white"], ["sand-700", "white"], ["sand-800", "white"], ["sand-700", "sand-100"], ["sand-800", "sand-100"], ["sand-600", "sand-100"], ["sand-600", "sand-50"],
    ["sand-900", "sand-100"], ["sand-200", "sand-900"], ["white", "sand-800"], ["white", "sand-900"], ["white", "sand-700"], ["white", "sand-600"],
    ["emerald-800", "emerald-50"], ["emerald-900", "emerald-50"], ["emerald-900", "emerald-100"], ["red-800", "red-50"], ["red-800", "red-100"], ["red-900", "red-50"],
    ["amber-900", "amber-100"], ["amber-800", "amber-50"], ["amber-900", "amber-50"],
    ["peacock-700", "peacock-50"], ["brand-700", "brand-50"], ["maroon-700", "maroon-50"], ["maroon-800", "maroon-50"], ["marigold-800", "marigold-50"],
    ["maroon-800", "marigold-50"], ["sand-700", "marigold-50"], ["sand-700", "maroon-50"],
    ["white", "amber-700"], ["white", "red-700"], ["white", "emerald-700"], ["white", "emerald-800"], ["white", "brand-700"], ["white", "brand-800"],
    ["white", "peacock-700"], ["white", "maroon-700"], ["white", "maroon-800"], ["white", "maroon-900"], ["white", "marigold-700"], ["red-800", "white"], ["emerald-800", "white"],
    ["red-600", "white"], ["brand-800", "white"], ["peacock-700", "white"],
    // v5: setup rows left out (sand-50), ideas chips and warnings, the remove confirm, the chat ideas card.
    ["ink", "sand-50"], ["ink-muted", "sand-50"], ["marigold-800", "marigold-50"], ["amber-800", "surface"], ["red-800", "red-50"], ["sand-800", "white"],
    ["emerald-800", "emerald-50"], ["brand-800", "brand-50"], ["sand-700", "sand-100"],
    // v6: trade-off box and vendor questions card (sand-800 on peacock-50), adopt over-budget warning, figure tags, slot steps.
    ["sand-800", "peacock-50"], ["peacock-700", "peacock-50"], ["amber-900", "amber-50"], ["sand-700", "sand-100"], ["emerald-800", "emerald-50"],
    ["brand-800", "brand-50"], ["red-700", "surface-muted"], ["emerald-800", "surface"], ["ink", "peacock-50"],
    // Overview hero: heading text on the glow tints themselves (the worst point of each radial gradient).
    ["ink", "marigold-100"], ["ink-muted", "marigold-100"], ["ink", "brand-50"], ["ink-muted", "brand-50"], ["ink-muted", "maroon-50"], ["ink-muted", "peacock-50"],
    // v7: account control and cloud choice dialog (status chip tones, avatar initial, sign-in error, the two version cards).
    ["emerald-800", "emerald-50"], ["amber-800", "amber-50"], ["sand-700", "surface-muted"], ["white", "brand-700"], ["red-700", "surface"],
    ["ink", "surface-muted"], ["ink-muted", "surface-muted"], ["sand-800", "surface"], ["white", "primary"],
  ];
  for (const [fg, bg] of text) test(`text ${fg} on ${bg} ≥ 4.5:1`, () => {
    const r = ratio(shade(fg), shade(bg));
    assert.ok(r >= 4.5, `${fg} (${shade(fg)}) on ${bg} (${shade(bg)}) = ${r.toFixed(2)}`);
  });
  // Non-text UI parts (WCAG 1.4.11): control borders, focus ring, budget segments and quote ticks, lane bars, KPI/task rules. 3:1 against what they sit on.
  const ui: [string, string][] = [
    ["line-strong", "surface"], ["line-strong", "canvas"], ["line-strong", "surface-muted"], ["sand-400", "sand-900"], ["sand-500", "white"], ["sand-500", "sand-100"],
    ["brand-700", "white"], ["brand-700", "sand-50"], ["brand-700", "sand-100"],
    // Active page tab rule (saffron, kumkum, maroon stops) on the header surface.
    ["marigold-700", "white"], ["maroon-700", "white"],
    ["sand-700", "white"], ["sand-700", "sand-100"], ["emerald-600", "white"], ["emerald-600", "sand-100"], ["red-600", "white"], ["red-600", "sand-100"],
    ["amber-700", "white"], ["peacock-700", "white"], ["amber-600", "white"],
    // Timeline lanes on the lane track.
    ["brand-700", "sand-50"], ["peacock-700", "sand-50"], ["marigold-700", "sand-50"], ["emerald-700", "sand-50"], ["maroon-700", "sand-50"], ["sand-600", "sand-50"],
    ["emerald-600", "emerald-50"], ["red-600", "red-50"], ["marigold-500", "sand-800"],
    // v5: setup checkboxes and the selected event-type card border (brand-700), the ideas Lightbulb (marigold-700).
    ["brand-700", "brand-50"], ["marigold-700", "white"], ["line-strong", "sand-50"],
    // v7: the cloud / device icons on the version cards and the status chip icons.
    ["peacock-700", "surface-muted"], ["brand-700", "surface-muted"], ["emerald-800", "emerald-50"], ["amber-800", "amber-50"],
  ];
  for (const [fg, bg] of ui) test(`UI ${fg} on ${bg} ≥ 3:1`, () => {
    const r = ratio(shade(fg), shade(bg));
    assert.ok(r >= 3, `${fg} (${shade(fg)}) on ${bg} (${shade(bg)}) = ${r.toFixed(2)}`);
  });
  test("placeholder text (sand-600) reads at body-copy contrast on white", () => {
    assert.match(globals, /::placeholder\s*\{\s*color:\s*var\(--color-sand-600\)/);
    assert.ok(ratio("sand-600", "white") >= 4.5);
  });
});

describe("type floor (WCAG 1.4.4 / 1.4.12 spirit)", () => {
  test("no component uses text smaller than 12px (no text-[10px] / text-[11px] or other arbitrary sub-12px sizes)", () => {
    const dir = new URL("../components/", import.meta.url);
    for (const f of readdirSync(dir).filter(n => n.endsWith(".tsx"))) {
      const src = readFileSync(new URL(f, dir), "utf8");
      const hit = src.match(/text-\[(\d+(?:\.\d+)?)px\]/g)?.filter(m => Number(m.match(/[\d.]+/)![0]) < 12);
      assert.deepEqual(hit ?? [], [], `${f} uses ${hit?.join(", ")}`);
    }
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

// ---------- dark theme: globals.css re-points the palette shades (and so the tokens) under :root[data-theme="dark"] ----------
const darkBlock = globals.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] ?? "";
const darkValues = new Map<string, [number, number, number]>();
for (const m of darkBlock.matchAll(/--color-([a-z]+(?:-\d+)?):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/g)) darkValues.set(m[1]!, [Number(m[2]) / 100, Number(m[3]), Number(m[4])]);
/** A token or palette name, resolved the way the browser does in dark mode: token → shade → the shade's dark value. */
const darkColour = (name: string): [number, number, number] => {
  const s = shade(name);
  const c = darkValues.get(s) ?? palette.get(s);
  assert.ok(c, `unknown colour ${name}`);
  return c;
};
const darkRatio = (fg: string, bg: string) => {
  palette.set("__fg", darkColour(fg)); palette.set("__bg", darkColour(bg));
  return ratio("__fg", "__bg");
};
// Every pair checked in the light theme above, now in the dark theme. Same thresholds.
const pairLists = [...readFileSync(new URL(import.meta.url), "utf8").matchAll(/const (text|ui): \[string, string\]\[\] = \[([\s\S]*?)\];/g)]
  .map(m => ({ min: m[1] === "text" ? 4.5 : 3, pairs: [...m[2]!.matchAll(/\["([a-z0-9-]+)", "([a-z0-9-]+)"\]/g)].map(p => [p[1]!, p[2]!] as const) }));

describe("dark theme palette (WCAG 1.4.3 / 1.4.11 in both themes)", () => {
  test("the dark block exists, is screen-only (print stays light) and sets color-scheme", () => {
    // White plus all eleven steps of every scale the UI is built from (8 × 11 + 1 = 89 values).
    for (const scale of ["sand", "brand", "maroon", "peacock", "marigold", "emerald", "amber", "red"])
      for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) assert.ok(darkValues.has(`${scale}-${step}`), `no dark value for ${scale}-${step}`);
    assert.ok(darkValues.has("white") && darkValues.size >= 89, `only ${darkValues.size} dark values`);
    assert.match(globals, /@media screen\s*\{\s*:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;/);
    assert.doesNotMatch(globals.replace(/@media screen\s*\{[\s\S]*?\n\}/, ""), /data-theme="dark"/, "a dark rule outside @media screen would reach print");
  });
  test("every palette shade a component or the app uses has a dark value (nothing light leaks into dark mode)", () => {
    const used = new Set<string>();
    const scan = (dir: URL) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory()) scan(new URL(`${f.name}/`, dir));
        else if (/\.(tsx|css)$/.test(f.name)) for (const m of readFileSync(new URL(f.name, dir), "utf8").matchAll(/(?:^|[\s"'`:-])(?:bg|text|ring|border|from|via|to|accent|divide|decoration|outline|fill|stroke)-((?:white)|(?:[a-z]+-\d{2,3}))(?:\/\d+)?\b/g)) used.add(m[1]!);
      }
    };
    scan(new URL("../components/", import.meta.url));
    scan(new URL("../app/", import.meta.url));
    for (const m of globals.matchAll(/var\(--color-([a-z]+-\d+)\)/g)) used.add(m[1]!);
    const missing = [...used].filter(c => palette.has(c) && !darkValues.has(c));
    assert.deepEqual(missing, []);
    assert.ok(used.size > 40, `scan found only ${used.size} colours`);
  });
  test("design tokens resolve to dark surfaces and light ink", () => {
    assert.ok(luminanceOf(darkColour("surface")) < 0.05 && luminanceOf(darkColour("canvas")) < 0.05);
    assert.ok(luminanceOf(darkColour("ink")) > 0.8);
  });
  for (const { min, pairs } of pairLists) for (const [fg, bg] of pairs) test(`dark: ${min === 3 ? "UI" : "text"} ${fg} on ${bg} ≥ ${min}:1`, () => {
    const r = darkRatio(fg, bg);
    assert.ok(r >= min, `${fg} on ${bg} in dark mode = ${r.toFixed(2)}`);
  });
  test("focus outline and placeholder keep their contrast in dark mode", () => {
    for (const bg of ["surface", "canvas", "surface-muted"]) assert.ok(darkRatio("brand-700", bg) >= 3, `focus on ${bg}`);
    assert.ok(darkRatio("sand-600", "surface") >= 4.5);
  });
});
function luminanceOf(c: [number, number, number]) { palette.set("__x", c); return luminance("__x"); }
