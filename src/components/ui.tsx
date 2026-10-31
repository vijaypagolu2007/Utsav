"use client";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { BadgeCheck, Calculator, Check, CircleHelp, FileText, Pencil, X } from "lucide-react";
import { FIGURE_HINT, FIGURE_LABEL, type FigureKind } from "@/vendors";
import { daysBetween, MAX_DIRECT_AMOUNT_PAISE, MAX_NAME_LENGTH, weekdayOf, type BatchInput, type BatchResult } from "@/commands";
import { formatMinute } from "@/diff";

/** ₹ with Indian digit grouping: 15000000 paise → ₹1,50,000. */
export { inr } from "@/budget-a11y";
/** Compact lakh/crore form for tight spots: ₹25L, ₹1.5L, ₹80K. */
export { inrShort } from "@/budget-a11y";
export const hhmm = formatMinute;
const monthShort = (dt: Date) => dt.toLocaleString("en-IN", { month: "short", timeZone: "UTC" });
const weekday3 = (d: string) => weekdayOf(d).slice(0, 3).replace(/^./, c => c.toUpperCase());
/** "Thu, 22 Oct" */
export const prettyDate = (d: string) => {
  const dt = new Date(d + "T00:00:00Z");
  return `${weekday3(d)}, ${dt.getUTCDate()} ${monthShort(dt)}`;
};
/** "Thu, 22 Oct 2026": the en-IN form shown wherever a full date is needed (never the US 10/22/2026). */
export const longDate = (d: string) => `${prettyDate(d)} ${new Date(d + "T00:00:00Z").getUTCFullYear()}`;
export const relDays = (today: string, d: string) => {
  const n = daysBetween(today, d);
  return n === 0 ? "today" : n > 0 ? `in ${n}d` : `${-n}d ago`;
};

export function useHighlight(hl: { ids: Set<string>; key: number }) {
  return (id: string) => (hl.ids.has(id) ? (hl.key % 2 ? "hl-a" : "hl-b") : "");
}

// ---------- responsive hooks (one rendered variant at a time, so no control exists twice in the DOM) ----------
/**
 * True while the media query matches. The server snapshot (and the very first client render) uses `serverDefault`,
 * so server-rendered markup is deterministic; the planner itself renders client-only.
 */
