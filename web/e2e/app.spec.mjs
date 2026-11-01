import { expect, test } from "@playwright/test";

const FIXTURE = "http://localhost:6100";
const BACKEND = "http://localhost:6300";
const BACKEND_KEY = "e2e-access-key-only-for-local-tests";

async function fixture(request, action) {
  await request.get(`${FIXTURE}/__test/${action}`);
}

async function signIn(page, request) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Nuvio" })).toBeVisible();
  await expect(page.locator(".login-code")).toHaveText("ABCD-1234");
  await fixture(request, "approve");
  await expect(page.getByRole("heading", { name: "Who's watching?" })).toBeVisible({ timeout: 20000 });
}

async function enterProfile(page, name = "Account Owner") {
  await page.getByRole("button", { name }).click();
  await expect(page.locator(".nav-item.is-active:visible")).toHaveText(/Home/);
}

async function connectBackend(page) {
  await page.goto("/#/settings/streaming");
  await page.getByLabel("Backend URL").fill(BACKEND);
  await page.getByLabel("Access key").fill(BACKEND_KEY);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".setting-status")).toHaveText(/Connected. Torrents on, remuxing on/);
}

async function openStream(page, id, type = "movie") {
  await page.goto(`/#/detail/${type}/${id}`);
  await page.locator(".detail-actions .btn-primary").click();
  const row = page.locator(".stream-row").first();
  await expect(row).toBeVisible({ timeout: 20000 });
  await row.click();
  await expect(page.locator(".player-video")).toBeAttached();
}

async function expectPlaying(page, { atLeast = 1, timeout = 45000 } = {}) {
  await expect
    .poll(() => page.locator(".player-video").evaluate((video) => ({ t: video.currentTime, err: video.error?.message || "" })).then((state) => {
      if (state.err) throw new Error(state.err);
      return state.t;
    }), { timeout })
    .toBeGreaterThan(atLeast);
}

test.beforeEach(async ({ request }) => {
  await fixture(request, "reset");
});

test.describe("account", () => {
  test("device-code sign-in loads account profiles and addons", async ({ page, request }) => {
    await signIn(page, request);
    await expect(page.getByRole("button", { name: "Second Person" })).toBeVisible();
    await enterProfile(page);
    await expect(page.locator(".row-head h2", { hasText: "E2E Movies" })).toBeVisible({ timeout: 20000 });
    await expect(page.locator(".poster-title", { hasText: "Direct MP4" }).first()).toBeVisible();
  });

  test("sign-in survives the app reloading while the code is approved on the website", async ({ page, request }) => {
    await page.goto("/");
    await expect(page.locator(".login-code")).toHaveText("ABCD-1234");
    await page.reload();
    await expect(page.locator(".login-code")).toHaveText("ABCD-1234");
    await fixture(request, "approve");
    await expect(page.getByRole("heading", { name: "Who's watching?" })).toBeVisible({ timeout: 20000 });
    const state = await (await request.get(`${FIXTURE}/__test/state`)).json();
    expect(state.loginStarts, "the reload reused the same code").toBe(1);
    expect(await page.evaluate(() => localStorage.getItem("webPendingDeviceLogin"))).toBeNull();
  });

  test("coming back to the app checks for approval right away", async ({ page, request }) => {
    await page.goto("/");
    await expect(page.locator(".login-code")).toHaveText("ABCD-1234");
    await page.evaluate(() => {
      const realSetTimeout = window.setTimeout;
      window.setTimeout = (fn, delay, ...rest) => realSetTimeout(fn, delay >= 1000 ? 600000 : delay, ...rest);
    });
    // Lets the timer already waiting run out, so that only the return event can trigger a check.
    await page.waitForTimeout(1500);
    await fixture(request, "approve");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByRole("heading", { name: "Who's watching?" })).toBeVisible({ timeout: 10000 });
  });

  test("an unavailable addon is shown as unavailable and doesn't break the rest", async ({ page, request }) => {
    await signIn(page, request);
    await enterProfile(page);
    await page.goto("/#/settings/addons");
    await expect(page.locator(".addon-text strong", { hasText: "E2E Test Addon" })).toBeVisible({ timeout: 20000 });
    await expect(page.locator(".addon-text strong", { hasText: "Unavailable addon" })).toBeVisible();
  });

  const expireAccessToken = (page) =>
    page.evaluate(() => {
      const encode = (value) => btoa(JSON.stringify(value)).replace(/=+$/, "");
      localStorage.setItem("access_token", `${encode({ alg: "none" })}.${encode({ sub: "user-1", exp: 1000 })}.mock`);
    });

  test("an expired access token refreshes without signing out", async ({ page, request }) => {
    await signIn(page, request);
    await enterProfile(page);
    await expireAccessToken(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Who's watching?" })).toBeVisible({ timeout: 15000 });
    await enterProfile(page);
    const state = await (await request.get(`${FIXTURE}/__test/state`)).json();
    expect(state.refreshes).toBeGreaterThan(0);
    await page.goto("/#/settings/account");
    await expect(page.getByText("Signed in", { exact: true })).toBeVisible();
  });

  test("a session that can't be refreshed returns to sign-in", async ({ page, request }) => {
    await signIn(page, request);
    await enterProfile(page);
    await fixture(request, "reject-refresh");
    await expireAccessToken(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in to Nuvio" })).toBeVisible({ timeout: 20000 });
  });

  test("signing out clears the session", async ({ page, request }) => {
    await signIn(page, request);
    await enterProfile(page);
    await page.goto("/#/settings/account");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to Nuvio" })).toBeVisible({ timeout: 15000 });
    const tokens = await page.evaluate(() => localStorage.getItem("refresh_token"));
    expect(String(tokens || "")).not.toContain("user-1");
  });

  test("guest mode works without an account", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Continue without an account" }).click();
    await expect(page.locator(".nav-item.is-active:visible")).toHaveText(/Home/);
  });
});

