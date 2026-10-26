"use client";
import { useState } from "react";
import { Anchor, CalendarRange, ChevronLeft, ChevronRight, Clock, Eye, EyeOff, MapPin, Shirt, Star } from "lucide-react";
import type { AgentState } from "@/schema";
import type { Commit, Highlight } from "./PlannerApp";
import { refAnchor } from "@/routes";
import { Badge, Card, Chip, Empty, hhmm, InlineEdit, phaseTone, prettyDate, saveWith, useHighlight, useMediaQuery } from "./ui";

// White labels sit on these, so every shade clears 4.5:1 against white. Each lane also gets its own pattern
// (globals.css .lane-pat-*), shown on the bar's leading edge and on the lane's legend swatch, so lanes never differ by colour alone.
const LANE_COLORS = ["bg-brand-700", "bg-peacock-700", "bg-marigold-700", "bg-emerald-700", "bg-maroon-700", "bg-sand-600"];

type Block = AgentState["timeline"][number];
/** "HH:MM" (24-hour) for the time input. */
const hhmm24 = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
type Nudge = (b: Block, d: number) => void;

function LaneSwatch({ i }: { i: number }) {
  return <i aria-hidden="true" className={`inline-block h-3.5 w-5 shrink-0 rounded-sm ${LANE_COLORS[i % LANE_COLORS.length]} lane-pat-${i % 6}`} />;
}
function LaneChip({ lane, i }: { lane: string; i: number }) {
  return <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium capitalize text-sand-800 ring-1 ring-inset ring-line"><LaneSwatch i={i} />{lane}</span>;
}

const fullLabel = (b: Block, lane: string) => `${b.label}, ${hhmm(b.startMin)} to ${hhmm(b.endMin)}, ${lane} lane${b.anchored ? ", anchored (never moves)" : ""}`;

