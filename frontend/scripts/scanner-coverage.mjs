import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import v8toIstanbul from "v8-to-istanbul";
import istanbul from "istanbul-lib-coverage";
const { createCoverageMap } = istanbul;
import { AnyMap, encodedMap, eachMapping } from "@jridgewell/trace-mapping";

const scannerTargets = [
  "src/components/files/file-list.tsx",
  "src/components/files/file-upload.tsx",
  "src/components/files/use-file-refresh.ts",
  "src/components/workspace-logo-settings.tsx",
  "src/lib/files.ts",
];
const targetsFile =
  process.argv[3] ?? process.env.SCANNER_COVERAGE_TARGETS_FILE;
const targets = targetsFile
  ? JSON.parse(await readFile(targetsFile, "utf8"))
  : scannerTargets;
if (
  !Array.isArray(targets) ||
  targets.length === 0 ||
  targets.some(
    (target) =>
      typeof target !== "string" ||
      !target.startsWith("src/") ||
      target.split("/").includes(".."),
  ) ||
  new Set(targets).size !== targets.length
)
  throw new Error("Coverage targets must be unique source paths");
const baseline = process.argv[2];
if (baseline && !(await stat(baseline)).isDirectory())
  throw new Error("Scanner baseline must be a directory");
const root = path.resolve("test-results/playwright");
const coverage = createCoverageMap({});
let captures = 0;
const mappedLines = new Map(targets.map((target) => [target, new Set()]));
for (const folder of await readdir(root)) {
  let entries;
  try {
    entries = JSON.parse(
      await readFile(path.join(root, folder, "scanner-v8.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
    throw error;
  }
  captures++;
  for (const entry of entries) {
    const traced = AnyMap(entry.sourceMap);
    const sourceMap = encodedMap(traced);
    for (const [index, source] of sourceMap.sources.entries()) {
      const target = targets.find((target) => source.endsWith(target));
      if (
        target &&
        sourceMap.sourcesContent[index] !== (await readFile(target, "utf8"))
      ) {
        throw new Error(`Stale runtime source for ${target}; rerun coverage.`);
      }
    }
    eachMapping(traced, (mapping) => {
      const target = targets.find((target) => mapping.source?.endsWith(target));
      if (target && mapping.originalLine)
        mappedLines.get(target).add(mapping.originalLine);
    });
    const converter = v8toIstanbul(path.resolve("scanner-runtime.js"), 0, {
      source: entry.source,
      sourceMap: { sourcemap: sourceMap },
    });
    await converter.load();
    // V8 navigation fragments omit unexecuted functions. Converting those would
    // mark omitted code covered by default, so accept only complete script entries.
    if (
      !entry.functions.some((fn) =>
        fn.ranges.some(
          (range) =>
            range.startOffset === 0 && range.endOffset === entry.source.length,
        ),
      )
    )
      continue;
    converter.applyCoverage(entry.functions);
    const converted = converter.toIstanbul();
    for (const [source, value] of Object.entries(converted)) {
      const target = targets.find((target) =>
        source.replaceAll("\\", "/").endsWith(target),
      );
      if (target) coverage.merge({ [target]: { ...value, path: target } });
    }
  }
}
if (!captures)
  throw new Error(
    "No scanner V8 captures. Run SCANNER_COVERAGE=1 npm run test:e2e -- --project=chromium tests/browser/files/library.spec.ts first.",
  );
const report = {
  captures,
  baseline: baseline ?? "entire owned files",
  targetsFile: targetsFile ?? null,
  files: [],
  covered: 0,
  total: 0,
};
for (const target of targets) {
  if (!coverage.files().includes(target))
    throw new Error(`Missing coverage for ${target}`);
  let changed = null;
  if (baseline) {
    const before = path.join(baseline, target);
    let exists = true;
    try {
      await readFile(before);
    } catch (error) {
      if (error.code === "ENOENT") exists = false;
      else throw error;
    }
    if (exists) {
      const diff = spawnSync(
        "git",
        ["diff", "--no-index", "--unified=0", "--", before, target],
        { encoding: "utf8" },
      );
      if (diff.status !== 0 && diff.status !== 1)
        throw new Error(diff.stderr || "Cannot compare scanner baseline");
      changed = new Set();
      for (const match of diff.stdout.matchAll(
        /^@@ .* \+(\d+)(?:,(\d+))? @@/gm,
      )) {
        const start = Number(match[1]);
        const count = match[2] === undefined ? 1 : Number(match[2]);
        for (let line = start; line < start + count; line++) changed.add(line);
      }
    }
  }
  // Type-only declarations, comments and blank source lines have no emitted
  // mapping and cannot count toward executable line coverage.
  const lines = Object.fromEntries(
    Object.entries(coverage.fileCoverageFor(target).getLineCoverage()).filter(
      ([line]) =>
        mappedLines.get(target).has(Number(line)) &&
        (!changed || changed.has(Number(line))),
    ),
  );
  const uncovered = Object.entries(lines)
    .filter(([, count]) => count === 0)
    .map(([line]) => Number(line));
  const total = Object.keys(lines).length;
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(`No measurable emitted lines for ${target}`);
  }
  report.total += total;
  report.covered += total - uncovered.length;
  report.files.push({
    path: target,
    covered: total - uncovered.length,
    total,
    uncovered,
  });
}
if (
  !Number.isFinite(report.total) ||
  report.total <= 0 ||
  !Number.isFinite(report.covered)
) {
  throw new Error("Invalid scanner coverage totals");
}
report.percent = (report.covered / report.total) * 100;
if (!Number.isFinite(report.percent))
  throw new Error("Invalid scanner coverage percentage");
await writeFile(
  baseline
    ? "test-results/scanner-changed-coverage.json"
    : "test-results/scanner-coverage.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
if (report.percent < 90) process.exitCode = 1;
