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
/**
 * One gift on a birthday wishlist or a wedding registry (v8 Part 1: the same shape for both). `url` is a shopping link
 * the organiser typed: https only (checked by isSafeWishlistUrl in commands.ts when it is added or edited), rendered as a
 * plain link and never fetched by the server. Older plans may hold any URL; the guest projection re-checks it.
 */
export const WishlistItem = z.looseObject({
  id: Id, item: z.string(), url: z.string().url().optional(),
  approxPaise: Money.optional(), claimedByGuestId: Id.nullable().default(null),
  priority: Priority.default("med"),
});
const WeddingExt = z.looseObject({
  type: z.literal("wedding"),
  partners: z.tuple([z.string(), z.string()]).default(["", ""]),
  traditions: z.array(z.string()).default([]), // e.g. ["telugu", "hindu"]
  rsvpDeadline: IsoDate.nullable().default(null),
  /** v8 Part 1: the gift registry. Default [] so weddings saved before it still parse. */
  wishlist: z.array(WishlistItem).max(100).default([]),
  /** v8 Part 1: surprise mode. The public link hides which gifts are claimed and the organiser view hides who claimed. */
  wishlistSurprise: z.boolean().default(false),
});
const BirthdayExt = z.looseObject({
  type: z.literal("birthday"),
  honoree: z.string().default(""),
  turningAge: z.number().int().nullable().default(null),
  theme: z.string().default(""),
  wishlist: z.array(WishlistItem).max(100).default([]),
  /** v8 Part 1: surprise mode (see WeddingExt). */
  wishlistSurprise: z.boolean().default(false),
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
  /** The organiser's "anything special" note from setup (traditions, theme, must-haves). Feeds personalised ideas. */
  notes: z.string().max(1000).default(""),
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
  /** v6: "flat" (one amount) or "per_guest" (rescaled in code when the guest count changes). Legacy lines are flat. */
  basis: z.enum(["flat", "per_guest"]).default("flat"),
  /** v6: the per-guest rate in paise for a per_guest line. A guest-count change moves plannedPaise by rate × (new − old). */
  perGuestPaise: Money.nullable().default(null),
});

export const VendorStage = z.enum(["shortlisted", "contacted", "quoted", "negotiating", "booked", "dropped"]);
export const QuoteBasis = z.enum(["flat", "per_guest", "per_hour"]);
/** One extra charge a quote names ("Generator backup", "Overtime per hour"). The amount is null when the quote doesn't say. */
export const ExtraCharge = z.looseObject({ label: z.string().min(1).max(120), amountPaise: Money.nullable().default(null) });
export const VendorQuote = z.looseObject({
  id: Id, amountPaise: Money, basis: QuoteBasis,
  receivedOn: IsoDate, notes: z.string().default(""),
  // v6 structured comparison fields. Defaults keep quotes saved before v6 valid.
  inclusions: z.array(z.string().max(160)).max(30).default([]),
  exclusions: z.array(z.string().max(160)).max(30).default([]),
  extraCharges: z.array(ExtraCharge).max(20).default([]),
  /** Guests the quoted amount covers (a flat package for 300); null when the quote doesn't say. */
  guestsCovered: z.number().int().positive().nullable().default(null),
  /** Things still to clarify with the vendor before booking. */
  openQuestions: z.array(z.string().max(200)).max(20).default([]),
});
export const Vendor = z.looseObject({
  id: Id, name: z.string(), category: BudgetItem.shape.category,
  phone: z.string().default(""), email: z.string().default(""),
  stage: VendorStage.default("shortlisted"),
  quotes: z.array(VendorQuote).default([]),
  rating: z.number().min(0).max(5).nullable().default(null),
  /** v6: the vendor-checklist slot this vendor is for ("photographer", "mehendi_artist"); null = matched by category. */
  need: z.string().max(40).nullable().default(null),
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
  /** v6: ids of tasks that must be done first (venue booking before decor). Default [] so legacy tasks parse. */
  dependsOn: z.array(Id).max(20).default([]),
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
  /** Organizer-only (v8 Part 1: E.164 when entered through the guest ops). Never in the guest projection, the public page or logs. */
  phone: z.string().default(""),
  /** Organizer-only, from a vCard or contact import. Same privacy rule as phone. */
  email: z.string().max(254).default(""),
});

export const Guest = z.looseObject({
  id: Id, householdId: Id, name: z.string(),
  ageGroup: z.enum(["adult", "child", "infant"]).default("adult"),
  isPlusOne: z.boolean().default(false),
  diet: z.array(z.string()).default([]),   // "veg", "jain", "no-onion-garlic"
  /** Each guest's RSVP is per sub-event. A missing key means not invited to it. */
  rsvp: z.record(Id, RsvpStatus).default({}),
});

