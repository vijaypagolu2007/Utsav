// v5: user-chosen budgets and first-run setup, budget line add/remove, event basics, rebalance, personalised ideas,
// and the removed "haldi" template jump. Gemini is always mocked; no network, no real key.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
process.env.UTSAV_SILENT_LOGS = "1";
import { royalWedding, arcadeBirthday, culturalFest } from "../presets";
import { AgentState, type Idea } from "../schema";
import { AgentBatch, applyBatch, Batch, checkInvariants, DIRECT_EDIT_OPS, plannedTotal, taskDueDate, type CommandInput } from "../commands";
import { batchTier, commandTier } from "../trust";
import { computePlanDiff } from "../diff";
import { initializeEventPlan } from "../blueprint";
import { blueprintFromSetup, constrainBudgetLines, defaultSetupCategories, resolveSetupBudget, STYLES, suggestedCategories, suggestionHints, SetupInput, type SetupInputRaw } from "../setup";
import { categoryHeadroom, demoIdeas, focusCapPaise, kindsIn, prepareIdeas } from "../ideas";
import { executeAgentTool } from "../agent";
import { blueprintFromPrompt, runOfflineAgent, runOfflineGuestAgent } from "../offline";
import { functionDeclarations, SYSTEM_PROMPT } from "../gemini-tools";
import { handleChat, type ChatResponseBody } from "../server/chat-handler";
import { handleCreatePlan, type PlanResponseBody } from "../server/plan-handler";
import type { GenerateFn, GenerateResult } from "../server/gemini-client";
import { toGuestView } from "../guest-view";
import { pageForPath, pagesForDiff, PAGES } from "../routes";
import { parseStore, serializeStore, defaultStore } from "../persistence";
import { plannerSource } from "./planner-source";

const TODAY = "2026-10-23";
const run = (st: AgentState, commands: CommandInput[], opts: Parameters<typeof applyBatch>[2] = {}) => applyBatch(st, { summary: "t", commands }, opts);
const ok = (r: ReturnType<typeof applyBatch>) => { assert.ok(r.ok, r.ok ? "" : r.reason); return r.ok ? r.state : (null as never); };
function scripted(...steps: (GenerateResult | Error)[]): GenerateFn & { calls: number; sent: unknown[] } {
  const f = (async (p: unknown) => { f.calls++; f.sent.push(p); const s = steps.shift() ?? { text: "done" }; if (s instanceof Error) throw s; return s; }) as unknown as GenerateFn & { calls: number; sent: unknown[] };
  f.calls = 0; f.sent = [];
  return f;
}
const KEY = "test-key-not-real";

// ---------------------------------------------------------------- add / remove budget lines
describe("add_budget_item", () => {
  test("adds a line (and a new category) with an id from its label; Tier 0 below ₹25,000, Tier 1 at or above", () => {
    const st = ok(run(arcadeBirthday, [{ op: "add_budget_item", category: "attire", label: "80s costumes", plannedPaise: 8_000_00 }]));
    const b = st.budgetItems.find(x => x.label === "80s costumes")!;
    assert.deepEqual([b.category, b.plannedPaise, b.committedPaise, b.locked, b.subEventId], ["attire", 8_000_00, 0, false, null]);
    assert.match(b.id, /^bi-80s-costumes/);
    assert.equal(commandTier({ op: "add_budget_item", category: "attire", label: "x", plannedPaise: 24_999_99 }), 0);
    assert.equal(commandTier({ op: "add_budget_item", category: "attire", label: "x", plannedPaise: 25_000_00 }), 1);
  });
  test("already booked → committed at that amount and locked; sub-event refs resolve; duplicates are refused", () => {
    const st = ok(run(royalWedding, [{ op: "add_budget_item", category: "beauty", label: "Mehendi artist", plannedPaise: 15_000_00, subEvent: "mehendi", alreadyBooked: true }]));
    const b = st.budgetItems.find(x => x.label === "Mehendi artist")!;
    assert.deepEqual([b.committedPaise, b.locked, b.subEventId], [15_000_00, true, "s2"]);
    const dup = run(st, [{ op: "add_budget_item", category: "beauty", label: "mehendi ARTIST", plannedPaise: 1 }]);
    assert.ok(!dup.ok && /already a beauty line/.test(dup.reason));
    assert.ok(!run(royalWedding, [{ op: "add_budget_item", category: "beauty", label: "x", plannedPaise: 1, subEvent: "nope" }]).ok);
  });
  test("Zod rejects empty names, negative and fractional amounts", () => {
    for (const bad of [{ label: " ", plannedPaise: 1 }, { label: "x", plannedPaise: -1 }, { label: "x", plannedPaise: 1.5 }])
      assert.equal(run(royalWedding, [{ op: "add_budget_item", category: "misc", ...bad } as CommandInput]).ok, false);
  });
  test("going over the total is allowed but flagged in the log", () => {
    const r = run(royalWedding, [{ op: "add_budget_item", category: "misc", label: "Fireworks", plannedPaise: 5_00_000_00 }]);
    assert.ok(r.ok && r.log.some(l => /Over budget/.test(l)));
  });
});

describe("remove_budget_item", () => {
  test("removes an uncommitted line with no payments (Tier 1) and undo is just the previous state", () => {
    const st = ok(run(royalWedding, [{ op: "remove_budget_item", budgetItemId: "b18" }]));
    assert.ok(!st.budgetItems.some(b => b.id === "b18"));
    assert.equal(commandTier({ op: "remove_budget_item", budgetItemId: "b18" }), 1);
    const d = computePlanDiff(royalWedding, st);
    assert.ok(d.rows.some(r => r.kind === "budget_removed" && r.id === "b18" && r.deltaPaise === -40_000_00));
    assert.deepEqual(pagesForDiff(d.rows, "overview").map(p => p.id), ["budget"]);
  });
  test("refused when anything is committed or a payment exists", () => {
    const committed = run(royalWedding, [{ op: "remove_budget_item", budgetItemId: "b1" }]);
    assert.ok(!committed.ok && /committed/.test(committed.reason));
    const withPayment = { ...royalWedding, budgetItems: royalWedding.budgetItems.map(b => b.id === "b18" ? { ...b, payments: [{ id: "px", amountPaise: 100, kind: "deposit" as const, dueDate: "2026-11-01", paidDate: null, refundable: false }] } : b) };
    const r = run(withPayment, [{ op: "remove_budget_item", budgetItemId: "b18" }]);
    assert.ok(!r.ok && /payments/.test(r.reason));
    assert.ok(!run(royalWedding, [{ op: "remove_budget_item", budgetItemId: "nope" }]).ok);
  });
});

