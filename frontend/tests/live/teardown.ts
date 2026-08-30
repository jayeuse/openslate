import {
  isLiveAuditLog,
  isLiveDepartment,
  isLiveField,
  isLiveModule,
  isLiveRecord,
  isLiveRelationship,
  isLiveUser,
  LiveApiError,
  type LiveApiClient,
  type LiveAuditLog,
  type LiveDepartment,
  type LiveField,
  type LiveModule,
  type LiveRecord,
  type LiveRelationship,
  type LiveUser,
} from "./support/api";
import { withLiveAdminToken } from "./support/auth";
import {
  assertExactLifecycleImpact,
  isLiveLifecycleMutation,
  isLiveLifecyclePreview,
  lifecycleConfirmationPayload,
  type LifecycleRowsByEntity,
  type LiveLifecycleMutation,
  type LiveLifecyclePreview,
} from "./support/lifecycle";
import {
  assertActorMatchesManifest,
  assertCanonicalUuid,
  assertManifestReadyForTeardown,
  appendOperation,
  isCanonicalUuid,
  manifestOperationIdForEntity,
  manifestOwnedEntities,
  manifestRootOwnership,
  readManifest,
  updateOperationStatus,
  type LiveManifest,
  type ManifestRootOwnership,
} from "./support/manifest";
import {
  acquireLiveLock,
  getLiveTeardownEnvironment,
  LIVE_TEARDOWN_MODE,
  type LiveTeardownEnvironment,
} from "./support/preflight";
import { liveResultsDirectory } from "./support/manifest";
import { writeLiveReport } from "./support/report";
import type { LivePurgeAuditEvidence } from "./support/report";
import {
  liveScaleFromEnvironment,
  reconstructSeedMaps,
  targetRecordCount,
  type ReconstructedSeedMaps,
} from "./seed-data";
import { runMarkerValue } from "./support/seed-helpers";
import type { CatalogModule } from "./support/catalog";

export type { ManifestRootOwnership } from "./support/manifest";

export type TeardownOptions = Readonly<{
  resultsRoot?: string;
}>;

export type TeardownResult = Readonly<{
  runId: string;
  purgedRoots: number;
  domainRowsRemoved: number;
  auditLogCountBefore: number;
  auditLogCountAfter: number;
}>;

export type RootInventory = Readonly<{
  department: LiveDepartment;
  modules: readonly LiveModule[];
  fields: readonly LiveField[];
  records: readonly LiveRecord[];
  relationships: readonly LiveRelationship[];
}>;

export type PurgeAuditScope = Readonly<{
  departmentId: string;
  moduleIds: readonly string[];
  fieldIds: readonly string[];
  recordIds: readonly string[];
  relationshipIds: readonly string[];
}>;

type MutationResult = Readonly<{
  status: number;
  body?: unknown;
}>;

type RootTeardownResult = Readonly<{
  domainRowsRemoved: number;
  auditEvidence?: LivePurgeAuditEvidence;
}>;

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function assertExactIds(
  actual: readonly string[],
  expected: ReadonlySet<string>,
  label: string,
): void {
  const actualIds = sorted(actual);
  const expectedIds = sorted(expected);
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new Error(
      `${label} is not an exact manifest match (expected ${expectedIds.length}, received ${actualIds.length})`,
    );
  }
}

