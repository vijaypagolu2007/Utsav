import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { skipWelcome, openPageNav } from "./helpers";

// Round-2 fixes: the "Guest links" button (publish → links, at desktop and phone widths), every other header control,
// and inline editing of names and amounts through the reducer. Same Demo Mode build and file store as smoke.spec.ts.

const pageErrors: string[] = [];
test.beforeEach(async ({ page }, info) => {
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
  await skipWelcome(page);
  // Publishing is rate-limited per client IP (10 an hour, keyed on X-Forwarded-For). Give each test its own address so
  // the suite's many publishes don't exhaust one shared budget; the limit itself is covered by the server tests.
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `e2e-${info.testId}` });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
test.afterEach(() => { expect(pageErrors, "uncaught client-side exceptions").toEqual([]); });

const rupees = (s: string) => Number(s.replace(/[^\d]/g, ""));
const kpi = (page: Page, name: string) => page.getByTestId(`kpi-${name}`).locator("dd").first();
// The organizer dashboard is split into pages (/, /budget, /tasks, /schedule, /event). Go to the page that holds a
// control before touching it: a client-side click on the page navigation, so the plan state carries over.
async function openPage(page: Page, name: "Overview" | "Budget" | "Tasks" | "Schedule" | "Event") {
  await openPageNav(page, name);
}
async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`);
}

// ---------- 1. Guest links ----------
for (const width of [1280, 375]) {
  test(`Guest links ${width}px: the header button opens the dialog, Publish returns working links`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: width < 768 ? 740 : 900 });
    const btn = page.getByTestId("open-guest-links");
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAccessibleName(/Guest links/);
    // Nothing sits on top of the button (the header, the More popover or the tab bar never swallow the click).
    expect(await btn.evaluate(el => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && el.contains(hit); })).toBe(true);
    await btn.click();
    const dlg = page.getByRole("dialog", { name: "Guest links" });
    await expect(dlg).toBeVisible();
    const [res] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/events") && r.request().method() === "POST"), dlg.getByTestId("publish-guest-links").click()]);
    expect(res.status()).toBe(201);
    // v8 Part 1d: one link only, the RSVP link, with Copy, WhatsApp and a QR toggle. No public itinerary field.
    const rsvp = dlg.getByTestId("rsvp-guest-link");
    await expect(rsvp).toBeVisible();
    await expect(rsvp).toHaveAccessibleName("RSVP link");
    const url = await rsvp.inputValue();
    expect(url).toMatch(/\/guest\/[A-Za-z0-9_-]+#k=[A-Za-z0-9_-]+$/);
    await expect(dlg.getByTestId("public-guest-link")).toHaveCount(0);
    await expect(dlg.getByTestId("visibility-summary")).toHaveCount(0);
    await expect(dlg.getByRole("textbox")).toHaveCount(1);
    await expect(dlg.getByTestId("share-intro")).toContainText("Share this one link with everyone");
    await expect(dlg.getByTestId("share-intro")).toContainText("Guests page");
    await expect(btn).toContainText("live");
    // WhatsApp opens a chat picker with the invitation and this exact link filled in.
    const wa = new URL((await dlg.getByTestId("share-wa").getAttribute("href"))!);
    expect(wa.origin + wa.pathname).toBe("https://wa.me/");
    expect(wa.searchParams.get("text")).toContain(url);
    await expect(dlg.getByTestId("share-wa")).toHaveAttribute("rel", /noopener/);
    // The QR is behind a disclosure button that says whether it is open.
    const qrBtn = dlg.getByTestId("share-qr-toggle");
    await expect(qrBtn).toHaveAttribute("aria-expanded", "false");
    await expect(dlg.getByTestId("share-qr")).toHaveCount(0);
    await qrBtn.click();
    await expect(qrBtn).toHaveAttribute("aria-expanded", "true");
    await expect(dlg.getByTestId("share-qr")).toBeVisible();
    await expect(dlg.getByRole("img", { name: /QR code for the RSVP link/ })).toBeVisible();
    // 44px targets for every control in the dialog.
    for (const b of await dlg.locator("button, a").all()) {
      const box = await b.boundingBox();
      if (box) expect(box.height, await b.textContent() ?? "").toBeGreaterThanOrEqual(44);
    }
    expect(await axe(page), `Guest links dialog ${width}px (light, QR open)`).toEqual([]);
    // The old public itinerary URL (no #k=) still serves the read-only projection.
    const id = url.split("/guest/")[1]!.split("#")[0]!;
    expect((await request.get(`/api/events/${id}/public`)).status()).toBe(200);
    // Copy gives feedback (clipboard permission granted here; the no-clipboard fallback has its own test).
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await dlg.getByRole("button", { name: "Copy RSVP link" }).click();
    await expect(dlg.getByRole("button", { name: "Copy RSVP link" })).toContainText("Copied");
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await expect(btn).toBeFocused();
  });
}

test("Guest links: Copy still works without the async clipboard API (plain-http LAN address)", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined, configurable: true }); });
  await page.reload();
  await page.getByTestId("open-guest-links").click();
  await page.getByTestId("publish-guest-links").click();
  const copy = page.getByRole("button", { name: "Copy RSVP link" });
  await copy.click();
  // Either execCommand copied it, or the link is left selected with a Ctrl+C hint linked to the field. Never silence.
  await expect(page.getByText(/Copied|press Ctrl\+C/).first()).toBeVisible();
  const field = page.getByTestId("rsvp-guest-link");
  if (await page.getByText(/press Ctrl\+C/).count()) await expect(field).toHaveAccessibleDescription(/press Ctrl\+C/);
});

test("Guest links: a server without shared storage explains how to fix it instead of failing silently", async ({ page }) => {
  await page.route("**/api/events", r => r.request().method() === "POST"
    ? r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "storage_unconfigured", message: "Shared guest links need UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN" }) })
    : r.continue());
  await page.getByTestId("open-guest-links").click();
  await page.getByTestId("publish-guest-links").click();
  const note = page.getByTestId("share-unconfigured");
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute("role", "alert");
  await expect(note).toContainText("UTSAV_STORE=file");
  await expect(note).toContainText(".env.local");
  await expect(page.getByTestId("publish-guest-links")).toBeEnabled(); // can retry once the server is configured
  expect(await axe(page)).toEqual([]);
});

// ---------- every other header control ----------
for (const [width, wide] of [[1280, false], [1263, true], [1366, false], [1536, false], [768, false], [375, false]] as const) {
  test(`header ${width}px${wide ? " with wider text" : ""}: no two controls overlap (so no click lands on the wrong one)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    // 1263 = 1280 minus a classic Windows scrollbar; letter-spacing stands in for Segoe UI's wider glyphs.
    if (wide) await page.addStyleTag({ content: "header * { letter-spacing: 0.06em; }" });
    const boxes = await page.getByRole("banner").evaluate(h => Array.from(h.querySelectorAll<HTMLElement>("button, select, [data-testid=copilot-launcher]"))
      .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
      .map(el => { const r = el.getBoundingClientRect(); return { name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30), l: r.left, t: r.top, r: r.right, b: r.bottom }; }));
    expect(boxes.length).toBeGreaterThan(6);
    const hits: string[] = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      if (Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5) hits.push(`${a.name} × ${b.name}`);
    }
    expect(hits).toEqual([]);
    for (const b of boxes) expect(b.r, `${b.name} inside the viewport`).toBeLessThanOrEqual(width + 0.5);
  });
}

