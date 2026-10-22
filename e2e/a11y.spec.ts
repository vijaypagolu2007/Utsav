import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Co-Pilot drawer, keyboard/focus, budget meters, responsive layout and an axe-core WCAG 2.2 A/AA scan.
// Runs against the same Demo Mode build as smoke.spec.ts (no Gemini calls).

const pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
test.afterEach(() => { expect(pageErrors, "uncaught client-side exceptions").toEqual([]); });

const launcher = (page: Page) => page.getByRole("button", { name: "Open AI Co-Pilot" });
const drawer = (page: Page) => page.getByRole("dialog", { name: "AI Co-Pilot" });
/** Wait for the drawer's slide-in to finish (an event, not a sleep) so geometry is measured at rest. */
const settle = (page: Page) => page.getByTestId("copilot-drawer").evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished)).then(() => undefined));
const activeInDrawer = (page: Page) => page.evaluate(() => !!document.activeElement?.closest("[data-testid=copilot-drawer]"));

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
  // Background controls can't be clicked while the modal is open.
  await expect(page.getByRole("button", { name: "Export CSV" }).click({ timeout: 1_000 })).rejects.toThrow();
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
  await expect(page.getByRole("heading", { level: 2, name: "Smart Budget Ledger" })).toBeVisible();
  for (const name of ["Undo", "Redo", "Export CSV", "Print Run-Sheet", "Guest links", "Reset", "Scan Vendor Quote / Invoice"]) {
    await expect(page.getByRole("button", { name, exact: true }).first()).toBeVisible();
  }
  await expect(page.getByLabel("Planning date")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Event" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Organizer" })).toHaveAttribute("aria-pressed", "true");
});

test("keyboard: focus is visible and the upload button is reachable", async ({ page }) => {
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
    await page.getByRole("combobox", { name: "Event" }).selectOption(t);
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
      await page.getByRole("combobox", { name: "Event" }).selectOption(t);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `document-level horizontal overflow (${t})`).toBeLessThanOrEqual(0);
    }
    // Budget figures are visible, not clipped to nothing.
    await expect(page.getByTestId("kpi-planned").locator("dd").first()).toHaveText(/₹/);
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
