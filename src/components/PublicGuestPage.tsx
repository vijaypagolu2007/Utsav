"use client";
// Shared guest link (/guest/<eventId>#k=<household token>). Renders only the server's public projection
// (src/guest-view.ts). Every action is a POST the server re-validates: allowlisted op, household scope, reducer.
import { useEffect, useState } from "react";
import { Anchor, CalendarHeart, Gift, HandHeart, Handshake, MapPin, PartyPopper, Shirt, UserRound, Utensils } from "lucide-react";
import type { GuestView } from "@/guest-view";
import { Badge, Card, hhmm, prettyDate } from "./ui";

const ANSWERS = ["yes", "maybe", "no"] as const;
const DIETS = ["veg", "non-veg", "jain", "vegan", "no-onion-garlic", "gluten-free"];

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
  const [vol, setVol] = useState({ name: "", subEvent: "", shift: "" });
  const [spon, setSpon] = useState({ name: "", tier: "silver" });
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

  const act = async (commands: Cmd[], okText: string) => {
    setBusy(true); setNotice(null);
    try {
      const r = await fetch(`/api/events/${encodeURIComponent(eventId)}/guest`, { method: "POST", headers, body: JSON.stringify({ commands }) });
      const j = await r.json().catch(() => ({})) as { view?: GuestView; message?: string };
      if (r.ok && j.view) { setView(j.view); setNotice(okText); } else setNotice(`Not saved: ${j.message ?? `error ${r.status}`}`);
    } catch { setNotice("Not saved: you seem to be offline."); }
    finally { setBusy(false); }
  };

  if (error) return <main className="grid min-h-screen place-items-center p-6"><div className="max-w-md rounded-2xl bg-white p-6 text-center shadow" role="alert"><h1 className="mb-2 text-lg font-semibold">Link unavailable</h1><p className="text-sm text-slate-600">{error}</p></div></main>;
  if (!view) return <main className="grid min-h-screen place-items-center text-sm text-slate-500">Loading your invitation…</main>;

  const hh = view.household;
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4 pb-16" data-testid="public-guest-page">
      <section className="rounded-3xl bg-gradient-to-br from-amber-400 via-rose-500 to-violet-600 p-6 text-white shadow-lg">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest opacity-90"><PartyPopper size={14} /> You&apos;re invited</div>
        <h1 className="mt-1 text-2xl font-bold">{view.title}</h1>
        <p className="text-sm opacity-90">{view.hosts ? `${view.hosts} · ` : ""}{view.city} · {prettyDate(view.startDate)}{view.endDate !== view.startDate ? ` – ${prettyDate(view.endDate)}` : ""}</p>
        {hh && <p className="mt-2 text-sm"><UserRound size={14} className="inline" /> Welcome, {hh.label}</p>}
      </section>

      {notice && <div className="rounded-xl bg-slate-800 px-4 py-2 text-sm text-white" role="status">{notice}</div>}

      <Card title="Itinerary" icon={<CalendarHeart size={16} className="text-rose-500" />}>
        {view.subEvents.length === 0 && <p className="text-sm text-slate-500" data-testid="itinerary-empty">The hosts haven&apos;t published the itinerary yet. Check back soon.</p>}
        <ul className="space-y-2">
          {view.subEvents.map(s => (
            <li key={s.id} className="rounded-xl p-3 ring-1 ring-slate-100">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{s.name}</span>
                {s.isMain && <Badge tone="rose">main event</Badge>}
                <span className="text-xs text-slate-500">{prettyDate(s.date)} · {hhmm(s.startMin)}–{hhmm(s.endMin)}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-600">
                {s.venue && <span><MapPin size={12} className="inline" /> {s.venue}</span>}
                {s.dressCode && <span><Shirt size={12} className="inline" /> {s.dressCode}</span>}
              </div>
              {view.moments.filter(m => m.subEventId === s.id).map(m => (
                <div key={m.label} className="mt-1 text-xs text-amber-700"><Anchor size={11} className="inline" /> {m.label} at {hhmm(m.startMin)}</div>
              ))}
            </li>
          ))}
        </ul>
      </Card>

      {hh ? (
        <Card title="Your RSVP" icon={<Utensils size={16} className="text-emerald-600" />}>
          <div className="space-y-4">
            {hh.members.map(g => (
              <div key={g.id} className="rounded-xl p-3 ring-1 ring-slate-100">
                <div className="mb-2 text-sm font-semibold">{g.name}</div>
                <ul className="space-y-1.5">
                  {view.subEvents.filter(s => s.id in g.rsvp && s.collectsRsvp).map(s => (
                    <li key={s.id} className="flex flex-wrap items-center gap-2">
                      <span className="w-32 text-xs">{s.name}</span>
                      {ANSWERS.map(a => (
                        <button key={a} type="button" disabled={busy} aria-pressed={g.rsvp[s.id] === a}
                          onClick={() => void act([{ op: "set_rsvp", guestId: g.id, subEvent: s.slug, answer: a }], `${g.name}: ${a} for ${s.name}`)}
                          className={`rounded-full px-2.5 py-0.5 text-xs ring-1 ${g.rsvp[s.id] === a ? "bg-emerald-600 text-white ring-emerald-600" : "ring-slate-200 hover:bg-slate-50"}`}>{a}</button>
                      ))}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex flex-wrap gap-1.5" aria-label={`Meal preferences for ${g.name}`}>
                  {DIETS.map(d => {
                    const on = g.diet.includes(d);
                    return (
                      <button key={d} type="button" disabled={busy} aria-pressed={on}
                        onClick={() => void act([{ op: "set_guest_diet", guestId: g.id, diet: on ? g.diet.filter(x => x !== d) : [...g.diet, d] }], `Meal preferences saved for ${g.name}`)}
                        className={`rounded-full px-2 py-0.5 text-[11px] ring-1 ${on ? "bg-violet-600 text-white ring-violet-600" : "ring-slate-200 hover:bg-slate-50"}`}>{d}</button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <p className="rounded-xl bg-white p-3 text-xs text-slate-500 ring-1 ring-slate-100">To RSVP, open the personal link your host sent your household.</p>
      )}

      {view.wishlist && (
        <Card title="Wishlist" icon={<Gift size={16} className="text-violet-600" />}>
          <ul className="space-y-1.5">
            {view.wishlist.map(w => (
              <li key={w.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1">{w.item}{w.priority === "high" && <Badge tone="rose">most wanted</Badge>}</span>
                {w.claimed ? <Badge tone={w.claimedByYourHousehold ? "emerald" : "slate"}>{w.claimedByYourHousehold ? "you're bringing this" : "claimed"}</Badge>
                  : hh ? <button type="button" disabled={busy} onClick={() => void act([{ op: "claim_wishlist_item", itemId: w.id, guestId: hh.members[0]!.id }], `You're bringing ${w.item}`)}
                      className="rounded-lg bg-violet-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50">I&apos;ll bring this</button>
                    : <span className="text-xs text-slate-400">open</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {view.community && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card title="Volunteer" icon={<HandHeart size={16} className="text-emerald-600" />}>
            <form className="space-y-2" onSubmit={e => { e.preventDefault(); if (vol.name.trim()) void act([{ op: "community_signup", kind: "volunteer", name: vol.name.trim(), ...(vol.subEvent ? { subEvent: vol.subEvent } : {}), ...(vol.shift ? { shift: vol.shift } : {}) }], "Thanks for volunteering!").then(() => setVol({ name: "", subEvent: "", shift: "" })); }}>
              <input required maxLength={80} placeholder="Your name" aria-label="Volunteer name" value={vol.name} onChange={e => setVol({ ...vol, name: e.target.value })} className="w-full rounded border border-slate-300 px-2 py-1 text-sm" />
              <select aria-label="Sub-event" value={vol.subEvent} onChange={e => setVol({ ...vol, subEvent: e.target.value })} className="w-full rounded border border-slate-300 px-2 py-1 text-sm">
                <option value="">Any part of the event</option>
                {view.subEvents.map(s => <option key={s.id} value={s.slug}>{s.name}</option>)}
              </select>
              <input maxLength={60} placeholder="Shift (e.g. Gate 10 AM–1 PM)" aria-label="Shift" value={vol.shift} onChange={e => setVol({ ...vol, shift: e.target.value })} className="w-full rounded border border-slate-300 px-2 py-1 text-sm" />
              <button disabled={busy} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Sign up</button>
              <p className="text-[11px] text-slate-500">{view.community.volunteersSignedUp} signed up so far</p>
            </form>
          </Card>
          <Card title="Sponsor" icon={<Handshake size={16} className="text-sky-600" />}>
            <form className="space-y-2" onSubmit={e => { e.preventDefault(); if (spon.name.trim()) void act([{ op: "community_signup", kind: "sponsor", name: spon.name.trim(), tier: spon.tier }], "Thanks! The committee will reach out.").then(() => setSpon({ name: "", tier: "silver" })); }}>
              <input required maxLength={80} placeholder="Business or name" aria-label="Sponsor name" value={spon.name} onChange={e => setSpon({ ...spon, name: e.target.value })} className="w-full rounded border border-slate-300 px-2 py-1 text-sm" />
              <select aria-label="Tier" value={spon.tier} onChange={e => setSpon({ ...spon, tier: e.target.value })} className="w-full rounded border border-slate-300 px-2 py-1 text-sm">
                {view.community.sponsorTiers.map(t => <option key={t} value={t}>{t.replace("_", "-")}</option>)}
              </select>
              <button disabled={busy} className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Express interest</button>
            </form>
          </Card>
        </div>
      )}
    </main>
  );
}
