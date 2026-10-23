// One command language and one pure reducer. Gemini function calls and CopilotKit actions
// both reach the state only through applyBatch(), so the same command always yields the same state.
import { z } from "zod";
import { AgentState, BudgetItem, ExperienceLevel, IdeaKind, IsoDate, MinuteOfDay, Money, PermitStatus, QuoteBasis, RsvpStatus, SponsorStatus, SponsorTier, TaskStatus, VendorStage } from "./schema";
import { slotByKey } from "./config/vendor-checklist";
import { isDefaultPriorities, planPriorityCut, spreadOverSlack } from "./priorities";

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
  taskId: z.string(), status: TaskStatus,
});

export const RecordPayment = z.object({
  op: z.literal("record_payment"),
  budgetItemId: z.string(), paymentId: z.string(), paidDate: IsoDate,
});

export const SetRsvp = z.object({
  op: z.literal("set_rsvp"),
  guestId: z.string(), subEvent: Ref, answer: RsvpStatus,
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
  permitId: z.string(), status: PermitStatus,
  referenceNo: z.string().optional(),
});

export const UpdateSponsor = z.object({
  op: z.literal("update_sponsor"),
  sponsorId: z.string(),
  status: SponsorStatus.optional(),
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
  // v6: structured fields for the quote comparison (all optional; the scanner fills what it can read).
  basis: QuoteBasis.optional().describe("flat (one package price), per_guest (price per plate/guest) or per_hour"),
  inclusions: z.array(z.string().max(160)).max(30).optional().describe("What the quote includes, as printed"),
  exclusions: z.array(z.string().max(160)).max(30).optional().describe("What it says is not included"),
  extraCharges: z.array(z.object({ label: z.string().min(1).max(120), amountPaise: Money.nullable().default(null) })).max(20).optional()
    .describe("Extra charges named on the quote (overtime, generator, travel), with the amount in paise when printed"),
  guestsCovered: z.number().int().positive().optional().describe("Guests the quoted amount covers, when printed"),
  openQuestions: z.array(z.string().max(200)).max(20).optional().describe("What is unclear and must be asked before booking"),
  need: z.string().max(40).optional().describe("Vendor-checklist slot key for a new vendor, e.g. 'photographer'"),
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
  tier: SponsorTier.optional().describe("sponsor: tier they're interested in"),
});

export const SetSubEventVisibility = z.object({
  op: z.literal("set_sub_event_visibility"),
  subEvent: Ref,
  visibility: z.enum(["public", "private"]).describe("public: shown on the shared guest link to anyone with it; private: only to invited households"),
}).describe("Organizer only. Show or hide one sub-event on the public guest link. Does not change who may RSVP.");

// ---------- direct edits (organizer UI only) ----------
// Inline editing in the organizer's own controls. These are never declared to the LLM and the reducer refuses them
// unless the caller says the batch came from the UI (applyBatch(..., { source: "ui" })), so the model can't rename
// things or set an amount. Money stays integer paise; the UI converts whole rupees before it builds the command.
/** Upper bound for a directly entered amount: ₹100 crore, the same cap the quote scanner applies. */
export const MAX_DIRECT_AMOUNT_PAISE = 100_00_00_000_00;
export const MAX_NAME_LENGTH = 120;
const EditName = z.string().trim().min(1, "Name can't be empty").max(MAX_NAME_LENGTH, `Keep it under ${MAX_NAME_LENGTH} characters`);

export const RenameEvent = z.object({
  op: z.literal("rename_event"),
  title: EditName,
}).describe("Organizer UI only. Rename the event (the title shown in the header and on guest links).");

export const SetPartnerNames = z.object({
  op: z.literal("set_partner_names"),
  partners: z.tuple([EditName, EditName]),
}).describe("Organizer UI only. Wedding events: the couple's names.");

export const RENAMEABLE = ["budget_item", "task", "sub_event", "guest", "household", "vendor"] as const;
export const RenameEntity = z.object({
  op: z.literal("rename_entity"),
  kind: z.enum(RENAMEABLE),
  id: z.string().min(1),
  name: EditName,
}).describe("Organizer UI only. Rename a budget line, task, sub-event, guest, household or vendor. Ids, slugs and links are unchanged.");

export const SetPlannedAmount = z.object({
  op: z.literal("set_planned_amount"),
  budgetItemId: z.string().min(1),
  plannedPaise: Money.max(MAX_DIRECT_AMOUNT_PAISE),
  /** The planned amount the editor showed. A stale value is rejected, and the trust tier is |plannedPaise − expectedPaise|. */
  expectedPaise: Money.max(MAX_DIRECT_AMOUNT_PAISE),
}).describe("Organizer UI only. Set one budget line's planned envelope (paise).");

// ---------- plan structure: budget lines, event basics, ideas (organizer only; the AI may propose most of them) ----------
export const AddBudgetItem = z.object({
  op: z.literal("add_budget_item"),
  category: BudgetItem.shape.category,
  label: EditName.describe("What the line is for, e.g. 'Mehendi artist'"),
  plannedPaise: Money.max(MAX_DIRECT_AMOUNT_PAISE).describe("Planned envelope in paise (₹1 = 100)"),
  subEvent: Ref.optional().describe("Sub-event the line belongs to (optional)"),
  alreadyBooked: z.boolean().optional().describe("true when the user has already booked it: the line is committed at that amount and locked"),
}).describe("Organizer only. Add a budget line (a new category is simply a first line in it).");

export const RemoveBudgetItem = z.object({
  op: z.literal("remove_budget_item"),
  budgetItemId: z.string().min(1),
}).describe("Organizer only. Delete a budget line. Refused when anything is committed or a payment is recorded on it.");

