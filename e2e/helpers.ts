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

/**
 * v8 Part 1b (E2E stability): the canvas highlight (hl-a / hl-b) lasts about 3 s, which a slow machine can miss between
 * the click and the assertion. Record every element that ever carried it, from the first script on the page, and assert
 * on that record instead of the live class.
 */
export async function trackHighlights(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __hlSeen?: string[] };
    w.__hlSeen = [];
    const seen = (el: Element) => {
      if (!/\bhl-[ab]\b/.test(el.getAttribute("class") ?? "")) return;
      w.__hlSeen!.push(el.id || el.getAttribute("data-testid") || el.tagName);
      for (let p = el.parentElement; p; p = p.parentElement) if (p.id) w.__hlSeen!.push(`in:${p.id}`);
    };
    const start = () => new MutationObserver(ms => { for (const m of ms) {
      if (m.type === "attributes" && m.target instanceof Element) seen(m.target);
      for (const n of Array.from(m.addedNodes)) if (n instanceof Element) { seen(n); n.querySelectorAll(".hl-a, .hl-b").forEach(seen); }
    } }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    if (document.documentElement) start(); else document.addEventListener("DOMContentLoaded", start);
  });
}
/** True once the element with this id (or data-testid) has been highlighted since the page loaded (see trackHighlights). */
export async function expectHighlighted(page: Page, idOrTestId: string) {
  await expect.poll(() => page.evaluate(id => ((window as unknown as { __hlSeen?: string[] }).__hlSeen ?? []).includes(id), idOrTestId), { timeout: 10_000 }).toBe(true);
}
/** True once anything inside the element with this id has been highlighted since the page loaded. */
export async function expectSectionHighlighted(page: Page, section: string) {
  await expect.poll(() => page.evaluate(s => ((window as unknown as { __hlSeen?: string[] }).__hlSeen ?? []).includes(`in:${s}`), section), { timeout: 10_000 }).toBe(true);
}

/**
 * v8 Part 1c: fill in the open RSVP form on a guest page (the RSVP link) and send it. `functions` are sub-event ids
 * (the wedding sample: s1 Haldi, s2 Mehendi, s3 Sangeet, s4 Muhurtham, s5 Reception). Waits for the confirmation.
 */
export async function submitRsvp(page: Page, o: { name?: string; phone?: string; party?: number; functions?: string[]; meal?: "veg" | "non_veg" | "jain"; answer?: "coming" | "maybe" | "not_coming"; kids?: number } = {}) {
  const form = page.getByTestId("rsvp-form");
  await expect(form).toBeVisible();
  if (o.name !== undefined) await form.getByTestId("rsvp-name").fill(o.name);
  if (o.phone !== undefined) await form.getByTestId("rsvp-phone").fill(o.phone);
  if (o.answer) await form.getByTestId(`rsvp-answer-${o.answer}`).click();
  if (o.party !== undefined) await form.getByTestId("rsvp-party").fill(String(o.party));
  if (o.kids !== undefined) await form.getByTestId("rsvp-kids").fill(String(o.kids));
  for (const f of o.functions ?? []) {
    const pill = form.getByTestId(`rsvp-fn-${f}`);
    if (!(await pill.locator("input").isChecked())) await pill.click();
    await expect(pill.locator("input")).toBeChecked();
  }
  if (o.meal) await form.getByTestId(`rsvp-meal-${o.meal}`).click();
  await form.getByTestId("rsvp-submit").click();
  await expect(page.getByTestId("rsvp-confirmation")).toBeVisible();
}

/**
 * v8 Part 0b: the header's event title is the event menu (it replaced the template <select>). Open it and choose a slot
 * ("wedding", "birthday", "community") with the mouse, then confirm the switch.
 */
export async function switchEvent(page: Page, slot: string) {
  const btn = page.getByTestId("event-switcher");
  // Hardened (v8 Part 1b): right after a client-side navigation the first click on the menu button was occasionally lost
  // on a slow machine (the menu stayed closed for the whole timeout). Click again only while it is still closed.
  await expect(async () => {
    if ((await btn.getAttribute("aria-expanded")) !== "true") await btn.click({ timeout: 2_000 });
    await expect(btn).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await page.getByTestId(`event-option-${slot}`).click();
  await expect(btn).toHaveAttribute("data-active", slot);
  await expect(btn).toHaveAttribute("aria-expanded", "false");
}
