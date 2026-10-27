import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openPageNav, skipWelcome, switchEvent, ownClientIp } from "./helpers";

// v8 Part 1e: the editable party activity run-sheet on the birthday sample's Event page. Add, edit (name, minutes,
// ages, supply chips), reorder, the party start time and the computed row times (midnight wrap included), delete with
// the 10 s Undo toast, a Co-Pilot (Demo Mode) approval card, adopting an activity idea, Guest View staying read-only,
// and axe in light and dark at 375 and 1280. Demo Mode build with the file store, like every other spec.

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
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/** Every visible control inside the run-sheet is at least 44 x 44 px. */
async function smallRunSheetTargets(page: Page) {
  return page.getByTestId("activity-run-sheet").evaluate(root => {
    const out: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("button, input, select"))) {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      if (r.height < 43.5 || (el.tagName === "BUTTON" && r.width < 43.5)) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
}
async function openBirthdayEvent(page: Page) {
  await page.goto("/");
  await switchEvent(page, "birthday");
  await page.goto("/event");
  await expect(page.getByTestId("activity-run-sheet")).toBeVisible();
}
/** Click an InlineEdit pencil inside `row`, type the value and press Enter. */
async function inlineEdit(page: Page, row: ReturnType<Page["getByTestId"]>, testId: string, label: string, value: string) {
  await row.getByTestId(testId).click();
  const input = page.getByLabel(label, { exact: true });
  await input.fill(value);
  await input.press("Enter");
  await expect(input).toHaveCount(0);
}

test("run-sheet: add, edit, reorder, start time and computed times, delete with Undo", async ({ page }) => {
  await openBirthdayEvent(page);
  const rows = page.getByTestId("activity-row");
  await expect(rows).toHaveCount(4);
  await expect(page.getByTestId("activity-total")).toContainText("135 min");
  await expect(page.getByTestId("activity-time")).toHaveCount(0); // no start time: durations only

  // Add
  await page.getByTestId("activity-add").click();
  await page.getByTestId("activity-add-name").fill("Treasure hunt");
  await page.getByTestId("activity-add-minutes").fill("20");
  await page.getByTestId("activity-add-supplies").fill("Clues, Map");
  await page.getByTestId("activity-add-submit").click();
  await expect(rows).toHaveCount(5);
  const hunt = rows.filter({ hasText: "Treasure hunt" });
  await expect(hunt).toContainText("20 min");
  await expect(hunt.getByTestId("activity-supply")).toHaveText(["Clues", "Map"]);
  await expect(page.getByTestId("activity-total")).toContainText("155 min");

  // Edit: minutes, ages, name, supplies (remove one chip, add one)
  await inlineEdit(page, hunt, "activity-edit-minutes", "minutes for Treasure hunt", "25");
  await expect(hunt.getByTestId("activity-minutes")).toHaveText("25 min");
  await inlineEdit(page, hunt, "activity-edit-ages", "ages for Treasure hunt", "8+");
  await expect(hunt.getByTestId("activity-ages")).toHaveText("ages 8+");
  await inlineEdit(page, hunt, "activity-edit-name", "activity name Treasure hunt", "Treasure hunt with clues");
  const clues = rows.filter({ hasText: "Treasure hunt with clues" });
  await expect(clues).toHaveCount(1);
  await clues.getByRole("button", { name: "Remove supply Map from Treasure hunt with clues" }).click();
  await expect(clues.getByTestId("activity-supply")).toHaveText(["Clues"]);
  await clues.getByLabel("Add a supply to Treasure hunt with clues").fill("Prizes");
  await clues.getByTestId("activity-edit-supply-add").click();
  await expect(clues.getByTestId("activity-supply")).toHaveText(["Clues", "Prizes"]);
  // A bad value keeps the editor open with the reason
  await clues.getByTestId("activity-edit-minutes").click();
  await page.getByLabel("minutes for Treasure hunt with clues", { exact: true }).fill("2");
  await page.getByLabel("minutes for Treasure hunt with clues", { exact: true }).press("Enter");
  await expect(clues.getByRole("alert")).toContainText("5 to 480");
  await page.getByRole("button", { name: "Cancel editing minutes for Treasure hunt with clues" }).click();

  // Reorder: up and down, edges disabled
  await expect(rows.first().getByTestId("activity-up")).toBeDisabled();
  await expect(rows.last().getByTestId("activity-down")).toBeDisabled();
  await clues.getByRole("button", { name: "Move Treasure hunt with clues up" }).click();
  await expect(rows.nth(3)).toContainText("Treasure hunt with clues");
  await expect(rows.nth(4)).toContainText("Cake cutting");
  await rows.nth(3).getByTestId("activity-down").click();
  await expect(rows.nth(4)).toContainText("Treasure hunt with clues");
  await rows.nth(4).getByTestId("activity-up").click();
  await expect(rows.nth(3)).toContainText("Treasure hunt with clues");

  // Start time: every row gets "start to end", computed in code
  await page.getByTestId("party-start").fill("19:00");
  await page.getByTestId("party-start").press("Enter");
  await expect(page.getByTestId("activity-time")).toHaveText([
    "7:00 PM to 7:45 PM", "7:45 PM to 8:15 PM", "8:15 PM to 8:55 PM", "8:55 PM to 9:20 PM", "9:20 PM to 9:40 PM"]);
  await expect(page.getByTestId("activity-total")).toContainText("160 min");
  await expect(page.getByTestId("activity-total")).toContainText("ends 9:40 PM");
  // Past midnight wraps to the next day's clock
  await page.getByTestId("party-start").fill("23:00");
  await page.getByTestId("party-start").press("Enter");
  await expect(page.getByTestId("activity-time").nth(1)).toHaveText("11:45 PM to 12:15 AM");
  await expect(page.getByTestId("activity-total")).toContainText("ends 1:40 AM");

  // Delete with the 10 s Undo toast
  await clues.getByTestId("activity-remove").click();
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: "Treasure hunt with clues" })).toHaveCount(0);
  await page.getByTestId("toast-undo").click();
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(3)).toContainText("Treasure hunt with clues");

  // Clearing the start time goes back to durations only
  await page.getByTestId("party-start-clear").click();
  await expect(page.getByTestId("activity-time")).toHaveCount(0);

  // Guest View: read-only, no editing controls
  await page.getByRole("button", { name: "Guest View" }).click();
  await expect(page.getByTestId("activity-add")).toHaveCount(0);
  await expect(page.getByTestId("party-start")).toHaveCount(0);
  await expect(page.getByTestId("activity-remove")).toHaveCount(0);
});

