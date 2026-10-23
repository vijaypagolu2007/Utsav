import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { skipWelcome, openPageNav } from "./helpers";

// Round 3: the organizer dashboard as separate pages (/, /budget, /tasks, /schedule, /event) sharing one client-side
// plan state in the (planner) layout. Same Demo Mode build and file store as the other specs.

const pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
  await skipWelcome(page);
});
test.afterEach(() => { expect(pageErrors, "uncaught client-side exceptions").toEqual([]); });

const ROUTES = [
  { path: "/", name: "Overview", title: "Overview · Utsav Co-Pilot", section: "overview" },
  { path: "/budget", name: "Budget", title: "Budget · Utsav Co-Pilot", section: "budget" },
  { path: "/vendors", name: "Vendors", title: "Vendors · Utsav Co-Pilot", section: "vendors" },
  { path: "/tasks", name: "Tasks", title: "Tasks · Utsav Co-Pilot", section: "tasks" },
  { path: "/schedule", name: "Schedule", title: "Schedule · Utsav Co-Pilot", section: "schedule" },
  { path: "/event", name: "Event", title: "Event · Utsav Co-Pilot", section: "event" },
  { path: "/ideas", name: "Ideas", title: "Ideas · Utsav Co-Pilot", section: "ideas" },
] as const;
type RouteName = (typeof ROUTES)[number]["name"];
const WEDDING_TITLE = "Arjun & Meera — Royal Telugu Wedding"; // seed title of the default (wedding) template

const rupees = (s: string) => Number(s.replace(/[^\d]/g, ""));
const kpi = (page: Page, name: string) => page.getByTestId(`kpi-${name}`).locator("dd").first();
const nav = (page: Page) => page.getByRole("navigation", { name: "Pages" });
const h1 = (page: Page) => page.getByRole("heading", { level: 1 });
async function openPage(page: Page, name: RouteName) {
  await openPageNav(page, name);
}
/** A marker on window: still there after a navigation means it was client-side (no reload, state kept in memory). */
const mark = (page: Page) => page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
const stillMarked = (page: Page) => page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload === true);
async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => `${n.target.join(" ")} ${n.failureSummary?.split("\n")[1] ?? ""}`).join(" | ")}`);
}
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

// ---------- every route on a fresh load ----------
for (const r of ROUTES) {
  test(`${r.path} renders its own h1 and <title>, one main, the header, and marks itself in the nav`, async ({ page }) => {
    await page.goto(r.path);
    await expect(h1(page)).toHaveCount(1);
    await expect(h1(page)).toHaveText(r.name === "Overview" ? WEDDING_TITLE : r.name);
    await expect(page).toHaveTitle(r.title);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("banner")).toHaveCount(1);
    await expect(page.getByTestId("copilot-launcher")).toHaveCount(1);
    await expect(page.locator(`section#${r.section}`)).toHaveCount(1);
    // Only this page's card is rendered.
    for (const o of ROUTES) if (o.section !== r.section) await expect(page.locator(`section#${o.section}`)).toHaveCount(0);
    await expect(nav(page).getByRole("link", { name: r.name, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav(page).locator("[aria-current]")).toHaveCount(1);
  });
}

test("the page links are real routes in nav order, and /guests leads to the Event page", async ({ page }) => {
  await page.goto("/");
  const links = nav(page).getByRole("link");
  await expect(links).toHaveText(ROUTES.map(r => r.name));
  for (const [i, r] of ROUTES.entries()) await expect(links.nth(i)).toHaveAttribute("href", r.path);
  await page.goto("/guests");
  await expect(page).toHaveURL(/\/event$/);
  await expect(h1(page)).toHaveText("Event");
});

test("client navigation: aria-current moves, the <title> changes and focus lands on the new page's h1", async ({ page }) => {
  await page.goto("/");
  await expect(h1(page)).toBeVisible();
  await mark(page);
  for (const r of [...ROUTES.slice(1), ROUTES[0]]) {
    await openPage(page, r.name);
    await expect(page).toHaveURL(new RegExp(`${r.path === "/" ? "/" : r.path}$`));
    await expect(page).toHaveTitle(r.title);
    await expect(h1(page)).toBeFocused();
    for (const o of ROUTES) if (o.name !== r.name) await expect(nav(page).getByRole("link", { name: o.name, exact: true })).not.toHaveAttribute("aria-current", /.*/);
  }
  expect(await stillMarked(page), "navigation reloaded the page").toBe(true);
});

test("skip link still goes to the page content on every page", async ({ page }) => {
  for (const r of ROUTES) {
    await page.goto(r.path);
    await expect(h1(page)).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("dashboard")).toBeFocused();
  }
});

