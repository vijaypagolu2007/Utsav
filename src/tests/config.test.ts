// Run: npm test. Configuration layer: templates, template API, option lists, demo prompts, generic layouts, KPIs.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
process.env.UTSAV_SILENT_LOGS = "1";
import {
  DEFAULT_TEMPLATE_ID, EventTemplate, GUEST_SECTIONS, ORGANIZER_SECTIONS, PublicTemplate, TEMPLATE_DEFINITIONS, TEMPLATES,
  defaultTemplateFor, formatTokens, getTemplate, instantiateTemplate, isTemplateId, parseTemplateRegistry, presentationFor,
  slotFor, templateLabel, templateTokens, toPublicTemplate, type TemplateId,
} from "../config/event-templates";
import { DEMO_PROMPTS, DemoPrompt, DemoPromptList, promptsFor } from "../config/demo-prompts";
import { KPI_DEFINITIONS, KpiDefinitionList, kpisFor, kpiTestId } from "../config/kpis";
import {
  DIET_OPTIONS, GUEST_RSVP_ANSWERS, PERMIT_STATUS_OPTIONS, RSVP_LABELS, RSVP_STATUS_OPTIONS, SPONSOR_STATUS_OPTIONS,
  SPONSOR_TIER_OPTIONS, TASK_COLUMN_ORDER, TASK_NEXT_STATUS, TASK_STATUS_OPTIONS, VOLUNTEER_SHIFTS, labelOf,
} from "../config/planner-options";
import { KPI_CALCULATORS, kpiContext, kpiValue } from "../kpis";
import { handleEventTemplates, type TemplatesResponseBody } from "../server/templates-handler";
import { toResponse } from "../server/http";
import { AgentState, EventType, PermitStatus, RsvpStatus, SponsorStatus, SponsorTier, TaskStatus } from "../schema";
import { applyBatch, Batch, checkInvariants, GUEST_ALLOWED_OPS } from "../commands";
import { batchTier } from "../trust";
import { runOfflineAgent, runOfflineGuestAgent } from "../offline";
import { handleChat } from "../server/chat-handler";
import { defaultStore, freshHistory, historyOf, parseStore, serializeStore, storedTitles } from "../persistence";
import { arcadeBirthday, culturalFest, royalWedding } from "../presets";
import ArchetypeCard from "../components/ArchetypeCard";
import GuestMicrosite from "../components/GuestMicrosite";

const TODAY = "2026-10-21";
const raw = () => structuredClone(TEMPLATE_DEFINITIONS) as Record<string, unknown>[];
const ids = <T>(xs: readonly T[], f: (x: T) => string) => xs.map(f);
const allIdsOf = (p: AgentState) => [
  ...p.subEvents.map(x => x.id), ...p.budgetItems.map(x => x.id), ...p.tasks.map(x => x.id), ...p.timeline.map(x => x.id),
  ...p.vendors.map(x => x.id), ...p.households.map(x => x.id), ...p.guests.map(x => x.id),
];

