// One command language and one pure reducer. Gemini function calls and CopilotKit actions
// both reach the state only through applyBatch(), so the same command always yields the same state.
import { z } from "zod";
import { AgentState, BudgetItem, IsoDate, MinuteOfDay, Money } from "./schema";

const Ref = z.string().min(1).describe("An id, or a sub-event slug/name such as 'haldi'");
export const Weekday = z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

export const AdjustBudget = z.object({
  op: z.literal("adjust_budget"),
  category: BudgetItem.shape.category,
  subEvent: Ref.optional().describe("Limit the change to one sub-event's items"),
  deltaPaise: z.number().int().describe("Negative to cut. ₹20,000 = -2000000 paise"),
  reason: z.string().default(""),
});

export const MoveSubEvent = z.object({
  op: z.literal("move_sub_event"),
  subEvent: Ref,
  to: z.union([
    z.object({ date: IsoDate }),
    z.object({ weekday: Weekday, relativeTo: z.enum(["current_date", "main_event"]).default("current_date") }),
  ]).describe("Prefer weekday when the user names a day. The reducer resolves it, so the LLM never does date arithmetic"),
  newStartMin: MinuteOfDay.optional().describe("Leave out to keep the same clock times"),
});

export const ShiftBlock = z.object({
  op: z.literal("shift_block"),
  blockId: z.string(), newStartMin: MinuteOfDay,
});

export const SetTaskStatus = z.object({
  op: z.literal("set_task_status"),
  taskId: z.string(), status: z.enum(["todo", "doing", "done", "blocked"]),
});

export const RecordPayment = z.object({
  op: z.literal("record_payment"),
  budgetItemId: z.string(), paymentId: z.string(), paidDate: IsoDate,
});

export const SetRsvp = z.object({
  op: z.literal("set_rsvp"),
  guestId: z.string(), subEvent: Ref, answer: z.enum(["invited", "yes", "no", "maybe"]),
});

export const SetItemLock = z.object({
  op: z.literal("set_item_lock"),
  budgetItemId: z.string(), locked: z.boolean().describe("Locked items are never cut by adjust_budget"),
});

export const ClaimWishlistItem = z.object({
  op: z.literal("claim_wishlist_item"),
  itemId: z.string(), guestId: z.string().nullable().describe("null releases the claim"),
});

export const SetPermitStatus = z.object({
  op: z.literal("set_permit_status"),
  permitId: z.string(), status: z.enum(["not_started", "applied", "approved", "rejected"]),
  referenceNo: z.string().optional(),
});

export const UpdateSponsor = z.object({
  op: z.literal("update_sponsor"),
  sponsorId: z.string(),
  status: z.enum(["prospect", "pitched", "committed", "paid", "declined"]).optional(),
  receivedPaise: Money.optional().describe("Total received so far, in paise (not a delta)"),
});

export const UpsertVendorQuote = z.object({
  op: z.literal("upsert_vendor_quote"),
  budgetItemId: z.string().optional().describe("Target budget item id if known (e.g. 'b8')"),
  vendorName: z.string().min(1),
  category: BudgetItem.shape.category,
  itemLabel: z.string().min(1).describe("What the quote is for; matched fuzzily to an existing line in the category, else a new line is created"),
  quotedPaise: Money.describe("The vendor's total quote in paise"),
  depositRequiredPaise: Money.optional(),
  dueAt: IsoDate.optional().describe("Deposit due date"),
  depositDueDate: IsoDate.optional().describe("Alias of dueAt"),
  receivedOn: IsoDate.optional(),
  subEvent: Ref.optional().describe("Sub-event the line belongs to, when a new line is created"),
  notes: z.string().optional().describe("Terms: cancellation, corkage, overtime"),
  redFlags: z.array(z.string()).optional(),
  lockItem: z.boolean().optional(),
});

export const SetGuestDiet = z.object({
  op: z.literal("set_guest_diet"),
  guestId: z.string(), diet: z.array(z.string()).describe("e.g. ['jain'], ['veg', 'no-onion-garlic']; [] clears"),
});

export const CommunitySignup = z.object({
  op: z.literal("community_signup"),
  kind: z.enum(["volunteer", "sponsor"]),
  name: z.string().min(1),
  subEvent: Ref.optional().describe("volunteer: the sub-event the shift is for"),
  shift: z.string().optional().describe("volunteer: e.g. 'Gate 10 AM–1 PM'"),
  tier: z.enum(["title", "gold", "silver", "in_kind"]).optional().describe("sponsor: tier they're interested in"),
});

