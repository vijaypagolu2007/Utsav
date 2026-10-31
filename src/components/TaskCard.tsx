"use client";
import { useId } from "react";
import { AlarmClock, CheckCircle2, Circle, CircleDot, Clock, Link2, ListChecks, OctagonAlert, X, type LucideIcon } from "lucide-react";
import type { AgentState, TaskStatus } from "@/schema";
import { TASK_NEXT_STATUS as NEXT, TASK_STATUS_LABELS, TASK_STATUS_OPTIONS } from "@/config/planner-options";
import { daysBetween, taskDueDate } from "@/commands";
import type { Commit, Highlight } from "./PlannerApp";
import { Badge, Card, Chip, Empty, InlineEdit, priorityTone, prettyDate, relDays, saveWith, useHighlight } from "./ui";
import { refAnchor } from "@/routes";

const ICONS: Record<TaskStatus, LucideIcon> = { todo: Circle, doing: CircleDot, blocked: OctagonAlert, done: CheckCircle2 };
const ICON_TONE: Record<TaskStatus, string> = { todo: "text-sand-600", doing: "text-peacock-700", blocked: "text-red-700", done: "text-emerald-700" };
const GROUPS = TASK_STATUS_OPTIONS.map(o => ({ key: o.value, label: o.label, icon: ICONS[o.value] }));
/** v6: tasks are ordered by priority (high first), then by due date. */
const PRIORITY_RANK: Record<string, number> = { high: 0, med: 1, low: 2 };

/** "Waits for …": the tasks this one depends on, editable through set_task_dependency (Tier 0, cycles refused). */
function Dependencies({ plan, task, commit }: { plan: AgentState; task: AgentState["tasks"][number]; commit: Commit }) {
  const id = useId();
  const options = plan.tasks.filter(t => t.id !== task.id && !task.dependsOn.includes(t.id));
  const set = (deps: string[], summary: string) => commit({ summary, commands: [{ op: "set_task_dependency", taskId: task.id, dependsOn: deps }] });
  return (
    <details className="mt-1 rounded-lg px-1 text-sm" data-testid={`deps-${task.id}`}>
      <summary className={`flex min-h-8 w-fit cursor-pointer items-center gap-1.5 rounded-lg px-2 hover:bg-sand-100 max-md:min-h-11 ${task.dependsOn.length ? "font-medium text-sand-800" : "text-ink-muted"}`}>
        <Link2 size={14} aria-hidden="true" />{task.dependsOn.length ? `Waits for ${task.dependsOn.length} task${task.dependsOn.length === 1 ? "" : "s"}` : "Add a dependency"}<span className="sr-only">: {task.title}</span>
      </summary>
      <div className="space-y-1.5 px-2 pb-2 pt-1">
        {task.dependsOn.map(d => {
          const t = plan.tasks.find(x => x.id === d);
          return (
            <p key={d} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 break-words text-ink">{t?.title ?? d}{t?.status === "done" ? " (done)" : ""}</span>
              <button type="button" onClick={() => set(task.dependsOn.filter(x => x !== d), `"${task.title}" no longer waits for "${t?.title ?? d}"`)}
                className="flex min-h-8 items-center gap-1 rounded-md px-2 text-sand-800 ring-1 ring-inset ring-sand-400 hover:bg-sand-100 max-md:min-h-11"><X size={13} aria-hidden="true" />Remove<span className="sr-only"> {t?.title ?? d} from what {task.title} waits for</span></button>
            </p>
          );
        })}
        {options.length > 0 && (
          <div>
            <label htmlFor={`${id}-add`} className="sr-only">Add a task that {task.title} waits for</label>
            <select id={`${id}-add`} value="" data-testid={`dep-add-${task.id}`} onChange={e => { const v = e.target.value; if (v) set([...task.dependsOn, v], `"${task.title}" waits for "${plan.tasks.find(x => x.id === v)?.title}"`); }}
              className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink max-md:h-11">
              <option value="">Add a task it waits for…</option>
              {options.map(o => <option key={o.id} value={o.id}>{o.title}</option>)}
            </select>
          </div>
        )}
      </div>
    </details>
  );
}

