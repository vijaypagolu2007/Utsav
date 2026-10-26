"use client";
// Shared guest link (/guest/<eventId>#k=<token>). Renders only the server's public projection (src/guest-view.ts).
// Every action is a POST the server re-validates (Zod, rate limits, the reducer's guest allowlist and scope).
// v8 Part 1c (open RSVP): the event's one RSVP link (also a QR) opens a form: name, optional phone, party size, functions,
// meal, Coming / Maybe / Not coming. This browser keeps a random device token per event; the same device reopening the
// link gets "Welcome back" and edits the same RSVP. After sending, the confirmation shows the wishlist (claim and
// release). Nobody sees anyone else's RSVP. An old household link opens the same form.
import { useEffect, useId, useRef, useState } from "react";
import ThemeSelect from "./ThemeSelect";
import { Anchor, CalendarHeart, CircleAlert, Gift, HandHeart, Handshake, Lock, MapPin, PartyPopper, Pencil, Shirt, Utensils } from "lucide-react";
import type { GuestView } from "@/guest-view";
import { deviceTokenFor } from "@/guest-device";
import { ANSWER_LABEL, formatIst, MEAL_LABEL, RSVP_DUPLICATE_MESSAGE } from "@/rsvp";
import RsvpForm, { type RsvpFormValues } from "./RsvpForm";
import { Badge, Card, hhmm, prettyDate } from "./ui";
import { DEFAULT_SPONSOR_TIER, labelOf, SPONSOR_TIER_OPTIONS } from "@/config/planner-options";


