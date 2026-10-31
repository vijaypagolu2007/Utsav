"use client";
import { Fragment, useState, type ReactNode } from "react";
import { Anchor, CalendarHeart, Check, Clock, Gift, Handshake, HandHeart, MapPin, Shirt, UserRound } from "lucide-react";
import type { AgentState, SponsorTier } from "@/schema";
import { daysBetween } from "@/commands";
import type { Commit, Highlight } from "./PlannerApp";
import { Badge, Card, hhmm, phaseTone, prettyDate, useHighlight } from "./ui";
import { formatTokens, templateTokens, type EventTemplate, type GuestSectionId } from "@/config/event-templates";
import { DEFAULT_SPONSOR_TIER, SPONSOR_TIER_OPTIONS, VOLUNTEER_SHIFTS } from "@/config/planner-options";
import { ANSWER_LABEL, rsvpFunctions } from "@/rsvp";
import RsvpForm from "./RsvpForm";

type Props = {
  template: EventTemplate;
  plan: AgentState; today: string; commit: Commit; highlight: Highlight;
  actingEntryId: string | null; setActingEntryId: (id: string) => void;
  /** Optional guest-facing summary figures (no money), shown under the invitation. */
  summary?: ReactNode;
};

const big = "min-h-11 rounded-lg px-3.5 text-sm font-semibold";
const field = "mt-1 block min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base font-normal text-ink";

/** A fresh RSVP entry id for a Guest View preview answer (the real link gets its id from the server). */
const previewEntryId = () => `r-preview-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * v8 Part 1c: Guest View shows the same open RSVP form a guest gets on the RSVP link. "Answering as" picks one of the
 * RSVPs already sent (to preview editing it) or a new one; every answer is a submit_rsvp_entry with role "guest".
 */
function RsvpCard({ plan, commit, actingEntryId, setActingEntryId }: Props) {
  const live = plan.rsvpEntries.filter(e => !e.removedAt && !e.mergedInto);
  const me = live.find(e => e.id === actingEntryId) ?? null;
  const [saved, setSaved] = useState<string | null>(null);
  const fns = rsvpFunctions(plan);
  return (
    <div className="space-y-4">
      {live.length > 0 && (
        <label className="block text-sm font-medium text-sand-800">
          <span className="flex items-center gap-1.5"><UserRound size={16} aria-hidden="true" /> Answering as</span>
          <select value={me?.id ?? ""} onChange={e => { setActingEntryId(e.target.value); setSaved(null); }} className={field} data-testid="guest-acting-entry">
            <option value="">A new guest</option>
            {live.slice(0, 200).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
      )}
      <RsvpForm key={me?.id ?? "new"} functions={fns.map(s => ({ id: s.id, name: s.name, date: s.date }))} askKids={plan.rsvpSettings.askKids}
        initial={me ? { name: me.name, partySize: me.partySize, kids: me.kids, functions: me.functions, meal: me.meal, answer: me.answer, hasPhone: !!me.phone } : null}
        submitLabel={me ? "Update RSVP" : "Send RSVP"}
        onSubmit={v => {
          const entryId = me?.id ?? previewEntryId();
          const r = commit({ summary: `RSVP from ${v.name}`, commands: [{ op: "submit_rsvp_entry", entryId, name: v.name, ...(v.phone ? { phone: v.phone } : {}),
            partySize: v.partySize, ...(v.kids !== null ? { kids: v.kids } : {}), functions: v.functions, meal: v.meal, answer: v.answer }] });
          if (!r.ok) return r.reason;
          setActingEntryId(entryId); setSaved(`Saved ${v.name}'s RSVP (${v.partySize}, ${ANSWER_LABEL[v.answer]}).`);
          return null;
        }} />
      <p role="status" className="text-sm text-ink-muted empty:hidden">{saved}</p>
    </div>
  );
}

