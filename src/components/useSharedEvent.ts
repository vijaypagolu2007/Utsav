"use client";
// Organizer side of shared guest links: publish once, then keep the server copy in sync.
// The organizer token lives only in this browser's localStorage (never in the plan, never in a URL).
// Every sync is GET → rebase guest-owned fields → PUT with baseVersion, so a guest's RSVP that landed in between
// is merged in (and shown on the canvas) instead of being overwritten.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentState } from "@/schema";
import type { TemplateId } from "@/config/event-templates";
import { rebaseGuestFields } from "@/sync";

export const SHARE_KEY = "utsav_share_v1";
export type Invite = { householdId: string; label: string; token: string };
/**
 * joinToken (v8 Part 1): the group join link's token while it is switched on, null when off (absent on older records).
 * v8 Part 1c: rsvpToken is the event's one open RSVP link (absent on share info saved before it until the next sync).
 */
export type ShareInfo = { eventId: string; organizerToken: string; version: number; invites: Invite[]; joinToken?: string | null; rsvpToken?: string | null };
export type ShareStatus = { state: "idle" | "publishing" | "syncing" | "synced" | "error" | "unconfigured"; message?: string; at?: number };

function loadShares(): Partial<Record<TemplateId, ShareInfo>> {
  try { return JSON.parse(window.localStorage.getItem(SHARE_KEY) ?? "{}") as Partial<Record<TemplateId, ShareInfo>>; } catch { return {}; }
}
function saveShares(s: Partial<Record<TemplateId, ShareInfo>>) {
  try { window.localStorage.setItem(SHARE_KEY, JSON.stringify(s)); } catch { /* storage full or disabled */ }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The plan both sides last agreed on, per template slot: the base of the three-way merge. Local-only. */
const BASE_KEY = "utsav_share_base_v1";
function loadBase(t: TemplateId): AgentState | null {
  try { return (JSON.parse(window.localStorage.getItem(BASE_KEY) ?? "{}") as Partial<Record<TemplateId, AgentState>>)[t] ?? null; } catch { return null; }
}
function saveBase(t: TemplateId, plan: AgentState | null) {
  try {
    const all = JSON.parse(window.localStorage.getItem(BASE_KEY) ?? "{}") as Partial<Record<TemplateId, AgentState>>;
    if (plan) all[t] = plan; else delete all[t];
    window.localStorage.setItem(BASE_KEY, JSON.stringify(all));
  } catch { /* storage full or disabled: the merge falls back to two-way */ }
}

async function api(path: string, init: RequestInit & { token?: string } = {}) {
  const { token, ...rest } = init;
  const res = await fetch(path, { ...rest, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...rest.headers } });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, body };
}

/** PATCH /api/events/:id { removed }: switch a shared event's guest links off (deleted) or on (restored). */
export async function setRemoved(s: Pick<ShareInfo, "eventId" | "organizerToken">, removed: boolean): Promise<boolean> {
  try { return (await api(`/api/events/${encodeURIComponent(s.eventId)}`, { method: "PATCH", token: s.organizerToken, body: JSON.stringify({ removed }) })).status === 200; }
  catch { return false; }
}

type SyncDeps = {
  getPlan: () => AgentState;
  onMerge: (merged: AgentState) => void;
  setStatus: (s: ShareStatus) => void;
  update: (t: TemplateId, s: ShareInfo | null) => void;
};
const inFlight = new Set<TemplateId>();
const rerun = new Set<TemplateId>();

/** GET → rebase guest fields → PUT with baseVersion; retries on 409. One run per event type at a time. */
async function reconcile(t: TemplateId, info: ShareInfo, d: SyncDeps): Promise<void> {
  if (inFlight.has(t)) { rerun.add(t); return; }
  inFlight.add(t);
  d.setStatus({ state: "syncing" });
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const got = await api(`/api/events/${info.eventId}`, { token: info.organizerToken, cache: "no-store" });
      if (got.status === 401 || got.status === 404) { d.setStatus({ state: "error", message: "This device lost access to the shared event (link expired or token invalid)." }); return; }
      if (got.status === 503) { d.setStatus({ state: "unconfigured", message: String(got.body.message ?? "Shared storage is not configured") }); return; }
      if (got.status !== 200) { d.setStatus({ state: "error", message: String(got.body.message ?? `Sync failed (${got.status})`) }); return; }
      const remote = got.body.plan as AgentState, version = Number(got.body.version);
      const local = d.getPlan();
      if (local.event.eventType !== t) return;
      const base = loadBase(t);
      // The base must belong to this shared event; a stale or foreign base would make the merge unsafe.
      const merged = rebaseGuestFields(local, remote, base && base.event.id === remote.event.id ? base : null);
      if (!same(merged, local)) d.onMerge(merged);
      let invites = got.body.invites as Invite[];
      let rsvpToken = (got.body.rsvpToken as string | null | undefined) ?? null;
      const joinToken = (got.body.joinToken as string | null | undefined) ?? null;
      let v = version;
      if (!same(merged, remote)) {
        const put = await api(`/api/events/${info.eventId}`, { method: "PUT", token: info.organizerToken, body: JSON.stringify({ plan: merged, baseVersion: version }) });
        if (put.status === 409) continue; // a guest wrote meanwhile: pull again and re-merge
        if (put.status !== 200) { d.setStatus({ state: "error", message: String(put.body.message ?? `Sync failed (${put.status})`) }); return; }
        v = Number(put.body.version); invites = put.body.invites as Invite[];
        rsvpToken = (put.body.rsvpToken as string | null | undefined) ?? rsvpToken;
      }
      saveBase(t, merged);
      if (v !== info.version || !same(invites, info.invites) || joinToken !== (info.joinToken ?? null) || rsvpToken !== (info.rsvpToken ?? null))
        d.update(t, { ...info, version: v, invites, joinToken, rsvpToken });
      d.setStatus({ state: "synced", at: Date.now() });
      return;
    }
    d.setStatus({ state: "error", message: "The event keeps changing. Try syncing again in a moment." });
  } catch {
    d.setStatus({ state: "error", message: "Offline: changes will sync when the server is reachable." });
  } finally {
    inFlight.delete(t);
    if (rerun.delete(t)) { const s = loadShares()[t]; if (s) void reconcile(t, s, d); }
  }
}