// ---------- one shared plan state ----------
test("state persists across navigation: an edit on /budget shows in the KPI on /, without a reload", async ({ page }) => {
  await page.goto("/");
  const before = rupees(await kpi(page, "planned").innerText());
  await mark(page);
  await openPage(page, "Budget");
  await page.getByRole("button", { name: "Edit planned amount for Haldi marigold decor", exact: true }).click();
  await page.getByRole("textbox", { name: "planned amount for Haldi marigold decor" }).fill("95000");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("envelope-b1")).toHaveAttribute("aria-valuetext", /of ₹95,000 planned/);
  await openPage(page, "Overview");
  await expect.poll(async () => rupees(await kpi(page, "planned").innerText())).toBe(before + 15_000);
  await expect(page.getByTestId("summary-budget")).toContainText(/planned/);
  expect(await stillMarked(page)).toBe(true);
  // And it was saved: a fresh load of another page still has it.
  await page.goto("/budget");
  await expect(page.getByTestId("envelope-b1")).toHaveAttribute("aria-valuetext", /of ₹95,000 planned/);
});

test("undo after navigating: the header's Undo reverts an edit made on another page, and links to it", async ({ page }) => {
  await page.goto("/budget");
  await page.getByRole("button", { name: /^Lock Haldi marigold decor$/ }).click();
  await expect(page.getByRole("button", { name: /^Locked Haldi marigold decor/ })).toBeVisible();
  await openPage(page, "Tasks");
  const undo = page.getByRole("button", { name: "Undo" });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(undo).toBeDisabled();
  // The change happened on Budget, so the toast links there.
  const link = page.getByRole("status").getByRole("link", { name: /View budget/ });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/budget$/);
  await expect(page.getByRole("button", { name: /^Lock Haldi marigold decor$/ })).toBeVisible();
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(page.getByRole("button", { name: /^Locked Haldi marigold decor/ })).toBeVisible();
});

// ---------- Co-Pilot on every page ----------
test("the Co-Pilot drawer opens on every route, and its conversation carries across pages", async ({ page }) => {
  await page.goto("/");
  await expect(h1(page)).toBeVisible();
  const launcher = page.getByRole("button", { name: "Open AI Co-Pilot" });
  const drawer = page.getByRole("dialog", { name: "AI Co-Pilot" });
  await launcher.click();
  await page.getByLabel("Chat message").fill("Which vendor deposits are overdue and what tasks are urgent?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log", { name: "AI Co-Pilot conversation" })).toContainText("Which vendor deposits");
  await page.keyboard.press("Escape");
  for (const r of ROUTES) {
    await openPage(page, r.name);
    await launcher.click();
    await expect(drawer).toBeVisible();
    await expect(page.getByRole("log", { name: "AI Co-Pilot conversation" })).toContainText("Which vendor deposits");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(launcher).toBeFocused();
  }
});

test("an AI change to another page is linked from the drawer, and the link opens that page", async ({ page }) => {
  await page.goto("/tasks");
  await expect(h1(page)).toHaveText("Tasks");
  await page.getByRole("button", { name: "Open AI Co-Pilot" }).click();
  await page.getByLabel("Chat message").fill("Cut ₹30k from decor");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const card = page.getByTestId("diff-card").last();
  await card.getByRole("button", { name: "Approve & Commit" }).click();
  await expect(card).toContainText("Committed");
  const elsewhere = page.getByTestId("copilot-elsewhere");
  await expect(elsewhere).toBeVisible();
  await elsewhere.getByRole("link", { name: /Budget/ }).click();
  await expect(page.getByRole("dialog", { name: "AI Co-Pilot" })).toBeHidden();
  await expect(page).toHaveURL(/\/budget$/);
  await expect(h1(page)).toBeFocused();
  // The highlight shows on the page that changed (it pulses for three seconds).
  await expect(page.locator("#budget .hl-a, #budget .hl-b").first()).toBeVisible();
});

// ---------- Show me ----------
async function showMeAndCheck(page: Page, name: RegExp, path: string, section: string) {
  await openPage(page, "Overview");
  const all = page.getByRole("button", { name: /^Show all \d+/ });
  if (await all.count()) await all.click();
  await page.getByRole("button", { name }).first().click();
  await expect(page).toHaveURL(new RegExp(`${path}#ref-[\\w-]+$`));
  const ref = new URL(page.url()).hash.slice(1);
  await expect(page.locator(`#${ref}`)).toBeFocused();
  await expect(page.locator(`#${ref}`)).toBeInViewport();
  expect(await page.locator(`#${ref}`).evaluate((el, s) => !!el.closest(`section#${s}`), section)).toBe(true);
  await expect(page.locator(`#${ref}`)).toHaveClass(/hl-[ab]/);
}

