// Multimodal vendor quote & contract scanner. Gemini Vision (or the deterministic sample parser) only *reads*
// the document; the result becomes one upsert_vendor_quote command that goes through the same reducer, trust
// tier (always Tier 1) and Before → After diff as everything else.
import { z } from "zod";
import type { AgentState } from "./schema";
import { BudgetItem, IsoDate } from "./schema";
import { addDays, type BatchInput, type Role, rupees } from "./commands";
import { executeAgentTool, type AgentAction } from "./agent";

export const ScannedQuote = z.object({
  vendorName: z.string().min(1),
  category: BudgetItem.shape.category,
  itemLabel: z.string().min(1),
  quotedPaise: z.number().int().nonnegative(),
  depositRequiredPaise: z.number().int().nonnegative().optional(),
  dueAt: IsoDate.optional(),
  subEvent: z.string().optional(),
  budgetItemId: z.string().optional(),
  notes: z.string().default(""),
  redFlags: z.array(z.string()).default([]),
  summary: z.string().default(""),
});
export type ScannedQuote = z.infer<typeof ScannedQuote>;

/** What we ask Gemini Vision for. Money in whole rupees (it reads digits off the page); we convert to paise. */
export const VisionExtraction = z.object({
  vendorName: z.string(),
  category: BudgetItem.shape.category,
  itemLabel: z.string().describe("What is being quoted, in a few words"),
  quotedRupees: z.number().describe("Grand total payable, whole rupees, as printed"),
  depositRupees: z.number().optional().describe("Advance / deposit required, whole rupees, as printed"),
  dueAt: z.string().optional().describe("Deposit due date YYYY-MM-DD only if a calendar date is printed"),
  depositDueInDays: z.number().int().optional().describe("If the deposit is due 'within N days', N"),
  subEvent: z.string().optional().describe("Which of the listed sub-event slugs this is for, if clear"),
  notes: z.string().optional().describe("Key terms: cancellation, corkage, overtime, taxes"),
  redFlags: z.array(z.string()).describe("Risky clauses, each one short line starting with ⚠️"),
  summary: z.string().describe("One sentence"),
});
export type VisionExtraction = z.infer<typeof VisionExtraction>;

export function visionToScanned(v: VisionExtraction, today: string): ScannedQuote {
  const r2p = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? undefined : Math.round(n * 100));
  const dueAt = v.dueAt && /^\d{4}-\d{2}-\d{2}$/.test(v.dueAt) ? v.dueAt
    : v.depositDueInDays !== undefined ? addDays(today, v.depositDueInDays) : undefined;
  return ScannedQuote.parse({
    vendorName: v.vendorName.trim(), category: v.category, itemLabel: v.itemLabel.trim(), quotedPaise: r2p(v.quotedRupees) ?? 0,
    depositRequiredPaise: r2p(v.depositRupees), dueAt, subEvent: v.subEvent || undefined,
    notes: v.notes ?? "", redFlags: v.redFlags, summary: v.summary,
  });
}

