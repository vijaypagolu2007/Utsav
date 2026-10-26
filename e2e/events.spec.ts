import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { skipWelcome, switchEvent } from "./helpers";

// v8 Part 0b: the header's event title is the event menu ("My events" and "Samples", "New event"), replacing the
// template <select>; the red-flag count is an outlined badge.

const pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
  await skipWelcome(page);
});
test.afterEach(() => { expect(pageErrors, "uncaught client-side exceptions").toEqual([]); });

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => `${n.target.join(" ")} ${n.failureSummary?.split("\n")[1] ?? ""}`).join(" | ")}`);
}
const switcher = (page: Page) => page.getByTestId("event-switcher");
const h1 = (page: Page) => page.getByRole("heading", { level: 1 });

test("mouse: the title opens the event menu; choosing a sample switches the plan and closes it", async ({ page }) => {
  await page.goto("/");
  const btn = switcher(page);
  await expect(btn).toHaveAccessibleName("Event: Arjun & Meera — Royal Telugu Wedding");
  await expect(btn).toHaveAttribute("aria-haspopup", "menu");
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  // The title is not a heading: the page owns its h1.
  await expect(page.getByRole("banner").getByRole("heading")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Event" })).toHaveCount(0);
  await btn.click();
  const menu = page.getByRole("menu", { name: /Event: / });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("group", { name: "My events" })).toHaveCount(0);
  const samples = menu.getByRole("group", { name: "Samples" }).getByRole("menuitemradio");
  await expect(samples).toHaveCount(3);
  await expect(samples.first()).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitem", { name: "New event" })).toBeVisible();
  // Signed out: loading the samples is just choosing one, so there is no separate entry.
  await expect(page.getByTestId("event-load-samples")).toHaveCount(0);
  await page.getByTestId("event-option-birthday").click();
  await expect(menu).toHaveCount(0);
  await expect(btn).toHaveAttribute("data-active", "birthday");
  await expect(btn).toHaveAccessibleName("Event: Rohan's 30th — Retro Arcade Night");
  await expect(h1(page)).toContainText("Rohan");
  // A click outside closes it.
  await btn.click();
  await expect(menu).toBeVisible();
  await page.mouse.click(5, 900);
  await expect(menu).toHaveCount(0);
});

test("keyboard: Enter opens on the current event, arrows wrap, Home/End, Escape returns focus, Enter switches", async ({ page }) => {
  await page.goto("/");
  const btn = switcher(page);
  await btn.focus();
  await page.keyboard.press("Enter");
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("event-option-wedding")).toBeFocused();
  // v8 Part 0d: every sample row has its own Delete right after it, so the arrows visit it on the way.
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("event-delete-wedding")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("event-option-birthday")).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByTestId("event-new")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("event-option-wedding")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("event-new")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.getByTestId("event-option-wedding")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  await expect(btn).toBeFocused();
  // ArrowDown on the button opens the menu on the current event (focus moves in on the next frame).
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("event-option-wedding")).toBeFocused();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("event-option-community")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(btn).toHaveAttribute("data-active", "community");
  await expect(btn).toBeFocused();
  await expect(h1(page)).toContainText("Kondapur");
  // Space opens too, on the new current event; Tab leaves and closes the menu.
  await page.keyboard.press(" ");
  await expect(page.getByTestId("event-option-community")).toBeFocused();
  await expect(page.getByTestId("event-option-community")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("event-menu")).toHaveCount(0);
});

test("a renamed sample keeps its '(now: …)' hint; an own event is listed under My events; New event opens the blank setup", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Edit event name", exact: true }).click();
  await page.getByRole("textbox", { name: "event name", exact: true }).fill("Our wedding draft");
  await page.keyboard.press("Enter");
  await expect(h1(page)).toContainText("Our wedding draft");
  await switcher(page).click();
  await expect(page.getByTestId("event-option-wedding")).toContainText("Royal Wedding (now: Our wedding draft)");
  await expect(page.getByTestId("event-option-wedding")).toContainText("Wedding · ₹25L · edited");
  await page.keyboard.press("Escape");
  // Make the birthday slot hold an event of the organizer's own (a different event id, as the setup form makes).
  await switchEvent(page, "birthday");
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("genai_event_planner_v1")!);
    const h = s.byType.birthday;
    const p = h.snaps[h.idx].plan;
    p.event.id = "ev-kabir-30"; p.event.title = "Kabir's 30th"; p.event.totalBudgetPaise = 200000_00;
    localStorage.setItem("genai_event_planner_v1", JSON.stringify(s));
  });
  await page.reload();
  await switcher(page).click();
  const mine = page.getByRole("group", { name: "My events" }).getByRole("menuitemradio");
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText("Kabir's 30th");
  await expect(mine).toContainText("Birthday · ₹2L");
  await expect(mine).toHaveAttribute("aria-checked", "true");
  const samples = page.getByRole("group", { name: "Samples" });
  await expect(samples.getByRole("menuitemradio")).toHaveCount(2);
  await expect(samples).toContainText("30th Arcade Birthday: hidden while your own birthday uses its place.");
  expect(await axe(page), "menu with both sections").toEqual([]);
  await page.getByTestId("event-new").click();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByText(/New plan · Step 1 of 3/)).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`event menu and red-flag badge: axe-clean, inside the viewport, 44px rows (${scheme}, 1280 and 375 px)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      const flags = page.getByTestId("red-flags");
      await expect(flags).toBeVisible();
      // Outlined, not a filled red block: the badge keeps the header's surface colour.
      const look = await flags.evaluate(el => { const s = getComputedStyle(el); const hdr = getComputedStyle(el.closest("header")!); return { bg: s.backgroundColor, border: s.borderTopWidth, hdr: hdr.backgroundColor }; });
      expect(look.border).toBe("2px");
      expect(look.bg).not.toMatch(/rgb\(25[0-5], 2[0-4]\d, 2[0-4]\d\)/);
      await switcher(page).click();
      const menu = page.getByTestId("event-menu");
      await expect(menu).toBeVisible();
      expect(await axe(page), `menu ${width}`).toEqual([]);
      const box = await menu.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= width + 1, `menu inside the viewport at ${width}`).toBeTruthy();
      for (const item of await page.getByRole("menuitemradio").all()) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const small = await menu.evaluate(el => [...el.querySelectorAll<HTMLElement>("*")].filter(n => n.childNodes.length && [...n.childNodes].some(c => c.nodeType === 3 && c.textContent!.trim()) && parseFloat(getComputedStyle(n).fontSize) < 12).length);
      expect(small, "no text under 12px").toBe(0);
      await page.keyboard.press("Escape");
      await expect(switcher(page)).toBeFocused();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `no horizontal scroll at ${width}`).toBeLessThanOrEqual(0);
    }
  });
}
