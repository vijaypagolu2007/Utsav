"use client";
// v8 Part 0b: the one-time choice on a new account's first sign-in (my-events.ts shouldShowFirstChoice): start an event
// of your own (the setup form, blank) or load the sample events. Nothing is written to the account until the
// organizer picks one; the answer is remembered per account on this device, so it is never asked again here.
import { useEffect, useId, useRef } from "react";
import { ArrowRight, LayoutTemplate, Sparkles } from "lucide-react";

export default function FirstChoiceDialog({ open, name, onOwn, onSamples, onClose }: {
  open: boolean; name: string; onOwn: () => void; onSamples: () => void; onClose: () => void;
}) {
  if (!open) return null;
  return <FirstChoiceOpen name={name} onOwn={onOwn} onSamples={onSamples} onClose={onClose} />;
}

function FirstChoiceOpen({ name, onOwn, onSamples, onClose }: { name: string; onOwn: () => void; onSamples: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const titleId = useId(), descId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!d.open) d.showModal();
    first.current?.focus();
    // React Strict Mode (dev) runs this effect twice: the cleanup's close() queues a "close" event that lands after the
    // second showModal(), so onClose below ignores a close event that arrives while the dialog is open again (fix6).
    return () => { if (d.open) d.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  const greeting = name.trim().split(/\s+/)[0];
  return (
    <dialog ref={ref} aria-labelledby={titleId} aria-describedby={descId} data-testid="first-choice-dialog"
      onClose={() => { if (!ref.current?.open) onClose(); }}
      className="m-auto max-h-[min(85dvh,100%)] w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-sand-900/40">
      <div className="max-h-[min(85dvh,100%)] overflow-y-auto overscroll-contain p-5">
        <h2 id={titleId} className="text-base font-semibold">{greeting ? `Welcome, ${greeting}. How would you like to start?` : "How would you like to start?"}</h2>
        <p id={descId} className="mt-1 text-sm text-ink-muted">Your account has no events yet. Nothing is saved to it until you choose.</p>
        <ul className="mt-4 grid gap-3">
          <li>
            <button ref={first} type="button" onClick={onOwn} data-testid="first-choice-own"
              className="flex min-h-11 w-full items-start gap-3 rounded-xl border border-line-strong bg-surface p-3 text-left hover:bg-sand-100">
              <Sparkles size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-brand-700" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-ink">Start your own event</span>
                <span className="block text-sm text-ink-muted">A blank setup: type, city, dates, guests and budget, in about two minutes.</span>
              </span>
              <ArrowRight size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-muted" />
            </button>
          </li>
          <li>
            <button type="button" onClick={onSamples} data-testid="first-choice-samples"
              className="flex min-h-11 w-full items-start gap-3 rounded-xl border border-line-strong bg-surface p-3 text-left hover:bg-sand-100">
              <LayoutTemplate size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-peacock-700" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-ink">Load sample events</span>
                <span className="block text-sm text-ink-muted">Three fully planned examples (a wedding, a birthday and a community fest), saved to your account as you open them.</span>
              </span>
              <ArrowRight size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-muted" />
            </button>
          </li>
        </ul>
        <p className="mt-3 text-xs text-ink-muted">You can load the samples later from the event menu or your account, and start a new event any time.</p>
      </div>
    </dialog>
  );
}