// ---------------------------------------------------------------- set_event_basics
describe("set_event_basics", () => {
  test("total, guests and city; total can't go below committed; always Tier 1", () => {
    const st = ok(run(royalWedding, [{ op: "set_event_basics", totalBudgetPaise: 30_00_000_00, guestCount: 350, city: "Secunderabad" }]));
    assert.deepEqual([st.event.totalBudgetPaise, st.event.guestCount, st.event.city], [30_00_000_00, 350, "Secunderabad"]);
    const committed = royalWedding.budgetItems.reduce((a, b) => a + b.committedPaise, 0);
    const low = run(royalWedding, [{ op: "set_event_basics", totalBudgetPaise: committed - 1 }]);
    assert.ok(!low.ok && /already committed/.test(low.reason));
    assert.ok(run(royalWedding, [{ op: "set_event_basics", totalBudgetPaise: committed }]).ok);
    assert.equal(commandTier({ op: "set_event_basics", guestCount: 1 }), 1);
    assert.ok(!run(royalWedding, [{ op: "set_event_basics" }]).ok, "nothing to change");
  });
  test("a new start date shifts every sub-event by whole days in code; tasks follow; permits shift too", () => {
    const st = ok(run(royalWedding, [{ op: "set_event_basics", startDate: "2027-03-18" }]));
    const shift = (new Date("2027-03-18T00:00:00Z").getTime() - new Date(royalWedding.event.startDate + "T00:00:00Z").getTime()) / 86_400_000;
    assert.equal(st.event.startDate, "2027-03-18");
    for (const s of royalWedding.subEvents) {
      const moved = st.subEvents.find(x => x.id === s.id)!;
      const d = new Date(moved.date + "T00:00:00Z").getTime() - new Date(s.date + "T00:00:00Z").getTime();
      assert.equal(d / 86_400_000, shift, s.name);
      assert.equal(moved.startMin, s.startMin);
    }
    assert.deepEqual(checkInvariants(st), []);
    const t = royalWedding.tasks[0]!;
    assert.notEqual(taskDueDate(st, st.tasks[0]!), taskDueDate(royalWedding, t));
    const fest = ok(run(culturalFest, [{ op: "set_event_basics", startDate: "2026-11-27" }]));
    const p0 = culturalFest.event.ext.type === "community" ? culturalFest.event.ext.permits[0]! : null;
    const p1 = fest.event.ext.type === "community" ? fest.event.ext.permits[0]! : null;
    assert.ok(p0 && p1 && p0.applyBy && p1.applyBy && p1.applyBy > p0.applyBy);
  });
  test("sanity limits: impossible dates, windows over 60 days, an end before a sub-event", () => {
    assert.ok(!run(royalWedding, [{ op: "set_event_basics", startDate: "2027-02-30" }]).ok);
    assert.ok(!run(royalWedding, [{ op: "set_event_basics", startDate: "1999-01-01" }]).ok);
    assert.ok(!run(royalWedding, [{ op: "set_event_basics", endDate: "2027-07-30" }]).ok);
    const cut = run(royalWedding, [{ op: "set_event_basics", endDate: "2027-03-14" }]);
    assert.ok(!cut.ok && /outside/.test(cut.reason));
    assert.ok(!run(royalWedding, [{ op: "set_event_basics", guestCount: 100_001 }]).ok);
  });
});

// ---------------------------------------------------------------- rebalance_budget
describe("rebalance_budget", () => {
  const head = (st: AgentState) => st.event.totalBudgetPaise - plannedTotal(st);
  test("positive headroom is spread over unlocked lines in proportion; planned equals the total to the paisa", () => {
    const base = ok(run(royalWedding, [{ op: "set_event_basics", totalBudgetPaise: royalWedding.event.totalBudgetPaise + 1_23_457_89 }]));
    const h = head(base);
    assert.ok(h > 0);
    const st = ok(run(base, [{ op: "rebalance_budget", expectedHeadroomPaise: h }]));
    assert.equal(plannedTotal(st), st.event.totalBudgetPaise);
    const deltas = st.budgetItems.map(b => b.plannedPaise - base.budgetItems.find(x => x.id === b.id)!.plannedPaise);
    assert.equal(deltas.filter(d => d % 100 !== 0).length <= 89, true, "odd paise land on at most 89 lines");
    for (const b of base.budgetItems.filter(x => x.locked)) assert.equal(st.budgetItems.find(x => x.id === b.id)!.plannedPaise, b.plannedPaise, `${b.label} is locked`);
    assert.equal(commandTier({ op: "rebalance_budget", expectedHeadroomPaise: h }), 1);
  });
  test("over budget: trims unlocked, uncommitted money; refuses a stale preview and too-small slack", () => {
    const over = ok(run(royalWedding, [{ op: "add_budget_item", category: "misc", label: "Fireworks", plannedPaise: 2_00_000_00 }]));
    const h = head(over);
    if (h < 0) {
      const st = ok(run(over, [{ op: "rebalance_budget", expectedHeadroomPaise: h }]));
      assert.equal(plannedTotal(st), st.event.totalBudgetPaise);
      for (const b of st.budgetItems) assert.ok(b.plannedPaise >= b.committedPaise);
    }
    const stale = run(over, [{ op: "rebalance_budget", expectedHeadroomPaise: h + 1 }]);
    assert.ok(!stale.ok && /changed since this preview/.test(stale.reason));
    const allLocked = { ...royalWedding, budgetItems: royalWedding.budgetItems.map(b => ({ ...b, locked: true })) };
    assert.ok(!run(allLocked, [{ op: "rebalance_budget", expectedHeadroomPaise: head(allLocked) }]).ok || head(allLocked) === 0);
  });
  test("zero headroom is a no-op", () => {
    const st = ok(run(royalWedding, [{ op: "rebalance_budget", expectedHeadroomPaise: head(royalWedding) }]));
    if (head(royalWedding) === 0) assert.equal(st, royalWedding);
  });
});

