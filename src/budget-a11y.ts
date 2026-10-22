// Screen-reader descriptions for the budget graphics. Pure functions (no React), so they're unit-tested
// and the visible bars and their accessible values can never disagree.
import type { BudgetItem } from "./schema";

/** ₹ with Indian digit grouping: 15000000 paise → ₹1,50,000. */
export const inr = (paise: number) => `${paise < 0 ? "−" : ""}₹${Math.round(Math.abs(paise) / 100).toLocaleString("en-IN")}`;
/** Compact lakh/crore form for tight spots: ₹25L, ₹1.5L, ₹80K. */
export function inrShort(paise: number) {
  const r = Math.abs(paise) / 100, s = paise < 0 ? "−" : "";
  if (r >= 1e7) return `${s}₹${+(r / 1e7).toFixed(2)}Cr`;
  if (r >= 1e5) return `${s}₹${+(r / 1e5).toFixed(2)}L`;
  if (r >= 1e3) return `${s}₹${+(r / 1e3).toFixed(1)}K`;
  return `${s}₹${r}`;
}
const rupees = (paise: number) => Math.round(paise / 100);

/** Decorative quote/flag glyphs the scanner prefixes to red-flag lines (the card already shows a warning icon). */
export const stripFlagGlyph = (s: string) => s.replace(/^\s*⚠\uFE0F?\s*/u, "");

export type EnvelopeA11y =
  | { role: "meter"; label: string; valueNow: number; valueMin: 0; valueMax: number; valueText: string }
  | { role: "img"; label: string };

type Envelope = Pick<BudgetItem, "label" | "plannedPaise" | "committedPaise" | "quotedPaise" | "locked">;

/**
 * The ledger bar is a composition (committed floor, uncommitted slack, overage, quote marker), not task
 * progress. It is exposed as a meter of committed spend against the planned envelope, with the full
 * picture in aria-valuetext. A line with no planned budget has no meaningful maximum, so it becomes a
 * labelled image instead of a meter with a fake range. Values are whole rupees.
 */
export function envelopeA11y(b: Envelope): EnvelopeA11y {
  const planned = Math.max(0, b.plannedPaise), committed = Math.max(0, b.committedPaise);
  const parts: string[] = [];
  if (planned === 0) {
    parts.push(committed === 0 ? "no budget planned and nothing committed" : `${inr(committed)} committed with no budget planned`);
  } else {
    parts.push(`${inr(committed)} committed of ${inr(planned)} planned`);
    parts.push(committed > planned ? `${inr(committed - planned)} over the plan` : `${inr(planned - committed)} not yet committed`);
  }
  if (b.quotedPaise !== null && b.quotedPaise !== undefined) {
    parts.push(`vendor quote ${inr(b.quotedPaise)}${planned > 0 ? (b.quotedPaise > planned ? ", above the plan" : ", within the plan") : ""}`);
  }
  if (b.locked) parts.push("locked, so AI cuts skip it");
  const text = `${b.label}: ${parts.join(", ")}.`;
  if (planned === 0) return { role: "img", label: text };
  return { role: "meter", label: `${b.label} budget`, valueNow: rupees(Math.min(committed, planned)), valueMin: 0, valueMax: rupees(planned), valueText: text };
}

export type SponsorProgress = { label: string; valueNow: number; valueMax: number; valueText: string } | null;

/** Sponsor money received against the pledge: genuine progress toward a target. In-kind pledges have none. */
export function sponsorProgress(s: { name: string; pledgedPaise: number; receivedPaise: number }): SponsorProgress {
  if (s.pledgedPaise <= 0) return null;
  const received = Math.max(0, s.receivedPaise);
  const extra = received > s.pledgedPaise ? `, ${inr(received - s.pledgedPaise)} above the pledge` : "";
  return { label: `${s.name} sponsorship received`, valueNow: rupees(Math.min(received, s.pledgedPaise)), valueMax: rupees(s.pledgedPaise),
    valueText: `${inr(received)} received of ${inr(s.pledgedPaise)} pledged${extra}` };
}
