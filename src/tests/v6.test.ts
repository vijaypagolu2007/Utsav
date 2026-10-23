// v6: priorities and trade-offs, what-if and per-guest lines, the vendor workspace, task dependencies, idea refinement
// and the stress test ("budget down ₹50k and the event 2 weeks earlier" revises, never restarts). Gemini is always mocked.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
process.env.UTSAV_SILENT_LOGS = "1";
import { royalWedding, arcadeBirthday, culturalFest } from "../presets";
import { AgentState } from "../schema";
import { AgentBatch, addDays, applyBatch, categoryMaxCuttable, plannedTotal, taskDueDate, type CommandInput } from "../commands";
import { agentBatchTier, batchTier, commandTier } from "../trust";
import { Batch } from "../commands";
import { computePlanDiff } from "../diff";
import { initializeEventPlan, inferDependencies } from "../blueprint";
import { blueprintFromSetup, defaultSetupCategories } from "../setup";
import { buildPriorityFix, buildRevision, categoryTotals, cutCommands, explainCut, planPriorityCut, tierOf, whatIf, LEVEL_DEPTH_BPS } from "../priorities";
import { checklistRows, compareQuotes, divRound, figureKind, normaliseQuote, slotStatus } from "../vendors";
import { checklistFor } from "../config/vendor-checklist";
import { computePlanInsights } from "../insights";
import { demoRefine, prepareIdeas } from "../ideas";
import { executeAgentTool, revisionInputOf, RevisePlan } from "../agent";
import { parseShiftDays, runOfflineAgent, runOfflineIdeas, runOfflineVendorQuestions } from "../offline";
import { functionDeclarations, SYSTEM_PROMPT } from "../gemini-tools";
import { handleChat, type ChatResponseBody } from "../server/chat-handler";
import type { GenerateFn, GenerateResult } from "../server/gemini-client";
import { parseQuoteText, sampleQuote, scanToActions, visionToScanned } from "../quote-scanner";
import { promptsForPlan } from "../config/demo-prompts";
import { toGuestView } from "../guest-view";
import { pageForInsight } from "../routes";

const TODAY = "2026-10-23";
const run = (st: AgentState, commands: CommandInput[], opts: Parameters<typeof applyBatch>[2] = {}) => applyBatch(st, { summary: "t", commands }, opts);
const ok = (r: ReturnType<typeof applyBatch>) => { assert.ok(r.ok, r.ok ? "" : r.reason); return r.ok ? r.state : (null as never); };
const catSum = (st: AgentState, c: string) => st.budgetItems.filter(b => b.category === c).reduce((a, b) => a + b.plannedPaise, 0);
function scripted(...steps: (GenerateResult | Error)[]): GenerateFn & { calls: number; sent: unknown[] } {
  const f = (async (p: unknown) => { f.calls++; f.sent.push(p); const s = steps.shift() ?? { text: "done" }; if (s instanceof Error) throw s; return s; }) as unknown as GenerateFn & { calls: number; sent: unknown[] };
  f.calls = 0; f.sent = [];
  return f;
}
const KEY = "test-key-not-real";
const body = <T,>(r: { status: number; body: unknown }) => r.body as T;
const user = (text: string) => [{ role: "user" as const, text }];
/** A plan that is over its total by `over` paise (the total lowered, nothing else touched). */
const overBy = (st: AgentState, over: number) => ({ ...st, event: { ...st.event, totalBudgetPaise: plannedTotal(st) - over } });

// ---------------------------------------------------------------- schema defaults
describe("v6 schema defaults (legacy plans still parse)", () => {
  test("priorities, vendor checklist, per-guest basis, dependsOn, quote fields and refinedFrom all default", () => {
    const legacy = JSON.parse(JSON.stringify(arcadeBirthday)) as Record<string, unknown>;
    delete legacy.priorities; delete legacy.vendorChecklist;
    for (const b of legacy.budgetItems as Record<string, unknown>[]) { delete b.basis; delete b.perGuestPaise; }
    for (const t of legacy.tasks as Record<string, unknown>[]) delete t.dependsOn;
    const st = AgentState.parse(legacy);
    assert.deepEqual(st.priorities, { protect: [], cutFirst: [], level: "balanced" });
    assert.deepEqual(st.vendorChecklist, { notNeeded: [] });
    assert.ok(st.budgetItems.every(b => b.basis === "flat" && b.perGuestPaise === null));
    assert.ok(st.tasks.every(t => Array.isArray(t.dependsOn) && t.dependsOn.length === 0));
    const q = AgentState.parse({ ...royalWedding, vendors: [{ id: "x", name: "X", category: "decor", quotes: [{ id: "q", amountPaise: 100, basis: "flat", receivedOn: TODAY }] }] }).vendors[0]!.quotes[0]!;
    assert.deepEqual([q.inclusions, q.exclusions, q.extraCharges, q.guestsCovered, q.openQuestions], [[], [], [], null, []]);
  });
  test("the guest projection never carries priorities, vendors or the checklist", () => {
    const json = JSON.stringify(toGuestView(royalWedding, "e", 1, null));
    for (const k of ["priorities", "cutFirst", "vendorChecklist", "Lens & Light", "perGuestPaise"]) assert.ok(!json.includes(k), k);
  });
});

