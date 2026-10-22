"use client";
import { useId, useRef, useState } from "react";
import { AlertTriangle, Camera, CheckCircle2, ChevronDown, ChevronRight, CircleDollarSign, FileText, Lock, Scissors, Unlock, Wallet } from "lucide-react";
import { SAMPLE_QUOTES } from "@/quote-scanner";
import type { AgentState, BudgetItem } from "@/schema";
import { categoryMaxCuttable } from "@/commands";
import type { Commit, Highlight, ScanInput } from "./PlannerApp";
import { Badge, Card, inr, useHighlight } from "./ui";
import { envelopeA11y } from "@/budget-a11y";

const CAT_LABEL: Record<string, string> = {
  venue: "Venue", catering: "Catering", decor: "Decor", photo_video: "Photo & video", music: "Music", attire: "Attire",
  beauty: "Beauty", stationery: "Stationery", gifts: "Gifts", logistics: "Logistics", permits: "Permits", entertainment: "Entertainment", misc: "Misc",
};

function EnvelopeBar({ b }: { b: BudgetItem }) {
  const scale = Math.max(b.plannedPaise, b.quotedPaise ?? 0, b.committedPaise, 1);
  const c = (Math.min(b.committedPaise, b.plannedPaise) / scale) * 100;
  const s = (Math.max(0, b.plannedPaise - b.committedPaise) / scale) * 100;
  const over = b.committedPaise > b.plannedPaise ? ((b.committedPaise - b.plannedPaise) / scale) * 100 : 0;
  const q = b.quotedPaise !== null ? (b.quotedPaise / scale) * 100 : null;
  // The segments are decorative; the whole bar carries one description (a meter of committed spend against the
  // planned envelope, or a labelled image when nothing is planned). The same numbers are printed under the bar.
  const a = envelopeA11y(b);
  const sem = a.role === "meter"
    ? { role: "meter", "aria-label": a.label, "aria-valuenow": a.valueNow, "aria-valuemin": a.valueMin, "aria-valuemax": a.valueMax, "aria-valuetext": a.valueText }
    : { role: "img", "aria-label": a.label };
  return (
    <div {...sem} data-testid={`envelope-${b.id}`} className="relative h-2.5 w-full overflow-hidden rounded-full bg-slate-100 ring-1 ring-inset ring-slate-300" title="dark = committed floor · green = cuttable slack · red = over plan · marker = quote">
      <div aria-hidden="true" className="absolute inset-y-0 left-0 bg-slate-700" style={{ width: `${c}%` }} />
      <div aria-hidden="true" className={`absolute inset-y-0 ${b.locked ? "bg-slate-400" : "bg-emerald-500"}`} style={{ left: `${c}%`, width: `${s}%` }} />
      {over > 0 && <div aria-hidden="true" className="absolute inset-y-0 bg-rose-600" style={{ left: `${c + s}%`, width: `${over}%` }} />}
      {q !== null && <div aria-hidden="true" className={`absolute inset-y-[-2px] w-0.5 ${b.quotedPaise! > b.plannedPaise ? "bg-amber-600" : "bg-sky-600"}`} style={{ left: `calc(${Math.min(q, 100)}% - 1px)` }} />}
    </div>
  );
}