test("Co-Pilot (Demo Mode): 'add a 15 minute balloon pop after cake' is an approval card that adds the row after cake", async ({ page }) => {
  await openBirthdayEvent(page);
  await page.getByTestId("copilot-launcher").click();
  await page.getByLabel("Chat message").fill("add a 15 minute balloon pop after cake");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const card = page.getByTestId("diff-card").last();
  await expect(card).toContainText("Balloon pop (new activity)");
  await expect(card).toContainText("row 5");
  await card.getByRole("button", { name: "Approve & Commit" }).click();
  await page.keyboard.press("Escape");
  const rows = page.getByTestId("activity-row");
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(3)).toContainText("Cake cutting");
  await expect(rows.nth(4)).toContainText("Balloon pop");
  await expect(rows.nth(4)).toContainText("15 min");
});

test("adopting an activity idea adds the task and a run-sheet row in one step", async ({ page }) => {
  await page.goto("/");
  await switchEvent(page, "birthday");
  await page.goto("/ideas");
  await page.getByTestId("get-ideas").click();
  const cards = page.getByTestId("idea-list").locator("article");
  await expect(cards.first()).toBeVisible();
  const activity = cards.filter({ has: page.getByText("Activity", { exact: true }) }).first();
  await expect(activity).toBeVisible();
  const title = (await activity.locator("h3").innerText()).trim();
  await activity.getByRole("button", { name: `Add to plan ${title}`, exact: true }).click();
  const preview = activity.getByTestId("approval-preview");
  await expect(preview).toContainText("(new task)");
  await expect(preview).toContainText(`${title} (new activity)`);
  await preview.getByRole("button", { name: "Approve & Commit" }).click();
  await expect(activity).toContainText("In your plan");
  await openPageNav(page, "Event");
  const row = page.getByTestId("activity-row").filter({ hasText: title });
  await expect(row).toHaveCount(1);
  await expect(page.getByTestId("activity-row")).toHaveCount(5);
  // One Undo takes back the task and the row together.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId("activity-row")).toHaveCount(4);
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe (${scheme}) at 1280 and 375: the run-sheet with times, the add form and an inline editor`, async ({ page }) => {
    test.slow();
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await openBirthdayEvent(page);
    await page.getByTestId("party-start").fill("19:00");
    await page.getByTestId("party-start").press("Enter");
    await expect(page.getByTestId("activity-time").first()).toHaveText("7:00 PM to 7:45 PM");
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: width < 768 ? 740 : 900 });
      await page.goto("/event");
      await expect(page.getByTestId("activity-time").first()).toBeVisible();
      expect(await axe(page), `run-sheet ${width}`).toEqual([]);
      expect(await overflowX(page), `no horizontal scroll at ${width}`).toBeLessThanOrEqual(0);
      expect(await smallRunSheetTargets(page), `44px targets at ${width}`).toEqual([]);
      await page.getByTestId("activity-add").click();
      await expect(page.getByTestId("activity-add-form")).toBeVisible();
      await page.getByTestId("activity-add-submit").click(); // empty name: the error is announced
      await expect(page.getByTestId("activity-add-form").getByRole("alert")).toBeVisible();
      expect(await axe(page), `add form ${width}`).toEqual([]);
      expect(await overflowX(page), `add form fits at ${width}`).toBeLessThanOrEqual(0);
      await page.getByTestId("activity-add-cancel").click();
      await page.getByTestId("activity-row").first().getByTestId("activity-edit-ages").click();
      expect(await axe(page), `inline editor ${width}`).toEqual([]);
      expect(await smallRunSheetTargets(page), `44px targets with the editor open at ${width}`).toEqual([]);
    }
  });
}

test("an empty run-sheet shows an Add button", async ({ page }) => {
  await openBirthdayEvent(page);
  for (let n = 4; n > 0; n--) {
    await page.getByTestId("activity-row").first().getByTestId("activity-remove").click();
    await expect(page.getByTestId("activity-row")).toHaveCount(n - 1);
  }
  const empty = page.getByTestId("activity-empty");
  await expect(empty).toContainText("No activities yet");
  await empty.getByTestId("activity-add").click();
  await page.getByTestId("activity-add-name").fill("Cake cutting");
  await page.getByTestId("activity-add-submit").click();
  await expect(page.getByTestId("activity-row")).toHaveCount(1);
  await expect(page.getByTestId("activity-empty")).toHaveCount(0);
});