// ---------------------------------------------------------------- permissions
describe("permissions for the new ops", () => {
  const ideaState = () => ok(run(royalWedding, [{ op: "add_ideas", ideas: [{ kind: "decor", title: "Toranam", source: "demo", estLowPaise: 30_000_00, estHighPaise: 50_000_00, category: "decor" }] }]));
  test("guests can run none of them", () => {
    const st = ideaState();
    const cmds: CommandInput[] = [
      { op: "add_budget_item", category: "misc", label: "x", plannedPaise: 1 }, { op: "remove_budget_item", budgetItemId: "b18" },
      { op: "set_event_basics", guestCount: 1 }, { op: "rebalance_budget", expectedHeadroomPaise: 0 },
      { op: "add_ideas", ideas: [{ kind: "menu", title: "x", source: "demo" }] }, { op: "save_idea", ideaId: st.ideas[0]!.id },
      { op: "dismiss_idea", ideaId: st.ideas[0]!.id }, { op: "adopt_idea", ideaId: st.ideas[0]!.id },
    ];
    for (const c of cmds) for (const source of ["agent", "ui"] as const) assert.equal(applyBatch(st, { summary: "g", commands: [c] }, { role: "guest", source }).ok, false, `${c.op} as guest via ${source}`);
  });
  test("save/dismiss are UI-only; the AI may propose add/remove/basics/rebalance/adopt (declared to Gemini), not add_ideas", () => {
    const st = ideaState();
    assert.ok(DIRECT_EDIT_OPS.has("save_idea") && DIRECT_EDIT_OPS.has("dismiss_idea"));
    assert.equal(run(st, [{ op: "save_idea", ideaId: st.ideas[0]!.id }]).ok, false);
    assert.ok(run(st, [{ op: "save_idea", ideaId: st.ideas[0]!.id }], { source: "ui" }).ok);
    const declared = JSON.stringify(functionDeclarations[0].parametersJsonSchema);
    for (const op of ["add_budget_item", "remove_budget_item", "set_event_basics", "rebalance_budget", "adopt_idea"]) assert.ok(declared.includes(`"${op}"`), op);
    for (const op of ["add_ideas", "save_idea", "dismiss_idea"]) assert.ok(!declared.includes(`"${op}"`), op);
    assert.ok(AgentBatch.safeParse({ summary: "x", commands: [{ op: "add_ideas", ideas: [] }] }).success === false);
  });
});

