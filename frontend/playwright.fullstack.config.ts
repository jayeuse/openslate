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

// The release smoke suite (backend/tests/smoke_runner.py) reads seeded Harbor data and
// signs in once per role; the acceptance suite keeps its own fixture and never runs it.
const smoke = process.env.OPENSLATE_FULLSTACK_SUITE === "smoke";
if (smoke && !process.env.OPENSLATE_SMOKE_STATE_DIR)
  throw new Error("OPENSLATE_SMOKE_STATE_DIR is required for the smoke suite");

export default defineConfig({
  testDir: smoke ? "./tests/fullstack/smoke" : "./tests/fullstack",
  testIgnore: smoke ? undefined : ["smoke/**"],
  globalSetup: smoke ? "./tests/fullstack/smoke/sign-in.setup.ts" : undefined,
  outputDir: smoke ? "test-results/smoke" : "test-results/fullstack",
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
