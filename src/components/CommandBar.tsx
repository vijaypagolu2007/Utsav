"use client";
import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, CheckCircle2, Link2, ChevronDown, FileSpreadsheet, History, PartyPopper, Printer, Redo2, RotateCcw, Ticket, Undo2, Users, Wrench } from "lucide-react";
import type { AgentState } from "@/schema";
import type { PlanInsights } from "@/insights";
import type { Role } from "@/commands";
import { TEMPLATES, templateLabel, type EventTemplate, type TemplateId } from "@/config/event-templates";
import { kpisFor, kpiTestId, type KpiDefinition } from "@/config/kpis";
import { kpiContext, kpiValue, type KpiContext, type KpiValue } from "@/kpis";
import { Badge, severityTone } from "./ui";

type Props = {
  plan: AgentState; today: string; setToday: (d: string) => void; insights: PlanInsights;
  activeTemplate: TemplateId; template: EventTemplate; storedTitles: Record<string, string | null>; onSwitch: (t: TemplateId) => void; onReset: () => void;
  role: Role; setRole: (r: Role) => void;
  history: string[]; historyIdx: number; goTo: (i: number) => void; flash: (ids: string[]) => void;
  onExportCsv: () => void; onExportRunSheet: () => void; onShare: () => void; shared: boolean;
};

const TONE_CLASS: Record<NonNullable<KpiValue["tone"]>, string> = { default: "text-slate-900", danger: "text-rose-700", positive: "text-emerald-700" };

/** One summary figure. Rendered as a dt/dd pair inside the KPI <dl>, so the label stays tied to its value. Values wrap instead of being clipped. */
function Kpi({ def, ctx }: { def: KpiDefinition; ctx: KpiContext }) {
  const { value, sub, tone = "default" } = kpiValue(def.id, ctx);
  return (
    <div className="min-w-0 rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200" data-testid={kpiTestId(def.label)} title={def.description}>
      <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-600">{def.label}</dt>
      <dd className={`break-words text-sm font-semibold tabular-nums ${TONE_CLASS[tone]}`}>{value}</dd>
      {sub && <dd className="break-words text-[11px] leading-snug text-slate-600">{sub}</dd>}
    </div>
  );
}