export function useMediaQuery(query: string, serverDefault = true): boolean {
  return useSyncExternalStore(
    cb => { const m = window.matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => window.matchMedia(query).matches,
    () => serverDefault,
  );
}

// ---------- building blocks ----------
/** A section's h2 with a short subtitle under it. */
export function SectionHeader({ title, subtitle, icon, id, right, level = 2 }: { title: string; subtitle?: ReactNode; icon?: ReactNode; id?: string; right?: ReactNode; level?: 2 | 3 }) {
  const H = level === 2 ? "h2" : "h3";
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1 basis-56">
        <H id={id} className={`flex min-w-0 items-center gap-2 font-semibold text-ink [text-wrap:balance] ${level === 2 ? "text-lg leading-snug" : "text-base leading-snug"}`}>{icon && <span aria-hidden="true" className="grid shrink-0 place-items-center">{icon}</span>}{title}</H>
        {subtitle && <p className="mt-1 text-sm leading-relaxed text-ink-muted">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

/** A titled panel: a labelled region (section + h2) so screen-reader users can jump between panels. */
export function Card({ title, subtitle, icon, right, children, className = "", id, bodyClassName = "" }: { title: string; subtitle?: ReactNode; icon?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; id?: string; bodyClassName?: string }) {
  const hid = `${useId()}-h`;
  return (
    <section id={id} tabIndex={id ? -1 : undefined} aria-labelledby={hid} className={`min-w-0 rounded-xl border border-line bg-surface shadow-sm focus-visible:outline-offset-4 ${className}`}>
      <header className="border-b border-line-soft px-4 py-4 sm:px-6">
        <SectionHeader id={hid} title={title} subtitle={subtitle} icon={icon} right={right} />
      </header>
      <div className={`p-4 sm:p-6 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

// ---------- buttons ----------
/**
 * One button recipe for the whole app (ui-ux-pro-max shadcn "component variants"): primary, secondary (outlined),
 * ghost (text) and danger (outlined red). Sizes: sm 32px, md 36px (44px below 768px and on coarse pointers), lg 44px.
 * Colour, border and shadow ease over 200ms (globals.css); active goes one step darker; disabled dims and stops the pointer.
 */
const BUTTON_VARIANT = {
  primary: "bg-primary text-white shadow-sm hover:bg-primary-hover active:bg-brand-900",
  secondary: "border border-line-strong bg-surface text-sand-800 hover:bg-sand-100 active:bg-sand-200",
  ghost: "text-brand-800 hover:bg-brand-50 active:bg-brand-100",
  danger: "border border-red-600 bg-surface text-red-700 hover:bg-red-50 active:bg-red-100",
} as const;
const BUTTON_SIZE = {
  sm: "min-h-8 px-3 max-md:min-h-11 pointer-coarse:min-h-11",
  md: "min-h-9 px-4 max-md:min-h-11 pointer-coarse:min-h-11",
  lg: "min-h-11 px-5",
} as const;
export type ButtonVariant = keyof typeof BUTTON_VARIANT;
export const buttonClass = (variant: ButtonVariant = "secondary", size: keyof typeof BUTTON_SIZE = "md", className = "") =>
  `inline-flex shrink-0 items-center justify-center gap-2 rounded-lg text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_SIZE[size]} ${BUTTON_VARIANT[variant]} ${className}`;
export function Button({ variant = "secondary", size = "md", className = "", type = "button", ...rest }: { variant?: ButtonVariant; size?: keyof typeof BUTTON_SIZE } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} {...rest} className={buttonClass(variant, size, className)} />;
}

/**
 * Status and accent tints (soft background, dark text, matching ring). Semantic names; the Utsav palette behind them:
 * warm sand neutrals, kumkum primary, maroon secondary, peacock info, marigold gold, and emerald / amber / red status.
 */
const TONES = {
  neutral: "bg-sand-100 text-sand-700 ring-sand-300",
  success: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  warning: "bg-amber-50 text-amber-800 ring-amber-200",
  danger: "bg-red-50 text-red-700 ring-red-200",
  info: "bg-peacock-50 text-peacock-700 ring-peacock-200",
  primary: "bg-brand-50 text-brand-700 ring-brand-200",
  secondary: "bg-maroon-50 text-maroon-700 ring-maroon-200",
  gold: "bg-marigold-50 text-marigold-800 ring-marigold-300",
} as const;
export type Tone = keyof typeof TONES;

/** Small status label. Never below 12px; pair it with an icon (Chip) wherever the colour carries meaning. */
export function Badge({ tone = "neutral", children, className = "", title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]} ${className}`}>{children}</span>;
}

/** Icon + text status chip: the icon is the shape cue, the text the meaning, the colour only reinforces both. */
export function Chip({ tone = "neutral", icon, children, className = "", title }: { tone?: Tone; icon: ReactNode; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]} ${className}`}>
      <span aria-hidden="true" className="shrink-0">{icon}</span><span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

/**
 * Icon-only button with a required accessible name. 36px on desktop (above the 24px minimum),
 * 44px on touch-sized screens and coarse pointers.
 */
export function IconButton({ label, children, className = "", ...rest }: { label: string; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children">) {
  return (
    <button type="button" aria-label={label} title={label} {...rest}
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line-strong bg-surface text-sand-700 hover:bg-sand-100 hover:text-ink active:bg-sand-200 disabled:cursor-not-allowed disabled:opacity-50 max-md:h-11 max-md:w-11 pointer-coarse:h-11 pointer-coarse:w-11 ${className}`}>
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

export const phaseTone = (p: string): Tone => (p === "main" ? "primary" : p === "pre" ? "info" : "gold");
export const priorityTone = (p: string): Tone => (p === "high" ? "danger" : p === "med" ? "warning" : "neutral");
export const severityTone = (s: string): Tone => (s === "critical" ? "danger" : s === "warning" ? "warning" : "info");
/** A template's configured accent (event-templates.ts keeps its palette-name enum) as a theme tone: wedding maroon, birthday kumkum, community peacock. */
const ACCENT_TONE: Record<string, Tone> = { rose: "secondary", violet: "primary", sky: "info", amber: "gold", emerald: "success", indigo: "secondary" };
export const accentTone = (accent: string): Tone => ACCENT_TONE[accent] ?? "neutral";

/**
 * v6: what a figure is, shown the same way everywhere: Estimate (a plan, blueprint or idea figure), Quoted (from an actual
 * vendor quote), Committed (signed or paid), or Unverified (a vendor with no quote yet: no price or availability is known).
 */
export function FigureTag({ kind, className = "" }: { kind: FigureKind | "unverified"; className?: string }) {
  const map = {
    estimate: { tone: "neutral" as Tone, icon: <Calculator size={12} />, text: FIGURE_LABEL.estimate, title: FIGURE_HINT.estimate },
    quoted: { tone: "info" as Tone, icon: <FileText size={12} />, text: FIGURE_LABEL.quoted, title: FIGURE_HINT.quoted },
    committed: { tone: "success" as Tone, icon: <BadgeCheck size={12} />, text: FIGURE_LABEL.committed, title: FIGURE_HINT.committed },
    unverified: { tone: "warning" as Tone, icon: <CircleHelp size={12} />, text: "Unverified", title: "Not from an actual quote: no price or availability is confirmed" },
  }[kind];
  return <span data-figure={kind}><Chip tone={map.tone} icon={map.icon} title={map.title} className={className}>{map.text}</Chip></span>;
}

/** An empty state: a quiet dashed box with the message (and, from the caller, the next step). */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-line-strong bg-canvas px-4 py-6 text-center text-sm leading-relaxed text-ink-muted">{children}</p>;
}

// ---------- inline editing ----------
export type InlineKind = "text" | "rupees" | "time";
/** The largest whole-rupee amount the editor accepts (₹100 crore); the reducer enforces the same cap in paise. */
export const MAX_EDIT_RUPEES = MAX_DIRECT_AMOUNT_PAISE / 100;

/**
 * Turn what was typed into the value the command needs: trimmed text, integer paise from whole rupees
 * ("25,000" or "₹25000" → 2500000), or minutes from midnight from "HH:MM". Money is never parsed as a float.
 */
export function parseInline(kind: InlineKind, raw: string): { ok: true; value: string | number } | { ok: false; error: string } {
  if (kind === "text") {
    const v = raw.trim();
    if (!v) return { ok: false, error: "Enter a name." };
    if (v.length > MAX_NAME_LENGTH) return { ok: false, error: `Use ${MAX_NAME_LENGTH} characters or fewer.` };
    return { ok: true, value: v };
  }
  if (kind === "rupees") {
    const v = raw.replace(/[\s,₹]/g, "");
    if (!/^\d+$/.test(v)) return { ok: false, error: "Enter a whole number of rupees, like 25000 (no paise, no minus sign)." };
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n > MAX_EDIT_RUPEES) return { ok: false, error: "Enter at most ₹1,00,00,00,000 (₹100 crore)." };
    return { ok: true, value: n * 100 };
  }
  const m = /^(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { ok: false, error: "Enter a time as HH:MM, like 18:30." };
  return { ok: true, value: Number(m[1]) * 60 + Number(m[2]) };
}

/** Run a direct edit through the reducer and hand the editor its error (null when it applied). */
export const saveWith = (commit: (b: BatchInput) => BatchResult, batch: BatchInput): string | null => {
  const r = commit(batch);
  return r.ok ? null : r.reason;
};

/**
 * Click-to-edit for one value. At rest: the value (children) and an "Edit …" button. Editing: a labelled input
 * with Save and Cancel; Enter saves, Escape cancels, focus goes back to the Edit button either way. Errors (from
 * parsing or from the reducer) stay visible under the input, linked with aria-describedby, until the next try.
 * Targets are 32px on desktop and 44px on touch-sized screens and coarse pointers.
 */
export function InlineEdit({ label, value, kind = "text", onSave, children, className = "", grow = false, inputSize = "w-56", hint, testId, large = false, top = false }: {
  /** Names the field ("Name of budget line Haldi marigold decor"); the button is "Edit <label>". */
  label: string;
  /** The current value as the input should show it: text, whole rupees, or "HH:MM". */
  value: string;
  kind?: InlineKind;
  /** Gets the parsed value; returns an error message to keep the editor open, or null when the change applied. */
  onSave: (value: never) => string | null;
  children: ReactNode;
  className?: string;
  grow?: boolean;
  inputSize?: string;
  hint?: string;
  testId?: string;
  /** v8 Part 1e: 44px targets at every width (the run-sheet), not just on touch-sized screens. */
  large?: boolean;
  /** v8 Part 3b: pin the pencil to the first line (a heading that can wrap) instead of centring it on the block. */
  top?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const refocus = useRef(false);
  const id = useId();
  const errId = `${id}-err`, hintId = `${id}-hint`;
  useEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select(); }
    else if (refocus.current) { refocus.current = false; btn.current?.focus(); }
  }, [editing]);
  const start = () => { setDraft(value); setError(null); setEditing(true); };
  const stop = () => { refocus.current = true; setEditing(false); setError(null); };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = parseInline(kind, draft);
    if (!p.ok) { setError(p.error); input.current?.focus(); return; }
    const err = (onSave as (v: string | number) => string | null)(p.value);
    if (err) { setError(err); input.current?.focus(); return; }
    stop();
  };
  const onKey = (e: ReactKeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stop(); } };
  const hintText = hint ?? (kind === "rupees" ? "Whole rupees" : undefined);
  const touch = "max-md:h-11 max-md:w-11 pointer-coarse:h-11 pointer-coarse:w-11";
  const pencil = large ? "h-11 w-11" : `h-8 w-8 ${touch}`, square = large ? "h-11 w-11" : `h-9 w-9 ${touch}`;

  if (!editing) {
    return (
      <div className={`flex min-w-0 ${top ? "items-start" : "items-center"} gap-1 ${grow ? "flex-1" : ""} ${className}`}>
        <div className={`min-w-0 ${grow ? "flex-1" : ""}`}>{children}</div>
        <button ref={btn} type="button" onClick={start} aria-label={`Edit ${label}`} title={`Edit ${label}`} data-testid={testId}
          className={`grid ${pencil} shrink-0 place-items-center rounded-md text-ink-muted hover:bg-sand-100 hover:text-ink`}>
          <Pencil size={15} aria-hidden="true" />
        </button>
      </div>
    );
  }
  return (
    <form noValidate onSubmit={submit} onKeyDown={onKey} className={`flex min-w-0 max-w-full flex-wrap items-center gap-1.5 ${grow ? "flex-1" : ""} ${className}`}>
      <label htmlFor={`${id}-in`} className="sr-only">{label}</label>
      <span className={`relative flex min-w-0 items-center ${inputSize} max-w-full`}>
        {kind === "rupees" && <span aria-hidden="true" className="pointer-events-none absolute left-2.5 text-sm text-ink-muted">₹</span>}
        <input ref={input} id={`${id}-in`} type={kind === "time" ? "time" : "text"} value={draft} onChange={e => setDraft(e.target.value)}
          inputMode={kind === "rupees" ? "numeric" : undefined} autoComplete="off" spellCheck={kind === "text"}
          aria-invalid={error ? true : undefined} aria-describedby={[error ? errId : "", hintText ? hintId : ""].filter(Boolean).join(" ") || undefined}
          className={`${large ? "h-11" : "h-9 max-md:h-11 pointer-coarse:h-11"} w-full min-w-0 rounded-lg border bg-surface px-2.5 text-sm text-ink tabular-nums ${kind === "rupees" ? "pl-6" : ""} ${error ? "border-danger" : "border-line-strong"}`} />
      </span>
      <button type="submit" aria-label={`Save ${label}`} title="Save (Enter)" className={`grid ${square} shrink-0 place-items-center rounded-lg bg-primary text-white hover:bg-primary-hover`}>
        <Check size={16} aria-hidden="true" />
      </button>
      <button type="button" onClick={stop} aria-label={`Cancel editing ${label}`} title="Cancel (Esc)" className={`grid ${square} shrink-0 place-items-center rounded-lg border border-line-strong bg-surface text-sand-700 hover:bg-sand-100`}>
        <X size={16} aria-hidden="true" />
      </button>
      {hintText && <span id={hintId} className="sr-only">{hintText}</span>}
      {/* contain: the message wraps to the editor's width instead of widening it (and the page) to fit one line. */}
      {error && <p id={errId} role="alert" className="basis-full break-words text-sm font-medium text-danger [contain:inline-size]">{error}</p>}
    </form>
  );
}
