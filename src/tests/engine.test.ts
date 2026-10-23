// Run: npm test  (node --import tsx --test src/tests/*.test.ts)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AgentState, EventExt } from "../schema";
import { allocateLargestRemainder, applyBatch, categoryMaxCuttable, checkInvariants, plannedTotal, taskDueDate, derive } from "../commands";
import { initializeEventPlan } from "../blueprint";
import { computePlanInsights } from "../insights";
import { computePlanDiff } from "../diff";
import { batchTier } from "../trust";
import { Batch } from "../commands";
import { royalWedding, arcadeBirthday, culturalFest } from "../presets";
import { TEMPLATES } from "../config/event-templates";
import { blueprintFromPrompt, parseAmountPaise, runOfflineAgent } from "../offline";
import { functionDeclarations } from "../gemini-tools";
import { SAMPLE_QUOTES, parseQuoteText, sampleQuote, scanToActions, visionToScanned } from "../quote-scanner";
import { budgetLedgerCsv, budgetToCsv, runSheetHtml } from "../export";
import { parseStore, serializeStore, freshHistory, defaultStore } from "../persistence";
import { runOfflineGuestAgent } from "../offline";
import { executeAgentTool } from "../agent";
import { matchBudgetItem, DIRECT_EDIT_OPS, GUEST_ALLOWED_OPS, MAX_DIRECT_AMOUNT_PAISE, RENAMEABLE } from "../commands";

const TODAY = "2026-10-20";
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const item = (st: AgentState, id: string) => st.budgetItems.find(b => b.id === id)!;

describe("largest-remainder allocation", () => {
  test("sums exactly and is deterministic", () => {
    const w = [{ id: "a", w: 1 }, { id: "b", w: 1 }, { id: "c", w: 1 }];
    const m = allocateLargestRemainder(100, w);
    assert.equal(sum(m), 100);
    assert.deepEqual([...m.entries()].sort(), [["a", 34], ["b", 33], ["c", 33]]); // tie → smallest id gets the extra paisa
    assert.deepEqual(allocateLargestRemainder(100, w), m);
  });
  test("handles huge totals without float drift (BigInt)", () => {
    const total = 9_007_199_254_740; // ~₹90 thousand crore in paise
    const m = allocateLargestRemainder(total, [{ id: "x", w: 3333 }, { id: "y", w: 3333 }, { id: "z", w: 3334 }]);
    assert.equal(sum(m), total);
  });
  test("random fuzz: always exact, every part within 1 of its quota", () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 300; i++) {
      const total = Math.floor(rnd() * 1e9);
      const ws = Array.from({ length: 1 + Math.floor(rnd() * 12) }, (_, k) => ({ id: `i${k}`, w: 1 + Math.floor(rnd() * 10000) }));
      const W = ws.reduce((a, x) => a + x.w, 0);
      const m = allocateLargestRemainder(total, ws);
      assert.equal(sum(m), total);
      for (const x of ws) assert.ok(Math.abs(m.get(x.id)! - (total * x.w) / W) < 1);
    }
  });
  test("rejects zero / negative weights", () => {
    assert.throws(() => allocateLargestRemainder(10, [{ id: "a", w: 0 }]));
    assert.throws(() => allocateLargestRemainder(10, [{ id: "a", w: -1 }]));
  });
});

describe("slack-proportional cuts", () => {
  test("₹20k decor cut splits by slack, skips locked and fully-committed items", () => {
    const r = applyBatch(royalWedding, { summary: "cut", commands: [{ op: "adjust_budget", category: "decor", deltaPaise: -20_000_00 }] });
    assert.ok(r.ok);
    assert.equal(item(r.state, "b1").plannedPaise, 70_000_00);  // slack 50k
    assert.equal(item(r.state, "b3").plannedPaise, 1_40_000_00); // slack 50k
    assert.equal(item(r.state, "b2").plannedPaise, 60_000_00);  // slack 0 → untouched
    assert.equal(item(r.state, "b4").plannedPaise, 2_00_000_00); // locked
    assert.equal(plannedTotal(royalWedding) - plannedTotal(r.state), 20_000_00);
  });
  test("odd paise cut still sums exactly", () => {
    const r = applyBatch(royalWedding, { summary: "cut", commands: [{ op: "adjust_budget", category: "catering", deltaPaise: -1_234_567 }] });
    assert.ok(r.ok);
    assert.equal(plannedTotal(royalWedding) - plannedTotal(r.state), 1_234_567);
    for (const b of r.state.budgetItems) assert.ok(b.plannedPaise >= b.committedPaise);
  });
  test("locking an item through the reducer protects it from the next cut", () => {
    const locked = applyBatch(royalWedding, { summary: "lock", commands: [{ op: "set_item_lock", budgetItemId: "b3", locked: true }] });
    assert.ok(locked.ok);
    const r = applyBatch(locked.state, { summary: "cut", commands: [{ op: "adjust_budget", category: "decor", deltaPaise: -20_000_00 }] });
    assert.ok(r.ok);
    assert.equal(item(r.state, "b3").plannedPaise, 1_50_000_00);
    assert.equal(item(r.state, "b1").plannedPaise, 60_000_00);
  });
  test("categoryMaxCuttable reports unlocked slack", () => {
    assert.equal(categoryMaxCuttable(royalWedding).decor, 1_00_000_00);
  });
});

describe("structured self-healing rejection", () => {
  test("over-cut rolls back atomically with diagnostics and a verified counter-offer", () => {
    const batch = { summary: "x", commands: [
      { op: "set_task_status", taskId: "k1", status: "done" },
      { op: "adjust_budget", category: "decor", deltaPaise: -1_50_000_00 },
    ] };
    const r = applyBatch(royalWedding, batch);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.state, royalWedding); // untouched, including the task in command #0
    assert.equal(r.failedCommandIndex, 1);
    assert.equal(r.error, r.reason);
    assert.match(r.reason, /₹1,00,000/);
    assert.equal(r.diagnostics.categoryMaxCuttablePaise.decor, 1_00_000_00);
    assert.deepEqual(r.diagnostics.lockedItems, ["Mandap", "Reception florals"]);
    assert.ok(r.suggestion);
    const s = applyBatch(royalWedding, r.suggestion!);
    assert.ok(s.ok);
    assert.equal(plannedTotal(royalWedding) - plannedTotal(s.state), 1_00_000_00);
  });
  test("pre-event moved after main is rejected with valid dates", () => {
    const r = applyBatch(royalWedding, { summary: "x", commands: [{ op: "move_sub_event", subEvent: "haldi", to: { weekday: "monday" } }] });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.failedCommandIndex, 0);
    assert.match(r.reason, /after the main event/);
    assert.deepEqual(r.diagnostics.validDatesForSubEvent, ["2027-03-10", "2027-03-11", "2027-03-12", "2027-03-13", "2027-03-14"]);
    assert.ok(r.suggestion);
    assert.ok(applyBatch(royalWedding, r.suggestion!).ok);
  });
  test("blame points at the right command in a multi-command batch", () => {
    const r = applyBatch(royalWedding, { summary: "x", commands: [
      { op: "adjust_budget", category: "decor", deltaPaise: -10_000_00 },
      { op: "move_sub_event", subEvent: "reception", to: { date: "2027-03-12" } },
    ] });
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.failedCommandIndex, 1); assert.match(r.reason, /Reception would land before/); }
  });
  test("malformed batch reports a schema error, never throws", () => {
    const r = applyBatch(royalWedding, { summary: "x", commands: [{ op: "adjust_budget", category: "decor", deltaPaise: 1.5 }] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.failedCommandIndex, 0);
  });
});