// ---------------------------------------------------------------- set_priorities
describe("set_priorities (Tier 0, organiser only)", () => {
  test("sets protect / cut-first / level; dedupes; refuses a category in both; no-op when unchanged", () => {
    const st = ok(run(arcadeBirthday, [{ op: "set_priorities", protect: ["entertainment", "entertainment", "catering"], cutFirst: ["decor"], level: "premium" }]));
    assert.deepEqual(st.priorities, { protect: ["entertainment", "catering"], cutFirst: ["decor"], level: "premium" });
    assert.equal(tierOf(st.priorities, "decor"), "cut_first");
    assert.equal(tierOf(st.priorities, "venue"), "flexible");
    const both = run(arcadeBirthday, [{ op: "set_priorities", protect: ["decor"], cutFirst: ["decor"], level: "balanced" }]);
    assert.ok(!both.ok && /both protected and cut first/.test(both.reason));
    const same = ok(run(royalWedding, [{ op: "set_priorities", protect: ["catering", "venue"], cutFirst: ["decor", "misc"], level: "balanced" }]));
    assert.equal(same, royalWedding);
    assert.equal(commandTier({ op: "set_priorities", protect: [], cutFirst: [], level: "simple" }), 0);
  });
  test("guests can't; an AI proposal of it is shown as an approval card (Tier ≥ 1), not auto-applied", () => {
    const g = run(royalWedding, [{ op: "set_priorities", protect: [], cutFirst: [], level: "simple" }], { role: "guest" });
    assert.ok(!g.ok && /read-only/i.test(g.reason));
    const cmds = Batch.parse({ summary: "x", commands: [{ op: "set_priorities", protect: ["venue"], cutFirst: [], level: "simple" }] }).commands;
    assert.equal(batchTier(cmds), 0);
    assert.equal(agentBatchTier(cmds), 1);
    const out = executeAgentTool("apply_plan_changes", { summary: "x", commands: [{ op: "set_priorities", protect: ["venue"], cutFirst: [], level: "simple" }] }, royalWedding, TODAY);
    const a = out.actions[0]!;
    assert.equal(a.kind, "batch");
    assert.equal(a.kind === "batch" && a.tier, 1);
  });
  test("every v6 op is declared to Gemini", () => {
    const decl = JSON.stringify(functionDeclarations.find(f => f.name === "apply_plan_changes")!.parametersJsonSchema);
    for (const op of ["set_priorities", "add_vendor", "set_vendor_stage", "remove_vendor", "set_vendor_need", "set_task_dependency"]) assert.ok(decl.includes(`"${op}"`), op);
    assert.ok(AgentBatch.safeParse({ summary: "x", commands: [{ op: "set_task_dependency", taskId: "k5", dependsOn: ["k3"] }] }).success);
  });
});

// ---------------------------------------------------------------- the priority cut maths
describe("planPriorityCut: trade-offs, not uniform cuts (paise-exact)", () => {
  test("royal wedding, ₹30,000 short: only cut-first categories give, at most the level's depth; protected untouched", () => {
    const plan = planPriorityCut(royalWedding, 30_000_00);
    assert.equal(plan.cuts.reduce((a, c) => a + c.cutPaise, 0), 30_000_00);
    assert.equal(plan.shortfallPaise, 0);
    assert.deepEqual(plan.cuts.map(c => c.category).sort(), ["decor", "misc"]);
    assert.ok(plan.cuts.every(c => c.tier === "cut_first"));
    assert.deepEqual(plan.kept, ["catering", "venue"]);
    const slack = categoryMaxCuttable(royalWedding);
    for (const c of plan.cuts) assert.ok(c.cutPaise <= Math.floor(slack[c.category]! * LEVEL_DEPTH_BPS.balanced / 10_000), c.category);
    assert.ok(plan.cuts.every(c => c.cutPaise % 100 === 0), "whole rupees when everything is in whole rupees");
  });
  test("stages: cut-first to its depth, then flexible, then the rest of cut-first; never protected", () => {
    const slack = categoryMaxCuttable(royalWedding);
    const firstDepth = ["decor", "misc"].reduce((a, c) => a + Math.floor(slack[c]! * 7_500 / 10_000 / 100) * 100, 0);
    const flex = Object.entries(slack).filter(([c]) => !["decor", "misc", "catering", "venue"].includes(c)).reduce((a, [, v]) => a + v, 0);
    const need = firstDepth + flex + 1_000_00;
    const plan = planPriorityCut(royalWedding, need);
    assert.equal(plan.cuts.reduce((a, c) => a + c.cutPaise, 0), need);
    assert.ok(!plan.cuts.some(c => c.category === "catering" || c.category === "venue"));
    // More than all cut-first + flexible slack: the rest is a shortfall, not a protected cut.
    const huge = planPriorityCut(royalWedding, 50_00_000_00);
    assert.ok(huge.shortfallPaise > 0);
    assert.ok(!huge.cuts.some(c => c.tier === "protect"));
    assert.ok(explainCut(huge, royalWedding).some(l => /still over/.test(l)));
    // allowProtected (rebalance's last resort) reaches protected categories only after everything else.
    const all = planPriorityCut(royalWedding, flex + slack.decor! + slack.misc! + 1_00, { allowProtected: true });
    assert.equal(all.shortfallPaise, 0);
    assert.ok(all.cuts.some(c => c.tier === "protect"));
  });
  test("simple goes deeper on cut-first before flexible than premium does", () => {
    const simple = { ...royalWedding, priorities: { ...royalWedding.priorities, level: "simple" as const } };
    const premium = { ...royalWedding, priorities: { ...royalWedding.priorities, level: "premium" as const } };
    const need = 1_20_000_00;
    const sum = (p: ReturnType<typeof planPriorityCut>, tier: string) => p.cuts.filter(c => c.tier === tier).reduce((a, c) => a + c.cutPaise, 0);
    assert.ok(sum(planPriorityCut(simple, need), "cut_first") > sum(planPriorityCut(premium, need), "cut_first"));
    assert.ok(sum(planPriorityCut(premium, need), "flexible") > sum(planPriorityCut(simple, need), "flexible"));
  });
  test("locks and commitments are respected; paise are exact with odd amounts", () => {
    const locked = { ...royalWedding, budgetItems: royalWedding.budgetItems.map(b => b.id === "b1" ? { ...b, locked: true } : b) };
    const p = planPriorityCut(locked, 12_345_67);
    assert.equal(p.cuts.reduce((a, c) => a + c.cutPaise, 0), 12_345_67);
    const st = ok(run(locked, cutCommands(p)));
    assert.equal(st.budgetItems.find(b => b.id === "b1")!.plannedPaise, 80_000_00, "the locked line is untouched");
    for (const b of st.budgetItems) assert.ok(b.plannedPaise >= b.committedPaise, b.label);
    assert.equal(plannedTotal(locked) - plannedTotal(st), 12_345_67);
  });
  test("no priorities: every category flexible, cut in proportion; the explanation says so", () => {
    const p = planPriorityCut(arcadeBirthday, 10_000_00);
    assert.ok(p.cuts.every(c => c.tier === "flexible") && p.cuts.length > 1);
    assert.match(explainCut(p, arcadeBirthday).join(" "), /No priorities are set/);
  });
});

