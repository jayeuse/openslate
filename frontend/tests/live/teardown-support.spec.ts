import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  assertExactLifecycleImpact,
  lifecycleConfirmationPayload,
  type LifecycleRowsByEntity,
} from "./support/lifecycle";
import {
  actorBaselineFromUser,
  assertActorMatchesManifest,
  createActorOperation,
  createManifest,
  manifestOperationIdForEntity,
  manifestOwnedEntities,
  manifestRootOwnership,
  updateOperationStatus,
  type LiveManifest,
  type LiveOperation,
} from "./support/manifest";
import {
  getLiveTeardownEnvironment,
  runtimeNamespaceForRunId,
  teardownModeFromEnvironment,
  type EnvironmentValues,
} from "./support/preflight";
import {
  assertNoUnexpectedManifestEdges,
  assertMutationCanStart,
  verifyPurgeAudit,
} from "./teardown";
import { renderLiveReport, writeLiveReport } from "./support/report";
import {
  createLiveApiClient,
  type LiveAuditLog,
  type LiveRelationship,
  type LiveUser,
} from "./support/api";

const USER: LiveUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.com",
  username: "admin",
  status: "active",
  role_id: "22222222-2222-4222-8222-222222222222",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  deleted_at: null,
  is_deleted: false,
  performed_by: null,
};

const ROOT = "33333333-3333-4333-8333-333333333333";
const MODULE = "44444444-4444-4444-8444-444444444444";
const FIELD = "55555555-5555-4555-8555-555555555555";
const RECORD = "66666666-6666-4666-8666-666666666666";
const EDGE = "77777777-7777-4777-8777-777777777777";
const RUN_ID = "run-20260830-020-00000000000000000000000000000020";
const REPORT_RUN_ID = "run-20260830-021-00000000000000000000000000000021";
const AUDIT_REQUEST_ID = "88888888-8888-4888-8888-888888888888";

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
    entity_id: entityId,
    status: "succeeded",
    evidence: [],
  };
}

function manifestWithOwnership(): LiveManifest {
  return {
    version: 1,
    run_id: RUN_ID as LiveManifest["run_id"],
    namespace: runtimeNamespaceForRunId(RUN_ID),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    assertions: [],
    operations: [
      operation("department:root", null, "department", ROOT),
      operation("module:root", "department:root", "module", MODULE),
      operation("field:root", "module:root", "field", FIELD),
      operation("record:root", "module:root", "record", RECORD),
      operation("relationship:root", "field:root", "relationship", EDGE),
    ],
  };
}

function expectedRows(): LifecycleRowsByEntity {
  return {
    departments: [ROOT],
    modules: [MODULE],
    fields: [FIELD],
    records: [RECORD],
  };
}

function relationship(
  id: string,
  sourceRecordId = RECORD,
  targetRecordId = RECORD,
  fieldId = FIELD,
): LiveRelationship {
  return {
    id,
    field_id: fieldId,
    source_record_id: sourceRecordId,
    target_record_id: targetRecordId,
    visibility: "available",
    hidden_reasons: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  };
}

function environmentValues(
  overrides: Readonly<Record<string, string>> = {},
): EnvironmentValues {
  return {
    LIVE_API_BASE_URL: "http://127.0.0.1:8000",
    LIVE_BASE_URL: "http://127.0.0.1:3000",
    BACKEND_URL: "http://127.0.0.1:8000",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    LIVE_ADMIN_EMAIL: USER.email,
    LIVE_ADMIN_PASSWORD: "not-a-real-password",
    LIVE_RUN_ID: RUN_ID,
    LIVE_TEARDOWN: "domain-purge",
    LIFECYCLE_PURGE_ENABLED: "true",
    ...overrides,
  };
}