export function useSharedEvent(type: TemplateId, plan: AgentState, onMerge: (merged: AgentState) => void) {
  const [shares, setShares] = useState<Partial<Record<TemplateId, ShareInfo>>>(() => loadShares());
  const [status, setStatus] = useState<ShareStatus>({ state: "idle" });
  const share = shares[type] ?? null;
  const planRef = useRef(plan);
  const onMergeRef = useRef(onMerge);
  useEffect(() => { planRef.current = plan; onMergeRef.current = onMerge; });

  const update = useCallback((t: TemplateId, s: ShareInfo | null) => {
    setShares(prev => {
      const next = { ...prev };
      if (s) next[t] = s; else delete next[t];
      saveShares(next);
      return next;
    });
  }, []);


  const publish = useCallback(async () => {
    setStatus({ state: "publishing" });
    try {
      const r = await api("/api/events", { method: "POST", body: JSON.stringify({ plan: planRef.current }) });
      if (r.status === 503) { setStatus({ state: "unconfigured", message: String(r.body.message ?? "Shared storage is not configured") }); return; }
      if (r.status !== 201) { setStatus({ state: "error", message: String(r.body.message ?? `Couldn't publish (${r.status})`) }); return; }
      saveBase(type, planRef.current);
      update(type, { eventId: String(r.body.eventId), organizerToken: String(r.body.organizerToken), version: Number(r.body.version), invites: r.body.invites as Invite[],
        rsvpToken: (r.body.rsvpToken as string | null | undefined) ?? null });
      setStatus({ state: "synced", at: Date.now() });
    } catch {
      setStatus({ state: "error", message: "Server unreachable." });
    }
  }, [type, update]);

  const forget = useCallback(() => { update(type, null); saveBase(type, null); setStatus({ state: "idle" }); }, [type, update]);
  const syncNow = useCallback(() => {
    const s = loadShares()[type];
    if (s) void reconcile(type, s, { getPlan: () => planRef.current, onMerge: m => onMergeRef.current(m), setStatus, update });
  }, [type, update]);

  // Push local edits (debounced) and pull guest responses (every 20 s and when the tab regains focus).
  // Depend on the event id, not the share object: its identity changes on every version bump, which would
  // otherwise re-trigger a sync after every sync.
  const sharedId = share?.eventId ?? null;
  const planKey = sharedId ? JSON.stringify(plan) : "";
  useEffect(() => {
    if (!sharedId) return;
    const t = setTimeout(syncNow, 1200);
    return () => clearTimeout(t);
  }, [planKey, sharedId, syncNow]);
  useEffect(() => {
    if (!sharedId) return;
    const iv = setInterval(syncNow, 20_000);
    const onFocus = () => syncNow();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(iv); window.removeEventListener("focus", onFocus); };
  }, [sharedId, syncNow]);

  /**
   * v8 Part 0c. Deleting an event parks its guest link (with the organizer token) in the trash and switches the link off
   * on the server (410 for guests); Restore puts it back and switches it on again. Best effort: offline, the link keeps
   * working until the organizer is back online and deletes or restores again.
   */
  const detach = useCallback((t: TemplateId): ShareInfo | null => {
    const s = loadShares()[t] ?? null;
    if (s) { update(t, null); saveBase(t, null); void setRemoved(s, true); }
    return s;
  }, [update]);
  const attach = useCallback((t: TemplateId, s: ShareInfo) => {
    update(t, s);
    void setRemoved(s, false);
  }, [update]);

  /**
   * v8 Part 1. Organizer actions on the server copy that are not plan data: a new private link for one household (the
   * old one stops working), and the group join link (enable, rotate to a new token, disable). Both return an error
   * message, or null when it worked, and update the stored share info.
   */
  const serverAction = useCallback(async (path: string, body: unknown): Promise<string | null> => {
    const s = loadShares()[type];
    if (!s) return "Publish guest links first";
    try {
      const r = await api(`/api/events/${encodeURIComponent(s.eventId)}/${path}`, { method: "POST", token: s.organizerToken, body: JSON.stringify(body) });
      if (r.status !== 200) return String(r.body.message ?? `The server answered ${r.status}`);
      update(type, { ...s, version: Number(r.body.version), invites: r.body.invites as Invite[], joinToken: (r.body.joinToken as string | null) ?? null,
        rsvpToken: (r.body.rsvpToken as string | null | undefined) ?? s.rsvpToken ?? null });
      return null;
    } catch {
      return "Server unreachable: try again when you're online.";
    }
  }, [type, update]);
  const resetInvite = useCallback((householdId: string) => serverAction("invites", { householdId }), [serverAction]);
  const setJoinLink = useCallback((action: "enable" | "rotate" | "disable") => serverAction("join-link", { action }), [serverAction]);
  /** v8 Part 1c: a new RSVP link for the event (also makes the first one for an event shared before it). */
  const resetRsvpLink = useCallback(() => serverAction("invites", { rsvpLink: true }), [serverAction]);

  return { share, status, publish, forget, syncNow, detach, attach, resetInvite, setJoinLink, resetRsvpLink };
}