describe("Fix by my priorities, rebalance and AI cuts", () => {
  test("buildPriorityFix: one batch of adjust_budget cuts; planned lands exactly on the total; protected untouched", () => {
    const over = overBy(royalWedding, 47_500_00);
    const fix = buildPriorityFix(over);
    assert.ok(fix.ok);
    if (!fix.ok) return;
    assert.ok(fix.batch.commands.every(c => c.op === "adjust_budget"));
    assert.equal(plannedTotal(fix.after), over.event.totalBudgetPaise);
    for (const c of ["catering", "venue"]) assert.equal(catSum(fix.after, c), catSum(over, c), c);
    assert.ok(fix.explain.some(l => /Decor −₹[\d,]+ \(cut first\) to keep Catering and Venue intact/.test(l)), fix.explain.join("\n"));
    assert.ok(!buildPriorityFix(royalWedding).ok, "nothing to fix when within the total");
  });
  test("rebalance_budget follows priorities when they are set: protected categories last; still exact", () => {
    const over = overBy(royalWedding, 60_000_00);
    const st = ok(run(over, [{ op: "rebalance_budget", expectedHeadroomPaise: -60_000_00 }]));
    assert.equal(plannedTotal(st), st.event.totalBudgetPaise);
    for (const c of ["catering", "venue"]) assert.equal(catSum(st, c), catSum(over, c));
    // Positive headroom: protected categories get the most, cut-first nothing.
    const extra = { ...royalWedding, event: { ...royalWedding.event, totalBudgetPaise: plannedTotal(royalWedding) + 1_00_000_00 } };
    const up = ok(run(extra, [{ op: "rebalance_budget", expectedHeadroomPaise: 1_00_000_00 }]));
    assert.equal(plannedTotal(up), up.event.totalBudgetPaise);
    assert.equal(catSum(up, "decor"), catSum(extra, "decor"));
    assert.equal(catSum(up, "misc"), catSum(extra, "misc"));
    assert.ok(catSum(up, "catering") > catSum(extra, "catering"));
  });
  test("offline: 'we're over budget' and a cut with no category both follow priorities", () => {
    const over = overBy(royalWedding, 20_000_00);
    const r = runOfflineAgent(over, "We're over budget, fix it by my priorities", TODAY);
    const b = r.actions.find(a => a.kind === "batch");
    assert.ok(b && b.kind === "batch" && b.tier >= 1 && b.explain?.length);
    const cut = runOfflineAgent(royalWedding, "Cut ₹25k", TODAY);
    const c = cut.actions.find(a => a.kind === "batch");
    assert.ok(c && c.kind === "batch");
    if (c?.kind === "batch") assert.ok(c.batch.commands.every(x => x.op === "adjust_budget" && ["decor", "misc"].includes(x.category)), JSON.stringify(c.batch.commands));
  });
});

