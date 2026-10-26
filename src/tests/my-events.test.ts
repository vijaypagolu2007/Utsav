// Run: npm test. v8 Part 0b: "My events" vs "Samples" in the event menu, the first sign-in choice, and the rule that
// keeps untouched samples out of a signed-in account. Pure parts directly; the event menu, the chooser and the red-flag
// badge statically from their source (no browser needed).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EVENT_TYPE_LABEL, FIRST_CHOICE_KEY, hasMeaningfulLocalEdits, isOwnEvent, isPristineSample, loadFirstChoice, mayCreateCloudCopy, needsCloudProbe,
  saveFirstChoice, shouldShowFirstChoice, switcherSections, type CloudPlans, type FirstChoiceInput,
} from "../my-events";
import { defaultStore, freshHistory, type Store } from "../persistence";
import { instantiateTemplate, TEMPLATES, type TemplateId } from "../config/event-templates";
import { DEVICE_PLAN_KEYS } from "../signin";
import { statusLabel, shouldAutosave } from "../cloud-sync";
import type { AgentState } from "../schema";

const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
const renamed = (p: AgentState, title: string): AgentState => ({ ...p, event: { ...p.event, title } });
const own = (slot: TemplateId, title: string): AgentState => { const p = instantiateTemplate(slot); return { ...p, event: { ...p.event, id: "ev-my-own", title } }; };
const withSlot = (s: Store, slot: TemplateId, plan: AgentState, active = false): Store =>
  ({ ...s, ...(active ? { active: slot } : {}), byType: { ...s.byType, [slot]: { snaps: [...(s.byType[slot]?.snaps ?? []), { plan, label: "x" }], idx: s.byType[slot]?.snaps.length ?? 0 } } });

describe("what a slot holds", () => {
  test("a fresh copy of every template is a pristine sample and not the organizer's own", () => {
    for (const t of TEMPLATES) {
      const p = instantiateTemplate(t.id as TemplateId);
      assert.equal(isPristineSample(t.id as TemplateId, p), true, t.id);
      assert.equal(isOwnEvent(t.id as TemplateId, p), false, t.id);
    }
  });
  test("an edit makes it an edited sample; a different event id makes it the organizer's own", () => {
    const p = instantiateTemplate("wedding");
    assert.equal(isPristineSample("wedding", renamed(p, "Ours")), false);
    assert.equal(isOwnEvent("wedding", renamed(p, "Ours")), false);
    assert.equal(isOwnEvent("wedding", own("wedding", "Priya & Kiran")), true);
  });
  test("meaningful local edits: none on a brand-new device, yes after any edit or an own event in any slot", () => {
    const s = defaultStore();
    assert.equal(hasMeaningfulLocalEdits(s), false);
    assert.equal(hasMeaningfulLocalEdits({ ...s, byType: { ...s.byType, birthday: freshHistory("birthday") } }), false);
    assert.equal(hasMeaningfulLocalEdits(withSlot(s, "wedding", renamed(instantiateTemplate("wedding"), "Edited"))), true);
    assert.equal(hasMeaningfulLocalEdits(withSlot(s, "community", own("community", "Our fest"))), true);
  });
  test("an edit undone back to the sample is pristine again (the slot's current step counts)", () => {
    const s = withSlot(defaultStore(), "wedding", renamed(instantiateTemplate("wedding"), "Edited"));
    assert.equal(hasMeaningfulLocalEdits({ ...s, byType: { ...s.byType, wedding: { ...s.byType.wedding!, idx: 0 } } }), false);
  });
});

