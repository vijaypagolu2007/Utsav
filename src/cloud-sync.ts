// Cloud save for signed-in organizers: the pure decision logic and a small API client. No React, no Firebase: the
// hook (components/useCloudSync.ts) supplies the ID token and the plan, and this module decides what to do.
//
// Local storage stays the working copy. The cloud copy is a per-slot backup that follows the organizer across
// devices. When the two differ and it isn't obvious which is newer, the organizer chooses; nothing is merged silently.
import { AgentState } from "./schema";

export type CloudCopy = { version: number; updatedAt: string; plan: AgentState;
  /** v8 Part 0c: set when the organizer deleted the event (a tombstone: the plan is kept so it can be restored). */
  deletedAt?: string | null };
/** What this device last agreed with the cloud for one (user, slot): the version and a fingerprint of that plan. */
export type SyncBase = { version: number; hash: string };

export type SyncStatus =
  | { state: "signed_out" }
  | { state: "checking" }
  | { state: "saving" }
  | { state: "saved"; at: number }
  | { state: "offline" }
  /** v8 Part 0b: an untouched sample with no cloud copy, kept on this device only (see my-events.ts mayCreateCloudCopy). */
  | { state: "sample" }
  | { state: "choose"; cloud: CloudCopy; reason: "differs" | "conflict" }
  /**
   * v8 Part 0c: a deletion and edits the other side never saw (trash.ts decideTombstoneSync "choose"). deleted_elsewhere:
   * deleted on another device, edited here. edited_elsewhere: deleted here while offline, edited on another device.
   */
  | { state: "choose_deleted"; cloud: CloudCopy; reason: "deleted_elsewhere" | "edited_elsewhere" }
  | { state: "error"; message: string };

/** JSON with object keys sorted, so two equal plans serialise the same whatever order their keys were built in. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(x => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

/**
 * Short, stable fingerprint of a plan (53-bit cyrb53 over its canonical JSON). The plan is normalised through the schema
 * first (the server stores the parsed plan, defaults filled in), so equal plans give equal hashes on both sides.
 */
export function planHash(plan: AgentState): string {
  const p = AgentState.safeParse(plan);
  const s = canonicalJson(p.success ? p.data : plan);
  let h1 = 0xdeadbeef ^ s.length, h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export type SignInDecision =
  /** No cloud copy yet: upload this device's plan as version 1. */
  | { kind: "create" }
  /** Cloud and device already match: just remember the version. */
  | { kind: "in_sync"; version: number }
  /** The cloud copy is the one this device last saved and only the device changed since: save over it, no question. */
  | { kind: "push"; baseVersion: number }
  /** They differ and either side may be newer: ask "Use cloud copy" or "Keep this device's plan". */
  | { kind: "choose" };

/**
 * What to do when an organizer signs in (or opens a slot while signed in). Never picks the cloud copy on its own:
 * replacing the plan on screen is always the organizer's call.
 */
export function decideOnSignIn(local: AgentState, cloud: CloudCopy | null, base: SyncBase | null): SignInDecision {
  if (!cloud) return { kind: "create" };
  const lh = planHash(local), ch = planHash(cloud.plan);
  if (lh === ch) return { kind: "in_sync", version: cloud.version };
  if (base && base.version === cloud.version && base.hash === ch) return { kind: "push", baseVersion: cloud.version };
  return { kind: "choose" };
}

/** Autosave runs only while signed in, with nothing to decide, and when the plan differs from what the cloud holds. */
export function shouldAutosave(status: SyncStatus, local: AgentState, base: SyncBase | null): boolean {
  if (status.state === "signed_out" || status.state === "checking" || status.state === "choose" || status.state === "choose_deleted" || status.state === "saving") return false;
  return !base || base.hash !== planHash(local);
}

/** "Keep this device's plan" overwrites the cloud: save with the cloud's current version as the base. */
export const keepLocalBaseVersion = (cloud: CloudCopy | null, currentVersion = 0) => cloud?.version ?? currentVersion;

export const AUTOSAVE_DEBOUNCE_MS = 1500;

/** The status line shown next to the account control. */
export function statusLabel(s: SyncStatus): string {
  switch (s.state) {
    case "signed_out": return "Not signed in";
    case "checking": return "Checking cloud copy…";
    case "saving": return "Saving…";
    case "saved": return "Saved to cloud";
    case "offline": return "Offline – saved on this device";
    case "sample": return "Sample – not saved to your account";
    case "choose": return s.reason === "conflict" ? "Cloud copy changed elsewhere – choose a version" : "Cloud and device differ – choose a version";
    case "choose_deleted": return s.reason === "deleted_elsewhere" ? "Deleted on another device – choose what to keep" : "Edited on another device after you deleted it – choose";
    case "error": return s.message;
  }
}

// ---------- API client (fetch is injectable for tests) ----------
export type CloudApiResult =
  | { kind: "ok"; version: number; updatedAt: string }
  | { kind: "copy"; copy: CloudCopy | null }
  | { kind: "conflict"; current: CloudCopy | null; currentVersion: number }
  | { kind: "unauthorized" }
  | { kind: "unavailable"; message: string }
  | { kind: "offline" }
  | { kind: "error"; message: string };

type Fetch = typeof fetch;
const url = (planKey: string) => `/api/cloud/plans/${encodeURIComponent(planKey)}`;

function parseCopy(raw: unknown): CloudCopy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const p = AgentState.safeParse(r.plan);
  if (!p.success || !Number.isInteger(r.version)) return null;
  const copy: CloudCopy = { version: r.version as number, updatedAt: String(r.updatedAt ?? ""), plan: p.data };
  if (typeof r.deletedAt === "string" && r.deletedAt) copy.deletedAt = r.deletedAt;
  return copy;
}