// ---------------------------------------------------------------- the stress test
describe("stress test: budget down ₹50k and the event 2 weeks earlier → revise, not restart", () => {
  test("one approval card: set_event_basics (−₹50,000, every date −14 days) plus priority cuts; exact; protected untouched", () => {
    const rev = buildRevision(royalWedding, TODAY, { budgetDeltaPaise: -50_000_00, shiftDays: -14 });
    assert.ok(rev.ok);
    if (!rev.ok) return;
    const [basics, ...cuts] = rev.batch.commands;
    assert.deepEqual(basics, { op: "set_event_basics", totalBudgetPaise: royalWedding.event.totalBudgetPaise - 50_000_00, startDate: addDays(royalWedding.event.startDate, -14) });
    assert.ok(cuts.length > 0 && cuts.every(c => c.op === "adjust_budget"));
    const after = rev.after;
    assert.equal(after.event.id, royalWedding.event.id, "the same plan, revised");
    assert.equal(after.event.totalBudgetPaise, 24_50_000_00);
    assert.ok(plannedTotal(after) <= after.event.totalBudgetPaise);
    assert.equal(plannedTotal(after), after.event.totalBudgetPaise);
    for (const s of royalWedding.subEvents) assert.equal(after.subEvents.find(x => x.id === s.id)!.date, addDays(s.date, -14));
    for (const t of royalWedding.tasks) assert.equal(taskDueDate(after, after.tasks.find(x => x.id === t.id)!), addDays(taskDueDate(royalWedding, t), -14));
    for (const c of ["catering", "venue"]) assert.equal(catSum(after, c), catSum(royalWedding, c));
    assert.equal(after.guests.length, royalWedding.guests.length, "nothing else is rebuilt");
    assert.ok(rev.explain.some(l => /14 days earlier/.test(l)) && rev.explain.some(l => /now overdue/.test(l)) && rev.explain.some(l => /to keep Catering and Venue intact/.test(l)));
    assert.equal(Math.max(1, batchTier(Batch.parse(rev.batch).commands)), 1);
  });
  test("offline chat produces exactly that card (Tier 1, with trade-offs), for the demo chip text", () => {
    const chip = promptsForPlan("organizer", royalWedding).find(p => p.id === "stress-test-revise")!;
    const r = runOfflineAgent(royalWedding, chip.text, TODAY);
    const cards = r.actions.filter(a => a.kind === "batch");
    assert.equal(cards.length, 1);
    const c = cards[0]!;
    assert.ok(c.kind === "batch" && c.tier === 1 && (c.explain?.length ?? 0) >= 4);
    if (c.kind === "batch") assert.deepEqual(c.batch.commands[0], { op: "set_event_basics", totalBudgetPaise: 24_50_000_00, startDate: "2027-02-24" });
    assert.match(r.reply, /revised the plan rather than starting over/);
    assert.ok(!r.actions.some(a => a.kind === "init"), "never a new plan");
  });
  test("when the headroom absorbs the cut, no category is cut and the card says so", () => {
    const roomy = { ...arcadeBirthday, event: { ...arcadeBirthday.event, totalBudgetPaise: plannedTotal(arcadeBirthday) + 80_000_00 } };
    const rev = buildRevision(roomy, TODAY, { budgetDeltaPaise: -50_000_00 });
    assert.ok(rev.ok && rev.batch.commands.length === 1 && rev.explain.some(l => /absorbs it/.test(l)));
  });
  test("parseShiftDays and revisionInputOf do the unit maths in code", () => {
    assert.equal(parseShiftDays("the event is 2 weeks earlier"), -14);
    assert.equal(parseShiftDays("pushed back by 3 days"), 3);
    assert.equal(parseShiftDays("a week later"), 7);
    assert.equal(parseShiftDays("no dates here"), null);
    assert.deepEqual(revisionInputOf(RevisePlan.parse({ budgetChangeRupees: -50000, shift: { amount: 2, unit: "weeks", direction: "earlier" } })),
      { budgetDeltaPaise: -50_000_00, shiftDays: -14, fixOverrun: true });
  });
  test("revise_plan refuses a total below what is committed and is organiser only", () => {
    const r = executeAgentTool("revise_plan", { budgetChangeRupees: -24_00_000 }, royalWedding, TODAY);
    assert.ok(!(r.response as { ok: boolean }).ok);
    const g = executeAgentTool("revise_plan", { budgetChangeRupees: -50000 }, royalWedding, TODAY, "guest");
    assert.ok(!(g.response as { ok: boolean }).ok && g.actions.length === 0);
  });
});

// ---------------------------------------------------------------- per-guest lines and what-if
describe("per-guest lines rescale with the guest count (code, integer paise)", () => {
  test("300 → 350 moves per-guest lines by rate × 50; back to 300 restores them exactly; flat lines don't move", () => {
    const up = ok(run(royalWedding, [{ op: "set_event_basics", guestCount: 350 }]));
    assert.equal(up.budgetItems.find(b => b.id === "b7")!.plannedPaise, 4_50_000_00 + 1500_00 * 50);
    assert.equal(up.budgetItems.find(b => b.id === "b8")!.plannedPaise, 1_50_000_00 + 500_00 * 50);
    assert.equal(up.budgetItems.find(b => b.id === "b9")!.plannedPaise, 2_50_000_00, "flat");
    const back = ok(run(up, [{ op: "set_event_basics", guestCount: 300 }]));
    assert.deepEqual(back.budgetItems.map(b => b.plannedPaise), royalWedding.budgetItems.map(b => b.plannedPaise));
    const rows = computePlanDiff(royalWedding, up).rows;
    assert.ok(rows.some(r => r.id === "b7" && r.deltaPaise === 75_000_00) && rows.some(r => r.kind === "basics"));
  });
  test("a cut never goes below what is committed, and a locked per-guest line isn't scaled down", () => {
    const down = ok(run(royalWedding, [{ op: "set_event_basics", guestCount: 50 }]));
    assert.equal(down.budgetItems.find(b => b.id === "b7")!.plannedPaise, 2_00_000_00, "held at committed");
    const locked = { ...royalWedding, budgetItems: royalWedding.budgetItems.map(b => b.id === "b8" ? { ...b, locked: true } : b) };
    const r = applyBatch(locked, { summary: "x", commands: [{ op: "set_event_basics", guestCount: 200 }] });
    assert.ok(r.ok && r.state.budgetItems.find(b => b.id === "b8")!.plannedPaise === 1_50_000_00 && r.log.some(l => /locked/.test(l)));
  });
  test("blueprints price catering and return gifts per guest (not cake or volunteer meals); totals stay exact", () => {
    const setup = { eventType: "wedding" as const, style: "telugu-hindu", city: "Hyderabad", startDate: "2027-02-10", guestCount: 250, totalBudgetRupees: 20_00_000,
      categories: defaultSetupCategories("wedding", "telugu-hindu") };
    const r = initializeEventPlan(blueprintFromSetup(setup), { setup });
    assert.ok(r.ok);
    if (!r.ok) return;
    const cat = r.state.budgetItems.filter(b => b.category === "catering" || b.category === "gifts");
    assert.ok(cat.length && cat.every(b => b.basis === "per_guest" && b.perGuestPaise === Math.floor(b.plannedPaise / 250)));
    assert.ok(r.state.budgetItems.filter(b => !["catering", "gifts"].includes(b.category)).every(b => b.basis === "flat"));
    assert.equal(plannedTotal(r.state), 20_00_000_00);
    const fest = initializeEventPlan(blueprintFromSetup({ eventType: "community", style: "cultural", city: "Pune", startDate: "2027-01-10", guestCount: 800, totalBudgetRupees: 3_00_000,
      categories: defaultSetupCategories("community", "cultural") }));
    assert.ok(fest.ok && fest.state.budgetItems.find(b => /volunteer/i.test(b.label))!.basis === "flat");
  });
});

