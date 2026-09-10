import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  root,
  hash,
  inventory,
  generate,
  validateCaptureManifest,
} from "./coverage-report.mjs";

function revision(ref) {
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", `${ref}^{commit}`],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(`Cannot resolve coverage revision: ${ref}`);
  return result.stdout.trim();
}
const metadata = {
  runId: randomUUID(),
  revision: null,
  baseRef: process.env.COVERAGE_BASE_REF ?? null,
  status: "preflight-failed",
  sources: {},
};
const directory = resolve(root, "coverage", metadata.runId);
mkdirSync(directory, { recursive: true });
function save() {
  writeFileSync(
    resolve(directory, "metadata.json"),
    JSON.stringify(metadata, null, 2),
  );
  writeFileSync(
    resolve(root, "coverage", "latest.json"),
    JSON.stringify({ directory, ...metadata }, null, 2),
  );
}
save();
try {
  if (!process.env.COVERAGE_BASE_REF)
    throw new Error("COVERAGE_BASE_REF is required");
  if (process.argv.length > 2)
    throw new Error(
      "Coverage requires the complete suite; test filters are not accepted",
    );
  metadata.baseRef = revision(process.env.COVERAGE_BASE_REF);
  metadata.revision = revision("HEAD");
  metadata.sources = Object.fromEntries(
    inventory().map((path) => [path, hash(readFileSync(resolve(root, path)))]),
  );
  metadata.status = "running";
  save();
  const env = {
    ...process.env,
    FRONTEND_COVERAGE: "1",
    FRONTEND_COVERAGE_BROWSER_DIR: resolve(directory, "browser"),
    NODE_V8_COVERAGE: resolve(directory, "node"),
    NODE_OPTIONS: `--require=${resolve(root, "scripts/coverage-node.cjs")}`,
    TEST_LAYER: "all",
    PLAYWRIGHT_CONFIGURATION: "synthetic",
    BASE_URL: "http://127.0.0.1:3104",
    PLAYWRIGHT_JSON_OUTPUT_FILE: resolve(directory, "tests.json"),
  };
  // Keep collection identical to execution, but isolate discovery coverage
  // outside node/ so it cannot contribute measured application execution.
  const discoveryPath = resolve(directory, "discovery.json");
  const discovery = spawnSync(
    process.execPath,
    [
      "scripts/run-playwright.mjs",
      "--list",
      "--reporter=json",
      "--forbid-only",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...env,
        NODE_OPTIONS: "--no-warnings",
        NODE_V8_COVERAGE: resolve(directory, "discovery-node"),
        PLAYWRIGHT_JSON_OUTPUT_FILE: discoveryPath,
      },
    },
  );
  if (discovery.status !== 0) {
    metadata.status = "discovery-failed";
    throw new Error("Coverage test discovery failed");
  }
  const run = spawnSync(
    process.execPath,
    [
      "scripts/run-playwright.mjs",
      "--reporter=line,json",
      "--workers=1",
      "--retries=0",
      "--forbid-only",
      `--output=${resolve(directory, "playwright")}`,
    ],
    { cwd: root, env, stdio: "inherit" },
  );
  metadata.status = "tests-failed";
  if (run.status !== 0)
    throw new Error("Coverage test run failed; partial captures cannot pass");
  metadata.status = "measurement-failed";
  for (const [path, digest] of Object.entries(metadata.sources))
    if (hash(readFileSync(resolve(root, path))) !== digest)
      throw new Error(`Source changed during coverage: ${path}`);
  const testReport = JSON.parse(readFileSync(resolve(directory, "tests.json")));
  validateCaptureManifest(
    directory,
    testReport,
    JSON.parse(readFileSync(discoveryPath)),
  );
  const captures = await generate(directory, metadata.sources);
  Object.assign(metadata, captures, {
    tests: JSON.parse(readFileSync(resolve(directory, "tests.json"))).stats,
  });
  const gate = spawnSync(
    "python3",
    [
      "../scripts/check_coverage.py",
      "--project",
      "frontend",
      "--report",
      resolve(directory, "report/coverage-final.json"),
      "--base-ref",
      metadata.baseRef,
      "--output",
      resolve(directory, "gate.json"),
    ],
    { cwd: root, encoding: "utf8" },
  );
  const result = JSON.parse(gate.stdout);
  metadata.status = gate.status === 0 ? "passed" : "threshold-failed";
  if (result.error) {
    metadata.status = "measurement-failed";
    throw new Error(result.error);
  }
  console.log(
    JSON.stringify(
      {
        directory,
        status: metadata.status,
        overall: result.overall,
        changed: result.changed,
      },
      null,
      2,
    ),
  );
  process.exitCode = gate.status ?? 1;
} catch (error) {
  metadata.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  save();
}