export function assertNoUnexpectedManifestEdges(
  edges: readonly LiveRelationship[],
  ownership: ManifestRootOwnership,
): void {
  const unexpected = edges.filter((edge) => {
    return !(
      isCanonicalUuid(edge.id) &&
      isCanonicalUuid(edge.field_id) &&
      isCanonicalUuid(edge.source_record_id) &&
      isCanonicalUuid(edge.target_record_id) &&
      ownership.relationships.has(edge.id) &&
      ownership.fields.has(edge.field_id) &&
      ownership.records.has(edge.source_record_id) &&
      ownership.records.has(edge.target_record_id)
    );
  });
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected relationship edge or external impact is not represented by the manifest: ${unexpected
        .map((edge) => edge.id)
        .join(",")}`,
    );
  }
}

export function assertMutationCanStart(
  manifest: LiveManifest,
  operationId: string,
): boolean {
  const operation = manifest.operations.find((item) => item.id === operationId);
  if (!operation) return true;
  if (operation.status === "succeeded") return false;
  throw new Error(
    `Live destructive mutation has an uncertain journal state: ${operationId} (${operation.status})`,
  );
}

function operationEvidence(
  method: "POST" | "DELETE",
  status: number,
): readonly Record<string, unknown>[] {
  return [{ request: { method, status } }];
}

async function confirmedMutation(
  runId: string,
  operationId: string,
  parentId: string,
  operation: string,
  entityType: string,
  entityId: string,
  method: "POST" | "DELETE",
  mutate: () => Promise<MutationResult>,
  resultsRoot: string,
): Promise<MutationResult | null> {
  const manifest = await readManifest(runId, resultsRoot);
  if (!assertMutationCanStart(manifest, operationId)) return null;
  await appendOperation(
    runId,
    {
      id: operationId,
      parent_id: parentId,
      operation,
      entity_type: entityType,
      entity_id: entityId,
      status: "running",
      evidence: [],
    },
    resultsRoot,
  );
  const result = await mutate();
  await updateOperationStatus(
    runId,
    operationId,
    "succeeded",
    operationEvidence(method, result.status),
    resultsRoot,
  );
  return result;
}

async function listRootInventory(
  api: LiveApiClient,
  ownership: ManifestRootOwnership,
): Promise<RootInventory> {
  const department = await api.get(
    `/departments/${ownership.rootId}`,
    undefined,
    isLiveDepartment,
  );
  const modules = await api.listAll<LiveModule>(
    "/modules",
    { department_id: ownership.rootId, deleted: "include", limit: 100 },
    1000,
    isLiveModule,
  );
  assertExactIds(
    modules.map((module) => module.id),
    ownership.modules,
    "Manifest root modules",
  );

  const fields: LiveField[] = [];
  const records: LiveRecord[] = [];
  for (const catalogModule of [...modules].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const moduleFields = await api.listAll<LiveField>(
      "/fields",
      { module_id: catalogModule.id, deleted: "include", limit: 100 },
      1000,
      isLiveField,
    );
    const moduleRecords = await api.listAll<LiveRecord>(
      "/records",
      { module_id: catalogModule.id, deleted: "include", limit: 100 },
      1000,
      isLiveRecord,
    );
    fields.push(...moduleFields);
    records.push(...moduleRecords);
  }
  assertExactIds(
    fields.map((field) => field.id),
    ownership.fields,
    "Manifest root fields",
  );
  const externalRelationshipFields = fields.filter(
    (field) =>
      field.type === "relationship" &&
      field.relationship_target_module_id !== null &&
      !ownership.modules.has(field.relationship_target_module_id),
  );
  if (externalRelationshipFields.length > 0) {
    throw new Error(
      `Unexpected external schema dependency is not represented by the manifest: ${externalRelationshipFields
        .map((field) => field.id)
        .join(",")}`,
    );
  }
  assertExactIds(
    records.map((record) => record.id),
    ownership.records,
    "Manifest root records",
  );

  const edgesById = new Map<string, LiveRelationship>();
  for (const fieldId of sorted(ownership.fields)) {
    const edges = await api.listAll<LiveRelationship>(
      "/relationships",
      {
        field_id: fieldId,
        availability: "all",
        deleted: "include",
        limit: 100,
      },
      1000,
      isLiveRelationship,
    );
    for (const edge of edges) edgesById.set(edge.id, edge);
  }
  for (const recordId of sorted(ownership.records)) {
    const edges = await api.listAll<LiveRelationship>(
      "/relationships",
      {
        incident_record_id: recordId,
        availability: "all",
        deleted: "include",
        limit: 100,
      },
      1000,
      isLiveRelationship,
    );
    for (const edge of edges) edgesById.set(edge.id, edge);
  }
  const relationships = [...edgesById.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  assertNoUnexpectedManifestEdges(relationships, ownership);
  assertExactIds(
    relationships.map((relationship) => relationship.id),
    ownership.relationships,
    "Manifest root relationships",
  );
  return { department, modules, fields, records, relationships };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function assertSameValue(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  if (
    JSON.stringify(stableValue(actual)) !==
    JSON.stringify(stableValue(expected))
  ) {
    throw new Error(`${label} does not match the manifest catalog`);
  }
}

function recordIdsFromManifest(
  manifest: LiveManifest,
  catalogModule: CatalogModule,
  targetCount: number,
): ReadonlyMap<number, string> {
  const expected = new Map<number, string>();
  const prefix = `module:${catalogModule.key}`;
  for (const operation of manifest.operations) {
    if (
      operation.operation !== "create_record" ||
      operation.entity_type !== "record" ||
      operation.parent_id !== prefix
    ) {
      continue;
    }
    const match = /^(?:record|bulk-record):([^:]+):(\d+)$/.exec(operation.id);
    if (!match || match[1] !== catalogModule.key) {
      throw new Error(
        `Record operation ID is not derived from its module: ${operation.id}`,
      );
    }
    const recordNumber = Number(match[2]);
    if (
      !Number.isSafeInteger(recordNumber) ||
      recordNumber < 1 ||
      recordNumber > targetCount ||
      expected.has(recordNumber)
    ) {
      throw new Error(`Record operation number is invalid: ${operation.id}`);
    }
    if (
      operation.status !== "succeeded" ||
      !isCanonicalUuid(operation.entity_id)
    ) {
      throw new Error(`Record operation is not confirmed: ${operation.id}`);
    }
    expected.set(recordNumber, operation.entity_id);
  }
  if (expected.size !== targetCount) {
    throw new Error(
      `Record operation catalog is incomplete for ${catalogModule.key}`,
    );
  }
  return expected;
}

function validateRootCatalog(
  inventory: RootInventory,
  ownership: ManifestRootOwnership,
  maps: ReconstructedSeedMaps,
  scale: "standard" | "extended",
): void {
  const { runtime, manifest } = maps;
  const department = runtime.departments.find(
    (candidate) => maps.departmentIds.get(candidate.key) === ownership.rootId,
  );
  if (!department)
    throw new Error("Manifest root is not in the runtime catalog");
  assertCanonicalUuid(inventory.department.id, "Department ID");
  if (
    inventory.department.id !== ownership.rootId ||
    inventory.department.department_name !== department.name ||
    inventory.department.is_deleted
  ) {
    throw new Error(
      "Root department does not exactly match the manifest catalog",
    );
  }

  assertExactIds(
    inventory.modules.map((module) => module.id),
    new Set(
      department.modules.map((module) => {
        const id = maps.moduleIds.get(module.key);
        if (!id)
          throw new Error(`Manifest module ID is missing: ${module.key}`);
        return id;
      }),
    ),
    "Manifest root modules",
  );
  for (const catalogModule of department.modules) {
    const moduleId = maps.moduleIds.get(catalogModule.key);
    const actual = inventory.modules.find((module) => module.id === moduleId);
    if (
      !actual ||
      actual.module_name !== catalogModule.name ||
      actual.department_id !== ownership.rootId ||
      actual.is_schema_accepted !== true ||
      actual.is_deleted
    ) {
      throw new Error(
        `Module does not exactly match the manifest catalog: ${catalogModule.key}`,
      );
    }

    const expectedFields = new Map<string, Readonly<Record<string, unknown>>>();
    for (const primitive of catalogModule.primitiveFields) {
      const id = maps.fieldIds.get(primitive.key);
      if (!id)
        throw new Error(`Manifest field ID is missing: ${primitive.key}`);
      expectedFields.set(id, {
        name: primitive.name,
        type: primitive.type,
        required: primitive.required,
        position: primitive.order,
        config: primitive.config,
        relationship_target_module_id: null,
        relationship_multiple_targets: null,
        relationship_multiple_sources: null,
      });
    }
    const sourceRelationships = runtime.relationships.filter(
      (relationship) => relationship.sourceModuleKey === catalogModule.key,
    );
    sourceRelationships.forEach((relationship, index) => {
      const id = maps.relationshipFieldIds.get(relationship.key);
      if (!id)
        throw new Error(
          `Manifest relationship field ID is missing: ${relationship.key}`,
        );
      expectedFields.set(id, {
        name: relationship.name,
        type: "relationship",
        required: false,
        position: catalogModule.primitiveFields.length + index,
        config: {},
        relationship_target_module_id: maps.moduleIds.get(
          relationship.targetModuleKey,
        ),
        relationship_multiple_targets: relationship.multipleTargets,
        relationship_multiple_sources: relationship.multipleSources,
      });
    });
    const actualFields = inventory.fields.filter(
      (field) => field.module_id === moduleId,
    );
    assertExactIds(
      actualFields.map((field) => field.id),
      new Set(expectedFields.keys()),
      `Manifest fields for ${catalogModule.key}`,
    );
    for (const field of actualFields) {
      assertCanonicalUuid(field.id, "Field ID");
      if (field.is_deleted)
        throw new Error(`Manifest field is closed: ${field.id}`);
      const expected = expectedFields.get(field.id);
      if (!expected) throw new Error(`Unexpected manifest field: ${field.id}`);
      for (const key of [
        "name",
        "type",
        "required",
        "position",
        "relationship_target_module_id",
        "relationship_multiple_targets",
        "relationship_multiple_sources",
      ]) {
        if (field[key as keyof typeof field] !== expected[key]) {
          throw new Error(`Field ${field.id} has unexpected ${key}`);
        }
      }
      assertSameValue(
        field.config,
        expected.config,
        `Field ${field.id} config`,
      );
    }

    const expectedRecordIds = recordIdsFromManifest(
      manifest,
      catalogModule,
      targetRecordCount(scale, catalogModule.order),
    );
    const actualRecords = inventory.records.filter(
      (record) => record.module_id === moduleId,
    );
    assertExactIds(
      actualRecords.map((record) => record.id),
      new Set(expectedRecordIds.values()),
      `Manifest records for ${catalogModule.key}`,
    );
    const markerId = maps.fieldIds.get(`${catalogModule.key}.run-marker`);
    if (!markerId)
      throw new Error(`Run marker field ID is missing: ${catalogModule.key}`);
    for (const [recordNumber, recordId] of expectedRecordIds) {
      const record = actualRecords.find(
        (candidate) => candidate.id === recordId,
      );
      if (!record || record.is_deleted) {
        throw new Error(`Manifest record is missing or closed: ${recordId}`);
      }
      const expectedMarker = runMarkerValue(
        manifest.run_id,
        catalogModule.key,
        recordNumber,
      );
      if (record.data[markerId] !== expectedMarker) {
        throw new Error(`Record ${recordId} has an invalid run marker`);
      }
    }
  }

  for (const edge of inventory.relationships) {
    assertCanonicalUuid(edge.id, "Relationship edge ID");
    const relationship = runtime.relationships.find(
      (candidate) =>
        maps.relationshipFieldIds.get(candidate.key) === edge.field_id,
    );
    if (
      !relationship ||
      !ownership.fields.has(edge.field_id) ||
      !ownership.records.has(edge.source_record_id) ||
      !ownership.records.has(edge.target_record_id)
    ) {
      throw new Error(`Relationship edge is not manifest-owned: ${edge.id}`);
    }
    const sourceModuleId = maps.moduleIds.get(relationship.sourceModuleKey);
    const targetModuleId = maps.moduleIds.get(relationship.targetModuleKey);
    const source = inventory.records.find(
      (record) => record.id === edge.source_record_id,
    );
    const target = inventory.records.find(
      (record) => record.id === edge.target_record_id,
    );
    if (
      !source ||
      !target ||
      source.module_id !== sourceModuleId ||
      target.module_id !== targetModuleId
    ) {
      throw new Error(`Relationship edge has unexpected endpoints: ${edge.id}`);
    }
  }
}

async function validateTeardownCatalog(
  api: LiveApiClient,
  manifest: LiveManifest,
  maps: ReconstructedSeedMaps,
  scale: "standard" | "extended",
): Promise<void> {
  const ownership = manifestOwnedEntities(manifest);
  const departments = await api.listAll<LiveDepartment>(
    "/departments",
    { search: manifest.namespace, deleted: "include", limit: 100 },
    1000,
    isLiveDepartment,
  );
  assertExactIds(
    departments.map((department) => department.id),
    ownership.departments,
    "Manifest departments",
  );
  if (departments.length !== 12)
    throw new Error("Live teardown requires exactly 12 manifest departments");
  for (const department of maps.runtime.departments) {
    const id = maps.departmentIds.get(department.key);
    const actual = departments.find((candidate) => candidate.id === id);
    if (
      !actual ||
      actual.department_name !== department.name ||
      actual.is_deleted
    ) {
      throw new Error(
        `Department does not exactly match the manifest catalog: ${department.key}`,
      );
    }
  }

  const modules = await api.listAll<LiveModule>(
    "/modules",
    { search: manifest.namespace, deleted: "include", limit: 100 },
    1000,
    isLiveModule,
  );
  assertExactIds(
    modules.map((module) => module.id),
    ownership.modules,
    "Manifest modules",
  );
  if (modules.length !== 57)
    throw new Error("Live teardown requires exactly 57 manifest modules");

  const allFields = await api.listAll<LiveField>(
    "/fields",
    { deleted: "include", limit: 100 },
    1000,
    isLiveField,
  );
  for (const field of allFields) {
    assertCanonicalUuid(field.id, "Field ID");
    if (
      field.type === "relationship" &&
      field.relationship_target_module_id !== null &&
      ownership.modules.has(field.relationship_target_module_id) &&
      !ownership.fields.has(field.id)
    ) {
      throw new Error(
        `External relationship schema dependency targets the live run: ${field.id}`,
      );
    }
  }

  for (const department of maps.runtime.departments) {
    const rootOperationId = `department:${department.key}`;
    const rootOwnership = manifestRootOwnership(manifest, rootOperationId);
    const inventory = await listRootInventory(api, rootOwnership);
    validateRootCatalog(inventory, rootOwnership, maps, scale);
  }

  const allRelationships = await api.listAll<LiveRelationship>(
    "/relationships",
    { availability: "all", deleted: "include", limit: 100 },
    1000,
    isLiveRelationship,
  );
  for (const edge of allRelationships) {
    if (
      ownership.fields.has(edge.field_id) ||
      ownership.records.has(edge.source_record_id) ||
      ownership.records.has(edge.target_record_id)
    ) {
      if (!ownership.relationships.has(edge.id)) {
        throw new Error(
          `External or unjournaled relationship edge touches the live run: ${edge.id}`,
        );
      }
    }
  }
}

function expectedRows(
  inventory: RootInventory,
  operation: "close" | "purge",
): LifecycleRowsByEntity {
  const rows = <Item extends { is_deleted: boolean }>(
    items: readonly Item[],
  ): readonly string[] =>
    items
      .filter((item) => operation === "purge" || !item.is_deleted)
      .map((item) => (item as Item & { id: string }).id);
  return {
    departments: rows([inventory.department]),
    modules: rows(inventory.modules),
    fields: rows(inventory.fields),
    records: rows(inventory.records),
  };
}

function assertRootClosed(inventory: RootInventory): void {
  const openRows = [
    inventory.department,
    ...inventory.modules,
    ...inventory.fields,
    ...inventory.records,
  ].filter((row) => !row.is_deleted);
  if (openRows.length > 0) {
    throw new Error(
      "A completed close journal does not match current root state",
    );
  }
}

async function unlinkOwnedEdges(
  api: LiveApiClient,
  runId: string,
  inventory: RootInventory,
  resultsRoot: string,
): Promise<void> {
  const manifest = await readManifest(runId, resultsRoot);
  for (const edge of inventory.relationships) {
    if (edge.is_deleted) continue;
    const field = inventory.fields.find(
      (candidate) => candidate.id === edge.field_id,
    );
    const source = inventory.records.find(
      (candidate) => candidate.id === edge.source_record_id,
    );
    if (field && source && !field.is_deleted && !source.is_deleted) {
      assertMutationCanStart(manifest, `unlink:${edge.id}`);
    }
  }
  for (const edge of inventory.relationships) {
    if (edge.is_deleted) continue;
    const field = inventory.fields.find(
      (candidate) => candidate.id === edge.field_id,
    );
    const source = inventory.records.find(
      (candidate) => candidate.id === edge.source_record_id,
    );
    if (!field || !source) {
      throw new Error(
        `Manifest relationship edge dependencies are unavailable: ${edge.id}`,
      );
    }
    // The real unlink route requires a live field and source record. Archived
    // dependencies are deliberately left for the department purge plan.
    if (field.is_deleted || source.is_deleted) continue;
    const parentId = manifestOperationIdForEntity(
      manifest,
      "field",
      edge.field_id,
    );
    await confirmedMutation(
      runId,
      `unlink:${edge.id}`,
      parentId,
      "unlink_relationship_edge",
      "relationship",
      edge.id,
      "DELETE",
      async () => {
        await api.delete(`/relationships/${edge.id}`);
        return { status: 204 };
      },
      resultsRoot,
    );
  }
}

async function assertAbsent(
  api: LiveApiClient,
  path: string,
  label: string,
): Promise<void> {
  try {
    await api.get(path);
  } catch (error) {
    if (error instanceof LiveApiError && error.status === 404) return;
    throw error;
  }
  throw new Error(`Purged ${label} is still present`);
}

async function verifyRootPurged(
  api: LiveApiClient,
  ownership: ManifestRootOwnership,
): Promise<void> {
  await assertAbsent(api, `/departments/${ownership.rootId}`, "department");
  for (const moduleId of sorted(ownership.modules)) {
    await assertAbsent(api, `/modules/${moduleId}`, "module");
  }
  for (const fieldId of sorted(ownership.fields)) {
    await assertAbsent(api, `/fields/${fieldId}`, "field");
  }
  for (const recordId of sorted(ownership.records)) {
    await assertAbsent(api, `/records/${recordId}`, "record");
  }
  for (const relationshipId of sorted(ownership.relationships)) {
    await assertAbsent(api, `/relationships/${relationshipId}`, "relationship");
  }
}

async function currentActor(api: LiveApiClient): Promise<LiveUser> {
  return api.get("/auth/me", undefined, isLiveUser);
}

function hasNamespaceValue(value: unknown, namespace: string): boolean {
  if (typeof value === "string") {
    return (
      value.startsWith(`${namespace} `) || value.startsWith(`${namespace}:`)
    );
  }
  if (Array.isArray(value))
    return value.some((item) => hasNamespaceValue(item, namespace));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) =>
      hasNamespaceValue(item, namespace),
    );
  }
  return false;
}

async function assertNoNamespacedResidue(
  api: LiveApiClient,
  namespace: string,
  runId: string,
  owned: ReturnType<typeof manifestOwnedEntities>,
): Promise<void> {
  const departments = await api.listAll<LiveDepartment>(
    "/departments",
    { search: namespace, deleted: "include", limit: 100 },
    1000,
    isLiveDepartment,
  );
  if (
    departments.some((item) => item.department_name.startsWith(`${namespace} `))
  ) {
    throw new Error("Namespaced departments remain after teardown");
  }
  const modules = await api.listAll<LiveModule>(
    "/modules",
    { search: namespace, deleted: "include", limit: 100 },
    1000,
    isLiveModule,
  );
  if (modules.some((item) => item.module_name.startsWith(`${namespace} `))) {
    throw new Error("Namespaced modules remain after teardown");
  }
  const fields = await api.listAll<LiveField>(
    "/fields",
    { search: namespace, deleted: "include", limit: 100 },
    1000,
    isLiveField,
  );
  if (fields.some((item) => item.name.startsWith(`${namespace} `))) {
    throw new Error("Namespaced fields remain after teardown");
  }
  const records = await api.listAll<LiveRecord>(
    "/records",
    { deleted: "include", limit: 100 },
    1000,
    isLiveRecord,
  );
  if (
    records.some(
      (item) =>
        owned.records.has(item.id) ||
        owned.modules.has(item.module_id) ||
        hasNamespaceValue(item.data, namespace) ||
        hasRunMarkerValue(item.data, runId),
    )
  ) {
    throw new Error("Namespaced records remain after teardown");
  }
  const relationships = await api.listAll<LiveRelationship>(
    "/relationships",
    { availability: "all", deleted: "include", limit: 100 },
    1000,
    isLiveRelationship,
  );
  if (
    relationships.some(
      (item) =>
        owned.relationships.has(item.id) ||
        owned.fields.has(item.field_id) ||
        owned.records.has(item.source_record_id) ||
        owned.records.has(item.target_record_id),
    )
  ) {
    throw new Error("Namespaced relationships remain after teardown");
  }
}

function hasRunMarkerValue(value: unknown, runId: string): boolean {
  if (typeof value === "string") {
    return value.startsWith(`${runId}:`) && value.includes(":record-");
  }
  if (Array.isArray(value))
    return value.some((item) => hasRunMarkerValue(item, runId));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => hasRunMarkerValue(item, runId));
  }
  return false;
}

async function auditLogCount(api: LiveApiClient): Promise<number> {
  const logs = await api.listAll<LiveAuditLog>(
    "/audit-logs",
    { limit: 100 },
    1000,
    isLiveAuditLog,
  );
  return logs.length;
}

function purgeAuditScopeFromInventory(
  inventory: RootInventory,
): PurgeAuditScope {
  return {
    departmentId: inventory.department.id,
    moduleIds: inventory.modules.map((item) => item.id),
    fieldIds: inventory.fields.map((item) => item.id),
    recordIds: inventory.records.map((item) => item.id),
    relationshipIds: inventory.relationships.map((item) => item.id),
  };
}

function purgeAuditScopeFromOwnership(
  ownership: ManifestRootOwnership,
): PurgeAuditScope {
  return {
    departmentId: ownership.rootId,
    moduleIds: sorted(ownership.modules),
    fieldIds: sorted(ownership.fields),
    recordIds: sorted(ownership.records),
    relationshipIds: sorted(ownership.relationships),
  };
}

function purgeRequestIdFromOperation(
  operation: LiveManifest["operations"][number],
): string {
  for (const evidence of operation.evidence) {
    if (
      typeof evidence === "object" &&
      evidence !== null &&
      !Array.isArray(evidence) &&
      "request_id" in evidence &&
      typeof evidence.request_id === "string"
    ) {
      assertCanonicalUuid(evidence.request_id, "Purge audit request ID");
      return evidence.request_id;
    }
  }
  throw new Error(
    `Completed purge journal has no request_id-bound audit evidence: ${operation.id}`,
  );
}

export async function verifyPurgeAudit(
  api: LiveApiClient,
  scope: PurgeAuditScope,
  rootId: string,
  operationId: string,
  actorId: string,
): Promise<LivePurgeAuditEvidence> {
  assertCanonicalUuid(scope.departmentId, "Purge department ID");
  assertCanonicalUuid(rootId, "Purge root ID");
  if (scope.departmentId !== rootId) {
    throw new Error("Purge audit scope does not match its root ID");
  }
  for (const id of [
    ...scope.moduleIds,
    ...scope.fieldIds,
    ...scope.recordIds,
    ...scope.relationshipIds,
  ]) {
    assertCanonicalUuid(id, "Purge audit entity ID");
  }
  assertCanonicalUuid(operationId, "Purge operation ID");
  assertCanonicalUuid(actorId, "Purge actor ID");
  const expected = new Map<string, string>();
  const add = (entityType: string, id: string) => {
    expected.set(`${entityType}:${id}`, id);
  };
  add("departments", scope.departmentId);
  for (const id of scope.moduleIds) add("modules", id);
  for (const id of scope.fieldIds) add("fields", id);
  for (const id of scope.recordIds) add("records", id);
  for (const id of scope.relationshipIds) add("relationship_edges", id);

  const logs = await api.listAll<LiveAuditLog>(
    "/audit-logs",
    { request_id: operationId, limit: 100 },
    1000,
    isLiveAuditLog,
  );
  const seen = new Set<string>();
  for (const log of logs) {
    const entityId = log.entity_id;
    const key = entityId === null ? "" : `${log.entity_type}:${entityId}`;
    if (
      log.request_id !== operationId ||
      log.action !== "delete" ||
      log.performed_by !== actorId ||
      log.request_method !== "POST" ||
      log.request_path !== `/api/departments/${rootId}/purge` ||
      log.before === null ||
      !expected.has(key)
    ) {
      throw new Error(
        "Purge audit log has unexpected actor, path, action, or snapshot",
      );
    }
    if (seen.has(key)) {
      throw new Error(
        `Purge audit log contains duplicate entity evidence: ${key}`,
      );
    }
    seen.add(key);
  }
  const missing = [...expected.keys()].filter((key) => !seen.has(key));
  if (missing.length > 0) {
    throw new Error(
      `Purge audit log is missing entity evidence: ${missing.join(",")}`,
    );
  }
  return {
    rootId,
    requestId: operationId,
    auditLogCount: logs.length,
    entities: {
      departments: 1,
      modules: scope.moduleIds.length,
      fields: scope.fieldIds.length,
      records: scope.recordIds.length,
      relationships: scope.relationshipIds.length,
    },
  };
}

async function teardownRoot(
  api: LiveApiClient,
  environment: LiveTeardownEnvironment,
  rootOperationId: string,
  resultsRoot: string,
): Promise<RootTeardownResult> {
  let manifest = await readManifest(environment.runId, resultsRoot);
  const ownership = manifestRootOwnership(manifest, rootOperationId);
  const purgeOperationId = `purge:${ownership.rootId}`;
  assertMutationCanStart(manifest, `close:${ownership.rootId}`);
  assertMutationCanStart(manifest, purgeOperationId);
  const purgeOperation = manifest.operations.find(
    (operation) => operation.id === purgeOperationId,
  );
  if (purgeOperation?.status === "succeeded") {
    await verifyRootPurged(api, ownership);
    const auditRequestId = purgeRequestIdFromOperation(purgeOperation);
    const auditEvidence = await verifyPurgeAudit(
      api,
      purgeAuditScopeFromOwnership(ownership),
      ownership.rootId,
      auditRequestId,
      (await currentActor(api)).id,
    );
    return {
      domainRowsRemoved:
        ownership.departments.size +
        ownership.modules.size +
        ownership.fields.size +
        ownership.records.size +
        ownership.relationships.size,
      auditEvidence,
    };
  }
  const inventory = await listRootInventory(api, ownership);
  assertNoUnexpectedManifestEdges(inventory.relationships, ownership);
  await unlinkOwnedEdges(api, environment.runId, inventory, resultsRoot);

  manifest = await readManifest(environment.runId, resultsRoot);
  const closeOperationId = `close:${ownership.rootId}`;
  const closeOperation = manifest.operations.find(
    (operation) => operation.id === closeOperationId,
  );
  if (closeOperation?.status === "succeeded") {
    assertRootClosed(inventory);
  } else {
    if (inventory.department.is_deleted) {
      throw new Error(
        "Root department is already closed without a confirmed manifest operation",
      );
    }
    const closePreview = await api.post<LiveLifecyclePreview>(
      `/departments/${ownership.rootId}/close/preview`,
      undefined,
      isLiveLifecyclePreview,
    );
    if (
      closePreview.confirmation_name !== inventory.department.department_name
    ) {
      throw new Error("Close preview confirmation name changed");
    }
    assertExactLifecycleImpact(closePreview.impact, {
      operation: "close",
      targetType: "department",
      targetId: ownership.rootId,
      actorId: (await currentActor(api)).id,
      expectedRows: expectedRows(inventory, "close"),
    });
    const closeResult = await confirmedMutation(
      environment.runId,
      closeOperationId,
      rootOperationId,
      "close_department",
      "department",
      ownership.rootId,
      "POST",
      async () => ({
        status: 200,
        body: await api.post<LiveLifecycleMutation>(
          `/departments/${ownership.rootId}/close`,
          lifecycleConfirmationPayload(closePreview, environment.adminPassword),
          isLiveLifecycleMutation,
        ),
      }),
      resultsRoot,
    );
    if (
      !closeResult ||
      !closeResult.body ||
      !isLiveLifecycleMutation(closeResult.body)
    ) {
      throw new Error("Close mutation did not return a valid lifecycle result");
    }
    assertExactLifecycleImpact(closeResult.body.impact, {
      operation: "close",
      targetType: "department",
      targetId: ownership.rootId,
      actorId: (await currentActor(api)).id,
      expectedRows: expectedRows(inventory, "close"),
    });
  }

  manifest = await readManifest(environment.runId, resultsRoot);
  const purgePreview = await api.post<LiveLifecyclePreview>(
    `/departments/${ownership.rootId}/purge/preview`,
    undefined,
    isLiveLifecyclePreview,
  );
  if (purgePreview.confirmation_name !== inventory.department.department_name) {
    throw new Error("Purge preview confirmation name changed");
  }
  assertExactLifecycleImpact(purgePreview.impact, {
    operation: "purge",
    targetType: "department",
    targetId: ownership.rootId,
    actorId: (await currentActor(api)).id,
    expectedRows: expectedRows(inventory, "purge"),
  });
  const purgeResult = await confirmedMutation(
    environment.runId,
    purgeOperationId,
    rootOperationId,
    "purge_department",
    "department",
    ownership.rootId,
    "POST",
    async () => ({
      status: 200,
      body: await api.post<LiveLifecycleMutation>(
        `/departments/${ownership.rootId}/purge`,
        lifecycleConfirmationPayload(purgePreview, environment.adminPassword),
        isLiveLifecycleMutation,
      ),
    }),
    resultsRoot,
  );
  if (
    !purgeResult ||
    !purgeResult.body ||
    !isLiveLifecycleMutation(purgeResult.body)
  ) {
    throw new Error("Purge mutation did not return a valid lifecycle result");
  }
  assertExactLifecycleImpact(purgeResult.body.impact, {
    operation: "purge",
    targetType: "department",
    targetId: ownership.rootId,
    actorId: (await currentActor(api)).id,
    expectedRows: expectedRows(inventory, "purge"),
  });
  const auditRequestId = purgeResult.body.operation_id;
  if (auditRequestId === null || !isCanonicalUuid(auditRequestId)) {
    throw new Error(
      "Purge response did not return a non-null canonical operation_id",
    );
  }
  const purgeAuditEvidence = await verifyPurgeAudit(
    api,
    purgeAuditScopeFromInventory(inventory),
    ownership.rootId,
    auditRequestId,
    (await currentActor(api)).id,
  );
  await updateOperationStatus(
    environment.runId,
    purgeOperationId,
    "succeeded",
    [
      {
        request_id: auditRequestId,
        audit_log_count: purgeAuditEvidence.auditLogCount,
        audit_entities: purgeAuditEvidence.entities,
      },
    ],
    resultsRoot,
  );
  await verifyRootPurged(api, ownership);
  return {
    domainRowsRemoved:
      ownership.departments.size +
      ownership.modules.size +
      ownership.fields.size +
      ownership.records.size +
      ownership.relationships.size,
    auditEvidence: purgeAuditEvidence,
  };
}

export async function teardownLiveData(
  environment: LiveTeardownEnvironment = getLiveTeardownEnvironment(),
  options: TeardownOptions = {},
): Promise<TeardownResult> {
  if (environment.teardownMode !== LIVE_TEARDOWN_MODE) {
    throw new Error(`LIVE_TEARDOWN must be ${LIVE_TEARDOWN_MODE}`);
  }
  const resultsRoot = options.resultsRoot ?? liveResultsDirectory();
  const lock = await acquireLiveLock(environment.runId, resultsRoot);
  try {
    const initialManifest = await readManifest(environment.runId, resultsRoot);
    assertManifestReadyForTeardown(initialManifest);
    const scale = liveScaleFromEnvironment();
    const maps = await reconstructSeedMaps(environment.runId, resultsRoot);
    const ownership = manifestOwnedEntities(initialManifest);
    const rootOperationIds = maps.runtime.departments.map(
      (department) => `department:${department.key}`,
    );
    if (rootOperationIds.length !== 12 || ownership.departments.size !== 12) {
      throw new Error("Live manifest must contain exactly 12 domain roots");
    }

    return await withLiveAdminToken(environment, async ({ api, user }) => {
      assertActorMatchesManifest(initialManifest, user);
      await validateTeardownCatalog(api, initialManifest, maps, scale);
      const auditLogCountBefore = await auditLogCount(api);
      let domainRowsRemoved = 0;
      const auditEvidence: LivePurgeAuditEvidence[] = [];
      for (const rootOperationId of rootOperationIds) {
        const manifest = await readManifest(environment.runId, resultsRoot);
        assertManifestReadyForTeardown(manifest);
        assertActorMatchesManifest(manifest, await currentActor(api));
        const rootOwnership = manifestRootOwnership(manifest, rootOperationId);
        const rootMaps = await reconstructSeedMaps(
          environment.runId,
          resultsRoot,
        );
        const rootInventory = await listRootInventory(api, rootOwnership);
        validateRootCatalog(rootInventory, rootOwnership, rootMaps, scale);
        const rootResult = await teardownRoot(
          api,
          environment,
          rootOperationId,
          resultsRoot,
        );
        domainRowsRemoved += rootResult.domainRowsRemoved;
        if (rootResult.auditEvidence)
          auditEvidence.push(rootResult.auditEvidence);
        const afterRoot = await readManifest(environment.runId, resultsRoot);
        assertActorMatchesManifest(afterRoot, await currentActor(api));
      }
      const finalManifest = await readManifest(environment.runId, resultsRoot);
      await assertNoNamespacedResidue(
        api,
        finalManifest.namespace,
        finalManifest.run_id,
        ownership,
      );
      const auditLogCountAfter = await auditLogCount(api);
      if (
        auditLogCountAfter < auditLogCountBefore ||
        auditLogCountAfter === 0
      ) {
        throw new Error("Audit logs were not retained as expected residue");
      }
      assertActorMatchesManifest(finalManifest, await currentActor(api));
      await writeLiveReport(
        environment.runId,
        {
          assertions: [
            {
              id: "teardown",
              name: "Manifest-owned domain teardown",
              status: "Pass",
              detail: `Domain rows removed: ${domainRowsRemoved}; each purged department has entity-specific POST purge audit evidence; ${auditLogCountAfter} audit logs retained.`,
            },
          ],
          teardownSummary: {
            domainRowsRemoved,
            auditLogsRetained: true,
            auditLogCount: auditLogCountAfter,
            auditEvidence,
          },
        },
        resultsRoot,
      );
      return {
        runId: environment.runId,
        purgedRoots: rootOperationIds.length,
        domainRowsRemoved,
        auditLogCountBefore,
        auditLogCountAfter,
      };
    });
  } finally {
    await lock.release();
  }
}

export const teardown = teardownLiveData;
