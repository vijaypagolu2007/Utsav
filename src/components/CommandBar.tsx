"use client";
import { useState } from "react";
import { AlertTriangle, CalendarDays, Link2, ChevronDown, FileSpreadsheet, History, PartyPopper, Printer, Redo2, RotateCcw, Ticket, Undo2, Users, Wrench } from "lucide-react";
import type { AgentState } from "@/schema";
import type { PlanInsights } from "@/insights";
import type { Role } from "@/commands";
import type { EventType } from "@/persistence";
import { daysBetween, plannedTotal } from "@/commands";
import { PRESETS } from "@/presets";
import { Badge, inr, severityTone } from "./ui";

type Props = {
  plan: AgentState; today: string; setToday: (d: string) => void; insights: PlanInsights;
  activeType: EventType; storedTitles: Record<string, string | null>; onSwitch: (t: EventType) => void; onReset: () => void;
  role: Role; setRole: (r: Role) => void;
  history: string[]; historyIdx: number; goTo: (i: number) => void; flash: (ids: string[]) => void;
  onExportCsv: () => void; onExportRunSheet: () => void; onShare: () => void; shared: boolean;
};

function Kpi({ label, value, sub, tone = "text-slate-900" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200" data-testid={`kpi-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`truncate text-sm font-semibold tabular-nums ${tone}`}>{value}</div>
      {sub && <div className="truncate text-[10px] text-slate-500">{sub}</div>}
    </div>
  );
}

