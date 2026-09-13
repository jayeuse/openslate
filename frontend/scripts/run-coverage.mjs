import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  boundedCoverageWorkers,
  createCoveragePlan,
  generate,
  generateDenominator,
  hash,
  inventory,
  mergeCoverageReports,
  root,
  validateCaptureManifest,
  validateCoveragePlan,
  validateCoverageShard,
} from "./coverage-report.mjs";

const COVERAGE_SHARD_COUNT = 6;

export function parseCoverageArguments(argumentsList) {
  const options = {
    mode: "run",
    planPath: null,
    outputPath: null,
    shardsPath: null,
    shard: null,
  };
  for (const argument of argumentsList) {
    if (argument === "--plan") {
      options.mode = "plan";
      continue;
    }
    if (argument === "--merge") {
      options.mode = "merge";
      continue;
    }
    if (argument.startsWith("--plan=")) {
      options.planPath = argument.slice("--plan=".length);
      continue;
    }
    if (argument.startsWith("--output=")) {
      options.outputPath = argument.slice("--output=".length);
      continue;
    }
    if (argument.startsWith("--shards=")) {
      options.shardsPath = argument.slice("--shards=".length);
      continue;
    }
    if (argument.startsWith("--shard=")) {
      const match = argument.slice("--shard=".length).match(/^(\d+)\/(\d+)$/);
      if (!match || Number(match[1]) < 1 || Number(match[1]) > Number(match[2]))
        throw new Error("--shard must use a valid 1-based index, such as 1/3");
      options.shard = { index: Number(match[1]), count: Number(match[2]) };
      continue;
    }
    throw new Error(`Unknown coverage option: ${argument}`);
  }
  if (options.mode === "plan" && options.shard)
    throw new Error("--plan cannot be combined with --shard");
  if (options.mode === "merge" && options.shard)
    throw new Error("--merge cannot be combined with --shard");
  if (options.mode === "run" && options.planPath && !options.shard)
    throw new Error("A plan can only be supplied with --shard or --merge");
  if ((options.shard || options.mode === "merge") && !options.planPath)
    throw new Error("--plan=<path> is required for shard and merge modes");
  return options;
}

function revision(root, ref) {
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", `${ref}^{commit}`],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(`Cannot resolve coverage revision: ${ref}`);
  return result.stdout.trim();
}

