import { expect, test, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { submitRsvp, skipWelcome, switchEvent } from "./helpers";

// v8 Part 1: the Guests page (paste / vCard import through one approval card, per-household WhatsApp invites, Copy and
// Reset link), the group join link across two browsers, the wishlist (add, claim, release, surprise mode) and the RSVP
// change log. Demo Mode build with the file store, like every other spec.
// v8 Part 1c (updated on purpose): one open RSVP link per event (with a QR); each family fills in one form, so the tests
// below send the form instead of finding a name. The household list moved into the collapsed "Guest list (optional)"
// section (openGuestList), and personal links are gone. The RSVP dashboard itself is covered by rsvp-open.spec.ts.

const pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", e => pageErrors.push(e.message));
  await skipWelcome(page);
  // Publishing is rate limited per client IP (10 an hour). These tests publish several times, so each one reports its own
  // documentation-range address (the server reads x-forwarded-for, as it does behind Vercel's proxy) and the rest of the
  // suite keeps its budget.
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${1 + Math.floor(Math.random() * 250)}` });
});
test.afterEach(() => { expect(pageErrors, "uncaught client-side exceptions").toEqual([]); });

async function axe(page: Page, exclude?: string) {
  const b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  const r = await (exclude ? b.exclude(exclude) : b).analyze();
  return r.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => `${n.target.join(" ")} ${n.failureSummary?.split("\n")[1] ?? ""}`).join(" | ")}`);
}
async function smallTargets(page: Page) {
  return page.evaluate(() => {
    const sel = "a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex='-1'])";
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (el.closest("dialog:not([open])") || el.closest("[aria-hidden='true']")) continue;
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (r.width <= 1 || r.height <= 1 || cs.visibility === "hidden" || cs.display === "none") continue;
      if (r.width < 23.5 || r.height < 23.5) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 50)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
}
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const approve = (page: Page, testId: string) => page.getByTestId(testId).getByRole("button", { name: "Approve & Commit" }).click();
/** v8 Part 1c: the household list is optional and starts collapsed. */
async function openGuestList(page: Page) {
  const d = page.getByTestId("guests-optional");
  await expect(d).toBeVisible();
  if (!(await d.evaluate(el => (el as HTMLDetailsElement).open))) await d.locator("summary").click();
  await expect(page.locator("#guests-add")).toBeVisible();
}

/** Publish from the Guests page; resolves once the household links exist. */
async function publishFromGuests(page: Page) {
  await page.goto("/guests");
  await page.getByTestId("guests-publish").click();
  await expect(page.getByTestId("guests-unpublished")).toHaveCount(0);
  await expect(page.getByTestId("rsvp-link-text")).toBeVisible();
  return (await page.getByTestId("rsvp-link-text").textContent())!.trim();
}
async function guestPage(browser: Browser, url: string) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.goto(url);
  return { ctx, p };
}

test("paste a list: deterministic preview (new / duplicate / can't add), then ONE approval card, then the households", async ({ page }) => {
  await page.goto("/guests");
  await expect(page.getByRole("heading", { level: 1, name: "Guests" })).toBeVisible();
  await openGuestList(page);
  await page.getByTestId("guests-mode-paste").click();
  await page.getByTestId("paste-input").fill("Ravi Kumar, +91 98480 12345\nSita - 98765 43210\nRavi again 098480-12345\n98480 99999");
  await page.getByTestId("paste-preview").click();
  await expect(page.getByTestId("import-counts")).toContainText("2 new · 1 duplicate · 1 can't be added");
  await expect(page.getByTestId("import-row")).toHaveCount(4);
  await expect(page.getByTestId("import-row").nth(0)).toContainText("+91 98480 12345");
  await expect(page.getByTestId("import-approval")).toHaveCount(0);
  await page.getByTestId("import-continue").click();
  const card = page.getByTestId("import-approval");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Needs your approval");
  await expect(card.getByRole("button", { name: "Approve & Commit" })).toHaveCount(1);
  await approve(page, "import-approval");
  await expect(page.getByTestId("household-hh-ravi-kumar")).toBeVisible();
  await expect(page.getByTestId("hh-phone-hh-ravi-kumar")).toHaveText("+91 98480 12345");
  await expect(page.getByTestId("household-hh-sita")).toBeVisible();
  await expect(page.getByTestId("household-hh-ravi-again")).toHaveCount(0);
  // One history step: Undo takes the whole import back.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("household-hh-ravi-kumar")).toHaveCount(0);
  await expect(page.getByTestId("household-hh-sita")).toHaveCount(0);
});