test.describe("browsing", () => {
  test.beforeEach(async ({ page, request }) => {
    await signIn(page, request);
    await enterProfile(page);
  });

  test("search returns real addon results", async ({ page }) => {
    await page.goto("/#/search");
    await page.getByLabel("Search", { exact: true }).fill("hls");
    const results = page.locator(".screen-search");
    await expect(results.locator(".poster-title", { hasText: "HLS Stream" })).toBeVisible({ timeout: 15000 });
    await expect(results.locator(".poster-title", { hasText: "Direct MP4" })).toHaveCount(0);
    await page.getByLabel("Search", { exact: true }).fill("no-such-title");
    await expect(page.getByRole("heading", { name: /No results/ })).toBeVisible({ timeout: 15000 });
  });

  test("details show metadata, and series show episodes", async ({ page }) => {
    await page.goto("/#/detail/movie/e2e-movie-0");
    await expect(page.locator(".detail-title")).toHaveText("Direct MP4");
    await expect(page.locator(".detail-desc")).toContainText("Automated test title");
    await expect(page.locator(".detail-body")).not.toContainText("null");
    await page.goto("/#/detail/series/e2e-series-1");
    await expect(page.locator(".episode")).toHaveCount(2);
    await expect(page.locator(".episode-text strong").first()).toHaveText("Episode 1");
  });

  test("a saved title appears in the library and syncs", async ({ page, request }) => {
    await page.goto("/#/detail/movie/e2e-movie-3");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "In Library" })).toBeVisible();
    await page.goto("/#/library");
    await expect(page.locator(".screen-library .poster-title", { hasText: "Torrent MP4" })).toBeVisible();
    await expect.poll(async () => (await (await request.get(`${FIXTURE}/__test/state`)).json()).pushes.sync_push_library, { timeout: 15000 }).toBeTruthy();
  });

  test("torrent sources explain that they need the backend", async ({ page }) => {
    await page.goto("/#/detail/movie/e2e-movie-3");
    await page.locator(".detail-actions .btn-primary").click();
    const row = page.locator(".stream-row").first();
    await expect(row).toHaveClass(/is-blocked/, { timeout: 15000 });
    await expect(page.locator(".sheet .notice")).toContainText("streaming backend");
    await row.click();
    await expect(page.locator(".toast")).toContainText("Settings");
    await expect(page.locator(".player-video")).toHaveCount(0);
  });

  test("a reload stays on the same screen", async ({ page }) => {
    await page.goto("/#/detail/series/e2e-series-1");
    await expect(page.locator(".episode")).toHaveCount(2);
    await page.reload();
    await page.getByRole("button", { name: "Account Owner" }).click();
    await expect(page.locator(".episode")).toHaveCount(2);
    expect(page.url()).toContain("/detail/series/e2e-series-1");
  });

  test("the page never scrolls sideways", async ({ page }) => {
    for (const route of ["home", "search", "library", "settings/addons", "settings/streaming", "detail/movie/e2e-movie-0", "detail/series/e2e-series-1"]) {
      await page.goto(`/#/${route}`);
      await page.waitForTimeout(800);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, route).toBeLessThanOrEqual(0);
    }
  });
});

