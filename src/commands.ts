// One command language and one pure reducer. Gemini function calls and CopilotKit actions
// both reach the state only through applyBatch(), so the same command always yields the same state.
import { z } from "zod";
import { AgentState, BudgetItem, ExperienceLevel, IdeaKind, IsoDate, MinuteOfDay, Money, PermitStatus, Priority, QuoteBasis, RSVP_LOG_CAP, JOIN_RECORDS_CAP, RsvpStatus, SponsorStatus, SponsorTier, TaskStatus, VendorStage, RsvpAnswer, RsvpMeal, RSVP_ENTRIES_CAP, RSVP_MAX_PARTY, RSVP_NAME_MAX, type ChangeSource, type RsvpEntry, type RsvpLogEntry, type WishlistItem } from "./schema";
import { normalizePhone } from "./phone";
import { ANSWER_LABEL, istToUtcIso, MEAL_LABEL, RSVP_CLOSED_MESSAGE, RSVP_ENTRY_ID, RSVP_REMOVED_MESSAGE, rsvpClosed, rsvpFunctions, formatIst } from "./rsvp";
import { slotByKey } from "./config/vendor-checklist";
import { computeRunSheetTimes, formatClock, parseHHMM, runSheetEnd, RUN_SHEET_INPUT } from "./run-sheet";
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

/**
 * v8 Part 0c. The reducer never deletes anything: this op changes no plan data. An approved delete_event card asks the
 * organizer to confirm in the app, which moves the event to Recently deleted (src/trash.ts). Always Tier 2, alone in
 * its batch, organiser only.
 */
export const DeleteEvent = z.object({
  op: z.literal("delete_event"),
  reason: z.string().max(200).optional().describe("Why, in the user's words (optional)"),
}).describe("Organizer only. Propose deleting the event on screen. Nothing is deleted until the organizer approves the card and confirms; it can be restored for 30 days. Never combine with other changes.");


// ---------- v8 Part 1: the guest list, the group join queue and the gift wishlist / registry ----------
/** Limits that keep a shared plan well under its 400 KB cap and a single approval card readable. */
export const GUEST_LIMITS = { maxImport: 300, maxGuests: 1500, maxHouseholds: 1000, maxHouseholdSize: 20, maxPendingJoins: 50, maxWishlist: 100, maxWishRupees: 10_000_000 } as const;
const PersonName = z.string().trim().min(1, "Name can't be empty").max(MAX_NAME_LENGTH, `Keep it under ${MAX_NAME_LENGTH} characters`);
const Side = z.string().trim().max(40);
/** A phone as typed; the reducer normalises it to E.164 (India default) and refuses one that isn't a number. */
const PhoneInput = z.string().trim().max(40);
const EmailInput = z.string().trim().max(254).refine(v => v === "" || /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v), "Not an email address");
const AgeGroup = z.enum(["adult", "child", "infant"]);
const InvitedTo = z.array(Ref).max(30).describe("Sub-events (slugs) this guest is invited to. Leave out to invite them to every sub-event that collects RSVPs");

export const AddHousehold = z.object({
  op: z.literal("add_household"),
  label: PersonName.describe("Household name, e.g. 'Rao family'"),
  side: Side.optional().describe("bride, groom, friends, school, ..."),
  phone: PhoneInput.optional().describe("WhatsApp number as written; the tool normalises it"),
  email: EmailInput.optional(),
  members: z.array(z.object({ name: PersonName, ageGroup: AgeGroup.optional() })).max(GUEST_LIMITS.maxHouseholdSize).optional().describe("The people in it"),
  invitedTo: InvitedTo.optional(),
}).describe("Organizer only. Add a household (and its members) to the guest list.");

export const UpdateHousehold = z.object({
  op: z.literal("update_household"),
  householdId: z.string().min(1),
  label: PersonName.optional(),
  side: Side.optional(),
  phone: PhoneInput.optional().describe("\"\" clears it"),
  email: EmailInput.optional(),
}).describe("Organizer only. Change a household's name, side, phone or email.");

export const RemoveHousehold = z.object({
  op: z.literal("remove_household"),
  householdId: z.string().min(1),
}).describe("Organizer only. Remove a household and everyone in it (their gift claims are released).");

export const AddGuest = z.object({
  op: z.literal("add_guest"),
  householdId: z.string().min(1),
  name: PersonName,
  ageGroup: AgeGroup.optional(),
  isPlusOne: z.boolean().optional(),
  invitedTo: InvitedTo.optional(),
}).describe("Organizer only. Add a person to an existing household.");

export const UpdateGuest = z.object({
  op: z.literal("update_guest"),
  guestId: z.string().min(1),
  name: PersonName.optional(),
  ageGroup: AgeGroup.optional(),
  householdId: z.string().min(1).optional().describe("Move them to another household"),
  invitedTo: InvitedTo.optional().describe("Replace the sub-events they're invited to; answers already given are kept"),
}).describe("Organizer only. Edit a guest.");

export const RemoveGuest = z.object({
  op: z.literal("remove_guest"),
  guestId: z.string().min(1),
}).describe("Organizer only. Remove one guest (their gift claim is released; the household stays).");

export const ImportEntry = z.object({
  name: PersonName,
  phone: PhoneInput.optional().describe("As written; normalised and used to skip duplicates"),
  email: z.string().trim().max(254).optional(),
  household: z.string().trim().max(MAX_NAME_LENGTH).optional().describe("Group several people into one household by giving the same name"),
  side: Side.optional(),
});
export const ImportGuests = z.object({
  op: z.literal("import_guests"),
  entries: z.array(ImportEntry).min(1).max(GUEST_LIMITS.maxImport),
  source: z.enum(["paste", "vcf", "contacts", "ai"]).default("paste"),
}).describe("Organizer only. Add many guests at once (one household each unless `household` groups them). Duplicates by phone are skipped. Always shown as one approval card.");

export const RequestJoin = z.object({
  op: z.literal("request_join"),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/),
  name: z.string().trim().min(1).max(80),
  size: z.number().int().min(1).max(GUEST_LIMITS.maxHouseholdSize),
  phone: PhoneInput.optional(),
  at: z.string().max(40),
}).describe("Public, join endpoint only. A pending request to be added to the guest list.");

export const ApproveJoinRequest = z.object({
  op: z.literal("approve_join_request"),
  requestId: z.string().min(1),
  side: Side.optional(),
}).describe("Organizer only. Approve a pending join request: it becomes a household with its own private RSVP link.");

export const RejectJoinRequest = z.object({
  op: z.literal("reject_join_request"),
  requestId: z.string().min(1),
}).describe("Organizer only. Decline a pending join request (its phone number is deleted).");

/**
 * A wishlist link: https only, no user:password@, no bare IP address or localhost, at most 500 characters. Links are only
 * ever rendered for a person to click (rel="noopener noreferrer nofollow"); the server never fetches them, so there is no
 * SSRF surface, and refusing other schemes keeps javascript: and data: URLs out of the guest page.
 */
export function isSafeWishlistUrl(raw: string): boolean {
  if (raw.length > 500 || /\s/.test(raw)) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\d+(\.\d+){3}$/.test(h) || h.startsWith("[")) return false; // IPv4 / IPv6 literals
  return true;
}
const WishUrl = z.string().trim().max(500).refine(v => v === "" || isSafeWishlistUrl(v), "Use a full https:// shop link (no other kinds of link)");
const WishRupees = z.number().int().min(0).max(GUEST_LIMITS.maxWishRupees).describe("Approximate price in whole rupees, as the user said it; the tool converts");

export const AddWishlistItem = z.object({
  op: z.literal("add_wishlist_item"),
  item: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  url: WishUrl.optional(),
  approxRupees: WishRupees.optional(),
  priority: Priority.optional(),
}).describe("Organizer only. Add a gift to the birthday wishlist or the wedding registry.");

export const UpdateWishlistItem = z.object({
  op: z.literal("update_wishlist_item"),
  itemId: z.string().min(1),
  item: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
  url: WishUrl.optional().describe("\"\" removes the link"),
  approxRupees: WishRupees.nullable().optional().describe("null removes the price"),
  priority: Priority.optional(),
}).describe("Organizer only. Edit a wishlist or registry gift.");

export const RemoveWishlistItem = z.object({
  op: z.literal("remove_wishlist_item"),
  itemId: z.string().min(1),
}).describe("Organizer only. Remove a gift from the wishlist or registry.");

export const SetWishlistSurprise = z.object({
  op: z.literal("set_wishlist_surprise"),
  on: z.boolean(),
}).describe("Organizer only. Surprise mode: the public link hides which gifts are claimed, and the organiser view hides who claimed them.");

export const UnclaimWishlistItem = z.object({
  op: z.literal("unclaim_wishlist_item"),
  itemId: z.string().min(1),
  guestId: z.string().min(1).describe("The guest who claimed it; only their own claim can be released"),
}).describe("Release your own gift claim.");

