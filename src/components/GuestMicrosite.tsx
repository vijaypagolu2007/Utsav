"use client";
import { Fragment, useState, type ReactNode } from "react";
import { Anchor, CalendarHeart, Check, Gift, Handshake, HandHeart, MapPin, Shirt, UserRound, Utensils } from "lucide-react";
import type { AgentState, SponsorTier } from "@/schema";
import { daysBetween } from "@/commands";
import type { Commit, Highlight } from "./PlannerApp";
import { Badge, Card, Empty, hhmm, phaseTone, prettyDate, useHighlight } from "./ui";
import { formatTokens, templateTokens, type EventTemplate, type GuestSectionId } from "@/config/event-templates";
import { DEFAULT_SPONSOR_TIER, DIET_OPTIONS, GUEST_RSVP_ANSWERS, SPONSOR_TIER_OPTIONS, VOLUNTEER_SHIFTS } from "@/config/planner-options";

type Props = {
  template: EventTemplate;
  plan: AgentState; today: string; commit: Commit; highlight: Highlight;
  actingGuestId: string | null; setActingGuestId: (id: string) => void;
};


function RsvpCard({ plan, commit, actingGuestId, setActingGuestId, highlight }: Props) {
  const hl = useHighlight(highlight);
  const me = plan.guests.find(g => g.id === actingGuestId);
  if (!plan.guests.length) return <Empty>The guest list isn&apos;t open yet.</Empty>;
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-xs text-slate-600">
        <UserRound size={14} /> You are
        <select value={actingGuestId ?? ""} onChange={e => setActingGuestId(e.target.value)} className="min-h-8 rounded-md border border-slate-400 px-2 py-1 text-xs">
          {plan.households.map(h => (
            <optgroup key={h.id} label={h.label}>
              {plan.guests.filter(g => g.householdId === h.id).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      {me && (
        <>
          <ul className="space-y-1.5">
            {plan.subEvents.filter(s => s.id in me.rsvp).sort((a, b) => a.date.localeCompare(b.date)).map(s => {
              const v = me.rsvp[s.id];
              return (
                <li key={s.id} className={`flex flex-wrap items-center gap-2 rounded-lg p-2 ring-1 ring-slate-100 ${hl(me.id)}`}>
                  <div className="min-w-0 flex-1"><div className="text-xs font-semibold">{s.name}</div><div className="text-[11px] text-slate-600">{prettyDate(s.date)} · {hhmm(s.startMin)}</div></div>
                  <div className="flex gap-1" role="group" aria-label={`RSVP for ${s.name}`}>
                    {GUEST_RSVP_ANSWERS.map(a => (
                      <button type="button" key={a} aria-pressed={v === a} onClick={() => commit({ summary: `${me.name} · ${s.name}: ${a}`, commands: [{ op: "set_rsvp", guestId: me.id, subEvent: s.slug, answer: a }] })}
                        className={`flex min-h-8 items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold capitalize ring-1 ${v === a
                          ? a === "yes" ? "bg-emerald-700 text-white ring-emerald-700" : a === "no" ? "bg-rose-700 text-white ring-rose-700" : "bg-amber-700 text-white ring-amber-700"
                          : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"}`}>{v === a && <Check size={11} />}{a}</button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          <div>
            <div id={`diet-${me.id}`} className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-slate-700"><Utensils size={12} /> Dietary needs</div>
            <div className="flex flex-wrap gap-1" role="group" aria-labelledby={`diet-${me.id}`}>
              {DIET_OPTIONS.map(({ value: d, label }) => {
                const on = me.diet.includes(d);
                return (
                  <button type="button" key={d} aria-pressed={on} onClick={() => commit({ summary: `${me.name} diet`, commands: [{ op: "set_guest_diet", guestId: me.id, diet: on ? me.diet.filter(x => x !== d) : [...me.diet, d] }] })}
                    className={`flex min-h-7 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] ring-1 ${on ? "bg-violet-700 text-white ring-violet-700" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"}`}>{on && <Check size={11} />}{label}</button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Wishlist({ plan, commit, actingGuestId, highlight }: Props) {
  const hl = useHighlight(highlight);
  const ext = plan.event.ext;
  if (ext.type !== "birthday") return null;
  const name = (id: string | null) => plan.guests.find(g => g.id === id)?.name;
  return (
    <ul className="space-y-1.5">
      {ext.wishlist.map(w => {
        const mine = w.claimedByGuestId === actingGuestId;
        return (
          <li key={w.id} className={`flex items-center gap-2 rounded-lg p-2 ring-1 ring-slate-100 ${hl(w.id)}`}>
            <Gift size={14} className="text-violet-600" />
            <span className="min-w-0 flex-1 text-xs font-medium">{w.item} {w.priority === "high" && <Badge tone="rose">most wanted</Badge>}</span>
            {w.claimedByGuestId && !mine ? <Badge>claimed by {name(w.claimedByGuestId)}</Badge> : (
              <button type="button" disabled={!actingGuestId}
                onClick={() => commit({ summary: `${mine ? "Release" : "Claim"} ${w.item}`, commands: [{ op: "claim_wishlist_item", itemId: w.id, guestId: mine ? null : actingGuestId }] })}
                className={`flex min-h-8 items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold ${mine ? "bg-emerald-700 text-white hover:bg-emerald-800" : "bg-violet-700 text-white hover:bg-violet-800"} disabled:opacity-40`}>
                {mine ? <><Check size={12} /> Yours (release)</> : "I'll bring this"}<span className="sr-only">: {w.item}</span>
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function CommunitySignup({ plan, commit }: Props) {
  const ext = plan.event.ext;
  const [name, setName] = useState("");
  const pub = plan.subEvents.filter(s => s.visibility === "public");
  const [sub, setSub] = useState(pub.find(s => s.isMain)?.slug ?? pub[0]?.slug ?? "");
  const [shift, setShift] = useState<string>(VOLUNTEER_SHIFTS[0]);
  const [org, setOrg] = useState("");
  const [tier, setTier] = useState<SponsorTier>(DEFAULT_SPONSOR_TIER);
  if (ext.type !== "community") return null;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <form className="space-y-2 rounded-xl p-3 ring-1 ring-slate-100" onSubmit={e => {
        e.preventDefault();
        if (name.trim()) { const r = commit({ summary: `${name} volunteers`, commands: [{ op: "community_signup", kind: "volunteer", name: name.trim(), subEvent: sub, shift }] }); if (r.ok) setName(""); }
      }}>
        <h3 className="flex items-center gap-1 text-xs font-semibold text-slate-700"><HandHeart size={13} className="text-emerald-700" /> Volunteer for a shift</h3>
        <label className="block text-[11px] font-medium text-slate-700">Your name <span aria-hidden="true" className="text-rose-700">*</span>
          <input value={name} onChange={e => setName(e.target.value)} required autoComplete="name" className="mt-0.5 w-full rounded-md border border-slate-400 px-2 py-1 text-xs font-normal" />
        </label>
        <div className="flex flex-wrap gap-2">
          <label className="min-w-0 flex-1 text-[11px] font-medium text-slate-700">Part of the event
            <select value={sub} onChange={e => setSub(e.target.value)} className="mt-0.5 block min-h-7 w-full rounded-md border border-slate-400 px-1 py-1 text-xs font-normal">
              {plan.subEvents.filter(s => s.visibility === "public").map(s => <option key={s.id} value={s.slug}>{s.name}</option>)}
            </select>
          </label>
          <label className="text-[11px] font-medium text-slate-700">Shift
            <select value={shift} onChange={e => setShift(e.target.value)} className="mt-0.5 block min-h-7 rounded-md border border-slate-400 px-1 py-1 text-xs font-normal">
              {VOLUNTEER_SHIFTS.map(x => <option key={x}>{x}</option>)}
            </select>
          </label>
        </div>
        <button className="min-h-8 w-full rounded-md bg-emerald-700 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800">Sign me up</button>
        <p className="text-[11px] text-slate-600">{ext.volunteerSignups.length} signed up here · {ext.volunteers} volunteers total</p>
      </form>
      <form className="space-y-2 rounded-xl p-3 ring-1 ring-slate-100" onSubmit={e => {
        e.preventDefault();
        if (org.trim()) { const r = commit({ summary: `${org} sponsor interest`, commands: [{ op: "community_signup", kind: "sponsor", name: org.trim(), tier }] }); if (r.ok) setOrg(""); }
      }}>
        <h3 className="flex items-center gap-1 text-xs font-semibold text-slate-700"><Handshake size={13} className="text-violet-700" /> Sponsor the fest</h3>
        <label className="block text-[11px] font-medium text-slate-700">Business / organisation name <span aria-hidden="true" className="text-rose-700">*</span>
          <input value={org} onChange={e => setOrg(e.target.value)} required autoComplete="organization" className="mt-0.5 w-full rounded-md border border-slate-400 px-2 py-1 text-xs font-normal" />
        </label>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Sponsor tier">
          {SPONSOR_TIER_OPTIONS.map(({ value: t, label }) => (
            <button type="button" key={t} aria-pressed={tier === t} onClick={() => setTier(t)} className={`flex min-h-7 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] capitalize ring-1 ${tier === t ? "bg-violet-700 text-white ring-violet-700" : "text-slate-700 ring-slate-300"}`}>{tier === t && <Check size={11} />}{label}</button>
          ))}
        </div>
        <button className="min-h-8 w-full rounded-md bg-violet-700 py-1.5 text-xs font-semibold text-white hover:bg-violet-800">Register interest</button>
        <p className="text-[11px] text-slate-600">The committee follows up with the tier benefits.</p>
      </form>
    </div>
  );
}

/**
 * Guest-side cards a template can place (config/event-templates.ts → guest.aside / guest.footer).
 * Each renders nothing when the plan has no data for it. Showing a card grants nothing: every action still goes
 * through commit() with role "guest", and the reducer allows only the guest ops.
 */
const GUEST_SECTIONS: Record<GuestSectionId, (p: Props) => ReactNode> = {
  "guest-rsvp": p => p.plan.guests.length > 0 && <Card title="Your RSVP" icon={<UserRound size={16} className="text-emerald-600" />}><RsvpCard {...p} /></Card>,
  "guest-wishlist": p => p.plan.event.ext.type === "birthday" && <Card title="Gift wishlist" icon={<Gift size={16} className="text-violet-600" />}><Wishlist {...p} /></Card>,
  "community-signup": p => p.plan.event.ext.type === "community" && <Card title="Get involved" icon={<HandHeart size={16} className="text-emerald-600" />}><CommunitySignup {...p} /></Card>,
};
const renderSections = (ids: readonly GuestSectionId[], p: Props) => ids.map(id => <Fragment key={id}>{GUEST_SECTIONS[id](p)}</Fragment>);

/** Guest / Committee view: a public microsite with no money, vendors or internal tasks. */
export default function GuestMicrosite(props: Props) {
  const { plan, today, highlight, template } = props;
  const tagline = formatTokens(template.guest.tagline, templateTokens(plan));
  const hl = useHighlight(highlight);
  const main = plan.subEvents.find(s => s.isMain);
  const dte = main ? daysBetween(today, main.date) : null;
  const subs = [...plan.subEvents].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      {/* Darker gradient stops keep the white text at 4.5:1 or better across the whole banner. */}
      <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-violet-800 via-fuchsia-800 to-rose-700 p-5 text-white shadow-lg sm:p-8">
        <div className="text-xs font-semibold uppercase tracking-[0.2em]">{template.guest.kicker}</div>
        <h2 className="mt-2 break-words text-2xl font-bold leading-tight sm:text-3xl">{plan.event.title}</h2>
        <p className="mt-2 flex flex-wrap items-center gap-3 text-sm">
          <span className="flex items-center gap-1"><CalendarHeart size={15} /> {prettyDate(plan.event.startDate)}{plan.event.endDate !== plan.event.startDate ? ` – ${prettyDate(plan.event.endDate)}` : ""}</span>
          <span className="flex items-center gap-1"><MapPin size={15} /> {plan.event.city}</span>
          {dte !== null && dte >= 0 && <span className="rounded-full bg-black/25 px-2.5 py-0.5 text-xs font-semibold">{dte === 0 ? "Today!" : `${dte} days to go`}</span>}
        </p>
        {tagline && <p className="mt-3 text-lg font-medium">{tagline}</p>}
      </section>

      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <Card title="Live itinerary" icon={<CalendarHeart size={16} className="text-violet-600" />}>
          <ol className="relative space-y-4 border-l-2 border-violet-100 pl-5">
            {subs.map(s => {
              const blocks = plan.timeline.filter(b => b.subEventId === s.id).sort((a, b) => a.startMin - b.startMin);
              return (
                <li key={s.id} className={`relative ${hl(s.id)}`}>
                  <span aria-hidden="true" className="absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-white bg-violet-600 ring-2 ring-violet-200" />
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">{s.name}</h3>
                    <Badge tone={phaseTone(s.phase)}>{s.isMain ? "main event" : s.phase === "pre" ? "before" : "after"}</Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-slate-600">{prettyDate(s.date)} · {hhmm(s.startMin)} – {hhmm(s.endMin)}</div>
                  <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-slate-600">
                    {s.venue && <span className="flex items-center gap-1"><MapPin size={11} /> {s.venue}</span>}
                    {s.dressCode && <span className="flex items-center gap-1"><Shirt size={11} /> {s.dressCode}</span>}
                  </div>
                  {blocks.length > 0 && (
                    <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                      {blocks.filter(b => b.lane === "main" || b.anchored).map(b => (
                        <li key={b.id} className="flex items-center gap-2 rounded-md bg-slate-50 px-2 py-1 text-[11px]">
                          <span className="w-16 tabular-nums text-slate-600">{hhmm(b.startMin)}</span>
                          <span className="flex-1 font-medium text-slate-700">{b.label}</span>
                          {b.anchored && <><Anchor size={11} className="text-amber-700" /><span className="sr-only">fixed time</span></>}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        </Card>
        <div className="space-y-4">
          {renderSections(template.guest.aside, props)}
        </div>
      </div>
      {renderSections(template.guest.footer, props)}
    </div>
  );
}
