"use client";
// Signed-in cloud save for the plan on screen. Local storage stays the working copy; this keeps a cloud copy per slot
// (users/{uid}/plans/{slot}) through /api/cloud/plans/*. On sign-in (and when the slot changes) it compares the two
// and, when they differ and neither is clearly newer, asks the organizer which to keep. After that, every plan change
// is saved after a short pause; a 409 (changed on another device) asks again with the same two choices.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentState } from "@/schema";
import {
  AUTOSAVE_DEBOUNCE_MS, decideOnSignIn, fetchCloudCopy, keepLocalBaseVersion, loadSyncBase, planHash, saveCloudCopy, saveSyncBase, shouldAutosave,
  type CloudApiResult, type CloudCopy, type SyncStatus,
} from "@/cloud-sync";
import { cloudAuthAvailable, loadAuth, type AuthApi, type CloudUser } from "./cloud-auth";

export type CloudSync = {
  /** False when this build has no Firebase config: render no sign-in UI at all. */
  enabled: boolean;
  user: CloudUser | null;
  status: SyncStatus;
  signingIn: boolean;
  signInError: string | null;
  signIn: () => void;
  signOut: () => void;
  chooseCloud: () => void;
  chooseLocal: () => void;
  retry: () => void;
};

const SIGNED_OUT: SyncStatus = { state: "signed_out" };

export function useCloudSync(planKey: string, plan: AgentState, onUseCloud: (cloud: AgentState) => void): CloudSync {
  const [enabled, setEnabled] = useState(false);
  const [user, setUser] = useState<CloudUser | null>(null);
  const [status, setStatusState] = useState<SyncStatus>({ state: "signed_out" });
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const auth = useRef<AuthApi | null>(null);
  const statusRef = useRef(status);
  const planRef = useRef(plan);
  const keyRef = useRef(planKey);
  const userRef = useRef(user);
  const onUseCloudRef = useRef(onUseCloud);
  /** Bumped whenever the user or slot changes, so a reply for the old one is ignored. */
  const gen = useRef(0);
  /** The server said cloud save isn't configured: stop autosaving until the next sign-in or retry. */
  const unavailable = useRef(false);
  useEffect(() => { planRef.current = plan; keyRef.current = planKey; onUseCloudRef.current = onUseCloud; });
  const setStatus = useCallback((s: SyncStatus) => { statusRef.current = s; setStatusState(s); }, []);

  // Load the auth module only when sign-in is configured (or a test stands one in).
  useEffect(() => {
    // Sign-in hides itself when it can't work; say why in the console so a missing control is never a mystery.
    if (!cloudAuthAvailable()) {
      if (process.env.NODE_ENV !== "production") console.info("[utsav] Sign-in is hidden: this build has no Firebase web config (the four NEXT_PUBLIC_FIREBASE_* variables). Restart the dev server after editing .env.local.");
      return;
    }
    let off: (() => void) | undefined, live = true;
    void loadAuth().then(a => {
      if (!a || !live) return;
      auth.current = a;
      setEnabled(true);
      off = a.subscribe(u => { userRef.current = u; setUser(u); });
    }).catch((e: unknown) => {
      // The SDK failed to load or start (offline on first visit, a blocked script, a bad config): sign-in stays hidden.
      console.warn("[utsav] Sign-in is hidden: the Firebase sign-in SDK failed to load.", e);
    });
    return () => { live = false; off?.(); };
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
    else if (r.kind === "unavailable") { unavailable.current = true; setStatus({ state: "error", message: "Cloud save is unavailable – saved on this device" }); }
    else if (r.kind === "error") setStatus({ state: "error", message: r.message });
  }, [setStatus]);

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
        setStatus({ state: "saved", at: Date.now() });
        // The plan changed while this save was in flight (its autosave was skipped): save the newer one too.
        if (planRef.current !== sent && keyRef.current === key) { base = r.version; continue; }
        return;
      }
      if (r.kind === "conflict") {
        // An unreadable or vanished cloud copy has nothing to choose between: replace it with this device's plan, once.
        if (!r.current && !replacedUnreadable) { replacedUnreadable = true; base = r.currentVersion; continue; }
        if (!r.current) { setStatus({ state: "error", message: "Couldn't save to the cloud" }); return; }
        setStatus({ state: "choose", cloud: r.current, reason: "conflict" });
        return;
      }
      fail(r);
      return;
    }
  }, [withToken, setStatus, fail]);

  /** Compare this device's plan with the cloud copy and act on decideOnSignIn. */
  const check = useCallback(async () => {
    const u = userRef.current, key = keyRef.current, g = ++gen.current;
    if (!u) return;
    unavailable.current = false;
    setStatus({ state: "checking" });
    const r = await withToken(t => fetchCloudCopy(key, t));
    if (g !== gen.current) return;
    if (r.kind !== "copy") { fail(r); return; }
    const d = decideOnSignIn(planRef.current, r.copy, loadSyncBase(u.uid, key));
    if (d.kind === "create") await save(0);
    else if (d.kind === "push") await save(d.baseVersion);
    else if (d.kind === "in_sync") { saveSyncBase(u.uid, key, { version: d.version, hash: planHash(planRef.current) }); setStatus({ state: "saved", at: Date.now() }); }
    else setStatus({ state: "choose", cloud: r.copy!, reason: "differs" });
  }, [withToken, setStatus, fail, save]);

  // Signed in, or switched to another slot while signed in: compare again. Signed out: reset.
  const uid = user?.uid ?? null;
  useEffect(() => {
    if (!uid) { gen.current++; return; }
    void check();
  }, [uid, planKey, check]);

  // Autosave ~1.5 s after the plan changes, unless something is waiting on the organizer's choice.
  useEffect(() => {
    if (!uid) return;
    const t = setTimeout(() => {
      const u = userRef.current;
      if (!u || unavailable.current) return;
      const base = loadSyncBase(u.uid, keyRef.current);
      if (statusRef.current.state === "offline" || statusRef.current.state === "error") { void check(); return; }
      if (shouldAutosave(statusRef.current, planRef.current, base)) void save(base?.version ?? 0);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [plan, uid, save, check]);

  // Back online: compare and save what changed meanwhile.
  useEffect(() => {
    if (!uid) return;
    const on = () => { if (statusRef.current.state === "offline") void check(); };
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [uid, check]);

  const signIn = useCallback(() => {
    const a = auth.current;
    if (!a || signingIn) return;
    setSigningIn(true); setSignInError(null);
    void a.signIn().then(r => { if (!r.ok) setSignInError(r.message); }).finally(() => setSigningIn(false));
  }, [signingIn]);
  const signOut = useCallback(() => { void auth.current?.signOut(); }, []);

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

  // Signed out always reads as signed out, whatever the last sync said.
  return { enabled, user, status: uid ? status : SIGNED_OUT, signingIn, signInError, signIn, signOut, chooseCloud, chooseLocal, retry };
}
