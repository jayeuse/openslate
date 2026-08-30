import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { createLiveApiClient } from "./support/api";
import {
  LIVE_CATALOG,
  LIVE_RELATIONSHIPS,
  catalogCardinality,
  createRuntimeCatalog,
  relationshipCardinality,
  validateSameDepartmentRelationships,
  validateCatalog,
} from "./support/catalog";
import {
  appendOperation,
  beginOperation,
  createManifest,
  finalizeOperation,
  readManifest,
  updateOperationStatus,
} from "./support/manifest";
import {
  acquireLiveLock,
  assertNoRedirect,
  getLiveEnvironment,
  validatePublishableKeyEnvName,
  validateRequiredEnv,
  validateLoopbackHttpOrigin,
  validateRunId,
  createRunId,
  getLiveSeedEnvironment,
  runtimeNamespaceForRunId,
} from "./support/preflight";
import { sanitizeEvidence } from "./support/sanitize";

test.describe("live stress foundation", () => {
  const RUN_ID = "run-20260830-001-00000000000000000000000000000001";
  const MANIFEST_RUN_ID = "run-20260830-002-00000000000000000000000000000002";
  const LOCK_RUN_ONE = "run-20260830-003-00000000000000000000000000000003";
  const LOCK_RUN_TWO = "run-20260830-004-00000000000000000000000000000004";
  const NAMESPACE = "live-foundation";
  test("disables credential-copy prompts in the live harness", () => {
    expect(process.env.PLAYWRIGHT_NO_COPY_PROMPT).toBe("1");
  });

  test("accepts only numeric loopback HTTP origins without redirect inputs", () => {
    expect(validateLoopbackHttpOrigin("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000",
    );
    expect(() => validateLoopbackHttpOrigin("http://localhost:3000")).toThrow();
    expect(() =>
      validateLoopbackHttpOrigin("https://127.0.0.1:3000"),
    ).toThrow();
    expect(() =>
      validateLoopbackHttpOrigin("http://user:password@127.0.0.1:3000"),
    ).toThrow();
    expect(() =>
      validateLoopbackHttpOrigin("http://127.0.0.1:3000?next=/workspace"),
    ).toThrow();
    expect(() =>
      validateLoopbackHttpOrigin("http://127.0.0.1:3000#fragment"),
    ).toThrow();
    expect(() =>
      validateLoopbackHttpOrigin("http://127.0.0.1:3000/login"),
    ).toThrow();
    expect(() =>
      assertNoRedirect(
        "http://127.0.0.1:3001/workspace",
        "http://127.0.0.1:3000",
      ),
    ).toThrow();
  });

  test("validates strict run IDs", () => {
    expect(validateRunId(RUN_ID)).toBe(RUN_ID);
    expect(runtimeNamespaceForRunId(RUN_ID)).toBe(
      "live-000000000000000000000001",
    );
    expect(createRunId(new Date("2026-08-30T12:34:56.000Z"))).toMatch(
      /^run-.*-[0-9a-f]{32}$/,
    );
    expect(() => validateRunId("../outside")).toThrow();
    expect(() => validateRunId("run with spaces")).toThrow();
    expect(() => validateRunId(".")).toThrow();
    expect(() => validateRunId("a".repeat(65))).toThrow();
    expect(() => validateRunId("run-20260830-001")).toThrow(/128-bit/i);
  });

  test("validates required environment names without exposing their values", () => {
    expect(() =>
      validateRequiredEnv({ LIVE_ADMIN_PASSWORD: "do-not-print" }, [
        "LIVE_API_BASE_URL",
        "LIVE_ADMIN_PASSWORD",
      ]),
    ).toThrow("LIVE_API_BASE_URL");
    expect(() =>
      validateRequiredEnv({ LIVE_API_BASE_URL: "http://127.0.0.1:8000" }, [
        "LIVE_API_BASE_URL",
        "LIVE_ADMIN_PASSWORD",
      ]),
    ).toThrow("LIVE_ADMIN_PASSWORD");
  });

  test("requires numeric loopback API and Supabase origins plus the public key name", () => {
    const environment = {
      LIVE_API_BASE_URL: "http://127.0.0.1:8000",
      LIVE_BASE_URL: "http://127.0.0.1:3000",
      BACKEND_URL: "http://127.0.0.1:8000",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      LIVE_ADMIN_EMAIL: "admin@example.com",
      LIVE_ADMIN_PASSWORD: "not-a-real-password",
    };
    expect(getLiveEnvironment(environment)).toMatchObject({
      apiOrigin: "http://127.0.0.1:8000",
      supabaseUrl: "http://127.0.0.1:54321",
      supabasePublishableKey: "sb_publishable_test",
    });
    const seedEnvironment = getLiveSeedEnvironment({
      ...environment,
      LIVE_RUN_ID: RUN_ID,
    });
    expect(seedEnvironment.namespace).toBe(runtimeNamespaceForRunId(RUN_ID));
    expect(seedEnvironment.runId).toBe(RUN_ID);
    expect(() =>
      getLiveEnvironment({
        ...environment,
        NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      }),
    ).toThrow(/numeric loopback/i);
    expect(() =>
      getLiveEnvironment({
        ...environment,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "service_role_secret",
      }),
    ).toThrow(/publishable/i);
    expect(() =>
      getLiveEnvironment({
        ...environment,
        BACKEND_URL: "http://127.0.0.1:8001",
      }),
    ).toThrow(/BACKEND_URL.*LIVE_API_BASE_URL/i);
    expect(() => validatePublishableKeyEnvName("SUPABASE_SECRET_KEY")).toThrow(
      /publishable/i,
    );
  });

  test("keeps the catalog deterministic and cardinality-safe", () => {
    const first = createRuntimeCatalog(NAMESPACE);
    const second = createRuntimeCatalog(NAMESPACE);
    const expectedDepartments = [
      "Human Resources",
      "Finance",
      "Accounting",
      "Inventory",
      "Sales",
      "Procurement",
      "Legal",
      "IT",
      "Operations",
      "Marketing",
      "Customer Support",
      "Facilities",
    ];
    const expectedModules = [
      "Employees",
      "Job Positions",
      "Departments Directory",
      "Payroll Records",
      "Leave Requests",
      "Performance Reviews",
      "Training Programs",
      "Benefits Enrollment",
      "Budgets",
      "Cost Centers",
      "Financial Accounts",
      "Bank Reconciliations",
      "Investment Records",
      "Accounts Payable",
      "Accounts Receivable",
      "Expenses",
      "Transactions",
      "Journal Entries",
      "Tax Filings",
      "Inventory Catalog",
      "Stock Movements",
      "Suppliers",
      "Warehouses",
      "Purchase Orders",
      "Stock Adjustments",
      "Customers",
      "Sales Orders",
      "Quotes",
      "Payments",
      "Sales Territories",
      "Commission Records",
      "Vendors",
      "Purchase Requisitions",
      "Contracts",
      "Vendor Evaluations",
      "Contracts",
      "Compliance Cases",
      "Legal Documents",
      "Disputes",
      "Assets",
      "Software Licenses",
      "Support Tickets",
      "Incident Reports",
      "Projects",
      "Tasks",
      "Milestones",
      "Resource Allocations",
      "Campaigns",
      "Leads",
      "Marketing Assets",
      "Events",
      "Tickets",
      "Customer Feedback",
      "SLAs",
      "Locations",
      "Maintenance Requests",
      "Equipment",
    ];

    expect(first).toEqual(second);
    expect(
      LIVE_CATALOG.departments.map((department) => department.name),
    ).toEqual(expectedDepartments);
    expect(LIVE_CATALOG.modules.map((module) => module.name)).toEqual(
      expectedModules,
    );
    expect(catalogCardinality(LIVE_CATALOG)).toEqual({
      departments: 12,
      modules: 57,
      primitiveFields: 342,
      relationships: 13,
    });
    expect(LIVE_RELATIONSHIPS).toHaveLength(13);
    expect(relationshipCardinality(LIVE_CATALOG)).toEqual({
      "one-to-one": 3,
      "many-to-one": 4,
      "one-to-many": 3,
      "many-to-many": 3,
    });
    expect(first.departments.map((department) => department.order)).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
    expect(first.modules.map((module) => module.order)).toEqual(
      Array.from({ length: 57 }, (_, index) => index),
    );
    expect(
      first.modules.every((module) =>
        module.primitiveFields.every((field, index) => field.order === index),
      ),
    ).toBe(true);
    expect(
      first.modules.every((module) =>
        module.primitiveFields.some(
          (field) =>
            field.key === `${module.key}.run-marker` &&
            field.name.endsWith("(run marker)") &&
            field.type === "text" &&
            field.required,
        ),
      ),
    ).toBe(true);
    expect(
      first.modules.every(
        (module) =>
          module.primitiveFields
            .map((field) => field.type)
            .sort()
            .join(",") === "boolean,datetime,decimal,int,select,text",
      ),
    ).toBe(true);
    expect(validateSameDepartmentRelationships(LIVE_CATALOG)).toBe(true);
    expect(
      first.modules.every((module) => module.name.startsWith(`${NAMESPACE} `)),
    ).toBe(true);
    expect(
      LIVE_CATALOG.modules.find((module) => module.key === "employees"),
    ).toMatchObject({
      primitiveFields: expect.arrayContaining([
        expect.objectContaining({ name: "Employee ID", type: "int" }),
        expect.objectContaining({ name: "Salary", type: "decimal" }),
        expect.objectContaining({ name: "Current employee", type: "boolean" }),
        expect.objectContaining({ name: "Hire datetime", type: "datetime" }),
        expect.objectContaining({
          name: "Employment status",
          type: "select",
          config: {
            options: ["candidate", "active", "on-leave", "terminated"],
          },
        }),
      ]),
    });
    expect(
      LIVE_CATALOG.modules
        .filter((module) =>
          [
            "sales-orders",
            "customers",
            "inventory-catalog",
            "stock-movements",
            "projects",
            "tasks",
            "transactions",
            "expenses",
            "tickets",
            "purchase-orders",
          ].includes(module.key),
        )
        .every((module) => {
          const select = module.primitiveFields.find(
            (field) => field.type === "select",
          );
          return (
            select !== undefined && (select.config.options?.length ?? 0) >= 2
          );
        }),
    ).toBe(true);
    expect(
      LIVE_RELATIONSHIPS.find(
        (relationship) => relationship.key === "employee-manager",
      ),
    ).toMatchObject({
      name: "Manager",
      sourceModuleKey: "employees",
      targetModuleKey: "employees",
      multipleTargets: false,
      multipleSources: true,
    });
    expect(
      LIVE_RELATIONSHIPS.find(
        (relationship) => relationship.key === "budget-cost-center",
      ),
    ).toMatchObject({
      name: "Cost Center",
      sourceModuleKey: "budgets",
      targetModuleKey: "cost-centers",
      cardinality: "many-to-one",
      multipleTargets: false,
      multipleSources: true,
    });
    expect(
      LIVE_RELATIONSHIPS.some(
        (relationship) => relationship.sourceModuleKey === "expenses",
      ),
    ).toBe(false);

    const invalidCatalog = {
      ...LIVE_CATALOG,
      relationships: [
        ...LIVE_CATALOG.relationships,
        {
          ...LIVE_CATALOG.relationships[0],
          key: "invalid-cross-department",
          sourceModuleKey: "employees",
          targetModuleKey: "cost-centers",
        },
      ],
    };
    expect(() => validateSameDepartmentRelationships(invalidCatalog)).toThrow(
      /same department/i,
    );
    expect(() =>
      validateCatalog({
        ...LIVE_CATALOG,
        relationships: LIVE_CATALOG.relationships.slice(0, -1),
      }),
    ).toThrow(/exactly 13 relationships/i);
    expect(() =>
      validateCatalog({
        ...LIVE_CATALOG,
        relationships: [
          ...LIVE_CATALOG.relationships.slice(0, -1),
          LIVE_CATALOG.relationships[0],
        ],
      }),
    ).toThrow(/relationship keys must be unique/i);
  });

  test("atomically journals exact operation IDs, parent IDs, and statuses", async () => {
    const resultsRoot = await mkdtemp(
      join(tmpdir(), "openslate-live-manifest-"),
    );
    try {
      const runId = MANIFEST_RUN_ID;
      await createManifest(runId, runtimeNamespaceForRunId(runId), resultsRoot);
      await appendOperation(
        runId,
        {
          id: "department:employee",
          parent_id: null,
          operation: "create_department",
          entity_type: "department",
          entity_id: "33333333-3333-4333-8333-333333333333",
          status: "succeeded",
          evidence: [{ request: { password: "not-for-report" } }],
        },
        resultsRoot,
      );
      await appendOperation(
        runId,
        {
          id: "module:employee",
          parent_id: "department:employee",
          operation: "create_module",
          entity_type: "module",
          entity_id: "44444444-4444-4444-8444-444444444444",
          status: "planned",
          evidence: [],
        },
        resultsRoot,
      );
      await updateOperationStatus(
        runId,
        "module:employee",
        "succeeded",
        [{ response: { access_token: "not-for-report" } }],
        resultsRoot,
      );

      const manifest = await readManifest(runId, resultsRoot);
      expect(manifest.operations).toEqual([
        {
          id: "department:employee",
          parent_id: null,
          operation: "create_department",
          entity_type: "department",
          entity_id: "33333333-3333-4333-8333-333333333333",
          status: "succeeded",
          evidence: [{ request: { password: "[REDACTED]" } }],
        },
        {
          id: "module:employee",
          parent_id: "department:employee",
          operation: "create_module",
          entity_type: "module",
          entity_id: "44444444-4444-4444-8444-444444444444",
          status: "succeeded",
          evidence: [{ response: { access_token: "[REDACTED]" } }],
        },
      ]);
      expect(await readdir(join(resultsRoot, runId))).toEqual([
        "manifest.json",
      ]);
    } finally {
      await rm(resultsRoot, { recursive: true, force: true });
    }
  });

  test("requires a known entity ID before journaling schema acceptance", async () => {
    const resultsRoot = await mkdtemp(
      join(tmpdir(), "openslate-live-schema-journal-"),
    );
    const runId = "run-20260830-005-00000000000000000000000000000005";
    const departmentId = "33333333-3333-4333-8333-333333333333";
    const moduleId = "44444444-4444-4444-8444-444444444444";
    try {
      await createManifest(runId, runtimeNamespaceForRunId(runId), resultsRoot);
      await appendOperation(
        runId,
        {
          id: "department:employees",
          parent_id: null,
          operation: "create_department",
          entity_type: "department",
          entity_id: departmentId,
          status: "succeeded",
          evidence: [],
        },
        resultsRoot,
      );
      await appendOperation(
        runId,
        {
          id: "module:employees",
          parent_id: "department:employees",
          operation: "create_module",
          entity_type: "module",
          entity_id: moduleId,
          status: "succeeded",
          evidence: [],
        },
        resultsRoot,
      );

      await expect(
        beginOperation(
          runId,
          {
            id: "schema:employees:invalid",
            parent_id: "module:employees",
            operation: "accept_schema",
            entity_type: "module",
            evidence: [],
          },
          resultsRoot,
        ),
      ).rejects.toThrow(/entity ID must be canonical/i);

      await beginOperation(
        runId,
        {
          id: "schema:employees:accept",
          parent_id: "module:employees",
          operation: "accept_schema",
          entity_type: "module",
          entity_id: moduleId,
          evidence: [],
        },
        resultsRoot,
      );
      await finalizeOperation(
        runId,
        "schema:employees:accept",
        moduleId,
        [],
        resultsRoot,
      );
      expect(
        (await readManifest(runId, resultsRoot)).operations.find(
          (operation) => operation.id === "schema:employees:accept",
        ),
      ).toMatchObject({ entity_id: moduleId, status: "succeeded" });
    } finally {
      await rm(resultsRoot, { recursive: true, force: true });
    }
  });

  test("sanitizes nested evidence and URL credentials", () => {
    expect(
      sanitizeEvidence({
        authorization: "Bearer secret",
        nested: [{ refresh_token: "refresh-secret" }],
        url: "http://127.0.0.1:3000/api?access_token=secret#fragment",
        message: "password=secret",
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      nested: [{ refresh_token: "[REDACTED]" }],
      url: "http://127.0.0.1:3000/api",
      message: "password=[REDACTED]",
    });
  });

  test("follows the standard paginated list envelope", async () => {
    const requests: string[] = [];
    const client = createLiveApiClient(
      "http://127.0.0.1:3000",
      undefined,
      async (url) => {
        requests.push(url);
        const offset = new URL(url).searchParams.get("offset");
        const page = offset === "2" ? ["third"] : ["first", "second"];
        return new Response(
          JSON.stringify({
            items: page,
            pagination: {
              limit: 2,
              offset: Number(offset ?? 0),
              count: page.length,
              total: 3,
              has_more: offset !== "2",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );

    await expect(
      client.listAll<string>("/modules", { limit: 2 }),
    ).resolves.toEqual(["first", "second", "third"]);
    expect(requests).toEqual([
      "http://127.0.0.1:3000/api/modules?limit=2&offset=0",
      "http://127.0.0.1:3000/api/modules?limit=2&offset=2",
    ]);
  });

  test("creates an exclusive local lock and releases it safely", async () => {
    const resultsRoot = await mkdtemp(join(tmpdir(), "openslate-live-lock-"));
    try {
      const first = await acquireLiveLock(LOCK_RUN_ONE, resultsRoot);
      await expect(acquireLiveLock(LOCK_RUN_TWO, resultsRoot)).rejects.toThrow(
        /already running/i,
      );
      await first.release();
      const second = await acquireLiveLock(LOCK_RUN_TWO, resultsRoot);
      await second.release();
    } finally {
      await rm(resultsRoot, { recursive: true, force: true });
    }
  });
});
