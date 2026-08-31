import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  LIVE_CATALOG,
  createRuntimeCatalog,
  type RelationshipDefinition,
} from "./support/catalog";
import {
  createLiveApiClient,
  type LiveApiClient,
  type LiveRelationship,
} from "./support/api";
import {
  createManifest,
  readManifest,
  updateManifest,
  type LiveOperation,
} from "./support/manifest";
import {
  generateSanityFormValues,
  relationshipAssignments,
} from "./support/seed-helpers";
import { LIVE_BEARER_TOKEN_SENTINEL } from "./support/sanitize";
import {
  reconstructSeedMaps,
  seedRecordsForDepartment,
  seedRelationshipsForDepartment,
  targetRecordCount,
  type DepartmentSeedContext,
  type ReconstructedSeedMaps,
} from "./seed-data";
import { writeLiveReport, type LiveIntegritySummary } from "./support/report";
import { runtimeNamespaceForRunId } from "./support/preflight";

const RUN_ID = "run-20260830-001-00000000000000000000000000000001";
const MAPS_RUN_ID = "run-20260830-011-00000000000000000000000000000011";
const REPORT_RUN_ID = "run-20260830-012-00000000000000000000000000000012";
const STATE_RUN_ID = "run-20260830-013-00000000000000000000000000000013";
const DEPARTMENT_RECORD_RUN_ID =
  "run-20260830-014-00000000000000000000000000000014";
const DEPARTMENT_RELATIONSHIP_RUN_ID =
  "run-20260830-015-00000000000000000000000000000015";
const NAMESPACE = "live-seed-support";

function canonicalTestId(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function operation(
  id: string,
  parentId: string | null,
  entityType: string,
  entityId: string,
): LiveOperation {
  return {
    id,
    parent_id: parentId,
    operation:
      entityType === "relationship"
        ? "create_relationship_edge"
        : `create_${entityType}`,
    entity_type: entityType,
    entity_id: canonicalTestId(entityId),
    status: "succeeded",
    evidence: [],
  };
}

async function makeSchemaManifest(resultsRoot: string, runId: string) {
  const runtime = createRuntimeCatalog(NAMESPACE);
  const operations: LiveOperation[] = [];
  for (const department of runtime.departments) {
    operations.push(
      operation(
        `department:${department.key}`,
        null,
        "department",
        `d-${department.key}`,
      ),
    );
  }
  for (const catalogModule of runtime.modules) {
    operations.push(
      operation(
        `module:${catalogModule.key}`,
        `department:${catalogModule.departmentKey}`,
        "module",
        `m-${catalogModule.key}`,
      ),
    );
    for (const field of catalogModule.primitiveFields) {
      operations.push(
        operation(
          `field:${field.key}`,
          `module:${catalogModule.key}`,
          "field",
          `f-${field.key}`,
        ),
      );
    }
    operations.push({
      ...operation(
        `schema:${catalogModule.key}:accept`,
        `module:${catalogModule.key}`,
        "module",
        `m-${catalogModule.key}`,
      ),
      operation: "accept_schema",
    });
    for (const recordNumber of [1, 2]) {
      operations.push(
        operation(
          `record:${catalogModule.key}:${recordNumber}`,
          `module:${catalogModule.key}`,
          "record",
          `r-${catalogModule.key}-${recordNumber}`,
        ),
      );
    }
  }
  for (const relationship of runtime.relationships) {
    operations.push(
      operation(
        `field:${relationship.key}`,
        `module:${relationship.sourceModuleKey}`,
        "field",
        `f-${relationship.key}`,
      ),
      operation(
        `relationship:${relationship.key}`,
        `field:${relationship.key}`,
        "relationship",
        `e-${relationship.key}`,
      ),
    );
  }
  await createManifest(runId, runtimeNamespaceForRunId(runId), resultsRoot);
  await updateManifest(
    runId,
    (manifest) => ({ ...manifest, operations }),
    resultsRoot,
  );
}

type CapturedRequest = Readonly<{
  url: string;
  init?: RequestInit;
}>;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("JSON body is missing");
  const body: unknown = JSON.parse(init.body);
  if (!isObjectRecord(body)) throw new Error("JSON body is not an object");
  return body;
}