describe("what-if previews (nothing commits until approved)", () => {
  test("spend more on photos: shows headroom after; with 'keep within my total' the overrun comes from cut-first, photos kept", () => {
    const w = whatIf(royalWedding, { category: "photo_video", plannedPaise: 2_50_000_00 }, { balance: true });
    assert.ok(w.ok);
    if (!w.ok) return;
    assert.equal(w.after.photo_video, 2_50_000_00);
    assert.ok(w.headroomAfter >= 0);
    assert.ok((w.after.decor ?? 0) < (w.before.decor ?? 0));
    assert.equal(w.after.catering, w.before.catering);
    const raw = whatIf(royalWedding, { category: "photo_video", plannedPaise: 2_50_000_00 });
    assert.ok(raw.ok && raw.headroomAfter < 0 && raw.after.decor === raw.before.decor);
    assert.deepEqual(categoryTotals(royalWedding).photo_video, 1_80_000_00, "the plan itself is unchanged");
  });
  test("more guests: lists which costs change (per-guest lines) and which don't", () => {
    const w = whatIf(royalWedding, { guestCount: 320 });
    assert.ok(w.ok && w.after.catering === (w.before.catering ?? 0) + (1500_00 + 500_00) * 20);
    assert.ok(w.ok && /per-guest lines rescale/.test(w.explain.join(" ")));
    assert.ok(!whatIf(royalWedding, { guestCount: 300 }).ok);
  });
});

// ---------------------------------------------------------------- vendors
describe("vendor ops", () => {
  test("add_vendor (Tier 0): shortlisted, with its checklist slot; duplicate names and unknown slots refused", () => {
    const st = ok(run(royalWedding, [{ op: "add_vendor", name: "Henna by Hima", category: "beauty", need: "mehendi_artist", phone: "+91 90000 00000" }]));
    const v = st.vendors.find(x => x.name === "Henna by Hima")!;
    assert.deepEqual([v.stage, v.need, v.quotes.length, v.phone], ["shortlisted", "mehendi_artist", 0, "+91 90000 00000"]);
    assert.ok(!run(st, [{ op: "add_vendor", name: "henna by hima", category: "beauty" }]).ok);
    assert.ok(!run(royalWedding, [{ op: "add_vendor", name: "X", category: "decor", need: "idol" }]).ok, "idol isn't a wedding slot");
    assert.equal(commandTier({ op: "add_vendor", name: "X", category: "decor" }), 0);
  });
  test("set_vendor_stage: Tier 0, booking Tier 1; remove_vendor Tier 1 and refused while money is committed", () => {
    assert.equal(commandTier({ op: "set_vendor_stage", vendorId: "v6", stage: "negotiating" }), 0);
    assert.equal(commandTier({ op: "set_vendor_stage", vendorId: "v6", stage: "booked" }), 1);
    assert.equal(commandTier({ op: "remove_vendor", vendorId: "v6" }), 1);
    const booked = ok(run(royalWedding, [{ op: "set_vendor_stage", vendorId: "v6", stage: "booked" }]));
    assert.equal(booked.vendors.find(v => v.id === "v6")!.stage, "booked");
    const r = run(royalWedding, [{ op: "remove_vendor", vendorId: "v3" }]);
    assert.ok(!r.ok && /committed/.test(r.reason));
    assert.ok(!run(royalWedding, [{ op: "remove_vendor", vendorId: "v4" }]).ok, "a payment is recorded on its line");
    const linked = { ...royalWedding, budgetItems: royalWedding.budgetItems.map(b => b.id === "b12" ? { ...b, vendorId: "v6" } : b) };
    const gone = ok(run(linked, [{ op: "remove_vendor", vendorId: "v6" }]));
    assert.ok(!gone.vendors.some(v => v.id === "v6"));
    assert.equal(gone.budgetItems.find(b => b.id === "b12")!.vendorId, null, "linked line unlinked, not deleted");
    assert.ok(computePlanDiff(linked, gone).rows.some(x => x.kind === "vendor" && /removed/.test(x.label)));
  });
  test("set_vendor_need marks a slot not needed (and back); guests can run none of the vendor ops", () => {
    const off = ok(run(royalWedding, [{ op: "set_vendor_need", need: "mehendi_artist", needed: false }]));
    const slot = checklistFor(off).find(s => s.key === "mehendi_artist")!;
    assert.equal(slotStatus(off, slot), "not_needed");
    const on = ok(run(off, [{ op: "set_vendor_need", need: "mehendi_artist", needed: true }]));
    assert.equal(slotStatus(on, slot), "needed");
    for (const c of [{ op: "add_vendor", name: "G", category: "decor" }, { op: "set_vendor_stage", vendorId: "v6", stage: "booked" }, { op: "remove_vendor", vendorId: "v6" },
      { op: "set_vendor_need", need: "makeup", needed: false }, { op: "set_task_dependency", taskId: "k5", dependsOn: [] }] as CommandInput[]) {
      const r = run(royalWedding, [c], { role: "guest" });
      assert.ok(!r.ok, c.op);
    }
  });
});