test.describe("managing things", () => {
  test("an addon can be added, disabled, updated, reordered and removed", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto("/");
    await page.getByRole("button", { name: "Continue without an account" }).click();
    await expect(page.locator(".nav-item.is-active:visible")).toHaveText(/Home/);
    await page.goto("/#/settings/addons");

    await page.getByLabel("Addon URL").fill(`${FIXTURE}/addon/manifest.json`);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const row = page.locator(".addon-row", { hasText: "E2E Test Addon" });
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".addon-text strong").last()).toHaveText("E2E Test Addon");

    await page.getByRole("button", { name: "Move E2E Test Addon up" }).click();
    await expect(page.locator(".addon-text strong").nth(1)).toHaveText("E2E Test Addon");

    await page.getByRole("button", { name: "Update E2E Test Addon" }).click();
    await expect(page.locator(".toast")).toHaveText("Addon updated");

    await page.getByLabel("Enable E2E Test Addon").uncheck({ force: true });
    await expect(row).toHaveClass(/is-disabled/);

    await page.getByRole("button", { name: "Remove E2E Test Addon" }).click();
    await expect(row).toHaveCount(0);
  });

  test("a bad addon URL gets a clear message and nothing is added", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Continue without an account" }).click();
    await expect(page.locator(".nav-item.is-active:visible")).toHaveText(/Home/);
    await page.goto("/#/settings/addons");
    await expect(page.locator(".addon-row").first()).toBeVisible({ timeout: 15000 });
    const before = await page.locator(".addon-row").count();
    await page.getByLabel("Addon URL").fill(`${FIXTURE}/not-an-addon/manifest.json`);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.locator(".toast")).toContainText("Couldn't add");
    await expect(page.locator(".addon-row")).toHaveCount(before);
  });

  test("marking an episode watched sticks and syncs", async ({ page, request }) => {
    await signIn(page, request);
    await enterProfile(page);
    await page.goto("/#/detail/series/e2e-series-1");
    await page.getByRole("button", { name: "Mark as watched" }).first().click();
    await expect(page.locator(".episode").first()).toHaveClass(/is-watched/);
    await expect.poll(async () => (await (await request.get(`${FIXTURE}/__test/state`)).json()).pushes.sync_push_watched_items, { timeout: 15000 }).toBeTruthy();
    await page.getByRole("button", { name: "Mark as unwatched" }).first().click();
    await expect(page.locator(".episode").first()).not.toHaveClass(/is-watched/);
  });

  test("a profile can be added and synced", async ({ page, request }) => {
    await signIn(page, request);
    await page.getByRole("button", { name: "Add Profile" }).click();
    await page.getByLabel("Profile name").fill("Kids");
    await page.locator(".sheet").getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".profile-name", { hasText: "Kids" })).toBeVisible();
    await expect.poll(async () => JSON.stringify((await (await request.get(`${FIXTURE}/__test/state`)).json()).pushes.sync_push_profiles || ""), { timeout: 15000 }).toContain("Kids");
  });

  test("changing the accent applies immediately", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Continue without an account" }).click();
    await expect(page.locator(".nav-item.is-active:visible")).toHaveText(/Home/);
    await page.goto("/#/settings/appearance");
    const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--secondary-color").trim());
    const before = await accent();
    await page.getByRole("button", { name: "crimson" }).click();
    await expect.poll(accent).not.toBe(before);
  });
});

