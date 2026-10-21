"use client";
import { useState } from "react";
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
          className="w-full truncate rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600" />
      </div>
      <button type="button" onClick={() => { void navigator.clipboard?.writeText(url).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}
        className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50" aria-label={`Copy ${label} link`}>
        {done ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />} {done ? "Copied" : "Copy"}
      </button>
    </li>
  );
}

export default function ShareDialog({ open, onClose, share, status, onPublish, onSync, onForget, visibility }: Props) {
  if (!open) return null;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-labelledby="share-title">
      <div className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center gap-2">
          <Link2 size={18} className="text-violet-600" />
          <h2 id="share-title" className="text-base font-semibold">Guest links</h2>
          <button type="button" onClick={onClose} className="ml-auto rounded p-1 hover:bg-slate-100" aria-label="Close"><X size={16} /></button>
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
            <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
              <span data-testid="share-sync-status">{status.state === "syncing" ? "Syncing…" : status.state === "synced" ? "Synced" : status.state === "error" ? "Not synced" : "Shared"} · version {share.version}</span>
              <button type="button" onClick={onSync} className="flex items-center gap-1 rounded border border-slate-200 px-1.5 py-0.5 hover:bg-slate-50"><RefreshCw size={11} /> Sync now</button>
            </div>
            <ul className="divide-y divide-slate-100">
              <CopyRow label="Public itinerary (anyone)" url={`${origin}/guest/${share.eventId}`} testId="public-guest-link" />
              {share.invites.map(i => <CopyRow key={i.householdId} label={`${i.label} (RSVP link)`} url={`${origin}/guest/${share.eventId}#k=${i.token}`} testId={`invite-${i.householdId}`} />)}
            </ul>
            <button type="button" onClick={onForget} className="mt-3 text-xs text-slate-500 underline">Stop syncing on this device</button>
          </>
        )}
      </div>
    </div>
  );
}