// ---------- v8 Part 1c: the open RSVP list ----------
const EntryId = z.string().regex(RSVP_ENTRY_ID, "Not an RSVP entry id");
/**
 * A guest's RSVP from the open link (the server's /rsvp endpoint), or from Guest View / the guest Co-Pilot in the organizer's
 * app. Creates the entry when entryId is new, otherwise updates it. The server picks entryId from the device token and is
 * the only caller that may set duplicateOf (same phone from another device).
 */
export const SubmitRsvpEntry = z.object({
  op: z.literal("submit_rsvp_entry"),
  entryId: EntryId.describe("The RSVP being answered: the acting guest's own entry id, or a new id for a new RSVP"),
  name: z.string().trim().min(1, "Enter your name").max(RSVP_NAME_MAX, `Keep the name under ${RSVP_NAME_MAX} characters`),
  phone: z.string().trim().max(40).optional().describe("As typed (Indian numbers need no +91). Leave out to keep the one on file"),
  partySize: z.number().int().min(1).max(RSVP_MAX_PARTY).default(1).describe("People in this RSVP, the guest included"),
  kids: z.number().int().min(0).max(RSVP_MAX_PARTY).optional().describe("Children among them (only when the organizer asks)"),
  functions: z.array(Ref).max(30).default([]).describe("Sub-events (slugs) this party is attending"),
  meal: RsvpMeal,
  answer: RsvpAnswer,
  duplicateOf: z.string().max(60).nullable().optional().describe("Server only: the entry with the same phone"),
}).describe("A guest's own RSVP on the open link: name, party size, functions, meal and answer.");
export const SetRsvpVip = z.object({
  op: z.literal("set_rsvp_vip"),
  entryId: EntryId, vip: z.boolean(),
}).describe("Organizer only. Mark an RSVP as VIP (or not).");
export const RemoveRsvpEntry = z.object({
  op: z.literal("remove_rsvp_entry"),
  entryId: EntryId,
}).describe("Organizer only. Remove an RSVP (soft delete: it moves to Recently removed and can be restored).");
export const RestoreRsvpEntry = z.object({
  op: z.literal("restore_rsvp_entry"),
  entryId: EntryId,
}).describe("Organizer only. Bring back a removed RSVP.");
export const MergeRsvpEntries = z.object({
  op: z.literal("merge_rsvp_entries"),
  keepId: EntryId.describe("The RSVP whose answers are kept (usually the newest)"),
  dropId: EntryId.describe("The duplicate that is folded into it"),
}).describe("Organizer only. Merge two RSVPs for the same family: keepId's answers stay; dropId is removed and its device now edits keepId.");
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
export const SetRsvpSettings = z.object({
  op: z.literal("set_rsvp_settings"),
  closesOn: IsoDate.nullable().optional().describe("Last day guests can answer, in India time (YYYY-MM-DD as the user said it); null removes the close date"),
  closesTime: HHMM.optional().describe("Closing time that day in India time, 24-hour; default 23:59"),
  askKids: z.boolean().optional().describe("Ask guests how many of their party are children"),
}).describe("Organizer only. The open RSVP form's close date (IST; the tool converts) and whether it asks for a kids count.");
/** v8 Part 1c organizer ops on the RSVP list: never run for a guest, and an AI proposal with one is always an approval card. */
export const RSVP_ORGANIZER_OPS: ReadonlySet<string> = new Set(["set_rsvp_vip", "remove_rsvp_entry", "restore_rsvp_entry", "merge_rsvp_entries", "set_rsvp_settings"]);

// ---------- v8 Part 1e: the birthday party activity run-sheet ----------
/** Limits that keep the run-sheet readable on a phone and on one approval card. */
export const ACTIVITY_LIMITS = { maxActivities: 30, nameMax: 80, ...RUN_SHEET_INPUT, maxSupplies: 10, supplyMax: 40 } as const;
const ActivityName = z.string().trim().min(1, "Name the activity").max(ACTIVITY_LIMITS.nameMax, `Keep the name under ${ACTIVITY_LIMITS.nameMax} characters`);
const ActivityMinutes = z.number().int().min(ACTIVITY_LIMITS.minDuration, `At least ${ACTIVITY_LIMITS.minDuration} minutes`).max(ACTIVITY_LIMITS.maxDuration, `At most ${ACTIVITY_LIMITS.maxDuration} minutes`)
  .describe("How long it runs, in whole minutes, exactly as the user said it");
const ActivityAge = z.number().int().min(0).max(ACTIVITY_LIMITS.maxAge);
const ActivitySupplies = z.array(z.string().trim().min(1, "A supply can't be empty").max(ACTIVITY_LIMITS.supplyMax, `Keep each supply under ${ACTIVITY_LIMITS.supplyMax} characters`))
  .max(ACTIVITY_LIMITS.maxSupplies, `At most ${ACTIVITY_LIMITS.maxSupplies} supplies`);
const ActivityPosition = z.number().int().min(0).max(ACTIVITY_LIMITS.maxActivities)
  .describe("0-based row to insert at (the # shown in RUN-SHEET); \"after row #n\" is n + 1. Leave out to add at the end");
const agesInOrder = (v: { ageMin?: number | null; ageMax?: number | null }) => v.ageMin == null || v.ageMax == null || v.ageMin <= v.ageMax;
const AGES_MSG = { message: "The youngest age can't be above the oldest", path: ["ageMin"] };
export const AddActivity = z.object({
  op: z.literal("add_activity"),
  name: ActivityName,
  durationMin: ActivityMinutes,
  ageMin: ActivityAge.optional().describe("Youngest age it suits"),
  ageMax: ActivityAge.optional().describe("Oldest age it suits"),
  supplies: ActivitySupplies.optional(),
  position: ActivityPosition.optional(),
  afterId: z.string().min(1).optional().describe("Insert right after this activity id (\"after cake\" → the cake row's id). Use instead of position"),
}).refine(agesInOrder, AGES_MSG).describe("Organizer only. Add a row to the birthday party activity run-sheet. Start and end times are computed by the tool.");
export const UpdateActivity = z.object({
  op: z.literal("update_activity"),
  activityId: z.string().min(1),
  name: ActivityName.optional(),
  durationMin: ActivityMinutes.optional(),
  ageMin: ActivityAge.nullable().optional().describe("null with ageMax null: suits all ages"),
  ageMax: ActivityAge.nullable().optional(),
  supplies: ActivitySupplies.optional().describe("The full new list (replaces the old one)"),
}).refine(agesInOrder, AGES_MSG).describe("Organizer only. Edit a run-sheet activity's name, minutes, ages or supplies.");
export const MoveActivity = z.object({
  op: z.literal("move_activity"),
  activityId: z.string().min(1),
  direction: z.enum(["up", "down"]).optional().describe("One row earlier or later"),
  index: z.number().int().min(0).max(ACTIVITY_LIMITS.maxActivities - 1).optional().describe("Or the 0-based row to move it to"),
}).refine(v => (v.direction === undefined) !== (v.index === undefined), { message: "Give a direction or an index, not both", path: ["direction"] })
  .describe("Organizer only. Reorder the run-sheet: move an activity up, down, or to a row.");
export const RemoveActivity = z.object({
  op: z.literal("remove_activity"),
  activityId: z.string().min(1),
}).describe("Organizer only. Remove an activity from the run-sheet.");
export const SetPartyStart = z.object({
  op: z.literal("set_party_start"),
  time: HHMM.nullable().describe("When the party starts, 24-hour HH:MM as the user said it (7 pm = 19:00); null removes it"),
}).describe("Organizer only. Set the party start time. The tool computes each run-sheet row's start and end from it.");
/** v8 Part 1e run-sheet ops: organizer only, never for a guest, and an AI proposal with one is always an approval card. */
export const ACTIVITY_OPS: ReadonlySet<string> = new Set(["add_activity", "update_activity", "move_activity", "remove_activity", "set_party_start"]);

/** v8 Part 1 organiser ops: an AI proposal containing one is always an approval card. */
export const GUEST_LIST_OPS: ReadonlySet<string> = new Set(["add_household", "update_household", "remove_household", "add_guest", "update_guest", "remove_guest",
  "import_guests", "approve_join_request", "reject_join_request", "add_wishlist_item", "update_wishlist_item", "remove_wishlist_item", "set_wishlist_surprise"]);
/** Ops that only the public join endpoint may run (BatchSource "join"); nothing else can, and that source can run nothing else. */
export const JOIN_ONLY_OPS: ReadonlySet<string> = new Set(["request_join"]);

/** v6 ops: organiser only, and an AI proposal containing one is always shown as an approval card. */
export const V6_OPS: ReadonlySet<string> = new Set(["set_priorities", "add_vendor", "set_vendor_stage", "remove_vendor", "set_vendor_need", "set_task_dependency"]);

