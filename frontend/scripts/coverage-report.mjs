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

// Coverage is intentionally planned as a profile rather than as a collection
// of homogeneous Playwright shards.  The PR profile keeps the complete
// isolated/HTTP suite together and balances desktop Chromium tests by the
// duration profile supplied by CI.
export const COVERAGE_PLAN_VERSION = 2;
export const COVERAGE_TIMING_VERSION = 1;
export const COVERAGE_TIMING_WINDOW = 5;
export const DEFAULT_NEW_TEST_DURATION_MS = 60_000;
export const MAX_COVERAGE_TEST_DURATION_MS = 600_000;
export const MAX_COVERAGE_TIMING_RECORDS = 10_000;
export const PR_CHROMIUM_PART_COUNT = 3;
export const COVERAGE_PROFILES = Object.freeze({
  pr: Object.freeze({
    projects: Object.freeze(["isolated", "http", "chromium"]),
    coreProjects: Object.freeze(["isolated", "http"]),
    chromiumPartCount: PR_CHROMIUM_PART_COUNT,
  }),
});

export function coverageProfile(name = "pr") {
  const profile = COVERAGE_PROFILES[name];
  if (!profile) throw new Error(`Unsupported coverage profile: ${name}`);
  return profile;
}

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

export function coverageManifestKey(projectName, id) {
  return JSON.stringify([projectName, id]);
}

function manifestKey(projectName, id) {
  return coverageManifestKey(projectName, id);
}

