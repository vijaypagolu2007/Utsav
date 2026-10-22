"use client";
import type { ReactNode } from "react";
import { daysBetween, weekdayOf } from "@/commands";
import { formatMinute } from "@/diff";

/** ₹ with Indian digit grouping: 15000000 paise → ₹1,50,000. */
export { inr } from "@/budget-a11y";
/** Compact lakh/crore form for tight spots: ₹25L, ₹1.5L, ₹80K. */
export { inrShort } from "@/budget-a11y";
export const hhmm = formatMinute;
export const prettyDate = (d: string) => {
  const dt = new Date(d + "T00:00:00Z");
  return `${weekdayOf(d).slice(0, 3).replace(/^./, c => c.toUpperCase())}, ${dt.getUTCDate()} ${dt.toLocaleString("en-IN", { month: "short", timeZone: "UTC" })}`;
};
export const relDays = (today: string, d: string) => {
  const n = daysBetween(today, d);
  return n === 0 ? "today" : n > 0 ? `in ${n}d` : `${-n}d ago`;
};

export function useHighlight(hl: { ids: Set<string>; key: number }) {
  return (id: string) => (hl.ids.has(id) ? (hl.key % 2 ? "hl-a" : "hl-b") : "");
}

export function Card({ title, icon, right, children, className = "" }: { title: string; icon?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-slate-100 px-4 py-3">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-800">{icon}{title}</h2>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

const TONES = {
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  rose: "bg-rose-50 text-rose-700 ring-rose-200",
  sky: "bg-sky-50 text-sky-700 ring-sky-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = "slate", children, className = "", title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${TONES[tone]} ${className}`}>{children}</span>;
}

export const phaseTone = (p: string): Tone => (p === "main" ? "violet" : p === "pre" ? "sky" : "amber");
export const priorityTone = (p: string): Tone => (p === "high" ? "rose" : p === "med" ? "amber" : "slate");
export const severityTone = (s: string): Tone => (s === "critical" ? "rose" : s === "warning" ? "amber" : "sky");

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-500">{children}</p>;
}
