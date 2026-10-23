import { expect, type Page } from "@playwright/test";

/**
 * A brand-new browser now opens on the welcome screen (plan your own event, or explore a sample). Most specs exercise
 * the sample plans, so they start as a returning user who already chose "Explore a sample": the app's own onboarding
 * flag, set before any page script runs. setup.spec.ts covers the welcome itself.
 */
export async function skipWelcome(page: Page) {
  await page.addInitScript(() => { try { window.localStorage.setItem("utsav_onboarding_v1", "done"); } catch { /* storage blocked */ } });
}

/**
 * v6: open a page from the "Pages" navigation. From 768px every page is a header tab; below that the bar keeps
 * Overview, Budget, Tasks and Vendors and the rest are in the "More" sheet, so open it first when the link isn't shown.
 * Then confirm the page is current (the tab's aria-current, or the More button naming it once the sheet closes).
 */
export async function openPageNav(page: Page, name: string) {
  const nav = page.getByRole("navigation", { name: "Pages" });
  const link = nav.getByRole("link", { name, exact: true });
  const more = nav.getByTestId("more-button");
  if (!(await link.isVisible()) && (await more.isVisible())) await more.click();
  await link.click();
  await expect(nav.getByRole("link", { name, exact: true }).or(more.filter({ hasText: name }))).toBeVisible();
  if (await nav.getByRole("link", { name, exact: true }).isVisible()) await expect(nav.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
  else await expect(more).toContainText(name);
}
