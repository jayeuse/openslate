import {
  expect,
  test,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";

import {
  isLiveAuditLog,
  isLiveDepartment,
  isLiveField,
  isLiveModule,
  isLiveRecord,
  isLiveRelationship,
  LiveApiError,
  type LiveApiClient,
  type LiveAuditLog,
  type LiveDepartment,
  type LiveField,
  type LiveModule,
  type LiveRecord,
  type LiveRelationship,
} from "./support/api";
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
  auditRelationshipCardinality,
  assertStateUnchanged,
  createIntegrityAssertion,
  selectSafeTargetRecord,
  type CardinalitySummary,
} from "./support/integrity";
import {
  assertActorMatchesManifest,
  beginOperation,
  finalizeOperation,
  liveResultsDirectory,
  readManifest,
  type LiveAssertionResult,
} from "./support/manifest";
import {
  getLiveSeedEnvironment,
  hasLiveSeedEnvironment,
  acquireLiveLock,
  type LiveSeedEnvironment,
} from "./support/preflight";
import { type LiveIntegritySummary, writeLiveReport } from "./support/report";
import { sanitizeEvidence } from "./support/sanitize";
import {
  liveScaleFromEnvironment,
  reconstructSeedMaps,
  targetRecordCount,
  type ReconstructedSeedMaps,
} from "./seed-data";
import {
  createRuntimeCatalog,
  type CatalogModule,
  type RelationshipDefinition,
  type RuntimeCatalog,
} from "./support/catalog";
import {
  assertExactUiPath,
  LiveSeedPage,
  type LiveMutation,
} from "./support/seed-ui";

const LIVE_RESULTS_ROOT = liveResultsDirectory();

type CatalogSnapshot = Readonly<{
  departments: readonly LiveDepartment[];
  modules: readonly LiveModule[];
  fieldsByModule: ReadonlyMap<string, readonly LiveField[]>;
  recordsByModule: ReadonlyMap<string, readonly LiveRecord[]>;
}>;

type NegativeEvidence = Readonly<{
  check: string;
  status: number;
  path: string;
}>;

type CheckDefinition = Readonly<{
  id: string;
  name: string;
  run: () => Promise<string>;
}>;

const CHECKS = [
  ["catalog-footprint", "Exact catalog footprint"],
  ["ui-smoke", "Namespaced UI smoke and validation"],
  ["cardinality", "Relationship cardinality audit"],
  ["invalid-links", "Invalid and cross-department relationship rejection"],
  ["single-target-replacement", "Single-target atomic replacement"],
  ["multi-target-add", "Multi-target add and duplicate rejection"],
  ["archive-cardinality", "Archived target visibility and cardinality"],
  ["incoming-outgoing-links", "Incoming read-only and outgoing unlink"],
  ["audit-evidence", "Audit UI and API evidence"],
] as const;

function routeFor(departmentId: string, moduleId: string, suffix = ""): string {
  return `/departments/${departmentId}/modules/${moduleId}${suffix}`;
}

