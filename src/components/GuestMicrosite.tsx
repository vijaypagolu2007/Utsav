"use client";
import { Fragment, useState, type ReactNode } from "react";
import { Anchor, CalendarHeart, Check, Clock, Gift, Handshake, HandHeart, MapPin, Shirt, UserRound, Utensils } from "lucide-react";
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
  /** Optional guest-facing summary figures (no money), shown under the invitation. */
  summary?: ReactNode;
};

const big = "min-h-11 rounded-lg px-3.5 text-sm font-semibold";
const field = "mt-1 block min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base font-normal text-ink";
const ANSWER_ON: Record<string, string> = { yes: "bg-emerald-700 text-white ring-emerald-700", no: "bg-red-700 text-white ring-red-700", maybe: "bg-amber-700 text-white ring-amber-700" };

function RsvpCard({ plan, commit, actingGuestId, setActingGuestId, highlight }: Props) {
  const hl = useHighlight(highlight);
  const me = plan.guests.find(g => g.id === actingGuestId);
  if (!plan.guests.length) return <Empty>The guest list isn&apos;t open yet.</Empty>;
  return (
    <div className="space-y-4">
      <label className="block text-sm font-medium text-sand-800">
        <span className="flex items-center gap-1.5"><UserRound size={16} aria-hidden="true" /> You are</span>
        <select value={actingGuestId ?? ""} onChange={e => setActingGuestId(e.target.value)} className={field}>
          {plan.households.map(h => (
            <optgroup key={h.id} label={h.label}>
              {plan.guests.filter(g => g.householdId === h.id).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      {me && (
        <>
          <ul className="space-y-2">
            {plan.subEvents.filter(s => s.id in me.rsvp).sort((a, b) => a.date.localeCompare(b.date)).map(s => {
              const v = me.rsvp[s.id];
              return (
                <li key={s.id} className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl p-3 ring-1 ring-inset ring-line ${hl(me.id)}`}>
                  <div className="min-w-0 flex-1 basis-32"><p className="text-base font-semibold text-ink">{s.name}</p><p className="text-sm tabular-nums text-ink-muted">{prettyDate(s.date)} · {hhmm(s.startMin)}</p></div>
                  <div className="flex gap-1.5" role="group" aria-label={`RSVP for ${s.name}`}>
                    {GUEST_RSVP_ANSWERS.map(a => (
                      <button type="button" key={a} aria-pressed={v === a} onClick={() => commit({ summary: `${me.name} · ${s.name}: ${a}`, commands: [{ op: "set_rsvp", guestId: me.id, subEvent: s.slug, answer: a }] })}
                        className={`flex min-w-11 items-center justify-center gap-1 capitalize ring-1 ring-inset ${big} ${v === a ? ANSWER_ON[a] : "bg-surface text-sand-800 ring-sand-400 hover:bg-sand-100"}`}>{v === a && <Check size={15} aria-hidden="true" />}{a}</button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          <div>
            <h3 id={`diet-${me.id}`} className="mb-2 flex items-center gap-1.5 text-base font-semibold text-ink"><Utensils size={16} aria-hidden="true" /> Dietary needs</h3>
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby={`diet-${me.id}`}>
              {DIET_OPTIONS.map(({ value: d, label }) => {
                const on = me.diet.includes(d);
                return (
                  <button type="button" key={d} aria-pressed={on} onClick={() => commit({ summary: `${me.name} diet`, commands: [{ op: "set_guest_diet", guestId: me.id, diet: on ? me.diet.filter(x => x !== d) : [...me.diet, d] }] })}
                    className={`flex min-h-11 items-center gap-1 rounded-full px-4 text-sm font-medium ring-1 ring-inset ${on ? "bg-primary text-white ring-brand-700" : "bg-surface text-sand-800 ring-sand-400 hover:bg-sand-100"}`}>{on && <Check size={15} aria-hidden="true" />}{label}</button>
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
    <ul className="space-y-2">
      {ext.wishlist.map(w => {
        const mine = w.claimedByGuestId === actingGuestId;
        return (
          <li key={w.id} className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl p-3 ring-1 ring-inset ring-line ${hl(w.id)}`}>
            <Gift size={18} aria-hidden="true" className="shrink-0 text-brand-700" />
            <span className="min-w-0 flex-1 basis-32 text-base font-medium text-ink">{w.item} {w.priority === "high" && <Badge tone="primary">most wanted</Badge>}</span>
            {w.claimedByGuestId && !mine ? <Badge>claimed by {name(w.claimedByGuestId)}</Badge> : (
              <button type="button" disabled={!actingGuestId}
                onClick={() => commit({ summary: `${mine ? "Release" : "Claim"} ${w.item}`, commands: [{ op: "claim_wishlist_item", itemId: w.id, guestId: mine ? null : actingGuestId }] })}
                className={`flex items-center gap-1 text-white disabled:opacity-50 ${big} ${mine ? "bg-emerald-700 hover:bg-emerald-800" : "bg-primary hover:bg-primary-hover"}`}>
                {mine ? <><Check size={15} aria-hidden="true" /> Yours (release)</> : "I'll bring this"}<span className="sr-only">: {w.item}</span>
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
      <form className="space-y-3 rounded-xl p-4 ring-1 ring-inset ring-line" onSubmit={e => {
        e.preventDefault();
        if (name.trim()) { const r = commit({ summary: `${name} volunteers`, commands: [{ op: "community_signup", kind: "volunteer", name: name.trim(), subEvent: sub, shift }] }); if (r.ok) setName(""); }
      }}>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-ink"><HandHeart size={16} aria-hidden="true" className="text-emerald-700" /> Volunteer for a shift</h3>
        <label className="block text-sm font-medium text-sand-800">Your name <span aria-hidden="true" className="text-red-700">*</span>
          <input value={name} onChange={e => setName(e.target.value)} required autoComplete="name" className={field} />
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="min-w-0 flex-1 basis-40 text-sm font-medium text-sand-800">Part of the event
            <select value={sub} onChange={e => setSub(e.target.value)} className={field}>
              {plan.subEvents.filter(s => s.visibility === "public").map(s => <option key={s.id} value={s.slug}>{s.name}</option>)}
            </select>
          </label>
          <label className="min-w-0 flex-1 basis-32 text-sm font-medium text-sand-800">Shift
            <select value={shift} onChange={e => setShift(e.target.value)} className={field}>
              {VOLUNTEER_SHIFTS.map(x => <option key={x}>{x}</option>)}
            </select>
          </label>
        </div>
        <button className={`w-full bg-emerald-700 text-white hover:bg-emerald-800 ${big}`}>Sign me up</button>
        <p className="text-sm tabular-nums text-ink-muted">{ext.volunteerSignups.length} signed up here · {ext.volunteers} volunteers total</p>
      </form>
      <form className="space-y-3 rounded-xl p-4 ring-1 ring-inset ring-line" onSubmit={e => {
        e.preventDefault();
        if (org.trim()) { const r = commit({ summary: `${org} sponsor interest`, commands: [{ op: "community_signup", kind: "sponsor", name: org.trim(), tier }] }); if (r.ok) setOrg(""); }
      }}>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-ink"><Handshake size={16} aria-hidden="true" className="text-brand-700" /> Sponsor the fest</h3>
        <label className="block text-sm font-medium text-sand-800">Business / organisation name <span aria-hidden="true" className="text-red-700">*</span>
          <input value={org} onChange={e => setOrg(e.target.value)} required autoComplete="organization" className={field} />
        </label>
        <div>
          <p id="sponsor-tier-label" className="mb-1 text-sm font-medium text-sand-800">Sponsor tier</p>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby="sponsor-tier-label">
            {SPONSOR_TIER_OPTIONS.map(({ value: t, label }) => (
              <button type="button" key={t} aria-pressed={tier === t} onClick={() => setTier(t)} className={`flex min-h-11 items-center gap-1 rounded-full px-4 text-sm font-medium capitalize ring-1 ring-inset ${tier === t ? "bg-primary text-white ring-brand-700" : "bg-surface text-sand-800 ring-sand-400 hover:bg-sand-100"}`}>{tier === t && <Check size={15} aria-hidden="true" />}{label}</button>
            ))}
          </div>
        </div>
        <button className={`w-full bg-primary text-white hover:bg-primary-hover ${big}`}>Register interest</button>
        <p className="text-sm text-ink-muted">The committee follows up with the tier benefits.</p>
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
  "guest-rsvp": p => p.plan.guests.length > 0 && <Card title="Your RSVP" subtitle="Tell the hosts who is coming to each part." icon={<UserRound size={18} className="text-emerald-700" />}><RsvpCard {...p} /></Card>,
  "guest-wishlist": p => p.plan.event.ext.type === "birthday" && <Card title="Gift wishlist" subtitle="Claim a gift so nobody doubles up." icon={<Gift size={18} className="text-brand-700" />}><Wishlist {...p} /></Card>,
  "community-signup": p => p.plan.event.ext.type === "community" && <Card title="Get involved" subtitle="Volunteer for a shift or sponsor the fest." icon={<HandHeart size={18} className="text-emerald-700" />}><CommunitySignup {...p} /></Card>,
};
const renderSections = (ids: readonly GuestSectionId[], p: Props) => ids.map(id => <Fragment key={id}>{GUEST_SECTIONS[id](p)}</Fragment>);

/** Guest / Committee view: a public microsite with no money, vendors or internal tasks. Invitation, then itinerary, then RSVP. */
export default function GuestMicrosite(props: Props) {
  const { plan, today, highlight, template, summary } = props;
  const tagline = formatTokens(template.guest.tagline, templateTokens(plan));
  const hl = useHighlight(highlight);
  const main = plan.subEvents.find(s => s.isMain);
  const dte = main ? daysBetween(today, main.date) : null;
  const subs = [...plan.subEvents].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {/* hero-silk (globals.css): deep maroon-to-kumkum silk in both themes, white text at 4.5:1 or better everywhere on it. */}
      <section className="hero-silk overflow-hidden rounded-3xl p-6 text-white shadow-lg sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.18em]">{template.guest.kicker}</p>
        <h1 tabIndex={-1} className="mt-2 break-words text-3xl font-bold leading-tight focus-visible:outline-offset-4 sm:text-4xl">{plan.event.title}</h1>
        <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-base">
          <span className="flex items-center gap-1.5 tabular-nums"><CalendarHeart size={18} aria-hidden="true" /> {prettyDate(plan.event.startDate)}{plan.event.endDate !== plan.event.startDate ? ` – ${prettyDate(plan.event.endDate)}` : ""}</span>
          <span className="flex items-center gap-1.5"><MapPin size={18} aria-hidden="true" /> {plan.event.city}</span>
          {dte !== null && dte >= 0 && <span className="rounded-full bg-black/30 px-3 py-0.5 text-sm font-semibold tabular-nums">{dte === 0 ? "Today!" : `${dte} days to go`}</span>}
        </p>
        {tagline && <p className="mt-3 text-xl font-medium">{tagline}</p>}
      </section>
      {summary}

      <div className="grid gap-5 xl:grid-cols-[1fr_24rem]">
        <Card title="Live itinerary" subtitle="Times, venues and dress codes for every part of the celebration." icon={<CalendarHeart size={18} className="text-brand-700" />}>
          <ol className="relative space-y-6 border-l-2 border-marigold-300 pl-6">
            {subs.map(s => {
              const blocks = plan.timeline.filter(b => b.subEventId === s.id).sort((a, b) => a.startMin - b.startMin);
              return (
                <li key={s.id} className={`relative ${hl(s.id)}`}>
                  <span aria-hidden="true" className="absolute -left-[33px] top-1.5 h-4 w-4 rounded-full border-2 border-white bg-brand-700 ring-2 ring-marigold-300" />
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold text-ink">{s.name}</h3>
                    <Badge tone={phaseTone(s.phase)}>{s.isMain ? "main event" : s.phase === "pre" ? "before" : "after"}</Badge>
                  </div>
                  <p className="mt-0.5 flex items-center gap-1.5 text-base tabular-nums text-sand-800"><Clock size={16} aria-hidden="true" />{prettyDate(s.date)} · {hhmm(s.startMin)} – {hhmm(s.endMin)}</p>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-muted">
                    {s.venue && <span className="flex items-center gap-1"><MapPin size={14} aria-hidden="true" /> {s.venue}</span>}
                    {s.dressCode && <span className="flex items-center gap-1"><Shirt size={14} aria-hidden="true" /> {s.dressCode}</span>}
                  </div>
                  {blocks.length > 0 && (
                    <ul className="mt-2.5 grid gap-1.5 sm:grid-cols-2">
                      {blocks.filter(b => b.lane === "main" || b.anchored).map(b => (
                        <li key={b.id} className="flex items-center gap-2 rounded-lg bg-surface-muted px-3 py-2 text-sm">
                          <span className="w-[4.75rem] shrink-0 whitespace-nowrap font-semibold tabular-nums text-sand-800">{hhmm(b.startMin)}</span>
                          <span className="min-w-0 flex-1 break-words font-medium text-ink">{b.label}</span>
                          {b.anchored && <><Anchor size={14} aria-hidden="true" className="shrink-0 text-amber-700" /><span className="sr-only">fixed time</span></>}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        </Card>
        <div className="space-y-5">
          {renderSections(template.guest.aside, props)}
        </div>
      </div>
      {renderSections(template.guest.footer, props)}
    </div>
  );
}
