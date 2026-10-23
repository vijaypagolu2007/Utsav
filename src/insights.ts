// Proactive insights: pure, deterministic red flags derived from the plan. Never stored, so never stale.
import type { EventPlan } from "./schema";
import { addDays, categoryMaxCuttable, daysBetween, plannedTotal, rupees, taskDueDate } from "./commands";

export type InsightKind =
  | "overdue_deposit" | "upcoming_deposit" | "envelope_breach" | "over_budget" | "urgent_task"
  | "permit_risk" | "wishlist_unclaimed" | "rsvp_pending" | "sponsor_gap" | "blocked_task";
export type Severity = "critical" | "warning" | "info";

export type Insight = {
  id: string;
  kind: InsightKind;
  severity: Severity;
  title: string;
  detail: string;
  /** Ids of the plan entities this insight points at, so the canvas can highlight them. */
  refs: string[];
  /** Sort key: the date the flag is about, if any. */
  date?: string;
  amountPaise?: number;
  /** For an envelope breach: other categories whose unlocked slack could cover the gap, largest first. */
  coverFrom?: { category: string; cuttablePaise: number }[];
};

export type PlanInsights = {
  today: string;
  insights: Insight[];
  counts: Record<Severity, number>;
  redFlags: number;
};

/** Today's date in India (the app's home zone), YYYY-MM-DD. */
export function todayIST(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function computePlanInsights(plan: EventPlan, today: string = todayIST()): PlanInsights {
  const out: Insight[] = [];
  const seName = (id: string | null) => plan.subEvents.find(s => s.id === id)?.name;

  // Deposits and payments
  for (const b of plan.budgetItems) for (const p of b.payments) {
    if (p.paidDate) continue;
    if (p.dueDate < today) {
      const late = daysBetween(p.dueDate, today);
      out.push({ id: `overdue:${b.id}:${p.id}`, kind: "overdue_deposit", severity: "critical",
        title: `${b.label}: ${p.kind} overdue`, detail: `${rupees(p.amountPaise)} was due ${p.dueDate} (${late}d ago)`,
        refs: [b.id, p.id], date: p.dueDate, amountPaise: p.amountPaise });
    } else if (p.dueDate <= addDays(today, 14)) {
      out.push({ id: `upcoming:${b.id}:${p.id}`, kind: "upcoming_deposit", severity: "info",
        title: `${b.label}: ${p.kind} due soon`, detail: `${rupees(p.amountPaise)} due ${p.dueDate} (in ${daysBetween(today, p.dueDate)}d)`,
        refs: [b.id, p.id], date: p.dueDate, amountPaise: p.amountPaise });
    }
  }

  // Envelope breach risk
  const cuttable = categoryMaxCuttable(plan);
  for (const b of plan.budgetItems) {
    if (b.committedPaise > b.plannedPaise)
      out.push({ id: `breach:c:${b.id}`, kind: "envelope_breach", severity: "critical", title: `${b.label}: committed over envelope`,
        detail: `Committed ${rupees(b.committedPaise)} vs planned ${rupees(b.plannedPaise)}`, refs: [b.id], amountPaise: b.committedPaise - b.plannedPaise });
    else if (b.quotedPaise !== null && b.quotedPaise > b.plannedPaise) {
      const gap = b.quotedPaise - b.plannedPaise;
      const coverFrom = Object.entries(cuttable).filter(([c, v]) => c !== b.category && v > 0)
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 3).map(([category, cuttablePaise]) => ({ category, cuttablePaise }));
      const headroom = plan.event.totalBudgetPaise - plannedTotal(plan);
      const cover = headroom >= gap ? `fits in the ${rupees(headroom)} headroom`
        : coverFrom.length ? `cuttable elsewhere: ${coverFrom.map(c => `${c.category} ${rupees(c.cuttablePaise)}`).join(", ")}` : "no unlocked slack elsewhere";
      out.push({ id: `breach:q:${b.id}`, kind: "envelope_breach", severity: "warning", title: `Envelope breach: ${b.label}`,
        detail: `Quoted ${rupees(b.quotedPaise)} exceeds planned ${rupees(b.plannedPaise)} by ${rupees(gap)} · ${cover}`,
        refs: [b.id], amountPaise: gap, coverFrom });
    }
  }
  const planned = plannedTotal(plan);
  if (planned > plan.event.totalBudgetPaise)
    out.push({ id: "over_budget", kind: "over_budget", severity: "critical", title: "Plan exceeds total budget",
      detail: `Planned ${rupees(planned)} vs budget ${rupees(plan.event.totalBudgetPaise)}`, refs: [], amountPaise: planned - plan.event.totalBudgetPaise });

  // Urgent tasks (derived due date within 14 days, or past due)
  for (const t of plan.tasks) {
    if (t.status === "done") continue;
    const due = taskDueDate(plan, t);
    if (due > addDays(today, 14)) continue;
    const d = daysBetween(today, due);
    out.push({ id: `task:${t.id}`, kind: "urgent_task", severity: d < 0 ? "critical" : t.priority === "high" || d <= 3 ? "warning" : "info",
      title: t.title, detail: `${d < 0 ? `${-d}d overdue` : d === 0 ? "due today" : `due in ${d}d`} (${due}${seName(t.subEventId) ? `, ${Math.abs(t.dueOffsetDays)}d ${t.dueOffsetDays <= 0 ? "before" : "after"} ${seName(t.subEventId)}` : ""})`,
      refs: [t.id], date: due });
  }

  // v6: dependencies. A task waiting on another that is overdue, due within a week, or due after it is flagged (code, not the LLM).
  for (const t of plan.tasks) {
    if (t.status === "done" || !t.dependsOn.length) continue;
    const due = taskDueDate(plan, t);
    const dT = daysBetween(today, due);
    const problems: { id: string; text: string; level: number }[] = [];
    for (const depId of t.dependsOn) {
      const d = plan.tasks.find(x => x.id === depId);
      if (!d || d.status === "done") continue;
      const dd = taskDueDate(plan, d);
      const n = daysBetween(today, dd);
      if (n < 0) problems.push({ id: d.id, text: `"${d.title}" is ${-n}d overdue`, level: 2 });
      else if (dd > due) problems.push({ id: d.id, text: `"${d.title}" is due ${dd}, after this task's ${due}`, level: 2 });
      else if (n <= 7) problems.push({ id: d.id, text: `"${d.title}" isn't done and is due ${n === 0 ? "today" : `in ${n}d`}`, level: 1 });
    }
    if (!problems.length) continue;
    const worst = Math.max(...problems.map(p => p.level));
    // A blocked task is always worth attention: critical when it is itself due within a week and its blocker is late.
    const severity: Severity = worst === 2 && dT <= 7 ? "critical" : "warning";
    out.push({ id: `blocked:${t.id}`, kind: "blocked_task", severity, title: `${t.title}: blocked`,
      detail: `Waiting on ${problems.map(p => p.text).join("; ")} · this task is ${dT < 0 ? `${-dT}d overdue` : `due ${due} (in ${dT}d)`}`,
      refs: [t.id, ...problems.map(p => p.id)], date: due });
  }

  // Archetype-specific alerts
  const ext = plan.event.ext;
  if (ext.type === "community") {
    for (const p of ext.permits) {
      if (p.status === "approved") continue;
      if (p.status === "rejected") {
        out.push({ id: `permit:${p.id}`, kind: "permit_risk", severity: "critical", title: `${p.authority} ${p.kind} rejected`,
          detail: "Re-apply or change the plan", refs: [p.id] });
        continue;
      }
      const main = plan.subEvents.find(s => s.isMain)?.date ?? plan.event.startDate;
      const until = daysBetween(today, main);
      const applyIn = p.applyBy ? daysBetween(today, p.applyBy) : null;
      if (until <= 30 || (applyIn !== null && applyIn <= 14)) {
        const late = p.status === "not_started" && applyIn !== null && applyIn < 0;
        out.push({ id: `permit:${p.id}`, kind: "permit_risk", severity: late || until <= 7 ? "critical" : "warning",
          title: `${p.authority} ${p.kind}: ${p.status.replace("_", " ")}`,
          detail: `${p.applyBy ? (applyIn! < 0 ? `apply-by passed ${-applyIn!}d ago` : `apply by ${p.applyBy} (${applyIn}d)`) : "no apply-by date"} · event in ${until}d`,
          refs: [p.id], date: p.applyBy ?? undefined });
      }
    }
    const pledged = ext.sponsors.reduce((a, s) => a + (s.status === "declined" ? 0 : s.pledgedPaise), 0);
    const received = ext.sponsors.reduce((a, s) => a + s.receivedPaise, 0);
    if (pledged > received)
      out.push({ id: "sponsor_gap", kind: "sponsor_gap", severity: "info", title: "Sponsor money outstanding",
        detail: `${rupees(pledged - received)} pledged but not yet received`, refs: ext.sponsors.filter(s => s.pledgedPaise > s.receivedPaise).map(s => s.id),
        amountPaise: pledged - received });
  }
  if (ext.type === "birthday") {
    const open = ext.wishlist.filter(w => w.priority === "high" && !w.claimedByGuestId);
    if (open.length)
      out.push({ id: "wishlist", kind: "wishlist_unclaimed", severity: "warning", title: `${open.length} high-priority wish${open.length > 1 ? "es" : ""} unclaimed`,
        detail: open.map(w => w.item).join(", "), refs: open.map(w => w.id) });
  }
  if (ext.type === "wedding") {
    const invitedAny = plan.guests.filter(g => Object.keys(g.rsvp).length > 0);
    const pending = invitedAny.filter(g => Object.values(g.rsvp).some(v => v === "invited" || v === "maybe"));
    if (invitedAny.length && pending.length / invitedAny.length >= 0.25)
      out.push({ id: "rsvp", kind: "rsvp_pending", severity: pending.length / invitedAny.length >= 0.5 ? "warning" : "info",
        title: `${pending.length} of ${invitedAny.length} guests haven't confirmed`,
        detail: ext.rsvpDeadline ? `RSVP deadline ${ext.rsvpDeadline}` : "Chase pending households", refs: pending.map(g => g.id), date: ext.rsvpDeadline ?? undefined });
  }

  out.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.id.localeCompare(b.id));
  const counts = { critical: 0, warning: 0, info: 0 } as Record<Severity, number>;
  for (const i of out) counts[i.severity]++;
  return { today, insights: out, counts, redFlags: counts.critical + counts.warning };
}

/** Compact text for the LLM system prompt. */
export function insightsDigest(pi: PlanInsights, max = 12): string {
  if (!pi.insights.length) return "No red flags.";
  return pi.insights.slice(0, max).map(i => `- [${i.severity}] ${i.title}: ${i.detail}`).join("\n");
}
