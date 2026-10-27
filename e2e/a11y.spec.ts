import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { skipWelcome, openPageNav, switchEvent, ownClientIp } from "./helpers";

// Co-Pilot drawer, keyboard/focus, budget meters, responsive layout and an axe-core WCAG 2.2 A/AA scan.
// Runs against the same Demo Mode build as smoke.spec.ts (no Gemini calls).

const pageErrors: string[] = [];
test.beforeEach(async ({ page }, info) => {
  await ownClientIp(page, info);
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
  await skipWelcome(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
test.afterEach(() => { expect(pageErrors, "uncaught client-side exceptions").toEqual([]); });

const launcher = (page: Page) => page.getByRole("button", { name: "Open AI Co-Pilot" });
const drawer = (page: Page) => page.getByRole("dialog", { name: "AI Co-Pilot" });
/** Wait for the drawer's slide-in to finish (an event, not a sleep) so geometry is measured at rest. */
const settle = (page: Page) => page.getByTestId("copilot-drawer").evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished)).then(() => undefined));
const activeInDrawer = (page: Page) => page.evaluate(() => !!document.activeElement?.closest("[data-testid=copilot-drawer]"));
/** Open the header's "More" menu (Export CSV, Print Run-Sheet, Reset, planning date, history). */
async function openMore(page: Page) {
  const more = page.getByRole("button", { name: "More", exact: true });
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
  await expect(page.getByRole("menu")).toBeVisible();
}