function validDuration(value) {
  return (
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_COVERAGE_TEST_DURATION_MS
  );
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return DEFAULT_NEW_TEST_DURATION_MS;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function timingRecordKey(record) {
  return coverageManifestKey(record.projectName, record.id);
}

function normalizeTimingRecord(record) {
  if (
    !record ||
    typeof record.projectName !== "string" ||
    !record.projectName ||
    typeof record.id !== "string" ||
    !record.id
  )
    throw new Error("Coverage timing records are invalid");
  const samples = record.samples ?? [record.durationMs];
  if (
    !Array.isArray(samples) ||
    !samples.length ||
    samples.some((sample) => !validDuration(sample))
  )
    throw new Error(
      `Coverage timing duration is invalid: ${record.projectName}/${record.id}`,
    );
  const normalized = {
    projectName: record.projectName,
    id: record.id,
    samples: samples
      .map((sample) => Math.round(sample))
      .slice(-COVERAGE_TIMING_WINDOW),
  };
  normalized.durationMs = median(normalized.samples);
  if (typeof record.file === "string") normalized.file = record.file;
  if (Number.isInteger(record.line) && record.line > 0)
    normalized.line = record.line;
  return normalized;
}

/**
 * Normalize the compact timing cache exchanged by the CI workflow.
 *
 * The cache deliberately contains only one median and at most five samples
 * per test.  It is a performance hint, never coverage evidence.
 */
export function normalizeDurationProfile(profile) {
  if (profile === undefined || profile === null)
    return {
      version: COVERAGE_TIMING_VERSION,
      window: COVERAGE_TIMING_WINDOW,
      tests: [],
    };
  if (
    typeof profile !== "object" ||
    profile.version !== COVERAGE_TIMING_VERSION ||
    !Array.isArray(profile.tests) ||
    profile.tests.length > MAX_COVERAGE_TIMING_RECORDS
  )
    throw new Error("Unsupported coverage timing profile");
  const records = new Map();
  for (const record of profile.tests) {
    const normalized = normalizeTimingRecord(record);
    const key = timingRecordKey(normalized);
    if (records.has(key)) throw new Error("Duplicate coverage timing record");
    records.set(key, normalized);
  }
  return {
    version: COVERAGE_TIMING_VERSION,
    window: COVERAGE_TIMING_WINDOW,
    tests: [...records.values()].sort((left, right) =>
      timingRecordKey(left).localeCompare(timingRecordKey(right)),
    ),
  };
}

/**
 * Convert a successful Playwright JSON report into compact observations.
 * Coverage runs reject failures/retries before this function is used.
 */
export function collectCoverageDurations(report) {
  const manifest = collectCoverageManifest(report, {
    requireAllProjects: false,
  });
  const records = new Map();
  for (const test of manifest.tests.values()) {
    const duration = test.results?.[0]?.duration;
    if (!validDuration(duration)) continue;
    const record = normalizeTimingRecord({
      projectName: test.projectName,
      id: test.id,
      durationMs: Math.round(duration),
      file: test.file,
      line: test.line,
    });
    const key = timingRecordKey(record);
    if (records.has(key)) throw new Error("Duplicate coverage timing record");
    records.set(key, record);
  }
  return [...records.values()].sort((left, right) =>
    timingRecordKey(left).localeCompare(timingRecordKey(right)),
  );
}

/**
 * Append one successful run to the rolling duration profile.  Unobserved
 * records are retained so a partial run cannot erase useful history.
 */
export function updateDurationProfile(previous, observations) {
  const base = normalizeDurationProfile(previous);
  if (!Array.isArray(observations))
    throw new Error("Coverage timing observations are invalid");
  const records = new Map(
    base.tests.map((record) => [timingRecordKey(record), record]),
  );
  for (const observation of observations) {
    const current = normalizeTimingRecord(observation);
    const key = timingRecordKey(current);
    const history = records.get(key)?.samples ?? [];
    const next = normalizeTimingRecord({
      ...current,
      samples: [...history, current.durationMs].slice(-COVERAGE_TIMING_WINDOW),
    });
    records.set(key, next);
  }
  return {
    version: COVERAGE_TIMING_VERSION,
    window: COVERAGE_TIMING_WINDOW,
    tests: [...records.values()].sort((left, right) =>
      timingRecordKey(left).localeCompare(timingRecordKey(right)),
    ),
  };
}

export function collectCoverageManifest(
  value,
  { requireAllProjects = true, projectFilter } = {},
) {
  if (!value || value.errors?.length || !Array.isArray(value.suites))
    throw new Error("Incomplete coverage test report");
  const configuredProjects = value.config?.projects?.map(
    (project) => project.name,
  );
  if (
    !configuredProjects?.length ||
    new Set(configuredProjects).size !== configuredProjects.length
  )
    throw new Error("Incomplete coverage projects");
  const projects = projectFilter ? [...projectFilter] : configuredProjects;
  if (
    !projects.length ||
    new Set(projects).size !== projects.length ||
    projects.some((project) => !configuredProjects.includes(project))
  )
    throw new Error("Coverage project filter is invalid");
  const tests = new Map();
  function visit(suites, ancestors = []) {
    for (const suite of suites) {
      const suiteTitles =
        typeof suite.title === "string" && suite.title !== suite.file
          ? [...ancestors, suite.title]
          : ancestors;
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          const key = manifestKey(test.projectName, spec.id);
          if (!configuredProjects.includes(test.projectName))
            throw new Error("Unknown or duplicate coverage test");
          if (!projects.includes(test.projectName)) continue;
          if (tests.has(key))
            throw new Error("Unknown or duplicate coverage test");
          tests.set(key, {
            ...test,
            id: spec.id,
            file: typeof spec.file === "string" ? spec.file : suite.file,
            line: Number.isInteger(spec.line) ? spec.line : suite.line,
            column: Number.isInteger(spec.column) ? spec.column : suite.column,
            title: spec.title,
            titlePath: [...suiteTitles, spec.title].filter(
              (title) => typeof title === "string" && title.length,
            ),
          });
        }
      }
      visit(suite.suites ?? [], suiteTitles);
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
    .map((test) => {
      const normalized = { projectName: test.projectName, id: test.id };
      if (typeof test.file === "string") normalized.file = test.file;
      if (Number.isInteger(test.line) && test.line > 0)
        normalized.line = test.line;
      if (Number.isInteger(test.column) && test.column > 0)
        normalized.column = test.column;
      if (typeof test.title === "string") normalized.title = test.title;
      if (Array.isArray(test.titlePath) && test.titlePath.length)
        normalized.titlePath = [...test.titlePath];
      return normalized;
    })
    .sort((left, right) =>
      manifestKey(left.projectName, left.id).localeCompare(
        manifestKey(right.projectName, right.id),
      ),
    );
}

function assertCoveragePlanShape(plan) {
  if (!plan || plan.version !== COVERAGE_PLAN_VERSION)
    throw new Error("Unsupported coverage plan version");
  if (typeof plan.profile !== "string" || !COVERAGE_PROFILES[plan.profile])
    throw new Error("Coverage plan profile is invalid");
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
      typeof test.file !== "string" ||
      !test.file ||
      !Number.isInteger(test.line) ||
      test.line < 1 ||
      expectedKeys.has(manifestKey(test.projectName, test.id))
    )
      throw new Error("Coverage plan tests are invalid");
    expectedKeys.add(manifestKey(test.projectName, test.id));
  }
  const profile = coverageProfile(plan.profile);
  const expectedProjects = [...profile.projects].sort();
  if (
    JSON.stringify([...plan.projects].sort()) !==
    JSON.stringify(expectedProjects)
  )
    throw new Error("Coverage plan projects do not match profile");
  if (
    !Array.isArray(plan.parts) ||
    plan.parts.length !== 1 + profile.chromiumPartCount
  )
    throw new Error("Coverage plan parts are incomplete");
  const expectedPartIds = [
    "core",
    ...Array.from(
      { length: profile.chromiumPartCount },
      (_, index) => `chromium-${index + 1}`,
    ),
  ];
  if (
    JSON.stringify(plan.parts.map((part) => part.id)) !==
    JSON.stringify(expectedPartIds)
  )
    throw new Error("Coverage plan part IDs are invalid");
  const seen = new Set();
  for (const [position, part] of plan.parts.entries()) {
    if (
      !part ||
      typeof part.id !== "string" ||
      !Array.isArray(part.projects) ||
      !Array.isArray(part.tests) ||
      !Number.isInteger(part.estimatedDurationMs) ||
      part.estimatedDurationMs < 1
    )
      throw new Error("Coverage plan part assignments are invalid");
    const expectedPartProjects =
      position === 0 ? [...profile.coreProjects].sort() : ["chromium"];
    if (
      JSON.stringify([...part.projects].sort()) !==
      JSON.stringify(expectedPartProjects)
    )
      throw new Error(`Coverage plan projects are invalid for ${part.id}`);
    let estimatedDurationMs = 0;
    for (const test of part.tests) {
      const key = manifestKey(test.projectName, test.id);
      if (
        !expectedKeys.has(key) ||
        seen.has(key) ||
        !part.projects.includes(test.projectName) ||
        !Number.isInteger(test.durationMs) ||
        test.durationMs < 1
      )
        throw new Error("Coverage plan part assignments are incomplete");
      seen.add(key);
      estimatedDurationMs += test.durationMs;
    }
    if (estimatedDurationMs !== part.estimatedDurationMs)
      throw new Error(`Coverage plan duration is invalid for ${part.id}`);
  }
  if (seen.size !== expectedKeys.size)
    throw new Error("Coverage plan part assignments are incomplete");
  if (
    !plan.timing ||
    plan.timing.version !== COVERAGE_TIMING_VERSION ||
    !Number.isInteger(plan.timing.defaultDurationMs) ||
    plan.timing.defaultDurationMs < 1
  )
    throw new Error("Coverage plan timing metadata is invalid");
  if (!plan.timingProfile)
    throw new Error("Coverage plan timing profile is missing");
  normalizeDurationProfile(plan.timingProfile);
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

