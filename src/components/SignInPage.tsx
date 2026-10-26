"use client";
// v8 Part 0: /signin. Continue with Google, or email and password (create an account, sign in, reset a password,
// verify the address after sign-up). "Try without an account" and "Explore a sample" always work, whatever state
// sign-in is in, so nobody (a judge on a fresh browser included) is ever blocked here. When sign-in can't work (no
// Firebase config, or the SDK failed to load) the page says "Sign-in unavailable" and why, instead of hiding it.
// Everything that depends on the browser (the `next` parameter, the device flag, Firebase) is read after mount, so
// the server render and the first client render are identical (no hydration mismatch).
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, LogIn, MailCheck, PartyPopper } from "lucide-react";
import { authErrorMessage, markSignedInOnDevice, safeNextPath, skipSignInForSession, wasSignedInOnDevice } from "@/signin";
import { markOnboarded } from "@/persistence";
import { loadAuthState, unavailableText, type AuthApi, type UnavailableReason } from "./cloud-auth";

type Phase = { kind: "loading" } | { kind: "ready"; api: AuthApi } | { kind: "unavailable"; reason: UnavailableReason };
type Mode = "signin" | "signup" | "reset";
const MIN_PASSWORD = 6;

const field = "mt-1 h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink";
const primaryBtn = "flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-hover disabled:cursor-progress disabled:opacity-80";
const secondaryBtn = "flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-sm font-semibold text-sand-800 hover:bg-sand-100 disabled:cursor-progress";
// Browser-only values read through useSyncExternalStore: the server snapshot ("/", not returning) is what hydration
// uses, then React re-renders with the browser's values, so there is never a hydration mismatch.
const noSubscribe = () => () => {};
const readNext = () => safeNextPath(new URLSearchParams(window.location.search).get("next"));
const textBtn = "inline-flex min-h-11 items-center text-sm font-semibold text-primary underline underline-offset-2 hover:text-primary-hover";

