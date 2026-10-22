import { expect, test } from "@playwright/test";

// Configuration-driven templates, prompts and layouts, end to end.
const pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
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

test("the event switcher lists the registry and each template renders its configured sections", async ({ page }) => {
  await page.goto("/");
  const select = page.getByRole("combobox", { name: "Event" });
  await expect(select.locator("option")).toHaveText(["1. Royal Wedding — ₹25L", "2. 30th Arcade Birthday — ₹1.5L", "3. Community Cultural Fest — ₹5L"]);
  const want: Record<string, string[]> = {
    wedding: ["Wedding · RSVP Matrix & Traditions", "Dietary counts · Muhurtham (yes)"],
    birthday: ["Birthday · Rohan turns 30 · Retro arcade · 80s neon", "Gift wishlist", "Party activity run-sheet"],
    community: ["Community · Sponsors & Permits", "Sponsor pipeline", "Municipal permits"],
  };
  for (const [id, texts] of Object.entries(want)) {
    await select.selectOption(id);
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
  await page.getByRole("combobox", { name: "Event" }).selectOption("community");
  await page.getByRole("button", { name: "Guest View" }).click();
  await expect(page.getByText("Join the community")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Get involved" })).toBeVisible();
  await expect(page.getByText("Sponsor pipeline")).toHaveCount(0);
  await expect(page.locator('[data-prompt-id^="judge-"]')).toHaveCount(0);
});