export default function CommandBar({ plan, today, setToday, insights, activeTemplate, template, storedTitles, onSwitch, onReset, role, setRole,
  history, historyIdx, goTo, flash, onExportCsv, onExportRunSheet, onShare, shared }: Props) {
  const [flagsOpen, setFlagsOpen] = useState(false);
  const flagsId = useId();
  const flagsBtn = useRef<HTMLButtonElement>(null);
  const flagsBox = useRef<HTMLDivElement>(null);
  // Disclosure: Escape or a click elsewhere closes the red-flag list; Escape returns focus to its button.
  useEffect(() => {
    if (!flagsOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setFlagsOpen(false); flagsBtn.current?.focus(); } };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!flagsBox.current?.contains(t) && !flagsBtn.current?.contains(t)) setFlagsOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [flagsOpen]);
  const guest = role === "guest";
  const ctx = kpiContext(plan, today);
  const kpis = kpisFor(guest ? "guest" : "organizer", plan.event.eventType);

  return (
    <header className="border-b border-slate-200 bg-white/95 px-3 py-3 backdrop-blur sm:px-4">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="flex min-w-0 max-w-full items-center gap-2">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-amber-400 via-rose-500 to-violet-600 text-white shadow"><PartyPopper size={18} /></div>
          <div className="min-w-0 leading-tight">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600">Utsav Co-Pilot</p>
            <h1 className="break-words text-sm font-semibold sm:max-w-[22rem] sm:truncate" title={plan.event.title}>{plan.event.title}</h1>
          </div>
        </div>
        <label className="relative min-w-0 max-w-full">
          <span className="sr-only">Event</span>
          <select value={activeTemplate} onChange={e => onSwitch(e.target.value as TemplateId)}
            className="min-h-9 w-full max-w-full appearance-none truncate rounded-lg border border-slate-400 bg-white py-1.5 pl-3 pr-8 text-sm font-medium shadow-sm">
            {TEMPLATES.map((t, i) => {
              const now = storedTitles[t.id];
              return <option key={t.id} value={t.id}>{i + 1}. {templateLabel(t)}{now && now !== t.seed.event.title ? ` (now: ${now})` : ""}</option>;
            })}
          </select>
          <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-2.5 text-slate-500" />
        </label>
        {!guest && <button type="button" onClick={onReset} title="Restore the clean preset for this event type (clears its history)"
          className="flex min-h-8 items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50"><RotateCcw size={14} /> Reset</button>}
        <Badge tone={template.accent}>{plan.event.eventType} · {plan.event.city}</Badge>

        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          {/* Two-state view switch: toggle buttons (aria-pressed) so Tab reaches both and Space/Enter selects. */}
          <div role="group" aria-label="View" className="flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
            <button type="button" aria-pressed={!guest} onClick={() => setRole("organizer")}
              className={`flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1 ${!guest ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-300" : "text-slate-700 hover:text-slate-900"}`}><Wrench size={14} /> Organizer</button>
            <button type="button" aria-pressed={guest} onClick={() => setRole("guest")}
              className={`flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1 ${guest ? "bg-white text-violet-800 shadow-sm ring-1 ring-violet-300" : "text-slate-700 hover:text-slate-900"}`}><Ticket size={14} /> Guest View</button>
          </div>
          {!guest && (<>
            <button type="button" onClick={onExportCsv} title="Budget ledger as CSV"
              className="flex min-h-8 items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"><FileSpreadsheet size={14} className="text-emerald-700" /> Export CSV</button>
            <button type="button" onClick={onExportRunSheet} title="Print-ready day-of run sheet (Save as PDF from the print dialog)"
              className="flex min-h-8 items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"><Printer size={14} className="text-violet-700" /> Print Run-Sheet</button>
            <button type="button" onClick={onShare} title="Shareable guest links (needs shared storage)" data-testid="open-guest-links" aria-haspopup="dialog"
              className="flex min-h-8 items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"><Link2 size={14} className="text-sky-700" /> Guest links
              {shared && <span className="rounded-full bg-emerald-50 px-1.5 text-[10px] font-semibold text-emerald-800 ring-1 ring-emerald-200">live</span>}</button>
          </>)}
          <label className="flex min-h-8 items-center gap-1.5 rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700" title="Planning date: move it to time-travel the red flags">
            <CalendarDays size={14} />
            <span className="sr-only">Planning date</span>
            <input type="date" value={today} onChange={e => e.target.value && setToday(e.target.value)} className="bg-transparent tabular-nums" />
          </label>
          {!guest && <div className="relative">
            <button type="button" ref={flagsBtn} onClick={() => setFlagsOpen(o => !o)} aria-expanded={flagsOpen} aria-controls={flagsOpen ? flagsId : undefined}
              className={`flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold ring-1 ${insights.redFlags ? "bg-rose-50 text-rose-700 ring-rose-300" : "bg-emerald-50 text-emerald-800 ring-emerald-300"}`}>
              {insights.redFlags ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />} {insights.redFlags} red flag{insights.redFlags === 1 ? "" : "s"}
            </button>
            {flagsOpen && (
              <div ref={flagsBox} id={flagsId} className="absolute right-0 z-40 mt-2 max-h-[min(24rem,70dvh)] w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
                {insights.insights.length === 0 && <p className="p-3 text-xs text-slate-600">All clear.</p>}
                <ul>
                  {insights.insights.map(i => (
                    <li key={i.id}>
                      <button type="button" onClick={() => { flash(i.refs); setFlagsOpen(false); flagsBtn.current?.focus(); }} className="flex w-full items-start gap-2 rounded-lg p-2 text-left hover:bg-slate-50">
                        <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                        <span className="min-w-0"><span className="block text-xs font-medium text-slate-800">{i.title}</span><span className="block text-[11px] text-slate-600">{i.detail}</span></span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>}
        </div>
      </div>

      <dl className={`mt-3 grid gap-2 ${guest ? "grid-cols-1 min-[400px]:grid-cols-3" : "grid-cols-2 sm:grid-cols-3 xl:grid-cols-6"}`}>
        {kpis.map(k => <Kpi key={k.id} def={k} ctx={ctx} />)}
      </dl>
      {!guest && (<>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" aria-label="Undo" title="Undo" onClick={() => goTo(historyIdx - 1)} disabled={historyIdx === 0}
          className="grid h-8 w-8 place-items-center rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-40"><Undo2 size={14} /></button>
        <button type="button" aria-label="Redo" title="Redo" onClick={() => goTo(historyIdx + 1)} disabled={historyIdx >= history.length - 1}
          className="grid h-8 w-8 place-items-center rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-40"><Redo2 size={14} /></button>
        <History size={14} className="text-slate-500" />
        <input type="range" min={0} max={Math.max(0, history.length - 1)} value={historyIdx} onChange={e => goTo(Number(e.target.value))}
          className="h-6 w-32 cursor-pointer accent-emerald-700 sm:w-40" disabled={history.length < 2} aria-label="History scrubber"
          aria-valuetext={`Step ${historyIdx + 1} of ${history.length}: ${history[historyIdx] ?? ""}`} />
        <span className="min-w-0 flex-1 truncate text-xs text-slate-600" title={history[historyIdx]}>
          <span className="font-medium tabular-nums text-slate-800">{historyIdx + 1}/{history.length}</span> · {history[historyIdx]}
        </span>
        <span className="ml-auto hidden items-center gap-1 text-[11px] text-slate-600 lg:flex"><Users size={12} /> {plan.guests.length} guests on list · {plan.subEvents.length} sub-events · autosaved</span>
      </div>
      </>)}
    </header>
  );
}