// ---------- v8 Part 1: group join requests and the RSVP change log (organizer only; never in the guest projection) ----------
/** Someone who opened the organizer's group join link and asked to be added. Approving creates a household. */
export const JoinRequest = z.looseObject({
  id: Id,
  name: z.string().min(1).max(80),
  /** People in their household, the requester included. */
  size: z.number().int().min(1).max(20),
  /** E.164, or "" when not given. Cleared once the request is decided (it moves to the household on approval). */
  phone: z.string().default(""),
  /** ISO time the server received it. */
  at: z.string().default(""),
  status: z.enum(["pending", "approved", "rejected"]).default("pending"),
  householdId: Id.nullable().default(null),
});
export const ChangeSource = z.enum(["organizer", "copilot", "guest_link", "guest_preview"]);
/** One RSVP or meal-preference change: who changed what, when, and through which door. */
export const RsvpLogEntry = z.looseObject({
  id: Id,
  at: z.string(),
  householdId: z.string(),
  householdLabel: z.string().default(""),
  guestId: z.string(),
  guestName: z.string().default(""),
  field: z.enum(["rsvp", "diet"]),
  /** For an RSVP: the sub-event it was for. */
  subEventId: z.string().nullable().default(null),
  before: z.string().max(200),
  after: z.string().max(200),
  source: ChangeSource,
});
/** The change log keeps the newest entries only. */
export const RSVP_LOG_CAP = 300;
export const JOIN_RECORDS_CAP = 200;

// ---------- v8 Part 1c: the open RSVP list (one link for everyone; no guest list needed) ----------
/** One meal choice per RSVP (the whole party). Persisted values: never rename one. */
export const RsvpMeal = z.enum(["veg", "non_veg", "jain"]);
/** A guest's own answer on the open RSVP form. */
export const RsvpAnswer = z.enum(["coming", "maybe", "not_coming"]);
/** Largest party one RSVP can carry (the guest form's 1 to 20). */
export const RSVP_MAX_PARTY = 20;
/**
 * Most RSVPs one event keeps, removed ones included. 1,000 RSVPs is 3,000+ people at the usual 3 to 4 per family. The
 * real bound is bytes: the whole plan (entries included) must stay under the 400 KiB limit shared with cloud save, whose
 * Firestore rule can't be raised without a rules change, so the server also refuses a write that would cross it.
 */
export const RSVP_ENTRIES_CAP = 1000;
export const RSVP_NAME_MAX = 80;
/**
 * One RSVP from the open link. Guest-owned: name, phone, partySize, kids, functions, meal, answer, updatedAt. Organizer-owned:
 * vip, removedAt, mergedInto. possibleDuplicateOf is set by the server (same phone hash from another device) and cleared
 * by the organizer (merge, or "not a duplicate"). The phone is organizer-only, like a household phone: never in the guest
 * projection, the public API, the AI prompt, logs or approval cards (masked there).
 */
export const RsvpEntry = z.looseObject({
  id: z.string().regex(/^r-[A-Za-z0-9_-]{4,40}$/),
  name: z.string().min(1).max(RSVP_NAME_MAX),
  /** E.164 or "". */
  phone: z.string().max(16).default(""),
  partySize: z.number().int().min(1).max(RSVP_MAX_PARTY).default(1),
  /** How many of the party are children; null when the organizer doesn't ask. */
  kids: z.number().int().min(0).max(RSVP_MAX_PARTY).nullable().default(null),
  /** Sub-event ids this party is attending. */
  functions: z.array(Id).max(30).default([]),
  meal: RsvpMeal.default("veg"),
  answer: RsvpAnswer.default("coming"),
  vip: z.boolean().default(false),
  possibleDuplicateOf: z.string().nullable().default(null),
  /** Soft delete: the row moves to "Recently removed" and can be restored. Its device can't write any more. */
  removedAt: z.string().nullable().default(null),
  /** Set when the organizer merged this entry into another one; its device then edits that one. */
  mergedInto: z.string().nullable().default(null),
  createdAt: z.string().default(""),
  updatedAt: z.string().default(""),
});
/** Organizer settings for the open RSVP form. closesAt is a UTC instant (the organizer picks it in IST). */
export const RsvpSettings = z.looseObject({
  closesAt: z.string().nullable().default(null),
  askKids: z.boolean().default(false),
});