describe("cascading dueOffsetDays", () => {
  test("moving Haldi Thu→Fri moves exactly the Haldi tasks by one day", () => {
    const before = derive(royalWedding, TODAY).tasksWithDates;
    const r = applyBatch(royalWedding, { summary: "mv", commands: [{ op: "move_sub_event", subEvent: "haldi", to: { weekday: "friday" } }] });
    assert.ok(r.ok);
    assert.equal(r.state.subEvents.find(s => s.slug === "haldi")!.date, "2027-03-12");
    for (const t of r.state.tasks) {
      const was = before.find(x => x.id === t.id)!.dueDate;
      const now = taskDueDate(r.state, t);
      if (t.subEventId === "s1") assert.notEqual(now, was); else assert.equal(now, was);
    }
    assert.equal(taskDueDate(r.state, r.state.tasks.find(t => t.id === "k1")!), "2027-02-26");
    const diff = computePlanDiff(royalWedding, r.state);
    assert.equal(diff.cascadedTasks, 2);
    assert.ok(diff.changedIds.includes("k1") && diff.changedIds.includes("k9"));
  });
  test("weekday resolution picks the nearest date inside the window", () => {
    const r = applyBatch(royalWedding, { summary: "mv", commands: [{ op: "move_sub_event", subEvent: "mehendi", to: { weekday: "wednesday" } }] });
    assert.ok(r.ok);
    assert.equal(r.state.subEvents.find(s => s.slug === "mehendi")!.date, "2027-03-10");
  });
});

