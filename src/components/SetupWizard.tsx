"use client";
// The setup form for a brand-new plan: first the basics, then the budget by category. Amounts the user types are kept
// exactly; categories left blank are filled from the remainder by code (largest remainder in paise) when the plan is
// created. The live preview here runs the same code (setup.ts) the server runs, so what you see is what you get.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Cake, Check, CheckCircle2, Heart, Loader2, Lock, Megaphone, Plus, ShieldCheck, Sparkles, type LucideIcon } from "lucide-react";
import { BUDGET_CATEGORIES, type BudgetCategory, type ExperienceLevel, type PriorityTier } from "@/schema";
import { LEVEL_HINT, LEVEL_LABEL } from "@/priorities";
import { constrainBudgetLines, defaultSetupCategories, resolveSetupBudget, STYLES, suggestedCategories, suggestionHints, defaultLabel,
  type SetupCategory, type SetupEventType, type SetupInputRaw } from "@/setup";
import { PlanError } from "@/commands";
import type { CreatePlanResult } from "./PlannerApp";
import { inr } from "./ui";

type Row = { category: BudgetCategory; include: boolean; raw: string; booked: boolean };
type Basics = {
  eventType: SetupEventType; style: string; title: string; partner1: string; partner2: string; honoree: string; age: string; organizer: string;
  city: string; startDate: string; endDate: string; guests: string; total: string; note: string;
};
const TYPES: { id: SetupEventType; label: string; blurb: string; icon: LucideIcon }[] = [
  { id: "wedding", label: "Wedding", blurb: "Ceremonies, family events and the reception", icon: Heart },
  { id: "birthday", label: "Birthday", blurb: "A kid's party at home to a grown-up night out", icon: Cake },
  { id: "community", label: "Community event", blurb: "Ganesh pandal, Navratri, Diwali mela or a fest", icon: Megaphone },
];
const STYLE_LABEL: Record<SetupEventType, string> = { wedding: "Tradition", birthday: "Kind of party", community: "Kind of event" };

/** "45000", "₹45,000" → rupees; "12%" or "12.5 %" → basis points; "" → blank. Never floats for money. */
export function parseAmount(raw: string): { ok: true; rupees: number | null; bps: number | null } | { ok: false; error: string } {
  const v = raw.replace(/[\s,₹]/g, "");
  if (!v) return { ok: true, rupees: null, bps: null };
  const pct = /^(\d{1,3})(?:\.(\d{1,2}))?%$/.exec(v);
  if (pct) {
    const bps = Number(pct[1]) * 100 + Number((pct[2] ?? "").padEnd(2, "0"));
    return bps <= 10_000 ? { ok: true, rupees: null, bps } : { ok: false, error: "A share can't be more than 100%." };
  }
  if (!/^\d+$/.test(v)) return { ok: false, error: "Use whole rupees like 45000, or a share like 12%." };
  const n = Number(v);
  return Number.isSafeInteger(n) && n <= 1_00_00_00_000 ? { ok: true, rupees: n, bps: null } : { ok: false, error: "That amount is too large." };
}
const wholeRupees = (raw: string) => { const v = raw.replace(/[\s,₹]/g, ""); return /^\d+$/.test(v) ? Number(v) : null; };

const field = "h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base text-ink sm:text-sm";
const labelCls = "block text-sm font-medium text-ink";

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={labelCls}>{label}</label>
      {hint && <p id={`${id}-hint`} className="mt-0.5 text-sm text-ink-muted">{hint}</p>}
      <div className="mt-1">{children}</div>
      {error && <p id={`${id}-err`} className="mt-1 text-sm font-medium text-danger">{error}</p>}
    </div>
  );
}

