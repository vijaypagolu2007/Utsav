// Clean-room schema for a GenAI event planner.
// It follows the conventions of the MIT-licensed @jfrusher/knotwork contract:
// loose objects with defaults, slices merged rather than rewritten, minutes from midnight.
// Concepts from OSWP (AGPL) were studied, but none of its code or field names were copied.
import { z } from "zod";

/** Money is stored as integers in the minor unit (paise), so totals never drift. */
export const Money = z.number().int().nonnegative();
/** Calendar date in the event's local zone, written YYYY-MM-DD. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Minutes from the day's 00:00, the same convention Knotwork's Cadence uses. */
export const MinuteOfDay = z.number().int().min(0).max(24 * 60);
const Id = z.string().min(1);

// ---------- Shared enums: the one definition of each status vocabulary ----------
// Commands, the blueprint schema, guest projection and the UI option lists (src/config/planner-options.ts) all reuse these,
// so a value can never be valid in one place and unknown in another. Persisted values are part of the storage format: never rename one.
export const EventType = z.enum(["wedding", "birthday", "community"]);
export const Priority = z.enum(["low", "med", "high"]);
export const RsvpStatus = z.enum(["invited", "yes", "no", "maybe"]);
export const TaskStatus = z.enum(["todo", "doing", "done", "blocked"]);
export const SponsorTier = z.enum(["title", "gold", "silver", "in_kind"]);
export const SponsorStatus = z.enum(["prospect", "pitched", "committed", "paid", "declined"]);
export const PermitStatus = z.enum(["not_started", "applied", "approved", "rejected"]);

// ---------- Event, with one extension block per event type ----------
const WeddingExt = z.looseObject({
  type: z.literal("wedding"),
  partners: z.tuple([z.string(), z.string()]).default(["", ""]),
  traditions: z.array(z.string()).default([]), // e.g. ["telugu", "hindu"]
  rsvpDeadline: IsoDate.nullable().default(null),
});
const BirthdayExt = z.looseObject({
  type: z.literal("birthday"),
  honoree: z.string().default(""),
  turningAge: z.number().int().nullable().default(null),
  theme: z.string().default(""),
  wishlist: z.array(z.looseObject({
    id: Id, item: z.string(), url: z.string().url().optional(),
    approxPaise: Money.optional(), claimedByGuestId: Id.nullable().default(null),
    priority: Priority.default("med"),
  })).default([]),
  activities: z.array(z.looseObject({
    id: Id, name: z.string(), ageRange: z.tuple([z.number(), z.number()]).optional(),
    durationMin: z.number().int().positive(), supplies: z.array(z.string()).default([]),
  })).default([]),
});
const CommunityExt = z.looseObject({
  type: z.literal("community"),
  organizer: z.string().default(""),
  expectedFootfall: z.number().int().nonnegative().default(0),
  sponsors: z.array(z.looseObject({
    id: Id, name: z.string(), tier: SponsorTier,
    pledgedPaise: Money.default(0), receivedPaise: Money.default(0),
    deliverables: z.array(z.string()).default([]), // "logo on banner", "stall"
    status: SponsorStatus.default("prospect"),
  })).default([]),
  permits: z.array(z.looseObject({
    id: Id, authority: z.string(),            // "GHMC", "Police", "Fire NOC"
    kind: z.string(), applyBy: IsoDate.nullable().default(null),
    status: PermitStatus.default("not_started"),
    feePaise: Money.default(0), referenceNo: z.string().default(""),
  })).default([]),
  volunteers: z.number().int().nonnegative().default(0),
  /** Self-service sign-ups from Guest / Committee mode. */
  volunteerSignups: z.array(z.looseObject({
    id: Id, name: z.string(), subEventId: Id.nullable().default(null), shift: z.string().default(""),
  })).default([]),
});
export const EventExt = z.discriminatedUnion("type", [WeddingExt, BirthdayExt, CommunityExt]);

export const Event = z.looseObject({
  id: Id,
  title: z.string(),
  eventType: EventType,
  city: z.string().default(""),
  currency: z.string().default("INR"),
  totalBudgetPaise: Money,
  /** Headcount the plan is sized for (the guest list may still be filling up). */
  guestCount: z.number().int().nonnegative().default(0),
  /** Window that every sub-event date must fall inside. */
  startDate: IsoDate,
  endDate: IsoDate,
  utcOffsetMin: z.number().int().nullable().default(null),
  ext: EventExt,
});

// ---------- Sub-events: Haldi, Sangeet, Muhurtham, Reception / Cake, Games / Stage, Food court ----------
export const SubEvent = z.looseObject({
  id: Id,
  name: z.string(),                 // "Haldi"
  slug: z.string(),                 // "haldi", used for name lookup by the agent
  date: IsoDate,
  startMin: MinuteOfDay,
  endMin: MinuteOfDay,
  venue: z.string().default(""),
  dressCode: z.string().default(""),
  collectsRsvp: z.boolean().default(true),
  isMain: z.boolean().default(false), // the anchor event (the wedding day, the birthday party)
  phase: z.enum(["pre", "main", "post"]).default("pre"), // Haldi is pre, Reception is post
  // Who sees it on a shared guest link. New and legacy sub-events default to private (fail closed); see visibility.ts.
  visibility: z.enum(["public", "private"]).default("private"),
});

