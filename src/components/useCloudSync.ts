"use client";
// Signed-in cloud save for the plan on screen. Local storage stays the working copy; this keeps a cloud copy per slot
// (users/{uid}/plans/{slot}) through /api/cloud/plans/*. On sign-in (and when the slot changes) it compares the two
// and, when they differ and neither is clearly newer, asks the organizer which to keep. After that, every plan change
// is saved after a short pause; a 409 (changed on another device) asks again with the same two choices.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentState } from "@/schema";
import {
  AUTOSAVE_DEBOUNCE_MS, decideOnSignIn, deleteCloudCopy, fetchCloudCopy, keepLocalBaseVersion, loadSyncBase, planHash, saveCloudCopy, saveSyncBase, shouldAutosave,
  tombstoneCloudCopy, type CloudApiResult, type CloudCopy, type SyncStatus,
} from "@/cloud-sync";
import { decideTombstoneSync, loadPending, mayDeleteForever, savePending } from "@/trash";
import { TEMPLATES } from "@/config/event-templates";
import { flushStore } from "@/persistence";
import { markSignedInOnDevice } from "@/signin";
import type { CloudPlans } from "@/my-events";
import { loadAuthState, warnUnavailable, type AuthApi, type CloudUser, type UnavailableReason } from "./cloud-auth";

export type CloudSync = {
  /** True once sign-in works on this build (configured and the SDK loaded). */
  enabled: boolean;
  /** Why sign-in can't be offered (null while loading or when it works): shown as "Sign-in unavailable", never hidden. */
  unavailable: UnavailableReason | null;
  /** The auth state is known: Firebase answered (signed in or not), or sign-in is unavailable. */
  authReady: boolean;
  user: CloudUser | null;
  status: SyncStatus;
  /** Sign out of the account; the planner decides where to go next. */
  signOut: () => Promise<void>;
  chooseCloud: () => void;
  chooseLocal: () => void;
  retry: () => void;
  /**
   * v8 Part 0b: what the account holds across these slots ("none" only when every slot answered "no copy"). Read-only:
   * used once on a first sign-in to decide whether to offer "Start your own event / Load sample events".
   */
  probe: (keys: readonly string[]) => Promise<CloudPlans>;
  /**
   * v8 Part 0c. The planner moved a slot's event to its trash: tombstone the cloud copy now (or as soon as this device is
   * signed in and online; the debt is kept per slot in utsav_cloud_pending_v1).
   */
  markDeleted: (planKey: string, plan: AgentState) => void;
  /** The planner restored a deleted event into its slot: the next sync saves it over the tombstone (clearing it). */
  markRestored: (planKey: string, plan: AgentState) => void;
  /** "Delete forever": remove the cloud copy, only when it is this event's tombstone. Best effort; local is already gone. */
  deleteForever: (planKey: string, eventId: string) => Promise<void>;
  /** The "choose_deleted" chooser: keep the event (with this device's edits, or the other device's) or keep it deleted. */
  chooseRestoreDeleted: () => void;
  chooseKeepDeleted: () => void;
};

/**
 * v8 Part 0c. What the planner does when the cloud says an event was deleted elsewhere (move this device's copy to its
 * trash), or when "Restore with those edits" brings back the other device's version of an event deleted here (false when
 * the slot is taken by another event of the organizer's own).
 */
export type DeletionHooks = {
  onRemoteDelete: (planKey: string, deletedAt: number) => void;
  onRestoreFromCloud: (planKey: string, plan: AgentState) => boolean;
  /** The slot holds its untouched sample. */
  isPristine: (planKey: string, plan: AgentState) => boolean;
  /**
   * v8 Part 0d: the slot's sample was deleted on this device and nothing replaced it. Its plan is only a placeholder:
   * it is never saved, created or compared (a deletion this device still owes for it is still sent).
   */
  isRemoved?: (planKey: string) => boolean;
};
const NO_HOOKS: DeletionHooks = { onRemoteDelete: () => {}, onRestoreFromCloud: () => false, isPristine: () => false, isRemoved: () => false };

/** May this device create the first cloud copy of a slot (false keeps an untouched sample local: status "sample"). */
export type MayCreate = (uid: string, planKey: string, plan: AgentState) => boolean;
const ALWAYS: MayCreate = () => true;