export default function SetupWizard({ onCreate, onCancel, cancelLabel = "Cancel", headingLevel = 1, onDone }: {
  onCreate: (s: SetupInputRaw) => Promise<CreatePlanResult>;
  onCancel?: () => void; cancelLabel?: string; headingLevel?: 1 | 2;
  onDone?: (r: Extract<CreatePlanResult, { ok: true }>) => void;
}) {
  const uid = useId();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  // v6: what matters most (step 2). Every category starts flexible; the organiser marks protect / cut first.
  const [tiers, setTiers] = useState<Partial<Record<BudgetCategory, PriorityTier>>>({});
  const [level, setLevel] = useState<ExperienceLevel>("balanced");
  const [b, setB] = useState<Basics>({ eventType: "wedding", style: STYLES.wedding[0].id, title: "", partner1: "", partner2: "", honoree: "", age: "", organizer: "",
    city: "", startDate: "", endDate: "", guests: "", total: "", note: "" });
  const [rows, setRows] = useState<Row[]>(() => defaultSetupCategories("wedding", STYLES.wedding[0].id).map(c => ({ category: c.category, include: true, raw: "", booked: false })));
  const [rowsFor, setRowsFor] = useState(`wedding/${STYLES.wedding[0].id}`);
  const [errors, setErrors] = useState<Partial<Record<keyof Basics, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstMount = useRef(true);
  const H = headingLevel === 1 ? "h1" : "h2";
  const set = <K extends keyof Basics>(k: K, v: Basics[K]) => setB(x => ({ ...x, [k]: v }));

  // Each step change moves focus to the step's heading, so keyboard and screen-reader users start at the top.
  useEffect(() => { if (firstMount.current) { firstMount.current = false; return; } headingRef.current?.focus(); }, [step]);

  const totalRupees = wholeRupees(b.total) ?? 0;
  const hints = useMemo(() => suggestionHints(b.eventType, b.style, totalRupees), [b.eventType, b.style, totalRupees]);
  const labels = useMemo(() => Object.fromEntries(suggestedCategories(b.eventType, b.style).map(s => [s.category, s.label])) as Partial<Record<BudgetCategory, string>>, [b.eventType, b.style]);
  const rowLabel = (c: BudgetCategory) => labels[c] ?? defaultLabel(c);

  const validateBasics = (): Partial<Record<keyof Basics, string>> => {
    const e: Partial<Record<keyof Basics, string>> = {};
    if (!b.city.trim()) e.city = "Enter the city.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.startDate)) e.startDate = "Pick the first day.";
    if (b.endDate && b.startDate && b.endDate < b.startDate) e.endDate = "The last day can't be before the first day.";
    const g = wholeRupees(b.guests);
    if (g === null || g < 1 || g > 100_000) e.guests = "Enter how many guests, like 150.";
    const t = wholeRupees(b.total);
    if (t === null || t < 1_000) e.total = "Enter the total in whole rupees, at least 1000.";
    if (b.age && (wholeRupees(b.age) === null || wholeRupees(b.age)! < 1 || wholeRupees(b.age)! > 120)) e.age = "Enter an age between 1 and 120, or leave it blank.";
    return e;
  };

  const goNext = (ev: FormEvent) => {
    ev.preventDefault();
    const e = validateBasics();
    setErrors(e);
    if (Object.keys(e).length) {
      const first = Object.keys(e)[0]!;
      document.getElementById(`${uid}-${first}`)?.focus();
      return;
    }
    const key = `${b.eventType}/${b.style}`;
    if (key !== rowsFor) {
      setRows(defaultSetupCategories(b.eventType, b.style).map(c => ({ category: c.category, include: true, raw: "", booked: false })));
      setRowsFor(key);
    }
    setSubmitError(null);
    setStep(2);
  };
  const toBudget = (ev: FormEvent) => { ev.preventDefault(); setStep(3); };
  const tierOf = (c: BudgetCategory): PriorityTier => tiers[c] ?? "flexible";

  // ---- step 2: live budget preview, computed by the same code the server uses
  const parsed = rows.map(r => ({ r, p: parseAmount(r.raw) }));
  const rowErrors = Object.fromEntries(parsed.filter(x => !x.p.ok || (x.r.include && x.r.booked && x.p.ok && x.p.rupees === null && x.p.bps === null))
    .map(x => [x.r.category, !x.p.ok ? x.p.error : "Enter the amount you booked."]));
  const cats: SetupCategory[] = parsed.map(({ r, p }) => ({ category: r.category, include: r.include, amountRupees: p.ok ? p.rupees : null, percentBps: p.ok ? p.bps : null, booked: r.booked && r.include }));
  const catsKey = JSON.stringify(cats);
  const preview = useMemo(() => {
    if (!totalRupees) return null;
    try {
      const res = resolveSetupBudget({ totalBudgetRupees: totalRupees, categories: cats.map(c => (c.booked && c.amountRupees === null && c.percentBps === null ? { ...c, booked: false } : c)) });
      const draft = suggestedCategories(b.eventType, b.style);
      const lines = constrainBudgetLines(draft, { eventType: b.eventType, style: b.style, totalBudgetRupees: totalRupees, categories: cats.map(c => (c.booked && c.amountRupees === null && c.percentBps === null ? { ...c, booked: false } : c)) });
      const per: Partial<Record<BudgetCategory, number>> = {};
      for (const l of lines) per[l.category] = (per[l.category] ?? 0) + l.plannedPaise;
      const fixed = res.fixed.reduce((a, f) => a + f.paise, 0);
      return { ok: true as const, fixed, remainder: res.remainderPaise, blank: res.blank.length, per, planned: lines.reduce((a, l) => a + l.plannedPaise, 0) };
    } catch (e) {
      return { ok: false as const, error: e instanceof PlanError ? e.message : "Check the amounts." };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catsKey is cats, serialised
  }, [catsKey, totalRupees, b.eventType, b.style]);
  const anyIncluded = rows.some(r => r.include);
  const canCreate = !creating && anyIncluded && Object.keys(rowErrors).length === 0 && preview?.ok === true;
  const missing = BUDGET_CATEGORIES.filter(c => !rows.some(r => r.category === c));
  const [addCat, setAddCat] = useState<string>("");

  const create = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!canCreate) {
      setSubmitError(!anyIncluded ? "Turn on at least one category." : Object.keys(rowErrors).length ? "Fix the highlighted amounts first." : preview && !preview.ok ? preview.error : "Check the amounts.");
      return;
    }
    const setup: SetupInputRaw = {
      eventType: b.eventType, style: b.style, title: b.title.trim(), city: b.city.trim(), startDate: b.startDate, ...(b.endDate && b.endDate !== b.startDate ? { endDate: b.endDate } : {}),
      guestCount: wholeRupees(b.guests)!, totalBudgetRupees: totalRupees, note: b.note.trim(), categories: cats,
      ...(b.eventType === "wedding" ? { partners: [b.partner1.trim(), b.partner2.trim()] as [string, string] } : {}),
      ...(b.eventType === "birthday" ? { honoree: b.honoree.trim(), turningAge: b.age ? wholeRupees(b.age) : null } : {}),
      ...(b.eventType === "community" ? { organizer: b.organizer.trim() } : {}),
      priorities: { protect: rows.filter(r => r.include && tierOf(r.category) === "protect").map(r => r.category),
        cutFirst: rows.filter(r => r.include && tierOf(r.category) === "cut_first").map(r => r.category), level },
    };
    setCreating(true);
    setSubmitError(null);
    const r = await onCreate(setup);
    setCreating(false);
    if (!r.ok) { setSubmitError([r.error, ...(r.issues ?? [])].join(" ")); return; }
    onDone?.(r);
  };

  const errId = (k: keyof Basics) => (errors[k] ? `${uid}-${k}-err` : undefined);
  const inputProps = (k: keyof Basics) => ({ id: `${uid}-${k}`, value: b[k] as string, onChange: (e: { target: { value: string } }) => set(k, e.target.value as never),
    "aria-invalid": errors[k] ? true : undefined, "aria-describedby": errId(k) });

  return (
    <div data-testid="setup-wizard" className="mx-auto w-full max-w-3xl rounded-xl border border-line bg-surface p-4 shadow-sm sm:p-8">
      <p className="text-sm font-semibold text-ink-muted">New plan · Step {step} of 3</p>
      <ol aria-label="Steps" className="mt-3 flex gap-2">
        {["About your event", "What matters most", "Budget by category"].map((t, i) => (
          <li key={t} aria-current={step === i + 1 ? "step" : undefined}
            className={`flex flex-1 items-center justify-center rounded-lg px-2 py-2 text-center text-xs font-medium leading-snug ring-1 ring-inset sm:px-3 sm:text-sm ${step === i + 1 ? "bg-brand-50 text-brand-800 ring-brand-200" : step > i + 1 ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-sand-100 text-sand-700 ring-sand-300"}`}>
            {step > i + 1 && <CheckCircle2 size={14} aria-hidden="true" className="mr-1.5 shrink-0" />}{t}
          </li>
        ))}
      </ol>

      {step === 1 ? (
        <form noValidate onSubmit={goNext} data-testid="setup-step-1" className="mt-8 space-y-6">
          <H ref={headingRef} tabIndex={-1} className="text-2xl font-semibold text-ink focus-visible:outline-offset-4">Tell us about your event</H>
          <fieldset>
            <legend className={labelCls}>What are you planning?</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {TYPES.map(t => {
                const on = b.eventType === t.id;
                const Icon = t.icon;
                return (
                  <label key={t.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${on ? "border-brand-700 bg-brand-50" : "border-line-strong bg-surface hover:bg-sand-50"}`}>
                    <input type="radio" name={`${uid}-type`} value={t.id} checked={on} className="mt-1 h-5 w-5 accent-brand-700"
                      onChange={() => setB(x => ({ ...x, eventType: t.id, style: STYLES[t.id][0].id }))} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 font-semibold text-ink"><Icon size={16} aria-hidden="true" className="text-brand-700" />{t.label}</span>
                      <span className="block text-sm text-ink-muted">{t.blurb}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`${uid}-style`} label={STYLE_LABEL[b.eventType]}>
              <select {...inputProps("style")} className={field}>
                {STYLES[b.eventType].map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </Field>
            <Field id={`${uid}-title`} label="Event name (optional)" hint="We'll suggest one if you leave it blank."><input {...inputProps("title")} aria-describedby={`${uid}-title-hint`} className={field} /></Field>
            {b.eventType === "wedding" && <>
              <Field id={`${uid}-partner1`} label="First partner's name (optional)"><input {...inputProps("partner1")} autoComplete="off" className={field} /></Field>
              <Field id={`${uid}-partner2`} label="Second partner's name (optional)"><input {...inputProps("partner2")} autoComplete="off" className={field} /></Field>
            </>}
            {b.eventType === "birthday" && <>
              <Field id={`${uid}-honoree`} label="Whose birthday? (optional)"><input {...inputProps("honoree")} autoComplete="off" className={field} /></Field>
              <Field id={`${uid}-age`} label="Turning (age, optional)" error={errors.age}><input {...inputProps("age")} inputMode="numeric" className={field} /></Field>
            </>}
            {b.eventType === "community" && (
              <Field id={`${uid}-organizer`} label="Organised by (optional)"><input {...inputProps("organizer")} placeholder="Residents' welfare association" className={field} /></Field>
            )}
            <Field id={`${uid}-city`} label="City" error={errors.city}><input {...inputProps("city")} autoComplete="address-level2" required className={field} /></Field>
            <Field id={`${uid}-guests`} label="How many guests?" error={errors.guests}><input {...inputProps("guests")} inputMode="numeric" required className={`${field} tabular-nums`} /></Field>
            <Field id={`${uid}-startDate`} label="First day" error={errors.startDate}><input {...inputProps("startDate")} type="date" required className={`${field} tabular-nums`} /></Field>
            <Field id={`${uid}-endDate`} label="Last day (for multi-day events)" error={errors.endDate}><input {...inputProps("endDate")} type="date" min={b.startDate || undefined} className={`${field} tabular-nums`} /></Field>
            <Field id={`${uid}-total`} label="Total budget (₹)" error={errors.total}>
              <span className="relative block"><span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">₹</span>
                <input {...inputProps("total")} inputMode="numeric" required className={`${field} pl-7 tabular-nums`} /></span>
            </Field>
          </div>
          <Field id={`${uid}-note`} label="Anything special? (optional)" hint="Traditions, a theme, must-haves, dietary needs. The AI uses this to personalise your plan and ideas.">
            <textarea {...inputProps("note")} aria-describedby={`${uid}-note-hint`} rows={3} maxLength={1000} className="w-full rounded-lg border border-line-strong bg-surface p-3 text-base text-ink sm:text-sm" />
          </Field>
          {Object.keys(errors).length > 0 && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700 ring-1 ring-red-200">Some answers need another look (marked above).</p>}
          <div className="flex flex-wrap justify-between gap-2">
            {onCancel ? <button type="button" onClick={onCancel} className="min-h-11 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium text-sand-800 hover:bg-sand-100">{cancelLabel}</button> : <span />}
            <button type="submit" className="flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-semibold text-white hover:bg-primary-hover">Next: priorities<ArrowRight size={16} aria-hidden="true" /></button>
          </div>
        </form>
      ) : step === 2 ? (
        <form noValidate onSubmit={toBudget} data-testid="setup-priorities" className="mt-8 space-y-6">
          <H ref={headingRef} tabIndex={-1} className="text-2xl font-semibold text-ink focus-visible:outline-offset-4">What matters most?</H>
          <p className="max-w-2xl text-sm text-ink-muted">If money gets tight, we cut from “Cut first” before anything else and never touch what you protect. You can change this any time on the Budget page.</p>
          <fieldset>
            <legend className={labelCls}>How lavish?</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {(["simple", "balanced", "premium"] as const).map(l => (
                <label key={l} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${level === l ? "border-brand-700 bg-brand-50" : "border-line-strong bg-surface hover:bg-sand-50"}`}>
                  <input type="radio" name={`${uid}-level`} value={l} checked={level === l} onChange={() => setLevel(l)} data-testid={`setup-level-${l}`} className="mt-0.5 h-6 w-6 shrink-0 accent-brand-700" />
                  <span className="min-w-0"><span className="block font-semibold text-ink">{LEVEL_LABEL[l]}</span><span className="block text-sm text-ink-muted">{LEVEL_HINT[l].split(": ")[1]}</span></span>
                </label>
              ))}
            </div>
          </fieldset>
          <ul className="divide-y divide-line-soft rounded-xl border border-line bg-surface">
            {rows.map(r => (
              <li key={r.category} data-testid={`setup-prio-${r.category}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 sm:px-4">
                <span id={`${uid}-prio-${r.category}`} className="font-medium text-ink">{rowLabel(r.category)}</span>
                <div role="radiogroup" aria-labelledby={`${uid}-prio-${r.category}`} className="flex flex-wrap gap-1.5">
                  {([["protect", "Protect"], ["flexible", "Flexible"], ["cut_first", "Cut first"]] as const).map(([t, l]) => (
                    <label key={t} className={`flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-700 ${tierOf(r.category) === t ? "border-brand-700 bg-brand-50 text-brand-800" : "border-line-strong bg-surface text-sand-800 hover:bg-sand-100"}`}>
                      <input type="radio" name={`${uid}-prio-${r.category}`} value={t} checked={tierOf(r.category) === t} onChange={() => setTiers(x => ({ ...x, [r.category]: t }))}
                        data-testid={`setup-prio-${r.category}-${t}`} className="sr-only" />
                      {tierOf(r.category) === t ? <Check size={14} aria-hidden="true" /> : t === "protect" ? <ShieldCheck size={14} aria-hidden="true" /> : null}{l}<span className="sr-only"> {rowLabel(r.category)}</span>
                    </label>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <p className="text-sm text-ink-muted" aria-live="polite" data-testid="setup-prio-summary">
            {(() => { const p = rows.filter(r => tierOf(r.category) === "protect").map(r => rowLabel(r.category)); const c = rows.filter(r => tierOf(r.category) === "cut_first").map(r => rowLabel(r.category));
              return p.length || c.length ? `Protecting ${p.join(", ") || "nothing"}; cutting ${c.join(", ") || "nothing"} first. Everything else is flexible.` : "Everything is flexible for now."; })()}
          </p>
          <div className="flex flex-wrap justify-between gap-2">
            <button type="button" onClick={() => setStep(1)} className="flex min-h-11 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium text-sand-800 hover:bg-sand-100"><ArrowLeft size={16} aria-hidden="true" />Back</button>
            <button type="submit" className="flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-semibold text-white hover:bg-primary-hover">Next: budget<ArrowRight size={16} aria-hidden="true" /></button>
          </div>
        </form>
      ) : (
        <form noValidate onSubmit={create} data-testid="setup-step-2" aria-busy={creating} className="mt-8 space-y-6">
          <H ref={headingRef} tabIndex={-1} className="text-2xl font-semibold text-ink focus-visible:outline-offset-4">Your budget by category</H>
          <p className="max-w-2xl text-sm text-ink-muted">Turn categories on or off. Type an amount (45000) or a share (12%) for any you already know, and tick “Already booked” for anything you’ve paid for or signed. Your amounts are kept exactly; the categories you leave blank share what’s left.</p>
          <div aria-live="polite" data-testid="setup-summary" className="grid grid-cols-3 gap-2 rounded-lg border border-line bg-surface-muted p-4 text-sm tabular-nums">
            <p><span className="block text-ink-muted">Total budget</span><span className="text-base font-semibold text-ink">{inr(totalRupees * 100)}</span></p>
            <p><span className="block text-ink-muted">You’ve set</span><span data-testid="setup-allocated" className="text-base font-semibold text-ink">{preview?.ok ? inr(preview.fixed) : "—"}</span></p>
            <p><span className="block text-ink-muted">{preview?.ok && preview.blank === 0 ? "Left unallocated" : "Left to share"}</span>
              <span data-testid="setup-remainder" className={`text-base font-semibold ${preview && !preview.ok ? "text-danger" : "text-ink"}`}>{preview?.ok ? inr(preview.remainder) : "Over budget"}</span>
              {preview?.ok && preview.blank > 0 && <span className="block text-ink-muted">across {preview.blank} blank categor{preview.blank === 1 ? "y" : "ies"}</span>}
            </p>
            {preview && !preview.ok && <p role="alert" className="col-span-3 font-medium text-danger">{preview.error}</p>}
          </div>
          <ul className="divide-y divide-line-soft rounded-xl border border-line bg-surface">
            {rows.map((r, i) => {
              const id = `${uid}-cat-${r.category}`;
              const h = hints[r.category];
              const err = rowErrors[r.category];
              const p = parsed[i]!.p;
              const typed = p.ok && (p.rupees !== null || p.bps !== null);
              const gets = preview?.ok ? preview.per[r.category] ?? 0 : null;
              const update = (patch: Partial<Row>) => setRows(rs => rs.map(x => x.category === r.category ? { ...x, ...patch } : x));
              return (
                <li key={r.category} data-testid={`setup-cat-${r.category}`} className={`grid gap-x-3 gap-y-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-center sm:px-4 ${r.include ? "" : "bg-sand-50"}`}>
                  <div className="flex min-w-0 items-start gap-3">
                    <input id={`${id}-on`} type="checkbox" checked={r.include} onChange={e => update({ include: e.target.checked, ...(e.target.checked ? {} : { booked: false }) })}
                      data-testid={`setup-include-${r.category}`} className="mt-0.5 h-6 w-6 shrink-0 accent-brand-700" />
                    <label htmlFor={`${id}-on`} className="min-w-0">
                      <span className={`block font-medium ${r.include ? "text-ink" : "text-ink-muted line-through"}`}>{rowLabel(r.category)}<span className="sr-only">{r.include ? " (included)" : " (left out)"}</span></span>
                      <span id={`${id}-hint`} className="block text-sm text-ink-muted">{h ? `Suggested ${h.pctLabel}${totalRupees ? ` · ${inr(h.paise)}` : ""}` : "Not in our suggestion"}</span>
                    </label>
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 sm:contents">
                  <div className="min-w-0">
                    <label htmlFor={`${id}-amt`} className="sr-only">Amount for {rowLabel(r.category)} (rupees or %)</label>
                    <span className="relative block">{!r.raw.includes("%") && <span aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-ink-muted">₹</span>}
                      <input id={`${id}-amt`} data-testid={`setup-amount-${r.category}`} value={r.raw} onChange={e => update({ raw: e.target.value })} disabled={!r.include}
                        placeholder="Auto" inputMode="decimal" autoComplete="off" aria-invalid={err ? true : undefined} aria-describedby={`${id}-hint ${id}-gets${err ? ` ${id}-err` : ""}`}
                        className={`h-11 w-full rounded-lg border bg-surface pl-6 pr-2 text-sm tabular-nums text-ink disabled:cursor-not-allowed disabled:bg-sand-100 ${err ? "border-danger" : "border-line-strong"}`} /></span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:justify-end">
                    <label className={`flex min-h-11 items-center gap-2 text-sm ${r.include ? "text-ink" : "text-ink-muted"}`}>
                      <input type="checkbox" checked={r.booked} disabled={!r.include} onChange={e => update({ booked: e.target.checked })} data-testid={`setup-booked-${r.category}`} className="h-6 w-6 shrink-0 accent-brand-700" />
                      Already booked<span className="sr-only"> {rowLabel(r.category)}</span>
                    </label>
                  </div>
                  </div>
                  <p id={`${id}-gets`} className="text-sm tabular-nums text-ink-muted sm:col-span-3 sm:-mt-1">
                    {!r.include ? "Left out of the plan."
                      : r.booked && typed ? <span className="inline-flex items-center gap-1 font-medium text-emerald-800"><Lock size={13} aria-hidden="true" />Booked: {gets !== null ? inr(gets) : ""} committed and locked</span>
                      : typed ? <>Kept exactly: <span className="font-medium text-ink">{gets !== null ? inr(gets) : ""}</span></>
                      : gets !== null ? <>Gets {inr(gets)} from what’s left</> : "Gets a share of what’s left"}
                  </p>
                  {err && <p id={`${id}-err`} className="text-sm font-medium text-danger sm:col-span-3">{err}</p>}
                </li>
              );
            })}
          </ul>
          {missing.length > 0 && (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label htmlFor={`${uid}-add`} className={labelCls}>Add a category</label>
                <select id={`${uid}-add`} value={addCat} onChange={e => setAddCat(e.target.value)} className={`${field} mt-1 w-60`}>
                  <option value="">Choose…</option>
                  {missing.map(c => <option key={c} value={c}>{defaultLabel(c)}</option>)}
                </select>
              </div>
              <button type="button" disabled={!addCat} onClick={() => { setRows(rs => [...rs, { category: addCat as BudgetCategory, include: true, raw: "", booked: false }]); setAddCat(""); }}
                className="flex min-h-11 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium text-sand-800 hover:bg-sand-100 disabled:cursor-not-allowed disabled:opacity-50">
                <Plus size={16} aria-hidden="true" />Add
              </button>
            </div>
          )}
          {submitError && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700 ring-1 ring-red-200">{submitError}</p>}
          {creating && (
            <div role="status" className="flex items-center gap-2 rounded-lg border border-line bg-surface-muted p-4 text-sm text-ink">
              <Loader2 size={16} aria-hidden="true" className="animate-spin text-brand-700" />Drafting your sub-events, tasks and timeline, then fitting them to your budget…
            </div>
          )}
          <div className="flex flex-wrap justify-between gap-2">
            <button type="button" onClick={() => setStep(2)} disabled={creating} className="flex min-h-11 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium text-sand-800 hover:bg-sand-100 disabled:opacity-50">
              <ArrowLeft size={16} aria-hidden="true" />Back
            </button>
            <button type="submit" disabled={creating} className="flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-semibold text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60">
              {creating ? <Loader2 size={16} aria-hidden="true" className="animate-spin" /> : <Sparkles size={16} aria-hidden="true" />}{creating ? "Creating your plan…" : "Create my plan"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
