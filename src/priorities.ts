// v6: priorities and trade-offs. The organiser marks budget categories must-protect, flexible or cut-first and picks an
// experience level; this module turns a shortfall into explicit trade-offs, all in integer paise, by code, never the LLM.
//
// The cut, in stages (each stage shared across its categories in proportion to what it can give, largest remainder):
//   A. cut-first categories, down to a depth set by the level (simple 100%, balanced 75%, premium 50% of their slack);
//   B. flexible categories, up to all of their slack;
//   C. whatever cut-first slack stage A left;
//   D. protected categories, only when the caller allows it (rebalance must hit the total exactly; "fix" never does).
// Slack is planned − committed on unlocked lines, so locks and commitments are always respected. Each category's cut
// becomes one adjust_budget command, which spreads it across that category's unlocked lines by slack.
import type { AgentState, BudgetCategory, BudgetItem, Priorities, PriorityTier } from "./schema";
import { addDays, allocateLargestRemainder, applyBatch, categoryMaxCuttable, daysBetween, plannedTotal, rupees, taskDueDate, type BatchInput, type CommandInput } from "./commands";

export const CATEGORY_LABEL: Record<BudgetCategory, string> = {
  venue: "Venue", catering: "Catering", decor: "Decor", photo_video: "Photo & video", music: "Music", attire: "Attire", beauty: "Beauty",
  stationery: "Stationery", gifts: "Gifts", logistics: "Logistics", permits: "Permits", entertainment: "Entertainment", misc: "Misc",
};
export const TIER_LABEL: Record<PriorityTier, string> = { protect: "must protect", flexible: "flexible", cut_first: "cut first" };
export const LEVEL_LABEL = { simple: "Simple", balanced: "Balanced", premium: "Premium" } as const;
/** How far cut-first categories go (basis points of their slack) before flexible ones are touched. */
export const LEVEL_DEPTH_BPS = { simple: 10_000, balanced: 7_500, premium: 5_000 } as const;
export const LEVEL_HINT = {
  simple: "Keep it simple: nice-to-haves give way fully before anything else is touched.",
  balanced: "Balanced: nice-to-haves give up to three-quarters of their spare money first.",
  premium: "Premium: nice-to-haves give at most half first, so cuts spread wider and nothing is stripped bare.",
} as const;

export const isDefaultPriorities = (p: Priorities) => p.protect.length === 0 && p.cutFirst.length === 0;
export function tierOf(p: Priorities, c: BudgetCategory): PriorityTier {
  return p.protect.includes(c) ? "protect" : p.cutFirst.includes(c) ? "cut_first" : "flexible";
}
const list = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const label = (c: BudgetCategory) => CATEGORY_LABEL[c] ?? c;

/** Exact share of `take` across capacities (never above a capacity). Whole rupees when everything is in whole rupees. */
function share(take: number, caps: { id: string; w: number }[]): Map<string, number> {
  const live = caps.filter(c => c.w > 0);
  if (take <= 0 || !live.length) return new Map();
  if (take % 100 === 0 && live.every(c => c.w % 100 === 0)) {
    const r = allocateLargestRemainder(take / 100, live.map(c => ({ id: c.id, w: c.w / 100 })));
    return new Map([...r].map(([k, v]) => [k, v * 100]));
  }
  return allocateLargestRemainder(take, live);
}

/** Spread a category's cut over its lines by slack (planned − committed), exact to the paisa. Returns positive amounts. */
export function spreadOverSlack(items: BudgetItem[], cut: number): Map<string, number> {
  return share(cut, items.map(b => ({ id: b.id, w: Math.max(0, b.plannedPaise - b.committedPaise) })));
}

export type CategoryCut = { category: BudgetCategory; tier: PriorityTier; cutPaise: number };
export type CutPlan = {
  needPaise: number;
  cuts: CategoryCut[];
  /** What could not be found without touching protected (or kept) categories, locks or commitments. */
  shortfallPaise: number;
  /** Protected categories left untouched. */
  kept: BudgetCategory[];
  level: Priorities["level"];
};

