import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  liveResultsDirectory,
  mergeLiveAssertions,
  readManifest,
  type LiveManifest,
  type LiveAssertionResult,
} from "./manifest";
import { sanitizeEvidence } from "./sanitize";
import { validateRunId } from "./preflight";
import { assertSafeOutputFile, ensurePrivateResultsDirectory } from "./paths";
import type { LiveScale } from "../seed-data";
import type { RunId } from "./preflight";

export {
  LIVE_ASSERTION_STATUSES,
  type LiveAssertionResult,
  type LiveAssertionStatus,
} from "./manifest";

export type LiveTeardownSummary = Readonly<{
  domainRowsRemoved: number;
  auditLogsRetained: boolean;
  auditLogCount: number;
  auditEvidence?: readonly LivePurgeAuditEvidence[];
}>;

export type LivePurgeAuditEvidence = Readonly<{
  rootId: string;
  requestId: string;
  auditLogCount: number;
  entities: Readonly<{
    departments: number;
    modules: number;
    fields: number;
    records: number;
    relationships: number;
  }>;
}>;

export type LiveIntegritySummary = Readonly<{
  scale: LiveScale;
  catalog: Readonly<{
    departments: number;
    modules: number;
    primitiveFields: number;
    relationshipFields: number;
    acceptedSchemas: number;
    expectedRecords: number;
    observedRecords: number;
  }>;
  cardinality: readonly Readonly<{
    cardinality: string;
    fields: number;
    activeEdges: number;
    representativeFields: number;
  }>[];
  apiNegatives: readonly Readonly<{
    check: string;
    status: number;
    path: string;
  }>[];
  audit: Readonly<{
    uiRows: number;
    filteredLogs: number;
    detailLogs: number;
  }>;
}>;

export type LiveReportInput = Readonly<{
  assertions?: readonly LiveAssertionResult[];
  generatedAt?: Date;
  recordTargetIncludesUiSanityRecords?: boolean;
  teardownSummary?: LiveTeardownSummary;
  integritySummary?: LiveIntegritySummary;
}>;

type LiveReportState = Readonly<{
  version: 1;
  run_id: RunId;
  recordTargetIncludesUiSanityRecords?: boolean;
  teardownSummary?: LiveTeardownSummary;
  integritySummary?: LiveIntegritySummary;
}>;

const REPORT_BEARER_SENTINEL = /__VG_BEARER_TOKEN_[A-Za-z0-9]+__/g;
const reportStateQueues = new Map<string, Promise<void>>();

export function reportStateFilePath(
  runId: string,
  resultsRoot = liveResultsDirectory(),
): string {
  return join(
    liveResultsDirectory(resultsRoot),
    validateRunId(runId),
    "report-state.json",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  context: string,
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`Live report state has an invalid shape: ${context}`);
  }
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function reportCount(value: unknown, context: string): number {
  if (!nonNegativeInteger(value)) {
    throw new Error(`Live report state has an invalid shape: ${context}`);
  }
  return value;
}

function isHttpStatus(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 100 &&
    value <= 599
  );
}

function reportString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length > 500) {
    throw new Error(`Live report state has an invalid shape: ${context}`);
  }
  return String(sanitizeEvidence(value)).replace(
    REPORT_BEARER_SENTINEL,
    "[REDACTED]",
  );
}