// ---------------------------------------------------------------- A. templates
describe("event template registry", () => {
  test("every template validates, ids are unique and stable, every event type has a template", () => {
    assert.deepEqual(TEMPLATES.map(t => t.id), ["wedding", "birthday", "community"]);
    for (const t of TEMPLATES) assert.ok(EventTemplate.safeParse(t).success, t.id);
    assert.equal(new Set(TEMPLATES.map(t => t.id)).size, TEMPLATES.length);
    for (const type of EventType.options) assert.equal(defaultTemplateFor(type).eventType, type);
    assert.equal(DEFAULT_TEMPLATE_ID, "wedding");
  });

  test("labels are unchanged from the hand-written presets", () => {
    assert.deepEqual(TEMPLATES.map(templateLabel), ["Royal Wedding — ₹25L", "30th Arcade Birthday — ₹1.5L", "Community Cultural Fest — ₹5L"]);
  });

  test("seeds are the authored plans, valid and inside budget", () => {
    const seeds = [royalWedding, arcadeBirthday, culturalFest];
    TEMPLATES.forEach((t, i) => {
      assert.deepEqual(t.seed, seeds[i]);
      assert.deepEqual(checkInvariants(t.seed), []);
    });
  });

  test("invalid definitions are rejected with a useful message", () => {
    const cases: [string, (d: Record<string, unknown>[]) => void, RegExp][] = [
      ["duplicate id", d => { d[1]!.id = "wedding"; }, /duplicate template id/],
      ["bad id", d => { d[0]!.id = "Royal Wedding"; }, /lowercase/],
      ["unknown event type", d => { d[0]!.eventType = "funeral"; }, /eventType/],
      ["seed of another type", d => { d[0]!.seed = arcadeBirthday; }, /seed is a birthday plan/],
      ["invalid seed", d => { d[0]!.seed = { event: { title: "x" } }; }, /seed/],
      ["section for another type", d => { (d[0]!.layout as { columns: string[][] }).columns = [["permit-tracker"]]; }, /needs community/],
      ["unknown section", d => { (d[0]!.layout as { columns: string[][] }).columns = [["custom-html"]]; }, /columns/],
      ["removed section (v8 Part 1f)", d => { (d[0]!.layout as { columns: string[][] }).columns = [["rsvp-matrix"], ["diet-summary"]]; }, /columns/],
      ["unknown guest section", d => { (d[2]!.guest as { footer: string[] }).footer = ["guest-wishlist"]; }, /needs birthday/],
      ["unknown token", d => { (d[0]!.layout as { heading: string }).heading = "Hi {process}"; }, /unknown \{token\}/],
      ["unknown key (e.g. code)", d => { d[0]!.render = "() => alert(1)"; }, /render|Unrecognized/i],
      ["missing event type coverage", d => { d.splice(2, 1); }, /no template for event type "community"/],
      ["empty", d => { d.length = 0; }, /./],
    ];
    for (const [name, mutate, re] of cases) {
      const d = raw(); mutate(d);
      const r = parseTemplateRegistry(d);
      assert.equal(r.ok, false, name);
      if (!r.ok) assert.match(r.issues.join("\n"), re, name);
    }
  });

  test("the registry is deep-frozen and instantiation returns fresh, independent copies", () => {
    const t = getTemplate("wedding")!;
    assert.ok(Object.isFrozen(t) && Object.isFrozen(t.seed) && Object.isFrozen(t.seed.guests) && Object.isFrozen(t.seed.guests[0]));
    assert.throws(() => { (t.seed.guests as unknown as unknown[]).push({}); }, TypeError);
    const a = instantiateTemplate("wedding"), b = instantiateTemplate("wedding");
    assert.notEqual(a, b); assert.notEqual(a.guests, b.guests); assert.notEqual(a.guests[0], b.guests[0]); assert.notEqual(a.event.ext, t.seed.event.ext);
    assert.ok(!Object.isFrozen(a) && !Object.isFrozen(a.guests[0]));
    a.guests[0]!.name = "Changed"; a.budgetItems.push({ ...a.budgetItems[0]!, id: "extra" }); (a.event.ext as { partners: string[] }).partners[0] = "X";
    assert.equal(b.guests[0]!.name, royalWedding.guests[0]!.name);
    assert.equal(t.seed.guests[0]!.name, royalWedding.guests[0]!.name);
    assert.equal(b.budgetItems.length, royalWedding.budgetItems.length);
    assert.deepEqual(b, t.seed);
  });

  test("each instance is a valid plan with unique, deterministic entity ids", () => {
    for (const t of TEMPLATES) {
      const p = instantiateTemplate(t.id as TemplateId);
      assert.ok(AgentState.safeParse(p).success, t.id);
      assert.equal(p.event.eventType, t.eventType);
      const all = allIdsOf(p);
      assert.equal(new Set(all).size, all.length, `${t.id}: duplicate entity id`);
      assert.deepEqual(allIdsOf(instantiateTemplate(t.id as TemplateId)), all, `${t.id}: ids must be deterministic`);
    }
  });

  test("editing a plan through the reducer never touches the registry or another slot", () => {
    const before = JSON.stringify(TEMPLATES);
    const a = instantiateTemplate("wedding");
    const r = applyBatch(a, { summary: "cut", commands: [{ op: "adjust_budget", category: "decor", deltaPaise: -20_000_00 }] });
    assert.ok(r.ok);
    assert.equal(JSON.stringify(TEMPLATES), before);
    assert.deepEqual(instantiateTemplate("wedding"), a);
  });

  test("slots: a plan stays in the active template when the type matches, else goes to that type's default", () => {
    assert.equal(slotFor("wedding", royalWedding), "wedding");
    assert.equal(slotFor("wedding", arcadeBirthday), "birthday");
    assert.equal(slotFor("community", royalWedding), "wedding");
    assert.equal(presentationFor("community", royalWedding).id, "wedding");
    assert.equal(presentationFor("no-such-template", culturalFest).id, "community");
    assert.ok(isTemplateId("birthday") && !isTemplateId("__proto__") && !isTemplateId(42));
  });

  test("token text: plain substitution, optional [segments], no evaluation", () => {
    assert.equal(formatTokens("{honoree}[ turns {turningAge}] · {theme}", { honoree: "Aarav", turningAge: "", theme: "Space" }), "Aarav · Space");
    assert.equal(formatTokens("{honoree}[ turns {turningAge}] · {theme}", { honoree: "Aarav", turningAge: "7", theme: "Space" }), "Aarav turns 7 · Space");
    assert.equal(formatTokens("[{partners}]", { partners: "" }), "");
    assert.equal(formatTokens("${process.env.GEMINI_API_KEY} {title}", { title: "<b>x</b>" }), "${process.env.GEMINI_API_KEY} <b>x</b>");
    assert.equal(templateTokens(royalWedding).partners, "Arjun & Meera");
    assert.equal(templateTokens(royalWedding).honoree, "");
  });
});

