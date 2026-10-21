// Shared agent runtime: one executor for every tool, used by the Gemini route and by the offline demo parser.
// It never mutates the live plan. It dry-runs batches and returns proposals; the client commits them through
// applyBatch after the trust-tier check (Tier 0 auto, Tier 1 approve, Tier 2 human sends).
import { z } from "zod";
import { householdOf, visibleSubEventIds } from "./visibility";
import type { AgentState } from "./schema";
import { applyBatch, Batch, type BatchInput, type Diagnostics, type Role, rupees, taskDueDate } from "./commands";
import { initializeEventPlan } from "./blueprint";
import { computePlanDiff, type PlanDiff } from "./diff";
import { computePlanInsights, type Insight } from "./insights";
import { batchTier, type TrustTier } from "./trust";

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
      redFlags?: string[]; source?: string }
  | { kind: "rejection"; id: string; batch: BatchInput; rejection: RejectionInfo }
  | { kind: "init"; id: string; plan: AgentState; log: string[] }
  | { kind: "init_rejection"; id: string; reason: string; issues: string[] }
  | { kind: "draft"; id: string; draft: DraftOutboundMessage }
  | { kind: "insights"; id: string; insights: Insight[] };

export type ChatTurn = { role: "user" | "assistant"; text: string };
export type ChatRequest = { messages: ChatTurn[]; state: AgentState; today: string; forceOffline?: boolean;
  role?: Role; actingGuestId?: string | null };
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
export function executeAgentTool(name: string, args: unknown, working: AgentState, today: string, role: Role = "organizer"):
  { response: Record<string, unknown>; actions: AgentAction[]; working: AgentState } {
  if (role === "guest" && !GUEST_TOOLS.has(name))
    return { response: { ok: false, reason: `${name} isn't available in Guest mode` }, actions: [], working };
  switch (name) {
    case "get_event_info":
      return { response: { info: summarizeForGuest(working, null) }, actions: [], working };
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
      const r = applyBatch(working, args, { role });
      if (r.ok) {
        const tier = batchTier(Batch.parse(args).commands);
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
  lines.push(`TASKS: ${st.tasks.map(t => `${t.id} "${t.title}" ${t.status} due ${due(t)}`).join(" | ")}`);
  if (st.timeline.length) lines.push(`TIMELINE BLOCKS: ${st.timeline.map(b => `${b.id} ${b.label}@${b.subEventId} ${b.startMin}-${b.endMin}min lane ${b.lane}${b.anchored ? " ANCHORED" : ""}`).join(" | ")}`);
  if (st.guests.length) lines.push(`GUESTS: ${st.guests.slice(0, 60).map(g => `${g.id} ${g.name}`).join(", ")}`);
  const x = e.ext;
  if (x.type === "wedding") lines.push(`WEDDING partners ${x.partners.join(" & ")}, traditions ${x.traditions.join(", ")}`);
  if (x.type === "birthday") lines.push(`BIRTHDAY ${x.honoree} turning ${x.turningAge ?? "?"}, theme ${x.theme}; wishlist ${x.wishlist.map(w => `${w.id} ${w.item} (${w.priority}${w.claimedByGuestId ? `, claimed by ${w.claimedByGuestId}` : ", unclaimed"})`).join("; ")}`);
  if (x.type === "community") {
    lines.push(`SPONSORS: ${x.sponsors.map(s => `${s.id} ${s.name} ${s.tier} ${s.status} pledged ${rupees(s.pledgedPaise)} received ${rupees(s.receivedPaise)}`).join(" | ")}`);
    lines.push(`PERMITS: ${x.permits.map(p => `${p.id} ${p.authority} ${p.kind} ${p.status} applyBy ${p.applyBy ?? "-"}`).join(" | ")}`);
  }
  return lines.join("\n");
}

/** What a guest may see: schedule, venues, dress codes, RSVPs, wishlist, volunteer shifts. No money, no vendors. */
export function summarizeForGuest(st: AgentState, actingGuestId: string | null): string {
  const e = st.event;
  const wd = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const hm = (m: number) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${m < 720 ? "AM" : "PM"}`;
  const lines = [`EVENT ${e.title} | ${e.eventType} | ${e.city} | ${e.startDate}..${e.endDate}`];
  const visible = visibleSubEventIds(st, householdOf(st, actingGuestId));
  for (const s of [...st.subEvents].filter(s => visible.has(s.id)).sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin)) {
    const blocks = st.timeline.filter(b => b.subEventId === s.id).sort((a, b) => a.startMin - b.startMin).map(b => `${hm(b.startMin)} ${b.label}`);
    lines.push(`- ${s.slug}: ${s.name}, ${wd(s.date)} ${s.date} ${hm(s.startMin)}–${hm(s.endMin)}, venue ${s.venue || "tbc"}, dress code ${s.dressCode || "none"}${blocks.length ? `; schedule: ${blocks.join(", ")}` : ""}`);
  }
  for (const h of st.households) {
    const gs = st.guests.filter(g => g.householdId === h.id);
    if (gs.length) lines.push(`HOUSEHOLD ${h.id} "${h.label}": ${gs.map(g => `${g.id} ${g.name} [${Object.entries(g.rsvp).map(([sid, v]) => `${visible.has(sid) ? st.subEvents.find(x => x.id === sid)?.slug ?? sid : "private"}=${v}`).join(" ")}]${g.diet.length ? ` diet ${g.diet.join("/")}` : ""}`).join("; ")}`);
  }
  const x = e.ext;
  if (x.type === "birthday") lines.push(`WISHLIST: ${x.wishlist.map(w => `${w.id} ${w.item} (${w.claimedByGuestId ? "claimed" : "unclaimed"})`).join("; ")}`);
  if (x.type === "community") lines.push(`VOLUNTEERS signed up: ${x.volunteerSignups.length}; sponsor tiers: title, gold, silver, in_kind`);
  if (actingGuestId) lines.push(`ACTING GUEST: ${actingGuestId} (${st.guests.find(g => g.id === actingGuestId)?.name ?? "unknown"})`);
  return lines.join("\n");
}
