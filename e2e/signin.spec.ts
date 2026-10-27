import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { ownClientIp } from "./helpers";

// v8 Part 0: /signin and the sign-in-first opening. Firebase is never configured in E2E (playwright.config.ts blanks
// the four NEXT_PUBLIC_FIREBASE_* values), so without a stand-in the page shows "Sign-in unavailable" and the
// "Try without an account" / "Explore a sample" paths. The signed-in tests stand in a fake auth module
// (window.__UTSAV_AUTH_MOCK__, honoured only because the E2E build sets NEXT_PUBLIC_UTSAV_E2E_AUTH_MOCK=1) that also
// implements the email and password calls; the real Firebase popup and email delivery are not exercised.

const pageErrors: string[] = [];
test.beforeEach(async ({ page }, info) => {
  await ownClientIp(page, info);
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
});
test.afterEach(() => { expect(pageErrors, "uncaught client-side exceptions").toEqual([]); });

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => `${n.target.join(" ")} ${n.failureSummary?.split("\n")[1] ?? ""}`).join(" | ")}`);
}

/** /signin has mounted (the `next` link and the auth state are read after mount). */
async function signinReady(page: Page, phase: "ready" | "unavailable") {
  await expect(page.getByTestId("signin-page")).toHaveAttribute("data-phase", phase);
}

/**
 * The fake auth module with email and password. `signedIn` signs the session in once, on its first page load (not again
 * after a sign-out and reload). Passwords: "right-password" signs in; "taken@example.com" is already registered.
 */
async function mockAuth(page: Page, signedIn = false) {
  await page.addInitScript(start => {
    const KEY = "e2e_mock_user", STARTED = "e2e_mock_started";
    const asha = { uid: "e2e-user", name: "Asha Rao", email: "asha@example.com", emailVerified: true };
    if (start && !sessionStorage.getItem(STARTED)) sessionStorage.setItem(KEY, JSON.stringify(asha));
    sessionStorage.setItem(STARTED, "1");
    let user = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    const subs = new Set<(u: unknown) => void>();
    const set = (u: unknown) => { user = u; if (u) sessionStorage.setItem(KEY, JSON.stringify(u)); else sessionStorage.removeItem(KEY); subs.forEach(cb => cb(user)); };
    window.__UTSAV_AUTH_MOCK__ = {
      subscribe(cb) { subs.add(cb as (u: unknown) => void); setTimeout(() => cb(user), 0); return () => { subs.delete(cb as (u: unknown) => void); }; },
      async signIn() { set(asha); return { ok: true }; },
      async signOut() { set(null); },
      async getIdToken() { return user ? "e2e-mock-id-token" : null; },
      async signInWithEmail(email, password) {
        if (password !== "right-password") return { ok: false, code: "auth/invalid-credential" };
        set({ uid: "e2e-email", name: email.split("@")[0]!, email, emailVerified: true });
        return { ok: true };
      },
      async signUpWithEmail(email, _password, name) {
        if (email === "taken@example.com") return { ok: false, code: "auth/email-already-in-use" };
        set({ uid: "e2e-new", name: name || email.split("@")[0]!, email, emailVerified: false });
        return { ok: true, verificationSent: true };
      },
      async sendPasswordReset() { return { ok: true }; },
      async resendVerification() { return { ok: true }; },
    };
  }, signedIn);
  // A quiet cloud: nothing saved yet, and every save accepted.
  await page.route("**/api/cloud/plans/**", route => route.request().method() === "GET"
    ? route.fulfill({ status: 404, json: { error: "not_found", message: "none" } })
    : route.fulfill({ json: { planKey: "wedding", version: 1, updatedAt: "Sun 2026-10-25 2:00 PM IST (UTC+05:30)" } }));
}

const markSignedInBefore = (page: Page) => page.addInitScript(() => {
  try { localStorage.setItem("utsav_signed_in_before_v1", "1"); localStorage.setItem("utsav_onboarding_v1", "done"); } catch { /* storage blocked */ }
});

// ---------- unconfigured (the judges' path) ----------
for (const scheme of ["light", "dark"] as const) {
  test(`unconfigured (${scheme}): 'Sign-in unavailable' with a reason, one h1, axe-clean at 1280 and 375 px`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/signin");
      await signinReady(page, "unavailable");
      await expect(page).toHaveTitle("Sign in · Utsav Co-Pilot");
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in to Utsav");
      const notice = page.getByTestId("signin-unavailable");
      await expect(notice).toBeVisible();
      await expect(notice.getByRole("heading", { name: "Sign-in unavailable" })).toBeVisible();
      await expect(notice).toHaveAttribute("data-reason", "unconfigured");
      await expect(notice).toContainText("no Firebase sign-in set up");
      await expect(page.getByTestId("signin-google")).toHaveCount(0);
      await expect(page.getByTestId("signin-skip")).toHaveText("Try without an account");
      await expect(page.getByTestId("signin-sample")).toHaveText("Explore a sample");
      expect(await axe(page), `signin ${scheme} ${width}`).toEqual([]);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `no horizontal scroll at ${width}`).toBeLessThanOrEqual(0);
    }
  });
}

test("unconfigured: 'Try without an account' opens the first-run welcome on a brand-new browser", async ({ page }) => {
  await page.goto("/signin");
  await signinReady(page, "unavailable");
  await page.getByTestId("signin-skip").click();
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  await expect(page.getByTestId("welcome")).toBeVisible();
  // The welcome links back to sign-in, which is optional.
  await expect(page.getByTestId("welcome-signin")).toHaveAttribute("href", "/signin");
});

test("unconfigured: 'Explore a sample' opens a sample plan straight away", async ({ page }) => {
  await page.goto("/signin");
  await signinReady(page, "unavailable");
  await page.getByTestId("signin-sample").click();
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("copilot-launcher")).toBeVisible();
});

test("next: only same-origin paths are followed", async ({ page }) => {
  for (const bad of ["//evil.example", "https://evil.example/x", "/\\evil.example", "javascript:alert(1)", "/signin", "/%2F%2Fevil.example"]) {
    await page.goto(`/signin?next=${encodeURIComponent(bad)}`);
    await signinReady(page, "unavailable");
    await expect(page.getByTestId("signin-skip"), bad).toHaveAttribute("href", "/");
  }
  await page.goto(`/signin?next=${encodeURIComponent("/budget")}`);
  await signinReady(page, "unavailable");
  await expect(page.getByTestId("signin-skip")).toHaveAttribute("href", "/budget");
});

// ---------- opening behaviour ----------
test("signed out on a device that signed in before: /signin first, the plan stays hidden until 'Use without an account'", async ({ page }) => {
  await markSignedInBefore(page);
  await page.goto("/budget");
  await expect(page).toHaveURL(/\/signin\?next=%2Fbudget$/);
  await expect(page.getByTestId("dashboard")).toHaveCount(0);
  await signinReady(page, "unavailable");
  const skip = page.getByTestId("signin-skip");
  await expect(skip).toHaveText("Use without an account");
  await skip.click();
  await expect(page).toHaveURL(/\/budget$/);
  await expect(page.getByTestId("dashboard")).toBeVisible();
  // For the rest of this session the plan opens directly.
  await page.reload();
  await expect(page).toHaveURL(/\/budget$/);
  await expect(page.getByTestId("dashboard")).toBeVisible();
});

test("never signed in here: the existing behaviour (no redirect to /signin)", async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem("utsav_onboarding_v1", "done"); } catch { /* storage blocked */ } });
  await page.goto("/tasks");
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByTestId("dashboard")).toBeVisible();
});

test("signed in (mocked): straight to the plan, with the account in the header's top-right slot", async ({ page }) => {
  await mockAuth(page, true);
  await markSignedInBefore(page);
  await page.goto("/budget");
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await expect(page).toHaveURL(/\/budget$/);
  await expect(page.getByTestId("header-account-slot").getByTestId("cloud-account")).toBeVisible();
  // /signin while signed in goes straight back to `next`.
  await page.goto("/signin?next=%2Ftasks");
  await expect(page).toHaveURL(/\/tasks$/);
});

// ---------- mocked email and password ----------
test("email sign-in (mocked): a friendly error for a wrong password, then success returns to next", async ({ page }) => {
  await mockAuth(page);
  await page.goto("/signin?next=%2Ftasks");
  await signinReady(page, "ready");
  await expect(page.getByTestId("signin-google")).toBeEnabled();
  const email = page.getByLabel("Email", { exact: true }), password = page.getByLabel("Password", { exact: true });
  await expect(email).toHaveAttribute("autocomplete", "email");
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  await page.getByTestId("signin-submit").click();
  await expect(page.getByTestId("signin-error")).toHaveText("Enter your email address.");
  await email.fill("asha@example.com");
  await password.fill("wrong");
  await page.getByTestId("signin-submit").click();
  const err = page.getByTestId("signin-error");
  await expect(err).toContainText("don't match an account");
  await expect(err).not.toContainText("auth/");
  await expect(email).toHaveAccessibleDescription(/don't match an account/);
  expect(await axe(page), "error state").toEqual([]);
  await password.fill("right-password");
  await page.getByTestId("signin-submit").click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByTestId("cloud-account")).toBeVisible();
});

test("create account (mocked): taken address, short password, then the verify-your-email notice", async ({ page }) => {
  await mockAuth(page);
  await page.goto("/signin");
  await signinReady(page, "ready");
  await page.getByTestId("signin-to-signup").click();
  await expect(page.getByRole("heading", { name: "Create an account" })).toBeFocused();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("autocomplete", "new-password");
  await expect(page.getByLabel(/Your name/)).toHaveAttribute("autocomplete", "name");
  await page.getByLabel(/Your name/).fill("Meera");
  await page.getByLabel("Email", { exact: true }).fill("taken@example.com");
  await page.getByLabel("Password", { exact: true }).fill("abc");
  await page.getByTestId("signin-submit").click();
  await expect(page.getByTestId("signin-error")).toContainText("at least 6 characters");
  await page.getByLabel("Password", { exact: true }).fill("long-enough");
  await page.getByTestId("signin-submit").click();
  await expect(page.getByTestId("signin-error")).toContainText("already uses this email");
  await page.getByLabel("Email", { exact: true }).fill("meera@example.com");
  await page.getByTestId("signin-submit").click();
  const notice = page.getByTestId("signin-verify");
  await expect(notice).toBeVisible();
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeFocused();
  await expect(notice).toContainText("meera@example.com");
  await expect(page).toHaveURL(/\/signin$/); // stays for the notice
  expect(await axe(page), "verify notice").toEqual([]);
  await page.getByTestId("signin-resend").click();
  await expect(page.getByTestId("signin-info")).toContainText("Sent again");
  await page.getByTestId("signin-continue").click();
  // A brand-new browser that is signed in goes straight to the plan (no welcome)...
  await expect(page.getByTestId("dashboard")).toBeVisible();
  // ...and a brand-new account with an empty cloud is asked once how to start (v8 Part 0b).
  await expect(page.getByTestId("first-choice-dialog")).toBeVisible();
  await page.getByTestId("first-choice-samples").click();
  await expect(page.getByTestId("first-choice-dialog")).toHaveCount(0);
  await page.getByTestId("cloud-account").click();
  await expect(page.getByTestId("cloud-unverified")).toBeVisible();
});

test("forgot password (mocked): the reset link is sent without saying whether the account exists", async ({ page }) => {
  await mockAuth(page);
  await page.goto("/signin");
  await signinReady(page, "ready");
  await page.getByTestId("signin-forgot").click();
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeFocused();
  await expect(page.getByTestId("signin-google")).toHaveCount(0);
  await page.getByTestId("signin-submit").click();
  await expect(page.getByTestId("signin-error")).toHaveText("Enter your email address.");
  await page.getByLabel("Email", { exact: true }).fill("someone@example.com");
  await page.getByTestId("signin-submit").click();
  await expect(page.getByTestId("signin-info")).toContainText("If an account uses someone@example.com");
  await page.getByTestId("signin-to-signin").click();
  await expect(page.getByRole("heading", { name: "Sign in with email" })).toBeFocused();
});

test("sign out (mocked) with 'Also remove this plan from this device' clears this browser and lands on /signin", async ({ page }) => {
  await mockAuth(page, true);
  // This account already answered the first sign-in choice on this device (v8 Part 0b), so nothing covers the plan.
  await page.addInitScript(() => { if (!sessionStorage.getItem("e2e_choice_seeded")) { sessionStorage.setItem("e2e_choice_seeded", "1"); localStorage.setItem("utsav_first_choice_v1", JSON.stringify({ "e2e-user": "samples" })); } });
  await page.goto("/");
  await expect(page.getByTestId("cloud-account")).toBeVisible();
  await page.getByRole("button", { name: "Edit event name", exact: true }).click();
  await page.getByRole("textbox", { name: "event name", exact: true }).fill("Shared PC wedding");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Shared PC wedding");
  // v8 Part 2: plan saves are debounced (300 ms), so wait for the write rather than reading at once.
  await expect.poll(() => page.evaluate(() => localStorage.getItem("genai_event_planner_v1"))).toContain("Shared PC wedding");
  // Let the autosave (1.5 s after the edit) finish first, so no save is in flight while signing out.
  await page.waitForTimeout(2500);
  await expect(page.getByTestId("cloud-account")).toHaveAttribute("data-sync", "saved");
  await page.getByTestId("cloud-account").click();
  const forget = page.getByTestId("cloud-signout-forget");
  await expect(forget).toHaveAccessibleName("Also remove this plan from this device");
  await forget.check();
  await expect(page.getByTestId("cloud-signout")).toHaveText("Sign out and remove");
  await page.getByTestId("cloud-signout").click();
  await expect(page).toHaveURL(/\/signin$/);
  await signinReady(page, "ready");
  const left = await page.evaluate(() => ["genai_event_planner_v1", "utsav_onboarding_v1", "utsav_signed_in_before_v1", "utsav_cloud_base_v1", "utsav_first_choice_v1"].map(k => localStorage.getItem(k)));
  expect(left).toEqual([null, null, null, null, null]);
  await expect(page.getByTestId("signin-skip")).toHaveText("Try without an account");
  await page.getByTestId("signin-skip").click();
  await expect(page.getByTestId("welcome")).toBeVisible();
});