// ---------------------------------------------------------------- ideas
describe("ideas: schema, prepare, ops", () => {
  test("legacy plans without ideas or notes still parse with defaults", () => {
    const legacy = JSON.parse(JSON.stringify(royalWedding)) as Record<string, unknown>;
    delete legacy.ideas;
    delete (legacy.event as Record<string, unknown>).notes;
    const p = AgentState.parse(legacy);
    assert.deepEqual(p.ideas, []);
    assert.equal(p.event.notes, "");
    const store = parseStore(serializeStore(defaultStore()).replace(/"ideas":\[\],?/g, ""));
    assert.ok(store.byType[store.active]);
  });
  test("prepareIdeas converts rupees to paise, orders the range, maps a default category and flags over-headroom ideas", () => {
    const r = prepareIdeas(arcadeBirthday, { ideas: [
      { kind: "decor", title: "Neon wall", description: "d", estLowRupees: 9_000, estHighRupees: 4_000 },
      { kind: "music", title: "Live band", estLowRupees: 1_00_000, budgetCategory: "music" },
      { kind: "invite_text", title: "Invite copy" },
    ] }, "gemini");
    assert.ok(r.ok);
    if (!r.ok) return;
    const [neon, band, inv] = r.value.drafts;
    assert.deepEqual([neon!.estLowPaise, neon!.estHighPaise, neon!.category], [4_000_00, 9_000_00, "decor"]);
    assert.equal(band!.overBudget, true);
    assert.equal(inv!.estLowPaise, null);
    assert.equal(r.value.flagged, 1);
  });
  test("drops ideas costing more than the whole budget, duplicates and malformed input", () => {
    const r = prepareIdeas(arcadeBirthday, { ideas: [{ kind: "theme", title: "Castle", estLowRupees: 10_00_000 }, { kind: "theme", title: "A" }, { kind: "theme", title: "a" }] }, "gemini");
    assert.ok(r.ok && r.value.drafts.length === 1 && r.value.dropped.length === 2);
    assert.equal(prepareIdeas(arcadeBirthday, { ideas: [{ kind: "spaceship", title: "x" }] }, "gemini").ok, false);
    assert.equal(prepareIdeas(arcadeBirthday, { ideas: [{ kind: "theme", title: "x", estLowRupees: -5 }] }, "gemini").ok, false);
    assert.equal(prepareIdeas(arcadeBirthday, { ideas: [{ kind: "theme", title: "x", estLowRupees: 1.5 }] }, "gemini").ok, false);
  });
  test("categoryHeadroom = uncommitted envelope + unallocated", () => {
    const h = categoryHeadroom(royalWedding);
    const free = Math.max(0, royalWedding.event.totalBudgetPaise - plannedTotal(royalWedding));
    const decor = royalWedding.budgetItems.filter(b => b.category === "decor").reduce((a, b) => a + Math.max(0, b.plannedPaise - b.committedPaise), 0);
    assert.equal(h.decor, decor + free);
    assert.equal(h.permits, free);
  });
  test("add_ideas, save, dismiss (Tier 0) and dedupe; adopt_idea creates a task and a budget line at the low estimate (Tier 1)", () => {
    const st = ok(run(royalWedding, [{ op: "add_ideas", ideas: [
      { kind: "decor", title: "Toranam", source: "demo", estLowPaise: 30_000_00, estHighPaise: 50_000_00, category: "decor" },
      { kind: "invite_text", title: "Invite copy", source: "demo" },
    ] }]));
    assert.equal(st.ideas.length, 2);
    assert.equal(run(st, [{ op: "add_ideas", ideas: [{ kind: "decor", title: "toranam", source: "demo" }] }]).ok && run(st, [{ op: "add_ideas", ideas: [{ kind: "decor", title: "toranam", source: "demo" }] }]).state, st);
    const [t, inv] = st.ideas as [Idea, Idea];
    assert.equal(batchTier(Batch.parse({ summary: "x", commands: [{ op: "save_idea", ideaId: t.id }, { op: "add_ideas", ideas: [{ kind: "menu", title: "y", source: "demo" }] }] }).commands), 0);
    const saved = ok(run(st, [{ op: "save_idea", ideaId: t.id }], { source: "ui" }));
    assert.equal(saved.ideas[0]!.status, "saved");
    const gone = ok(run(st, [{ op: "dismiss_idea", ideaId: inv.id }], { source: "ui" }));
    assert.equal(gone.ideas[1]!.status, "dismissed");
    const adopted = ok(run(st, [{ op: "adopt_idea", ideaId: t.id }]));
    const i = adopted.ideas[0]!;
    const line = adopted.budgetItems.find(b => b.id === i.adoptedBudgetItemId)!;
    const task = adopted.tasks.find(x => x.id === i.adoptedTaskId)!;
    assert.deepEqual([line.category, line.plannedPaise, line.label, i.status], ["decor", 30_000_00, "Toranam", "saved"]);
    assert.match(task.title, /^Arrange decor: Toranam/);
    assert.equal(task.subEventId, "s4");
    assert.equal(commandTier({ op: "adopt_idea", ideaId: t.id, addTask: true, addBudgetLine: true }), 1);
    assert.ok(!run(adopted, [{ op: "adopt_idea", ideaId: t.id }]).ok, "only once");
    const invOnly = ok(run(st, [{ op: "adopt_idea", ideaId: inv.id }]));
    assert.ok(invOnly.ideas[1]!.adoptedTaskId && !invOnly.ideas[1]!.adoptedBudgetItemId, "no cost → task only");
    assert.ok(!run(st, [{ op: "adopt_idea", ideaId: inv.id, addTask: false }]).ok, "nothing to add");
    const diff = computePlanDiff(st, adopted);
    assert.deepEqual(new Set(diff.rows.map(r => r.kind)), new Set(["budget_new", "task_new", "idea"]));
    assert.equal(diff.rows.find(r => r.kind === "idea")!.after, "added to plan");
    // Adopting an idea that was already saved still shows its row (the status alone doesn't change).
    const savedDiff = computePlanDiff(saved, ok(run(saved, [{ op: "adopt_idea", ideaId: t.id }])));
    assert.deepEqual(savedDiff.rows.filter(r => r.kind === "idea").map(r => [r.before, r.after]), [["saved", "added to plan"]]);
    // Undo: removing the adopted line clears the idea's link.
    const removed = ok(run(adopted, [{ op: "remove_budget_item", budgetItemId: line.id }]));
    assert.equal(removed.ideas[0]!.adoptedBudgetItemId, null);
  });
  test("the board keeps at most 200 ideas, dropping the oldest dismissed first", () => {
    const many = Array.from({ length: 199 }, (_, k) => ({ id: `i${k}`, kind: "theme" as const, title: `T${k}`, description: "", estLowPaise: null, estHighPaise: null, category: null, tags: [],
      status: (k === 0 ? "dismissed" : "new") as Idea["status"], source: "demo" as const, overBudget: false, adoptedTaskId: null, adoptedBudgetItemId: null, refinedFrom: null }));
    const st = { ...royalWedding, ideas: many };
    const out = ok(run(st, [{ op: "add_ideas", ideas: [{ kind: "menu", title: "new 1", source: "demo" }, { kind: "menu", title: "new 2", source: "demo" }] }]));
    assert.equal(out.ideas.length, 200);
    assert.ok(!out.ideas.some(i => i.id === "i0"));
  });
  test("guests never see ideas: not in the guest projection, not in the guest prompt", () => {
    const st = ok(run(royalWedding, [{ op: "add_ideas", ideas: [{ kind: "decor", title: "SECRET-IDEA-TITLE", source: "demo" }] }]));
    assert.ok(!JSON.stringify(toGuestView(st, "e", 1, null)).includes("SECRET-IDEA-TITLE"));
    const g = runOfflineGuestAgent(st, "What ideas do you have?", TODAY, "g1");
    assert.ok(!g.reply.includes("SECRET-IDEA-TITLE"));
    assert.ok(executeAgentTool("suggest_ideas", { ideas: [{ kind: "decor", title: "x" }] }, st, TODAY, "guest").response.ok === false);
  });
});