test.describe("playback", () => {
  test.beforeEach(async ({ page, request }) => {
    await signIn(page, request);
    await enterProfile(page);
  });

  test("direct MP4 plays, seeks, reports progress and resumes", async ({ page, request }) => {
    await openStream(page, "e2e-movie-0");
    await expectPlaying(page);
    await page.locator(".player-video").evaluate((video) => { video.currentTime = 40; });
    await expectPlaying(page, { atLeast: 40.5 });

    await page.locator(".player-top .icon-btn").click({ force: true });
    await expect(page.locator(".player-video")).toHaveCount(0);
    await expect.poll(async () => (await (await request.get(`${FIXTURE}/__test/state`)).json()).pushes.sync_push_watch_progress, { timeout: 20000 }).toBeTruthy();

    await page.goto("/#/home");
    const continueCard = page.locator(".continue-card", { hasText: "Direct MP4" });
    await expect(continueCard).toBeVisible();
    expect(await continueCard.locator(".continue-bar > span").evaluate((bar) => parseFloat(bar.style.width))).toBeGreaterThan(30);

    await page.goto("/#/detail/movie/e2e-movie-0");
    await expect(page.locator(".detail-actions .btn-primary")).toContainText("Resume");
    await page.locator(".detail-actions .btn-primary").click();
    await page.locator(".stream-row").first().click();
    await expect.poll(() => page.locator(".player-video").evaluate((video) => video.currentTime), { timeout: 20000 }).toBeGreaterThan(35);
  });

  test("HLS plays through hls.js outside Apple devices, even where the browser claims native HLS", async ({ page }) => {
    await openStream(page, "e2e-movie-1");
    await expectPlaying(page);
    expect(await page.locator(".player-video").evaluate((video) => video.currentSrc)).toMatch(/^blob:/);
  });

  test("subtitles load, display and shift with the timing control", async ({ page }) => {
    await openStream(page, "e2e-movie-0");
    await expectPlaying(page, { atLeast: 0.2 });
    await page.mouse.move(100, 100);
    await page.locator(".player-gestures").click({ position: { x: 150, y: 150 } }).catch(() => null);
    await page.getByRole("button", { name: "Subtitles" }).click({ force: true });
    await page.locator(".picker-item", { hasText: "English" }).click();
    await expect(page.locator(".player-sub-line")).toHaveText("Nuvio test subtitle line", { timeout: 10000 });

    // A 30 second delay means the first cue is still showing later than it otherwise would.
    await page.locator(".player-video").evaluate((video) => { video.pause(); video.currentTime = 30.5; });
    await page.waitForTimeout(300);
    await expect(page.locator(".player-subs")).not.toContainText("Nuvio test subtitle line");
    await page.getByRole("button", { name: "Subtitles" }).click({ force: true });
    const later = page.getByRole("button", { name: "Show subtitles later" });
    for (let step = 0; step < 4; step += 1) await later.click();
    await expect(page.locator(".delay-value")).toHaveText("2.0s");
    await expect(page.locator(".player-sub-line")).toHaveText("Nuvio test subtitle line");
  });

  test("an unplayable source shows a useful error", async ({ page }) => {
    await page.route("**/media/direct.mp4", (route) => route.fulfill({ status: 200, contentType: "video/mp4", body: "not a video" }));
    await openStream(page, "e2e-movie-0");
    await expect(page.locator(".player-error")).toContainText(/format|decoded/, { timeout: 15000 });
    await expect(page.getByRole("button", { name: "Choose another source" })).toBeVisible();
  });

  test("leaving the player tears down the video", async ({ page }) => {
    await openStream(page, "e2e-movie-0");
    await expectPlaying(page, { atLeast: 0.2 });
    await page.goto("/#/home");
    await expect(page.locator(".player-video")).toHaveCount(0);
    await expect(page.locator("html")).not.toHaveClass(/player-active/);
  });
});

