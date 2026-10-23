// v6: the vendor workspace, as pure derivations of the plan: which checklist slot each vendor fills, each slot's
// status (needed → shortlisted → quoted → booked, or not needed), and quotes normalised for a fair comparison.
// Money is integer paise; a per-guest figure is rounded half up with BigInt. Nothing here claims availability or a price.
import type { AgentState, BudgetItem, Vendor, VendorQuote } from "./schema";
import { checklistFor, type ChecklistSlot } from "./config/vendor-checklist";

export type SlotStatus = "not_needed" | "needed" | "shortlisted" | "quoted" | "booked";
export const SLOT_STATUS_LABEL: Record<SlotStatus, string> = { not_needed: "Not needed", needed: "Needed", shortlisted: "Shortlisted", quoted: "Quoted", booked: "Booked" };
/** The stages a slot moves through, in order (for the progress steps). */
export const SLOT_STEPS: SlotStatus[] = ["needed", "shortlisted", "quoted", "booked"];

/** Vendors filling a slot: those that name it, plus unassigned vendors of its category when it is that category's first slot. */
export function vendorsForSlot(plan: AgentState, slot: ChecklistSlot, slots: ChecklistSlot[] = checklistFor(plan)): Vendor[] {
  const firstOfCategory = slots.find(s => s.category === slot.category)?.key === slot.key;
  return plan.vendors.filter(v => v.stage !== "dropped" && (v.need === slot.key || (v.need === null && firstOfCategory && v.category === slot.category)));
}

export function slotStatus(plan: AgentState, slot: ChecklistSlot, slots: ChecklistSlot[] = checklistFor(plan)): SlotStatus {
  if (plan.vendorChecklist.notNeeded.includes(slot.key)) return "not_needed";
  const vs = vendorsForSlot(plan, slot, slots);
  if (vs.some(v => v.stage === "booked")) return "booked";
  if (vs.some(v => v.stage === "quoted" || v.stage === "negotiating" || v.quotes.length > 0)) return "quoted";
  if (vs.length) return "shortlisted";
  return "needed";
}

export type ChecklistRow = { slot: ChecklistSlot; status: SlotStatus; vendors: Vendor[]; plannedPaise: number };
/** Every slot for the plan with its status, its vendors and what the plan sets aside for its category (an estimate). */
export function checklistRows(plan: AgentState): ChecklistRow[] {
  const slots = checklistFor(plan);
  return slots.map(slot => ({ slot, status: slotStatus(plan, slot, slots), vendors: vendorsForSlot(plan, slot, slots),
    plannedPaise: plan.budgetItems.filter(b => b.category === slot.category).reduce((a, b) => a + b.plannedPaise, 0) }));
}
export function checklistProgress(rows: ChecklistRow[]) {
  const live = rows.filter(r => r.status !== "not_needed");
  return { booked: live.filter(r => r.status === "booked").length, total: live.length };
}

/** a / b rounded half up, exact for any size (BigInt). */
export function divRound(a: number, b: number): number {
  if (b <= 0) throw new Error("divide by zero");
  const A = BigInt(a), B = BigInt(b);
  return Number((A * 2n + B) / (B * 2n));
}

export type NormalisedQuote = {
  vendorId: string; vendorName: string; stage: Vendor["stage"]; quoteId: string;
  amountPaise: number; basis: VendorQuote["basis"];
  /** Guests the comparison uses: the quote's own figure, or the plan's guest count (then `guestsAssumed`). */
  guests: number; guestsAssumed: boolean;
  /** The quoted amount for the whole event (per-guest × guests), or null for a per-hour quote. */
  totalPaise: number | null;
  /** totalPaise ÷ guests, rounded half up to the paisa; null when it can't be computed. */
  perGuestPaise: number | null;
  inclusions: string[]; exclusions: string[];
  extras: { label: string; amountPaise: number | null }[];
  /** Sum of the extra charges that name an amount (optional add-ons, not added to the total). */
  knownExtrasPaise: number;
  /** Extra charges whose amount the quote doesn't give. */
  unpricedExtras: number;
  openQuestions: string[];
  receivedOn: string;
  notes: string;
};

/** One vendor quote, normalised so different bases can be compared. */
export function normaliseQuote(v: Vendor, q: VendorQuote, planGuests: number): NormalisedQuote {
  const guests = q.guestsCovered ?? Math.max(1, planGuests);
  const guestsAssumed = q.guestsCovered === null;
  const totalPaise = q.basis === "flat" ? q.amountPaise : q.basis === "per_guest" ? q.amountPaise * guests : null;
  const perGuestPaise = q.basis === "per_guest" ? q.amountPaise : totalPaise === null ? null : divRound(totalPaise, guests);
  const extras = q.extraCharges.map(x => ({ label: x.label, amountPaise: x.amountPaise }));
  const openQuestions = [...q.openQuestions];
  if (guestsAssumed) openQuestions.push(`How many guests does it cover? (compared at your ${guests})`);
  if (q.basis === "per_hour") openQuestions.push("How many hours, and what is the total?");
  return { vendorId: v.id, vendorName: v.name, stage: v.stage, quoteId: q.id, amountPaise: q.amountPaise, basis: q.basis, guests, guestsAssumed, totalPaise, perGuestPaise,
    inclusions: q.inclusions, exclusions: q.exclusions, extras, knownExtrasPaise: extras.reduce((a, x) => a + (x.amountPaise ?? 0), 0),
    unpricedExtras: extras.filter(x => x.amountPaise === null).length, openQuestions, receivedOn: q.receivedOn, notes: q.notes };
}

/** The latest quote of every vendor in a slot, normalised; cheapest per guest first (unknown last, then by name). */
export function compareQuotes(plan: AgentState, vendors: Vendor[]): NormalisedQuote[] {
  return vendors.filter(v => v.quotes.length > 0).map(v => normaliseQuote(v, v.quotes[v.quotes.length - 1]!, plan.event.guestCount))
    .sort((a, b) => (a.perGuestPaise ?? Infinity) - (b.perGuestPaise ?? Infinity) || a.vendorName.localeCompare(b.vendorName));
}

// ---------------------------------------------------------------- Estimate / Quoted / Committed
export type FigureKind = "estimate" | "quoted" | "committed";
export const FIGURE_LABEL: Record<FigureKind, string> = { estimate: "Estimate", quoted: "Quoted", committed: "Committed" };
export const FIGURE_HINT: Record<FigureKind, string> = {
  estimate: "A planning estimate (from your setup, a blueprint or an idea), not a vendor's price",
  quoted: "From a vendor's actual quote; not yet signed",
  committed: "Signed or paid: money you have committed",
};
/** What a budget line's figure is: committed money beats a quote, a quote beats an estimate. */
export const figureKind = (b: Pick<BudgetItem, "committedPaise" | "quotedPaise">): FigureKind =>
  b.committedPaise > 0 ? "committed" : b.quotedPaise !== null ? "quoted" : "estimate";
