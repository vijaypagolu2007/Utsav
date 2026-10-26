// Shared agent runtime: one executor for every tool, used by the Gemini route and by the offline demo parser.
// It never mutates the live plan. It dry-runs batches and returns proposals; the client commits them through
// applyBatch after the trust-tier check (Tier 0 auto, Tier 1 approve, Tier 2 human sends).
import { z } from "zod";
import { visibleSubEventIds } from "./visibility";
import type { AgentState } from "./schema";
import { ACTIVITY_LIMITS, applyBatch, Batch, type BatchInput, type Diagnostics, type Role, rupees, taskDueDate } from "./commands";
import { computeRunSheetTimes, runSheetEnd, runSheetTotal } from "./run-sheet";
import { ANSWER_LABEL, computeRsvpCounts, MEAL_LABEL, rsvpCountsForAi, rsvpFunctions } from "./rsvp";
import { initializeEventPlan } from "./blueprint";
import { computePlanDiff, type PlanDiff } from "./diff";
import { computePlanInsights, type Insight } from "./insights";
import { agentBatchTier, batchTier, type TrustTier } from "./trust";
import { ideasReply, prepareIdeas, type IdeaDraftT, type Refine } from "./ideas";
import { buildRevision, prioritiesDigest, type RevisionInput } from "./priorities";
import { checklistFor, slotByKey } from "./config/vendor-checklist";

/** v6: "revise, don't restart". The model passes what the user said; code computes the total, the dates and every cut. */
export const RevisePlan = z.object({
  budgetChangeRupees: z.number().int().min(-1_000_000_000).max(1_000_000_000).optional()
    .describe("Change to the TOTAL budget in whole rupees, as the user said it: 'budget dropped by ₹50k' = -50000. The tool converts and computes the new total"),
  shift: z.object({
    amount: z.number().int().min(1).max(60),
    unit: z.enum(["days", "weeks"]),
    direction: z.enum(["earlier", "later"]),
  }).optional().describe("Move every date: 'the event is 2 weeks earlier' = {amount: 2, unit: 'weeks', direction: 'earlier'}. The tool computes the dates"),
  guestCount: z.number().int().min(1).max(100_000).optional().describe("New total guest count, if the user changed it"),
  fixOverrun: z.boolean().default(true).describe("Fix any overrun by the organiser's priorities (cut-first, then flexible; never must-protect)"),
});
export type RevisePlanInput = z.input<typeof RevisePlan>;
export function revisionInputOf(a: z.infer<typeof RevisePlan>): RevisionInput {
  const days = a.shift ? a.shift.amount * (a.shift.unit === "weeks" ? 7 : 1) * (a.shift.direction === "earlier" ? -1 : 1) : undefined;
  return { ...(a.budgetChangeRupees !== undefined ? { budgetDeltaPaise: a.budgetChangeRupees * 100 } : {}), ...(days !== undefined ? { shiftDays: days } : {}),
    ...(a.guestCount !== undefined ? { guestCount: a.guestCount } : {}), fixOverrun: a.fixOverrun };
}

/** v6: questions to ask one kind of vendor (Gemini writes them; code checks the slot and the shape). */
export const SuggestVendorQuestions = z.object({
  need: z.string().min(1).max(40).describe("Vendor-checklist slot key, e.g. 'caterer', 'photographer'"),
  questions: z.array(z.string().trim().min(8).max(220)).min(3).max(10).describe("5 to 8 specific questions to ask before booking: inclusions, guests covered, extra charges, timing, cancellation. Never state prices or availability"),
});

export const DraftOutboundMessage = z.object({
  channel: z.enum(["whatsapp", "email"]),
  recipient: z.string().describe("Vendor, sponsor or guest name"),
  subject: z.string().optional().describe("Email subject (email only)"),
  body: z.string().min(1).describe("The full message text, ready to send"),
  purpose: z.enum(["vendor_negotiation", "sponsor_pitch", "guest_reminder", "other"]).default("other"),
});
export type DraftOutboundMessage = z.infer<typeof DraftOutboundMessage>;

export type RejectionInfo = {
  reason: string;
  failedCommandIndex: number;
  diagnostics: Diagnostics;
  suggestion?: BatchInput;
};

