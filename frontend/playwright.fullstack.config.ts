import { defineConfig, devices } from "@playwright/test";

if (
  process.env.E2E_ALLOW_MUTATIONS !== "true" ||
  !process.env.OPENSLATE_FULLSTACK_FIXTURE ||
  !/^[a-f0-9]{32}$/.test(process.env.OPENSLATE_FULLSTACK_RUN_ID ?? "")
) {
  throw new Error("Run the dedicated disposable full-stack harness.");
}

export default defineConfig({
  testDir: "./tests/fullstack",
  outputDir: "test-results/fullstack",
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [["./tests/fullstack/safe-reporter.ts"]],
  use: {
    baseURL: "http://localhost:3008",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