/** Work out where `needPaise` comes from, by the plan's priorities. Pure; amounts exact to the paisa. */
export function planPriorityCut(st: AgentState, needPaise: number, opts: { keep?: BudgetCategory[]; allowProtected?: boolean } = {}): CutPlan {
  const p = st.priorities;
  const keep = new Set(opts.keep ?? []);
  const slack = categoryMaxCuttable(st) as Partial<Record<BudgetCategory, number>>;
  const cats = (Object.keys(slack) as BudgetCategory[]).filter(c => (slack[c] ?? 0) > 0 && !keep.has(c)).sort();
  const cut = new Map<BudgetCategory, number>();
  let left = Math.max(0, needPaise);
  const stage = (caps: { id: string; w: number }[]) => {
    const total = caps.reduce((a, c) => a + c.w, 0);
    const take = Math.min(left, total);
    for (const [id, v] of share(take, caps)) cut.set(id as BudgetCategory, (cut.get(id as BudgetCategory) ?? 0) + v);
    left -= take;
  };
  const depth = BigInt(LEVEL_DEPTH_BPS[p.level]);
  const room = (c: BudgetCategory) => (slack[c] ?? 0) - (cut.get(c) ?? 0);
  const first = cats.filter(c => tierOf(p, c) === "cut_first"), flex = cats.filter(c => tierOf(p, c) === "flexible"), prot = cats.filter(c => tierOf(p, c) === "protect");
  // Stage A: a whole-rupee depth so the shares stay in whole rupees.
  if (left > 0) stage(first.map(c => ({ id: c, w: Math.floor(Number((BigInt(slack[c]!) * depth) / 10_000n) / 100) * 100 })));
  if (left > 0) stage(flex.map(c => ({ id: c, w: room(c) })));
  if (left > 0) stage(first.map(c => ({ id: c, w: room(c) })));
  if (left > 0 && opts.allowProtected) stage(prot.map(c => ({ id: c, w: room(c) })));
  const order: Record<PriorityTier, number> = { cut_first: 0, flexible: 1, protect: 2 };
  const cuts = [...cut].filter(([, v]) => v > 0).map(([category, cutPaise]) => ({ category, tier: tierOf(p, category), cutPaise }))
    .sort((a, b) => order[a.tier] - order[b.tier] || b.cutPaise - a.cutPaise || a.category.localeCompare(b.category));
  const touched = new Set(cuts.map(c => c.category));
  const kept = p.protect.filter(c => !touched.has(c) && st.budgetItems.some(b => b.category === c));
  return { needPaise: Math.max(0, needPaise), cuts, shortfallPaise: left, kept, level: p.level };
}

/** One adjust_budget per category: the reducer spreads each over that category's unlocked lines. */
export function cutCommands(plan: CutPlan): CommandInput[] {
  return plan.cuts.map(c => ({ op: "adjust_budget" as const, category: c.category, deltaPaise: -c.cutPaise, reason: `Fix by priorities (${TIER_LABEL[c.tier]})` }));
}

/** Plain-English trade-offs: "Decor −₹60,000 (cut first) to keep Catering intact". */
export function explainCut(plan: CutPlan, st: AgentState): string[] {
  const kept = plan.kept.map(label);
  const out = plan.cuts.map((c, i) => `${label(c.category)} −${rupees(c.cutPaise)} (${TIER_LABEL[c.tier]})${i === 0 && kept.length && c.tier !== "protect" ? ` to keep ${list(kept)} intact` : ""}`);
  if (isDefaultPriorities(st.priorities)) out.push("No priorities are set, so every category was treated as flexible and cut in proportion to what it can give. Set priorities on the Budget page to protect what matters.");
  else {
    if (kept.length) out.push(`${list(kept)} ${kept.length === 1 ? "is" : "are"} must-protect, so ${kept.length === 1 ? "it is" : "they are"} untouched.`);
    if (plan.cuts.some(c => c.tier === "cut_first")) out.push(`${LEVEL_LABEL[plan.level]} level: ${LEVEL_HINT[plan.level].split(": ")[1]}`);
  }
  if (plan.shortfallPaise > 0) out.push(`${rupees(plan.shortfallPaise)} is still over: the rest is committed, locked or must-protect. Unprotect a category, unlock a line or raise the total to close it.`);
  return out;
}

export type Revision =
  | { ok: true; batch: BatchInput; explain: string[]; cut: CutPlan | null; after: AgentState }
  | { ok: false; reason: string };

/** Planned minus total (positive when over budget). */
export const overrunOf = (st: AgentState) => plannedTotal(st) - st.event.totalBudgetPaise;
const headroomOf = (st: AgentState) => st.event.totalBudgetPaise - plannedTotal(st);

/** "Over budget? Fix by my priorities": the cuts that bring planned back to the total, as one approval batch. */
export function buildPriorityFix(st: AgentState): Revision {
  const over = overrunOf(st);
  if (over <= 0) return { ok: false, reason: `Planned is within the total (${rupees(-over)} not yet planned), so there is nothing to fix.` };
  const plan = planPriorityCut(st, over);
  if (!plan.cuts.length) return { ok: false, reason: `Planned is ${rupees(over)} over the total, but nothing outside must-protect categories can be cut (it's committed or locked).` };
  const batch: BatchInput = { summary: `Fix the ${rupees(over)} overrun by your priorities`, commands: cutCommands(plan) };
  const r = applyBatch(st, batch);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, batch, cut: plan, after: r.state, explain: [`Planned is ${rupees(over)} over the ${rupees(st.event.totalBudgetPaise)} total. By your priorities:`, ...explainCut(plan, st)] };
}

