// Canonical option lists for every select, chip group and toggle in the UI.
// Values come from the Zod enums in schema.ts (the persisted vocabulary); this file adds only display labels and order.
// Each label map is a Record over the enum, so adding an enum value without a label is a type error.
// Client-safe: imports nothing but the schema.
import { PermitStatus, RsvpStatus, SponsorStatus, SponsorTier, TaskStatus } from "../schema";

export type Option<V extends string> = Readonly<{ value: V; label: string }>;

const options = <V extends string>(values: readonly V[], labels: Readonly<Record<V, string>>): readonly Option<V>[] =>
  Object.freeze(values.map(value => Object.freeze({ value, label: labels[value] })));

// ---------- RSVP (per guest, per sub-event) ----------
/** "invited" means asked but not answered yet, which the UI calls "pending". */
export const RSVP_LABELS: Readonly<Record<RsvpStatus, string>> = { invited: "pending", yes: "yes", no: "no", maybe: "maybe" };
export const RSVP_STATUS_OPTIONS = options(RsvpStatus.options, RSVP_LABELS);
/** The answers a guest can give, in the order the RSVP buttons show them. "invited" is not an answer. */
export const GUEST_RSVP_ANSWERS = ["yes", "maybe", "no"] as const satisfies readonly RsvpStatus[];
export type GuestRsvpAnswer = (typeof GUEST_RSVP_ANSWERS)[number];
/** Organizer RSVP matrix: one click advances to the next state. */
export const RSVP_CYCLE: Readonly<Record<RsvpStatus, RsvpStatus>> = { invited: "yes", yes: "no", no: "maybe", maybe: "invited" };

// ---------- Dietary needs ----------
/**
 * The suggested meal preferences guests can toggle. Guest.diet stays an open string array in the schema on purpose:
 * older saved plans, AI blueprints and free text ("halal", "nut allergy") must keep loading, and the UI shows any
 * extra value it finds. Only the chips below are offered for one-tap selection.
 */
export const DIET_VALUES = ["veg", "non-veg", "jain", "vegan", "no-onion-garlic", "gluten-free"] as const;
export type DietValue = (typeof DIET_VALUES)[number];
export const DIET_OPTIONS = options(DIET_VALUES, {
  veg: "veg", "non-veg": "non-veg", jain: "jain", vegan: "vegan", "no-onion-garlic": "no-onion-garlic", "gluten-free": "gluten-free",
});

// ---------- Tasks ----------
export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = { todo: "To do", doing: "Doing", blocked: "Blocked", done: "Done" };
/** Kanban column order (differs from the enum order on purpose: Blocked sits before Done). */
export const TASK_COLUMN_ORDER = ["todo", "doing", "blocked", "done"] as const satisfies readonly TaskStatus[];
export const TASK_STATUS_OPTIONS = options(TASK_COLUMN_ORDER, TASK_STATUS_LABELS);
/** Clicking a task advances it one step. */
export const TASK_NEXT_STATUS: Readonly<Record<TaskStatus, TaskStatus>> = { todo: "doing", doing: "done", blocked: "doing", done: "todo" };

// ---------- Community: sponsors, permits, volunteers ----------
export const SPONSOR_TIER_OPTIONS = options(SponsorTier.options, { title: "title", gold: "gold", silver: "silver", in_kind: "in-kind" });
export const SPONSOR_STATUS_OPTIONS = options(SponsorStatus.options, { prospect: "prospect", pitched: "pitched", committed: "committed", paid: "paid", declined: "declined" });
export const PERMIT_STATUS_OPTIONS = options(PermitStatus.options, { not_started: "not started", applied: "applied", approved: "approved", rejected: "rejected" });
/** Default tier pre-selected on the sponsor-interest form. */
export const DEFAULT_SPONSOR_TIER: SponsorTier = "silver";
/** Shift choices on the in-app volunteer form. Shifts are free text in the schema; these are suggestions. */
export const VOLUNTEER_SHIFTS = Object.freeze(["Morning", "Afternoon", "Evening", "Setup crew", "Cleanup crew"] as const);

/** Label lookup for any of the option lists above, falling back to the raw value (legacy or free-text data). */
export const labelOf = <V extends string>(list: readonly Option<V>[], value: string): string =>
  list.find(o => o.value === value)?.label ?? value;