test("upload a .vcf: parsed in the browser (folded lines, several cards), previewed, approved", async ({ page }) => {
  let uploads = 0;
  page.on("request", r => { if (r.method() !== "GET" && /vcf|vcard/i.test(r.postData() ?? "")) uploads++; });
  await page.goto("/guests");
  await openGuestList(page);
  await page.getByTestId("guests-mode-vcf").click();
  const vcf = ["BEGIN:VCARD", "VERSION:3.0", "FN:Meena", "  Iyer", "TEL;TYPE=CELL:+91 90000 11111", "END:VCARD", "BEGIN:VCARD", "VERSION:3.0", "N:Reddy;Gopal;;;", "TEL:9000022222", "EMAIL:g@example.com", "END:VCARD"].join("\r\n");
  await page.getByTestId("vcf-input").setInputFiles({ name: "contacts.vcf", mimeType: "text/vcard", buffer: Buffer.from(vcf) });
  await expect(page.getByTestId("import-counts")).toContainText("2 new");
  await expect(page.getByTestId("import-row").nth(0)).toContainText("Meena Iyer");
  await expect(page.getByTestId("import-row").nth(1)).toContainText("Gopal Reddy");
  await page.getByTestId("import-continue").click();
  await approve(page, "import-approval");
  await expect(page.getByTestId("household-hh-meena-iyer")).toBeVisible();
  await expect(page.getByTestId("household-hh-gopal-reddy")).toBeVisible();
  expect(uploads, "the contacts file never leaves the browser").toBe(0);
  // The contact picker only exists where the browser has it (desktop Chromium does not).
  await expect(page.getByTestId("guests-pick-contacts")).toHaveCount(0);
});