describe("ideas: offline bank and the suggest_ideas tool", () => {
  test("the bank is deterministic and personalised: kid party vs grown-up, Ganesh pandal, Christian wedding", () => {
    assert.deepEqual(demoIdeas(arcadeBirthday), demoIdeas(arcadeBirthday));
    const kidSetup: SetupInputRaw = { eventType: "birthday", style: "kid-home", city: "Pune", startDate: "2027-01-09", guestCount: 25, totalBudgetRupees: 40_000, turningAge: 7, categories: defaultSetupCategories("birthday", "kid-home") };
    const kid = initializeEventPlan(blueprintFromSetup(kidSetup), { setup: kidSetup });
    assert.ok(kid.ok);
    if (!kid.ok) return;
    const kidTitles = demoIdeas(kid.state, { count: 12 }).ideas.map(i => i.title).join(" | ");
    assert.match(kidTitles, /Magician|Treasure hunt|Balloon/);
    assert.doesNotMatch(kidTitles, /mocktail|DJ for three hours|Karaoke/);
    const ganeshSetup: SetupInputRaw = { eventType: "community", style: "ganesh", city: "Hyderabad", startDate: "2027-09-04", guestCount: 400, totalBudgetRupees: 3_00_000, categories: defaultSetupCategories("community", "ganesh") };
    const g = initializeEventPlan(blueprintFromSetup(ganeshSetup), { setup: ganeshSetup });
    assert.ok(g.ok && /shadu-maati|immersion|Modak/.test(demoIdeas(g.state, { count: 12 }).ideas.map(i => i.title).join(" ")));
    const xSetup: SetupInputRaw = { eventType: "wedding", style: "christian", city: "Kochi", startDate: "2027-01-16", guestCount: 200, totalBudgetRupees: 15_00_000, categories: defaultSetupCategories("wedding", "christian") };
    const x = initializeEventPlan(blueprintFromSetup(xSetup), { setup: xSetup });
    assert.ok(x.ok);
    if (x.ok) {
      const t = demoIdeas(x.state, { count: 20 }).ideas.map(i => i.title).join(" | ");
      assert.match(t, /church|Choir/i);
      assert.doesNotMatch(t, /Brass diya|Ungaram|mandap/i);
    }
  });
  test("focus filters: kind words, 'under ₹50k' caps the low estimate, per-guest costs scale with the head count", () => {
    assert.deepEqual(kindsIn("decor, food and return gifts"), ["decor", "menu", "return_gift"]);
    assert.equal(focusCapPaise("eco-friendly under ₹50k"), 50_000_00);
    assert.equal(focusCapPaise("below 1.5L"), 1_50_000_00);
    const cheap = demoIdeas(royalWedding, { focus: "under ₹50k", count: 20 });
    assert.ok(cheap.ideas.every(i => (i.estLowRupees ?? 0) <= 50_000));
    const lunch = demoIdeas(royalWedding, { focus: "banana leaf lunch", count: 20 }).ideas.find(i => /Banana-leaf/.test(i.title));
    assert.deepEqual([lunch?.estLowRupees, lunch?.estHighRupees], [450 * royalWedding.event.guestCount, 900 * royalWedding.event.guestCount]);
  });
  test("executeAgentTool(suggest_ideas) returns an ideas action whose add_ideas batch is valid Tier 0; offline chat routes idea asks", () => {
    const r = executeAgentTool("suggest_ideas", demoIdeas(royalWedding, { focus: "sangeet" }), royalWedding, TODAY, "organizer", "demo");
    const a = r.actions[0];
    assert.ok(a && a.kind === "ideas");
    if (!a || a.kind !== "ideas") return;
    assert.equal(batchTier(Batch.parse(a.batch).commands), 0);
    assert.ok(applyBatch(royalWedding, a.batch).ok);
    assert.equal(r.working.ideas.length, a.ideas.length);
    const chat = runOfflineAgent(royalWedding, "Give me sangeet ideas", TODAY);
    assert.ok(chat.actions.some(x => x.kind === "ideas"));
    assert.ok(chat.reply.split("\n").length > 3, "idea replies may run longer than three sentences");
  });
  test("the system prompt carries the idea context and relaxes the short-reply rule only for ideas and advice", () => {
    const p = SYSTEM_PROMPT({ ...royalWedding, event: { ...royalWedding.event, notes: "Telangana bonalu touch" } }, TODAY);
    assert.match(p, /IDEA CONTEXT/);
    assert.match(p, /Telangana bonalu touch/);
    assert.match(p, /MONEY LEFT per category/);
    assert.match(p, /For changes and facts, keep replies to 1–3 short sentences. For ideas and advice/);
    const init = functionDeclarations.find(f => f.name === "initialize_event_plan")!.description;
    assert.doesNotMatch(init, /sub-events Haldi, Mehendi, Sangeet, Muhurtham as main, Reception as post/);
    assert.match(init, /never a fixed list/);
  });
});

// ---------------------------------------------------------------- setup
const setupFor = (over: Partial<SetupInputRaw> = {}): SetupInputRaw => ({ eventType: "wedding", style: "telugu-hindu", city: "Hyderabad", startDate: "2027-02-10", endDate: "2027-02-12",
  guestCount: 250, totalBudgetRupees: 20_00_000, note: "Telugu, vegetarian lunch", categories: defaultSetupCategories("wedding", "telugu-hindu"), ...over });

