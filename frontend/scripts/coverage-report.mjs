import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import CoverageReport from "monocart-coverage-reports";
import istanbul from "istanbul-lib-coverage";

export const root = resolve(import.meta.dirname, "..");
export const hash = (source) =>
  createHash("sha256").update(source).digest("hex");
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
export function validateCaptureManifest(directory, report, discovery) {
  function collect(value) {
    if (!value || value.errors?.length || !Array.isArray(value.suites))
      throw new Error("Incomplete coverage test report");
    const projects = value.config?.projects?.map((project) => project.name);
    if (!projects?.length || new Set(projects).size !== projects.length)
      throw new Error("Incomplete coverage projects");
    const tests = new Map();
    function visit(suites) {
      for (const suite of suites) {
        for (const spec of suite.specs ?? [])
          for (const test of spec.tests) {
            const key = JSON.stringify([test.projectName, spec.id]);
            if (!projects.includes(test.projectName) || tests.has(key))
              throw new Error("Unknown or duplicate coverage test");
            tests.set(key, { ...test, id: spec.id });
          }
        visit(suite.suites ?? []);
      }
    }
    visit(value.suites);
    if (
      projects.some(
        (name) =>
          ![...tests.values()].some((test) => test.projectName === name),
      )
    )
      throw new Error("Missing coverage project tests");
    return { projects, tests };
  }
  const required = collect(discovery);
  const actual = collect(report);
  if (
    JSON.stringify([...required.projects].sort()) !==
      JSON.stringify([...actual.projects].sort()) ||
    required.tests.size !== actual.tests.size ||
    [...required.tests.keys()].some((key) => !actual.tests.has(key))
  )
    throw new Error("Partial coverage test report");
  const expected = [];
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
    if (["chromium", "mobile-chromium"].includes(test.projectName))
      expected.push(test.id);
  }
  const browserDirectory = resolve(directory, "browser");
  const captured = readdirSync(browserDirectory).map(
    (file) => JSON.parse(readFileSync(resolve(browserDirectory, file))).testId,
  );
  validateCaptureIds(expected, captured);
}

export async function generate(directory, expected) {
  const entries = [];
  const browserDirectory = resolve(directory, "browser");
  if (!existsSync(browserDirectory))
    throw new Error("Missing browser captures");
  const browserFiles = readdirSync(browserDirectory);
  if (!browserFiles.length) throw new Error("Missing browser captures");
  for (const file of browserFiles) {
    const capture = JSON.parse(readFileSync(resolve(browserDirectory, file)));
    if (capture.status !== "passed")
      throw new Error(`Incomplete browser capture: ${capture.testId}`);
    for (const entry of capture.entries) {
      if (!expected[canonical(entry.url)]) continue;
      const map =
        typeof entry.source === "string"
          ? sourceMap(entry.source, entry.url)
          : undefined;
      if (!map) throw new Error(`Missing browser source map: ${entry.url}`);
      if (!includesSource(map, expected))
        throw new Error(`Missing browser application mapping: ${entry.url}`);
      validateMap(map, expected);
      entries.push({ ...entry, sourceMap: map });
    }
  }
  const nodeDirectory = resolve(directory, "node");
  const files = readdirSync(nodeDirectory);
  const servers = files.filter(
    (file) =>
      file.startsWith("process-") &&
      JSON.parse(
        readFileSync(resolve(nodeDirectory, file)),
      ).entrypoint?.endsWith("next/dist/server/lib/start-server.js"),
  );
  if (
    !servers.length ||
    servers.some(
      (file) =>
        !existsSync(
          resolve(
            nodeDirectory,
            file.replace("process-", "flushed-").replace(".json", ""),
          ),
        ),
    )
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
  for (const file of files.filter((file) => file.startsWith("source-"))) {
    const entry = JSON.parse(readFileSync(resolve(nodeDirectory, file)));
    const key = `${entry.pid}:${entry.scriptId}`;
    if (sources.has(key) && sources.get(key) !== entry.source)
      throw new Error(`Ambiguous executed source: ${entry.url}`);
    sources.set(key, entry.source);
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
  for (const file of servers) {
    const pid = file.replace("process-", "").replace(".json", "");
    if (!capturedProcesses.has(pid))
      throw new Error(`Missing Next server coverage: ${pid}`);
  }
  for (const pid of workers)
    if (!capturedProcesses.has(pid))
      throw new Error(`Missing Playwright worker coverage: ${pid}`);
  if (!nodeEntries || !serverEntries || !isolatedEntries)
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