async function call(f: Fetch, path: string, token: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> } | null> {
  try {
    const res = await f(path, { ...init, cache: "no-store", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch { return null; }
}

const common = (r: { status: number; body: Record<string, unknown> } | null): CloudApiResult | null => {
  if (!r) return { kind: "offline" };
  if (r.status === 401) return { kind: "unauthorized" };
  if (r.status === 503) return { kind: "unavailable", message: String(r.body.message ?? "Cloud save isn't available") };
  return null;
};

export async function fetchCloudCopy(planKey: string, token: string, f: Fetch = fetch): Promise<CloudApiResult> {
  const r = await call(f, url(planKey), token);
  const c = common(r); if (c) return c;
  if (r!.status === 404) return { kind: "copy", copy: null };
  if (r!.status === 200) {
    const copy = parseCopy(r!.body);
    return copy ? { kind: "copy", copy } : { kind: "error", message: "The cloud copy couldn't be read" };
  }
  return { kind: "error", message: String(r!.body.message ?? `Cloud save failed (${r!.status})`) };
}

export async function saveCloudCopy(planKey: string, token: string, plan: AgentState, baseVersion: number, f: Fetch = fetch): Promise<CloudApiResult> {
  const r = await call(f, url(planKey), token, { method: "PUT", body: JSON.stringify({ plan, baseVersion }) });
  const c = common(r); if (c) return c;
  if (r!.status === 200) return { kind: "ok", version: Number(r!.body.version), updatedAt: String(r!.body.updatedAt ?? "") };
  if (r!.status === 409) return { kind: "conflict", current: parseCopy(r!.body.current), currentVersion: Number(r!.body.currentVersion) || 0 };
  return { kind: "error", message: String(r!.body.message ?? `Cloud save failed (${r!.status})`) };
}

/** v8 Part 0c: tombstone the cloud copy (the plan stays, so Restore works anywhere). Same compare-and-set as a save. */
export async function tombstoneCloudCopy(planKey: string, token: string, baseVersion: number, f: Fetch = fetch): Promise<CloudApiResult> {
  const r = await call(f, url(planKey), token, { method: "PUT", body: JSON.stringify({ deleted: true, baseVersion }) });
  const c = common(r); if (c) return c;
  if (r!.status === 200) return { kind: "ok", version: Number(r!.body.version), updatedAt: String(r!.body.updatedAt ?? "") };
  if (r!.status === 404) return { kind: "copy", copy: null };
  if (r!.status === 409) return { kind: "conflict", current: parseCopy(r!.body.current), currentVersion: Number(r!.body.currentVersion) || 0 };
  return { kind: "error", message: String(r!.body.message ?? `Cloud delete failed (${r!.status})`) };
}

/** v8 Part 0c: "Delete forever": a real DELETE of a tombstoned copy (version- and event-checked by the server). */
export async function deleteCloudCopy(planKey: string, token: string, baseVersion: number, eventId: string, f: Fetch = fetch): Promise<CloudApiResult> {
  const q = new URLSearchParams({ baseVersion: String(baseVersion), eventId });
  const r = await call(f, `${url(planKey)}?${q}`, token, { method: "DELETE" });
  const c = common(r); if (c) return c;
  if (r!.status === 200 || r!.status === 404) return { kind: "copy", copy: null };
  if (r!.status === 409) return { kind: "conflict", current: parseCopy(r!.body.current), currentVersion: Number(r!.body.currentVersion) || 0 };
  return { kind: "error", message: String(r!.body.message ?? `Cloud delete failed (${r!.status})`) };
}

// ---------- per-device memory of the last agreed version (localStorage, separate from the plan store) ----------
export const CLOUD_BASE_KEY = "utsav_cloud_base_v1";
const baseId = (uid: string, planKey: string) => `${uid}:${planKey}`;
export function loadSyncBase(uid: string, planKey: string): SyncBase | null {
  try {
    const all = JSON.parse(window.localStorage.getItem(CLOUD_BASE_KEY) ?? "{}") as Record<string, SyncBase>;
    const b = all[baseId(uid, planKey)];
    return b && Number.isInteger(b.version) && typeof b.hash === "string" ? b : null;
  } catch { return null; }
}
export function saveSyncBase(uid: string, planKey: string, b: SyncBase | null): void {
  try {
    const all = JSON.parse(window.localStorage.getItem(CLOUD_BASE_KEY) ?? "{}") as Record<string, SyncBase>;
    if (b) all[baseId(uid, planKey)] = b; else delete all[baseId(uid, planKey)];
    window.localStorage.setItem(CLOUD_BASE_KEY, JSON.stringify(all));
  } catch { /* storage full or blocked: the next sign-in asks again */ }
}
