"use client";
// Optional sign-in through Firebase Auth (auth only: no Analytics, no client Firestore): Google, or email and password.
// The Firebase SDK is imported lazily, and only when the NEXT_PUBLIC_FIREBASE_* config is present, so a build without
// it never downloads any Firebase code. When sign-in can't work, loadAuthState says why, and the UI shows
// "Sign-in unavailable" with that reason instead of hiding the control.
import { firebaseClientConfig } from "@/cloud-config";
import { authErrorMessage, errorCode } from "@/signin";

export type CloudUser = { uid: string; name: string; email: string | null; /** False for an email account whose address isn't verified yet. */ emailVerified?: boolean };
/** A failed call carries the Firebase error code only; the UI turns it into a sentence (authErrorMessage). */
export type AuthResult = { ok: true } | { ok: false; code: string };
/** @deprecated kept for older imports: same as AuthResult. */
export type SignInResult = AuthResult;
export type AuthApi = {
  subscribe(cb: (u: CloudUser | null) => void): () => void;
  /** Google, in a popup. */
  signIn(): Promise<AuthResult>;
  signOut(): Promise<void>;
  /** A fresh Firebase ID token for the Authorization header (force refreshes an expired one). */
  getIdToken(force?: boolean): Promise<string | null>;
  // Email and password (optional so a test stand-in may leave them out; the sign-in page then offers Google only).
  signInWithEmail?(email: string, password: string): Promise<AuthResult>;
  /** Creates the account, sets the display name when given, and sends the verification email. */
  signUpWithEmail?(email: string, password: string, name?: string): Promise<AuthResult & { verificationSent?: boolean }>;
  sendPasswordReset?(email: string): Promise<AuthResult>;
  resendVerification?(): Promise<AuthResult>;
};

declare global {
  // Playwright-only stand-in, honoured only in builds made with NEXT_PUBLIC_UTSAV_E2E_AUTH_MOCK=1.
  interface Window { __UTSAV_AUTH_MOCK__?: AuthApi }
}

// The env check is inline (not imported) so a production build folds it to false and drops the hook entirely.
const mock = (): AuthApi | null =>
  (process.env.NEXT_PUBLIC_UTSAV_E2E_AUTH_MOCK === "1" && typeof window !== "undefined" ? window.__UTSAV_AUTH_MOCK__ ?? null : null);

/** Whether sign-in is configured on this build (it can still fail to load). */
export const cloudAuthAvailable = (): boolean => !!mock() || !!firebaseClientConfig();

/** Google sign-in errors → a sentence (null: the user closed the popup, say nothing). */
export function signInErrorMessage(code: string): string | null {
  return authErrorMessage(code, "google");
}

export type UnavailableReason = "unconfigured" | "sdk_failed";
export type AuthState = { ok: true; api: AuthApi } | { ok: false; reason: UnavailableReason };

/** The short reason shown under "Sign-in unavailable". */
export function unavailableText(reason: UnavailableReason): string {
  return reason === "unconfigured"
    ? "This copy of Utsav has no Firebase sign-in set up, so accounts are off. Your plans still save on this device."
    : "The sign-in service couldn't load (a lost connection or a blocked script). Your plans still save on this device.";
}

/** Dev-only console note, so a missing sign-in is never a mystery while developing (silent in production). */
export function warnUnavailable(reason: UnavailableReason, e?: unknown): void {
  if (process.env.NODE_ENV === "production") return;
  if (reason === "unconfigured") console.warn("[utsav] Sign-in unavailable: this build has no Firebase web config (the four NEXT_PUBLIC_FIREBASE_* variables). Restart the dev server after editing .env.local.");
  else console.warn("[utsav] Sign-in unavailable: the Firebase sign-in SDK failed to load.", e);
}

let loading: Promise<AuthApi | null> | null = null;

/** Load (once) the auth implementation: the test stand-in, Firebase, or null when sign-in isn't configured. Rejects when the SDK fails. */
export function loadAuth(): Promise<AuthApi | null> {
  const m = mock();
  if (m) return Promise.resolve(m);
  const cfg = firebaseClientConfig();
  if (!cfg) return Promise.resolve(null);
  loading ??= (async () => {
    const [{ getApps, initializeApp }, fa] = await Promise.all([import("firebase/app"), import("firebase/auth")]);
    const app = getApps()[0] ?? initializeApp(cfg);
    const auth = fa.getAuth(app);
    const toUser = (u: { uid: string; displayName: string | null; email: string | null; emailVerified: boolean; providerData: { providerId: string }[] }): CloudUser => ({
      uid: u.uid, name: u.displayName?.trim() || u.email?.split("@")[0] || "Signed in", email: u.email,
      // Only password accounts need verifying (Google addresses arrive verified).
      emailVerified: u.providerData.some(p => p.providerId === "password") ? u.emailVerified : true,
    });
    const run = async (f: () => Promise<unknown>): Promise<AuthResult> => {
      try { await f(); return { ok: true }; } catch (e) { return { ok: false, code: errorCode(e) }; }
    };
    return {
      subscribe: cb => fa.onAuthStateChanged(auth, u => cb(u ? toUser(u) : null)),
      signIn: () => run(() => {
        const provider = new fa.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        return fa.signInWithPopup(auth, provider);
      }),
      signOut: () => fa.signOut(auth),
      getIdToken: async force => (auth.currentUser ? auth.currentUser.getIdToken(force) : null),
      signInWithEmail: (email, password) => run(() => fa.signInWithEmailAndPassword(auth, email, password)),
      signUpWithEmail: async (email, password, name) => {
        let cred: Awaited<ReturnType<typeof fa.createUserWithEmailAndPassword>>;
        try { cred = await fa.createUserWithEmailAndPassword(auth, email, password); } catch (e) { return { ok: false, code: errorCode(e) }; }
        // The account exists from here on: a failed profile update or verification email doesn't undo it.
        if (name?.trim()) { try { await fa.updateProfile(cred.user, { displayName: name.trim().slice(0, 80) }); } catch { /* keep the email-derived name */ } }
        let verificationSent = false;
        try { await fa.sendEmailVerification(cred.user); verificationSent = true; } catch { /* the notice offers "Resend" */ }
        return { ok: true, verificationSent };
      },
      sendPasswordReset: email => run(() => fa.sendPasswordResetEmail(auth, email)),
      resendVerification: () => run(async () => { if (auth.currentUser) await fa.sendEmailVerification(auth.currentUser); else throw Object.assign(new Error("signed out"), { code: "auth/user-token-expired" }); }),
    } satisfies AuthApi;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

/** loadAuth, as a state the UI can show: the API, or why sign-in is unavailable. Never rejects. */
export async function loadAuthState(): Promise<AuthState> {
  try {
    const api = await loadAuth();
    return api ? { ok: true, api } : { ok: false, reason: "unconfigured" };
  } catch (e) {
    warnUnavailable("sdk_failed", e);
    return { ok: false, reason: "sdk_failed" };
  }
}