// ---------- Budget: planned envelope, then quote, then committed, then paid ----------
export const BudgetItem = z.looseObject({
  id: Id,
  category: z.enum(["venue", "catering", "decor", "photo_video", "music", "attire",
    "beauty", "stationery", "gifts", "logistics", "permits", "entertainment", "misc"]),
  label: z.string(),                 // "Haldi marigold decor"
  subEventId: Id.nullable().default(null),
  vendorId: Id.nullable().default(null),
  plannedPaise: Money,               // the envelope: what we intend to spend
  quotedPaise: Money.nullable().default(null),   // the vendor's best quote
  committedPaise: Money.default(0),  // signed or contracted, the floor for any cut
  payments: z.array(z.looseObject({
    id: Id, amountPaise: Money, kind: z.enum(["deposit", "installment", "final"]),
    dueDate: IsoDate, paidDate: IsoDate.nullable().default(null), refundable: z.boolean().default(false),
  })).default([]),
  locked: z.boolean().default(false), // the user pinned it, so the agent can't cut it
  /** Terms pulled from the latest vendor quote (cancellation, corkage, overtime). */
  quoteNotes: z.string().default(""),
  quoteRedFlags: z.array(z.string()).default([]),
});

export const Vendor = z.looseObject({
  id: Id, name: z.string(), category: BudgetItem.shape.category,
  phone: z.string().default(""), email: z.string().default(""),
  stage: z.enum(["shortlisted", "contacted", "quoted", "negotiating", "booked", "dropped"]).default("shortlisted"),
  quotes: z.array(z.looseObject({
    id: Id, amountPaise: Money, basis: z.enum(["flat", "per_guest", "per_hour"]),
    receivedOn: IsoDate, notes: z.string().default(""),
  })).default([]),
  rating: z.number().min(0).max(5).nullable().default(null),
});

export const Task = z.looseObject({
  id: Id, title: z.string(),
  subEventId: Id.nullable().default(null),
  vendorId: Id.nullable().default(null),
  /** The due date is derived: (sub-event date, or the main event) + offsetDays. Moving a sub-event moves its tasks. */
  dueOffsetDays: z.number().int(),   // -30 means 30 days before
  status: TaskStatus.default("todo"),
  priority: Priority.default("med"),
  column: z.string().default("todo"), // kanban lane
});

export const TimelineBlock = z.looseObject({
  id: Id, subEventId: Id,
  label: z.string(),                 // "Haldi application", "Lunch"
  lane: z.string().default("main"),  // "main", "decor", "catering" (one lane per crew)
  startMin: MinuteOfDay, endMin: MinuteOfDay,
  vendorId: Id.nullable().default(null),
  anchored: z.boolean().default(false), // muhurtham: never shift automatically
});

export const Household = z.looseObject({
  id: Id, label: z.string(),         // "Rao family"
  side: z.string().default(""),      // "bride", "groom", "friends", "school"
  inviteCode: z.string().default(""),
  phone: z.string().default(""),
});

export const Guest = z.looseObject({
  id: Id, householdId: Id, name: z.string(),
  ageGroup: z.enum(["adult", "child", "infant"]).default("adult"),
  isPlusOne: z.boolean().default(false),
  diet: z.array(z.string()).default([]),   // "veg", "jain", "no-onion-garlic"
  /** Each guest's RSVP is per sub-event. A missing key means not invited to it. */
  rsvp: z.record(Id, RsvpStatus).default({}),
});

export const AgentState = z.looseObject({
  version: z.literal(1).default(1),
  event: Event,
  subEvents: z.array(SubEvent).default([]),
  budgetItems: z.array(BudgetItem).default([]),
  tasks: z.array(Task).default([]),
  timeline: z.array(TimelineBlock).default([]),
  vendors: z.array(Vendor).default([]),
  households: z.array(Household).default([]),
  guests: z.array(Guest).default([]),
});

export type AgentState = z.infer<typeof AgentState>;
/** Alias used by the UI and insights layer. */
export type EventPlan = AgentState;
export type BudgetItem = z.infer<typeof BudgetItem>;
export type SubEvent = z.infer<typeof SubEvent>;
export type Task = z.infer<typeof Task>;
export type TimelineBlock = z.infer<typeof TimelineBlock>;
export type Guest = z.infer<typeof Guest>;
export type Household = z.infer<typeof Household>;
export type Vendor = z.infer<typeof Vendor>;
export type EventExt = z.infer<typeof EventExt>;
export type BudgetCategory = BudgetItem["category"];
export type EventType = z.infer<typeof EventType>;
export type Priority = z.infer<typeof Priority>;
export type RsvpStatus = z.infer<typeof RsvpStatus>;
export type TaskStatus = z.infer<typeof TaskStatus>;
export type SponsorTier = z.infer<typeof SponsorTier>;
export type SponsorStatus = z.infer<typeof SponsorStatus>;
export type PermitStatus = z.infer<typeof PermitStatus>;
export const BUDGET_CATEGORIES = BudgetItem.shape.category.options;
