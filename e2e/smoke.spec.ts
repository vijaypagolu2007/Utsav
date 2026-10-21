import { expect, test, type Page } from "@playwright/test";

// Every test starts from a clean browser profile (fresh localStorage), so state never leaks between tests.
const pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
  await page.goto("/");
  await expect(page.getByText("Utsav Co-Pilot")).toBeVisible();
});
test.afterEach(() => { expect(pageErrors, "uncaught client-side exceptions").toEqual([]); });

const rupees = (s: string) => Number(s.replace(/[^\d]/g, ""));
const kpi = (page: Page, name: string) => page.getByTestId(`kpi-${name}`).locator("div").nth(1);
async function ask(page: Page, text: string) {
  await page.getByLabel("Chat message").fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

test("loads without an API key and says it is in Demo Mode", async ({ page }) => {
  await ask(page, "Which vendor deposits are overdue and what tasks are urgent?");
  await expect(page.getByTestId("ai-mode")).toHaveText("Offline");
  await expect(page.getByText(/running in deterministic Demo Mode/).first()).toBeVisible();
});

test("wedding: Tier-1 diff → approve → budget and dates stay valid → refresh keeps it", async ({ page }) => {
  await page.getByRole("combobox", { name: "Event" }).selectOption("wedding");
  const before = rupees(await kpi(page, "planned").innerText());
  await ask(page, "Cut ₹20k from decor and move the Haldi to Friday");
  const card = page.getByTestId("diff-card").last();
  await expect(card).toContainText("Tier 1");
  await expect(card).toContainText(/task due date/);
  await card.getByRole("button", { name: "Approve & Commit" }).click();
  await expect(card).toContainText("Committed");
  await expect.poll(async () => rupees(await kpi(page, "planned").innerText())).toBe(before - 20_000);
  const total = rupees(await kpi(page, "total-budget").innerText());
  expect(before - 20_000).toBeLessThanOrEqual(total);
  await page.reload();
  await expect.poll(async () => rupees(await kpi(page, "planned").innerText())).toBe(before - 20_000);
});

test("over-cut is rolled back with a verified counter-offer and the plan unchanged", async ({ page }) => {
  const before = await kpi(page, "planned").innerText();
  await ask(page, "Cut ₹1.5L from decor");
  await expect(page.getByTestId("rejection-card").last()).toContainText("Rolled back");
  await expect(page.getByTestId("counter-offer-card").last()).toContainText("Counter-offer");
  await expect(kpi(page, "planned")).toHaveText(before);
});

test("quote scanner sample opens as a Tier-1 card with red flags", async ({ page }) => {
  await page.getByRole("button", { name: "Scan sample quote" }).click();
  const card = page.getByTestId("diff-card").last();
  await expect(card).toContainText("Contract red flags");
  await expect(card).toContainText("Deccan Royal Caterers");
  await expect(card.getByRole("button", { name: "Approve & Update Budget" })).toBeVisible();
});

test("exports: CSV downloads, run sheet opens", async ({ page, context }) => {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Export CSV/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/budget-ledger\.csv$/);
  const [sheet] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: /Print Run-Sheet/ }).click()]);
  await expect(sheet.locator("body")).toContainText(/Run sheet/i);
});

test("Guest View hides organizer controls", async ({ page }) => {
  await page.getByRole("radio", { name: /Guest View/ }).click();
  await expect(page.getByRole("button", { name: /Export CSV/ })).toHaveCount(0);
  await expect(page.getByTestId("kpi-planned")).toHaveCount(0);
  await expect(page.getByText("Guest Concierge")).toBeVisible();
});

test("server refuses organizer mutations from a guest link", async ({ request }) => {
  const plan = (await import("../src/presets")).royalWedding;
  const pub = await request.post("/api/events", { data: { plan } });
  expect(pub.status()).toBe(201);
  const { eventId, invites } = await pub.json();
  const r = await request.post(`/api/events/${eventId}/guest`, { headers: { "x-guest-token": invites[0].token },
    data: { commands: [{ op: "adjust_budget", category: "decor", deltaPaise: -100 }] } });
  expect(r.status()).toBe(400);
  const pubView = await (await request.get(`/api/events/${eventId}/public`)).json();
  expect(JSON.stringify(pubView)).not.toMatch(/Paise|vendor|budget/);
});

test("guest link works in a separate browser context and the organizer sees the RSVP", async ({ page, browser }) => {
  await page.getByRole("combobox", { name: "Event" }).selectOption("wedding");
  await page.getByTestId("open-guest-links").click();
  await page.getByTestId("publish-guest-links").click();
  const inviteInput = page.locator('input[data-testid^="invite-"]').first();
  await expect(inviteInput).toBeVisible();
  const url = await inviteInput.inputValue();

  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(url);
  await expect(guest.getByTestId("public-guest-page")).toBeVisible();
  await expect(guest.getByText("Your RSVP").first()).toBeVisible();
  await expect(guest.getByText(/₹|Planned|Vendor/)).toHaveCount(0);
  const first = guest.getByRole("button", { name: "maybe" }).first();
  await first.click();
  await expect(guest.getByRole("status")).toContainText("maybe");
  await guestCtx.close();

  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByTestId("share-sync-status")).toContainText("Synced");
});