export default function CommandBar({ plan, today, setToday, insights, activeType, storedTitles, onSwitch, onReset, role, setRole,
  history, historyIdx, goTo, flash, onExportCsv, onExportRunSheet, onShare, shared }: Props) {
  const [flagsOpen, setFlagsOpen] = useState(false);
  const guest = role === "guest";
  const total = plan.event.totalBudgetPaise;
  const planned = plannedTotal(plan);
  const committed = plan.budgetItems.reduce((a, b) => a + b.committedPaise, 0);
  const paid = plan.budgetItems.reduce((a, b) => a + b.payments.reduce((x, p) => x + (p.paidDate ? p.amountPaise : 0), 0), 0);
  const main = plan.subEvents.find(s => s.isMain);
  const dte = main ? daysBetween(today, main.date) : null;
  const rsvpTarget = main?.id;
  const invited = plan.guests.filter(g => rsvpTarget && g.rsvp[rsvpTarget]);
  const yes = invited.filter(g => g.rsvp[rsvpTarget!] === "yes").length;
  const pending = invited.filter(g => ["invited", "maybe"].includes(g.rsvp[rsvpTarget!] ?? "")).length;

  return (
    <div className="border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-amber-400 via-rose-500 to-violet-600 text-white shadow"><PartyPopper size={18} /></div>
          <div className="leading-tight">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Utsav Co-Pilot</div>
            <div className="max-w-[22rem] truncate text-sm font-semibold">{plan.event.title}</div>
          </div>
        </div>
        <label className="relative">
          <span className="sr-only">Event</span>
          <select value={activeType} onChange={e => onSwitch(e.target.value as EventType)}
            className="appearance-none rounded-lg border border-slate-300 bg-white py-1.5 pl-3 pr-8 text-sm font-medium shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-400">
            {PRESETS.map((p, i) => {
              const t = storedTitles[p.key];
              return <option key={p.key} value={p.key}>{i + 1}. {p.label}{t && t !== p.plan.event.title ? ` (now: ${t})` : ""}</option>;
            })}
          </select>
          <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-2.5 text-slate-500" />
        </label>
        {!guest && <button onClick={onReset} title="Restore the clean preset for this event type (clears its history)"
          className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-50"><RotateCcw size={13} /> ↺ Reset</button>}
        <Badge tone={plan.event.eventType === "wedding" ? "rose" : plan.event.eventType === "birthday" ? "violet" : "sky"}>{plan.event.eventType} · {plan.event.city}</Badge>

        <div className="ml-auto flex items-center gap-2">
          <div role="radiogroup" aria-label="Mode" className="flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
            <button role="radio" aria-checked={!guest} onClick={() => setRole("organizer")}
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 ${!guest ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}><Wrench size={13} /> 🛠️ Organizer</button>
            <button role="radio" aria-checked={guest} onClick={() => setRole("guest")}
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 ${guest ? "bg-white text-violet-700 shadow-sm" : "text-slate-500"}`}><Ticket size={13} /> 🎟️ Guest View</button>
          </div>
          {!guest && (<>
            <button onClick={onExportCsv} title="Budget ledger as CSV"
              className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"><FileSpreadsheet size={13} className="text-emerald-600" /> ⬇ Export CSV</button>
            <button onClick={onExportRunSheet} title="Print-ready day-of run sheet (Save as PDF from the print dialog)"
              className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"><Printer size={13} className="text-violet-600" /> 🖨️ Print Run-Sheet</button>
            <button onClick={onShare} title="Shareable guest links (needs shared storage)" data-testid="open-guest-links"
              className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"><Link2 size={13} className="text-sky-600" /> {shared ? "Guest links ●" : "Guest links"}</button>
          </>)}
          <label className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600" title="Planning date: move it to time-travel the red flags">
            <CalendarDays size={14} />
            <input type="date" value={today} onChange={e => e.target.value && setToday(e.target.value)} className="bg-transparent tabular-nums focus:outline-none" />
          </label>
          {!guest && <div className="relative">
            <button onClick={() => setFlagsOpen(o => !o)}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold ring-1 ${insights.redFlags ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200"}`}>
              <AlertTriangle size={14} /> {insights.redFlags} red flag{insights.redFlags === 1 ? "" : "s"}
            </button>
            {flagsOpen && (
              <div className="absolute right-0 z-40 mt-2 max-h-96 w-96 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
                {insights.insights.length === 0 && <p className="p-3 text-xs text-slate-500">All clear.</p>}
                {insights.insights.map(i => (
                  <button key={i.id} onClick={() => { flash(i.refs); setFlagsOpen(false); }} className="flex w-full items-start gap-2 rounded-lg p-2 text-left hover:bg-slate-50">
                    <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                    <span className="min-w-0"><span className="block text-xs font-medium text-slate-800">{i.title}</span><span className="block text-[11px] text-slate-500">{i.detail}</span></span>
                  </button>
                ))}
              </div>
            )}
          </div>}
        </div>
      </div>

      {guest ? (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Kpi label="Days to event" value={dte === null ? "—" : dte >= 0 ? `${dte} days` : `${-dte}d ago`} sub={main ? `${main.name} · ${main.date}` : undefined} />
          <Kpi label="Events" value={`${plan.subEvents.length} on the itinerary`} sub={`${plan.event.city}`} />
          <Kpi label="RSVP" value={invited.length ? `${yes} attending` : "open"} sub={invited.length ? `${pending} still to reply` : undefined} />
        </div>
      ) : (<>
      <div className="mt-3 grid grid-cols-3 gap-2 md:grid-cols-6">
        <Kpi label="Total budget" value={inr(total)} />
        <Kpi label="Planned" value={inr(planned)} sub={planned > total ? `over by ${inr(planned - total)}` : `${inr(total - planned)} headroom`} tone={planned > total ? "text-rose-600" : "text-slate-900"} />
        <Kpi label="Committed" value={inr(committed)} sub={`${Math.round((committed / Math.max(1, total)) * 100)}% of budget`} />
        <Kpi label="Paid" value={inr(paid)} sub={`${inr(committed - paid > 0 ? committed - paid : 0)} still owed`} tone="text-emerald-700" />
        <Kpi label="Days to event" value={dte === null ? "—" : dte >= 0 ? `${dte} days` : `${-dte}d ago`} sub={main ? `${main.name} · ${main.date}` : undefined} />
        <Kpi label="RSVP" value={invited.length ? `${yes} / ${invited.length} yes` : `${plan.event.guestCount} expected`} sub={invited.length ? `${pending} pending` : "no guest list yet"} />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button aria-label="Undo" onClick={() => goTo(historyIdx - 1)} disabled={historyIdx === 0}
          className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40"><Undo2 size={14} /></button>
        <button aria-label="Redo" onClick={() => goTo(historyIdx + 1)} disabled={historyIdx >= history.length - 1}
          className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40"><Redo2 size={14} /></button>
        <History size={14} className="text-slate-400" />
        <input type="range" min={0} max={Math.max(0, history.length - 1)} value={historyIdx} onChange={e => goTo(Number(e.target.value))}
          className="h-1.5 w-40 cursor-pointer accent-emerald-600" disabled={history.length < 2} aria-label="History scrubber" />
        <span className="truncate text-xs text-slate-500">
          <span className="font-medium tabular-nums text-slate-700">{historyIdx + 1}/{history.length}</span> · {history[historyIdx]}
        </span>
        <span className="ml-auto hidden items-center gap-1 text-[11px] text-slate-400 lg:flex"><Users size={12} /> {plan.guests.length} guests on list · {plan.subEvents.length} sub-events · autosaved</span>
      </div>
      </>)}
    </div>
  );
}
