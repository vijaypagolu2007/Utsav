// Run: npm test. v8 Part 0: the sign-in page and the sign-in-first opening (no browser needed).
// Pure parts are tested directly (next-param sanitiser, Firebase error codes, the opening decision, the device flags);
// the page, the header and the floating Co-Pilot launcher are checked statically from their source.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  authErrorMessage, decideOpening, DEVICE_PLAN_KEYS, errorCode, forgetThisDevice, markSignedInOnDevice, safeNextPath, signInHref, signInSkipped,
  SIGNED_IN_BEFORE_KEY, SKIP_SIGNIN_KEY, skipSignInForSession, wasSignedInOnDevice, type AuthAction, type Opening, type OpeningInput,
} from "../signin";
import { ONBOARDING_KEY, STORAGE_KEY } from "../persistence";
import { CLOUD_BASE_KEY } from "../cloud-sync";
import { signInErrorMessage } from "../components/cloud-auth";

const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

describe("safeNextPath: only same-origin paths survive", () => {
  test("internal paths (with query and hash) are kept", () => {
    assert.equal(safeNextPath("/"), "/");
    assert.equal(safeNextPath("/budget"), "/budget");
    assert.equal(safeNextPath("/tasks?x=1#ref-t1"), "/tasks?x=1#ref-t1");
    assert.equal(safeNextPath("  /schedule  "), "/schedule");
    assert.equal(safeNextPath("/./event"), "/event");
    assert.equal(safeNextPath("/a/../ideas"), "/ideas");
  });
  test("missing or empty falls back to the plan", () => {
    for (const v of [null, undefined, "", "   "]) assert.equal(safeNextPath(v), "/");
  });
  test("absolute, protocol-relative and scheme URLs are rejected", () => {
    for (const v of ["https://evil.example", "http://evil.example/budget", "//evil.example", "///evil.example", "//evil.example/budget",
      "/\\evil.example", "\\\\evil.example", "/\\/evil.example", "javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "evil.example/budget",
      " //evil.example", "https:/evil.example", "budget"])
      assert.equal(safeNextPath(v), "/", JSON.stringify(v));
  });
  test("control characters, encoded slashes and over-long values are rejected", () => {
    for (const v of ["/\t/evil.example", "/\n/evil.example", "/budget\u0000", "/%2F%2Fevil.example", "/%2fevil", "/%5Cevil", "/" + "a".repeat(600)])
      assert.equal(safeNextPath(v), "/", JSON.stringify(v));
  });
  test("no loop back to /signin, and never an API route", () => {
    for (const v of ["/signin", "/signin/", "/signin?next=/budget", "/api/cloud/plans", "/api/chat"]) assert.equal(safeNextPath(v), "/", v);
    assert.equal(safeNextPath("/signing-up"), "/signing-up", "only the exact /signin path is a loop");
  });
  test("signInHref carries the current page as next (the root needs none)", () => {
    assert.equal(signInHref("/"), "/signin");
    assert.equal(signInHref(null), "/signin");
    assert.equal(signInHref("/budget"), "/signin?next=%2Fbudget");
    assert.equal(signInHref("//evil.example"), "/signin");
    assert.equal(safeNextPath(new URL(`https://x${signInHref("/tasks")}`).searchParams.get("next")), "/tasks");
  });
});