/** Ops the AI never sees and the reducer runs only for source "ui". */
export const DIRECT_EDIT_OPS: ReadonlySet<string> = new Set(["rename_event", "set_partner_names", "rename_entity", "set_planned_amount", "save_idea", "dismiss_idea"]);
/** Ops only the organiser may run, whoever built the batch. Listed so the guest check is explicit, not implied. */
export const ORGANIZER_ONLY_OPS: ReadonlySet<string> = new Set(["add_budget_item", "remove_budget_item", "set_event_basics", "rebalance_budget",
  "add_ideas", "save_idea", "dismiss_idea", "adopt_idea", "delete_event", ...V6_OPS, ...GUEST_LIST_OPS, ...RSVP_ORGANIZER_OPS, ...ACTIVITY_OPS]);

/** The commands the AI may propose (declared to Gemini). Unchanged by the direct-edit ops. */
export const AgentCommand = z.discriminatedUnion("op", [
  AdjustBudget, MoveSubEvent, ShiftBlock, SetTaskStatus, RecordPayment, SetRsvp,
  SetItemLock, ClaimWishlistItem, SetPermitStatus, UpdateSponsor,
  UpsertVendorQuote, SetGuestDiet, CommunitySignup, SetSubEventVisibility,
  AddBudgetItem, RemoveBudgetItem, SetEventBasics, RebalanceBudget, AdoptIdea,
  SetPriorities, AddVendor, SetVendorStage, RemoveVendor, SetVendorNeed, SetTaskDependency, DeleteEvent,
  AddHousehold, UpdateHousehold, RemoveHousehold, AddGuest, UpdateGuest, RemoveGuest, ImportGuests, ApproveJoinRequest, RejectJoinRequest,
  AddWishlistItem, UpdateWishlistItem, RemoveWishlistItem, SetWishlistSurprise, UnclaimWishlistItem,
  SetRsvpVip, RemoveRsvpEntry, RestoreRsvpEntry, MergeRsvpEntries, SetRsvpSettings,
  AddActivity, UpdateActivity, MoveActivity, RemoveActivity, SetPartyStart,
]);
export const Command = z.discriminatedUnion("op", [
  AdjustBudget, MoveSubEvent, ShiftBlock, SetTaskStatus, RecordPayment, SetRsvp,
  SetItemLock, ClaimWishlistItem, SetPermitStatus, UpdateSponsor,
  UpsertVendorQuote, SetGuestDiet, CommunitySignup, SetSubEventVisibility,
  RenameEvent, SetPartnerNames, RenameEntity, SetPlannedAmount,
  AddBudgetItem, RemoveBudgetItem, SetEventBasics, RebalanceBudget,
  AddIdeas, SaveIdea, DismissIdea, AdoptIdea,
  SetPriorities, AddVendor, SetVendorStage, RemoveVendor, SetVendorNeed, SetTaskDependency, DeleteEvent,
  AddHousehold, UpdateHousehold, RemoveHousehold, AddGuest, UpdateGuest, RemoveGuest, ImportGuests, RequestJoin, ApproveJoinRequest, RejectJoinRequest,
  AddWishlistItem, UpdateWishlistItem, RemoveWishlistItem, SetWishlistSurprise, UnclaimWishlistItem,
  SubmitRsvpEntry, SetRsvpVip, RemoveRsvpEntry, RestoreRsvpEntry, MergeRsvpEntries, SetRsvpSettings,
  AddActivity, UpdateActivity, MoveActivity, RemoveActivity, SetPartyStart,
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
/**
 * Who built the batch. Direct edits need "ui". v8 Part 1: "guest_link" is the server's guest endpoint and "join" is the
 * public join endpoint, the only source request_join runs from. v8 Part 1c: "rsvp_link" is the open RSVP endpoint, the
 * only source that may flag a possible duplicate. Otherwise they behave like "agent".
 */
export type BatchSource = "agent" | "ui" | "guest_link" | "join" | "rsvp_link";

// ---------- roles ----------
export type Role = "organizer" | "guest";
/**
 * Guest / Committee Concierge mode (and every guest link) may only run these. Everything else is refused at the reducer
 * boundary. v8 Part 1c keeps it tight: a guest answers with their own RSVP entry, claims or releases a gift for that entry,
 * or signs up to volunteer; request_join additionally needs the join endpoint's source (JOIN_ONLY_OPS).
 */
export const GUEST_ALLOWED_OPS: ReadonlySet<Command["op"]> = new Set(["submit_rsvp_entry", "claim_wishlist_item", "community_signup", "request_join"]);

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

// ---------- v8 Part 1 helpers: guest list, change log, wishlist ----------
/** A household label not used yet ("Ravi", then "Ravi (2)"). */
function uniqueLabel(st: AgentState, label: string): string {
  let out = label, n = 2;
  while (st.households.some(h => sameText(h.label, out))) out = `${label} (${n++})`;
  return out;
}
export type ImportRowStatus = "new" | "duplicate" | "invalid";
export type ImportPlan = {
  households: AgentState["households"]; guests: AgentState["guests"];
  /** One per entry, in order: what happens to it and why. */
  rows: { status: ImportRowStatus; reason: string; phone: string; householdId: string | null }[];
  duplicates: number; invalid: number;
};
/**
 * The import, decided: shared by the reducer (import_guests) and the preview, so what the organiser previews is exactly
 * what Approve commits. Each entry becomes its own household unless `household` names one (existing or earlier in the
 * batch). Duplicates: the same E.164 phone or email as a household already on the list or an earlier entry. Entries with
 * neither are deduped by name within the batch only (two different people can share a name).
 */
export function planImport(st: AgentState, entries: z.input<typeof ImportEntry>[]): ImportPlan {
  const phones = new Map(st.households.filter(h => h.phone).map(h => [toE164Loose(h.phone), h.label]));
  const emails = new Map(st.households.filter(h => h.email).map(h => [h.email.toLowerCase(), h.label]));
  const batchNames = new Set<string>();
  const hhByLabel = new Map(st.households.map(h => [h.label.trim().toLowerCase(), h.id]));
  const households: AgentState["households"] = [], guests: AgentState["guests"] = [];
  const takenH = new Set(st.households.map(h => h.id)), takenG = new Set(st.guests.map(g => g.id));
  const labels = new Set(st.households.map(h => h.label.trim().toLowerCase()));
  const rsvp = invitesFor(st, undefined);
  const rows: ImportPlan["rows"] = [];
  let duplicates = 0, invalid = 0;
  for (const e of entries) {
    const name = (e.name ?? "").trim();
    if (!name) { invalid++; rows.push({ status: "invalid", reason: "No name", phone: "", householdId: null }); continue; }
    let phone = "";
    if (e.phone && e.phone.trim()) {
      const p = normalizePhone(e.phone);
      if (!p.ok) { invalid++; rows.push({ status: "invalid", reason: `Phone: ${p.reason}`, phone: "", householdId: null }); continue; }
      phone = p.e164;
    }
    const email = (e.email ?? "").trim().toLowerCase();
    const dupOf = (phone && phones.get(phone)) || (email && emails.get(email)) || (!phone && !email && batchNames.has(name.toLowerCase()) ? name : "");
    if (dupOf) { duplicates++; rows.push({ status: "duplicate", reason: `Already on the list (${dupOf})`, phone, householdId: null }); continue; }
    const hLabel = (e.household ?? "").trim() || name;
    const key = hLabel.toLowerCase();
    let hid = e.household?.trim() ? hhByLabel.get(key) : undefined;
    if (!hid) {
      let label = hLabel, n = 2;
      while (labels.has(label.toLowerCase())) label = `${hLabel} (${n++})`;
      labels.add(label.toLowerCase());
      hid = uniqueId(`hh-${slug(label).slice(0, 32)}`, x => takenH.has(x)); takenH.add(hid);
      households.push({ id: hid, label, side: e.side?.trim() ?? "", inviteCode: "", phone, email: e.email?.trim() ?? "" });
      hhByLabel.set(key, hid);
    } else {
      const h = households.find(x => x.id === hid);
      if (h && !h.phone && phone) h.phone = phone; // a new household picks up the first phone given for it
    }
    const gid = uniqueId(`g-${slug(name).slice(0, 32)}`, x => takenG.has(x)); takenG.add(gid);
    guests.push({ id: gid, householdId: hid, name, ageGroup: "adult", isPlusOne: false, diet: [], rsvp: { ...rsvp } });
    if (phone) phones.set(phone, name);
    if (email) emails.set(email, name);
    batchNames.add(name.toLowerCase());
    rows.push({ status: "new", reason: e.household?.trim() ? `Joins "${hLabel}"` : "New household", phone, householdId: hid });
  }
  return { households, guests, rows, duplicates, invalid };
}
/** Households saved before v8 may hold a phone as typed; compare them in E.164 when they parse. */
const toE164Loose = (raw: string) => { const r = normalizePhone(raw); return r.ok ? r.e164 : raw; };

type ApplyCtx = { source: BatchSource; now?: string; actorEntryId?: string | null };
type Ext = AgentState["event"]["ext"];
type WishExt = Extract<Ext, { type: "birthday" | "wedding" }>;
/** The wishlist lives on birthdays (wishlist) and weddings (gift registry); community events have none. */
function wishExt(st: AgentState): WishExt {
  const x = st.event.ext;
  if (x.type !== "birthday" && x.type !== "wedding") throw new PlanError("Wishlists exist on birthday and wedding events only");
  return x;
}
const withWishlist = (st: AgentState, x: WishExt, wishlist: WishlistItem[], extra: Partial<WishExt> = {}): AgentState =>
  ({ ...st, event: { ...st.event, ext: { ...x, ...extra, wishlist } as WishExt } });
// v8 Part 1e: the birthday party activity run-sheet.
type BirthdayExtT = Extract<Ext, { type: "birthday" }>;
export type RunSheetActivity = BirthdayExtT["activities"][number];
function runSheetExt(st: AgentState): BirthdayExtT {
  const x = st.event.ext;
  if (x.type !== "birthday") throw new PlanError("The activity run-sheet is on birthday events only");
  return x;
}
const withActivities = (st: AgentState, x: BirthdayExtT, activities: RunSheetActivity[], extra: Partial<BirthdayExtT> = {}): AgentState =>
  ({ ...st, event: { ...st.event, ext: { ...x, ...extra, activities } as BirthdayExtT } });
function activityIndex(x: BirthdayExtT, id: string): number {
  const i = x.activities.findIndex(a => a.id === id);
  if (i < 0) throw new PlanError(`No activity ${id} on the run-sheet`);
  return i;
}
/** The default length of a run-sheet row adopted from an idea that doesn't say how long it runs. */
export const DEFAULT_ACTIVITY_MINUTES = 30;
/** Minutes an idea says it runs ("Magician show (45 minutes)", "a 2 hour workshop"), clamped to the run-sheet limits; else 30. */
export function ideaActivityMinutes(i: { title: string; description?: string }): number {
  const text = `${i.title} ${i.description ?? ""}`;
  const m = /\b(\d{1,3})\s*[- ]?\s*(?:min|mins|minutes?)\b/i.exec(text);
  const h = /\b(\d{1,2}(?:\.\d)?)\s*[- ]?\s*(?:hr|hrs|hours?)\b/i.exec(text);
  const n = m ? Number(m[1]) : h ? Math.round(Number(h[1]) * 60) : DEFAULT_ACTIVITY_MINUTES;
  return Math.min(ACTIVITY_LIMITS.maxDuration, Math.max(ACTIVITY_LIMITS.minDuration, n));
}
const cleanSupplies = (list: readonly string[]) => {
  const out: string[] = [];
  for (const raw of list) { const v = raw.trim(); if (v && !out.some(o => sameText(o, v))) out.push(v); }
  return out;
};
const ageText = (r: readonly [number, number] | undefined) => (r ? `ages ${r[0]}–${r[1]}` : "all ages");

/** Release every gift claimed by one of `guestIds` (they are leaving the list). */
function releaseClaims(st: AgentState, guestIds: Set<string>): AgentState {
  const x = st.event.ext;
  if (x.type !== "birthday" && x.type !== "wedding") return st;
  if (!x.wishlist.some(w => w.claimedByGuestId && guestIds.has(w.claimedByGuestId))) return st;
  return withWishlist(st, x, x.wishlist.map(w => (w.claimedByGuestId && guestIds.has(w.claimedByGuestId) ? { ...w, claimedByGuestId: null } : w)));
}
/** Which door a change came through, for the change log. */
export function changeSourceOf(role: Role, source: BatchSource): ChangeSource {
  if (source === "guest_link") return "guest_link";
  if (role === "guest") return "guest_preview";
  return source === "ui" ? "organizer" : "copilot";
}
/**
 * Append one RSVP or diet change to the organizer's change log. Only when the caller passed `now` (the app and the server
 * do; dry runs and previews don't), so the reducer stays pure: the same input, including `now`, gives the same log.
 */
function logChange(st: AgentState, ctx: ApplyCtx, role: Role, g: AgentState["guests"][number], field: RsvpLogEntry["field"], subEventId: string | null, before: string, after: string): AgentState {
  if (!ctx.now || before === after) return st;
  const hh = st.households.find(h => h.id === g.householdId);
  const base = `rl-${ctx.now.replace(/[^0-9]/g, "").slice(0, 17)}-${g.id}-${field}${subEventId ? `-${subEventId}` : ""}`;
  const id = uniqueId(base, x => st.rsvpLog.some(e => e.id === x));
  const entry: RsvpLogEntry = { id, at: ctx.now, householdId: g.householdId, householdLabel: hh?.label ?? "", guestId: g.id, guestName: g.name,
    field, subEventId, before: before.slice(0, 200), after: after.slice(0, 200), source: changeSourceOf(role, ctx.source) };
  return { ...st, rsvpLog: [...st.rsvpLog, entry].slice(-RSVP_LOG_CAP) };
}
/** Every sub-event that collects RSVPs, or the named ones: the invitation map a new guest starts with. */
function invitesFor(st: AgentState, refs: string[] | undefined): Record<string, "invited"> {
  const ids = refs ? refs.map(r => findSubEvent(st, r).id) : st.subEvents.filter(s => s.collectsRsvp).map(s => s.id);
  return Object.fromEntries([...new Set(ids)].map(id => [id, "invited" as const]));
}
/** Normalise an optional phone; a value that isn't a number is an error the organiser sees. */
function phoneOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.trim() === "") return "";
  const r = normalizePhone(raw);
  if (!r.ok) throw new PlanError(`"${raw}" isn't a phone number (${r.reason})`);
  return r.e164;
}
function assertRoom(st: AgentState, households: number, guests: number) {
  if (st.households.length + households > GUEST_LIMITS.maxHouseholds) throw new PlanError(`The guest list is limited to ${GUEST_LIMITS.maxHouseholds} households`);
  if (st.guests.length + guests > GUEST_LIMITS.maxGuests) throw new PlanError(`The guest list is limited to ${GUEST_LIMITS.maxGuests} guests`);
}
const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const phoneClash = (st: AgentState, phone: string, exceptId: string | null) => (phone ? st.households.find(h => h.id !== exceptId && h.phone && toE164Loose(h.phone) === phone) : undefined);
/** Join requests: drop decided ones (oldest first) when the queue is full of history. */
function capJoinRecords(list: AgentState["joinRequests"]): AgentState["joinRequests"] {
  let out = list;
  while (out.length > JOIN_RECORDS_CAP) {
    const i = out.findIndex(r => r.status !== "pending");
    if (i < 0) break;
    out = out.filter((_, k) => k !== i);
  }
  return out;
}

