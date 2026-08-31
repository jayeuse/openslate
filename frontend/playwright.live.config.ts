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
const frontendEnvironment: Record<string, string> = {
  BACKEND_URL: apiOrigin,
};
const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const supabasePublishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.SUPABASE_PUBLISHABLE_KEY;
if (supabaseUrl !== undefined) {
  frontendEnvironment.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl;
}
if (supabasePublishableKey !== undefined) {
  frontendEnvironment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
    supabasePublishableKey;
}
if (process.env.NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED !== undefined) {
  frontendEnvironment.NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED =
    process.env.NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED;
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

const serverCommand = isolatedCommand(
  `npm run dev -- --hostname ${shellQuote(uiHostname)} --port ${shellQuote(uiPort)}`,
);

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
    env: frontendEnvironment,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