describe("vendor checklist and quote comparison", () => {
  test("statuses come from vendors: venue booked, photographer quoted (2 quotes), mehendi needed", () => {
    const rows = checklistRows(royalWedding);
    const by = Object.fromEntries(rows.map(r => [r.slot.key, r]));
    assert.equal(by.venue!.status, "booked");
    assert.equal(by.photographer!.status, "quoted");
    assert.equal(by.photographer!.vendors.length, 2);
    assert.equal(by.mehendi_artist!.status, "needed");
    assert.deepEqual(checklistFor(culturalFest).map(s => s.key).includes("idol"), false, "no idol for a cultural fest");
    assert.ok(checklistFor(arcadeBirthday).some(s => s.key === "cake" && !s.optional) && checklistFor(arcadeBirthday).find(s => s.key === "venue")!.optional);
  });
  test("normalised per-guest cost: flat ₹2,20,000 for 300 → ₹733.33; ₹600 per guest at your 300 (assumed, flagged)", () => {
    const row = checklistRows(royalWedding).find(r => r.slot.key === "photographer")!;
    const qs = compareQuotes(royalWedding, row.vendors);
    assert.deepEqual(qs.map(q => q.vendorName), ["Lens & Light Co.", "Frame by Frame Studios"], "cheapest per guest first");
    const [ll, fbf] = qs;
    assert.equal(fbf!.perGuestPaise, 733_33);
    assert.equal(fbf!.totalPaise, 2_20_000_00);
    assert.equal(ll!.perGuestPaise, 600_00);
    assert.equal(ll!.totalPaise, 600_00 * 300);
    assert.ok(ll!.guestsAssumed && ll!.openQuestions.some(q => /How many guests/.test(q)));
    assert.equal(fbf!.knownExtrasPaise, 18_000_00 + 5_000_00);
    assert.equal(ll!.unpricedExtras, 1);
    const hourly = normaliseQuote(royalWedding.vendors[0]!, { id: "h", amountPaise: 5_000_00, basis: "per_hour", receivedOn: TODAY, notes: "", inclusions: [], exclusions: [], extraCharges: [], guestsCovered: null, openQuestions: [] }, 300);
    assert.deepEqual([hourly.totalPaise, hourly.perGuestPaise], [null, null]);
  });
  test("divRound rounds half up exactly; figure labels: committed beats quoted beats estimate", () => {
    assert.deepEqual([divRound(10, 4), divRound(10, 3), divRound(2, 4), divRound(1, 3)], [3, 3, 1, 0]);
    assert.equal(divRound(Number.MAX_SAFE_INTEGER, 1), Number.MAX_SAFE_INTEGER);
    assert.equal(figureKind({ committedPaise: 1, quotedPaise: 5 }), "committed");
    assert.equal(figureKind({ committedPaise: 0, quotedPaise: 5 }), "quoted");
    assert.equal(figureKind({ committedPaise: 0, quotedPaise: null }), "estimate");
  });
  test("the quote scanner fills the structured fields, and upsert_vendor_quote stores them", () => {
    const q = sampleQuote("royal-caterer-quote", TODAY)!;
    assert.equal(q.guestsCovered, 320);
    assert.ok(q.extraCharges.some(x => x.amountPaise === 15_000_00) && q.extraCharges.some(x => x.amountPaise === null));
    assert.ok(q.openQuestions.includes("Is GST included?"));
    const out = scanToActions(q, royalWedding, TODAY);
    const st = ok(applyBatch(royalWedding, out.batch));
    const v = st.vendors.find(x => x.name === q.vendorName)!;
    assert.equal(v.quotes.at(-1)!.guestsCovered, 320);
    const typed = parseQuoteText("ACME TENTS\nItem: Pandal for 500 guests\nGrand Total: ₹90 per plate\nIncludes: chairs, fans; lights\nExcludes: generator", TODAY);
    assert.deepEqual([typed.basis, typed.inclusions, typed.exclusions, typed.guestsCovered], ["per_guest", ["chairs", "fans", "lights"], ["generator"], 500]);
    const vis = visionToScanned({ vendorName: "V", category: "decor", itemLabel: "Stage", quotedRupees: 1000, redFlags: [], summary: "s", inclusions: ["a"], extraCharges: [{ label: "Night", amountRupees: 250.5 }], guestsCovered: 0 }, TODAY);
    assert.deepEqual([vis.inclusions, vis.extraCharges, vis.guestsCovered], [["a"], [{ label: "Night", amountPaise: 250_50 }], undefined]);
  });
  test("offline vendor questions come from the curated bank through the same checked tool", () => {
    const r = runOfflineVendorQuestions(royalWedding, TODAY, "caterer");
    const q = r.actions.find(a => a.kind === "questions");
    assert.ok(q && q.kind === "questions" && q.questions.length >= 5 && q.source === "demo");
    const bad = executeAgentTool("suggest_vendor_questions", { need: "idol", questions: ["What is the height?", "Is it clay?", "When is delivery?"] }, royalWedding, TODAY);
    assert.ok(!(bad.response as { ok: boolean }).ok);
  });
});