describe("setup: user-chosen budget", () => {
  test("typed amounts are kept exactly, a booked line is committed and locked, blanks fill the remainder, the total matches to the paisa", () => {
    const cats = defaultSetupCategories("wedding", "telugu-hindu");
    cats.find(c => c.category === "venue")!.amountRupees = 4_12_345;
    Object.assign(cats.find(c => c.category === "photo_video")!, { amountRupees: 1_50_000, booked: true });
    cats.find(c => c.category === "decor")!.percentBps = 1250; // 12.5%
    cats.find(c => c.category === "logistics")!.include = false;
    const setup = setupFor({ categories: cats });
    const r = initializeEventPlan(blueprintFromSetup(setup), { setup });
    assert.ok(r.ok, r.ok ? "" : r.reason);
    if (!r.ok) return;
    const by = (c: string) => r.state.budgetItems.filter(b => b.category === c);
    assert.equal(by("venue").reduce((a, b) => a + b.plannedPaise, 0), 4_12_345_00);
    assert.equal(by("decor").reduce((a, b) => a + b.plannedPaise, 0), 2_50_000_00);
    const photo = by("photo_video");
    assert.deepEqual(photo.map(b => [b.plannedPaise, b.committedPaise, b.locked]), [[1_50_000_00, 1_50_000_00, true]]);
    assert.equal(by("logistics").length, 0);
    assert.equal(plannedTotal(r.state), 20_00_000_00);
    assert.deepEqual(checkInvariants(r.state), []);
    assert.equal(r.state.event.notes, "Telugu, vegetarian lunch");
    assert.deepEqual([r.state.event.startDate, r.state.event.endDate], ["2027-02-10", "2027-02-12"]);
  });
  test("with no blank categories the remainder stays unallocated; over-allocation and a booked line without an amount are refused", () => {
    const cats = defaultSetupCategories("birthday", "kid-home").map(c => ({ ...c, amountRupees: 1_000 }));
    const res = resolveSetupBudget({ totalBudgetRupees: 40_000, categories: cats });
    assert.deepEqual([res.blank.length, res.remainderPaise], [0, (40_000 - 1_000 * cats.length) * 100]);
    const setup: SetupInputRaw = { eventType: "birthday", style: "kid-home", city: "Pune", startDate: "2027-01-09", guestCount: 20, totalBudgetRupees: 40_000, categories: cats };
    const r = initializeEventPlan(blueprintFromSetup(setup), { setup });
    assert.ok(r.ok && plannedTotal(r.state) === 1_000 * cats.length * 100);
    assert.throws(() => resolveSetupBudget({ totalBudgetRupees: 1_000, categories: [{ category: "venue", include: true, amountRupees: 2_000, percentBps: null, booked: false }] }), /over the/);
    assert.throws(() => resolveSetupBudget({ totalBudgetRupees: 1_000, categories: [{ category: "venue", include: true, amountRupees: null, percentBps: null, booked: true }] }), /amount you booked/);
  });
  test("blank categories share the remainder by normalised weights (largest remainder), deterministic", () => {
    const lines = suggestedCategories("wedding", "telugu-hindu");
    const setup = SetupInput.parse(setupFor({ totalBudgetRupees: 10_00_001 }));
    const a = constrainBudgetLines(lines, setup), b = constrainBudgetLines(lines, setup);
    assert.deepEqual(a, b);
    assert.equal(a.reduce((x, l) => x + l.plannedPaise, 0), 10_00_001_00);
    assert.ok(a.every(l => l.plannedPaise % 100 === 0), "whole-rupee inputs give whole-rupee envelopes (no stray paise on screen)");
    const hints = suggestionHints("wedding", "telugu-hindu", 10_00_001);
    assert.equal(Object.values(hints).reduce((x, h) => x + h.paise, 0), 10_00_001_00);
  });
  test("an AI draft is held to the user's answers: excluded categories dropped, basics overridden, sub-events kept in the range", () => {
    const cats = defaultSetupCategories("birthday", "kid-home");
    cats.find(c => c.category === "decor")!.amountRupees = 7_777;
    const setup: SetupInputRaw = { eventType: "birthday", style: "kid-home", title: "Aarav turns 7", city: "Pune", startDate: "2027-01-09", guestCount: 25, totalBudgetRupees: 40_000, honoree: "Aarav", turningAge: 7, categories: cats };
    const aiDraft = { title: "Some party", eventType: "birthday", city: "Mumbai", startDate: "2030-01-01", totalBudgetRupees: 99_999, guestCount: 300,
      subEvents: [{ name: "Party", dayOffset: 3, startMin: 960, endMin: 1140, isMain: true, phase: "main" }],
      budgetLines: [{ category: "venue", label: "Banquet hall", weightBps: 4000 }, { category: "catering", label: "Mocktail bar", weightBps: 3000 }, { category: "decor", label: "Jungle decor", weightBps: 1000 }, { category: "logistics", label: "Cabs", weightBps: 500 }],
      ext: { type: "birthday", honoree: "X", wishlist: [{ item: "Whisky", approxRupees: 5000 }] } };
    const r = initializeEventPlan(aiDraft, { setup });
    assert.ok(r.ok, r.ok ? "" : r.reason);
    if (!r.ok) return;
    assert.deepEqual([r.state.event.title, r.state.event.city, r.state.event.startDate, r.state.event.guestCount, r.state.event.totalBudgetPaise], ["Aarav turns 7", "Pune", "2027-01-09", 25, 40_000_00]);
    assert.ok(!r.state.budgetItems.some(b => b.category === "venue" || b.category === "logistics"), "a kid's party at home gets no venue or cabs unless the user turned them on");
    assert.equal(r.state.budgetItems.filter(b => b.category === "decor").reduce((a, b) => a + b.plannedPaise, 0), 7_777_00);
    assert.ok(r.state.budgetItems.some(b => b.category === "entertainment"), "an included category the AI forgot still gets a line");
    assert.equal(plannedTotal(r.state), 40_000_00);
    assert.equal(r.state.subEvents[0]!.date, "2027-01-09", "single-day setup: sub-events are pulled into the user's range");
    assert.equal(r.state.event.ext.type === "birthday" && r.state.event.ext.honoree, "Aarav");
    assert.equal(initializeEventPlan({ ...aiDraft, eventType: "wedding", ext: { type: "wedding" } }, { setup }).ok, false);
  });
  test("every style builds a valid offline plan; culture-appropriate sub-events (no Haldi for Christian, Muslim, civil; Ganesh days)", () => {
    for (const t of ["wedding", "birthday", "community"] as const) for (const st of STYLES[t]) for (const endDate of [undefined, "2027-02-14"]) {
      const setup: SetupInputRaw = { eventType: t, style: st.id, city: "Hyderabad", startDate: "2027-02-10", ...(endDate ? { endDate } : {}), guestCount: 120, totalBudgetRupees: 8_00_000, categories: defaultSetupCategories(t, st.id) };
      const r = initializeEventPlan(blueprintFromSetup(setup), { setup });
      assert.ok(r.ok, `${t}/${st.id}: ${r.ok ? "" : r.reason}`);
      if (!r.ok) continue;
      assert.equal(plannedTotal(r.state), 8_00_000_00);
      const names = r.state.subEvents.map(s => s.name).join(",");
      if (t === "wedding" && ["christian", "muslim", "civil", "sikh"].includes(st.id)) assert.doesNotMatch(names, /Haldi|Muhurtham/, st.id);
      if (st.id === "ganesh") assert.match(names, /sthapana.*aarti.*Visarjan/i);
      if (st.id === "kid-home") assert.ok(!r.state.budgetItems.some(b => b.category === "venue" || b.category === "logistics" || /mocktail|bar/i.test(b.label)));
    }
  });
  test("chat cold-start uses the right variant too: kid party at home, Ganesh pandal, Christian wedding; the flagships are unchanged", () => {
    const kid = initializeEventPlan(blueprintFromPrompt("Plan a 7th jungle birthday at home for Aarav in Pune for ₹40k", TODAY));
    assert.ok(kid.ok && !kid.state.budgetItems.some(b => b.category === "venue" || /mocktail|cab/i.test(b.label)) && !kid.state.subEvents.some(s => /brunch/i.test(s.name)));
    const g = initializeEventPlan(blueprintFromPrompt("Plan a Ganesh pandal for our colony in Hyderabad for 400 people with ₹3L", TODAY));
    assert.ok(g.ok && /Visarjan/.test(g.state.subEvents.map(s => s.name).join()));
    const c = initializeEventPlan(blueprintFromPrompt("Plan a Christian wedding in Kochi for 200 guests ₹15L", TODAY));
    assert.ok(c.ok && !c.state.subEvents.some(s => /haldi/i.test(s.name)));
    const arcade = initializeEventPlan(blueprintFromPrompt("Plan a 30th retro arcade birthday in Mumbai for ₹1.5L", TODAY));
    assert.ok(arcade.ok && arcade.state.budgetItems.some(b => /Arcade lounge buyout/.test(b.label)));
  });
  test("with the organiser's today, deadlines the draft already missed move to today; nothing starts overdue", () => {
    const setup = setupFor({ startDate: "2027-02-10", endDate: undefined, today: "2026-10-23" });
    const r = initializeEventPlan(blueprintFromSetup(setup), { setup });
    assert.ok(r.ok);
    if (!r.ok) return;
    for (const t of r.state.tasks) assert.ok(taskDueDate(r.state, t) >= "2026-10-23", `${t.title} due ${taskDueDate(r.state, t)}`);
    assert.ok(r.state.tasks.some(t => taskDueDate(r.state, t) === "2026-10-23"), "the venue booking is due today, not 38 days ago");
  });
  test("the setup schema rejects bad input", () => {
    for (const bad of [{ city: "" }, { guestCount: 0 }, { totalBudgetRupees: 999 }, { endDate: "2027-02-01" }, { endDate: "2027-03-30" }, { style: "zz" },
      { categories: defaultSetupCategories("wedding", "telugu-hindu").map(c => ({ ...c, include: false })) }])
      assert.equal(SetupInput.safeParse(setupFor(bad as Partial<SetupInputRaw>)).success, false, JSON.stringify(bad));
  });
});

