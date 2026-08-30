import {
  assertActorMatchesManifest,
  beginOperation,
  finalizeOperation,
  liveResultsDirectory,
  readManifest,
  type LiveManifest,
} from "./support/manifest";
import {
  createRuntimeCatalog,
  type CatalogModule,
  type RelationshipDefinition,
  type RuntimeCatalog,
} from "./support/catalog";
import {
  isLiveRecord,
  isLiveRelationship,
  isLiveUser,
  type LiveApiClient,
  type LiveRecord,
  type LiveRelationship,
} from "./support/api";
import {
  getLiveSeedEnvironment,
  acquireLiveLock,
  validateRunId,
  type LiveSeedEnvironment,
} from "./support/preflight";
import {
  mapSanityFormValuesToFields,
  recordPayloadFromFormValues,
  relationshipAssignments,
  type SeedFieldDescriptor,
} from "./support/seed-helpers";
import { assertCanonicalUuid } from "./support/manifest";
import { withLiveAdminToken } from "./support/auth";
import { writeLiveReport } from "./support/report";

export type LiveScale = "standard" | "extended";

export const LIVE_SCALE_TARGETS: Readonly<Record<LiveScale, number>> = {
  standard: 20,
  extended: 100,
};

export type ReconstructedSeedMaps = Readonly<{
  manifest: LiveManifest;
  runtime: RuntimeCatalog;
  departmentIds: ReadonlyMap<string, string>;
  moduleIds: ReadonlyMap<string, string>;
  fieldIds: ReadonlyMap<string, string>;
  primitiveFieldIdsByModule: ReadonlyMap<string, ReadonlyMap<string, string>>;
  relationshipFieldIds: ReadonlyMap<string, string>;
  uiRecordIdsByModule: ReadonlyMap<string, readonly string[]>;
  uiRelationshipIds: ReadonlyMap<string, string>;
}>;

export type SeedDataResult = Readonly<{
  runId: string;
  scale: LiveScale;
  targetRecordsPerModule: number;
  createdRecords: number;
  createdRelationships: number;
  maps: ReconstructedSeedMaps;
}>;

export type SeedDataOptions = Readonly<{
  scale?: LiveScale;
  resultsRoot?: string;
}>;

function isLiveScale(value: string | undefined): value is LiveScale {
  return value === "standard" || value === "extended";
}

export function liveScaleFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LiveScale {
  const value = env.LIVE_SCALE ?? "standard";
  if (!isLiveScale(value)) {
    throw new Error("LIVE_SCALE must be standard or extended");
  }
  return value;
}

export function targetRecordCount(scale: LiveScale, moduleOrder = 0): number {
  if (!Number.isInteger(moduleOrder) || moduleOrder < 0) {
    throw new Error("Module order must be a non-negative integer");
  }
  const variation = moduleOrder % 5;
  return scale === "standard"
    ? LIVE_SCALE_TARGETS.standard + variation
    : LIVE_SCALE_TARGETS.extended - 20 + variation * 5;
}

function operationMap(
  manifest: LiveManifest,
): ReadonlyMap<string, LiveManifest["operations"][number]> {
  return new Map(
    manifest.operations.map((operation) => [operation.id, operation]),
  );
}

function confirmedOperation(
  operations: ReadonlyMap<string, LiveManifest["operations"][number]>,
  id: string,
  entityType: string,
  parentId: string | null,
): string {
  const operation = operations.get(id);
  if (!operation || operation.status !== "succeeded") {
    throw new Error(`Live manifest is missing confirmed operation: ${id}`);
  }
  if (
    operation.entity_type !== entityType ||
    operation.parent_id !== parentId
  ) {
    throw new Error(
      `Live manifest operation has unexpected parent or type: ${id}`,
    );
  }
  return operation.entity_id;
}