// ---------------------------------------------------------------- task dependencies
describe("task dependencies", () => {
  test("set_task_dependency (Tier 0): sets and clears; refuses itself, unknown tasks and cycles", () => {
    assert.equal(commandTier({ op: "set_task_dependency", taskId: "k1", dependsOn: [] }), 0);
    const st = ok(run(royalWedding, [{ op: "set_task_dependency", taskId: "k7", dependsOn: ["k5"] }]));
    assert.deepEqual(st.tasks.find(t => t.id === "k7")!.dependsOn, ["k5"]);
    assert.ok(computePlanDiff(royalWedding, st).rows.some(r => r.kind === "task_dep"));
    assert.ok(!run(royalWedding, [{ op: "set_task_dependency", taskId: "k7", dependsOn: ["k7"] }]).ok);
    assert.ok(!run(royalWedding, [{ op: "set_task_dependency", taskId: "k7", dependsOn: ["nope"] }]).ok);
    const cyc = run(st, [{ op: "set_task_dependency", taskId: "k3", dependsOn: ["k7"] }]);
    assert.ok(!cyc.ok && /wait for itself/.test(cyc.reason), "k7 → k5 → k3 → k7");
    assert.deepEqual(ok(run(st, [{ op: "set_task_dependency", taskId: "k7", dependsOn: [] }])).tasks.find(t => t.id === "k7")!.dependsOn, []);
  });
  test("insights flag the downstream task when its blocker is due within a week, overdue, or due after it", () => {
    const pi = computePlanInsights(royalWedding, TODAY);
    const f = pi.insights.find(i => i.id === "blocked:k5");
    assert.ok(f, "Print invitations waits on Book purohit (due 2026-10-25)");
    assert.ok(f!.refs.includes("k3") && /Book Muhurtham purohit/.test(f!.detail));
    assert.equal(pageForInsight("blocked_task").id, "tasks");
    const late = computePlanInsights(royalWedding, "2026-10-30").insights.find(i => i.id === "blocked:k5")!;
    assert.match(late.detail, /overdue/);
    const done = ok(run(royalWedding, [{ op: "set_task_status", taskId: "k3", status: "done" }]));
    assert.ok(!computePlanInsights(done, TODAY).insights.some(i => i.id === "blocked:k5"));
    // Knock-on: delaying the blocker's sub-event past the dependent's due date is flagged.
    const swapped = { ...royalWedding, tasks: royalWedding.tasks.map(t => t.id === "k3" ? { ...t, dueOffsetDays: -100 } : t) };
    assert.match(computePlanInsights(swapped, TODAY).insights.find(i => i.id === "blocked:k5")!.detail, /after this task/);
  });
  test("blueprints set key dependencies: venue booking before decor, catering and invitations", () => {
    const setup = { eventType: "wedding" as const, style: "telugu-hindu", city: "Hyderabad", startDate: "2027-02-10", endDate: "2027-02-12", guestCount: 250, totalBudgetRupees: 20_00_000,
      categories: defaultSetupCategories("wedding", "telugu-hindu") };
    const r = initializeEventPlan(blueprintFromSetup(setup), { setup });
    assert.ok(r.ok);
    if (!r.ok) return;
    const venue = r.state.tasks.find(t => /Book venue/.test(t.title))!;
    for (const re of [/caterers/, /invitations/]) assert.ok(r.state.tasks.find(t => re.test(t.title))!.dependsOn.includes(venue.id), String(re));
    const tasks = [{ id: "a", title: "Apply for police permission", dependsOn: [] as string[] }, { id: "b", title: "Allot stalls", dependsOn: [] as string[] }];
    inferDependencies(tasks);
    assert.deepEqual(tasks[1]!.dependsOn, ["a"]);
    // Explicit titles from an AI draft win over inference.
    const bp = { ...blueprintFromSetup(setup), tasks: [{ title: "Book venue & pay deposit", dueOffsetDays: -150 }, { title: "Send invitations", dueOffsetDays: -45, dependsOn: ["Book venue & pay deposit"] }, { title: "Shortlist caterers", dueOffsetDays: -100 }] };
    const r2 = initializeEventPlan(bp);
    assert.ok(r2.ok && r2.state.tasks[1]!.dependsOn.length === 1 && r2.state.tasks[2]!.dependsOn.length === 0);
  });
});

// ---------------------------------------------------------------- idea refinement
describe("idea refinement", () => {
  const withIdea = () => ok(run(royalWedding, [{ op: "add_ideas", ideas: [{ kind: "decor", title: "Pastel floral mandap with jasmine strings", source: "demo", estLowPaise: 1_20_000_00, estHighPaise: 3_00_000_00, category: "decor" }] }]));
  test("offline 'Cheaper alternative' adds cheaper cards linked to the source idea", () => {
    const st = withIdea();
    const src = st.ideas.at(-1)!;
    const r = runOfflineIdeas(st, TODAY, "", undefined, { mode: "cheaper", ideaId: src.id });
    const a = r.actions.find(x => x.kind === "ideas");
    assert.ok(a && a.kind === "ideas" && a.ideas.length >= 1);
    if (a?.kind !== "ideas") return;
    for (const i of a.ideas) { assert.equal(i.refinedFrom, src.id); assert.ok(i.estLowPaise === null || i.estLowPaise < src.estLowPaise!); }
    const after = ok(applyBatch(st, a.batch));
    assert.ok(after.ideas.some(i => i.refinedFrom === src.id));
  });
  test("kid-friendly and more traditional always return something, tagged; code drops a 'cheaper' card that isn't cheaper", () => {
    const st = withIdea();
    const src = st.ideas.at(-1)!;
    for (const mode of ["kid_friendly", "traditional"] as const) {
      const input = demoRefine(st, { mode, ideaId: src.id });
      const p = prepareIdeas(st, input, "demo", { refine: { mode, ideaId: src.id } });
      assert.ok(p.ok && p.value.drafts.length >= 1 && p.value.drafts.every(d => d.tags.includes(mode === "kid_friendly" ? "kids" : "traditional")), mode);
    }
    const p = prepareIdeas(st, { ideas: [{ kind: "decor", title: "Gold mandap", estLowRupees: 2_00_000 }, { kind: "decor", title: "Paper flowers", estLowRupees: 20_000 }] }, "gemini", { refine: { mode: "cheaper", ideaId: src.id } });
    assert.ok(p.ok && p.value.drafts.map(d => d.title).join() === "Paper flowers" && p.value.dropped.length === 1);
    assert.ok(!prepareIdeas(st, { ideas: [{ kind: "decor", title: "x" }] }, "demo", { refine: { mode: "cheaper", ideaId: "nope" } }).ok);
  });
});

