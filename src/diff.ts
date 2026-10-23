// Before → After diff between two plans. Drives the HITL approval card and the canvas highlight pulse.
import type { EventPlan } from "./schema";
import { rupees, taskDueDate } from "./commands";

export type DiffRow = {
  kind: "budget" | "budget_new" | "quote" | "vendor" | "diet" | "signup" | "sub_event" | "task_due" | "task_status" | "block" | "payment" | "rsvp" | "lock" | "wishlist" | "permit" | "sponsor" | "event"
    | "budget_removed" | "task_new" | "idea" | "basics" | "priorities" | "vendor_stage" | "checklist" | "task_dep";
  id: string;
  label: string;
  before: string;
  after: string;
  /** Signed change in paise for money rows. */
  deltaPaise?: number;
  /** Secondary note, e.g. "cascaded from Haldi". */
  note?: string;
};

export type PlanDiff = { rows: DiffRow[]; changedIds: string[]; cascadedTasks: number };

const hhmm = (m: number) => {
  const h = Math.floor(m / 60) % 24, mm = m % 60, ap = h < 12 ? "AM" : "PM";
  return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${ap}`;
};
export const formatMinute = hhmm;

export function computePlanDiff(before: EventPlan, after: EventPlan): PlanDiff {
  const rows: DiffRow[] = [];
  if (before.event.id !== after.event.id) {
    rows.push({ kind: "event", id: after.event.id, label: "Event", before: before.event.title, after: after.event.title });
    return { rows, changedIds: [], cascadedTasks: 0 };
  }
  const eb0 = before.event, ea0 = after.event;
  if (ea0.totalBudgetPaise !== eb0.totalBudgetPaise)
    rows.push({ kind: "basics", id: "event-total", label: "Total budget", before: rupees(eb0.totalBudgetPaise), after: rupees(ea0.totalBudgetPaise), deltaPaise: ea0.totalBudgetPaise - eb0.totalBudgetPaise });
  if (ea0.guestCount !== eb0.guestCount) rows.push({ kind: "basics", id: "event-guests", label: "Guest count", before: String(eb0.guestCount), after: String(ea0.guestCount) });
  if (ea0.city !== eb0.city) rows.push({ kind: "basics", id: "event-city", label: "City", before: eb0.city || "—", after: ea0.city || "—" });
  if (ea0.startDate !== eb0.startDate || ea0.endDate !== eb0.endDate)
    rows.push({ kind: "basics", id: "event-window", label: "Event window", before: `${eb0.startDate} to ${eb0.endDate}`, after: `${ea0.startDate} to ${ea0.endDate}` });
  for (const b of before.budgetItems) if (!after.budgetItems.some(x => x.id === b.id))
    rows.push({ kind: "budget_removed", id: b.id, label: `${b.label} (removed)`, before: `planned ${rupees(b.plannedPaise)}`, after: "—", deltaPaise: -b.plannedPaise });
  for (const t of after.tasks) if (!before.tasks.some(x => x.id === t.id))
    rows.push({ kind: "task_new", id: t.id, label: `${t.title} (new task)`, before: "—", after: `due ${taskDueDate(after, t)}` });
  const ideasAdded = after.ideas.filter(i => !before.ideas.some(x => x.id === i.id));
  if (ideasAdded.length) rows.push({ kind: "idea", id: ideasAdded[0]!.id, label: "Ideas board", before: `${before.ideas.length} idea${before.ideas.length === 1 ? "" : "s"}`, after: `+${ideasAdded.length} new` });
  for (const i of after.ideas) {
    const o = before.ideas.find(x => x.id === i.id);
    if (!o) continue;
    // Adopting an idea (even one already saved) reads as "added to plan", not as a bare status change.
    const adoptedNow = !!(i.adoptedTaskId || i.adoptedBudgetItemId) && !(o.adoptedTaskId || o.adoptedBudgetItemId);
    if (adoptedNow || o.status !== i.status) rows.push({ kind: "idea", id: i.id, label: `Idea: ${i.title}`, before: o.status, after: adoptedNow ? "added to plan" : i.status });
  }
  for (const v of after.vendors) if (!before.vendors.some(x => x.id === v.id))
    rows.push({ kind: "vendor", id: v.id, label: `Vendor ${v.name}`, before: "—", after: `added · ${v.category}` });
  // v6: vendors removed or moved along the pipeline, checklist slots, priorities and task dependencies.
  for (const v of before.vendors) if (!after.vendors.some(x => x.id === v.id))
    rows.push({ kind: "vendor", id: v.id, label: `Vendor ${v.name} (removed)`, before: v.stage, after: "—" });
  for (const v of after.vendors) {
    const o = before.vendors.find(x => x.id === v.id);
    if (o && o.stage !== v.stage) rows.push({ kind: "vendor_stage", id: v.id, label: `${v.name} stage`, before: o.stage, after: v.stage });
  }
  const offB = new Set(before.vendorChecklist.notNeeded), offA = new Set(after.vendorChecklist.notNeeded);
  for (const k of new Set([...offB, ...offA])) if (offB.has(k) !== offA.has(k))
    rows.push({ kind: "checklist", id: `need-${k}`, label: `Vendor checklist: ${k.replace(/_/g, " ")}`, before: offB.has(k) ? "not needed" : "needed", after: offA.has(k) ? "not needed" : "needed" });
  const pb = before.priorities, pa = after.priorities;
  const ptxt = (p: typeof pa) => `protect ${p.protect.join(", ") || "none"} · cut first ${p.cutFirst.join(", ") || "none"} · ${p.level}`;
  if (ptxt(pb) !== ptxt(pa)) rows.push({ kind: "priorities", id: "priorities", label: "Priorities", before: ptxt(pb), after: ptxt(pa) });
  for (const t of after.tasks) {
    const o = before.tasks.find(x => x.id === t.id);
    if (o && o.dependsOn.join() !== t.dependsOn.join()) {
      const nm = (ids: string[]) => ids.map(id => after.tasks.find(x => x.id === id)?.title ?? id).join(", ") || "nothing";
      rows.push({ kind: "task_dep", id: t.id, label: `${t.title} waits for`, before: nm(o.dependsOn), after: nm(t.dependsOn) });
    }
  }
  for (const a of after.budgetItems) {
    const b = before.budgetItems.find(x => x.id === a.id);
    if (!b) {
      rows.push({ kind: "budget_new", id: a.id, label: `${a.label} (new line)`, before: "—", after: `planned ${rupees(a.plannedPaise)}`,
        note: a.quotedPaise !== null && a.quotedPaise > a.plannedPaise ? `⚠ quote ${rupees(a.quotedPaise)} exceeds planned by ${rupees(a.quotedPaise - a.plannedPaise)}` : undefined });
      if (a.quotedPaise !== null) rows.push({ kind: "quote", id: a.id, label: `${a.label} quote`, before: "No quote", after: rupees(a.quotedPaise) });
      for (const p of a.payments) rows.push({ kind: "payment", id: p.id, label: `${a.label} ${p.kind}`, before: "—", after: `${rupees(p.amountPaise)} due ${p.dueDate}` });
      continue;
    }
    if (a.quotedPaise !== b.quotedPaise)
      rows.push({ kind: "quote", id: a.id, label: `${a.label} quote`, before: b.quotedPaise === null ? "No quote" : rupees(b.quotedPaise), after: a.quotedPaise === null ? "No quote" : rupees(a.quotedPaise),
        note: a.quotedPaise !== null && a.quotedPaise > a.plannedPaise ? `⚠ exceeds planned ${rupees(a.plannedPaise)} by ${rupees(a.quotedPaise - a.plannedPaise)}` : `within planned ${rupees(a.plannedPaise)}` });
    if (a.plannedPaise !== b.plannedPaise)
      rows.push({ kind: "budget", id: a.id, label: a.label, before: rupees(b.plannedPaise), after: rupees(a.plannedPaise), deltaPaise: a.plannedPaise - b.plannedPaise });
    if (a.locked !== b.locked)
      rows.push({ kind: "lock", id: a.id, label: a.label, before: b.locked ? "Locked" : "Unlocked", after: a.locked ? "Locked" : "Unlocked" });
    for (const p of a.payments) {
      const q = b.payments.find(x => x.id === p.id);
      if (!q) { rows.push({ kind: "payment", id: p.id, label: `${a.label} ${p.kind}`, before: "—", after: `${rupees(p.amountPaise)} due ${p.dueDate}` }); continue; }
      if (q.amountPaise !== p.amountPaise || q.dueDate !== p.dueDate)
        rows.push({ kind: "payment", id: p.id, label: `${a.label} ${p.kind}`, before: `${rupees(q.amountPaise)} due ${q.dueDate}`, after: `${rupees(p.amountPaise)} due ${p.dueDate}` });
      if (q.paidDate !== p.paidDate)
        rows.push({ kind: "payment", id: p.id, label: `${a.label} ${p.kind} (${rupees(p.amountPaise)})`, before: q.paidDate ? `Paid ${q.paidDate}` : `Due ${q.dueDate}`, after: p.paidDate ? `Paid ${p.paidDate}` : `Due ${p.dueDate}` });
    }
  }
  for (const a of after.subEvents) {
    const b = before.subEvents.find(x => x.id === a.id);
    if (!b) continue;
    if (a.date !== b.date || a.startMin !== b.startMin)
      rows.push({ kind: "sub_event", id: a.id, label: `${a.name} date`, before: `${b.date} ${hhmm(b.startMin)}`, after: `${a.date} ${hhmm(a.startMin)}` });
    if (a.visibility !== b.visibility)
      rows.push({ kind: "sub_event", id: a.id, label: `${a.name} on guest link`, before: b.visibility, after: a.visibility });
  }
  let cascadedTasks = 0;
  for (const a of after.tasks) {
    const b = before.tasks.find(x => x.id === a.id);
    if (!b) continue;
    const db = taskDueDate(before, b), da = taskDueDate(after, a);
    if (db !== da) {
      cascadedTasks++;
      const se = after.subEvents.find(s => s.id === a.subEventId);
      rows.push({ kind: "task_due", id: a.id, label: `${a.title} due`, before: db, after: da, note: se ? `cascaded (${Math.abs(a.dueOffsetDays)}d before ${se.name})` : "cascaded" });
    }
    if (a.status !== b.status) rows.push({ kind: "task_status", id: a.id, label: a.title, before: b.status, after: a.status });
  }
  for (const a of after.timeline) {
    const b = before.timeline.find(x => x.id === a.id);
    if (b && (a.startMin !== b.startMin || a.endMin !== b.endMin))
      rows.push({ kind: "block", id: a.id, label: a.label, before: `${hhmm(b.startMin)}–${hhmm(b.endMin)}`, after: `${hhmm(a.startMin)}–${hhmm(a.endMin)}` });
  }
  for (const g of after.guests) {
    const b = before.guests.find(x => x.id === g.id);
    if (!b) continue;
    if (b.diet.join(",") !== g.diet.join(","))
      rows.push({ kind: "diet", id: g.id, label: `${g.name} diet`, before: b.diet.join(", ") || "none", after: g.diet.join(", ") || "none" });
    for (const [sid, v] of Object.entries(g.rsvp)) if (b.rsvp[sid] !== v) {
      const se = after.subEvents.find(s => s.id === sid);
      rows.push({ kind: "rsvp", id: g.id, label: `${g.name} · ${se?.name ?? sid}`, before: b.rsvp[sid] ?? "—", after: v });
    }
  }
  const ea = after.event.ext, eb = before.event.ext;
  if (ea.type === "birthday" && eb.type === "birthday") for (const w of ea.wishlist) {
    const o = eb.wishlist.find(x => x.id === w.id);
    if (o && o.claimedByGuestId !== w.claimedByGuestId) {
      const nm = (id: string | null) => (id ? after.guests.find(g => g.id === id)?.name ?? id : "Unclaimed");
      rows.push({ kind: "wishlist", id: w.id, label: w.item, before: nm(o.claimedByGuestId), after: nm(w.claimedByGuestId) });
    }
  }
  if (ea.type === "community" && eb.type === "community") {
    for (const p of ea.permits) {
      const o = eb.permits.find(x => x.id === p.id);
      if (o && (o.status !== p.status || o.referenceNo !== p.referenceNo))
        rows.push({ kind: "permit", id: p.id, label: `${p.authority} ${p.kind}`, before: o.status, after: `${p.status}${p.referenceNo ? ` · ${p.referenceNo}` : ""}` });
    }
    for (const v of ea.volunteerSignups) if (!eb.volunteerSignups.some(x => x.id === v.id))
      rows.push({ kind: "signup", id: v.id, label: `Volunteer ${v.name}`, before: "—", after: [after.subEvents.find(x => x.id === v.subEventId)?.name, v.shift].filter(Boolean).join(" · ") || "signed up" });
    for (const s of ea.sponsors) if (!eb.sponsors.some(x => x.id === s.id))
      rows.push({ kind: "signup", id: s.id, label: `Sponsor ${s.name}`, before: "—", after: `${s.tier} · prospect` });
    for (const s of ea.sponsors) {
      const o = eb.sponsors.find(x => x.id === s.id);
      if (o && (o.status !== s.status || o.receivedPaise !== s.receivedPaise))
        rows.push({ kind: "sponsor", id: s.id, label: s.name, before: `${o.status} · ${rupees(o.receivedPaise)}`, after: `${s.status} · ${rupees(s.receivedPaise)}`, deltaPaise: s.receivedPaise - o.receivedPaise });
    }
  }
  return { rows, changedIds: [...new Set(rows.map(r => r.id))], cascadedTasks };
}