function reconstructSeedMapsFromManifest(
  manifest: LiveManifest,
): ReconstructedSeedMaps {
  const runtime = createRuntimeCatalog(manifest.namespace);
  const operations = operationMap(manifest);
  const departmentIds = new Map<string, string>();
  const moduleIds = new Map<string, string>();
  const fieldIds = new Map<string, string>();
  const primitiveFieldIdsByModule = new Map<
    string,
    ReadonlyMap<string, string>
  >();
  const relationshipFieldIds = new Map<string, string>();
  const uiRecordIdsByModule = new Map<string, readonly string[]>();
  const uiRelationshipIds = new Map<string, string>();

  for (const department of runtime.departments) {
    departmentIds.set(
      department.key,
      confirmedOperation(
        operations,
        `department:${department.key}`,
        "department",
        null,
      ),
    );
  }
  for (const catalogModule of runtime.modules) {
    const departmentOperationId = `department:${catalogModule.departmentKey}`;
    const moduleId = confirmedOperation(
      operations,
      `module:${catalogModule.key}`,
      "module",
      departmentOperationId,
    );
    moduleIds.set(catalogModule.key, moduleId);

    const primitiveIds = new Map<string, string>();
    for (const field of catalogModule.primitiveFields) {
      const fieldId = confirmedOperation(
        operations,
        `field:${field.key}`,
        "field",
        `module:${catalogModule.key}`,
      );
      primitiveIds.set(field.key, fieldId);
      fieldIds.set(field.key, fieldId);
    }
    primitiveFieldIdsByModule.set(catalogModule.key, primitiveIds);

    const uiRecords = [1, 2].map((recordNumber) =>
      confirmedOperation(
        operations,
        `record:${catalogModule.key}:${recordNumber}`,
        "record",
        `module:${catalogModule.key}`,
      ),
    );
    uiRecordIdsByModule.set(catalogModule.key, uiRecords);
    confirmedOperation(
      operations,
      `schema:${catalogModule.key}:accept`,
      "module",
      `module:${catalogModule.key}`,
    );
  }
  for (const relationship of runtime.relationships) {
    const fieldId = confirmedOperation(
      operations,
      `field:${relationship.key}`,
      "field",
      `module:${relationship.sourceModuleKey}`,
    );
    fieldIds.set(relationship.key, fieldId);
    relationshipFieldIds.set(relationship.key, fieldId);
    uiRelationshipIds.set(
      relationship.key,
      confirmedOperation(
        operations,
        `relationship:${relationship.key}`,
        "relationship",
        `field:${relationship.key}`,
      ),
    );
  }

  return {
    manifest,
    runtime,
    departmentIds,
    moduleIds,
    fieldIds,
    primitiveFieldIdsByModule,
    relationshipFieldIds,
    uiRecordIdsByModule,
    uiRelationshipIds,
  };
}

export async function reconstructSeedMaps(
  runId: string,
  resultsRoot = liveResultsDirectory(),
): Promise<ReconstructedSeedMaps> {
  const manifest = await readManifest(validateRunId(runId), resultsRoot);
  return reconstructSeedMapsFromManifest(manifest);
}

function primitiveDescriptors(
  catalogModule: CatalogModule,
  maps: ReconstructedSeedMaps,
): readonly SeedFieldDescriptor[] {
  const ids = maps.primitiveFieldIdsByModule.get(catalogModule.key);
  if (!ids)
    throw new Error(`Live primitive fields are missing: ${catalogModule.key}`);
  return catalogModule.primitiveFields.map((field) => {
    const id = ids.get(field.key);
    if (!id) throw new Error(`Live field ID is missing: ${field.key}`);
    return { id, name: field.name, type: field.type };
  });
}

async function finishBulkMutation(
  runId: string,
  operationId: string,
  entityId: string,
  resultsRoot: string,
  status: number,
  method: "POST" | "PUT",
): Promise<void> {
  await finalizeOperation(
    runId,
    operationId,
    entityId,
    [{ request: { method, status }, response: { status } }],
    resultsRoot,
  );
}

function exactId(value: string, operation: string): string {
  return assertCanonicalUuid(value, `Live ${operation} response ID`);
}