// ---------------------------------------------------------------- server with mocked Gemini
describe("server: v6 tools with mocked Gemini", () => {
  test("revise_plan from Gemini becomes one approval card with the trade-offs; the model never computes amounts or dates", async () => {
    const gen = scripted({ functionCalls: [{ id: "c1", name: "revise_plan", args: { budgetChangeRupees: -50000, shift: { amount: 2, unit: "weeks", direction: "earlier" } } }] },
      { text: "Revised: decor and misc give way so catering and the venue stay intact." });
    const r = await handleChat({ messages: user("Our budget dropped by ₹50,000 and the event is 2 weeks earlier"), state: royalWedding, today: TODAY }, { apiKey: KEY, generate: gen });
    assert.equal(r.status, 200);
    const b = body<ChatResponseBody>(r);
    assert.equal(b.mode, "gemini");
    const cards = b.actions.filter(a => a.kind === "batch");
    assert.equal(cards.length, 1);
    const c = cards[0]!;
    assert.ok(c.kind === "batch" && c.tier === 1 && c.explain!.some(l => /to keep Catering and Venue intact/.test(l)));
    if (c.kind === "batch") assert.deepEqual(c.batch.commands[0], { op: "set_event_basics", totalBudgetPaise: 24_50_000_00, startDate: "2027-02-24" });
    const sys = JSON.stringify((gen.sent[0] as { systemInstruction: string }).systemInstruction);
    assert.match(sys, /PRIORITIES: protect catering, venue/);
    assert.match(sys, /revise_plan/);
  });
  test("vendor questions: Gemini's list is shown; a malformed one falls back to the Demo bank; guests get 403", async () => {
    const gen = scripted({ functionCalls: [{ id: "q", name: "suggest_vendor_questions", args: { need: "photographer", questions: ["How many hours does it cover?", "When are photos delivered?", "Is a drone included?"] } }] });
    const r = body<ChatResponseBody>(await handleChat({ messages: user("q"), state: royalWedding, today: TODAY, vendorQuestions: { need: "photographer" } }, { apiKey: KEY, generate: gen }));
    const q = r.actions.find(a => a.kind === "questions");
    assert.ok(q && q.kind === "questions" && q.source === "gemini" && q.questions.length === 3 && q.label === "Photographer & video");
    const bad = body<ChatResponseBody>(await handleChat({ messages: user("q"), state: royalWedding, today: TODAY, vendorQuestions: { need: "photographer" } }, { apiKey: KEY, generate: scripted({ text: "no tool" }) }));
    assert.ok(bad.mode === "offline" && bad.actions.some(a => a.kind === "questions" && a.source === "demo"));
    const forced = body<ChatResponseBody>(await handleChat({ messages: user("q"), state: royalWedding, today: TODAY, forceOffline: true, vendorQuestions: { need: "caterer" } }, { apiKey: KEY, generate: gen }));
    assert.ok(forced.actions.some(a => a.kind === "questions"));
    assert.equal((await handleChat({ messages: user("q"), state: royalWedding, today: TODAY, role: "guest", vendorQuestions: { need: "caterer" } }, { apiKey: KEY, generate: gen })).status, 403);
    assert.equal((await handleChat({ messages: user("q"), state: royalWedding, today: TODAY, vendorQuestions: { need: "idol" } }, { apiKey: KEY, generate: gen })).status, 400);
  });
  test("idea refinement: Gemini gets the source idea; the cards come back linked to it", async () => {
    const st = ok(run(royalWedding, [{ op: "add_ideas", ideas: [{ kind: "decor", title: "Gold mandap", source: "gemini", estLowPaise: 2_00_000_00, estHighPaise: 3_00_000_00, category: "decor" }] }]));
    const src = st.ideas.at(-1)!;
    const gen = scripted({ functionCalls: [{ id: "i", name: "suggest_ideas", args: { ideas: [{ kind: "decor", title: "Marigold mandap", estLowRupees: 60000, estHighRupees: 90000 }] } }] });
    const r = body<ChatResponseBody>(await handleChat({ messages: user("refine"), state: st, today: TODAY, ideas: { refine: { mode: "cheaper", ideaId: src.id } } }, { apiKey: KEY, generate: gen }));
    const a = r.actions.find(x => x.kind === "ideas");
    assert.ok(a && a.kind === "ideas" && a.ideas[0]!.refinedFrom === src.id);
    assert.match(JSON.stringify(gen.sent[0]), /CHEAPER alternatives[\s\S]*Gold mandap/);
    assert.equal((await handleChat({ messages: user("x"), state: st, today: TODAY, ideas: { refine: { mode: "cheaper", ideaId: "nope" } } }, { apiKey: KEY, generate: gen })).status, 400);
  });
  test("the system prompt asks for trade-offs and labelled figures", () => {
    const p = SYSTEM_PROMPT(royalWedding, TODAY);
    assert.match(p, /never cut every category evenly/);
    assert.match(p, /ESTIMATES[\s\S]*QUOTED[\s\S]*COMMITTED/);
    assert.match(p, /VENDOR CHECKLIST SLOTS: venue, caterer/);
  });
});