test.describe("manifest-owned teardown support", () => {
  test("builds lifecycle confirmation payloads and requires an exact safe preview", () => {
    const impact = {
      target_type: "department" as const,
      target_id: ROOT,
      operation: "purge" as const,
      actor_id: USER.id,
      rows: [
        ...expectedRows().departments.map((entity_id) => ({
          entity_type: "departments",
          entity_id,
          is_deleted: true,
          deleted_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          state_fingerprint: "fingerprint",
        })),
        ...expectedRows().modules.map((entity_id) => ({
          entity_type: "modules",
          entity_id,
          is_deleted: true,
          deleted_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          state_fingerprint: "fingerprint",
        })),
        ...expectedRows().fields.map((entity_id) => ({
          entity_type: "fields",
          entity_id,
          is_deleted: true,
          deleted_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          state_fingerprint: "fingerprint",
        })),
        ...expectedRows().records.map((entity_id) => ({
          entity_type: "records",
          entity_id,
          is_deleted: true,
          deleted_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          state_fingerprint: "fingerprint",
        })),
      ],
      external_impacts: [],
      key_strips: [],
      blockers: [],
      impact_digest: "digest",
    };

    expect(() =>
      assertExactLifecycleImpact(impact, {
        operation: "purge",
        targetType: "department",
        targetId: ROOT,
        actorId: USER.id,
        expectedRows: expectedRows(),
      }),
    ).not.toThrow();
    const preview = {
      impact,
      token: "opaque-token",
      expires_at: "2099-01-01T00:00:00.000Z",
      confirmation_name: "run Operations",
    };
    expect(lifecycleConfirmationPayload(preview, "password")).toEqual({
      token: "opaque-token",
      confirmation_name: "run Operations",
      password: "password",
    });
    expect(() =>
      assertExactLifecycleImpact(
        { ...impact, rows: impact.rows.slice(1) },
        {
          operation: "purge",
          targetType: "department",
          targetId: ROOT,
          actorId: USER.id,
          expectedRows: expectedRows(),
        },
      ),
    ).toThrow(/exact lifecycle rows/i);
    expect(() =>
      assertExactLifecycleImpact(
        {
          ...impact,
          external_impacts: [
            {
              edge_id: EDGE,
              field_id: FIELD,
              external_record_id: "88888888-8888-4888-8888-888888888888",
              external_module_id: MODULE,
              external_module_name: "external",
              external_department_id: ROOT,
              external_department_name: "external",
            },
          ],
        },
        {
          operation: "purge",
          targetType: "department",
          targetId: ROOT,
          actorId: USER.id,
          expectedRows: expectedRows(),
        },
      ),
    ).toThrow(/external impact/i);
  });

  test("derives manifest ownership and rejects an unexpected external edge", () => {
    const manifest = manifestWithOwnership();
    const owned = manifestOwnedEntities(manifest);
    const rootOwnership = manifestRootOwnership(manifest, "department:root");
    expect(owned.departments).toEqual(new Set([ROOT]));
    expect(rootOwnership.records).toEqual(new Set([RECORD]));
    expect(manifestOperationIdForEntity(manifest, "field", FIELD)).toBe(
      "field:root",
    );

    expect(() =>
      assertNoUnexpectedManifestEdges(
        [relationship(EDGE), relationship("unexpected", RECORD, "external")],
        rootOwnership,
      ),
    ).toThrow(/unexpected.*external|not represented/i);
    const integrityEdgeId = "88888888-8888-4888-8888-888888888888";
    const withOwnedIntegrityEdge: LiveManifest = {
      ...manifest,
      operations: [
        ...manifest.operations,
        {
          ...operation(
            "integrity:owned",
            "field:root",
            "relationship",
            integrityEdgeId,
          ),
          operation: "create_relationship_edge",
        },
        {
          ...operation(
            "integrity:external",
            "field:root",
            "relationship",
            "99999999-9999-4999-8999-999999999999",
          ),
          operation: "create_relationship_edge",
        },
      ],
    };
    const integrityOwnership = manifestRootOwnership(
      withOwnedIntegrityEdge,
      "department:root",
    );
    expect(manifestOwnedEntities(withOwnedIntegrityEdge).relationships).toEqual(
      new Set([EDGE, integrityEdgeId, "99999999-9999-4999-8999-999999999999"]),
    );
    expect(integrityOwnership.relationships).toContain(integrityEdgeId);
    expect(() =>
      assertNoUnexpectedManifestEdges(
        [relationship(integrityEdgeId)],
        integrityOwnership,
      ),
    ).not.toThrow();
    expect(() =>
      assertNoUnexpectedManifestEdges(
        [
          relationship(
            "99999999-9999-4999-8999-999999999999",
            RECORD,
            "external",
          ),
        ],
        integrityOwnership,
      ),
    ).toThrow(/unexpected.*external|not represented/i);
  });

  test("gates teardown mode and requires the purge flag without changing it", () => {
    expect(teardownModeFromEnvironment(environmentValues())).toBe(
      "domain-purge",
    );
    expect(() =>
      teardownModeFromEnvironment(
        environmentValues({ LIVE_TEARDOWN: "reset-all" }),
      ),
    ).toThrow(/LIVE_TEARDOWN/);
    expect(() =>
      getLiveTeardownEnvironment(
        environmentValues({ LIFECYCLE_PURGE_ENABLED: "false" }),
      ),
    ).toThrow(/already enabled|LIFECYCLE_PURGE_ENABLED/i);
  });

  test("preserves the manifest actor and refuses a changed identity", async () => {
    const baseline = actorBaselineFromUser(USER);
    const manifest = manifestWithOwnership();
    const withActor: LiveManifest = {
      ...manifest,
      operations: [createActorOperation(baseline), ...manifest.operations],
    };
    expect(() => assertActorMatchesManifest(withActor, USER)).not.toThrow();
    expect(() =>
      assertActorMatchesManifest(withActor, {
        ...USER,
        role_id: "88888888-8888-4888-8888-888888888888",
      }),
    ).toThrow(/actor|role/i);
    await expect(
      updateOperationStatus(
        withActor.run_id,
        "actor:admin",
        "failed",
        [],
        "test-results/live",
      ),
    ).rejects.toThrow(/immutable/i);
  });

  test("does not retry a completed or uncertain destructive operation", () => {
    const completed: LiveManifest = {
      ...manifestWithOwnership(),
      operations: [
        ...manifestWithOwnership().operations,
        {
          ...operation("purge:root", "department:root", "department", ROOT),
          operation: "purge_department",
        },
      ],
    };
    expect(assertMutationCanStart(completed, "purge:root")).toBe(false);
    expect(() =>
      assertMutationCanStart(
        {
          ...completed,
          operations: completed.operations.map((item) =>
            item.id === "purge:root" ? { ...item, status: "running" } : item,
          ),
        },
        "purge:root",
      ),
    ).toThrow(/uncertain|running/i);
  });

  test("requires exact request_id-bound audit evidence for every purged entity", async () => {
    const inventory = {
      department: {
        ...USER,
        id: ROOT,
        department_name: "department",
      },
      modules: [
        {
          ...USER,
          id: MODULE,
          department_id: ROOT,
          module_name: "module",
          is_schema_accepted: true,
        },
      ],
      fields: [
        {
          ...USER,
          id: FIELD,
          module_id: MODULE,
          name: "field",
          type: "text",
          required: true,
          position: 0,
          config: {},
          relationship_target_module_id: null,
          relationship_multiple_targets: null,
          relationship_multiple_sources: null,
        },
      ],
      records: [{ ...USER, id: RECORD, module_id: MODULE, data: {} }],
      relationships: [relationship(EDGE)],
    };
    const auditEntities = [
      ["departments", ROOT],
      ["modules", MODULE],
      ["fields", FIELD],
      ["records", RECORD],
      ["relationship_edges", EDGE],
    ] as const;
    let requestedUrl = "";
    let useWrongRequestId = false;
    let omitBefore = false;
    const api = createLiveApiClient(
      "http://127.0.0.1:8000",
      undefined,
      async (url) => {
        requestedUrl = url;
        const logs: LiveAuditLog[] = auditEntities.map(
          ([entity_type, entity_id], index) => {
            const log = {
              id: `99999999-9999-4999-8999-99999999999${index}`,
              created_at: "2026-01-01T00:00:00.000Z",
              performed_by: USER.id,
              action: "delete" as const,
              entity_type,
              entity_id,
              before: { entity_id },
              after: null,
              request_id: useWrongRequestId
                ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
                : AUDIT_REQUEST_ID,
              request_method: "POST",
              request_path: `/api/departments/${ROOT}/purge`,
              actor_label: null,
              note: null,
            };
            if (omitBefore) {
              return Object.fromEntries(
                Object.entries(log).filter(([key]) => key !== "before"),
              ) as LiveAuditLog;
            }
            return log;
          },
        );
        return new Response(
          JSON.stringify({
            items: logs,
            pagination: {
              limit: 100,
              offset: 0,
              count: logs.length,
              total: logs.length,
              has_more: false,
            },
          }),
          { status: 200 },
        );
      },
    );

    await expect(
      verifyPurgeAudit(
        api,
        {
          departmentId: inventory.department.id,
          moduleIds: inventory.modules.map((item) => item.id),
          fieldIds: inventory.fields.map((item) => item.id),
          recordIds: inventory.records.map((item) => item.id),
          relationshipIds: inventory.relationships.map((item) => item.id),
        },
        ROOT,
        AUDIT_REQUEST_ID,
        USER.id,
      ),
    ).resolves.toMatchObject({ requestId: AUDIT_REQUEST_ID });
    expect(new URL(requestedUrl).searchParams.get("request_id")).toBe(
      AUDIT_REQUEST_ID,
    );

    useWrongRequestId = true;
    await expect(
      verifyPurgeAudit(
        api,
        {
          departmentId: inventory.department.id,
          moduleIds: inventory.modules.map((item) => item.id),
          fieldIds: inventory.fields.map((item) => item.id),
          recordIds: inventory.records.map((item) => item.id),
          relationshipIds: inventory.relationships.map((item) => item.id),
        },
        ROOT,
        AUDIT_REQUEST_ID,
        USER.id,
      ),
    ).rejects.toThrow(/unexpected actor, path, action, or snapshot/i);

    omitBefore = true;
    await expect(
      verifyPurgeAudit(
        api,
        {
          departmentId: inventory.department.id,
          moduleIds: inventory.modules.map((item) => item.id),
          fieldIds: inventory.fields.map((item) => item.id),
          recordIds: inventory.records.map((item) => item.id),
          relationshipIds: inventory.relationships.map((item) => item.id),
        },
        ROOT,
        AUDIT_REQUEST_ID,
        USER.id,
      ),
    ).rejects.toThrow(/invalid list item/i);
  });

  test("atomically merges assertion results and uses explicit audit-retention wording", async () => {
    const resultsRoot = await mkdtemp(
      join(tmpdir(), "openslate-teardown-report-"),
    );
    const runId = REPORT_RUN_ID;
    try {
      await createManifest(runId, runtimeNamespaceForRunId(runId), resultsRoot);
      await writeLiveReport(
        runId,
        {
          assertions: [
            {
              id: "seed",
              name: "Seed",
              status: "Pass",
              detail: "Seed completed",
            },
          ],
        },
        resultsRoot,
      );
      await writeLiveReport(
        runId,
        {
          assertions: [
            {
              id: "teardown",
              name: "Domain teardown",
              status: "Pass",
              detail: "Domain rows removed; audit logs retained.",
            },
          ],
          teardownSummary: {
            domainRowsRemoved: 5,
            auditLogsRetained: true,
            auditLogCount: 5,
          },
        },
        resultsRoot,
      );
      const report = renderLiveReport(
        {
          version: 1,
          run_id: runId as LiveManifest["run_id"],
          namespace: runtimeNamespaceForRunId(runId),
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          assertions: [],
          operations: [],
        },
        {
          teardownSummary: {
            domainRowsRemoved: 5,
            auditLogsRetained: true,
            auditLogCount: 5,
          },
        },
      );
      const persisted = await readFile(
        join(resultsRoot, runId, "manifest.json"),
        "utf8",
      );
      expect(persisted).toContain('"id": "seed"');
      expect(persisted).toContain('"id": "teardown"');
      expect(report).toMatch(/domain rows removed/i);
      expect(report).toMatch(/audit logs retained/i);
      expect(report).toMatch(/not a full environment reset/i);
    } finally {
      await rm(resultsRoot, { recursive: true, force: true });
    }
  });
});
