"use client";
// Shared guest link (/guest/<eventId>#k=<household token>). Renders only the server's public projection
// (src/guest-view.ts). Every action is a POST the server re-validates: allowlisted op, household scope, reducer.
import { useEffect, useId, useState } from "react";
import ThemeSelect from "./ThemeSelect";
import { Anchor, CalendarHeart, Check, Gift, HandHeart, Handshake, MapPin, PartyPopper, Shirt, UserRound, Utensils } from "lucide-react";
import type { GuestView } from "@/guest-view";
import { Badge, Card, hhmm, prettyDate } from "./ui";
import { DEFAULT_SPONSOR_TIER, DIET_OPTIONS, GUEST_RSVP_ANSWERS, labelOf, SPONSOR_TIER_OPTIONS } from "@/config/planner-options";


function readToken(): string | null {
  const m = typeof window === "undefined" ? null : window.location.hash.match(/(?:^#|&)k=([A-Za-z0-9_-]{43})(?:&|$)/);
  return m ? m[1]! : null;
}

type Cmd = Record<string, unknown> & { op: string };

export default function PublicGuestPage({ eventId }: { eventId: string }) {
  const [token] = useState(readToken);
  const [view, setView] = useState<GuestView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which part of the page the last save came from, so a failure can be linked to it with aria-describedby. */
  const [source, setSource] = useState<string | null>(null);
  const noticeId = useId();
  const [vol, setVol] = useState({ name: "", subEvent: "", shift: "" });
  const [spon, setSpon] = useState<{ name: string; tier: string }>({ name: "", tier: DEFAULT_SPONSOR_TIER });
  const headers: Record<string, string> = { "content-type": "application/json", ...(token ? { "x-guest-token": token } : {}) };

  useEffect(() => {
    let alive = true;
    const t = readToken();
    fetch(`/api/events/${encodeURIComponent(eventId)}/public`, { headers: t ? { "x-guest-token": t } : {}, cache: "no-store" })
      .then(async r => {
        const j = await r.json().catch(() => ({}));
        if (!alive) return;
        if (r.ok) setView(j as GuestView); else setError((j as { message?: string }).message ?? "This link isn't available.");
      })
      .catch(() => alive && setError("Couldn't reach the event. Check your connection and refresh."));
    return () => { alive = false; };
  }, [eventId]);

  const act = async (commands: Cmd[], okText: string, from: string) => {
    setBusy(true); setNotice(null); setSource(from);
    try {
      const r = await fetch(`/api/events/${encodeURIComponent(eventId)}/guest`, { method: "POST", headers, body: JSON.stringify({ commands }) });
      const j = await r.json().catch(() => ({})) as { view?: GuestView; message?: string };
      if (r.ok && j.view) { setView(j.view); setNotice(okText); } else setNotice(`Not saved: ${j.message ?? `error ${r.status}`}`);
    } catch { setNotice("Not saved: you seem to be offline."); }
    finally { setBusy(false); }
  };

  if (error) return <main className="grid min-h-screen place-items-center p-6"><div className="max-w-md rounded-2xl bg-white p-6 text-center shadow" role="alert"><h1 className="mb-2 text-lg font-semibold">Link unavailable</h1><p className="text-sm text-sand-600">{error}</p></div></main>;
  if (!view) return <main className="grid min-h-screen place-items-center text-sm text-sand-600" aria-busy="true">Loading your invitation…</main>;

  const hh = view.household;
  const failed = !!notice?.startsWith("Not saved");
  /** aria-describedby for the control group whose save just failed. */
  const errFor = (from: string) => (failed && source === from ? noticeId : undefined);
  const input = "mt-1 block min-h-11 w-full rounded-lg border border-sand-500 bg-white px-3 text-base text-sand-900";
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4 pb-16" data-testid="public-guest-page">
      {/* hero-silk (globals.css): deep maroon-to-kumkum silk in both themes, white text at 4.5:1 or better everywhere on it. */}
      <section className="hero-silk rounded-3xl p-5 text-white shadow-lg sm:p-6">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest"><PartyPopper size={14} /> You&apos;re invited</div>
        <h1 className="mt-1 break-words text-2xl font-bold">{view.title}</h1>
        <p className="text-sm">{view.hosts ? `${view.hosts} · ` : ""}{view.city} · {prettyDate(view.startDate)}{view.endDate !== view.startDate ? ` – ${prettyDate(view.endDate)}` : ""}</p>
        {hh && <p className="mt-2 text-sm"><UserRound size={14} className="inline" /> Welcome, {hh.label}</p>}
      </section>

      {/* Always mounted so screen readers hear each save result (a live region added together with its text is often missed). */}
      <div role="status" aria-live="polite">{notice && <div id={noticeId} className={`rounded-xl px-4 py-2 text-sm text-white ${failed ? "bg-red-700" : "bg-sand-800"}`}>{notice}</div>}</div>

      <Card title="Itinerary" icon={<CalendarHeart size={16} className="text-brand-600" />}>
        {view.subEvents.length === 0 && <p className="text-sm text-sand-600" data-testid="itinerary-empty">The hosts haven&apos;t published the itinerary yet. Check back soon.</p>}
        <ul className="space-y-2">
          {view.subEvents.map(s => (
            <li key={s.id} className="rounded-xl p-3 ring-1 ring-sand-100">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">{s.name}</h3>
                {s.isMain && <Badge tone="primary">main event</Badge>}
                <span className="text-xs text-sand-600">{prettyDate(s.date)} · {hhmm(s.startMin)}–{hhmm(s.endMin)}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-3 text-xs text-sand-600">
                {s.venue && <span><MapPin size={12} className="inline" /> {s.venue}</span>}
                {s.dressCode && <span><Shirt size={12} className="inline" /> {s.dressCode}</span>}
              </div>
              {view.moments.filter(m => m.subEventId === s.id).map(m => (
                <div key={m.label} className="mt-1 text-xs text-amber-800"><Anchor size={11} className="inline" /> {m.label} at {hhmm(m.startMin)}</div>
              ))}
            </li>
          ))}
        </ul>
      </Card>

      {hh ? (
        <Card title="Your RSVP" icon={<Utensils size={16} className="text-emerald-600" />}>
          <div className="space-y-4">
            {hh.members.map(g => (
              <div key={g.id} className="rounded-xl p-3 ring-1 ring-sand-100">
                <h3 className="mb-2 text-sm font-semibold">{g.name}</h3>
                <ul className="space-y-1.5">
                  {view.subEvents.filter(s => s.id in g.rsvp && s.collectsRsvp).map(s => (
                    <li key={s.id} className="flex flex-wrap items-center gap-2">
                      <span className="w-32 text-sm" id={`rsvp-${g.id}-${s.id}`}>{s.name}</span>
                      <span role="group" aria-labelledby={`rsvp-${g.id}-${s.id}`} aria-describedby={errFor(`rsvp-${g.id}-${s.id}`)} className="flex flex-wrap gap-1.5">
                        {GUEST_RSVP_ANSWERS.map(a => (
                          <button key={a} type="button" disabled={busy} aria-pressed={g.rsvp[s.id] === a}
                            onClick={() => void act([{ op: "set_rsvp", guestId: g.id, subEvent: s.slug, answer: a }], `${g.name}: ${a} for ${s.name}`, `rsvp-${g.id}-${s.id}`)}
                            className={`flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-full px-4 text-sm ring-1 ${g.rsvp[s.id] === a ? "bg-emerald-700 text-white ring-emerald-700" : "text-sand-700 ring-sand-400 hover:bg-sand-50"}`}>{g.rsvp[s.id] === a && <Check size={14} aria-hidden="true" />}{a}<span className="sr-only">, {g.name}, {s.name}</span></button>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`Meal preferences for ${g.name}`} aria-describedby={errFor(`diet-${g.id}`)}>
                  {DIET_OPTIONS.map(({ value: d, label }) => {
                    const on = g.diet.includes(d);
                    return (
                      <button key={d} type="button" disabled={busy} aria-pressed={on}
                        onClick={() => void act([{ op: "set_guest_diet", guestId: g.id, diet: on ? g.diet.filter(x => x !== d) : [...g.diet, d] }], `Meal preferences saved for ${g.name}`, `diet-${g.id}`)}
                        className={`flex min-h-11 items-center gap-1 rounded-full px-4 text-sm ring-1 ${on ? "bg-brand-700 text-white ring-brand-700" : "text-sand-700 ring-sand-400 hover:bg-sand-50"}`}>{on && <Check size={14} aria-hidden="true" />}{label}</button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <p className="rounded-xl bg-white p-3 text-sm text-sand-600 ring-1 ring-sand-200">To RSVP, open the personal link your host sent your household.</p>
      )}

      {view.wishlist && (
        <Card title="Wishlist" icon={<Gift size={16} className="text-brand-600" />}>
          <ul className="space-y-1.5">
            {view.wishlist.map(w => (
              <li key={w.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{w.item}{w.priority === "high" && <Badge tone="primary">most wanted</Badge>}</span>
                {w.claimed ? <Badge tone={w.claimedByYourHousehold ? "success" : "neutral"}>{w.claimedByYourHousehold ? "you're bringing this" : "claimed"}</Badge>
                  : hh ? <button type="button" disabled={busy} aria-describedby={errFor(`wish-${w.id}`)} onClick={() => void act([{ op: "claim_wishlist_item", itemId: w.id, guestId: hh.members[0]!.id }], `You're bringing ${w.item}`, `wish-${w.id}`)}
                      className="min-h-11 rounded-lg bg-brand-700 px-4 text-sm font-medium text-white disabled:opacity-50">I&apos;ll bring this<span className="sr-only">: {w.item}</span></button>
                    : <span className="text-xs text-sand-600">open</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {view.community && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card title="Volunteer" icon={<HandHeart size={16} className="text-emerald-600" />}>
            <form className="space-y-2" onSubmit={e => { e.preventDefault(); if (vol.name.trim()) void act([{ op: "community_signup", kind: "volunteer", name: vol.name.trim(), ...(vol.subEvent ? { subEvent: vol.subEvent } : {}), ...(vol.shift ? { shift: vol.shift } : {}) }], "Thanks for volunteering!", "volunteer").then(() => setVol({ name: "", subEvent: "", shift: "" })); }}>
              <label className="block text-sm font-medium text-sand-800">Volunteer name <span aria-hidden="true" className="text-red-700">*</span>
                <input required maxLength={80} autoComplete="name" value={vol.name} aria-describedby={errFor("volunteer")} onChange={e => setVol({ ...vol, name: e.target.value })} className={input} />
              </label>
              <label className="block text-sm font-medium text-sand-800">Sub-event
                <select value={vol.subEvent} onChange={e => setVol({ ...vol, subEvent: e.target.value })} className={input}>
                  <option value="">Any part of the event</option>
                  {view.subEvents.map(s => <option key={s.id} value={s.slug}>{s.name}</option>)}
                </select>
              </label>
              <label className="block text-sm font-medium text-sand-800">Shift <span className="font-normal text-sand-600">(optional, e.g. Gate 10 AM–1 PM)</span>
                <input maxLength={60} value={vol.shift} onChange={e => setVol({ ...vol, shift: e.target.value })} className={input} />
              </label>
              <button disabled={busy} aria-describedby={errFor("volunteer")} className="min-h-11 rounded-lg bg-emerald-700 px-4 text-sm font-medium text-white disabled:opacity-50">Sign up</button>
              <p className="text-xs text-sand-600">{view.community.volunteersSignedUp} signed up so far</p>
            </form>
          </Card>
          <Card title="Sponsor" icon={<Handshake size={16} className="text-peacock-600" />}>
            <form className="space-y-2" onSubmit={e => { e.preventDefault(); if (spon.name.trim()) void act([{ op: "community_signup", kind: "sponsor", name: spon.name.trim(), tier: spon.tier }], "Thanks! The committee will reach out.", "sponsor").then(() => setSpon({ name: "", tier: DEFAULT_SPONSOR_TIER })); }}>
              <label className="block text-sm font-medium text-sand-800">Sponsor name <span className="font-normal text-sand-600">(business or your name)</span> <span aria-hidden="true" className="text-red-700">*</span>
                <input required maxLength={80} autoComplete="organization" value={spon.name} aria-describedby={errFor("sponsor")} onChange={e => setSpon({ ...spon, name: e.target.value })} className={input} />
              </label>
              <label className="block text-sm font-medium text-sand-800">Tier
                <select value={spon.tier} onChange={e => setSpon({ ...spon, tier: e.target.value })} className={input}>
                  {view.community.sponsorTiers.map(t => <option key={t} value={t}>{labelOf(SPONSOR_TIER_OPTIONS, t)}</option>)}
                </select>
              </label>
              <button disabled={busy} aria-describedby={errFor("sponsor")} className="min-h-11 rounded-lg bg-peacock-700 px-4 text-sm font-medium text-white disabled:opacity-50">Express interest</button>
            </form>
          </Card>
        </div>
      )}
      <footer className="border-t border-sand-200 pt-4"><ThemeSelect className="max-w-60" /></footer>
    </main>
  );
}