export type RevisionInput = { budgetDeltaPaise?: number; shiftDays?: number; guestCount?: number; fixOverrun?: boolean };

/**
 * Revise, don't restart: change the total, move every date and/or change the guest count with one set_event_basics,
 * then fix any overrun by priorities, all in ONE approval batch. Code computes the new total, the new dates and every
 * cut; the reply only quotes what this returns.
 */
export function buildRevision(st: AgentState, today: string, input: RevisionInput): Revision {
  const e = st.event;
  const basics: Record<string, unknown> = { op: "set_event_basics" };
  const explain: string[] = [];
  if (input.budgetDeltaPaise !== undefined && input.budgetDeltaPaise !== 0) {
    const total = e.totalBudgetPaise + input.budgetDeltaPaise;
    if (total < 0) return { ok: false, reason: `The total can't drop by ${rupees(-input.budgetDeltaPaise)}: it's only ${rupees(e.totalBudgetPaise)}` };
    basics.totalBudgetPaise = total;
    explain.push(`Total budget ${rupees(e.totalBudgetPaise)} → ${rupees(total)} (${input.budgetDeltaPaise < 0 ? "−" : "+"}${rupees(Math.abs(input.budgetDeltaPaise))}).`);
  }
  if (input.shiftDays !== undefined && input.shiftDays !== 0) basics.startDate = addDays(e.startDate, input.shiftDays);
  if (input.guestCount !== undefined && input.guestCount !== e.guestCount) basics.guestCount = input.guestCount;
  const commands: CommandInput[] = Object.keys(basics).length > 1 ? [basics as CommandInput] : [];
  let mid = st;
  if (commands.length) {
    const r = applyBatch(st, { summary: "basics", commands });
    if (!r.ok) return { ok: false, reason: r.reason };
    mid = r.state;
    if (basics.startDate) {
      const shift = input.shiftDays!;
      const moved = st.tasks.filter(t => taskDueDate(st, t) !== taskDueDate(mid, t));
      const nowLate = mid.tasks.filter(t => t.status !== "done" && taskDueDate(mid, t) < today && taskDueDate(st, t) >= today);
      const soon = mid.tasks.filter(t => t.status !== "done" && taskDueDate(mid, t) >= today && daysBetween(today, taskDueDate(mid, t)) <= 7 && daysBetween(today, taskDueDate(st, t)) > 7);
      explain.push(`Every date moves ${Math.abs(shift)} day${Math.abs(shift) === 1 ? "" : "s"} ${shift < 0 ? "earlier" : "later"} (${e.startDate} → ${mid.event.startDate}); ${moved.length} task due date${moved.length === 1 ? "" : "s"} move with ${moved.length === 1 ? "it" : "them"}.`);
      if (nowLate.length) explain.push(`${nowLate.length} task${nowLate.length === 1 ? " is" : "s are"} now overdue: ${nowLate.slice(0, 3).map(t => `"${t.title}"`).join(", ")}${nowLate.length > 3 ? "…" : ""}. Do ${nowLate.length === 1 ? "it" : "these"} first.`);
      if (soon.length) explain.push(`${soon.length} more now fall${soon.length === 1 ? "s" : ""} due within a week.`);
    }
    if (basics.guestCount !== undefined) {
      const scaled = mid.budgetItems.filter(b => b.plannedPaise !== st.budgetItems.find(x => x.id === b.id)?.plannedPaise);
      explain.push(`Guest count ${e.guestCount} → ${mid.event.guestCount}${scaled.length ? `: per-guest lines rescale (${scaled.map(b => b.label).join(", ")})` : ": no per-guest lines to rescale"}.`);
    }
  }
  const over = overrunOf(mid);
  let cut: CutPlan | null = null;
  if (over > 0 && input.fixOverrun !== false) {
    cut = planPriorityCut(mid, over);
    commands.push(...cutCommands(cut));
    explain.push(`Planned would be ${rupees(over)} over the new total, so by your priorities:`, ...explainCut(cut, mid));
  } else if (commands.length && Object.prototype.hasOwnProperty.call(basics, "totalBudgetPaise")) {
    explain.push(over <= 0 ? `The ${rupees(-over)} not yet planned absorbs it, so no category needs a cut.` : `Planned is ${rupees(over)} over the total.`);
  }
  if (!commands.length) return { ok: false, reason: over > 0 ? "Nothing could be cut: everything left is committed, locked or must-protect." : "Nothing to change." };
  const parts = [basics.totalBudgetPaise !== undefined && `budget ${input.budgetDeltaPaise! < 0 ? "−" : "+"}${rupees(Math.abs(input.budgetDeltaPaise!))}`,
    basics.startDate && `dates ${Math.abs(input.shiftDays!)} days ${input.shiftDays! < 0 ? "earlier" : "later"}`, basics.guestCount !== undefined && `${input.guestCount} guests`, cut?.cuts.length && "cuts by your priorities"].filter(Boolean);
  const batch: BatchInput = { summary: `Revise the plan: ${parts.join(", ")}`, commands };
  const r = applyBatch(st, batch);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, batch, explain, cut, after: r.state };
}