// ---------- built-in sample documents (one per archetype) ----------
export const SAMPLE_QUOTES = [
  {
    id: "royal-caterer-quote", archetype: "wedding", budgetItemId: "b8", fileName: "deccan-royal-caterers-sangeet.pdf",
    title: "Deccan Royal Caterers — Sangeet Dinner Quote",
    text: `DECCAN ROYAL CATERERS
Banjara Hills, Hyderabad · GSTIN 36ABCDE1234F1Z5
QUOTATION No. DRC/2026/1187
Event: Sangeet
Item: Sangeet dinner — live counters, 320 guests
Grand Total: ₹1,85,000
Advance: ₹50,000, non-refundable, payable by 2026-10-25
Terms: Overtime ₹15,000/hr after 11:30 PM. Generator backup billed extra.`,
    redFlags: ["⚠️ 25% non-refundable deposit", "⚠️ ₹15,000/hr overtime after 11:30 PM", "⚠️ Generator backup billed extra"],
  },
  {
    id: "arcade-rental-invoice", archetype: "birthday", budgetItemId: "bb4", fileName: "bandra-arcade-rentals.png",
    title: "Bandra Arcade Rentals — 6 Deluxe Cabinets + VR Pod",
    text: `BANDRA ARCADE RENTALS
Hill Road, Bandra West, Mumbai
PROFORMA INVOICE #BAR-0442
Event: Party
Item: Arcade machine rental — 6 deluxe cabinets + VR pod
Grand Total: ₹26,000
Terms: ₹10,000 security deposit required, refundable after pickup. Staircase load-in fee ₹2,500 extra.`,
    redFlags: ["⚠️ ₹10,000 security deposit required", "⚠️ Staircase load-in fee ₹2,500"],
  },
  {
    id: "sound-stage-contract", archetype: "community", budgetItemId: "cb3", fileName: "telangana-pro-audio-truss.pdf",
    title: "Telangana Pro Audio & Truss — Main Stage Line Array",
    text: `TELANGANA PRO AUDIO & TRUSS
Kukatpally, Hyderabad
SERVICE CONTRACT TPA-2026-219
Event: Main Stage & Food Court
Item: Stage, truss & lighting with line-array sound
Grand Total: ₹1,45,000
Terms: Requires 60kVA 3-phase generator, arranged by the organiser. 100% advance 7 days before event.`,
    redFlags: ["⚠️ Requires 60kVA 3-phase generator", "⚠️ 100% advance 7 days before event"],
  },
] as const;
export type SamplePresetId = (typeof SAMPLE_QUOTES)[number]["id"];

const CATEGORY_HINTS: [RegExp, ScannedQuote["category"]][] = [
  [/cater|lunch|dinner|plates|buffet|banana leaf/i, "catering"],
  [/arcade|pinball|games|entertain|artist|performer/i, "entertainment"],
  [/stage|truss|lighting|decor|flor|mandap/i, "decor"],
  [/sound|dj|band|music/i, "music"],
  [/photo|video|film/i, "photo_video"],
  [/hall|venue|grounds|lounge|banquet/i, "venue"],
  [/tent|chairs|transport|shuttle|cab/i, "logistics"],
];
const money = (s: string) => Math.round(parseFloat(s.replace(/[₹,\s]/g, "")) * 100);

/** Deterministic parser for typed / OCR'd quote text (used for the samples and for plain-text uploads). */
export function parseQuoteText(text: string, today: string): ScannedQuote {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const field = (label: string) => lines.find(l => new RegExp(`^${label}\\s*:`, "i").test(l))?.replace(/^[^:]+:\s*/, "");
  const vendorName = (lines[0] ?? "Vendor").toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(/ & /g, " & ");
  const item = field("Item") ?? field("Description") ?? "Vendor services";
  const totalLine = field("Grand Total") ?? field("Total") ?? "";
  const quotedPaise = totalLine.match(/₹\s?[\d,]+(?:\.\d+)?/) ? money(totalLine.match(/₹\s?[\d,]+(?:\.\d+)?/)![0]) : 0;
  const adv = field("Advance") ?? field("Deposit") ?? "";
  const advAmt = adv.match(/₹\s?[\d,]+(?:\.\d+)?/);
  const pct = adv.match(/(\d+)\s*%/);
  const depositRequiredPaise = advAmt ? money(advAmt[0]) : pct ? Math.round((quotedPaise * Number(pct[1])) / 100) : undefined;
  const within = adv.match(/within\s+(\d+)\s+days?/i);
  const dated = adv.match(/\d{4}-\d{2}-\d{2}/);
  const dueAt = dated ? dated[0] : within ? addDays(today, Number(within[1])) : undefined;
  const terms = field("Terms") ?? "";
  const category = CATEGORY_HINTS.find(([re]) => re.test(item))?.[1] ?? CATEGORY_HINTS.find(([re]) => re.test(text))?.[1] ?? "misc";

  const redFlags: string[] = [];
  if (/non-refundable/i.test(adv) && depositRequiredPaise !== undefined)
    redFlags.push(`⚠️ Non-refundable ${pct ? `${pct[1]}% ` : ""}deposit of ${rupees(depositRequiredPaise)}${within ? ` due in ${within[1]} days` : dueAt ? ` due ${dueAt}` : ""}`);
  else if (depositRequiredPaise !== undefined && within && Number(within[1]) <= 7)
    redFlags.push(`⚠️ Deposit of ${rupees(depositRequiredPaise)} due in ${within[1]} days`);
  for (const sentence of terms.split(/(?<=\.)\s+/)) {
    const t = sentence.replace(/\.$/, "");
    if (/corkage|overtime|late return|uncapped|cancellation|forfeit|extra|actuals/i.test(t)) redFlags.push(`⚠️ ${t}`);
  }
  const minGuarantee = field("Minimum guarantee");
  if (minGuarantee) redFlags.push(`⚠️ Minimum guarantee: ${minGuarantee}`);
  const ev = field("Event");
  return ScannedQuote.parse({
    vendorName, category, itemLabel: item, quotedPaise, depositRequiredPaise, dueAt,
    subEvent: ev ? ev.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : undefined,
    notes: terms, redFlags,
    summary: `${vendorName} quotes ${rupees(quotedPaise)} for ${item}${depositRequiredPaise ? `, ${rupees(depositRequiredPaise)} upfront` : ""}.`,
  });
}

