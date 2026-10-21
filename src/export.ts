// One-click client-side exports. Pure string builders, so they're unit-testable and work offline.
import type { AgentState } from "./schema";
import { addDays, taskDueDate } from "./commands";
import { formatMinute } from "./diff";

const rs = (paise: number | null) => (paise === null ? "" : (paise / 100).toFixed(2));
const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export const BUDGET_CSV_HEADER = ["ID", "Category", "Item", "SubEvent", "PlannedINR", "QuotedINR", "CommittedINR", "PaidINR", "CuttableSlackINR", "Locked", "Vendor"];

/** Budget ledger as CSV (RFC 4180 quoting, CRLF rows, rupees with 2 decimals, a TOTAL row). */
export function budgetLedgerCsv(plan: AgentState): string {
  const rows: string[][] = [BUDGET_CSV_HEADER];
  let tp = 0, tq = 0, tc = 0, tpaid = 0, ts = 0;
  const items = [...plan.budgetItems].sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
  for (const b of items) {
    const paid = b.payments.reduce((a, p) => a + (p.paidDate ? p.amountPaise : 0), 0);
    const slack = b.locked ? 0 : Math.max(0, b.plannedPaise - b.committedPaise); // what adjust_budget could actually cut
    tp += b.plannedPaise; tq += b.quotedPaise ?? 0; tc += b.committedPaise; tpaid += paid; ts += slack;
    rows.push([b.id, b.category, b.label, plan.subEvents.find(s => s.id === b.subEventId)?.name ?? "", rs(b.plannedPaise), rs(b.quotedPaise),
      rs(b.committedPaise), rs(paid), rs(slack), b.locked ? "Yes" : "No", plan.vendors.find(v => v.id === b.vendorId)?.name ?? ""]);
  }
  rows.push(["TOTAL", "", "", "", rs(tp), rs(tq), rs(tc), rs(tpaid), rs(ts), "", ""]);
  return rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const longDate = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** A self-contained, print-styled day-of run sheet (open in a new tab → Print / Save as PDF). */
export function runSheetHtml(plan: AgentState, today: string): string {
  const subs = [...plan.subEvents].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
  const urgent = plan.tasks.filter(t => t.status !== "done").map(t => ({ t, due: taskDueDate(plan, t) }))
    .filter(x => x.due <= addDays(today, 14)).sort((a, b) => a.due.localeCompare(b.due));
  const sections = subs.map(s => {
    const blocks = plan.timeline.filter(b => b.subEventId === s.id).sort((a, b) => a.startMin - b.startMin || a.lane.localeCompare(b.lane));
    const rows = blocks.map(b => `<tr><td class="t">${formatMinute(b.startMin)}</td><td class="t">${formatMinute(b.endMin)}</td><td>${esc(b.label)}${b.anchored ? ' <span class="anchor">⚓ ANCHORED</span>' : ""}</td><td>${esc(b.lane)}</td><td>${esc(plan.vendors.find(v => v.id === b.vendorId)?.name ?? "")}</td></tr>`).join("");
    return `<section><h2>${esc(s.name)} <span class="phase ${s.phase}">${s.phase}${s.isMain ? " · main" : ""}</span></h2>
<p class="meta">${longDate(s.date)} · ${formatMinute(s.startMin)} – ${formatMinute(s.endMin)}${s.venue ? ` · ${esc(s.venue)}` : ""}${s.dressCode ? ` · Dress: ${esc(s.dressCode)}` : ""}</p>
${blocks.length ? `<table><thead><tr><th>Start</th><th>End</th><th>Block</th><th>Lane</th><th>Vendor</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="meta">No blocks scheduled.</p>'}</section>`;
  }).join("\n");
  const tasks = urgent.length
    ? `<ul>${urgent.map(({ t, due }) => `<li><b>${due}</b> — ${esc(t.title)} <span class="meta">(${t.priority}${due < today ? ", OVERDUE" : ""})</span></li>`).join("")}</ul>`
    : "<p class=\"meta\">Nothing due in the next 14 days.</p>";
  return `<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><title>Run sheet · ${esc(plan.event.title)}</title>
<style>
body{font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a;margin:32px;max-width:900px}
h1{font-size:22px;margin:0}h2{font-size:16px;margin:24px 0 2px;border-bottom:2px solid #0f172a;padding-bottom:2px}
.meta{color:#475569;margin:2px 0 8px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #cbd5e1;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#f1f5f9;font-size:11px;text-transform:uppercase;letter-spacing:.04em}.t{white-space:nowrap;font-variant-numeric:tabular-nums;width:72px}
.anchor{font-size:10px;font-weight:700;color:#92400e;background:#fef3c7;border:1px solid #f59e0b;border-radius:4px;padding:0 4px}
.phase{font-size:10px;font-weight:600;text-transform:uppercase;color:#fff;background:#64748b;border-radius:4px;padding:1px 5px;vertical-align:middle}
.phase.main{background:#7c3aed}.phase.pre{background:#0284c7}.phase.post{background:#d97706}
.bar{display:flex;justify-content:space-between;align-items:center}button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #0f172a;background:#0f172a;color:#fff;cursor:pointer}
section{page-break-inside:avoid}@media print{button{display:none}body{margin:12mm}}
</style></head><body>
<div class="bar"><div><h1>${esc(plan.event.title)}</h1><p class="meta">Day-of run sheet · ${esc(plan.event.city)} · ${plan.event.startDate} → ${plan.event.endDate} · printed ${today}</p></div><button onclick="window.print()">Print / Save PDF</button></div>
${sections}
<h2>Urgent tasks (due by ${addDays(today, 14)})</h2>${tasks}
</body></html>`;
}

/** Spec names. */
export const budgetToCsv = budgetLedgerCsv;
export const runSheetToHtml = runSheetHtml;