// ---------- Ideas: personalised suggestions (theme, decor, menu, ...) the organiser can save, dismiss or adopt ----------
export const IdeaKind = z.enum(["theme", "decor", "menu", "activity", "return_gift", "invite_text", "music", "photo"]);
export const IdeaStatus = z.enum(["new", "saved", "dismissed"]);
export const Idea = z.looseObject({
  id: Id,
  kind: IdeaKind,
  title: z.string().min(1).max(120),
  description: z.string().max(400).default(""),
  /** Estimated cost range in paise (converted from rupees by code, never by the LLM). Both null when there's no cost. */
  estLowPaise: Money.nullable().default(null),
  estHighPaise: Money.nullable().default(null),
  category: BudgetItem.shape.category.nullable().default(null),
  tags: z.array(z.string().max(40)).max(8).default([]),
  status: IdeaStatus.default("new"),
  /** Where it came from: live Gemini or the offline curated bank. */
  source: z.enum(["gemini", "demo"]).default("demo"),
  /** Set when the low estimate was above the category's headroom at the time it was suggested. */
  overBudget: z.boolean().default(false),
  /** What adopt_idea created from it (task and/or budget line ids). */
  adoptedTaskId: Id.nullable().default(null),
  adoptedBudgetItemId: Id.nullable().default(null),
  /** v6: set on a refinement ("cheaper alternative", "kid-friendly", "more traditional"): the idea it came from. */
  refinedFrom: Id.nullable().default(null),
});

// ---------- v6: the organiser's priorities: which budget categories to protect, which to cut first, and how lavish ----------
export const ExperienceLevel = z.enum(["simple", "balanced", "premium"]);
export const PriorityTier = z.enum(["protect", "flexible", "cut_first"]);
export const Priorities = z.looseObject({
  /** Must-protect categories, most important first. Overrun fixes never take from these. */
  protect: z.array(BudgetItem.shape.category).max(13).default([]),
  /** Cut-first categories, the first to give when money is short. Every other category is flexible. */
  cutFirst: z.array(BudgetItem.shape.category).max(13).default([]),
  level: ExperienceLevel.default("balanced"),
});
export const DEFAULT_PRIORITIES = { protect: [], cutFirst: [], level: "balanced" } as const;

// ---------- v6: vendor checklist state the organiser sets (which checklist slots aren't needed) ----------
export const VendorChecklistState = z.looseObject({ notNeeded: z.array(z.string().max(40)).max(40).default([]) });

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
  /** Organizer-only idea board. Default [] so plans saved before ideas existed still parse. Never in the guest projection. */
  ideas: z.array(Idea).max(200).default([]),
  /** v6: organiser-only. Defaults so plans saved before v6 still parse. Never in the guest projection. */
  priorities: Priorities.default({ protect: [], cutFirst: [], level: "balanced" }),
  vendorChecklist: VendorChecklistState.default({ notNeeded: [] }),
  /** v8 Part 1: organizer-only. Defaults so older plans still parse. */
  joinRequests: z.array(JoinRequest).max(JOIN_RECORDS_CAP).default([]),
  rsvpLog: z.array(RsvpLogEntry).max(RSVP_LOG_CAP).default([]),
  /** v8 Part 1c: the open RSVP list and its settings. Defaults so older plans still parse. */
  rsvpEntries: z.array(RsvpEntry).max(RSVP_ENTRIES_CAP).default([]),
  rsvpSettings: RsvpSettings.default({ closesAt: null, askKids: false }),
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
export type Idea = z.infer<typeof Idea>;
export type WishlistItem = z.infer<typeof WishlistItem>;
export type JoinRequest = z.infer<typeof JoinRequest>;
export type RsvpLogEntry = z.infer<typeof RsvpLogEntry>;
export type ChangeSource = z.infer<typeof ChangeSource>;
export type RsvpEntry = z.infer<typeof RsvpEntry>;
export type RsvpMeal = z.infer<typeof RsvpMeal>;
export type RsvpAnswer = z.infer<typeof RsvpAnswer>;
export type RsvpSettings = z.infer<typeof RsvpSettings>;
export type IdeaKind = z.infer<typeof IdeaKind>;
export type IdeaStatus = z.infer<typeof IdeaStatus>;
export type BudgetCategory = BudgetItem["category"];
export type EventType = z.infer<typeof EventType>;
export type Priority = z.infer<typeof Priority>;
export type RsvpStatus = z.infer<typeof RsvpStatus>;
export type TaskStatus = z.infer<typeof TaskStatus>;
export type SponsorTier = z.infer<typeof SponsorTier>;
export type SponsorStatus = z.infer<typeof SponsorStatus>;
export type PermitStatus = z.infer<typeof PermitStatus>;
export const BUDGET_CATEGORIES = BudgetItem.shape.category.options;
export type Priorities = z.infer<typeof Priorities>;
export type ExperienceLevel = z.infer<typeof ExperienceLevel>;
export type PriorityTier = z.infer<typeof PriorityTier>;
export type VendorQuote = z.infer<typeof VendorQuote>;
export type VendorStage = z.infer<typeof VendorStage>;