/** Accepts a sample id or an archetype ("wedding" | "birthday" | "community"). */
export function sampleQuote(key: string, today: string): ScannedQuote | null {
  const s = SAMPLE_QUOTES.find(x => x.id === key || x.archetype === key);
  if (!s) return null;
  return { ...parseQuoteText(s.text, today), budgetItemId: s.budgetItemId, redFlags: [...s.redFlags] };
}

export type ScanResponse = {
  source: "sample" | "gemini" | "text" | "unavailable";
  /** Same shape as ChatResponse: reply + actions (+ mode, warning). */
  mode?: "gemini" | "offline";
  scanned?: ScannedQuote;
  reply: string;
  actions: AgentAction[];
  warning?: string;
};

/** Turn an extraction into one upsert_vendor_quote batch and dry-run it through the shared executor (Tier 1). */
export function scanToActions(q: ScannedQuote, plan: AgentState, today: string, role: Role = "organizer", source = "scan"):
  { batch: BatchInput; actions: AgentAction[]; reply: string } {
  const subEvent = q.subEvent && plan.subEvents.some(s => s.slug === q.subEvent) ? q.subEvent : undefined;
  const batch: BatchInput = {
    summary: `Scanned quote: ${q.vendorName} ${rupees(q.quotedPaise)} for ${q.itemLabel}`,
    commands: [{
      op: "upsert_vendor_quote", ...(q.budgetItemId && plan.budgetItems.some(b => b.id === q.budgetItemId) ? { budgetItemId: q.budgetItemId } : {}),
      vendorName: q.vendorName, category: q.category, itemLabel: q.itemLabel, quotedPaise: q.quotedPaise,
      ...(q.depositRequiredPaise !== undefined ? { depositRequiredPaise: q.depositRequiredPaise } : {}),
      ...(q.dueAt ? { dueAt: q.dueAt } : {}), receivedOn: today, ...(subEvent ? { subEvent } : {}),
      notes: q.notes, redFlags: q.redFlags,
    }],
  };
  const out = executeAgentTool("apply_plan_changes", batch, plan, today, role);
  const actions = out.actions.map(a => (a.kind === "batch" ? { ...a, redFlags: q.redFlags, source } : a));
  const b = actions.find(a => a.kind === "batch");
  const quoteRow = b?.kind === "batch" ? b.diff.rows.find(r => r.kind === "quote") : undefined;
  const reply = !out.response.ok ? `I read the quote but couldn't stage it: ${String(out.response.reason)}`
    : `${q.summary} ${quoteRow?.note ? `It ${quoteRow.note.replace(/^⚠\s*/, "")}. ` : ""}${q.redFlags.length ? `${q.redFlags.length} contract red flag${q.redFlags.length > 1 ? "s" : ""} to review before you approve.` : "No risky clauses spotted."}`;
  return { batch, actions, reply };
}