function Wishlist({ plan, commit, actingEntryId, highlight }: Props) {
  const hl = useHighlight(highlight);
  const ext = plan.event.ext;
  if (ext.type !== "birthday" && ext.type !== "wedding") return null;
  // Surprise mode (v8 Part 1): the preview never names who claimed a gift.
  const name = (id: string | null) => (ext.wishlistSurprise ? null : plan.guests.find(g => g.id === id)?.name ?? plan.rsvpEntries.find(e => e.id === id)?.name);
  return (
    <ul className="space-y-2">
      {ext.wishlist.map(w => {
        const mine = !!actingEntryId && w.claimedByGuestId === actingEntryId;
        return (
          <li key={w.id} className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl p-3 ring-1 ring-inset ring-line ${hl(w.id)}`}>
            <Gift size={18} aria-hidden="true" className="shrink-0 text-brand-700" />
            <span className="min-w-0 flex-1 basis-32 text-base font-medium text-ink">{w.item} {w.priority === "high" && <Badge tone="primary">most wanted</Badge>}</span>
            {w.claimedByGuestId && !mine ? <Badge>{name(w.claimedByGuestId) ? `claimed by ${name(w.claimedByGuestId)}` : "claimed"}</Badge> : (
              <button type="button" disabled={!actingEntryId} title={actingEntryId ? undefined : "Send an RSVP first"}
                onClick={() => actingEntryId && commit({ summary: mine ? `Release ${w.item}` : `Claim ${w.item}`, commands: [{ op: "claim_wishlist_item", itemId: w.id, guestId: mine ? null : actingEntryId }] })}
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
  "guest-rsvp": p => rsvpFunctions(p.plan).length > 0 && <Card title="Your RSVP" subtitle="The same form guests get on the RSVP link: one per family." icon={<UserRound size={18} className="text-emerald-700" />}><RsvpCard {...p} /></Card>,
  "guest-wishlist": p => {
    const x = p.plan.event.ext;
    if (x.type === "birthday") return <Card title="Gift wishlist" subtitle="Claim a gift so nobody doubles up." icon={<Gift size={18} className="text-brand-700" />}><Wishlist {...p} /></Card>;
    // v8 Part 1: the wedding gift registry, shown once the couple has added a gift.
    if (x.type === "wedding" && x.wishlist.length > 0) return <Card title="Gift registry" subtitle="Claim a gift so nobody doubles up." icon={<Gift size={18} className="text-brand-700" />}><Wishlist {...p} /></Card>;
    return null;
  },
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
    <div className="mx-auto w-full max-w-5xl space-y-6">
      {/* hero-silk (globals.css): deep maroon-to-kumkum silk in both themes, white text at 4.5:1 or better everywhere on it. */}
      <section className="hero-silk overflow-hidden rounded-2xl p-6 text-white shadow-lg sm:p-8 lg:p-10">
        <p className="text-sm font-semibold uppercase tracking-wider">{template.guest.kicker}</p>
        <h1 tabIndex={-1} className="mt-3 break-words text-3xl font-semibold leading-tight focus-visible:outline-offset-4 sm:text-4xl">{plan.event.title}</h1>
        <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-base">
          <span className="flex items-center gap-1.5 tabular-nums"><CalendarHeart size={18} aria-hidden="true" /> {prettyDate(plan.event.startDate)}{plan.event.endDate !== plan.event.startDate ? ` – ${prettyDate(plan.event.endDate)}` : ""}</span>
          <span className="flex items-center gap-1.5"><MapPin size={18} aria-hidden="true" /> {plan.event.city}</span>
          {dte !== null && dte >= 0 && <span className="rounded-full bg-black/30 px-3 py-0.5 text-sm font-semibold tabular-nums">{dte === 0 ? "Today!" : `${dte} days to go`}</span>}
        </p>
        {tagline && <p className="mt-3 text-xl font-medium">{tagline}</p>}
      </section>
      {summary}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start">
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
                  <p className="mt-1 flex items-center gap-1.5 text-base tabular-nums text-sand-800"><Clock size={16} aria-hidden="true" />{prettyDate(s.date)} · {hhmm(s.startMin)} – {hhmm(s.endMin)}</p>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-muted">
                    {s.venue && <span className="flex items-center gap-1"><MapPin size={14} aria-hidden="true" /> {s.venue}</span>}
                    {s.dressCode && <span className="flex items-center gap-1"><Shirt size={14} aria-hidden="true" /> {s.dressCode}</span>}
                  </div>
                  {blocks.length > 0 && (
                    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
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
        <div className="space-y-6">
          {renderSections(template.guest.aside, props)}
        </div>
      </div>
      {renderSections(template.guest.footer, props)}
    </div>
  );
}