async function createRecords(
  api: LiveApiClient,
  maps: ReconstructedSeedMaps,
  environment: LiveSeedEnvironment,
  scale: LiveScale,
  resultsRoot: string,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const recordIds = new Map<string, readonly string[]>();
  for (const catalogModule of maps.runtime.modules) {
    const targetCount = targetRecordCount(scale, catalogModule.order);
    const moduleId = maps.moduleIds.get(catalogModule.key);
    if (!moduleId)
      throw new Error(`Live module ID is missing: ${catalogModule.key}`);
    const descriptors = primitiveDescriptors(catalogModule, maps);
    const existing = maps.uiRecordIdsByModule.get(catalogModule.key);
    if (!existing || existing.length !== 2) {
      throw new Error(
        `Live UI sanity records are missing: ${catalogModule.key}`,
      );
    }
    const ids = [...existing];
    for (let recordNumber = 3; recordNumber <= targetCount; recordNumber += 1) {
      const formValues = mapSanityFormValuesToFields(
        catalogModule,
        descriptors,
        recordNumber,
        environment.runId,
      );
      const data = recordPayloadFromFormValues(descriptors, formValues);
      const operationId = `bulk-record:${catalogModule.key}:${recordNumber}`;
      await beginOperation(
        environment.runId,
        {
          id: operationId,
          parent_id: `module:${catalogModule.key}`,
          operation: "create_record",
          entity_type: "record",
          evidence: [],
        },
        resultsRoot,
      );
      const body: LiveRecord = await api.post<LiveRecord>(
        "/records",
        { module_id: moduleId, data },
        isLiveRecord,
      );
      if (body.module_id !== moduleId) {
        throw new Error(
          `Live record was returned under the wrong module: ${catalogModule.key}`,
        );
      }
      const recordId = exactId(body.id, "record creation");
      ids.push(recordId);
      await finishBulkMutation(
        environment.runId,
        operationId,
        recordId,
        resultsRoot,
        201,
        "POST",
      );
    }
    recordIds.set(catalogModule.key, ids);
  }
  return recordIds;
}

async function discoverRelationships(
  api: LiveApiClient,
  fieldId: string,
): Promise<readonly LiveRelationship[]> {
  return api.listAll<LiveRelationship>(
    "/relationships",
    {
      field_id: fieldId,
      limit: 100,
    },
    1000,
    isLiveRelationship,
  );
}

function shouldSkipAssignment(
  relationship: RelationshipDefinition,
  sourceRecordId: string,
  targetRecordId: string,
  existing: readonly LiveRelationship[],
): boolean {
  if (
    existing.some(
      (edge) =>
        edge.source_record_id === sourceRecordId &&
        edge.target_record_id === targetRecordId,
    )
  ) {
    return true;
  }
  if (
    !relationship.multipleTargets &&
    existing.some((edge) => edge.source_record_id === sourceRecordId)
  ) {
    return true;
  }
  return (
    !relationship.multipleSources &&
    existing.some((edge) => edge.target_record_id === targetRecordId)
  );
}