/** md and up: one row per lane with positioned bars. Each bar reveals its full label, times and the ±15 buttons on hover or keyboard focus. */
function Lanes({ blocks, lo, span, laneIndex, nudge, hl }: { blocks: Block[]; lo: number; span: number; laneIndex: (l: string) => number; nudge: Nudge; hl: (id: string) => string }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const lanes = [...new Set(blocks.map(b => b.lane))];
  return (
    <div className="mt-3 space-y-2">
      <div aria-hidden="true" className="flex gap-3">
        <span className="w-28 shrink-0" />
        <div className="relative h-4 flex-1 text-xs tabular-nums text-ink-muted">
          {[0, 0.25, 0.5, 0.75, 1].map(f => (
            <span key={f} className={`absolute whitespace-nowrap ${f === 0 ? "" : f === 1 ? "-translate-x-full" : "-translate-x-1/2"}`} style={{ left: `${f * 100}%` }}>{hhmm(Math.round((lo + f * span) / 15) * 15)}</span>
          ))}
        </div>
      </div>
      {lanes.map(lane => {
        const li = laneIndex(lane);
        return (
          <div key={lane} className="flex items-center gap-3">
            <span className="flex w-28 shrink-0 items-center gap-1.5 break-words text-sm font-medium capitalize leading-tight text-sand-800"><LaneSwatch i={li} />{lane}</span>
            <div className="relative h-10 flex-1 rounded-md bg-sand-50 ring-1 ring-inset ring-line">
              {blocks.filter(b => b.lane === lane).map(b => {
                const left = ((b.startMin - lo) / span) * 100, width = Math.max(2, ((b.endMin - b.startMin) / span) * 100);
                const color = LANE_COLORS[li % LANE_COLORS.length];
                const hide = dismissed === b.id;
                return (
                  <div key={b.id} className={`group absolute inset-y-1 hover:z-20 focus-within:z-20 ${hl(b.id)}`} style={{ left: `${left}%`, width: `${width}%` }}
                    onMouseLeave={() => setDismissed(null)} onBlur={() => setDismissed(null)}
                    onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setDismissed(b.id); } }}>
                    <div aria-hidden="true" className={`flex h-full items-center overflow-hidden rounded ${b.anchored ? "bg-sand-800 ring-2 ring-marigold-500" : color} text-white shadow-sm`}>
                      <span className={`h-full w-2 shrink-0 lane-pat-${li % 6}`} />
                      {b.anchored && <Anchor size={13} className="ml-1 shrink-0 text-marigold-300" />}
                      <span className="truncate px-1.5 text-xs font-medium">{b.label}</span>
                    </div>
                    {/* Hover / focus reveal (WCAG 1.4.13: hoverable, stays while hovered or focused, Escape dismisses).
                        Always in the accessibility tree and the tab order, so the full label and the buttons are never out of reach. */}
                    <div role="group" aria-label={fullLabel(b, lane)}
                      className={`absolute top-full z-20 pt-1 ${left > 40 ? "right-0" : "left-0"} ${hide ? "pointer-events-none opacity-0" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"}`}>
                      <div className="w-max max-w-[17rem] rounded-lg bg-sand-900 p-2.5 text-white shadow-xl">
                        <p aria-hidden="true" className="break-words text-sm font-semibold">{b.label}</p>
                        <p aria-hidden="true" className="text-xs tabular-nums text-sand-200">{hhmm(b.startMin)}–{hhmm(b.endMin)} · <span className="capitalize">{lane}</span>{b.anchored ? " · anchored" : ""}</p>
                        <div className="mt-2 flex gap-1.5">
                          <button type="button" aria-label={`Shift ${b.label} 15 minutes earlier`} onClick={() => nudge(b, -15)} className="flex h-8 items-center gap-0.5 rounded-md bg-white/15 px-2 text-xs font-semibold tabular-nums hover:bg-white/25"><ChevronLeft size={14} aria-hidden="true" />15 min</button>
                          <button type="button" aria-label={`Shift ${b.label} 15 minutes later`} onClick={() => nudge(b, 15)} className="flex h-8 items-center gap-0.5 rounded-md bg-white/15 px-2 text-xs font-semibold tabular-nums hover:bg-white/25">15 min<ChevronRight size={14} aria-hidden="true" /></button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Below 768px: a plain agenda (time, full block name, lane chip) with 44px nudge buttons. */
function Agenda({ blocks, laneIndex, nudge, hl }: { blocks: Block[]; laneIndex: (l: string) => number; nudge: Nudge; hl: (id: string) => string }) {
  return (
    <ol className="mt-3 divide-y divide-line-soft rounded-xl border border-line">
      {[...blocks].sort((a, b) => a.startMin - b.startMin || a.lane.localeCompare(b.lane)).map(b => (
        <li key={b.id} className={`flex items-start gap-3 px-3 py-2.5 ${hl(b.id)}`}>
          <span className="w-[4.75rem] shrink-0 whitespace-nowrap pt-0.5 text-sm font-semibold tabular-nums text-ink">{hhmm(b.startMin)}<span className="block text-xs font-normal text-ink-muted"><span className="sr-only">to </span>{hhmm(b.endMin)}</span></span>
          <div className="min-w-0 flex-1">
            <p className="break-words text-base font-medium leading-snug text-ink">{b.label}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <LaneChip lane={b.lane} i={laneIndex(b.lane)} />
              {b.anchored && <Chip tone="warning" icon={<Anchor size={13} />}>Anchored</Chip>}
            </div>
          </div>
          <div className="flex shrink-0 gap-1">
            <button type="button" aria-label={`Shift ${b.label} 15 minutes earlier`} onClick={() => nudge(b, -15)}
              className="grid h-11 w-11 place-items-center rounded-lg border border-line-strong bg-surface text-sand-800 hover:bg-sand-100"><ChevronLeft size={18} aria-hidden="true" /></button>
            <button type="button" aria-label={`Shift ${b.label} 15 minutes later`} onClick={() => nudge(b, 15)}
              className="grid h-11 w-11 place-items-center rounded-lg border border-line-strong bg-surface text-sand-800 hover:bg-sand-100"><ChevronRight size={18} aria-hidden="true" /></button>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function TimelineCard({ plan, commit, highlight }: { plan: AgentState; commit: Commit; highlight: Highlight }) {
  const hl = useHighlight(highlight);
  // One variant at a time: no nudge button or block exists twice in the DOM.
  const wide = useMediaQuery("(min-width: 768px)", true);
  const subs = [...plan.subEvents].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
  const allLanes = [...new Set(plan.timeline.map(b => b.lane))];
  const laneIndex = (l: string) => Math.max(0, allLanes.indexOf(l));
  const nudge: Nudge = (b, d) => commit({ summary: `Shift ${b.label} ${d > 0 ? "+" : ""}${d} min`, commands: [{ op: "shift_block", blockId: b.id, newStartMin: Math.max(0, b.startMin + d) }] });

  return (
    <Card id="schedule" title="Multi-Event Timeline & Lane Schedule" icon={<CalendarRange size={18} className="text-brand-700" />}
      subtitle={<>Nudge a block by 15 minutes (via <code className="rounded bg-surface-muted px-1 text-sm">shift_block</code>). <Anchor size={14} aria-hidden="true" className="inline text-amber-700" /> Anchored blocks never move.</>}>
      {subs.length === 0 ? <Empty>No sub-events yet.</Empty> : (
        <div className="space-y-4">
          {subs.map(s => {
            const blocks = plan.timeline.filter(b => b.subEventId === s.id);
            const lo = Math.min(s.startMin, ...blocks.map(b => b.startMin));
            const hi = Math.max(s.endMin, ...blocks.map(b => b.endMin));
            const span = Math.max(30, hi - lo);
            const pub = s.visibility === "public";
            return (
              <div key={s.id} id={refAnchor(s.id)} className={`rounded-xl border border-line p-3 sm:p-4 ${hl(s.id)}`}>
                <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <InlineEdit label={`name of ${s.name}`} value={s.name}
                        onSave={(name: string) => saveWith(commit, { summary: `Rename ${s.name}`, commands: [{ op: "rename_entity", kind: "sub_event", id: s.id, name }] })}>
                        <h3 className="text-base font-semibold text-ink">{s.name}</h3>
                      </InlineEdit>
                      {s.isMain ? <Chip tone="primary" icon={<Star size={12} />}>Main event</Chip> : <Badge tone={phaseTone(s.phase)} className="capitalize">{s.phase}</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted">
                      {/* Start time: move_sub_event on the same date keeps the duration and shifts its unanchored blocks with it. */}
                      <InlineEdit label={`start time of ${s.name}`} kind="time" value={hhmm24(s.startMin)} inputSize="w-32" hint="Keeps the duration; unanchored blocks move with it"
                        onSave={(min: number) => min === s.startMin ? null : saveWith(commit, { summary: `${s.name} starts at ${hhmm(min)}`,
                          commands: [{ op: "move_sub_event", subEvent: s.id, to: { date: s.date }, newStartMin: min }] })}>
                        <span className="flex items-center gap-1 font-medium tabular-nums text-sand-800"><Clock size={14} aria-hidden="true" />{prettyDate(s.date)} · {hhmm(s.startMin)}–{hhmm(s.endMin)}</span>
                      </InlineEdit>
                      {s.venue && <span className="flex items-center gap-1"><MapPin size={14} aria-hidden="true" />{s.venue}</span>}
                      {s.dressCode && <span className="flex items-center gap-1"><Shirt size={14} aria-hidden="true" />{s.dressCode}</span>}
                    </div>
                  </div>
                  <button type="button" data-testid={`visibility-${s.slug}`} aria-pressed={pub}
                    title={pub ? "Shown on the read-only itinerary page (the guest link without an RSVP code). Click to hide it there. Guests on the RSVP link still see it if it takes RSVPs." : "Hidden from the read-only itinerary page. Guests on the RSVP link still see it if it takes RSVPs. Click to show it there."}
                    onClick={() => commit({ summary: `${pub ? "Hide" : "Show"} ${s.name} ${pub ? "from" : "on"} the read-only itinerary page`,
                      commands: [{ op: "set_sub_event_visibility", subEvent: s.slug, visibility: pub ? "private" : "public" }] })}
                    className={`flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium ring-1 ring-inset max-md:min-h-11 pointer-coarse:min-h-11 ${pub ? "bg-emerald-50 text-emerald-800 ring-emerald-600" : "bg-surface text-sand-700 ring-sand-500"}`}>
                    <span className="sr-only">{s.name} on the read-only itinerary page: </span>
                    {pub ? <><Eye size={15} aria-hidden="true" /> Public</> : <><EyeOff size={15} aria-hidden="true" /> Private</>}
                  </button>
                </div>
                {blocks.length > 0 && (wide
                  ? <Lanes blocks={blocks} lo={lo} span={span} laneIndex={laneIndex} nudge={nudge} hl={hl} />
                  : <Agenda blocks={blocks} laneIndex={laneIndex} nudge={nudge} hl={hl} />)}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