export type AgentAction =
  | { kind: "batch"; id: string; batch: BatchInput; tier: TrustTier; log: string[]; diff: PlanDiff; counterOffer?: boolean;
      /** Set when the batch came from the quote scanner: contract red flags shown before approval. */
      redFlags?: string[]; source?: string;
      /** v6: plain-English trade-offs and knock-on effects, computed by code (priorities.ts), shown on the card. */
      explain?: string[] }
  /** v6: questions to ask one kind of vendor. Nothing in the plan changes. */
  | { kind: "questions"; id: string; need: string; label: string; questions: string[]; source: "gemini" | "demo" }
  | { kind: "rejection"; id: string; batch: BatchInput; rejection: RejectionInfo }
  | { kind: "init"; id: string; plan: AgentState; log: string[] }
  | { kind: "init_rejection"; id: string; reason: string; issues: string[] }
  | { kind: "draft"; id: string; draft: DraftOutboundMessage }
  | { kind: "insights"; id: string; insights: Insight[] }
  /** Idea cards from suggest_ideas, already validated and converted by code; `batch` (add_ideas, Tier 0) puts them on the board. */
  | { kind: "ideas"; id: string; ideas: IdeaDraftT[]; batch: BatchInput; source: "gemini" | "demo"; flagged: number; dropped: number };

export type ChatTurn = { role: "user" | "assistant"; text: string };
export type ChatRequest = { messages: ChatTurn[]; state: AgentState; today: string; forceOffline?: boolean;
  role?: Role; actingEntryId?: string | null };
/** Tools a guest-mode agent may call. apply_plan_changes is further limited to GUEST_ALLOWED_OPS by the reducer. */
export const GUEST_TOOLS = new Set(["apply_plan_changes", "get_event_info"]);
export type ChatResponse = { reply: string; actions: AgentAction[]; mode: "gemini" | "offline"; warning?: string };

let seq = 0;
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const fmtCuttable = (d: Diagnostics) =>
  Object.fromEntries(Object.entries(d.categoryMaxCuttablePaise).map(([k, v]) => [k, `${rupees(v)} (${v} paise)`]));

/**
 * Run one tool call against the working state. Returns what to send back to the model, the UI action
 * (if any), and the working state for any later call in the same turn (a dry-run assumes approval).
 */
/**
 * v8 Part 1c: `opts.actingEntryId` is the RSVP entry the Co-Pilot speaks for in guest mode (Guest View). Its writes are
 * scoped to that entry (the reducer refuses any other) and its view shows nobody else's RSVP.
 */
