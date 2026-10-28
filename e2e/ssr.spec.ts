import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { ownClientIp, skipWelcome } from "./helpers";

// v8 Part 2c: the (planner) routes are server-rendered. The server sends a real app shell (header frame, page
// navigation, the page's h1, an aria-busy skeleton) instead of a blank loading pulse; PlannerApp mounts after
// hydration with the plan from localStorage.

const SAMPLE_TITLES = ["Arjun & Meera", "Retro Arcade Night", "Kondapur Community Cultural Fest"];
const STORE_KEY = "genai_event_planner_v1";

const pageErrors: string[] = [];
test.beforeEach(async ({ page }, info) => {
  await ownClientIp(page, info);
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
  await skipWelcome(page);
});
test.afterEach(() => { expect(pageErrors, "uncaught client-side exceptions").toEqual([]); });

for (const [path, heading] of [["/", "Overview"], ["/budget", "Budget"], ["/guests", "Guests"], ["/setup", "New plan"]] as const) {
  test(`the server sends the app shell for ${path}: nav landmark, the page h1, an aria-busy skeleton, no loading pulse`, async ({ request }) => {
    const res = await request.get(path);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="app-shell"');
    expect(html).toMatch(/<nav aria-label="Pages"/);
    expect(html).toMatch(new RegExp(`<h1[^>]*data-testid="shell-heading"[^>]*>${heading}</h1>`));
    expect(html).toMatch(/<main[^>]*aria-busy="true"/);
    expect(html).toContain("Skip to main content");
    expect(html).not.toContain("Loading event planner");
    expect(html).not.toContain("Loading your event canvas");
    // Nothing from a plan is rendered on the server (the sample plans included).
    for (const t of SAMPLE_TITLES) expect(html).not.toContain(t);
  });
}

/** Console errors React logs for a hydration mismatch (dev wording and the production error codes 418/423/425). */
const HYDRATION = /hydrat|did not match|server rendered|Minified React error #(418|423|425)/i;

test("no hydration error on /, /budget and /guests (cold load of each route)", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", m => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text()); });
  page.on("pageerror", e => errors.push(e.message));
  for (const [path, heading] of [["/", null], ["/budget", "Budget"], ["/guests", "Guests"]] as const) {
    await page.goto(path);
    await expect(page.getByTestId("dashboard")).toBeVisible();
    await expect(page.getByTestId("app-shell")).toHaveCount(0);
    if (heading) await expect(page.getByTestId("page-heading")).toHaveText(heading);
    await expect(page.getByRole("navigation", { name: "Pages" })).toBeVisible();
  }
  expect(errors.filter(e => HYDRATION.test(e)), "hydration errors").toEqual([]);
});

test("a stored plan of the organizer's own never flashes a sample's content while the page hydrates", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible();
  // An edit gets the plan saved (an untouched sample is never written to storage).
  await page.getByRole("button", { name: "Edit event name", exact: true }).click();
  await page.getByRole("textbox", { name: "event name", exact: true }).fill("Our own celebration");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key)?.includes("Our own celebration") ?? false, STORE_KEY)).toBe(true);
  // Make the active slot hold the organizer's own event (a different event id, as the setup form makes).
  await page.evaluate(key => {
    const s = JSON.parse(localStorage.getItem(key)!);
    const h = s.byType[s.active];
    const p = h.snaps[h.idx].plan;
    p.event.id = "ev-own-ssr"; p.event.title = "Our own celebration";
    localStorage.setItem(key, JSON.stringify(s));
  }, STORE_KEY);
  // Record every heading and header text the page ever shows, from the first parsed byte.
  await page.addInitScript(() => {
    const w = window as unknown as { __seen?: string[] };
    w.__seen = [];
    const snap = () => { document.querySelectorAll("h1, header").forEach(el => w.__seen!.push(el.textContent ?? "")); };
    // Observe the document itself: the init script runs before <html> exists.
    new MutationObserver(snap).observe(document, { subtree: true, childList: true, characterData: true });
  });
  for (const path of ["/", "/budget"]) {
    await page.goto(path);
    await expect(page.getByTestId("dashboard")).toBeVisible();
    await expect(page.getByRole("banner")).toContainText("Our own celebration");
    const seen = await page.evaluate(() => (window as unknown as { __seen?: string[] }).__seen ?? []);
    // The observer saw the server-rendered shell (its h1 names the page) before the plan arrived.
    expect(seen).toContain(path === "/" ? "Overview" : "Budget");
    for (const t of SAMPLE_TITLES) expect(seen.filter(s => s.includes(t)), `${path}: ${t}`).toEqual([]);
  }
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Budget");
});

/** Keep the page on the server-rendered shell: the theme script (inline) still runs, the app's JavaScript never loads. */
async function shellOnly(page: Page) {
  await page.route("**/_next/static/**", r => (r.request().resourceType() === "script" ? r.abort() : r.continue()));
}

for (const scheme of ["light", "dark"] as const) {
  test(`the server-rendered shell is axe-clean and themed before any app script (${scheme}, 1280 and 375 px)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await shellOnly(page);
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ["/", "/budget"]) {
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        await expect(page.getByTestId("app-shell-main")).toHaveAttribute("aria-busy", "true");
        await expect(page.getByRole("navigation", { name: "Pages" })).toBeVisible();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(path === "/" ? "Overview" : "Budget");
        const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
        expect(r.violations.map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`), `${scheme} ${width} ${path}`).toEqual([]);
      }
    }
  });
}

test("the skip link is the first stop on the server-rendered shell and targets the main landmark", async ({ page }) => {
  await shellOnly(page);
  await page.goto("/budget");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toHaveAttribute("href", "#main");
  await expect(page.locator("main#main")).toHaveCount(1);
});
