"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy, Link2, RefreshCw, X } from "lucide-react";
import type { ShareInfo, ShareStatus } from "./useSharedEvent";

type Props = { open: boolean; onClose: () => void; share: ShareInfo | null; status: ShareStatus; onPublish: () => void; onSync: () => void; onForget: () => void; visibility: { public: number; total: number } };

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

function CopyRow({ label, url, testId }: { label: string; url: string; testId?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const field = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const copy = async () => {
    const ok = await copyText(url, field.current);
    setState(ok ? "copied" : "manual");
    if (ok) setTimeout(() => setState("idle"), 1500);
  };
  return (
    <li className="py-1.5">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sand-700">{label}</div>
          <input ref={field} readOnly value={url} data-testid={testId} aria-label={`${label} link`} onFocus={e => e.currentTarget.select()}
            aria-describedby={state === "manual" ? hintId : undefined}
            className="h-9 w-full truncate rounded border border-line-strong bg-surface-muted px-2 font-mono text-xs text-sand-800 max-md:h-11" />
        </div>
        <button type="button" onClick={() => void copy()}
          className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 text-xs font-medium text-sand-800 hover:bg-sand-100 max-md:h-11" aria-label={`Copy ${label} link`}>
          {state === "copied" ? <Check size={14} aria-hidden="true" className="text-emerald-700" /> : <Copy size={14} aria-hidden="true" />} <span aria-live="polite">{state === "copied" ? "Copied" : "Copy"}</span>
        </button>
      </div>
      {state === "manual" && <p id={hintId} role="status" className="mt-1 text-xs text-ink-muted">This browser blocked copying here. The link is selected: press Ctrl+C (Cmd+C on a Mac) to copy it.</p>}
    </li>
  );
}

/** Native modal <dialog>: real focus containment, inert background, Escape to close; focus goes back to the opener. */
export default function ShareDialog(props: Props) {
  if (!props.open) return null;
  return <ShareDialogOpen {...props} />;
}

function ShareDialogOpen({ onClose, share, status, onPublish, onSync, onForget, visibility }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const downOnBackdrop = useRef(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!d.open) d.showModal();
    return () => { if (d.open) d.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <dialog ref={ref} aria-labelledby="share-title" onClose={onClose}
      onPointerDown={e => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={e => { if (downOnBackdrop.current && e.target === e.currentTarget) onClose(); downOnBackdrop.current = false; }}
      className="m-auto max-h-[min(85dvh,100%)] w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-sand-900/40">
      <div className="max-h-[min(85dvh,100%)] overflow-y-auto overscroll-contain p-5">
        <div className="mb-3 flex items-center gap-2">
          <Link2 size={18} aria-hidden="true" className="text-brand-700" />
          <h2 id="share-title" className="text-base font-semibold">Guest links</h2>
          <button type="button" onClick={onClose} className="ml-auto grid h-9 w-9 place-items-center rounded-lg text-sand-700 hover:bg-sand-100 max-md:h-11 max-md:w-11" aria-label="Close" title="Close (Esc)"><X size={18} aria-hidden="true" /></button>
        </div>
        <p className="mb-3 text-xs text-ink-muted">
          Guests see only the itinerary, venues, dress codes and their own household&apos;s RSVPs. Budgets, vendors, tasks and other guests stay private.
          Each household link carries its own secret after the <code>#</code>, which browsers never send to the server.
        </p>
        <p className="mb-3 rounded-lg bg-surface-muted p-2 text-xs text-ink-muted" data-testid="visibility-summary">
          {visibility.public} of {visibility.total} sub-events are public. Private ones appear only on the links of households invited to them.
          {visibility.public === 0 && " The public itinerary link will be empty until you mark a sub-event Public on the timeline."}
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
            className="min-h-10 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50 max-md:min-h-11">
            {status.state === "publishing" ? "Publishing…" : "Publish & create guest links"}
          </button>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              <span data-testid="share-sync-status" role="status">{status.state === "syncing" ? "Syncing…" : status.state === "synced" ? "Synced" : status.state === "error" ? "Not synced" : "Shared"} · version {share.version}</span>
              <button type="button" onClick={onSync} className="flex min-h-9 items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-0.5 text-sand-800 hover:bg-sand-100 max-md:min-h-11"><RefreshCw size={14} aria-hidden="true" /> Sync now</button>
            </div>
            <ul className="divide-y divide-line-soft">
              <CopyRow label="Public itinerary (anyone)" url={`${origin}/guest/${share.eventId}`} testId="public-guest-link" />
              {share.invites.map(i => <CopyRow key={i.householdId} label={`${i.label} (RSVP link)`} url={`${origin}/guest/${share.eventId}#k=${i.token}`} testId={`invite-${i.householdId}`} />)}
            </ul>
            <button type="button" onClick={onForget} className="mt-3 min-h-9 text-xs text-ink-muted underline max-md:min-h-11">Stop syncing on this device</button>
          </>
        )}
      </div>
    </dialog>
  );
}
