import { expect, test } from "@playwright/test";
import { skipWelcome, switchEvent } from "./helpers";

// Configuration-driven templates, prompts and layouts, end to end.
const pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
  await skipWelcome(page);
});
test.afterEach(() => { expect(pageErrors, "uncaught client-side exceptions").toEqual([]); });

test("GET /api/event-templates returns the public template summaries", async ({ request }) => {
  const res = await request.get("/api/event-templates");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/json");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  const body = await res.json() as { templates: { id: string; label: string; eventType: string }[] };
  expect(body.templates.map(t => t.id)).toEqual(["wedding", "birthday", "community"]);
  expect(body.templates.map(t => t.label)).toEqual(["Royal Wedding — ₹25L", "30th Arcade Birthday — ₹1.5L", "Community Cultural Fest — ₹5L"]);
  const raw = JSON.stringify(body);
  for (const leak of ["guests", "vendors", "phone", "inviteCode", "seed"]) expect(raw).not.toContain(`"${leak}"`);
});

test("the event menu lists the registry under Samples and each template renders its configured sections", async ({ page }) => {
  await page.goto("/");
  // v8 Part 0b: the header title is the event menu; samples are listed by name with type and budget, unnumbered.
  const menuBtn = page.getByTestId("event-switcher");
  await menuBtn.click();
  const samples = page.getByRole("group", { name: "Samples" }).getByRole("menuitemradio");
  await expect(samples).toHaveText([/^Royal Wedding\s*Wedding · ₹25L$/, /^30th Arcade Birthday\s*Birthday · ₹1\.5L$/, /^Community Cultural Fest\s*Community event · ₹5L$/]);
  await page.keyboard.press("Escape");
  const want: Record<string, string[]> = {
    wedding: ["Wedding · Couple & Traditions", "Dietary counts · Muhurtham (yes)", "Gift registry", "Manage RSVPs on Guests"],
    birthday: ["Birthday · Rohan turns 30 · Retro arcade · 80s neon", "Gift wishlist", "Party activity run-sheet"],
    community: ["Community · Sponsors & Permits", "Sponsor pipeline", "Municipal permits"],
  };
  // The event-type card is on the Event page (the switcher stays in the header on every page).
  await page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Event", exact: true }).click();
  for (const [id, texts] of Object.entries(want)) {
    await switchEvent(page, id);
    for (const t of texts) await expect(page.getByText(t).first()).toBeVisible();
  }
});

test("prompt chips come from configuration and still need approval", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("copilot-launcher").click();
  const chip = page.locator('[data-prompt-id="judge-cut-and-move"]');
  await expect(chip).toHaveText("Cut ₹20k from decor and move the Haldi to Friday");
  await chip.click();
  const card = page.getByTestId("diff-card").last();
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: /approve/i })).toBeVisible();
});

test("guest view uses the template's guest sections", async ({ page }) => {
  await page.goto("/");
  await switchEvent(page, "community");
  await page.getByRole("button", { name: "Guest View" }).click();
  await expect(page.getByText("Join the community")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Get involved" })).toBeVisible();
  await expect(page.getByText("Sponsor pipeline")).toHaveCount(0);
  await expect(page.locator('[data-prompt-id^="judge-"]')).toHaveCount(0);
});