function sourceHashes(root) {
  return Object.fromEntries(
    inventory()
      .sort()
      .map((path) => [path, hash(readFileSync(resolve(root, path)))])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Missing or invalid ${label}: ${path}`, { cause: error });
  }
}

function recordsEqual(left, right) {
  return (
    JSON.stringify(Object.entries(left).sort()) ===
    JSON.stringify(Object.entries(right).sort())
  );
}

function resolveFromRoot(root, value) {
  return resolve(root, value);
}

function terminateChild(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function runChild(root, argumentsList, env, setActive) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: root,
      env,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    setActive(child);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      setActive(null);
      resolveResult({ code, signal });
    });
  });
}

function compactArtifacts(tempDirectory, outputDirectory) {
  const copied = [];
  const files = [
    ["metadata.json", "metadata.json"],
    ["tests.json", "tests.json"],
    ["discovery.json", "discovery.json"],
    ["gate.json", "gate.json"],
    ["report/coverage-final.json", "report/coverage-final.json"],
    ["report/lcov.info", "report/lcov.info"],
  ];
  for (const [from, to] of files) {
    const source = resolve(tempDirectory, from);
    if (!existsSync(source)) continue;
    const destination = resolve(outputDirectory, to);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    copied.push(to);
  }
  return copied;
}

function coverageEnvironment(root, directory) {
  return {
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
}

function discoveryEnvironment(environment, directory, outputPath) {
  return {
    ...environment,
    // Coverage config remains strict during discovery, but its V8 output is
    // isolated from executable measurement and discarded with the temp run.
    NODE_OPTIONS: "--no-warnings",
    NODE_V8_COVERAGE: resolve(directory, "discovery-node"),
    PLAYWRIGHT_JSON_OUTPUT_FILE: resolve(directory, outputPath),
  };
}

async function discover(
  root,
  environment,
  directory,
  outputPath,
  shard,
  setActive,
) {
  const argumentsList = [
    "scripts/run-playwright.mjs",
    "--list",
    "--reporter=json",
    "--forbid-only",
  ];
  if (shard) argumentsList.push(`--shard=${shard.index}/${shard.count}`);
  const result = await runChild(
    root,
    argumentsList,
    discoveryEnvironment(environment, directory, outputPath),
    setActive ?? (() => undefined),
  );
  if (result.code !== 0 || result.signal)
    throw new Error("Coverage test discovery failed");
  return readJson(resolve(directory, outputPath), "coverage discovery");
}

async function runPlan(root, options) {
  if (!process.env.COVERAGE_BASE_REF)
    throw new Error("COVERAGE_BASE_REF is required");
  const baseRevision = revision(root, process.env.COVERAGE_BASE_REF);
  const headRevision = revision(root, "HEAD");
  const sources = sourceHashes(root);
  const directory = mkdtempSync(join(tmpdir(), "openslate-coverage-plan-"));
  const environment = coverageEnvironment(root, directory);
  try {
    const discovery = await discover(
      root,
      environment,
      directory,
      "discovery.json",
    );
    const shardDiscoveries = [];
    for (let index = 1; index <= COVERAGE_SHARD_COUNT; index++)
      shardDiscoveries.push(
        await discover(
          root,
          environment,
          directory,
          `discovery-${index}.json`,
          { index, count: COVERAGE_SHARD_COUNT },
        ),
      );
    const denominator = await generateDenominator(
      Object.keys(sources).map((path) => ({
        url: path,
        source: readFileSync(resolve(root, path), "utf8"),
      })),
      resolve(directory, "baseline"),
    );
    const plan = createCoveragePlan({
      baseRevision,
      headRevision,
      sources,
      denominator: Object.fromEntries(
        Object.keys(sources).map((path) => [
          path,
          Object.keys(denominator.fileCoverageFor(path).getLineCoverage()).map(
            Number,
          ),
        ]),
      ),
      discovery,
      shardDiscoveries,
    });
    const output = resolveFromRoot(
      root,
      options.outputPath ?? "coverage/coverage-plan.json",
    );
    writeJson(output, plan);
    console.log(
      JSON.stringify(
        { mode: "plan", output, shards: COVERAGE_SHARD_COUNT },
        null,
        2,
      ),
    );
    return 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function runCoverage(root, options) {
  const runId = randomUUID();
  const outputDirectory = resolveFromRoot(
    root,
    options.outputPath ?? `coverage/${runId}`,
  );
  const tempDirectory = mkdtempSync(
    join(tmpdir(), `openslate-coverage-${runId}-`),
  );
  const metadata = {
    runId,
    revision: null,
    baseRef: process.env.COVERAGE_BASE_REF ?? null,
    status: "preflight-failed",
    sources: {},
    ...(options.shard ? { shard: options.shard } : {}),
  };
  mkdirSync(outputDirectory, { recursive: true });
  let activeChild = null;
  let interrupted = false;
  const save = () => {
    writeJson(resolve(outputDirectory, "metadata.json"), metadata);
    if (!options.shard)
      writeJson(resolve(root, "coverage", "latest.json"), {
        directory: outputDirectory,
        ...metadata,
      });
  };
  const signalHandler = (signal) => {
    interrupted = true;
    metadata.status = "interrupted";
    metadata.error = `Coverage interrupted by ${signal}`;
    save();
    terminateChild(activeChild, "SIGTERM");
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);
  save();
  let exitCode = 1;
  try {
    if (!process.env.COVERAGE_BASE_REF)
      throw new Error("COVERAGE_BASE_REF is required");
    metadata.baseRef = revision(root, process.env.COVERAGE_BASE_REF);
    metadata.revision = revision(root, "HEAD");
    metadata.sources = sourceHashes(root);
    let plan;
    if (options.shard) {
      plan = readJson(resolveFromRoot(root, options.planPath), "coverage plan");
      validateCoveragePlan(plan);
      if (
        plan.baseRevision !== metadata.baseRef ||
        plan.headRevision !== metadata.revision ||
        JSON.stringify(plan.sources) !== JSON.stringify(metadata.sources) ||
        plan.shards.length !== options.shard.count
      )
        throw new Error(
          "Coverage plan does not match this revision or source tree",
        );
    }
    metadata.status = "running";
    save();
    const environment = coverageEnvironment(root, tempDirectory);
    const discoveryPath = "discovery.json";
    if (!options.shard) {
      const discovery = await discover(
        root,
        environment,
        tempDirectory,
        discoveryPath,
        undefined,
        (child) => {
          activeChild = child;
        },
      );
      metadata.discovery = {
        projects: discovery.config?.projects?.length ?? 0,
      };
    }
    const argumentsList = [
      "scripts/run-playwright.mjs",
      "--reporter=line,json",
      `--workers=${boundedCoverageWorkers()}`,
      "--retries=0",
      "--forbid-only",
      `--output=${resolve(tempDirectory, "playwright")}`,
    ];
    if (options.shard)
      argumentsList.push(
        `--shard=${options.shard.index}/${options.shard.count}`,
      );
    const run = await runChild(root, argumentsList, environment, (child) => {
      activeChild = child;
    });
    if (interrupted) throw new Error("Coverage test run interrupted");
    metadata.status = "tests-failed";
    if (run.code !== 0 || run.signal)
      throw new Error("Coverage test run failed; partial captures cannot pass");
    metadata.status = "measurement-failed";
    for (const [path, digest] of Object.entries(metadata.sources))
      if (hash(readFileSync(resolve(root, path))) !== digest)
        throw new Error(`Source changed during coverage: ${path}`);
    const testReport = readJson(
      resolve(tempDirectory, "tests.json"),
      "coverage test report",
    );
    if (options.shard)
      validateCoverageShard(
        plan,
        testReport,
        options.shard.index,
        tempDirectory,
      );
    else
      validateCaptureManifest(
        tempDirectory,
        testReport,
        readJson(resolve(tempDirectory, discoveryPath), "coverage discovery"),
      );
    const captures = await generate(
      tempDirectory,
      metadata.sources,
      options.shard
        ? {
            projects: plan.shards[options.shard.index - 1].tests.map(
              (test) => test.projectName,
            ),
          }
        : undefined,
    );
    if (interrupted) throw new Error("Coverage measurement interrupted");
    metadata.runtime = { ...captures, sourceMapsValidated: true };
    metadata.tests = testReport.stats;
    if (options.shard) {
      metadata.status = "passed";
      exitCode = 0;
    } else {
      const gate = spawnSync(
        "python3",
        [
          "../scripts/check_coverage.py",
          "--project",
          "frontend",
          "--report",
          resolve(tempDirectory, "report/coverage-final.json"),
          "--base-ref",
          metadata.baseRef,
          "--output",
          resolve(tempDirectory, "gate.json"),
        ],
        { cwd: root, encoding: "utf8" },
      );
      const result = JSON.parse(gate.stdout || "{}");
      metadata.status = gate.status === 0 ? "passed" : "threshold-failed";
      if (result.error) {
        metadata.status = "measurement-failed";
        throw new Error(result.error);
      }
      console.log(
        JSON.stringify(
          {
            directory: outputDirectory,
            status: metadata.status,
            overall: result.overall,
            changed: result.changed,
          },
          null,
          2,
        ),
      );
      exitCode = gate.status ?? 1;
    }
  } catch (error) {
    if (!interrupted) {
      metadata.error = error instanceof Error ? error.message : String(error);
      console.error(metadata.error);
    }
  } finally {
    if (interrupted) metadata.status = "interrupted";
    if (metadata.status === "running") metadata.status = "failed";
    metadata.artifacts = compactArtifacts(tempDirectory, outputDirectory);
    save();
    rmSync(tempDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    process.off("SIGINT", signalHandler);
    process.off("SIGTERM", signalHandler);
  }
  return exitCode;
}

async function runMerge(root, options) {
  const planPath = resolveFromRoot(root, options.planPath);
  const plan = readJson(planPath, "coverage plan");
  validateCoveragePlan(plan);
  const currentRevision = revision(root, "HEAD");
  const currentSources = sourceHashes(root);
  if (
    plan.headRevision !== currentRevision ||
    !recordsEqual(plan.sources, currentSources)
  )
    throw new Error("Coverage plan does not match the current checkout");
  const shardsRoot = resolveFromRoot(root, options.shardsPath ?? "coverage");
  const shardDirectories = plan.shards.map((shard) =>
    resolve(shardsRoot, `shard-${shard.index}-of-${shard.count}`),
  );
  const outputDirectory = resolveFromRoot(
    root,
    options.outputPath ?? "coverage/merged",
  );
  const merged = mergeCoverageReports({
    plan,
    shardDirectories,
    outputDirectory,
    currentRevision,
    currentSources,
  });
  const gate = spawnSync(
    "python3",
    [
      "../scripts/check_coverage.py",
      "--project",
      "frontend",
      "--report",
      merged.report,
      "--base-ref",
      plan.baseRevision,
      "--output",
      resolve(outputDirectory, "gate.json"),
    ],
    { cwd: root, encoding: "utf8" },
  );
  const result = JSON.parse(gate.stdout || "{}");
  const metadata = {
    runId: randomUUID(),
    revision: plan.headRevision,
    baseRef: plan.baseRevision,
    status: gate.status === 0 ? "passed" : "threshold-failed",
    sources: plan.sources,
    shard: { count: plan.shards.length },
    artifacts: ["coverage-final.json", "gate.json", "plan.json", "tests.json"],
  };
  writeJson(resolve(outputDirectory, "plan.json"), plan);
  writeJson(resolve(outputDirectory, "tests.json"), {
    projects: plan.projects,
    tests: plan.tests,
    shards: plan.shards,
  });
  if (result.error) {
    metadata.status = "measurement-failed";
    metadata.error = result.error;
  }
  writeJson(resolve(outputDirectory, "metadata.json"), metadata);
  writeJson(resolve(root, "coverage", "latest.json"), {
    directory: outputDirectory,
    ...metadata,
  });
  console.log(
    JSON.stringify(
      { mode: "merge", directory: outputDirectory, ...result },
      null,
      2,
    ),
  );
  return result.error ? 1 : (gate.status ?? 1);
}

export async function main(argumentsList = process.argv.slice(2)) {
  const options = parseCoverageArguments(argumentsList);
  if (options.mode === "plan") return runPlan(root, options);
  if (options.mode === "merge") return runMerge(root, options);
  return runCoverage(root, options);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(resolve(process.argv[1])) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