test("Needs attention: Show me opens the page that owns each flag and focuses the flagged row", async ({ page }) => {
  await page.goto("/");
  await expect(h1(page)).toBeVisible();
  await showMeAndCheck(page, /^Show me ?: .*deposit (overdue|due soon)/, "/budget", "budget");
  await expect(h1(page)).toHaveText("Budget");
  await showMeAndCheck(page, /^Show me ?: Pay caterer deposit/, "/tasks", "tasks");
  await expect(h1(page)).toHaveText("Tasks");
  await showMeAndCheck(page, /^Show me ?: .*haven.t confirmed/, "/event", "event");
  await expect(h1(page)).toHaveText("Event");
});

test("deep links: a fresh load of /budget, and of /budget#ref-b1, which focuses and highlights that line", async ({ page }) => {
  await page.goto("/budget");
  await expect(h1(page)).toHaveText("Budget");
  await expect(page).toHaveTitle("Budget · Utsav Co-Pilot");
  await expect(nav(page).getByRole("link", { name: "Budget", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("meter", { name: "Haldi marigold decor budget" })).toBeVisible();
  await page.goto("about:blank"); // so the next load is a real page load, not a same-document hash change
  await page.goto("/budget#ref-b1");
  await expect(page.locator("#ref-b1")).toBeFocused();
  await expect(page.locator("#ref-b1")).toBeInViewport();
  await expect(page.locator("#ref-b1")).toHaveClass(/hl-[ab]/);
});

// ---------- mobile ----------
test("mobile tab bar routes between pages and the open page's heading is never under it", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto("/");
  await expect(h1(page)).toBeVisible();
  await mark(page);
  const bar = nav(page);
  await expect(page.getByRole("banner").getByRole("navigation")).toHaveCount(0); // the bar, not header tabs, below 768px
  for (const r of [...ROUTES.slice(1), ROUTES[0]]) {
    // v6: Schedule, Event and Ideas sit in the "More" sheet below 768px.
    const inBar = await bar.getByRole("link", { name: r.name, exact: true }).isVisible();
    if (!inBar) await bar.getByTestId("more-button").click();
    await bar.getByRole("link", { name: r.name, exact: true }).click();
    await expect(page).toHaveTitle(r.title);
    if (inBar) await expect(bar.getByRole("link", { name: r.name, exact: true })).toHaveAttribute("aria-current", "page");
    else await expect(bar.getByTestId("more-button")).toContainText(r.name);
    await expect(h1(page)).toBeFocused();
    await expect(h1(page)).toBeInViewport();
    const hb = (await h1(page).boundingBox())!, nb = (await bar.boundingBox())!;
    expect(hb.y + hb.height).toBeLessThanOrEqual(nb.y);
  }
  expect(await stillMarked(page)).toBe(true);
});

// ---------- accessibility and layout on every route ----------
for (const scheme of ["light", "dark"] as const) {
  test(`axe (${scheme}): every route, at 1280px and 375px, has no WCAG 2.2 A/AA violations and no target under 24px`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: width < 768 ? 740 : 900 });
      for (const r of ROUTES) {
        await page.goto(r.path);
        await expect(h1(page)).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        expect(await axe(page), `${r.path} ${width}px (${scheme})`).toEqual([]);
        expect(await smallTargets(page), `${r.path} ${width}px targets`).toEqual([]);
      }
    }
  });
}

test("axe: the Event page for each event type, light and dark", async ({ page }) => {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/event");
    await expect(h1(page)).toBeVisible();
    for (const t of ["birthday", "community", "wedding"]) {
      await page.getByRole("combobox", { name: "Event" }).selectOption(t);
      expect(await axe(page), `/event ${t} (${scheme})`).toEqual([]);
    }
  }
});

for (const width of [320, 375, 768, 1280]) {
  test(`no horizontal overflow at ${width}px on any route (each event type)`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 768 ? 740 : 900 });
    await page.goto("/");
    await expect(h1(page)).toBeVisible();
    for (const t of ["birthday", "community", "wedding"]) {
      await page.getByRole("combobox", { name: "Event" }).selectOption(t);
      for (const r of ROUTES) {
        await openPage(page, r.name);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${r.path} (${t}) at ${width}px`).toBeLessThanOrEqual(0);
      }
    }
  });
}

test("Guest View is its own page: it hides the page navigation on any route and has its own title", async ({ page }) => {
  await page.goto("/schedule");
  await expect(h1(page)).toHaveText("Schedule");
  await page.getByRole("button", { name: "Guest View" }).click();
  await expect(nav(page)).toHaveCount(0);
  await expect(page).toHaveTitle("Guest View · Utsav Co-Pilot");
  await expect(h1(page)).toHaveCount(1);
  await expect(h1(page)).toHaveText(WEDDING_TITLE);
  await expect(page.getByRole("heading", { name: "Live itinerary" })).toBeVisible();
  await page.getByRole("button", { name: "Organizer" }).click();
  await expect(nav(page)).toBeVisible();
  await expect(page).toHaveTitle("Schedule · Utsav Co-Pilot");
  await expect(h1(page)).toHaveText("Schedule");
});