/** Sanity limits for set_event_basics. */
export const BASICS_LIMITS = { minDate: "2000-01-01", maxDate: "2100-12-31", maxWindowDays: 60, maxGuests: 100_000, maxCity: 80 } as const;
export const SetEventBasics = z.object({
  op: z.literal("set_event_basics"),
  totalBudgetPaise: Money.max(MAX_DIRECT_AMOUNT_PAISE).optional().describe("New total budget in paise. Can't go below what is already committed"),
  guestCount: z.number().int().min(0).max(BASICS_LIMITS.maxGuests).optional(),
  city: z.string().trim().min(1).max(BASICS_LIMITS.maxCity).optional(),
  startDate: IsoDate.optional().describe("New first day. Every sub-event moves by the same whole number of days (the tool computes it)"),
  endDate: IsoDate.optional().describe("New last day of the window (after any shift); must still contain every sub-event"),
}).describe("Organizer only. Change the event's total budget, guest count, city or dates.");

export const RebalanceBudget = z.object({
  op: z.literal("rebalance_budget"),
  /** The headroom (total − planned) the preview was computed from. A stale value is rejected. */
  expectedHeadroomPaise: z.number().int(),
}).describe("Organizer only. Spread the headroom (total − planned) across unlocked lines in proportion, so planned equals the total exactly.");

/** An idea card as code prepared it (amounts already converted to paise and checked). Built by code, never declared to the LLM. */
export const IdeaDraft = z.object({
  kind: IdeaKind,
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400).default(""),
  estLowPaise: Money.max(MAX_DIRECT_AMOUNT_PAISE).nullable().default(null),
  estHighPaise: Money.max(MAX_DIRECT_AMOUNT_PAISE).nullable().default(null),
  category: BudgetItem.shape.category.nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  source: z.enum(["gemini", "demo"]),
  overBudget: z.boolean().default(false),
  /** v6: the idea this one refines ("cheaper alternative" of …). */
  refinedFrom: z.string().min(1).nullable().default(null),
});
export const AddIdeas = z.object({
  op: z.literal("add_ideas"),
  ideas: z.array(IdeaDraft).min(1).max(12),
});
export const SaveIdea = z.object({ op: z.literal("save_idea"), ideaId: z.string().min(1) }).describe("Organizer UI only. Keep an idea on the board.");
export const DismissIdea = z.object({ op: z.literal("dismiss_idea"), ideaId: z.string().min(1) }).describe("Organizer UI only. Hide an idea.");
export const AdoptIdea = z.object({
  op: z.literal("adopt_idea"),
  ideaId: z.string().min(1),
  addTask: z.boolean().default(true).describe("Create a task for it"),
  addBudgetLine: z.boolean().default(true).describe("Add a budget line at its low estimate (when it has a cost and a category)"),
  plannedPaise: Money.max(MAX_DIRECT_AMOUNT_PAISE).optional().describe("Override the budget line amount (paise)"),
  subEvent: Ref.optional(),
}).describe("Organizer only. Turn an idea into a task and/or a budget line. Always shown for approval.");

// ---------- v6: priorities, vendors and task dependencies (organizer only; the AI proposes them through approval cards) ----------
const Category = BudgetItem.shape.category;
export const SetPriorities = z.object({
  op: z.literal("set_priorities"),
  protect: z.array(Category).max(13).describe("Must-protect categories, most important first. Overrun fixes never cut these"),
  cutFirst: z.array(Category).max(13).describe("Cut-first categories: the first to give when money is short. Every other category is flexible"),
  level: ExperienceLevel.describe("simple, balanced or premium: how deep cut-first categories go before flexible ones are touched"),
}).describe("Organizer only. Set which budget categories to protect, which to cut first, and the experience level.");

export const AddVendor = z.object({
  op: z.literal("add_vendor"),
  name: EditName.describe("Vendor name as the organiser knows it"),
  category: Category,
  need: z.string().trim().min(1).max(40).optional().describe("Vendor-checklist slot key, e.g. 'photographer', 'mehendi_artist'"),
  phone: z.string().trim().max(30).optional(),
}).describe("Organizer only. Add a vendor to the shortlist (no price, no availability claim).");

export const SetVendorStage = z.object({
  op: z.literal("set_vendor_stage"),
  vendorId: z.string().min(1),
  stage: VendorStage.describe("shortlisted, contacted, quoted, negotiating, booked or dropped. Booking needs approval"),
}).describe("Organizer only. Move a vendor along the pipeline.");

export const RemoveVendor = z.object({
  op: z.literal("remove_vendor"),
  vendorId: z.string().min(1),
}).describe("Organizer only. Remove a vendor. Refused while any budget line linked to it has money committed or a payment recorded.");

export const SetVendorNeed = z.object({
  op: z.literal("set_vendor_need"),
  need: z.string().trim().min(1).max(40).describe("Vendor-checklist slot key"),
  needed: z.boolean().describe("false marks the slot 'not needed' for this event"),
}).describe("Organizer only. Mark a vendor-checklist slot as needed or not needed.");

export const SetTaskDependency = z.object({
  op: z.literal("set_task_dependency"),
  taskId: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).max(20).describe("Task ids that must be done first ([] clears). Cycles are refused"),
}).describe("Organizer only. Say which tasks must be done before this one.");

/** v6 ops: organiser only, and an AI proposal containing one is always shown as an approval card. */
export const V6_OPS: ReadonlySet<string> = new Set(["set_priorities", "add_vendor", "set_vendor_stage", "remove_vendor", "set_vendor_need", "set_task_dependency"]);