// ---------------------------------------------------------------- persistence compatibility
describe("persistence with template slots", () => {
  test("a store saved before the registry existed loads unchanged", () => {
    const legacy = JSON.stringify({ v: 1, active: "community", today: "2026-11-01", byType: {
      wedding: { snaps: [{ plan: royalWedding, label: "Loaded Royal Wedding — ₹25L" }], idx: 0 },
      community: { snaps: [{ plan: culturalFest, label: "Loaded" }, { plan: culturalFest, label: "Edit" }], idx: 1 },
    } });
    const s = parseStore(legacy);
    assert.equal(s.active, "community");
    assert.equal(s.today, "2026-11-01");
    assert.deepEqual(s.byType.wedding!.snaps[0]!.plan, royalWedding);
    assert.equal(s.byType.community!.idx, 1);
    assert.deepEqual(JSON.parse(serializeStore(s)), JSON.parse(legacy));
  });

  test("a slot for a template this build doesn't know is preserved, not dropped", () => {
    const retired = { snaps: [{ plan: { anything: true }, label: "old" }], idx: 0 };
    const s = parseStore(JSON.stringify({ v: 1, active: "garden-party", byType: { "garden-party": retired, __proto__: { x: 1 } } }));
    assert.equal(s.active, "wedding");
    assert.deepEqual(s.retired, { "garden-party": retired });
    assert.deepEqual(JSON.parse(serializeStore(s)).byType["garden-party"], retired);
    assert.equal(({} as Record<string, unknown>).x, undefined);
  });

  test("snapshots of the wrong event type for a slot are discarded; fresh histories are independent copies", () => {
    const s = parseStore(JSON.stringify({ v: 1, active: "wedding", byType: { wedding: { snaps: [{ plan: arcadeBirthday }], idx: 0 } } }));
    assert.equal(s.byType.wedding!.snaps[0]!.plan.event.id, royalWedding.event.id);
    const h1 = freshHistory("birthday"), h2 = freshHistory("birthday");
    assert.notEqual(h1.snaps[0]!.plan, h2.snaps[0]!.plan);
    assert.equal(h1.snaps[0]!.label, "Loaded 30th Arcade Birthday — ₹1.5L");
    const st = defaultStore();
    assert.equal(historyOf(st, "community").snaps[0]!.plan.event.id, culturalFest.event.id);
    assert.deepEqual(storedTitles(st), { wedding: royalWedding.event.title, birthday: null, community: null });
  });
});

