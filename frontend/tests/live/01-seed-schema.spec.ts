import { expect, test } from "@playwright/test";

import { isLiveUser, type LiveFieldType } from "./support/api";
import {
  LIVE_CATALOG,
  createRuntimeCatalog,
  validateCatalog,
  type CatalogModule,
  type RuntimeCatalog,
} from "./support/catalog";
import {
  appendOperation,
  assertActorMatchesManifest,
  assertManifestIsFresh,
  actorBaselineFromUser,
  beginOperation,
  createManifest,
  createActorOperation,
  finalizeOperation,
  liveResultsDirectory,
  readManifest,
} from "./support/manifest";
import {
  assertLiveAdminRoleFromBff,
  assertLiveSession,
  getLiveActorFromBff,
  liveCredentialsFromEnvironment,
  signInLiveAdmin,
  signOutLiveAdmin,
  withLiveAdminToken,
} from "./support/auth";
import {
  acquireLiveLock,
  getLiveSeedEnvironment,
  hasLiveSeedEnvironment,
} from "./support/preflight";
import {
  exactEntityId,
  LiveSeedPage,
  assertExactUiPath,
  type LiveMutation,
} from "./support/seed-ui";
import {
  liveScaleFromEnvironment,
  seedRecordsForDepartment,
  seedRelationshipsForDepartment,
  type DepartmentSeedContext,
} from "./seed-data";
import { writeLiveReport } from "./support/report";

const LIVE_RESULTS_ROOT = liveResultsDirectory();

type CreatedField = Readonly<{
  id: string;
  module_id: string;
  name: string;
  type: LiveFieldType;
  required: boolean;
  config: Record<string, unknown>;
  relationship_target_module_id: string | null;
  relationship_multiple_targets: boolean | null;
  relationship_multiple_sources: boolean | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLiveFieldType(value: unknown): value is LiveFieldType {
  return (
    typeof value === "string" &&
    [
      "text",
      "number",
      "decimal",
      "int",
      "boolean",
      "date",
      "datetime",
      "select",
      "relationship",
    ].includes(value)
  );
}

function nullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new Error("Live field response contained an invalid nullable string");
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  throw new Error("Live field response contained an invalid nullable boolean");
}

function createdField(
  body: unknown,
  expectedModuleId: string,
  operation: string,
): CreatedField {
  if (
    !isRecord(body) ||
    typeof body.id !== "string" ||
    body.id.length === 0 ||
    typeof body.module_id !== "string" ||
    body.module_id !== expectedModuleId ||
    typeof body.name !== "string" ||
    !isLiveFieldType(body.type) ||
    typeof body.required !== "boolean" ||
    !isRecord(body.config)
  ) {
    throw new Error(`Live ${operation} response did not contain a valid field`);
  }
  return {
    id: body.id,
    module_id: body.module_id,
    name: body.name,
    type: body.type,
    required: body.required,
    config: body.config,
    relationship_target_module_id: nullableString(
      body.relationship_target_module_id,
    ),
    relationship_multiple_targets: nullableBoolean(
      body.relationship_multiple_targets,
    ),
    relationship_multiple_sources: nullableBoolean(
      body.relationship_multiple_sources,
    ),
  };
}

function moduleFor(runtime: RuntimeCatalog, key: string): CatalogModule {
  const catalogModule = runtime.modules.find((item) => item.key === key);
  if (!catalogModule) throw new Error(`Live catalog module is missing: ${key}`);
  return catalogModule;
}

function departmentIdFor(
  departmentIds: ReadonlyMap<string, string>,
  catalogModule: CatalogModule,
): string {
  const departmentId = departmentIds.get(catalogModule.departmentKey);
  if (!departmentId) {
    throw new Error(
      `Live department ID is missing: ${catalogModule.departmentKey}`,
    );
  }
  return departmentId;
}

async function journalMutation(
  runId: string,
  operationId: string,
  entityId: string,
  mutation: LiveMutation,
): Promise<void> {
  await finalizeOperation(
    runId,
    operationId,
    entityId,
    [
      {
        response: {
          status: mutation.response.status(),
        },
      },
    ],
    LIVE_RESULTS_ROOT,
  );
}

