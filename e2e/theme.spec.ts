import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { skipWelcome } from "./helpers";

// Dark mode: Light / Dark / System (default), persisted in localStorage["utsav_theme_v1"] apart from the plan,
// applied before first paint, axe-clean in dark for the organizer, the Guest View and the public guest page; print stays light.

const pageErrors: string[] = [];
test.beforeEach(async ({ page }, info) => {
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
  await skipWelcome(page);
  // Own rate-limit bucket per test for publishing (see header-and-editing.spec.ts).
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `e2e-${info.testId}` });
});
test.afterEach(() => { expect(pageErrors, "uncaught client-side exceptions").toEqual([]); });

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => `${n.target.join(" ")} ${n.failureSummary?.split("\n")[1] ?? ""}`).join(" | ")}`);
}
const theme = (page: Page) => page.locator("html").getAttribute("data-theme");
const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
async function setTheme(page: Page, v: "light" | "dark" | "system") {
  const more = page.getByRole("button", { name: "More", exact: true });
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
  await page.getByLabel("Theme").selectOption(v);
  await page.keyboard.press("Escape");
}

test("System is the default and follows prefers-color-scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await theme(page)).toBe("dark");
  expect(await page.evaluate(() => localStorage.getItem("utsav_theme_v1"))).toBeNull();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByLabel("Theme")).toHaveValue("system");
});

test("the choice persists under utsav_theme_v1, separately from the plan, and is applied before first paint", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const planBefore = await page.evaluate(() => localStorage.getItem("genai_event_planner_v1"));
  await setTheme(page, "dark");
  expect(await page.evaluate(() => localStorage.getItem("utsav_theme_v1"))).toBe("dark");
  expect(await page.evaluate(() => localStorage.getItem("genai_event_planner_v1"))).toBe(planBefore); // plan storage untouched
  expect(planBefore ?? "").not.toContain("theme");
  // Before any app script runs, the inline head script has already set the theme (no light flash).
  await page.addInitScript(() => {
    document.addEventListener("readystatechange", () => {
      if (document.readyState === "interactive") (window as unknown as { __themeAtParse: string | null }).__themeAtParse = document.documentElement.getAttribute("data-theme");
    }, { once: true });
  });
  await page.reload();
  expect(await page.evaluate(() => (window as unknown as { __themeAtParse: string | null }).__themeAtParse)).toBe("dark");
  await setTheme(page, "light");
  await page.reload();
  expect(await theme(page)).toBe("light");
  // Junk in storage falls back to System.
  await page.evaluate(() => localStorage.setItem("utsav_theme_v1", "purple"));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  expect(await theme(page)).toBe("dark");
});

test("dark mode: organizer dashboard, More menu, share dialog and Co-Pilot drawer are axe-clean", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await theme(page)).toBe("dark");
  const canvas = await bg(page);
  for (const t of ["birthday", "community", "wedding"]) {
    await page.getByRole("combobox", { name: "Event" }).selectOption(t);
    expect(await axe(page), `organizer ${t} (dark)`).toEqual([]);
  }
  await page.getByRole("button", { name: "More", exact: true }).click();
  expect(await axe(page), "More menu (dark)").toEqual([]);
  await page.keyboard.press("Escape");
  // The inline editors are on the Budget page.
  await page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Budget", exact: true }).click();
  await page.getByRole("button", { name: "Edit planned amount for Haldi marigold decor", exact: true }).click();
  await page.getByRole("textbox", { name: "planned amount for Haldi marigold decor" }).fill("x");
  await page.keyboard.press("Enter");
  expect(await axe(page), "inline editor with an error (dark)").toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByTestId("open-guest-links").click();
  await page.getByTestId("publish-guest-links").click();
  await expect(page.getByTestId("public-guest-link")).toBeVisible();
  expect(await axe(page), "share dialog (dark)").toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open AI Co-Pilot" }).click();
  await page.getByRole("button", { name: "Cut ₹1.5L from decor" }).click();
  await expect(page.getByTestId("rejection-card").last()).toBeVisible();
  expect(await axe(page), "Co-Pilot drawer (dark)").toEqual([]);
  // It really is dark (not a light page with a dark attribute): the canvas colour differs from the light theme's.
  await page.keyboard.press("Escape");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await bg(page)).not.toBe(canvas);
});

test("dark mode at 375px: organizer and Guest View are axe-clean", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await axe(page), "organizer 375 (dark)").toEqual([]);
  await page.getByRole("button", { name: "Guest View" }).click();
  expect(await axe(page), "guest view 375 (dark)").toEqual([]);
});

test("dark mode: Guest View and the public guest page are axe-clean", async ({ page, browser }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Guest View" }).click();
  expect(await axe(page), "guest view (dark)").toEqual([]);
  await page.getByRole("button", { name: "Open Guest Concierge" }).click();
  expect(await axe(page), "guest concierge drawer (dark)").toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Organizer" }).click();
  for (const [t, kind] of [["wedding", "invite"], ["community", "public"], ["birthday", "invite"]] as const) {
    await page.getByRole("combobox", { name: "Event" }).selectOption(t);
    await page.getByTestId("open-guest-links").click();
    if (await page.getByTestId("publish-guest-links").count()) await page.getByTestId("publish-guest-links").click();
    const field = kind === "public" ? page.getByTestId("public-guest-link") : page.locator('input[data-testid^="invite-"]').first();
    const url = await field.inputValue();
    await page.keyboard.press("Escape");
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const g = await ctx.newPage();
    await g.goto(url);
    await expect(g.getByTestId("public-guest-page")).toBeVisible();
    expect(await theme(g)).toBe("dark");
    expect(await axe(g), `public guest page ${t} (dark)`).toEqual([]);
    await g.getByLabel("Theme").selectOption("light");
    expect(await theme(g)).toBe("light");
    expect(await axe(g), `public guest page ${t} (light, toggled)`).toEqual([]);
    await ctx.close();
  }
});

test("print stays light in dark mode", async ({ page }) => {
  // Reference: the light theme on screen.
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const colours = () => page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector("h1")!).color]);
  const light = await colours();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const dark = await colours();
  expect(dark).not.toEqual(light);
  await page.emulateMedia({ media: "print", colorScheme: "dark" });
  expect(await colours()).toEqual(light);
});