// ---------------------------------------------------------------- B. template API
describe("GET /api/event-templates", () => {
  test("200 with the public summary of every template", async () => {
    const r = handleEventTemplates();
    assert.equal(r.status, 200);
    const b = r.body as TemplatesResponseBody;
    assert.deepEqual(b.templates.map(t => t.id), TEMPLATES.map(t => t.id));
    for (const t of b.templates) assert.ok(PublicTemplate.safeParse(t).success, t.id);
    assert.deepEqual(b.templates[0], {
      id: "wedding", name: "Royal Wedding", label: "Royal Wedding — ₹25L", description: TEMPLATES[0]!.description, eventType: "wedding",
      city: "Hyderabad", currency: "INR", totalBudgetPaise: 25_00_000_00, startDate: "2027-03-10", endDate: "2027-03-15", subEventCount: 5,
    });
    const res = toResponse(r);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(res.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await res.json(), b);
  });

  test("returns no guest, vendor, contact, invite or secret data", () => {
    process.env.GEMINI_API_KEY = "test-secret-key-should-never-leak-123";
    try {
      const json = JSON.stringify(handleEventTemplates().body);
      for (const t of TEMPLATES) {
        for (const g of t.seed.guests) assert.ok(!json.includes(g.name), g.name);
        for (const v of t.seed.vendors) { assert.ok(!json.includes(v.name), v.name); if (v.phone) assert.ok(!json.includes(v.phone)); }
        for (const h of t.seed.households) if (h.inviteCode) assert.ok(!json.includes(h.inviteCode));
      }
      for (const key of ["guests", "households", "vendors", "budgetItems", "tasks", "seed", "layout", "phone", "email", "inviteCode", "token"]) assert.ok(!json.includes(`"${key}"`), key);
      assert.ok(!json.includes("test-secret-key"));
    } finally { delete process.env.GEMINI_API_KEY; }
  });

  test("an invalid registry is a generic 500 with no internals", () => {
    const d = raw(); d[0]!.eventType = "funeral";
    const r = handleEventTemplates(d);
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: "templates_unavailable", message: "Event templates are temporarily unavailable" });
    assert.equal(toResponse(r).headers.get("cache-control"), "no-store, max-age=0");
  });

  test("the response cannot be used to mutate the registry", () => {
    const b = handleEventTemplates(raw()).body as TemplatesResponseBody;
    b.templates[0]!.name = "Hacked";
    assert.equal(TEMPLATES[0]!.name, "Royal Wedding");
    assert.equal(toPublicTemplate(TEMPLATES[0]!).name, "Royal Wedding");
  });
});