export const Command = z.discriminatedUnion("op", [
  AdjustBudget, MoveSubEvent, ShiftBlock, SetTaskStatus, RecordPayment, SetRsvp,
  SetItemLock, ClaimWishlistItem, SetPermitStatus, UpdateSponsor,
  UpsertVendorQuote, SetGuestDiet, CommunitySignup,
]);
export type Command = z.infer<typeof Command>;
export type CommandInput = z.input<typeof Command>;

export const Batch = z.object({
  commands: z.array(Command).min(1).max(20),
  summary: z.string().describe("One line that echoes the change back to the user"),
});
export type Batch = z.infer<typeof Batch>;
export type BatchInput = z.input<typeof Batch>;

// ---------- roles ----------
export type Role = "organizer" | "guest";
/** Guest / Committee Concierge mode may only run these. Everything else is refused at the reducer boundary. */
export const GUEST_ALLOWED_OPS: ReadonlySet<Command["op"]> = new Set(["set_rsvp", "set_guest_diet", "claim_wishlist_item", "community_signup"]);

// ---------- helpers ----------
export class PlanError extends Error {}
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
const STOP = new Set(["the", "and", "for", "with", "per", "set", "package", "quote", "invoice", "services", "service"]);
const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(w => w.length > 2 && !STOP.has(w)));
const uniqueId = (base: string, taken: (id: string) => boolean) => { let id = base, n = 2; while (taken(id)) id = `${base}-${n++}`; return id; };

/** Fuzzy match of a quote to an existing budget line in the same category: vendor link, then shared words. */
export function matchBudgetItem(st: AgentState, category: string, label: string, vendorId: string | null): BudgetItem | null {
  const want = tokens(label);
  let best: { b: BudgetItem; score: number } | null = null;
  for (const b of st.budgetItems) {
    if (b.category !== category) continue;
    const have = tokens(b.label);
    const shared = [...want].filter(w => have.has(w)).length;
    const L = label.toLowerCase(), B = b.label.toLowerCase();
    const score = shared * 2 + (vendorId && b.vendorId === vendorId ? 3 : 0) + (B === L ? 10 : B.includes(L) || L.includes(B) ? 6 : 0);
    if (score > 0 && (!best || score > best.score || (score === best.score && b.id < best.b.id))) best = { b, score };
  }
  return best?.b ?? null;
}
const DAYS = Weekday.options;
const toDate = (s: string) => new Date(s + "T00:00:00Z");
const fmt = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
export const daysBetween = (from: string, to: string) => Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000);
export const weekdayOf = (s: string) => DAYS[(toDate(s).getUTCDay() + 6) % 7]!;
export const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

export function findSubEvent(st: AgentState, ref: string) {
  const r = ref.trim().toLowerCase();
  const hits = st.subEvents.filter(s => s.id === ref || s.slug === r || s.name.toLowerCase() === r);
  if (hits.length !== 1) throw new PlanError(hits.length ? `"${ref}" matches ${hits.length} sub-events` : `No sub-event "${ref}"`);
  return hits[0]!;
}

/** The nearest named weekday to the anchor. A tie goes to the earlier date. Inside the event window, or it throws. */
export function resolveWeekday(st: AgentState, anchor: string, wd: z.infer<typeof Weekday>): string {
  const target = DAYS.indexOf(wd), cur = DAYS.indexOf(weekdayOf(anchor));
  const fwd = (target - cur + 7) % 7, back = fwd === 0 ? 0 : 7 - fwd;
  const cands = fwd === 0 ? [anchor] : back <= fwd ? [addDays(anchor, -back), addDays(anchor, fwd)] : [addDays(anchor, fwd), addDays(anchor, -back)];
  const ok = cands.find(d => d >= st.event.startDate && d <= st.event.endDate);
  if (!ok) throw new PlanError(`No ${wd} near ${anchor} inside ${st.event.startDate}..${st.event.endDate}`);
  return ok;
}

/**
 * Largest-remainder (Hamilton) allocation of an integer total across integer weights.
 * Exact to the paisa: the parts always sum to `total`. BigInt keeps total × weight exact at any size.
 * Ties on the remainder go to the lexicographically smaller id, so the result is fully deterministic.
 */
