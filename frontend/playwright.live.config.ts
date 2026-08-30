import { defineConfig, devices } from "@playwright/test";
import { chmodSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { getLiveHarnessOrigins } from "./tests/live/support/preflight";

process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

const isCI = Boolean(process.env.CI);
if (isCI) {
  throw new Error("The local-only live harness cannot run in CI");
}

if (process.env.PLAYWRIGHT_USE_PRODUCTION === "1") {
  throw new Error(
    "The local-only live harness must run the reviewed source, not a prebuilt production bundle",
  );
}

process.umask(0o077);
for (const directory of [
  resolve("test-results/live"),
  resolve("test-results/live-playwright"),
]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

const { uiOrigin, apiOrigin } = getLiveHarnessOrigins();
const uiUrl = new URL(uiOrigin);
const uiHostname = uiUrl.hostname;
const uiPort = uiUrl.port;
const serverCommand = `npm run dev -- --hostname ${uiHostname} --port ${uiPort}`;

export default defineConfig({
  testDir: "./tests/live",
  // Keep Playwright's auto-cleaned output separate from persistent run
  // manifests and reports under test-results/live/<run-id>.
  outputDir: "test-results/live-playwright",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  // The approved UI-only seed performs hundreds of serialized mutations.
  timeout: 45 * 60 * 1_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: uiOrigin,
    actionTimeout: 60_000,
    navigationTimeout: 120_000,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: serverCommand,
    url: uiOrigin,
    env: {
      ...process.env,
      BACKEND_URL: apiOrigin,
      HOSTNAME: uiHostname,
      PORT: uiPort,
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
