// v8 Part 3: the header theme toggle (System, then Light, then Dark) and the redesigned dark theme. v8 Part 3b: the
// ui-ux-pro-max "Premium dark + gold accent" direction (warm stone / charcoal grounds, lifted card surfaces, warm ivory
// text, a muted rose primary, gold accents, a coral danger red, dark shadows) and the "Classic Elegant" type pairing.
// The pairwise contrast of both themes is checked in a11y.test.ts; this file checks the toggle's logic and wiring and the
// character of the dark palette.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { isThemePref, nextThemePref, readThemePref, resolveTheme, setThemePref, subscribeTheme, THEME_BOOT_SCRIPT, THEME_KEY, THEME_LABELS, THEME_PREFS, themeToggleLabel, type ThemePref } from "../theme";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** A minimal browser: localStorage, matchMedia, <html> attributes and window event listeners. */
function fakeBrowser(systemDark = false, storage: Record<string, string> = {}, throwing = false) {
  const store = new Map(Object.entries(storage));
  const attrs = new Map<string, string>();
  const handlers = new Map<string, Set<(e: unknown) => void>>();
  const mqHandlers = new Set<() => void>();
  const mq = { matches: systemDark, addEventListener: (_: string, h: () => void) => { mqHandlers.add(h); } };
  const localStorage = {
    getItem: (k: string) => { if (throwing) throw new Error("denied"); return store.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (throwing) throw new Error("denied"); store.set(k, v); },
  };
  const window = {
    localStorage,
    matchMedia: () => mq,
    addEventListener: (t: string, h: (e: unknown) => void) => { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t)!.add(h); },
    removeEventListener: (t: string, h: (e: unknown) => void) => { handlers.get(t)?.delete(h); },
    __utsavTheme: undefined as undefined | (() => void),
  };
  const document = { documentElement: { setAttribute: (k: string, v: string) => { attrs.set(k, v); }, getAttribute: (k: string) => attrs.get(k) ?? null } };
  const fire = (t: string, e: unknown) => { for (const h of handlers.get(t) ?? []) h(e); };
  const listenerCount = (t: string) => handlers.get(t)?.size ?? 0;
  const setSystemDark = (v: boolean) => { mq.matches = v; for (const h of mqHandlers) h(); };
  return { window, document, store, attrs, fire, listenerCount, setSystemDark };
}
function withBrowser<T>(b: ReturnType<typeof fakeBrowser>, f: () => T): T {
  const g = globalThis as { window?: unknown; document?: unknown };
  const prev = [g.window, g.document];
  g.window = b.window; g.document = b.document;
  try { return f(); } finally { [g.window, g.document] = prev; }
}

describe("theme toggle: cycle and accessible name", () => {
  test("a press cycles System, then Light, then Dark, then back to System", () => {
    assert.deepEqual([...THEME_PREFS], ["system", "light", "dark"]);
    assert.equal(nextThemePref("system"), "light");
    assert.equal(nextThemePref("light"), "dark");
    assert.equal(nextThemePref("dark"), "system");
    let p: ThemePref = "system";
    const seen: ThemePref[] = [];
    for (let i = 0; i < 6; i++) { p = nextThemePref(p); seen.push(p); }
    assert.deepEqual(seen, ["light", "dark", "system", "light", "dark", "system"]);
  });
  test("the label says the current theme and what a press switches to", () => {
    assert.equal(themeToggleLabel("system"), "Theme: System. Switch to Light");
    assert.equal(themeToggleLabel("light"), "Theme: Light. Switch to Dark");
    assert.equal(themeToggleLabel("dark"), "Theme: Dark. Switch to System");
    for (const p of THEME_PREFS) assert.match(themeToggleLabel(p), new RegExp(`^Theme: ${THEME_LABELS[p]}\\. Switch to ${THEME_LABELS[nextThemePref(p)]}$`));
  });
  test("isThemePref and resolveTheme", () => {
    assert.ok(THEME_PREFS.every(isThemePref));
    assert.equal(isThemePref("purple"), false);
    assert.equal(isThemePref(null), false);
    assert.equal(resolveTheme("system", true), "dark");
    assert.equal(resolveTheme("system", false), "light");
    assert.equal(resolveTheme("light", true), "light");
    assert.equal(resolveTheme("dark", false), "dark");
  });
});