export function allocateLargestRemainder(total: number, weights: { id: string; w: number }[]): Map<string, number> {
  if (!Number.isSafeInteger(total) || total < 0) throw new PlanError(`Total must be a non-negative integer, got ${total}`);
  if (weights.some(x => !Number.isSafeInteger(x.w) || x.w < 0)) throw new PlanError("Weights must be non-negative integers");
  const W = weights.reduce((a, x) => a + BigInt(x.w), 0n);
  if (W === 0n) throw new PlanError("Weights sum to zero");
  const T = BigInt(total);
  const rows = weights.map(x => ({ id: x.id, base: (T * BigInt(x.w)) / W, rem: (T * BigInt(x.w)) % W }));
  let left = T - rows.reduce((a, r) => a + r.base, 0n);
  const order = [...rows].sort((a, b) => (a.rem === b.rem ? a.id.localeCompare(b.id) : a.rem > b.rem ? -1 : 1));
  const out = new Map<string, number>();
  for (const r of order) { out.set(r.id, Number(r.base + (left > 0n ? 1n : 0n))); if (left > 0n) left--; }
  return out;
}

/** Spread a cut (or a top-up) across items in proportion to their slack, using largest-remainder rounding so it sums exactly. */
function distribute(items: BudgetItem[], delta: number): Map<string, number> {
  const out = new Map<string, number>();
  if (delta >= 0) { // a top-up goes entirely to the largest unlocked item
    const tgt = [...items].sort((a, b) => b.plannedPaise - a.plannedPaise || a.id.localeCompare(b.id))[0];
    if (!tgt) throw new PlanError("No items in that category");
    out.set(tgt.id, delta); return out;
  }
  const need = -delta;
  const slack = items.map(i => ({ id: i.id, w: Math.max(0, i.plannedPaise - i.committedPaise) }));
  const total = slack.reduce((a, b) => a + b.w, 0);
  if (total < need) throw new PlanError(`Can only cut ₹${(total / 100).toLocaleString("en-IN")} here: the rest is already committed`);
  for (const [id, v] of allocateLargestRemainder(need, slack)) if (v > 0) out.set(id, -v);
  return out;
}

/** Unlocked slack (planned − committed) per category: the most adjust_budget can cut there right now. */
export function categoryMaxCuttable(st: AgentState, subEventId: string | null = null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of st.budgetItems) {
    if (subEventId !== null && b.subEventId !== subEventId) continue;
    out[b.category] = (out[b.category] ?? 0) + (b.locked ? 0 : Math.max(0, b.plannedPaise - b.committedPaise));
  }
  return out;
}

