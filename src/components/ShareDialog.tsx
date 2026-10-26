"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy, Link2, MessageCircle, QrCode, RefreshCw, X } from "lucide-react";
import type { AgentState } from "@/schema";
import { privateLink, rsvpMessage, waLink } from "@/invites";
import QrImage from "./QrImage";
import type { ShareInfo, ShareStatus } from "./useSharedEvent";

// v8 Part 1d: one link only. The dialog shares the event's RSVP link (Copy, WhatsApp, QR); the old public itinerary
// URL (/guest/<id> without #k=) still works read-only for anyone who has it, but the dialog no longer hands it out.
type Props = { open: boolean; onClose: () => void; share: ShareInfo | null; status: ShareStatus; onPublish: () => void; onSync: () => void; onForget: () => void; plan: AgentState };

/** Every control in this dialog is at least 44px tall. */
const btn = "flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-sand-800 hover:bg-sand-100";

/**
 * Copy to the clipboard. navigator.clipboard only exists on secure origins (https or localhost), so a LAN address
 * such as http://192.168.1.20:3000, which is how the app is opened from a phone or another PC, has none. Fall back to
 * selecting the field and execCommand("copy"); when that fails too, leave the link selected for Ctrl+C.
 */
async function copyText(url: string, field: HTMLInputElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(url); return true; }
  } catch { /* permission denied: try the fallback */ }
  if (!field) return false;
  field.focus(); field.select();
  try { return document.execCommand("copy"); } catch { return false; }
}

function RsvpLink({ url, plan }: { url: string; plan: AgentState }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const [showQr, setShowQr] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const fieldId = useId();
  const qrId = useId();
  const copy = async () => {
    const ok = await copyText(url, field.current);
    setState(ok ? "copied" : "manual");
    if (ok) setTimeout(() => setState("idle"), 1500);
  };
  return (
    <div data-testid="share-rsvp">
      <label htmlFor={fieldId} className="text-xs font-semibold uppercase tracking-wide text-ink-muted">RSVP link</label>
      <input id={fieldId} ref={field} readOnly value={url} data-testid="rsvp-guest-link" onFocus={e => e.currentTarget.select()}
        aria-describedby={state === "manual" ? hintId : undefined}
        className="mt-1 h-11 w-full truncate rounded-lg border border-line-strong bg-surface-muted px-2 font-mono text-xs text-sand-800" />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void copy()} data-testid="share-copy" className={btn} aria-label="Copy RSVP link">
          {state === "copied" ? <Check size={15} aria-hidden="true" className="text-emerald-700" /> : <Copy size={15} aria-hidden="true" />} <span aria-live="polite">{state === "copied" ? "Copied" : "Copy"}</span>
        </button>
        <a href={waLink("", rsvpMessage(plan, url))} target="_blank" rel="noopener noreferrer" data-testid="share-wa"
          className="flex min-h-11 items-center gap-1.5 rounded-lg bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-800">
          <MessageCircle size={15} aria-hidden="true" />Share on WhatsApp<span className="sr-only"> (opens WhatsApp)</span>
        </a>
        <button type="button" onClick={() => setShowQr(v => !v)} aria-expanded={showQr} aria-controls={qrId} data-testid="share-qr-toggle" className={btn}>
          <QrCode size={15} aria-hidden="true" />{showQr ? "Hide QR" : "Show QR"}
        </button>
      </div>
      {state === "manual" && <p id={hintId} role="status" className="mt-1 text-xs text-ink-muted">This browser blocked copying here. The link is selected: press Ctrl+C (Cmd+C on a Mac) to copy it.</p>}
      <div id={qrId} hidden={!showQr} className="mt-3">
        {showQr && (
          <figure className="m-0 inline-block">
            <QrImage value={url} label={`QR code for the RSVP link to ${plan.event.title}`} testId="share-qr" className="h-40 w-40 rounded-lg ring-1 ring-line" />
            <figcaption className="mt-1 text-center text-xs text-ink-muted">Scan to RSVP</figcaption>
          </figure>
        )}
      </div>
    </div>
  );
}