describe("theme store (what the toggle reads and writes)", () => {
  test("readThemePref: stored value, System for nothing, junk or blocked storage", () => {
    assert.equal(withBrowser(fakeBrowser(false, { [THEME_KEY]: "dark" }), readThemePref), "dark");
    assert.equal(withBrowser(fakeBrowser(false, {}), readThemePref), "system");
    assert.equal(withBrowser(fakeBrowser(false, { [THEME_KEY]: "purple" }), readThemePref), "system");
    assert.equal(withBrowser(fakeBrowser(false, {}, true), readThemePref), "system");
  });
  test("setThemePref stores the choice, applies it to <html> and notifies subscribers; unsubscribe stops them", () => {
    const b = fakeBrowser(true);
    withBrowser(b, () => {
      let calls = 0;
      const off = subscribeTheme(() => { calls++; });
      setThemePref("light");
      assert.equal(b.store.get(THEME_KEY), "light");
      assert.equal(b.attrs.get("data-theme"), "light");
      assert.equal(b.attrs.get("data-theme-pref"), "light");
      setThemePref("system"); // the fake device is dark
      assert.equal(b.attrs.get("data-theme"), "dark");
      assert.equal(b.attrs.get("data-theme-pref"), "system");
      assert.equal(calls, 2);
      // Another tab's change to the theme key reaches the subscriber; other keys don't.
      b.fire("storage", { key: THEME_KEY });
      b.fire("storage", { key: "something-else" });
      assert.equal(calls, 3);
      off();
      assert.equal(b.listenerCount("storage"), 0);
      setThemePref("dark");
      assert.equal(calls, 3);
    });
  });
  test("setThemePref still applies the theme for this page when storage is blocked", () => {
    const b = fakeBrowser(false, {}, true);
    withBrowser(b, () => setThemePref("dark"));
    assert.equal(b.attrs.get("data-theme"), "dark");
  });
  test("the inline boot script applies the stored choice, falls back to System, and follows the device", () => {
    const run = (b: ReturnType<typeof fakeBrowser>) => new Function("window", "document", THEME_BOOT_SCRIPT)(b.window, b.document);
    const dark = fakeBrowser(false, { [THEME_KEY]: "dark" });
    run(dark);
    assert.equal(dark.attrs.get("data-theme"), "dark");
    const sys = fakeBrowser(false, { [THEME_KEY]: "purple" });
    run(sys);
    assert.equal(sys.attrs.get("data-theme"), "light");
    assert.equal(sys.attrs.get("data-theme-pref"), "system");
    sys.setSystemDark(true);
    assert.equal(sys.attrs.get("data-theme"), "dark");
  });
});

