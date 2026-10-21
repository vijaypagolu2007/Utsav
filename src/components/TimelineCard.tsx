"use client";
import { Anchor, CalendarRange, ChevronLeft, ChevronRight, MapPin } from "lucide-react";
import type { AgentState } from "@/schema";
import type { Commit, Highlight } from "./PlannerApp";
import { Badge, Card, Empty, hhmm, phaseTone, prettyDate, useHighlight } from "./ui";

const LANE_COLORS = ["bg-violet-500", "bg-sky-500", "bg-amber-500", "bg-emerald-500", "bg-rose-500", "bg-indigo-500"];

export default function TimelineCard({ plan, commit, highlight }: { plan: AgentState; commit: Commit; highlight: Highlight }) {
  const hl = useHighlight(highlight);
  const subs = [...plan.subEvents].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
  const allLanes = [...new Set(plan.timeline.map(b => b.lane))];

  return (
    <Card title="Multi-Event Timeline & Lane Schedule" icon={<CalendarRange size={16} className="text-violet-600" />}
      right={<span className="text-[11px] text-slate-500">±15 min nudges go through <code className="rounded bg-slate-100 px-1">shift_block</code>; ⚓ anchored blocks never move</span>}>
      {subs.length === 0 ? <Empty>No sub-events yet.</Empty> : (
        <div className="space-y-3">
          {subs.map(s => {
            const blocks = plan.timeline.filter(b => b.subEventId === s.id);
            const lo = Math.min(s.startMin, ...blocks.map(b => b.startMin));
            const hi = Math.max(s.endMin, ...blocks.map(b => b.endMin));
            const span = Math.max(30, hi - lo);
            const lanes = [...new Set(blocks.map(b => b.lane))];
            return (
              <div key={s.id} className={`rounded-xl border border-slate-100 p-3 ${hl(s.id)}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-28 text-xs font-semibold tabular-nums text-slate-500">{prettyDate(s.date)}</span>
                  <span className="text-sm font-semibold">{s.name}</span>
                  <Badge tone={phaseTone(s.phase)}>{s.phase}</Badge>
                  {s.isMain && <Badge tone="violet">★ main</Badge>}
                  <span className="text-xs tabular-nums text-slate-500">{hhmm(s.startMin)} – {hhmm(s.endMin)}</span>
                  {s.venue && <span className="flex items-center gap-1 text-xs text-slate-400"><MapPin size={11} />{s.venue}</span>}
                  {s.dressCode && <span className="text-xs text-slate-400">· {s.dressCode}</span>}
                </div>
                {blocks.length > 0 && (
                  <div className="mt-2 space-y-1.5 pl-0 md:pl-28">
                    <div className="relative h-3 text-[9px] text-slate-400">
                      {[0, 0.25, 0.5, 0.75, 1].map(f => (
                        <span key={f} className="absolute -translate-x-1/2 tabular-nums" style={{ left: `${f * 100}%` }}>{hhmm(Math.round((lo + f * span) / 15) * 15)}</span>
                      ))}
                    </div>
                    {lanes.map(lane => (
                      <div key={lane} className="flex items-center gap-2">
                        <span className="w-16 shrink-0 truncate text-[10px] font-medium uppercase tracking-wide text-slate-400">{lane}</span>
                        <div className="relative h-8 flex-1 rounded-md bg-slate-50 ring-1 ring-slate-100">
                          {blocks.filter(b => b.lane === lane).map(b => {
                            const left = ((b.startMin - lo) / span) * 100, width = Math.max(2, ((b.endMin - b.startMin) / span) * 100);
                            const color = LANE_COLORS[allLanes.indexOf(lane) % LANE_COLORS.length];
                            const nudge = (d: number) => commit({ summary: `Shift ${b.label} ${d > 0 ? "+" : ""}${d} min`, commands: [{ op: "shift_block", blockId: b.id, newStartMin: Math.max(0, b.startMin + d) }] });
                            return (
                              <div key={b.id} className={`group absolute inset-y-0.5 flex items-center overflow-hidden rounded ${b.anchored ? "bg-slate-800 ring-2 ring-amber-400" : color} px-1.5 text-white shadow-sm ${hl(b.id)}`}
                                style={{ left: `${left}%`, width: `${width}%` }} title={`${b.label} · ${hhmm(b.startMin)}–${hhmm(b.endMin)}${b.anchored ? " · anchored" : ""}`}>
                                {b.anchored && <Anchor size={11} className="mr-1 shrink-0 text-amber-300" />}
                                <span className="truncate text-[11px] font-medium">{b.label}</span>
                                <span className="ml-1 hidden shrink-0 text-[9px] opacity-80 xl:inline">{hhmm(b.startMin)}</span>
                                <span className="absolute right-0.5 hidden gap-0.5 group-hover:flex">
                                  <button aria-label={`Shift ${b.label} earlier`} onClick={() => nudge(-15)} className="rounded bg-black/30 p-0.5 hover:bg-black/50"><ChevronLeft size={10} /></button>
                                  <button aria-label={`Shift ${b.label} later`} onClick={() => nudge(15)} className="rounded bg-black/30 p-0.5 hover:bg-black/50"><ChevronRight size={10} /></button>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
