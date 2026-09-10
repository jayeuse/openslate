import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env.CI);
const useProductionServer =
  process.env.SCANNER_COVERAGE !== "1" &&
  (isCI || process.env.PLAYWRIGHT_USE_PRODUCTION === "1");
function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// Editor discovery loads this file directly, without the npm launcher. Its
// local profile is synthetic test data; explicit process configuration stays strict.
const hasExplicitConfiguration = [
  "PLAYWRIGHT_CONFIGURATION",
  "TEST_LAYER",
  "BASE_URL",
].some((name) => process.env[name] !== undefined);
const localProfile = !isCI && !hasExplicitConfiguration;
const configurationMode = localProfile
  ? "synthetic"
  : requiredEnvironment("PLAYWRIGHT_CONFIGURATION");
if (!["synthetic", "process"].includes(configurationMode))
  throw new Error("PLAYWRIGHT_CONFIGURATION must be synthetic or process");
const testLayer = localProfile ? "all" : requiredEnvironment("TEST_LAYER");
if (!["all", "isolated", "http", "browser"].includes(testLayer))
  throw new Error("TEST_LAYER must be all, isolated, http, or browser");
const baseURL = localProfile
  ? "http://127.0.0.1:3104"
  : requiredEnvironment("BASE_URL");
let target: URL;
try {
  target = new URL(baseURL);
  if (!["http:", "https:"].includes(target.protocol) || !target.port)
    throw new Error();
} catch {
  throw new Error("BASE_URL must be an absolute HTTP(S) URL with a port");
}
const syntheticEnvironment = {
  BACKEND_URL: "http://backend.invalid",
  SUPABASE_SERVER_URL: "http://supabase.invalid",
  LOG_DIR: "/tmp/openslate-frontend-logs",
  BFF_REQUEST_BODY_LIMIT_BYTES: "1048576",
  BFF_RESPONSE_BODY_LIMIT_BYTES: "8388608",
  BFF_REQUEST_DEADLINE_MS: "60000",
  PORT: target.port,
  HOSTNAME: target.hostname,
  NEXT_PUBLIC_SUPABASE_URL: "http://supabase.invalid",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable-key",
  NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED: "false",
};
const frontendEnvironment: Record<string, string> =
  configurationMode === "synthetic"
    ? syntheticEnvironment
    : Object.fromEntries(
        Object.keys(syntheticEnvironment).map((name) => [
          name,
          requiredEnvironment(name),
        ]),
      );
Object.assign(process.env, frontendEnvironment);

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
    baseURL,
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
            useProductionServer
              ? "npm run start -- --from-process"
              : "npm run dev -- --from-process",
          ),
          url: baseURL,
          env: frontendEnvironment,
          reuseExistingServer: !isCI,
          timeout: 120_000,
        },
});
