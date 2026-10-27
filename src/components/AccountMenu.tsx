"use client";
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, Cloud, CloudOff, Laptop, LayoutTemplate, LogIn, LogOut, RefreshCw } from "lucide-react";
import { statusLabel, type SyncStatus } from "@/cloud-sync";
import { flushStore } from "@/persistence";
import { signInHref } from "@/signin";
import { unavailableText } from "./cloud-auth";
import type { CloudSync } from "./useCloudSync";

/** Short form for the header chip (below 640px the chip shrinks to an icon badge on the avatar); the full sentence is in the popover, the button's name and the live region. */
function shortStatus(s: SyncStatus): string {
  switch (s.state) {
    case "saved": return "Saved";
    case "saving": return "Saving…";
    case "checking": return "Checking…";
    case "offline": return "Offline";
    case "sample": return "Sample";
    case "choose": return "Review";
    case "error": return "Not saved";
    default: return "";
  }
}
function StatusIcon({ s, size = 14 }: { s: SyncStatus; size?: number }) {
  if (s.state === "saving" || s.state === "checking") return <RefreshCw size={size} aria-hidden="true" className="motion-safe:animate-spin" />;
  if (s.state === "offline") return <CloudOff size={size} aria-hidden="true" />;
  if (s.state === "choose" || s.state === "error") return <AlertTriangle size={size} aria-hidden="true" />;
  return <Cloud size={size} aria-hidden="true" />;
}
const chipTone = (s: SyncStatus) =>
  s.state === "saved" ? "bg-emerald-50 text-emerald-800 ring-emerald-300"
    : s.state === "choose" || s.state === "error" ? "bg-amber-50 text-amber-800 ring-amber-300"
      : "bg-surface-muted text-sand-700 ring-line";

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "earlier" : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
};

/**
 * The account control, top right in the header (where the Co-Pilot launcher used to be). Signed out: a "Sign in" link
 * to /signin (Google or email), shown even when sign-in is unavailable, since that page explains why. Signed in: the
 * user's initial and the cloud status; the disclosure holds the name, the full status, "Choose a version" while a
 * choice is pending, "Try again" after a failure, and "Sign out" with "Also remove this plan from this device".
 */