/** Ops the AI never sees and the reducer runs only for source "ui". */
export const DIRECT_EDIT_OPS: ReadonlySet<string> = new Set(["rename_event", "set_partner_names", "rename_entity", "set_planned_amount", "save_idea", "dismiss_idea"]);
/** Ops only the organiser may run, whoever built the batch. Listed so the guest check is explicit, not implied. */
export const ORGANIZER_ONLY_OPS: ReadonlySet<string> = new Set(["add_budget_item", "remove_budget_item", "set_event_basics", "rebalance_budget",
  "add_ideas", "save_idea", "dismiss_idea", "adopt_idea", ...V6_OPS]);

/** The commands the AI may propose (declared to Gemini). Unchanged by the direct-edit ops. */
export const AgentCommand = z.discriminatedUnion("op", [
  AdjustBudget, MoveSubEvent, ShiftBlock, SetTaskStatus, RecordPayment, SetRsvp,
  SetItemLock, ClaimWishlistItem, SetPermitStatus, UpdateSponsor,
  UpsertVendorQuote, SetGuestDiet, CommunitySignup, SetSubEventVisibility,
  AddBudgetItem, RemoveBudgetItem, SetEventBasics, RebalanceBudget, AdoptIdea,
  SetPriorities, AddVendor, SetVendorStage, RemoveVendor, SetVendorNeed, SetTaskDependency,
]);
export const Command = z.discriminatedUnion("op", [
  AdjustBudget, MoveSubEvent, ShiftBlock, SetTaskStatus, RecordPayment, SetRsvp,
  SetItemLock, ClaimWishlistItem, SetPermitStatus, UpdateSponsor,
  UpsertVendorQuote, SetGuestDiet, CommunitySignup, SetSubEventVisibility,
  RenameEvent, SetPartnerNames, RenameEntity, SetPlannedAmount,
  AddBudgetItem, RemoveBudgetItem, SetEventBasics, RebalanceBudget,
  AddIdeas, SaveIdea, DismissIdea, AdoptIdea,
  SetPriorities, AddVendor, SetVendorStage, RemoveVendor, SetVendorNeed, SetTaskDependency,
]);
export type Command = z.infer<typeof Command>;
export type CommandInput = z.input<typeof Command>;

export const Batch = z.object({
  commands: z.array(Command).min(1).max(20),
  summary: z.string().describe("One line that echoes the change back to the user"),
});
export type Batch = z.infer<typeof Batch>;
export type BatchInput = z.input<typeof Batch>;
/** The batch schema declared to the LLM: the same shape, without the direct-edit ops. */
export const AgentBatch = z.object({
  commands: z.array(AgentCommand).min(1).max(20),
  summary: z.string().describe("One line that echoes the change back to the user"),
});
/** Who built the batch. Direct edits need "ui"; everything else behaves the same for both. */
export type BatchSource = "agent" | "ui";

// ---------- roles ----------
export type Role = "organizer" | "guest";
/** Guest / Committee Concierge mode may only run these. Everything else is refused at the reducer boundary. */
export const GUEST_ALLOWED_OPS: ReadonlySet<Command["op"]> = new Set(["set_rsvp", "set_guest_diet", "claim_wishlist_item", "community_signup"]);

// ---------- helpers ----------
/** How an adopted idea reads as a task, and how many days before its sub-event it is due. Code decides, never the LLM. */
export const IDEA_TASK_VERB: Record<z.infer<typeof IdeaKind>, string> = {
  theme: "Finalise theme", decor: "Arrange decor", menu: "Confirm menu", activity: "Organise", return_gift: "Order return gifts",
  invite_text: "Send invite", music: "Book music", photo: "Plan photos",
};
export const IDEA_TASK_LEAD_DAYS: Record<z.infer<typeof IdeaKind>, number> = {
  theme: -60, decor: -21, menu: -30, activity: -14, return_gift: -21, invite_text: -45, music: -30, photo: -45,
};
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

/**
 * Largest remainder at a whole-rupee grain: the rupees are shared by the weights first, then any odd paise (< ₹1) by the
 * same rule. Still exact to the paisa and deterministic, but whole-rupee totals give whole-rupee shares, so envelopes the
 * code fills in (setup, rebalance) never show stray paise.
 */