// ---------------------------------------------------------------- C. option lists
describe("planner option lists", () => {
  test("values come from the schema enums, in a stable order", () => {
    assert.deepEqual(RSVP_STATUS_OPTIONS.map(o => o.value), RsvpStatus.options);
    assert.deepEqual(SPONSOR_TIER_OPTIONS.map(o => o.value), SponsorTier.options);
    assert.deepEqual(SPONSOR_STATUS_OPTIONS.map(o => o.value), SponsorStatus.options);
    assert.deepEqual(PERMIT_STATUS_OPTIONS.map(o => o.value), PermitStatus.options);
    assert.deepEqual([...TASK_STATUS_OPTIONS.map(o => o.value)].sort(), [...TaskStatus.options].sort());
    assert.deepEqual(TASK_COLUMN_ORDER, ["todo", "doing", "blocked", "done"]);
  });

  test("persisted values are unchanged (renaming one would orphan saved plans)", () => {
    assert.deepEqual(RsvpStatus.options, ["invited", "yes", "no", "maybe"]);
    assert.deepEqual(TaskStatus.options, ["todo", "doing", "done", "blocked"]);
    assert.deepEqual(SponsorTier.options, ["title", "gold", "silver", "in_kind"]);
    assert.deepEqual(SponsorStatus.options, ["prospect", "pitched", "committed", "paid", "declined"]);
    assert.deepEqual(PermitStatus.options, ["not_started", "applied", "approved", "rejected"]);
    assert.deepEqual(DIET_OPTIONS.map(o => o.value), ["veg", "non-veg", "jain", "vegan", "no-onion-garlic", "gluten-free"]);
    assert.deepEqual([...VOLUNTEER_SHIFTS], ["Morning", "Afternoon", "Evening", "Setup crew", "Cleanup crew"]);
  });

  test("labels match what the UI showed before", () => {
    assert.equal(RSVP_LABELS.invited, "pending");
    assert.equal(labelOf(SPONSOR_TIER_OPTIONS, "in_kind"), "in-kind");
    assert.equal(labelOf(PERMIT_STATUS_OPTIONS, "not_started"), "not started");
    assert.deepEqual(TASK_STATUS_OPTIONS.map(o => o.label), ["To do", "Doing", "Blocked", "Done"]);
    assert.equal(labelOf(DIET_OPTIONS, "halal"), "halal", "free-text / legacy values fall back to themselves");
  });

  test("every list has unique values and is frozen", () => {
    for (const list of [RSVP_STATUS_OPTIONS, DIET_OPTIONS, TASK_STATUS_OPTIONS, SPONSOR_TIER_OPTIONS, SPONSOR_STATUS_OPTIONS, PERMIT_STATUS_OPTIONS]) {
      assert.equal(new Set(list.map(o => o.value)).size, list.length);
      assert.ok(Object.isFrozen(list) && list.every(o => Object.isFrozen(o)));
    }
  });

  test("status domains stay separate: RSVP, task, sponsor and permit values don't overlap where they mean different things", () => {
    assert.ok(!SponsorStatus.options.includes("todo" as never));
    assert.ok(!PermitStatus.options.includes("committed" as never));
    assert.ok(GUEST_RSVP_ANSWERS.every(a => RsvpStatus.options.includes(a)));
    assert.ok(!(GUEST_RSVP_ANSWERS as readonly string[]).includes("invited"), "a guest can't answer 'invited'");
    for (const to of Object.values(TASK_NEXT_STATUS)) assert.ok(TaskStatus.options.includes(to));
  });

  test("legacy and free-text diets still load and still save through the reducer", () => {
    const plan = AgentState.parse({ ...royalWedding, guests: royalWedding.guests.map((g, i) => (i === 0 ? { ...g, diet: ["halal", "nut allergy"] } : g)) });
    assert.deepEqual(plan.guests[0]!.diet, ["halal", "nut allergy"]);
    // v8 Part 1c: diets are organizer-side now (guests pick a meal on the open RSVP form).
    const r = applyBatch(plan, { summary: "d", commands: [{ op: "set_guest_diet", guestId: plan.guests[0]!.id, diet: ["halal", "jain"] }] }, { source: "ui" });
    assert.ok(r.ok);
  });

  test("the guest projection offers exactly the schema's sponsor tiers", async () => {
    const { toGuestView } = await import("../guest-view");
    assert.deepEqual(toGuestView(culturalFest, "e", 1, null).community?.sponsorTiers, SponsorTier.options);
  });
});