test("share card: one RSVP link with a QR, WhatsApp share and Copy; an old household link opens the same form and shows nothing of the household", async ({ page, browser }) => {
  await page.goto("/guests");
  await openGuestList(page);
  await page.getByTestId("hh-label").fill("Kumar family");
  await page.getByTestId("hh-phone").fill("098480 12345");
  await page.getByTestId("hh-members").fill("Ravi Kumar\nUma Kumar");
  await page.getByTestId("hh-submit").click();
  await expect(page.getByTestId("household-hh-kumar-family")).toBeVisible();
  const rsvp = await publishFromGuests(page);
  expect(rsvp).toMatch(/\/guest\/[A-Za-z0-9_-]{22}#k=[A-Za-z0-9_-]{43}$/);
  // The share card: the QR (an image with a name, described by the link text), WhatsApp share, Copy.
  const qr = page.getByTestId("rsvp-qr");
  await expect(qr).toHaveAttribute("role", "img");
  await expect(qr).toHaveAccessibleName(/^QR code for the RSVP link to /);
  await expect(qr).toHaveAccessibleDescription(rsvp);
  const wa = await page.getByTestId("rsvp-wa").getAttribute("href");
  expect(wa).toMatch(/^https:\/\/wa\.me\/\?text=/);
  expect(decodeURIComponent(wa!.split("?text=")[1]!)).toContain(`Please RSVP for your family here: ${rsvp}`);
  await page.getByTestId("rsvp-copy").click();
  await expect(page.getByTestId("rsvp-msg")).toContainText(/RSVP link copied|Copy this link/);
  // Part 1b's per-guest personal links and "type your name" are gone.
  await expect(page.locator('[data-testid^="plink-"], [data-testid^="pcopy-"], [data-testid^="preset-"], [data-testid^="answered-"]')).toHaveCount(0);

  // An old Part 1 household link (still on the server) opens the open RSVP form, with no household data in it.
  const share = await page.evaluate(() => (JSON.parse(localStorage.getItem("utsav_share_v1") ?? "{}") as Record<string, { eventId: string; invites: { householdId: string; token: string }[] }>).wedding);
  const old = share.invites.find(i => i.householdId === "hh-kumar-family")!;
  const g = await guestPage(browser, `${rsvp.split("#")[0]}#k=${old.token}`);
  await expect(g.p.getByTestId("rsvp-form")).toBeVisible();
  await expect(g.p.getByTestId("public-guest-page")).not.toContainText("Kumar");
  await expect(g.p.getByTestId("rsvp-name")).toHaveValue("");
  await g.ctx.close();
});

test("group join link across two browsers: request → organizer approves → a household on the optional guest list", async ({ page, browser }) => {
  await publishFromGuests(page);
  await openGuestList(page);
  await page.getByTestId("join-enable").click();
  const joinUrl = await page.getByTestId("join-link").inputValue();
  expect(joinUrl).toMatch(/\/join\/[A-Za-z0-9_-]{22}\?t=[A-Za-z0-9_-]{43}$/);
  const wa = await page.getByTestId("join-wa").getAttribute("href");
  expect(wa).toMatch(/^https:\/\/wa\.me\/\?text=/);
  expect(decodeURIComponent(wa!.split("?text=")[1]!)).toContain(joinUrl);

  const m = await guestPage(browser, joinUrl);
  await expect(m.p.getByRole("heading", { level: 1 })).toContainText("Arjun & Meera");
  await m.p.getByTestId("join-name").fill("Priya Sharma");
  await m.p.getByTestId("join-size").selectOption("2");
  await m.p.getByTestId("join-phone").fill("90000 12345");
  await m.p.getByTestId("join-submit").click();
  await expect(m.p.getByTestId("join-done")).toContainText("once they approve it");

  await page.getByTestId("join-refresh").click();
  const req = page.locator('[data-testid^="join-request-"]').filter({ hasText: "Priya Sharma" });
  await expect(req).toBeVisible({ timeout: 15_000 });
  await expect(req).toContainText("2 people");
  await req.getByRole("button", { name: /^Approve/ }).click();
  await expect(page.getByTestId("household-hh-priya-sharma-household")).toBeVisible();
  await expect(page.getByTestId("hh-phone-hh-priya-sharma-household")).toHaveText("+91 90000 12345");
  // Turning the join link off: the old join URL now explains itself.
  await page.getByTestId("join-disable").click();
  await expect(page.getByTestId("join-enable")).toBeVisible();
  await m.p.goto(joinUrl);
  await expect(m.p.getByTestId("join-error")).toContainText("isn't active");
  await m.ctx.close();
});

test("wishlist: add a gift (https only), a guest claims and releases it, surprise mode hides claims on the public link", async ({ page, browser }) => {
  await page.goto("/");
  await switchEvent(page, "birthday");
  await page.goto("/event");
  const mgr = page.getByTestId("wishlist-manager");
  await mgr.getByTestId("wish-add-item").fill("Bad link gift");
  await mgr.getByTestId("wish-add-url").fill("http://example.com/x");
  await mgr.getByTestId("wish-add-submit").click();
  await expect(mgr.getByRole("alert")).toContainText("https://");
  await mgr.getByTestId("wish-add-item").fill("Lego Technic set");
  await mgr.getByTestId("wish-add-price").fill("4000");
  await mgr.getByTestId("wish-add-url").fill("https://www.amazon.in/dp/B0TEST");
  await mgr.getByTestId("wish-add-submit").click();
  const item = page.getByTestId("wish-wl-lego-technic-set");
  await expect(item).toContainText("₹4,000");
  await expect(item.getByRole("link", { name: /Shop link/ })).toHaveAttribute("rel", "noopener noreferrer nofollow");

  const link = await publishFromGuests(page);
  const g = await guestPage(browser, link);
  // v8 Part 1c: claims need an RSVP from this device; the confirmation shows the wishlist.
  await expect(g.p.getByTestId("claim-wl-lego-technic-set")).toHaveCount(0);
  await submitRsvp(g.p, { name: "Sneha's friend", party: 1, functions: ["bs2"] });
  const gift = g.p.getByTestId("guest-wish-wl-lego-technic-set");
  await expect(gift.getByRole("link", { name: /View/ })).toHaveAttribute("href", "https://www.amazon.in/dp/B0TEST");
  await gift.getByRole("button", { name: /I'll bring this/ }).click();
  await expect(gift).toContainText("you're bringing this");
  await gift.getByRole("button", { name: /Release/ }).click();
  await expect(gift.getByRole("button", { name: /I'll bring this/ })).toBeVisible();
  // Sneha (on the optional guest list) claimed the record player: claimed, and not releasable from here.
  await expect(g.p.getByTestId("guest-wish-w2")).toContainText("claimed");
  await expect(g.p.getByTestId("unclaim-w2")).toHaveCount(0);

  // Surprise mode: the organizer view hides who claimed until asked; the public link hides claims.
  await page.goto("/event");
  await expect(page.getByLabel("Who claimed Vinyl record player")).toHaveValue("bg2");
  await page.getByTestId("wish-surprise").click();
  await expect(page.getByTestId("wish-surprise")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Who claimed Vinyl record player")).toHaveCount(0);
  await expect(page.getByTestId("wish-w2")).toContainText("Claimed");
  await page.getByTestId("wish-reveal").click();
  await expect(page.getByLabel("Who claimed Vinyl record player")).toBeVisible();
  const pub = link.split("#")[0]!;
  await expect(async () => {
    await g.p.goto("about:blank");
    await g.p.goto(pub);
    await expect(g.p.getByTestId("claims-hidden")).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await expect(g.p.getByTestId("guest-wish-w2")).toContainText("on the list");
  await expect(g.p.getByTestId("guest-wish-w2")).not.toContainText("claimed");
  await g.ctx.close();
});

test("removing a guest is a Tier 1 approval card; cancelling changes nothing", async ({ page }) => {
  await page.goto("/guests");
  await openGuestList(page);
  const row = page.getByTestId("household-h5");
  await expect(row).toBeVisible();
  await page.getByTestId("hh-remove-h5").click();
  const card = page.getByTestId("guest-remove-preview");
  await expect(card).toContainText("College friends (removed)");
  await card.getByRole("button", { name: /Reject|Cancel/ }).first().click();
  await expect(row).toBeVisible();
  await page.getByTestId("hh-remove-h5").click();
  await approve(page, "guest-remove-preview");
  await expect(row).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe (${scheme}) at 1280 and 375: Guests page, import preview and approval card, join page, wishlist manager`, async ({ page }) => {
    test.slow();
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 900 });
    await publishFromGuests(page);
    await openGuestList(page);
    await page.getByTestId("join-enable").click();
    const joinUrl = await page.getByTestId("join-link").inputValue();
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: width < 768 ? 740 : 900 });
      await page.goto("/guests");
      await openGuestList(page);
      await expect(page.getByTestId("household-list")).toBeVisible();
      expect(await axe(page), `guests ${width}`).toEqual([]);
      expect(await overflowX(page), `no horizontal scroll at ${width}`).toBeLessThanOrEqual(0);
      if (width === 375) expect(await smallTargets(page), "guests targets").toEqual([]);
      await page.getByTestId("guests-mode-paste").click();
      await page.getByTestId("paste-input").fill("Asha, 9000000001\nAsha twin 90000 00001\n12345678");
      await page.getByTestId("paste-preview").click();
      await page.getByTestId("import-continue").click();
      await expect(page.getByTestId("import-approval")).toBeVisible();
      expect(await axe(page), `import approval ${width}`).toEqual([]);
      expect(await overflowX(page), `import preview fits at ${width}`).toBeLessThanOrEqual(0);
      await page.getByTestId("hh-remove-h1").click();
      await expect(page.getByTestId("guest-remove-preview")).toBeVisible();
      expect(await axe(page), `remove card ${width}`).toEqual([]);
      await page.goto(joinUrl);
      await expect(page.getByTestId("join-form")).toBeVisible();
      expect(await axe(page), `join page ${width}`).toEqual([]);
      if (width === 375) {
        expect(await smallTargets(page), "join targets").toEqual([]);
        for (const id of ["join-name", "join-size", "join-phone", "join-submit"]) expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
    }
    await page.goto("/");
    await switchEvent(page, "birthday");
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: width < 768 ? 740 : 900 });
      await page.goto("/event");
      await expect(page.getByTestId("wishlist-manager")).toBeVisible();
      await page.getByTestId("wish-surprise").click();
      expect(await axe(page), `wishlist manager ${width}`).toEqual([]);
      expect(await overflowX(page), `wishlist fits at ${width}`).toBeLessThanOrEqual(0);
      await page.getByTestId("wish-remove-w5").click();
      await expect(page.getByTestId("wish-remove-preview")).toBeVisible();
      // v8 Part 1e: the editable run-sheet sits beside the wishlist; focusing this card scrolls the page, which can leave a
      // run-sheet button partly under the sticky header (axe target-size "obscured"). The run-sheet has its own axe checks
      // in activities.spec.ts, so this one scopes to everything else.
      expect(await axe(page, '[data-testid="activity-run-sheet"]'), `wishlist remove card ${width}`).toEqual([]);
      await page.getByTestId("wish-remove-preview").getByRole("button", { name: /Reject|Cancel/ }).first().click();
      await page.getByTestId("wish-surprise").click();
    }
  });
}