describe("event menu sections", () => {
  test("a brand-new device: no own events, every template under Samples with type and budget, the active one marked", () => {
    const x = switcherSections(defaultStore());
    assert.deepEqual(x.mine, []);
    assert.deepEqual(x.covered, []);
    assert.deepEqual(x.samples.map(e => e.slot), TEMPLATES.map(t => t.id));
    assert.deepEqual(x.samples.map(e => e.title), TEMPLATES.map(t => t.name));
    assert.deepEqual(x.samples.map(e => e.detail), ["Wedding · ₹25L", "Birthday · ₹1.5L", "Community event · ₹5L"]);
    assert.deepEqual(x.samples.map(e => e.active), [true, false, false]);
    assert.ok(x.samples.every(e => e.now === null && !e.edited));
    // No numbering anywhere: the old "1. Royal Wedding — ₹25L" option text is gone.
    assert.ok(x.samples.every(e => !/^\d+\./.test(e.title) && !e.title.includes("—")));
  });
  test("a renamed sample keeps the '(now: …)' hint and is marked edited", () => {
    const x = switcherSections(withSlot(defaultStore(), "birthday", renamed(instantiateTemplate("birthday"), "Kabir turns 30"), true));
    const b = x.samples.find(e => e.slot === "birthday")!;
    assert.equal(b.title, "30th Arcade Birthday");
    assert.equal(b.now, "Kabir turns 30");
    assert.equal(b.edited, true);
    assert.equal(b.active, true);
  });
  test("an own event moves to My events under its own title, and the sample it replaced is listed as covered", () => {
    const p = own("wedding", "Priya & Kiran's wedding");
    const x = switcherSections(withSlot(defaultStore(), "wedding", { ...p, event: { ...p.event, totalBudgetPaise: 12_00_000_00 } }, true));
    assert.deepEqual(x.mine.map(e => [e.slot, e.title, e.detail, e.active]), [["wedding", "Priya & Kiran's wedding", "Wedding · ₹12L", true]]);
    assert.deepEqual(x.samples.map(e => e.slot), ["birthday", "community"]);
    assert.deepEqual(x.covered, [{ slot: "wedding", name: "Royal Wedding", type: "wedding" }]);
  });
  test("type labels cover every event type", () => {
    assert.deepEqual(Object.keys(EVENT_TYPE_LABEL).sort(), ["birthday", "community", "wedding"]);
  });
});

describe("first sign-in choice (shouldShowFirstChoice)", () => {
  const base: FirstChoiceInput = { signedIn: true, answered: false, cloudPlans: "none", localEdits: false };
  test("shows for a signed-in account with an empty cloud, nothing local and no answer yet", () => {
    assert.equal(shouldShowFirstChoice(base), true);
  });
  test("never while signed out, once answered, or with local edits to upload", () => {
    assert.equal(shouldShowFirstChoice({ ...base, signedIn: false }), false);
    assert.equal(shouldShowFirstChoice({ ...base, answered: true }), false);
    assert.equal(shouldShowFirstChoice({ ...base, localEdits: true }), false);
  });
  test("only when the cloud is known to be empty: still checking, has plans, or failed means no chooser", () => {
    for (const c of ["unknown", "some", "error"] as CloudPlans[]) assert.equal(shouldShowFirstChoice({ ...base, cloudPlans: c }), false, c);
  });
  test("the whole truth table: true in exactly one of 2×2×2×4 cases", () => {
    let shown = 0;
    for (const signedIn of [true, false]) for (const answered of [true, false]) for (const localEdits of [true, false])
      for (const cloudPlans of ["unknown", "none", "some", "error"] as CloudPlans[]) if (shouldShowFirstChoice({ signedIn, answered, localEdits, cloudPlans })) shown++;
    assert.equal(shown, 1);
  });
  test("the cloud is asked only while the chooser could still show", () => {
    assert.equal(needsCloudProbe({ signedIn: true, answered: false, localEdits: false }), true);
    assert.equal(needsCloudProbe({ signedIn: false, answered: false, localEdits: false }), false);
    assert.equal(needsCloudProbe({ signedIn: true, answered: true, localEdits: false }), false);
    assert.equal(needsCloudProbe({ signedIn: true, answered: false, localEdits: true }), false);
  });
});

