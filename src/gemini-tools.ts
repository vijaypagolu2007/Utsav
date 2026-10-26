// Gemini function calling (@google/genai). The JSON Schema comes straight from the Zod source of truth.
import { z } from "zod";
import { AgentBatch, applyBatch, derive, ClaimWishlistItem, CommunitySignup, SubmitRsvpEntry } from "./commands";
import { InitializeEventPlan } from "./blueprint";
import { DraftOutboundMessage, RevisePlan, SuggestVendorQuestions, summarizeForGuest, summarizePlan } from "./agent";
import { prioritiesDigest } from "./priorities";
import { computePlanInsights, insightsDigest, todayIST } from "./insights";
import { ideaContext, SuggestIdeas } from "./ideas";
import type { AgentState } from "./schema";

/**
 * Gemini accepts a JSON Schema subset: drop $schema, prefer anyOf over oneOf, spell const as a one-value enum,
 * express tuples as fixed-length arrays, and turn exclusiveMinimum into minimum.
 */
export function geminiSchema(schema: unknown): Record<string, unknown> {
  const walk = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(walk);
    if (!n || typeof n !== "object") return n;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === "$schema") continue;
      if (k === "oneOf") { out.anyOf = walk(v); continue; }
      if (k === "const") { out.enum = [v]; continue; }
      if (k === "prefixItems" && Array.isArray(v) && v.length) {
        out.items = walk(v[0]); out.minItems = v.length; out.maxItems = v.length; continue;
      }
      if (k === "exclusiveMinimum" && typeof v === "number") {
        out.minimum = (n as Record<string, unknown>).type === "integer" ? v + 1 : v; continue;
      }
      out[k] = walk(v);
    }
    return out;
  };
  return walk(schema) as Record<string, unknown>;
}
const toSchema = (s: z.ZodType) => geminiSchema(z.toJSONSchema(s, { target: "draft-2020-12", io: "input" }));

export const functionDeclarations = [
  {
    name: "apply_plan_changes",
    description:
      "Apply one or more changes to the event plan atomically: all succeed or none do. " +
      "Put every change from a single user request into ONE call (e.g. a budget cut and a date move together). " +
      "Use weekday names as given; never compute dates yourself. Amounts are in paise (₹1 = 100). " +
      "The app dry-runs the batch: small changes auto-apply, money ≥ ₹25,000 / date moves / payments wait for the user's approval. " +
      "On failure you get {reason, failedCommandIndex, diagnostics, counterOffer}; use them to explain and propose the counter-offer.",
    parametersJsonSchema: toSchema(AgentBatch),
  },
  {
    name: "get_plan_snapshot",
    description: "Read the current plan with derived values (headroom, overdue payments, tasks due in 7 days). Call this before you change anything you haven't seen.",
    parametersJsonSchema: { type: "object", properties: {} },
  },
  {
    name: "initialize_event_plan",
    description:
      "Create a brand-new event plan from a one-line brief (cold start). Give budget lines as relative weightBps, NOT amounts: " +
      "the tool allocates totalBudgetRupees across them with largest-remainder rounding so it sums exactly. Give sub-event days as dayOffset from startDate, " +
      "permit deadlines as applyByOffsetDays, and task deadlines as dueOffsetDays; the tool computes every date. Fill ext for the event type " +
      "(wedding → partners, traditions; birthday → honoree, turningAge, theme, wishlist, activities; community → sponsors, permits, volunteers). " +
      "Choose sub-events that fit the tradition, city, age and venue the user gave; never a fixed list. For example: Haldi, Mehendi, Sangeet, " +
      "Muhurtham and Reception suit a Hindu or Telugu wedding; a Nikah and Walima, a church ceremony and reception, an Anand Karaj, or a registration " +
      "and dinner suit others. A child's party at home needs no venue, bar, cabs or adult wishlist items. A Ganesh pandal runs sthapana, daily aarti and " +
      "visarjan days; Navratri runs nightly garba. If the user's setup lists budget categories, use only those.",
    parametersJsonSchema: toSchema(InitializeEventPlan),
  },
  {
    name: "get_rsvp_counts",
    description: "Read-only headcounts from the open RSVP list, computed in code: coming people per function, per meal (veg, non_veg, jain) per function, kids (when asked), " +
      "Maybe people (separate, never in the catering total), Not coming, total RSVPs and possible duplicates. Call it for every 'how many' question and quote its numbers; never add them up yourself.",
    parametersJsonSchema: { type: "object", properties: {} },
  },
  {
    name: "get_plan_insights",
    description: "Deterministic red flags: overdue deposits, envelope breaches, urgent tasks (due ≤ 14 days), permit/wishlist/RSVP alerts. Use for 'what's overdue / urgent / at risk' questions.",
    parametersJsonSchema: { type: "object", properties: {} },
  },
  {
    name: "draft_outbound_message",
    description: "Draft a WhatsApp or email to a vendor, sponsor or guests (negotiation, sponsor pitch, RSVP reminder). Shown as an editable card; the user sends it. Never claim it was sent.",
    parametersJsonSchema: toSchema(DraftOutboundMessage),
  },
  {
    name: "suggest_ideas",
    description:
      "Suggest 4–8 personalised idea cards (theme, decor, menu, activity, return_gift, invite_text, music, photo) for this event. " +
      "Use the IDEA CONTEXT: tradition, city and region, age, guest count, diets and the organiser's note. Give realistic Indian costs for the WHOLE event " +
      "in whole rupees (estLowRupees, estHighRupees); the app converts and checks them against what is left in each category, so stay within it where you can. " +
      "Cards are saved to the user's Ideas page; they never change the budget until the user adopts one.",
    parametersJsonSchema: toSchema(SuggestIdeas),
  },
  {
    name: "revise_plan",
    description:
      "Revise the plan instead of restarting it when the budget, dates or guest count change (e.g. 'our budget dropped by ₹50,000 and the event is 2 weeks earlier'). " +
      "Pass the change exactly as the user said it (rupees and weeks/days); the tool computes the new total and dates, moves every sub-event and task, " +
      "and fixes any overrun by the organiser's priorities (cut-first, then flexible, never must-protect). It also fixes an existing overrun when called with no changes. " +
      "It returns ONE approval card plus `explain` lines: use them to explain the trade-offs in plain words.",
    parametersJsonSchema: toSchema(RevisePlan),
  },
  {
    name: "suggest_vendor_questions",
    description:
      "Questions the organiser should ask one kind of vendor before booking (what's included, guests covered, extra charges, timings, cancellation, what still needs clarifying). " +
      "Use the vendor-checklist slot key from the live state. Never state or guess prices or availability.",
    parametersJsonSchema: toSchema(SuggestVendorQuestions),
  },
] as const;

