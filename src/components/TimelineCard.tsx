"use client";
import { Anchor, CalendarRange, ChevronLeft, ChevronRight, Eye, EyeOff, MapPin, Star } from "lucide-react";
import type { AgentState } from "@/schema";
import type { Commit, Highlight } from "./PlannerApp";
import { Badge, Card, Empty, hhmm, phaseTone, prettyDate, useHighlight } from "./ui";

// White labels sit on these, so every shade clears 4.5:1 against white.
const LANE_COLORS = ["bg-violet-600", "bg-sky-700", "bg-amber-700", "bg-emerald-700", "bg-rose-700", "bg-indigo-600"];

export default function TimelineCard({ plan, commit, highlight }: { plan: AgentState; commit: Commit; highlight: Highlight }) {
  const hl = useHighlight(highlight);
  const subs = [...plan.subEvents].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
  const allLanes = [...new Set(plan.timeline.map(b => b.lane))];

  return (
    <Card title="Multi-Event Timeline & Lane Schedule" icon={<CalendarRange size={16} className="text-violet-600" />}
      right={<span className="flex flex-wrap items-center gap-1 text-[11px] text-slate-600">±15 min nudges go through <code className="rounded bg-slate-100 px-1">shift_block</code>; <Anchor size={11} className="text-amber-700" /> anchored blocks never move</span>}>
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
                  <span className="text-xs font-semibold tabular-nums text-slate-600 md:w-28">{prettyDate(s.date)}</span>
                  <h3 className="text-sm font-semibold">{s.name}</h3>
                  <Badge tone={phaseTone(s.phase)}>{s.phase}</Badge>
                  {s.isMain && <Badge tone="violet"><Star size={10} /> main</Badge>}
                  <span className="text-xs tabular-nums text-slate-600">{hhmm(s.startMin)} – {hhmm(s.endMin)}</span>
                  {s.venue && <span className="flex items-center gap-1 text-xs text-slate-600"><MapPin size={11} />{s.venue}</span>}
                  {s.dressCode && <span className="text-xs text-slate-600">· {s.dressCode}</span>}
                  <button type="button" data-testid={`visibility-${s.slug}`} aria-pressed={s.visibility === "public"}
                    title={s.visibility === "public" ? "Shown on the public guest link. Click to hide it (invited households still see it)." : "Only invited households see this on guest links. Click to show it publicly."}
                    onClick={() => commit({ summary: `${s.visibility === "public" ? "Hide" : "Show"} ${s.name} ${s.visibility === "public" ? "from" : "on"} the public guest link`,
                      commands: [{ op: "set_sub_event_visibility", subEvent: s.slug, visibility: s.visibility === "public" ? "private" : "public" }] })}
                    className={`ml-auto flex min-h-7 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ${s.visibility === "public" ? "bg-emerald-50 text-emerald-800 ring-emerald-300" : "bg-slate-50 text-slate-700 ring-slate-300"}`}>
                    <span className="sr-only">{s.name} on the public guest link: </span>
                    {s.visibility === "public" ? <><Eye size={12} /> Public</> : <><EyeOff size={12} /> Private</>}
                  </button>
                </div>
                {blocks.length > 0 && (
                  <div className="mt-2 space-y-1.5 pl-0 md:pl-28">
                    <div aria-hidden="true" className="relative h-3 text-[10px] text-slate-600">
                      {[0, 0.25, 0.5, 0.75, 1].map(f => (
                        <span key={f} className="absolute -translate-x-1/2 tabular-nums" style={{ left: `${f * 100}%` }}>{hhmm(Math.round((lo + f * span) / 15) * 15)}</span>
                      ))}
                    </div>
                    {lanes.map(lane => (
                      <div key={lane} className="flex items-center gap-2">
                        <span className="w-16 shrink-0 truncate text-[10px] font-medium uppercase tracking-wide text-slate-600" title={lane}>{lane}</span>
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
                                <span className="sr-only">, {hhmm(b.startMin)} to {hhmm(b.endMin)}{b.anchored ? ", anchored" : ""}</span>
                                <span aria-hidden="true" className="ml-1 hidden shrink-0 text-[10px] xl:inline">{hhmm(b.startMin)}</span>
                                {/* Shown on hover or keyboard focus (always in the tab order, so they're never unreachable). */}
                                <span className="absolute right-0.5 flex gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                                  <button type="button" aria-label={`Shift ${b.label} 15 minutes earlier`} onClick={() => nudge(-15)} className="grid h-6 w-6 place-items-center rounded bg-black/40 hover:bg-black/60"><ChevronLeft size={12} /></button>
                                  <button type="button" aria-label={`Shift ${b.label} 15 minutes later`} onClick={() => nudge(15)} className="grid h-6 w-6 place-items-center rounded bg-black/40 hover:bg-black/60"><ChevronRight size={12} /></button>
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
