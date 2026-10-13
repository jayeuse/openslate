import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  archiveOpenViewReport,
  createOpenViewReport,
  createOpenViewReportRun,
  downloadOpenViewReportRunCsv,
  getOpenViewReport,
  getOpenViewReportConflict,
  getOpenViewReportRun,
  listOpenViewReports,
  listOpenViewReportRuns,
  listOpenViewSharedReportRuns,
  previewReportPurge,
  purgeReport,
  restoreOpenViewReport,
  updateOpenViewReport,
  type OpenViewReport,
} from "../../../src/components/systems/openview/adapters/reports-api";
import { wirePagination } from "../../helpers/pagination";

const moduleId = "00000000-0000-4000-8000-000000000101";
const textFieldId = "00000000-0000-4000-8000-000000000102";
const statusFieldId = "00000000-0000-4000-8000-000000000103";
const amountFieldId = "00000000-0000-4000-8000-000000000104";
const reportId = "00000000-0000-4000-8000-000000000106";
const runId = "00000000-0000-4000-8000-000000000107";
const idempotencyKey = "00000000-0000-4000-8000-000000000108";
const otherReportId = "00000000-0000-4000-8000-000000000109";
const timestamp = "2026-09-23T00:00:00Z";

type CapturedRequest = { input: RequestInfo | URL; init?: RequestInit };

