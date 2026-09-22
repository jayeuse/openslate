import { defineConfig } from "@playwright/test";

const baseURL = process.env.BASE_URL;
if (!baseURL)
  throw new Error("BASE_URL is required for the full-stack gateway suite");

let target: URL;
try {
  target = new URL(baseURL);
  if (
    target.protocol !== "https:" ||
    target.hostname !== "localhost" ||
    !target.port
  )
    throw new Error();
} catch {
  throw new Error("BASE_URL must be an HTTPS localhost origin with a port");
}

if (!process.env.OPENSLATE_FULLSTACK_FIXTURE)
  throw new Error("OPENSLATE_FULLSTACK_FIXTURE is required");
if (!process.env.OPENSLATE_FULLSTACK_RUN_ID)
  throw new Error("OPENSLATE_FULLSTACK_RUN_ID is required");

export default defineConfig({
  testDir: "./tests/fullstack",
  outputDir: "test-results/fullstack",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: true,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: target.origin,
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: "chromium" }],
});