function testDuration(test, timingByKey, defaultDurationMs) {
  const timing = timingByKey.get(manifestKey(test.projectName, test.id));
  return timing
    ? { durationMs: timing.durationMs, durationSource: "historical" }
    : {
        durationMs: defaultDurationMs,
        durationSource: "conservative-default",
      };
}

/**
 * Build the stable `core` part and duration-balanced Chromium parts.
 * Longest-processing-time assignment is deterministic: durations are sorted
 * descending and ties resolve by the project/test manifest key.
 */
export function createCoverageParts(
  tests,
  timingProfile,
  {
    chromiumPartCount = PR_CHROMIUM_PART_COUNT,
    coreProjects = ["isolated", "http"],
  } = {},
) {
  if (!Array.isArray(tests) || !tests.length)
    throw new Error("Coverage part tests are empty");
  const timing = normalizeDurationProfile(timingProfile);
  const timingByKey = new Map(
    timing.tests.map((record) => [timingRecordKey(record), record]),
  );
  const knownDurations = timing.tests
    .map((record) => record.durationMs)
    .sort((left, right) => left - right);
  const defaultDurationMs = knownDurations.length
    ? knownDurations[Math.max(0, Math.ceil(knownDurations.length * 0.75) - 1)]
    : DEFAULT_NEW_TEST_DURATION_MS;
  const core = [];
  const chromium = [];
  for (const test of tests) {
    if (coreProjects.includes(test.projectName)) core.push(test);
    else if (test.projectName === "chromium") chromium.push(test);
    else
      throw new Error(`Unsupported PR coverage project: ${test.projectName}`);
  }
  if (!core.length || !chromium.length)
    throw new Error("Coverage profile is missing core or Chromium tests");
  const weighted = (items) =>
    items.map((test) => ({
      ...test,
      ...testDuration(test, timingByKey, defaultDurationMs),
    }));
  const coreTests = weighted(core).sort((left, right) =>
    manifestKey(left.projectName, left.id).localeCompare(
      manifestKey(right.projectName, right.id),
    ),
  );
  const parts = [
    {
      id: "core",
      kind: "core",
      projects: [...coreProjects].sort(),
      estimatedDurationMs: coreTests.reduce(
        (total, test) => total + test.durationMs,
        0,
      ),
      tests: coreTests,
    },
  ];
  const chromiumParts = Array.from(
    { length: chromiumPartCount },
    (_, index) => ({
      id: `chromium-${index + 1}`,
      kind: "chromium",
      projects: ["chromium"],
      estimatedDurationMs: 0,
      tests: [],
    }),
  );
  weighted(chromium)
    .sort(
      (left, right) =>
        right.durationMs - left.durationMs ||
        manifestKey(left.projectName, left.id).localeCompare(
          manifestKey(right.projectName, right.id),
        ),
    )
    .forEach((test) => {
      const part = chromiumParts.reduce((lightest, candidate) =>
        candidate.estimatedDurationMs < lightest.estimatedDurationMs
          ? candidate
          : lightest,
      );
      part.tests.push(test);
      part.estimatedDurationMs += test.durationMs;
    });
  for (const part of chromiumParts)
    part.tests.sort((left, right) =>
      manifestKey(left.projectName, left.id).localeCompare(
        manifestKey(right.projectName, right.id),
      ),
    );
  return [...parts, ...chromiumParts];
}