describe("Firebase Auth error codes → friendly text", () => {
  const actions: AuthAction[] = ["google", "signin", "signup", "reset", "verify"];
  const codes = ["auth/invalid-email", "auth/missing-email", "auth/missing-password", "auth/invalid-credential", "auth/invalid-login-credentials", "auth/wrong-password",
    "auth/user-not-found", "auth/user-disabled", "auth/email-already-in-use", "auth/weak-password", "auth/password-does-not-meet-requirements", "auth/too-many-requests",
    "auth/network-request-failed", "auth/operation-not-allowed", "auth/popup-blocked", "auth/unauthorized-domain", "auth/quota-exceeded", "auth/requires-recent-login",
    "auth/user-token-expired", "auth/internal-error", "auth/account-exists-with-different-credential", "auth/some-new-code", "", "Firebase: Error (auth/x)."];
  test("every code gets a sentence that never echoes the raw code or Firebase's message", () => {
    for (const a of actions) for (const c of codes) {
      const m = authErrorMessage(c, a);
      assert.ok(m && m.length > 10, `${a} ${c}`);
      assert.doesNotMatch(m, /auth\/|firebase:|error \(/i, `${a} ${c}: ${m}`);
      assert.match(m, /[.!]$/, `${a} ${c} ends as a sentence`);
    }
  });
  test("closing the Google window says nothing", () => {
    for (const c of ["auth/popup-closed-by-user", "auth/cancelled-popup-request", "auth/user-cancelled"]) assert.equal(authErrorMessage(c, "google"), null);
  });
  test("a wrong password and an unknown address read the same (no account enumeration)", () => {
    const same = authErrorMessage("auth/wrong-password", "signin");
    for (const c of ["auth/user-not-found", "auth/invalid-credential", "auth/invalid-login-credentials"]) assert.equal(authErrorMessage(c, "signin"), same);
    assert.match(same!, /reset your password/);
  });
  test("specific codes say what to do", () => {
    assert.match(authErrorMessage("auth/email-already-in-use", "signup")!, /already uses this email/);
    assert.match(authErrorMessage("auth/weak-password", "signup")!, /at least 6 characters/);
    assert.match(authErrorMessage("auth/too-many-requests", "signin")!, /Wait a few minutes/);
    assert.match(authErrorMessage("auth/operation-not-allowed", "signin")!, /Email and password sign-in isn't turned on/);
    assert.match(authErrorMessage("auth/operation-not-allowed", "google")!, /Google sign-in isn't enabled/);
    assert.match(authErrorMessage("auth/invalid-email", "reset")!, /doesn't look right/);
    assert.match(authErrorMessage("nope", "reset")!, /reset email/);
    assert.match(authErrorMessage("nope", "verify")!, /verification email/);
    assert.match(authErrorMessage("nope", "signup")!, /create the account/);
  });
  test("the header's Google mapping is the same table (v7 behaviour kept)", () => {
    assert.equal(signInErrorMessage("auth/popup-closed-by-user"), null);
    assert.equal(signInErrorMessage("auth/popup-blocked"), authErrorMessage("auth/popup-blocked", "google"));
  });
  test("errorCode reads Firebase's code and nothing else", () => {
    assert.equal(errorCode({ code: "auth/weak-password", message: "Firebase: secret details" }), "auth/weak-password");
    for (const v of [new Error("x"), null, undefined, "auth/x", { code: 42 }]) assert.equal(errorCode(v), "");
  });
});

describe("opening decision", () => {
  const base: OpeningInput = { authReady: true, signedIn: false, previouslySignedIn: false, skipped: false, firstRun: false };
  const d = (o: Partial<OpeningInput>) => decideOpening({ ...base, ...o });
  test("signed in: straight to the plan, even on a brand-new browser or before anything else is known", () => {
    for (const firstRun of [true, false]) for (const previouslySignedIn of [true, false]) for (const skipped of [true, false]) for (const authReady of [true, false])
      assert.equal(d({ signedIn: true, firstRun, previouslySignedIn, skipped, authReady }), "plan");
  });
  test("never signed in here: the existing first-run behaviour, without waiting for auth", () => {
    for (const authReady of [true, false]) {
      assert.equal(d({ firstRun: true, authReady }), "welcome");
      assert.equal(d({ firstRun: false, authReady }), "plan");
    }
  });
  test("signed out after signing in here: sign in first; the local plan never shows while auth is still answering", () => {
    assert.equal(d({ previouslySignedIn: true }), "signin");
    assert.equal(d({ previouslySignedIn: true, firstRun: true }), "signin");
    assert.equal(d({ previouslySignedIn: true, authReady: false }), "wait");
  });
  test("'Use without an account' for this session opens the device's plan (or the welcome)", () => {
    assert.equal(d({ previouslySignedIn: true, skipped: true }), "plan");
    assert.equal(d({ previouslySignedIn: true, skipped: true, authReady: false }), "plan");
    assert.equal(d({ previouslySignedIn: true, skipped: true, firstRun: true }), "welcome");
  });
  test("the whole truth table only ever answers one of the four openings", () => {
    const seen = new Set<Opening>();
    for (let i = 0; i < 32; i++) {
      const o = decideOpening({ authReady: !!(i & 1), signedIn: !!(i & 2), previouslySignedIn: !!(i & 4), skipped: !!(i & 8), firstRun: !!(i & 16) });
      seen.add(o);
      // The plan is never shown to a signed-out, previously-signed-in, not-skipped visitor.
      if (!(i & 2) && i & 4 && !(i & 8)) assert.ok(o === "signin" || o === "wait", `case ${i}: ${o}`);
    }
    assert.deepEqual([...seen].sort(), ["plan", "signin", "wait", "welcome"]);
  });
});

describe("device flags", () => {
  const fakeStorage = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); }, map: m };
  };
  const withWindow = (f: (l: ReturnType<typeof fakeStorage>, s: ReturnType<typeof fakeStorage>) => void) => {
    const l = fakeStorage(), s = fakeStorage();
    const g = globalThis as { window?: unknown };
    const prev = g.window;
    g.window = { localStorage: l, sessionStorage: s };
    try { f(l, s); } finally { g.window = prev; }
  };
  test("sign-in marks the device and ends this session's skip; skip lasts for the session only", () => withWindow((l, s) => {
    assert.equal(wasSignedInOnDevice(), false);
    skipSignInForSession();
    assert.equal(signInSkipped(), true);
    assert.equal(s.map.get(SKIP_SIGNIN_KEY), "1");
    markSignedInOnDevice();
    assert.equal(wasSignedInOnDevice(), true);
    assert.equal(l.map.get(SIGNED_IN_BEFORE_KEY), "1");
    assert.equal(signInSkipped(), false);
  }));
  test("'remove this plan from this device' clears plans, sync bases, shared-link tokens and the flags, and keeps the theme", () => withWindow((l, s) => {
    for (const k of DEVICE_PLAN_KEYS) l.setItem(k, "x");
    l.setItem("utsav_theme_v1", "dark");
    s.setItem(SKIP_SIGNIN_KEY, "1");
    forgetThisDevice();
    for (const k of DEVICE_PLAN_KEYS) assert.equal(l.getItem(k), null, k);
    assert.equal(l.getItem("utsav_theme_v1"), "dark");
    assert.equal(signInSkipped(), false);
    assert.equal(wasSignedInOnDevice(), false);
  }));
  test("the key list matches the keys the app really writes", () => {
    for (const k of [STORAGE_KEY, ONBOARDING_KEY, CLOUD_BASE_KEY, SIGNED_IN_BEFORE_KEY]) assert.ok((DEVICE_PLAN_KEYS as readonly string[]).includes(k), k);
    const shared = src("../components/useSharedEvent.ts");
    for (const m of shared.matchAll(/(?:SHARE_KEY|BASE_KEY) = "([^"]+)"/g)) assert.ok((DEVICE_PLAN_KEYS as readonly string[]).includes(m[1]!), m[1]!);
    assert.equal([...shared.matchAll(/(?:SHARE_KEY|BASE_KEY) = "([^"]+)"/g)].length, 2);
  });
  test("no window (server render): every helper is a safe no-op", () => {
    assert.equal(wasSignedInOnDevice(), false);
    assert.equal(signInSkipped(), false);
    markSignedInOnDevice(); skipSignInForSession(); forgetThisDevice();
  });
});

describe("/signin page (static a11y checks)", () => {
  const page = src("../components/SignInPage.tsx");
  const route = src("../app/signin/page.tsx");
  test("exactly one h1, and it is the page's own", () => {
    assert.equal(page.match(/<h1\b/g)?.length, 1);
    assert.doesNotMatch(route, /<h1\b/);
    assert.match(route, /pageTitle\("Sign in"\)/);
  });
  test("every input has a label (htmlFor = its id) and an autocomplete token", () => {
    const inputs = [...page.matchAll(/<input\b([\s\S]*?)\/>/g)].map(m => m[1]!);
    assert.equal(inputs.length, 3, "name, email, password");
    for (const attrs of inputs) {
      const id = attrs.match(/\bid=\{([^}]+)\}/)?.[1];
      assert.ok(id, `input without id: ${attrs.slice(0, 60)}`);
      assert.ok(page.includes(`htmlFor={${id}}`), `no label for ${id}`);
      assert.match(attrs, /autoComplete=/, `${id} has no autoComplete`);
    }
    assert.match(page, /type="email"[^>]*autoComplete="email"/);
    assert.match(page, /autoComplete="name"/);
    assert.match(page, /autoComplete=\{mode === "signup" \? "new-password" : "current-password"\}/);
    assert.match(page, /type="password"/);
  });
  test("errors are announced (role=alert) and tied to the fields; raw Firebase errors are never shown", () => {
    assert.match(page, /role="alert"/);
    assert.match(page, /aria-describedby=\{describedBy\}/);
    assert.match(page, /authErrorMessage\(/);
    assert.doesNotMatch(page, /\.message\b/, "never renders an error's message");
    assert.doesNotMatch(page, /console\.(log|error)/);
  });
  test("Google, email sign-in, create account, forgot password and the verify-email notice are all there", () => {
    for (const t of ["Continue with Google", "Sign in with email", "Create an account", "Forgot password?", "Reset your password", "Verify your email", "Resend verification email", "Sign-in unavailable"])
      assert.ok(page.includes(t), t);
    assert.match(page, /signUpWithEmail/);
    assert.match(page, /sendPasswordReset/);
    const auth = src("../components/cloud-auth.ts");
    for (const f of ["signInWithEmailAndPassword", "createUserWithEmailAndPassword", "sendEmailVerification", "sendPasswordResetEmail"]) assert.match(auth, new RegExp(`fa\\.${f}\\(`), f);
  });
  test("'Try without an account' and 'Explore a sample' render outside every sign-in state, so they always work", () => {
    const bodyAt = page.indexOf("{body}");
    assert.ok(bodyAt > 0);
    for (const id of ["signin-skip", "signin-sample"]) {
      const at = page.indexOf(`data-testid="${id}"`);
      assert.ok(at > bodyAt, `${id} is rendered after (outside) the state-dependent body`);
    }
    assert.match(page, /Try without an account/);
    assert.match(page, /Use without an account/);
    assert.match(page, /skipSignInForSession\(\)/);
  });
  test("next is sanitised, and read from the browser without a hydration mismatch (server snapshot \"/\")", () => {
    assert.match(page, /safeNextPath\(new URLSearchParams\(window\.location\.search\)\.get\("next"\)\)/);
    assert.doesNotMatch(page, /useSearchParams/);
    assert.match(page, /useSyncExternalStore\(noSubscribe, readNext, \(\) => "\/"\)/);
    assert.match(page, /useSyncExternalStore\(noSubscribe, wasSignedInOnDevice, \(\) => false\)/);
  });
  test("sign-in unavailable is shown with a reason, never hidden; dev-only console note", () => {
    const auth = src("../components/cloud-auth.ts"), hook = src("../components/useCloudSync.ts");
    assert.match(auth, /if \(process\.env\.NODE_ENV === "production"\) return;\s*\n\s*if \(reason === "unconfigured"\) console\.warn/);
    assert.doesNotMatch(hook, /Sign-in is hidden|console\.(info|warn)\(/);
    assert.doesNotMatch(src("../components/AccountMenu.tsx"), /if \(!cloud\.enabled\) return null/);
  });
});

describe("header and floating Co-Pilot launcher (static checks)", () => {
  const drawer = src("../components/CopilotDrawer.tsx"), bar = src("../components/CommandBar.tsx"), app = src("../components/PlannerApp.tsx");
  const css = src("../app/globals.css");
  test("the account control takes the header's top-right slot; the launcher is no longer in the header", () => {
    assert.doesNotMatch(bar, /CopilotLauncher|\blauncher[?:=]|\{launcher\}/);
    assert.match(bar, /<div className="order-2 shrink-0 xl:order-none" data-testid="header-account-slot">\{account\}<\/div>/);
    assert.equal(bar.match(/\{account\}/g)?.length, 1);
  });
  test("one round floating launcher, named, with a focus ring, clear of the safe areas and above the mobile tab bar", () => {
    const btn = drawer.match(/<button[^>]*data-testid="copilot-launcher"[\s\S]*?>/)?.[0] ?? "";
    assert.ok(btn, "launcher button");
    assert.match(btn, /aria-label=\{`Open \$\{title\}`\}/);
    assert.match(btn, /aria-haspopup="dialog"/);
    assert.match(btn, /\bfixed\b/);
    assert.match(btn, /rounded-full/);
    assert.match(btn, /h-14 w-14/, "56px target");
    assert.match(btn, /focus-visible:outline-2/);
    assert.match(btn, /env\(safe-area-inset-right\)/);
    assert.match(btn, /env\(safe-area-inset-bottom\)/);
    assert.match(btn, /bottom-\[calc\(var\(--tabbar-h\)\+env\(safe-area-inset-bottom\)\+0\.75rem\)\] md:bottom-/);
    assert.equal(app.match(/<CopilotLauncher\b/g)?.length, 1);
    assert.match(app, /<CopilotLauncher\b[^\n]*aboveTabBar=\{!guest\}/);
    assert.ok(app.indexOf("<CopilotLauncher") < app.indexOf("<PageTabBar"), "the tab bar's More sheet paints over the launcher");
  });
  test("pages reserve room under the launcher (and the tab bar), so it never covers content", () => {
    assert.match(css, /--fab-space: 5\.5rem/);
    assert.match(app, /pb-\[calc\(var\(--fab-space\)\+env\(safe-area-inset-bottom\)\)\]/);
    assert.match(app, /max-md:pb-\[calc\(var\(--tabbar-h\)\+env\(safe-area-inset-bottom\)\+var\(--fab-space\)\)\]/);
    assert.match(css, /scroll-padding-bottom: calc\(var\(--fab-space\) \+ env\(safe-area-inset-bottom\)\)/);
    assert.match(css, /scroll-padding-bottom: calc\(var\(--tabbar-h\) \+ env\(safe-area-inset-bottom\) \+ var\(--fab-space\)\)/);
    // 5.5rem covers the launcher's 3.5rem plus its largest offset (1rem) with room to spare.
    assert.ok(5.5 >= 3.5 + 1 + 0.5);
  });
  test("data-testids kept: copilot-launcher, cloud-signin, cloud-account, cloud-signout", () => {
    assert.match(drawer, /data-testid="copilot-launcher"/);
    const menu = src("../components/AccountMenu.tsx");
    for (const id of ["cloud-signin", "cloud-account", "cloud-signout", "cloud-panel", "cloud-status", "cloud-live", "cloud-signout-forget"]) assert.match(menu, new RegExp(`data-testid="${id}"`), id);
  });
  test("sign out offers removing the plan from this device", () => {
    const menu = src("../components/AccountMenu.tsx");
    assert.match(menu, /type="checkbox"[^\n]*\n?[^\n]*data-testid="cloud-signout-forget"/);
    assert.match(menu, /Also remove this plan from this device/);
    assert.match(app, /if \(removeFromDevice\) forgetThisDevice\(\);/);
    assert.match(app, /window\.location\.replace\(SIGNIN_PATH\)/);
  });
  test("the opening gate runs client-side only, before any plan renders", () => {
    // v8 Part 2c: the server and the hydration pass render the plan-free AppShell; PlannerApp (and this gate) only after.
    const root = src("../components/ClientRoot.tsx");
    assert.doesNotMatch(root, /ssr: false/);
    assert.match(root, /useSyncExternalStore\(subscribe, \(\) => true, \(\) => false\)/);
    assert.match(root, /useHydrated\(\) \? <PlannerApp>\{children\}<\/PlannerApp> : <AppShell \/>/);
    const gate = app.indexOf('if (opening === "signin" || opening === "wait")');
    assert.ok(gate > 0 && gate < app.indexOf("<CommandBar"), "the locked screen returns before the planner renders");
    assert.ok(gate < app.indexOf('if (opening === "welcome")'));
  });
});