export function executeAgentTool(name: string, args: unknown, working: AgentState, today: string, role: Role = "organizer", ideaSource: "gemini" | "demo" = "gemini", opts: { refine?: Refine; actingEntryId?: string | null } = {}):
  { response: Record<string, unknown>; actions: AgentAction[]; working: AgentState } {
  if (role === "guest" && !GUEST_TOOLS.has(name))
    return { response: { ok: false, reason: `${name} isn't available in Guest mode` }, actions: [], working };
  switch (name) {
    case "get_event_info":
      return { response: { info: summarizeForGuest(working, role === "guest" ? opts.actingEntryId ?? null : null) }, actions: [], working };
    // v8 Part 1c: read-only headcounts, computed in code (src/rsvp.ts). Organizer only (not in GUEST_TOOLS). No names, no phones.
    case "get_rsvp_counts":
      return { response: rsvpCountsForAi(working), actions: [], working };
    case "get_plan_snapshot":
      return { response: { plan: summarizePlan(working, today) }, actions: [], working };
    case "get_plan_insights": {
      const pi = computePlanInsights(working, today);
      return { response: { today, counts: pi.counts, insights: pi.insights.map(i => ({ severity: i.severity, kind: i.kind, title: i.title, detail: i.detail })) },
        actions: [{ kind: "insights", id: nextId("ins"), insights: pi.insights }], working };
    }
    case "apply_plan_changes": {
      const parsed = Batch.safeParse(args);
      const batch = (parsed.success ? parsed.data : args) as BatchInput;
      const r = applyBatch(working, args, { role, ...(role === "guest" && opts.actingEntryId ? { actorEntryId: opts.actingEntryId } : {}) });
      if (r.ok) {
        const tier = agentBatchTier(Batch.parse(args).commands);
        const diff = computePlanDiff(working, r.state);
        return {
          response: { ok: true, tier, status: tier === 0 ? "auto-applied" : "dry-run preview shown; awaiting the user's Approve & Commit", log: r.log },
          actions: [{ kind: "batch", id: nextId("b"), batch, tier, log: r.log, diff }],
          working: r.state,
        };
      }
      const rejection: RejectionInfo = { reason: r.reason, failedCommandIndex: r.failedCommandIndex, diagnostics: r.diagnostics,
        ...(r.suggestion ? { suggestion: r.suggestion } : {}) };
      const actions: AgentAction[] = [{ kind: "rejection", id: nextId("rj"), batch, rejection }];
      // The verified counter-offer becomes an approval card right away (always Tier ≥ 1 so the user decides).
      if (r.suggestion) {
        const s = applyBatch(working, r.suggestion);
        if (s.ok) actions.push({ kind: "batch", id: nextId("b"), batch: r.suggestion, tier: Math.max(1, batchTier(Batch.parse(r.suggestion).commands)) as TrustTier,
          log: s.log, diff: computePlanDiff(working, s.state), counterOffer: true });
      }
      return {
        response: { ok: false, reason: r.reason, failedCommandIndex: r.failedCommandIndex,
          diagnostics: { ...r.diagnostics, categoryMaxCuttable: fmtCuttable(r.diagnostics) },
          counterOffer: r.suggestion ? { ...r.suggestion, note: "Already shown to the user as an approval card. Explain it; do not call it again." } : null },
        actions, working,
      };
    }
    case "initialize_event_plan": {
      const r = initializeEventPlan(args);
      if (!r.ok) return { response: { ok: false, reason: r.reason, issues: r.diagnostics.issues },
        actions: [{ kind: "init_rejection", id: nextId("ir"), reason: r.reason, issues: r.diagnostics.issues }], working };
      return { response: { ok: true, status: "new plan shown; the user can load it with one click", log: r.log },
        actions: [{ kind: "init", id: nextId("in"), plan: r.state, log: r.log }], working: r.state };
    }
    case "suggest_ideas": {
      const prep = prepareIdeas(working, args, ideaSource, opts);
      if (!prep.ok) return { response: { ok: false, reason: prep.reason }, actions: [], working };
      const { drafts, dropped, flagged } = prep.value;
      if (!drafts.length) return { response: { ok: true, added: 0, note: "All of those are already on the board; suggest different ones.", dropped }, actions: [], working };
      const batch: BatchInput = { summary: `Add ${drafts.length} idea${drafts.length === 1 ? "" : "s"} to the board`, commands: [{ op: "add_ideas", ideas: drafts }] };
      const r = applyBatch(working, batch, { role });
      if (!r.ok) return { response: { ok: false, reason: r.reason }, actions: [], working };
      return {
        response: { ok: true, added: drafts.length, flaggedOverBudget: flagged, dropped, status: "Shown to the user as idea cards and saved on the Ideas page",
          summary: ideasReply(prep.value, ideaSource) },
        actions: [{ kind: "ideas", id: nextId("id"), ideas: drafts, batch, source: ideaSource, flagged, dropped: dropped.length }],
        working: r.state,
      };
    }
    case "revise_plan": {
      if (role === "guest") return { response: { ok: false, reason: "Only the organiser can revise the plan" }, actions: [], working };
      const p = RevisePlan.safeParse(args);
      if (!p.success) return { response: { ok: false, reason: p.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") }, actions: [], working };
      const rev = buildRevision(working, today, revisionInputOf(p.data));
      if (!rev.ok) return { response: { ok: false, reason: rev.reason }, actions: [], working };
      const r = applyBatch(working, rev.batch);
      if (!r.ok) return { response: { ok: false, reason: r.reason }, actions: [], working };
      const tier = Math.max(1, batchTier(Batch.parse(rev.batch).commands)) as TrustTier;
      return {
        response: { ok: true, tier, status: "One approval card shown with the revision and its trade-offs. Explain it in plain words using `explain`; do not restate amounts you did not get from here.", explain: rev.explain, log: r.log },
        actions: [{ kind: "batch", id: nextId("b"), batch: rev.batch, tier, log: r.log, diff: computePlanDiff(working, r.state), explain: rev.explain }],
        working: r.state,
      };
    }
    case "suggest_vendor_questions": {
      if (role === "guest") return { response: { ok: false, reason: "Vendor questions are for the organiser" }, actions: [], working };
      const p = SuggestVendorQuestions.safeParse(args);
      if (!p.success) return { response: { ok: false, reason: p.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") }, actions: [], working };
      const slot = slotByKey(working, p.data.need);
      if (!slot) return { response: { ok: false, reason: `"${p.data.need}" isn't a vendor slot for this event. Use one of: ${checklistFor(working).map(s => s.key).join(", ")}` }, actions: [], working };
      const questions = [...new Set(p.data.questions.map(q => q.trim()))].slice(0, 10);
      return { response: { ok: true, shown: questions.length, status: "Shown to the user as a copyable list" },
        actions: [{ kind: "questions", id: nextId("q"), need: slot.key, label: slot.label, questions, source: ideaSource }], working };
    }
    case "draft_outbound_message": {
      const p = DraftOutboundMessage.safeParse(args);
      if (!p.success) return { response: { ok: false, reason: p.error.issues.map(i => i.message).join("; ") }, actions: [], working };
      return { response: { ok: true, status: "Draft shown to the user as an editable card. They send it themselves (Tier 2)." },
        actions: [{ kind: "draft", id: nextId("d"), draft: p.data }], working };
    }
    default:
      return { response: { ok: false, reason: `Unknown tool ${name}` }, actions: [], working };
  }
}

/** A compact, id-rich text summary of the plan for the system prompt (keeps tokens low, slugs exact). */
export function summarizePlan(st: AgentState, today: string): string {
  const e = st.event;
  const lines: string[] = [];
  const wd = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  lines.push(`EVENT ${e.title} | ${e.eventType} | ${e.city} | budget ${rupees(e.totalBudgetPaise)} | window ${e.startDate}..${e.endDate} | guests ~${e.guestCount} | today ${today}`);
  lines.push(`SUB-EVENTS (slug: date weekday, phase): ${st.subEvents.map(s => `${s.slug}: ${s.date} ${wd(s.date)}, ${s.phase}${s.isMain ? " MAIN" : ""}, ${s.visibility}`).join(" | ")}`);
  const cats = [...new Set(st.budgetItems.map(b => b.category))];
  lines.push("BUDGET by category (planned / committed / cuttable now):");
  for (const c of cats) {
    const items = st.budgetItems.filter(b => b.category === c);
    const p = items.reduce((a, b) => a + b.plannedPaise, 0), cm = items.reduce((a, b) => a + b.committedPaise, 0);
    const cut = items.reduce((a, b) => a + (b.locked ? 0 : Math.max(0, b.plannedPaise - b.committedPaise)), 0);
    lines.push(`  ${c}: ${rupees(p)} / ${rupees(cm)} / ${rupees(cut)} — ${items.map(b => `${b.id} "${b.label}"${b.locked ? " 🔒" : ""}${b.quotedPaise ? ` quoted ${rupees(b.quotedPaise)}` : ""}`).join("; ")}`);
  }
  const pays = st.budgetItems.flatMap(b => b.payments.filter(p => !p.paidDate).map(p => `${b.id}/${p.id} ${p.kind} ${rupees(p.amountPaise)} due ${p.dueDate}`));
  if (pays.length) lines.push(`UNPAID PAYMENTS: ${pays.join(" | ")}`);
  const due = (t: AgentState["tasks"][number]) => taskDueDate(st, t);
  lines.push(`TASKS: ${st.tasks.map(t => `${t.id} "${t.title}" ${t.status} ${t.priority} due ${due(t)}${t.dependsOn.length ? ` after ${t.dependsOn.join("+")}` : ""}`).join(" | ")}`);
  lines.push(`PRIORITIES: ${prioritiesDigest(st)}`);
  const perGuest = st.budgetItems.filter(b => b.basis === "per_guest" && b.perGuestPaise);
  if (perGuest.length) lines.push(`PER-GUEST LINES (rescale with guestCount): ${perGuest.map(b => `${b.id} ${rupees(b.perGuestPaise!)}/guest`).join(", ")}`);
  if (st.vendors.length) lines.push(`VENDORS (id name category stage need quotes): ${st.vendors.map(v => `${v.id} "${v.name}" ${v.category} ${v.stage}${v.need ? ` ${v.need}` : ""} ${v.quotes.length}q`).join(" | ")}`);
  const checklist = checklistFor(st).map(s => `${s.key}${st.vendorChecklist.notNeeded.includes(s.key) ? "(not needed)" : ""}`);
  lines.push(`VENDOR CHECKLIST SLOTS: ${checklist.join(", ")}`);
  if (st.timeline.length) lines.push(`TIMELINE BLOCKS: ${st.timeline.map(b => `${b.id} ${b.label}@${b.subEventId} ${b.startMin}-${b.endMin}min lane ${b.lane}${b.anchored ? " ANCHORED" : ""}`).join(" | ")}`);
  // Names and ids only: phones and emails are organizer-only and never go to the model (v8 Part 1).
  if (st.households.length) lines.push(`HOUSEHOLDS (${st.households.length}; id "label" size): ${st.households.slice(0, 40).map(h => `${h.id} "${h.label}" ${st.guests.filter(g => g.householdId === h.id).length}`).join(" | ")}`);
  if (st.guests.length) lines.push(`GUESTS: ${st.guests.slice(0, 60).map(g => `${g.id} ${g.name}`).join(", ")}`);
  // v8 Part 1c: the open RSVP list. Ids, names, party size and answer only (never phones); numbers come from get_rsvp_counts.
  const c = computeRsvpCounts(st);
  if (st.rsvpEntries.length) {
    const live = st.rsvpEntries.filter(e => !e.removedAt && !e.mergedInto);
    lines.push(`RSVP LIST (${c.totalEntries} live; call get_rsvp_counts for any headcount; settings: closes ${st.rsvpSettings.closesAt ?? "never"}, askKids ${st.rsvpSettings.askKids}): ${live.slice(0, 60).map(e => `${e.id} "${e.name}" ${e.partySize} ${e.answer}${e.vip ? " VIP" : ""}${e.possibleDuplicateOf ? ` DUP-OF ${e.possibleDuplicateOf}` : ""}`).join(" | ")}`);
    const removed = st.rsvpEntries.filter(e => e.removedAt && !e.mergedInto);
    if (removed.length) lines.push(`RSVPs REMOVED (restorable): ${removed.slice(0, 20).map(e => `${e.id} "${e.name}"`).join(" | ")}`);
  } else lines.push(`RSVP LIST: empty (settings: closes ${st.rsvpSettings.closesAt ?? "never"}, askKids ${st.rsvpSettings.askKids})`);
  const pendingJoins = st.joinRequests.filter(r => r.status === "pending");
  if (pendingJoins.length) lines.push(`JOIN REQUESTS pending (id name size): ${pendingJoins.slice(0, 20).map(r => `${r.id} ${r.name} ${r.size}`).join(" | ")}`);
  const x = e.ext;
  if (x.type === "wedding") lines.push(`WEDDING partners ${x.partners.join(" & ")}, traditions ${x.traditions.join(", ")}; gift registry ${x.wishlist.map(w => `${w.id} ${w.item} (${w.claimedByGuestId ? "claimed" : "unclaimed"})`).join("; ") || "(empty)"}${x.wishlistSurprise ? "; surprise mode on" : ""}`);
  if (x.type === "birthday") lines.push(`BIRTHDAY ${x.honoree} turning ${x.turningAge ?? "?"}, theme ${x.theme}; wishlist ${x.wishlist.map(w => `${w.id} ${w.item} (${w.priority}${w.claimedByGuestId ? `, claimed by ${w.claimedByGuestId}` : ", unclaimed"})`).join("; ")}`);
  if (x.type === "birthday") {
    // v8 Part 1e: the run-sheet with times computed by code (run-sheet.ts); the model quotes them, never works them out.
    const times = computeRunSheetTimes(x.partyStart, x.activities);
    lines.push(`RUN-SHEET (${x.activities.length}/${ACTIVITY_LIMITS.maxActivities} rows, total ${runSheetTotal(x.activities)} min, party start ${x.partyStart ?? "not set"}${times ? `, ends ${runSheetEnd(x.partyStart, x.activities)}` : ""}; #index id "name" minutes ages${times ? " time" : ""}): ${x.activities.map((a, k) => `#${k} ${a.id} "${a.name}" ${a.durationMin}min ${a.ageRange ? `${a.ageRange[0]}-${a.ageRange[1]}` : "all"}${times ? ` ${times[k]!.label}` : ""}`).join(" | ") || "(empty)"}`);
  }
  if (x.type === "community") {
    lines.push(`SPONSORS: ${x.sponsors.map(s => `${s.id} ${s.name} ${s.tier} ${s.status} pledged ${rupees(s.pledgedPaise)} received ${rupees(s.receivedPaise)}`).join(" | ")}`);
    lines.push(`PERMITS: ${x.permits.map(p => `${p.id} ${p.authority} ${p.kind} ${p.status} applyBy ${p.applyBy ?? "-"}`).join(" | ")}`);
  }
  return lines.join("\n");
}

/**
 * What a guest may see: schedule, venues, dress codes, their own RSVP, wishlist, volunteer shifts. No money, no vendors.
 * v8 Part 1c: the acting guest is an RSVP entry (Guest View); only that entry's answers, never anybody else's.
 */
export function summarizeForGuest(st: AgentState, actingEntryId: string | null): string {
  const e = st.event;
  const wd = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const hm = (m: number) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${m < 720 ? "AM" : "PM"}`;
  const lines = [`EVENT ${e.title} | ${e.eventType} | ${e.city} | ${e.startDate}..${e.endDate}`];
  // Guest View acts as someone holding the RSVP link: every sub-event that takes RSVPs, plus the public ones.
  const fns = rsvpFunctions(st);
  const visible = new Set([...visibleSubEventIds(st, []), ...fns.map(s => s.id)]);
  for (const s of [...st.subEvents].filter(s => visible.has(s.id)).sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin)) {
    const blocks = st.timeline.filter(b => b.subEventId === s.id).sort((a, b) => a.startMin - b.startMin).map(b => `${hm(b.startMin)} ${b.label}`);
    lines.push(`- ${s.slug}: ${s.name}, ${wd(s.date)} ${s.date} ${hm(s.startMin)}–${hm(s.endMin)}, venue ${s.venue || "tbc"}, dress code ${s.dressCode || "none"}${s.collectsRsvp ? ", takes RSVPs" : ""}${blocks.length ? `; schedule: ${blocks.join(", ")}` : ""}`);
  }
  const me = actingEntryId ? st.rsvpEntries.find(r => r.id === actingEntryId && !r.removedAt && !r.mergedInto) : undefined;
  if (me) lines.push(`YOUR RSVP ${me.id}: "${me.name}", ${me.partySize} people, ${ANSWER_LABEL[me.answer]}, functions ${me.functions.map(f => st.subEvents.find(s => s.id === f)?.slug ?? f).join(", ") || "none"}, meal ${MEAL_LABEL[me.meal]}`);
  else lines.push("YOUR RSVP: not sent yet (the guest fills in the RSVP form first)");
  const x = e.ext;
  if (x.type === "birthday" || x.type === "wedding") lines.push(`${x.type === "wedding" ? "GIFT REGISTRY" : "WISHLIST"}: ${x.wishlist.map(w => `${w.id} ${w.item} (${w.claimedByGuestId ? (me && w.claimedByGuestId === me.id ? "claimed by you" : "claimed") : "unclaimed"})`).join("; ")}`);
  if (x.type === "community") lines.push(`VOLUNTEERS signed up: ${x.volunteerSignups.length}; sponsor tiers: title, gold, silver, in_kind`);
  return lines.join("\n");
}