export function allocateRupeeGrain(total: number, weights: { id: string; w: number }[]): Map<string, number> {
  const rupeesPart = allocateLargestRemainder(Math.floor(total / 100), weights);
  const paisePart = allocateLargestRemainder(total % 100, weights);
  return new Map(weights.map(x => [x.id, rupeesPart.get(x.id)! * 100 + paisePart.get(x.id)!]));
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
  // Whole-rupee cuts over whole-rupee slack stay in whole rupees (no stray paise on a line); otherwise exact to the paisa.
  const alloc = need % 100 === 0 && slack.every(x => x.w % 100 === 0) ? allocateRupeeGrain(need, slack) : allocateLargestRemainder(need, slack);
  for (const [id, v] of alloc) if (v > 0) out.set(id, -v);
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
    case "set_sub_event_visibility": {
      if (role === "guest") throw new PlanError("Only the organiser can change who sees a sub-event");
      const s = findSubEvent(st, c.subEvent);
      if (s.visibility === c.visibility) { log.push(`${s.name} is already ${c.visibility}`); return st; }
      log.push(`${s.name}: ${c.visibility === "public" ? "shown on the public guest link" : "hidden from the public guest link (invited households still see it)"}`);
      return { ...st, subEvents: st.subEvents.map(x => x.id === s.id ? { ...x, visibility: c.visibility } : x) };
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
      const quoteBody = { amountPaise: c.quotedPaise, basis: c.basis ?? ("flat" as const), receivedOn, notes: c.notes ?? "",
        inclusions: c.inclusions ?? [], exclusions: c.exclusions ?? [], extraCharges: (c.extraCharges ?? []).map(x => ({ label: x.label, amountPaise: x.amountPaise ?? null })),
        guestsCovered: c.guestsCovered ?? null, openQuestions: c.openQuestions ?? [] };
      const need = c.need && slotByKey(st, c.need) ? c.need : null;
      const vendors = existingVendor
        ? st.vendors.map(v => v.id !== vendorId ? v : {
            ...v, stage: v.stage === "shortlisted" || v.stage === "contacted" ? ("quoted" as const) : v.stage,
            quotes: [...v.quotes, { id: `${vendorId}-q${v.quotes.length + 1}`, ...quoteBody }] })
        : [...st.vendors, { id: vendorId, name: c.vendorName.trim(), category: c.category, phone: "", email: "", stage: "quoted" as const, rating: null, need,
            quotes: [{ id: `${vendorId}-q1`, ...quoteBody }] }];
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
          quoteNotes: c.notes ?? "", quoteRedFlags: c.redFlags ?? [], basis: "flat", perGuestPaise: null };
        item = { ...item, payments: withDeposit(item) };
        budgetItems = [...st.budgetItems, item];
      }
      const gap = c.quotedPaise - item.plannedPaise;
      log.push(`${c.vendorName}: quote ${rupees(c.quotedPaise)} on ${match ? `"${item.label}"` : `new line "${item.label}"`}`);
      if (gap > 0) log.push(`⚠ Quote exceeds planned envelope by ${rupees(gap)}`);
      return { ...st, vendors, budgetItems };
    }
    case "rename_event": {
      if (role === "guest") throw new PlanError("Only the organiser can rename the event");
      const before = st.event.title;
      if (before === c.title) { log.push(`Event is already called "${c.title}"`); return st; }
      log.push(`Event renamed: "${before}" → "${c.title}"`);
      return { ...st, event: { ...st.event, title: c.title } };
    }
    case "set_partner_names": {
      if (role === "guest") throw new PlanError("Only the organiser can change the couple's names");
      const ext = st.event.ext;
      if (ext.type !== "wedding") throw new PlanError("Partner names only exist on wedding events");
      log.push(`Couple: ${c.partners[0]} & ${c.partners[1]}`);
      return { ...st, event: { ...st.event, ext: { ...ext, partners: [c.partners[0], c.partners[1]] } } };
    }
    case "rename_entity": {
      if (role === "guest") throw new PlanError("Only the organiser can rename things");
      const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
      const done = (what: string, before: string) => log.push(`Renamed ${what} "${before}" → "${c.name}"`);
      switch (c.kind) {
        case "budget_item": {
          const b = st.budgetItems.find(x => x.id === c.id); if (!b) throw new PlanError(`No budget item ${c.id}`);
          done("budget line", b.label);
          return { ...st, budgetItems: st.budgetItems.map(x => x.id === b.id ? { ...x, label: c.name } : x) };
        }
        case "task": {
          const t = st.tasks.find(x => x.id === c.id); if (!t) throw new PlanError(`No task ${c.id}`);
          done("task", t.title);
          return { ...st, tasks: st.tasks.map(x => x.id === t.id ? { ...x, title: c.name } : x) };
        }
        case "sub_event": {
          const s = st.subEvents.find(x => x.id === c.id); if (!s) throw new PlanError(`No sub-event ${c.id}`);
          // Sub-events are looked up by id, slug or name: a second one answering to the same word would make that ambiguous.
          const clash = st.subEvents.find(x => x.id !== s.id && (same(x.name, c.name) || same(x.slug, c.name)));
          if (clash) throw new PlanError(`Another sub-event is already called "${clash.name}"`);
          done("sub-event", s.name); // the slug stays, so links, prompts and RSVP keys keep working
          return { ...st, subEvents: st.subEvents.map(x => x.id === s.id ? { ...x, name: c.name } : x) };
        }
        case "guest": {
          const g = st.guests.find(x => x.id === c.id); if (!g) throw new PlanError(`No guest ${c.id}`);
          done("guest", g.name);
          return { ...st, guests: st.guests.map(x => x.id === g.id ? { ...x, name: c.name } : x) };
        }
        case "household": {
          const h = st.households.find(x => x.id === c.id); if (!h) throw new PlanError(`No household ${c.id}`);
          done("household", h.label);
          return { ...st, households: st.households.map(x => x.id === h.id ? { ...x, label: c.name } : x) };
        }
        case "vendor": {
          const v = st.vendors.find(x => x.id === c.id); if (!v) throw new PlanError(`No vendor ${c.id}`);
          // Quotes are matched to vendors by name, so two vendors may not share one.
          const clash = st.vendors.find(x => x.id !== v.id && same(x.name, c.name));
          if (clash) throw new PlanError(`Another vendor is already called "${clash.name}"`);
          done("vendor", v.name);
          return { ...st, vendors: st.vendors.map(x => x.id === v.id ? { ...x, name: c.name } : x) };
        }
      }
      throw new PlanError("Unknown rename target");
    }
    case "set_planned_amount": {
      if (role === "guest") throw new PlanError("Only the organiser can change the budget");
      const b = st.budgetItems.find(x => x.id === c.budgetItemId);
      if (!b) throw new PlanError(`No budget item ${c.budgetItemId}`);
      if (b.plannedPaise !== c.expectedPaise) throw new PlanError(`${b.label} changed while you were editing: it is now ${rupees(b.plannedPaise)}`);
      if (c.plannedPaise === b.plannedPaise) { log.push(`${b.label}: planned stays ${rupees(b.plannedPaise)}`); return st; }
      // Same rules as adjust_budget: a lock only protects against cuts, and nothing is planned below what is committed.
      if (b.locked && c.plannedPaise < b.plannedPaise) throw new PlanError(`${b.label} is locked: unlock it before lowering its plan`);
      if (c.plannedPaise < b.committedPaise) throw new PlanError(`${b.label} can't be planned below the ${rupees(b.committedPaise)} already committed`);
      log.push(`${b.label}: planned ${rupees(b.plannedPaise)} → ${rupees(c.plannedPaise)}`);
      return { ...st, budgetItems: st.budgetItems.map(x => x.id === b.id ? { ...x, plannedPaise: c.plannedPaise } : x) };
    }
    case "add_budget_item": {
      if (role === "guest") throw new PlanError("Only the organiser can add budget lines");
      const label = c.label.trim();
      const dup = st.budgetItems.find(b => b.category === c.category && b.label.trim().toLowerCase() === label.toLowerCase());
      if (dup) throw new PlanError(`There is already a ${c.category} line called "${dup.label}"`);
      const subEventId = c.subEvent ? findSubEvent(st, c.subEvent).id : null;
      const id = uniqueId(`bi-${slug(label)}`, x => st.budgetItems.some(b => b.id === x));
      const booked = c.alreadyBooked === true;
      const item: BudgetItem = { id, category: c.category, label, subEventId, vendorId: null, plannedPaise: c.plannedPaise, quotedPaise: null,
        committedPaise: booked ? c.plannedPaise : 0, payments: [], locked: booked, quoteNotes: "", quoteRedFlags: [], basis: "flat", perGuestPaise: null };
      log.push(`Added ${c.category} line "${label}": planned ${rupees(c.plannedPaise)}${booked ? " (already booked: committed and locked)" : ""}`);
      return { ...st, budgetItems: [...st.budgetItems, item] };
    }
    case "remove_budget_item": {
      if (role === "guest") throw new PlanError("Only the organiser can remove budget lines");
      const b = st.budgetItems.find(x => x.id === c.budgetItemId);
      if (!b) throw new PlanError(`No budget item ${c.budgetItemId}`);
      if (b.committedPaise > 0) throw new PlanError(`${b.label} has ${rupees(b.committedPaise)} committed, so it can't be removed`);
      if (b.payments.length > 0) throw new PlanError(`${b.label} has payments recorded against it, so it can't be removed`);
      log.push(`Removed budget line "${b.label}" (${rupees(b.plannedPaise)} planned)`);
      return { ...st, budgetItems: st.budgetItems.filter(x => x.id !== b.id),
        ideas: st.ideas.map(i => i.adoptedBudgetItemId === b.id ? { ...i, adoptedBudgetItemId: null } : i) };
    }
    case "set_event_basics": {
      if (role === "guest") throw new PlanError("Only the organiser can change the event basics");
      const { totalBudgetPaise, guestCount, city, startDate, endDate } = c;
      if (totalBudgetPaise === undefined && guestCount === undefined && city === undefined && startDate === undefined && endDate === undefined)
        throw new PlanError("Nothing to change: give a total budget, guest count, city or dates");
      let next = st;
      const e = st.event;
      if (totalBudgetPaise !== undefined && totalBudgetPaise !== e.totalBudgetPaise) {
        const committed = st.budgetItems.reduce((a, b) => a + b.committedPaise, 0);
        if (totalBudgetPaise < committed) throw new PlanError(`The total can't go below the ${rupees(committed)} already committed`);
        log.push(`Total budget: ${rupees(e.totalBudgetPaise)} → ${rupees(totalBudgetPaise)}`);
        next = { ...next, event: { ...next.event, totalBudgetPaise } };
      }
      if (guestCount !== undefined && guestCount !== e.guestCount) {
        log.push(`Guest count: ${e.guestCount} → ${guestCount}`);
        // Per-guest lines move by rate × (new − old), computed here in integer paise: never by the LLM, never by a ratio.
        const diff = guestCount - e.guestCount;
        const budgetItems = next.budgetItems.map(b => {
          if (b.basis !== "per_guest" || b.perGuestPaise === null || b.perGuestPaise === 0) return b;
          const want = b.plannedPaise + b.perGuestPaise * diff;
          if (diff < 0 && b.locked) { log.push(`${b.label}: locked, so it stays ${rupees(b.plannedPaise)} (unlock it to scale down)`); return b; }
          const to = Math.max(b.committedPaise, want);
          if (to === b.plannedPaise) return b;
          log.push(`${b.label}: ${rupees(b.plannedPaise)} → ${rupees(to)} (${rupees(b.perGuestPaise)} × ${Math.abs(diff)} ${diff > 0 ? "more" : "fewer"} guest${Math.abs(diff) === 1 ? "" : "s"}${to !== want ? `, held at the ${rupees(b.committedPaise)} committed` : ""})`);
          return { ...b, plannedPaise: to };
        });
        next = { ...next, budgetItems, event: { ...next.event, guestCount } };
      }
      if (city !== undefined && city.trim() !== e.city) {
        log.push(`City: ${e.city || "(not set)"} → ${city.trim()}`);
        next = { ...next, event: { ...next.event, city: city.trim() } };
      }
      if (startDate !== undefined || endDate !== undefined) {
        const L = BASICS_LIMITS;
        for (const d of [startDate, endDate]) if (d !== undefined && (d < L.minDate || d > L.maxDate || addDays(d, 0) !== d))
          throw new PlanError(`${d} isn't a usable date (between ${L.minDate} and ${L.maxDate})`);
        // Code computes the shift in whole days and moves every sub-event (and the dates hanging off them) by it.
        const shift = startDate !== undefined ? daysBetween(e.startDate, startDate) : 0;
        const start = addDays(e.startDate, shift);
        const end = endDate ?? addDays(e.endDate, shift);
        if (end < start) throw new PlanError("The last day can't be before the first day");
        if (daysBetween(start, end) + 1 > L.maxWindowDays) throw new PlanError(`Keep the event window to ${L.maxWindowDays} days or fewer`);
        const subEvents = next.subEvents.map(x => ({ ...x, date: addDays(x.date, shift) }));
        const outside = subEvents.find(x => x.date < start || x.date > end);
        if (outside) throw new PlanError(`${outside.name} (${outside.date}) would fall outside ${start}..${end}`);
        const ext = next.event.ext;
        const movedExt = shift === 0 ? ext : ext.type === "wedding" ? { ...ext, rsvpDeadline: ext.rsvpDeadline ? addDays(ext.rsvpDeadline, shift) : null }
          : ext.type === "community" ? { ...ext, permits: ext.permits.map(p => ({ ...p, applyBy: p.applyBy ? addDays(p.applyBy, shift) : null })) } : ext;
        if (shift !== 0) log.push(`Dates: everything moves ${shift > 0 ? "+" : "−"}${Math.abs(shift)} day${Math.abs(shift) === 1 ? "" : "s"} (${e.startDate} → ${start})`);
        if (end !== addDays(e.endDate, shift) || shift === 0) log.push(`Event window: ${start} to ${end}`);
        next = { ...next, subEvents, event: { ...next.event, startDate: start, endDate: end, ext: movedExt } };
      }
      if (next === st) log.push("Event basics unchanged");
      return next;
    }
    case "rebalance_budget": {
      if (role === "guest") throw new PlanError("Only the organiser can rebalance the budget");
      const head = st.event.totalBudgetPaise - plannedTotal(st);
      if (head !== c.expectedHeadroomPaise) throw new PlanError(`The budget changed since this preview: headroom is now ${rupees(head)}`);
      if (head === 0) { log.push("Planned already equals the total"); return st; }
      const unlocked = st.budgetItems.filter(b => !b.locked);
      if (!unlocked.length) throw new PlanError("Every line is locked: unlock one to rebalance");
      let deltas: Map<string, number>;
      const prio = st.priorities;
      if (!isDefaultPriorities(prio)) {
        // v6: the organiser's priorities decide. Spare money goes to protected lines first (3×), flexible (1×), never cut-first;
        // a shortfall is taken from cut-first, then flexible, and only as a last resort from protected categories.
        if (head > 0) {
          const mult = (cat: string) => (prio.protect.includes(cat as never) ? 3 : prio.cutFirst.includes(cat as never) ? 0 : 1);
          let w = unlocked.map(b => ({ id: b.id, w: b.plannedPaise * mult(b.category) }));
          if (!w.some(x => x.w > 0)) w = unlocked.map(b => ({ id: b.id, w: b.plannedPaise }));
          deltas = allocateRupeeGrain(head, w.some(x => x.w > 0) ? w : w.map(x => ({ ...x, w: 1 })));
        } else {
          const plan = planPriorityCut(st, -head, { allowProtected: true });
          if (plan.shortfallPaise > 0) throw new PlanError(`Planned is ${rupees(-head)} over the total but only ${rupees(-head - plan.shortfallPaise)} of unlocked lines isn't committed yet`);
          deltas = new Map();
          for (const cut of plan.cuts) for (const [id, v] of spreadOverSlack(st.budgetItems.filter(b => b.category === cut.category && !b.locked), cut.cutPaise)) deltas.set(id, -v);
          log.push(`By your priorities: ${plan.cuts.map(x => `${x.category} −${rupees(x.cutPaise)}`).join(", ")}`);
        }
      } else if (head > 0) {
        const w = unlocked.map(b => ({ id: b.id, w: b.plannedPaise }));
        deltas = allocateRupeeGrain(head, w.some(x => x.w > 0) ? w : w.map(x => ({ ...x, w: 1 })));
      } else {
        const slack = unlocked.map(b => ({ id: b.id, w: Math.max(0, b.plannedPaise - b.committedPaise) }));
        const room = slack.reduce((a, x) => a + x.w, 0);
        if (room < -head) throw new PlanError(`Planned is ${rupees(-head)} over the total but only ${rupees(room)} of unlocked lines isn't committed yet`);
        deltas = new Map([...allocateRupeeGrain(-head, slack)].map(([id, v]) => [id, -v]));
      }
      const touched = [...deltas.values()].filter(v => v !== 0).length;
      log.push(`Rebalanced ${head > 0 ? "+" : "−"}${rupees(Math.abs(head))} across ${touched} unlocked line${touched === 1 ? "" : "s"}: planned now equals the ${rupees(st.event.totalBudgetPaise)} total`);
      return { ...st, budgetItems: st.budgetItems.map(b => deltas.has(b.id) ? { ...b, plannedPaise: b.plannedPaise + deltas.get(b.id)! } : b) };
    }
    case "add_ideas": {
      if (role === "guest") throw new PlanError("Ideas are for the organiser");
      const seen = new Set(st.ideas.map(i => i.title.trim().toLowerCase()));
      const fresh: AgentState["ideas"] = [];
      let n = st.ideas.length;
      for (const d of c.ideas) {
        const key = d.title.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (d.estLowPaise !== null && d.estHighPaise !== null && d.estLowPaise > d.estHighPaise) throw new PlanError(`"${d.title}": low estimate is above the high one`);
        const id = uniqueId(`idea-${++n}`, x => st.ideas.some(i => i.id === x) || fresh.some(i => i.id === x));
        fresh.push({ id, kind: d.kind, title: d.title.trim(), description: d.description, estLowPaise: d.estLowPaise, estHighPaise: d.estHighPaise,
          category: d.category, tags: d.tags, status: "new", source: d.source, overBudget: d.overBudget, adoptedTaskId: null, adoptedBudgetItemId: null,
          refinedFrom: d.refinedFrom !== null && st.ideas.some(i => i.id === d.refinedFrom) ? d.refinedFrom : null });
      }
      if (!fresh.length) { log.push("No new ideas (all already on the board)"); return st; }
      let ideas = [...st.ideas, ...fresh];
      // The board keeps at most 200: the oldest dismissed ideas make room first.
      while (ideas.length > 200) {
        const i = ideas.findIndex(x => x.status === "dismissed");
        if (i < 0) throw new PlanError("The idea board is full: dismiss a few ideas first");
        ideas = ideas.filter((_, k) => k !== i);
      }
      log.push(`${fresh.length} new idea${fresh.length === 1 ? "" : "s"} on the board`);
      return { ...st, ideas };
    }
    case "save_idea": case "dismiss_idea": {
      if (role === "guest") throw new PlanError("Ideas are for the organiser");
      const i = st.ideas.find(x => x.id === c.ideaId);
      if (!i) throw new PlanError(`No idea ${c.ideaId}`);
      const status = c.op === "save_idea" ? "saved" as const : "dismissed" as const;
      if (i.status === status) { log.push(`"${i.title}" is already ${status}`); return st; }
      log.push(`Idea "${i.title}": ${status}`);
      return { ...st, ideas: st.ideas.map(x => x.id === i.id ? { ...x, status } : x) };
    }
    case "adopt_idea": {
      if (role === "guest") throw new PlanError("Ideas are for the organiser");
      const i = st.ideas.find(x => x.id === c.ideaId);
      if (!i) throw new PlanError(`No idea ${c.ideaId}`);
      if (i.adoptedTaskId || i.adoptedBudgetItemId) throw new PlanError(`"${i.title}" is already in the plan`);
      const main = st.subEvents.find(x => x.isMain);
      const subEventId = c.subEvent ? findSubEvent(st, c.subEvent).id : main?.id ?? null;
      let next = st;
      let taskId: string | null = null, itemId: string | null = null;
      if (c.addTask) {
        taskId = uniqueId(`tk-idea-${slug(i.title).slice(0, 24)}`, x => st.tasks.some(t => t.id === x));
        const title = `${IDEA_TASK_VERB[i.kind]}: ${i.title}`.slice(0, MAX_NAME_LENGTH);
        next = { ...next, tasks: [...next.tasks, { id: taskId, title, subEventId, vendorId: null, dueOffsetDays: IDEA_TASK_LEAD_DAYS[i.kind], status: "todo", priority: "med", column: "todo", dependsOn: [] }] };
        log.push(`New task "${title}" (${IDEA_TASK_LEAD_DAYS[i.kind]} days before ${main && subEventId === main.id ? main.name : st.subEvents.find(x => x.id === subEventId)?.name ?? "the event"})`);
      }
      const amount = c.plannedPaise ?? i.estLowPaise ?? 0;
      if (c.addBudgetLine && i.category && amount > 0) {
        itemId = uniqueId(`bi-idea-${slug(i.title).slice(0, 24)}`, x => st.budgetItems.some(b => b.id === x));
        next = { ...next, budgetItems: [...next.budgetItems, { id: itemId, category: i.category, label: i.title.slice(0, MAX_NAME_LENGTH), subEventId, vendorId: null,
          plannedPaise: amount, quotedPaise: null, committedPaise: 0, payments: [], locked: false, quoteNotes: "", quoteRedFlags: [], basis: "flat" as const, perGuestPaise: null }] };
        log.push(`New ${i.category} line "${i.title}": planned ${rupees(amount)}`);
      }
      if (!taskId && !itemId) throw new PlanError(`Nothing to add for "${i.title}": it has no cost or category, and no task was asked for`);
      return { ...next, ideas: next.ideas.map(x => x.id === i.id ? { ...x, status: "saved" as const, adoptedTaskId: taskId, adoptedBudgetItemId: itemId } : x) };
    }
    case "set_priorities": {
      if (role === "guest") throw new PlanError("Only the organiser can set priorities");
      const protect = [...new Set(c.protect)], cutFirst = [...new Set(c.cutFirst)];
      const both = protect.find(x => cutFirst.includes(x));
      if (both) throw new PlanError(`${both} can't be both protected and cut first`);
      const p = st.priorities;
      if (p.level === c.level && p.protect.join() === protect.join() && p.cutFirst.join() === cutFirst.join()) { log.push("Priorities unchanged"); return st; }
      log.push(`Priorities: protect ${protect.join(", ") || "(none)"} · cut first ${cutFirst.join(", ") || "(none)"} · ${c.level}`);
      return { ...st, priorities: { protect, cutFirst, level: c.level } };
    }
    case "add_vendor": {
      if (role === "guest") throw new PlanError("Only the organiser can add vendors");
      const name = c.name.trim();
      const dup = st.vendors.find(v => v.name.trim().toLowerCase() === name.toLowerCase());
      if (dup) throw new PlanError(`There is already a vendor called "${dup.name}"`);
      if (c.need !== undefined && !slotByKey(st, c.need)) throw new PlanError(`"${c.need}" isn't on the vendor checklist for a ${st.event.eventType}`);
      const id = uniqueId(`v-${slug(name)}`, x => st.vendors.some(v => v.id === x));
      log.push(`Added vendor "${name}" (${c.category}) to the shortlist`);
      return { ...st, vendors: [...st.vendors, { id, name, category: c.category, phone: c.phone?.trim() ?? "", email: "", stage: "shortlisted", quotes: [], rating: null, need: c.need ?? null }] };
    }
    case "set_vendor_stage": {
      if (role === "guest") throw new PlanError("Only the organiser can change a vendor's stage");
      const v = st.vendors.find(x => x.id === c.vendorId);
      if (!v) throw new PlanError(`No vendor ${c.vendorId}`);
      if (v.stage === c.stage) { log.push(`${v.name} is already ${c.stage}`); return st; }
      log.push(`${v.name}: ${v.stage} → ${c.stage}`);
      return { ...st, vendors: st.vendors.map(x => x.id === v.id ? { ...x, stage: c.stage } : x) };
    }
    case "remove_vendor": {
      if (role === "guest") throw new PlanError("Only the organiser can remove vendors");
      const v = st.vendors.find(x => x.id === c.vendorId);
      if (!v) throw new PlanError(`No vendor ${c.vendorId}`);
      const linked = st.budgetItems.filter(b => b.vendorId === v.id && (b.committedPaise > 0 || b.payments.length > 0));
      if (linked.length) throw new PlanError(`${v.name} has money committed on ${linked.map(b => `"${b.label}"`).join(", ")}, so it can't be removed`);
      log.push(`Removed vendor "${v.name}"`);
      return { ...st, vendors: st.vendors.filter(x => x.id !== v.id),
        budgetItems: st.budgetItems.map(b => b.vendorId === v.id ? { ...b, vendorId: null } : b),
        tasks: st.tasks.map(t => t.vendorId === v.id ? { ...t, vendorId: null } : t),
        timeline: st.timeline.map(b => b.vendorId === v.id ? { ...b, vendorId: null } : b) };
    }
    case "set_vendor_need": {
      if (role === "guest") throw new PlanError("Only the organiser can change the vendor checklist");
      const slot = slotByKey(st, c.need);
      if (!slot) throw new PlanError(`"${c.need}" isn't on the vendor checklist for a ${st.event.eventType}`);
      const off = new Set(st.vendorChecklist.notNeeded);
      if (c.needed ? !off.has(c.need) : off.has(c.need)) { log.push(`${slot.label} is already ${c.needed ? "needed" : "marked not needed"}`); return st; }
      if (c.needed) off.delete(c.need); else off.add(c.need);
      log.push(`${slot.label}: ${c.needed ? "needed again" : "not needed"}`);
      return { ...st, vendorChecklist: { ...st.vendorChecklist, notNeeded: [...off].sort() } };
    }
    case "set_task_dependency": {
      if (role === "guest") throw new PlanError("Only the organiser can change task dependencies");
      const t = st.tasks.find(x => x.id === c.taskId);
      if (!t) throw new PlanError(`No task ${c.taskId}`);
      const deps = [...new Set(c.dependsOn)];
      for (const d of deps) {
        if (d === t.id) throw new PlanError("A task can't wait for itself");
        if (!st.tasks.some(x => x.id === d)) throw new PlanError(`No task ${d}`);
      }
      // Refuse a cycle: walking the new graph from any dependency must never reach this task.
      const graph = new Map(st.tasks.map(x => [x.id, x.id === t.id ? deps : x.dependsOn]));
      const seen = new Set<string>(), stack = [...deps];
      while (stack.length) {
        const id = stack.pop()!;
        if (id === t.id) throw new PlanError(`That would make "${t.title}" wait for itself through another task`);
        if (seen.has(id)) continue;
        seen.add(id);
        stack.push(...(graph.get(id) ?? []));
      }
      const names = deps.map(d => `"${st.tasks.find(x => x.id === d)!.title}"`);
      log.push(deps.length ? `"${t.title}" now waits for ${names.join(", ")}` : `"${t.title}" no longer waits for another task`);
      return { ...st, tasks: st.tasks.map(x => x.id === t.id ? { ...x, dependsOn: deps } : x) };
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
  violations: string[], withSuggestion: boolean, summary: string, source: BatchSource = "agent"): Rejection {
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
      const r = runBatch(state, candidate, false, "organizer", source);
      if (r.ok) suggestion = candidate;
    }
  }
  return { ok: false, state, error: reason, reason, failedCommandIndex: idx, diagnostics, ...(suggestion ? { suggestion } : {}) };
}