function ScanZone({ plan, onScan, busy }: { plan: AgentState; onScan: (i: ScanInput) => void; busy: boolean }) {
  const [drag, setDrag] = useState(false);
  const mine = SAMPLE_QUOTES.find(q => q.archetype === plan.event.eventType) ?? SAMPLE_QUOTES[0];
  const others = SAMPLE_QUOTES.filter(q => q.id !== mine.id);
  const take = (f: File | undefined) => { if (f) onScan({ file: f }); };
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files[0]); }}
      className={`mb-3 flex flex-wrap items-center gap-2 rounded-xl border-2 border-dashed p-3 transition ${drag ? "border-violet-500 bg-violet-50" : "border-slate-300 bg-slate-50/60"}`}>
      {/* A real button opens the file picker, so the action is reachable by keyboard (a <label> around a hidden input is not). */}
      <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
        className="flex min-h-9 items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50">
        <Camera size={14} /> Scan Vendor Quote / Invoice
      </button>
      <input ref={fileRef} type="file" accept="image/*,application/pdf,text/plain" className="hidden" tabIndex={-1} aria-hidden="true" data-testid="ledger-upload"
        onChange={e => { take(e.target.files?.[0]); e.target.value = ""; }} />
      <button type="button" disabled={busy} onClick={() => onScan({ sampleId: mine.id })}
        className="flex min-h-9 items-center gap-1.5 rounded-lg bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800 disabled:opacity-50">
        <FileText size={14} /> Scan Sample Vendor Quote
      </button>
      <p className="text-[11px] text-slate-600">or drop an image / PDF here · other samples:{" "}
        {others.map((q, i) => (
          <span key={q.id}>
            <button type="button" disabled={busy} onClick={() => onScan({ sampleId: q.id })} className="min-h-6 text-violet-800 underline underline-offset-2 hover:text-violet-900">{q.title.split(" — ")[0]}</button>
            {i < others.length - 1 ? ", " : ""}
          </span>
        ))}
      </p>
    </div>
  );
}

