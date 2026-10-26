import { expect, test, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { skipWelcome, submitRsvp } from "./helpers";

// v8 Part 1c (open RSVP): the organizer copies the one RSVP link; a guest in a new browser sends a family of 4, Veg, Mehendi
// and Muhurtham (the wedding day), Coming; the dashboard shows Muhurtham 4 and Veg 4; the guest reopens the link (prefilled)
// and edits to 5; a second browser with the same phone is flagged as a possible duplicate and the organizer merges it; after
// the close date the form is blocked; the CSV downloads; axe in light and dark at 375 and 1280.

const pageErrors: string[] = [];
const rnd = () => `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
  await skipWelcome(page);
  // Publishing and RSVPs are rate limited per client IP; each test reports its own documentation-range address.
  await page.setExtraHTTPHeaders({ "x-forwarded-for": rnd() });
});
test.afterEach(() => { expect(pageErrors, "uncaught client-side exceptions").toEqual([]); });

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => `${n.target.join(" ")} ${n.failureSummary?.split("\n")[1] ?? ""}`).join(" | ")}`);
}
async function smallTargets(page: Page) {
  return page.evaluate(() => {
    const sel = "a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex='-1'])";
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (el.closest("dialog:not([open])") || el.closest("[aria-hidden='true']")) continue;
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (r.width <= 1 || r.height <= 1 || cs.visibility === "hidden" || cs.display === "none") continue;
      if (r.width < 23.5 || r.height < 23.5) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 50)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
}
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** Publish the wedding sample from the Guests page and copy the RSVP link (clipboard, or the fallback text). */
async function publishAndCopy(page: Page) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/guests");
  await page.getByTestId("guests-publish").click();
  await expect(page.getByTestId("guests-unpublished")).toHaveCount(0);
  const text = page.getByTestId("rsvp-link-text");
  await expect(text).toBeVisible();
  const url = (await text.textContent())!.trim();
  expect(url).toMatch(/\/guest\/[A-Za-z0-9_-]{22}#k=[A-Za-z0-9_-]{43}$/);
  await page.getByTestId("rsvp-copy").click();
  await expect(page.getByTestId("rsvp-msg")).toContainText(/RSVP link copied|Copy this link/);
  const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => "")).catch(() => "");
  if (copied) expect(copied).toBe(url);
  return url;
}
async function guestPage(browser: Browser, url: string, opts: { colorScheme?: "light" | "dark"; width?: number } = {}) {
  const width = opts.width ?? 390;
  const ctx = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 }, colorScheme: opts.colorScheme ?? "light", extraHTTPHeaders: { "x-forwarded-for": rnd() } });
  const p = await ctx.newPage();
  p.on("pageerror", e => pageErrors.push(e.message));
  await p.goto(url);
  return { ctx, p };
}
/** Pull new RSVPs into the organizer's dashboard until the check passes. */
async function refreshUntil(page: Page, check: () => Promise<void>) {
  await expect(async () => {
    await page.getByTestId("rsvp-refresh").click();
    await check();
  }).toPass({ timeout: 25_000 });
}
const fnRow = (page: Page, id: string) => page.getByTestId(`rsvp-fn-count-${id}`);