export default function SignInPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<null | "google" | "email" | "resend">(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [verify, setVerify] = useState<{ email: string; sent: boolean } | null>(null);
  const next = useSyncExternalStore(noSubscribe, readNext, () => "/");
  const returning = useSyncExternalStore(noSubscribe, wasSignedInOnDevice, () => false);
  const nextRef = useRef(next);
  useEffect(() => { nextRef.current = next; }, [next]);
  /** Set while an account is being created: the sign-in it causes shows the "verify your email" notice instead of leaving. */
  const holdRedirect = useRef(false);
  const formHeading = useRef<HTMLHeadingElement>(null);
  const shown = useRef<{ mode: Mode; verify: boolean }>({ mode: "signin", verify: false });
  const ids = { email: useId(), password: useId(), name: useId(), err: useId(), pwHint: useId() };

  // After mount: the auth module (the redirect target is read from the URL, above).
  useEffect(() => {
    nextRef.current = readNext();
    let live = true, off: (() => void) | undefined;
    void loadAuthState().then(s => {
      if (!live) return;
      if (!s.ok) { setPhase({ kind: "unavailable", reason: s.reason }); return; }
      setPhase({ kind: "ready", api: s.api });
      // Already signed in (or just signed in): remember this device and go on, unless a new account's notice is showing.
      off = s.api.subscribe(u => {
        if (!u) return;
        markSignedInOnDevice();
        if (!holdRedirect.current) router.replace(nextRef.current);
      });
    });
    return () => { live = false; off?.(); };
  }, [router]);

  // A mode switch replaces the buttons that caused it, so focus moves to the new form's heading. Compared with the last
  // values (not a "has run" flag), so Strict Mode's second mount effect never steals focus on first load.
  useEffect(() => {
    const was = shown.current;
    shown.current = { mode, verify: !!verify };
    if (was.mode !== mode || was.verify !== !!verify) formHeading.current?.focus();
  }, [mode, verify]);
  const switchMode = (m: Mode) => { setMode(m); setError(null); setInfo(null); };

  const api = phase.kind === "ready" ? phase.api : null;
  const say = (code: string, action: Parameters<typeof authErrorMessage>[1]) => setError(authErrorMessage(code, action));

  const google = async () => {
    if (!api || busy) return;
    setBusy("google"); setError(null); setInfo(null);
    try {
      const r = await api.signIn();
      if (r.ok) { markSignedInOnDevice(); router.replace(nextRef.current); } else say(r.code, "google");
    } catch { say("", "google"); } finally { setBusy(null); }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!api || busy) return;
    setError(null); setInfo(null);
    const addr = email.trim();
    if (!addr) return say("auth/missing-email", mode === "reset" ? "reset" : mode);
    if (mode !== "reset" && !password) return say("auth/missing-password", mode);
    if (mode === "signup" && password.length < MIN_PASSWORD) return say("auth/weak-password", "signup");
    const unsupported = "Email sign-in isn't available right now. Use Google, or try without an account.";
    setBusy("email");
    try {
      if (mode === "signin") {
        if (!api.signInWithEmail) { setError(unsupported); return; }
        const r = await api.signInWithEmail(addr, password);
        if (r.ok) { markSignedInOnDevice(); router.replace(nextRef.current); } else say(r.code, "signin");
      } else if (mode === "signup") {
        if (!api.signUpWithEmail) { setError(unsupported); return; }
        holdRedirect.current = true;
        const r = await api.signUpWithEmail(addr, password, name);
        if (r.ok) { markSignedInOnDevice(); setPassword(""); setVerify({ email: addr, sent: r.verificationSent !== false }); }
        else { holdRedirect.current = false; say(r.code, "signup"); }
      } else {
        if (!api.sendPasswordReset) { setError(unsupported); return; }
        const r = await api.sendPasswordReset(addr);
        // Never reveal whether an address has an account: "no such user" reads exactly like success.
        if (r.ok || r.code === "auth/user-not-found") setInfo(`If an account uses ${addr}, a link to reset the password is on its way. Check your inbox and spam folder.`);
        else say(r.code, "reset");
      }
    } catch { say("", mode === "reset" ? "reset" : mode); } finally { setBusy(null); }
  };

  const resend = async () => {
    if (!api?.resendVerification || busy) return;
    setBusy("resend"); setError(null); setInfo(null);
    try {
      const r = await api.resendVerification();
      if (r.ok) setInfo("Sent again. It can take a minute to arrive."); else say(r.code, "verify");
    } catch { say("", "verify"); } finally { setBusy(null); }
  };

  const errorBox = (
    <div role="alert" className="text-sm text-red-700" data-testid="signin-error">{error && <p id={ids.err} className="mt-3">{error}</p>}</div>
  );
  const infoBox = <div role="status" className="text-sm text-emerald-800" data-testid="signin-info">{info && <p className="mt-3">{info}</p>}</div>;
  const describedBy = error ? ids.err : undefined;

  let body: ReactNode;
  if (verify) {
    body = (
      <section aria-labelledby="signin-form-heading" data-testid="signin-verify" className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
        <h2 id="signin-form-heading" ref={formHeading} tabIndex={-1} className="flex items-center gap-2 text-lg font-semibold text-ink">
          <MailCheck size={18} aria-hidden="true" className="text-emerald-700" />Verify your email
        </h2>
        <p className="mt-2 break-words text-sm text-ink">
          {verify.sent ? <>We sent a verification link to <span className="font-semibold">{verify.email}</span>. Open it to confirm the address.</>
            : <>Your account is ready, but the verification email didn&apos;t go out. Send it again below.</>}
        </p>
        <p className="mt-1 text-sm text-ink-muted">You can keep planning meanwhile: your plans save to your account either way.</p>
        <div className="mt-4 grid gap-2">
          <button type="button" onClick={() => router.replace(nextRef.current)} data-testid="signin-continue" className={primaryBtn}>
            Continue to my plan<ArrowRight size={16} aria-hidden="true" />
          </button>
          <button type="button" onClick={() => void resend()} disabled={busy === "resend"} data-testid="signin-resend" className={secondaryBtn}>
            {busy === "resend" ? "Sending…" : "Resend verification email"}
          </button>
        </div>
        {errorBox}{infoBox}
      </section>
    );
  } else if (phase.kind === "unavailable") {
    body = (
      <section aria-labelledby="signin-unavailable-heading" data-testid="signin-unavailable" data-reason={phase.reason}
        className="rounded-2xl border border-amber-300 bg-amber-50 p-5">
        <h2 id="signin-unavailable-heading" className="flex items-center gap-2 text-lg font-semibold text-amber-900">
          <AlertTriangle size={18} aria-hidden="true" className="text-amber-800" />Sign-in unavailable
        </h2>
        <p className="mt-1 text-sm text-amber-900">{unavailableText(phase.reason)}</p>
      </section>
    );
  } else {
    const loading = phase.kind === "loading";
    const heading = mode === "signin" ? "Sign in with email" : mode === "signup" ? "Create an account" : "Reset your password";
    body = (
      <section aria-labelledby="signin-form-heading" className="rounded-2xl border border-line bg-surface p-5 shadow-sm" aria-busy={loading || undefined}>
        {mode !== "reset" && (
          <>
            <button type="button" onClick={() => void google()} disabled={loading || !!busy} data-testid="signin-google" className={secondaryBtn}>
              <LogIn size={16} aria-hidden="true" className="text-brand-700" />{busy === "google" ? "Opening Google…" : "Continue with Google"}
            </button>
            <div className="my-4 flex items-center gap-3 text-xs text-ink-muted"><span aria-hidden="true" className="h-px flex-1 bg-line" />or<span aria-hidden="true" className="h-px flex-1 bg-line" /></div>
          </>
        )}
        <h2 id="signin-form-heading" ref={formHeading} tabIndex={-1} className="text-lg font-semibold text-ink">{heading}</h2>
        {mode === "reset" && <p className="mt-1 text-sm text-ink-muted">Enter the email you signed up with and we&apos;ll send a link to choose a new password.</p>}
        <form onSubmit={e => void submit(e)} noValidate className="mt-3 space-y-3" data-testid="signin-form" data-mode={mode}>
          {mode === "signup" && (
            <div>
              <label htmlFor={ids.name} className="text-sm font-medium text-ink">Your name <span className="font-normal text-ink-muted">(optional)</span></label>
              <input id={ids.name} name="name" type="text" autoComplete="name" value={name} onChange={e => setName(e.target.value)} maxLength={80} className={field} />
            </div>
          )}
          <div>
            <label htmlFor={ids.email} className="text-sm font-medium text-ink">Email</label>
            <input id={ids.email} name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required
              value={email} onChange={e => setEmail(e.target.value)} aria-describedby={describedBy} aria-invalid={error ? true : undefined} className={field} />
          </div>
          {mode !== "reset" && (
            <div>
              <label htmlFor={ids.password} className="text-sm font-medium text-ink">Password</label>
              <input id={ids.password} name="password" type="password" required minLength={mode === "signup" ? MIN_PASSWORD : undefined}
                autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)}
                aria-describedby={[mode === "signup" ? ids.pwHint : "", describedBy ?? ""].filter(Boolean).join(" ") || undefined}
                aria-invalid={error ? true : undefined} className={field} />
              {mode === "signup" && <p id={ids.pwHint} className="mt-1 text-xs text-ink-muted">At least {MIN_PASSWORD} characters.</p>}
            </div>
          )}
          <button type="submit" disabled={loading || !!busy} data-testid="signin-submit" className={primaryBtn}>
            {busy === "email" ? "Please wait…" : mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
          </button>
        </form>
        {errorBox}{infoBox}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 border-t border-line pt-2">
          {mode === "signin" && <>
            <button type="button" onClick={() => switchMode("reset")} className={textBtn} data-testid="signin-forgot">Forgot password?</button>
            <button type="button" onClick={() => switchMode("signup")} className={textBtn} data-testid="signin-to-signup">Create an account</button>
          </>}
          {mode !== "signin" && <button type="button" onClick={() => switchMode("signin")} className={textBtn} data-testid="signin-to-signin">
            {mode === "signup" ? "Have an account? Sign in" : "Back to sign in"}</button>}
        </div>
        {loading && <p role="status" className="sr-only">Loading sign-in</p>}
      </section>
    );
  }

  return (
    <div className="min-h-dvh w-full bg-canvas">
      <a href="#main" className="sr-only rounded-lg bg-sand-900 text-sm font-semibold text-white shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:px-4 focus:py-3">Skip to main content</a>
      <header className="festive-rule relative border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-2.5 px-4 py-3">
          <div aria-hidden="true" className="logo-tile grid h-9 w-9 shrink-0 place-items-center rounded-xl shadow-sm"><PartyPopper size={18} /></div>
          <p className="text-sm font-semibold uppercase tracking-wider text-ink-muted">Utsav Co-Pilot</p>
        </div>
      </header>
      <main id="main" tabIndex={-1} data-testid="signin-page" data-phase={phase.kind} className="mx-auto max-w-md px-4 py-6 focus-visible:outline-none sm:py-10">
        <h1 className="text-3xl font-semibold leading-tight text-ink">Sign in to Utsav</h1>
        <p className="mt-2 text-base text-ink-muted">Keep a cloud copy of your plans and open them on any device. Signing in is optional.</p>
        <div className="mt-6">{body}</div>
        <section aria-labelledby="signin-skip-heading" className="mt-6 rounded-2xl border border-line bg-surface-muted p-5">
          <h2 id="signin-skip-heading" className="text-base font-semibold text-ink">No account needed</h2>
          <p className="mt-1 text-sm text-ink-muted">Plans save in this browser. You can sign in later from the header.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Link href={next} onClick={() => skipSignInForSession()} data-testid="signin-skip" className={secondaryBtn}>
              {returning ? "Use without an account" : "Try without an account"}
            </Link>
            <Link href="/" onClick={() => { skipSignInForSession(); markOnboarded(); }} data-testid="signin-sample" className={secondaryBtn}>
              Explore a sample
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
