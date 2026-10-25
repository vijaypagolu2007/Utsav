import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { skipWelcome, openPageNav } from "./helpers";

// v5: first-run welcome and setup (user-chosen budget), add/remove budget lines, total + rebalance, the Ideas page
// (offline Demo Mode bank), and the removed "haldi" template jump. The server runs with Gemini disabled.
const pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
});
test.afterEach(() => { expect(pageErrors, "uncaught client-side exceptions").toEqual([]); });

const h1 = (page: Page) => page.getByRole("heading", { level: 1 });
const rupees = (s: string) => Number(s.replace(/[^\d]/g, ""));
async function openPage(page: Page, name: string) {
  await openPageNav(page, name);
}
async function axe(page: Page) {
  // Start from the top so nothing is under the sticky header (axe counts a partly covered control as too small).
  await page.evaluate(() => window.scrollTo(0, 0));
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`);
}
async function fillBasics(page: Page) {
  await page.getByLabel("First partner's name (optional)").fill("Sita");
  await page.getByLabel("Second partner's name (optional)").fill("Ram");
  await page.getByLabel("City", { exact: true }).fill("Hyderabad");
  await page.getByLabel("First day").fill("2027-02-10");
  await page.getByLabel("Last day (for multi-day events)").fill("2027-02-12");
  await page.getByLabel("How many guests?").fill("250");
  await page.getByLabel("Total budget (₹)").fill("2000000");
  await page.getByLabel("Anything special? (optional)").fill("Telugu traditions, vegetarian lunch, marigold everywhere");
}

test("first run: the welcome offers both choices, and Explore a sample keeps the sample from then on", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("welcome")).toBeVisible();
  await expect(h1(page)).toHaveText("Plan your celebration, your way");
  await expect(page.getByTestId("welcome-plan")).toBeVisible();
  await expect(page.getByRole("button", { name: /Royal Wedding/ })).toBeVisible();
  await page.getByTestId("explore-sample-birthday").click();
  await expect(h1(page)).toHaveText(/Arcade|Rohan/);
  await page.reload();
  await expect(page.getByTestId("welcome")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Event" })).toHaveValue("birthday");
});

test("setup: custom amounts are kept exactly, booked is committed and locked, blanks fill the rest, total matches to the paisa", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("welcome-plan").click();
  await expect(page.getByTestId("setup-step-1")).toBeVisible();
  // Validation: nothing filled in → inline errors, focus on the first one.
  await page.getByRole("button", { name: "Next: priorities" }).click();
  await expect(page.getByText("Enter the city.")).toBeVisible();
  await expect(page.getByLabel("City", { exact: true })).toBeFocused();
  await fillBasics(page);
  await page.getByRole("button", { name: "Next: priorities" }).click();
  await page.getByRole("button", { name: "Next: budget" }).click();
  await expect(page.getByTestId("setup-step-2")).toBeVisible();
  await expect(h1(page)).toBeFocused();
  // Greyed hints show our suggestion; the user types their own.
  await expect(page.getByTestId("setup-cat-venue")).toContainText(/Suggested \d+(\.\d)?% · ₹/);
  await page.getByTestId("setup-amount-venue").fill("412345");
  await page.getByTestId("setup-amount-photo_video").fill("150000");
  await page.getByTestId("setup-booked-photo_video").check();
  await page.getByTestId("setup-amount-decor").fill("12.5%");
  await page.getByTestId("setup-include-logistics").uncheck();
  await expect(page.getByTestId("setup-allocated")).toHaveText("₹8,12,345");
  await expect(page.getByTestId("setup-remainder")).toHaveText("₹11,87,655");
  await expect(page.getByTestId("setup-cat-venue")).toContainText("Kept exactly: ₹4,12,345");
  await expect(page.getByTestId("setup-cat-photo_video")).toContainText("Booked: ₹1,50,000 committed and locked");
  // A booked line needs an amount.
  await page.getByTestId("setup-booked-catering").check();
  await page.getByRole("button", { name: "Create my plan" }).click();
  await expect(page.getByText("Fix the highlighted amounts first.")).toBeVisible();
  await page.getByTestId("setup-booked-catering").uncheck();
  await page.getByRole("button", { name: "Create my plan" }).click();
  await expect(h1(page)).toHaveText("Sita & Ram's Wedding");
  await expect(page.getByText(/Created Sita & Ram's Wedding \(Demo Mode\)/).filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("kpi-planned").locator("dd").first()).toHaveText("₹20,00,000");
  await openPage(page, "Budget");
  await expect(page.getByTestId("budget-total")).toHaveText("₹20,00,000");
  await expect(page.getByTestId("budget-planned")).toHaveText("₹20,00,000");
  await expect(page.getByTestId("budget-headroom")).toHaveText("₹0");
  await expect(page.getByRole("button", { name: "Edit Venue planned total" })).toBeVisible();
  await expect(page.locator("#budget").getByText("₹4,12,345 planned")).toBeVisible();
  await expect(page.locator("#budget").getByText("₹2,50,000 planned")).toBeVisible(); // 12.5% of ₹20L
  await page.locator("#budget").getByRole("button", { name: /^Photo & video \d+ item/ }).click();
  await expect(page.getByRole("button", { name: /^Locked Photo & video/ })).toBeVisible();
  await expect(page.getByRole("meter", { name: "Photo & video budget" })).toHaveAttribute("aria-valuetext", /₹1,50,000 committed of ₹1,50,000 planned.*locked/);
  await expect(page.locator("#budget").getByRole("button", { name: /^Logistics/ })).toHaveCount(0);
  // The plan survives a reload and the welcome never comes back.
  await page.reload();
  await expect(page.getByTestId("welcome")).toHaveCount(0);
  await expect(page.getByTestId("budget-planned")).toHaveText("₹20,00,000");
  // New plan is also reachable from More.
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "New plan" }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByTestId("setup-wizard")).toBeVisible();
});

test.describe("returning user", () => {
  test.beforeEach(async ({ page }) => { await skipWelcome(page); });

  test("budget: add a line, remove it with confirm, undo brings it back", async ({ page }) => {
    await page.goto("/budget");
    await page.getByTestId("add-budget-line").click();
    const form = page.getByTestId("add-line-form");
    await form.getByLabel("Category").selectOption("attire");
    await form.getByLabel("Line name").fill("Groom's sherwani");
    await form.getByLabel("Planned amount (₹)").fill("45000");
    await form.getByRole("button", { name: "Add line" }).click();
    await expect(page.locator("#budget span.text-ink", { hasText: /^Groom's sherwani$/ })).toBeVisible();
    await page.getByRole("button", { name: "Remove Groom's sherwani" }).click();
    await expect(page.getByRole("button", { name: "Keep it" })).toBeFocused();
    await page.getByRole("button", { name: "Remove line" }).click();
    await expect(page.locator("#budget span.text-ink", { hasText: /^Groom's sherwani$/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("#budget span.text-ink", { hasText: /^Groom's sherwani$/ })).toBeVisible();
    // Committed lines can't be removed: no Remove button on them.
    await expect(page.getByRole("button", { name: "Remove Mandap" })).toHaveCount(0);
  });

  test("budget: edit the total, then Rebalance to my total previews an approval card", async ({ page }) => {
    await page.goto("/budget");
    await page.getByRole("button", { name: "Edit total budget" }).click();
    await page.getByRole("textbox", { name: "total budget" }).fill("2700000");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("budget-total")).toHaveText("₹27,00,000");
    const head = rupees(await page.getByTestId("budget-headroom").innerText());
    expect(head).toBeGreaterThan(0);
    await page.getByTestId("rebalance").click();
    const card = page.getByTestId("approval-preview");
    await expect(card).toBeFocused();
    await expect(card).toContainText("Tier 1");
    await card.getByRole("button", { name: "Approve & Commit" }).click();
    await expect(page.getByTestId("budget-planned")).toHaveText("₹27,00,000");
    await expect(page.getByTestId("budget-headroom")).toHaveText("₹0");
    await expect(page.getByTestId("rebalance")).toBeDisabled();
  });

  test("ideas (offline demo): get ideas, save one, adopt one → approval → budget line appears → undo removes it", async ({ page }) => {
    await page.goto("/ideas");
    await expect(h1(page)).toHaveText("Ideas");
    await expect(page.getByText(/No ideas yet/)).toBeVisible();
    await page.getByRole("button", { name: "eco-friendly" }).click();
    await page.getByTestId("get-ideas").click();
    await expect(page.getByText(/new ideas? added · Demo Mode/)).toBeVisible();
    const cards = page.getByTestId("idea-list").locator("article");
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThan(2);
    await expect(cards.first()).toContainText("Demo");
    // Save
    const first = cards.first();
    const firstTitle = (await first.locator("h3").innerText()).trim();
    await first.getByRole("button", { name: `Save ${firstTitle}`, exact: true }).click();
    await expect(first.getByRole("button", { name: `Saved ${firstTitle}`, exact: true })).toBeDisabled();
    // Adopt one that has a cost
    const costed = cards.filter({ hasText: /₹[\d,]+ – ₹/ }).first();
    const title = (await costed.locator("h3").innerText()).trim();
    await costed.getByRole("button", { name: `Add to plan ${title}`, exact: true }).click();
    const preview = costed.getByTestId("approval-preview");
    await expect(preview).toContainText("Tier 1");
    await expect(preview).toContainText("(new line)");
    await expect(preview).toContainText("(new task)");
    await preview.getByRole("button", { name: "Approve & Commit" }).click();
    await expect(costed).toContainText("In your plan");
    await openPage(page, "Budget");
    const line = page.locator("#budget span.text-ink").filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
    await expect(line).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(line).toHaveCount(0);
    // Overview shows an Ideas summary tile.
    await openPage(page, "Overview");
    await expect(page.getByTestId("summary-ideas")).toContainText(/on the board/);
    // Guests never see organizer ideas.
    await openPage(page, "Ideas");
    await page.getByRole("button", { name: "Guest View" }).click();
    await expect(page.getByTestId("idea-list")).toHaveCount(0);
    await expect(page.getByRole("main").getByText(firstTitle)).toHaveCount(0);
  });

  test("ideas from chat: 'Give me sangeet ideas' adds cards and links to the Ideas page", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("copilot-launcher").click();
    await page.getByLabel("Chat message").fill("Give me sangeet ideas");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const card = page.getByTestId("ideas-card").last();
    await expect(card).toContainText(/ideas? · Demo/);
    await expect(card).toContainText("Committed");
    await card.getByRole("link", { name: "Open the Ideas page" }).click();
    await expect(h1(page)).toHaveText("Ideas");
    await expect(page.getByTestId("idea-list").locator("article").first()).toBeVisible();
  });

  test("regression: a 'haldi' message on a birthday plan never switches template or resets the plan", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Event" }).selectOption("birthday");
    // Make the plan the user's own first, so a reset would be visible.
    await page.getByRole("button", { name: "Edit event name" }).click();
    await page.getByRole("textbox", { name: "event name" }).fill("Rohan's Big Three-Oh");
    await page.keyboard.press("Enter");
    await expect(h1(page)).toHaveText("Rohan's Big Three-Oh");
    await page.getByTestId("copilot-launcher").click();
    await page.getByLabel("Chat message").fill("Move the Haldi to Friday");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("copilot-drawer").getByText(/Offline demo mode understands|No sub-event|couldn't/).last()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("combobox", { name: "Event" })).toHaveValue("birthday");
    await expect(h1(page)).toHaveText("Rohan's Big Three-Oh");
    await expect(page.getByText(/Switched to the/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`axe (${scheme}): setup steps, /ideas with cards and the adopt approval card, /budget add form and rebalance preview`, async ({ page }) => {
      test.slow();
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: width < 768 ? 740 : 900 });
        await page.goto("/setup");
        await expect(page.getByTestId("setup-step-1")).toBeVisible();
        expect(await axe(page), `/setup step 1 ${width} ${scheme}`).toEqual([]);
        await fillBasics(page);
        await page.getByRole("button", { name: "Next: priorities" }).click();
        await page.getByTestId("setup-prio-catering-protect").check({ force: true });
        expect(await axe(page), `/setup priorities ${width} ${scheme}`).toEqual([]);
        await page.getByRole("button", { name: "Next: budget" }).click();
        await page.getByTestId("setup-amount-venue").fill("400000");
        await page.getByTestId("setup-include-logistics").uncheck();
        expect(await axe(page), `/setup step 2 ${width} ${scheme}`).toEqual([]);
        await page.goto("/ideas");
        await page.getByTestId("get-ideas").click();
        const costed = page.getByTestId("idea-list").locator("article").filter({ hasText: /₹[\d,]+ – ₹/ }).first();
        await costed.getByRole("button", { name: /^Add to plan/ }).click();
        await expect(costed.getByTestId("approval-preview")).toBeVisible();
        expect(await axe(page), `/ideas ${width} ${scheme}`).toEqual([]);
        await page.goto("/budget");
        await page.getByTestId("add-budget-line").click();
        await page.getByRole("button", { name: "Edit total budget" }).click();
        await page.getByRole("textbox", { name: "total budget" }).fill("2700000");
        await page.keyboard.press("Enter");
        await page.getByTestId("rebalance").click();
        await expect(page.getByTestId("approval-preview")).toBeVisible();
        expect(await axe(page), `/budget ${width} ${scheme}`).toEqual([]);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `/budget overflow ${width}`).toBeLessThanOrEqual(0);
      }
    });
  }
});

test(`axe: the welcome screen, light and dark`, async ({ page }) => {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await expect(page.getByTestId("welcome")).toBeVisible();
    expect(await axe(page), `welcome ${scheme}`).toEqual([]);
  }
});
