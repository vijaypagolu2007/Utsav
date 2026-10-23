"use client";
// The Overview page's KPI strip and the "Needs attention" list built from computePlanInsights.
import { useState } from "react";
import { AlertOctagon, AlertTriangle, ArrowRight, CheckCircle2, Info, TrendingUp, type LucideIcon } from "lucide-react";
import type { AgentState } from "@/schema";
import type { Insight, PlanInsights, Severity } from "@/insights";
import type { KpiDefinition } from "@/config/kpis";
import { kpiTestId } from "@/config/kpis";
import { kpiValue, type KpiContext, type KpiValue } from "@/kpis";
import { Card, Chip, Empty, severityTone } from "./ui";

const SEVERITY_ICON: Record<Severity, LucideIcon> = { critical: AlertOctagon, warning: AlertTriangle, info: Info };
export function SeverityIcon({ severity, size = 14 }: { severity: string; size?: number }) {
  const Icon = SEVERITY_ICON[severity as Severity] ?? Info;
  return <Icon size={size} />;
}

const TONE: Record<NonNullable<KpiValue["tone"]>, { value: string; rule: string; icon: LucideIcon | null; label: string }> = {
  default: { value: "text-ink", rule: "border-l-marigold-300", icon: null, label: "" },
  danger: { value: "text-red-700", rule: "border-l-red-600", icon: AlertTriangle, label: "Needs attention" },
  positive: { value: "text-emerald-800", rule: "border-l-emerald-600", icon: TrendingUp, label: "On track" },
};

/** One summary figure: a dt/dd pair inside the KPI <dl>, so the label stays tied to its value. Values wrap, never clip. */
function Kpi({ def, ctx, size }: { def: KpiDefinition; ctx: KpiContext; size: "lg" | "md" }) {
  const { value, sub, tone = "default" } = kpiValue(def.id, ctx);
  const t = TONE[tone];
  const Icon = t.icon;
  return (
    <div className={`min-w-0 rounded-xl border border-line border-l-4 bg-surface px-3 py-3 sm:px-4 ${t.rule}`} data-testid={kpiTestId(def.label)} title={def.description}>
      <dt className="flex items-center gap-1.5 text-sm font-medium text-ink-muted">
        {Icon && <Icon size={15} aria-hidden="true" className={t.value} />}{def.label}{t.label && <span className="sr-only"> ({t.label})</span>}
      </dt>
      <dd className={`mt-1 break-words font-semibold leading-tight tabular-nums ${size === "lg" ? "text-xl sm:text-2xl" : "text-xl"} ${t.value}`}>{value}</dd>
      {sub && <dd className="mt-0.5 break-words text-sm tabular-nums text-ink-muted">{sub}</dd>}
    </div>
  );
}

export function KpiStrip({ kpis, ctx, guest = false }: { kpis: readonly KpiDefinition[]; ctx: KpiContext; guest?: boolean }) {
  return (
    <dl className={`grid gap-3 ${guest ? "grid-cols-1 min-[480px]:grid-cols-3" : "grid-cols-1 min-[360px]:grid-cols-2 lg:grid-cols-3"}`}>
      {kpis.map(k => <Kpi key={k.id} def={k} ctx={ctx} size={guest ? "md" : "lg"} />)}
    </dl>
  );
}

const INITIAL = 5;

/**
 * The red flags as a prioritised list (critical first, as computePlanInsights sorts them), each with a "Show me" that
 * opens the page that owns the flag (Budget, Tasks or Event), highlights the flagged rows and focuses the first one.
 */
export function AttentionPanel({ plan, insights, onShow }: { plan: AgentState; insights: PlanInsights; onShow: (i: Insight) => void }) {
  const [all, setAll] = useState(false);
  const list = all ? insights.insights : insights.insights.slice(0, INITIAL);
  const { critical, warning, info } = insights.counts;
  const show = onShow;
  return (
    <Card id="attention" title="Needs attention" icon={<AlertTriangle size={18} className="text-red-700" />}
      subtitle={insights.insights.length ? <span className="tabular-nums">{critical} critical · {warning} warning · {info} info, most urgent first</span> : "Nothing is flagged for this plan."}>
      {insights.insights.length === 0 ? <Empty><CheckCircle2 size={16} aria-hidden="true" className="mr-1 inline text-emerald-700" />All clear for {plan.event.title}.</Empty> : (
        <>
          <ul className="divide-y divide-line">
            {list.map(i => (
              <li key={i.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
                <Chip tone={severityTone(i.severity)} icon={<SeverityIcon severity={i.severity} />} className="mt-0.5 capitalize">{i.severity}</Chip>
                <div className="min-w-0 flex-1 basis-56">
                  <p className="break-words text-base font-medium text-ink">{i.title}</p>
                  <p className="break-words text-sm tabular-nums text-ink-muted">{i.detail}</p>
                </div>
                <button type="button" onClick={() => show(i)}
                  className="flex min-h-9 shrink-0 items-center gap-1 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-brand-800 hover:bg-brand-50 max-md:min-h-11 pointer-coarse:min-h-11">
                  Show me<span className="sr-only">: {i.title}</span> <ArrowRight size={15} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {insights.insights.length > INITIAL && (
            <button type="button" aria-expanded={all} onClick={() => setAll(a => !a)}
              className="mt-3 min-h-9 rounded-lg px-2 text-sm font-medium text-brand-800 underline underline-offset-2 hover:bg-brand-50 max-md:min-h-11">
              {all ? "Show fewer" : `Show all ${insights.insights.length}`}
            </button>
          )}
        </>
      )}
    </Card>
  );
}