export const SYSTEM_PROMPT = (st: AgentState, today: string = todayIST()) => `
You are the planning copilot for "${st.event.title}" (${st.event.eventType}, ${st.event.city}).
Budget: ₹${(st.event.totalBudgetPaise / 100).toLocaleString("en-IN")}. Window: ${st.event.startDate} to ${st.event.endDate}.
Sub-events (slug → date): ${st.subEvents.map(s => `${s.slug}→${s.date}`).join(", ")}.

Rules:
1. Every mutation goes through apply_plan_changes. Never describe a change as done until the tool returns ok.
2. One user request becomes one call. "Cut ₹20k from decor and move the Haldi to Friday" is a single call with two commands.
3. Refer to sub-events by slug. Pass weekdays as {weekday}; the tool resolves the date.
4. Rupees to paise: multiply by 100. "20k" = 2000000 paise. "1.5L" = 15000000 paise. A cut is a negative deltaPaise.
5. If the tool returns an error, explain it in plain words using its diagnostics (max cuttable per category, valid dates) and present the counterOffer it already prepared. Don't retry blindly.
6. Changes that spend money or contact vendors: propose them and wait for a yes. Outbound messages are drafts via draft_outbound_message only.
7. To start a new event ("plan a…", "switch to a…"), call initialize_event_plan with weights and offsets, never amounts or computed dates.
8. Never do budget math or date arithmetic in your reply; quote numbers from tool results or the live state below.
9. For changes and facts, keep replies to 1–3 short sentences. For ideas and advice ("give me sangeet ideas", "how do I keep costs down?"), call suggest_ideas when cards help and you may answer in up to 6 short lines or a short list. Use ₹ with Indian grouping (₹1,50,000).
10. Budget lines can be added (add_budget_item) or removed (remove_budget_item); the total, guest count, city and dates change with set_event_basics; "rebalance to my total" is rebalance_budget with the headroom from the live state; an idea joins the plan with adopt_idea. All of these are shown to the user for approval.
11. PRIORITIES decide trade-offs. When money is short (over budget, "budget dropped", "too pricey"), never cut every category evenly: call revise_plan (it cuts cut-first categories, then flexible ones, and never must-protect ones), then explain each trade-off in plain words, e.g. "Decor −₹60,000 to keep Catering intact". When the budget, dates or guest count change, REVISE with revise_plan; never start a new plan.
12. Amounts from blueprints, ideas and envelopes are ESTIMATES; only a vendor's quote is QUOTED and only signed money is COMMITTED. Say which one a figure is. Never claim a vendor is available or that a price is confirmed.
13. Vendors: add_vendor, set_vendor_stage, remove_vendor and set_vendor_need manage the checklist; suggest_vendor_questions gives questions to ask. Tasks can wait for other tasks (set_task_dependency); venue booking usually comes first.
14. Only when the organiser clearly asks to delete or remove the whole event, propose apply_plan_changes with a single delete_event command. You never delete anything: it is a Tier 2 card the organiser approves and then confirms, and the event can be restored for 30 days. Never propose it to clear, reset or tidy a plan.
15. Guest list (v8): "add these guests: …" is ONE apply_plan_changes call with ONE import_guests command (source "ai"): one entry per person with the name and the phone EXACTLY as written (never reformat or invent numbers; leave phone out when none is given). The tool normalises phones and skips duplicates, and the user approves it on a card. Single edits: add_household, add_guest, update_guest, update_household, remove_guest, remove_household. Phone numbers are private: never repeat them in your reply.
16. Join requests: "approve join requests" is apply_plan_changes with one approve_join_request per pending request id from JOIN REQUESTS (reject_join_request to decline). Never invent request ids.
17. Gifts: add_wishlist_item / update_wishlist_item / remove_wishlist_item work on the birthday wishlist or the wedding gift registry. Give the price as approxRupees in whole rupees exactly as the user said it (the tool converts). Links must be https; never fetch, open or describe a link. set_wishlist_surprise turns surprise mode on or off.
18. RSVPs (v8 Part 1c): guests answer on the open RSVP link; the list is in RSVP LIST. For any headcount ("how many veg for Sangeet?", "how many are coming?") call get_rsvp_counts and quote its numbers; Maybe is never part of the catering total. Organizer changes: set_rsvp_vip, remove_rsvp_entry (soft delete, restorable), restore_rsvp_entry, merge_rsvp_entries (keepId = the newer entry unless the organizer says otherwise; dropId = its DUP-OF partner) and set_rsvp_settings (closesOn is the IST date the user said, closesTime HH:MM if given; the tool converts; askKids). Use ids from RSVP LIST only. Never mention phone numbers.
19. Party run-sheet (birthdays, v8 Part 1e): add_activity, update_activity, move_activity, remove_activity and set_party_start. Give durationMin in whole minutes exactly as the user said it ("20 minute" = 20) and ages as ageMin/ageMax. "After cake" means afterId = the id of the cake row in RUN-SHEET ("before X" = position of X's #index). set_party_start takes 24-hour HH:MM (7 pm = "19:00"). Every row's start and end time is computed by the tool and shown in RUN-SHEET: quote those, never work out a time yourself.

LIVE STATE (ids and slugs are exact):
${summarizePlan(st, today)}

PRIORITIES: ${prioritiesDigest(st)}

RED FLAGS (deterministic):
${insightsDigest(computePlanInsights(st, today))}

IDEA CONTEXT:
${ideaContext(st)}
IDEAS ON THE BOARD (id status title): ${st.ideas.filter(i => i.status !== "dismissed").slice(0, 30).map(i => `${i.id} ${i.status} ${i.title}`).join(" | ") || "(none)"}
`.trim();

