"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Link2, RefreshCw, X } from "lucide-react";
import type { ShareInfo, ShareStatus } from "./useSharedEvent";

type Props = { open: boolean; onClose: () => void; share: ShareInfo | null; status: ShareStatus; onPublish: () => void; onSync: () => void; onForget: () => void; visibility: { public: number; total: number } };

function CopyRow({ label, url, testId }: { label: string; url: string; testId?: string }) {
  const [done, setDone] = useState(false);
  return (
    <li className="flex items-center gap-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-slate-700">{label}</div>
        <input readOnly value={url} data-testid={testId} aria-label={`${label} link`} onFocus={e => e.currentTarget.select()}
          className="w-full truncate rounded border border-slate-300 bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-700" />
      </div>
      <button type="button" onClick={() => { void navigator.clipboard?.writeText(url).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}
        className="flex min-h-8 items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50" aria-label={`Copy ${label} link`}>
        {done ? <Check size={12} className="text-emerald-700" /> : <Copy size={12} />} <span aria-live="polite">{done ? "Copied" : "Copy"}</span>
      </button>
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
      className="m-auto max-h-[min(85dvh,100%)] w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-2xl bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-900/40">
      <div className="max-h-[min(85dvh,100%)] overflow-y-auto overscroll-contain p-5">
        <div className="mb-3 flex items-center gap-2">
          <Link2 size={18} className="text-violet-700" />
          <h2 id="share-title" className="text-base font-semibold">Guest links</h2>
          <button type="button" onClick={onClose} className="ml-auto grid h-9 w-9 place-items-center rounded-lg hover:bg-slate-100" aria-label="Close" title="Close (Esc)"><X size={18} /></button>
        </div>
        <p className="mb-3 text-xs text-slate-600">
          Guests see only the itinerary, venues, dress codes and their own household&apos;s RSVPs. Budgets, vendors, tasks and other guests stay private.
          Each household link carries its own secret after the <code>#</code>, which browsers never send to the server.
        </p>
        <p className="mb-3 rounded-lg bg-slate-50 p-2 text-xs text-slate-600" data-testid="visibility-summary">
          {visibility.public} of {visibility.total} sub-events are public. Private ones appear only on the links of households invited to them.
          {visibility.public === 0 && " The public itinerary link will be empty until you mark a sub-event Public on the timeline."}
        </p>
        {status.state === "unconfigured" && <div className="mb-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-800" role="alert">{status.message}</div>}
        {status.state === "error" && <div className="mb-3 rounded-lg bg-rose-50 p-2 text-xs text-rose-700" role="alert">{status.message}</div>}
        {!share ? (
          <button type="button" onClick={onPublish} disabled={status.state === "publishing"} data-testid="publish-guest-links"
            className="rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50">
            {status.state === "publishing" ? "Publishing…" : "Publish & create guest links"}
          </button>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span data-testid="share-sync-status" role="status">{status.state === "syncing" ? "Syncing…" : status.state === "synced" ? "Synced" : status.state === "error" ? "Not synced" : "Shared"} · version {share.version}</span>
              <button type="button" onClick={onSync} className="flex min-h-7 items-center gap-1 rounded border border-slate-300 px-2 py-0.5 text-slate-700 hover:bg-slate-50"><RefreshCw size={12} /> Sync now</button>
            </div>
            <ul className="divide-y divide-slate-100">
              <CopyRow label="Public itinerary (anyone)" url={`${origin}/guest/${share.eventId}`} testId="public-guest-link" />
              {share.invites.map(i => <CopyRow key={i.householdId} label={`${i.label} (RSVP link)`} url={`${origin}/guest/${share.eventId}#k=${i.token}`} testId={`invite-${i.householdId}`} />)}
            </ul>
            <button type="button" onClick={onForget} className="mt-3 min-h-6 text-xs text-slate-600 underline">Stop syncing on this device</button>
          </>
        )}
      </div>
    </dialog>
  );
}