// The organizer dashboard is split into pages (/, /budget, /tasks, /schedule, /event). Go to the page that holds a
// control before touching it: a client-side click on the page navigation, so the plan state carries over.
async function openPage(page: Page, name: "Overview" | "Budget" | "Tasks" | "Schedule" | "Event") {
  await openPageNav(page, name);
  // Client navigation moves focus to the new page's h1 two frames after it renders (PlannerApp focusTarget). Wait for
  // that landing, so a test that then focuses a control itself can't have its focus taken by the late move.
  await expect(page.getByTestId("page-heading")).toBeFocused();
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`);
}

// ---------- drawer ----------
test("Co-Pilot is closed by default and the dashboard uses the full width", async ({ page }) => {
  await expect(drawer(page)).toBeHidden();
  await expect(launcher(page)).toBeVisible();
  await expect(launcher(page)).toHaveAttribute("aria-expanded", "false");
  const vw = page.viewportSize()!.width;
  const before = (await page.getByTestId("dashboard").boundingBox())!;
  expect(before.width).toBeGreaterThan(vw - 24); // no reserved chat column (allows a scrollbar)

  await launcher(page).click();
  await expect(drawer(page)).toBeVisible();
  await expect(launcher(page)).toHaveAttribute("aria-expanded", "true");
  await settle(page);
  const box = (await page.getByTestId("copilot-drawer").boundingBox())!;
  expect(box.width).toBeGreaterThan(380);
  expect(Math.round(box.width)).toBeLessThanOrEqual(420);
  expect(Math.round(box.x + box.width)).toBe(vw);
  const after = (await page.getByTestId("dashboard").boundingBox())!;
  expect(after.width).toBe(before.width); // overlay: nothing behind it reflows
});

test("opening moves focus into the drawer; Escape closes and focus returns to the launcher", async ({ page }) => {
  await launcher(page).focus();
  await page.keyboard.press("Enter");
  await expect(drawer(page)).toBeVisible();
  await expect(page.getByLabel("Chat message")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toBeHidden();
  await expect(launcher(page)).toBeFocused();
});

test("close button and backdrop both close the drawer", async ({ page }) => {
  await launcher(page).click();
  await page.getByRole("button", { name: "Close AI Co-Pilot" }).click();
  await expect(drawer(page)).toBeHidden();
  await expect(launcher(page)).toBeFocused();

  await launcher(page).click();
  await expect(drawer(page)).toBeVisible();
  await page.mouse.click(20, 300); // the backdrop, left of the drawer
  await expect(drawer(page)).toBeHidden();
});

test("Tab and Shift+Tab stay inside the open drawer and the dashboard is inert", async ({ page }) => {
  // Real, visible header controls (not ones tucked inside the closed More menu, which would fail to click anyway).
  const links = page.getByTestId("open-guest-links"), more = page.getByRole("button", { name: "More", exact: true });
  await expect(links).toBeVisible();
  await expect(more).toBeVisible();
  await launcher(page).click();
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    // A modal <dialog> may hand focus to the browser chrome (body here) but never to the page behind it.
    expect(await page.evaluate(() => { const a = document.activeElement; return !a || a === document.body || !!a.closest("dialog[open]"); })).toBe(true);
  }
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => { const a = document.activeElement; return !a || a === document.body || !!a.closest("dialog[open]"); })).toBe(true);
  }
  // Background controls can't be clicked while the modal is open: the clicks are refused and nothing opens.
  await expect(links.click({ timeout: 1_000 })).rejects.toThrow();
  await expect(more.click({ timeout: 1_000 })).rejects.toThrow();
  await expect(page.getByRole("dialog", { name: "Guest links" })).toBeHidden();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  // Once the drawer closes, the same control works again (so the refusal above came from the modal, not a broken button).
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toBeHidden();
  await links.click();
  await expect(page.getByRole("dialog", { name: "Guest links" })).toBeVisible();
});

test("closing keeps the transcript, the typed draft and pending approvals", async ({ page }) => {
  await launcher(page).click();
  await page.getByRole("button", { name: "Cut ₹1.5L from decor" }).click(); // a suggested prompt
  await expect(page.getByTestId("rejection-card").last()).toBeVisible();
  await page.getByLabel("Chat message").fill("Cut ₹30k from decor");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("diff-card").last().getByRole("button", { name: "Approve & Commit" })).toBeVisible();
  await page.getByLabel("Chat message").fill("draft I have not sent");
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toBeHidden();

  await launcher(page).click();
  const log = page.getByRole("log", { name: "AI Co-Pilot conversation" });
  await expect(log).toContainText("Cut ₹1.5L from decor");
  await expect(log).toContainText("Cut ₹30k from decor");
  await expect(page.getByLabel("Chat message")).toHaveValue("draft I have not sent");
  // Still pending: closing never approves or rejects anything.
  const card = page.getByTestId("diff-card").last();
  await expect(card.getByRole("button", { name: "Approve & Commit" })).toBeVisible();
  await card.getByRole("button", { name: "Approve & Commit" }).click();
  await expect(card).toContainText("Committed");
  await expect(page.getByTestId("copilot-status")).toContainText("Applied");
});

test("quote upload from the drawer still produces an approval card", async ({ page }) => {
  await launcher(page).click();
  await page.getByTestId("copilot-upload").setInputFiles({
    name: "quote.txt", mimeType: "text/plain",
    buffer: Buffer.from("MARIGOLD FLORALS\nItem: Haldi marigold decor\nTotal: ₹90,000\nAdvance: 25% non-refundable within 5 days\n"),
  });
  const card = page.getByTestId("diff-card").last();
  await expect(card).toContainText("Marigold Florals");
  await expect(card.getByRole("button", { name: "Approve & Update Budget" })).toBeVisible();
});

test("scanning from the ledger opens the drawer with the result", async ({ page }) => {
  await openPage(page, "Budget");
  await page.getByRole("button", { name: "Scan Sample Vendor Quote" }).click();
  await expect(drawer(page)).toBeVisible();
  await expect(page.getByTestId("diff-card").last()).toContainText("Contract red flags");
});

test("reduced motion: the drawer opens without animating", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await launcher(page).click();
  const ms = await page.getByTestId("copilot-drawer").evaluate(el => parseFloat(getComputedStyle(el).animationDuration) * 1000);
  expect(ms).toBeLessThan(1);
});

test("guest view has its own launcher and concierge drawer", async ({ page }) => {
  await page.getByRole("button", { name: "Guest View" }).click();
  await page.getByRole("button", { name: "Open Guest Concierge" }).click();
  await expect(page.getByRole("dialog", { name: "Guest Concierge" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan sample quote" })).toHaveCount(0);
});

// ---------- semantics ----------
test("budget bars expose committed vs planned as a meter with rupee text", async ({ page }) => {
  await openPage(page, "Budget");
  const meter = page.getByRole("meter", { name: "Haldi marigold decor budget" });
  await expect(meter).toHaveAttribute("aria-valuenow", "30000");
  await expect(meter).toHaveAttribute("aria-valuemin", "0");
  await expect(meter).toHaveAttribute("aria-valuemax", "80000");
  await expect(meter).toHaveAttribute("aria-valuetext", /₹30,000 committed of ₹80,000 planned, ₹50,000 not yet committed/);
  const mandap = page.getByRole("meter", { name: "Mandap budget" });
  await expect(mandap).toHaveAttribute("aria-valuetext", /locked/);
  // Organizer action updates the value.
  await page.getByRole("button", { name: /^Lock Haldi marigold decor$/ }).click();
  await expect(meter).toHaveAttribute("aria-valuetext", /locked, so AI cuts skip it/);
});

test("landmarks, headings, and named controls", async ({ page }) => {
  await expect(page.getByRole("banner")).toHaveCount(1);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await openPage(page, "Budget");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 2, name: "Smart Budget Ledger" })).toBeVisible();
  for (const name of ["Undo", "Redo", "Guest links", "Scan Vendor Quote / Invoice"]) {
    await expect(page.getByRole("button", { name, exact: true }).first()).toBeVisible();
  }
  // Export CSV, Print Run-Sheet, Reset and the planning date now live in the header's "More" menu (same names).
  await openMore(page);
  for (const name of ["New plan", "Export CSV", "Print Run-Sheet", "Reset"]) {
    await expect(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByLabel("Planning date")).toBeVisible();
  await expect(page.getByTestId("event-switcher")).toBeVisible();
  await expect(page.getByRole("button", { name: "Organizer" })).toHaveAttribute("aria-pressed", "true");
});

test("keyboard: focus is visible and the upload button is reachable", async ({ page }) => {
  await openPage(page, "Budget");
  const scan = page.getByRole("button", { name: "Scan Vendor Quote / Invoice" });
  await scan.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(scan).toBeFocused();
  const outline = await scan.evaluate(el => { const s = getComputedStyle(el); return `${s.outlineStyle} ${s.outlineWidth}`; });
  expect(outline).toMatch(/solid 2px/);
});

test("red-flag list is a disclosure that Escape closes", async ({ page }) => {
  const btn = page.getByRole("button", { name: /red flag/ });
  await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  await expect(btn).toBeFocused();
});

test("share dialog is a modal dialog that Escape closes", async ({ page }) => {
  await page.getByTestId("open-guest-links").click();
  const dlg = page.getByRole("dialog", { name: "Guest links" });
  await expect(dlg).toBeVisible();
  // v8 Part 2: focus moves inside the dialog on open, onto its Close button (the safe control).
  await expect(dlg.getByTestId("share-close")).toBeFocused();
  expect(await page.evaluate(() => !!document.activeElement?.closest("dialog[open]"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await expect(page.getByTestId("open-guest-links")).toBeFocused();
});

// ---------- automated WCAG scan (does not prove conformance; see README) ----------
test("axe: organizer dashboard has no WCAG 2.2 A/AA violations", async ({ page }) => {
  expect(await axe(page)).toEqual([]);
});
test("axe: open Co-Pilot drawer has no violations", async ({ page }) => {
  await launcher(page).click();
  await page.getByRole("button", { name: "Cut ₹1.5L from decor" }).click();
  await expect(page.getByTestId("rejection-card").last()).toBeVisible();
  expect(await axe(page)).toEqual([]);
});
test("axe: guest view and each event type", async ({ page }) => {
  for (const t of ["birthday", "community", "wedding"]) {
    await switchEvent(page, t);
    expect(await axe(page), `organizer ${t}`).toEqual([]);
  }
  await page.getByRole("button", { name: "Guest View" }).click();
  expect(await axe(page), "guest view").toEqual([]);
});

// ---------- responsive ----------
for (const width of [320, 375, 768, 1280]) {
  test(`responsive ${width}px: no page-level horizontal overflow, drawer fits, chat usable`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 768 ? 740 : 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    for (const t of ["birthday", "community", "wedding"]) {
      await switchEvent(page, t);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `document-level horizontal overflow (${t})`).toBeLessThanOrEqual(0);
    }
    // Budget figures are visible, not clipped to nothing (the KPI on Overview, the meter on Budget).
    await expect(page.getByTestId("kpi-planned").locator("dd").first()).toHaveText(/₹/);
    await openPage(page, "Budget");
    await expect(page.getByRole("meter", { name: "Haldi marigold decor budget" })).toBeVisible();

    await launcher(page).click();
    await settle(page);
    const box = (await page.getByTestId("copilot-drawer").boundingBox())!;
    expect(Math.round(box.x)).toBeGreaterThanOrEqual(0);
    expect(Math.round(box.width)).toBeLessThanOrEqual(width);
    for (const loc of [page.getByLabel("Chat message"), page.getByRole("button", { name: "Send", exact: true }), page.getByRole("button", { name: "Close AI Co-Pilot" })]) {
      await expect(loc).toBeInViewport();
    }
    await page.getByLabel("Chat message").fill("Which vendor deposits are overdue and what tasks are urgent?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("log", { name: "AI Co-Pilot conversation" })).toContainText("Which vendor deposits");
    expect(await activeInDrawer(page), "focus stays in the drawer after sending").toBe(true);
    const overflowOpen = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflowOpen).toBeLessThanOrEqual(0);
  });
}

// ---------- redesign: skip link, menu button, mobile section nav, target sizes, launcher placement ----------
test("skip link is the first Tab stop and moves focus to the main content", async ({ page }) => {
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  const box = (await skip.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("dashboard")).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("main"))).toBe(true);
});

test("More is an APG menu button: arrows move, Escape closes and returns focus", async ({ page }) => {
  const more = page.getByRole("button", { name: "More", exact: true });
  await expect(more).toHaveAttribute("aria-haspopup", "menu");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const item = (name: string) => page.getByRole("menuitem", { name, exact: true });
  await expect(item("New plan")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item("Export CSV")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item("Print Run-Sheet")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item("Reset")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item("New plan")).toBeFocused(); // wraps
  await page.keyboard.press("ArrowUp");
  await expect(item("Reset")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(item("New plan")).toBeFocused();
  await page.keyboard.press("End");
  await expect(item("Reset")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowUp");
  await expect(item("Reset")).toBeFocused(); // ArrowUp opens on the last item
  await page.keyboard.press("Escape");
  // The planning date sits in the same popover, reachable with Tab, with its en-IN date as the description.
  await openMore(page);
  const date = page.getByLabel("Planning date");
  await date.fill("2026-10-22");
  await expect(date).toHaveAccessibleDescription(/Thu, 22 Oct 2026/);
  await expect(page.getByText("Thu, 22 Oct 2026")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
});

test("organizer: every control exists once (one timeline / RSVP variant rendered at a time)", async ({ page }) => {
  await switchEvent(page, "wedding");
  await openPage(page, "Schedule");
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByTestId("visibility-haldi")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Shift Marigold decor setup 15 minutes later" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Shift Marigold decor setup 15 minutes earlier" })).toHaveCount(1);
    await expect(page.getByTestId("copilot-launcher")).toHaveCount(1);
  }
});

// The bottom tab bar links to pages: v6 keeps four (Overview, Budget, Tasks, Vendors) plus a "More" sheet with Schedule,
// Event and Ideas, so every target stays 44px+ and no label truncates. aria-current="page" marks the open page; the More
// button names the open page when it is one of its own; nothing is hidden under the bar.
test("mobile tab bar: four page links and More, 44px tall, aria-current follows the open page", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  const nav = page.getByRole("navigation", { name: "Pages" });
  await expect(nav).toBeVisible();
  const links = nav.getByRole("link");
  await expect(links).toHaveText(["Overview", "Budget", "Tasks", "Vendors"]);
  const more = nav.getByTestId("more-button");
  await expect(more).toHaveText("More");
  for (const l of [...await links.all(), more]) {
    const b = (await l.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.width).toBeGreaterThanOrEqual(44);
  }
  for (const l of await links.all()) expect(await l.getAttribute("href")).toMatch(/^\/(budget|tasks|vendors)?$/);
  await expect(links.filter({ hasText: "Overview" })).toHaveAttribute("aria-current", "page");
  for (const [name, id] of [["Tasks", "tasks"], ["Vendors", "vendors"], ["Budget", "budget"]] as const) {
    await nav.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`/${id}$`));
    await expect(page.locator(`#${id}`)).toBeInViewport();
    await expect(nav.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
    await expect(nav.locator("[aria-current]")).toHaveCount(1);
    const h = (await page.locator(`#${id} h2`).first().boundingBox())!;
    const n = (await nav.boundingBox())!;
    expect(h.y + h.height).toBeLessThanOrEqual(n.y);
  }
  // More: a sheet of the other pages; Escape closes it and returns focus; choosing one navigates and names it on the button.
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const sheet = page.getByTestId("more-sheet");
  await expect(sheet.getByRole("link")).toHaveText(["Schedule", "Event", "Guests", "Ideas"]);
  await expect(sheet.getByRole("link", { name: "Schedule" })).toBeFocused();
  for (const l of await sheet.getByRole("link").all()) expect((await l.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await axe(page), "More sheet open").toEqual([]);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(more).toBeFocused();
  for (const [name, id] of [["Schedule", "schedule"], ["Event", "event"], ["Guests", "guests"], ["Ideas", "ideas"]] as const) {
    await more.click();
    await sheet.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`/${id}$`));
    await expect(sheet).toHaveCount(0);
    await expect(more).toContainText(name);
    await expect(page.locator(`#${id}`)).toBeInViewport();
  }
  // At 768px and up the same links move into the header (and the bottom bar goes); absent in the guest view.
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(nav).toBeVisible();
  await expect(page.getByRole("banner").getByRole("navigation", { name: "Pages" })).toBeVisible();
  await expect(page.getByRole("banner").getByRole("navigation", { name: "Pages" }).getByRole("link")).toHaveCount(8);
  await page.setViewportSize({ width: 375, height: 740 });
  await page.getByRole("button", { name: "Guest View" }).click();
  await expect(nav).toHaveCount(0);
});

