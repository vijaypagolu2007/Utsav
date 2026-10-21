"use client";
import { Building2, Cake, Gift, Handshake, Heart, Megaphone, ShieldCheck, Sparkles, Timer, Users } from "lucide-react";
import type { AgentState } from "@/schema";
import { daysBetween } from "@/commands";
import type { Commit, Highlight } from "./PlannerApp";
import { Badge, Card, Empty, inr, priorityTone, relDays, useHighlight, type Tone } from "./ui";

type Props = { plan: AgentState; today: string; commit: Commit; highlight: Highlight; onAsk: (text: string) => void };
const RSVP_CYCLE: Record<string, "yes" | "no" | "maybe" | "invited"> = { invited: "yes", yes: "no", no: "maybe", maybe: "invited" };
const RSVP_STYLE: Record<string, string> = {
  yes: "bg-emerald-500 text-white", no: "bg-rose-100 text-rose-700", maybe: "bg-amber-100 text-amber-800", invited: "bg-slate-100 text-slate-500",
};

function Wedding({ plan, commit, highlight }: Props) {
  const hl = useHighlight(highlight);
  const ext = plan.event.ext;
  if (ext.type !== "wedding") return null;
  const subs = plan.subEvents.filter(s => s.collectsRsvp).sort((a, b) => a.date.localeCompare(b.date));
  const tally = (sid: string, v: string) => plan.guests.filter(g => g.rsvp[sid] === v).length;
  const main = plan.subEvents.find(s => s.isMain);
  const diets = new Map<string, number>();
  for (const g of plan.guests) if (main && g.rsvp[main.id] === "yes") for (const d of g.diet.length ? g.diet : ["no restriction"]) diets.set(d, (diets.get(d) ?? 0) + 1);

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_16rem]">
      <div className="min-w-0 overflow-x-auto">
        {plan.guests.length === 0 ? <Empty>No guests yet. The plan is sized for {plan.event.guestCount} guests.</Empty> : (
          <table className="w-full min-w-[36rem] border-separate border-spacing-y-0.5 text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-slate-500">
                <th className="py-1 pr-2 font-medium">Household · guest</th>
                {subs.map(s => <th key={s.id} className="px-1 py-1 text-center font-medium">{s.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {plan.households.map(h => {
                const gs = plan.guests.filter(g => g.householdId === h.id);
                if (!gs.length) return null;
                return [
                  <tr key={h.id}><td colSpan={subs.length + 1} className="pt-2 text-[11px] font-semibold text-slate-700">{h.label} <span className="font-normal text-slate-400">· {h.side}</span></td></tr>,
                  ...gs.map(g => (
                    <tr key={g.id} className={hl(g.id)}>
                      <td className="py-0.5 pr-2 text-slate-700">{g.name}{g.ageGroup !== "adult" && <span className="text-slate-400"> ({g.ageGroup})</span>}{g.diet.length > 0 && <span className="ml-1 text-[10px] text-slate-400">{g.diet.join(", ")}</span>}</td>
                      {subs.map(s => {
                        const v = g.rsvp[s.id];
                        return (
                          <td key={s.id} className="px-1 py-0.5 text-center">
                            {v ? (
                              <button onClick={() => commit({ summary: `${g.name} · ${s.name}: ${RSVP_CYCLE[v]}`, commands: [{ op: "set_rsvp", guestId: g.id, subEvent: s.slug, answer: RSVP_CYCLE[v]! }] })}
                                className={`w-14 rounded-md py-0.5 text-[10px] font-semibold capitalize ${RSVP_STYLE[v]}`}>{v === "invited" ? "pending" : v}</button>
                            ) : <span className="text-slate-300">—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  )),
                ];
              })}
            </tbody>
            <tfoot>
              <tr className="text-[10px] text-slate-500">
                <td className="pt-2 font-semibold">Yes / No / Maybe / Pending</td>
                {subs.map(s => <td key={s.id} className="pt-2 text-center tabular-nums"><span className="text-emerald-700">{tally(s.id, "yes")}</span>/{tally(s.id, "no")}/{tally(s.id, "maybe")}/{tally(s.id, "invited")}</td>)}
              </tr>
            </tfoot>
          </table>
        )}
      </div>
      <div className="space-y-3">
        <div className="rounded-xl bg-gradient-to-br from-rose-50 to-amber-50 p-3 ring-1 ring-rose-100">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-700"><Heart size={13} /> {ext.partners.filter(Boolean).join(" & ") || "Partners"}</div>
          <div className="mt-2 flex flex-wrap gap-1">{ext.traditions.map(t => <Badge key={t} tone="rose">{t}</Badge>)}</div>
          {ext.rsvpDeadline && <div className="mt-2 text-[11px] text-slate-600">RSVP deadline <b>{ext.rsvpDeadline}</b></div>}
        </div>
        <div className="rounded-xl p-3 ring-1 ring-slate-100">
          <div className="mb-1.5 text-xs font-semibold text-slate-700">Dietary counts · {main?.name ?? "main"} (yes)</div>
          {diets.size === 0 ? <p className="text-[11px] text-slate-400">No confirmations yet.</p> :
            <ul className="space-y-0.5 text-[11px]">{[...diets].sort((a, b) => b[1] - a[1]).map(([d, n]) => <li key={d} className="flex justify-between"><span className="capitalize text-slate-600">{d}</span><b className="tabular-nums">{n}</b></li>)}</ul>}
        </div>
      </div>
    </div>
  );
}

function Birthday({ plan, commit, highlight }: Props) {
  const hl = useHighlight(highlight);
  const ext = plan.event.ext;
  if (ext.type !== "birthday") return null;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div>
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700"><Gift size={13} className="text-violet-600" /> Gift wishlist</div>
        {ext.wishlist.length === 0 ? <Empty>No wishes yet.</Empty> : (
          <ul className="space-y-1.5">
            {ext.wishlist.map(w => (
              <li key={w.id} className={`flex items-center gap-2 rounded-lg p-2 ring-1 ${w.claimedByGuestId ? "bg-emerald-50/50 ring-emerald-100" : w.priority === "high" ? "ring-amber-200" : "ring-slate-100"} ${hl(w.id)}`}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{w.item}</div>
                  <div className="mt-0.5 flex gap-1"><Badge tone={priorityTone(w.priority)}>{w.priority}</Badge>{w.approxPaise !== undefined && <Badge>~{inr(w.approxPaise)}</Badge>}</div>
                </div>
                <select value={w.claimedByGuestId ?? ""} aria-label={`Who claimed ${w.item}`}
                  onChange={e => commit({ summary: `Wishlist ${w.item}`, commands: [{ op: "claim_wishlist_item", itemId: w.id, guestId: e.target.value || null }] })}
                  className={`max-w-36 rounded-md border px-1.5 py-1 text-[11px] ${w.claimedByGuestId ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-white text-slate-500"}`}>
                  <option value="">Unclaimed</option>
                  {plan.guests.map(g => <option key={g.id} value={g.id}>🎁 {g.name}</option>)}
                </select>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700"><Timer size={13} className="text-sky-600" /> Party activity run-sheet</div>
        {ext.activities.length === 0 ? <Empty>No activities yet.</Empty> : (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-[10px] uppercase tracking-wide text-slate-500"><th className="py-1 font-medium">Activity</th><th className="font-medium">Ages</th><th className="font-medium">Mins</th><th className="font-medium">Supplies</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {ext.activities.map(a => (
                <tr key={a.id} className={hl(a.id)}>
                  <td className="py-1.5 pr-2 font-medium">{a.name}</td>
                  <td className="tabular-nums text-slate-600">{a.ageRange ? `${a.ageRange[0]}–${a.ageRange[1]}` : "all"}</td>
                  <td className="tabular-nums text-slate-600">{a.durationMin}</td>
                  <td className="py-1"><div className="flex flex-wrap gap-1">{a.supplies.map(s => <Badge key={s}>{s}</Badge>)}</div></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={4} className="pt-2 text-[11px] text-slate-500">Total run time <b className="tabular-nums">{ext.activities.reduce((x, a) => x + a.durationMin, 0)} min</b></td></tr></tfoot>
          </table>
        )}
      </div>
    </div>
  );
}

const TIER_TONE: Record<string, Tone> = { title: "violet", gold: "amber", silver: "slate", in_kind: "sky" };
const SPONSOR_STATUSES = ["prospect", "pitched", "committed", "paid", "declined"] as const;
const PERMIT_STATUSES = ["not_started", "applied", "approved", "rejected"] as const;

function Community({ plan, today, commit, highlight, onAsk }: Props) {
  const hl = useHighlight(highlight);
  const ext = plan.event.ext;
  if (ext.type !== "community") return null;
  const pledged = ext.sponsors.reduce((a, s) => a + (s.status === "declined" ? 0 : s.pledgedPaise), 0);
  const received = ext.sponsors.reduce((a, s) => a + s.receivedPaise, 0);
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700"><Handshake size={13} className="text-violet-600" /> Sponsor pipeline
          <span className="ml-auto font-normal tabular-nums text-slate-500">{inr(received)} received of {inr(pledged)} pledged</span></div>
        <ul className="space-y-1.5">
          {ext.sponsors.map(s => {
            const pct = s.pledgedPaise ? Math.min(100, (s.receivedPaise / s.pledgedPaise) * 100) : s.status === "paid" || s.status === "committed" ? 100 : 0;
            return (
              <li key={s.id} className={`rounded-lg p-2 ring-1 ring-slate-100 ${hl(s.id)}`}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-semibold">{s.name}</span>
                  <Badge tone={TIER_TONE[s.tier]}>{s.tier.replace("_", "-")}</Badge>
                  <select value={s.status} aria-label={`${s.name} status`}
                    onChange={e => commit({ summary: `${s.name} → ${e.target.value}`, commands: [{ op: "update_sponsor", sponsorId: s.id, status: e.target.value as (typeof SPONSOR_STATUSES)[number] }] })}
                    className="ml-auto rounded-md border border-slate-200 px-1 py-0.5 text-[11px]">
                    {SPONSOR_STATUSES.map(x => <option key={x} value={x}>{x}</option>)}
                  </select>
                  <button onClick={() => onAsk(`Draft a sponsor pitch email for ${s.name}`)}
                    className="flex items-center gap-1 rounded-md bg-violet-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-violet-700"><Sparkles size={11} /> AI pitch</button>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
                  <span className="text-[11px] tabular-nums text-slate-600">{inr(s.receivedPaise)} / {s.pledgedPaise ? inr(s.pledgedPaise) : "in-kind"}</span>
                </div>
                {s.deliverables.length > 0 && <div className="mt-1 text-[10px] text-slate-500">{s.deliverables.join(" · ")}</div>}
              </li>
            );
          })}
        </ul>
        {ext.volunteerSignups.length > 0 && (
          <div className="mt-2 rounded-lg bg-emerald-50/60 p-2 text-[11px] text-emerald-900 ring-1 ring-emerald-100">
            <b>Volunteer sign-ups:</b> {ext.volunteerSignups.map(v => `${v.name}${v.shift ? ` (${v.shift})` : ""}`).join(", ")}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700"><ShieldCheck size={13} className="text-sky-600" /> Municipal permits
          <span className="ml-auto flex items-center gap-2 font-normal text-slate-500"><Users size={12} />{ext.volunteers} volunteers · <Megaphone size={12} />{ext.expectedFootfall.toLocaleString("en-IN")} footfall</span></div>
        <ul className="space-y-1.5">
          {ext.permits.map(p => {
            const d = p.applyBy ? daysBetween(today, p.applyBy) : null;
            const risk = p.status !== "approved" && d !== null && d <= 14;
            return (
              <li key={p.id} className={`flex flex-wrap items-center gap-2 rounded-lg p-2 ring-1 ${p.status === "approved" ? "ring-emerald-100" : risk ? "ring-amber-200" : "ring-slate-100"} ${hl(p.id)}`}>
                <Building2 size={14} className="text-slate-400" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">{p.authority} · {p.kind}</div>
                  <div className="text-[10px] text-slate-500 tabular-nums">
                    {p.applyBy ? <>apply by {p.applyBy} <span className={d !== null && d < 0 && p.status === "not_started" ? "font-semibold text-rose-600" : risk ? "font-semibold text-amber-700" : ""}>({relDays(today, p.applyBy)})</span></> : "no deadline"}
                    {p.feePaise > 0 && <> · fee {inr(p.feePaise)}</>}{p.referenceNo && <> · ref <b>{p.referenceNo}</b></>}
                  </div>
                </div>
                <select value={p.status} aria-label={`${p.authority} status`}
                  onChange={e => commit({ summary: `${p.authority} ${p.kind} → ${e.target.value}`, commands: [{ op: "set_permit_status", permitId: p.id, status: e.target.value as (typeof PERMIT_STATUSES)[number] }] })}
                  className={`rounded-md border px-1 py-0.5 text-[11px] ${p.status === "approved" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-200"}`}>
                  {PERMIT_STATUSES.map(x => <option key={x} value={x}>{x.replace("_", " ")}</option>)}
                </select>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export default function ArchetypeCard(props: Props) {
  const t = props.plan.event.eventType;
  const ext = props.plan.event.ext;
  const title = t === "wedding" ? "Wedding · RSVP Matrix & Traditions" : t === "birthday"
    ? `Birthday · ${ext.type === "birthday" ? `${ext.honoree}${ext.turningAge ? ` turns ${ext.turningAge}` : ""} · ${ext.theme}` : ""}` : "Community · Sponsors & Permits";
  const icon = t === "wedding" ? <Heart size={16} className="text-rose-500" /> : t === "birthday" ? <Cake size={16} className="text-violet-600" /> : <Megaphone size={16} className="text-sky-600" />;
  return (
    <Card title={title} icon={icon} right={<Badge tone="indigo">event.ext · {ext.type}</Badge>}>
      {ext.type === "wedding" && <Wedding {...props} />}
      {ext.type === "birthday" && <Birthday {...props} />}
      {ext.type === "community" && <Community {...props} />}
    </Card>
  );
}
