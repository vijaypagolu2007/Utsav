"use client";
import { useState } from "react";
import { AlertTriangle, Camera, CheckCircle2, ChevronDown, ChevronRight, FileText, Lock, Unlock, Wallet } from "lucide-react";
import { SAMPLE_QUOTES } from "@/quote-scanner";
import type { AgentState, BudgetItem } from "@/schema";
import { categoryMaxCuttable } from "@/commands";
import type { Commit, Highlight, ScanInput } from "./PlannerApp";
import { Badge, Card, inr, useHighlight } from "./ui";

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
  return (
    <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-slate-100" title="dark = committed floor · green = cuttable slack · marker = quote">
      <div className="absolute inset-y-0 left-0 bg-slate-700" style={{ width: `${c}%` }} />
      <div className={`absolute inset-y-0 ${b.locked ? "bg-slate-300" : "bg-emerald-400"}`} style={{ left: `${c}%`, width: `${s}%` }} />
      {over > 0 && <div className="absolute inset-y-0 bg-rose-500" style={{ left: `${c + s}%`, width: `${over}%` }} />}
      {q !== null && <div className={`absolute inset-y-[-2px] w-0.5 ${b.quotedPaise! > b.plannedPaise ? "bg-amber-500" : "bg-sky-500"}`} style={{ left: `calc(${Math.min(q, 100)}% - 1px)` }} />}
    </div>
  );
}

function ScanZone({ plan, onScan, busy }: { plan: AgentState; onScan: (i: ScanInput) => void; busy: boolean }) {
  const [drag, setDrag] = useState(false);
  const mine = SAMPLE_QUOTES.find(q => q.archetype === plan.event.eventType) ?? SAMPLE_QUOTES[0];
  const others = SAMPLE_QUOTES.filter(q => q.id !== mine.id);
  const take = (f: File | undefined) => { if (f) onScan({ file: f }); };
  return (
    <div onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files[0]); }}
      className={`mb-3 flex flex-wrap items-center gap-2 rounded-xl border-2 border-dashed p-3 transition ${drag ? "border-violet-400 bg-violet-50" : "border-slate-200 bg-slate-50/60"}`}>
      <label className={`flex cursor-pointer items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 ${busy ? "pointer-events-none opacity-50" : ""}`}>
        <Camera size={14} /> 📸 Scan Vendor Quote / Invoice
        <input type="file" accept="image/*,application/pdf,text/plain" className="hidden" onChange={e => { take(e.target.files?.[0]); e.target.value = ""; }} />
      </label>
      <button disabled={busy} onClick={() => onScan({ sampleId: mine.id })}
        className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50">
        <FileText size={14} /> 📄 Scan Sample Vendor Quote
      </button>
      <span className="text-[11px] text-slate-500">or drop an image / PDF here · other samples:{" "}
        {others.map((q, i) => <button key={q.id} disabled={busy} onClick={() => onScan({ sampleId: q.id })} className="text-violet-700 underline-offset-2 hover:underline">{q.title.split(" — ")[0]}{i < others.length - 1 ? ", " : ""}</button>)}
      </span>
    </div>
  );
}

