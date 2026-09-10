import { spawn } from "node:child_process";

const layer = process.env.TEST_LAYER;
const baseUrl = process.env.BASE_URL;
const configurationMode = process.env.PLAYWRIGHT_CONFIGURATION;
if (!layer || !["all", "isolated", "http", "browser"].includes(layer))
  throw new Error("TEST_LAYER must be all, isolated, http, or browser");
if (!baseUrl) throw new Error("BASE_URL is required");
if (!configurationMode || !["synthetic", "process"].includes(configurationMode))
  throw new Error("PLAYWRIGHT_CONFIGURATION must be synthetic or process");

const playwright = spawn(
  process.execPath,
  ["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)],
  { env: process.env, stdio: "inherit" },
);
playwright.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