export default function BudgetCard({ plan, today, commit, highlight, onScan, busy }: { plan: AgentState; today: string; commit: Commit; highlight: Highlight; onScan: (i: ScanInput) => void; busy: boolean }) {
  const hl = useHighlight(highlight);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const cats = [...new Set(plan.budgetItems.map(b => b.category))];
  const cuttable = categoryMaxCuttable(plan);
  const se = (id: string | null) => plan.subEvents.find(s => s.id === id)?.name;
  const uid = useId();

  return (
    <Card title="Smart Budget Ledger" icon={<Wallet size={16} className="text-emerald-600" />}
      right={<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600" aria-label="Bar legend" role="note">
        <span className="flex items-center gap-1"><i aria-hidden="true" className="h-2 w-3 rounded-sm bg-slate-700" />Committed</span>
        <span className="flex items-center gap-1"><i aria-hidden="true" className="h-2 w-3 rounded-sm bg-emerald-500" />Cuttable slack</span>
        <span className="flex items-center gap-1"><i aria-hidden="true" className="h-2 w-3 rounded-sm bg-rose-600" />Over plan</span>
        <span className="flex items-center gap-1"><i aria-hidden="true" className="h-2.5 w-0.5 bg-amber-600" />Quote</span>
      </div>}>
      <ScanZone plan={plan} onScan={onScan} busy={busy} />
      <div className="space-y-3">
        {cats.map(cat => {
          const items = plan.budgetItems.filter(b => b.category === cat);
          const planned = items.reduce((a, b) => a + b.plannedPaise, 0);
          const committed = items.reduce((a, b) => a + b.committedPaise, 0);
          const isOpen = open[cat] ?? (items.length > 1 || cat === "decor");
          const listId = `${uid}-${cat}`;
          return (
            <div key={cat} className="rounded-xl border border-slate-200">
              <h3>
                <button type="button" onClick={() => setOpen(o => ({ ...o, [cat]: !isOpen }))} aria-expanded={isOpen} aria-controls={isOpen ? listId : undefined}
                  className="flex min-h-10 w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left hover:bg-slate-50">
                  {isOpen ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
                  <span className="text-sm font-semibold">{CAT_LABEL[cat] ?? cat}</span>
                  <span className="text-xs text-slate-600">{items.length} item{items.length > 1 ? "s" : ""}</span>
                  <span className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs tabular-nums">
                    <span className="text-slate-600">committed {inr(committed)}</span>
                    <span className="font-semibold"><span className="sr-only">planned </span>{inr(planned)}</span>
                    <Badge tone={(cuttable[cat] ?? 0) > 0 ? "emerald" : "slate"} title="Unlocked slack the AI can cut"><Scissors size={11} /><span className="sr-only">cuttable </span>{inr(cuttable[cat] ?? 0)}</Badge>
                  </span>
                </button>
              </h3>
              {isOpen && (
                <ul id={listId} className="divide-y divide-slate-100 border-t border-slate-100">
                  {items.map(b => {
                    const overdue = b.payments.filter(p => !p.paidDate && p.dueDate < today);
                    const unpaid = b.payments.filter(p => !p.paidDate);
                    return (
                      <li key={b.id} className={`px-3 py-2.5 ${hl(b.id)}`}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-slate-800">{b.label}</span>
                          {se(b.subEventId) && <Badge tone="sky">{se(b.subEventId)}</Badge>}
                          {overdue.length > 0 && <Badge tone="rose"><AlertTriangle size={11} /> Deposit overdue</Badge>}
                          {b.quotedPaise !== null && b.quotedPaise > b.plannedPaise && <Badge tone="amber">Quote {inr(b.quotedPaise)} &gt; envelope</Badge>}
                          {b.quoteRedFlags.length > 0 && <Badge tone="rose" title={b.quoteRedFlags.join("\n")}><AlertTriangle size={11} /> {b.quoteRedFlags.length} contract flag{b.quoteRedFlags.length > 1 ? "s" : ""}</Badge>}
                          <button type="button" aria-pressed={b.locked}
                            onClick={() => commit({ summary: `${b.locked ? "Unlock" : "Lock"} ${b.label}`, commands: [{ op: "set_item_lock", budgetItemId: b.id, locked: !b.locked }] })}
                            className={`ml-auto flex min-h-7 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ${b.locked ? "bg-slate-800 text-white ring-slate-800" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"}`}
                            title={b.locked ? "Pinned: the AI can't cut this. Click to unlock." : "Pin this so cuts skip it"}>
                            {b.locked ? <><Lock size={12} /> Locked</> : <><Unlock size={12} /> Lock</>}<span className="sr-only"> {b.label}</span>
                          </button>
                        </div>
                        <div className="mt-1.5 flex items-center gap-3">
                          <div className="min-w-0 flex-1"><EnvelopeBar b={b} /></div>
                          <span className="shrink-0 text-right text-sm font-semibold tabular-nums sm:w-24"><span className="sr-only">planned </span>{inr(b.plannedPaise)}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600 tabular-nums">
                          <span>committed {inr(b.committedPaise)}</span>
                          <span className={b.locked ? "text-slate-600" : "text-emerald-800"}>slack {inr(Math.max(0, b.plannedPaise - b.committedPaise))}{b.locked ? " (locked)" : ""}</span>
                          {b.committedPaise > b.plannedPaise && <span className="font-medium text-rose-700">over plan by {inr(b.committedPaise - b.plannedPaise)}</span>}
                          {unpaid.map(p => (
                            <span key={p.id} className={`inline-flex flex-wrap items-center gap-1 ${p.dueDate < today ? "font-medium text-rose-700" : ""} ${hl(p.id)}`}>
                              {p.dueDate < today ? <AlertTriangle size={11} /> : <CircleDollarSign size={11} />}
                              {p.kind} {inr(p.amountPaise)} {p.dueDate < today ? "overdue since" : "due"} {p.dueDate}
                              <button type="button" onClick={() => commit({ summary: `Record ${p.kind} for ${b.label}`, commands: [{ op: "record_payment", budgetItemId: b.id, paymentId: p.id, paidDate: today }] })}
                                className="min-h-6 rounded bg-emerald-50 px-1.5 text-emerald-800 ring-1 ring-emerald-300 hover:bg-emerald-100">mark paid<span className="sr-only">: {p.kind} {inr(p.amountPaise)} for {b.label}</span></button>
                            </span>
                          ))}
                          {b.payments.filter(p => p.paidDate).map(p => (
                            <span key={p.id} className={`inline-flex items-center gap-0.5 text-emerald-800 ${hl(p.id)}`}><CheckCircle2 size={11} /> {p.kind} {inr(p.amountPaise)} paid</span>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