export default function BudgetCard({ plan, today, commit, highlight, onScan, busy }: { plan: AgentState; today: string; commit: Commit; highlight: Highlight; onScan: (i: ScanInput) => void; busy: boolean }) {
  const hl = useHighlight(highlight);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const cats = [...new Set(plan.budgetItems.map(b => b.category))];
  const cuttable = categoryMaxCuttable(plan);
  const se = (id: string | null) => plan.subEvents.find(s => s.id === id)?.name;

  return (
    <Card title="Smart Budget Ledger" icon={<Wallet size={16} className="text-emerald-600" />}
      right={<div className="flex items-center gap-3 text-[10px] text-slate-500">
        <span className="flex items-center gap-1"><i className="h-2 w-3 rounded-sm bg-slate-700" />Committed</span>
        <span className="flex items-center gap-1"><i className="h-2 w-3 rounded-sm bg-emerald-400" />Cuttable slack</span>
        <span className="flex items-center gap-1"><i className="h-2.5 w-0.5 bg-amber-500" />Quote</span>
      </div>}>
      <ScanZone plan={plan} onScan={onScan} busy={busy} />
      <div className="space-y-3">
        {cats.map(cat => {
          const items = plan.budgetItems.filter(b => b.category === cat);
          const planned = items.reduce((a, b) => a + b.plannedPaise, 0);
          const committed = items.reduce((a, b) => a + b.committedPaise, 0);
          const isOpen = open[cat] ?? (items.length > 1 || cat === "decor");
          return (
            <div key={cat} className="rounded-xl border border-slate-100">
              <button onClick={() => setOpen(o => ({ ...o, [cat]: !isOpen }))} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50">
                {isOpen ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
                <span className="text-sm font-semibold">{CAT_LABEL[cat] ?? cat}</span>
                <span className="text-xs text-slate-400">{items.length} item{items.length > 1 ? "s" : ""}</span>
                <span className="ml-auto flex items-center gap-3 text-xs tabular-nums">
                  <span className="text-slate-500">committed {inr(committed)}</span>
                  <span className="font-semibold">{inr(planned)}</span>
                  <Badge tone={(cuttable[cat] ?? 0) > 0 ? "emerald" : "slate"} title="Unlocked slack the AI can cut">✂ {inr(cuttable[cat] ?? 0)}</Badge>
                </span>
              </button>
              {isOpen && (
                <ul className="divide-y divide-slate-100 border-t border-slate-100">
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
                          {b.quoteRedFlags.length > 0 && <Badge tone="rose" title={b.quoteRedFlags.join("\n")}>⚠️ {b.quoteRedFlags.length} contract flag{b.quoteRedFlags.length > 1 ? "s" : ""}</Badge>}
                          <button
                            onClick={() => commit({ summary: `${b.locked ? "Unlock" : "Lock"} ${b.label}`, commands: [{ op: "set_item_lock", budgetItemId: b.id, locked: !b.locked }] })}
                            className={`ml-auto flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ${b.locked ? "bg-slate-800 text-white ring-slate-800" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"}`}
                            title={b.locked ? "Pinned: the AI can't cut this" : "Pin this so cuts skip it"}>
                            {b.locked ? <><Lock size={11} /> Locked</> : <><Unlock size={11} /> Lock</>}
                          </button>
                        </div>
                        <div className="mt-1.5 flex items-center gap-3">
                          <div className="flex-1"><EnvelopeBar b={b} /></div>
                          <span className="w-24 text-right text-sm font-semibold tabular-nums">{inr(b.plannedPaise)}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 tabular-nums">
                          <span>committed {inr(b.committedPaise)}</span>
                          <span className={b.locked ? "text-slate-400" : "text-emerald-700"}>slack {inr(Math.max(0, b.plannedPaise - b.committedPaise))}{b.locked ? " (locked)" : ""}</span>
                          {unpaid.map(p => (
                            <span key={p.id} className={`inline-flex items-center gap-1 ${p.dueDate < today ? "font-medium text-rose-600" : ""} ${hl(p.id)}`}>
                              {p.kind} {inr(p.amountPaise)} due {p.dueDate}
                              <button onClick={() => commit({ summary: `Record ${p.kind} for ${b.label}`, commands: [{ op: "record_payment", budgetItemId: b.id, paymentId: p.id, paidDate: today }] })}
                                className="rounded bg-emerald-50 px-1.5 text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100">mark paid</button>
                            </span>
                          ))}
                          {b.payments.filter(p => p.paidDate).map(p => (
                            <span key={p.id} className={`inline-flex items-center gap-0.5 text-emerald-700 ${hl(p.id)}`}><CheckCircle2 size={11} /> {p.kind} {inr(p.amountPaise)} paid</span>
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