/** Tasks as one list grouped by status (To do, Doing, Blocked when used, Done), soonest first. Click a task to advance it. */
export default function TaskCard({ plan, today, commit, highlight }: { plan: AgentState; today: string; commit: Commit; highlight: Highlight }) {
  const hl = useHighlight(highlight);
  const main = plan.subEvents.find(s => s.isMain);
  const rows = plan.tasks.map(t => {
    const se = plan.subEvents.find(s => s.id === t.subEventId) ?? main;
    return { t, due: taskDueDate(plan, t), se };
  }).sort((a, b) => (PRIORITY_RANK[a.t.priority] ?? 1) - (PRIORITY_RANK[b.t.priority] ?? 1) || a.due.localeCompare(b.due) || a.t.id.localeCompare(b.t.id));
  const byId = new Map(plan.tasks.map(t => [t.id, t]));
  const groups = GROUPS.filter(c => c.key !== "blocked" || rows.some(r => r.t.status === "blocked"));

  return (
    <Card id="tasks" title="Derived-Date Task Queue" icon={<ListChecks size={18} className="text-peacock-700" />}
      subtitle="Due date = sub-event date + offset. Ordered by priority, then due date. Select a task to move it to the next status.">
      {rows.length === 0 ? <Empty>No tasks yet.</Empty> : (
        /* Full-width page: the status groups sit side by side as columns once each can be 18rem wide. */
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[repeat(auto-fit,minmax(18rem,1fr))]">
          {groups.map(g => {
            const items = rows.filter(r => r.t.status === g.key);
            const Icon = g.icon;
            return (
              <div key={g.key}>
                <h3 className="mb-2 flex items-center gap-2 text-base font-semibold text-ink">
                  <Icon size={17} aria-hidden="true" className={ICON_TONE[g.key]} /> {g.label}
                  <span className="rounded-full bg-surface-muted px-2 text-sm font-medium tabular-nums text-sand-700 ring-1 ring-inset ring-line">{items.length}<span className="sr-only"> tasks</span></span>
                </h3>
                {items.length === 0 ? <p className="rounded-lg border border-dashed border-line-strong px-4 py-3 text-sm text-ink-muted">Nothing here yet</p> : (
                  <ul className="space-y-2">
                    {items.map(({ t, due, se }) => {
                      const d = daysBetween(today, due);
                      const open = t.status !== "done";
                      const overdue = open && d < 0, soon = open && d >= 0 && d <= 14;
                      const blockers = open ? t.dependsOn.map(x => byId.get(x)).filter((x): x is NonNullable<typeof x> => !!x && x.status !== "done") : [];
                      return (
                        <li key={t.id}>
                          <InlineEdit label={`task title ${t.title}`} value={t.title} grow inputSize="w-full" className="items-start"
                            onSave={(name: string) => saveWith(commit, { summary: `Rename task "${t.title}"`, commands: [{ op: "rename_entity", kind: "task", id: t.id, name }] })}>
                          <button type="button" id={refAnchor(t.id)}
                            onClick={() => commit({ summary: `Task "${t.title}" → ${NEXT[t.status]}`, commands: [{ op: "set_task_status", taskId: t.id, status: NEXT[t.status] }] })}
                            className={`block w-full rounded-lg border bg-surface px-3 py-3 text-left transition hover:border-sand-400 hover:bg-sand-50 ${overdue ? "border-red-300 border-l-4 border-l-red-600" : soon ? "border-amber-300 border-l-4 border-l-amber-600" : "border-line"} ${hl(t.id)}`}>
                            <span className={`block text-base font-medium leading-snug ${t.status === "done" ? "text-ink-muted line-through" : "text-ink"}`}>{t.title}</span>
                            <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              <span className={`text-sm font-semibold tabular-nums ${!open ? "text-ink-muted" : overdue ? "text-red-700" : soon ? "text-amber-800" : "text-sand-700"}`}>{prettyDate(due)}</span>
                              {overdue && <Chip tone="danger" icon={<AlarmClock size={13} />}>Overdue · {relDays(today, due)}</Chip>}
                              {soon && <Chip tone="warning" icon={<Clock size={13} />}>Soon · {relDays(today, due)}</Chip>}
                              {open && !overdue && !soon && <span className="text-sm tabular-nums text-ink-muted">{relDays(today, due)}</span>}
                            </span>
                            <span className="mt-1.5 flex flex-wrap gap-1.5">
                              {se && <Badge tone="neutral">{Math.abs(t.dueOffsetDays)}d {t.dueOffsetDays <= 0 ? "before" : "after"} {se.name}</Badge>}
                              <Badge tone={priorityTone(t.priority)} className="capitalize">{t.priority}<span className="sr-only"> priority</span></Badge>
                            </span>
                            {blockers.length > 0 && (
                              <span className="mt-1.5 flex flex-wrap gap-1.5" data-testid={`blocked-${t.id}`}>
                                <Chip tone="danger" icon={<Link2 size={13} />}>Blocked by {blockers.map(b => b.title).join(", ")}</Chip>
                              </span>
                            )}
                            <span className="sr-only">. {g.label}. Activate to move to {TASK_STATUS_LABELS[NEXT[t.status]]}.</span>
                          </button>
                          </InlineEdit>
                          {open && <Dependencies plan={plan} task={t} commit={commit} />}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