describe("samples stay out of the account until chosen or edited", () => {
  test("a pristine sample gets a cloud copy only after 'Load sample events'", () => {
    assert.equal(mayCreateCloudCopy({ pristineSample: true, choice: null }), false);
    assert.equal(mayCreateCloudCopy({ pristineSample: true, choice: "own" }), false);
    assert.equal(mayCreateCloudCopy({ pristineSample: true, choice: "samples" }), true);
  });
  test("an edited sample or an own event always may", () => {
    for (const choice of [null, "own", "samples"] as const) assert.equal(mayCreateCloudCopy({ pristineSample: false, choice }), true);
  });
  test("the held sample has its own status: labelled, and editing it lets autosave run", () => {
    assert.equal(statusLabel({ state: "sample" }), "Sample – not saved to your account");
    assert.equal(shouldAutosave({ state: "sample" }, instantiateTemplate("wedding"), null), true);
  });
  test("the hook keeps an untouched sample local on sign-in and on autosave", () => {
    const hook = src("../components/useCloudSync.ts");
    assert.match(hook, /if \(d\.kind === "create"\) \{ if \(mayCreateRef\.current\(u\.uid, key, planRef\.current\)\) await save\(0\); else setStatus\(\{ state: "sample" \}\); \}/);
    assert.match(hook, /if \(!base && !mayCreateRef\.current\(u\.uid, keyRef\.current, planRef\.current\)\)/);
    const app = src("../components/PlannerApp.tsx");
    assert.match(app, /useCloudSync\([^\n]*, mayCreate, \{/);
  });
});

describe("per-account answer on this device", () => {
  const fakeStorage = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); }, map: m }; };
  const withWindow = (f: (l: ReturnType<typeof fakeStorage>) => void) => {
    const l = fakeStorage(), g = globalThis as { window?: unknown }, prev = g.window;
    g.window = { localStorage: l };
    try { f(l); } finally { g.window = prev; }
  };
  test("remembered per uid; other accounts are still asked", () => withWindow(l => {
    assert.equal(loadFirstChoice("a"), null);
    saveFirstChoice("a", "samples");
    saveFirstChoice("b", "own");
    assert.equal(loadFirstChoice("a"), "samples");
    assert.equal(loadFirstChoice("b"), "own");
    assert.equal(loadFirstChoice("c"), null);
    assert.deepEqual(JSON.parse(l.map.get(FIRST_CHOICE_KEY)!), { a: "samples", b: "own" });
  }));
  test("junk, prototype keys and no uid read as unanswered", () => withWindow(l => {
    l.setItem(FIRST_CHOICE_KEY, "{not json");
    assert.equal(loadFirstChoice("a"), null);
    l.setItem(FIRST_CHOICE_KEY, JSON.stringify({ a: "maybe" }));
    assert.equal(loadFirstChoice("a"), null);
    assert.equal(loadFirstChoice("constructor"), null);
    assert.equal(loadFirstChoice("toString"), null);
    assert.equal(loadFirstChoice(null), null);
  }));
  test("'remove this plan from this device' clears the answers too; no window is a safe no-op", () => {
    assert.ok((DEVICE_PLAN_KEYS as readonly string[]).includes(FIRST_CHOICE_KEY));
    assert.equal(loadFirstChoice("a"), null);
    saveFirstChoice("a", "own");
  });
});

