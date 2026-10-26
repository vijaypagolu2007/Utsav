// v8 Part 0: the sign-in page and the sign-in-first opening. Pure decisions (no React, no Firebase) so they are unit
// tested, plus the two small per-device flags they read. Nothing here is a secret or an access control: the plan in
// localStorage is readable by anyone at this browser; the "locked" opening is a courtesy for shared computers, and
// the cloud copy is protected by the server's ID-token check and firestore.rules.

export const SIGNIN_PATH = "/signin";
/** localStorage: someone signed in on this browser before (set on every observed sign-in, cleared by "remove from this device"). */
export const SIGNED_IN_BEFORE_KEY = "utsav_signed_in_before_v1";
/** sessionStorage: "Use without an account" was chosen in this tab session, so the plan opens without asking again. */
export const SKIP_SIGNIN_KEY = "utsav_skip_signin_v1";

/**
 * The `next` parameter, reduced to a same-origin path or "/". Only "/path?query#hash" survives: absolute URLs
 * ("https://x"), protocol-relative ones ("//x", "/\x", which browsers treat as "//x"), other schemes ("javascript:"),
 * control characters, anything that would leave this origin once resolved, and the sign-in page itself (no loops).
 */
export function safeNextPath(next: string | null | undefined): string {
  if (typeof next !== "string") return "/";
  const n = next.trim();
  if (!n || n.length > 512 || !n.startsWith("/")) return "/";
  if (n.startsWith("//") || n.includes("\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(n)) return "/";
  let u: URL;
  try { u = new URL(n, "https://utsav.invalid"); } catch { return "/"; }
  if (u.origin !== "https://utsav.invalid") return "/";
  // An encoded slash or backslash in the path could be decoded into "//" by something downstream.
  if (/%(2f|5c)/i.test(u.pathname)) return "/";
  if (u.pathname === SIGNIN_PATH || u.pathname.startsWith(`${SIGNIN_PATH}/`)) return "/";
  if (u.pathname.startsWith("/api/")) return "/";
  return `${u.pathname}${u.search}${u.hash}`;
}

/** "/signin?next=<path>" for the page the user is on (the root needs no next). */
export function signInHref(currentPath: string | null | undefined): string {
  const next = safeNextPath(currentPath);
  return next === "/" ? SIGNIN_PATH : `${SIGNIN_PATH}?next=${encodeURIComponent(next)}`;
}

// ---------- Firebase Auth error codes → a sentence for the organizer (never the raw error) ----------
export type AuthAction = "google" | "signin" | "signup" | "reset" | "verify";

/**
 * A friendly sentence for a Firebase Auth error code, or null when there is nothing to say (the user closed the Google
 * window). Unknown codes get a generic line: the raw message can carry internals, so it is never shown.
 */
export function authErrorMessage(code: string, action: AuthAction): string | null {
  switch (code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
    case "auth/user-cancelled": return null;
    case "auth/popup-blocked": return "Your browser blocked the sign-in window. Allow pop-ups for this site and try again.";
    case "auth/unauthorized-domain": return "Sign-in isn't enabled for this web address yet (add it to Firebase's authorized domains).";
    case "auth/operation-not-allowed":
      return action === "google" ? "Google sign-in isn't enabled for this app yet." : "Email and password sign-in isn't turned on for this app yet. Use Google, or try without an account.";
    case "auth/network-request-failed": return action === "google" ? "Couldn't reach Google. Check your connection and try again." : "Couldn't reach the sign-in service. Check your connection and try again.";
    case "auth/invalid-email": return "That email address doesn't look right. Check it and try again.";
    case "auth/missing-email": return "Enter your email address.";
    case "auth/missing-password": return "Enter your password.";
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
    case "auth/wrong-password":
    case "auth/user-not-found": return "That email and password don't match an account. Check them, or reset your password.";
    case "auth/user-disabled": return "This account has been turned off.";
    case "auth/email-already-in-use": return "An account already uses this email. Sign in instead, or reset your password.";
    case "auth/weak-password": return "Choose a stronger password: at least 6 characters.";
    case "auth/password-does-not-meet-requirements": return "That password doesn't meet this app's password rules. Try a longer one with letters and numbers.";
    case "auth/too-many-requests": return "Too many attempts. Wait a few minutes, then try again.";
    case "auth/quota-exceeded": return "The sign-in service is busy right now. Try again later.";
    case "auth/requires-recent-login":
    case "auth/user-token-expired": return "Please sign in again.";
    case "auth/account-exists-with-different-credential": return "This email already signs in another way. Use that method, then try again.";
    case "auth/internal-error": return "The sign-in service had a problem. Please try again.";
    default:
      if (action === "reset") return "Couldn't send the reset email. Please try again.";
      if (action === "verify") return "Couldn't send the verification email. Please try again.";
      return action === "signup" ? "Couldn't create the account. Please try again." : "Sign-in didn't work. Please try again.";
  }
}

/** The `code` of a Firebase error (or any thrown value), "" when there is none. */
export const errorCode = (e: unknown): string =>
  typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string" ? (e as { code: string }).code : "";

// ---------- what the planner shows when it opens ----------
export type OpeningInput = {
  /** The auth state is known: Firebase answered, or sign-in is unavailable (unconfigured / SDK failed). */
  authReady: boolean;
  signedIn: boolean;
  /** Someone signed in on this browser before (SIGNED_IN_BEFORE_KEY). */
  previouslySignedIn: boolean;
  /** "Use without an account" was chosen in this session (SKIP_SIGNIN_KEY). */
  skipped: boolean;
  /** A brand-new browser: no saved plans and the welcome never answered. */
  firstRun: boolean;
};
/** plan: the planner. welcome: first-run welcome. signin: go to /signin, the local plan stays hidden. wait: hold (no plan yet) until auth answers. */
export type Opening = "plan" | "welcome" | "signin" | "wait";

/**
 * Signed in: straight to the plan (cloud sync takes over). Signed out but signed in on this device before: sign in
 * first, and the local plan isn't shown until auth has answered, nor afterwards unless "Use without an account" was
 * chosen. Never signed in here: the existing first-run behaviour (welcome, or the saved plan).
 */
export function decideOpening(i: OpeningInput): Opening {
  if (i.signedIn) return "plan";
  if (i.previouslySignedIn && !i.skipped) return i.authReady ? "signin" : "wait";
  return i.firstRun ? "welcome" : "plan";
}

// ---------- the per-device flags (browser only; every access tolerates blocked storage) ----------
const local = (): Storage | null => { try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; } };
const session = (): Storage | null => { try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; } };