export function formatCoverageTestList(tests) {
  if (!Array.isArray(tests) || !tests.length)
    throw new Error("Coverage test list is empty");
  return `${tests
    .map((test) => {
      if (
        typeof test.projectName !== "string" ||
        typeof test.file !== "string" ||
        !Number.isInteger(test.line) ||
        test.line < 1
      )
        throw new Error("Coverage tests are missing locations");
      if (
        test.file.startsWith("/") ||
        test.file.includes("\\") ||
        test.file.split("/").includes("..")
      )
        throw new Error(`Coverage test location is invalid: ${test.file}`);
      const titles = Array.isArray(test.titlePath)
        ? test.titlePath
        : typeof test.title === "string"
          ? [test.title]
          : [];
      return `[${test.projectName}] > ${test.file}:${test.line}${titles
        .map((title) => ` > ${title}`)
        .join("")}`;
    })
    .join("\n")}\n`;
}

export function createCoveragePlan({
  baseRevision,
  headRevision,
  sources,
  denominator,
  discovery,
  profile = "pr",
  timingProfile,
}) {
  const selectedProfile = coverageProfile(profile);
  const full = collectCoverageManifest(discovery, {
    projectFilter: selectedProfile.projects,
  });
  const tests = sortedManifestTests(full);
  const parts = createCoverageParts(tests, timingProfile, {
    chromiumPartCount: selectedProfile.chromiumPartCount,
    coreProjects: selectedProfile.coreProjects,
  });
  const normalizedTiming = normalizeDurationProfile(timingProfile);
  const matchedTiming = new Set(
    normalizedTiming.tests.map((record) => timingRecordKey(record)),
  );
  const matchedTests = tests.filter((test) =>
    matchedTiming.has(manifestKey(test.projectName, test.id)),
  ).length;
  const plan = {
    version: COVERAGE_PLAN_VERSION,
    profile,
    baseRevision,
    headRevision,
    sources: Object.fromEntries(
      Object.entries(sources).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    sourceInventory: Object.keys(sources).sort(),
    projects: [...full.projects].sort(),
    tests,
    parts,
    timing: {
      version: COVERAGE_TIMING_VERSION,
      window: COVERAGE_TIMING_WINDOW,
      defaultDurationMs:
        parts
          .flatMap((part) => part.tests)
          .find((test) => test.durationSource === "conservative-default")
          ?.durationMs ?? DEFAULT_NEW_TEST_DURATION_MS,
      knownTests: normalizedTiming.tests.length,
      matchedTests,
    },
    timingProfile: normalizedTiming,
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

export function validateCaptureManifest(
  directory,
  report,
  discovery,
  { projectFilter } = {},
) {
  const required = collectCoverageManifest(discovery, { projectFilter });
  const actual = collectCoverageManifest(report, { projectFilter });
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

function validatePartTestManifest(plan, report, part) {
  const actual = collectCoverageManifest(report, { requireAllProjects: false });
  const expected = new Map(
    part.tests.map((test) => [manifestKey(test.projectName, test.id), test]),
  );
  if (!keysEqual(actual.tests.keys(), expected.keys()))
    throw new Error(`Missing or unexpected coverage tests in part ${part.id}`);
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

export function validateCoveragePart(plan, report, partId, directory) {
  const { sourcePaths } = assertCoveragePlanShape(plan);
  const part = plan.parts.find((candidate) => candidate.id === partId);
  if (!part) throw new Error(`Coverage part is invalid: ${partId}`);
  const manifest = validatePartTestManifest(plan, report, part);
  if (directory) validateBrowserCaptureIds(directory, manifest);
  return { sourcePaths, part };
}

function validateRuntimeMetadata(metadata, part) {
  if (metadata.status !== "passed")
    throw new Error(`Coverage part ${part.id} did not pass`);
  const runtime = metadata.runtime ?? {};
  const requirements = coverageRuntimeRequirements([
    ...new Set(part.tests.map((test) => test.projectName)),
  ]);
  if (
    runtime.requirements &&
    JSON.stringify(runtime.requirements) !== JSON.stringify(requirements)
  )
    throw new Error(
      `Coverage runtime requirements mismatch in part ${part.id}`,
    );
  const requiredCounts = {
    browserCaptures: requirements.browser,
    serverEntries: requirements.server,
    isolatedEntries: requirements.isolated,
  };
  if (!Number.isInteger(runtime.nodeEntries) || runtime.nodeEntries < 1)
    throw new Error(`Missing nodeEntries coverage in part ${part.id}`);
  for (const [key, required] of Object.entries(requiredCounts)) {
    if (required && (!Number.isInteger(runtime[key]) || runtime[key] < 1))
      throw new Error(`Missing ${key} coverage in part ${part.id}`);
  }
  if (runtime.sourceMapsValidated !== true)
    throw new Error(`Missing source-map validation in part ${part.id}`);
  return { runtime, requirements };
}

function validateCanonicalReport(plan, data, partId) {
  const { sourcePaths } = assertCoveragePlanShape(plan);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error(`Invalid coverage report in part ${partId}`);
  if (!keysEqual(Object.keys(data), sourcePaths))
    throw new Error(`Coverage denominator mismatch in part ${partId}`);
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
  partDirectories,
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
  const directories = partDirectories;
  if (!Array.isArray(directories) || directories.length !== plan.parts.length)
    throw new Error("Coverage merge requires every part");
  const seenParts = new Set();
  const reports = [];
  const runtimeCoverage = [];
  for (const directory of directories) {
    const metadata = readJson(
      resolve(directory, "metadata.json"),
      "coverage part metadata",
    );
    const partId = metadata.part?.id ?? metadata.partId;
    const partIndex = plan.parts.findIndex((part) => part.id === partId);
    if (partIndex < 0 || seenParts.has(partId))
      throw new Error("Missing or duplicate coverage part");
    const part = plan.parts[partIndex];
    seenParts.add(partId);
    if (
      metadata.revision !== plan.headRevision ||
      metadata.baseRef !== plan.baseRevision ||
      JSON.stringify(metadata.sources) !== JSON.stringify(plan.sources)
    )
      throw new Error(
        `Mixed coverage revisions or source hashes in part ${part.id}`,
      );
    runtimeCoverage.push(validateRuntimeMetadata(metadata, part));
    const testReport = readJson(
      resolve(directory, "tests.json"),
      "coverage part tests",
    );
    validatePartTestManifest(plan, testReport, part);
    const report = readJson(
      resolve(directory, "report", "coverage-final.json"),
      "coverage part report",
    );
    reports.push({
      part,
      report: validateCanonicalReport(plan, report, part.id),
    });
  }
  if (seenParts.size !== plan.parts.length)
    throw new Error("Missing or duplicate coverage part");
  const requiredUnion = coverageRuntimeRequirements([
    ...new Set(
      plan.parts.flatMap((part) => part.tests.map((test) => test.projectName)),
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
      throw new Error(`Missing ${category} coverage across part union`);
  }
  reports.sort(
    (left, right) =>
      plan.parts.indexOf(left.part) - plan.parts.indexOf(right.part),
  );
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
  return { parts: reports.length, files: sourcePaths.length, report: output };
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