test.describe("playback through the backend", () => {
  test.beforeEach(async ({ page, request }) => {
    await signIn(page, request);
    await enterProfile(page);
    await connectBackend(page);
  });

  test("the access key is exchanged and never stored", async ({ page }) => {
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    expect(stored).not.toContain(BACKEND_KEY);
    expect(stored).toContain("webBackendConfig");
  });

  test("MKV with AC3 audio is remuxed to HLS, plays and seeks past what's converted", async ({ page }) => {
    await openStream(page, "e2e-movie-2");
    await expectPlaying(page);
    await expect(page.locator(".player-time").last()).toHaveText("1:30");

    await page.getByRole("button", { name: "Playback details" }).click({ force: true });
    await expect(page.locator(".details-list")).toContainText("Converted by backend");
    await expect(page.locator(".details-list")).toContainText("h264");
    await page.locator(".sheet-head .icon-btn").click();

    await page.getByRole("button", { name: "Audio" }).click({ force: true });
    await expect(page.locator(".picker-item")).toContainText("AC3");
    await page.locator(".sheet-head .icon-btn").click();

    await page.locator(".player-scrubber").evaluate((input) => {
      input.value = "800";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect.poll(() => page.locator(".player-time").first().textContent(), { timeout: 30000 }).toMatch(/1:1\d/);
    await expectPlaying(page, { atLeast: 0.2 });
  });

  test("a torrent with a browser-ready MP4 streams from the swarm", async ({ page }) => {
    await openStream(page, "e2e-movie-3");
    await expectPlaying(page);
    await expect(page.locator(".player-video")).toHaveJSProperty("error", null);
    const src = await page.locator(".player-video").evaluate((video) => video.currentSrc);
    expect(src).toContain(`${BACKEND}/v1/media/`);
  });

  test("a torrent with MKV is remuxed and plays", async ({ page }) => {
    await openStream(page, "e2e-movie-4");
    await expectPlaying(page);
  });

  test("leaving releases the backend session", async ({ page, request }) => {
    await openStream(page, "e2e-movie-0");
    await page.goto("/#/home");
    await page.goto("/#/detail/movie/e2e-movie-3");
    await page.locator(".detail-actions .btn-primary").click();
    await page.locator(".stream-row").first().click();
    await expectPlaying(page);
    const deleted = page.waitForRequest((candidate) => candidate.method() === "DELETE" && candidate.url().includes("/v1/playback/"));
    await page.goto("/#/home");
    await deleted;
    void request;
  });
});

test.describe("PWA", () => {
  test("the manifest, icons and service worker meet install requirements", async ({ page, request }) => {
    await page.goto("/");
    const manifest = await (await request.get("/manifest.webmanifest")).json();
    expect(manifest.display).toBe("standalone");
    expect(manifest.name).toBe("Nuvio");
    expect(manifest.start_url).toBeTruthy();
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const icon of manifest.icons) expect((await request.get(`/${icon.src}`)).status(), icon.src).toBe(200);
    expect((await request.get("/icons/icon-180.png")).status()).toBe(200);

    for (const selector of ['link[rel="manifest"]', 'link[rel="apple-touch-icon"]', 'meta[name="apple-mobile-web-app-capable"]']) {
      await expect(page.locator(selector)).toHaveCount(1);
    }
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);

    await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.ready)?.active)), { timeout: 15000 }).toBe(true);
  });

  test("the service worker caches the shell only, never account or media data", async ({ page, request }) => {
    await signIn(page, request);
    await enterProfile(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForTimeout(1500);
    const cached = await page.evaluate(async () => {
      const urls = [];
      for (const key of await caches.keys()) {
        for (const entry of await (await caches.open(key)).keys()) urls.push(entry.url);
      }
      return urls;
    });
    expect(cached.length).toBeGreaterThan(3);
    for (const url of cached) {
      expect(new URL(url).origin, url).toBe("http://localhost:6200");
      expect(url).not.toMatch(/\/rest\/|\/auth\/|\/media\/|\.m3u8/);
    }
  });

  test("the app shell still opens offline", async ({ page, context, request }) => {
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForTimeout(800);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator(".login").first()).toBeVisible({ timeout: 15000 });
    await context.setOffline(false);
    void request;
  });
});
