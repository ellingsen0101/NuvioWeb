// Runs in Playwright's WebKit with an iPhone profile. WebKit is the engine family iOS Safari uses,
// so this catches engine-specific script and layout errors. It is not iOS Safari: on Windows it has
// different media support, no safe areas, and no Home Screen mode. It proves nothing about playback
// on a real iPhone, so playback is not asserted here.
import { expect, test } from "@playwright/test";

const FIXTURE = "http://localhost:6100";

async function openSignedIn(page, request) {
  await request.get(`${FIXTURE}/__test/reset`);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator(".login-code")).toHaveText("ABCD-1234");
  await request.get(`${FIXTURE}/__test/approve`);
  await page.getByRole("button", { name: "Account Owner" }).tap();
  await expect(page.locator(".nav-bottom .nav-item.is-active")).toHaveText(/Home/, { timeout: 20000 });
  return errors;
}

test("the app runs in WebKit from sign-in through every main screen", async ({ page, request }) => {
  const errors = await openSignedIn(page, request);
  await expect(page.locator(".row-head h2", { hasText: "E2E Movies" })).toBeVisible({ timeout: 20000 });

  for (const route of ["search", "library", "settings", "settings/addons", "settings/streaming", "detail/movie/e2e-movie-0", "detail/series/e2e-series-1"]) {
    await page.goto(`/#/${route}`);
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, route).toBeLessThanOrEqual(0);
  }
  expect(errors).toEqual([]);
});

test("touch targets on the bottom navigation are large enough", async ({ page, request }) => {
  await openSignedIn(page, request);
  const boxes = await page.locator(".nav-bottom .nav-item").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()));
  expect(boxes).toHaveLength(4);
  for (const box of boxes) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
  await page.locator(".nav-bottom .nav-item", { hasText: "Search" }).tap();
  await expect(page.getByLabel("Search", { exact: true })).toBeVisible();
});

test("text inputs are 16px, so iOS doesn't zoom the page on focus", async ({ page, request }) => {
  await openSignedIn(page, request);
  await page.goto("/#/search");
  const size = await page.getByLabel("Search", { exact: true }).evaluate((input) => getComputedStyle(input).fontSize);
  expect(parseFloat(size)).toBeGreaterThanOrEqual(16);
});

test("the player opens and shows its controls in a landscape phone size", async ({ page, request }) => {
  await openSignedIn(page, request);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/#/detail/movie/e2e-movie-0");
  await page.locator(".detail-actions .btn-primary").tap();
  await page.locator(".stream-row").first().tap();
  await expect(page.locator(".player-video")).toBeAttached();
  await expect(page.locator(".player-video")).toHaveAttribute("playsinline", "");
  await expect(page.getByRole("button", { name: "Fullscreen" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