function installFetch(
  responder: (input: RequestInfo | URL, init?: RequestInit) => Response,
) {
  const original = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return Promise.resolve(responder(input, init));
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const recipe = {
  version: 1 as const,
  fields: [
    { fieldId: textFieldId, expectedType: "text" as const },
    { fieldId: statusFieldId, expectedType: "select" as const },
  ],
  filters: [
    {
      fieldId: statusFieldId,
      expectedType: "select" as const,
      operator: "in" as const,
      value: ["active", "pending"],
    },
  ],
  logic: "or" as const,
  sorts: [
    {
      fieldId: amountFieldId,
      expectedType: "number" as const,
      direction: "desc" as const,
    },
  ],
  groupBy: { fieldId: statusFieldId, expectedType: "select" as const },
  includeRowCount: true,
};

const wireRecipe = {
  version: 1,
  fields: [
    { field_id: textFieldId, expected_type: "text" },
    { field_id: statusFieldId, expected_type: "select" },
  ],
  filters: [
    {
      field_id: statusFieldId,
      expected_type: "select",
      operator: "in",
      value: ["active", "pending"],
    },
  ],
  logic: "or",
  sorts: [
    {
      field_id: amountFieldId,
      expected_type: "number",
      direction: "desc",
    },
  ],
  group_by: { field_id: statusFieldId, expected_type: "select" },
  include_row_count: true,
};

function reportResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: reportId,
    module_id: moduleId,
    name: "Active work",
    subtitle: "Current operational records",
    revision: 4,
    recipe: wireRecipe,
    is_deleted: false,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

const pagination = wirePagination({ limit: 25, count: 1, total: 1 });

function expectedReport(): OpenViewReport {
  return {
    id: reportId,
    moduleId,
    name: "Active work",
    subtitle: "Current operational records",
    revision: 4,
    recipe,
    isDeleted: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test("lists and reads department Reports with strict recipe mapping", async () => {
  const mock = installFetch((input) =>
    String(input).includes("?")
      ? jsonResponse({ items: [reportResponse()], pagination })
      : jsonResponse(reportResponse()),
  );
  try {
    const listed = await listOpenViewReports({
      moduleId,
      search: "  active work ",
      sortBy: "updated_at",
      sortOrder: "desc",
      deleted: "include",
    });
    expect(listed.items).toEqual([expectedReport()]);
    expect(listed.pagination).toEqual({
      limit: 25,
      offset: 0,
      count: 1,
      total: 1,
      hasMore: false,
    });
    expect(String(mock.requests[0]?.input)).toBe(
      "/api/reports?module_id=00000000-0000-4000-8000-000000000101&limit=25&offset=0&sort_by=updated_at&sort_order=desc&search=active+work&deleted=include",
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");

    await expect(getOpenViewReport(reportId)).resolves.toEqual(
      expectedReport(),
    );
    expect(String(mock.requests[1]?.input)).toBe(`/api/reports/${reportId}`);
    expect(mock.requests[1]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("creates and updates revisioned recipe metadata using the report wire DTO", async () => {
  const responses = [
    reportResponse(),
    reportResponse({ name: "Active work v2", subtitle: null, revision: 5 }),
  ];
  const mock = installFetch((_input, init) =>
    jsonResponse(responses.shift(), init?.method === "POST" ? 201 : 200),
  );
  try {
    await expect(
      createOpenViewReport({
        moduleId,
        name: "Active work",
        subtitle: "Current operational records",
        recipe,
      }),
    ).resolves.toEqual(expectedReport());
    expect(String(mock.requests[0]?.input)).toBe("/api/reports");
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      module_id: moduleId,
      name: "Active work",
      subtitle: "Current operational records",
      recipe: wireRecipe,
    });

    await expect(
      updateOpenViewReport({
        id: reportId,
        revision: 4,
        name: "Active work v2",
        subtitle: null,
      }),
    ).resolves.toMatchObject({
      id: reportId,
      name: "Active work v2",
      subtitle: null,
      revision: 5,
    });
    expect(String(mock.requests[1]?.input)).toBe(`/api/reports/${reportId}`);
    expect(mock.requests[1]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(mock.requests[1]?.init?.body))).toEqual({
      revision: 4,
      name: "Active work v2",
      subtitle: null,
    });
  } finally {
    mock.restore();
  }
});

test("creates and updates Reports without owner or audience fields", async () => {
  const mock = installFetch((_input, init) =>
    jsonResponse(reportResponse(), init?.method === "POST" ? 201 : 200),
  );
  try {
    await expect(
      createOpenViewReport({ moduleId, name: "Active work", recipe }),
    ).resolves.toEqual(expectedReport());
    const created = JSON.parse(String(mock.requests[0]?.init?.body));
    expect(Object.keys(created).sort()).toEqual([
      "module_id",
      "name",
      "recipe",
    ]);

    await updateOpenViewReport({ id: reportId, revision: 4, name: "Renamed" });
    expect(JSON.parse(String(mock.requests[1]?.init?.body))).toEqual({
      revision: 4,
      name: "Renamed",
    });

    await expect(
      createOpenViewReport({
        moduleId,
        name: "Audience is gone",
        recipe,
        audience: { kind: "everyone" },
      } as unknown as Parameters<typeof createOpenViewReport>[0]),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(2);
  } finally {
    mock.restore();
  }
});

test("rejects malformed IDs, revisions, and recipe values before sending", async () => {
  const mock = installFetch(() => jsonResponse(reportResponse()));
  try {
    await expect(getOpenViewReport("report-1")).rejects.toThrow();
    await expect(
      updateOpenViewReport({ id: reportId, revision: 0, name: "Renamed" }),
    ).rejects.toThrow();
    await expect(
      createOpenViewReport({
        moduleId,
        name: "   ",
        recipe,
      }),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("starts and retries an idempotent manual run with its UUID key in a header", async () => {
  const runResponse = {
    id: runId,
    report_id: reportId,
    recipe_revision: 4,
    row_count: 2,
    headings: ["Record name", "Status"],
    created_at: timestamp,
  };
  let requestCount = 0;
  const mock = installFetch(() => {
    requestCount += 1;
    return jsonResponse(
      requestCount === 3
        ? { ...runResponse, report_id: otherReportId }
        : runResponse,
      201,
    );
  });
  try {
    const expectedRun = {
      id: runId,
      reportId,
      recipeRevision: 4,
      rowCount: 2,
      headings: ["Record name", "Status"],
      createdAt: timestamp,
    };
    await expect(
      createOpenViewReportRun({ reportId, idempotencyKey }),
    ).resolves.toEqual(expectedRun);
    await expect(
      createOpenViewReportRun({ reportId, idempotencyKey }),
    ).resolves.toEqual(expectedRun);
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/reports/${reportId}/runs`,
    );
    expect(
      mock.requests
        .slice(0, 2)
        .map(({ init }) => new Headers(init?.headers).get("Idempotency-Key")),
    ).toEqual([idempotencyKey, idempotencyKey]);
    expect(mock.requests[0]?.init?.method).toBe("POST");
    expect(mock.requests[0]?.init?.body).toBeUndefined();

    await expect(
      createOpenViewReportRun({ reportId, idempotencyKey }),
    ).rejects.toBeInstanceOf(ApiContractError);
    await expect(
      createOpenViewReportRun({ reportId, idempotencyKey: "not-a-uuid" }),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(3);
  } finally {
    mock.restore();
  }
});

test("lists bounded retained runs only for the requested Report", async () => {
  const run = {
    id: runId,
    report_id: reportId,
    recipe_revision: 4,
    row_count: 2,
    headings: ["Record name"],
    created_at: timestamp,
  };
  let requestCount = 0;
  const mock = installFetch(() => {
    requestCount += 1;
    return jsonResponse({
      items: [requestCount === 1 ? run : { ...run, report_id: otherReportId }],
      pagination,
    });
  });
  try {
    await expect(
      listOpenViewReportRuns(reportId, { limit: 25, offset: 0 }),
    ).resolves.toMatchObject({
      items: [{ id: runId, reportId, rowCount: 2 }],
      pagination: { total: 1, hasMore: false },
    });
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/reports/${reportId}/runs?limit=25&offset=0`,
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
    await expect(listOpenViewReportRuns(reportId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
});

test("discovers only bounded, metadata-only shared Report runs", async () => {
  const sharedRun = {
    id: runId,
    report_id: reportId,
    report_name: "Shared review",
    recipe_revision: 4,
    row_count: 2,
    headings: ["Record name"],
    created_at: timestamp,
    status: "succeeded",
  };
  let invalid = false;
  const mock = installFetch(() =>
    jsonResponse({
      items: [invalid ? { ...sharedRun, recipe: wireRecipe } : sharedRun],
      pagination,
    }),
  );
  try {
    await expect(listOpenViewSharedReportRuns()).resolves.toEqual({
      items: [
        {
          id: runId,
          reportId,
          reportName: "Shared review",
          recipeRevision: 4,
          rowCount: 2,
          headings: ["Record name"],
          createdAt: timestamp,
          status: "succeeded",
        },
      ],
      pagination: {
        limit: 25,
        offset: 0,
        count: 1,
        total: 1,
        hasMore: false,
      },
    });
    expect(String(mock.requests[0]?.input)).toBe(
      "/api/reports/shared-runs?limit=25&offset=0",
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
    invalid = true;
    await expect(listOpenViewSharedReportRuns()).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
});

test("archives and restores a revisioned private Report", async () => {
  const mock = installFetch((_input, init) =>
    init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : jsonResponse(reportResponse({ revision: 5, is_deleted: false })),
  );
  try {
    await expect(
      archiveOpenViewReport({ id: reportId, revision: 4 }),
    ).resolves.toBeUndefined();
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/reports/${reportId}?revision=4`,
    );
    expect(mock.requests[0]?.init?.method).toBe("DELETE");
    await expect(
      restoreOpenViewReport({ id: reportId, revision: 4 }),
    ).resolves.toMatchObject({ id: reportId, revision: 5, isDeleted: false });
    expect(String(mock.requests[1]?.input)).toBe(
      `/api/reports/${reportId}/restore`,
    );
    expect(mock.requests[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(mock.requests[1]?.init?.body))).toEqual({
      revision: 4,
    });
  } finally {
    mock.restore();
  }
});

test("reads only a run belonging to the requested Report and exposes safe conflicts", async () => {
  const runResponse = {
    id: runId,
    report_id: reportId,
    recipe_revision: 4,
    row_count: 0,
    headings: ["Record name"],
    created_at: timestamp,
  };
  let runRequestCount = 0;
  const mock = installFetch((input) => {
    if (String(input) === `/api/reports/${reportId}`) {
      return jsonResponse(reportResponse());
    }
    runRequestCount += 1;
    return jsonResponse(
      runRequestCount === 1
        ? runResponse
        : { ...runResponse, report_id: otherReportId },
    );
  });
  try {
    await expect(getOpenViewReportRun(reportId, runId)).resolves.toMatchObject({
      id: runId,
      reportId,
      rowCount: 0,
    });
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/reports/${reportId}/runs/${runId}`,
    );
    await expect(getOpenViewReportRun(reportId, runId)).rejects.toBeInstanceOf(
      ApiContractError,
    );

    const conflict = new ApiError(409, "Report changed", {
      code: "stale_revision",
      message: "Report changed; reload before saving",
      current_revision: 5,
    });
    expect(getOpenViewReportConflict(conflict)).toEqual({
      code: "stale_revision",
      message: "Report changed; reload before saving",
      currentRevision: 5,
    });
    expect(
      getOpenViewReportConflict(new ApiError(409, "other", {})),
    ).toBeNull();
  } finally {
    mock.restore();
  }
});

test("does not expose a private server message from a stale Report conflict", () => {
  const conflict = new ApiError(409, "private internal server detail", {
    code: "stale_revision",
    message: "private internal server detail",
    current_revision: 5,
  });

  expect(getOpenViewReportConflict(conflict)).toEqual({
    code: "stale_revision",
    message: "Report changed; reload before saving",
    currentRevision: 5,
  });
});

test("JSON Report methods do not expose server error text or details", async () => {
  const calls = [
    () => listOpenViewReports(),
    () => listOpenViewReportRuns(reportId),
    () => getOpenViewReport(reportId),
    () => createOpenViewReport({ moduleId, name: "Active work", recipe }),
    () => updateOpenViewReport({ id: reportId, revision: 4, name: "Updated" }),
    () => createOpenViewReportRun({ reportId, idempotencyKey }),
    () => getOpenViewReportRun(reportId, runId),
    () => archiveOpenViewReport({ id: reportId, revision: 4 }),
    () => restoreOpenViewReport({ id: reportId, revision: 4 }),
  ];
  const conflictMock = installFetch(() =>
    jsonResponse(
      {
        detail: {
          code: "stale_revision",
          message: "private internal server detail",
          current_revision: 5,
          internal_value: "private metadata",
        },
      },
      409,
    ),
  );
  try {
    for (const call of calls) {
      const error = await call().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(409);
      expect((error as Error).message).toBe(
        "Report changed; reload before saving",
      );
      expect((error as ApiError).details).toEqual({
        code: "stale_revision",
        message: "Report changed; reload before saving",
        current_revision: 5,
      });
      expect(getOpenViewReportConflict(error)?.currentRevision).toBe(5);
    }
  } finally {
    conflictMock.restore();
  }

  const unknownMock = installFetch(() =>
    jsonResponse({ detail: "private proxy detail" }, 500),
  );
  try {
    const error = await getOpenViewReport(reportId).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
    expect((error as Error).message).toBe("Request could not be completed");
    expect((error as ApiError).details).toBeUndefined();
  } finally {
    unknownMock.restore();
  }
});

test("downloads immutable CSV bytes with a validated safe filename", async () => {
  const bytes = new Uint8Array([
    0xef, 0xbb, 0xbf, 0x41, 0x2c, 0x42, 0x0d, 0x0a,
  ]);
  let requestCount = 0;
  const mock = installFetch(() => {
    requestCount += 1;
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition":
          requestCount === 1
            ? `attachment; filename="report-${runId}.csv"`
            : 'attachment; filename="../../private.csv"',
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  try {
    const download = await downloadOpenViewReportRunCsv(reportId, runId);
    expect(download.filename).toBe(`report-${runId}.csv`);
    expect(download.blob.type).toBe("text/csv;charset=utf-8");
    expect(
      Array.from(new Uint8Array(await download.blob.arrayBuffer())),
    ).toEqual(Array.from(bytes));
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/reports/${reportId}/runs/${runId}/csv`,
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
    await expect(
      downloadOpenViewReportRunCsv(reportId, runId),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    mock.restore();
  }
});

test("does not expose malformed wire responses or unsafe CSV error bodies", async () => {
  const malformed = installFetch(() =>
    jsonResponse({ ...reportResponse(), unexpected: "private" }),
  );
  try {
    await expect(getOpenViewReport(reportId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    malformed.restore();
  }

  // A stored owner or audience is no longer part of the contract.
  const staleShape = installFetch(() =>
    jsonResponse(
      reportResponse({
        owner_id: reportId,
        audience: { kind: "private", user_id: null },
      }),
    ),
  );
  try {
    await expect(getOpenViewReport(reportId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    staleShape.restore();
  }

  const conflictMock = installFetch(() =>
    jsonResponse(
      {
        detail: {
          code: "stale_revision",
          message: "private message from an unexpected server",
          current_revision: 5,
          internal_value: "private server detail",
        },
      },
      409,
    ),
  );
  try {
    const conflict = await downloadOpenViewReportRunCsv(reportId, runId).catch(
      (reason: unknown) => reason,
    );
    expect(conflict).toBeInstanceOf(ApiError);
    expect(getOpenViewReportConflict(conflict)).toEqual({
      code: "stale_revision",
      message: "Report changed; reload before saving",
      currentRevision: 5,
    });
    expect((conflict as ApiError).details).not.toHaveProperty("internal_value");
  } finally {
    conflictMock.restore();
  }

  const unsafeDetail = installFetch(() =>
    jsonResponse({ detail: "private proxy detail" }, 502),
  );
  try {
    const error = await downloadOpenViewReportRunCsv(reportId, runId).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).toBe("Request could not be completed");
    expect((error as Error).message).not.toContain("private proxy detail");
  } finally {
    unsafeDetail.restore();
  }

  const failedCsv = installFetch(
    () =>
      new Response("<html>internal proxy secret</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
  );
  try {
    const error = await downloadOpenViewReportRunCsv(reportId, runId).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).toBe("Request could not be completed");
    expect((error as Error).message).not.toContain("internal proxy secret");
  } finally {
    failedCsv.restore();
  }
});

const purgeImpact = {
  target_type: "report",
  target_id: reportId,
  operation: "purge",
  actor_id: null,
  rows: [],
  external_impacts: [],
  key_strips: [],
  blockers: [],
  impact_digest: "a".repeat(64),
};
const purgePreview = {
  impact: purgeImpact,
  token: "synthetic-report-challenge",
  expires_at: timestamp,
  confirmation_name: "Finance report ".repeat(15).trim(),
  last_successful_backup_at: timestamp,
};

test("Report purge carries a guarded exact-name challenge and refuses mismatched impact", async () => {
  const responses = [
    jsonResponse(purgePreview),
    jsonResponse({ impact: purgeImpact, operation_id: null }),
    jsonResponse({
      ...purgePreview,
      impact: { ...purgeImpact, target_type: "record" },
    }),
  ];
  const mock = installFetch(() => responses.shift()!);
  try {
    await expect(previewReportPurge(reportId)).resolves.toEqual(purgePreview);
    await expect(
      purgeReport(reportId, {
        token: purgePreview.token,
        confirmationName: purgePreview.confirmation_name,
        password: "synthetic-passphrase",
      }),
    ).resolves.toEqual({ impact: purgeImpact, operation_id: null });
    expect(
      mock.requests
        .slice(0, 2)
        .map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      [`/api/reports/${reportId}/purge/preview`, "POST"],
      [`/api/reports/${reportId}/purge`, "POST"],
    ]);
    expect(JSON.parse(String(mock.requests[1]?.init?.body))).toEqual({
      token: purgePreview.token,
      confirmation_name: purgePreview.confirmation_name,
      password: "synthetic-passphrase",
    });
    await expect(previewReportPurge(reportId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
});