test("header: Undo/Redo, red flags, view toggle, More items, theme and Co-Pilot all respond", async ({ page, context }) => {
  const undo = page.getByRole("button", { name: "Undo" }), redo = page.getByRole("button", { name: "Redo" });
  await expect(undo).toBeDisabled();
  await openPage(page, "Budget");
  const lock = page.getByRole("button", { name: /^Lock Haldi marigold decor/ });
  await lock.click();
  await expect(page.getByRole("button", { name: /^Locked Haldi marigold decor/ })).toBeVisible();
  await undo.click();
  await expect(page.getByRole("button", { name: /^Lock Haldi marigold decor/ })).toBeVisible();
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(page.getByRole("button", { name: /^Locked Haldi marigold decor/ })).toBeVisible();

  const flags = page.getByRole("button", { name: /red flag/ });
  await flags.click();
  await expect(flags).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: /Pay caterer deposit/ }).first().click(); // a flag closes the list and highlights its row
  await expect(flags).toHaveAttribute("aria-expanded", "false");

  const more = page.getByRole("button", { name: "More", exact: true });
  await more.click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Export CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/budget-ledger\.csv$/);
  await more.click();
  const [sheet] = await Promise.all([context.waitForEvent("page"), page.getByRole("menuitem", { name: "Print Run-Sheet" }).click()]);
  await expect(sheet.locator("body")).toContainText(/Run sheet/i);
  await sheet.close();
  await more.click();
  await page.getByRole("menuitem", { name: "Reset" }).click();
  await openPage(page, "Budget"); // the flag above opened the Tasks page, where its task lives
  await expect(page.getByRole("button", { name: /^Lock Haldi marigold decor/ })).toBeVisible();
  await expect(undo).toBeDisabled();
  // v8 Part 3: the theme is a header toggle (no longer in More) that cycles System, Light, Dark.
  const themeToggle = page.getByTestId("theme-toggle");
  await expect(themeToggle).toHaveAttribute("aria-label", "Theme: System. Switch to Light");
  await themeToggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(themeToggle).toHaveAttribute("aria-label", "Theme: Light. Switch to Dark");
  await themeToggle.press("Enter"); // keyboard works too (a native button)
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(themeToggle).toHaveAttribute("aria-label", "Theme: Dark. Switch to System");
  await themeToggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-pref", "system");
  await more.click();
  await expect(page.getByTestId("theme-select")).toHaveCount(0); // gone from the More menu
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Guest View" }).click();
  await expect(page.getByRole("button", { name: "Guest View" })).toHaveAttribute("aria-pressed", "true");
  await expect(themeToggle).toBeVisible(); // in the Guest View header too
  await page.getByRole("button", { name: "Organizer" }).click();
  await expect(page.getByRole("button", { name: "Organizer" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Open AI Co-Pilot" }).click();
  await expect(page.getByRole("dialog", { name: "AI Co-Pilot" })).toBeVisible();
});

// ---------- 3. inline editing ----------
/** Open an inline editor by its field label, type, and press Enter. */
async function edit(page: Page, label: string, value: string, key: "Enter" | "Escape" = "Enter") {
  await page.getByRole("button", { name: `Edit ${label}`, exact: true }).click();
  const box = page.getByRole("textbox", { name: label, exact: true });
  await expect(box).toBeFocused();
  await box.fill(value);
  await page.keyboard.press(key);
  return box;
}

test("budget: rename a line (Enter saves), Escape cancels, focus returns to the Edit button", async ({ page }) => {
  await openPage(page, "Budget");
  await edit(page, "name of budget line Haldi marigold decor", "Haldi flowers & marigolds");
  await expect(page.locator("#budget span.text-ink", { hasText: /^Haldi flowers & marigolds$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit name of budget line Haldi flowers & marigolds", exact: true })).toBeFocused();
  await edit(page, "name of budget line Haldi flowers & marigolds", "Something else", "Escape");
  await expect(page.locator("#budget span.text-ink", { hasText: /^Haldi flowers & marigolds$/ })).toBeVisible();
  await expect(page.getByText("Something else")).toHaveCount(0);
  await expect(page.getByTestId("envelope-b1")).toHaveAccessibleName("Haldi flowers & marigolds budget");
  await expect(page.getByRole("button", { name: "Edit name of budget line Haldi flowers & marigolds", exact: true })).toBeFocused();
  // Survives a reload (it went through the reducer into the saved history).
  await page.reload();
  await expect(page.locator("#budget span.text-ink", { hasText: /^Haldi flowers & marigolds$/ })).toBeVisible();
});

test("budget: planned amount in rupees moves the Planned KPI by exactly that much; bad input shows a linked error", async ({ page }) => {
  const before = rupees(await kpi(page, "planned").innerText());
  await openPage(page, "Budget");
  const label = "planned amount for Haldi marigold decor";
  const box = await edit(page, label, "abc");
  const err = page.getByRole("alert").filter({ hasText: "whole number of rupees" });
  await expect(err).toBeVisible();
  await expect(box).toHaveAttribute("aria-invalid", "true");
  await expect(box).toHaveAccessibleDescription(/whole number of rupees/);
  await box.fill("-5"); await page.keyboard.press("Enter");
  await expect(box).toHaveAccessibleDescription(/whole number of rupees/);
  await box.fill("100000000000"); await page.keyboard.press("Enter");
  await expect(box).toHaveAccessibleDescription(/at most ₹1,00,00,00,000/);
  // Below what's committed: the reducer refuses, and the editor shows its reason.
  await box.fill("20000"); await page.keyboard.press("Enter");
  await expect(box).toHaveAccessibleDescription(/below the ₹30,000 already committed/);
  await box.fill("95,000"); await page.keyboard.press("Enter");
  await expect(box).toBeHidden();
  await openPage(page, "Overview");
  await expect.poll(async () => rupees(await kpi(page, "planned").innerText())).toBe(before + 15_000);
  await openPage(page, "Budget");
  await expect(page.getByTestId("envelope-b1")).toHaveAttribute("aria-valuetext", /of ₹95,000 planned/);
});

test("budget: category total uses adjust_budget (cut spread over slack), vendor rename", async ({ page }) => {
  const before = rupees(await kpi(page, "planned").innerText());
  await openPage(page, "Budget");
  await edit(page, "Decor planned total", "600000"); // ₹6,10,000 → ₹6,00,000
  await openPage(page, "Overview");
  await expect.poll(async () => rupees(await kpi(page, "planned").innerText())).toBe(before - 10_000);
  await openPage(page, "Budget");
  await expect(page.getByText("₹6,00,000 planned")).toBeVisible();
  await edit(page, "Decor planned total", "100000"); // more than the unlocked slack: refused with the reducer's reason
  await expect(page.getByRole("textbox", { name: "Decor planned total" })).toHaveAccessibleDescription(/Can only cut/);
  await page.keyboard.press("Escape");
  await edit(page, "vendor name DJ Nikhil", "DJ Nikhil & Co");
  await expect(page.getByText("DJ Nikhil & Co", { exact: true })).toBeVisible();
  await edit(page, "vendor name DJ Nikhil & Co", "N Convention");
  await expect(page.getByRole("textbox", { name: "vendor name DJ Nikhil & Co" })).toHaveAccessibleDescription(/already called "N Convention"/);
});

test("event name, couple, task title, sub-event name and start time, guest and household names", async ({ page }) => {
  await edit(page, "event name", "Arjun weds Meera");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Arjun weds Meera");
  await edit(page, "second partner's name", "Meera R.");
  await expect(page.getByTestId("event-details")).toContainText("Meera R.");
  await edit(page, "event name", "   ");
  await expect(page.getByRole("textbox", { name: "event name" })).toHaveAccessibleDescription(/Enter a name/);
  await page.keyboard.press("Escape");

  await openPage(page, "Tasks");
  await edit(page, "task title Book Muhurtham purohit", "Book the purohit");
  await expect(page.getByRole("button", { name: /^Book the purohit/ })).toBeVisible();

  await openPage(page, "Schedule");
  await edit(page, "name of Haldi", "Pasupu");
  await expect(page.getByRole("heading", { name: "Pasupu", level: 3 })).toBeVisible();
  await expect(page.getByTestId("visibility-haldi")).toBeVisible(); // the slug (and so the test id and links) is unchanged
  await page.getByRole("button", { name: "Edit start time of Pasupu", exact: true }).click();
  const t = page.getByLabel("start time of Pasupu", { exact: true });
  await t.fill("11:00");
  await page.keyboard.press("Enter");
  await expect(page.locator("#schedule")).toContainText("11:00 AM–2:00 PM"); // 10:00–13:00 moved, duration kept

  // v8 Part 1f: the Event page no longer has an RSVP matrix; guest and household names are edited on the Guests page,
  // in the optional household list (collapsed by default).
  await openPageNav(page, "Guests");
  const list = page.getByTestId("guests-optional");
  if (!(await list.evaluate(el => (el as HTMLDetailsElement).open))) await list.locator("summary").click();
  await edit(page, "guest name Srinivas Rao", "Srinivas K. Rao");
  await expect(page.getByTestId("household-list")).toContainText("Srinivas K. Rao");
  await edit(page, "household name Sharma family", "Sharma-Verma family");
  await expect(page.getByTestId("household-list")).toContainText("Sharma-Verma family");
});

test("inline editing at 375px: 44px targets, editor fits the screen, axe clean while editing", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await openPage(page, "Budget");
  const btn = page.getByRole("button", { name: "Edit planned amount for Haldi marigold decor", exact: true });
  const b = (await btn.boundingBox())!;
  expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(44);
  await btn.click();
  const box = page.getByRole("textbox", { name: "planned amount for Haldi marigold decor" });
  await box.fill("-1");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "whole number" })).toBeVisible();
  for (const name of ["planned amount for Haldi marigold decor"]) {
    const ib = (await page.getByRole("textbox", { name }).boundingBox())!;
    expect(ib.height).toBeGreaterThanOrEqual(44);
  }
  for (const name of ["Save planned amount for Haldi marigold decor", "Cancel editing planned amount for Haldi marigold decor"]) {
    const bb = (await page.getByRole("button", { name }).boundingBox())!;
    expect(Math.min(bb.width, bb.height)).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  expect(await axe(page)).toEqual([]);
});

test("guest view and the public guest page: no edit controls, no money", async ({ page, browser }) => {
  await page.getByRole("button", { name: "Guest View" }).click();
  await expect(page.getByRole("button", { name: /^Edit / })).toHaveCount(0);
  await expect(page.getByTestId("dashboard")).not.toContainText("₹");
  await page.getByRole("button", { name: "Organizer" }).click();
  await page.getByTestId("open-guest-links").click();
  await page.getByTestId("publish-guest-links").click();
  const url = await page.getByTestId("rsvp-guest-link").inputValue();
  const ctx = await browser.newContext();
  const g = await ctx.newPage();
  await g.goto(url);
  await expect(g.getByTestId("public-guest-page")).toBeVisible();
  await expect(g.getByRole("button", { name: /^Edit / })).toHaveCount(0);
  await expect(g.getByTestId("public-guest-page")).not.toContainText("₹");
  await ctx.close();
});