describe("theme toggle wiring (static checks)", () => {
  const toggle = src("../components/ThemeToggle.tsx"), bar = src("../components/CommandBar.tsx");
  test("ThemeToggle is a named IconButton (44px on coarse pointers) on the theme store, with a 'system' server snapshot", () => {
    assert.match(toggle, /^"use client";/);
    assert.match(toggle, /useSyncExternalStore\(subscribeTheme, readThemePref, \(\) => "system" as ThemePref\)/);
    assert.match(toggle, /<IconButton label=\{themeToggleLabel\(pref\)\} onClick=\{\(\) => setThemePref\(nextThemePref\(pref\)\)\} data-testid="theme-toggle"/);
    assert.match(toggle, /system: Monitor, light: Sun, dark: Moon/);
    const icon = src("../components/ui.tsx").match(/export function IconButton[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(icon, /pointer-coarse:h-11 pointer-coarse:w-11/);
    assert.match(icon, /aria-label=\{label\}/);
  });
  test("the header shows the toggle outside the organizer-only controls and the More menu no longer has the select", () => {
    assert.doesNotMatch(bar, /ThemeSelect/);
    assert.equal(bar.match(/<ThemeToggle \/>/g)?.length, 1);
    const at = bar.indexOf("<ThemeToggle />");
    assert.ok(at > bar.indexOf("</MoreMenu>"), "after the More menu");
    assert.ok(at < bar.indexOf('data-testid="header-account-slot"'), "just before the account slot");
    // Not inside the {!empty && ...} block that holds the view switch and the organizer controls: it closes before the toggle.
    const empty = bar.indexOf("{!empty && <div");
    assert.ok(empty > 0 && bar.lastIndexOf("</div>}", at) > empty, "outside the !empty block");
  });
});

describe("dark theme redesign (character of the palette)", () => {
  const css = src("../app/globals.css");
  const dark = css.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] ?? "";
  const v = (name: string) => {
    const m = dark.match(new RegExp(`--color-${name}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`));
    assert.ok(m, `no dark value for ${name}`);
    return { L: Number(m[1]), C: Number(m[2]), h: Number(m[3]) };
  };
  const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  test("a warm stone / charcoal ground (no purple or plum) with lifted card and hover surfaces", () => {
    const canvas = v("sand-50"), card = v("white"), hover = v("sand-100");
    // Every neutral (grounds, surfaces, lines and text) is warm stone: hue 50-70 at very low chroma.
    for (const n of ["white", ...[50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map(k => `sand-${k}`)]) {
      const s = v(n);
      assert.ok(s.C >= 0.004 && s.C <= 0.012, `${n} chroma ${s.C}`);
      assert.ok(s.h >= 50 && s.h <= 70, `${n} stone hue, got ${s.h}`);
    }
    // The tinted soft surfaces are never purple or plum (hue 280-350) either.
    for (const n of ["brand-50", "brand-100", "maroon-50", "maroon-100", "marigold-50", "marigold-100", "red-50", "peacock-50"]) {
      const h = v(n).h;
      assert.ok(!(h >= 280 && h <= 350), `${n} purple hue ${h}`);
    }
    assert.ok(canvas.L < card.L && card.L < hover.L, "each elevation step is lighter");
    assert.ok(canvas.L >= 12, "not pure black");
  });
  test("soft ivory text, not pure white", () => {
    const ink = v("sand-900");
    assert.ok(ink.L < 98 && ink.L > 93);
    assert.ok(ink.C > 0 && ink.h >= 60 && ink.h <= 100, "warm ivory");
  });
  test("a muted rose primary, kept clearly apart from the coral danger red; gold only as an accent", () => {
    const primary = v("brand-700"), danger = v("red-700"), gold = v("marigold-400");
    assert.ok(primary.L >= 72 && primary.C >= 0.1 && primary.C <= 0.14, `muted rose, not neon (C ${primary.C})`);
    assert.ok(primary.h >= 350 || primary.h <= 10, `rose hue, got ${primary.h}`);
    assert.ok(hueGap(primary.h, danger.h) >= 30, `primary and danger hues too close: ${primary.h} vs ${danger.h}`);
    assert.ok(gold.h >= 60 && gold.h <= 90, "gold accent");
    // The primary token is the rose, never the gold (the old dark theme turned the brand scale saffron).
    assert.match(css, /--color-primary: var\(--color-brand-700\);/);
    assert.ok(hueGap(primary.h, gold.h) > 45);
  });
  test("dark shadows: deeper black shadows with a top highlight, applied to the shadow utilities", () => {
    for (const k of ["--shadow-sm", "--shadow", "--shadow-lg", "--shadow-xl"]) assert.match(dark, new RegExp(`${k}: [^;]*rgb\\(0 0 0 / 0\\.\\d+\\)`), k);
    assert.match(dark, /--shadow-highlight: inset 0 1px 0 0 rgb\(255 \d+ \d+ \/ 0\.0\d+\);/);
    for (const c of ["shadow-sm", "shadow", "shadow-lg", "shadow-xl"]) assert.match(css, new RegExp(`:root\\[data-theme="dark"\\] \\.${c}[ ,][^{]*\\{ --tw-shadow: var\\(--shadow-highlight\\), var\\(--`), c);
    assert.match(css, /:root\[data-theme="dark"\] \.hero-silk \{ box-shadow: inset 0 -3px 0 [^;]*rgb\(0 0 0 \/ 0\.65\)/);
  });
});

describe("v8 Part 3b: Classic Elegant type and Soft UI motion", () => {
  const css = src("../app/globals.css"), layout = src("../app/layout.tsx");
  test("Inter (body) and Playfair Display (headings) as vendored woff2 @font-face with swap, no next/font/google; no Cormorant", () => {
    assert.doesNotMatch(layout, /next\/font/);
    for (const f of ["inter-latin", "inter-latin-ext", "playfair-display-latin", "playfair-display-latin-ext"]) {
      assert.match(css, new RegExp(`src: url\\("\\./fonts/${f}\\.woff2"\\) format\\("woff2"\\)`));
      assert.ok(statSync(new URL(`../app/fonts/${f}.woff2`, import.meta.url)).size > 10_000, `${f}.woff2 is vendored`);
    }
    assert.match(css, /@font-face \{ font-family: "Inter"; font-style: normal; font-weight: 400 700; font-display: swap;/);
    assert.match(css, /@font-face \{ font-family: "Playfair Display"; font-style: normal; font-weight: 600 700; font-display: swap;/);
    assert.match(css, /--font-sans: "Inter", ui-sans-serif, system-ui/);
    assert.match(css, /--font-display: "Playfair Display", Georgia/);
    assert.match(css, /h1, h2 \{ font-family: var\(--font-display\);/);
    assert.doesNotMatch(css + layout, /Cormorant|font-size-adjust/);
  });
  test("controls ease over 200ms, and prefers-reduced-motion cuts every transition", () => {
    assert.match(css, /transition-duration: 200ms;/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after, ::backdrop \{[^}]*transition-duration: 0\.01ms !important;/);
  });
});
