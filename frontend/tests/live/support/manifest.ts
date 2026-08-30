import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { validateRuntimeNamespace } from "./catalog";
import {
  assertSafeOutputFile,
  ensurePrivateResultsDirectory,
  safeResultsRoot,
  safeRunDirectory,
} from "./paths";
import { sanitizeEvidence, type SanitizedEvidence } from "./sanitize";
import {
  runtimeNamespaceForRunId,
  validateRunId,
  type RunId,
} from "./preflight";
import type { LiveUser } from "./api";

export const LIVE_ASSERTION_STATUSES = [
  "Pass",
  "Fail",
  "Not Supported",
  "Not Testable",
] as const;

export type LiveAssertionStatus = (typeof LIVE_ASSERTION_STATUSES)[number];

export type LiveAssertionResult = Readonly<{
  id: string;
  name: string;
  status: LiveAssertionStatus;
  detail?: string;
}>;

export const LIVE_ACTOR_OPERATION_ID = "actor:admin" as const;

export const LIVE_OPERATION_STATUSES = [
  "planned",
  "running",
  "succeeded",
  "failed",
  "skipped",
] as const;

export type LiveOperationStatus = (typeof LIVE_OPERATION_STATUSES)[number];

export type LiveOperation = Readonly<{
  id: string;
  parent_id: string | null;
  operation: string;
  entity_type: string;
  entity_id: string;
  status: LiveOperationStatus;
  evidence: readonly SanitizedEvidence[];
}>;

export const LIVE_UNKNOWN_ENTITY_ID = "" as const;

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;

const OPERATION_RULES: Readonly<
  Record<
    string,
    Readonly<{ entityType: string; parentTypes: readonly string[] }>
  >
> = {
  record_actor_baseline: { entityType: "actor", parentTypes: [] },
  create_department: { entityType: "department", parentTypes: [] },
  close_department: {
    entityType: "department",
    parentTypes: ["department"],
  },
  purge_department: {
    entityType: "department",
    parentTypes: ["department"],
  },
  create_module: { entityType: "module", parentTypes: ["department"] },
  accept_schema: { entityType: "module", parentTypes: ["module"] },
  close_module: { entityType: "module", parentTypes: ["module"] },
  purge_module: { entityType: "module", parentTypes: ["module"] },
  create_field: { entityType: "field", parentTypes: ["module"] },
  create_relationship_field: { entityType: "field", parentTypes: ["module"] },
  close_field: { entityType: "field", parentTypes: ["module"] },
  purge_field: { entityType: "field", parentTypes: ["module"] },
  create_record: { entityType: "record", parentTypes: ["module"] },
  update_record: { entityType: "record", parentTypes: ["module"] },
  archive_record: { entityType: "record", parentTypes: ["module"] },
  restore_record: { entityType: "record", parentTypes: ["module"] },
  purge_record: { entityType: "record", parentTypes: ["module"] },
  create_relationship_edge: {
    entityType: "relationship",
    parentTypes: ["field"],
  },
  soft_delete_relationship_edge: {
    entityType: "relationship",
    parentTypes: ["field"],
  },
  unlink_relationship_edge: {
    entityType: "relationship",
    parentTypes: ["field"],
  },
};

export type LiveManifest = Readonly<{
  version: 1;
  run_id: RunId;
  namespace: string;
  created_at: string;
  updated_at: string;
  assertions: readonly LiveAssertionResult[];
  operations: readonly LiveOperation[];
}>;

const manifestQueues = new Map<string, Promise<void>>();

export function liveResultsDirectory(
  resultsRoot = "test-results/live",
): string {
  return safeResultsRoot(resultsRoot);
}

export function manifestFilePath(
  runId: string,
  resultsRoot = "test-results/live",
): string {
  return join(
    safeRunDirectory(resultsRoot, validateRunId(runId)),
    "manifest.json",
  );
}

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

export function assertCanonicalUuid(value: string, context: string): string {
  if (!isCanonicalUuid(value)) {
    throw new Error(`${context} must be a canonical lowercase UUID`);
  }
  return value;
}

function isOwnershipCreatingOperation(operation: LiveOperation): boolean {
  return (
    operation.operation === "record_actor_baseline" ||
    operation.operation.startsWith("create_")
  );
}