function parseTeardownSummary(value: unknown): LiveTeardownSummary {
  if (!isRecord(value))
    throw new Error("Live report state has an invalid shape: teardownSummary");
  assertExactKeys(
    value,
    [
      "domainRowsRemoved",
      "auditLogsRetained",
      "auditLogCount",
      "auditEvidence",
    ],
    "teardownSummary",
  );
  if (
    !nonNegativeInteger(value.domainRowsRemoved) ||
    typeof value.auditLogsRetained !== "boolean" ||
    !nonNegativeInteger(value.auditLogCount)
  ) {
    throw new Error("Live report state has an invalid shape: teardownSummary");
  }
  let auditEvidence: readonly LivePurgeAuditEvidence[] | undefined;
  if (value.auditEvidence !== undefined) {
    if (!Array.isArray(value.auditEvidence)) {
      throw new Error("Live report state has an invalid shape: auditEvidence");
    }
    auditEvidence = value.auditEvidence.map((item) => {
      if (!isRecord(item) || !isRecord(item.entities)) {
        throw new Error(
          "Live report state has an invalid shape: auditEvidence",
        );
      }
      assertExactKeys(
        item,
        ["rootId", "requestId", "auditLogCount", "entities"],
        "auditEvidence",
      );
      assertExactKeys(
        item.entities,
        ["departments", "modules", "fields", "records", "relationships"],
        "auditEvidence.entities",
      );
      if (
        typeof item.rootId !== "string" ||
        typeof item.requestId !== "string" ||
        !nonNegativeInteger(item.auditLogCount)
      ) {
        throw new Error(
          "Live report state has an invalid shape: auditEvidence",
        );
      }
      return {
        rootId: reportString(item.rootId, "audit root ID"),
        requestId: reportString(item.requestId, "audit request ID"),
        auditLogCount: item.auditLogCount,
        entities: {
          departments: reportCount(item.entities.departments, "audit entities"),
          modules: reportCount(item.entities.modules, "audit entities"),
          fields: reportCount(item.entities.fields, "audit entities"),
          records: reportCount(item.entities.records, "audit entities"),
          relationships: reportCount(
            item.entities.relationships,
            "audit entities",
          ),
        },
      };
    });
  }
  return {
    domainRowsRemoved: value.domainRowsRemoved,
    auditLogsRetained: value.auditLogsRetained,
    auditLogCount: value.auditLogCount,
    ...(auditEvidence === undefined ? {} : { auditEvidence }),
  };
}

function parseIntegritySummary(value: unknown): LiveIntegritySummary {
  if (!isRecord(value))
    throw new Error("Live report state has an invalid shape: integritySummary");
  assertExactKeys(
    value,
    ["scale", "catalog", "cardinality", "apiNegatives", "audit"],
    "integritySummary",
  );
  if (value.scale !== "standard" && value.scale !== "extended") {
    throw new Error("Live report state has an invalid shape: scale");
  }
  if (!isRecord(value.catalog))
    throw new Error("Live report state has an invalid shape: catalog");
  assertExactKeys(
    value.catalog,
    [
      "departments",
      "modules",
      "primitiveFields",
      "relationshipFields",
      "acceptedSchemas",
      "expectedRecords",
      "observedRecords",
    ],
    "catalog",
  );
  const catalog = {
    departments: reportCount(value.catalog.departments, "catalog"),
    modules: reportCount(value.catalog.modules, "catalog"),
    primitiveFields: reportCount(value.catalog.primitiveFields, "catalog"),
    relationshipFields: reportCount(
      value.catalog.relationshipFields,
      "catalog",
    ),
    acceptedSchemas: reportCount(value.catalog.acceptedSchemas, "catalog"),
    expectedRecords: reportCount(value.catalog.expectedRecords, "catalog"),
    observedRecords: reportCount(value.catalog.observedRecords, "catalog"),
  };
  if (!Array.isArray(value.cardinality))
    throw new Error("Live report state has an invalid shape: cardinality");
  const cardinality = value.cardinality.map((item) => {
    if (!isRecord(item))
      throw new Error("Live report state has an invalid shape: cardinality");
    assertExactKeys(
      item,
      ["cardinality", "fields", "activeEdges", "representativeFields"],
      "cardinality",
    );
    if (
      typeof item.cardinality !== "string" ||
      !nonNegativeInteger(item.fields) ||
      !nonNegativeInteger(item.activeEdges) ||
      !nonNegativeInteger(item.representativeFields)
    ) {
      throw new Error("Live report state has an invalid shape: cardinality");
    }
    return {
      cardinality: reportString(item.cardinality, "cardinality name"),
      fields: item.fields,
      activeEdges: item.activeEdges,
      representativeFields: item.representativeFields,
    };
  });
  if (!Array.isArray(value.apiNegatives))
    throw new Error("Live report state has an invalid shape: apiNegatives");
  const apiNegatives = value.apiNegatives.map((item) => {
    if (!isRecord(item))
      throw new Error("Live report state has an invalid shape: apiNegatives");
    assertExactKeys(item, ["check", "status", "path"], "apiNegatives");
    const status = item.status;
    if (
      typeof item.check !== "string" ||
      !isHttpStatus(status) ||
      typeof item.path !== "string"
    ) {
      throw new Error("Live report state has an invalid shape: apiNegatives");
    }
    return {
      check: reportString(item.check, "API negative check"),
      status,
      path: reportString(item.path, "API negative path"),
    };
  });
  if (!isRecord(value.audit))
    throw new Error("Live report state has an invalid shape: audit");
  assertExactKeys(
    value.audit,
    ["uiRows", "filteredLogs", "detailLogs"],
    "audit",
  );
  if (
    !nonNegativeInteger(value.audit.uiRows) ||
    !nonNegativeInteger(value.audit.filteredLogs) ||
    !nonNegativeInteger(value.audit.detailLogs)
  ) {
    throw new Error("Live report state has an invalid shape: audit");
  }
  return {
    scale: value.scale,
    catalog,
    cardinality,
    apiNegatives,
    audit: {
      uiRows: value.audit.uiRows,
      filteredLogs: value.audit.filteredLogs,
      detailLogs: value.audit.detailLogs,
    },
  };
}