export default function AccountMenu({ cloud, onOpenChoice, onSignOut, onLoadSamples }: {
  cloud: CloudSync; onOpenChoice: () => void; onSignOut: (removeFromDevice: boolean) => void;
  /** v8 Part 0b: "Load sample events" (signed in): opens the samples and lets them save to this account. */
  onLoadSamples?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [forget, setForget] = useState(false);
  const panelId = useId(), forgetId = useId(), forgetHintId = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); btn.current?.focus(); } };
    const onDown = (e: PointerEvent) => { const t = e.target as Node; if (!btn.current?.contains(t) && !box.current?.contains(t)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [open]);

  const { user, status } = cloud;
  const label = statusLabel(status);
  // Polite announcements of sync changes ("Saving…" → "Saved to cloud"), present whether or not the panel is open.
  const live = <span className="sr-only" role="status" aria-live="polite" data-testid="cloud-live">{user ? label : ""}</span>;

  if (!user) {
    return (
      <div className="relative">
        <Link href={signInHref(pathname)} onClick={() => flushStore()} data-testid="cloud-signin" data-available={cloud.unavailable ? "false" : "true"}
          title={cloud.unavailable ? `Sign-in unavailable. ${unavailableText(cloud.unavailable)}` : "Sign in with Google or email to save your plans to the cloud"}
          className="flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-sand-800 hover:bg-sand-100 max-md:h-11 pointer-coarse:h-11">
          <LogIn size={16} aria-hidden="true" className="text-brand-700" /> <span>Sign in</span>
        </Link>
        {live}
      </div>
    );
  }

  const initial = (user.name.trim()[0] ?? "?").toUpperCase();
  const short = shortStatus(status);
  // The accessible name is built from the content (WCAG 2.5.3: the visible status word is part of it): "Account: Asha Rao."
  // then the visible short status, then the rest of the full sentence for screen readers ("Saved" + " to cloud").
  const rest = label.startsWith(short) ? label.slice(short.length) : `: ${label}`;
  return (
    <div className="relative">
      <button ref={btn} type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-controls={open ? panelId : undefined}
        data-testid="cloud-account" data-sync={status.state} title={label}
        className="relative flex h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-surface pl-1 pr-2 text-sm font-medium text-sand-800 hover:bg-sand-100 max-md:h-11 max-sm:w-10 max-sm:justify-center max-sm:px-0 pointer-coarse:h-11">
        <span className="sr-only">Account: {user.name}. </span>
        <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-full bg-brand-700 text-sm font-semibold text-white">{initial}</span>
        <span data-testid="cloud-status" className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-semibold ring-1 ring-inset max-sm:absolute max-sm:-bottom-1 max-sm:-right-1 max-sm:px-0.5 ${chipTone(status)}`}>
          <StatusIcon s={status} /><span className="max-sm:sr-only">{short}</span><span className="sr-only">{rest}</span>
        </span>
      </button>
      {open && (
        <div ref={box} id={panelId} data-testid="cloud-panel"
          className="absolute right-0 z-40 mt-2 w-[min(20rem,calc(100vw-1.5rem))] rounded-xl border border-line bg-surface p-3 shadow-xl max-sm:fixed max-sm:inset-x-3 max-sm:w-auto">
          <p className="break-words text-sm font-semibold text-ink">{user.name}</p>
          {user.email && <p className="break-words text-sm text-ink-muted">{user.email}</p>}
          <p className="mt-2 flex items-start gap-1.5 text-sm text-ink" data-testid="cloud-status-text">
            <span className="mt-0.5 shrink-0"><StatusIcon s={status} size={16} /></span><span className="min-w-0 break-words">{label}</span>
          </p>
          {user.emailVerified === false && (
            <p className="mt-1 text-xs text-amber-800" data-testid="cloud-unverified">Email not verified yet: check your inbox for the link.</p>
          )}
          <p className="mt-1 text-xs text-ink-muted">Your plans are always saved on this device too.</p>
          {onLoadSamples && (
            <div className="mt-3 border-t border-line pt-3">
              <button type="button" onClick={() => { setOpen(false); btn.current?.focus(); onLoadSamples(); }} data-testid="cloud-load-samples"
                className="flex min-h-11 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-sand-800 hover:bg-sand-100">
                <LayoutTemplate size={16} aria-hidden="true" className="text-brand-700" /> Load sample events
              </button>
              <p className="mt-1 text-xs text-ink-muted">Three fully planned examples. A sample saves to your account once you load the samples or edit it.</p>
            </div>
          )}
          {(status.state === "choose" || status.state === "offline" || status.state === "error") && <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
            {status.state === "choose" && (
              <button type="button" onClick={() => { setOpen(false); onOpenChoice(); }} data-testid="cloud-open-choice"
                className="flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-white hover:bg-primary-hover">Choose a version</button>
            )}
            {(status.state === "offline" || status.state === "error") && (
              <button type="button" onClick={cloud.retry} data-testid="cloud-retry"
                className="flex min-h-11 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-sand-800 hover:bg-sand-100">
                <RefreshCw size={16} aria-hidden="true" /> Try again
              </button>
            )}
          </div>}
          <div className="mt-3 border-t border-line pt-3">
            <div className="flex items-start gap-2">
              <input id={forgetId} type="checkbox" checked={forget} onChange={e => setForget(e.target.checked)} aria-describedby={forgetHintId}
                data-testid="cloud-signout-forget" className="h-6 w-6 shrink-0 accent-brand-700" />
              <label htmlFor={forgetId} className="pt-0.5 text-sm text-ink">Also remove this plan from this device</label>
            </div>
            <p id={forgetHintId} className="mt-1 pl-8 text-xs text-ink-muted">For shared computers: clears the plans saved in this browser. The cloud copy stays in your account.</p>
            <button type="button" onClick={() => { setOpen(false); onSignOut(forget); }} data-testid="cloud-signout"
              className="mt-2 flex min-h-11 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-sand-800 hover:bg-sand-100">
              <LogOut size={16} aria-hidden="true" /> {forget ? "Sign out and remove" : "Sign out"}
            </button>
          </div>
        </div>
      )}
      {live}
    </div>
  );
}

/**
 * "Which version should we keep?" Shown when the cloud copy and this device's plan differ on sign-in, or after a 409
 * (changed on another device). Native modal <dialog>; Escape or the backdrop decides later (autosave waits; the
 * account panel reopens this). Using the cloud copy is one Undo away; keeping this device's plan replaces the cloud copy.
 */
export function CloudChoiceDialog({ open, status, localTitle, onUseCloud, onKeepLocal, onClose }: {
  open: boolean; status: SyncStatus; localTitle: string; onUseCloud: () => void; onKeepLocal: () => void; onClose: () => void;
}) {
  if (!open || status.state !== "choose") return null;
  return <ChoiceOpen status={status} localTitle={localTitle} onUseCloud={onUseCloud} onKeepLocal={onKeepLocal} onClose={onClose} />;
}

function ChoiceOpen({ status, localTitle, onUseCloud, onKeepLocal, onClose }: {
  status: Extract<SyncStatus, { state: "choose" }>; localTitle: string; onUseCloud: () => void; onKeepLocal: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const downOnBackdrop = useRef(false);
  const titleId = useId(), descId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!d.open) d.showModal();
    // React Strict Mode (dev) runs this effect twice: the cleanup's close() queues a "close" event that lands after the
    // second showModal(), so the dialog's onClose ignores a close event that arrives while the dialog is open again.
    return () => { if (d.open) d.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  const conflict = status.reason === "conflict";
  return (
    <dialog ref={ref} aria-labelledby={titleId} aria-describedby={descId} onClose={() => { if (!ref.current?.open) onClose(); }} data-testid="cloud-choice-dialog"
      onPointerDown={e => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={e => { if (downOnBackdrop.current && e.target === e.currentTarget) onClose(); downOnBackdrop.current = false; }}
      className="m-auto max-h-[min(85dvh,100%)] w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-sand-900/40">
      <div className="max-h-[min(85dvh,100%)] overflow-y-auto overscroll-contain p-5">
        <h2 id={titleId} className="text-base font-semibold">Which version should we keep?</h2>
        <p id={descId} className="mt-1 text-sm text-ink-muted">
          {conflict ? "This plan was changed on another device since this one last saved it." : "The plan saved in your account is different from the one on this device."}
        </p>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          <li className="rounded-xl border border-line bg-surface-muted p-3">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-ink"><Cloud size={16} aria-hidden="true" className="text-peacock-700" /> Cloud copy</p>
            <p className="mt-1 break-words text-sm text-ink">{status.cloud.plan.event.title}</p>
            <p className="text-xs text-ink-muted">Saved {when(status.cloud.updatedAt)}</p>
          </li>
          <li className="rounded-xl border border-line bg-surface-muted p-3">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-ink"><Laptop size={16} aria-hidden="true" className="text-brand-700" /> This device</p>
            <p className="mt-1 break-words text-sm text-ink">{localTitle}</p>
            <p className="text-xs text-ink-muted">The plan on screen now</p>
          </li>
        </ul>
        <p className="mt-3 text-xs text-ink-muted">Use cloud copy keeps this device&apos;s plan one Undo away. Keep this device&apos;s plan replaces the cloud copy.</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onKeepLocal} data-testid="cloud-keep-local"
            className="flex min-h-11 items-center rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium text-sand-800 hover:bg-sand-100">Keep this device&apos;s plan</button>
          <button type="button" onClick={onUseCloud} data-testid="cloud-use-cloud"
            className="flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-hover">Use cloud copy</button>
        </div>
      </div>
    </dialog>
  );
}
