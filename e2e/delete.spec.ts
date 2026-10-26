import { expect, test, type Browser, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { skipWelcome, switchEvent } from "./helpers";

// v8 Part 0c: delete event (soft delete). Overview's "Delete event" and the event menu's per-event Delete open a confirm;
// the event moves to "Recently deleted" (Restore / Delete forever) with a 10 s Undo toast. v8 Part 0d: samples are
// deletable too (with "Reset sample" next to Delete), "Restore samples" brings them back, and deleting every event
// opens the setup form.
// Cloud: a tombstone propagates to other devices (two browser contexts sharing one in-test fake of /api/cloud/plans/*).

const pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
  await skipWelcome(page);
});
test.afterEach(() => { expect(pageErrors, "uncaught client-side exceptions").toEqual([]); });

const STORE = "genai_event_planner_v1";
const h1 = (page: Page) => page.getByRole("heading", { level: 1 });
const switcher = (page: Page) => page.getByTestId("event-switcher");
async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => `${n.target.join(" ")} ${n.failureSummary?.split("\n")[1] ?? ""}`).join(" | ")}`);
}

/** Turn a slot's plan into an event of the organizer's own (a new event id and title), as the setup form would. */
async function makeOwn(page: Page, slot: string, title: string, id: string) {
  // A fresh browser saves nothing until something changes: switching slots writes the store with this slot in it.
  const stored = await page.evaluate(([k, sl]) => !!JSON.parse(localStorage.getItem(k) ?? "null")?.byType?.[sl], [STORE, slot] as const);
  if (!stored && (await switcher(page).getAttribute("data-active")) === slot) await switchEvent(page, slot === "community" ? "birthday" : "community");
  if ((await switcher(page).getAttribute("data-active")) !== slot) await switchEvent(page, slot);
  await page.evaluate(([k, s, t, i]) => {
    const st = JSON.parse(localStorage.getItem(k)!);
    const h = st.byType[s];
    const p = h.snaps[h.idx].plan;
    p.event.id = i; p.event.title = t;
    h.snaps = [{ plan: p, label: `Created ${t}` }]; h.idx = 0;
    localStorage.setItem(k, JSON.stringify(st));
  }, [STORE, slot, title, id] as const);
  await page.reload();
  await expect(h1(page)).toHaveText(title);
}
async function openMenu(page: Page) {
  await switcher(page).click();
  await expect(page.getByTestId("event-menu")).toBeVisible();
}

test("delete from Overview (red outlined, right of Event name), confirm, then Undo from the toast", async ({ page }) => {
  await page.goto("/");
  await makeOwn(page, "wedding", "Asha & Ravi's wedding", "ev-own-wedding");
  const del = page.getByTestId("overview-delete-event");
  await expect(del).toBeVisible();
  await expect(page.getByTestId("overview-reset-sample")).toHaveCount(0);
  // Right end of the Event name row.
  const row = await page.getByTestId("event-details").boundingBox(), btn = await del.boundingBox();
  expect(btn!.x + btn!.width).toBeGreaterThan(row!.x + row!.width - 40);
  await del.click();
  const dialog = page.getByTestId("delete-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Delete Asha & Ravi's wedding?");
  await expect(dialog).toContainText("You can restore it for 30 days.");
  await expect(page.getByTestId("delete-dialog-cancel")).toBeFocused();
  expect(await axe(page)).toEqual([]);
  // Escape cancels: nothing changes.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(h1(page)).toHaveText("Asha & Ravi's wedding");
  await del.click();
  await page.getByTestId("delete-confirm").click();
  // No other event of the organizer's own: the setup form for a new one.
  await expect(page).toHaveURL(/\/setup$/);
  await expect(switcher(page)).not.toHaveAccessibleName(/Asha & Ravi/);
  const undo = page.getByTestId("toast-undo");
  await expect(undo).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Deleted Asha & Ravi's wedding" })).toBeVisible();
  await undo.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(h1(page)).toHaveText("Asha & Ravi's wedding");
  await openMenu(page);
  await expect(page.getByTestId("recently-deleted")).toHaveCount(0);
  await expect(page.getByTestId("event-option-wedding")).toHaveAttribute("aria-checked", "true");
});

test("delete switches to another own event; restore from Recently deleted brings it back", async ({ page }) => {
  await page.goto("/");
  await makeOwn(page, "birthday", "Kiran turns 8", "ev-own-bday");
  await makeOwn(page, "wedding", "Asha & Ravi's wedding", "ev-own-wedding");
  await page.getByTestId("overview-delete-event").click();
  await page.getByTestId("delete-confirm").click();
  await expect(switcher(page)).toHaveAttribute("data-active", "birthday");
  await expect(h1(page)).toHaveText("Kiran turns 8");
  await openMenu(page);
  const menu = page.getByRole("menu", { name: /Event: / });
  await expect(menu.getByRole("group", { name: "My events" }).getByRole("menuitemradio")).toHaveCount(1);
  const trash = menu.getByRole("group", { name: "Recently deleted" });
  await expect(trash).toContainText("Asha & Ravi's wedding");
  await expect(trash).toContainText("30 days left to restore");
  expect(await axe(page)).toEqual([]);
  await trash.getByRole("menuitem", { name: "Restore Asha & Ravi's wedding" }).click();
  await expect(switcher(page)).toHaveAttribute("data-active", "wedding");
  await expect(h1(page)).toHaveText("Asha & Ravi's wedding");
  await expect(page.getByRole("status").filter({ hasText: "Restored Asha & Ravi's wedding" })).toBeVisible();
  // Persisted: still there after a reload, and the trash is empty.
  await page.reload();
  await expect(h1(page)).toHaveText("Asha & Ravi's wedding");
  expect(await page.evaluate(() => localStorage.getItem("utsav_trash_v1"))).toBeNull();
});

test("Delete forever asks first, then removes it from Recently deleted for good", async ({ page }) => {
  await page.goto("/");
  await makeOwn(page, "wedding", "Asha & Ravi's wedding", "ev-own-wedding");
  await page.getByTestId("overview-delete-event").click();
  await page.getByTestId("delete-confirm").click();
  await expect(page).toHaveURL(/\/setup$/);
  await openMenu(page);
  await page.getByTestId("trash-forever-0").click();
  const dialog = page.getByTestId("forever-dialog");
  await expect(dialog.getByRole("heading")).toHaveText("Delete Asha & Ravi's wedding forever?");
  await expect(page.getByTestId("forever-dialog-cancel")).toBeFocused();
  await page.getByTestId("forever-dialog-cancel").click();
  await openMenu(page);
  await expect(page.getByTestId("recently-deleted")).toContainText("Asha & Ravi's wedding");
  await page.getByTestId("trash-forever-0").click();
  await page.getByTestId("forever-confirm").click();
  await expect(page.getByRole("status").filter({ hasText: "deleted forever" })).toBeVisible();
  await openMenu(page);
  await expect(page.getByTestId("recently-deleted")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("utsav_trash_v1"))).toBeNull();
});

test("keyboard: delete from the event menu (ArrowRight reaches the event's Delete; the event stays a menuitemradio)", async ({ page }) => {
  await page.goto("/");
  await makeOwn(page, "wedding", "Asha & Ravi's wedding", "ev-own-wedding");
  const btn = switcher(page);
  await btn.focus();
  await page.keyboard.press("Enter");
  const radio = page.getByTestId("event-option-wedding");
  await expect(radio).toBeFocused();
  await expect(radio).toHaveAttribute("role", "menuitemradio");
  await page.keyboard.press("ArrowRight");
  const del = page.getByRole("menuitem", { name: "Delete Asha & Ravi's wedding" });
  await expect(del).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(radio).toBeFocused();
  // ArrowDown also visits it (it is in the menu's arrow order).
  await page.keyboard.press("ArrowDown");
  await expect(del).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("delete-dialog")).toBeVisible();
  await expect(page.getByTestId("delete-dialog-cancel")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("delete-confirm")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("delete-dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/setup$/);
  // ArrowUp opens the menu on its last item: Delete forever, at the end of Recently deleted. (Client navigation to
  // /setup moves focus to its h1 first.)
  await expect(h1(page)).toBeFocused();
  await btn.focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("menuitem", { name: "Delete forever: Asha & Ravi's wedding" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("menuitem", { name: "Restore Asha & Ravi's wedding" })).toBeFocused();
});

test("a sample shows Delete event with Reset sample next to it; deleting it moves it to Recently deleted, and Undo brings it back", async ({ page }) => {
  await page.goto("/");
  const del = page.getByTestId("overview-delete-event");
  const reset = page.getByTestId("overview-reset-sample");
  await expect(del).toBeVisible();
  await expect(reset).toBeVisible();
  // Delete is the rightmost button of the Event name row; Reset sample sits just before it.
  const row = await page.getByTestId("event-details").boundingBox(), d = await del.boundingBox(), r = await reset.boundingBox();
  expect(d!.x + d!.width).toBeGreaterThan(row!.x + row!.width - 40);
  expect(r!.x).toBeLessThan(d!.x);
  // Every row of the menu has its Delete, samples included.
  await openMenu(page);
  for (const slot of ["wedding", "birthday", "community"]) await expect(page.getByTestId(`event-delete-${slot}`)).toBeVisible();
  await expect(page.getByRole("group", { name: "Samples" }).getByRole("menuitem", { name: "Delete Royal Wedding" })).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await del.click();
  const dialog = page.getByTestId("delete-dialog");
  await expect(dialog.getByRole("heading")).toHaveText("Delete Arjun & Meera — Royal Telugu Wedding?");
  await expect(page.getByTestId("delete-dialog-cancel")).toBeFocused();
  await page.getByTestId("delete-confirm").click();
  // The next sample opens (never a blank screen); the deleted one is no longer listed.
  await expect(switcher(page)).toHaveAttribute("data-active", "birthday");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("status").filter({ hasText: "Deleted Arjun & Meera — Royal Telugu Wedding" })).toBeVisible();
  // A local sample that never went to an account: only this device forgets it.
  expect(await page.evaluate(k => JSON.parse(localStorage.getItem(k)!).removedSamples, STORE)).toEqual(["wedding"]);
  expect(await page.evaluate(() => localStorage.getItem("utsav_cloud_pending_v1"))).toBeNull();
  await openMenu(page);
  await expect(page.getByTestId("event-option-wedding")).toHaveCount(0);
  await expect(page.getByTestId("recently-deleted")).toContainText("Arjun & Meera — Royal Telugu Wedding");
  await expect(page.getByTestId("event-restore-samples")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("toast-undo").click();
  await expect(switcher(page)).toHaveAttribute("data-active", "wedding");
  await expect(h1(page)).toHaveText("Arjun & Meera — Royal Telugu Wedding");
  await openMenu(page);
  await expect(page.getByTestId("recently-deleted")).toHaveCount(0);
  await expect(page.getByTestId("event-restore-samples")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Samples" }).getByRole("menuitemradio")).toHaveCount(3);
  // Reset sample still works on a sample.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Edit event name", exact: true }).click();
  await page.getByRole("textbox", { name: "event name", exact: true }).fill("Edited sample");
  await page.keyboard.press("Enter");
  await expect(h1(page)).toHaveText("Edited sample");
  await reset.click();
  await expect(h1(page)).toHaveText("Arjun & Meera — Royal Telugu Wedding");
});

test("an edited sample deleted from the menu stays in Recently deleted after a reload; Restore samples brings a fresh copy back", async ({ page }) => {
  await page.goto("/");
  await switchEvent(page, "community");
  await page.getByRole("button", { name: "Edit event name", exact: true }).click();
  await page.getByRole("textbox", { name: "event name", exact: true }).fill("Our street fest");
  await page.keyboard.press("Enter");
  await expect(h1(page)).toHaveText("Our street fest");
  await openMenu(page);
  await page.getByTestId("event-delete-community").click();
  await expect(page.getByTestId("delete-dialog").getByRole("heading")).toHaveText("Delete Our street fest?");
  await page.getByTestId("delete-confirm").click();
  await expect(switcher(page)).toHaveAttribute("data-active", "wedding");
  await page.reload();
  await openMenu(page);
  await expect(page.getByTestId("event-option-community")).toHaveCount(0);
  await expect(page.getByTestId("recently-deleted")).toContainText("Our street fest");
  await page.getByRole("menuitem", { name: "Restore samples" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Samples restored" })).toBeVisible();
  await switchEvent(page, "community");
  // A fresh copy, not the edited one; the edited one is still restorable.
  await expect(h1(page)).not.toHaveText("Our street fest");
  await openMenu(page);
  await expect(page.getByTestId("event-restore-samples")).toHaveCount(0);
  await expect(page.getByTestId("recently-deleted")).toContainText("Our street fest");
  await page.getByRole("menuitem", { name: "Restore Our street fest" }).click();
  await expect(h1(page)).toHaveText("Our street fest");
});

test("deleting every event (own and samples) opens the setup form with Restore samples, never a blank screen", async ({ page }) => {
  await page.goto("/");
  await makeOwn(page, "birthday", "Kiran turns 8", "ev-own-bday");
  // Own event first: samples remain, so the Part 0c flow (setup form for a new event) applies.
  await page.getByTestId("overview-delete-event").click();
  await page.getByTestId("delete-confirm").click();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByTestId("no-events")).toHaveCount(0);
  // Then each sample from the menu.
  for (const slot of ["wedding", "birthday", "community"]) {
    await openMenu(page);
    await page.getByTestId(`event-delete-${slot}`).click();
    await page.getByTestId("delete-confirm").click();
    await expect(page.getByTestId("delete-dialog")).toHaveCount(0);
  }
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByTestId("no-events")).toBeVisible();
  await expect(page.getByTestId("no-events")).toContainText("You have no events right now");
  await expect(h1(page)).toBeVisible();
  await expect(switcher(page)).toHaveAccessibleName("Event: No events");
  await expect(page.getByTestId("copilot-launcher")).toHaveCount(0);
  await expect(page.getByTestId("red-flags")).toHaveCount(0);
  expect(await axe(page)).toEqual([]);
  // The Overview isn't reachable with nothing in it: it comes straight back to the setup form, also after a reload.
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByTestId("no-events")).toBeVisible();
  await openMenu(page);
  await expect(page.getByRole("group", { name: "Samples" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Recently deleted" }).getByRole("menuitem", { name: /^Restore / })).toHaveCount(4);
  await page.keyboard.press("Escape");
  await page.getByTestId("setup-restore-samples").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(h1(page)).toBeVisible();
  await openMenu(page);
  await expect(page.getByRole("group", { name: "Samples" }).getByRole("menuitemradio")).toHaveCount(3);
});

test("Co-Pilot: 'delete this event' on a sample is a Tier 2 card, then the same confirm", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("copilot-launcher").click();
  await page.getByLabel("Chat message").fill("Delete this event");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const card = page.locator('[data-testid="diff-card"][data-op="delete_event"]').last();
  await expect(card).toContainText("Tier 2");
  await card.getByRole("button", { name: "Approve, then confirm" }).click();
  await page.getByTestId("delete-confirm").click();
  await expect(card).toContainText("Committed");
  await expect(switcher(page)).toHaveAttribute("data-active", "birthday");
});

test("Hide samples: per device, only while an own event exists; deleting the last own event shows the samples again", async ({ page }) => {
  await page.goto("/");
  await makeOwn(page, "birthday", "Kiran turns 8", "ev-own-bday");
  await openMenu(page);
  const toggle = page.getByRole("menuitemcheckbox", { name: "Hide samples" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("group", { name: "Samples" })).toBeVisible();
  await toggle.click();
  await openMenu(page);
  await expect(page.getByRole("menuitemcheckbox", { name: "Hide samples" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("group", { name: "Samples" })).toHaveCount(0);
  await expect(page.getByTestId("event-option-wedding")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.reload();
  await openMenu(page);
  await expect(page.getByRole("group", { name: "Samples" })).toHaveCount(0);
  await page.getByTestId("event-delete-birthday").click();
  await page.getByTestId("delete-confirm").click();
  await expect(page).toHaveURL(/\/setup$/);
  await openMenu(page);
  // No own event left: the samples are back (Explore a sample never disappears) and the toggle is gone.
  await expect(page.getByRole("group", { name: "Samples" }).getByRole("menuitemradio")).toHaveCount(3);
  await expect(page.getByTestId("event-hide-samples")).toHaveCount(0);
});

test("Co-Pilot: 'delete this event' is a Tier 2 card; nothing is deleted until Approve and the app's confirm", async ({ page }) => {
  await page.goto("/");
  await makeOwn(page, "wedding", "Asha & Ravi's wedding", "ev-own-wedding");
  await page.getByTestId("copilot-launcher").click();
  await page.getByLabel("Chat message").fill("Delete this event");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const card = page.locator('[data-testid="diff-card"][data-op="delete_event"]').last();
  await expect(card).toContainText("Tier 2");
  await expect(card).toContainText("Delete event: needs your approval");
  await expect(h1(page)).toHaveText("Asha & Ravi's wedding");
  await card.getByRole("button", { name: "Approve, then confirm" }).click();
  await expect(page.getByTestId("delete-dialog")).toBeVisible();
  // Cancel at the confirm: still nothing deleted, and the card can still be approved.
  await page.getByTestId("delete-dialog-cancel").click();
  await expect(h1(page)).toHaveText("Asha & Ravi's wedding");
  await expect(card.getByRole("button", { name: "Approve, then confirm" })).toBeVisible();
  await card.getByRole("button", { name: "Approve, then confirm" }).click();
  await page.getByTestId("delete-confirm").click();
  await expect(card).toContainText("Committed");
  await expect(page).toHaveURL(/\/setup$/);
});

test("Co-Pilot as a guest: 'delete this event' is refused", async ({ page }) => {
  await page.goto("/");
  await makeOwn(page, "wedding", "Asha & Ravi's wedding", "ev-own-wedding");
  await page.getByRole("button", { name: "Guest View" }).click();
  await page.getByTestId("copilot-launcher").click();
  await page.getByLabel("Chat message").fill("delete this event");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("copilot-drawer").getByText(/read-only/).last()).toBeVisible();
  await expect(page.locator('[data-op="delete_event"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Organizer" }).click();
  await expect(h1(page)).toHaveText("Asha & Ravi's wedding");
});

test("guest links of a deleted event say it was removed (410); Restore switches them back on", async ({ page, browser }) => {
  await page.goto("/");
  await makeOwn(page, "wedding", "Asha & Ravi's wedding", "ev-own-wedding");
  await page.getByTestId("open-guest-links").click();
  await page.getByTestId("publish-guest-links").click();
  const invite = page.getByTestId("rsvp-guest-link");
  await expect(invite).toBeVisible();
  const url = await invite.inputValue();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByTestId("overview-delete-event").click();
  const removedSaved = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/api\/events\//.test(r.url()), { timeout: 30_000 });
  await page.getByTestId("delete-confirm").click();
  await expect(page).toHaveURL(/\/setup$/);
  await removedSaved;
  const guest = await browser.newPage();
  await expect.poll(async () => { await guest.goto("about:blank"); await guest.goto(url); return guest.getByTestId("guest-removed").count(); }, { timeout: 30_000 }).toBe(1);
  await expect(guest.getByRole("heading", { level: 1 })).toHaveText("This event was removed by the organizer");
  // Nothing about the event or the household leaks on that page.
  await expect(guest.getByText("Asha & Ravi")).toHaveCount(0);
  await openMenu(page);
  const restoredSaved = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/api\/events\//.test(r.url()), { timeout: 30_000 });
  await page.getByRole("menuitem", { name: "Restore Asha & Ravi's wedding" }).click();
  await expect(h1(page)).toHaveText("Asha & Ravi's wedding");
  await restoredSaved;
  await expect.poll(async () => { await guest.goto("about:blank"); await guest.goto(url); return guest.getByTestId("guest-removed").count(); }, { timeout: 30_000 }).toBe(0);
  await expect(guest.getByRole("heading", { level: 1 })).toBeVisible();
  await guest.close();
});

// ---------- two devices, one account (mocked auth and cloud) ----------
const TOKEN = "e2e-mock-id-token";
type Doc = { version: number; updatedAt: string; plan: { event: { id: string; title: string } }; deletedAt?: string };

async function mockAuth(page: Page) {
  await page.addInitScript(([token]) => {
    const user = { uid: "e2e-user", name: "Asha Rao", email: "asha@example.com" };
    window.__UTSAV_AUTH_MOCK__ = {
      subscribe(cb) { setTimeout(() => cb(user), 0); return () => {}; },
      async signIn() { return { ok: true }; },
      async signOut() { /* stays signed in for these tests */ },
      async getIdToken() { return token; },
    };
    try { localStorage.setItem("utsav_first_choice_v1", JSON.stringify({ "e2e-user": "samples" })); } catch { /* storage blocked */ }
  }, [TOKEN] as const);
}
/** One cloud for both devices: compare-and-set PUT (plan or tombstone), GET, and DELETE of a tombstone. */
function sharedCloud() {
  const docs = new Map<string, Doc>();
  let clock = 0;
  const handler = async (route: Route) => {
    const req = route.request();
    if (req.headers().authorization !== `Bearer ${TOKEN}`) return route.fulfill({ status: 401, json: { error: "unauthorized", message: "Sign in again" } });
    const u = new URL(req.url());
    const key = decodeURIComponent(u.pathname.split("/").pop() ?? "");
    const doc = docs.get(key);
    const conflict = () => route.fulfill({ status: 409, json: { error: "version_conflict", message: "changed", current: doc ? { planKey: key, ...doc } : null, currentVersion: doc?.version ?? 0 } });
    if (req.method() === "GET") return doc ? route.fulfill({ json: { planKey: key, ...doc } }) : route.fulfill({ status: 404, json: { error: "not_found", message: "none" } });
    if (req.method() === "DELETE") {
      if (!doc) return route.fulfill({ status: 404, json: { error: "not_found", message: "none" } });
      if (!doc.deletedAt || String(doc.version) !== u.searchParams.get("baseVersion")) return conflict();
      docs.delete(key);
      return route.fulfill({ json: { planKey: key, deleted: true } });
    }
    const body = req.postDataJSON() as { plan?: Doc["plan"]; baseVersion: number; deleted?: true };
    if ((doc?.version ?? 0) !== body.baseVersion) return conflict();
    const updatedAt = new Date(Date.UTC(2026, 9, 25, 9, 0, ++clock)).toISOString();
    if (body.deleted) {
      if (!doc) return route.fulfill({ status: 404, json: { error: "not_found", message: "none" } });
      if (doc.deletedAt) return route.fulfill({ json: { planKey: key, version: doc.version, updatedAt: doc.updatedAt, deletedAt: doc.deletedAt } });
      docs.set(key, { ...doc, version: doc.version + 1, updatedAt, deletedAt: updatedAt });
      return route.fulfill({ json: { planKey: key, version: doc.version + 1, updatedAt, deletedAt: updatedAt } });
    }
    docs.set(key, { version: body.baseVersion + 1, updatedAt, plan: body.plan! });
    return route.fulfill({ json: { planKey: key, version: body.baseVersion + 1, updatedAt } });
  };
  return { docs, handler };
}
async function device(browser: Browser, cloud: ReturnType<typeof sharedCloud>, store?: string) {
  const net = { offline: false };
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", e => pageErrors.push(e.message));
  await skipWelcome(page);
  await mockAuth(page);
  if (store) await page.addInitScript(([k, v]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, v); sessionStorage.setItem("seeded", "1"); } }, [STORE, store] as const);
  await page.route("**/api/cloud/plans/**", route => (net.offline ? route.abort("internetdisconnected") : cloud.handler(route)));
  return { ctx, page, net };
}
const account = (page: Page) => page.getByTestId("cloud-account");

test("two devices: a deletion on one moves the event to Recently deleted on the other (it is never uploaded again)", async ({ browser }) => {
  const cloud = sharedCloud();
  const a = await device(browser, cloud);
  await a.page.goto("/");
  await makeOwn(a.page, "wedding", "Asha & Ravi's wedding", "ev-own-wedding");
  await expect(account(a.page)).toHaveAttribute("data-sync", "saved");
  await expect.poll(() => cloud.docs.get("wedding")?.plan.event.id).toBe("ev-own-wedding");
  const store = await a.page.evaluate(k => localStorage.getItem(k)!, STORE);
  const b = await device(browser, cloud, store);
  await b.page.goto("/");
  await expect(h1(b.page)).toHaveText("Asha & Ravi's wedding");
  await expect(account(b.page)).toHaveAttribute("data-sync", "saved");

  // Device A deletes: the cloud copy becomes a tombstone (the plan is kept for Restore).
  await a.page.getByTestId("overview-delete-event").click();
  await a.page.getByTestId("delete-confirm").click();
  await expect.poll(() => cloud.docs.get("wedding")?.deletedAt ?? null).not.toBeNull();
  expect(cloud.docs.get("wedding")!.plan.event.id).toBe("ev-own-wedding");

  // Device B syncs (opening the planner again): its copy moves to its own Recently deleted, and nothing is re-uploaded.
  await b.page.reload();
  await expect(b.page.getByRole("status").filter({ hasText: "was deleted on another device" })).toBeVisible();
  await expect(b.page).toHaveURL(/\/setup$/);
  await openMenu(b.page);
  await expect(b.page.getByTestId("recently-deleted")).toContainText("Asha & Ravi's wedding");
  await expect(b.page.getByRole("group", { name: "My events" })).toHaveCount(0);
  await b.page.keyboard.press("Escape");
  await b.page.waitForTimeout(2000);
  expect(cloud.docs.get("wedding")!.deletedAt).toBeTruthy();

  // Device B restores: the tombstone is cleared.
  await openMenu(b.page);
  await b.page.getByRole("menuitem", { name: "Restore Asha & Ravi's wedding" }).click();
  await expect(h1(b.page)).toHaveText("Asha & Ravi's wedding");
  await expect.poll(() => cloud.docs.get("wedding")?.deletedAt ?? null).toBeNull();
  expect(cloud.docs.get("wedding")!.plan.event.id).toBe("ev-own-wedding");
  await a.ctx.close();
  await b.ctx.close();
});

test("two devices: edits the cloud never saw meet a deletion → chooser, and 'Restore with my edits' keeps them", async ({ browser }) => {
  const cloud = sharedCloud();
  const a = await device(browser, cloud);
  await a.page.goto("/");
  await makeOwn(a.page, "wedding", "Asha & Ravi's wedding", "ev-own-wedding");
  await expect(account(a.page)).toHaveAttribute("data-sync", "saved");
  const store = await a.page.evaluate(k => localStorage.getItem(k)!, STORE);
  const b = await device(browser, cloud, store);
  await b.page.goto("/");
  await expect(account(b.page)).toHaveAttribute("data-sync", "saved");
  // B goes offline, edits; A deletes meanwhile.
  b.net.offline = true;
  await b.page.getByRole("button", { name: "Edit event name", exact: true }).click();
  await b.page.getByRole("textbox", { name: "event name", exact: true }).fill("Asha & Ravi — final venue");
  await b.page.keyboard.press("Enter");
  await expect(account(b.page)).toHaveAttribute("data-sync", "offline");
  await a.page.getByTestId("overview-delete-event").click();
  await a.page.getByTestId("delete-confirm").click();
  await expect.poll(() => cloud.docs.get("wedding")?.deletedAt ?? null).not.toBeNull();
  // B is back: never resurrected silently, never dropped silently.
  b.net.offline = false;
  await b.page.evaluate(() => window.dispatchEvent(new Event("online")));
  const chooser = b.page.getByTestId("deleted-choice-dialog");
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole("heading")).toHaveText("Asha & Ravi — final venue was deleted on another device");
  // Escape doesn't dismiss a decision that must be made.
  await b.page.keyboard.press("Escape");
  await expect(chooser).toBeVisible();
  expect(await axe(b.page)).toEqual([]);
  await b.page.getByTestId("deleted-restore").click();
  await expect(chooser).toHaveCount(0);
  await expect.poll(() => cloud.docs.get("wedding")?.deletedAt ?? null).toBeNull();
  expect(cloud.docs.get("wedding")!.plan.event.title).toBe("Asha & Ravi — final venue");
  await expect(account(b.page)).toHaveAttribute("data-sync", "saved");
  await a.ctx.close();
  await b.ctx.close();
});

test("two devices: a sample loaded into the account is tombstoned when deleted, dropped on the other device, and Restore samples saves it back", async ({ browser }) => {
  const cloud = sharedCloud();
  const a = await device(browser, cloud);
  await a.page.goto("/");
  // "Load sample events" was chosen (mockAuth): the sample on screen is saved to the account.
  await expect(account(a.page)).toHaveAttribute("data-sync", "saved");
  await expect.poll(() => cloud.docs.get("wedding")?.plan.event.title).toBe("Arjun & Meera — Royal Telugu Wedding");
  const b = await device(browser, cloud);
  await b.page.goto("/");
  await expect(account(b.page)).toHaveAttribute("data-sync", "saved");

  await a.page.getByTestId("overview-delete-event").click();
  await a.page.getByTestId("delete-confirm").click();
  await expect(switcher(a.page)).toHaveAttribute("data-active", "birthday");
  await expect.poll(() => cloud.docs.get("wedding")?.deletedAt ?? null).not.toBeNull();

  // Device B (untouched copy of the same sample): it goes to B's Recently deleted, and nothing is re-uploaded.
  await b.page.reload();
  await expect(b.page.getByRole("status").filter({ hasText: "was deleted on another device" })).toBeVisible();
  await openMenu(b.page);
  await expect(b.page.getByTestId("event-option-wedding")).toHaveCount(0);
  await expect(b.page.getByTestId("recently-deleted")).toContainText("Arjun & Meera — Royal Telugu Wedding");
  await b.page.keyboard.press("Escape");
  await b.page.waitForTimeout(2000);
  expect(cloud.docs.get("wedding")!.deletedAt).toBeTruthy();

  // Device A brings the samples back: the fresh copy is saved over the tombstone when its slot syncs.
  await openMenu(a.page);
  await expect(a.page.getByTestId("event-load-samples")).toHaveCount(0);
  await a.page.getByTestId("event-restore-samples").click();
  await switchEvent(a.page, "wedding");
  await expect.poll(() => cloud.docs.get("wedding")?.deletedAt ?? null).toBeNull();
  await expect(account(a.page)).toHaveAttribute("data-sync", "saved");
  await a.ctx.close();
  await b.ctx.close();
});