/** Server-side tool executor. Persist state (Firestore or Supabase) only when ok is true. */
export function executeTool(name: string, args: unknown, state: AgentState, today: string) {
  if (name === "get_plan_snapshot") return { state, derived: derive(state, today) };
  if (name === "apply_plan_changes") {
    const r = applyBatch(state, args);
    return r.ok ? { ok: true, log: r.log, derived: derive(r.state, today), _next: r.state }
      : { ok: false, error: r.error, failedCommandIndex: r.failedCommandIndex, diagnostics: r.diagnostics, suggestion: r.suggestion };
  }
  return { ok: false, error: `Unknown tool ${name}` };
}

/* Usage with @google/genai: see src/app/api/chat/route.ts for the full multi-step loop with trust tiers. */

// ---------- Guest / Committee Concierge persona ----------
/** The only command shapes a guest-mode model can even express (duplicateOf is the server's alone). The reducer enforces the same list. */
export const GuestBatch = z.object({
  commands: z.array(z.discriminatedUnion("op", [SubmitRsvpEntry.omit({ duplicateOf: true }), ClaimWishlistItem, CommunitySignup])).min(1).max(10),
  summary: z.string(),
});

export const guestFunctionDeclarations = [
  {
    name: "apply_plan_changes",
    description: "Guest-safe changes only: submit_rsvp_entry (the acting guest's own RSVP: entryId from YOUR RSVP, name, partySize, functions as slugs, meal veg | non_veg | jain, answer coming | maybe | not_coming), " +
      "claim_wishlist_item (guestId = your RSVP entry id; null releases your own claim) and community_signup (volunteer shift or sponsor interest). Put everything from one request in ONE call.",
    parametersJsonSchema: toSchema(GuestBatch),
  },
  {
    name: "get_event_info",
    description: "Read the schedule, venues, dress codes, your own RSVP, the wishlist and volunteer info.",
    parametersJsonSchema: { type: "object", properties: {} },
  },
] as const;

export const GUEST_SYSTEM_PROMPT = (st: AgentState, actingEntryId: string | null) => `
You are the friendly guest concierge and RSVP assistant for "${st.event.title}". You are READ-ONLY except for guest actions.
Answer questions about timings, venues, dress codes and the itinerary from the event info below. Times are local.
You may only send or change the acting guest's own RSVP (submit_rsvp_entry: keep the fields from YOUR RSVP that the guest didn't change), claim (or release your own claim on) a wishlist or registry gift, or sign someone up to volunteer / express sponsor interest, via apply_plan_changes. If YOUR RSVP is not sent yet, ask them to fill in the RSVP form first.
Never discuss budgets, vendors, costs or internal tasks; politely say the organiser handles those.
When the user says "me" or "I", they are the acting guest. Keep replies to 1–3 warm sentences.

EVENT INFO:
${summarizeForGuest(st, actingEntryId)}
`.trim();
