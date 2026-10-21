"use client";
import { useState } from "react";
import { Anchor, CalendarHeart, Gift, Handshake, HandHeart, MapPin, Shirt, UserRound, Utensils } from "lucide-react";
import type { AgentState } from "@/schema";
import { daysBetween } from "@/commands";
import type { Commit, Highlight } from "./PlannerApp";
import { Badge, Card, Empty, hhmm, phaseTone, prettyDate, useHighlight } from "./ui";

type Props = {
  plan: AgentState; today: string; commit: Commit; highlight: Highlight;
  actingGuestId: string | null; setActingGuestId: (id: string) => void;
};

const ANSWERS = ["yes", "maybe", "no"] as const;
const DIETS = ["veg", "non-veg", "jain", "vegan", "no-onion-garlic", "gluten-free"];

function RsvpCard({ plan, commit, actingGuestId, setActingGuestId, highlight }: Props) {
  const hl = useHighlight(highlight);
  const me = plan.guests.find(g => g.id === actingGuestId);
  if (!plan.guests.length) return <Empty>The guest list isn&apos;t open yet.</Empty>;
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-xs text-slate-600">
        <UserRound size={14} /> You are
        <select value={actingGuestId ?? ""} onChange={e => setActingGuestId(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
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
                  <div className="min-w-0 flex-1"><div className="text-xs font-semibold">{s.name}</div><div className="text-[10px] text-slate-500">{prettyDate(s.date)} · {hhmm(s.startMin)}</div></div>
                  <div className="flex gap-1">
                    {ANSWERS.map(a => (
                      <button key={a} onClick={() => commit({ summary: `${me.name} · ${s.name}: ${a}`, commands: [{ op: "set_rsvp", guestId: me.id, subEvent: s.slug, answer: a }] })}
                        className={`rounded-md px-2.5 py-1 text-[11px] font-semibold capitalize ring-1 ${v === a
                          ? a === "yes" ? "bg-emerald-600 text-white ring-emerald-600" : a === "no" ? "bg-rose-600 text-white ring-rose-600" : "bg-amber-500 text-white ring-amber-500"
                          : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"}`}>{a}</button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          <div>
            <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-slate-600"><Utensils size={12} /> Dietary needs</div>
            <div className="flex flex-wrap gap-1">
              {DIETS.map(d => {
                const on = me.diet.includes(d);
                return (
                  <button key={d} onClick={() => commit({ summary: `${me.name} diet`, commands: [{ op: "set_guest_diet", guestId: me.id, diet: on ? me.diet.filter(x => x !== d) : [...me.diet, d] }] })}
                    className={`rounded-full px-2 py-0.5 text-[11px] ring-1 ${on ? "bg-violet-600 text-white ring-violet-600" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"}`}>{d}</button>
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
            <Gift size={14} className="text-violet-500" />
            <span className="min-w-0 flex-1 text-xs font-medium">{w.item} {w.priority === "high" && <Badge tone="rose">most wanted</Badge>}</span>
            {w.claimedByGuestId && !mine ? <Badge>claimed by {name(w.claimedByGuestId)}</Badge> : (
              <button disabled={!actingGuestId}
                onClick={() => commit({ summary: `${mine ? "Release" : "Claim"} ${w.item}`, commands: [{ op: "claim_wishlist_item", itemId: w.id, guestId: mine ? null : actingGuestId }] })}
                className={`rounded-md px-2.5 py-1 text-[11px] font-semibold ${mine ? "bg-emerald-600 text-white" : "bg-violet-600 text-white hover:bg-violet-700"} disabled:opacity-40`}>
                {mine ? "✓ Yours (release)" : "🎁 I'll bring this"}
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
  const [shift, setShift] = useState("Morning");
  const [org, setOrg] = useState("");
  const [tier, setTier] = useState<"title" | "gold" | "silver" | "in_kind">("silver");
  if (ext.type !== "community") return null;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <form className="space-y-2 rounded-xl p-3 ring-1 ring-slate-100" onSubmit={e => {
        e.preventDefault();
        if (name.trim()) { const r = commit({ summary: `${name} volunteers`, commands: [{ op: "community_signup", kind: "volunteer", name: name.trim(), subEvent: sub, shift }] }); if (r.ok) setName(""); }
      }}>
        <div className="flex items-center gap-1 text-xs font-semibold text-slate-700"><HandHeart size={13} className="text-emerald-600" /> Volunteer for a shift</div>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs" />
        <div className="flex gap-2">
          <select value={sub} onChange={e => setSub(e.target.value)} className="min-w-0 flex-1 rounded-md border border-slate-300 px-1 py-1 text-xs">
            {plan.subEvents.filter(s => s.visibility === "public").map(s => <option key={s.id} value={s.slug}>{s.name}</option>)}
          </select>
          <select value={shift} onChange={e => setShift(e.target.value)} className="rounded-md border border-slate-300 px-1 py-1 text-xs">
            {["Morning", "Afternoon", "Evening", "Setup crew", "Cleanup crew"].map(x => <option key={x}>{x}</option>)}
          </select>
        </div>
        <button className="w-full rounded-md bg-emerald-600 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">Sign me up</button>
        <p className="text-[10px] text-slate-500">{ext.volunteerSignups.length} signed up here · {ext.volunteers} volunteers total</p>
      </form>
      <form className="space-y-2 rounded-xl p-3 ring-1 ring-slate-100" onSubmit={e => {
        e.preventDefault();
        if (org.trim()) { const r = commit({ summary: `${org} sponsor interest`, commands: [{ op: "community_signup", kind: "sponsor", name: org.trim(), tier }] }); if (r.ok) setOrg(""); }
      }}>
        <div className="flex items-center gap-1 text-xs font-semibold text-slate-700"><Handshake size={13} className="text-violet-600" /> Sponsor the fest</div>
        <input value={org} onChange={e => setOrg(e.target.value)} placeholder="Business / organisation name" className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs" />
        <div className="flex flex-wrap gap-1">
          {(["title", "gold", "silver", "in_kind"] as const).map(t => (
            <button type="button" key={t} onClick={() => setTier(t)} className={`rounded-full px-2 py-0.5 text-[11px] capitalize ring-1 ${tier === t ? "bg-violet-600 text-white ring-violet-600" : "ring-slate-200"}`}>{t.replace("_", "-")}</button>
          ))}
        </div>
        <button className="w-full rounded-md bg-violet-600 py-1.5 text-xs font-semibold text-white hover:bg-violet-700">Register interest</button>
        <p className="text-[10px] text-slate-500">The committee follows up with the tier benefits.</p>
      </form>
    </div>
  );
}

/** Guest / Committee view: a public microsite with no money, vendors or internal tasks. */
export default function GuestMicrosite(props: Props) {
  const { plan, today, highlight } = props;
  const hl = useHighlight(highlight);
  const main = plan.subEvents.find(s => s.isMain);
  const dte = main ? daysBetween(today, main.date) : null;
  const ext = plan.event.ext;
  const subs = [...plan.subEvents].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-violet-700 via-fuchsia-600 to-amber-500 p-8 text-white shadow-lg">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] opacity-80">{plan.event.eventType === "wedding" ? "You're invited to celebrate" : plan.event.eventType === "birthday" ? "Party time" : "Join the community"}</div>
        <h1 className="mt-2 text-3xl font-bold leading-tight">{plan.event.title}</h1>
        <p className="mt-2 flex flex-wrap items-center gap-3 text-sm opacity-90">
          <span className="flex items-center gap-1"><CalendarHeart size={15} /> {prettyDate(plan.event.startDate)}{plan.event.endDate !== plan.event.startDate ? ` – ${prettyDate(plan.event.endDate)}` : ""}</span>
          <span className="flex items-center gap-1"><MapPin size={15} /> {plan.event.city}</span>
          {dte !== null && dte >= 0 && <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-semibold">{dte === 0 ? "Today!" : `${dte} days to go`}</span>}
        </p>
        {ext.type === "wedding" && ext.partners.some(Boolean) && <p className="mt-3 text-lg font-medium">{ext.partners.join(" & ")}</p>}
        {ext.type === "birthday" && <p className="mt-3 text-lg font-medium">{ext.honoree}{ext.turningAge ? ` turns ${ext.turningAge}` : ""} · {ext.theme}</p>}
        {ext.type === "community" && <p className="mt-3 text-lg font-medium">Hosted by {ext.organizer}</p>}
      </section>

      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <Card title="Live itinerary" icon={<CalendarHeart size={16} className="text-violet-600" />}>
          <ol className="relative space-y-4 border-l-2 border-violet-100 pl-5">
            {subs.map(s => {
              const blocks = plan.timeline.filter(b => b.subEventId === s.id).sort((a, b) => a.startMin - b.startMin);
              return (
                <li key={s.id} className={`relative ${hl(s.id)}`}>
                  <span className="absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-white bg-violet-500 ring-2 ring-violet-200" />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{s.name}</span>
                    <Badge tone={phaseTone(s.phase)}>{s.isMain ? "main event" : s.phase === "pre" ? "before" : "after"}</Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-slate-600">{prettyDate(s.date)} · {hhmm(s.startMin)} – {hhmm(s.endMin)}</div>
                  <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-slate-500">
                    {s.venue && <span className="flex items-center gap-1"><MapPin size={11} /> {s.venue}</span>}
                    {s.dressCode && <span className="flex items-center gap-1"><Shirt size={11} /> {s.dressCode}</span>}
                  </div>
                  {blocks.length > 0 && (
                    <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                      {blocks.filter(b => b.lane === "main" || b.anchored).map(b => (
                        <li key={b.id} className="flex items-center gap-2 rounded-md bg-slate-50 px-2 py-1 text-[11px]">
                          <span className="w-16 tabular-nums text-slate-500">{hhmm(b.startMin)}</span>
                          <span className="flex-1 font-medium text-slate-700">{b.label}</span>
                          {b.anchored && <Anchor size={11} className="text-amber-500" />}
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
          {plan.guests.length > 0 && <Card title="Your RSVP" icon={<UserRound size={16} className="text-emerald-600" />}><RsvpCard {...props} /></Card>}
          {ext.type === "birthday" && <Card title="Gift wishlist" icon={<Gift size={16} className="text-violet-600" />}><Wishlist {...props} /></Card>}
        </div>
      </div>
      {ext.type === "community" && <Card title="Get involved" icon={<HandHeart size={16} className="text-emerald-600" />}><CommunitySignup {...props} /></Card>}
    </div>
  );
}