// ---------------------------------------------------------------- what-if
export type CategoryTotals = Partial<Record<BudgetCategory, number>>;
export const categoryTotals = (st: AgentState): CategoryTotals => {
  const out: CategoryTotals = {};
  for (const b of st.budgetItems) out[b.category] = (out[b.category] ?? 0) + b.plannedPaise;
  return out;
};
export type WhatIfChange = { category: BudgetCategory; plannedPaise: number } | { guestCount: number };
export type WhatIf =
  | { ok: true; batch: BatchInput; before: CategoryTotals; after: CategoryTotals; headroomBefore: number; headroomAfter: number; explain: string[]; afterState: AgentState }
  | { ok: false; reason: string };

/**
 * Preview a change before committing it: set one category's planned total or the guest count, see headroom and every
 * other category after, and optionally keep within the total by cutting other categories by priority (the changed
 * category is kept).
 */
export function whatIf(st: AgentState, change: WhatIfChange, opts: { balance?: boolean } = {}): WhatIf {
  const before = categoryTotals(st);
  const commands: CommandInput[] = [];
  const explain: string[] = [];
  let keep: BudgetCategory[] = [];
  if ("category" in change) {
    const cur = before[change.category] ?? 0;
    const delta = change.plannedPaise - cur;
    if (delta === 0) return { ok: false, reason: `${label(change.category)} is already ${rupees(cur)}.` };
    if (!st.budgetItems.some(b => b.category === change.category)) return { ok: false, reason: `There is no ${label(change.category)} line yet: add one first.` };
    commands.push({ op: "adjust_budget", category: change.category, deltaPaise: delta, reason: "What-if" });
    keep = [change.category];
    explain.push(`${label(change.category)} ${rupees(cur)} → ${rupees(change.plannedPaise)} (${delta < 0 ? "−" : "+"}${rupees(Math.abs(delta))}).`);
  } else {
    if (change.guestCount === st.event.guestCount) return { ok: false, reason: `The plan is already sized for ${change.guestCount} guests.` };
    commands.push({ op: "set_event_basics", guestCount: change.guestCount });
    const perGuest = st.budgetItems.filter(b => b.basis === "per_guest" && b.perGuestPaise);
    explain.push(perGuest.length ? `Guests ${st.event.guestCount} → ${change.guestCount}: per-guest lines rescale at their rate (${perGuest.map(b => `${b.label} ${rupees(b.perGuestPaise!)}/guest`).join(", ")}); flat lines stay as they are.`
      : `Guests ${st.event.guestCount} → ${change.guestCount}: no line is priced per guest, so no amounts change.`);
  }
  const mid = applyBatch(st, { summary: "what-if", commands });
  if (!mid.ok) return { ok: false, reason: mid.reason };
  const over = overrunOf(mid.state);
  if (opts.balance && over > 0) {
    const plan = planPriorityCut(mid.state, over, { keep });
    commands.push(...cutCommands(plan));
    explain.push(`To stay within the ${rupees(st.event.totalBudgetPaise)} total, by your priorities:`, ...explainCut(plan, mid.state));
  } else if (over > 0) explain.push(`This puts the plan ${rupees(over)} over the total. Tick "Keep within my total" to see where that would come from.`);
  const batch: BatchInput = { summary: "category" in change ? `What-if: ${label(change.category)} → ${rupees(change.plannedPaise)}${opts.balance && over > 0 ? ", balanced by priorities" : ""}`
    : `What-if: ${change.guestCount} guests${opts.balance && over > 0 ? ", balanced by priorities" : ""}`, commands };
  const r = applyBatch(st, batch);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, batch, before, after: categoryTotals(r.state), headroomBefore: headroomOf(st), headroomAfter: headroomOf(r.state), explain, afterState: r.state };
}

/** Compact text for the Gemini system prompt. */
export function prioritiesDigest(st: AgentState): string {
  const p = st.priorities;
  if (isDefaultPriorities(p)) return `none set (every category flexible), level ${p.level}`;
  return `protect ${p.protect.join(", ") || "-"}; cut first ${p.cutFirst.join(", ") || "-"}; everything else flexible; level ${p.level} (${LEVEL_HINT[p.level]})`;
}