describe("event menu (static a11y checks)", () => {
  const bar = src("../components/CommandBar.tsx");
  const sw = bar.slice(bar.indexOf("function EventSwitcher"), bar.indexOf("export default function CommandBar"));
  test("the duplicate template <select> is gone; the title itself is the menu button", () => {
    assert.doesNotMatch(bar, /<select/);
    assert.doesNotMatch(bar, /\{i \+ 1\}\./);
    assert.ok(sw.length > 500, "EventSwitcher found");
    const btn = sw.slice(sw.indexOf("<button ref={btn}"), sw.indexOf("</button>", sw.indexOf("<button ref={btn}")));
    assert.match(btn, /aria-haspopup="menu"/);
    assert.match(btn, /aria-expanded=\{open\}/);
    assert.match(btn, /aria-controls=\{open \? menuId : undefined\}/);
    assert.match(btn, /data-testid="event-switcher"/);
    assert.match(sw, /<span className="sr-only">Event: <\/span>/);
    assert.match(sw, /<ChevronDown[^>]*aria-hidden="true"/);
  });
  test("menu semantics: role=menu labelled by the button, groups for My events / Samples / Actions, radio items for events", () => {
    assert.match(sw, /role="menu" id=\{menuId\} aria-labelledby=\{btnId\}/);
    assert.match(sw, /role="group" aria-labelledby=\{mineId\}/);
    assert.match(sw, /role="group" aria-labelledby=\{samplesId\}/);
    assert.match(sw, /role="group" aria-label="Actions"/);
    assert.match(sw, />My events</);
    assert.match(sw, />Samples</);
    assert.match(sw, /role="menuitemradio" aria-checked=\{e\.active\} tabIndex=\{-1\}/);
    // New event and Load sample events; v8 Part 0c adds each event's Delete, and Restore / Delete forever; Part 0d adds Restore samples.
    assert.equal(sw.match(/role="menuitem" tabIndex=\{-1\}/g)?.length, 6, "New event, Load sample events, Restore samples, Delete, Restore, Delete forever");
    assert.match(sw, /New event/);
    assert.match(sw, /Load sample events/);
  });
  test("keyboard: arrows wrap, Home/End, opening lands on the current event, Escape/outside click close and return focus", () => {
    for (const k of ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "]) assert.ok(sw.includes(`e.key === "${k}"`), k);
    assert.ok(sw.includes("((i % n) + n) % n"), "arrows wrap");
    assert.match(sw, /openAt\("current"\)/);
    assert.match(sw, /useDismiss\(open, setOpen, btn, wrap\)/);
    assert.match(bar, /if \(e\.key === "Escape"\) \{ e\.preventDefault\(\); setOpen\(false\); trigger\.current\?\.focus\(\); \}/);
    assert.match(sw, /const select = \(f: \(\) => void\) => \{ setOpen\(false\); btn\.current\?\.focus\(\); f\(\); \}/);
    assert.match(sw, /onBlur=\{e => \{ if \(open && e\.relatedTarget && !wrap\.current\?\.contains/);
  });
  test("touch-friendly rows, a popover that fits a phone, and no sub-12px text", () => {
    assert.match(sw, /min-h-11 w-full/);
    assert.match(sw, /max-sm:fixed max-sm:inset-x-3 max-sm:w-auto/);
    assert.match(sw, /max-md:min-h-11 pointer-coarse:min-h-11/);
    assert.doesNotMatch(sw, /text-\[(\d|1[01])(\.\d+)?px\]/);
  });
  test("the title stays non-heading text (pages own their h1), in both the menu button and Guest View", () => {
    assert.doesNotMatch(bar, /<h[1-6]/);
    assert.match(bar, /\{guest\s*\? <p className="line-clamp-2[^"]*" title=\{plan\.event\.title\}>\{plan\.event\.title\}<\/p>\s*: <EventSwitcher /);
  });
  test("the red-flag count is a calm outlined badge (red, amber or green outline on the surface), not a filled red block", () => {
    const flags = bar.match(/data-testid="red-flags"[\s\S]*?>/)?.[0] ?? "";
    assert.match(flags, /rounded-full border-2 bg-surface/);
    assert.doesNotMatch(bar, /bg-red-50 text-red-700 ring-red-300/);
    assert.match(bar, /insights\.counts\.critical \? "border-red-600 text-red-700" : flagCount \? "border-amber-700 text-amber-800" : "border-emerald-600 text-emerald-800"/);
  });
});

describe("first-choice dialog (static checks)", () => {
  const dlg = src("../components/FirstChoiceDialog.tsx"), app = src("../components/PlannerApp.tsx");
  test("native modal dialog, labelled and described, with both choices and a Strict Mode-safe close", () => {
    assert.match(dlg, /<dialog ref=\{ref\} aria-labelledby=\{titleId\} aria-describedby=\{descId\} data-testid="first-choice-dialog"/);
    assert.match(dlg, /d\.showModal\(\)/);
    assert.match(dlg, /onClose=\{\(\) => \{ if \(!ref\.current\?\.open\) onClose\(\); \}\}/);
    assert.match(dlg, /data-testid="first-choice-own"[\s\S]*Start your own event/);
    assert.match(dlg, /data-testid="first-choice-samples"[\s\S]*Load sample events/);
    assert.match(dlg, /<h2 /);
    assert.doesNotMatch(dlg, /<h1/);
  });
  test("wired once: opens from shouldShowFirstChoice, never over Guest View or the version chooser; own → setup, samples → loaded", () => {
    assert.equal(app.match(/<FirstChoiceDialog\b/g)?.length, 1);
    assert.match(app, /<FirstChoiceDialog open=\{chooserOpen && !guest && !choicePending\}/);
    assert.match(app, /const startOwnEvent = \(\) => \{ rememberChoice\("own"\); router\.push\(SETUP_PATH\); \};/);
    assert.match(app, /onLoadSamples=\{loadSampleEvents\}/);
    assert.match(app, /onLoadSamples=\{account && firstChoice !== "samples" \? loadSampleEvents : undefined\}/);
  });
});
