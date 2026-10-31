"use client";
// v8 Part 1c: the open RSVP form. One component for the guest's page (/guest/<id>#k=…) and the organizer's Guest View
// preview. Name, optional phone, party size, optional kids, functions, meal and answer; 44px targets throughout; native
// radios and checkboxes inside fieldsets with legends, so screen readers and keyboards get the standard behaviour.
// The caller sends what it returns; nothing here talks to the server.
import { useId, useState, type FormEvent } from "react";
import { Check, Minus, Plus, ShieldCheck } from "lucide-react";
import type { RsvpAnswer, RsvpMeal } from "@/schema";
import { ANSWER_LABEL, ANSWERS, MEAL_LABEL, MEALS } from "@/rsvp";

export type RsvpFormValues = { name: string; phone: string; partySize: number; kids: number | null; functions: string[]; meal: RsvpMeal; answer: RsvpAnswer; website: string };
export type RsvpFormInitial = Partial<Omit<RsvpFormValues, "phone" | "website">> & { hasPhone?: boolean };

type Props = {
  functions: { id: string; name: string; date?: string }[];
  askKids: boolean;
  maxParty?: number;
  initial?: RsvpFormInitial | null;
  busy?: boolean;
  submitLabel: string;
  /** Resolves to an error message to show, or null when it worked. */
  onSubmit: (v: RsvpFormValues) => Promise<string | null> | string | null;
  /** Show the honeypot field (the public page; the organizer's preview has no bots). */
  honeypot?: boolean;
};

const input = "mt-1 block min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base text-ink";
const pill = "flex min-h-11 cursor-pointer items-center gap-2 rounded-xl px-4 text-base ring-1 ring-inset has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-700";
const pillOn = "bg-brand-50 font-semibold text-brand-800 ring-2 ring-brand-700";
const pillOff = "bg-surface text-ink ring-line-strong hover:bg-surface-muted";

