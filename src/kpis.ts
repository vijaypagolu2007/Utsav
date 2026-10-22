// KPI values: one calculation per KPI id from config/kpis.ts. Pure functions over the plan, sharing one
// precomputed context so the header derives each total once per render. The record is keyed by KpiId, so a
// configured KPI without a calculation (or the reverse) is a type error.
import type { AgentState } from "./schema";
import { daysBetween, plannedTotal } from "./commands";
import { inr } from "./budget-a11y";
import type { KpiId } from "./config/kpis";

export type KpiValue = { value: string; sub?: string; tone?: "default" | "danger" | "positive" };

export type KpiContext = {
  plan: AgentState;
  total: number; planned: number; committed: number; paid: number;
  main: AgentState["subEvents"][number] | undefined;
  /** Days from the planning date to the main event; null when there is no main event. */
  daysToEvent: number | null;
  /** Guests invited to the main event, and how many said yes / have not answered. */
  invited: number; yes: number; pending: number;
};

export function kpiContext(plan: AgentState, today: string): KpiContext {
  const main = plan.subEvents.find(s => s.isMain);
  const invited = main ? plan.guests.filter(g => g.rsvp[main.id]) : [];
  return {
    plan,
    total: plan.event.totalBudgetPaise,
    planned: plannedTotal(plan),
    committed: plan.budgetItems.reduce((a, b) => a + b.committedPaise, 0),
    paid: plan.budgetItems.reduce((a, b) => a + b.payments.reduce((x, p) => x + (p.paidDate ? p.amountPaise : 0), 0), 0),
    main,
    daysToEvent: main ? daysBetween(today, main.date) : null,
    invited: invited.length,
    yes: main ? invited.filter(g => g.rsvp[main.id] === "yes").length : 0,
    pending: main ? invited.filter(g => ["invited", "maybe"].includes(g.rsvp[main.id] ?? "")).length : 0,
  };
}

const daysText = (d: number | null) => (d === null ? "—" : d >= 0 ? `${d} days` : `${-d}d ago`);

export const KPI_CALCULATORS: Readonly<Record<KpiId, (c: KpiContext) => KpiValue>> = {
  "total-budget": c => ({ value: inr(c.total) }),
  planned: c => ({
    value: inr(c.planned),
    sub: c.planned > c.total ? `over by ${inr(c.planned - c.total)}` : `${inr(c.total - c.planned)} headroom`,
    tone: c.planned > c.total ? "danger" : "default",
  }),
  committed: c => ({ value: inr(c.committed), sub: `${Math.round((c.committed / Math.max(1, c.total)) * 100)}% of budget` }),
  paid: c => ({ value: inr(c.paid), sub: `${inr(Math.max(0, c.committed - c.paid))} still owed`, tone: "positive" }),
  "days-to-event": c => ({ value: daysText(c.daysToEvent), sub: c.main ? `${c.main.name} · ${c.main.date}` : undefined }),
  "rsvp-summary": c => c.invited
    ? { value: `${c.yes} / ${c.invited} yes`, sub: `${c.pending} pending` }
    : { value: `${c.plan.event.guestCount} expected`, sub: "no guest list yet" },
  itinerary: c => ({ value: `${c.plan.subEvents.length} on the itinerary`, sub: c.plan.event.city }),
  "rsvp-attending": c => c.invited ? { value: `${c.yes} attending`, sub: `${c.pending} still to reply` } : { value: "open" },
};

export const kpiValue = (id: KpiId, c: KpiContext): KpiValue => KPI_CALCULATORS[id](c);