async function journalUiMutation(
  runId: string,
  operationId: string,
  parentId: string | null,
  operation: string,
  entityType: string,
  mutate: () => Promise<LiveMutation>,
  knownEntityId?: string,
): Promise<LiveMutation> {
  await beginOperation(
    runId,
    {
      id: operationId,
      parent_id: parentId,
      operation,
      entity_type: entityType,
      ...(knownEntityId === undefined ? {} : { entity_id: knownEntityId }),
      evidence: [],
    },
    LIVE_RESULTS_ROOT,
  );
  const mutation = await mutate();
  const entityId = exactEntityId(mutation.body, `${operation} response`);
  await journalMutation(runId, operationId, entityId, mutation);
  return mutation;
}

function departmentOperationId(key: string): string {
  return `department:${key}`;
}

function moduleOperationId(key: string): string {
  return `module:${key}`;
}

function fieldOperationId(key: string): string {
  return `field:${key}`;
}

test.describe("live department-first catalog seed", () => {
  test("creates the complete catalog with deterministic records and relationships", async ({
    page,
  }) => {
    test.skip(
      !hasLiveSeedEnvironment(),
      "Live seed requires explicit loopback API, Supabase, credential, and run-ID environment variables",
    );
    const environment = getLiveSeedEnvironment();
    const scale = liveScaleFromEnvironment();
    validateCatalog(LIVE_CATALOG);
    const runtime = createRuntimeCatalog(environment.namespace);
    const lock = await acquireLiveLock(environment.runId, LIVE_RESULTS_ROOT);
    let browserSignedIn = false;

    try {
      await assertManifestIsFresh(environment.runId, LIVE_RESULTS_ROOT);

      await createManifest(
        environment.runId,
        runtime.namespace,
        LIVE_RESULTS_ROOT,
      );

      await signInLiveAdmin(
        page,
        liveCredentialsFromEnvironment(environment),
        environment.uiOrigin,
      );
      browserSignedIn = true;
      const actor = await getLiveActorFromBff(page);
      await assertLiveAdminRoleFromBff(page, actor.role_id);
      await appendOperation(
        environment.runId,
        createActorOperation(actorBaselineFromUser(actor)),
        LIVE_RESULTS_ROOT,
      );
      await assertLiveSession(page);
      await page.goto("/departments");
      assertExactUiPath(page, "/departments", environment.uiOrigin);
      await expect(
        page.getByRole("heading", { name: "Departments", exact: true }),
      ).toBeVisible();
      const ui = new LiveSeedPage(page, environment.uiOrigin);
      const departmentIds = new Map<string, string>();
      const moduleIds = new Map<string, string>();

      const fieldsByModule = new Map<string, CreatedField[]>();
      const fieldsByCatalogKey = new Map<string, CreatedField>();
      const primitiveFieldIdsByModule = new Map<
        string,
        ReadonlyMap<string, string>
      >();
      const relationshipFieldIds = new Map<string, string>();
      const uiRecordIdsByModule = new Map<string, readonly string[]>();
      const firstRelationship = runtime.relationships[0];

      const result = await withLiveAdminToken(environment, async ({ api }) => {
        const manifest = await readManifest(
          environment.runId,
          LIVE_RESULTS_ROOT,
        );
        const currentActor = await api.get("/auth/me", undefined, isLiveUser);
        assertActorMatchesManifest(manifest, currentActor);
        const context: DepartmentSeedContext = {
          api,
          runId: environment.runId,
          resultsRoot: LIVE_RESULTS_ROOT,
          moduleIds,
          primitiveFieldIdsByModule,
          relationshipFieldIds,
          uiRecordIdsByModule,
          relationships: runtime.relationships,
        };
        let createdRecords = 0;
        let createdRelationships = 0;

        for (const department of runtime.departments) {
          const departmentMutation = await journalUiMutation(
            environment.runId,
            departmentOperationId(department.key),
            null,
            "create_department",
            "department",
            () => ui.createDepartment(department.name),
          );
          const departmentId = exactEntityId(
            departmentMutation.body,
            "department creation",
          );
          expect(
            isRecord(departmentMutation.body) &&
              departmentMutation.body.department_name,
          ).toBe(department.name);
          departmentIds.set(department.key, departmentId);

          await ui.openDepartment(departmentId, department.name);
          for (const catalogModule of department.modules) {
            const moduleMutation = await journalUiMutation(
              environment.runId,
              moduleOperationId(catalogModule.key),
              departmentOperationId(department.key),
              "create_module",
              "module",
              () => ui.createModule(departmentId, catalogModule.name),
            );
            const moduleId = exactEntityId(
              moduleMutation.body,
              "module creation",
            );
            expect(
              isRecord(moduleMutation.body) && moduleMutation.body.module_name,
            ).toBe(catalogModule.name);
            moduleIds.set(catalogModule.key, moduleId);
          }

          const departmentRelationships = runtime.relationships.filter(
            (relationship) =>
              department.moduleKeys.includes(relationship.sourceModuleKey) &&
              department.moduleKeys.includes(relationship.targetModuleKey),
          );
          for (const catalogModule of department.modules) {
            const moduleId = moduleIds.get(catalogModule.key);
            if (!moduleId)
              throw new Error(
                `Live module ID is missing: ${catalogModule.key}`,
              );
            const departmentIdForModule = departmentIdFor(
              departmentIds,
              catalogModule,
            );
            await ui.openSchema(departmentIdForModule, moduleId);
            const primitiveFieldIds = new Map<string, string>();
            for (const field of catalogModule.primitiveFields) {
              const mutation = await journalUiMutation(
                environment.runId,
                fieldOperationId(field.key),
                moduleOperationId(catalogModule.key),
                "create_field",
                "field",
                () =>
                  ui.addField({
                    name: field.name,
                    type: field.type,
                    required: field.required,
                    options: field.config.options,
                  }),
              );
              const created = createdField(
                mutation.body,
                moduleId,
                `primitive field ${field.key}`,
              );
              expect(created.name).toBe(field.name);
              expect(created.type).toBe(field.type);
              expect(created.required).toBe(field.required);
              if (field.type === "select") {
                expect(created.config.options).toEqual(field.config.options);
              }
              primitiveFieldIds.set(field.key, created.id);
              const currentFields = fieldsByModule.get(catalogModule.key) ?? [];
              fieldsByModule.set(catalogModule.key, [
                ...currentFields,
                created,
              ]);
              fieldsByCatalogKey.set(field.key, created);
            }
            primitiveFieldIdsByModule.set(catalogModule.key, primitiveFieldIds);
          }

          for (const relationship of departmentRelationships) {
            const sourceModule = moduleFor(
              runtime,
              relationship.sourceModuleKey,
            );
            const targetModule = moduleFor(
              runtime,
              relationship.targetModuleKey,
            );
            const sourceModuleId = moduleIds.get(sourceModule.key);
            const sourceDepartmentId = departmentIdFor(
              departmentIds,
              sourceModule,
            );
            const targetModuleId = moduleIds.get(targetModule.key);
            if (!sourceModuleId) {
              throw new Error(
                `Live source module ID is missing: ${sourceModule.key}`,
              );
            }
            if (!targetModuleId) {
              throw new Error(
                `Live target module ID is missing: ${targetModule.key}`,
              );
            }
            await ui.openSchema(sourceDepartmentId, sourceModuleId);
            const forbiddenTarget = runtime.modules.find(
              (catalogModule) =>
                catalogModule.departmentKey !== sourceModule.departmentKey,
            );
            const mutation = await journalUiMutation(
              environment.runId,
              fieldOperationId(relationship.key),
              moduleOperationId(sourceModule.key),
              "create_relationship_field",
              "field",
              () =>
                ui.addField({
                  name: relationship.name,
                  type: "relationship",
                  targetModuleId,
                  multipleTargets: relationship.multipleTargets,
                  multipleSources: relationship.multipleSources,
                  forbiddenTargetModuleName:
                    relationship.key === firstRelationship.key
                      ? forbiddenTarget?.name
                      : undefined,
                }),
            );
            const created = createdField(
              mutation.body,
              sourceModuleId,
              `relationship field ${relationship.key}`,
            );
            expect(created.name).toBe(relationship.name);
            expect(created.type).toBe("relationship");
            expect(created.required).toBe(false);
            expect(created.relationship_target_module_id).toBe(targetModuleId);
            expect(created.relationship_multiple_targets).toBe(
              relationship.multipleTargets,
            );
            expect(created.relationship_multiple_sources).toBe(
              relationship.multipleSources,
            );
            relationshipFieldIds.set(relationship.key, created.id);
            const currentFields = fieldsByModule.get(sourceModule.key) ?? [];
            fieldsByModule.set(sourceModule.key, [...currentFields, created]);
            fieldsByCatalogKey.set(relationship.key, created);
          }

          for (const catalogModule of department.modules) {
            const moduleId = moduleIds.get(catalogModule.key);
            if (!moduleId)
              throw new Error(
                `Live module ID is missing: ${catalogModule.key}`,
              );
            const fields = fieldsByModule.get(catalogModule.key) ?? [];
            expect(
              fields.filter((field) => field.type !== "relationship"),
            ).toHaveLength(6);
            expect(
              fields.filter((field) => field.type === "relationship"),
            ).toHaveLength(
              departmentRelationships.filter(
                (relationship) =>
                  relationship.sourceModuleKey === catalogModule.key,
              ).length,
            );
            const departmentIdForModule = departmentIdFor(
              departmentIds,
              catalogModule,
            );
            await ui.openSchema(departmentIdForModule, moduleId);
            const mutation = await journalUiMutation(
              environment.runId,
              `schema:${catalogModule.key}:accept`,
              moduleOperationId(catalogModule.key),
              "accept_schema",
              "module",
              () => ui.acceptSchema(moduleId),
              moduleId,
            );
            expect(exactEntityId(mutation.body, "schema acceptance")).toBe(
              moduleId,
            );
          }

          const departmentRecordIds = new Map<string, readonly string[]>();
          for (const catalogModule of department.modules) {
            const moduleId = moduleIds.get(catalogModule.key);
            if (!moduleId)
              throw new Error(
                `Live module ID is missing: ${catalogModule.key}`,
              );
            const departmentIdForModule = departmentIdFor(
              departmentIds,
              catalogModule,
            );
            const fields = fieldsByModule.get(catalogModule.key) ?? [];
            const recordIds: string[] = [];
            for (const recordNumber of [1, 2]) {
              const mutation = await journalUiMutation(
                environment.runId,
                `record:${catalogModule.key}:${recordNumber}`,
                moduleOperationId(catalogModule.key),
                "create_record",
                "record",
                () =>
                  ui.createRecord(
                    departmentIdForModule,
                    moduleId,
                    catalogModule,
                    fields,
                    recordNumber,
                    environment.runId,
                  ),
              );
              const recordId = exactEntityId(mutation.body, "record creation");
              recordIds.push(recordId);
            }
            uiRecordIdsByModule.set(catalogModule.key, recordIds);
            departmentRecordIds.set(catalogModule.key, recordIds);
          }

          const seededRecordIds = await seedRecordsForDepartment(
            department,
            context,
            scale,
          );
          for (const [moduleKey, ids] of seededRecordIds) {
            departmentRecordIds.set(moduleKey, ids);
            createdRecords += ids.length - 2;
          }

          if (departmentRelationships.length > 0) {
            for (const relationship of departmentRelationships) {
              const sourceModule = moduleFor(
                runtime,
                relationship.sourceModuleKey,
              );
              const targetModule = moduleFor(
                runtime,
                relationship.targetModuleKey,
              );
              const sourceModuleId = moduleIds.get(sourceModule.key);
              const sourceDepartmentId = departmentIdFor(
                departmentIds,
                sourceModule,
              );
              const sourceRecords = departmentRecordIds.get(sourceModule.key);
              const targetRecords = departmentRecordIds.get(targetModule.key);
              const field = fieldsByCatalogKey.get(relationship.key);
              if (
                !sourceModuleId ||
                !sourceRecords ||
                !targetRecords ||
                sourceRecords.length < 2 ||
                targetRecords.length < 2 ||
                !field
              ) {
                throw new Error(
                  `Live relationship seed prerequisites are missing: ${relationship.key}`,
                );
              }
              const sourceRecordId = sourceRecords[0];
              const targetRecordId =
                sourceModule.key === targetModule.key
                  ? targetRecords[1]
                  : targetRecords[0];
              await ui.openRecordEdit(
                sourceDepartmentId,
                sourceModuleId,
                sourceRecordId,
              );
              await journalUiMutation(
                environment.runId,
                `relationship:${relationship.key}`,
                fieldOperationId(relationship.key),
                "create_relationship_edge",
                "relationship",
                () =>
                  ui.addRelationship(
                    relationship,
                    field,
                    sourceRecordId,
                    targetRecordId,
                  ),
              );
            }
            createdRelationships += await seedRelationshipsForDepartment(
              department,
              departmentRecordIds,
              context,
            );
          }
        }

        expect(fieldsByCatalogKey.size).toBe(342 + 13);
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
        LIVE_RESULTS_ROOT,
      );
    } finally {
      if (browserSignedIn) {
        await signOutLiveAdmin(page, environment.uiOrigin).catch(
          () => undefined,
        );
      }
      await lock.release();
    }
  });
});