// ---------- reducer ----------
function apply(st: AgentState, c: Command, log: string[], role: Role = "organizer"): AgentState {
  switch (c.op) {
    case "adjust_budget": {
      const se = c.subEvent ? findSubEvent(st, c.subEvent).id : null;
      const inScope = st.budgetItems.filter(b => b.category === c.category && (se === null || b.subEventId === se));
      const unlocked = inScope.filter(b => !b.locked);
      // Locks only protect against cuts. A top-up on a fully locked category still lands (on its largest line).
      const pool = c.deltaPaise > 0 && unlocked.length === 0 ? inScope : unlocked;
      const deltas = distribute(pool, c.deltaPaise);
      log.push(`${c.category}: ${c.deltaPaise < 0 ? "−" : "+"}₹${(Math.abs(c.deltaPaise) / 100).toLocaleString("en-IN")} across ${deltas.size} item(s)`);
      return { ...st, budgetItems: st.budgetItems.map(b => deltas.has(b.id) ? { ...b, plannedPaise: b.plannedPaise + deltas.get(b.id)! } : b) };
    }
    case "move_sub_event": {
      const s = findSubEvent(st, c.subEvent);
      const main = st.subEvents.find(x => x.isMain);
      const date = "date" in c.to ? c.to.date
        : resolveWeekday(st, c.to.relativeTo === "main_event" && main ? main.date : s.date, c.to.weekday);
      if (date < st.event.startDate || date > st.event.endDate) throw new PlanError(`${date} is outside the event window`);
      const shift = c.newStartMin === undefined ? 0 : c.newStartMin - s.startMin;
      if (s.endMin + shift > 24 * 60 || s.startMin + shift < 0) throw new PlanError("New time runs past midnight");
      log.push(`${s.name}: ${s.date} → ${date}${shift ? `, ${shift > 0 ? "+" : ""}${shift} min` : ""}`);
      // Timeline blocks hang off the sub-event and tasks are relative to it, so both move with it automatically.
      return {
        ...st,
        subEvents: st.subEvents.map(x => x.id === s.id ? { ...x, date, startMin: x.startMin + shift, endMin: x.endMin + shift } : x),
        timeline: st.timeline.map(b => b.subEventId === s.id && !b.anchored ? { ...b, startMin: b.startMin + shift, endMin: b.endMin + shift } : b),
      };
    }
    case "shift_block": {
      const b = st.timeline.find(x => x.id === c.blockId); if (!b) throw new PlanError(`No block ${c.blockId}`);
      if (b.anchored) throw new PlanError(`${b.label} is anchored`);
      const d = c.newStartMin - b.startMin;
      if (b.endMin + d > 24 * 60) throw new PlanError(`${b.label} would run past midnight`);
      log.push(`${b.label}: ${d >= 0 ? "+" : ""}${d} min`);
      return { ...st, timeline: st.timeline.map(x => x.id === b.id ? { ...x, startMin: x.startMin + d, endMin: x.endMin + d } : x) };
    }
    case "set_task_status": {
      const t = st.tasks.find(x => x.id === c.taskId);
      if (!t) throw new PlanError(`No task ${c.taskId}`);
      log.push(`Task "${t.title}" → ${c.status}`);
      return { ...st, tasks: st.tasks.map(x => x.id === c.taskId ? { ...x, status: c.status, column: c.status } : x) };
    }
    case "record_payment": {
      const b = st.budgetItems.find(x => x.id === c.budgetItemId);
      if (!b) throw new PlanError(`No budget item ${c.budgetItemId}`);
      const p = b.payments.find(x => x.id === c.paymentId);
      if (!p) throw new PlanError(`No payment ${c.paymentId} on ${b.label}`);
      log.push(`${b.label}: ${p.kind} of ${rupees(p.amountPaise)} paid on ${c.paidDate}`);
      return { ...st, budgetItems: st.budgetItems.map(x => x.id !== c.budgetItemId ? x : {
        ...x, payments: x.payments.map(q => q.id === c.paymentId ? { ...q, paidDate: c.paidDate } : q) }) };
    }
    case "set_rsvp": {
      const sid = findSubEvent(st, c.subEvent).id;
      const g = st.guests.find(x => x.id === c.guestId);
      if (!g) throw new PlanError(`No guest ${c.guestId}`);
      if (role === "guest" && !(sid in g.rsvp)) throw new PlanError(`${g.name} isn't invited to ${findSubEvent(st, c.subEvent).name}; only the organiser can add invitations`);
      log.push(`${g.name} · ${c.subEvent}: ${c.answer}`);
      return { ...st, guests: st.guests.map(x => x.id === c.guestId ? { ...x, rsvp: { ...x.rsvp, [sid]: c.answer } } : x) };
    }
    case "set_item_lock": {
      const b = st.budgetItems.find(x => x.id === c.budgetItemId);
      if (!b) throw new PlanError(`No budget item ${c.budgetItemId}`);
      log.push(`${b.label}: ${c.locked ? "locked" : "unlocked"}`);
      return { ...st, budgetItems: st.budgetItems.map(x => x.id === b.id ? { ...x, locked: c.locked } : x) };
    }
    case "claim_wishlist_item": {
      const ext = st.event.ext;
      if (ext.type !== "birthday") throw new PlanError("Wishlist only exists on birthday events");
      const w = ext.wishlist.find(x => x.id === c.itemId);
      if (!w) throw new PlanError(`No wishlist item ${c.itemId}`);
      if (c.guestId !== null && !st.guests.some(g => g.id === c.guestId)) throw new PlanError(`No guest ${c.guestId}`);
      if (role === "guest" && w.claimedByGuestId && w.claimedByGuestId !== c.guestId)
        throw new PlanError(`"${w.item}" is already claimed by ${st.guests.find(g => g.id === w.claimedByGuestId)?.name ?? "another guest"}`);
      log.push(`Wishlist "${w.item}": ${c.guestId ? `claimed by ${st.guests.find(g => g.id === c.guestId)!.name}` : "released"}`);
      return { ...st, event: { ...st.event, ext: { ...ext, wishlist: ext.wishlist.map(x => x.id === w.id ? { ...x, claimedByGuestId: c.guestId } : x) } } };
    }
    case "set_permit_status": {
      const ext = st.event.ext;
      if (ext.type !== "community") throw new PlanError("Permits only exist on community events");
      const p = ext.permits.find(x => x.id === c.permitId);
      if (!p) throw new PlanError(`No permit ${c.permitId}`);
      log.push(`${p.authority} ${p.kind}: ${p.status} → ${c.status}`);
      return { ...st, event: { ...st.event, ext: { ...ext, permits: ext.permits.map(x => x.id === p.id
        ? { ...x, status: c.status, referenceNo: c.referenceNo ?? x.referenceNo } : x) } } };
    }
    case "update_sponsor": {
      const ext = st.event.ext;
      if (ext.type !== "community") throw new PlanError("Sponsors only exist on community events");
      const s = ext.sponsors.find(x => x.id === c.sponsorId);
      if (!s) throw new PlanError(`No sponsor ${c.sponsorId}`);
      if (c.receivedPaise !== undefined && s.pledgedPaise > 0 && c.receivedPaise > s.pledgedPaise)
        throw new PlanError(`${s.name} pledged ${rupees(s.pledgedPaise)}; received can't exceed it`);
      log.push(`Sponsor ${s.name}: ${[c.status && `status ${c.status}`, c.receivedPaise !== undefined && `received ${rupees(c.receivedPaise)}`].filter(Boolean).join(", ")}`);
      return { ...st, event: { ...st.event, ext: { ...ext, sponsors: ext.sponsors.map(x => x.id === s.id
        ? { ...x, status: c.status ?? x.status, receivedPaise: c.receivedPaise ?? x.receivedPaise } : x) } } };
    }
    case "upsert_vendor_quote": {
      const existingVendor = st.vendors.find(v => v.name.trim().toLowerCase() === c.vendorName.trim().toLowerCase());
      const vendorId = existingVendor?.id ?? uniqueId(`v-${slug(c.vendorName)}`, id => st.vendors.some(v => v.id === id));
      const receivedOn = c.receivedOn ?? c.dueAt ?? c.depositDueDate ?? st.event.startDate;
      const vendors = existingVendor
        ? st.vendors.map(v => v.id !== vendorId ? v : {
            ...v, stage: v.stage === "shortlisted" || v.stage === "contacted" ? ("quoted" as const) : v.stage,
            quotes: [...v.quotes, { id: `${vendorId}-q${v.quotes.length + 1}`, amountPaise: c.quotedPaise, basis: "flat" as const, receivedOn, notes: c.notes ?? "" }] })
        : [...st.vendors, { id: vendorId, name: c.vendorName.trim(), category: c.category, phone: "", email: "", stage: "quoted" as const, rating: null,
            quotes: [{ id: `${vendorId}-q1`, amountPaise: c.quotedPaise, basis: "flat" as const, receivedOn, notes: c.notes ?? "" }] }];
      if (c.budgetItemId !== undefined && !st.budgetItems.some(b => b.id === c.budgetItemId)) throw new PlanError(`No budget item ${c.budgetItemId}`);
      const match = c.budgetItemId !== undefined ? st.budgetItems.find(b => b.id === c.budgetItemId)! : matchBudgetItem(st, c.category, c.itemLabel, existingVendor?.id ?? null);
      const dueAt = c.dueAt ?? c.depositDueDate;
      const withDeposit = (b: BudgetItem): BudgetItem["payments"] => {
        if (!c.depositRequiredPaise || !dueAt) return b.payments;
        const open = b.payments.find(p => p.kind === "deposit" && !p.paidDate);
        if (open) return b.payments.map(p => p.id === open.id ? { ...p, amountPaise: c.depositRequiredPaise!, dueDate: dueAt } : p);
        return [...b.payments, { id: uniqueId(`${b.id}-dep`, id => b.payments.some(p => p.id === id)), amountPaise: c.depositRequiredPaise, kind: "deposit" as const,
          dueDate: dueAt, paidDate: null, refundable: false }];
      };
      let budgetItems: BudgetItem[], item: BudgetItem;
      if (match) {
        item = { ...match, quotedPaise: c.quotedPaise, vendorId: match.vendorId ?? vendorId, quoteNotes: c.notes ?? match.quoteNotes,
          quoteRedFlags: c.redFlags ?? match.quoteRedFlags, locked: c.lockItem ?? match.locked };
        item = { ...item, payments: withDeposit(item) };
        budgetItems = st.budgetItems.map(b => b.id === match.id ? item : b);
      } else {
        const id = uniqueId(`bi-q-${slug(c.itemLabel)}`, x => st.budgetItems.some(b => b.id === x));
        item = { id, category: c.category, label: c.itemLabel, subEventId: c.subEvent ? findSubEvent(st, c.subEvent).id : null, vendorId,
          plannedPaise: 0, quotedPaise: c.quotedPaise, committedPaise: 0, payments: [], locked: c.lockItem ?? false,
          quoteNotes: c.notes ?? "", quoteRedFlags: c.redFlags ?? [] };
        item = { ...item, payments: withDeposit(item) };
        budgetItems = [...st.budgetItems, item];
      }
      const gap = c.quotedPaise - item.plannedPaise;
      log.push(`${c.vendorName}: quote ${rupees(c.quotedPaise)} on ${match ? `"${item.label}"` : `new line "${item.label}"`}`);
      if (gap > 0) log.push(`⚠ Quote exceeds planned envelope by ${rupees(gap)}`);
      return { ...st, vendors, budgetItems };
    }
    case "set_guest_diet": {
      const g = st.guests.find(x => x.id === c.guestId);
      if (!g) throw new PlanError(`No guest ${c.guestId}`);
      const diet = [...new Set(c.diet.map(d => d.trim().toLowerCase()).filter(Boolean))];
      log.push(`${g.name}: diet ${diet.join(", ") || "no restriction"}`);
      return { ...st, guests: st.guests.map(x => x.id === g.id ? { ...x, diet } : x) };
    }
    case "community_signup": {
      const ext = st.event.ext;
      if (ext.type !== "community") throw new PlanError("Sign-ups only exist on community events");
      const name = c.name.trim();
      if (c.kind === "volunteer") {
        const subEventId = c.subEvent ? findSubEvent(st, c.subEvent).id : null;
        const shift = c.shift?.trim() ?? "";
        if (ext.volunteerSignups.some(v => v.name.toLowerCase() === name.toLowerCase() && v.subEventId === subEventId && v.shift === shift))
          throw new PlanError(`${name} is already signed up for that shift`);
        const id = uniqueId(`vs-${ext.volunteerSignups.length + 1}`, x => ext.volunteerSignups.some(v => v.id === x));
        log.push(`Volunteer ${name} signed up${subEventId ? ` for ${st.subEvents.find(s => s.id === subEventId)!.name}` : ""}${shift ? ` (${shift})` : ""}`);
        return { ...st, event: { ...st.event, ext: { ...ext, volunteers: ext.volunteers + 1, volunteerSignups: [...ext.volunteerSignups, { id, name, subEventId, shift }] } } };
      }
      if (ext.sponsors.some(sp => sp.name.toLowerCase() === name.toLowerCase())) throw new PlanError(`${name} is already in the sponsor pipeline`);
      const id = uniqueId(`sp-g${ext.sponsors.length + 1}`, x => ext.sponsors.some(sp => sp.id === x));
      log.push(`Sponsor interest: ${name} (${c.tier ?? "silver"})`);
      return { ...st, event: { ...st.event, ext: { ...ext, sponsors: [...ext.sponsors, { id, name, tier: c.tier ?? "silver", pledgedPaise: 0, receivedPaise: 0, deliverables: [], status: "prospect" as const }] } } };
    }
  }
}