// ---------------------------------------------------------------- D. demo prompts
describe("demo prompts", () => {
  test("the configured prompts, ids unique, in the original order", () => {
    assert.equal(new Set(DEMO_PROMPTS.map(p => p.id)).size, DEMO_PROMPTS.length);
    for (const p of DEMO_PROMPTS) assert.ok(DemoPrompt.safeParse(p).success, p.id);
    assert.deepEqual(ids(promptsFor("organizer", "wedding"), p => p.text), [
      "Cut ₹20k from decor and move the Haldi to Friday", "Cut ₹1.5L from decor", "Move the Haldi to Monday", "Our budget dropped by ₹50,000 and the event is 2 weeks earlier",
      "Which vendor deposits are overdue and what tasks are urgent?", "Give me ideas for decor, food and return gifts", "Rebalance to my total",
      "Switch to a 30th Retro Arcade Birthday for ₹1.5L", "Draft a WhatsApp to negotiate the photographer's quote",
    ]);
    // Prompts that name the Haldi exist only for weddings (a message never switches templates to make one fit).
    for (const t of ["birthday", "community"] as const) assert.ok(promptsFor("organizer", t).every(p => !/haldi/i.test(p.text)), t);
    assert.equal(promptsFor("organizer", "birthday").at(-1)!.text, "What's overdue and which wishes are unclaimed?");
    assert.equal(promptsFor("organizer", "community").at(-1)!.text, "Draft a sponsor pitch for SpiceRoute Foods");
    assert.equal(promptsFor("guest", "wedding").length, 4);
    assert.equal(promptsFor("guest", "birthday").length, 3);
    assert.equal(promptsFor("guest", "community").length, 3);
    assert.ok(promptsFor("guest", "wedding").every(p => p.hint === "Guests can ask this"));
    // Hints are user language, not engine jargon.
    for (const p of DEMO_PROMPTS) assert.doesNotMatch(p.hint, /slack|invariant|ext polymorphism|cold-start|Tier \d|guest-safe|resolve/i, p.id);
  });

  test("a prompt is text only: extra keys such as commands or autoApprove are rejected", () => {
    const base = { id: "x", text: "hi", hint: "h", audience: "organizer" };
    assert.ok(DemoPrompt.safeParse(base).success);
    assert.equal(DemoPrompt.safeParse({ ...base, commands: [{ op: "adjust_budget" }] }).success, false);
    assert.equal(DemoPrompt.safeParse({ ...base, autoApprove: true }).success, false);
    assert.equal(DemoPrompt.safeParse({ ...base, audience: "admin" }).success, false);
    assert.equal(DemoPromptList.safeParse([base, base]).success, false);
  });

  test("organizer prompts go through the reducer and the trust policy; nothing is pre-approved", () => {
    for (const t of TEMPLATES) for (const p of promptsFor("organizer", t.eventType)) {
      const out = runOfflineAgent(t.seed, p.text, TODAY);
      for (const a of out.actions) if (a.kind === "batch") {
        const r = applyBatch(t.seed, a.batch);
        assert.ok(r.ok, `${p.id}: offline batch must be valid`);
        assert.ok(a.tier >= batchTier(Batch.parse(a.batch).commands), `${p.id}: tier comes from the trust policy, never lower`);
      }
    }
    const cut = runOfflineAgent(royalWedding, promptsFor("organizer", "wedding")[0]!.text, TODAY).actions.find(a => a.kind === "batch");
    assert.ok(cut && cut.kind === "batch" && cut.tier >= 1, "the flagship cut + move still needs approval");
  });

  test("guest prompts can only produce guest-allowed operations", () => {
    for (const t of TEMPLATES) for (const p of promptsFor("guest", t.eventType)) {
      const out = runOfflineGuestAgent(t.seed, p.text, TODAY, t.seed.guests[0]?.id ?? null);
      for (const a of out.actions) if (a.kind === "batch") {
        for (const c of a.batch.commands) assert.ok(GUEST_ALLOWED_OPS.has(c.op), `${p.id}: ${c.op}`);
        assert.ok(applyBatch(t.seed, a.batch, { role: "guest" }).ok, p.id);
      }
    }
    const cut = runOfflineGuestAgent(royalWedding, "Cut ₹20k from decor", TODAY, "g1");
    assert.equal(cut.actions.filter(a => a.kind === "batch").length, 0);
  });

  test("demo mode answers every prompt without Gemini credentials", async () => {
    for (const p of promptsFor("organizer", "wedding")) {
      const r = await handleChat({ messages: [{ role: "user", text: p.text }], state: royalWedding, today: TODAY }, { apiKey: null });
      assert.equal(r.status, 200, p.id);
      assert.equal((r.body as { mode: string }).mode, "offline", p.id);
    }
  });
});

// ---------------------------------------------------------------- E. generic layout
const noop = (() => ({ ok: false, reason: "test", state: royalWedding })) as never;
const hl = { ids: new Set<string>(), key: 0 };
const organizerHtml = (id: TemplateId, plan = instantiateTemplate(id)) =>
  renderToStaticMarkup(createElement(ArchetypeCard, { template: getTemplate(id)!, plan, today: TODAY, commit: noop, highlight: hl, onAsk: () => {} }));
const guestHtml = (id: TemplateId, plan = instantiateTemplate(id)) =>
  renderToStaticMarkup(createElement(GuestMicrosite, { template: getTemplate(id)!, plan, today: TODAY, commit: noop, highlight: hl, actingEntryId: null, setActingEntryId: () => {} }));