/** Visible interactive elements smaller than 24×24 CSS px (WCAG 2.5.8). Visually hidden (sr-only) and closed content is skipped. */
async function smallTargets(page: Page) {
  return page.evaluate(() => {
    const sel = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=menuitem], [tabindex]:not([tabindex='-1'])";
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (el.closest("dialog:not([open])")) continue;
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (r.width <= 1 || r.height <= 1 || cs.visibility === "hidden" || cs.display === "none") continue;
      if (r.width < 23.5 || r.height < 23.5) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 50)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
}

for (const width of [375, 1280]) {
  test(`target size ${width}px: every visible interactive element is at least 24x24 (organizer, menus, guest)`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 768 ? 740 : 900 });
    for (const t of ["birthday", "community", "wedding"]) {
      await switchEvent(page, t);
      expect(await smallTargets(page), `organizer ${t}`).toEqual([]);
    }
    await openMore(page);
    expect(await smallTargets(page), "More menu open").toEqual([]);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /red flag/ }).click();
    expect(await smallTargets(page), "red flags open").toEqual([]);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Guest View" }).click();
    expect(await smallTargets(page), "guest view").toEqual([]);
    await page.getByRole("button", { name: "Organizer" }).click();
    await launcher(page).click();
    await page.getByRole("button", { name: "Cut ₹1.5L from decor" }).click();
    await expect(page.getByTestId("rejection-card").last()).toBeVisible();
    expect(await smallTargets(page), "Co-Pilot drawer").toEqual([]);
  });

  test(`launcher ${width}px: one round floating button at the bottom right, never over page content`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 768 ? 740 : 900 });
    const fab = page.getByTestId("copilot-launcher");
    await expect(fab).toHaveCount(1);
    await expect(fab).toBeVisible();
    await expect(fab).toHaveAccessibleName("Open AI Co-Pilot");
    // v8: not in the header any more; the account control holds the header's top-right slot instead.
    await expect(page.getByRole("banner").getByTestId("copilot-launcher")).toHaveCount(0);
    await expect(page.getByTestId("header-account-slot").getByTestId("cloud-signin")).toBeVisible();
    const l = (await fab.boundingBox())!;
    expect(Math.round(l.width)).toBe(56);
    expect(Math.round(l.height)).toBe(56);
    expect(await fab.evaluate(el => getComputedStyle(el).position)).toBe("fixed");
    // Bottom right, inside the viewport.
    expect(l.x + l.width).toBeLessThanOrEqual(width - 8);
    expect(l.x + l.width).toBeGreaterThan(width - 40);
    const vh = page.viewportSize()!.height;
    expect(l.y + l.height).toBeLessThanOrEqual(vh - 8);
    if (width < 768) {
      // Above the bottom tab bar, never on it.
      const nav = (await page.getByRole("navigation", { name: "Pages" }).boundingBox())!;
      expect(l.y + l.height).toBeLessThanOrEqual(nav.y);
    } else {
      expect(l.y + l.height).toBeGreaterThan(vh - 40);
    }
    // Keyboard focus shows a visible ring.
    await fab.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(fab).toBeFocused();
    expect(await fab.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe("none");
    // Wherever the page is scrolled, the launcher is the topmost thing at its own centre.
    for (const frac of [0, 0.5, 1]) {
      await page.evaluate(f => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * f), frac);
      const ok = await fab.evaluate(el => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && el.contains(hit);
      });
      expect(ok, `launcher covered at ${frac}`).toBe(true);
    }
    // At the very bottom of a page, the last content ends above the launcher (main reserves --fab-space), and on mobile
    // the tab bar sits below the last section instead of over it (the Event page's card).
    await openPage(page, "Event");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const last = (await page.locator("#event").boundingBox())!;
    const now = (await fab.boundingBox())!;
    expect(last.y + last.height).toBeLessThanOrEqual(now.y);
    if (width < 768) {
      const nav = (await page.getByRole("navigation", { name: "Pages" }).boundingBox())!;
      expect(last.y + last.height).toBeLessThanOrEqual(nav.y);
    }
  });
}

