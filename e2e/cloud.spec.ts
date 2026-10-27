import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { skipWelcome, switchEvent, ownClientIp } from "./helpers";

// v7: optional Google sign-in + cloud save. Firebase is never configured in E2E, so by default no Firebase code loads
// and the header's "Sign in" leads to /signin, which says "Sign-in unavailable" (v8: never hidden). The signed-in tests stand in a fake auth module (window.__UTSAV_AUTH_MOCK__, honoured
// only because the E2E build sets NEXT_PUBLIC_UTSAV_E2E_AUTH_MOCK=1) and answer /api/cloud/plans/* from an in-test fake
// with the same compare-and-set contract as src/server/cloud-handler.ts. The live popup and Firestore are not exercised.

const TOKEN = "e2e-mock-id-token";
const pageErrors: string[] = [];
test.beforeEach(async ({ page }, info) => {
  await ownClientIp(page, info);
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
  await skipWelcome(page);
});
test.afterEach(() => { expect(pageErrors, "uncaught client-side exceptions").toEqual([]); });

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => `${n.target.join(" ")} ${n.failureSummary?.split("\n")[1] ?? ""}`).join(" | ")}`);
}

/** The fake auth module. `signedIn` starts the page already signed in (as Firebase does after a reload). */
async function mockAuth(page: Page, signedIn = false) {
  await page.addInitScript(([start, token]) => {
    const KEY = "e2e_mock_user";
    if (start && !sessionStorage.getItem(KEY)) sessionStorage.setItem(KEY, JSON.stringify({ uid: "e2e-user", name: "Asha Rao", email: "asha@example.com" }));
    let user = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    const subs = new Set<(u: unknown) => void>();
    const emit = () => subs.forEach(cb => cb(user));
    window.__UTSAV_AUTH_MOCK__ = {
      subscribe(cb) { subs.add(cb as (u: unknown) => void); setTimeout(() => cb(user), 0); return () => { subs.delete(cb as (u: unknown) => void); }; },
      async signIn() { user = { uid: "e2e-user", name: "Asha Rao", email: "asha@example.com" }; sessionStorage.setItem(KEY, JSON.stringify(user)); emit(); return { ok: true }; },
      async signOut() { user = null; sessionStorage.removeItem(KEY); emit(); },
      async getIdToken() { return user ? token : null; },
    };
  }, [signedIn, TOKEN] as const);
}

type Doc = { version: number; updatedAt: string; plan: unknown };
/** In-test cloud: users/e2e-user/plans/{key}, versions assigned here, PUT is compare-and-set on baseVersion. */
async function fakeCloud(page: Page, opts: { offline?: boolean } = {}) {
  const docs = new Map<string, Doc>();
  const puts: { key: string; baseVersion: number; title: string }[] = [];
  const state = { offline: !!opts.offline };
  await page.route("**/api/cloud/plans/**", async (route: Route) => {
    if (state.offline) return route.abort("internetdisconnected");
    const req = route.request();
    if (req.headers().authorization !== `Bearer ${TOKEN}`) return route.fulfill({ status: 401, json: { error: "unauthorized", message: "Sign in again" } });
    const key = decodeURIComponent(new URL(req.url()).pathname.split("/").pop() ?? "");
    const doc = docs.get(key);
    if (req.method() === "GET") return doc ? route.fulfill({ json: { planKey: key, ...doc } }) : route.fulfill({ status: 404, json: { error: "not_found", message: "none" } });
    const body = req.postDataJSON() as { plan: { event: { title: string } }; baseVersion: number };
    puts.push({ key, baseVersion: body.baseVersion, title: body.plan.event.title });
    if ((doc?.version ?? 0) !== body.baseVersion)
      return route.fulfill({ status: 409, json: { error: "version_conflict", message: "changed", current: doc ? { planKey: key, ...doc } : null, currentVersion: doc?.version ?? 0 } });
    const next = { version: body.baseVersion + 1, updatedAt: "2026-10-23T10:00:00.000Z", plan: body.plan };
    docs.set(key, next);
    return route.fulfill({ json: { planKey: key, version: next.version, updatedAt: next.updatedAt } });
  });
  return { docs, puts, state };
}

/**
 * v8 Part 0b: this account already answered the first sign-in choice on this device ("Load sample events"), so the
 * signed-in tests below start where they always did: the sample on screen saves to the cloud.
 */
const samplesChosen = (page: Page) => page.addInitScript(() => { try { localStorage.setItem("utsav_first_choice_v1", JSON.stringify({ "e2e-user": "samples" })); } catch { /* storage blocked */ } });

/** The current sample plan as saved locally (to seed a "cloud copy" that differs from it). */
const localPlan = (page: Page) => page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem("genai_event_planner_v1") ?? "null");
  const h = s?.byType?.[s.active];
  return h ? h.snaps[h.idx].plan : null;
});
async function renameEvent(page: Page, title: string) {
  await page.getByRole("button", { name: "Edit event name", exact: true }).click();
  const box = page.getByRole("textbox", { name: "event name", exact: true });
  await box.fill(title);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
}
const account = (page: Page) => page.getByTestId("cloud-account");
/** v8: the header's Sign in is a link to /signin; "Continue with Google" there signs in and comes back to the same page. */
async function signInViaPage(page: Page) {
  const from = new URL(page.url()).pathname;
  await page.getByTestId("cloud-signin").click();
  await expect(page).toHaveURL(/\/signin(\?|$)/);
  await page.getByTestId("signin-google").click();
  await expect(page).toHaveURL(new RegExp(`${from.replace(/\//g, "\\/")}$`));
}

test("Firebase not configured: Sign in leads to 'Sign-in unavailable', no Firebase code or cloud calls, and the app works as before", async ({ page }) => {
  const hits: string[] = [];
  page.on("request", r => { if (/firebase|googleapis\.com\/identitytoolkit|\/api\/cloud\//i.test(r.url())) hits.push(r.url()); });
  const res = await page.goto("/");
  expect(res?.headers()["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // v8: the control is shown (never silently hidden) and says sign-in is unavailable.
  const signIn = page.getByTestId("cloud-signin");
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveAttribute("data-available", "false");
  await expect(account(page)).toHaveCount(0);
  // Plans still save locally and edit through the reducer.
  await renameEvent(page, "Local only wedding");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Local only wedding");
  await page.getByRole("link", { name: "Budget", exact: true }).first().click();
  await expect(page).toHaveURL(/\/budget$/);
  await page.getByTestId("open-guest-links").click();
  await expect(page.getByRole("dialog", { name: "Guest links" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("cloud-signin").click();
  await expect(page).toHaveURL(/\/signin\?next=%2Fbudget$/);
  await expect(page.getByTestId("signin-unavailable")).toBeVisible();
  await expect(page.getByTestId("signin-unavailable")).toHaveAttribute("data-reason", "unconfigured");
  await page.getByTestId("signin-skip").click();
  await expect(page).toHaveURL(/\/budget$/);
  await page.waitForTimeout(300);
  expect(hits).toEqual([]);
  const scripts = await page.evaluate(() => performance.getEntriesByType("resource").map(e => e.name).filter(n => /firebase/i.test(n)));
  expect(scripts).toEqual([]);
});

test("the cloud API answers 503 cleanly without the public Firebase config (no-store)", async ({ request }) => {
  const r = await request.get("/api/cloud/plans/wedding", { headers: { authorization: "Bearer a.b.c" } });
  expect(r.status()).toBe(503);
  expect(r.headers()["cache-control"]).toContain("no-store");
  expect((await r.json()).error).toBe("cloud_not_configured");
});

test("mocked sign-in: 'Load sample events' creates the cloud copy, edits autosave with compare-and-set, sign out", async ({ page }) => {
  await mockAuth(page);
  const cloud = await fakeCloud(page);
  await page.goto("/");
  const signIn = page.getByTestId("cloud-signin");
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveAccessibleName("Sign in");
  await signInViaPage(page);
  // v8 Part 0b: a new account with an empty cloud is asked first; the untouched sample isn't uploaded until it answers.
  await page.getByTestId("first-choice-samples").click();
  await expect(account(page)).toHaveAttribute("data-sync", "saved");
  await expect(account(page)).toHaveAccessibleName(/Account: Asha Rao\. Saved to cloud/);
  expect(cloud.puts).toEqual([{ key: "wedding", baseVersion: 0, title: expect.any(String) }]);

  await renameEvent(page, "Cloud saved wedding");
  await expect.poll(() => cloud.puts.length, { timeout: 6000 }).toBe(2);
  expect(cloud.puts[1]).toEqual({ key: "wedding", baseVersion: 1, title: "Cloud saved wedding" });
  await expect(account(page)).toHaveAttribute("data-sync", "saved");

  await account(page).click();
  await expect(page.getByTestId("cloud-panel")).toContainText("Asha Rao");
  await expect(page.getByTestId("cloud-status-text")).toHaveText("Saved to cloud");
  await page.getByTestId("cloud-signout").click();
  // v8: signed out on a device that was signed in: the sign-in page comes first and the plan stays hidden...
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByTestId("dashboard")).toHaveCount(0);
  // ...until "Use without an account"; the local plan is untouched by signing out.
  await page.getByTestId("signin-skip").click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Cloud saved wedding");
  await expect(page.getByTestId("cloud-signin")).toBeVisible();
});

test("cloud copy differs on sign-in: choose; Use cloud copy loads it and is one Undo away", async ({ page }) => {
  await mockAuth(page);
  const cloud = await fakeCloud(page);
  await page.goto("/");
  await renameEvent(page, "Device plan");
  // v8 Part 2: plan saves are debounced (300 ms); wait for the rename to reach storage.
  await expect.poll(async () => (await localPlan(page))?.event?.title ?? null).toBe("Device plan");
  const plan = await localPlan(page);
  expect(plan).not.toBeNull();
  cloud.docs.set("wedding", { version: 3, updatedAt: "2026-10-22T08:30:00.000Z", plan: { ...plan, event: { ...plan.event, title: "From my laptop" } } });
  const before = await page.getByRole("heading", { level: 1 }).textContent();

  await signInViaPage(page);
  const dialog = page.getByTestId("cloud-choice-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Which version should we keep?" })).toBeVisible();
  await expect(dialog).toContainText("From my laptop");
  await expect(account(page)).toHaveAttribute("data-sync", "choose");
  expect(await axe(page)).toEqual([]);
  await dialog.getByTestId("cloud-use-cloud").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("From my laptop");
  await expect(account(page)).toHaveAttribute("data-sync", "saved");
  await page.waitForTimeout(2000);
  expect(cloud.puts, "using the cloud copy doesn't write it back").toEqual([]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(before ?? "");
});

test("a 409 on autosave asks again; Keep this device's plan overwrites the cloud on its current version", async ({ page }) => {
  await mockAuth(page, true);
  await samplesChosen(page);
  const cloud = await fakeCloud(page);
  await page.goto("/");
  await expect(account(page)).toHaveAttribute("data-sync", "saved");
  // Another device saves meanwhile.
  const plan = cloud.docs.get("wedding")!.plan as { event: Record<string, unknown> };
  cloud.docs.set("wedding", { version: 2, updatedAt: "2026-10-23T09:00:00.000Z", plan: { ...plan, event: { ...plan.event, title: "Phone edit" } } });
  await renameEvent(page, "Desk edit");
  const dialog = page.getByTestId("cloud-choice-dialog");
  await expect(dialog).toBeVisible({ timeout: 6000 });
  await expect(dialog).toContainText("changed on another device");
  // Escape decides later; the account panel reopens the choice.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await account(page).click();
  await page.getByTestId("cloud-open-choice").click();
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("cloud-keep-local").click();
  await expect(account(page)).toHaveAttribute("data-sync", "saved");
  expect(cloud.docs.get("wedding")?.version).toBe(3);
  expect((cloud.docs.get("wedding")?.plan as { event: { title: string } }).event.title).toBe("Desk edit");
  expect(cloud.puts.at(-1)).toEqual({ key: "wedding", baseVersion: 2, title: "Desk edit" });
});

test("offline: status says the plan is saved on this device, and saving resumes on retry", async ({ page }) => {
  await mockAuth(page, true);
  await samplesChosen(page);
  const cloud = await fakeCloud(page, { offline: true });
  await page.goto("/");
  await expect(account(page)).toHaveAttribute("data-sync", "offline");
  await account(page).click();
  await expect(page.getByTestId("cloud-status-text")).toHaveText("Offline – saved on this device");
  cloud.state.offline = false;
  // Hardened (v8 Part 1b): the panel re-renders while the background retry runs, which detached "Try again" mid-click on
  // a slow machine. Click it only while it is still offered, and accept the background retry getting there first.
  await expect(async () => {
    if ((await account(page).getAttribute("data-sync")) !== "saved") {
      const retry = page.getByTestId("cloud-retry");
      if (await retry.isVisible()) await retry.click({ timeout: 2_000 });
    }
    await expect(account(page)).toHaveAttribute("data-sync", "saved", { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  expect(cloud.docs.get("wedding")?.version).toBe(1);
});

for (const scheme of ["light", "dark"] as const) {
  test(`signed-in header, account panel and choice dialog are axe-clean in ${scheme} at 1280 and 375 px`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await mockAuth(page, true);
    await samplesChosen(page);
    const cloud = await fakeCloud(page);
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(account(page)).toHaveAttribute("data-sync", "saved");
      expect(await axe(page), `header ${width}`).toEqual([]);
      await account(page).click();
      await expect(page.getByTestId("cloud-panel")).toBeVisible();
      expect(await axe(page), `panel ${width}`).toEqual([]);
      const box = await page.getByTestId("cloud-panel").boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= width + 1, `panel inside the viewport at ${width}`).toBeTruthy();
      await page.keyboard.press("Escape");
      await expect(account(page)).toBeFocused();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `no horizontal scroll at ${width}`).toBeLessThanOrEqual(0);
      // The choice dialog: a cloud copy this device never saw.
      const doc = cloud.docs.get("wedding")!;
      cloud.docs.set("wedding", { ...doc, version: doc.version + 1, plan: { ...(doc.plan as object), event: { ...(doc.plan as { event: object }).event, title: `Other device ${width}` } } });
      await page.evaluate(() => localStorage.removeItem("utsav_cloud_base_v1"));
      await page.reload();
      await expect(page.getByTestId("cloud-choice-dialog")).toBeVisible();
      expect(await axe(page), `dialog ${width}`).toEqual([]);
      await page.getByTestId("cloud-keep-local").click();
      await expect(account(page)).toHaveAttribute("data-sync", "saved");
    }
  });
}

// ---------- v8 Part 0b: the first sign-in choice ----------
const chooser = (page: Page) => page.getByTestId("first-choice-dialog");

test("first sign-in, empty cloud: the chooser asks once; 'Load sample events' saves the samples and never asks again", async ({ page }) => {
  await mockAuth(page);
  const cloud = await fakeCloud(page);
  await page.goto("/");
  await signInViaPage(page);
  await expect(chooser(page)).toBeVisible();
  await expect(page.getByRole("dialog", { name: /How would you like to start\?/ })).toBeVisible();
  await expect(page.getByTestId("first-choice-own")).toBeFocused();
  // Nothing is written to the account while it waits: the sample on screen is held on this device.
  await expect(account(page)).toHaveAttribute("data-sync", "sample");
  expect(cloud.puts).toEqual([]);
  expect(await axe(page), "chooser").toEqual([]);
  await page.getByTestId("first-choice-samples").click();
  await expect(chooser(page)).toHaveCount(0);
  await expect(account(page)).toHaveAttribute("data-sync", "saved");
  expect(cloud.puts.map(p => p.key)).toEqual(["wedding"]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("utsav_first_choice_v1") ?? "{}"))).toEqual({ "e2e-user": "samples" });
  // Opening another sample now saves it too.
  await switchEvent(page, "birthday");
  await expect.poll(() => cloud.puts.map(p => p.key)).toEqual(["wedding", "birthday"]);
  // The event menu no longer offers loading them again.
  await page.getByTestId("event-switcher").click();
  await expect(page.getByTestId("event-load-samples")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(account(page)).toHaveAttribute("data-sync", "saved");
  await page.waitForTimeout(800);
  await expect(chooser(page)).toHaveCount(0);
});

test("first sign-in, empty cloud: 'Start your own event' opens the blank setup; samples stay out of the account", async ({ page }) => {
  await mockAuth(page);
  const cloud = await fakeCloud(page);
  await page.goto("/");
  await signInViaPage(page);
  await expect(chooser(page)).toBeVisible();
  await page.getByTestId("first-choice-own").click();
  await expect(chooser(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByText(/New plan · Step 1 of 3/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/New plan · Step 1 of 3/)).toBeVisible();
  await expect(account(page)).toHaveAttribute("data-sync", "sample");
  await page.waitForTimeout(800);
  await expect(chooser(page)).toHaveCount(0);
  // Browsing a sample doesn't upload it either; "Load sample events" stays in the event menu and the account panel.
  await page.goto("/");
  await switchEvent(page, "community");
  await expect(account(page)).toHaveAttribute("data-sync", "sample");
  await page.waitForTimeout(2000);
  expect(cloud.puts).toEqual([]);
  await account(page).click();
  await expect(page.getByTestId("cloud-status-text")).toHaveText("Sample – not saved to your account");
  await expect(page.getByTestId("cloud-load-samples")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("event-switcher").click();
  await page.getByTestId("event-load-samples").click();
  await expect(account(page)).toHaveAttribute("data-sync", "saved");
  expect(cloud.puts.map(p => p.key)).toEqual(["community"]);
});

test("first sign-in with an edited sample on this device: no chooser, the usual sync uploads it", async ({ page }) => {
  await mockAuth(page);
  const cloud = await fakeCloud(page);
  await page.goto("/");
  await renameEvent(page, "My edited wedding");
  await signInViaPage(page);
  await expect(account(page)).toHaveAttribute("data-sync", "saved");
  expect(cloud.puts).toEqual([{ key: "wedding", baseVersion: 0, title: "My edited wedding" }]);
  await page.waitForTimeout(800);
  await expect(chooser(page)).toHaveCount(0);
});

test("first sign-in when the account already has plans: no chooser", async ({ page }) => {
  await mockAuth(page);
  const cloud = await fakeCloud(page);
  await page.goto("/");
  // Switching saves the (still untouched) samples locally, so there is a plan to seed the cloud copy from.
  await switchEvent(page, "birthday");
  await switchEvent(page, "wedding");
  const plan = await localPlan(page);
  cloud.docs.set("birthday", { version: 2, updatedAt: "Thu 2026-10-22 2:00 PM IST (UTC+05:30)", plan: { ...plan, event: { ...plan.event, title: "x" } } });
  await signInViaPage(page);
  await expect(account(page)).toHaveAttribute("data-sync", "sample");
  await page.waitForTimeout(800);
  await expect(chooser(page)).toHaveCount(0);
  expect(cloud.puts).toEqual([]);
});