export default function RsvpForm({ functions, askKids, maxParty = 20, initial, busy, submitLabel, onSubmit, honeypot }: Props) {
  const id = useId();
  const [v, setV] = useState<RsvpFormValues>(() => ({
    name: initial?.name ?? "", phone: "", partySize: initial?.partySize ?? 1, kids: initial?.kids ?? (askKids ? 0 : null),
    functions: initial?.functions ?? [], meal: initial?.meal ?? "veg", answer: initial?.answer ?? "coming", website: "",
  }));
  const [err, setErr] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);
  const set = (patch: Partial<RsvpFormValues>) => { setV(x => ({ ...x, ...patch })); setErr(null); setField(null); };
  const attending = v.answer !== "not_coming";
  const clampParty = (n: number) => Math.max(1, Math.min(maxParty, Number.isFinite(n) ? Math.round(n) : 1));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = v.name.trim();
    if (!name) { setErr("Enter your name."); setField("name"); return; }
    if (attending && functions.length > 0 && v.functions.length === 0) { setErr("Pick at least one function you're attending."); setField("functions"); return; }
    if (askKids && (v.kids ?? 0) > v.partySize) { setErr("Kids can't be more than the party size."); setField("kids"); return; }
    const out = await onSubmit({ ...v, name, phone: v.phone.trim(), kids: askKids ? v.kids ?? 0 : null, functions: attending ? v.functions : [] });
    if (out) { setErr(out); setField(/phone/i.test(out) ? "phone" : null); }
  };
  const errId = `${id}-err`;
  const described = (f: string) => (err && field === f ? errId : undefined);
  return (
    <form onSubmit={e => void submit(e)} noValidate className="space-y-4" data-testid="rsvp-form">
      <label className="block text-sm font-medium text-ink">Your name <span aria-hidden="true" className="text-danger">*</span>
        <input value={v.name} onChange={e => set({ name: e.target.value })} maxLength={80} required autoComplete="name" data-testid="rsvp-name"
          aria-invalid={field === "name" ? true : undefined} aria-describedby={described("name")} className={input} />
      </label>
      <label className="block text-sm font-medium text-ink">WhatsApp number <span className="font-normal text-ink-muted">(optional)</span>
        <input value={v.phone} onChange={e => set({ phone: e.target.value })} type="tel" inputMode="tel" autoComplete="tel" maxLength={40} data-testid="rsvp-phone"
          placeholder={initial?.hasPhone ? "On file: leave blank to keep it" : "98480 12345"}
          aria-invalid={field === "phone" ? true : undefined} aria-describedby={[`${id}-phone-hint`, described("phone")].filter(Boolean).join(" ")} className={input} />
        <span id={`${id}-phone-hint`} className="mt-1 flex items-start gap-1 text-xs font-normal text-ink-muted"><ShieldCheck size={14} aria-hidden="true" className="mt-px shrink-0 text-emerald-700" />Indian numbers need no +91. Only the hosts see it; it helps them spot a family that answered twice.</span>
      </label>

      <fieldset>
        <legend className="text-sm font-medium text-ink">Will you come?</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {ANSWERS.map(a => (
            <label key={a} className={`${pill} ${v.answer === a ? pillOn : pillOff}`} data-testid={`rsvp-answer-${a}`}>
              <input type="radio" name={`${id}-answer`} value={a} checked={v.answer === a} onChange={() => set({ answer: a })} className="sr-only" />
              {v.answer === a && <Check size={16} aria-hidden="true" />}{ANSWER_LABEL[a]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-4">
        <div>
          <label htmlFor={`${id}-party`} className="block text-sm font-medium text-ink">People in your party</label>
          <div className="mt-1 flex items-center gap-1.5">
            <button type="button" onClick={() => set({ partySize: clampParty(v.partySize - 1) })} disabled={v.partySize <= 1} data-testid="rsvp-party-minus"
              className="grid h-11 w-11 place-items-center rounded-lg border border-line-strong bg-surface text-ink hover:bg-surface-muted disabled:opacity-50"><Minus size={18} aria-hidden="true" /><span className="sr-only">One fewer person</span></button>
            <input id={`${id}-party`} type="number" inputMode="numeric" min={1} max={maxParty} value={v.partySize} data-testid="rsvp-party"
              onChange={e => set({ partySize: clampParty(Number(e.target.value)) })} aria-describedby={`${id}-party-hint`}
              className="h-11 w-20 rounded-lg border border-line-strong bg-surface px-3 text-center text-base tabular-nums text-ink" />
            <button type="button" onClick={() => set({ partySize: clampParty(v.partySize + 1) })} disabled={v.partySize >= maxParty} data-testid="rsvp-party-plus"
              className="grid h-11 w-11 place-items-center rounded-lg border border-line-strong bg-surface text-ink hover:bg-surface-muted disabled:opacity-50"><Plus size={18} aria-hidden="true" /><span className="sr-only">One more person</span></button>
          </div>
          <p id={`${id}-party-hint`} className="mt-1 text-xs text-ink-muted">You included, 1 to {maxParty}.</p>
        </div>
        {askKids && (
          <label className="block text-sm font-medium text-ink">Of them, kids
            <input type="number" inputMode="numeric" min={0} max={v.partySize} value={v.kids ?? 0} data-testid="rsvp-kids"
              onChange={e => set({ kids: Math.max(0, Math.min(maxParty, Math.round(Number(e.target.value) || 0))) })}
              aria-invalid={field === "kids" ? true : undefined} aria-describedby={described("kids")}
              className="mt-1 block h-11 w-20 rounded-lg border border-line-strong bg-surface px-3 text-center text-base tabular-nums text-ink" />
          </label>
        )}
      </div>

      {attending && functions.length > 0 && (
        <fieldset aria-describedby={described("functions")}>
          <legend className="text-sm font-medium text-ink">Functions you&apos;re attending</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {functions.map(f => {
              const on = v.functions.includes(f.id);
              return (
                <label key={f.id} className={`${pill} ${on ? pillOn : pillOff}`} data-testid={`rsvp-fn-${f.id}`}>
                  <input type="checkbox" checked={on} onChange={() => set({ functions: on ? v.functions.filter(x => x !== f.id) : [...v.functions, f.id] })} className="sr-only" />
                  {on && <Check size={16} aria-hidden="true" />}{f.name}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
      {attending && (
        <fieldset>
          <legend className="text-sm font-medium text-ink">Meal</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {MEALS.map(m => (
              <label key={m} className={`${pill} ${v.meal === m ? pillOn : pillOff}`} data-testid={`rsvp-meal-${m}`}>
                <input type="radio" name={`${id}-meal`} value={m} checked={v.meal === m} onChange={() => set({ meal: m })} className="sr-only" />
                {v.meal === m && <Check size={16} aria-hidden="true" />}{MEAL_LABEL[m]}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {honeypot && (
        // Honeypot: hidden from people and screen readers; a bot that fills it gets a polite answer and nothing is saved.
        <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
          <label>Website<input tabIndex={-1} autoComplete="off" value={v.website} onChange={e => setV(x => ({ ...x, website: e.target.value }))} name="website" data-testid="rsvp-website" /></label>
        </div>
      )}
      {err && <p id={errId} role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700" data-testid="rsvp-error">{err}</p>}
      <button type="submit" disabled={busy} data-testid="rsvp-submit" className="min-h-11 w-full rounded-lg bg-primary px-4 text-base font-semibold text-white hover:bg-primary-hover disabled:opacity-50 sm:w-auto">
        {busy ? "Sending…" : submitLabel}
      </button>
    </form>
  );
}