test("axe at 375px: organizer (each event type), More menu and guest view", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  for (const t of ["birthday", "community", "wedding"]) {
    await switchEvent(page, t);
    expect(await axe(page), `organizer ${t} 375px`).toEqual([]);
  }
  await openMore(page);
  expect(await axe(page), "More menu").toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Guest View" }).click();
  expect(await axe(page), "guest view 375px").toEqual([]);
});

async function publishLink(page: Page, template: string, which: "public" | "invite") {
  await switchEvent(page, template);
  await page.getByTestId("open-guest-links").click();
  await page.getByTestId("publish-guest-links").click();
  // v8 Part 1d: the dialog shows only the RSVP link. The old public itinerary URL is the same address without #k=.
  const input = page.getByTestId("rsvp-guest-link");
  await expect(input).toBeVisible();
  const rsvpUrl = await input.inputValue();
  const url = which === "public" ? rsvpUrl.replace(/#.*$/, "") : rsvpUrl;
  await page.getByRole("button", { name: "Close", exact: true }).click();
  return url;
}

test("public guest link: visible labels, 44px RSVP form targets, errors linked with aria-describedby, axe clean", async ({ page, browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 } });
  const guest = await ctx.newPage();
  // Community public link: the volunteer / sponsor forms.
  await guest.goto(await publishLink(page, "community", "public"));
  await expect(guest.getByTestId("public-guest-page")).toBeVisible();
  for (const name of ["Volunteer name", "Sub-event", "Shift", "Sponsor name", "Tier"]) await expect(guest.getByLabel(name)).toBeVisible();
  expect(await smallTargets(guest), "community public page targets").toEqual([]);
  expect(await axe(guest), "community public page").toEqual([]);
  // Wedding RSVP link (v8 Part 1c): the open form, every control labelled and at least 44px.
  await guest.goto(await publishLink(page, "wedding", "invite"));
  await expect(guest.getByTestId("rsvp-form")).toBeVisible();
  for (const name of ["Your name *", "WhatsApp number (optional)", "People in your party"]) await expect(guest.getByLabel(name, { exact: false }).first()).toBeVisible();
  await expect(guest.getByRole("group", { name: "Will you come?" })).toBeVisible();
  await expect(guest.getByRole("group", { name: "Functions you're attending" })).toBeVisible();
  await expect(guest.getByRole("group", { name: "Meal" })).toBeVisible();
  expect(await smallTargets(guest), "RSVP form targets").toEqual([]);
  for (const id of ["rsvp-answer-maybe", "rsvp-fn-s1", "rsvp-meal-jain", "rsvp-party-plus", "rsvp-submit"]) {
    const b = (await guest.getByTestId(id).boundingBox())!;
    expect(Math.min(b.width, b.height), id).toBeGreaterThanOrEqual(44);
  }
  expect(await axe(guest), "wedding RSVP form").toEqual([]);
  // A missing name is announced and linked to the field it came from.
  await guest.getByTestId("rsvp-submit").click();
  await expect(guest.getByTestId("rsvp-error")).toHaveText("Enter your name.");
  await expect(guest.getByTestId("rsvp-name")).toHaveAccessibleDescription("Enter your name.");
  await expect(guest.getByTestId("rsvp-name")).toHaveAttribute("aria-invalid", "true");
  // A server failure is announced in the form's alert.
  await guest.route("**/api/events/*/rsvp", r => r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "simulated conflict" }) }));
  await guest.getByTestId("rsvp-name").fill("Asha");
  await guest.getByTestId("rsvp-fn-s3").click();
  await guest.getByTestId("rsvp-submit").click();
  await expect(guest.getByTestId("rsvp-error")).toHaveText("simulated conflict");
  expect(await axe(guest), "wedding RSVP form with an error").toEqual([]);
  await ctx.close();
});