describe("generic event-type layout", () => {
  test("every section id a template can use has a component and declares its event types", () => {
    for (const [id, req] of Object.entries({ ...ORGANIZER_SECTIONS, ...GUEST_SECTIONS }))
      assert.ok(req === "any" || (req as readonly string[]).every(t => EventType.options.includes(t as never)), id);
  });

  test("wedding: couple profile, diet counts and gift registry, with a link to manage RSVPs on Guests; nothing from other event types", () => {
    const h = organizerHtml("wedding");
    assert.match(h, /Wedding · Couple &amp; Traditions/);
    for (const s of ["Arjun &amp; Meera", "RSVP deadline", "Dietary counts · Muhurtham (yes)", "Gift registry"]) assert.ok(h.includes(s), s);
    // v8 Part 1f: no RSVP matrix on the Event page; one link to the Guests page instead.
    for (const s of ["RSVP Matrix", "Household · guest", "RSVP totals", "Gift wishlist", "Sponsor pipeline", "Municipal permits"]) assert.ok(!h.includes(s), s);
    assert.match(h, /<a [^>]*href="\/guests"[^>]*>Manage RSVPs on Guests<\/a>/);
    assert.equal(h.split("Manage RSVPs on Guests").length - 1, 1, "one link");
    assert.match(h, /@3xl:grid-cols-2/);
    const layout = getTemplate("wedding")!.layout;
    assert.deepEqual(layout.columns, [["couple-profile", "diet-summary"], ["wishlist-manager"]]);
    assert.equal(layout.arrangement, "two-up");
  });

  test("v8 Part 1f: rsvp-matrix is no longer a section id and no template lists it", () => {
    assert.ok(!Object.keys(ORGANIZER_SECTIONS).includes("rsvp-matrix"));
    for (const t of TEMPLATES) assert.ok(!(t.layout.columns as readonly (readonly string[])[]).flat().includes("rsvp-matrix"), t.id);
  });

  test("birthday: heading from tokens, wishlist manager and activity run-sheet", () => {
    const h = organizerHtml("birthday");
    assert.ok(h.includes("Birthday · Rohan turns 30 · Retro arcade · 80s neon"));
    for (const s of ["Gift wishlist", "Party activity run-sheet", "Total run time"]) assert.ok(h.includes(s), s);
    for (const s of ["Household · guest", "Sponsor pipeline"]) assert.ok(!h.includes(s), s);
  });

  test("community: sponsor pipeline with progress semantics and permits", () => {
    const h = organizerHtml("community");
    for (const s of ["Community · Sponsors &amp; Permits", "Sponsor pipeline", "Municipal permits", 'role="progressbar"', "in-kind", "not started"]) assert.ok(h.includes(s), s);
  });

  test("a section whose data is missing renders nothing instead of failing", () => {
    // Force a mismatched template onto a plan (the registry forbids this; presentationFor never does it).
    const h = renderToStaticMarkup(createElement(ArchetypeCard, { template: getTemplate("community")!, plan: royalWedding, today: TODAY, commit: noop, highlight: hl, onAsk: () => {} }));
    assert.ok(!h.includes("Sponsor pipeline") && !h.includes("Municipal permits"));
    const empty = AgentState.parse({ ...royalWedding, guests: [], households: [] });
    const w = organizerHtml("wedding", empty);
    assert.ok(w.includes("No confirmations yet.") && w.includes("Manage RSVPs on Guests"));
  });

  test("guest microsite: kicker, tagline and cards come from the template; no organizer data", () => {
    const w = guestHtml("wedding"), b = guestHtml("birthday"), c = guestHtml("community");
    assert.ok(w.includes("You&#x27;re invited to celebrate") && w.includes("Arjun &amp; Meera") && w.includes("Your RSVP"));
    assert.ok(!w.includes("Gift wishlist") && !w.includes("Get involved"));
    assert.ok(b.includes("Party time") && b.includes("Gift wishlist") && b.includes("Rohan turns 30"));
    assert.ok(c.includes("Join the community") && c.includes("Get involved") && c.includes("Hosted by"));
    for (const h of [w, b, c]) for (const s of ["Sponsor pipeline", "Municipal permits", "Household · guest", "plannedPaise", "₹"]) assert.ok(!h.includes(s), s);
  });

  test("the guest view never shows the sub-event visibility controls or vendor phones", () => {
    const h = guestHtml("wedding");
    for (const v of royalWedding.vendors) if (v.phone) assert.ok(!h.includes(v.phone));
  });
});