function compactRecordId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-8)}`;
}

function moduleFor(runtime: RuntimeCatalog, key: string): CatalogModule {
  const catalogModule = runtime.modules.find((item) => item.key === key);
  if (!catalogModule) throw new Error(`Runtime module is missing: ${key}`);
  return catalogModule;
}

function relationshipFor(
  runtime: RuntimeCatalog,
  key: string,
): RelationshipDefinition {
  const relationship = runtime.relationships.find((item) => item.key === key);
  if (!relationship) throw new Error(`Runtime relationship is missing: ${key}`);
  return relationship;
}

function departmentIdFor(
  maps: ReconstructedSeedMaps,
  catalogModule: CatalogModule,
): string {
  const departmentId = maps.departmentIds.get(catalogModule.departmentKey);
  if (!departmentId) {
    throw new Error(
      `Runtime department ID is missing: ${catalogModule.departmentKey}`,
    );
  }
  return departmentId;
}

function fieldFor(
  snapshot: CatalogSnapshot,
  catalogModule: CatalogModule,
  key: string,
): LiveField {
  const field = snapshot.fieldsByModule
    .get(catalogModule.key)
    ?.find((item) => item.id === key || item.name === key);
  if (!field)
    throw new Error(`Live field is missing: ${catalogModule.key}/${key}`);
  return field;
}

function relationshipFieldFor(
  snapshot: CatalogSnapshot,
  maps: ReconstructedSeedMaps,
  relationship: RelationshipDefinition,
): LiveField {
  const id = maps.relationshipFieldIds.get(relationship.key);
  if (!id)
    throw new Error(`Relationship field ID is missing: ${relationship.key}`);
  return fieldFor(
    snapshot,
    moduleFor(maps.runtime, relationship.sourceModuleKey),
    id,
  );
}

async function readCatalog(
  api: LiveApiClient,
  maps: ReconstructedSeedMaps,
  scale: ReturnType<typeof liveScaleFromEnvironment>,
): Promise<CatalogSnapshot> {
  const departments = await api.listAll<LiveDepartment>(
    "/departments",
    { search: maps.runtime.namespace, deleted: "include", limit: 100 },
    1000,
    isLiveDepartment,
  );
  const modules = await api.listAll<LiveModule>(
    "/modules",
    { search: maps.runtime.namespace, deleted: "include", limit: 100 },
    1000,
    isLiveModule,
  );
  expect(departments).toHaveLength(12);
  expect(modules).toHaveLength(57);
  expect(new Set(departments.map((item) => item.id)).size).toBe(12);
  expect(new Set(modules.map((item) => item.id)).size).toBe(57);

  for (const department of maps.runtime.departments) {
    const departmentId = maps.departmentIds.get(department.key);
    if (!departmentId)
      throw new Error(`Department map is missing: ${department.key}`);
    expect(
      departments.find((item) => item.id === departmentId)?.department_name,
    ).toBe(department.name);
  }

  const fieldsByModule = new Map<string, readonly LiveField[]>();
  const recordsByModule = new Map<string, readonly LiveRecord[]>();
  let acceptedSchemas = 0;
  let primitiveFields = 0;
  let relationshipFields = 0;
  const relationshipFieldIds = new Set(maps.relationshipFieldIds.values());

  for (const catalogModule of maps.runtime.modules) {
    const moduleId = maps.moduleIds.get(catalogModule.key);
    if (!moduleId)
      throw new Error(`Module map is missing: ${catalogModule.key}`);
    const currentModule = modules.find((item) => item.id === moduleId);
    expect(currentModule).toBeDefined();
    expect(currentModule?.module_name).toBe(catalogModule.name);
    expect(currentModule?.department_id).toBe(
      maps.departmentIds.get(catalogModule.departmentKey),
    );
    expect(currentModule?.is_schema_accepted).toBe(true);
    if (currentModule?.is_schema_accepted) acceptedSchemas += 1;

    const fields = await api.listAll<LiveField>(
      "/fields",
      {
        module_id: moduleId,
        deleted: "include",
        limit: 100,
        sort_by: "position",
        sort_order: "asc",
      },
      1000,
      isLiveField,
    );
    const records = await api.listAll<LiveRecord>(
      "/records",
      {
        module_id: moduleId,
        deleted: "include",
        limit: 100,
        sort_by: "created_at",
        sort_order: "desc",
      },
      1000,
      isLiveRecord,
    );
    const expectedRelationshipFields = maps.runtime.relationships.filter(
      (item) => item.sourceModuleKey === catalogModule.key,
    );
    const expectedPrimitiveIds = [
      ...(maps.primitiveFieldIdsByModule.get(catalogModule.key)?.values() ??
        []),
    ];
    const expectedRelationshipIds = expectedRelationshipFields.map((item) => {
      const fieldId = maps.relationshipFieldIds.get(item.key);
      if (!fieldId)
        throw new Error(`Relationship field map is missing: ${item.key}`);
      return fieldId;
    });
    const actualPrimitiveFields = fields.filter(
      (item) => item.type !== "relationship",
    );
    const actualRelationshipFields = fields.filter(
      (item) => item.type === "relationship",
    );
    expect(actualPrimitiveFields.map((item) => item.id).sort()).toEqual(
      expectedPrimitiveIds.sort(),
    );
    expect(actualRelationshipFields.map((item) => item.id).sort()).toEqual(
      expectedRelationshipIds.sort(),
    );
    expect(actualPrimitiveFields).toHaveLength(6);
    expect(actualRelationshipFields).toHaveLength(
      expectedRelationshipFields.length,
    );
    expect(records).toHaveLength(targetRecordCount(scale, catalogModule.order));
    primitiveFields += actualPrimitiveFields.length;
    relationshipFields += actualRelationshipFields.length;
    fieldsByModule.set(catalogModule.key, fields);
    recordsByModule.set(catalogModule.key, records);

    for (const primitive of catalogModule.primitiveFields) {
      const id = maps.primitiveFieldIdsByModule
        .get(catalogModule.key)
        ?.get(primitive.key);
      const actual = id ? fields.find((item) => item.id === id) : undefined;
      expect(actual).toMatchObject({
        name: primitive.name,
        type: primitive.type,
        required: primitive.required,
      });
      if (primitive.type === "select")
        expect(actual?.config.options).toEqual(primitive.config.options);
    }
    for (const definition of expectedRelationshipFields) {
      const id = maps.relationshipFieldIds.get(definition.key);
      const actual = id ? fields.find((item) => item.id === id) : undefined;
      expect(actual).toMatchObject({
        name: definition.name,
        type: "relationship",
        required: false,
        relationship_target_module_id: maps.moduleIds.get(
          definition.targetModuleKey,
        ),
        relationship_multiple_targets: definition.multipleTargets,
        relationship_multiple_sources: definition.multipleSources,
      });
    }
    for (const relationshipField of actualRelationshipFields) {
      expect(relationshipFieldIds.has(relationshipField.id)).toBe(true);
      for (const record of records) {
        expect(
          Object.prototype.hasOwnProperty.call(
            record.data,
            relationshipField.id,
          ),
        ).toBe(false);
      }
    }
    const visibleRecordIds = new Set(
      records.slice(0, 100).map((record) => record.id),
    );
    for (const uiRecordId of maps.uiRecordIdsByModule.get(catalogModule.key) ??
      []) {
      expect(
        records.find((record) => record.id === uiRecordId)?.is_deleted,
      ).toBe(false);
      expect(visibleRecordIds.has(uiRecordId)).toBe(true);
    }
  }
  expect(primitiveFields).toBe(342);
  expect(relationshipFields).toBe(13);
  expect(acceptedSchemas).toBe(57);
  return { departments, modules, fieldsByModule, recordsByModule };
}

async function currentEdges(
  api: LiveApiClient,
  fieldId: string,
  sourceRecordId?: string,
): Promise<readonly LiveRelationship[]> {
  return api.listAll<LiveRelationship>(
    "/relationships",
    {
      field_id: fieldId,
      source_record_id: sourceRecordId,
      availability: "all",
      deleted: "include",
      limit: 100,
    },
    1000,
    isLiveRelationship,
  );
}

async function expectRejected(
  action: () => Promise<unknown>,
  check: string,
  negativeEvidence: NegativeEvidence[],
  expectedStatuses: readonly number[] = [409, 422],
): Promise<void> {
  try {
    await action();
  } catch (reason) {
    if (!(reason instanceof LiveApiError)) throw reason;
    expect(expectedStatuses).toContain(reason.status);
    negativeEvidence.push({ check, status: reason.status, path: reason.path });
    return;
  }
  throw new Error(`${check} unexpectedly succeeded`);
}

function safeFailureDetail(check: string, reason: unknown): string {
  if (reason instanceof LiveApiError) {
    return `${check} failed with HTTP ${reason.status} at ${reason.path}; response details are omitted from the report.`;
  }
  return `${check} failed; diagnostic details remain in Playwright output and are omitted from the report.`;
}

async function journalIntegrityOperation(
  environment: LiveSeedEnvironment,
  operationId: string,
  parentId: string,
  operation: string,
  entityType: string,
  entityId: string,
  evidence: readonly unknown[] = [],
): Promise<void> {
  await finalizeOperation(
    environment.runId,
    operationId,
    entityId,
    evidence.map(sanitizeEvidence),
    LIVE_RESULTS_ROOT,
  );
}

async function beginIntegrityOperation(
  environment: LiveSeedEnvironment,
  operationId: string,
  parentId: string,
  operation: string,
  entityType: string,
  entityId?: string,
): Promise<void> {
  await beginOperation(
    environment.runId,
    {
      id: operationId,
      parent_id: parentId,
      operation,
      entity_type: entityType,
      ...(entityId === undefined ? {} : { entity_id: entityId }),
      evidence: [],
    },
    LIVE_RESULTS_ROOT,
  );
}

function reportCardinality(
  summary: CardinalitySummary,
): LiveIntegritySummary["cardinality"] {
  return ["one-to-one", "many-to-one", "one-to-many", "many-to-many"].map(
    (cardinality) => ({
      cardinality,
      ...summary.byCardinality[
        cardinality as keyof typeof summary.byCardinality
      ],
    }),
  );
}

function rowForRecord(page: Page, recordId: string) {
  return page.getByRole("row").filter({
    has: page.locator(`a[href$="/records/${recordId}/edit"]`),
  });
}

async function archiveRecordThroughUi(
  page: Page,
  departmentId: string,
  moduleId: string,
  recordId: string,
  uiOrigin: string,
): Promise<Response> {
  const path = routeFor(departmentId, moduleId, "/records");
  await page.goto(path);
  assertExactUiPath(page, path, uiOrigin);
  const row = rowForRecord(page, recordId);
  await expect(row).toBeVisible();
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "DELETE" &&
      url.origin === uiOrigin &&
      url.pathname === `/bff/records/${recordId}` &&
      url.search === "" &&
      url.hash === ""
    );
  });
  const dialogPromise = page
    .waitForEvent("dialog")
    .then((dialog) => dialog.accept());
  await Promise.all([
    row.getByRole("button", { name: "Archive", exact: true }).click(),
    dialogPromise,
  ]);
  const response = await responsePromise;
  await expect(row.getByText("Archived", { exact: true })).toBeVisible();
  return response;
}

async function restoreRecordThroughUi(
  page: Page,
  departmentId: string,
  moduleId: string,
  recordId: string,
  uiOrigin: string,
): Promise<Response> {
  const path = routeFor(departmentId, moduleId, "/records");
  await page.goto(path);
  assertExactUiPath(page, path, uiOrigin);
  const row = rowForRecord(page, recordId);
  await expect(row).toBeVisible();
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.origin === uiOrigin &&
      url.pathname === `/bff/records/${recordId}/restore` &&
      url.search === "" &&
      url.hash === ""
    );
  });
  await row.getByRole("button", { name: "Restore", exact: true }).click();
  const response = await responsePromise;
  await expect(row.getByText("Active", { exact: true })).toBeVisible();
  return response;
}

function assertionPlaceholders(): readonly LiveAssertionResult[] {
  return [
    createIntegrityAssertion(
      "integrity-suite",
      "Integrity suite",
      "Not Testable",
      "Integrity checks have not run; no result is inferred.",
    ),
    ...CHECKS.map(([id, name]) =>
      createIntegrityAssertion(
        id,
        name,
        "Not Testable",
        "Check has not run; no result is inferred.",
      ),
    ),
    createIntegrityAssertion(
      "unique-record-values",
      "Unique record values",
      "Not Supported",
      "The live schema and API do not expose unique-record-value enforcement; no uniqueness claim is made.",
    ),
  ];
}

test.describe("live relationship integrity audit", () => {
  test("audits the seeded catalog through UI and canonical direct API reads", async ({
    page,
  }) => {
    test.skip(
      !hasLiveSeedEnvironment(),
      "Live integrity requires explicit loopback API, Supabase, administrator credentials, and an existing run-ID seed manifest",
    );
    const environment = getLiveSeedEnvironment();
    const scale = liveScaleFromEnvironment();
    const runtime = createRuntimeCatalog(environment.namespace);
    const maps = await reconstructSeedMaps(
      environment.runId,
      LIVE_RESULTS_ROOT,
    );
    const lock = await acquireLiveLock(environment.runId, LIVE_RESULTS_ROOT);
    let browserSignedIn = false;
    const negativeEvidence: NegativeEvidence[] = [];
    let reportSummary: LiveIntegritySummary = {
      scale,
      catalog: {
        departments: 12,
        modules: 57,
        primitiveFields: 342,
        relationshipFields: 13,
        acceptedSchemas: 0,
        expectedRecords: runtime.modules.reduce(
          (total, catalogModule) =>
            total + targetRecordCount(scale, catalogModule.order),
          0,
        ),
        observedRecords: 0,
      },
      cardinality: [],
      apiNegatives: negativeEvidence,
      audit: { uiRows: 0, filteredLogs: 0, detailLogs: 0 },
    };
    let snapshot: CatalogSnapshot | null = null;
    let cardinalitySummary: CardinalitySummary | null = null;
    let replacementEdge: LiveRelationship | null = null;
    let replacementPreviousEdge: LiveRelationship | null = null;
    let multiAddedEdge: LiveRelationship | null = null;
    let unlinkedEdge: LiveRelationship | null = null;
    let archivedRecordId = "";
    let archiveResponse: Response | null = null;
    let restoreResponse: Response | null = null;

    async function persist(assertion: LiveAssertionResult): Promise<void> {
      await writeLiveReport(
        environment.runId,
        { assertions: [assertion], integritySummary: reportSummary },
        LIVE_RESULTS_ROOT,
      );
    }

    async function runCheck(check: CheckDefinition): Promise<void> {
      try {
        const detail = await check.run();
        await persist(
          createIntegrityAssertion(check.id, check.name, "Pass", detail),
        );
      } catch (reason) {
        await persist(
          createIntegrityAssertion(
            check.id,
            check.name,
            "Fail",
            safeFailureDetail(check.name, reason),
          ),
        ).catch(() => undefined);
        throw reason;
      }
    }

    try {
      const manifest = await readManifest(environment.runId, LIVE_RESULTS_ROOT);
      if (
        manifest.operations.some((operation) =>
          operation.id.startsWith("integrity:"),
        )
      ) {
        throw new Error(
          "Live manifest already contains integrity operations; refusing to repeat live mutations",
        );
      }
      await signInLiveAdmin(
        page,
        liveCredentialsFromEnvironment(environment),
        environment.uiOrigin,
      );
      browserSignedIn = true;
      await assertLiveSession(page);
      const browserActor = await getLiveActorFromBff(page);
      await assertLiveAdminRoleFromBff(page, browserActor.role_id);
      assertActorMatchesManifest(manifest, browserActor);

      await writeLiveReport(
        environment.runId,
        {
          assertions: assertionPlaceholders(),
          integritySummary: reportSummary,
        },
        LIVE_RESULTS_ROOT,
      );

      await withLiveAdminToken(environment, async ({ api, user }) => {
        const currentManifest = await readManifest(
          environment.runId,
          LIVE_RESULTS_ROOT,
        );
        assertActorMatchesManifest(currentManifest, user);
        const ui = new LiveSeedPage(page, environment.uiOrigin);

        const checks: readonly CheckDefinition[] = [
          {
            id: "catalog-footprint",
            name: "Exact catalog footprint",
            run: async () => {
              snapshot = await readCatalog(api, maps, scale);
              const expectedRecords = runtime.modules.reduce(
                (total, catalogModule) =>
                  total + targetRecordCount(scale, catalogModule.order),
                0,
              );
              const observedRecords = [
                ...snapshot.recordsByModule.values(),
              ].reduce((total, records) => total + records.length, 0);
              const acceptedSchemas = snapshot.modules.filter(
                (module) => module.is_schema_accepted,
              ).length;
              reportSummary = {
                ...reportSummary,
                catalog: {
                  ...reportSummary.catalog,
                  acceptedSchemas,
                  expectedRecords,
                  observedRecords,
                },
              };
              return `12 departments, 57 modules, 342 primitive fields, 13 relationship fields, ${acceptedSchemas} accepted schemas, and ${observedRecords}/${expectedRecords} records confirmed; relationship field IDs are absent from record data.`;
            },
          },
          {
            id: "ui-smoke",
            name: "Namespaced UI smoke and validation",
            run: async () => {
              if (!snapshot) throw new Error("Catalog snapshot is unavailable");
              const firstDepartment = runtime.departments[0];
              const firstModule = runtime.modules.find(
                (catalogModule) =>
                  catalogModule.departmentKey === firstDepartment?.key,
              );
              if (!firstDepartment || !firstModule)
                throw new Error("First UI module is unavailable");
              const departmentId = maps.departmentIds.get(firstDepartment.key);
              const moduleId = maps.moduleIds.get(firstModule.key);
              const recordId = maps.uiRecordIdsByModule.get(
                firstModule.key,
              )?.[0];
              if (!departmentId || !moduleId || !recordId)
                throw new Error("UI sanity IDs are unavailable");

              await ui.openDepartment(departmentId, firstDepartment.name);
              const modulePath = routeFor(departmentId, moduleId);
              await page.goto(modulePath);
              assertExactUiPath(page, modulePath, environment.uiOrigin);
              await expect(
                page.getByRole("heading", {
                  name: firstModule.name,
                  exact: true,
                }),
              ).toBeVisible();
              const recordsPath = routeFor(departmentId, moduleId, "/records");
              await page.goto(recordsPath);
              assertExactUiPath(page, recordsPath, environment.uiOrigin);
              await expect(
                page.getByRole("columnheader", { name: /run marker/i }),
              ).toBeVisible();
              const recordLink = page.locator(
                `a[href$="/records/${recordId}/edit"]`,
              );
              await expect(recordLink).toHaveAccessibleName(
                compactRecordId(recordId),
              );
              await ui.openRecordEdit(departmentId, moduleId, recordId);
              await expect(
                page.getByRole("heading", {
                  name: "Manage relationships",
                  exact: true,
                }),
              ).toBeVisible();

              const fields = snapshot.fieldsByModule.get(firstModule.key) ?? [];
              const primitiveFields = fields.filter(
                (field) => field.type !== "relationship",
              );
              const relationshipFields = fields.filter(
                (field) => field.type === "relationship",
              );
              for (const field of primitiveFields) {
                await expect(page.locator(`[id="${field.id}"]`)).toBeVisible();
              }
              for (const field of relationshipFields) {
                await expect(
                  page.getByLabel(field.name, { exact: true }),
                ).toHaveCount(0);
              }

              const runMarker = primitiveFields.find((field) =>
                field.name.endsWith("(run marker)"),
              );
              if (!runMarker)
                throw new Error("Required run marker field is unavailable");
              const runMarkerControl = page.locator(`[id="${runMarker.id}"]`);
              const originalRunMarker = await runMarkerControl.inputValue();
              const form = page
                .locator("form")
                .filter({ has: runMarkerControl })
                .first();
              await runMarkerControl.fill("");
              expect(
                await form.evaluate((element) =>
                  (element as HTMLFormElement).checkValidity(),
                ),
              ).toBe(false);
              const invalidRecordWrites: string[] = [];
              const observeInvalidRecordWrite = (request: Request) => {
                const url = new URL(request.url());
                if (
                  request.method() === "PATCH" &&
                  url.origin === environment.uiOrigin &&
                  url.pathname === `/bff/records/${recordId}`
                ) {
                  invalidRecordWrites.push(url.pathname);
                }
              };
              page.on("request", observeInvalidRecordWrite);
              await page
                .getByRole("button", { name: "Save changes", exact: true })
                .click();
              await expect(
                page.getByText(`${runMarker.name} is required`, {
                  exact: true,
                }),
              ).toBeVisible();
              expect(invalidRecordWrites).toEqual([]);
              page.off("request", observeInvalidRecordWrite);
              await runMarkerControl.fill(originalRunMarker);

              const selectField = primitiveFields.find(
                (field) => field.type === "select",
              );
              if (!selectField || !Array.isArray(selectField.config.options))
                throw new Error("Configured select field is unavailable");
              const selectControl = page.getByRole("combobox", {
                name: selectField.name,
                exact: true,
              });
              await expect(selectControl.locator("option")).toHaveCount(
                selectField.config.options.length + 1,
              );
              expect(
                await selectControl
                  .locator("option")
                  .evaluateAll((options) =>
                    options.map(
                      (option) => (option as HTMLOptionElement).value,
                    ),
                  ),
              ).toEqual(["", ...selectField.config.options.map(String)]);

              const forbiddenModule = runtime.modules.find(
                (catalogModule) =>
                  catalogModule.departmentKey !== firstModule.departmentKey,
              );
              const relationship = runtime.relationships.find(
                (item) => item.sourceModuleKey === firstModule.key,
              );
              if (!forbiddenModule || !relationship)
                throw new Error(
                  "UI relationship smoke prerequisite is unavailable",
                );
              const schemaPath = routeFor(departmentId, moduleId, "/schema");
              await page.goto(schemaPath);
              assertExactUiPath(page, schemaPath, environment.uiOrigin);
              await expect(
                page.getByRole("heading", {
                  name: "Field builder",
                  exact: true,
                }),
              ).toBeVisible();
              await page
                .getByLabel("Type", { exact: true })
                .selectOption("relationship");
              await ui.assertTargetModuleOptionAbsent(forbiddenModule.name);

              const sourceRecord = await api.get(
                `/records/${recordId}`,
                undefined,
                isLiveRecord,
              );
              const invalidSelectData = {
                ...sourceRecord.data,
                [selectField.id]: "__invalid_select__",
              };
              await expectRejected(
                () =>
                  api.patch(`/records/${recordId}`, {
                    data: invalidSelectData,
                  }),
                "invalid select value",
                negativeEvidence,
                [422],
              );
              const afterInvalidSelect = await api.get(
                `/records/${recordId}`,
                undefined,
                isLiveRecord,
              );
              assertStateUnchanged(
                [sourceRecord],
                [afterInvalidSelect],
                "Invalid select record state",
              );
              const intField = primitiveFields.find(
                (field) => field.type === "int",
              );
              if (!intField)
                throw new Error("Configured integer field is unavailable");
              await expectRejected(
                () =>
                  api.patch(`/records/${recordId}`, {
                    data: {
                      ...sourceRecord.data,
                      [intField.id]: "not-an-integer",
                    },
                  }),
                "invalid primitive value",
                negativeEvidence,
                [422],
              );
              const afterInvalidPrimitive = await api.get(
                `/records/${recordId}`,
                undefined,
                isLiveRecord,
              );
              assertStateUnchanged(
                [sourceRecord],
                [afterInvalidPrimitive],
                "Invalid primitive record state",
              );
              reportSummary = {
                ...reportSummary,
                apiNegatives: negativeEvidence,
              };
              return `Department, module, records table, edit form, distinct primitive controls, required run marker, configured select options, and cross-department target exclusion rendered; API negatives: ${negativeEvidence.length}; unique-record-values remains Not Supported.`;
            },
          },
          {
            id: "cardinality",
            name: "Relationship cardinality audit",
            run: async () => {
              if (!snapshot) throw new Error("Catalog snapshot is unavailable");
              const edgesByKey = new Map<string, readonly LiveRelationship[]>();
              for (const relationship of runtime.relationships) {
                const field = relationshipFieldFor(
                  snapshot,
                  maps,
                  relationship,
                );
                edgesByKey.set(field.id, await currentEdges(api, field.id));
              }
              const keyedEdges = new Map<string, readonly LiveRelationship[]>();
              for (const relationship of runtime.relationships) {
                const field = relationshipFieldFor(
                  snapshot,
                  maps,
                  relationship,
                );
                keyedEdges.set(
                  relationship.key,
                  edgesByKey.get(field.id) ?? [],
                );
              }
              cardinalitySummary = auditRelationshipCardinality(
                runtime.relationships,
                keyedEdges,
              );
              reportSummary = {
                ...reportSummary,
                cardinality: reportCardinality(cardinalitySummary),
              };
              return `13 relationship fields validated with ${cardinalitySummary.fields.reduce((total, field) => total + field.activeEdges, 0)} active edges; every field and cardinality category has a seeded representative.`;
            },
          },
          {
            id: "invalid-links",
            name: "Invalid and cross-department relationship rejection",
            run: async () => {
              if (!snapshot) throw new Error("Catalog snapshot is unavailable");
              const employee = moduleFor(runtime, "employees");
              const employeeRecordId = maps.uiRecordIdsByModule.get(
                employee.key,
              )?.[0];
              const manager = relationshipFor(runtime, "employee-manager");
              const managerField = relationshipFieldFor(
                snapshot,
                maps,
                manager,
              );
              if (!employeeRecordId)
                throw new Error("Employee UI record is unavailable");
              const beforeSelf = await currentEdges(api, managerField.id);
              await expectRejected(
                () =>
                  api.put(
                    `/relationships/fields/${managerField.id}/sources/${employeeRecordId}`,
                    { target_record_id: employeeRecordId },
                  ),
                "same-module self-link",
                negativeEvidence,
              );
              const afterSelf = await currentEdges(api, managerField.id);
              assertStateUnchanged(beforeSelf, afterSelf, "Self-link state");

              const crossRelationship = relationshipFor(
                runtime,
                "employee-job-position",
              );
              const crossField = relationshipFieldFor(
                snapshot,
                maps,
                crossRelationship,
              );
              const crossTargetModule = moduleFor(runtime, "budgets");
              const crossTargetId = maps.uiRecordIdsByModule.get(
                crossTargetModule.key,
              )?.[0];
              if (!crossTargetId)
                throw new Error(
                  "Cross-department negative target is unavailable",
                );
              const beforeCross = await currentEdges(api, crossField.id);
              await expectRejected(
                () =>
                  api.post("/relationships", {
                    field_id: crossField.id,
                    source_record_id: employeeRecordId,
                    target_record_id: crossTargetId,
                  }),
                "cross-department target",
                negativeEvidence,
              );
              const afterCross = await currentEdges(api, crossField.id);
              assertStateUnchanged(
                beforeCross,
                afterCross,
                "Cross-department schema state",
              );

              const oneToOne = relationshipFor(
                runtime,
                "employee-primary-payroll-record",
              );
              const oneToOneField = relationshipFieldFor(
                snapshot,
                maps,
                oneToOne,
              );
              const oneToOneEdges = await currentEdges(api, oneToOneField.id);
              const activeOneToOneEdges = oneToOneEdges.filter(
                (edge) => !edge.is_deleted,
              );
              const occupiedTarget = activeOneToOneEdges[0];
              const conflictingSource = activeOneToOneEdges.find(
                (edge) =>
                  edge.source_record_id !== occupiedTarget?.source_record_id,
              );
              if (!occupiedTarget || !conflictingSource)
                throw new Error(
                  "One-to-one conflict prerequisite is unavailable",
                );
              const beforeOneToOneConflict = [...oneToOneEdges];
              await expectRejected(
                () =>
                  api.put(
                    `/relationships/fields/${oneToOneField.id}/sources/${conflictingSource.source_record_id}`,
                    { target_record_id: occupiedTarget.target_record_id },
                  ),
                "one-to-one single-source conflict",
                negativeEvidence,
                [409],
              );
              const afterOneToOneConflict = await currentEdges(
                api,
                oneToOneField.id,
              );
              assertStateUnchanged(
                beforeOneToOneConflict,
                afterOneToOneConflict,
                "One-to-one conflict state",
              );
              reportSummary = {
                ...reportSummary,
                apiNegatives: negativeEvidence,
              };
              return `Same-module Employee→Manager self-link and cross-department target were rejected without changing active or deleted edge state; negative paths/statuses are recorded.`;
            },
          },
          {
            id: "single-target-replacement",
            name: "Single-target atomic replacement",
            run: async () => {
              if (!snapshot) throw new Error("Catalog snapshot is unavailable");
              const relationship = relationshipFor(
                runtime,
                "sales-order-customer",
              );
              const sourceModule = moduleFor(
                runtime,
                relationship.sourceModuleKey,
              );
              const targetModule = moduleFor(
                runtime,
                relationship.targetModuleKey,
              );
              const sourceRecordId = maps.uiRecordIdsByModule.get(
                sourceModule.key,
              )?.[0];
              const field = relationshipFieldFor(snapshot, maps, relationship);
              const targetRecords =
                snapshot.recordsByModule.get(targetModule.key) ?? [];
              if (!sourceRecordId)
                throw new Error("Sales order UI source is unavailable");
              const before = await currentEdges(api, field.id, sourceRecordId);
              const previous = before.find((edge) => !edge.is_deleted);
              if (!previous)
                throw new Error("Single-target seeded edge is unavailable");
              const alternate = selectSafeTargetRecord(targetRecords, {
                targetModuleId: maps.moduleIds.get(targetModule.key),
                sourceRecordId,
                currentTargetId: previous.target_record_id,
              });
              if (!alternate)
                throw new Error(
                  "No safe alternate single-target record is available",
                );
              const departmentId = departmentIdFor(maps, sourceModule);
              await ui.openRecordEdit(
                departmentId,
                maps.moduleIds.get(sourceModule.key) ?? "",
                sourceRecordId,
              );
              const puts: Request[] = [];
              const onRequest = (request: Request) => {
                if (
                  request.method() === "PUT" &&
                  request
                    .url()
                    .includes(
                      `/relationships/fields/${field.id}/sources/${sourceRecordId}`,
                    )
                )
                  puts.push(request);
              };
              page.on("request", onRequest);
              let mutation: LiveMutation;
              const replacementOperationId = `integrity:replacement:${relationship.key}:${sourceRecordId}`;
              await beginIntegrityOperation(
                environment,
                replacementOperationId,
                `field:${relationship.key}`,
                "create_relationship_edge",
                "relationship",
              );
              try {
                mutation = await ui.addRelationship(
                  relationship,
                  field,
                  sourceRecordId,
                  alternate.id,
                );
              } finally {
                page.off("request", onRequest);
              }
              expect(puts).toHaveLength(1);
              if (!isLiveRelationship(mutation.body))
                throw new Error(
                  "Replacement response did not contain an exact relationship edge",
                );
              const after = await currentEdges(api, field.id, sourceRecordId);
              const active = after.filter((edge) => !edge.is_deleted);
              expect(active).toHaveLength(1);
              expect(active[0]).toMatchObject({
                id: mutation.body.id,
                field_id: field.id,
                source_record_id: sourceRecordId,
                target_record_id: alternate.id,
              });
              expect(
                after.find((edge) => edge.id === previous.id)?.is_deleted,
              ).toBe(true);
              replacementEdge = active[0] ?? null;
              replacementPreviousEdge = previous;
              await journalIntegrityOperation(
                environment,
                replacementOperationId,
                `field:${relationship.key}`,
                "create_relationship_edge",
                "relationship",
                mutation.body.id,
                [
                  {
                    request: {
                      method: "PUT",
                      status: mutation.response.status(),
                    },
                    state: { replaced_edge: previous.id },
                  },
                ],
              );
              const replacementStateOperationId = `integrity:replacement-state:${previous.id}`;
              await beginIntegrityOperation(
                environment,
                replacementStateOperationId,
                `field:${relationship.key}`,
                "soft_delete_relationship_edge",
                "relationship",
                previous.id,
              );
              await journalIntegrityOperation(
                environment,
                replacementStateOperationId,
                `field:${relationship.key}`,
                "soft_delete_relationship_edge",
                "relationship",
                previous.id,
                [
                  {
                    state: {
                      is_deleted: true,
                      replacement_edge: mutation.body.id,
                    },
                  },
                ],
              );
              return `Exactly one PUT returned and left one active source edge; the prior edge is soft-deleted and the returned target is exact.`;
            },
          },
          {
            id: "multi-target-add",
            name: "Multi-target add and duplicate rejection",
            run: async () => {
              if (!snapshot) throw new Error("Catalog snapshot is unavailable");
              const relationship = relationshipFor(
                runtime,
                "employee-training-programs",
              );
              const sourceModule = moduleFor(
                runtime,
                relationship.sourceModuleKey,
              );
              const targetModule = moduleFor(
                runtime,
                relationship.targetModuleKey,
              );
              const sourceRecordId = maps.uiRecordIdsByModule.get(
                sourceModule.key,
              )?.[0];
              const field = relationshipFieldFor(snapshot, maps, relationship);
              if (!sourceRecordId)
                throw new Error("Employee UI source is unavailable");
              const before = await currentEdges(api, field.id, sourceRecordId);
              const activeBefore = before.filter((edge) => !edge.is_deleted);
              const targetRecords =
                snapshot.recordsByModule.get(targetModule.key) ?? [];
              const alternate = selectSafeTargetRecord(targetRecords, {
                targetModuleId: maps.moduleIds.get(targetModule.key),
                sourceRecordId,
                excludeRecordIds: activeBefore.map(
                  (edge) => edge.target_record_id,
                ),
              });
              if (!alternate)
                throw new Error(
                  "No safe alternate multi-target record is available",
                );
              await ui.openRecordEdit(
                departmentIdFor(maps, sourceModule),
                maps.moduleIds.get(sourceModule.key) ?? "",
                sourceRecordId,
              );
              const multiAddOperationId = `integrity:multi-add:${relationship.key}:${sourceRecordId}:${alternate.id}`;
              await beginIntegrityOperation(
                environment,
                multiAddOperationId,
                `field:${relationship.key}`,
                "create_relationship_edge",
                "relationship",
              );
              const mutation = await ui.addRelationship(
                relationship,
                field,
                sourceRecordId,
                alternate.id,
              );
              if (!isLiveRelationship(mutation.body))
                throw new Error(
                  "Multi-target response did not contain an exact relationship edge",
                );
              const afterAdd = await currentEdges(
                api,
                field.id,
                sourceRecordId,
              );
              const activeAfterAdd = afterAdd.filter(
                (edge) => !edge.is_deleted,
              );
              expect(activeAfterAdd.map((edge) => edge.id).sort()).toEqual(
                [
                  ...activeBefore.map((edge) => edge.id),
                  mutation.body.id,
                ].sort(),
              );
              const duplicateBefore = [...afterAdd];
              await expectRejected(
                () =>
                  api.post("/relationships", {
                    field_id: field.id,
                    source_record_id: sourceRecordId,
                    target_record_id: alternate.id,
                  }),
                "duplicate multi-target edge",
                negativeEvidence,
                [409],
              );
              const duplicateAfter = await currentEdges(
                api,
                field.id,
                sourceRecordId,
              );
              assertStateUnchanged(
                duplicateBefore,
                duplicateAfter,
                "Duplicate multi-target state",
              );
              multiAddedEdge = mutation.body;
              await journalIntegrityOperation(
                environment,
                multiAddOperationId,
                `field:${relationship.key}`,
                "create_relationship_edge",
                "relationship",
                mutation.body.id,
                [
                  {
                    request: {
                      method: "POST",
                      status: mutation.response.status(),
                    },
                    state: { preserved_active_edges: activeBefore.length },
                  },
                ],
              );
              reportSummary = {
                ...reportSummary,
                apiNegatives: negativeEvidence,
              };
              return `UI used POST, preserved ${activeBefore.length} prior active edges, and a duplicate POST returned HTTP ${negativeEvidence.at(-1)?.status ?? 409} with an unchanged active set.`;
            },
          },
          {
            id: "archive-cardinality",
            name: "Archived target visibility and cardinality",
            run: async () => {
              if (!snapshot) throw new Error("Catalog snapshot is unavailable");
              const relationship = relationshipFor(
                runtime,
                "employee-primary-payroll-record",
              );
              const sourceModule = moduleFor(
                runtime,
                relationship.sourceModuleKey,
              );
              const targetModule = moduleFor(
                runtime,
                relationship.targetModuleKey,
              );
              const field = relationshipFieldFor(snapshot, maps, relationship);
              const seeded = await currentEdges(api, field.id);
              const sourceRecordId = maps.uiRecordIdsByModule.get(
                sourceModule.key,
              )?.[0];
              const sourceEdge = seeded.find(
                (edge) =>
                  edge.source_record_id === sourceRecordId && !edge.is_deleted,
              );
              if (!sourceRecordId || !sourceEdge)
                throw new Error("One-to-one archive edge is unavailable");
              archivedRecordId = sourceEdge.target_record_id;
              await beginIntegrityOperation(
                environment,
                `integrity:archive:${archivedRecordId}`,
                `module:${targetModule.key}`,
                "archive_record",
                "record",
                archivedRecordId,
              );
              archiveResponse = await archiveRecordThroughUi(
                page,
                departmentIdFor(maps, targetModule),
                maps.moduleIds.get(targetModule.key) ?? "",
                archivedRecordId,
                environment.uiOrigin,
              );
              const archivedEdges = await currentEdges(api, field.id);
              const hidden = archivedEdges.find(
                (edge) => edge.id === sourceEdge.id,
              );
              expect(hidden).toMatchObject({
                is_deleted: false,
                visibility: "hidden",
              });
              expect(hidden?.hidden_reasons).toContain(
                "target_record_archived",
              );
              const conflicting = archivedEdges.find(
                (edge) =>
                  !edge.is_deleted &&
                  edge.target_record_id !== archivedRecordId,
              );
              if (!conflicting)
                throw new Error("One-to-one conflict source is unavailable");
              const beforeConflict = [...archivedEdges];
              await expectRejected(
                () =>
                  api.put(
                    `/relationships/fields/${field.id}/sources/${conflicting.source_record_id}`,
                    { target_record_id: archivedRecordId },
                  ),
                "archived target cardinality conflict",
                negativeEvidence,
                [409],
              );
              const afterConflict = await currentEdges(api, field.id);
              assertStateUnchanged(
                beforeConflict,
                afterConflict,
                "Archived cardinality reservation",
              );
              await ui.openRecordEdit(
                departmentIdFor(maps, sourceModule),
                maps.moduleIds.get(sourceModule.key) ?? "",
                sourceRecordId,
              );
              await expect(
                page.getByText(/Target record archived/i),
              ).toBeVisible();
              await beginIntegrityOperation(
                environment,
                `integrity:restore:${archivedRecordId}`,
                `module:${targetModule.key}`,
                "restore_record",
                "record",
                archivedRecordId,
              );
              restoreResponse = await restoreRecordThroughUi(
                page,
                departmentIdFor(maps, targetModule),
                maps.moduleIds.get(targetModule.key) ?? "",
                archivedRecordId,
                environment.uiOrigin,
              );
              const restoredEdges = await currentEdges(api, field.id);
              expect(
                restoredEdges.find((edge) => edge.id === sourceEdge.id),
              ).toMatchObject({
                is_deleted: false,
                visibility: "available",
                hidden_reasons: [],
              });
              await journalIntegrityOperation(
                environment,
                `integrity:archive:${archivedRecordId}`,
                `module:${targetModule.key}`,
                "archive_record",
                "record",
                archivedRecordId,
                [
                  {
                    request: {
                      method: "DELETE",
                      status: archiveResponse.status(),
                    },
                  },
                ],
              );
              await journalIntegrityOperation(
                environment,
                `integrity:restore:${archivedRecordId}`,
                `module:${targetModule.key}`,
                "restore_record",
                "record",
                archivedRecordId,
                [
                  {
                    request: {
                      method: "POST",
                      status: restoreResponse.status(),
                    },
                  },
                ],
              );
              reportSummary = {
                ...reportSummary,
                apiNegatives: negativeEvidence,
              };
              return `Archive returned HTTP ${archiveResponse.status()}, hid the existing edge with target_record_archived while reserving cardinality, and restore returned HTTP ${restoreResponse.status()} with the edge available again.`;
            },
          },
          {
            id: "incoming-outgoing-links",
            name: "Incoming read-only and outgoing unlink",
            run: async () => {
              if (!snapshot || !multiAddedEdge)
                throw new Error("Multi-target edge is unavailable");
              const relationship = relationshipFor(
                runtime,
                "employee-training-programs",
              );
              const sourceModule = moduleFor(
                runtime,
                relationship.sourceModuleKey,
              );
              const targetModule = moduleFor(
                runtime,
                relationship.targetModuleKey,
              );
              const field = relationshipFieldFor(snapshot, maps, relationship);
              const sourceRecordId = maps.uiRecordIdsByModule.get(
                sourceModule.key,
              )?.[0];
              if (!sourceRecordId)
                throw new Error("Employee UI source is unavailable");
              const edges = await currentEdges(api, field.id, sourceRecordId);
              const candidate = edges.find(
                (edge) => !edge.is_deleted && edge.id !== multiAddedEdge?.id,
              );
              if (!candidate)
                throw new Error("Manifest-owned outgoing edge is unavailable");
              unlinkedEdge = candidate;
              await ui.openRecordEdit(
                departmentIdFor(maps, sourceModule),
                maps.moduleIds.get(sourceModule.key) ?? "",
                sourceRecordId,
              );
              const list = page.getByRole("list", {
                name: `${relationship.name} current links`,
                exact: true,
              });
              const link = list
                .getByRole("listitem")
                .filter({
                  has: page.getByText(
                    compactRecordId(candidate.target_record_id),
                    { exact: true },
                  ),
                })
                .first();
              await expect(link).toBeVisible();
              const deleteRequests: Request[] = [];
              const onRequest = (request: Request) => {
                if (
                  request.method() === "DELETE" &&
                  request.url().endsWith(`/relationships/${candidate.id}`)
                )
                  deleteRequests.push(request);
              };
              page.on("request", onRequest);
              const unlinkOperationId = `integrity:unlink:${candidate.id}`;
              await beginIntegrityOperation(
                environment,
                unlinkOperationId,
                `field:${relationship.key}`,
                "unlink_relationship_edge",
                "relationship",
                candidate.id,
              );
              const deleteResponse = page.waitForResponse((response) => {
                const url = new URL(response.url());
                return (
                  response.request().method() === "DELETE" &&
                  url.origin === environment.uiOrigin &&
                  url.pathname === `/bff/relationships/${candidate.id}` &&
                  url.search === "" &&
                  url.hash === ""
                );
              });
              try {
                await link
                  .getByRole("button", { name: "Unlink", exact: true })
                  .click();
                await deleteResponse;
              } finally {
                page.off("request", onRequest);
              }
              expect(deleteRequests).toHaveLength(1);
              const afterDelete = await currentEdges(
                api,
                field.id,
                sourceRecordId,
              );
              expect(
                afterDelete.find((edge) => edge.id === candidate.id)
                  ?.is_deleted,
              ).toBe(true);
              await journalIntegrityOperation(
                environment,
                unlinkOperationId,
                `field:${relationship.key}`,
                "unlink_relationship_edge",
                "relationship",
                candidate.id,
                [
                  {
                    request: { method: "DELETE", status: 204 },
                    state: { is_deleted: true },
                  },
                ],
              );

              await ui.openRecordEdit(
                departmentIdFor(maps, targetModule),
                maps.moduleIds.get(targetModule.key) ?? "",
                multiAddedEdge.target_record_id,
              );
              const incoming = page.getByRole("region", {
                name: "Incoming links",
                exact: true,
              });
              await expect(incoming).toContainText(
                compactRecordId(sourceRecordId),
              );
              await expect(
                incoming.getByRole("button", { name: /Unlink|Remove/ }),
              ).toHaveCount(0);
              const finalEdgesByKey = new Map<
                string,
                readonly LiveRelationship[]
              >();
              for (const item of runtime.relationships) {
                const relationshipField = relationshipFieldFor(
                  snapshot,
                  maps,
                  item,
                );
                finalEdgesByKey.set(
                  item.key,
                  await currentEdges(api, relationshipField.id),
                );
              }
              auditRelationshipCardinality(
                runtime.relationships,
                finalEdgesByKey,
              );
              return `Incoming links rendered read-only; one manifest-owned outgoing edge used exactly one DELETE and is soft-deleted, while the final active relationship set remains cardinality-safe.`;
            },
          },
          {
            id: "audit-evidence",
            name: "Audit UI and API evidence",
            run: async () => {
              if (
                !snapshot ||
                !replacementEdge ||
                !replacementPreviousEdge ||
                !multiAddedEdge ||
                !unlinkedEdge ||
                !archivedRecordId
              )
                throw new Error("Audit mutation IDs are unavailable");
              const employee = moduleFor(runtime, "employees");
              const employeeRecordId = maps.uiRecordIdsByModule.get(
                employee.key,
              )?.[0];
              const runMarker = snapshot.fieldsByModule
                .get(employee.key)
                ?.find(
                  (field) =>
                    field.type === "text" &&
                    field.name.endsWith("(run marker)"),
                );
              if (!employeeRecordId || !runMarker)
                throw new Error(
                  "Audit record update prerequisite is unavailable",
                );
              const original = await api.get(
                `/records/${employeeRecordId}`,
                undefined,
                isLiveRecord,
              );
              await ui.openRecordEdit(
                departmentIdFor(maps, employee),
                maps.moduleIds.get(employee.key) ?? "",
                employeeRecordId,
              );
              const auditUpdateOperationId = `integrity:audit-update:${employeeRecordId}:audit`;
              await beginIntegrityOperation(
                environment,
                auditUpdateOperationId,
                `module:${employee.key}`,
                "update_record",
                "record",
                employeeRecordId,
              );
              const updateResponse = page.waitForResponse((response) => {
                const url = new URL(response.url());
                return (
                  response.request().method() === "PATCH" &&
                  url.origin === environment.uiOrigin &&
                  url.pathname === `/bff/records/${employeeRecordId}` &&
                  url.search === "" &&
                  url.hash === ""
                );
              });
              await page
                .locator(`[id="${runMarker.id}"]`)
                .fill(`${String(original.data[runMarker.id])}-audit`);
              await page
                .getByRole("button", { name: "Save changes", exact: true })
                .click();
              const updatedResponse = await updateResponse;
              await journalIntegrityOperation(
                environment,
                auditUpdateOperationId,
                `module:${employee.key}`,
                "update_record",
                "record",
                employeeRecordId,
                [
                  {
                    request: {
                      method: "PATCH",
                      status: updatedResponse.status(),
                    },
                  },
                ],
              );
              await ui.openRecordEdit(
                departmentIdFor(maps, employee),
                maps.moduleIds.get(employee.key) ?? "",
                employeeRecordId,
              );
              const restoreUpdateOperationId = `integrity:audit-update:${employeeRecordId}:restore`;
              await beginIntegrityOperation(
                environment,
                restoreUpdateOperationId,
                `module:${employee.key}`,
                "update_record",
                "record",
                employeeRecordId,
              );
              const restoreUpdateResponse = page.waitForResponse((response) => {
                const url = new URL(response.url());
                return (
                  response.request().method() === "PATCH" &&
                  url.origin === environment.uiOrigin &&
                  url.pathname === `/bff/records/${employeeRecordId}` &&
                  url.search === "" &&
                  url.hash === ""
                );
              });
              await page
                .locator(`[id="${runMarker.id}"]`)
                .fill(String(original.data[runMarker.id]));
              await page
                .getByRole("button", { name: "Save changes", exact: true })
                .click();
              const restoredResponse = await restoreUpdateResponse;
              await journalIntegrityOperation(
                environment,
                restoreUpdateOperationId,
                `module:${employee.key}`,
                "update_record",
                "record",
                employeeRecordId,
                [
                  {
                    request: {
                      method: "PATCH",
                      status: restoredResponse.status(),
                    },
                  },
                ],
              );
              const restoredRecord = await api.get(
                `/records/${employeeRecordId}`,
                undefined,
                isLiveRecord,
              );
              assertStateUnchanged(
                [{ id: original.id, data: original.data }],
                [{ id: restoredRecord.id, data: restoredRecord.data }],
                "Audit record final state",
              );

              await page.goto("/administration/audit");
              assertExactUiPath(
                page,
                "/administration/audit",
                environment.uiOrigin,
              );
              await expect(
                page.getByRole("heading", {
                  name: "Audit trail",
                  exact: true,
                }),
              ).toBeVisible();
              const auditResponse = page.waitForResponse((response) => {
                const url = new URL(response.url());
                return (
                  response.request().method() === "GET" &&
                  url.origin === environment.uiOrigin &&
                  url.pathname === "/bff/audit-logs" &&
                  url.hash === ""
                );
              });
              await page.getByLabel("Search audit trail").fill("records");
              await auditResponse;
              const uiRows = page
                .getByRole("row")
                .filter({ hasText: /records/ })
                .filter({ hasText: /\/records\// });
              await expect(uiRows.first()).toBeVisible();
              const uiRowCount = await uiRows.count();

              const recordLogs = await api.listAll<LiveAuditLog>(
                "/audit-logs",
                {
                  entity_type: "records",
                  entity_id: employeeRecordId,
                  limit: 100,
                  sort_by: "created_at",
                  sort_order: "asc",
                },
                1000,
                isLiveAuditLog,
              );
              const archivedRecordLogs = await api.listAll<LiveAuditLog>(
                "/audit-logs",
                {
                  entity_type: "records",
                  entity_id: archivedRecordId,
                  limit: 100,
                  sort_by: "created_at",
                  sort_order: "asc",
                },
                1000,
                isLiveAuditLog,
              );
              const replacementLogs = await api.listAll<LiveAuditLog>(
                "/audit-logs",
                {
                  entity_type: "relationship_edges",
                  entity_id: replacementEdge.id,
                  limit: 100,
                  sort_by: "created_at",
                  sort_order: "asc",
                },
                1000,
                isLiveAuditLog,
              );
              const replacementPreviousLogs = await api.listAll<LiveAuditLog>(
                "/audit-logs",
                {
                  entity_type: "relationship_edges",
                  entity_id: replacementPreviousEdge.id,
                  limit: 100,
                  sort_by: "created_at",
                  sort_order: "asc",
                },
                1000,
                isLiveAuditLog,
              );
              const multiLogs = await api.listAll<LiveAuditLog>(
                "/audit-logs",
                {
                  entity_type: "relationship_edges",
                  entity_id: multiAddedEdge.id,
                  limit: 100,
                  sort_by: "created_at",
                  sort_order: "asc",
                },
                1000,
                isLiveAuditLog,
              );
              const unlinkedLogs = await api.listAll<LiveAuditLog>(
                "/audit-logs",
                {
                  entity_type: "relationship_edges",
                  entity_id: unlinkedEdge.id,
                  limit: 100,
                  sort_by: "created_at",
                  sort_order: "asc",
                },
                1000,
                isLiveAuditLog,
              );
              const detailLogs: LiveAuditLog[] = [];
              const fetchDetails = async (logs: readonly LiveAuditLog[]) => {
                for (const log of logs)
                  detailLogs.push(
                    await api.get(
                      `/audit-logs/${log.id}`,
                      undefined,
                      isLiveAuditLog,
                    ),
                  );
              };
              await fetchDetails(recordLogs);
              await fetchDetails(archivedRecordLogs);
              await fetchDetails(replacementLogs);
              await fetchDetails(replacementPreviousLogs);
              await fetchDetails(multiLogs);
              await fetchDetails(unlinkedLogs);
              const hasMutation = (
                logs: readonly LiveAuditLog[],
                action: LiveAuditLog["action"],
                method: string,
                path: RegExp,
                snapshotKind: "before" | "after",
              ) =>
                logs.some(
                  (log) =>
                    log.action === action &&
                    log.request_method === method &&
                    path.test(log.request_path ?? "") &&
                    log[snapshotKind] !== null,
                );
              expect(
                hasMutation(
                  recordLogs,
                  "create",
                  "POST",
                  /\/records(?:\/|$)/,
                  "after",
                ),
              ).toBe(true);
              expect(
                hasMutation(
                  recordLogs,
                  "update",
                  "PATCH",
                  new RegExp(`/records/${employeeRecordId}$`),
                  "before",
                ),
              ).toBe(true);
              expect(
                hasMutation(
                  recordLogs,
                  "update",
                  "PATCH",
                  new RegExp(`/records/${employeeRecordId}$`),
                  "after",
                ),
              ).toBe(true);
              expect(
                hasMutation(
                  archivedRecordLogs,
                  "delete",
                  "DELETE",
                  new RegExp(`/records/${archivedRecordId}$`),
                  "before",
                ),
              ).toBe(true);
              expect(
                hasMutation(
                  replacementLogs,
                  "create",
                  "PUT",
                  /\/relationships\/fields\//,
                  "after",
                ),
              ).toBe(true);
              expect(
                hasMutation(
                  replacementPreviousLogs,
                  "delete",
                  "PUT",
                  /\/relationships\/fields\//,
                  "before",
                ),
              ).toBe(true);
              expect(
                hasMutation(
                  multiLogs,
                  "create",
                  "POST",
                  /\/relationships$/,
                  "after",
                ),
              ).toBe(true);
              expect(
                hasMutation(
                  unlinkedLogs,
                  "delete",
                  "DELETE",
                  new RegExp(`/relationships/${unlinkedEdge.id}$`),
                  "before",
                ),
              ).toBe(true);
              reportSummary = {
                ...reportSummary,
                audit: {
                  uiRows: uiRowCount,
                  filteredLogs:
                    recordLogs.length +
                    archivedRecordLogs.length +
                    replacementLogs.length +
                    replacementPreviousLogs.length +
                    multiLogs.length +
                    unlinkedLogs.length,
                  detailLogs: detailLogs.length,
                },
              };
              return `Audit UI showed ${uiRowCount} targeted mutation row(s); exact entity filters returned ${recordLogs.length + archivedRecordLogs.length + replacementLogs.length + replacementPreviousLogs.length + multiLogs.length + unlinkedLogs.length} logs and ${detailLogs.length} details with create/update/delete snapshots and request method/path evidence.`;
            },
          },
        ];
        for (const check of checks) await runCheck(check);
        await persist(
          createIntegrityAssertion(
            "integrity-suite",
            "Integrity suite",
            "Pass",
            `All ${CHECKS.length} live checks passed at ${scale} scale; unique-record-values is Not Supported by contract.`,
          ),
        );
      });
    } catch (reason) {
      await persist(
        createIntegrityAssertion(
          "integrity-suite",
          "Integrity suite",
          "Fail",
          "Integrity suite failed; diagnostic details remain in Playwright output and are omitted from the report.",
        ),
      ).catch(() => undefined);
      throw reason;
    } finally {
      if (browserSignedIn) await signOutLiveAdmin(page).catch(() => undefined);
      await lock.release();
    }
  });
});