describe("anchored blocks", () => {
  test("shift_block on an anchored block is refused", () => {
    const r = applyBatch(royalWedding, { summary: "x", commands: [{ op: "shift_block", blockId: "t3", newStartMin: 480 }] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /anchored/);
  });
  test("re-timing a sub-event shifts its blocks but leaves the Muhurtham where it is", () => {
    const r = applyBatch(royalWedding, { summary: "x", commands: [{ op: "move_sub_event", subEvent: "haldi", to: { date: "2027-03-11" }, newStartMin: 660 }] });
    assert.ok(r.ok);
    assert.equal(r.state.timeline.find(b => b.id === "t1")!.startMin, 660);
    const muh = applyBatch(royalWedding, { summary: "x", commands: [{ op: "shift_block", blockId: "t10", newStartMin: 400 }] });
    assert.ok(muh.ok);
    assert.deepEqual(muh.state.timeline.find(b => b.id === "t3"), royalWedding.timeline.find(b => b.id === "t3"));
  });
  test("lane overlap is rejected", () => {
    const r = applyBatch(royalWedding, { summary: "x", commands: [{ op: "shift_block", blockId: "t10", newStartMin: 450 }] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /overlaps/);
  });
});

describe("polymorphic event.ext", () => {
  test("each archetype validates with its own fields and defaults", () => {
    const w = EventExt.parse({ type: "wedding", partners: ["A", "B"] });
    assert.equal(w.type, "wedding"); if (w.type === "wedding") assert.deepEqual(w.traditions, []);
    const b = EventExt.parse({ type: "birthday", honoree: "R", wishlist: [{ id: "w", item: "x" }] });
    if (b.type === "birthday") { assert.equal(b.wishlist[0]!.claimedByGuestId, null); assert.equal(b.wishlist[0]!.priority, "med"); }
    const c = EventExt.parse({ type: "community", permits: [{ id: "p", authority: "GHMC", kind: "Event" }] });
    if (c.type === "community") { assert.equal(c.permits[0]!.status, "not_started"); assert.equal(c.volunteers, 0); }
  });
  test("cross-archetype fields are rejected where types clash", () => {
    assert.equal(EventExt.safeParse({ type: "community", sponsors: [{ id: "s", name: "X", tier: "platinum" }] }).success, false);
    assert.equal(EventExt.safeParse({ type: "party" }).success, false);
    assert.equal(EventExt.safeParse({ type: "birthday", turningAge: 30.5 }).success, false);
  });
  test("archetype commands only run on their archetype", () => {
    assert.equal(applyBatch(royalWedding, { summary: "x", commands: [{ op: "claim_wishlist_item", itemId: "w1", guestId: null }] }).ok, false);
    const c = applyBatch(arcadeBirthday, { summary: "x", commands: [{ op: "claim_wishlist_item", itemId: "w1", guestId: "bg1" }] });
    assert.ok(c.ok);
    if (c.ok && c.state.event.ext.type === "birthday") assert.equal(c.state.event.ext.wishlist[0]!.claimedByGuestId, "bg1");
    const p = applyBatch(culturalFest, { summary: "x", commands: [{ op: "set_permit_status", permitId: "pm1", status: "applied", referenceNo: "GHMC-1" }] });
    assert.ok(p.ok);
    assert.equal(applyBatch(culturalFest, { summary: "x", commands: [{ op: "update_sponsor", sponsorId: "sp2", receivedPaise: 99_00_000_00 }] }).ok, false);
  });
  test("all presets are valid and inside budget", () => {
    for (const t of TEMPLATES) {
      assert.deepEqual(checkInvariants(t.seed), [], t.id);
      assert.ok(plannedTotal(t.seed) <= t.seed.event.totalBudgetPaise, t.id);
      assert.equal(t.seed.event.ext.type, t.seed.event.eventType);
    }
  });
});

describe("initialize_event_plan (cold start)", () => {
  test("weights → exact paise on pass #1, dates resolved from offsets", () => {
    const r = initializeEventPlan({
      title: "Test", eventType: "community", city: "Pune", startDate: "2026-12-04", totalBudgetRupees: 333_333,
      subEvents: [{ name: "Brief", dayOffset: 0, startMin: 600, endMin: 660 }, { name: "Main", dayOffset: 1, startMin: 600, endMin: 1200, isMain: true }],
      budgetLines: [{ category: "venue", label: "A", weightBps: 1 }, { category: "decor", label: "B", weightBps: 1 }, { category: "misc", label: "C", weightBps: 1 }],
      tasks: [{ title: "Permit", dueOffsetDays: -21 }],
      ext: { type: "community", permits: [{ authority: "PMC", kind: "Event", applyByOffsetDays: -14 }], sponsors: [{ name: "S", tier: "gold", pledgedRupees: 50_000 }] },
    });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(plannedTotal(r.state), 333_333_00);
    assert.deepEqual(r.state.budgetItems.map(b => b.plannedPaise), [111_111_00, 111_111_00, 111_111_00]);
    assert.equal(r.state.subEvents.find(s => s.isMain)!.date, "2026-12-05");
    assert.equal(taskDueDate(r.state, r.state.tasks[0]!), "2026-11-14");
    if (r.state.event.ext.type === "community") {
      assert.equal(r.state.event.ext.permits[0]!.applyBy, "2026-11-21");
      assert.equal(r.state.event.ext.sponsors[0]!.pledgedPaise, 50_000_00);
    }
  });
  test("rejects mismatched ext, two mains, unknown sub-event refs", () => {
    const base = { title: "T", eventType: "birthday", startDate: "2026-12-05", totalBudgetRupees: 1000,
      subEvents: [{ name: "Party", dayOffset: 0, startMin: 600, endMin: 700, isMain: true }],
      budgetLines: [{ category: "venue", label: "V", weightBps: 1 }], ext: { type: "birthday" } };
    assert.ok(initializeEventPlan(base).ok);
    assert.equal(initializeEventPlan({ ...base, ext: { type: "wedding" } }).ok, false);
    assert.equal(initializeEventPlan({ ...base, subEvents: [...base.subEvents, { name: "Two", dayOffset: 0, startMin: 800, endMin: 900, isMain: true }] }).ok, false);
    assert.equal(initializeEventPlan({ ...base, budgetLines: [{ category: "venue", label: "V", subEvent: "Nope", weightBps: 1 }] }).ok, false);
  });
  test("offline blueprints for all three flagship prompts are valid and exact", () => {
    for (const p of [
      "Plan a 3-day South Indian wedding in Hyderabad for 300 guests in March 2027 with a ₹25L budget",
      "Plan a 30th retro arcade birthday in Mumbai for ₹1.5L",
      "Plan a neighborhood Diwali mela for 500 people with ₹5L budget",
    ]) {
      const r = initializeEventPlan(blueprintFromPrompt(p, TODAY));
      assert.ok(r.ok, p);
      if (!r.ok) continue;
      assert.equal(plannedTotal(r.state), r.state.event.totalBudgetPaise, p);
      assert.deepEqual(checkInvariants(r.state), []);
    }
    const w = initializeEventPlan(blueprintFromPrompt("Plan a 3-day South Indian wedding in Hyderabad for 300 guests in March 2027 with a ₹25L budget", TODAY));
    assert.ok(w.ok);
    if (w.ok) {
      assert.equal(w.state.event.totalBudgetPaise, 25_00_000_00);
      assert.equal(w.state.event.city, "Hyderabad");
      assert.equal(w.state.event.guestCount, 300);
      assert.ok(w.state.event.startDate.startsWith("2027-03"));
      assert.deepEqual(w.state.subEvents.map(s => s.slug), ["haldi", "mehendi", "sangeet", "muhurtham", "reception"]);
    }
  });
});

describe("insights", () => {
  test("flags overdue deposits, breaches, urgent tasks and RSVPs on the wedding", () => {
    const pi = computePlanInsights(royalWedding, TODAY);
    const kinds = pi.insights.map(i => i.kind);
    assert.ok(kinds.includes("overdue_deposit"));
    assert.ok(kinds.includes("envelope_breach"));
    assert.ok(kinds.includes("urgent_task"));
    assert.ok(kinds.includes("rsvp_pending"));
    assert.equal(pi.insights[0]!.severity, "critical");
  });
  test("recording the payment clears the overdue flag", () => {
    const r = applyBatch(royalWedding, { summary: "pay", commands: [{ op: "record_payment", budgetItemId: "b7", paymentId: "p4", paidDate: TODAY }] });
    assert.ok(r.ok);
    assert.equal(computePlanInsights(r.state, TODAY).insights.filter(i => i.kind === "overdue_deposit").length, 0);
  });
  test("archetype alerts: permits (community) and unclaimed wishes (birthday)", () => {
    assert.ok(computePlanInsights(culturalFest, TODAY).insights.some(i => i.kind === "permit_risk"));
    assert.ok(computePlanInsights(arcadeBirthday, TODAY).insights.some(i => i.kind === "wishlist_unclaimed"));
  });
  test("pure: same input, same output", () => {
    assert.deepEqual(computePlanInsights(culturalFest, TODAY), computePlanInsights(culturalFest, TODAY));
  });
});

describe("trust tiers", () => {
  const tier = (commands: unknown[]) => batchTier(Batch.parse({ summary: "x", commands }).commands);
  test("small/minor changes auto-apply; money ≥ ₹25k, moves and payments need approval", () => {
    assert.equal(tier([{ op: "set_task_status", taskId: "k1", status: "done" }]), 0);
    assert.equal(tier([{ op: "adjust_budget", category: "decor", deltaPaise: -24_999_00 }]), 0);
    assert.equal(tier([{ op: "adjust_budget", category: "decor", deltaPaise: -25_000_00 }]), 1);
    assert.equal(tier([{ op: "move_sub_event", subEvent: "haldi", to: { weekday: "friday" } }]), 1);
    assert.equal(tier([{ op: "record_payment", budgetItemId: "b7", paymentId: "p4", paidDate: TODAY }]), 1);
  });
});

describe("offline demo brain (flagship chips)", () => {
  test("chip 1 → one Tier-1 batch with cut + move + 2 cascaded tasks", () => {
    const r = runOfflineAgent(royalWedding, "Cut ₹20k from decor and move the Haldi to Friday", TODAY);
    const b = r.actions.find(a => a.kind === "batch");
    assert.ok(b && b.kind === "batch");
    assert.equal(b.tier, 1);
    assert.equal(b.batch.commands.length, 2);
    assert.equal(b.diff.cascadedTasks, 2);
  });
  test("chip 2 → rejection + counter-offer of ₹1,00,000", () => {
    const r = runOfflineAgent(royalWedding, "Cut ₹1.5L from decor", TODAY);
    assert.ok(r.actions.some(a => a.kind === "rejection"));
    const c = r.actions.find(a => a.kind === "batch" && a.counterOffer);
    assert.ok(c && c.kind === "batch");
    assert.equal(c.diff.rows.reduce((a, x) => a + (x.deltaPaise ?? 0), 0), -1_00_000_00);
    assert.match(r.reply, /₹1,00,000/);
  });
  test("chip 3 → phase invariant rejection", () => {
    const r = runOfflineAgent(royalWedding, "Move the Haldi to Monday", TODAY);
    const rj = r.actions.find(a => a.kind === "rejection");
    assert.ok(rj && rj.kind === "rejection");
    assert.match(rj.rejection.reason, /after the main event/);
  });
  test("chip 4 → insights", () => {
    const r = runOfflineAgent(royalWedding, "Which vendor deposits are overdue and what tasks are urgent?", TODAY);
    assert.ok(r.actions.some(a => a.kind === "insights"));
    assert.match(r.reply, /Muhurtham lunch/);
  });
  test("chip 5 → birthday blueprint", () => {
    const r = runOfflineAgent(royalWedding, "Switch to a 30th Retro Arcade Birthday for ₹1.5L", TODAY);
    const i = r.actions.find(a => a.kind === "init");
    assert.ok(i && i.kind === "init");
    assert.equal(i.plan.event.ext.type, "birthday");
    assert.equal(i.plan.event.totalBudgetPaise, 1_50_000_00);
    if (i.plan.event.ext.type === "birthday") assert.equal(i.plan.event.ext.turningAge, 30);
  });
  test("amount parsing", () => {
    assert.equal(parseAmountPaise("₹20k"), 20_000_00);
    assert.equal(parseAmountPaise("1.5L"), 1_50_000_00);
    assert.equal(parseAmountPaise("₹25,000"), 25_000_00);
    assert.equal(parseAmountPaise("2 crore"), 2_00_00_000_00);
  });
});

test("Gemini declarations are generated from Zod and Gemini-safe", () => {
  const names = functionDeclarations.map(f => f.name);
  assert.deepEqual(names, ["apply_plan_changes", "get_plan_snapshot", "initialize_event_plan", "get_plan_insights", "draft_outbound_message", "suggest_ideas", "revise_plan", "suggest_vendor_questions"]);
  const json = JSON.stringify(functionDeclarations);
  assert.ok(!json.includes('"$schema"'));
  assert.ok(!json.includes('"oneOf"'));
  assert.ok(!json.includes('"const"'));
  assert.ok(!json.includes('"prefixItems"') && !json.includes('"exclusiveMinimum"'));
});

// ======================= Phases 5–7 =======================

describe("upsert_vendor_quote", () => {
  const quote = { op: "upsert_vendor_quote", vendorName: "Royal Deccan Caterers", category: "catering", itemLabel: "Muhurtham wedding lunch",
    quotedPaise: 4_80_000_00, depositRequiredPaise: 2_40_000_00, dueAt: "2026-10-26", receivedOn: TODAY, notes: "Corkage 25%", redFlags: ["⚠️ Corkage 25%"] };
  test("fuzzy-matches the existing line, records the quote, vendor and deposit", () => {
    assert.equal(matchBudgetItem(royalWedding, "catering", "Muhurtham wedding lunch", null)?.id, "b7");
    const r = applyBatch(royalWedding, { summary: "q", commands: [quote] });
    assert.ok(r.ok);
    if (!r.ok) return;
    const b7 = item(r.state, "b7");
    assert.equal(b7.quotedPaise, 4_80_000_00);
    assert.equal(b7.plannedPaise, 4_50_000_00); // the envelope is NOT silently raised
    assert.deepEqual(b7.quoteRedFlags, ["⚠️ Corkage 25%"]);
    assert.equal(b7.payments.find(p => p.id === "p4")!.amountPaise, 2_40_000_00);
    const v = r.state.vendors.find(x => x.name === "Royal Deccan Caterers");
    assert.ok(v);
    assert.equal(v!.quotes[0]!.amountPaise, 4_80_000_00);
    assert.equal(plannedTotal(r.state), plannedTotal(royalWedding));
  });
  test("insights flag the envelope breach with the gap and where to cover it", () => {
    const r = applyBatch(royalWedding, { summary: "q", commands: [quote] });
    assert.ok(r.ok);
    if (!r.ok) return;
    const breach = computePlanInsights(r.state, TODAY).insights.find(i => i.id === "breach:q:b7");
    assert.ok(breach);
    assert.equal(breach!.amountPaise, 30_000_00);
    assert.match(breach!.detail, /exceeds planned ₹4,50,000 by ₹30,000/);
    assert.ok(breach!.coverFrom!.length > 0);
    assert.ok(breach!.coverFrom!.every(c => c.category !== "catering" && c.cuttablePaise > 0));
  });
  test("an unknown line becomes a new budget item at ₹0 planned (breach, not silent spend)", () => {
    const r = applyBatch(royalWedding, { summary: "q", commands: [{ op: "upsert_vendor_quote", vendorName: "Sky Lanterns Co", category: "entertainment", itemLabel: "Lantern release", quotedPaise: 15_000_00 }] });
    assert.ok(r.ok);
    if (!r.ok) return;
    const n = r.state.budgetItems.find(b => b.label === "Lantern release")!;
    assert.equal(n.plannedPaise, 0);
    assert.equal(n.vendorId, r.state.vendors.find(v => v.name === "Sky Lanterns Co")!.id);
    assert.ok(computePlanInsights(r.state, TODAY).insights.some(i => i.id === `breach:q:${n.id}`));
    assert.equal(applyBatch(r.state, { summary: "again", commands: [{ op: "upsert_vendor_quote", vendorName: "Sky Lanterns Co", category: "entertainment", itemLabel: "Lantern release", quotedPaise: 12_000_00 }] }).ok, true);
  });
  test("always Tier 1 with a before/after diff", () => {
    assert.equal(batchTier(Batch.parse({ summary: "q", commands: [{ ...quote, quotedPaise: 100 }] }).commands), 1);
    const r = applyBatch(royalWedding, { summary: "q", commands: [quote] });
    assert.ok(r.ok);
    if (!r.ok) return;
    const d = computePlanDiff(royalWedding, r.state);
    const row = d.rows.find(x => x.kind === "quote")!;
    assert.equal(row.before, "No quote");
    assert.equal(row.after, "₹4,80,000");
    assert.match(row.note!, /by ₹30,000/);
    assert.ok(d.rows.some(x => x.kind === "vendor") && d.rows.some(x => x.kind === "payment"));
  });
});

describe("quote scanner", () => {
  test("deterministic sample parsing (all three samples, aliases by archetype)", () => {
    const q = sampleQuote("royal-caterer-quote", TODAY)!;
    assert.equal(q.vendorName, "Deccan Royal Caterers");
    assert.equal(q.category, "catering");
    assert.equal(q.budgetItemId, "b8");
    assert.equal(q.quotedPaise, 1_85_000_00);
    assert.equal(q.depositRequiredPaise, 50_000_00);
    assert.equal(q.dueAt, "2026-10-25");
    assert.deepEqual(q.redFlags, ["⚠️ 25% non-refundable deposit", "⚠️ ₹15,000/hr overtime after 11:30 PM", "⚠️ Generator backup billed extra"]);
    assert.deepEqual(sampleQuote("wedding", TODAY), q);
    const a = sampleQuote("birthday", TODAY)!;
    assert.deepEqual([a.vendorName, a.category, a.quotedPaise, a.budgetItemId], ["Bandra Arcade Rentals", "entertainment", 26_000_00, "bb4"]);
    const c = sampleQuote("community", TODAY)!;
    assert.deepEqual([c.vendorName, c.category, c.quotedPaise, c.budgetItemId], ["Telangana Pro Audio & Truss", "decor", 1_45_000_00, "cb3"]);
    assert.ok(c.redFlags.includes("⚠️ 100% advance 7 days before event"));
    // the raw text parser is pure and finds the same numbers
    const raw = parseQuoteText(SAMPLE_QUOTES[0].text, TODAY);
    assert.deepEqual([raw.quotedPaise, raw.depositRequiredPaise, raw.dueAt], [1_85_000_00, 50_000_00, "2026-10-25"]);
    assert.equal(sampleQuote("nope", TODAY), null);
  });
  test("each sample hits its target line with the exact envelope breach", () => {
    const want: [string, number][] = [["b8", 35_000_00], ["bb4", 6_000_00], ["cb3", 25_000_00]];
    for (const [i, s] of SAMPLE_QUOTES.entries()) {
      const plan = TEMPLATES[i]!.seed; // frozen: also proves the reducer never mutates its input
      const b = scanToActions(sampleQuote(s.id, TODAY)!, plan, TODAY).actions.find(x => x.kind === "batch");
      assert.ok(b && b.kind === "batch", s.id);
      assert.equal(b.tier, 1);
      assert.ok(b.log.some(l => l.startsWith("⚠ Quote exceeds planned envelope by")));
      const r = applyBatch(plan, b.batch);
      assert.ok(r.ok);
      if (!r.ok) continue;
      const [id, gap] = want[i]!;
      assert.equal(computePlanInsights(r.state, TODAY).insights.find(x => x.id === `breach:q:${id}`)?.amountPaise, gap, s.id);
    }
  });
  test("vision output is converted deterministically (rupees → paise, 'within N days' → date)", () => {
    const q = visionToScanned({ vendorName: " X ", category: "decor", itemLabel: "Stage", quotedRupees: 1450.5, depositRupees: 400,
      depositDueInDays: 7, redFlags: ["⚠️ Overtime"], summary: "s" }, TODAY);
    assert.deepEqual([q.vendorName, q.quotedPaise, q.depositRequiredPaise, q.dueAt], ["X", 145050, 40000, "2026-10-27"]);
  });
});

describe("guest mode permission boundary", () => {
  test("reducer blocks budget and schedule ops for guests, allows RSVP", () => {
    for (const c of [
      { op: "adjust_budget", category: "decor", deltaPaise: -100 },
      { op: "move_sub_event", subEvent: "haldi", to: { weekday: "friday" } },
      { op: "set_item_lock", budgetItemId: "b1", locked: true },
      { op: "upsert_vendor_quote", vendorName: "X", category: "decor", itemLabel: "Y", quotedPaise: 1 },
    ]) {
      const r = applyBatch(royalWedding, { summary: "x", commands: [{ op: "set_rsvp", guestId: "g1", subEvent: "haldi", answer: "no" }, c] }, { role: "guest" });
      assert.equal(r.ok, false, c.op);
      if (!r.ok) { assert.equal(r.failedCommandIndex, 1); assert.match(r.reason, /Guest Concierge Mode is read-only for budgets and schedules/); assert.equal(r.suggestion, undefined); }
    }
    const ok = applyBatch(royalWedding, { summary: "x", commands: [{ op: "set_rsvp", guestId: "g13", subEvent: "sangeet", answer: "yes" }] }, { role: "guest" });
    assert.ok(ok.ok);
    assert.ok(applyBatch(royalWedding, { summary: "x", commands: [{ op: "adjust_budget", category: "decor", deltaPaise: -100 }] }).ok); // organizer default
  });
  test("guests can't self-invite or steal a claimed gift", () => {
    const r = applyBatch(royalWedding, { summary: "x", commands: [{ op: "set_rsvp", guestId: "g10", subEvent: "haldi", answer: "yes" }] }, { role: "guest" });
    assert.equal(r.ok, false);
    const steal = applyBatch(arcadeBirthday, { summary: "x", commands: [{ op: "claim_wishlist_item", itemId: "w2", guestId: "bg1" }] }, { role: "guest" });
    assert.equal(steal.ok, false);
    assert.ok(applyBatch(arcadeBirthday, { summary: "x", commands: [{ op: "claim_wishlist_item", itemId: "w2", guestId: "bg1" }] }).ok); // organizer can reassign
  });
  test("guest tools are limited at the executor too", () => {
    assert.equal(executeAgentTool("initialize_event_plan", {}, royalWedding, TODAY, "guest").response.ok, false);
    assert.equal(executeAgentTool("get_plan_insights", {}, royalWedding, TODAY, "guest").response.ok, false);
  });
  test("offline concierge: Sharma household RSVP with 2 Jain meals, as one guest-safe batch", () => {
    const r = runOfflineGuestAgent(royalWedding, "Mark the Sharma household as attending Haldi and Reception with 2 Jain meals", TODAY, "g1");
    const b = r.actions.find(a => a.kind === "batch");
    assert.ok(b && b.kind === "batch");
    assert.equal(b.tier, 0);
    const res = applyBatch(royalWedding, b.batch, { role: "guest" });
    assert.ok(res.ok);
    if (!res.ok) return;
    const sharma = res.state.guests.filter(g => g.householdId === "h3");
    assert.ok(sharma.every(g => g.rsvp.s1 === "yes" && g.rsvp.s5 === "yes"));
    assert.equal(sharma.filter(g => g.diet.includes("jain")).length, 2);
  });
  test("offline concierge answers schedule questions and refuses money talk via the boundary", () => {
    assert.match(runOfflineGuestAgent(royalWedding, "What time is the Sangeet and what's the dress code?", TODAY, "g1").reply, /7:00 PM.*Indo-western/);
    const cut = runOfflineGuestAgent(royalWedding, "Cut ₹20k from decor", TODAY, "g1");
    assert.ok(cut.actions.some(a => a.kind === "rejection"));
    const claim = runOfflineGuestAgent(arcadeBirthday, "Claim the Retro Polaroid Camera from the birthday wishlist.", TODAY, "bg3");
    assert.ok(claim.actions.some(a => a.kind === "batch"));
    const vol = runOfflineGuestAgent(culturalFest, "Sign Ravi Kumar up to volunteer for the Cultural Night", TODAY, null);
    const vb = vol.actions.find(a => a.kind === "batch");
    assert.ok(vb && vb.kind === "batch");
    const after = applyBatch(culturalFest, vb.batch, { role: "guest" });
    assert.ok(after.ok);
    if (after.ok && after.state.event.ext.type === "community") {
      assert.equal(after.state.event.ext.volunteerSignups[0]!.subEventId, "cs3");
      assert.equal(after.state.event.ext.volunteers, 41);
    }
  });
});

describe("exports", () => {
  test("budgetToCsv: header, quoting, 2-decimal rupees, lock-aware slack, totals", () => {
    const csv = budgetToCsv(royalWedding);
    const lines = csv.trimEnd().split("\r\n");
    assert.equal(lines[0], "ID,Category,Item,SubEvent,PlannedINR,QuotedINR,CommittedINR,PaidINR,CuttableSlackINR,Locked,Vendor");
    assert.equal(lines.length, royalWedding.budgetItems.length + 2);
    assert.ok(lines.includes("b6,venue,N Convention hall (2 days),Muhurtham,380000.00,,380000.00,150000.00,0.00,No,N Convention"));
    assert.ok(lines.includes("b1,decor,Haldi marigold decor,Haldi,80000.00,,30000.00,0.00,50000.00,No,Petals & Pillars Decor"));
    // b5 has ₹70,000 of planned-over-committed, but it's locked, so nothing is cuttable
    assert.ok(lines.includes("b5,decor,Reception florals,Reception,120000.00,,50000.00,0.00,0.00,Yes,Petals & Pillars Decor"));
    const fest = budgetToCsv(culturalFest);
    assert.ok(fest.includes('"Stage, truss & lighting"') && fest.includes('"Tents, chairs & sanitation"'));
    const total = lines[lines.length - 1]!.split(",");
    assert.equal(total[0], "TOTAL");
    assert.equal(total[4], (plannedTotal(royalWedding) / 100).toFixed(2));
    assert.equal(budgetToCsv, budgetLedgerCsv);
  });
  test("run sheet: every sub-event, HH:MM blocks, anchored badge, escaped text", () => {
    const html = runSheetHtml(royalWedding, TODAY);
    for (const s of royalWedding.subEvents) assert.ok(html.includes(`>${s.name} <span`), s.name);
    assert.ok(html.includes("7:50 AM") && html.includes("⚓ ANCHORED"));
    assert.ok(html.includes("Urgent tasks") && html.includes("Book Muhurtham purohit"));
    const evil = AgentState.parse({ ...royalWedding, event: { ...royalWedding.event, title: "<script>x</script>" } });
    assert.ok(!runSheetHtml(evil, TODAY).includes("<script>x"));
  });
});

describe("persistence", () => {
  test("round-trips per-archetype histories and rejects corrupt data", () => {
    const s = defaultStore();
    s.byType.birthday = freshHistory("birthday");
    s.active = "birthday";
    const back = parseStore(serializeStore(s));
    assert.equal(back.active, "birthday");
    assert.equal(back.byType.birthday!.snaps[0]!.plan.event.id, arcadeBirthday.event.id);
    assert.equal(parseStore("{nope").active, "wedding");
    assert.equal(parseStore(JSON.stringify({ v: 1, active: "birthday", byType: { birthday: { snaps: [{ plan: { junk: true } }], idx: 0 } } })).byType.birthday!.snaps[0]!.plan.event.id, arcadeBirthday.event.id);
  });
});

describe("bug fixes (round 3)", () => {
  test("top-up on a fully locked category succeeds; cuts still can't touch locks", () => {
    let st = royalWedding;
    for (const b of st.budgetItems.filter(x => x.category === "attire")) {
      const r = applyBatch(st, { summary: "lock", commands: [{ op: "set_item_lock", budgetItemId: b.id, locked: true }] });
      assert.ok(r.ok); if (r.ok) st = r.state;
    }
    const attire = st.budgetItems.filter(x => x.category === "attire");
    assert.ok(attire.length > 0 && attire.every(b => b.locked));
    const largest = [...attire].sort((a, b) => b.plannedPaise - a.plannedPaise || a.id.localeCompare(b.id))[0]!;
    const up = applyBatch(st, { summary: "top up", commands: [{ op: "adjust_budget", category: "attire", deltaPaise: 5_000_00 }] });
    assert.ok(up.ok);
    if (up.ok) assert.equal(item(up.state, largest.id).plannedPaise, largest.plannedPaise + 5_000_00);
    const cut = applyBatch(st, { summary: "cut", commands: [{ op: "adjust_budget", category: "attire", deltaPaise: -5_000_00 }] });
    assert.equal(cut.ok, false);
  });
  test("computePlanDiff records quote changes, new lines and new payments", () => {
    const r1 = applyBatch(royalWedding, { summary: "q", commands: [{ op: "upsert_vendor_quote", budgetItemId: "b8", vendorName: "Deccan Royal Caterers", category: "catering",
      itemLabel: "Sangeet dinner", quotedPaise: 1_85_000_00, depositRequiredPaise: 50_000_00, depositDueDate: "2026-10-25" }] });
    assert.ok(r1.ok); if (!r1.ok) return;
    const d1 = computePlanDiff(royalWedding, r1.state);
    const q = d1.rows.find(x => x.kind === "quote" && x.id === "b8")!;
    assert.deepEqual([q.before, q.after], ["No quote", "₹1,85,000"]);
    assert.match(q.note!, /⚠ exceeds planned ₹1,50,000 by ₹35,000/);
    assert.ok(d1.rows.some(x => x.kind === "payment" && x.before === "—" && x.after === "₹50,000 due 2026-10-25"));
    const r2 = applyBatch(r1.state, { summary: "q2", commands: [{ op: "upsert_vendor_quote", budgetItemId: "b8", vendorName: "Deccan Royal Caterers", category: "catering", itemLabel: "x", quotedPaise: 1_40_000_00 }] });
    assert.ok(r2.ok); if (!r2.ok) return;
    const q2 = computePlanDiff(r1.state, r2.state).rows.find(x => x.kind === "quote")!;
    assert.deepEqual([q2.before, q2.after], ["₹1,85,000", "₹1,40,000"]);
    assert.match(q2.note!, /within planned/);
    assert.equal(r2.state.vendors.filter(v => v.name === "Deccan Royal Caterers").length, 1); // vendor upserted, not duplicated
    assert.equal(r2.state.vendors.find(v => v.name === "Deccan Royal Caterers")!.quotes.length, 2);
  });
  test("budgetItemId targets a line directly; an unknown id is rejected atomically", () => {
    const bad = applyBatch(royalWedding, { summary: "q", commands: [{ op: "upsert_vendor_quote", budgetItemId: "zzz", vendorName: "X", category: "decor", itemLabel: "Y", quotedPaise: 1 }] });
    assert.equal(bad.ok, false);
    assert.equal(bad.state, royalWedding);
  });
});

describe("Gemini retry", () => {
  test("retries 503s, falls through to a fallback model, never retries a 4xx", async () => {
    const { withGeminiRetry, isTransientGeminiError } = await import("../gemini-model");
    const prev = process.env.GEMINI_FALLBACK_MODELS;
    process.env.GEMINI_FALLBACK_MODELS = "backup-model";
    try {
      const seen: string[] = [];
      const out = await withGeminiRetry(async m => { seen.push(m); if (m !== "backup-model") throw new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}'); return "ok"; }, { delaysMs: [1, 1] });
      assert.equal(out, "ok");
      assert.equal(seen.length, 4); // 3 tries on the primary, then the fallback
      let calls = 0;
      await assert.rejects(withGeminiRetry(async () => { calls++; throw new Error('{"error":{"code":404}}'); }, { delaysMs: [1, 1] }));
      assert.equal(calls, 1);
      assert.equal(isTransientGeminiError(new Error("This model is currently experiencing high demand")), true);
      assert.equal(isTransientGeminiError(new Error('{"error":{"code":504,"message":"Deadline expired before operation could complete.","status":"DEADLINE_EXCEEDED"}}')), true);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_FALLBACK_MODELS; else process.env.GEMINI_FALLBACK_MODELS = prev;
    }
  });
});

describe("Gemini model selection", () => {
  test("defaults to gemini-3.5-flash-lite; GEMINI_MODEL and GEMINI_FALLBACK_MODELS still override", async () => {
    const { DEFAULT_GEMINI_MODEL, geminiModel, geminiModels } = await import("../gemini-model");
    const prev = { m: process.env.GEMINI_MODEL, f: process.env.GEMINI_FALLBACK_MODELS };
    try {
      delete process.env.GEMINI_MODEL; delete process.env.GEMINI_FALLBACK_MODELS;
      assert.equal(DEFAULT_GEMINI_MODEL, "gemini-3.5-flash-lite");
      assert.equal(geminiModel(), "gemini-3.5-flash-lite");
      assert.deepEqual(geminiModels(), ["gemini-3.5-flash-lite"]);
      process.env.GEMINI_MODEL = "  "; // blank override falls back to the default
      assert.equal(geminiModel(), "gemini-3.5-flash-lite");
      process.env.GEMINI_MODEL = "gemini-3.8-flash";
      process.env.GEMINI_FALLBACK_MODELS = "gemini-3.1-flash-lite, gemini-3.8-flash";
      assert.deepEqual(geminiModels(), ["gemini-3.8-flash", "gemini-3.1-flash-lite"]);
    } finally {
      if (prev.m === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = prev.m;
      if (prev.f === undefined) delete process.env.GEMINI_FALLBACK_MODELS; else process.env.GEMINI_FALLBACK_MODELS = prev.f;
    }
  });
});

describe("Gemini latency settings", () => {
  test("thinking level defaults to LOW, accepts the four levels, and 'default' sends nothing", async () => {
    const { geminiThinkingLevel, geminiTimeoutMs } = await import("../gemini-model");
    const prev = { t: process.env.GEMINI_THINKING_LEVEL, m: process.env.GEMINI_TIMEOUT_MS };
    try {
      delete process.env.GEMINI_THINKING_LEVEL;
      assert.equal(geminiThinkingLevel(), "LOW");
      process.env.GEMINI_THINKING_LEVEL = "minimal"; assert.equal(geminiThinkingLevel(), "MINIMAL");
      process.env.GEMINI_THINKING_LEVEL = "HIGH"; assert.equal(geminiThinkingLevel(), "HIGH");
      process.env.GEMINI_THINKING_LEVEL = "default"; assert.equal(geminiThinkingLevel(), undefined);
      process.env.GEMINI_THINKING_LEVEL = "nonsense"; assert.equal(geminiThinkingLevel(), "LOW");
      delete process.env.GEMINI_TIMEOUT_MS;
      assert.equal(geminiTimeoutMs(30_000, 45_000), 30_000);
      process.env.GEMINI_TIMEOUT_MS = "40000"; assert.equal(geminiTimeoutMs(30_000, 45_000), 40_000);
      process.env.GEMINI_TIMEOUT_MS = "999999"; assert.equal(geminiTimeoutMs(30_000, 45_000), 45_000);
      process.env.GEMINI_TIMEOUT_MS = "10"; assert.equal(geminiTimeoutMs(30_000, 45_000), 5_000);
      process.env.GEMINI_TIMEOUT_MS = "abc"; assert.equal(geminiTimeoutMs(30_000, 45_000), 30_000);
    } finally {
      if (prev.t === undefined) delete process.env.GEMINI_THINKING_LEVEL; else process.env.GEMINI_THINKING_LEVEL = prev.t;
      if (prev.m === undefined) delete process.env.GEMINI_TIMEOUT_MS; else process.env.GEMINI_TIMEOUT_MS = prev.m;
    }
  });

  test("a 400 about thinking config is recognised so the call is retried without it", async () => {
    const { isThinkingConfigRejected } = await import("../server/gemini-client");
    assert.equal(isThinkingConfigRejected(new Error('{"error":{"code":400,"message":"Thinking level is not supported for this model."}}')), true);
    assert.equal(isThinkingConfigRejected(new Error('{"error":{"code":400,"message":"Invalid argument"}}')), false);
    assert.equal(isThinkingConfigRejected(new Error('{"error":{"code":503,"message":"thinking too hard"}}')), false);
  });
});

// ---------- direct edits (inline editing in the organizer UI) ----------
describe("direct-edit ops: renames and planned amounts", () => {
  const ui = { source: "ui" } as const;
  const run = (commands: unknown[], opts: Parameters<typeof applyBatch>[2] = ui, st = royalWedding) => applyBatch(st, { summary: "edit", commands }, opts);
  const DIRECT = [
    { op: "rename_event", title: "Arjun weds Meera" },
    { op: "set_partner_names", partners: ["Arjun", "Meera R."] },
    { op: "rename_entity", kind: "budget_item", id: "b1", name: "Haldi flowers" },
    { op: "set_planned_amount", budgetItemId: "b1", plannedPaise: 9_000_000, expectedPaise: 8_000_000 },
  ];

  test("each rename lands on exactly one field and leaves ids, slugs and money alone", () => {
    const cases: [unknown, (s: AgentState) => unknown, unknown][] = [
      [{ op: "rename_event", title: "  Arjun weds Meera  " }, s => s.event.title, "Arjun weds Meera"],
      [{ op: "set_partner_names", partners: ["Arjun", "Meera R."] }, s => s.event.ext.type === "wedding" && s.event.ext.partners, ["Arjun", "Meera R."]],
      [{ op: "rename_entity", kind: "budget_item", id: "b1", name: "Haldi flowers" }, s => s.budgetItems.find(b => b.id === "b1")!.label, "Haldi flowers"],
      [{ op: "rename_entity", kind: "task", id: royalWedding.tasks[0]!.id, name: "Book the priest" }, s => s.tasks[0]!.title, "Book the priest"],
      [{ op: "rename_entity", kind: "sub_event", id: "s1", name: "Pasupu" }, s => [s.subEvents[0]!.name, s.subEvents[0]!.slug], ["Pasupu", "haldi"]],
      [{ op: "rename_entity", kind: "guest", id: "g1", name: "Lakshmi Rao" }, s => s.guests.find(g => g.id === "g1")!.name, "Lakshmi Rao"],
      [{ op: "rename_entity", kind: "household", id: "h3", name: "Sharma-Verma family" }, s => s.households.find(h => h.id === "h3")!.label, "Sharma-Verma family"],
      [{ op: "rename_entity", kind: "vendor", id: "v5", name: "DJ Nikhil & Co" }, s => s.vendors.find(v => v.id === "v5")!.name, "DJ Nikhil & Co"],
    ];
    for (const [cmd, read, want] of cases) {
      const r = run([cmd]);
      assert.ok(r.ok, JSON.stringify(cmd) + (r.ok ? "" : r.reason));
      assert.deepEqual(read(r.state), want);
      assert.equal(plannedTotal(r.state), plannedTotal(royalWedding));
      assert.equal(r.state.subEvents.map(s => s.slug).join(), royalWedding.subEvents.map(s => s.slug).join());
    }
    // A renamed sub-event is still found by its slug (judge prompts, links and RSVP keys keep working).
    const renamed = run([{ op: "rename_entity", kind: "sub_event", id: "s1", name: "Pasupu" }]);
    assert.ok(renamed.ok);
    assert.ok(applyBatch(renamed.state, { summary: "x", commands: [{ op: "move_sub_event", subEvent: "haldi", to: { weekday: "friday" } }] }).ok);
  });

  test("names are validated by Zod: trimmed, non-empty, at most 120 characters", () => {
    for (const name of ["", "   ", "x".repeat(121)]) {
      const r = run([{ op: "rename_entity", kind: "task", id: royalWedding.tasks[0]!.id, name }]);
      assert.equal(r.ok, false, JSON.stringify(name));
    }
    assert.ok(run([{ op: "rename_entity", kind: "task", id: royalWedding.tasks[0]!.id, name: "x".repeat(120) }]).ok);
    assert.equal(run([{ op: "rename_entity", kind: "plan", id: "b1", name: "x" }]).ok, false);
    assert.equal(run([{ op: "rename_entity", kind: "guest", id: "nope", name: "x" }]).ok, false);
    assert.equal(run([{ op: "set_partner_names", partners: ["Asha", "Ravi"] }], ui, arcadeBirthday).ok, false); // not a wedding
  });

  test("renames that would make lookups ambiguous are refused", () => {
    const dupSub = run([{ op: "rename_entity", kind: "sub_event", id: "s1", name: "sangeet" }]);
    assert.ok(!dupSub.ok && /already called "Sangeet"/.test(dupSub.reason));
    const dupVendor = run([{ op: "rename_entity", kind: "vendor", id: "v5", name: "n convention" }]);
    assert.ok(!dupVendor.ok && /already called "N Convention"/.test(dupVendor.reason));
    assert.ok(run([{ op: "rename_entity", kind: "sub_event", id: "s1", name: "HALDI" }]).ok); // its own name in another case is fine
  });

  test("planned amount: integer paise, non-negative, capped at ₹100 crore, never below committed, locks block cuts only", () => {
    const set = (id: string, plannedPaise: unknown, expectedPaise: unknown) => run([{ op: "set_planned_amount", budgetItemId: id, plannedPaise, expectedPaise }]);
    const up = set("b1", 9_000_000, 8_000_000);
    assert.ok(up.ok);
    assert.equal(up.state.budgetItems.find(b => b.id === "b1")!.plannedPaise, 9_000_000);
    assert.equal(plannedTotal(up.state) - plannedTotal(royalWedding), 1_000_000);
    assert.deepEqual(up.log, ["Haldi marigold decor: planned ₹80,000 → ₹90,000"]);
    for (const bad of [-1, 1.5, "100", MAX_DIRECT_AMOUNT_PAISE + 1, Number.NaN]) assert.equal(set("b1", bad, 8_000_000).ok, false, String(bad));
    assert.ok(set("b12", MAX_DIRECT_AMOUNT_PAISE, 4_000_000).ok); // the cap itself is allowed (and flags over-budget in the log)
    const belowCommitted = set("b1", 2_000_000, 8_000_000);
    assert.ok(!belowCommitted.ok && /below the ₹30,000 already committed/.test(belowCommitted.reason));
    assert.ok(set("b1", 3_000_000, 8_000_000).ok); // exactly committed is fine
    const lockedCut = set("b5", 11_000_000, 12_000_000);
    assert.ok(!lockedCut.ok && /locked/.test(lockedCut.reason));
    assert.ok(set("b5", 13_000_000, 12_000_000).ok); // a top-up on a locked line still lands, as with adjust_budget
    const stale = set("b1", 9_000_000, 7_000_000);
    assert.ok(!stale.ok && /changed while you were editing: it is now ₹80,000/.test(stale.reason));
    assert.equal(set("nope", 1, 1).ok, false);
    assert.ok(set("b1", 8_000_000, 8_000_000).ok); // unchanged is a no-op, not an error
  });

  test("organizer-only: the guest role is refused every direct edit (the allowlist doesn't grow)", () => {
    for (const c of DIRECT) {
      assert.ok(!GUEST_ALLOWED_OPS.has(c.op as never), c.op);
      for (const opts of [{ role: "guest" as const }, { role: "guest" as const, source: "ui" as const }]) {
        const r = run([{ op: "set_rsvp", guestId: "g13", subEvent: "sangeet", answer: "yes" }, c], opts);
        assert.equal(r.ok, false, c.op);
        if (!r.ok) { assert.equal(r.failedCommandIndex, 1); assert.match(r.reason, /Guest Concierge Mode is read-only/); }
      }
    }
    assert.deepEqual([...GUEST_ALLOWED_OPS].sort(), ["claim_wishlist_item", "community_signup", "set_guest_diet", "set_rsvp"]);
  });

  test("never from the AI: refused without source 'ui', absent from the Gemini declaration and the agent executor", () => {
    for (const c of DIRECT) {
      const r = run([c], {});
      assert.ok(!r.ok && /direct edit: only the organiser's own controls/.test(r.reason), c.op);
      assert.equal(run([c], { role: "organizer", source: "agent" }).ok, false);
      assert.ok(run([c]).ok, c.op);
      const viaTool = executeAgentTool("apply_plan_changes", { summary: "x", commands: [c] }, royalWedding, TODAY, "organizer");
      assert.equal(viaTool.response.ok, false, c.op);
      assert.equal(viaTool.working, royalWedding);
    }
    const declared = JSON.stringify(functionDeclarations.find(f => f.name === "apply_plan_changes")!.parametersJsonSchema);
    for (const op of DIRECT_EDIT_OPS) assert.ok(!declared.includes(op), op);
    assert.ok(declared.includes("adjust_budget") && declared.includes("set_sub_event_visibility"));
  });

  test("trust tiers: renames are Tier 0; a planned amount follows the ₹25,000 adjust_budget rule", () => {
    const tier = (c: unknown) => batchTier(Batch.parse({ summary: "x", commands: [c] }).commands);
    assert.equal(tier({ op: "rename_event", title: "x" }), 0);
    assert.equal(tier({ op: "set_partner_names", partners: ["a", "b"] }), 0);
    for (const kind of RENAMEABLE) assert.equal(tier({ op: "rename_entity", kind, id: "x", name: "y" }), 0, kind);
    assert.equal(tier({ op: "set_planned_amount", budgetItemId: "b1", plannedPaise: 8_000_000 + 2_499_999, expectedPaise: 8_000_000 }), 0);
    assert.equal(tier({ op: "set_planned_amount", budgetItemId: "b1", plannedPaise: 8_000_000 + 2_500_000, expectedPaise: 8_000_000 }), 1);
    assert.equal(tier({ op: "set_planned_amount", budgetItemId: "b1", plannedPaise: 5_500_000, expectedPaise: 8_000_000 }), 1);
    assert.equal(tier({ op: "adjust_budget", category: "decor", deltaPaise: -2_500_000 }), 1); // unchanged
  });

  test("existing ops behave exactly as before when the source is 'ui'", () => {
    const b = { summary: "Cut ₹20k from decor and move the Haldi to Friday", commands: [
      { op: "adjust_budget", category: "decor", deltaPaise: -2_000_000 }, { op: "move_sub_event", subEvent: "haldi", to: { weekday: "friday" } }] };
    assert.deepEqual(applyBatch(royalWedding, b, ui), applyBatch(royalWedding, b));
    const over = { summary: "x", commands: [{ op: "adjust_budget", category: "decor", deltaPaise: -15_000_000 }] };
    assert.deepEqual(applyBatch(royalWedding, over, ui), applyBatch(royalWedding, over));
  });

  test("a direct edit is pure: the input plan is never mutated", () => {
    const before = JSON.stringify(royalWedding);
    for (const c of DIRECT) run([c]);
    assert.equal(JSON.stringify(royalWedding), before);
  });
});
