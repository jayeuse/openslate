import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import CoverageReport from "monocart-coverage-reports";
import istanbul from "istanbul-lib-coverage";

export const root = resolve(import.meta.dirname, "..");
export const hash = (source) =>
  createHash("sha256").update(source).digest("hex");
export function boundedCoverageWorkers(parallelism = availableParallelism()) {
  return Math.min(4, Math.max(1, Math.max(1, parallelism) - 1));
}
export function coverageRuntimeRequirements(projects) {
  const names = new Set(projects);
  return {
    browser: names.has("chromium") || names.has("mobile-chromium"),
    server: [...names].some((name) => name !== "isolated"),
    isolated: names.has("isolated"),
  };
}
export function inventory(directory = resolve(root, "src")) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? inventory(path)
      : /\.tsx?$/.test(path) && !path.endsWith(".d.ts")
        ? [relative(root, path)]
        : [];
  });
}

function manifestKey(projectName, id) {
  return JSON.stringify([projectName, id]);
}

export function collectCoverageManifest(
  value,
  { requireAllProjects = true } = {},
) {
  if (!value || value.errors?.length || !Array.isArray(value.suites))
    throw new Error("Incomplete coverage test report");
  const projects = value.config?.projects?.map((project) => project.name);
  if (!projects?.length || new Set(projects).size !== projects.length)
    throw new Error("Incomplete coverage projects");
  const tests = new Map();
  function visit(suites) {
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          const key = manifestKey(test.projectName, spec.id);
          if (!projects.includes(test.projectName) || tests.has(key))
            throw new Error("Unknown or duplicate coverage test");
          tests.set(key, { ...test, id: spec.id });
        }
      }
      visit(suite.suites ?? []);
    }
  }
  visit(value.suites);
  if (
    requireAllProjects &&
    projects.some(
      (name) => ![...tests.values()].some((test) => test.projectName === name),
    )
  )
    throw new Error("Missing coverage project tests");
  return { projects, tests };
}

function sortedManifestTests(manifest) {
  return [...manifest.tests.values()]
    .map(({ projectName, id }) => ({ projectName, id }))
    .sort((left, right) =>
      manifestKey(left.projectName, left.id).localeCompare(
        manifestKey(right.projectName, right.id),
      ),
    );
}

function assertCoveragePlanShape(plan) {
  if (!plan || plan.version !== 1)
    throw new Error("Unsupported coverage plan version");
  if (!plan.baseRevision || !plan.headRevision)
    throw new Error("Coverage plan revisions are required");
  if (!plan.sources || typeof plan.sources !== "object")
    throw new Error("Coverage plan sources are required");
  const sourcePaths = Object.keys(plan.sources).sort();
  if (!sourcePaths.length)
    throw new Error("Coverage plan source inventory is empty");
  if (
    JSON.stringify(plan.sourceInventory ?? sourcePaths) !==
    JSON.stringify(sourcePaths)
  )
    throw new Error("Coverage plan source inventory mismatch");
  if (
    !Array.isArray(plan.projects) ||
    new Set(plan.projects).size !== plan.projects.length
  )
    throw new Error("Coverage plan projects are invalid");
  if (!Array.isArray(plan.tests) || !plan.tests.length)
    throw new Error("Coverage plan tests are empty");
  const expectedKeys = new Set();
  for (const test of plan.tests) {
    if (
      !test ||
      !plan.projects.includes(test.projectName) ||
      typeof test.id !== "string" ||
      expectedKeys.has(manifestKey(test.projectName, test.id))
    )
      throw new Error("Coverage plan tests are invalid");
    expectedKeys.add(manifestKey(test.projectName, test.id));
  }
  if (!Array.isArray(plan.shards) || !plan.shards.length)
    throw new Error("Coverage plan shards are empty");
  const seen = new Set();
  for (const [position, shard] of plan.shards.entries()) {
    if (
      !shard ||
      shard.index !== position + 1 ||
      shard.count !== plan.shards.length ||
      !Array.isArray(shard.tests)
    )
      throw new Error("Coverage plan shard assignments are invalid");
    for (const test of shard.tests) {
      const key = manifestKey(test.projectName, test.id);
      if (!expectedKeys.has(key) || seen.has(key))
        throw new Error("Coverage plan shard assignments are incomplete");
      seen.add(key);
    }
  }
  if (seen.size !== expectedKeys.size)
    throw new Error("Coverage plan shard assignments are incomplete");
  if (plan.denominator !== undefined) {
    if (!plan.denominator || typeof plan.denominator !== "object")
      throw new Error("Coverage plan denominator is invalid");
    for (const path of sourcePaths) {
      const lines = plan.denominator[path];
      if (
        !Array.isArray(lines) ||
        lines.some((line) => !Number.isInteger(line) || line < 1) ||
        new Set(lines).size !== lines.length
      )
        throw new Error(`Coverage plan denominator is invalid: ${path}`);
    }
    if (
      Object.keys(plan.denominator).some((path) => !sourcePaths.includes(path))
    )
      throw new Error("Coverage plan denominator has an unexpected source");
  }
  return { sourcePaths, expectedKeys };
}

