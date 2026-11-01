import { defineConfig, devices } from "@playwright/test";

// Edge is used because Playwright's bundled Chromium has no H.264 or AAC decoders, which playback
// tests need. Desktop-browser iPhone emulation checks layout only: it says nothing about real iOS.
export default defineConfig({
  testDir: "web/e2e",
  timeout: 90000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: "http://localhost:6200",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "node web/e2e/fixtures/stack.mjs",
    url: "http://localhost:6200",
    reuseExistingServer: true,
    timeout: 180000,
    stdout: "pipe"
  },
  projects: [
    {
      name: "phone",
      testMatch: "app.spec.mjs",
      use: {
        channel: "msedge",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"
      }
    },
    { name: "desktop", testMatch: "app.spec.mjs", use: { channel: "msedge", viewport: { width: 1440, height: 900 } } },
    // The closest thing to iOS Safari available on this machine, and still not iOS Safari.
    { name: "iphone-webkit", testMatch: "ios-webkit.spec.mjs", use: { ...devices["iPhone 14"] } }
  ]
});