/** Native modal <dialog>: real focus containment, inert background, Escape to close; focus goes back to the opener. */
export default function ShareDialog(props: Props) {
  if (!props.open) return null;
  return <ShareDialogOpen {...props} />;
}

function ShareDialogOpen({ onClose, share, status, onPublish, onSync, onForget, plan }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const downOnBackdrop = useRef(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!d.open) d.showModal();
    // React Strict Mode (dev) runs this effect twice: the cleanup's close() queues a "close" event that lands after the
    // second showModal(), so the dialog's onClose ignores a close event that arrives while the dialog is open again.
    return () => { if (d.open) d.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <dialog ref={ref} aria-labelledby="share-title" onClose={() => { if (!ref.current?.open) onClose(); }}
      onPointerDown={e => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={e => { if (downOnBackdrop.current && e.target === e.currentTarget) onClose(); downOnBackdrop.current = false; }}
      className="m-auto max-h-[min(85dvh,100%)] w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-sand-900/40">
      <div className="max-h-[min(85dvh,100%)] overflow-y-auto overscroll-contain p-5">
        <div className="mb-3 flex items-center gap-2">
          <Link2 size={18} aria-hidden="true" className="text-brand-700" />
          <h2 id="share-title" className="text-base font-semibold">Guest links</h2>
          <button type="button" onClick={onClose} className="ml-auto grid h-11 w-11 place-items-center rounded-lg text-sand-700 hover:bg-sand-100" aria-label="Close" title="Close (Esc)"><X size={18} aria-hidden="true" /></button>
        </div>
        <p className="mb-3 text-sm text-ink-muted" data-testid="share-intro">
          Share this one link with everyone. Each family fills in one short form and sees the schedule, venues and dress codes,
          never your budget, vendors or other guests. The RSVP dashboard is on the Guests page.
        </p>
        {status.state === "unconfigured" && (
          <div className="mb-3 space-y-1 rounded-lg bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-inset ring-amber-300" role="alert" data-testid="share-unconfigured">
            <p className="font-semibold">Guest links aren&apos;t available on this server yet: it has nowhere to store the shared copy.</p>
            <p>Running it yourself? <code>npm run dev</code> works as is. For <code>npm start</code>, add <code>UTSAV_STORE=file</code> to <code>.env.local</code> and restart. On Vercel, connect Upstash Redis.</p>
            {status.message && <p className="text-amber-900">Server said: {status.message}</p>}
          </div>
        )}
        {status.state === "error" && <div className="mb-3 rounded-lg bg-red-50 p-2 text-xs text-red-700" role="alert">{status.message}</div>}
        {!share ? (
          <button type="button" onClick={onPublish} disabled={status.state === "publishing"} data-testid="publish-guest-links"
            className="min-h-11 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50">
            {status.state === "publishing" ? "Publishing…" : "Publish & create the RSVP link"}
          </button>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              <span data-testid="share-sync-status" role="status">{status.state === "syncing" ? "Syncing…" : status.state === "synced" ? "Synced" : status.state === "error" ? "Not synced" : "Shared"} · version {share.version}</span>
              <button type="button" onClick={onSync} className="flex min-h-11 items-center gap-1 rounded-lg border border-line-strong bg-surface px-3 text-sand-800 hover:bg-sand-100"><RefreshCw size={14} aria-hidden="true" /> Sync now</button>
            </div>
            {share.rsvpToken
              ? <RsvpLink url={privateLink(origin, share.eventId, share.rsvpToken)} plan={plan} />
              : <p className="text-sm text-ink-muted" data-testid="share-rsvp-missing">This event was shared before the RSVP link existed. Press Sync now to make it.</p>}
            <button type="button" onClick={onForget} className="mt-3 min-h-11 text-xs text-ink-muted underline">Stop syncing on this device</button>
          </>
        )}
      </div>
    </dialog>
  );
}