function parseReportState(
  value: unknown,
  expectedRunId: RunId,
): LiveReportState {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Live report state has an invalid shape");
  }
  assertExactKeys(
    value,
    [
      "version",
      "run_id",
      "recordTargetIncludesUiSanityRecords",
      "teardownSummary",
      "integritySummary",
    ],
    "root",
  );
  if (typeof value.run_id !== "string") {
    throw new Error("Live report state has an invalid shape: run_id");
  }
  const parsedRunId = validateRunId(value.run_id);
  if (parsedRunId !== expectedRunId) {
    throw new Error(
      "Live report state run ID does not match its requested path",
    );
  }
  if (
    value.recordTargetIncludesUiSanityRecords !== undefined &&
    typeof value.recordTargetIncludesUiSanityRecords !== "boolean"
  ) {
    throw new Error(
      "Live report state has an invalid shape: recordTargetIncludesUiSanityRecords",
    );
  }
  return {
    version: 1,
    run_id: expectedRunId,
    ...(value.recordTargetIncludesUiSanityRecords === undefined
      ? {}
      : {
          recordTargetIncludesUiSanityRecords:
            value.recordTargetIncludesUiSanityRecords,
        }),
    ...(value.teardownSummary === undefined
      ? {}
      : { teardownSummary: parseTeardownSummary(value.teardownSummary) }),
    ...(value.integritySummary === undefined
      ? {}
      : { integritySummary: parseIntegritySummary(value.integritySummary) }),
  };
}