/** Invariants run after every batch. This is the deterministic version of Planora's budget-sum validator. */
export function checkInvariants(st: AgentState): string[] {
  const errs: string[] = [];
  for (const b of st.budgetItems) if (b.plannedPaise < b.committedPaise) errs.push(`${b.label} is planned below its committed amount`);
  const mainDate = st.subEvents.find(x => x.isMain)?.date;
  for (const s of st.subEvents) {
    if (mainDate && s.phase === "pre" && !s.isMain && s.date > mainDate) errs.push(`${s.name} would land after the main event`);
    if (mainDate && s.phase === "post" && s.date < mainDate) errs.push(`${s.name} would land before the main event`);
    if (s.date < st.event.startDate || s.date > st.event.endDate) errs.push(`${s.name} is outside the event window`);
    const blocks = st.timeline.filter(b => b.subEventId === s.id).sort((a, b) => a.lane.localeCompare(b.lane) || a.startMin - b.startMin);
    for (let i = 1; i < blocks.length; i++)
      if (blocks[i]!.lane === blocks[i - 1]!.lane && blocks[i]!.startMin < blocks[i - 1]!.endMin) errs.push(`${blocks[i]!.label} overlaps ${blocks[i - 1]!.label}`);
  }
  return errs;
}

export const plannedTotal = (st: AgentState) => st.budgetItems.reduce((a, b) => a + b.plannedPaise, 0);

