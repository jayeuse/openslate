import { defineConfig } from "@playwright/test";

const isCI = Boolean(process.env.CI);
const explicitConfiguration = [
  "PLAYWRIGHT_CONFIGURATION",
  "TEST_LAYER",
  "BASE_URL",
].some((name) => process.env[name] !== undefined);
const localProfile = !isCI && !explicitConfiguration;
const configurationMode = localProfile
  ? "synthetic"
  : process.env.PLAYWRIGHT_CONFIGURATION;
if (!configurationMode || !["synthetic", "process"].includes(configurationMode))
  throw new Error("PLAYWRIGHT_CONFIGURATION must be synthetic or process");

const testLayer = localProfile ? "all" : process.env.TEST_LAYER;
if (!testLayer || !["all", "isolated", "http"].includes(testLayer))
  throw new Error("TEST_LAYER must be all, isolated, or http");
const browserMatrix = process.env.HTTP_BROWSER_MATRIX;
if (browserMatrix !== undefined && browserMatrix !== "all")
  throw new Error("HTTP_BROWSER_MATRIX must be all when set");
const httpBrowsers =
  browserMatrix === "all"
    ? (["chromium", "firefox", "webkit"] as const)
    : (["chromium"] as const);

const baseURL = localProfile ? "http://127.0.0.1:3104" : process.env.BASE_URL;
if (!baseURL) throw new Error("BASE_URL is required");
let target: URL;
try {
  target = new URL(baseURL);
  if (!["http:", "https:"].includes(target.protocol) || !target.port)
    throw new Error();
} catch {
  throw new Error("BASE_URL must be an absolute HTTP(S) URL with a port");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const syntheticEnvironment = {
  FRONTEND_DEV_PORT: target.port,
  BACKEND_BIND_HOST: "127.0.0.1",
  BACKEND_PORT: "1",
  PUBLIC_ORIGIN: target.origin,
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
  outputDir: "test-results/playwright",
  fullyParallel: true,
  // CI runners for this private repository have 2 CPUs, where Playwright's
  // default (half the CPUs) is 1 worker and the suite outgrows the job.
  workers: isCI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  forbidOnly: isCI,
  retries: 0,
  reporter: "line",
  use: { baseURL },
  projects: [
    ...(testLayer === "all" || testLayer === "isolated"
      ? [{ name: "isolated", testDir: "./tests/isolated" }]
      : []),
    ...(testLayer === "all" || testLayer === "http"
      ? httpBrowsers.map((browserName) => ({
          name: browserName === "chromium" ? "http" : `http-${browserName}`,
          testDir: "./tests/http",
          use: { browserName },
        }))
      : []),
  ],
  globalSetup: testLayer === "isolated" ? undefined : "./tests/warm-routes.ts",
  webServer:
    testLayer === "isolated"
      ? undefined
      : {
          command: isolatedCommand("npm run dev"),
          url: baseURL,
          env: frontendEnvironment,
          reuseExistingServer: !isCI,
          timeout: 120_000,
        },
});