function isUnknownEntityId(operation: LiveOperation): boolean {
  return (
    operation.status === "running" &&
    isOwnershipCreatingOperation(operation) &&
    !isCanonicalUuid(operation.entity_id)
  );
}

function validateOperationId(operation: LiveOperation): void {
  if (!OPERATION_ID.test(operation.id)) {
    throw new Error(`Live operation ID is invalid: ${operation.id}`);
  }
}

function validateOperation(
  operation: LiveOperation,
  operationsById: ReadonlyMap<string, LiveOperation>,
): void {
  validateOperationId(operation);
  const rule = OPERATION_RULES[operation.operation];
  if (!rule || rule.entityType !== operation.entity_type) {
    throw new Error(
      `Live operation has an unrecognized verb or entity type: ${operation.operation}/${operation.entity_type}`,
    );
  }
  if (!isOperationStatus(operation.status)) {
    throw new Error(
      `Unsupported live operation status: ${String(operation.status)}`,
    );
  }
  if (!isCanonicalUuid(operation.entity_id) && !isUnknownEntityId(operation)) {
    throw new Error(
      `Live operation entity ID must be canonical unless an ownership create is running: ${operation.id}`,
    );
  }
  if (
    operation.entity_type === "actor" &&
    operation.id !== LIVE_ACTOR_OPERATION_ID
  ) {
    throw new Error("Live actor ownership must use actor:admin");
  }
  if (operation.parent_id === null) {
    if (rule.parentTypes.length > 0) {
      throw new Error(`Live operation parent is required: ${operation.id}`);
    }
    return;
  }
  const parent = operationsById.get(operation.parent_id);
  if (!parent) {
    throw new Error(
      `Live operation parent ID does not exist: ${operation.parent_id}`,
    );
  }
  if (parent.status !== "succeeded") {
    throw new Error(`Live operation parent is not confirmed: ${operation.id}`);
  }
  if (!rule.parentTypes.includes(parent.entity_type)) {
    throw new Error(
      `Live operation parent has an invalid entity type: ${operation.id}`,
    );
  }
}

export function validateOperationGraph(
  operations: readonly LiveOperation[],
): void {
  const operationsById = new Map<string, LiveOperation>();
  for (const operation of operations) {
    if (operationsById.has(operation.id)) {
      throw new Error(`Live operation IDs must be unique: ${operation.id}`);
    }
    operationsById.set(operation.id, operation);
  }
  for (const operation of operations) {
    validateOperation(operation, operationsById);
    const seen = new Set<string>();
    let current: LiveOperation | undefined = operation;
    while (current?.parent_id !== null && current !== undefined) {
      if (seen.has(current.id)) {
        throw new Error(
          `Live operation graph contains a cycle: ${operation.id}`,
        );
      }
      seen.add(current.id);
      current = operationsById.get(current.parent_id);
      if (!current) break;
    }
  }
}

export function assertManifestReadyForTeardown(manifest: LiveManifest): void {
  if (runtimeNamespaceForRunId(manifest.run_id) !== manifest.namespace) {
    throw new Error(
      "Live manifest namespace must be the deterministic namespace derived from its run ID",
    );
  }
  validateOperationGraph(manifest.operations);
  const unfinished = manifest.operations.filter(
    (operation) => operation.status !== "succeeded",
  );
  if (unfinished.length > 0) {
    throw new Error(
      `Live manifest has unfinished operations and cannot be torn down: ${unfinished
        .map((operation) => operation.id)
        .join(", ")}`,
    );
  }
}

function isOperationStatus(value: unknown): value is LiveOperationStatus {
  return (
    typeof value === "string" &&
    (LIVE_OPERATION_STATUSES as readonly string[]).includes(value)
  );
}

function isAssertionStatus(value: unknown): value is LiveAssertionStatus {
  return (
    typeof value === "string" &&
    (LIVE_ASSERTION_STATUSES as readonly string[]).includes(value)
  );
}