/** A task's due date: its sub-event's date (or the main event's) plus dueOffsetDays. */
export function taskDueDate(st: AgentState, t: AgentState["tasks"][number]): string {
  const main = st.subEvents.find(s => s.isMain);
  return addDays(st.subEvents.find(s => s.id === t.subEventId)?.date ?? main?.date ?? st.event.startDate, t.dueOffsetDays);
}

/** Derived values that the UI and the agent read. They're never stored, so they can't go stale. */
export function derive(st: AgentState, today: string) {
  const due = (t: AgentState["tasks"][number]) => taskDueDate(st, t);
  return {
    plannedTotalPaise: plannedTotal(st),
    headroomPaise: st.event.totalBudgetPaise - plannedTotal(st),
    overduePayments: st.budgetItems.flatMap(b => b.payments.filter(p => !p.paidDate && p.dueDate < today).map(p => ({ item: b.label, ...p }))),
    urgentTasks: st.tasks.filter(t => t.status !== "done" && due(t) <= addDays(today, 7)).map(t => ({ ...t, dueDate: due(t) })),
    tasksWithDates: st.tasks.map(t => ({ ...t, dueDate: due(t) })),
  };
}

// ---------- structured, self-healing rejections ----------
export type Diagnostics = {
  /** Unlocked slack per category in the state the failing command saw. */
  categoryMaxCuttablePaise: Record<string, number>;
  /** When the failing cut was scoped to one sub-event: the slack inside that scope. */
  scopeMaxCuttablePaise?: number;
  /** Locked items in the category the failing cut targeted (they're why the slack is small). */
  lockedItems?: string[];
  /** When the failing command moved a sub-event: every date in the window where the move is valid. */
  subEvent?: string;
  validDatesForSubEvent?: string[];
  /** Slugs the agent can use when a sub-event reference didn't resolve. */
  knownSubEvents: string[];
  /** Every invariant the batch broke. */
  violations: string[];
};

