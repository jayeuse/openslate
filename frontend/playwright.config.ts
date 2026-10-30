import { existsSync, readdirSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

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

// Browser tests run against the production build: the `next build` output
// (`out/`) served through the production static-site code, with its routing
// and CSP (backend/tests/static_export_server.py). `next dev` differs in ways
// that hid real bugs (no CSP, Strict Mode double effects), so it is opt-in
// for quick local loops only: PLAYWRIGHT_HTTP_SERVER=dev.
const httpServer = process.env.PLAYWRIGHT_HTTP_SERVER ?? "export";
if (!["dev", "export"].includes(httpServer))
  throw new Error("PLAYWRIGHT_HTTP_SERVER must be dev or export");

function newestModification(path: string): number {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.mtimeMs;
  return readdirSync(path).reduce(
    (newest, entry) => Math.max(newest, newestModification(join(path, entry))),
    stats.mtimeMs,
  );
}

// A stale export would test old code; refuse it instead of passing quietly.
if (testLayer !== "isolated" && httpServer === "export") {
  const exportIndex = join(__dirname, "out", "index.html");
  if (!existsSync(exportIndex))
    throw new Error("No static export in out/; run `npm run build` first");
  const sources = ["src", "public", "next.config.ts", "package-lock.json"].map(
    (name) => newestModification(join(__dirname, name)),
  );
  if (Math.max(...sources) > statSync(exportIndex).mtimeMs)
    throw new Error(
      "out/ is older than the frontend sources; run `npm run build` first",
    );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isolatedCommand(command: string): string {
  const path = process.env.PATH;
  const pathAssignment = path === undefined ? [] : [`PATH=${shellQuote(path)}`];
  // uv needs HOME for its cache; the export server reads no other environment.
  const home = process.env.HOME;
  if (httpServer === "export" && home !== undefined)
    pathAssignment.push(`HOME=${shellQuote(home)}`);
  const environment = Object.entries(frontendEnvironment).map(
    ([name, value]) => `${name}=${shellQuote(value)}`,
  );
  return ["env", "-i", ...pathAssignment, ...environment, command].join(" ");
}

// Wall-clock measurements run alone: on a shared CPU other workers' tasks land
// inside the measured interval. The measure project starts after every other
// project in the same run; target it with `--project=measure --no-deps`.
const measuredSpecs = /comms-timeline-performance\.spec\.ts$/;
const httpProjects =
  testLayer === "all" || testLayer === "http"
    ? httpBrowsers.map((browserName) => ({
        name: browserName === "chromium" ? "http" : `http-${browserName}`,
        testDir: "./tests/http",
        testIgnore: measuredSpecs,
        use: { browserName },
      }))
    : [];

export default defineConfig({
  testDir: "./tests",
  outputDir: "test-results/playwright",
  fullyParallel: true,
  // CI parallelism comes from shards: one worker per shard keeps the browser
  // from starving beside `next dev` (measured on the old 2-vCPU runners; public
  // repositories now get 4 vCPU, so re-measure before changing it). Three local
  // workers reduce measured memory pressure on the 16 GiB development machine;
  // CLI --workers still overrides.
  workers: isCI ? 1 : Math.min(3, availableParallelism()),
  timeout: 30_000,
  expect: { timeout: 5_000 },
  forbidOnly: isCI,
  // One retry in CI only (docs/plans/ci-stability.md D1): local runs and the
  // pre-push gate keep zero, and frontend-verify fails on a retried test that
  // has no entry in tests/flaky.json, or whose entry has expired.
  retries: isCI ? 1 : 0,
  reporter: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME
    ? [["line"], ["json"]]
    : "line",
  // CI runs in UTC and en-US; pin both so a local run cannot pass only
  // because this machine's zone or language matches a test fixture.
  use: {
    baseURL,
    timezoneId: "UTC",
    locale: "en-US",
    // Keep a trace for every failure, locally and in CI, so a failure that
    // happens on one side can be read on the other.
    trace: "retain-on-failure",
  },
  projects: [
    ...(testLayer === "all" || testLayer === "isolated"
      ? [{ name: "isolated", testDir: "./tests/isolated" }]
      : []),
    ...httpProjects,
    ...(httpProjects.length
      ? [
          {
            name: "measure",
            testDir: "./tests/http",
            testMatch: measuredSpecs,
            use: { browserName: "chromium" as const },
            workers: 1,
            // A second attempt would hide a slow first measurement.
            retries: 0,
            dependencies: [
              ...(testLayer === "all" ? ["isolated"] : []),
              ...httpProjects.map((project) => project.name),
            ],
          },
        ]
      : []),
  ],
  globalSetup:
    testLayer === "isolated" || httpServer === "export"
      ? undefined
      : "./tests/warm-routes.ts",
  webServer:
    testLayer === "isolated"
      ? undefined
      : {
          command: isolatedCommand(
            httpServer === "export"
              ? `uv run --directory ../backend python -m tests.static_export_server --root ../frontend/out --port ${target.port}`
              : "npm run dev",
          ),
          url: baseURL,
          env: frontendEnvironment,
          reuseExistingServer: !isCI,
          timeout: 120_000,
        },
});