// ---------------------------------------------------------------- server: /api/plan and ideas over /api/chat
describe("plan API (mocked Gemini)", () => {
  const venueFixed = () => { const cats = defaultSetupCategories("wedding", "christian"); cats.find(c => c.category === "venue")!.amountRupees = 3_33_333; return setupFor({ style: "christian", categories: cats }); };
  test("no key → deterministic Demo Mode blueprint, labelled", async () => {
    const r = await handleCreatePlan({ setup: venueFixed() }, { apiKey: null });
    assert.equal(r.status, 200);
    const b = r.body as PlanResponseBody;
    assert.deepEqual([b.mode, b.fallbackReason], ["offline", "no_api_key"]);
    assert.equal(b.plan.budgetItems.filter(x => x.category === "venue").reduce((a, x) => a + x.plannedPaise, 0), 3_33_333_00);
    assert.equal(plannedTotal(b.plan), 20_00_000_00);
  });
  test("Gemini's initialize_event_plan draft is used, and the user's amounts still win", async () => {
    const draft = { title: "Anna & Joel", eventType: "wedding", startDate: "2027-02-10", totalBudgetRupees: 1, city: "x",
      subEvents: [{ name: "Engagement", dayOffset: 0, startMin: 1080, endMin: 1260, phase: "pre" }, { name: "Church wedding", dayOffset: 2, startMin: 600, endMin: 720, isMain: true, phase: "main" }],
      budgetLines: [{ category: "venue", label: "St. Mary's hall", weightBps: 9000 }, { category: "catering", label: "Kerala sadya", weightBps: 100 }],
      tasks: [{ title: "Book the choir", dueOffsetDays: -60 }], ext: { type: "wedding", partners: ["Anna", "Joel"], traditions: ["christian"] } };
    const gen = scripted({ functionCalls: [{ id: "1", name: "initialize_event_plan", args: draft }] });
    const r = await handleCreatePlan({ setup: venueFixed() }, { apiKey: KEY, generate: gen });
    const b = r.body as PlanResponseBody;
    assert.equal(b.mode, "gemini");
    assert.equal(b.plan.event.title, "Anna & Joel");
    assert.equal(b.plan.budgetItems.find(x => x.label === "St. Mary's hall")!.plannedPaise, 3_33_333_00);
    assert.equal(plannedTotal(b.plan), 20_00_000_00);
    assert.ok(b.plan.tasks.some(t => t.title === "Book the choir"));
    const sent = JSON.stringify(gen.sent[0]);
    assert.match(sent, /Use ONLY these budget categories/);
    assert.match(sent, /initialize_event_plan/);
  });
  test("a draft that can't fit is retried once with the reason, then falls back; provider errors fall back; bad setup is a 400", async () => {
    const bad = { functionCalls: [{ id: "1", name: "initialize_event_plan", args: { title: "x", eventType: "birthday", startDate: "2027-02-10", totalBudgetRupees: 1, subEvents: [{ name: "P", dayOffset: 0, startMin: 1, endMin: 2, isMain: true }], budgetLines: [{ category: "venue", label: "v", weightBps: 1 }], ext: { type: "birthday" } } }] };
    const gen = scripted(bad, bad);
    const r = await handleCreatePlan({ setup: venueFixed() }, { apiKey: KEY, generate: gen });
    assert.equal(gen.calls, 2);
    assert.deepEqual([(r.body as PlanResponseBody).mode, (r.body as PlanResponseBody).fallbackReason], ["offline", "draft_rejected"]);
    const down = await handleCreatePlan({ setup: venueFixed() }, { apiKey: KEY, generate: scripted(Object.assign(new Error("busy"), { status: 503 })) });
    assert.equal((down.body as PlanResponseBody).mode, "offline");
    assert.equal((await handleCreatePlan({ setup: { ...venueFixed(), city: "" } }, { apiKey: null })).status, 400);
    assert.equal((await handleCreatePlan({ setup: venueFixed(), extra: 1 }, { apiKey: null })).status, 400);
  });
});