function readToken(): string | null {
  const m = typeof window === "undefined" ? null : window.location.hash.match(/(?:^#|&)k=([A-Za-z0-9_-]{43})(?:&|$)/);
  return m ? m[1]! : null;
}

type Cmd = Record<string, unknown> & { op: string };

export default function PublicGuestPage({ eventId }: { eventId: string }) {
  const [token] = useState(readToken);
  const [view, setView] = useState<GuestView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** v8 Part 0c: the organizer deleted the event (410): a friendly page instead of an error. */
  const [removed, setRemoved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** v8 Part 1c: after a successful send the page shows the confirmation; "Edit" goes back to the form. */
  const [confirmed, setConfirmed] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  /** Which part of the page the last save came from, so a failure can be linked to it with aria-describedby. */
  const [source, setSource] = useState<string | null>(null);
  const noticeId = useId();
  const confirmRef = useRef<HTMLHeadingElement>(null);
  const [vol, setVol] = useState({ name: "", subEvent: "", shift: "" });
  const [spon, setSpon] = useState<{ name: string; tier: string }>({ name: "", tier: DEFAULT_SPONSOR_TIER });
  /** Only the RSVP link carries a device token: the public itinerary link has nothing to remember. */
  const headers = (): Record<string, string> => {
    const device = token ? deviceTokenFor(eventId) : null;
    return { "content-type": "application/json", ...(token ? { "x-guest-token": token } : {}), ...(device ? { "x-device-token": device } : {}) };
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const t = readToken();
        const device = t ? deviceTokenFor(eventId) : null;
        const r = await fetch(`/api/events/${encodeURIComponent(eventId)}/public`, { headers: { ...(t ? { "x-guest-token": t } : {}), ...(device ? { "x-device-token": device } : {}) }, cache: "no-store" });
        const body = await r.json().catch(() => ({})) as GuestView & { message?: string };
        if (!alive) return;
        if (r.status === 410) { setRemoved(true); return; }
        if (r.status !== 200) { setError(body.message ?? "This link isn't available."); return; }
        setView(body);
        if (body.mine?.duplicate) setDuplicate(true);
      } catch { if (alive) setError("Couldn't reach the event. Check your connection and refresh."); }
    })();
    return () => { alive = false; };
  }, [eventId]);
  useEffect(() => { if (confirmed) confirmRef.current?.focus(); }, [confirmed]);

  const sendRsvp = async (v: RsvpFormValues): Promise<string | null> => {
    setBusy(true); setNotice(null); setSource("rsvp");
    try {
      const r = await fetch(`/api/events/${encodeURIComponent(eventId)}/rsvp`, { method: "POST", headers: headers(), body: JSON.stringify({
        name: v.name, ...(v.phone ? { phone: v.phone } : {}), partySize: v.partySize, ...(v.kids !== null ? { kids: v.kids } : {}),
        functions: v.functions, meal: v.meal, answer: v.answer, ...(v.website ? { website: v.website } : {}) }) });
      const j = await r.json().catch(() => ({})) as { view?: GuestView; message?: string; duplicate?: boolean; result?: string };
      if (r.status === 410) { setRemoved(true); return null; }
      if (r.ok && j.view) { setView(j.view); setDuplicate(!!j.duplicate || !!j.view.mine?.duplicate); setConfirmed(true); return null; }
      if (r.ok) { setConfirmed(true); return null; }
      if (r.status === 403 && j.message && view) setView({ ...view, rsvp: view.rsvp && /ended/.test(j.message) ? { ...view.rsvp, closed: true } : view.rsvp });
      return r.status === 429 ? "Too many tries from this connection. Wait a few minutes, then send again." : j.message ?? `Not saved (error ${r.status}).`;
    } catch { return "Not saved: you seem to be offline. Try again in a moment."; }
    finally { setBusy(false); }
  };

  const act = async (commands: Cmd[], okText: string, from: string) => {
    setBusy(true); setNotice(null); setSource(from);
    try {
      const r = await fetch(`/api/events/${encodeURIComponent(eventId)}/guest`, { method: "POST", headers: headers(), body: JSON.stringify({ commands }) });
      const j = await r.json().catch(() => ({})) as { view?: GuestView; message?: string };
      if (r.status === 410) { setRemoved(true); return; }
      if (r.ok && j.view) { setView(j.view); setNotice(okText); } else setNotice(`Not saved: ${j.message ?? `error ${r.status}`}`);
    } catch { setNotice("Not saved: you seem to be offline."); }
    finally { setBusy(false); }
  };

  if (removed) return (
    <main className="grid min-h-screen place-items-center p-6" data-testid="guest-removed">
      <div className="max-w-md rounded-2xl bg-white p-6 text-center shadow">
        <h1 className="mb-2 text-lg font-semibold">This event was removed by the organizer</h1>
        <p className="text-sm text-sand-700">The invitation isn&apos;t available any more. If you think this is a mistake, ask the organizer: they can restore it.</p>
      </div>
    </main>
  );
  if (error) return <main className="grid min-h-screen place-items-center p-6"><div className="max-w-md rounded-2xl bg-white p-6 text-center shadow" role="alert"><h1 className="mb-2 text-lg font-semibold">Link unavailable</h1><p className="text-sm text-sand-600">{error}</p></div></main>;
  if (!view) return <main className="grid min-h-screen place-items-center text-sm text-sand-600" aria-busy="true">Loading your invitation…</main>;

  const mine = view.mine;
  const live = !!mine && !mine.removed;
  const form = view.rsvp;
  const fnName = (id: string) => form?.functions.find(f => f.id === id)?.name ?? "";
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
        {form?.closesAt && !form.closed && <p className="mt-2 text-sm" data-testid="rsvp-closes">Please reply by {formatIst(form.closesAt)}</p>}
      </section>

      {/* Always mounted so screen readers hear each save result (a live region added together with its text is often missed). */}
      <div role="status" aria-live="polite">{notice && <div id={noticeId} className={`rounded-xl px-4 py-2 text-sm text-white ${failed ? "bg-red-700" : "bg-sand-800"}`}>{notice}</div>}</div>

      {form && (
        <Card title={confirmed && live ? "Thank you!" : "RSVP"} icon={<Utensils size={16} className="text-emerald-700" />}>
          <div data-testid="rsvp-card">
            {mine?.removed ? (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="rsvp-removed"><CircleAlert size={16} aria-hidden="true" className="mr-1 inline" />This RSVP was removed by the organizer. Please contact them if this is a mistake.</p>
            ) : confirmed && mine ? (
              <div className="space-y-3" data-testid="rsvp-confirmation">
                <h2 ref={confirmRef} tabIndex={-1} className="text-base font-semibold text-ink">Your RSVP is saved, {mine.name}.</h2>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-ink-muted">Answer</dt><dd className="font-medium text-ink" data-testid="rsvp-summary-answer">{ANSWER_LABEL[mine.answer]}</dd>
                  <dt className="text-ink-muted">People</dt><dd className="font-medium tabular-nums text-ink" data-testid="rsvp-summary-party">{mine.partySize}{mine.kids ? ` (${mine.kids} kids)` : ""}</dd>
                  {mine.answer !== "not_coming" && <><dt className="text-ink-muted">Functions</dt><dd className="text-ink">{mine.functions.map(fnName).filter(Boolean).join(", ") || "None"}</dd>
                    <dt className="text-ink-muted">Meal</dt><dd className="text-ink">{MEAL_LABEL[mine.meal]}</dd></>}
                </dl>
                {duplicate && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="rsvp-duplicate"><CircleAlert size={16} aria-hidden="true" className="mr-1 inline" />{RSVP_DUPLICATE_MESSAGE}</p>}
                <p className="flex items-center gap-1 text-sm text-ink-muted"><Lock size={14} aria-hidden="true" /> Only you and the hosts see your answers. Open this link again on this phone to change them.</p>
                {!form.closed && <button type="button" onClick={() => setConfirmed(false)} data-testid="rsvp-edit" className="flex min-h-11 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-muted"><Pencil size={15} aria-hidden="true" />Edit your RSVP</button>}
              </div>
            ) : form.closed ? (
              <div className="space-y-2" data-testid="rsvp-closed">
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">RSVP period has ended{form.closesAt ? ` (${formatIst(form.closesAt)})` : ""}. Please contact the hosts if your plans changed.</p>
                {mine && <p className="text-sm text-ink" data-testid="rsvp-closed-mine">Your answer: {ANSWER_LABEL[mine.answer]}, {mine.partySize} {mine.partySize === 1 ? "person" : "people"}.</p>}
              </div>
            ) : (
              <>
                {mine
                  ? <p className="mb-3 text-sm font-medium text-ink" data-testid="rsvp-welcome-back">Welcome back, editing your RSVP.</p>
                  : <p className="mb-3 flex items-center gap-1 text-sm text-ink-muted"><Lock size={14} aria-hidden="true" /> Only you and the hosts see your answers.</p>}
                {duplicate && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="rsvp-duplicate"><CircleAlert size={16} aria-hidden="true" className="mr-1 inline" />{RSVP_DUPLICATE_MESSAGE}</p>}
                <RsvpForm key={mine?.updatedAt ?? "new"} functions={form.functions} askKids={form.askKids} maxParty={form.maxParty} busy={busy} honeypot
                  initial={mine ? { name: mine.name, partySize: mine.partySize, kids: mine.kids, functions: mine.functions, meal: mine.meal, answer: mine.answer, hasPhone: mine.hasPhone } : null}
                  submitLabel={mine ? "Update RSVP" : "Send RSVP"} onSubmit={sendRsvp} />
              </>
            )}
          </div>
        </Card>
      )}

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

      {view.mode === "public" && (
        <p className="rounded-xl bg-white p-3 text-sm text-sand-600 ring-1 ring-sand-200">To RSVP, open the RSVP link your hosts shared.</p>
      )}

      {view.wishlist && (view.wishlistKind === "wishlist" || view.wishlist.length > 0) && (
        <Card title={view.wishlistKind === "registry" ? "Gift registry" : "Wishlist"} icon={<Gift size={16} className="text-brand-600" />}>
          {view.claimsHidden && <p className="mb-2 text-sm text-sand-700" data-testid="claims-hidden">It&apos;s a surprise: claimed gifts aren&apos;t shown here. Send your RSVP to claim one.</p>}
          <ul className="space-y-1.5" data-testid="guest-wishlist">
            {view.wishlist.map(w => (
              <li key={w.id} className="flex flex-wrap items-center gap-2 text-sm" data-testid={`guest-wish-${w.id}`}>
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{w.item}{w.priority === "high" && <Badge tone="primary">most wanted</Badge>}
                  {/* A link the organiser typed: https only, opened by the guest's own browser, never fetched by the server. */}
                  {w.url && <a href={w.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center px-1 text-sm font-medium text-brand-800 underline">View<span className="sr-only"> {w.item} (opens a shop in a new tab)</span></a>}
                </span>
                {w.claimedByYou && live ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone="success">you&apos;re bringing this</Badge>
                    <button type="button" disabled={busy} aria-describedby={errFor(`wish-${w.id}`)} data-testid={`unclaim-${w.id}`}
                      onClick={() => void act([{ op: "claim_wishlist_item", itemId: w.id, guestId: null }], `Released ${w.item}`, `wish-${w.id}`)}
                      className="min-h-11 rounded-lg px-3 text-sm font-medium text-sand-800 ring-1 ring-sand-400 hover:bg-sand-50 disabled:opacity-50">Release<span className="sr-only">: {w.item}</span></button>
                  </span>
                ) : w.claimed ? <Badge tone="neutral">claimed</Badge>
                  : live ? <button type="button" disabled={busy} aria-describedby={errFor(`wish-${w.id}`)} data-testid={`claim-${w.id}`} onClick={() => void act([{ op: "claim_wishlist_item", itemId: w.id, guestId: mine!.entryId }], `You're bringing ${w.item}`, `wish-${w.id}`)}
                      className="min-h-11 rounded-lg bg-brand-700 px-4 text-sm font-medium text-white disabled:opacity-50">I&apos;ll bring this<span className="sr-only">: {w.item}</span></button>
                    : <span className="text-xs text-sand-600">{view.claimsHidden ? "on the list" : form ? "open (send your RSVP to claim)" : "open"}</span>}
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