const SIGNED_OUT: SyncStatus = { state: "signed_out" };

export function useCloudSync(planKey: string, plan: AgentState, onUseCloud: (cloud: AgentState) => void, mayCreate: MayCreate = ALWAYS, hooks: DeletionHooks = NO_HOOKS): CloudSync {
  const [enabled, setEnabled] = useState(false);
  const [user, setUser] = useState<CloudUser | null>(null);
  const [status, setStatusState] = useState<SyncStatus>({ state: "signed_out" });
  const [unavailable, setUnavailable] = useState<UnavailableReason | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const auth = useRef<AuthApi | null>(null);
  const statusRef = useRef(status);
  const planRef = useRef(plan);
  const keyRef = useRef(planKey);
  const userRef = useRef(user);
  const onUseCloudRef = useRef(onUseCloud);
  const mayCreateRef = useRef(mayCreate);
  const hooksRef = useRef(hooks);
  /** Tombstone rounds in a row (save → 409 on a tombstone → check → save …): stops a loop if the cloud keeps moving. */
  const tombRounds = useRef(0);
  /** Bumped whenever the user or slot changes, so a reply for the old one is ignored. */
  const gen = useRef(0);
  /** The server said cloud save isn't configured: stop autosaving until the next sign-in or retry. */
  const cloudOff = useRef(false);
  useEffect(() => { planRef.current = plan; keyRef.current = planKey; onUseCloudRef.current = onUseCloud; mayCreateRef.current = mayCreate; hooksRef.current = hooks; });
  const setStatus = useCallback((s: SyncStatus) => { statusRef.current = s; setStatusState(s); }, []);

  // Load the auth module (the test stand-in, or Firebase when configured). When it can't load, say why: the header and
  // the sign-in page show "Sign-in unavailable" with the reason, and the opening logic stops waiting for an answer.
  useEffect(() => {
    let off: (() => void) | undefined, live = true;
    void loadAuthState().then(s => {
      if (!live) return;
      if (!s.ok) {
        if (s.reason === "unconfigured") warnUnavailable("unconfigured");
        setUnavailable(s.reason); setAuthReady(true);
        return;
      }
      auth.current = s.api;
      setEnabled(true);
      off = s.api.subscribe(u => {
        if (u) markSignedInOnDevice();
        userRef.current = u; setUser(u); setAuthReady(true);
      });
    });
    // Firebase answers onAuthStateChanged within moments (from its local persistence, even offline); if it never does,
    // stop holding the opening after a few seconds rather than leaving the organizer on a loading screen.
    const t = setTimeout(() => { if (live) setAuthReady(true); }, 8000);
    return () => { live = false; clearTimeout(t); off?.(); };
  }, []);

  const token = useCallback(async (force = false) => { try { return (await auth.current?.getIdToken(force)) ?? null; } catch { return null; } }, []);

  /** Run an API call with the current ID token, refreshing it once on 401. */
  const withToken = useCallback(async (f: (t: string) => Promise<CloudApiResult>): Promise<CloudApiResult> => {
    let t = await token();
    if (!t) return { kind: "unauthorized" };
    let r = await f(t);
    if (r.kind === "unauthorized") { t = await token(true); if (t) r = await f(t); }
    return r;
  }, [token]);

  const fail = useCallback((r: CloudApiResult) => {
    if (r.kind === "offline") setStatus({ state: "offline" });
    else if (r.kind === "unauthorized") setStatus({ state: "error", message: "Sign in again to keep saving to the cloud" });
    else if (r.kind === "unavailable") { cloudOff.current = true; setStatus({ state: "error", message: "Cloud save is unavailable – saved on this device" }); }
    else if (r.kind === "error") setStatus({ state: "error", message: r.message });
  }, [setStatus]);

  // check() and save() call each other on a tombstone; the ref breaks the declaration cycle.
  const checkRef = useRef<() => Promise<void>>(async () => {});
  const save = useCallback(async (baseVersion: number): Promise<void> => {
    const u = userRef.current, key = keyRef.current, g = gen.current;
    if (!u) return;
    let base = baseVersion, replacedUnreadable = false;
    // A few rounds at most: a newer plan typed while a save was in flight, or one unreadable cloud copy replaced.
    for (let round = 0; round < 5; round++) {
      const sent = planRef.current;
      setStatus({ state: "saving" });
      const r = await withToken(t => saveCloudCopy(key, t, sent, base));
      if (g !== gen.current) return;
      if (r.kind === "ok") {
        saveSyncBase(u.uid, key, { version: r.version, hash: planHash(sent) });
        tombRounds.current = 0;
        // A restore (or a new event over an old tombstone) has reached the cloud.
        const p = loadPending(key);
        if (p?.kind === "restore" && p.eventId === sent.event.id) savePending(key, null);
        setStatus({ state: "saved", at: Date.now() });
        // The plan changed while this save was in flight (its autosave was skipped): save the newer one too.
        if (planRef.current !== sent && keyRef.current === key) { base = r.version; continue; }
        return;
      }
      if (r.kind === "conflict") {
        // An unreadable or vanished cloud copy has nothing to choose between: replace it with this device's plan, once.
        if (!r.current && !replacedUnreadable) { replacedUnreadable = true; base = r.currentVersion; continue; }
        if (!r.current) { setStatus({ state: "error", message: "Couldn't save to the cloud" }); return; }
        // v8 Part 0c: the cloud copy is a tombstone. check() decides (remove here, restore, replace, or ask).
        if (r.current.deletedAt || loadPending(key)) {
          if (++tombRounds.current > 3) { setStatus({ state: "error", message: "Couldn't save to the cloud" }); return; }
          await checkRef.current();
          return;
        }
        setStatus({ state: "choose", cloud: r.current, reason: "conflict" });
        return;
      }
      fail(r);
      return;
    }
  }, [withToken, setStatus, fail]);

  /**
   * v8 Part 0c: send a deletion this device owes for any slot (not only the one on screen). The cloud copy is
   * tombstoned only when it is still the version this device knew; anything else waits for check(), which asks.
   */
  const sendPendingDelete = useCallback(async (key: string) => {
    const pending = loadPending(key);
    if (!userRef.current || pending?.kind !== "delete") return;
    const r = await withToken(t => fetchCloudCopy(key, t));
    if (r.kind !== "copy") return;
    if (!r.copy || r.copy.plan.event.id !== pending.eventId) { if (!r.copy) savePending(key, null); return; }
    if (r.copy.deletedAt) { savePending(key, null); return; }
    if (pending.baseVersion === null || r.copy.version !== pending.baseVersion) return;
    const w = await withToken(t => tombstoneCloudCopy(key, t, r.copy!.version));
    if (w.kind === "ok" || (w.kind === "copy" && !w.copy)) savePending(key, null);
  }, [withToken]);

  /** Compare this device's plan with the cloud copy and act on decideOnSignIn. */
  const check = useCallback(async () => {
    const u = userRef.current, key = keyRef.current, g = ++gen.current;
    if (!u) return;
    // v8 Part 2 fix: decide from the plan in memory (planRef), with any debounced save written first, so storage and the
    // sign-in decision (edited sample vs untouched) agree.
    flushStore();
    cloudOff.current = false;
    // v8 Part 0d: a deleted sample's placeholder: only the deletion this device owes (if any) is sent.
    if (hooksRef.current.isRemoved?.(key)) { void sendPendingDelete(key); setStatus({ state: "sample" }); return; }
    setStatus({ state: "checking" });
    const r = await withToken(t => fetchCloudCopy(key, t));
    if (g !== gen.current) return;
    if (r.kind !== "copy") { fail(r); return; }
    // v8 Part 0c: a tombstone, or a deletion/restore this device still owes, comes first.
    const pending = loadPending(key);
    if (pending && (!r.copy || (pending.kind === "delete" && r.copy.deletedAt && r.copy.plan.event.id === pending.eventId)
      || (pending.kind === "restore" && !r.copy.deletedAt))) savePending(key, null);
    const t = decideTombstoneSync({ local: planRef.current, localPristine: hooksRef.current.isPristine(key, planRef.current), cloud: r.copy,
      base: loadSyncBase(u.uid, key), pending: loadPending(key) });
    if (t.kind !== "none") {
      const cloud = r.copy!;
      if (t.kind === "remove_local") {
        saveSyncBase(u.uid, key, null);
        hooksRef.current.onRemoteDelete(key, Date.parse(t.deletedAt) || Date.now());
        setStatus({ state: "sample" });
      } else if (t.kind === "keep_local_only") { saveSyncBase(u.uid, key, null); setStatus({ state: "sample" }); }
      else if (t.kind === "restore" || t.kind === "replace") await save(t.baseVersion);
      else if (t.kind === "send_tombstone") {
        const w = await withToken(tk => tombstoneCloudCopy(key, tk, t.baseVersion));
        if (g !== gen.current) return;
        if (w.kind === "ok" || (w.kind === "copy" && !w.copy)) { savePending(key, null); if (++tombRounds.current <= 3) await checkRef.current(); }
        else if (w.kind === "conflict") { if (++tombRounds.current <= 3) await checkRef.current(); }
        else fail(w);
      } else setStatus({ state: "choose_deleted", cloud, reason: t.reason });
      return;
    }
    const d = decideOnSignIn(planRef.current, r.copy, loadSyncBase(u.uid, key));
    // No cloud copy yet: an untouched sample stays on this device until the organizer loads the samples or edits it.
    if (d.kind === "create") { if (mayCreateRef.current(u.uid, key, planRef.current)) await save(0); else setStatus({ state: "sample" }); }
    else if (d.kind === "push") await save(d.baseVersion);
    else if (d.kind === "in_sync") { saveSyncBase(u.uid, key, { version: d.version, hash: planHash(planRef.current) }); setStatus({ state: "saved", at: Date.now() }); }
    else setStatus({ state: "choose", cloud: r.copy!, reason: "differs" });
  }, [withToken, setStatus, fail, save, sendPendingDelete]);
  useEffect(() => { checkRef.current = check; }, [check]);

  // Signed in, or switched to another slot while signed in: compare again. Signed out: reset.
  const uid = user?.uid ?? null;
  useEffect(() => {
    if (!uid) { gen.current++; return; }
    tombRounds.current = 0;
    void check();
  }, [uid, planKey, check]);
  // Signed in: send the deletions this device made while signed out or offline (every slot).
  useEffect(() => {
    if (!uid) return;
    for (const t of TEMPLATES) if (t.id !== keyRef.current) void sendPendingDelete(t.id);
  }, [uid, sendPendingDelete]);
  // Back on this tab: look again, so a deletion made on another device shows up without a reload.
  useEffect(() => {
    if (!uid) return;
    const on = () => {
      const st = statusRef.current.state;
      if (document.visibilityState === "visible" && (st === "saved" || st === "sample")) void check();
    };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [uid, check]);

  // Autosave ~1.5 s after the plan changes, unless something is waiting on the organizer's choice.
  useEffect(() => {
    if (!uid) return;
    const t = setTimeout(() => {
      const u = userRef.current;
      if (!u || cloudOff.current || hooksRef.current.isRemoved?.(keyRef.current)) return;
      const base = loadSyncBase(u.uid, keyRef.current);
      if (statusRef.current.state === "offline" || statusRef.current.state === "error") { void check(); return; }
      if (!base && !mayCreateRef.current(u.uid, keyRef.current, planRef.current)) { if (statusRef.current.state === "saved") setStatus({ state: "sample" }); return; }
      if (shouldAutosave(statusRef.current, planRef.current, base)) void save(base?.version ?? 0);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [plan, uid, save, check, setStatus]);

  // Back online: compare and save what changed meanwhile.
  useEffect(() => {
    if (!uid) return;
    const on = () => { if (statusRef.current.state === "offline") void check(); };
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [uid, check]);

  const signOut = useCallback(async () => { try { await auth.current?.signOut(); } catch { /* already signed out */ } }, []);

  const chooseCloud = useCallback(() => {
    const s = statusRef.current, u = userRef.current;
    if (s.state !== "choose" || !u) return;
    const cloud: CloudCopy = s.cloud;
    // Recorded before the plan changes, so the autosave that follows sees nothing new to save.
    saveSyncBase(u.uid, keyRef.current, { version: cloud.version, hash: planHash(cloud.plan) });
    onUseCloudRef.current(cloud.plan);
    setStatus({ state: "saved", at: Date.now() });
  }, [setStatus]);
  const chooseLocal = useCallback(() => {
    const s = statusRef.current;
    if (s.state !== "choose") return;
    void save(keepLocalBaseVersion(s.cloud));
  }, [save]);
  const retry = useCallback(() => { void check(); }, [check]);
  const probe = useCallback(async (keys: readonly string[]): Promise<CloudPlans> => {
    if (!userRef.current) return "unknown";
    const all = await Promise.all(keys.map(k => withToken(t => fetchCloudCopy(k, t))));
    if (all.some(r => r.kind === "copy" && r.copy)) return "some";
    return all.every(r => r.kind === "copy") ? "none" : "error";
  }, [withToken]);

  const markDeleted = useCallback((key: string, deleted: AgentState) => {
    const u = userRef.current;
    const base = u ? loadSyncBase(u.uid, key) : null;
    // The version this device last agreed on. Never synced from here (null): a cloud copy of this event made elsewhere is
    // asked about, not tombstoned blind.
    savePending(key, { kind: "delete", eventId: deleted.event.id, baseVersion: base?.version ?? null });
    if (u) saveSyncBase(u.uid, key, null);
    void sendPendingDelete(key);
  }, [sendPendingDelete]);
  const markRestored = useCallback((key: string, restored: AgentState) => {
    const p = loadPending(key);
    // Restored before the deletion ever reached the cloud: there is nothing to undo there.
    if (p?.kind === "delete" && p.eventId === restored.event.id) { savePending(key, null); return; }
    savePending(key, { kind: "restore", eventId: restored.event.id });
    const u = userRef.current;
    if (u) saveSyncBase(u.uid, key, null);
    tombRounds.current = 0;
  }, []);
  const deleteForever = useCallback(async (key: string, eventId: string) => {
    const p = loadPending(key);
    if (p && p.eventId === eventId && p.kind === "restore") savePending(key, null);
    if (!userRef.current) return;
    const r = await withToken(t => fetchCloudCopy(key, t));
    if (r.kind !== "copy" || !mayDeleteForever(r.copy, eventId)) return;
    await withToken(t => deleteCloudCopy(key, t, r.copy!.version, eventId));
  }, [withToken]);
  const chooseRestoreDeleted = useCallback(() => {
    const s = statusRef.current, u = userRef.current;
    if (s.state !== "choose_deleted" || !u) return;
    const key = keyRef.current;
    if (s.reason === "deleted_elsewhere") { tombRounds.current = 0; void save(s.cloud.version); return; }
    // Deleted here, edited elsewhere: bring the other device's version back (it is the cloud copy, so they agree).
    savePending(key, null);
    if (hooksRef.current.onRestoreFromCloud(key, s.cloud.plan)) { saveSyncBase(u.uid, key, { version: s.cloud.version, hash: planHash(s.cloud.plan) }); setStatus({ state: "saved", at: Date.now() }); }
    else void withToken(t => tombstoneCloudCopy(key, t, s.cloud.version)).then(() => { void check(); });
  }, [save, withToken, check, setStatus]);
  const chooseKeepDeleted = useCallback(() => {
    const s = statusRef.current, u = userRef.current;
    if (s.state !== "choose_deleted" || !u) return;
    const key = keyRef.current;
    if (s.reason === "deleted_elsewhere") {
      // This device's edits go to its Recently deleted (restorable for 30 days), like the deletion made elsewhere.
      saveSyncBase(u.uid, key, null);
      hooksRef.current.onRemoteDelete(key, Date.parse(s.cloud.deletedAt ?? "") || Date.now());
      setStatus({ state: "sample" });
      return;
    }
    savePending(key, null);
    // The other device's edits stay inside the tombstone, so that device keeps them in its own Recently deleted.
    void withToken(t => tombstoneCloudCopy(key, t, s.cloud.version)).then(() => { tombRounds.current = 0; void check(); });
  }, [withToken, check, setStatus]);

  // Signed out always reads as signed out, whatever the last sync said.
  return { enabled, unavailable, authReady, user, status: uid ? status : SIGNED_OUT, signOut, chooseCloud, chooseLocal, retry, probe,
    markDeleted, markRestored, deleteForever, chooseRestoreDeleted, chooseKeepDeleted };
}
