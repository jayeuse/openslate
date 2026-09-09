import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env.CI);
const useProductionServer =
  isCI || process.env.PLAYWRIGHT_USE_PRODUCTION === "1";
const frontendEnvironment: Record<string, string> = {};
for (const name of [
  "BACKEND_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED",
] as const) {
  const value = process.env[name];
  if (value !== undefined) frontendEnvironment[name] = value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isolatedCommand(command: string): string {
  const path = process.env.PATH;
  const pathAssignment = path === undefined ? [] : [`PATH=${shellQuote(path)}`];
  const environment = Object.entries(frontendEnvironment).map(
    ([name, value]) => `${name}=${shellQuote(value)}`,
  );
  return ["env", "-i", ...pathAssignment, ...environment, command].join(" ");
}

const testLayer = process.env.TEST_LAYER ?? "all";
if (!["all", "isolated", "http", "browser"].includes(testLayer)) {
  throw new Error("TEST_LAYER must be all, isolated, http, or browser");
}

export default defineConfig({
  testDir: "./tests",
  testIgnore: ["**/fullstack/**"],
  // Keep ordinary cleanup separate from disposable full-stack results.
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
    ...(testLayer === "all" || testLayer === "isolated"
      ? [{ name: "isolated", testDir: "./tests/isolated" }]
      : []),
    ...(testLayer === "all" || testLayer === "http"
      ? [{ name: "http", testDir: "./tests/http" }]
      : []),
    ...(testLayer === "all" || testLayer === "browser"
      ? [
          {
            name: "chromium",
            testDir: "./tests/browser",
            use: { ...devices["Desktop Chrome"] },
          },
          {
            name: "mobile-chromium",
            testDir: "./tests/browser",
            use: { ...devices["Pixel 7"] },
          },
          ...(isCI
            ? [
                {
                  name: "firefox",
                  testDir: "./tests/browser",
                  use: { ...devices["Desktop Firefox"] },
                },
                {
                  name: "webkit",
                  testDir: "./tests/browser",
                  use: { ...devices["Desktop Safari"] },
                },
              ]
            : []),
        ]
      : []),
  ],
  webServer:
    testLayer === "isolated"
      ? undefined
      : {
          command: isolatedCommand(
            useProductionServer ? "npm run start" : "npm run dev",
          ),
          url: process.env.BASE_URL ?? "http://localhost:3000",
          env: frontendEnvironment,
          reuseExistingServer: !isCI,
          timeout: 120_000,
        },
});
