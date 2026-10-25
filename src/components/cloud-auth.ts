"use client";
// Optional Google sign-in through Firebase Auth (auth only: no Analytics, no client Firestore). The Firebase SDK is
// imported lazily, and only when the NEXT_PUBLIC_FIREBASE_* config is present, so a build without it never downloads
// any Firebase code and the sign-in control stays hidden.
import { firebaseClientConfig } from "@/cloud-config";

export type CloudUser = { uid: string; name: string; email: string | null };
export type SignInResult = { ok: true } | { ok: false; message: string | null };
export type AuthApi = {
  subscribe(cb: (u: CloudUser | null) => void): () => void;
  signIn(): Promise<SignInResult>;
  signOut(): Promise<void>;
  /** A fresh Firebase ID token for the Authorization header (force refreshes an expired one). */
  getIdToken(force?: boolean): Promise<string | null>;
};

declare global {
  // Playwright-only stand-in, honoured only in builds made with NEXT_PUBLIC_UTSAV_E2E_AUTH_MOCK=1.
  interface Window { __UTSAV_AUTH_MOCK__?: AuthApi }
}

// The env check is inline (not imported) so a production build folds it to false and drops the hook entirely.
const mock = (): AuthApi | null =>
  (process.env.NEXT_PUBLIC_UTSAV_E2E_AUTH_MOCK === "1" && typeof window !== "undefined" ? window.__UTSAV_AUTH_MOCK__ ?? null : null);

/** Whether sign-in can be offered at all on this build. */
export const cloudAuthAvailable = (): boolean => !!mock() || !!firebaseClientConfig();

/** Firebase error codes → a sentence for the organizer (null: the user closed the popup, say nothing). */
export function signInErrorMessage(code: string): string | null {
  switch (code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
    case "auth/user-cancelled": return null;
    case "auth/popup-blocked": return "Your browser blocked the sign-in window. Allow pop-ups for this site and try again.";
    case "auth/unauthorized-domain": return "Sign-in isn't enabled for this web address yet (add it to Firebase's authorized domains).";
    case "auth/network-request-failed": return "Couldn't reach Google. Check your connection and try again.";
    case "auth/operation-not-allowed": return "Google sign-in isn't enabled for this app yet.";
    default: return "Sign-in didn't work. Please try again.";
  }
}

let loading: Promise<AuthApi | null> | null = null;

/** Load (once) the auth implementation: the test stand-in, Firebase, or null when sign-in isn't configured. */
export function loadAuth(): Promise<AuthApi | null> {
  const m = mock();
  if (m) return Promise.resolve(m);
  const cfg = firebaseClientConfig();
  if (!cfg) return Promise.resolve(null);
  loading ??= (async () => {
    const [{ getApps, initializeApp }, fa] = await Promise.all([import("firebase/app"), import("firebase/auth")]);
    const app = getApps()[0] ?? initializeApp(cfg);
    const auth = fa.getAuth(app);
    const toUser = (u: { uid: string; displayName: string | null; email: string | null }): CloudUser =>
      ({ uid: u.uid, name: u.displayName?.trim() || u.email?.split("@")[0] || "Signed in", email: u.email });
    return {
      subscribe: cb => fa.onAuthStateChanged(auth, u => cb(u ? toUser(u) : null)),
      signIn: async () => {
        const provider = new fa.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        try { await fa.signInWithPopup(auth, provider); return { ok: true }; }
        catch (e) { return { ok: false, message: signInErrorMessage(typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code) : "") }; }
      },
      signOut: () => fa.signOut(auth),
      getIdToken: async force => (auth.currentUser ? auth.currentUser.getIdToken(force) : null),
    } satisfies AuthApi;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}