async function readReportState(
  runId: RunId,
  resultsRoot: string,
): Promise<LiveReportState | undefined> {
  try {
    return parseReportState(
      JSON.parse(
        await readFile(reportStateFilePath(runId, resultsRoot), "utf8"),
      ),
      runId,
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    if (error instanceof Error && /invalid shape|run ID/.test(error.message)) {
      throw error;
    }
    throw new Error(`Unable to read live report state: ${String(error)}`);
  }
}

async function writeReportStateAtomically(
  filePath: string,
  state: LiveReportState,
): Promise<void> {
  const directory = dirname(filePath);
  await ensurePrivateResultsDirectory(directory);
  await assertSafeOutputFile(filePath);
  const temporaryPath = join(
    directory,
    `.report-state-${process.pid}-${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function enqueueReportState<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = reportStateQueues.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const completion = current.then(
    () => undefined,
    () => undefined,
  );
  reportStateQueues.set(filePath, completion);
  try {
    return await current;
  } finally {
    if (reportStateQueues.get(filePath) === completion)
      reportStateQueues.delete(filePath);
  }
}

function reportStatePatch(
  input: LiveReportInput,
): Omit<LiveReportState, "version" | "run_id"> {
  return {
    ...(input.recordTargetIncludesUiSanityRecords === undefined
      ? {}
      : {
          recordTargetIncludesUiSanityRecords:
            input.recordTargetIncludesUiSanityRecords,
        }),
    ...(input.teardownSummary === undefined
      ? {}
      : { teardownSummary: parseTeardownSummary(input.teardownSummary) }),
    ...(input.integritySummary === undefined
      ? {}
      : { integritySummary: parseIntegritySummary(input.integritySummary) }),
  };
}

async function mergeReportState(
  runId: RunId,
  patch: Omit<LiveReportState, "version" | "run_id">,
  resultsRoot: string,
): Promise<LiveReportState> {
  const filePath = reportStateFilePath(runId, resultsRoot);
  return enqueueReportState(filePath, async () => {
    const current =
      (await readReportState(runId, resultsRoot)) ??
      ({ version: 1, run_id: runId } satisfies LiveReportState);
    const state: LiveReportState = {
      ...current,
      ...patch,
    };
    await writeReportStateAtomically(filePath, state);
    return state;
  });
}

function markdownText(value: string): string {
  return String(sanitizeEvidence(value))
    .replace(/[|\r\n]+/g, " ")
    .replace(/`/g, "'")
    .trim();
}

async function writeTextAtomically(
  filePath: string,
  value: string,
): Promise<void> {
  const directory = dirname(filePath);
  await ensurePrivateResultsDirectory(directory);
  await assertSafeOutputFile(filePath);
  const temporaryPath = join(
    directory,
    `.live-report-${process.pid}-${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function operationCounts(
  manifest: LiveManifest,
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const operation of manifest.operations) {
    if (operation.status !== "succeeded") continue;
    counts[operation.entity_type] = (counts[operation.entity_type] ?? 0) + 1;
  }
  return counts;
}

function defaultAssertions(): readonly LiveAssertionResult[] {
  return [
    {
      id: "integrity-suite",
      name: "Integrity suite",
      status: "Not Testable",
      detail: "Integrity suite not yet run; no integrity result is inferred.",
    },
    {
      id: "lifecycle-integrity",
      name: "Lifecycle integrity",
      status: "Not Supported",
      detail:
        "Lifecycle teardown is reported separately; Section 3 integrity runs when the live integrity suite is available.",
    },
    {
      id: "teardown",
      name: "Manifest-owned domain teardown",
      status: "Not Testable",
      detail: "Teardown has not run; no teardown result is inferred.",
    },
  ];
}

export function renderLiveReport(
  manifest: LiveManifest,
  input: LiveReportInput = {},
): string {
  const counts = operationCounts(manifest);
  const defaults = defaultAssertions().map((assertion) =>
    input.teardownSummary && assertion.id === "teardown"
      ? {
          ...assertion,
          status: "Pass" as const,
          detail: "Teardown completed; see the teardown outcome below.",
        }
      : assertion,
  );
  const assertions = [
    ...(input.assertions ?? manifest.assertions),
    ...defaults,
  ].filter(
    (assertion, index, all) =>
      all.findIndex((candidate) => candidate.id === assertion.id) === index,
  );
  const integrityAssertion = assertions.find(
    (assertion) => assertion.id === "integrity-suite",
  );
  const generatedAt = input.generatedAt ?? new Date();
  const teardownSummary = input.teardownSummary;
  const lines = [
    "# OpenSlate live seed report",
    "",
    `- Run ID: \`${markdownText(manifest.run_id)}\``,
    `- Namespace: \`${markdownText(manifest.namespace)}\``,
    `- Generated: ${markdownText(generatedAt.toISOString())}`,
    "",
    "## Mutation summary",
    "",
    "| Entity | Confirmed operations |",
    "| --- | ---: |",
  ];
  for (const entity of [
    "department",
    "module",
    "field",
    "record",
    "relationship",
  ]) {
    lines.push(`| ${entity} | ${counts[entity] ?? 0} |`);
  }
  lines.push(
    `| Total | ${manifest.operations.length} |`,
    "",
    ...(input.recordTargetIncludesUiSanityRecords
      ? [
          "Record targets include the two UI sanity records; the bulk API creates only the remaining records.",
          "",
        ]
      : []),
    "## Assertions",
    "",
    "| Check | Status | Detail |",
    "| --- | --- | --- |",
  );
  for (const assertion of assertions) {
    lines.push(
      `| ${markdownText(assertion.name)} | ${assertion.status} | ${markdownText(assertion.detail ?? "")} |`,
    );
  }
  lines.push(
    "",
    `Integrity suite status: **${integrityAssertion?.status ?? "Not Testable"}** — ${markdownText(integrityAssertion?.detail ?? "Integrity suite not yet run; no integrity result is inferred.")}`,
    "",
  );
  if (input.integritySummary) {
    const summary = input.integritySummary;
    lines.push(
      "## Integrity evidence",
      "",
      `- Scale: ${summary.scale}; catalog departments ${summary.catalog.departments}, modules ${summary.catalog.modules}, primitive fields ${summary.catalog.primitiveFields}, relationship fields ${summary.catalog.relationshipFields}.`,
      `- Accepted schemas: ${summary.catalog.acceptedSchemas}/${summary.catalog.modules}; records: ${summary.catalog.observedRecords}/${summary.catalog.expectedRecords} observed/target.`,
      "",
      "| Cardinality | Fields | Active edges | Representative fields |",
      "| --- | ---: | ---: | ---: |",
      ...summary.cardinality.map(
        (item) =>
          `| ${markdownText(item.cardinality)} | ${item.fields} | ${item.activeEdges} | ${item.representativeFields} |`,
      ),
      "",
      "### API negative evidence",
      "",
      ...(summary.apiNegatives.length === 0
        ? ["No API negative attempts were recorded."]
        : summary.apiNegatives.map(
            (item) =>
              `- ${markdownText(item.check)}: HTTP ${item.status} at ${markdownText(item.path)}`,
          )),
      "",
      `- Audit evidence: ${summary.audit.uiRows} UI row(s), ${summary.audit.filteredLogs} filtered log(s), ${summary.audit.detailLogs} fetched detail log(s).`,
      "",
    );
  }
  if (teardownSummary) {
    lines.push(
      "## Teardown outcome",
      "",
      "- Teardown status: **Pass**",
      `- Domain rows removed: ${teardownSummary.domainRowsRemoved}`,
      `- Audit logs retained: ${teardownSummary.auditLogsRetained ? "yes" : "no"} (expected residue; ${teardownSummary.auditLogCount} observed).`,
      ...(teardownSummary.auditEvidence ?? []).map(
        (evidence) =>
          `- Purge audit evidence for department ${markdownText(evidence.rootId)}: request ${markdownText(evidence.requestId)} retained ${evidence.auditLogCount} log(s) covering ${evidence.entities.departments} department, ${evidence.entities.modules} module, ${evidence.entities.fields} field, ${evidence.entities.records} record, and ${evidence.entities.relationships} relationship-edge deletion(s).`,
      ),
      "- This is a domain teardown only, not a full environment reset.",
      "",
    );
  } else {
    lines.push(
      "## Teardown outcome",
      "",
      "- Teardown status: **Not Testable** — domain teardown has not run yet.",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function writeLiveReport(
  runId: string,
  input: LiveReportInput = {},
  resultsRoot = liveResultsDirectory(),
): Promise<string> {
  const validatedRunId = validateRunId(runId);
  const statePatch = reportStatePatch(input);
  if (input.assertions && input.assertions.length > 0) {
    await mergeLiveAssertions(validatedRunId, input.assertions, resultsRoot);
  }
  const reportState = await mergeReportState(
    validatedRunId,
    statePatch,
    resultsRoot,
  );
  const manifest = await readManifest(validatedRunId, resultsRoot);
  const directory = join(liveResultsDirectory(resultsRoot), validatedRunId);
  await ensurePrivateResultsDirectory(directory);
  const filePath = join(directory, "test-report.md");
  await writeTextAtomically(
    filePath,
    renderLiveReport(manifest, {
      ...input,
      assertions: manifest.assertions,
      recordTargetIncludesUiSanityRecords:
        reportState.recordTargetIncludesUiSanityRecords,
      teardownSummary: reportState.teardownSummary,
      integritySummary: reportState.integritySummary,
    }),
  );
  return filePath;
}

export const generateLiveReport = writeLiveReport;
