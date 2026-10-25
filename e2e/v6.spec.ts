import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openPageNav, skipWelcome } from "./helpers";

// v6: priorities in setup and on /budget, "Fix by my priorities", what-if, the vendor workspace (checklist, questions,
// quote comparison, booking via approval), task dependencies, idea refinement, the adopt over-budget warning and the
// stress test ("budget down ₹50k, 2 weeks earlier" revises the plan in one card). The server runs with Gemini disabled.
const pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
});
test.afterEach(() => { expect(pageErrors, "uncaught client-side exceptions").toEqual([]); });

const h1 = (page: Page) => page.getByRole("heading", { level: 1 });
const rupees = (s: string) => Number(s.replace(/[^\d]/g, ""));
async function axe(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`);
}
async function lowerTotal(page: Page, to: string) {
  await page.getByRole("button", { name: "Edit total budget" }).click();
  await page.getByRole("textbox", { name: "total budget" }).fill(to);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("budget-total")).toHaveText(`₹${Number(to).toLocaleString("en-IN")}`);
}
const categoryTotal = async (page: Page, label: string) =>
  rupees(await page.getByRole("button", { name: `Edit ${label} planned total` }).locator("xpath=..").innerText());

test("setup: the 'What matters most' step saves priorities and the level onto the new plan", async ({ page }) => {
  test.slow(); // many steps plus a server round trip; slower machines need more than the default 45 s
  await page.goto("/");
  await page.getByTestId("welcome-plan").click();
  await page.getByLabel("City", { exact: true }).fill("Hyderabad");
  await page.getByLabel("First day").fill("2027-02-10");
  await page.getByLabel("How many guests?").fill("200");
  await page.getByLabel("Total budget (₹)").fill("1500000");
  await page.getByRole("button", { name: "Next: priorities" }).click();
  await expect(page.getByTestId("setup-priorities")).toBeVisible();
  await expect(h1(page)).toHaveText("What matters most?");
  await expect(h1(page)).toBeFocused();
  await expect(page.getByText("New plan · Step 2 of 3")).toBeVisible();
  await page.getByTestId("setup-prio-catering-protect").check({ force: true });
  await page.getByTestId("setup-prio-decor-cut_first").check({ force: true });
  await page.getByTestId("setup-level-premium").check();
  await expect(page.getByTestId("setup-prio-summary")).toContainText("Protecting Catering; cutting Mandap & decor first.");
  // Back keeps the choices.
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Next: priorities" }).click();
  await expect(page.getByTestId("setup-prio-catering-protect")).toBeChecked();
  await page.getByRole("button", { name: "Next: budget" }).click();
  await expect(page.getByTestId("setup-step-2")).toBeVisible();
  await page.getByRole("button", { name: "Create my plan" }).click();
  // Creating calls /api/plan; a server error would show as an alert on the form instead.
  await expect(page.getByTestId("setup-step-2").getByRole("alert")).toHaveCount(0);
  await expect(h1(page)).toHaveText(/Wedding/, { timeout: 30_000 });
  await page.goto("/budget");
  await expect(page.getByTestId("priority-catering-protect")).toBeChecked();
  await expect(page.getByTestId("priority-decor-cut_first")).toBeChecked();
  await expect(page.getByTestId("priority-level-premium")).toBeChecked();
  // Per-guest lines from the blueprint: catering shows its per-guest rate.
  await page.locator("#budget h3 button", { hasText: "Catering" }).first().click();
  await expect(page.locator('[data-testid^="per-guest-"]').first()).toContainText("per guest");
});

test.describe("sample wedding", () => {
  test.beforeEach(async ({ page }) => { await skipWelcome(page); await page.goto("/"); });

  test("priorities on /budget: edit, save (Tier 0), undo", async ({ page }) => {
    await page.goto("/budget");
    await expect(page.getByTestId("priority-catering-protect")).toBeChecked();
    await expect(page.getByTestId("save-priorities")).toBeDisabled();
    await page.getByTestId("priority-photo_video-protect").check({ force: true });
    await expect(page.getByTestId("protect-rank-photo_video")).toHaveText("#3 to protect");
    // Ranked: move Photo & video above Venue.
    await page.getByTestId("raise-photo_video").click();
    await expect(page.getByTestId("protect-rank-photo_video")).toHaveText("#2 to protect");
    await page.getByTestId("priority-level-simple").check({ force: true });
    await page.getByTestId("save-priorities").click();
    await expect(page.getByTestId("save-priorities")).toBeDisabled();
    await expect(page.getByTestId("priorities-panel")).toContainText("Protecting Catering, Photo & video, Venue");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByTestId("priority-photo_video-flexible")).toBeChecked();
  });

  test("Over budget? Fix by my priorities: an approval card of trade-offs; cut-first gives, protected untouched; exact", async ({ page }) => {
    await page.goto("/budget");
    await expect(page.getByTestId("fix-by-priorities")).toBeDisabled();
    await lowerTotal(page, "2400000");
    await expect(page.getByTestId("budget-headroom")).toHaveText("₹80,000");
    const catering = await categoryTotal(page, "Catering");
    const decor = await categoryTotal(page, "Decor");
    await page.getByTestId("fix-by-priorities").click();
    const card = page.getByTestId("priority-fix-preview");
    await expect(card).toBeFocused();
    await expect(card).toContainText("Tier 1");
    const t = card.getByTestId("tradeoffs");
    await expect(t).toContainText(/Decor −₹[\d,]+ \(cut first\) to keep Catering and Venue intact/);
    await expect(t).toContainText("Catering and Venue are must-protect, so they are untouched.");
    await expect(card).not.toContainText(/\.\d\b/); // whole rupees, no stray paise
    await card.getByRole("button", { name: "Approve & Commit" }).click();
    await expect(page.getByTestId("budget-planned")).toHaveText("₹24,00,000");
    await expect(page.getByTestId("budget-headroom")).toHaveText("₹0");
    expect(await categoryTotal(page, "Catering")).toBe(catering);
    expect(await categoryTotal(page, "Decor")).toBeLessThan(decor);
    await expect(page.getByTestId("fix-by-priorities")).toBeDisabled();
  });

  test("what-if: spend more on photos (balanced by priorities), and more guests (per-guest lines), then commit as a card", async ({ page }) => {
    await page.goto("/budget");
    await page.getByTestId("whatif-category").selectOption("photo_video");
    await page.getByTestId("whatif-amount").fill("250000");
    await expect(page.getByTestId("whatif-row-photo_video")).toContainText("+₹70,000");
    await expect(page.getByTestId("whatif-row-decor")).toContainText("−");
    await expect(page.getByTestId("whatif-row-catering")).toHaveCount(0);
    await expect(page.getByTestId("whatif-headroom")).toHaveText("₹0");
    // Without balancing, the consequence is an overrun (and nothing else moves).
    await page.getByTestId("whatif-balance").uncheck();
    await expect(page.getByTestId("whatif-headroom")).toHaveText("₹50,000 over");
    await expect(page.getByTestId("whatif-row-decor")).toHaveCount(0);
    await page.getByTestId("whatif-balance").check();
    await expect(page.getByTestId("budget-planned")).toHaveText("₹24,80,000"); // nothing committed yet
    await page.getByTestId("whatif-review").click();
    const card = page.getByTestId("whatif-preview");
    await expect(card).toContainText("Tier 1");
    await card.getByRole("button", { name: "Approve & Commit" }).click();
    await expect(page.getByTestId("budget-planned")).toHaveText("₹25,00,000");
    expect(await categoryTotal(page, "Photo & video")).toBe(250000);
    // More guests: per-guest catering lines rescale (₹1,500 + ₹500 per guest × 20 = ₹40,000).
    await page.getByTestId("whatif-mode-guests").check({ force: true });
    await page.getByTestId("whatif-balance").uncheck();
    await page.getByTestId("whatif-guests").fill("320");
    await expect(page.getByTestId("whatif-row-catering")).toContainText("+₹40,000");
    await expect(page.getByTestId("whatif-result")).toContainText("per-guest lines rescale");
  });

  test("vendors: checklist statuses, add a vendor (Unverified), not needed, questions to ask, compare quotes, book via approval", async ({ page }) => {
    await openPageNav(page, "Vendors");
    await expect(h1(page)).toHaveText("Vendors");
    await expect(page.getByTestId("slot-status-venue")).toHaveText("Booked");
    await expect(page.getByTestId("slot-status-photographer")).toHaveText("Quoted");
    await expect(page.getByTestId("slot-status-mehendi_artist")).toHaveText("Needed");
    await expect(page.getByTestId("vendor-progress")).toHaveText("4 of 8 booked");
    // Add a mehendi artist: shortlisted, labelled Unverified (no quote, so no price or availability).
    await page.getByTestId("add-vendor-mehendi_artist").click();
    const form = page.getByTestId("add-vendor-form-mehendi_artist");
    await form.getByLabel("Vendor name").fill("Henna by Hima");
    await form.getByRole("button", { name: "Add" }).click();
    await expect(page.getByTestId("slot-status-mehendi_artist")).toHaveText("Shortlisted");
    const hima = page.getByTestId("vendor-slot-mehendi_artist").locator('[data-testid^="vendor-v-"]');
    await expect(hima).toContainText("Henna by Hima");
    await expect(hima.locator('[data-figure="unverified"]')).toHaveText("Unverified");
    // Not needed, and back.
    await page.getByTestId("not-needed-makeup").click();
    await expect(page.getByTestId("slot-status-makeup")).toHaveText("Not needed");
    await expect(page.getByTestId("vendor-progress")).toHaveText("4 of 7 booked");
    await page.getByTestId("not-needed-makeup").click();
    await expect(page.getByTestId("slot-status-makeup")).toHaveText("Needed");
    // Questions to ask (Demo Mode bank), copyable.
    await page.getByTestId("questions-caterer").click();
    const qs = page.getByTestId("vendor-slot-caterer").getByTestId("questions-card");
    await expect(qs).toContainText("Questions to ask: Caterer");
    expect(await qs.locator("li").count()).toBeGreaterThanOrEqual(5);
    await expect(qs.getByRole("button", { name: "Copy questions" })).toBeVisible();
    // Quote comparison: per guest computed in code; extras listed; open questions shown.
    await page.getByTestId("compare-photographer").click();
    const table = page.getByTestId("quote-compare-photographer");
    await expect(table.getByRole("columnheader", { name: /Lens & Light Co\./ })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: /Frame by Frame Studios/ })).toBeVisible();
    await expect(page.getByTestId("per-guest-v6")).toContainText("₹600");
    await expect(page.getByTestId("per-guest-v4")).toContainText("₹733");
    await expect(page.getByTestId("per-guest-v6")).toContainText("Lowest per guest");
    await expect(table).toContainText("amount not stated");
    await expect(table).toContainText("How many guests does it cover?");
    // Booking is Tier 1: previewed as an approval card first.
    await page.getByTestId("vendor-stage-v6").selectOption("booked");
    const card = page.getByTestId("vendor-approval");
    await expect(card).toContainText("Tier 1");
    await expect(page.getByTestId("slot-status-photographer")).toHaveText("Quoted");
    await card.getByRole("button", { name: "Approve & Commit" }).click();
    await expect(page.getByTestId("slot-status-photographer")).toHaveText("Booked");
    await expect(page.getByTestId("vendor-progress")).toHaveText("5 of 8 booked");
  });

  test("task dependencies: 'Blocked by' in the queue, flagged in Needs attention, cleared when the blocker is done; add one", async ({ page }) => {
    const attention = page.locator("#attention");
    if (await attention.getByRole("button", { name: /Show all/ }).isVisible()) await attention.getByRole("button", { name: /Show all/ }).click();
    await expect(attention).toContainText("Print wedding invitations: blocked");
    await expect(attention).toContainText('Waiting on "Book Muhurtham purohit"');
    await openPageNav(page, "Tasks");
    await expect(page.getByTestId("blocked-k5")).toContainText("Blocked by Book Muhurtham purohit");
    // Sorted by priority, then due date: the high-priority overdue deposit comes first.
    await expect(page.locator("#tasks li").first()).toContainText("Pay caterer deposit");
    // Finish the blocker (todo → doing → done): the chip goes away.
    const k3 = page.locator("#ref-k3");
    await k3.click();
    await page.locator("#ref-k3").click();
    await expect(page.getByTestId("blocked-k5")).toHaveCount(0);
    // Add a dependency: shuttles wait for the invitations.
    await page.locator('[data-testid="deps-k7"] summary').click();
    await page.getByTestId("dep-add-k7").selectOption({ label: "Print wedding invitations" });
    await expect(page.getByTestId("blocked-k7")).toContainText("Blocked by Print wedding invitations");
    await expect(page.locator('[data-testid="deps-k7"] summary')).toContainText("Waits for 1 task");
  });

  test("ideas: Cheaper alternative and Make it kid-friendly add refined cards linked to the source idea (Demo Mode)", async ({ page }) => {
    await page.goto("/ideas");
    await page.getByTestId("get-ideas").click();
    const first = page.getByTestId("idea-list").locator("article").filter({ hasText: /₹[\d,]+ – ₹/ }).first();
    const id = (await first.getAttribute("data-testid"))!.replace("idea-", "");
    const title = (await first.getByRole("heading").innerText()).trim();
    await page.getByTestId(`refine-cheaper-${id}`).click();
    await expect(page.getByRole("status").filter({ hasText: "Cheaper alternative for" })).toContainText("Demo Mode");
    const refined = page.locator('[data-testid^="refined-from-"]', { hasText: title });
    await expect(refined.first()).toBeVisible();
    const card = refined.first().locator("xpath=ancestor::article[1]");
    await expect(card.locator('[data-figure="estimate"]')).toHaveText("Estimate");
    await page.getByTestId(`refine-kid_friendly-${id}`).click();
    await expect(page.getByRole("status").filter({ hasText: "Make it kid-friendly for" })).toBeVisible();
    expect(await page.locator('[data-testid^="refined-from-"]', { hasText: title }).count()).toBeGreaterThanOrEqual(2);
  });

  test("adopting an idea that puts the plan over budget warns, and 'Add it and fix by my priorities' keeps it exact", async ({ page }) => {
    await page.goto("/ideas");
    await page.getByTestId("get-ideas").click();
    // ₹20,000 of headroom: a costed idea above that tips the plan over.
    const big = page.getByTestId("idea-list").locator("article").filter({ hasText: /₹(\d{1,2},)?\d{2},\d{3} – / }).first();
    await big.getByRole("button", { name: /^Add to plan/ }).click();
    const warn = big.getByTestId("adopt-warning");
    await expect(warn).toContainText("over your ₹25,00,000 total");
    await warn.getByTestId("adopt-fix-by-priorities").click();
    const card = big.getByTestId("approval-preview");
    await expect(card.getByTestId("tradeoffs")).toContainText("By your priorities");
    await card.getByRole("button", { name: "Approve & Commit" }).click();
    await page.goto("/budget");
    await expect(page.getByTestId("budget-headroom")).toHaveText("₹0");
    await expect(page.getByTestId("budget-planned")).toHaveText("₹25,00,000");
  });

  test("stress test: 'budget dropped by ₹50,000 and 2 weeks earlier' is ONE approval card that revises the plan", async ({ page }) => {
    const before = (await h1(page).innerText()).trim();
    await page.getByTestId("copilot-launcher").click();
    await page.locator('[data-prompt-id="stress-test-revise"]').click();
    const log = page.getByRole("log", { name: "AI Co-Pilot conversation" });
    await expect(log).toContainText("I revised the plan rather than starting over");
    const card = log.getByTestId("diff-card").last();
    await expect(card).toContainText("Tier 1");
    await expect(card).toContainText("Total budget");
    await expect(card).toContainText("Event window");
    const t = card.getByTestId("tradeoffs");
    await expect(t).toContainText("14 days earlier");
    await expect(t).toContainText("now overdue");
    await expect(t).toContainText(/Decor −₹[\d,]+ \(cut first\) to keep Catering and Venue intact/);
    await expect(log.getByText("Cold-start blueprint")).toHaveCount(0);
    await card.getByRole("button", { name: "Approve & Commit" }).click();
    await expect(card).toContainText("Committed");
    await page.getByRole("button", { name: "Close AI Co-Pilot" }).click();
    await expect(h1(page)).toHaveText(before); // same plan, revised
    await page.goto("/budget");
    await expect(page.getByTestId("budget-total")).toHaveText("₹24,50,000");
    await expect(page.getByTestId("budget-planned")).toHaveText("₹24,50,000");
    await page.goto("/schedule");
    await expect(page.locator("#schedule")).toContainText("25 Feb"); // the Haldi, 2027-03-11 − 14 days
  });

  test("stress test works with the server unreachable too (client-side Demo Mode)", async ({ page }) => {
    await page.route("**/api/chat", r => r.abort());
    await page.getByTestId("copilot-launcher").click();
    await page.getByLabel("Chat message").fill("Our budget dropped by ₹50,000 and the event is 2 weeks earlier");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const log = page.getByRole("log", { name: "AI Co-Pilot conversation" });
    await expect(log).toContainText("Answered locally in Demo Mode");
    await expect(log.getByTestId("tradeoffs").last()).toContainText("to keep Catering and Venue intact");
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`axe (${scheme}): /vendors with comparison and questions, /budget panels and fix card, /tasks dependencies, ideas refine`, async ({ page }) => {
      test.slow();
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: width < 768 ? 740 : 900 });
        await page.goto("/vendors");
        await page.getByTestId("compare-photographer").click();
        await page.getByTestId("questions-caterer").click();
        await expect(page.getByTestId("vendor-slot-caterer").getByTestId("questions-card")).toBeVisible();
        await page.getByTestId("vendor-stage-v6").selectOption("booked");
        await expect(page.getByTestId("vendor-approval")).toBeVisible();
        expect(await axe(page), `/vendors ${width} ${scheme}`).toEqual([]);
        let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `/vendors overflow ${width}`).toBeLessThanOrEqual(0);
        await page.goto("/budget");
        await lowerTotal(page, "2400000");
        await page.getByTestId("fix-by-priorities").click();
        await page.getByTestId("whatif-amount").fill("250000");
        await page.getByTestId("whatif-review").click();
        expect(await axe(page), `/budget ${width} ${scheme}`).toEqual([]);
        overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `/budget overflow ${width}`).toBeLessThanOrEqual(0);
        await page.goto("/tasks");
        await page.locator('[data-testid="deps-k5"] summary').click();
        expect(await axe(page), `/tasks ${width} ${scheme}`).toEqual([]);
        await page.goto("/ideas");
        await page.getByTestId("get-ideas").click();
        await expect(page.getByTestId("idea-list")).toBeVisible();
        expect(await axe(page), `/ideas ${width} ${scheme}`).toEqual([]);
      }
    });
  }
});