/** A live RSVP entry (not removed, not merged), or a PlanError. */
function rsvpEntryOf(st: AgentState, id: string): RsvpEntry {
  const e = st.rsvpEntries.find(x => x.id === id);
  if (!e) throw new PlanError(`No RSVP ${id}`);
  if (e.mergedInto) throw new PlanError(`${e.name}'s RSVP was merged into another one`);
  if (e.removedAt) throw new PlanError(`${e.name}'s RSVP was removed (restore it first)`);
  return e;
}
/** Approval cards and logs show only the last four digits of an RSVP phone. */
const maskPhoneShort = (e164: string) => `(phone ending ${e164.slice(-4)})`;

// ---------- reducer ----------
function apply(st: AgentState, c: Command, log: string[], role: Role = "organizer", ctx: ApplyCtx = { source: "agent" }): AgentState {
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
      const next = { ...st, guests: st.guests.map(x => x.id === c.guestId ? { ...x, rsvp: { ...x.rsvp, [sid]: c.answer } } : x) };
      return logChange(next, ctx, role, g, "rsvp", sid, g.rsvp[sid] ?? "not invited", c.answer);
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
      const ext = wishExt(st);
      const w = ext.wishlist.find(x => x.id === c.itemId);
      if (!w) throw new PlanError(`No wishlist item ${c.itemId}`);
      // v8 Part 1c: a claim is made for a guest on the optional guest list or for an RSVP entry from the open link.
      const who = c.guestId === null ? null : st.guests.find(g => g.id === c.guestId)?.name ?? st.rsvpEntries.find(e => e.id === c.guestId && !e.removedAt && !e.mergedInto)?.name;
      if (c.guestId !== null && !who) throw new PlanError(`No guest ${c.guestId}`);
      if (role === "guest" && w.claimedByGuestId && w.claimedByGuestId !== c.guestId && c.guestId !== null)
        throw new PlanError(`"${w.item}" is already claimed by another guest`);
      // A guest releases only their own claim (guestId null; runBatch checks the claim is theirs). Guests never learn who
      // else claimed a gift (privacy), so a guest's own log line names nobody else either.
      if (role === "guest" && c.guestId === null && w.claimedByGuestId === null) { log.push(`"${w.item}" is not claimed`); return st; }
      log.push(`Wishlist "${w.item}": ${c.guestId ? `claimed by ${who}` : "released"}`);
      return withWishlist(st, ext, ext.wishlist.map(x => x.id === w.id ? { ...x, claimedByGuestId: c.guestId } : x));
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
      if (i.adoptedTaskId || i.adoptedBudgetItemId || i.adoptedActivityId) throw new PlanError(`"${i.title}" is already in the plan`);
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
      // v8 Part 1e: an activity idea on a birthday also becomes a run-sheet row (its own minutes when it says, else 30),
      // in the same batch, so one Undo takes back the task, the line and the row together.
      let activityId: string | null = null;
      const bx = next.event.ext;
      if (i.kind === "activity" && bx.type === "birthday") {
        const name = i.title.trim().slice(0, ACTIVITY_LIMITS.nameMax).trim();
        if (bx.activities.some(a => sameText(a.name, name))) log.push(`"${name}" is already on the run-sheet`);
        else if (bx.activities.length >= ACTIVITY_LIMITS.maxActivities) log.push(`The run-sheet is full (${ACTIVITY_LIMITS.maxActivities} activities), so no row was added`);
        else {
          activityId = uniqueId(`ac-${slug(name).slice(0, 28)}`, k => bx.activities.some(a => a.id === k));
          const minutes = ideaActivityMinutes(i);
          next = withActivities(next, bx, [...bx.activities, { id: activityId, name, durationMin: minutes, supplies: [] }]);
          log.push(`New run-sheet row "${name}" (${minutes} min)`);
        }
      }
      if (!taskId && !itemId && !activityId) throw new PlanError(`Nothing to add for "${i.title}": it has no cost or category, and no task was asked for`);
      return { ...next, ideas: next.ideas.map(x => x.id === i.id ? { ...x, status: "saved" as const, adoptedTaskId: taskId, adoptedBudgetItemId: itemId, ...(activityId ? { adoptedActivityId: activityId } : {}) } : x) };
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
    case "delete_event": {
      if (role === "guest") throw new PlanError("Only the organiser can delete an event");
      log.push(`Delete "${st.event.title}": it moves to Recently deleted for 30 days (you confirm in the app first)`);
      return st;
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
    // ---------- v8 Part 1: guest list ----------
    case "add_household": {
      if (role === "guest") throw new PlanError("Only the organiser can add households");
      const label = c.label.trim();
      if (st.households.some(h => sameText(h.label, label))) throw new PlanError(`There is already a household called "${label}"`);
      const phone = phoneOf(c.phone) ?? "";
      const clash = phoneClash(st, phone, null);
      if (clash) throw new PlanError(`That number is already on the list (${clash.label})`);
      const members = c.members ?? [];
      assertRoom(st, 1, members.length);
      const id = uniqueId(`hh-${slug(label).slice(0, 32)}`, x => st.households.some(h => h.id === x));
      const rsvp = invitesFor(st, c.invitedTo);
      const taken = new Set(st.guests.map(g => g.id));
      const guests = members.map(m => {
        const gid = uniqueId(`g-${slug(m.name).slice(0, 32)}`, x => taken.has(x)); taken.add(gid);
        return { id: gid, householdId: id, name: m.name.trim(), ageGroup: m.ageGroup ?? "adult" as const, isPlusOne: false, diet: [], rsvp: { ...rsvp } };
      });
      log.push(`Added household "${label}"${members.length ? ` with ${members.length} guest${members.length === 1 ? "" : "s"}` : ""}`);
      return { ...st, households: [...st.households, { id, label, side: c.side?.trim() ?? "", inviteCode: "", phone, email: c.email?.trim() ?? "" }], guests: [...st.guests, ...guests] };
    }
    case "update_household": {
      if (role === "guest") throw new PlanError("Only the organiser can edit households");
      const h = st.households.find(x => x.id === c.householdId);
      if (!h) throw new PlanError(`No household ${c.householdId}`);
      if (c.label === undefined && c.side === undefined && c.phone === undefined && c.email === undefined) throw new PlanError("Nothing to change");
      const label = c.label?.trim() ?? h.label;
      if (c.label !== undefined && st.households.some(x => x.id !== h.id && sameText(x.label, label))) throw new PlanError(`There is already a household called "${label}"`);
      const phone = phoneOf(c.phone) ?? h.phone;
      const clash = phoneClash(st, phone, h.id);
      if (clash) throw new PlanError(`That number is already on the list (${clash.label})`);
      const next = { ...h, label, side: c.side?.trim() ?? h.side, phone, email: c.email?.trim() ?? h.email };
      const what = [c.label !== undefined && label !== h.label && "name", c.side !== undefined && next.side !== h.side && "side", phone !== h.phone && "phone", next.email !== h.email && "email"].filter(Boolean);
      log.push(what.length ? `Household "${label}": updated ${what.join(", ")}` : `Household "${label}" unchanged`);
      return { ...st, households: st.households.map(x => x.id === h.id ? next : x) };
    }
    case "remove_household": {
      if (role === "guest") throw new PlanError("Only the organiser can remove households");
      const h = st.households.find(x => x.id === c.householdId);
      if (!h) throw new PlanError(`No household ${c.householdId}`);
      const gone = new Set(st.guests.filter(g => g.householdId === h.id).map(g => g.id));
      log.push(`Removed household "${h.label}"${gone.size ? ` and its ${gone.size} guest${gone.size === 1 ? "" : "s"}` : ""}`);
      const next = { ...st, households: st.households.filter(x => x.id !== h.id), guests: st.guests.filter(g => !gone.has(g.id)) };
      return releaseClaims(next, gone);
    }
    case "add_guest": {
      if (role === "guest") throw new PlanError("Only the organiser can add guests");
      const h = st.households.find(x => x.id === c.householdId);
      if (!h) throw new PlanError(`No household ${c.householdId}`);
      if (st.guests.filter(g => g.householdId === h.id).length >= GUEST_LIMITS.maxHouseholdSize) throw new PlanError(`A household can have at most ${GUEST_LIMITS.maxHouseholdSize} people`);
      assertRoom(st, 0, 1);
      const id = uniqueId(`g-${slug(c.name).slice(0, 32)}`, x => st.guests.some(g => g.id === x));
      log.push(`Added ${c.name.trim()} to "${h.label}"`);
      return { ...st, guests: [...st.guests, { id, householdId: h.id, name: c.name.trim(), ageGroup: c.ageGroup ?? "adult", isPlusOne: c.isPlusOne ?? false, diet: [], rsvp: invitesFor(st, c.invitedTo) }] };
    }
    case "update_guest": {
      if (role === "guest") throw new PlanError("Only the organiser can edit guests");
      const g = st.guests.find(x => x.id === c.guestId);
      if (!g) throw new PlanError(`No guest ${c.guestId}`);
      if (c.name === undefined && c.ageGroup === undefined && c.householdId === undefined && c.invitedTo === undefined) throw new PlanError("Nothing to change");
      if (c.householdId !== undefined && !st.households.some(h => h.id === c.householdId)) throw new PlanError(`No household ${c.householdId}`);
      let rsvp = g.rsvp;
      if (c.invitedTo !== undefined) {
        const want = invitesFor(st, c.invitedTo);
        rsvp = Object.fromEntries(Object.keys(want).map(sid => [sid, g.rsvp[sid] ?? "invited"]));
      }
      const next = { ...g, name: c.name?.trim() ?? g.name, ageGroup: c.ageGroup ?? g.ageGroup, householdId: c.householdId ?? g.householdId, rsvp };
      const what = [next.name !== g.name && "name", next.ageGroup !== g.ageGroup && "age group", next.householdId !== g.householdId && "household", JSON.stringify(next.rsvp) !== JSON.stringify(g.rsvp) && "invitations"].filter(Boolean);
      log.push(what.length ? `${next.name}: updated ${what.join(", ")}` : `${g.name} unchanged`);
      return { ...st, guests: st.guests.map(x => x.id === g.id ? next : x) };
    }
    case "remove_guest": {
      if (role === "guest") throw new PlanError("Only the organiser can remove guests");
      const g = st.guests.find(x => x.id === c.guestId);
      if (!g) throw new PlanError(`No guest ${c.guestId}`);
      log.push(`Removed ${g.name} from the guest list`);
      return releaseClaims({ ...st, guests: st.guests.filter(x => x.id !== g.id) }, new Set([g.id]));
    }
    case "import_guests": {
      if (role === "guest") throw new PlanError("Only the organiser can import guests");
      const r = planImport(st, c.entries);
      if (!r.households.length && !r.guests.length) {
        const why = [r.duplicates && `${r.duplicates} already on the list`, r.invalid && `${r.invalid} with a phone that isn't a number`].filter(Boolean).join(", ");
        throw new PlanError(`Nothing new to import${why ? `: ${why}` : ""}`);
      }
      assertRoom(st, r.households.length, r.guests.length);
      log.push(`Imported ${r.guests.length} guest${r.guests.length === 1 ? "" : "s"} in ${r.households.length} new household${r.households.length === 1 ? "" : "s"}`);
      if (r.duplicates) log.push(`Skipped ${r.duplicates} duplicate${r.duplicates === 1 ? "" : "s"} (same phone or email already on the list)`);
      if (r.invalid) log.push(`Skipped ${r.invalid} with a phone that isn't a number`);
      return { ...st, households: [...st.households, ...r.households], guests: [...st.guests, ...r.guests] };
    }
    case "request_join": {
      if (ctx.source !== "join") throw new PlanError("Join requests come only through the group join link");
      const phone = c.phone ? normalizePhone(c.phone) : null;
      if (phone && !phone.ok) throw new PlanError(`That phone number doesn't look right (${phone.reason})`);
      const e164 = phone?.ok ? phone.e164 : "";
      const pending = st.joinRequests.filter(r => r.status === "pending");
      // The same person asking twice is one request (same answer either way, so the link can't be used to probe the list).
      if (pending.some(r => (e164 && r.phone === e164) || (!e164 && !r.phone && sameText(r.name, c.name)))) { log.push("Join request already pending"); return st; }
      if (pending.length >= GUEST_LIMITS.maxPendingJoins) throw new PlanError("The organizer has too many requests waiting right now. Please ask them directly.");
      if (st.joinRequests.some(r => r.id === c.requestId)) throw new PlanError("Duplicate request id");
      log.push(`Join request from ${c.name.trim()} (${c.size})`);
      return { ...st, joinRequests: capJoinRecords([...st.joinRequests, { id: c.requestId, name: c.name.trim(), size: c.size, phone: e164, at: c.at, status: "pending", householdId: null }]) };
    }
    case "approve_join_request": {
      if (role === "guest") throw new PlanError("Only the organiser can approve join requests");
      const r = st.joinRequests.find(x => x.id === c.requestId);
      if (!r) throw new PlanError(`No join request ${c.requestId}`);
      if (r.status !== "pending") throw new PlanError(`${r.name}'s request was already ${r.status}`);
      const clash = phoneClash(st, r.phone, null);
      if (clash) throw new PlanError(`${r.name}'s number is already on the list (${clash.label}): reject this request or remove that household first`);
      assertRoom(st, 1, r.size);
      const label = uniqueLabel(st, r.size > 1 ? `${r.name} household` : r.name);
      const hid = uniqueId(`hh-${slug(label).slice(0, 32)}`, x => st.households.some(h => h.id === x));
      const rsvp = invitesFor(st, undefined);
      const taken = new Set(st.guests.map(g => g.id));
      const guests = Array.from({ length: r.size }, (_, i) => {
        const name = i === 0 ? r.name : `${r.name} guest ${i + 1}`;
        const gid = uniqueId(`g-${slug(name).slice(0, 32)}`, x => taken.has(x)); taken.add(gid);
        return { id: gid, householdId: hid, name, ageGroup: "adult" as const, isPlusOne: i > 0, diet: [], rsvp: { ...rsvp } };
      });
      log.push(`Approved ${r.name}: household "${label}" with ${r.size} guest${r.size === 1 ? "" : "s"} (their private link appears after the next sync)`);
      return { ...st, households: [...st.households, { id: hid, label, side: c.side?.trim() ?? "", inviteCode: "", phone: r.phone, email: "" }],
        guests: [...st.guests, ...guests],
        joinRequests: st.joinRequests.map(x => x.id === r.id ? { ...x, status: "approved" as const, householdId: hid, phone: "" } : x) };
    }
    case "reject_join_request": {
      if (role === "guest") throw new PlanError("Only the organiser can decline join requests");
      const r = st.joinRequests.find(x => x.id === c.requestId);
      if (!r) throw new PlanError(`No join request ${c.requestId}`);
      if (r.status !== "pending") throw new PlanError(`${r.name}'s request was already ${r.status}`);
      log.push(`Declined ${r.name}'s join request`);
      return { ...st, joinRequests: st.joinRequests.map(x => x.id === r.id ? { ...x, status: "rejected" as const, phone: "" } : x) };
    }
    // ---------- v8 Part 1: wishlist / registry ----------
    case "add_wishlist_item": {
      if (role === "guest") throw new PlanError("Only the organiser can add gifts");
      const x = wishExt(st);
      const item = c.item.trim();
      if (x.wishlist.some(w => sameText(w.item, item))) throw new PlanError(`"${item}" is already on the ${x.type === "wedding" ? "registry" : "wishlist"}`);
      if (x.wishlist.length >= GUEST_LIMITS.maxWishlist) throw new PlanError(`Keep the list to ${GUEST_LIMITS.maxWishlist} gifts`);
      const id = uniqueId(`wl-${slug(item).slice(0, 32)}`, k => x.wishlist.some(w => w.id === k));
      const w: WishlistItem = { id, item, claimedByGuestId: null, priority: c.priority ?? "med",
        ...(c.url ? { url: c.url } : {}), ...(c.approxRupees !== undefined ? { approxPaise: c.approxRupees * 100 } : {}) };
      log.push(`Added "${item}" to the ${x.type === "wedding" ? "gift registry" : "wishlist"}${c.approxRupees !== undefined ? ` (about ${rupees(c.approxRupees * 100)})` : ""}`);
      return withWishlist(st, x, [...x.wishlist, w]);
    }
    case "update_wishlist_item": {
      if (role === "guest") throw new PlanError("Only the organiser can edit gifts");
      const x = wishExt(st);
      const w = x.wishlist.find(i => i.id === c.itemId);
      if (!w) throw new PlanError(`No wishlist item ${c.itemId}`);
      const item = c.item?.trim() ?? w.item;
      if (c.item !== undefined && x.wishlist.some(i => i.id !== w.id && sameText(i.item, item))) throw new PlanError(`"${item}" is already on the list`);
      const next: WishlistItem = { ...w, item, priority: c.priority ?? w.priority };
      if (c.url !== undefined) { if (c.url) next.url = c.url; else delete next.url; }
      if (c.approxRupees !== undefined) { if (c.approxRupees === null) delete next.approxPaise; else next.approxPaise = c.approxRupees * 100; }
      log.push(`Gift "${item}" updated`);
      return withWishlist(st, x, x.wishlist.map(i => i.id === w.id ? next : i));
    }
    case "remove_wishlist_item": {
      if (role === "guest") throw new PlanError("Only the organiser can remove gifts");
      const x = wishExt(st);
      const w = x.wishlist.find(i => i.id === c.itemId);
      if (!w) throw new PlanError(`No wishlist item ${c.itemId}`);
      log.push(`Removed "${w.item}"${w.claimedByGuestId ? " (it was claimed)" : ""}`);
      return withWishlist(st, x, x.wishlist.filter(i => i.id !== w.id));
    }
    case "set_wishlist_surprise": {
      if (role === "guest") throw new PlanError("Only the organiser can change surprise mode");
      const x = wishExt(st);
      if (x.wishlistSurprise === c.on) { log.push(`Surprise mode is already ${c.on ? "on" : "off"}`); return st; }
      log.push(c.on ? "Surprise mode on: the public link hides claims and this view hides who claimed" : "Surprise mode off");
      return withWishlist(st, x, x.wishlist, { wishlistSurprise: c.on });
    }
    case "unclaim_wishlist_item": {
      const x = wishExt(st);
      const w = x.wishlist.find(i => i.id === c.itemId);
      if (!w) throw new PlanError(`No wishlist item ${c.itemId}`);
      if (!st.guests.some(g => g.id === c.guestId)) throw new PlanError(`No guest ${c.guestId}`);
      if (w.claimedByGuestId === null) { log.push(`"${w.item}" is not claimed`); return st; }
      if (w.claimedByGuestId !== c.guestId) throw new PlanError("You can only release a gift you claimed");
      log.push(`Wishlist "${w.item}": released`);
      return withWishlist(st, x, x.wishlist.map(i => i.id === w.id ? { ...i, claimedByGuestId: null } : i));
    }
    // ---------- v8 Part 1e: the birthday party activity run-sheet ----------
    case "add_activity": {
      if (role === "guest") throw new PlanError("Only the organiser can change the run-sheet");
      const x = runSheetExt(st);
      const name = c.name.trim();
      if (x.activities.length >= ACTIVITY_LIMITS.maxActivities) throw new PlanError(`Keep the run-sheet to ${ACTIVITY_LIMITS.maxActivities} activities`);
      if (x.activities.some(a => sameText(a.name, name))) throw new PlanError(`"${name}" is already on the run-sheet`);
      if (c.position !== undefined && c.afterId !== undefined) throw new PlanError("Give a position or an activity to follow, not both");
      const at = c.afterId !== undefined ? activityIndex(x, c.afterId) + 1 : c.position ?? x.activities.length;
      if (at > x.activities.length) throw new PlanError(`The run-sheet has ${x.activities.length} rows: position ${at} is past the end`);
      const ageRange: [number, number] | undefined = c.ageMin === undefined && c.ageMax === undefined ? undefined : [c.ageMin ?? 0, c.ageMax ?? ACTIVITY_LIMITS.maxAge];
      const id = uniqueId(`ac-${slug(name).slice(0, 28)}`, k => x.activities.some(a => a.id === k));
      const row: RunSheetActivity = { id, name, durationMin: c.durationMin, supplies: cleanSupplies(c.supplies ?? []), ...(ageRange ? { ageRange } : {}) };
      const activities = [...x.activities.slice(0, at), row, ...x.activities.slice(at)];
      const times = computeRunSheetTimes(x.partyStart, activities);
      log.push(`Added "${name}" (${c.durationMin} min) to the run-sheet${at < x.activities.length ? ` as row ${at + 1}` : ""}${times ? `: ${times[at]!.label}` : ""}`);
      return withActivities(st, x, activities);
    }
    case "update_activity": {
      if (role === "guest") throw new PlanError("Only the organiser can change the run-sheet");
      const x = runSheetExt(st);
      const a = x.activities[activityIndex(x, c.activityId)]!;
      const name = c.name?.trim() ?? a.name;
      if (c.name !== undefined && x.activities.some(o => o.id !== a.id && sameText(o.name, name))) throw new PlanError(`"${name}" is already on the run-sheet`);
      let ageRange = a.ageRange;
      if (c.ageMin !== undefined || c.ageMax !== undefined) {
        if (c.ageMin === null || c.ageMax === null) {
          if (typeof c.ageMin === "number" || typeof c.ageMax === "number") throw new PlanError("Give both ages, or clear both for all ages");
          ageRange = undefined;
        } else {
          const lo = c.ageMin ?? ageRange?.[0] ?? 0, hi = c.ageMax ?? ageRange?.[1] ?? ACTIVITY_LIMITS.maxAge;
          if (lo > hi) throw new PlanError("The youngest age can't be above the oldest");
          ageRange = [lo, hi];
        }
      }
      const next: RunSheetActivity = { ...a, name, durationMin: c.durationMin ?? a.durationMin, supplies: c.supplies !== undefined ? cleanSupplies(c.supplies) : a.supplies };
      if (ageRange) next.ageRange = ageRange; else delete next.ageRange;
      const changed = [c.name !== undefined && name !== a.name ? "name" : "", c.durationMin !== undefined && c.durationMin !== a.durationMin ? `${c.durationMin} min` : "",
        ageText(ageRange) !== ageText(a.ageRange) ? ageText(ageRange) : "", c.supplies !== undefined && next.supplies.join("|") !== a.supplies.join("|") ? "supplies" : ""].filter(Boolean);
      if (!changed.length) { log.push(`"${a.name}" is unchanged`); return st; }
      log.push(`Run-sheet "${name}": ${changed.join(", ")}`);
      return withActivities(st, x, x.activities.map(o => o.id === a.id ? next : o));
    }
    case "move_activity": {
      if (role === "guest") throw new PlanError("Only the organiser can change the run-sheet");
      const x = runSheetExt(st);
      const from = activityIndex(x, c.activityId);
      const a = x.activities[from]!;
      const to = c.direction === "up" ? from - 1 : c.direction === "down" ? from + 1 : c.index!;
      if (to < 0) throw new PlanError(`"${a.name}" is already first`);
      if (to >= x.activities.length) throw new PlanError(c.direction === "down" ? `"${a.name}" is already last` : `The run-sheet has ${x.activities.length} rows`);
      if (to === from) { log.push(`"${a.name}" is already row ${from + 1}`); return st; }
      const rest = x.activities.filter(o => o.id !== a.id);
      const activities = [...rest.slice(0, to), a, ...rest.slice(to)];
      log.push(`Moved "${a.name}" to row ${to + 1} of ${activities.length}`);
      return withActivities(st, x, activities);
    }
    case "remove_activity": {
      if (role === "guest") throw new PlanError("Only the organiser can change the run-sheet");
      const x = runSheetExt(st);
      const a = x.activities[activityIndex(x, c.activityId)]!;
      log.push(`Removed "${a.name}" from the run-sheet`);
      const next = withActivities(st, x, x.activities.filter(o => o.id !== a.id));
      // An idea adopted into this row can be adopted again only through its task; just drop the stale link.
      return next.ideas.some(i => i.adoptedActivityId === a.id) ? { ...next, ideas: next.ideas.map(i => i.adoptedActivityId === a.id ? { ...i, adoptedActivityId: null } : i) } : next;
    }
    case "set_party_start": {
      if (role === "guest") throw new PlanError("Only the organiser can change the run-sheet");
      const x = runSheetExt(st);
      if (x.partyStart === c.time) { log.push(c.time ? `The party already starts at ${formatClock(parseHHMM(c.time)!)}` : "No start time is set"); return st; }
      log.push(c.time ? `Party starts at ${formatClock(parseHHMM(c.time)!)}; the run-sheet ends at ${runSheetEnd(c.time, x.activities)}` : "Party start time removed: the run-sheet shows durations only");
      return withActivities(st, x, x.activities, { partyStart: c.time });
    }
    case "set_guest_diet": {
      const g = st.guests.find(x => x.id === c.guestId);
      if (!g) throw new PlanError(`No guest ${c.guestId}`);
      const diet = [...new Set(c.diet.map(d => d.trim().toLowerCase()).filter(Boolean))];
      log.push(`${g.name}: diet ${diet.join(", ") || "no restriction"}`);
      const next = { ...st, guests: st.guests.map(x => x.id === g.id ? { ...x, diet } : x) };
      return logChange(next, ctx, role, g, "diet", null, g.diet.join(", ") || "none", diet.join(", ") || "none");
    }
    // ---------- v8 Part 1c: the open RSVP list ----------
    case "submit_rsvp_entry": {
      if (c.duplicateOf !== undefined && ctx.source !== "rsvp_link") throw new PlanError("Only the RSVP server flags possible duplicates");
      // Closed is checked against `now`: the server and the app pass it, so a guest write after the close date is refused.
      if (role === "guest" && ctx.now && rsvpClosed(st.rsvpSettings, ctx.now)) throw new PlanError(RSVP_CLOSED_MESSAGE);
      const prev = st.rsvpEntries.find(e => e.id === c.entryId);
      if (prev?.mergedInto) throw new PlanError("This RSVP was merged into another one by the organizer");
      if (prev?.removedAt) throw new PlanError(RSVP_REMOVED_MESSAGE);
      if (prev && role === "guest" && !ctx.actorEntryId) throw new PlanError("You can only change your own RSVP");
      const open = new Set(rsvpFunctions(st).map(x => x.id));
      const functions: string[] = [];
      for (const ref of c.functions) {
        const sub = findSubEvent(st, ref);
        if (!open.has(sub.id)) throw new PlanError(`${sub.name} doesn't take RSVPs`);
        if (!functions.includes(sub.id)) functions.push(sub.id);
      }
      if (c.answer !== "not_coming" && open.size > 0 && functions.length === 0) throw new PlanError("Pick at least one function you're attending");
      let kids = prev?.kids ?? null;
      if (st.rsvpSettings.askKids && c.kids !== undefined) {
        if (c.kids > c.partySize) throw new PlanError("Kids can't be more than the party size");
        kids = c.kids;
      }
      let phone = prev?.phone ?? "";
      if (c.phone !== undefined && c.phone !== "") {
        const r = normalizePhone(c.phone);
        if (!r.ok) throw new PlanError(`That phone number doesn't look right (${r.reason})`);
        phone = r.e164;
      }
      const live = (id: string | null | undefined) => !!id && id !== c.entryId && st.rsvpEntries.some(e => e.id === id && !e.removedAt && !e.mergedInto);
      const dup = c.duplicateOf !== undefined ? (live(c.duplicateOf) ? c.duplicateOf! : null) : prev?.possibleDuplicateOf ?? null;
      const name = c.name.trim();
      const now = ctx.now ?? prev?.updatedAt ?? "";
      if (!prev && st.rsvpEntries.length >= RSVP_ENTRIES_CAP) throw new PlanError(`This RSVP list is full (${RSVP_ENTRIES_CAP} RSVPs). Please contact the organizer.`);
      const entry: RsvpEntry = { ...(prev ?? { vip: false, removedAt: null, mergedInto: null, createdAt: now }), id: c.entryId, name, phone,
        partySize: c.partySize, kids, functions, meal: c.meal, answer: c.answer, possibleDuplicateOf: dup, updatedAt: now };
      const fnNames = functions.map(f => st.subEvents.find(x => x.id === f)!.name).join(", ");
      log.push(`${prev ? "RSVP updated" : "New RSVP"}: ${name}, ${c.partySize} ${c.partySize === 1 ? "person" : "people"}, ${ANSWER_LABEL[c.answer]}${fnNames ? ` (${fnNames})` : ""}, ${MEAL_LABEL[c.meal]}${dup ? " - possible duplicate" : ""}`);
      return { ...st, rsvpEntries: prev ? st.rsvpEntries.map(e => e.id === prev.id ? entry : e) : [...st.rsvpEntries, entry] };
    }
    case "set_rsvp_vip": {
      if (role === "guest") throw new PlanError("Only the organiser can mark VIPs");
      const e = rsvpEntryOf(st, c.entryId);
      if (e.vip === c.vip) { log.push(`${e.name} is already ${c.vip ? "a VIP" : "not a VIP"}`); return st; }
      log.push(`${e.name}: ${c.vip ? "marked VIP" : "no longer VIP"}`);
      return { ...st, rsvpEntries: st.rsvpEntries.map(x => x.id === e.id ? { ...x, vip: c.vip } : x) };
    }
    case "remove_rsvp_entry": {
      if (role === "guest") throw new PlanError("Only the organiser can remove RSVPs");
      const e = rsvpEntryOf(st, c.entryId);
      log.push(`Removed RSVP: ${e.name} (${e.partySize})${e.phone ? ` ${maskPhoneShort(e.phone)}` : ""}. Undo, or restore it from Recently removed.`);
      // Its gift claims are released (a spam entry can't hold gifts); Undo brings them back with the entry.
      return releaseClaims({ ...st, rsvpEntries: st.rsvpEntries.map(x => x.id === e.id ? { ...x, removedAt: ctx.now ?? "removed" }
        : x.possibleDuplicateOf === e.id ? { ...x, possibleDuplicateOf: null } : x) }, new Set([e.id]));
    }
    case "restore_rsvp_entry": {
      if (role === "guest") throw new PlanError("Only the organiser can restore RSVPs");
      const e = st.rsvpEntries.find(x => x.id === c.entryId);
      if (!e) throw new PlanError(`No RSVP ${c.entryId}`);
      if (e.mergedInto) throw new PlanError(`${e.name}'s RSVP was merged into another one`);
      if (!e.removedAt) { log.push(`${e.name}'s RSVP isn't removed`); return st; }
      log.push(`Restored RSVP: ${e.name} (${e.partySize})`);
      return { ...st, rsvpEntries: st.rsvpEntries.map(x => x.id === e.id ? { ...x, removedAt: null } : x) };
    }
    case "merge_rsvp_entries": {
      if (role === "guest") throw new PlanError("Only the organiser can merge RSVPs");
      if (c.keepId === c.dropId) throw new PlanError("Pick two different RSVPs to merge");
      const keep = rsvpEntryOf(st, c.keepId), drop = rsvpEntryOf(st, c.dropId);
      log.push(`Merged RSVPs: kept ${keep.name} (${keep.partySize}, ${ANSWER_LABEL[keep.answer]}); ${drop.name} (${drop.partySize}) folded into it`);
      const next = { ...st, rsvpEntries: st.rsvpEntries.map(x => x.id === keep.id ? { ...x, possibleDuplicateOf: null }
        : x.id === drop.id ? { ...x, mergedInto: keep.id, removedAt: ctx.now ?? "merged", possibleDuplicateOf: null }
        : x.possibleDuplicateOf === drop.id ? { ...x, possibleDuplicateOf: keep.id } : x) };
      // A gift the dropped entry claimed now belongs to the kept one (same family).
      const x = next.event.ext;
      if ((x.type === "birthday" || x.type === "wedding") && x.wishlist.some(w => w.claimedByGuestId === drop.id))
        return withWishlist(next, x, x.wishlist.map(w => w.claimedByGuestId === drop.id ? { ...w, claimedByGuestId: keep.id } : w));
      return next;
    }
    case "set_rsvp_settings": {
      if (role === "guest") throw new PlanError("Only the organiser can change RSVP settings");
      const cur = st.rsvpSettings;
      let closesAt = cur.closesAt;
      if (c.closesOn === null) closesAt = null;
      else if (c.closesOn !== undefined) {
        const iso = istToUtcIso(c.closesOn, c.closesTime ?? "23:59");
        if (!iso) throw new PlanError(`${c.closesOn} isn't a real date`);
        closesAt = iso;
      } else if (c.closesTime !== undefined) throw new PlanError("Give the close date with the time");
      const askKids = c.askKids ?? cur.askKids;
      if (closesAt !== cur.closesAt) log.push(closesAt ? `RSVPs close ${formatIst(closesAt)}` : "RSVPs stay open (no close date)");
      if (askKids !== cur.askKids) log.push(askKids ? "The RSVP form now asks how many kids" : "The RSVP form no longer asks about kids");
      if (closesAt === cur.closesAt && askKids === cur.askKids) { log.push("RSVP settings unchanged"); return st; }
      return { ...st, rsvpSettings: { ...cur, closesAt, askKids } };
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

/**
 * v8 Part 1c: the RSVP entry a guest-allowed command acts for (null: it names nobody, like a community sign-up). A claim
 * with guestId null is a release: it acts for whoever holds the claim, which runBatch checks is the actor.
 */
export const targetEntryOf = (c: Command): string | null =>
  c.op === "submit_rsvp_entry" ? c.entryId : c.op === "claim_wishlist_item" ? c.guestId : null;

function runBatch(state: AgentState, input: unknown, withSuggestion: boolean, role: Role = "organizer", source: BatchSource = "agent", now?: string, actorEntryId?: string | null): BatchResult {
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
    // v8 Part 1c: a guest acts for their own RSVP entry only: they answer it, and claim or release gifts for it. Without an
    // actor (the guest Co-Pilot before any RSVP) they may only start a new entry; the reducer refuses editing an existing one.
    const x = state.event.ext;
    const holder = (itemId: string) => (x.type === "birthday" || x.type === "wedding") ? x.wishlist.find(w => w.id === itemId)?.claimedByGuestId ?? null : null;
    const out = commands.findIndex(c => {
      if (c.op === "community_signup" || c.op === "request_join") return false;
      if (c.op === "claim_wishlist_item") return !actorEntryId || (c.guestId === null ? holder(c.itemId) !== null && holder(c.itemId) !== actorEntryId : c.guestId !== actorEntryId);
      const t = targetEntryOf(c);
      return actorEntryId ? t !== actorEntryId : false;
    });
    if (out >= 0) {
      const reason = actorEntryId ? "You can only change your own RSVP and your own gift claims." : "Send your RSVP first, then you can claim a gift.";
      return { ok: false, state, error: reason, reason, failedCommandIndex: out,
        diagnostics: { categoryMaxCuttablePaise: {}, knownSubEvents: state.subEvents.map(s => s.slug), violations: ["scope:guest"] } };
    }
  }
  // v8 Part 1: the join endpoint runs request_join and nothing else; nothing else runs request_join.
  const joinBad = commands.findIndex(c => (source === "join") !== JOIN_ONLY_OPS.has(c.op));
  if (joinBad >= 0) {
    const reason = source === "join" ? `"${commands[joinBad]!.op}" can't run from the join link` : "Join requests come only through the group join link";
    return { ok: false, state, error: reason, reason, failedCommandIndex: joinBad,
      diagnostics: { categoryMaxCuttablePaise: {}, knownSubEvents: state.subEvents.map(s => s.slug), violations: ["source:join"] } };
  }
  const del = commands.findIndex(c => c.op === "delete_event");
  if (del >= 0 && commands.length > 1) {
    const reason = "Deleting the event can't be combined with other changes: propose it on its own.";
    return { ok: false, state, error: reason, reason, failedCommandIndex: del,
      diagnostics: { categoryMaxCuttablePaise: categoryMaxCuttable(state), knownSubEvents: state.subEvents.map(s => s.slug), violations: ["delete_event:alone"] } };
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
    try { next = apply(next, commands[i]!, log, role, { source, now, actorEntryId: role === "guest" ? actorEntryId ?? null : null }); }
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
export function applyBatch(state: AgentState, input: unknown, opts: { role?: Role; source?: BatchSource; now?: string; actorEntryId?: string | null } = {}): BatchResult {
  return runBatch(state, input, opts.role !== "guest", opts.role ?? "organizer", opts.source ?? "agent", opts.now, opts.actorEntryId);
}
/** Spec alias: the same pure reducer. */
export const applyPlanChanges = applyBatch;