export function validateCoveragePlan(plan) {
  assertCoveragePlanShape(plan);
  return true;
}

export function createCoveragePlan({
  baseRevision,
  headRevision,
  sources,
  denominator,
  discovery,
  shardDiscoveries = [],
}) {
  const full = collectCoverageManifest(discovery);
  const discoveries = shardDiscoveries.length ? shardDiscoveries : [discovery];
  const plan = {
    version: 1,
    baseRevision,
    headRevision,
    sources: Object.fromEntries(
      Object.entries(sources).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    sourceInventory: Object.keys(sources).sort(),
    projects: [...full.projects].sort(),
    tests: sortedManifestTests(full),
    shards: discoveries.map((value, index) => ({
      index: index + 1,
      count: discoveries.length,
      tests: sortedManifestTests(
        collectCoverageManifest(value, { requireAllProjects: false }),
      ),
    })),
  };
  if (denominator !== undefined)
    plan.denominator = Object.fromEntries(
      Object.entries(denominator).map(([path, lines]) => [
        path,
        [...lines].sort((a, b) => a - b),
      ]),
    );
  validateCoveragePlan(plan);
  return plan;
}
export function canonical(path) {
  const decoded = decodeURIComponent(path).replaceAll("\\", "/");
  if (decoded.includes("node_modules") || decoded.startsWith("about:"))
    return null;
  const match = decoded.match(/(?:^|\/)src\/.*?\.tsx?(?=$|\?)/);
  return match ? match[0].replace(/^\//, "").replace(/\?.*$/, "") : null;
}
export function sourceMap(source, scriptUrl) {
  const reference = source.match(
    /^\s*\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/m,
  )?.[1];
  if (!reference) return undefined;
  if (!reference.startsWith("data:"))
    throw new Error(`Unresolved source map: ${reference}`);
  const comma = reference.indexOf(",");
  const map = JSON.parse(
    reference.slice(0, comma).endsWith(";base64")
      ? Buffer.from(reference.slice(comma + 1), "base64").toString()
      : decodeURIComponent(reference.slice(comma + 1)),
  );
  function resolveSources(value) {
    if (value.sections)
      return {
        ...value,
        sections: value.sections.map((section) => ({
          ...section,
          map: resolveSources(section.map),
        })),
      };
    const base = value.sourceRoot
      ? new URL(
          value.sourceRoot.endsWith("/")
            ? value.sourceRoot
            : `${value.sourceRoot}/`,
          scriptUrl,
        ).href
      : scriptUrl;
    return {
      ...value,
      sourceRoot: "",
      sources: value.sources.map((path) => new URL(path, base).href),
    };
  }
  return scriptUrl ? resolveSources(map) : map;
}
export function selectCompleteEntries(entries) {
  const complete = [];
  const partial = [];
  for (const entry of entries) {
    if (
      entry.functions?.some((fn) =>
        fn.ranges.some(
          (range) =>
            range.startOffset === 0 && range.endOffset === entry.source.length,
        ),
      )
    ) {
      validateRanges(entry);
      complete.push(entry);
    } else partial.push(entry);
  }
  const completeSources = new Set(complete.map((entry) => hash(entry.source)));
  for (const entry of partial) {
    if (!completeSources.has(hash(entry.source)))
      throw new Error(`Partial V8 capture: ${entry.url}`);
    // Later precise-coverage snapshots omit the script root. Supply a zero
    // delta for that root, then let the V8 merger combine the actual function
    // deltas. No execution outside those functions is credited by this root.
    const normalized = {
      ...entry,
      functions: [
        {
          functionName: "",
          isBlockCoverage: true,
          ranges: [
            { startOffset: 0, endOffset: entry.source.length, count: 0 },
          ],
        },
        ...entry.functions,
      ],
    };
    validateRanges(normalized);
    complete.push(normalized);
  }
  return { complete, discardedFragments: 0 };
}
export function validateRanges(entry) {
  const ranges = entry.functions?.flatMap((fn) => fn.ranges) ?? [];
  if (
    !ranges.some(
      (range) =>
        range.startOffset === 0 && range.endOffset === entry.source.length,
    )
  )
    throw new Error(`Partial V8 capture: ${entry.url}`);
  if (
    ranges.some(
      (range) =>
        !Number.isInteger(range.startOffset) ||
        !Number.isInteger(range.endOffset) ||
        !Number.isInteger(range.count) ||
        range.count < 0 ||
        range.startOffset < 0 ||
        range.endOffset > entry.source.length ||
        range.startOffset >= range.endOffset,
    )
  )
    throw new Error(`Invalid V8 ranges: ${entry.url}`);
}
function includesSource(map, expected) {
  return map.sections
    ? map.sections.some((section) => includesSource(section.map, expected))
    : map.sources.some((source) => Boolean(expected[canonical(source)]));
}
export function validateMap(map, expected) {
  if (map.sections) {
    for (const section of map.sections) validateMap(section.map, expected);
    return;
  }
  for (const [index, source] of map.sources.entries()) {
    const path = canonical(source);
    if (!path || !expected[path] || source.includes("node_modules")) continue;
    if (
      !expected[path] ||
      typeof map.sourcesContent?.[index] !== "string" ||
      hash(map.sourcesContent[index]) !== expected[path]
    )
      throw new Error(`Missing or stale source-map content: ${path}`);
  }
}
export function transformUntested(entry) {
  const original = entry.source;
  const path = canonical(entry.url);
  if (!path) throw new Error(`Invalid untested source ${entry.url}`);
  const output = ts.transpileModule(original, {
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      sourceMap: true,
      inlineSources: true,
    },
  });
  entry.source = output.outputText.replace(/^\/\/# sourceMappingURL=.*$/m, "");
  if (!JSON.parse(output.sourceMapText).mappings) entry.source = "";
  entry.sourceMap = {
    ...JSON.parse(output.sourceMapText),
    sources: [path],
    sourcesContent: [original],
    sourceRoot: "",
  };
}
export function validateCaptureIds(expectedIds, capturedIds) {
  const expected = new Set(expectedIds);
  const captured = new Set(capturedIds);
  if (
    !expected.size ||
    captured.size !== capturedIds.length ||
    captured.size !== expected.size ||
    [...expected].some((id) => !captured.has(id))
  )
    throw new Error("Missing or duplicate browser test captures");
}

function browserCaptureIds(directory) {
  const browserDirectory = resolve(directory, "browser");
  if (!existsSync(browserDirectory)) return [];
  return readdirSync(browserDirectory)
    .filter((file) => file.endsWith(".json") && !file.startsWith("source-"))
    .map(
      (file) =>
        JSON.parse(readFileSync(resolve(browserDirectory, file))).testId,
    );
}

export function validateBrowserCaptureIds(directory, manifestOrReport) {
  const manifest = manifestOrReport.tests
    ? manifestOrReport
    : collectCoverageManifest(manifestOrReport, { requireAllProjects: false });
  const expected = [...manifest.tests.values()]
    .filter((test) =>
      ["chromium", "mobile-chromium"].includes(test.projectName),
    )
    .map((test) => test.id);
  const captured = browserCaptureIds(directory);
  if (!expected.length) {
    if (captured.length) throw new Error("Unexpected browser test captures");
    return;
  }
  if (!existsSync(resolve(directory, "browser")))
    throw new Error("Missing browser captures");
  validateCaptureIds(expected, captured);
}

export function validateCaptureManifest(directory, report, discovery) {
  const required = collectCoverageManifest(discovery);
  const actual = collectCoverageManifest(report);
  if (
    JSON.stringify([...required.projects].sort()) !==
      JSON.stringify([...actual.projects].sort()) ||
    required.tests.size !== actual.tests.size ||
    [...required.tests.keys()].some((key) => !actual.tests.has(key))
  )
    throw new Error("Partial coverage test report");
  for (const test of actual.tests.values()) {
    if (
      test.expectedStatus !== "passed" ||
      test.status !== "expected" ||
      test.results?.length !== 1 ||
      test.results[0].status !== "passed"
    )
      throw new Error(
        `Incomplete coverage test: ${test.projectName}/${test.id}`,
      );
  }
  validateBrowserCaptureIds(directory, actual);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Missing or invalid ${label}: ${path}`, { cause: error });
  }
}

function keysEqual(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function recordsEqual(left, right) {
  return (
    JSON.stringify(Object.entries(left).sort()) ===
    JSON.stringify(Object.entries(right).sort())
  );
}

function validateShardTestManifest(plan, report, shard) {
  const actual = collectCoverageManifest(report, { requireAllProjects: false });
  const expected = new Map(
    shard.tests.map((test) => [manifestKey(test.projectName, test.id), test]),
  );
  if (!keysEqual(actual.tests.keys(), expected.keys()))
    throw new Error(
      `Missing or unexpected coverage tests in shard ${shard.index}`,
    );
  for (const [key, test] of actual.tests) {
    if (test.results?.length !== 1)
      throw new Error(`Retried coverage test: ${key}`);
    if (
      test.expectedStatus !== "passed" ||
      test.status !== "expected" ||
      test.results[0]?.status !== "passed"
    )
      throw new Error(`Failed or skipped coverage test: ${key}`);
  }
  return actual;
}

export function validateCoverageShard(plan, report, shardIndex, directory) {
  const { sourcePaths } = assertCoveragePlanShape(plan);
  if (
    !Number.isInteger(shardIndex) ||
    shardIndex < 1 ||
    shardIndex > plan.shards.length
  )
    throw new Error("Coverage shard index is invalid");
  const shard = plan.shards[shardIndex - 1];
  const manifest = validateShardTestManifest(plan, report, shard);
  if (directory) validateBrowserCaptureIds(directory, manifest);
  return { sourcePaths, shard };
}

function validateRuntimeMetadata(metadata, shard) {
  if (metadata.status !== "passed")
    throw new Error(`Coverage shard ${shard.index} did not pass`);
  const runtime = metadata.runtime ?? {};
  const requirements = coverageRuntimeRequirements([
    ...new Set(shard.tests.map((test) => test.projectName)),
  ]);
  if (
    runtime.requirements &&
    JSON.stringify(runtime.requirements) !== JSON.stringify(requirements)
  )
    throw new Error(
      `Coverage runtime requirements mismatch in shard ${shard.index}`,
    );
  const requiredCounts = {
    browserCaptures: requirements.browser,
    serverEntries: requirements.server,
    isolatedEntries: requirements.isolated,
  };
  if (!Number.isInteger(runtime.nodeEntries) || runtime.nodeEntries < 1)
    throw new Error(`Missing nodeEntries coverage in shard ${shard.index}`);
  for (const [key, required] of Object.entries(requiredCounts)) {
    if (required && (!Number.isInteger(runtime[key]) || runtime[key] < 1))
      throw new Error(`Missing ${key} coverage in shard ${shard.index}`);
  }
  if (runtime.sourceMapsValidated !== true)
    throw new Error(`Missing source-map validation in shard ${shard.index}`);
  return { runtime, requirements };
}

function validateCanonicalReport(plan, data, shardIndex) {
  const { sourcePaths } = assertCoveragePlanShape(plan);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error(`Invalid coverage report in shard ${shardIndex}`);
  if (!keysEqual(Object.keys(data), sourcePaths))
    throw new Error(`Coverage denominator mismatch in shard ${shardIndex}`);
  for (const path of sourcePaths) {
    const entry = data[path];
    const statementMap = entry?.statementMap;
    const counts = entry?.s;
    if (
      !statementMap ||
      !counts ||
      !keysEqual(Object.keys(statementMap), Object.keys(counts))
    )
      throw new Error(`Coverage denominator mismatch for ${path}`);
    const lines = Object.values(statementMap).map(
      (statement) => statement.start.line,
    );
    if (new Set(lines).size !== lines.length)
      throw new Error(`Coverage denominator mismatch for ${path}`);
    if (
      plan.denominator &&
      JSON.stringify([...lines].sort((a, b) => a - b)) !==
        JSON.stringify(plan.denominator[path])
    )
      throw new Error(`Coverage denominator mismatch for ${path}`);
  }
  return data;
}

export function mergeCoverageReports({
  plan,
  shardDirectories,
  outputDirectory,
  currentRevision,
  currentSources,
}) {
  const { sourcePaths } = assertCoveragePlanShape(plan);
  if (
    currentRevision !== undefined &&
    (currentRevision !== plan.headRevision ||
      currentSources === undefined ||
      !recordsEqual(currentSources, plan.sources))
  )
    throw new Error("Coverage plan does not match the current checkout");
  if (
    !Array.isArray(shardDirectories) ||
    shardDirectories.length !== plan.shards.length
  )
    throw new Error("Coverage merge requires every shard");
  const seenShards = new Set();
  const reports = [];
  const runtimeCoverage = [];
  for (const directory of shardDirectories) {
    const metadata = readJson(
      resolve(directory, "metadata.json"),
      "coverage shard metadata",
    );
    const shard = metadata.shard;
    if (
      !shard ||
      shard.count !== plan.shards.length ||
      !Number.isInteger(shard.index) ||
      shard.index < 1 ||
      shard.index > plan.shards.length ||
      seenShards.has(shard.index)
    )
      throw new Error("Missing or duplicate coverage shard");
    seenShards.add(shard.index);
    if (
      metadata.revision !== plan.headRevision ||
      metadata.baseRef !== plan.baseRevision ||
      JSON.stringify(metadata.sources) !== JSON.stringify(plan.sources)
    )
      throw new Error(
        `Mixed coverage revisions or source hashes in shard ${shard.index}`,
      );
    runtimeCoverage.push(
      validateRuntimeMetadata(metadata, plan.shards[shard.index - 1]),
    );
    const testReport = readJson(
      resolve(directory, "tests.json"),
      "coverage shard tests",
    );
    validateShardTestManifest(plan, testReport, plan.shards[shard.index - 1]);
    const report = readJson(
      resolve(directory, "report", "coverage-final.json"),
      "coverage shard report",
    );
    reports.push({
      shard,
      report: validateCanonicalReport(plan, report, shard.index),
    });
  }
  if (seenShards.size !== plan.shards.length)
    throw new Error("Missing or duplicate coverage shard");
  const requiredUnion = coverageRuntimeRequirements([
    ...new Set(
      plan.shards.flatMap((shard) =>
        shard.tests.map((test) => test.projectName),
      ),
    ),
  ]);
  const runtimeField = {
    browser: "browserCaptures",
    server: "serverEntries",
    isolated: "isolatedEntries",
  };
  for (const [category, required] of Object.entries(requiredUnion)) {
    if (
      required &&
      !runtimeCoverage.some(
        ({ requirements, runtime }) =>
          requirements[category] &&
          Number.isInteger(runtime[runtimeField[category]]) &&
          runtime[runtimeField[category]] > 0,
      )
    )
      throw new Error(`Missing ${category} coverage across shard union`);
  }
  reports.sort((left, right) => left.shard.index - right.shard.index);
  const merged = structuredClone(reports[0].report);
  for (const { report } of reports.slice(1)) {
    for (const path of sourcePaths) {
      const target = merged[path];
      const source = report[path];
      if (
        JSON.stringify(target.statementMap) !==
        JSON.stringify(source.statementMap)
      )
        throw new Error(`Coverage denominator mismatch for ${path}`);
      for (const key of Object.keys(target.s))
        target.s[key] = Math.max(target.s[key], source.s[key]);
    }
  }
  mkdirSync(outputDirectory, { recursive: true });
  const output = resolve(outputDirectory, "coverage-final.json");
  writeFileSync(output, JSON.stringify(merged));
  return { shards: reports.length, files: sourcePaths.length, report: output };
}

export async function generate(directory, expected, options = {}) {
  const runtimeRequirements =
    options.requirements ??
    coverageRuntimeRequirements(
      options.projects ?? ["isolated", "http", "chromium", "mobile-chromium"],
    );
  const entries = [];
  const browserDirectory = resolve(directory, "browser");
  const browserFiles = runtimeRequirements.browser
    ? existsSync(browserDirectory)
      ? readdirSync(browserDirectory).filter(
          (file) => file.endsWith(".json") && !file.startsWith("source-"),
        )
      : []
    : [];
  if (runtimeRequirements.browser && !browserFiles.length)
    throw new Error("Missing browser captures");
  const browserSources = new Map();
  for (const file of runtimeRequirements.browser && existsSync(browserDirectory)
    ? readdirSync(browserDirectory).filter((name) => name.startsWith("source-"))
    : []) {
    const source = JSON.parse(readFileSync(resolve(browserDirectory, file)));
    if (
      typeof source.sourceHash !== "string" ||
      typeof source.source !== "string"
    )
      throw new Error(`Invalid browser source body: ${file}`);
    if (
      browserSources.has(source.sourceHash) &&
      browserSources.get(source.sourceHash) !== source.source
    )
      throw new Error(`Ambiguous browser source body: ${source.sourceHash}`);
    browserSources.set(source.sourceHash, source.source);
  }
  for (const file of browserFiles) {
    const capture = JSON.parse(readFileSync(resolve(browserDirectory, file)));
    if (capture.status !== "passed")
      throw new Error(`Incomplete browser capture: ${capture.testId}`);
    for (const entry of capture.entries) {
      if (!expected[canonical(entry.url)]) continue;
      const source =
        typeof entry.source === "string"
          ? entry.source
          : browserSources.get(entry.sourceHash);
      if (typeof source !== "string")
        throw new Error(`Missing browser source body: ${entry.url}`);
      const map =
        typeof source === "string" ? sourceMap(source, entry.url) : undefined;
      if (!map) throw new Error(`Missing browser source map: ${entry.url}`);
      if (!includesSource(map, expected))
        throw new Error(`Missing browser application mapping: ${entry.url}`);
      validateMap(map, expected);
      entries.push({ ...entry, source, sourceMap: map });
    }
  }
  const nodeDirectory = resolve(directory, "node");
  if (!existsSync(nodeDirectory))
    throw new Error("Missing Node coverage captures");
  const files = readdirSync(nodeDirectory);
  const servers = files.filter(
    (file) =>
      file.startsWith("process-") &&
      JSON.parse(
        readFileSync(resolve(nodeDirectory, file)),
      ).entrypoint?.endsWith("next/dist/server/lib/start-server.js"),
  );
  if (
    runtimeRequirements.server &&
    (!servers.length ||
      servers.some(
        (file) =>
          !existsSync(
            resolve(
              nodeDirectory,
              file.replace("process-", "flushed-").replace(".json", ""),
            ),
          ),
      ))
  )
    throw new Error("Missing completed Next server flush");
  const workers = new Set(
    files
      .filter(
        (file) =>
          file.startsWith("process-") &&
          JSON.parse(
            readFileSync(resolve(nodeDirectory, file)),
          ).entrypoint?.endsWith("playwright/lib/worker/workerProcessEntry.js"),
      )
      .map((file) => file.replace("process-", "").replace(".json", "")),
  );
  const capturedProcesses = new Set();
  const sources = new Map();
  const sourceBodies = new Map();
  for (const file of files.filter((file) => file.startsWith("source-"))) {
    const entry = JSON.parse(readFileSync(resolve(nodeDirectory, file)));
    if (entry.pid !== undefined && entry.scriptId !== undefined) {
      const key = `${entry.pid}:${entry.scriptId}`;
      if (sources.has(key) && sources.get(key) !== entry.source)
        throw new Error(`Ambiguous executed source: ${entry.url}`);
      sources.set(key, entry.source);
    } else if (entry.sourceHash && typeof entry.source === "string") {
      if (
        sourceBodies.has(entry.sourceHash) &&
        sourceBodies.get(entry.sourceHash) !== entry.source
      )
        throw new Error(
          `Ambiguous content-addressed source: ${entry.sourceHash}`,
        );
      sourceBodies.set(entry.sourceHash, entry.source);
    }
  }
  for (const file of files.filter((file) => file.startsWith("script-"))) {
    const entry = JSON.parse(readFileSync(resolve(nodeDirectory, file)));
    const source = sourceBodies.get(entry.sourceHash);
    if (source === undefined)
      throw new Error(`Missing executed Node source: ${entry.url}`);
    const key = `${entry.pid}:${entry.scriptId}`;
    if (sources.has(key) && sources.get(key) !== source)
      throw new Error(`Ambiguous executed source: ${entry.url}`);
    sources.set(key, source);
  }
  let nodeEntries = 0;
  let serverEntries = 0;
  let isolatedEntries = 0;
  const uncreditedBootstrap = new Set();
  for (const file of files.filter((file) => file.startsWith("coverage-"))) {
    const pid = file.split("-")[1];
    const processMetadata = JSON.parse(
      readFileSync(resolve(nodeDirectory, `process-${pid}.json`)),
    );
    // The launcher validates config using Node's native TS stripping, outside the application runtimes.
    if (processMetadata.entrypoint?.endsWith("scripts/run-next.mjs")) continue;
    const data = JSON.parse(readFileSync(resolve(nodeDirectory, file)));
    if (Array.isArray(data.result) && data.result.length)
      capturedProcesses.add(pid);
    for (const entry of data.result) {
      if (!canonical(entry.url) || entry.url.includes("node_modules")) continue;
      const source = sources.get(`${pid}:${entry.scriptId}`);
      if (source === undefined)
        throw new Error(`Missing executed Node source: ${entry.url}`);
      const map = sourceMap(source, entry.url);
      if (
        !map &&
        entry.url.startsWith("file:") &&
        canonical(entry.url) === "src/lib/environment.ts"
      ) {
        uncreditedBootstrap.add(entry.url);
        continue;
      }
      if (!map) throw new Error(`Missing Node source map: ${entry.url}`);
      validateMap(map, expected);
      entries.push({ ...entry, source, sourceMap: map });
      nodeEntries++;
      if (
        processMetadata.entrypoint?.endsWith(
          "next/dist/server/lib/start-server.js",
        )
      )
        serverEntries++;
      if (
        processMetadata.entrypoint?.endsWith(
          "playwright/lib/worker/workerProcessEntry.js",
        )
      )
        isolatedEntries++;
    }
  }
  for (const file of runtimeRequirements.server ? servers : []) {
    const pid = file.replace("process-", "").replace(".json", "");
    if (!capturedProcesses.has(pid))
      throw new Error(`Missing Next server coverage: ${pid}`);
  }
  for (const pid of workers)
    if (!capturedProcesses.has(pid))
      throw new Error(`Missing Playwright worker coverage: ${pid}`);
  if (
    !nodeEntries ||
    (runtimeRequirements.server && !serverEntries) ||
    (runtimeRequirements.isolated && !isolatedEntries)
  )
    throw new Error("Missing server or isolated Node captures");
  const { complete, discardedFragments } = selectCompleteEntries(entries);
  const report = new CoverageReport({
    name: "OpenSlate executable source coverage",
    outputDir: resolve(directory, "report"),
    baseDir: root,
    cleanCache: true,
    reports: ["json"],
    v8Ignore: false,
    sourcePath: (path) => canonical(path) ?? path,
    sourceFilter: (path) => Boolean(expected[canonical(path)]),
    all: {
      dir: resolve(root, "src"),
      filter: (path) => /\.tsx?$/.test(path) && !path.endsWith(".d.ts"),
      transformer: transformUntested,
    },
  });
  await report.add(complete);
  await report.generate();
  const denominator = await generateDenominator(
    Object.keys(expected).map((path) => ({
      url: path,
      source: readFileSync(resolve(root, path), "utf8"),
    })),
    resolve(directory, "baseline"),
  );
  const observed = istanbul.createCoverageMap(
    JSON.parse(readFileSync(resolve(directory, "report/coverage-final.json"))),
  );
  const canonicalCoverage = {};
  for (const path of Object.keys(expected)) {
    if (!denominator.files().includes(path))
      throw new Error(`Source missing from denominator: ${path}`);
    const lines = denominator.fileCoverageFor(path).getLineCoverage();
    const hits = observed.files().includes(path)
      ? observed.fileCoverageFor(path).getLineCoverage()
      : {};
    const coverage = {
      path,
      statementMap: {},
      s: {},
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    };
    for (const [index, line] of Object.keys(lines).entries()) {
      coverage.statementMap[index] = {
        start: { line: Number(line), column: 0 },
        end: { line: Number(line), column: 1 },
      };
      coverage.s[index] = hits[line] > 0 ? 1 : 0;
    }
    canonicalCoverage[path] = coverage;
  }
  writeFileSync(
    resolve(directory, "report/coverage-final.json"),
    JSON.stringify(canonicalCoverage),
  );
  const finalReport = new CoverageReport({
    outputDir: resolve(directory, "report"),
    clean: false,
    cleanCache: true,
    reports: ["lcovonly"],
  });
  await finalReport.add(canonicalCoverage);
  await finalReport.generate();
  return {
    browserCaptures: browserFiles.length,
    nodeEntries,
    serverEntries,
    isolatedEntries,
    requirements: runtimeRequirements,
    discardedFragments,
    uncreditedBootstrap: [...uncreditedBootstrap],
  };
}

function nonExecutableOnlyLines({ url, source }) {
  const file = ts.createSourceFile(url, source, ts.ScriptTarget.Latest, true);
  const directives = new Set(
    file.statements.filter(
      (statement) =>
        ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement),
    ),
  );
  for (const statement of file.statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isStringLiteral(statement.expression)
    )
      break;
    if (["use client", "use server"].includes(statement.expression.text))
      directives.add(statement);
  }
  const lines = new Set();
  function eachLine(statement, visit) {
    const first =
      file.getLineAndCharacterOfPosition(statement.getStart(file)).line + 1;
    const last =
      file.getLineAndCharacterOfPosition(statement.getEnd() - 1).line + 1;
    for (let line = first; line <= last; line++) visit(line);
  }
  for (const statement of directives)
    eachLine(statement, (line) => lines.add(line));
  // Compilation directives and static module linkage have no executable line obligation.
  // Keep a shared line containing any other statement (calls, initializers, exported functions).
  for (const statement of file.statements)
    if (!directives.has(statement))
      eachLine(statement, (line) => lines.delete(line));
  return lines;
}

export async function generateDenominator(originals, outputDir) {
  const baseline = new CoverageReport({
    outputDir,
    baseDir: root,
    cleanCache: true,
    reports: ["json"],
    v8Ignore: false,
    sourcePath: (path) => canonical(path) ?? path,
    logging: "off",
  });
  const typeOnly = [];
  const zeroEntries = originals.map((original) => {
    const entry = { ...original };
    transformUntested(entry);
    if (!entry.source) typeOnly.push(entry.url);
    return {
      ...entry,
      functions: [
        {
          functionName: "",
          isBlockCoverage: true,
          ranges: [
            { startOffset: 0, endOffset: entry.source.length, count: 0 },
          ],
        },
      ],
    };
  });
  await baseline.add(zeroEntries.filter((entry) => entry.source));
  await baseline.generate();
  const file = resolve(outputDir, "coverage-final.json");
  const data = existsSync(file) ? JSON.parse(readFileSync(file)) : {};
  // An emitted export {} is module scaffolding, not an executable source statement.
  for (const path of typeOnly)
    data[path] = {
      path,
      statementMap: {},
      s: {},
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    };
  for (const original of originals) {
    const coverage = data[canonical(original.url)];
    if (!coverage) continue;
    const excluded = nonExecutableOnlyLines(original);
    for (const [id, statement] of Object.entries(coverage.statementMap))
      if (excluded.has(statement.start.line)) {
        delete coverage.statementMap[id];
        delete coverage.s[id];
      }
  }
  writeFileSync(file, JSON.stringify(data));
  return istanbul.createCoverageMap(data);
}