function isAssertion(value: unknown): value is LiveAssertionResult {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    isAssertionStatus(value.status) &&
    (value.detail === undefined || typeof value.detail === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManifest(value: unknown): value is LiveManifest {
  if (!isRecord(value) || value.version !== 1) return false;
  if (
    typeof value.run_id !== "string" ||
    typeof value.namespace !== "string" ||
    typeof value.created_at !== "string" ||
    typeof value.updated_at !== "string" ||
    !Array.isArray(value.operations) ||
    (value.assertions !== undefined &&
      (!Array.isArray(value.assertions) ||
        !value.assertions.every(isAssertion)))
  ) {
    return false;
  }
  return value.operations.every((operation) => {
    if (!isRecord(operation)) return false;
    return (
      typeof operation.id === "string" &&
      (operation.parent_id === null ||
        typeof operation.parent_id === "string") &&
      typeof operation.operation === "string" &&
      typeof operation.entity_type === "string" &&
      typeof operation.entity_id === "string" &&
      isOperationStatus(operation.status) &&
      Array.isArray(operation.evidence)
    );
  });
}

async function readManifestFile(
  filePath: string,
  expectedRunId?: RunId,
): Promise<LiveManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read live manifest: ${String(error)}`);
  }
  if (!isManifest(parsed))
    throw new Error("Live manifest has an invalid shape");
  const parsedRunId = validateRunId(parsed.run_id);
  if (expectedRunId && parsedRunId !== expectedRunId) {
    throw new Error("Live manifest run ID does not match its requested path");
  }
  const namespace = validateRuntimeNamespace(parsed.namespace);
  if (namespace !== runtimeNamespaceForRunId(parsedRunId)) {
    throw new Error(
      "Live manifest namespace must be the deterministic namespace derived from its run ID",
    );
  }
  const manifest: LiveManifest = {
    ...parsed,
    run_id: parsedRunId,
    namespace,
    assertions: (parsed.assertions ?? []).map(normalizeAssertion),
  };
  validateOperationGraph(manifest.operations);
  return manifest;
}

async function writeAtomically(
  filePath: string,
  value: LiveManifest,
): Promise<void> {
  const directory = dirname(filePath);
  await ensurePrivateResultsDirectory(directory);
  await assertSafeOutputFile(filePath);
  const temporaryPath = join(
    directory,
    `.manifest-${process.pid}-${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
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

async function assertManifestDoesNotExist(filePath: string): Promise<void> {
  try {
    await readFile(filePath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  throw new Error("Live manifest already exists for this run ID");
}

export async function assertManifestIsFresh(
  runId: string,
  resultsRoot = "test-results/live",
): Promise<void> {
  await assertManifestDoesNotExist(manifestFilePath(runId, resultsRoot));
}

async function enqueue<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = manifestQueues.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const completion = current.then(
    () => undefined,
    () => undefined,
  );
  manifestQueues.set(filePath, completion);
  try {
    return await current;
  } finally {
    if (manifestQueues.get(filePath) === completion)
      manifestQueues.delete(filePath);
  }
}

export async function createManifest(
  runId: string,
  namespace: string,
  resultsRoot = "test-results/live",
  now = new Date(),
): Promise<LiveManifest> {
  const validatedRunId = validateRunId(runId);
  const validatedNamespace = validateRuntimeNamespace(namespace);
  if (validatedNamespace !== runtimeNamespaceForRunId(validatedRunId)) {
    throw new Error(
      "Live manifest namespace must be the deterministic namespace derived from its run ID",
    );
  }
  const filePath = manifestFilePath(validatedRunId, resultsRoot);
  return enqueue(filePath, async () => {
    await assertManifestDoesNotExist(filePath);
    const timestamp = now.toISOString();
    const manifest: LiveManifest = {
      version: 1,
      run_id: validatedRunId,
      namespace: validatedNamespace,
      created_at: timestamp,
      updated_at: timestamp,
      assertions: [],
      operations: [],
    };
    await writeAtomically(filePath, manifest);
    return manifest;
  });
}

export async function readManifest(
  runId: string,
  resultsRoot = "test-results/live",
): Promise<LiveManifest> {
  const validatedRunId = validateRunId(runId);
  return readManifestFile(
    manifestFilePath(validatedRunId, resultsRoot),
    validatedRunId,
  );
}

export async function updateManifest(
  runId: string,
  updater: (manifest: LiveManifest) => LiveManifest | Promise<LiveManifest>,
  resultsRoot = "test-results/live",
  now = new Date(),
): Promise<LiveManifest> {
  const filePath = manifestFilePath(runId, resultsRoot);
  return enqueue(filePath, async () => {
    const current = await readManifestFile(filePath, validateRunId(runId));
    const updated = await updater(current);
    if (!isManifest(updated))
      throw new Error("Live manifest update has an invalid shape");
    const manifest: LiveManifest = {
      ...updated,
      run_id: current.run_id,
      namespace: current.namespace,
      updated_at: now.toISOString(),
      assertions: (updated.assertions ?? current.assertions).map(
        normalizeAssertion,
      ),
      operations: updated.operations.map((operation) => ({
        ...operation,
        evidence: operation.evidence.map((item) => sanitizeEvidence(item)),
      })),
    };
    validateOperationGraph(manifest.operations);
    await writeAtomically(filePath, manifest);
    return manifest;
  });
}

function normalizeAssertion(
  assertion: LiveAssertionResult,
): LiveAssertionResult {
  const id = sanitizeAssertionText(assertion.id, "id", 200);
  const name = sanitizeAssertionText(assertion.name, "name", 300);
  if (!isAssertionStatus(assertion.status)) {
    throw new Error(
      "Live assertions require an ID, name, and supported status",
    );
  }
  const detail =
    assertion.detail === undefined
      ? undefined
      : sanitizeAssertionText(assertion.detail, "detail", 2_000);
  return {
    id,
    name,
    status: assertion.status,
    ...(detail === undefined ? {} : { detail }),
  };
}

function sanitizeAssertionText(
  value: unknown,
  field: "id" | "name" | "detail",
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`Live assertion ${field} must be a string`);
  }
  const sanitized = String(sanitizeEvidence(value));
  if (sanitized.trim() === "" || sanitized.length > maxLength) {
    throw new Error(`Live assertion ${field} exceeds its safety limit`);
  }
  return sanitized;
}

export async function mergeLiveAssertions(
  runId: string,
  assertions: readonly LiveAssertionResult[],
  resultsRoot = "test-results/live",
): Promise<LiveManifest> {
  const normalized = assertions.map(normalizeAssertion);
  if (
    new Set(normalized.map((assertion) => assertion.id)).size !==
    normalized.length
  ) {
    throw new Error(
      "Live assertion IDs must be unique within one result merge",
    );
  }
  return updateManifest(
    runId,
    (manifest) => {
      const byId = new Map(
        manifest.assertions.map((assertion) => [assertion.id, assertion]),
      );
      for (const assertion of normalized) byId.set(assertion.id, assertion);
      return { ...manifest, assertions: [...byId.values()] };
    },
    resultsRoot,
  );
}

export type LiveActorBaseline = Readonly<{
  userId: string;
  email: string;
  roleId: string;
  status: LiveUser["status"];
}>;

export function actorBaselineFromUser(
  user: Pick<LiveUser, "id" | "email" | "role_id" | "status">,
): LiveActorBaseline {
  if (user.status !== "active") {
    throw new Error(
      "Live administrator must be active before domain mutations",
    );
  }
  return {
    userId: user.id,
    email: user.email,
    roleId: user.role_id,
    status: user.status,
  };
}

export function createActorOperation(
  baseline: LiveActorBaseline,
): LiveOperation {
  return {
    id: LIVE_ACTOR_OPERATION_ID,
    parent_id: null,
    operation: "record_actor_baseline",
    entity_type: "actor",
    entity_id: baseline.userId,
    status: "succeeded",
    evidence: [
      {
        actor: {
          user_id: baseline.userId,
          email: baseline.email,
          role_id: baseline.roleId,
          status: baseline.status,
        },
      },
    ],
  };
}

function actorBaselineFromOperation(manifest: LiveManifest): LiveActorBaseline {
  const operation = manifest.operations.find(
    (candidate) => candidate.id === LIVE_ACTOR_OPERATION_ID,
  );
  const evidence = operation?.evidence[0];
  const actor =
    isRecord(evidence) && isRecord(evidence.actor) ? evidence.actor : null;
  if (
    !operation ||
    operation.status !== "succeeded" ||
    operation.parent_id !== null ||
    operation.operation !== "record_actor_baseline" ||
    operation.entity_type !== "actor" ||
    !actor ||
    operation.entity_id !== actor.user_id ||
    typeof actor.user_id !== "string" ||
    typeof actor.email !== "string" ||
    typeof actor.role_id !== "string" ||
    (actor.status !== "pending" &&
      actor.status !== "active" &&
      actor.status !== "disabled")
  ) {
    throw new Error(
      "Live manifest is missing an immutable actor:admin baseline",
    );
  }
  return {
    userId: actor.user_id,
    email: actor.email,
    roleId: actor.role_id,
    status: actor.status,
  };
}

export function assertActorMatchesManifest(
  manifest: LiveManifest,
  user: Pick<LiveUser, "id" | "email" | "role_id" | "status">,
): void {
  const baseline = actorBaselineFromOperation(manifest);
  if (
    user.id !== baseline.userId ||
    user.email !== baseline.email ||
    user.role_id !== baseline.roleId ||
    user.status !== baseline.status
  ) {
    throw new Error("Current live actor does not match the manifest baseline");
  }
}

export function manifestOperationIdForEntity(
  manifest: LiveManifest,
  entityType: string,
  entityId: string,
): string {
  const candidates = manifest.operations.filter(
    (operation) =>
      operation.status === "succeeded" &&
      operation.entity_type === entityType &&
      operation.entity_id === entityId,
  );
  const preferred = candidates.find((operation) =>
    operation.id.startsWith(`${entityType}:`),
  );
  const operation = preferred ?? candidates[0];
  if (!operation) {
    throw new Error(
      `Live manifest has no confirmed operation for ${entityType}:${entityId}`,
    );
  }
  return operation.id;
}

export type ManifestOwnedEntities = Readonly<{
  departments: ReadonlySet<string>;
  modules: ReadonlySet<string>;
  fields: ReadonlySet<string>;
  records: ReadonlySet<string>;
  relationships: ReadonlySet<string>;
}>;

export type ManifestRootOwnership = ManifestOwnedEntities &
  Readonly<{ rootId: string; rootOperationId: string }>;

const DOMAIN_ENTITY_TYPES = [
  "department",
  "module",
  "field",
  "record",
  "relationship",
] as const;

type DomainEntityType = (typeof DOMAIN_ENTITY_TYPES)[number];

function ownershipKey(
  entityType: DomainEntityType,
): keyof ManifestOwnedEntities {
  return entityType === "relationship"
    ? "relationships"
    : (`${entityType}s` as keyof ManifestOwnedEntities);
}

function isManifestOwnershipOperation(operation: LiveOperation): boolean {
  return (
    operation.status === "succeeded" &&
    (operation.operation === "record_actor_baseline" ||
      operation.operation.startsWith("create_"))
  );
}

export function manifestOwnedEntities(
  manifest: LiveManifest,
): ManifestOwnedEntities {
  const owned = {
    departments: new Set<string>(),
    modules: new Set<string>(),
    fields: new Set<string>(),
    records: new Set<string>(),
    relationships: new Set<string>(),
  };
  for (const operation of manifest.operations) {
    if (
      !isManifestOwnershipOperation(operation) ||
      !(DOMAIN_ENTITY_TYPES as readonly string[]).includes(
        operation.entity_type,
      )
    ) {
      continue;
    }
    owned[ownershipKey(operation.entity_type as DomainEntityType)].add(
      operation.entity_id,
    );
  }
  return owned;
}

function isDescendantOf(
  operation: LiveOperation,
  ancestorId: string,
  operationsById: ReadonlyMap<string, LiveOperation>,
): boolean {
  const visited = new Set<string>();
  let current: LiveOperation | undefined = operation;
  while (current) {
    if (current.status !== "succeeded") return false;
    if (current.id === ancestorId) return true;
    if (current.parent_id === null || visited.has(current.id)) return false;
    visited.add(current.id);
    current = operationsById.get(current.parent_id);
  }
  return false;
}

export function manifestRootOwnership(
  manifest: LiveManifest,
  rootOperationId: string,
): ManifestRootOwnership {
  const operationsById = new Map(
    manifest.operations.map((operation) => [operation.id, operation]),
  );
  const root = operationsById.get(rootOperationId);
  if (
    !root ||
    root.status !== "succeeded" ||
    root.entity_type !== "department" ||
    root.parent_id !== null
  ) {
    throw new Error(
      `Live manifest root operation is invalid: ${rootOperationId}`,
    );
  }
  const owned = {
    departments: new Set<string>(),
    modules: new Set<string>(),
    fields: new Set<string>(),
    records: new Set<string>(),
    relationships: new Set<string>(),
  };
  for (const operation of manifest.operations) {
    if (
      !isManifestOwnershipOperation(operation) ||
      !(DOMAIN_ENTITY_TYPES as readonly string[]).includes(
        operation.entity_type,
      ) ||
      !isDescendantOf(operation, rootOperationId, operationsById)
    ) {
      continue;
    }
    owned[ownershipKey(operation.entity_type as DomainEntityType)].add(
      operation.entity_id,
    );
  }
  return {
    rootId: root.entity_id,
    rootOperationId,
    ...owned,
  };
}

function normalizeOperation(operation: LiveOperation): LiveOperation {
  if (!operation.id || !operation.operation || !operation.entity_type) {
    throw new Error("Live operations require exact IDs and operation metadata");
  }
  if (!isOperationStatus(operation.status)) {
    throw new Error(
      `Unsupported live operation status: ${String(operation.status)}`,
    );
  }
  return {
    ...operation,
    evidence: operation.evidence.map((item) => sanitizeEvidence(item)),
  };
}

export async function appendOperation(
  runId: string,
  operation: LiveOperation,
  resultsRoot = "test-results/live",
): Promise<LiveManifest> {
  const normalized = normalizeOperation(operation);
  return updateManifest(
    runId,
    (manifest) => {
      if (manifest.operations.some((item) => item.id === normalized.id)) {
        throw new Error(`Live operation ID already exists: ${normalized.id}`);
      }
      if (
        normalized.parent_id !== null &&
        !manifest.operations.some((item) => item.id === normalized.parent_id)
      ) {
        throw new Error(
          `Live operation parent ID does not exist: ${normalized.parent_id}`,
        );
      }
      const updated = {
        ...manifest,
        operations: [...manifest.operations, normalized],
      };
      validateOperationGraph(updated.operations);
      return updated;
    },
    resultsRoot,
  );
}

export const journalOperation = appendOperation;

export async function beginOperation(
  runId: string,
  operation: Omit<LiveOperation, "status" | "entity_id"> & {
    entity_id?: string;
  },
  resultsRoot = "test-results/live",
): Promise<LiveManifest> {
  return appendOperation(
    runId,
    {
      ...operation,
      entity_id: operation.entity_id ?? LIVE_UNKNOWN_ENTITY_ID,
      status: "running",
      evidence: operation.evidence ?? [],
    },
    resultsRoot,
  );
}

export async function updateOperationStatus(
  runId: string,
  operationId: string,
  status: LiveOperationStatus,
  evidence: readonly unknown[] = [],
  resultsRoot = "test-results/live",
): Promise<LiveManifest> {
  if (!operationId) throw new Error("Live operation ID is required");
  if (operationId === LIVE_ACTOR_OPERATION_ID) {
    throw new Error("The live actor baseline is immutable");
  }
  if (!isOperationStatus(status)) {
    throw new Error(`Unsupported live operation status: ${String(status)}`);
  }
  return updateManifest(
    runId,
    (manifest) => {
      let found = false;
      const operations = manifest.operations.map((operation) => {
        if (operation.id !== operationId) return operation;
        found = true;
        return {
          ...operation,
          status,
          evidence: evidence.map(sanitizeEvidence),
        };
      });
      if (!found)
        throw new Error(`Live operation ID does not exist: ${operationId}`);
      return { ...manifest, operations };
    },
    resultsRoot,
  );
}

export async function finalizeOperation(
  runId: string,
  operationId: string,
  entityId: string,
  evidence: readonly unknown[] = [],
  resultsRoot = "test-results/live",
): Promise<LiveManifest> {
  assertCanonicalUuid(entityId, `Live operation ${operationId} entity ID`);
  return updateManifest(
    runId,
    (manifest) => {
      const operation = manifest.operations.find(
        (candidate) => candidate.id === operationId,
      );
      if (!operation) {
        throw new Error(`Live operation ID does not exist: ${operationId}`);
      }
      if (operation.status !== "running") {
        throw new Error(
          `Live operation is not awaiting finalization: ${operationId}`,
        );
      }
      if (
        isCanonicalUuid(operation.entity_id) &&
        operation.entity_id !== entityId
      ) {
        throw new Error(`Live operation entity ID changed: ${operationId}`);
      }
      return {
        ...manifest,
        operations: manifest.operations.map((candidate) =>
          candidate.id === operationId
            ? {
                ...candidate,
                entity_id: entityId,
                status: "succeeded" as const,
                evidence: evidence.map(sanitizeEvidence),
              }
            : candidate,
        ),
      };
    },
    resultsRoot,
  );
}

export const journalOperationStatus = updateOperationStatus;