export type Rejection = {
  ok: false;
  state: AgentState;
  /** Kept for backward compatibility: identical to `reason`. */
  error: string;
  reason: string;
  /** Index of the command that failed, or -1 when the batch itself was malformed. */
  failedCommandIndex: number;
  diagnostics: Diagnostics;
  /** A verified-valid counter-offer batch the agent can propose verbatim. */
  suggestion?: BatchInput;
};
export type BatchResult = { ok: true; state: AgentState; log: string[] } | Rejection;

function datesInWindow(st: AgentState): string[] {
  const out: string[] = [];
  for (let d = st.event.startDate; d <= st.event.endDate && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

function validDatesFor(st: AgentState, ref: string): { slug: string; dates: string[] } | null {
  let s;
  try { s = findSubEvent(st, ref); } catch { return null; }
  const before = new Set(checkInvariants(st));
  const dates = datesInWindow(st).filter(date => {
    const next = { ...st, subEvents: st.subEvents.map(x => x.id === s.id ? { ...x, date } : x) };
    return checkInvariants(next).every(e => before.has(e));
  });
  return { slug: s.slug, dates };
}

function buildRejection(state: AgentState, prefix: AgentState, commands: Command[], idx: number, reason: string,
  violations: string[], withSuggestion: boolean, summary: string): Rejection {
  const failed = commands[idx];
  const diagnostics: Diagnostics = {
    categoryMaxCuttablePaise: categoryMaxCuttable(prefix),
    knownSubEvents: prefix.subEvents.map(s => s.slug),
    violations,
  };
  let replacement: Command | null | undefined; // undefined: no idea; null: drop the command
  if (failed?.op === "adjust_budget") {
    let seId: string | null = null;
    try { seId = failed.subEvent ? findSubEvent(prefix, failed.subEvent).id : null; } catch { /* unresolved ref */ }
    const scope = categoryMaxCuttable(prefix, seId)[failed.category] ?? 0;
    if (failed.subEvent) diagnostics.scopeMaxCuttablePaise = scope;
    diagnostics.lockedItems = prefix.budgetItems.filter(b => b.category === failed.category && b.locked).map(b => b.label);
    if (failed.deltaPaise < 0) replacement = scope > 0 ? { ...failed, deltaPaise: -scope } : null;
  }
  if (failed?.op === "move_sub_event") {
    const v = validDatesFor(prefix, failed.subEvent);
    if (v) {
      diagnostics.subEvent = v.slug; diagnostics.validDatesForSubEvent = v.dates;
      const wanted = "date" in failed.to ? failed.to.date : (() => {
        const s = findSubEvent(prefix, failed.subEvent);
        const target = DAYS.indexOf(failed.to.weekday), cur = DAYS.indexOf(weekdayOf(s.date));
        return addDays(s.date, (target - cur + 7) % 7);
      })();
      // Prefer not to stack a pre/post sub-event onto the main day, then the date nearest to what was asked.
      const self = findSubEvent(prefix, failed.subEvent);
      const mainDate = prefix.subEvents.find(x => x.isMain && x.id !== self.id)?.date;
      const nearest = v.dates.filter(d => d !== self.date)
        .sort((a, b) => Number(a === mainDate) - Number(b === mainDate) || Math.abs(daysBetween(wanted, a)) - Math.abs(daysBetween(wanted, b)) || a.localeCompare(b))[0];
      replacement = nearest ? { ...failed, to: { date: nearest } } : null;
    }
  }
  let suggestion: BatchInput | undefined;
  if (withSuggestion && replacement !== undefined) {
    const cmds = commands.flatMap((c, i) => (i === idx ? (replacement ? [replacement] : []) : [c]));
    if (cmds.length) {
      const candidate: BatchInput = { summary: `Counter-offer: ${summary}`, commands: cmds };
      const r = runBatch(state, candidate, false);
      if (r.ok) suggestion = candidate;
    }
  }
  return { ok: false, state, error: reason, reason, failedCommandIndex: idx, diagnostics, ...(suggestion ? { suggestion } : {}) };
}

function runBatch(state: AgentState, input: unknown, withSuggestion: boolean, role: Role = "organizer"): BatchResult {
  const parsed = Batch.safeParse(input);
  if (!parsed.success) {
    const reason = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    const p = parsed.error.issues[0]?.path ?? [];
    const idx = p[0] === "commands" && typeof p[1] === "number" ? p[1] : -1;
    return { ok: false, state, error: reason, reason, failedCommandIndex: idx,
      diagnostics: { categoryMaxCuttablePaise: categoryMaxCuttable(state), knownSubEvents: state.subEvents.map(s => s.slug), violations: [] } };
  }
  const { commands, summary } = parsed.data;
  if (role === "guest") {
    const bad = commands.findIndex(c => !GUEST_ALLOWED_OPS.has(c.op));
    if (bad >= 0) {
      const reason = `Guest Concierge Mode is read-only for budgets and schedules ("${commands[bad]!.op}" blocked). You can check event timings, dress codes, or update RSVPs and wishlists.`;

      return { ok: false, state, error: reason, reason, failedCommandIndex: bad,
        diagnostics: { categoryMaxCuttablePaise: {}, knownSubEvents: state.subEvents.map(s => s.slug), violations: ["role:guest"] } };
    }
  }
  const log: string[] = [];
  const baseline = new Set(checkInvariants(state));
  const prefixes: AgentState[] = [state];
  const errsAfter: string[][] = [];
  let next = state;
  for (let i = 0; i < commands.length; i++) {
    try { next = apply(next, commands[i]!, log, role); }
    catch (e) {
      if (e instanceof PlanError) return buildRejection(state, next, commands, i, e.message, [], withSuggestion, summary);
      throw e;
    }
    prefixes.push(next);
    errsAfter.push(checkInvariants(next));
  }
  const errs = errsAfter[errsAfter.length - 1]!.filter(e => !baseline.has(e));
  if (errs.length) {
    // Blame the command after which the first final violation appeared and never went away.
    const first = errs[0]!;
    let idx = commands.length - 1;
    while (idx > 0 && errsAfter[idx - 1]!.includes(first)) idx--;
    return buildRejection(state, prefixes[idx]!, commands, idx, errs.join("; "), errs, withSuggestion, summary);
  }
  if (plannedTotal(next) > next.event.totalBudgetPaise) log.push(`⚠ Over budget by ₹${((plannedTotal(next) - next.event.totalBudgetPaise) / 100).toLocaleString("en-IN")}`);
  return { ok: true, state: next, log };
}

/**
 * All or nothing: the whole batch applies or none of it does. Returns the new state, or the old one with
 * a structured rejection (reason, failing command index, diagnostics, and a verified counter-offer when one exists).
 * It's pure, so calling it is also the dry-run preview.
 */
export function applyBatch(state: AgentState, input: unknown, opts: { role?: Role } = {}): BatchResult {
  return runBatch(state, input, opts.role !== "guest", opts.role ?? "organizer");
}
/** Spec alias: the same pure reducer. */
export const applyPlanChanges = applyBatch;
