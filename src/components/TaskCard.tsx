"use client";
import { CheckCircle2, Circle, CircleDot, ListChecks, OctagonAlert } from "lucide-react";
import type { AgentState } from "@/schema";
import { daysBetween, taskDueDate } from "@/commands";
import type { Commit, Highlight } from "./PlannerApp";
import { Badge, Card, Empty, priorityTone, prettyDate, relDays, useHighlight } from "./ui";

const COLS = [
  { key: "todo", label: "To do", icon: Circle },
  { key: "doing", label: "Doing", icon: CircleDot },
  { key: "blocked", label: "Blocked", icon: OctagonAlert },
  { key: "done", label: "Done", icon: CheckCircle2 },
] as const;
const NEXT: Record<string, "todo" | "doing" | "done" | "blocked"> = { todo: "doing", doing: "done", blocked: "doing", done: "todo" };

export default function TaskCard({ plan, today, commit, highlight }: { plan: AgentState; today: string; commit: Commit; highlight: Highlight }) {
  const hl = useHighlight(highlight);
  const main = plan.subEvents.find(s => s.isMain);
  const rows = plan.tasks.map(t => {
    const se = plan.subEvents.find(s => s.id === t.subEventId) ?? main;
    return { t, due: taskDueDate(plan, t), se };
  }).sort((a, b) => a.due.localeCompare(b.due));
  const cols = COLS.filter(c => c.key !== "blocked" || rows.some(r => r.t.status === "blocked"));

  return (
    <Card title="Derived-Date Task Queue" icon={<ListChecks size={16} className="text-sky-600" />}
      right={<span className="text-[11px] text-slate-500">due = sub-event date + offset · click to advance</span>}>
      {rows.length === 0 ? <Empty>No tasks yet.</Empty> : (
        <div className="@container"><div className={`grid gap-3 ${cols.length === 4 ? "@xl:grid-cols-2 @4xl:grid-cols-4" : "@xl:grid-cols-3"}`}>
          {cols.map(c => {
            const items = rows.filter(r => r.t.status === c.key);
            const Icon = c.icon;
            return (
              <div key={c.key} className="min-w-0 rounded-xl bg-slate-50 p-2 ring-1 ring-slate-100">
                <div className="mb-2 flex items-center gap-1.5 px-1 text-xs font-semibold text-slate-600"><Icon size={13} /> {c.label} <span className="text-slate-400">{items.length}</span></div>
                <div className="space-y-2">
                  {items.map(({ t, due, se }) => {
                    const d = daysBetween(today, due);
                    const urgent = t.status !== "done" && d <= 14;
                    return (
                      <button key={t.id}
                        onClick={() => commit({ summary: `Task "${t.title}" → ${NEXT[t.status]}`, commands: [{ op: "set_task_status", taskId: t.id, status: NEXT[t.status]! }] })}
                        className={`block w-full rounded-lg bg-white p-2 text-left shadow-sm ring-1 transition hover:ring-slate-300 ${urgent ? (d < 0 ? "ring-rose-300" : "ring-amber-200") : "ring-slate-200"} ${hl(t.id)}`}>
                        <div className={`text-xs font-medium ${t.status === "done" ? "text-slate-400 line-through" : "text-slate-800"}`}>{t.title}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <span className={`text-[11px] font-semibold tabular-nums ${t.status === "done" ? "text-slate-400" : d < 0 ? "text-rose-600" : d <= 14 ? "text-amber-700" : "text-slate-600"}`}>{prettyDate(due)}</span>
                          <span className="text-[10px] text-slate-400">{t.status === "done" ? "" : relDays(today, due)}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {se && <Badge tone="slate">{Math.abs(t.dueOffsetDays)}d {t.dueOffsetDays <= 0 ? "before" : "after"} {se.name}</Badge>}
                          <Badge tone={priorityTone(t.priority)}>{t.priority}</Badge>
                        </div>
                      </button>
                    );
                  })}
                  {items.length === 0 && <p className="px-1 py-3 text-center text-[11px] text-slate-400">—</p>}
                </div>
              </div>
            );
          })}
        </div></div>
      )}
    </Card>
  );
}
