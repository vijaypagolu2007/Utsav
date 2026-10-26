"use client";
// v8 Part 1: /join/<eventId>?t=<join token>, opened from the organizer's WhatsApp group post. People add their own
// name, household size and (optionally) phone. That only files a pending request: nothing about the guest list is
// shown or returned, and the organizer approves each request before anyone gets a private RSVP link.
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { CheckCircle2, PartyPopper, ShieldCheck } from "lucide-react";
import ThemeSelect from "./ThemeSelect";
import { prettyDate } from "./ui";

type Info = { title: string; hosts: string; city: string; startDate: string; endDate: string; maxSize: number };
const readToken = () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("t"));

export default function JoinPage({ eventId }: { eventId: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", size: "1", phone: "", website: "" });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    let alive = true;
    const t = readToken();
    fetch(`/api/events/${encodeURIComponent(eventId)}/join?t=${encodeURIComponent(t ?? "")}`, { cache: "no-store" })
      .then(async r => {
        const j = await r.json().catch(() => ({})) as Info & { message?: string };
        if (!alive) return;
        if (r.ok) setInfo(j); else setError(j.message ?? "This join link isn't available.");
      })
      .catch(() => alive && setError("Couldn't reach the event. Check your connection and refresh."));
    return () => { alive = false; };
  }, [eventId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setFormError("Enter your name."); return; }
    setBusy(true); setFormError(null);
    try {
      const r = await fetch(`/api/events/${encodeURIComponent(eventId)}/join`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ t: readToken() ?? "", name: form.name.trim(), size: Number(form.size), ...(form.phone.trim() ? { phone: form.phone.trim() } : {}), ...(form.website ? { website: form.website } : {}) }) });
      const j = await r.json().catch(() => ({})) as { message?: string };
      if (r.status === 202) setDone(j.message ?? "Request sent.");
      else setFormError(j.message ?? `Couldn't send the request (error ${r.status}).`);
    } catch { setFormError("You seem to be offline. Try again in a moment."); }
    finally { setBusy(false); }
  };

  const shell = (children: ReactNode) => (
    <main className="mx-auto max-w-lg space-y-4 p-4 pb-16" data-testid="join-page">{children}<footer className="border-t border-line pt-4"><ThemeSelect className="max-w-60" /></footer></main>
  );
  if (error) return shell(<div className="rounded-2xl border border-line bg-surface p-6 text-center shadow-sm" role="alert" data-testid="join-error"><h1 className="mb-2 text-lg font-semibold text-ink">Join link unavailable</h1><p className="text-sm text-ink-muted">{error}</p></div>);
  if (!info) return shell(<p className="py-16 text-center text-sm text-ink-muted" aria-busy="true">Loading…</p>);
  const input = "mt-1 block min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base text-ink";
  return shell(
    <>
      <section className="hero-silk rounded-3xl p-5 text-white shadow-lg sm:p-6">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest"><PartyPopper size={14} aria-hidden="true" /> Join the guest list</div>
        <h1 className="mt-1 break-words text-2xl font-bold">{info.title}</h1>
        <p className="text-sm">{info.hosts ? `${info.hosts} · ` : ""}{info.city} · {prettyDate(info.startDate)}{info.endDate !== info.startDate ? ` – ${prettyDate(info.endDate)}` : ""}</p>
      </section>
      {done ? (
        <div role="status" className="rounded-2xl border border-line bg-surface p-5 shadow-sm" data-testid="join-done">
          <p className="flex items-center gap-2 text-base font-semibold text-ink"><CheckCircle2 size={18} aria-hidden="true" className="text-emerald-700" />Thank you!</p>
          <p className="mt-1 text-sm text-ink-muted">{done}</p>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-3 rounded-2xl border border-line bg-surface p-5 shadow-sm" data-testid="join-form">
          <p className="text-sm text-ink-muted">Add your household so the hosts can send you a personal RSVP link.</p>
          <label className="block text-sm font-medium text-ink">Your name <span aria-hidden="true" className="text-danger">*</span>
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required maxLength={80} autoComplete="name" data-testid="join-name"
              aria-invalid={formError ? true : undefined} aria-describedby={formError ? `${id}-err` : undefined} className={input} />
          </label>
          <label className="block text-sm font-medium text-ink">People in your household (you included)
            <select value={form.size} onChange={e => setForm({ ...form, size: e.target.value })} data-testid="join-size" className={input}>
              {Array.from({ length: info.maxSize }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium text-ink">WhatsApp number <span className="font-normal text-ink-muted">(optional, so the hosts can send your link)</span>
            <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} type="tel" inputMode="tel" autoComplete="tel" maxLength={40} data-testid="join-phone" className={input} />
          </label>
          {/* Honeypot: hidden from people and screen readers; a bot that fills it gets a polite answer and nothing is saved. */}
          <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
            <label>Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={e => setForm({ ...form, website: e.target.value })} name="website" data-testid="join-website" /></label>
          </div>
          {formError && <p id={`${id}-err`} role="alert" className="text-sm font-medium text-danger">{formError}</p>}
          <button type="submit" disabled={busy} data-testid="join-submit" className="min-h-11 w-full rounded-lg bg-primary px-4 text-base font-semibold text-white hover:bg-primary-hover disabled:opacity-50">{busy ? "Sending…" : "Ask to join"}</button>
          <p className="flex items-start gap-1.5 text-xs text-ink-muted"><ShieldCheck size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-emerald-700" />Only the hosts see your number. It is used to send your invitation and nothing else.</p>
        </form>
      )}
    </>
  );
}