describe("ideas over /api/chat (mocked Gemini)", () => {
  const ask = (extra: Record<string, unknown> = {}) => ({ messages: [{ role: "user", text: "Suggest ideas" }], state: royalWedding, today: TODAY, ideas: { focus: "sangeet" }, ...extra });
  test("no key → curated bank through the same tool, labelled offline", async () => {
    const r = await handleChat(ask(), { apiKey: null });
    const b = r.body as ChatResponseBody;
    assert.equal(b.mode, "offline");
    const a = b.actions.find(x => x.kind === "ideas");
    assert.ok(a && a.kind === "ideas" && a.source === "demo" && a.ideas.length > 0);
  });
  test("Gemini is offered only suggest_ideas; its rupee estimates are converted and checked by code", async () => {
    const gen = scripted({ functionCalls: [{ id: "1", name: "suggest_ideas", args: { ideas: [{ kind: "music", title: "Nadaswaram at dawn", description: "d", estLowRupees: 30_000, estHighRupees: 50_000 }, { kind: "decor", title: "Gold-plated mandap", estLowRupees: 99_00_000 }] } }] });
    const r = await handleChat(ask(), { apiKey: KEY, generate: gen });
    const b = r.body as ChatResponseBody;
    assert.equal(b.mode, "gemini");
    const sent = gen.sent[0] as { functionDeclarations: { name: string }[] };
    assert.deepEqual(sent.functionDeclarations.map(f => f.name), ["suggest_ideas"]);
    const a = b.actions.find(x => x.kind === "ideas");
    assert.ok(a && a.kind === "ideas");
    if (!a || a.kind !== "ideas") return;
    assert.deepEqual(a.ideas.map(i => [i.title, i.estLowPaise, i.source]), [["Nadaswaram at dawn", 30_000_00, "gemini"]]);
    assert.equal(a.dropped, 1, "the idea above the whole budget is dropped by code");
  });
  test("no tool call → falls back to the bank with a warning; guests can't ask for ideas; the strict schema still rejects unknown keys", async () => {
    const r = await handleChat(ask(), { apiKey: KEY, generate: scripted({ text: "Here are some thoughts..." }) });
    const b = r.body as ChatResponseBody;
    assert.equal(b.mode, "offline");
    assert.equal(b.fallbackReason, "malformed_response");
    assert.equal((await handleChat(ask({ role: "guest" }), { apiKey: null })).status, 403);
    assert.equal((await handleChat(ask({ ideas: { focus: "x", sneaky: true } }), { apiKey: null })).status, 400);
  });
  test("the chat loop executes suggest_ideas from conversation ('give me sangeet ideas')", async () => {
    const gen = scripted({ functionCalls: [{ id: "1", name: "suggest_ideas", args: { ideas: [{ kind: "activity", title: "Couple's dance-off", estLowRupees: 5_000, estHighRupees: 10_000 }] } }] }, { text: "Added one idea: a couple's dance-off." });
    const r = await handleChat({ messages: [{ role: "user", text: "give me sangeet ideas" }], state: royalWedding, today: TODAY }, { apiKey: KEY, generate: gen });
    const b = r.body as ChatResponseBody;
    assert.equal(b.mode, "gemini");
    assert.ok(b.actions.some(a => a.kind === "ideas"));
  });
});

// ---------------------------------------------------------------- the haldi regression
describe("a message never switches templates or resets the plan (regression)", () => {
  test("PlannerApp.send has no template jump or reset on 'haldi'", () => {
    const src = plannerSource();
    const send = src.slice(src.indexOf("const send = async"), src.indexOf("const scan = async"));
    assert.ok(send.length > 100, "found send()");
    assert.doesNotMatch(send, /haldi/i);
    assert.doesNotMatch(send, /resetTemplate\(|switchTemplate\(/);
  });
  test("a haldi message on a birthday plan is answered against that plan and changes nothing", () => {
    const r = runOfflineAgent(arcadeBirthday, "Cut ₹20k from decor and move the Haldi to Friday", TODAY);
    for (const a of r.actions) if (a.kind === "batch") {
      const res = applyBatch(arcadeBirthday, a.batch);
      assert.ok(res.ok);
      if (res.ok) assert.equal(res.state.event.id, arcadeBirthday.event.id);
      assert.ok(!a.batch.commands.some(c => c.op === "move_sub_event"));
    }
    const move = applyBatch(arcadeBirthday, { summary: "m", commands: [{ op: "move_sub_event", subEvent: "haldi", to: { weekday: "friday" } }] });
    assert.ok(!move.ok && /No sub-event "haldi"/.test(move.reason));
  });
});

describe("prompt chips follow the plan", () => {
  test("chips naming a sub-event are hidden on plans without it (a user's own Christian wedding has no Haldi)", async () => {
    const { promptsForPlan, promptsFor } = await import("../config/demo-prompts");
    assert.equal(promptsForPlan("organizer", royalWedding).length, promptsFor("organizer", "wedding").length);
    const setup = setupFor({ style: "christian", categories: defaultSetupCategories("wedding", "christian") });
    const r = initializeEventPlan(blueprintFromSetup(setup), { setup });
    assert.ok(r.ok);
    if (!r.ok) return;
    const chips = promptsForPlan("organizer", r.state).map(p => p.text).join(" | ");
    assert.doesNotMatch(chips, /Haldi/);
    assert.match(chips, /ideas/);
    for (const p of promptsForPlan("organizer", r.state)) for (const a of runOfflineAgent(r.state, p.text, TODAY).actions)
      if (a.kind === "batch") assert.ok(applyBatch(r.state, a.batch).ok, p.id);
  });
});

describe("routes", () => {
  test("Ideas and Vendors are nav pages; /setup is outside the nav", () => {
    assert.deepEqual(PAGES.map(p => p.href), ["/", "/budget", "/vendors", "/tasks", "/schedule", "/event", "/guests", "/ideas"]);
    assert.equal(pageForPath("/ideas").id, "ideas");
  });
});