function runBatch(state: AgentState, input: unknown, withSuggestion: boolean, role: Role = "organizer", source: BatchSource = "agent"): BatchResult {
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
  if (source !== "ui") {
    const direct = commands.findIndex(c => DIRECT_EDIT_OPS.has(c.op));
    if (direct >= 0) {
      const reason = `"${commands[direct]!.op}" is a direct edit: only the organiser's own controls can run it, not the AI.`;
      return { ok: false, state, error: reason, reason, failedCommandIndex: direct,
        diagnostics: { categoryMaxCuttablePaise: categoryMaxCuttable(state), knownSubEvents: state.subEvents.map(s => s.slug), violations: ["source:agent"] } };
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
      if (e instanceof PlanError) return buildRejection(state, next, commands, i, e.message, [], withSuggestion, summary, source);
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
    return buildRejection(state, prefixes[idx]!, commands, idx, errs.join("; "), errs, withSuggestion, summary, source);
  }
  if (plannedTotal(next) > next.event.totalBudgetPaise) log.push(`⚠ Over budget by ₹${((plannedTotal(next) - next.event.totalBudgetPaise) / 100).toLocaleString("en-IN")}`);
  return { ok: true, state: next, log };
}

/**
 * All or nothing: the whole batch applies or none of it does. Returns the new state, or the old one with
 * a structured rejection (reason, failing command index, diagnostics, and a verified counter-offer when one exists).
 * It's pure, so calling it is also the dry-run preview.
 */
export function applyBatch(state: AgentState, input: unknown, opts: { role?: Role; source?: BatchSource } = {}): BatchResult {
  return runBatch(state, input, opts.role !== "guest", opts.role ?? "organizer", opts.source ?? "agent");
}
/** Spec alias: the same pure reducer. */
export const applyPlanChanges = applyBatch;