export function wasSignedInOnDevice(): boolean { try { return local()?.getItem(SIGNED_IN_BEFORE_KEY) === "1"; } catch { return false; } }
/** A sign-in was seen: remember it for the next opening, and drop this session's "without an account" choice. */
export function markSignedInOnDevice(): void {
  try { local()?.setItem(SIGNED_IN_BEFORE_KEY, "1"); } catch { /* storage blocked */ }
  try { session()?.removeItem(SKIP_SIGNIN_KEY); } catch { /* storage blocked */ }
}
export function signInSkipped(): boolean { try { return session()?.getItem(SKIP_SIGNIN_KEY) === "1"; } catch { return false; } }
/** "Use without an account": open the local plan for the rest of this tab session. */
export function skipSignInForSession(): void { try { session()?.setItem(SKIP_SIGNIN_KEY, "1"); } catch { /* storage blocked */ } }

/** Everything Utsav keeps in this browser about plans and accounts (the theme choice stays). */
export const DEVICE_PLAN_KEYS = ["genai_event_planner_v1", "utsav_onboarding_v1", "utsav_cloud_base_v1", "utsav_share_v1", "utsav_share_base_v1", SIGNED_IN_BEFORE_KEY,
  /** v8 Part 0b: each account's first sign-in choice on this device (my-events.ts FIRST_CHOICE_KEY). */ "utsav_first_choice_v1",
  /** v8 Part 0c: Recently deleted (plans and parked guest-link tokens) and the cloud deletions still owed (trash.ts). */ "utsav_trash_v1", "utsav_cloud_pending_v1"] as const;
/** "Also remove this plan from this device": the next opening is a brand-new browser's. */
export function forgetThisDevice(): void {
  for (const k of DEVICE_PLAN_KEYS) { try { local()?.removeItem(k); } catch { /* storage blocked */ } }
  try { session()?.removeItem(SKIP_SIGNIN_KEY); } catch { /* storage blocked */ }
}
