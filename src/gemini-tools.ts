// Gemini function calling (@google/genai). The JSON Schema comes straight from the Zod source of truth.
import { z } from "zod";
import { Batch, applyBatch, derive, SetRsvp, SetGuestDiet, ClaimWishlistItem, CommunitySignup } from "./commands";
import { InitializeEventPlan } from "./blueprint";
import { DraftOutboundMessage, summarizeForGuest, summarizePlan } from "./agent";
import { computePlanInsights, insightsDigest, todayIST } from "./insights";
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
    parametersJsonSchema: toSchema(Batch),
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
      "permit deadlines as applyByOffsetDays, and task deadlines as dueOffsetDays; the tool computes every date. Fill ext for the event type: " +
      "wedding → partners, traditions (sub-events Haldi, Mehendi, Sangeet, Muhurtham as main, Reception as post); " +
      "birthday → honoree, turningAge, theme, wishlist, activities; community → sponsors, permits, volunteers.",
    parametersJsonSchema: toSchema(InitializeEventPlan),
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
9. Keep replies to 1–3 short sentences. Use ₹ with Indian grouping (₹1,50,000).

LIVE STATE (ids and slugs are exact):
${summarizePlan(st, today)}

RED FLAGS (deterministic):
${insightsDigest(computePlanInsights(st, today))}
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
/** The only command shapes a guest-mode model can even express. The reducer enforces the same list. */
export const GuestBatch = z.object({
  commands: z.array(z.discriminatedUnion("op", [SetRsvp, SetGuestDiet, ClaimWishlistItem, CommunitySignup])).min(1).max(30),
  summary: z.string(),
});

export const guestFunctionDeclarations = [
  {
    name: "apply_plan_changes",
    description: "Guest-safe changes only: set_rsvp (per guest, per sub-event slug), set_guest_diet, claim_wishlist_item, community_signup (volunteer shift or sponsor interest). " +
      "For a household, emit one set_rsvp per guest in it. Put everything from one request in ONE call.",
    parametersJsonSchema: toSchema(GuestBatch),
  },
  {
    name: "get_event_info",
    description: "Read the public schedule, venues, dress codes, households/guests with RSVPs, wishlist and volunteer info.",
    parametersJsonSchema: { type: "object", properties: {} },
  },
] as const;

export const GUEST_SYSTEM_PROMPT = (st: AgentState, actingGuestId: string | null) => `
You are the friendly guest concierge and RSVP assistant for "${st.event.title}". You are READ-ONLY except for guest actions.
Answer questions about timings, venues, dress codes and the itinerary from the event info below. Times are local.
You may only RSVP, set dietary needs, claim a birthday wishlist item, or sign someone up to volunteer / express sponsor interest, via apply_plan_changes.
Never discuss budgets, vendors, costs or internal tasks; politely say the organiser handles those.
When the user says "me" or "I", they are the acting guest. Keep replies to 1–3 warm sentences.

EVENT INFO:
${summarizeForGuest(st, actingGuestId)}
`.trim();