// ---------- shared-event sync: no request storm, no lost updates ----------
type Share = { eventId: string; organizerToken: string; version: number };
async function publishWedding(page: Page) {
  await page.getByRole("combobox", { name: "Event" }).selectOption("wedding");
  await page.getByTestId("open-guest-links").click();
  await page.getByTestId("publish-guest-links").click();
  const invite = page.locator('input[data-testid^="invite-"]').first();
  await expect(invite).toBeVisible();
  const url = await invite.inputValue();
  const share = await page.evaluate(() => (JSON.parse(localStorage.getItem("utsav_share_v1") ?? "{}") as Record<string, Share>).wedding);
  await page.getByRole("button", { name: "Close" }).click();
  return { url, share };
}

test("an idle shared event does not re-sync in a loop", async ({ page }) => {
  await publishWedding(page);
  await page.waitForTimeout(2_000); // let the post-publish sync settle
  let calls = 0;
  page.on("request", r => { if (r.url().includes("/api/events/")) calls++; });
  await page.waitForTimeout(8_000);
  // One sync per plan change plus a 20 s poll: an idle tab makes at most one poll (GET + maybe PUT) in 8 s.
  expect(calls, "sync requests while idle").toBeLessThanOrEqual(2);
});

test("guest RSVP and an organizer budget edit made at the same time both survive", async ({ page, browser, request }) => {
  const { url, share } = await publishWedding(page);
  const before = rupees(await kpi(page, "planned").innerText());
  const auth = { authorization: `Bearer ${share.organizerToken}` };
  type ServerPlan = { guests: { rsvp: Record<string, string> }[]; budgetItems: { plannedPaise: number }[] };
  const planned = (p: ServerPlan) => p.budgetItems.reduce((n, b) => n + b.plannedPaise, 0);
  const maybes = (p: ServerPlan) => p.guests.flatMap(g => Object.values(g.rsvp)).filter(a => a === "maybe").length;
  const start = (await (await request.get(`/api/events/${share.eventId}`, { headers: auth })).json()).plan as ServerPlan;
  const maybesBefore = maybes(start), plannedBefore = planned(start);

  // Guest answers first (server moves ahead of the organizer's local copy).
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(url);
  await guest.getByRole("button", { name: "maybe" }).first().click();
  await expect(guest.getByRole("status")).toContainText("maybe");
  await guestCtx.close();

  // Organizer edits from the now-stale copy.
  // ₹30k (≥ ₹25k) so it is a Tier-1 proposal that needs approval; ₹20k alone auto-applies with no button.
  await ask(page, "Cut ₹30k from decor");
  const card = page.getByTestId("diff-card").last();
  await expect(card).toContainText("Tier 1");
  await card.getByRole("button", { name: "Approve & Commit" }).click();
  await expect(card).toContainText("Committed");
  await page.getByTestId("open-guest-links").click();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByTestId("share-sync-status")).toContainText("Synced");

  // The organizer keeps the cut locally, and the server copy now holds both the guest's answer and the cut.
  await expect.poll(async () => rupees(await kpi(page, "planned").innerText())).toBe(before - 30_000);
  const res = await request.get(`/api/events/${share.eventId}`, { headers: auth });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(maybes(body.plan)).toBeGreaterThan(maybesBefore);
  expect(body.version).toBeGreaterThan(share.version);
  expect(planned(body.plan)).toBe(plannedBefore - 30_000 * 100);
});

test("private sub-events stay off the public link until the organizer marks them public", async ({ page, browser }) => {
  await page.getByRole("combobox", { name: "Event" }).selectOption("wedding");
  await page.getByTestId("open-guest-links").click();
  await page.getByTestId("publish-guest-links").click();
  await expect(page.getByTestId("visibility-summary")).toContainText("3 of 5 sub-events are public");
  const publicUrl = await page.getByTestId("public-guest-link").inputValue();
  await page.getByRole("button", { name: "Close" }).click();

  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  const payloads: string[] = [];
  guest.on("response", async r => { if (r.url().includes("/api/events/")) payloads.push(await r.text().catch(() => "")); });
  await guest.goto(publicUrl);
  await expect(guest.getByText("Sangeet", { exact: true })).toBeVisible();
  await expect(guest.getByText("Haldi", { exact: true })).toHaveCount(0);
  expect(payloads.join("\n"), "private sub-event in the API payload").not.toContain("Haldi");

  // Organizer publishes the Haldi from the timeline; the public link picks it up after sync.
  const toggle = page.getByTestId("visibility-haldi");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("open-guest-links").click();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByTestId("share-sync-status")).toContainText("Synced");
  await guest.reload();
  await expect(guest.getByText("Haldi", { exact: true })).toBeVisible();
  await guestCtx.close();
});