async function createRelationships(
  api: LiveApiClient,
  maps: ReconstructedSeedMaps,
  recordIds: ReadonlyMap<string, readonly string[]>,
  environment: LiveSeedEnvironment,
  resultsRoot: string,
): Promise<number> {
  let created = 0;
  for (const relationship of maps.runtime.relationships) {
    const fieldId = maps.relationshipFieldIds.get(relationship.key);
    const sourceIds = recordIds.get(relationship.sourceModuleKey);
    const targetIds = recordIds.get(relationship.targetModuleKey);
    if (!fieldId || !sourceIds || !targetIds) {
      throw new Error(
        `Live relationship seed prerequisites are missing: ${relationship.key}`,
      );
    }
    const existing = [...(await discoverRelationships(api, fieldId))];
    const sameModule =
      relationship.sourceModuleKey === relationship.targetModuleKey;
    const assignments = relationshipAssignments(
      relationship,
      sourceIds.length,
      targetIds.length,
      sameModule,
    );
    let sequence = 0;
    for (const assignment of assignments) {
      const sourceRecordId = sourceIds[assignment.sourceIndex];
      const targetRecordId = targetIds[assignment.targetIndex];
      if (!sourceRecordId || !targetRecordId) continue;
      if (
        shouldSkipAssignment(
          relationship,
          sourceRecordId,
          targetRecordId,
          existing,
        )
      ) {
        continue;
      }

      const mutationId = `bulk-relationship:${relationship.key}:${sequence}`;
      sequence += 1;
      let edge: LiveRelationship;
      await beginOperation(
        environment.runId,
        {
          id: mutationId,
          parent_id: `field:${relationship.key}`,
          operation: "create_relationship_edge",
          entity_type: "relationship",
          evidence: [],
        },
        resultsRoot,
      );
      if (relationship.multipleTargets === false) {
        edge = await api.put(
          `/relationships/fields/${fieldId}/sources/${sourceRecordId}`,
          { target_record_id: targetRecordId },
          isLiveRelationship,
        );
      } else {
        edge = await api.post(
          "/relationships",
          {
            field_id: fieldId,
            source_record_id: sourceRecordId,
            target_record_id: targetRecordId,
          },
          isLiveRelationship,
        );
      }
      if (
        edge.field_id !== fieldId ||
        edge.source_record_id !== sourceRecordId ||
        edge.target_record_id !== targetRecordId
      ) {
        throw new Error(
          `Live relationship mutation returned the wrong edge: ${relationship.key}`,
        );
      }
      existing.push(edge);
      await finishBulkMutation(
        environment.runId,
        mutationId,
        exactId(edge.id, "relationship creation"),
        resultsRoot,
        relationship.multipleTargets === false ? 200 : 201,
        relationship.multipleTargets === false ? "PUT" : "POST",
      );
      created += 1;
    }
  }
  return created;
}

export async function seedLiveData(
  environment: LiveSeedEnvironment = getLiveSeedEnvironment(),
  options: SeedDataOptions = {},
): Promise<SeedDataResult> {
  const resultsRoot = options.resultsRoot ?? liveResultsDirectory();
  const scale = options.scale ?? liveScaleFromEnvironment();
  const lock = await acquireLiveLock(environment.runId, resultsRoot);
  try {
    const maps = await reconstructSeedMaps(environment.runId, resultsRoot);
    const bulkOperations = maps.manifest.operations.filter(
      (operation) =>
        operation.id.startsWith("bulk-record:") ||
        operation.id.startsWith("bulk-relationship:"),
    );
    if (bulkOperations.length > 0) {
      throw new Error(
        "Live run already contains bulk seed operations; refusing to retry",
      );
    }
    const result = await withLiveAdminToken(environment, async ({ api }) => {
      const currentActor = await api.get("/auth/me", undefined, isLiveUser);
      assertActorMatchesManifest(maps.manifest, currentActor);
      const recordIds = await createRecords(
        api,
        maps,
        environment,
        scale,
        resultsRoot,
      );
      const createdRelationships = await createRelationships(
        api,
        maps,
        recordIds,
        environment,
        resultsRoot,
      );
      const createdRecords = [...recordIds.values()].reduce(
        (total, ids) => total + ids.length - 2,
        0,
      );
      return { createdRecords, createdRelationships };
    });
    await writeLiveReport(
      environment.runId,
      {
        recordTargetIncludesUiSanityRecords: true,
        assertions: [
          {
            id: "bulk-api-seed",
            name: "Bulk API seed",
            status: "Pass",
            detail: `${result.createdRecords} records and ${result.createdRelationships} relationship edges confirmed.`,
          },
        ],
      },
      resultsRoot,
    );
    return {
      runId: environment.runId,
      scale,
      targetRecordsPerModule: targetRecordCount(scale),
      ...result,
      maps,
    };
  } finally {
    await lock.release();
  }
}

export const seedData = seedLiveData;