test("open RSVP end to end: copy link → family of 4 → dashboard counts → edit to 5 → duplicate phone flagged and merged → CSV → close date blocks the form", async ({ page, browser }) => {
  test.slow();
  const url = await publishAndCopy(page);

  // A guest in a new browser: no list, no names, just the form.
  const g = await guestPage(browser, url);
  await expect(g.p.getByTestId("rsvp-form")).toBeVisible();
  await expect(g.p.getByTestId("public-guest-page")).not.toContainText("Iyer");
  await submitRsvp(g.p, { name: "Asha Rao", phone: "98480 12345", party: 4, functions: ["s2", "s4"], meal: "veg", answer: "coming" });
  await expect(g.p.getByTestId("rsvp-summary-party")).toHaveText("4");
  await expect(g.p.getByTestId("rsvp-summary-answer")).toHaveText("Coming");
  await expect(g.p.getByTestId("guest-wishlist").or(g.p.getByTestId("rsvp-confirmation"))).toBeVisible();

  // The organizer's dashboard: Muhurtham (the wedding day) 4, Veg 4; Mehendi 4; nothing for Sangeet.
  await refreshUntil(page, async () => {
    await expect(fnRow(page, "s4")).toHaveAttribute("data-coming", "4", { timeout: 2_000 });
  });
  await expect(fnRow(page, "s4")).toHaveAttribute("data-veg", "4");
  await expect(fnRow(page, "s2")).toHaveAttribute("data-coming", "4");
  await expect(fnRow(page, "s3")).toHaveAttribute("data-coming", "0");
  await expect(page.getByTestId("rsvp-total-coming")).toHaveAttribute("data-value", "4");
  await expect(page.getByTestId("rsvp-table")).toContainText("+91 98480 12345");

  // The guest reopens the link on the same phone: "Welcome back", prefilled; edit to 5.
  await g.p.goto("about:blank");
  await g.p.goto(url);
  await expect(g.p.getByTestId("rsvp-welcome-back")).toHaveText("Welcome back, editing your RSVP.");
  await expect(g.p.getByTestId("rsvp-name")).toHaveValue("Asha Rao");
  await expect(g.p.getByTestId("rsvp-party")).toHaveValue("4");
  await expect(g.p.getByTestId("rsvp-phone")).toHaveValue("");
  await expect(g.p.getByTestId("public-guest-page")).not.toContainText("12345");
  await g.p.getByTestId("rsvp-party-plus").click();
  await expect(g.p.getByTestId("rsvp-party")).toHaveValue("5");
  await g.p.getByTestId("rsvp-submit").click();
  await expect(g.p.getByTestId("rsvp-confirmation")).toBeVisible();
  await expect(g.p.getByTestId("rsvp-summary-party")).toHaveText("5");
  await refreshUntil(page, async () => {
    await expect(fnRow(page, "s4")).toHaveAttribute("data-coming", "5", { timeout: 2_000 });
  });
  await expect(page.getByTestId("rsvp-total-entries")).toHaveAttribute("data-value", "1");

  // Another browser, the same phone (written differently): a second entry, flagged; the first is untouched.
  const d = await guestPage(browser, url);
  await submitRsvp(d.p, { name: "Ravi Rao", phone: "+91 98480-12345", party: 2, functions: ["s4"], meal: "jain" });
  await expect(d.p.getByTestId("rsvp-duplicate")).toHaveText("We already have an RSVP for this number. The organizer will sort it out.");
  await expect(d.p.getByTestId("public-guest-page")).not.toContainText("Asha");
  await refreshUntil(page, async () => {
    await expect(page.getByTestId("rsvp-total-dups")).toHaveAttribute("data-value", "1", { timeout: 2_000 });
  });
  await expect(fnRow(page, "s4")).toHaveAttribute("data-coming", "7");
  await page.getByTestId("rsvp-filter-dup").click();
  const dupRow = page.locator('[data-testid^="rsvp-row-"][data-dup="true"]');
  await expect(dupRow).toHaveCount(1);
  await expect(dupRow).toContainText("Ravi Rao");
  await expect(dupRow).toContainText("possible duplicate of Asha Rao");
  // Merge, choosing to keep Asha's answers (5 people) instead of the newest.
  await dupRow.getByRole("button", { name: /^Merge/ }).click();
  const panel = page.getByTestId("rsvp-merge-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("rsvp-merge-keep-newest")).toBeChecked();
  await panel.getByRole("radio", { name: /^Keep Asha Rao: 5/ }).check();
  await panel.getByTestId("rsvp-merge-confirm").click();
  await expect(page.getByTestId("rsvp-list-msg")).toContainText("Merged: kept Asha Rao (5).");
  await page.getByTestId("rsvp-filter-dup").click();
  await expect(fnRow(page, "s4")).toHaveAttribute("data-coming", "5");
  await expect(page.getByTestId("rsvp-total-entries")).toHaveAttribute("data-value", "1");
  await expect(page.getByTestId("rsvp-total-dups")).toHaveAttribute("data-value", "0");

  // VIP, then Remove with Undo.
  const row = page.locator('[data-testid^="rsvp-row-"]').first();
  await row.getByRole("button", { name: /^VIP/ }).click();
  await expect(row.getByRole("button", { name: /^VIP/ })).toHaveAttribute("aria-pressed", "true");
  await row.getByRole("button", { name: /^Remove/ }).click();
  await expect(page.getByTestId("rsvp-total-entries")).toHaveAttribute("data-value", "0");
  await page.getByTestId("rsvp-undo").click();
  await expect(page.getByTestId("rsvp-total-entries")).toHaveAttribute("data-value", "1");

  // CSV: the organizer's list with the phone, formula-safe.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("rsvp-csv").click()]);
  expect(download.suggestedFilename()).toMatch(/^rsvps-.*\.csv$/);
  const csv = readFileSync((await download.path())!, "utf8");
  expect(csv.split("\r\n")[0]).toBe("Name,Phone,Party size,Kids,Answer,Functions,Meal,VIP,Possible duplicate of,Updated (IST)");
  expect(csv).toContain("Asha Rao,'+919848012345,5,,Coming,Mehendi; Muhurtham,Veg,yes,");
  expect(csv).not.toContain("Ravi Rao");

  // Close date in the past (IST): the guest's form is blocked; the page still opens.
  await page.getByTestId("rsvp-close-date").fill("2026-01-01");
  await page.getByTestId("rsvp-close-time").fill("18:00");
  await page.getByTestId("rsvp-close-save").click();
  await expect(page.getByTestId("rsvp-close-now")).toHaveText("RSVPs close 1 Jan 2026, 6:00 PM IST.");
  await refreshUntil(page, async () => {
    await expect(page.getByTestId("rsvp-sync-note")).toBeVisible();
    await g.p.goto("about:blank");
    await g.p.goto(url);
    await expect(g.p.getByTestId("rsvp-closed")).toBeVisible({ timeout: 2_000 });
  });
  await expect(g.p.getByTestId("rsvp-closed")).toContainText("RSVP period has ended");
  await expect(g.p.getByTestId("rsvp-form")).toHaveCount(0);
  await expect(g.p.getByTestId("rsvp-closed-mine")).toContainText("Coming, 5 people");
  // A fresh device can't send one either (the server refuses, not just the page).
  const late = await d.p.request.post(`${new URL(url).origin}/api/events/${url.split("/guest/")[1]!.split("#")[0]}/rsvp`, {
    headers: { "x-guest-token": url.split("#k=")[1]!, "x-device-token": randomUUID(), "x-forwarded-for": rnd() },
    data: { name: "Late", partySize: 1, functions: ["s4"], meal: "veg", answer: "coming" } });
  expect(late.status()).toBe(403);
  expect((await late.json()).message).toBe("RSVP period has ended");
  await g.ctx.close();
  await d.ctx.close();
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe (${scheme}) at 375 and 1280: the RSVP form, its confirmation and the organizer's RSVP dashboard`, async ({ page, browser }) => {
    test.slow();
    await page.emulateMedia({ colorScheme: scheme });
    const url = await publishAndCopy(page);
    const g = await guestPage(browser, url, { colorScheme: scheme, width: 375 });
    await expect(g.p.getByTestId("rsvp-form")).toBeVisible();
    expect(await axe(g.p), "RSVP form 375").toEqual([]);
    expect(await smallTargets(g.p), "RSVP form targets").toEqual([]);
    expect(await overflowX(g.p), "RSVP form fits at 375").toBeLessThanOrEqual(0);
    await submitRsvp(g.p, { name: "Asha Rao", phone: "98480 12346", party: 3, functions: ["s3", "s4"], meal: "non_veg" });
    expect(await axe(g.p), "RSVP confirmation 375").toEqual([]);
    await g.p.setViewportSize({ width: 1280, height: 900 });
    expect(await axe(g.p), "RSVP confirmation 1280").toEqual([]);
    await g.p.getByTestId("rsvp-edit").click();
    await expect(g.p.getByTestId("rsvp-form")).toBeVisible();
    expect(await axe(g.p), "RSVP form 1280 (editing)").toEqual([]);
    await g.ctx.close();
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: width < 768 ? 740 : 900 });
      await page.goto("/guests");
      await refreshUntil(page, async () => { await expect(page.getByTestId("rsvp-total-entries")).toHaveAttribute("data-value", "1", { timeout: 2_000 }); });
      await page.locator('[data-testid^="rsvp-row-"]').first().getByRole("button", { name: /^VIP/ }).click();
      expect(await axe(page), `RSVP dashboard ${width}`).toEqual([]);
      expect(await overflowX(page), `dashboard fits at ${width}`).toBeLessThanOrEqual(0);
      if (width === 375) expect(await smallTargets(page), "dashboard targets").toEqual([]);
      await page.locator('[data-testid^="rsvp-row-"]').first().getByRole("button", { name: /^VIP/ }).click();
    }
  });
}