// ---------------------------------------------------------------- F. KPIs
describe("KPI definitions and values", () => {
  test("definitions validate, every id has exactly one calculation, money is organizer-only", () => {
    assert.ok(KpiDefinitionList.safeParse(KPI_DEFINITIONS).success);
    assert.deepEqual(Object.keys(KPI_CALCULATORS).sort(), KPI_DEFINITIONS.map(k => k.id).sort());
    assert.equal(KpiDefinitionList.safeParse([{ id: "paid", label: "Paid", description: "x", audiences: ["guest"] }]).success, false);
    assert.equal(KpiDefinitionList.safeParse([{ id: "paid", label: "Paid", description: "x", audiences: ["organizer"], formula: "1+1" }]).success, false);
  });

  test("tiles, order and test ids are unchanged", () => {
    assert.deepEqual(kpisFor("organizer", "wedding").map(k => kpiTestId(k.label)),
      ["kpi-total-budget", "kpi-planned", "kpi-committed", "kpi-paid", "kpi-days-to-event", "kpi-rsvp"]);
    assert.deepEqual(kpisFor("guest", "birthday").map(k => k.label), ["Days to event", "Events", "RSVP"]);
    assert.ok(kpisFor("guest", "community").every(k => !["total-budget", "planned", "committed", "paid"].includes(k.id)));
  });

  test("wedding values match the hand-computed figures", () => {
    const c = kpiContext(royalWedding, TODAY);
    assert.deepEqual(kpiValue("total-budget", c), { value: "₹25,00,000" });
    const planned = kpiValue("planned", c);
    assert.match(planned.value, /^₹/);
    assert.equal(planned.tone, c.planned > c.total ? "danger" : "default");
    assert.equal(kpiValue("committed", c).sub, `${Math.round((c.committed / c.total) * 100)}% of budget`);
    assert.equal(kpiValue("paid", c).value, "₹1,50,000");
    assert.equal(kpiValue("days-to-event", c).value, "144 days");
    assert.equal(kpiValue("days-to-event", c).sub, "Muhurtham · 2027-03-14");
    assert.match(kpiValue("rsvp-summary", c).value, /^\d+ \/ \d+ yes$/);
    assert.equal(kpiValue("itinerary", c).value, "5 on the itinerary");
  });

  test("empty, zero, past and missing values are safe", () => {
    const blank = AgentState.parse({ event: { id: "e", title: "t", eventType: "birthday", totalBudgetPaise: 0, guestCount: 12, startDate: "2026-01-01", endDate: "2026-01-01", ext: { type: "birthday" } } });
    const c = kpiContext(blank, TODAY);
    assert.deepEqual(kpiValue("committed", c), { value: "₹0", sub: "0% of budget" });
    assert.deepEqual(kpiValue("days-to-event", c), { value: "—", sub: undefined });
    assert.deepEqual(kpiValue("rsvp-summary", c), { value: "12 expected", sub: "no guest list yet" });
    assert.deepEqual(kpiValue("rsvp-attending", c), { value: "open" });
    assert.equal(kpiValue("paid", c).sub, "₹0 still owed");
    assert.equal(kpiValue("days-to-event", kpiContext(royalWedding, "2027-03-20")).value, "6d ago");
  });

  test("large budgets keep Indian grouping and over-plan is flagged", () => {
    const big = AgentState.parse({ ...royalWedding, event: { ...royalWedding.event, totalBudgetPaise: 12_34_56_789_00 } });
    assert.equal(kpiValue("total-budget", kpiContext(big, TODAY)).value, "₹12,34,56,789");
    const tight = AgentState.parse({ ...royalWedding, event: { ...royalWedding.event, totalBudgetPaise: 1_00_000_00 } });
    const p = kpiValue("planned", kpiContext(tight, TODAY));
    assert.equal(p.tone, "danger");
    assert.match(p.sub!, /^over by ₹/);
  });
});