function responseBase(id: string) {
  return {
    id,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  } as const;
}

function relationshipResponse(
  id: string,
  fieldId: string,
  sourceRecordId: string,
  targetRecordId: string,
): LiveRelationship {
  return {
    ...responseBase(id),
    field_id: fieldId,
    source_record_id: sourceRecordId,
    target_record_id: targetRecordId,
    visibility: "available",
    hidden_reasons: [],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function stringValue(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string")
    throw new Error(`Missing string body field: ${key}`);
  return value;
}

function createSeedApi(
  requests: CapturedRequest[],
  existingByField: ReadonlyMap<string, readonly LiveRelationship[]> = new Map(),
): LiveApiClient {
  let created = 0;
  return createLiveApiClient(
    "http://127.0.0.1:8000",
    undefined,
    async (url, init) => {
      requests.push({ url, init });
      const requestUrl = new URL(url);
      const method = init?.method ?? "GET";
      if (method === "GET") {
        const fieldId = requestUrl.searchParams.get("field_id");
        if (!fieldId) throw new Error("Relationship field ID is missing");
        const items = existingByField.get(fieldId) ?? [];
        return new Response(
          JSON.stringify({
            items,
            pagination: {
              limit: 100,
              offset: 0,
              count: items.length,
              total: items.length,
              has_more: false,
            },
          }),
        );
      }

      const body = requestBody(init);
      if (method === "POST" && requestUrl.pathname === "/api/records") {
        return new Response(
          JSON.stringify({
            ...responseBase(canonicalTestId(`seed-response:${created++}`)),
            module_id: stringValue(body, "module_id"),
            data: body.data,
          }),
          { status: 201 },
        );
      }

      if (method === "POST" && requestUrl.pathname === "/api/relationships") {
        return jsonResponse(
          relationshipResponse(
            canonicalTestId(`seed-response:${created++}`),
            stringValue(body, "field_id"),
            stringValue(body, "source_record_id"),
            stringValue(body, "target_record_id"),
          ),
          201,
        );
      }

      const pathParts = requestUrl.pathname.split("/");
      if (method === "PUT" && pathParts[4] && pathParts[6]) {
        return jsonResponse(
          relationshipResponse(
            canonicalTestId(`seed-response:${created++}`),
            pathParts[4],
            pathParts[6],
            stringValue(body, "target_record_id"),
          ),
        );
      }

      throw new Error("Unexpected seed request");
    },
  );
}

function departmentContext(
  api: LiveApiClient,
  runId: string,
  resultsRoot: string,
  moduleIds: ReadonlyMap<string, string>,
  primitiveFieldIdsByModule: ReadonlyMap<string, ReadonlyMap<string, string>>,
  relationshipFieldIds: ReadonlyMap<string, string>,
  uiRecordIdsByModule: ReadonlyMap<string, readonly string[]>,
  relationships: readonly RelationshipDefinition[],
): DepartmentSeedContext {
  return {
    api,
    runId,
    resultsRoot,
    moduleIds,
    primitiveFieldIdsByModule,
    relationshipFieldIds,
    uiRecordIdsByModule,
    relationships,
  };
}

function departmentFor(maps: ReconstructedSeedMaps, key: string) {
  const department = maps.runtime.departments.find((item) => item.key === key);
  if (!department) throw new Error(`Runtime department is missing: ${key}`);
  return department;
}

test.describe("bulk seed pure and mocked support", () => {
  test("keeps both scale targets within the safe API bound", () => {
    expect(targetRecordCount("standard")).toBe(20);
    expect(targetRecordCount("extended")).toBe(80);
    expect(targetRecordCount("extended", 4)).toBe(100);
    expect(
      ["standard", "extended"].every((scale) => {
        const count = targetRecordCount(scale as "standard" | "extended", 56);
        return count >= 20 && count <= 100;
      }),
    ).toBe(true);
  });

  test("generates deterministic contextual values from curated catalog fields", () => {
    const catalogModule = LIVE_CATALOG.modules.find(
      (item) => item.key === "employees",
    );
    if (!catalogModule) throw new Error("Employees catalog module is missing");
    const first = generateSanityFormValues(catalogModule, 7, RUN_ID);
    const second = generateSanityFormValues(catalogModule, 7, RUN_ID);
    expect(first).toEqual(second);
    expect(first["employees.run-marker"]).toBe(`${RUN_ID}:employees:record-7`);
    expect(first["employees.sequence"]).toBe("7");
    expect(first["employees.amount"]).toBe("70.25");
    expect(["candidate", "active", "on-leave", "terminated"]).toContain(
      first["employees.status"],
    );
  });

  test("generates relationship assignments according to each cardinality", () => {
    const oneToOne = relationshipAssignments(
      {
        cardinality: "one-to-one",
        multipleTargets: false,
        multipleSources: false,
      },
      6,
      6,
    );
    expect(oneToOne).toHaveLength(6);
    expect(new Set(oneToOne.map((item) => item.sourceIndex)).size).toBe(6);
    expect(new Set(oneToOne.map((item) => item.targetIndex)).size).toBe(6);

    const manyToOne = relationshipAssignments(
      {
        cardinality: "many-to-one",
        multipleTargets: false,
        multipleSources: true,
      },
      6,
      2,
    );
    expect(manyToOne).toHaveLength(6);
    expect(new Set(manyToOne.map((item) => item.sourceIndex)).size).toBe(6);

    const oneToMany = relationshipAssignments(
      {
        cardinality: "one-to-many",
        multipleTargets: true,
        multipleSources: false,
      },
      6,
      6,
    );
    expect(oneToMany).toHaveLength(6);
    expect(new Set(oneToMany.map((item) => item.targetIndex)).size).toBe(6);
    expect(oneToMany.filter((item) => item.sourceIndex === 0)).toHaveLength(2);

    const manyToMany = relationshipAssignments(
      {
        cardinality: "many-to-many",
        multipleTargets: true,
        multipleSources: true,
      },
      6,
      6,
    );
    expect(manyToMany).toHaveLength(12);
    expect(new Set(manyToMany.map((item) => item.sourceIndex)).size).toBe(6);
  });

  test("sends mutations only to the exact API origin and rejects unsafe responses", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createLiveApiClient(
      "http://127.0.0.1:8000",
      LIVE_BEARER_TOKEN_SENTINEL,
      async (url, init) => {
        requests.push({ url, init });
        if (init?.method === "DELETE")
          return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    await client.post("/records", { data: {} });
    await client.put("/relationships/fields/f/sources/s", {
      target_record_id: "t",
    });
    await client.patch("/records/r", { data: {} });
    await client.delete("/records/r");
    expect(requests).toHaveLength(4);
    expect(requests.map((request) => request.init?.method)).toEqual([
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ]);
    for (const request of requests) {
      expect(new URL(request.url).origin).toBe("http://127.0.0.1:8000");
      expect(new URL(request.url).pathname).toMatch(/^\/api\//);
      expect(request.init?.redirect).toBe("error");
      expect(request.init?.credentials).toBe("omit");
      expect(new Headers(request.init?.headers).get("Authorization")).toBe(
        `Bearer ${LIVE_BEARER_TOKEN_SENTINEL}`,
      );
    }
    await expect(
      client.get("http://127.0.0.1:8001/api/auth/me"),
    ).rejects.toThrow(/validated origin/i);
    expect(requests).toHaveLength(4);

    const redirectClient = createLiveApiClient(
      "http://127.0.0.1:8000",
      undefined,
      async () => {
        const response = new Response(JSON.stringify({ ok: true }), {
          status: 200,
        });
        Object.defineProperty(response, "url", {
          value: "http://127.0.0.1:8001/api/records",
        });
        return response;
      },
    );
    await expect(redirectClient.post("/records", {})).rejects.toThrow(
      /redirected away/i,
    );

    const errorClient = createLiveApiClient(
      "http://127.0.0.1:8000",
      undefined,
      async () =>
        new Response(JSON.stringify({ detail: "password=do-not-leak" }), {
          status: 422,
        }),
    );
    await expect(errorClient.post("/records", {})).rejects.toThrow(
      "password=[REDACTED]",
    );
    await expect(errorClient.post("/records", {})).rejects.not.toThrow(
      "do-not-leak",
    );
  });

  test("seeds records for one catalog department without replacing UI records", async () => {
    const resultsRoot = await mkdtemp(
      join(tmpdir(), "openslate-department-records-"),
    );
    const runId = DEPARTMENT_RECORD_RUN_ID;
    try {
      await makeSchemaManifest(resultsRoot, runId);
      const maps = await reconstructSeedMaps(runId, resultsRoot);
      const department = departmentFor(maps, "operations");
      const requests: CapturedRequest[] = [];
      const recordIds = await seedRecordsForDepartment(
        department,
        departmentContext(
          createSeedApi(requests),
          runId,
          resultsRoot,
          maps.moduleIds,
          maps.primitiveFieldIdsByModule,
          maps.relationshipFieldIds,
          maps.uiRecordIdsByModule,
          maps.runtime.relationships,
        ),
        "standard",
      );

      expect([...recordIds.keys()]).toEqual(department.moduleKeys);
      const moduleIds = new Set<string>();
      let expectedRequestCount = 0;
      for (const catalogModule of department.modules) {
        const moduleId = maps.moduleIds.get(catalogModule.key);
        const uiRecordIds = maps.uiRecordIdsByModule.get(catalogModule.key);
        if (!moduleId || !uiRecordIds) {
          throw new Error(
            `Record seed prerequisites are missing: ${catalogModule.key}`,
          );
        }
        const target = targetRecordCount("standard", catalogModule.order);
        expect(recordIds.get(catalogModule.key)).toHaveLength(target);
        expect(recordIds.get(catalogModule.key)?.slice(0, 2)).toEqual(
          uiRecordIds,
        );
        moduleIds.add(moduleId);
        expectedRequestCount += target - 2;
      }
      expect(requests).toHaveLength(expectedRequestCount);
      expect(
        requests.every((request) =>
          moduleIds.has(stringValue(requestBody(request.init), "module_id")),
        ),
      ).toBe(true);

      const manifest = await readManifest(runId, resultsRoot);
      const bulkOperations = manifest.operations.filter((operation) =>
        operation.id.startsWith("bulk-record:"),
      );
      const expectedOperationIds = department.modules.flatMap((catalogModule) =>
        Array.from(
          {
            length: targetRecordCount("standard", catalogModule.order) - 2,
          },
          (_, index) => `bulk-record:${catalogModule.key}:${index + 3}`,
        ),
      );
      expect(bulkOperations.map((operation) => operation.id)).toEqual(
        expectedOperationIds,
      );
      expect(
        bulkOperations.every(
          (operation) =>
            operation.operation === "create_record" &&
            operation.entity_type === "record" &&
            operation.parent_id ===
              `module:${operation.id
                .slice("bulk-record:".length)
                .replace(/:\d+$/, "")}`,
        ),
      ).toBe(true);
    } finally {
      await rm(resultsRoot, { recursive: true, force: true });
    }
  });

  test("seeds only same-department relationships and skips an existing assignment", async () => {
    const resultsRoot = await mkdtemp(
      join(tmpdir(), "openslate-department-relationships-"),
    );
    const runId = DEPARTMENT_RELATIONSHIP_RUN_ID;
    try {
      await makeSchemaManifest(resultsRoot, runId);
      const maps = await reconstructSeedMaps(runId, resultsRoot);
      const department = departmentFor(maps, "human-resources");
      const departmentModuleKeys = new Set(department.moduleKeys);
      const relationships = maps.runtime.relationships.filter(
        (relationship) =>
          departmentModuleKeys.has(relationship.sourceModuleKey) &&
          departmentModuleKeys.has(relationship.targetModuleKey),
      );
      expect(relationships).toHaveLength(5);

      const recordIds = new Map<string, readonly string[]>();
      for (const catalogModule of department.modules) {
        const ids = maps.uiRecordIdsByModule.get(catalogModule.key);
        if (!ids)
          throw new Error(`UI record IDs are missing: ${catalogModule.key}`);
        recordIds.set(catalogModule.key, ids);
      }

      const duplicateFieldId = maps.relationshipFieldIds.get(
        "employee-training-programs",
      );
      const duplicateSourceIds = recordIds.get("employees");
      const duplicateTargetIds = recordIds.get("training-programs");
      const duplicateSourceId = duplicateSourceIds?.[0];
      const duplicateTargetId = duplicateTargetIds?.[0];
      if (!duplicateFieldId || !duplicateSourceId || !duplicateTargetId) {
        throw new Error("Duplicate relationship records are missing");
      }
      const existing = relationshipResponse(
        canonicalTestId("existing-employee-training-programs"),
        duplicateFieldId,
        duplicateSourceId,
        duplicateTargetId,
      );
      const existingByField = new Map<string, readonly LiveRelationship[]>([
        [duplicateFieldId, [existing]],
      ]);
      const requests: CapturedRequest[] = [];
      const created = await seedRelationshipsForDepartment(
        department,
        recordIds,
        departmentContext(
          createSeedApi(requests, existingByField),
          runId,
          resultsRoot,
          maps.moduleIds,
          maps.primitiveFieldIdsByModule,
          maps.relationshipFieldIds,
          maps.uiRecordIdsByModule,
          maps.runtime.relationships,
        ),
      );

      const expectedOperationIds = [
        "bulk-relationship:employee-primary-payroll-record:0",
        "bulk-relationship:employee-primary-payroll-record:1",
        "bulk-relationship:employee-job-position:0",
        "bulk-relationship:employee-job-position:1",
        "bulk-relationship:employee-manager:0",
        "bulk-relationship:employee-manager:1",
        "bulk-relationship:department-directory-employees:0",
        "bulk-relationship:department-directory-employees:1",
        "bulk-relationship:employee-training-programs:0",
        "bulk-relationship:employee-training-programs:1",
        "bulk-relationship:employee-training-programs:2",
      ];
      expect(created).toBe(expectedOperationIds.length);

      const discoveryFieldIds = requests
        .filter((request) => request.init?.method === "GET")
        .map((request) => new URL(request.url).searchParams.get("field_id"));
      expect(discoveryFieldIds).toEqual(
        relationships.map((relationship) =>
          maps.relationshipFieldIds.get(relationship.key),
        ),
      );
      const relationshipFieldIds = new Set(discoveryFieldIds);
      expect(
        requests.filter(
          (request) =>
            request.init?.method === "POST" || request.init?.method === "PUT",
        ),
      ).toHaveLength(created);
      expect(
        requests
          .filter(
            (request) =>
              request.init?.method === "POST" || request.init?.method === "PUT",
          )
          .every((request) => {
            const url = new URL(request.url);
            const fieldId =
              request.init?.method === "POST"
                ? requestBody(request.init).field_id
                : url.pathname.split("/")[4];
            return (
              typeof fieldId === "string" && relationshipFieldIds.has(fieldId)
            );
          }),
      ).toBe(true);

      const manifest = await readManifest(runId, resultsRoot);
      const bulkOperations = manifest.operations.filter((operation) =>
        operation.id.startsWith("bulk-relationship:"),
      );
      expect(bulkOperations.map((operation) => operation.id)).toEqual(
        expectedOperationIds,
      );
      expect(
        bulkOperations.every(
          (operation) =>
            operation.operation === "create_relationship_edge" &&
            operation.entity_type === "relationship" &&
            operation.parent_id ===
              `field:${operation.id
                .slice("bulk-relationship:".length)
                .replace(/:\d+$/, "")}`,
        ),
      ).toBe(true);
    } finally {
      await rm(resultsRoot, { recursive: true, force: true });
    }
  });

  test("reconstructs exact schema, UI record, and relationship maps from operation IDs", async () => {
    const resultsRoot = await mkdtemp(join(tmpdir(), "openslate-seed-maps-"));
    const runId = MAPS_RUN_ID;
    try {
      await makeSchemaManifest(resultsRoot, runId);
      const maps = await reconstructSeedMaps(runId, resultsRoot);
      expect(maps.departmentIds.size).toBe(12);
      expect(maps.moduleIds.size).toBe(57);
      expect(maps.fieldIds.size).toBe(342 + 13);
      expect(maps.uiRecordIdsByModule.get("employees")).toEqual([
        canonicalTestId("r-employees-1"),
        canonicalTestId("r-employees-2"),
      ]);
      expect(maps.relationshipFieldIds.get("project-tasks")).toBe(
        canonicalTestId("f-project-tasks"),
      );
      expect(maps.uiRelationshipIds.get("project-tasks")).toBe(
        canonicalTestId("e-project-tasks"),
      );
    } finally {
      await rm(resultsRoot, { recursive: true, force: true });
    }
  });

  test("writes a sanitized report without claiming integrity results", async () => {
    const resultsRoot = await mkdtemp(join(tmpdir(), "openslate-seed-report-"));
    const runId = REPORT_RUN_ID;
    try {
      await createManifest(runId, runtimeNamespaceForRunId(runId), resultsRoot);
      await updateManifest(
        runId,
        (manifest) => ({
          ...manifest,
          operations: [
            operation("department:one", null, "department", "department-id"),
            operation("module:one", "department:one", "module", "module-id"),
            operation("record:one", "module:one", "record", "record-id"),
          ],
        }),
        resultsRoot,
      );
      const reportPath = await writeLiveReport(
        runId,
        {
          assertions: [
            {
              id: "seed",
              name: "Seed | check",
              status: "Pass",
              detail: "Bearer secret and password=secret stay private",
            },
          ],
        },
        resultsRoot,
      );
      const report = await readFile(reportPath, "utf8");
      expect(report).toContain("Integrity suite status: **Not Testable**");
      expect(report).toMatch(/integrity suite not yet run/i);
      expect(report).toMatch(/Seed\s+check/);
      expect(report).not.toContain("Bearer secret");
      expect(report).not.toContain("password=secret");
      expect(report).toContain("| record | 1 |");
    } finally {
      await rm(resultsRoot, { recursive: true, force: true });
    }
  });

  test("merges persisted integrity evidence into the later teardown report", async () => {
    const resultsRoot = await mkdtemp(
      join(tmpdir(), "openslate-report-state-"),
    );
    const runId = STATE_RUN_ID;
    const integritySummary: LiveIntegritySummary = {
      scale: "standard",
      catalog: {
        departments: 12,
        modules: 57,
        primitiveFields: 342,
        relationshipFields: 13,
        acceptedSchemas: 57,
        expectedRecords: 1140,
        observedRecords: 1140,
      },
      cardinality: [
        {
          cardinality: "many-to-many",
          fields: 1,
          activeEdges: 40,
          representativeFields: 1,
        },
      ],
      apiNegatives: [
        {
          check: "duplicate password=secret rejection",
          status: 409,
          path: "https://127.0.0.1:8000/api/relationships?token=secret",
        },
      ],
      audit: { uiRows: 2, filteredLogs: 3, detailLogs: 1 },
    };
    try {
      await createManifest(runId, runtimeNamespaceForRunId(runId), resultsRoot);
      await writeLiveReport(
        runId,
        {
          recordTargetIncludesUiSanityRecords: true,
          integritySummary,
          assertions: [
            {
              id: "integrity-suite",
              name: "Integrity suite",
              status: "Pass",
              detail: "Integrity evidence is available",
            },
          ],
        },
        resultsRoot,
      );
      const reportPath = await writeLiveReport(
        runId,
        {
          teardownSummary: {
            domainRowsRemoved: 57,
            auditLogsRetained: true,
            auditLogCount: 57,
          },
        },
        resultsRoot,
      );
      const report = await readFile(reportPath, "utf8");
      expect(report).toContain("## Integrity evidence");
      expect(report).toContain("## Teardown outcome");
      expect(report).toContain(
        "Record targets include the two UI sanity records",
      );
      expect(report).toContain("many-to-many");
      expect(report).toContain("Domain rows removed: 57");
      expect(report).not.toContain("password=secret");
      expect(report).not.toContain("token=secret");

      const state = await readFile(
        join(resultsRoot, runId, "report-state.json"),
        "utf8",
      );
      expect(state).toContain('"integritySummary"');
      expect(state).toContain('"teardownSummary"');
      expect(state).not.toContain("password=secret");
      expect(state).not.toContain("token=secret");

      await writeFile(
        join(resultsRoot, runId, "report-state.json"),
        `${JSON.stringify({
          version: 1,
          run_id: runId,
          fullRecord: { id: "must-not-persist" },
        })}\n`,
        "utf8",
      );
      await expect(writeLiveReport(runId, {}, resultsRoot)).rejects.toThrow(
        /report state has an invalid shape/i,
      );
    } finally {
      await rm(resultsRoot, { recursive: true, force: true });
    }
  });
});
