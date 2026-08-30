import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env.CI);
const useProductionServer =
  isCI || process.env.PLAYWRIGHT_USE_PRODUCTION === "1";

export default defineConfig({
  testDir: "./tests",
  testIgnore: ["**/live/**"],
  // Keep ordinary Playwright cleanup away from persistent live-run manifests
  // stored under test-results/live/<run-id>.
  outputDir: "test-results/playwright",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : "html",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
    ...(isCI
      ? [
          { name: "firefox", use: { ...devices["Desktop Firefox"] } },
          { name: "webkit", use: { ...devices["Desktop Safari"] } },
        ]
      : []),
  ],
  webServer: {
    command: useProductionServer ? "npm run start" : "npm run dev",
    url: process.env.BASE_URL ?? "http://localhost:3000",
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
