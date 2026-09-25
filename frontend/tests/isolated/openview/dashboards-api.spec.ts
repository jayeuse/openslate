import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  archiveOpenViewDashboard,
  createOpenViewDashboard,
  getOpenViewDashboard,
  getOpenViewDashboardConflict,
  getOpenViewDashboardDefault,
  listOpenViewDashboards,
  restoreOpenViewDashboard,
  setOpenViewDashboardDefault,
  updateOpenViewDashboard,
  type OpenViewDashboardCreateInput,
  type OpenViewDashboard,
} from "../../../src/components/systems/openview/adapters/dashboards-api";

const moduleId = "00000000-0000-4000-8000-000000000001";
const dimensionId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const dashboardId = "00000000-0000-4000-8000-000000000004";
const widgetId = "00000000-0000-4000-8000-000000000005";
const dateFieldId = "00000000-0000-4000-8000-000000000006";
const measureId = "00000000-0000-4000-8000-000000000007";
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

const definition = {
  version: 1 as const,
  logic: "or" as const,
  columns: [{ fieldId: dimensionId, expectedType: "text" as const }],
  filters: [],
  sort: [],
  deleted: "exclude" as const,
  search: null,
  searchFields: [],
};

const wireDefinition = {
  version: 1,
  logic: "or",
  columns: [{ field_id: dimensionId, expected_type: "text" }],
  filters: [],
  sort: [],
  deleted: "exclude",
  search: null,
  search_fields: [],
};

const groupQuery = {
  moduleId,
  definition,
  mode: "groups" as const,
  aggregation: "count" as const,
  dimension: { fieldId: dimensionId, expectedType: "text" as const },
};

const wireGroupQuery = {
  mode: "groups",
  module_id: moduleId,
  definition: wireDefinition,
  aggregation: "count",
  measure: null,
  dimension: { field_id: dimensionId, expected_type: "text" },
  date_field: null,
  from_date: null,
  to_date: null,
};
const wireGroupRequest = {
  mode: wireGroupQuery.mode,
  module_id: wireGroupQuery.module_id,
  definition: wireGroupQuery.definition,
  aggregation: wireGroupQuery.aggregation,
  measure: wireGroupQuery.measure,
  dimension: wireGroupQuery.dimension,
};

const wireWidget = {
  id: widgetId,
  position: 0,
  widget_type: "chart",
  config: { version: 1, chart_type: "bar", query: wireGroupQuery },
  created_at: timestamp,
  updated_at: timestamp,
};
const wireLiveWidgets = [
  wireWidget,
  {
    ...wireWidget,
    id: "00000000-0000-4000-8000-000000000008",
    position: 1,
    widget_type: "summary",
    config: { version: 1, query: wireGroupQuery },
  },
  {
    ...wireWidget,
    id: "00000000-0000-4000-8000-000000000009",
    position: 2,
    widget_type: "workload",
    config: { version: 1, query: wireGroupQuery },
  },
  {
    ...wireWidget,
    id: "00000000-0000-4000-8000-000000000010",
    position: 3,
    widget_type: "records",
    config: {
      version: 1,
      query: { module_id: moduleId, definition: wireDefinition },
    },
  },
];

function dashboardResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: dashboardId,
    owner_id: userId,
    name: "Operations",
    refresh_cadence: "manual",
    revision: 2,
    is_deleted: false,
    created_at: timestamp,
    updated_at: timestamp,
    widgets: [wireWidget],
    ...overrides,
  };
}

const pageResponse = {
  limit: 25,
  offset: 0,
  count: 1,
  total: 1,
  has_more: false,
};

function expectedDashboard(): OpenViewDashboard {
  return {
    id: dashboardId,
    ownerId: userId,
    name: "Operations",
    refreshCadence: "manual",
    revision: 2,
    isDeleted: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    widgets: [
      {
        id: widgetId,
        position: 0,
        widgetType: "chart",
        config: {
          version: 1,
          chartType: "bar",
          query: {
            ...groupQuery,
            definition,
          },
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
}

test("reads and updates the personal Dashboard default with a strict nullable ID", async () => {
  const responses = [
    { dashboard_id: null },
    { dashboard_id: dashboardId },
    { dashboard_id: null },
  ];
  const fetch = installFetch(() => jsonResponse(responses.shift()));
  try {
    expect(await getOpenViewDashboardDefault()).toEqual({ dashboardId: null });
    expect(await setOpenViewDashboardDefault(dashboardId)).toEqual({
      dashboardId,
    });
    expect(await setOpenViewDashboardDefault(null)).toEqual({
      dashboardId: null,
    });
    expect(fetch.requests.map(({ input }) => String(input))).toEqual([
      "/api/dashboards/default",
      "/api/dashboards/default",
      "/api/dashboards/default",
    ]);
    expect(fetch.requests.map(({ init }) => init?.cache)).toEqual([
      "no-store",
      "no-store",
      "no-store",
    ]);
    expect(fetch.requests[1]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(fetch.requests[1]?.init?.body))).toEqual({
      dashboard_id: dashboardId,
    });
    expect(JSON.parse(String(fetch.requests[2]?.init?.body))).toEqual({
      dashboard_id: null,
    });
    await expect(
      setOpenViewDashboardDefault("sample-dashboard"),
    ).rejects.toThrow();
    expect(fetch.requests).toHaveLength(3);
  } finally {
    fetch.restore();
  }

  const malformed = installFetch(() =>
    jsonResponse({ dashboard_id: "sample-dashboard" }),
  );
  try {
    await expect(getOpenViewDashboardDefault()).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    malformed.restore();
  }
});

test("lists and reads owner-private Dashboards with strict ordered chart mapping", async () => {
  const fetch = installFetch((input) => {
    const path = String(input);
    return path.includes("?")
      ? jsonResponse({ items: [dashboardResponse()], pagination: pageResponse })
      : jsonResponse(dashboardResponse());
  });
  try {
    const listed = await listOpenViewDashboards({
      search: "  operations ",
      sortBy: "updated_at",
      sortOrder: "desc",
      deleted: "include",
    });
    expect(listed.items).toEqual([expectedDashboard()]);
    expect(listed.pagination).toEqual({
      limit: 25,
      offset: 0,
      count: 1,
      total: 1,
      hasMore: false,
    });
    expect(String(fetch.requests[0]?.input)).toContain(
      "/dashboards?limit=25&offset=0&sort_by=updated_at&sort_order=desc&search=operations&deleted=include",
    );
    expect(fetch.requests[0]?.init?.cache).toBe("no-store");

    expect(await getOpenViewDashboard(dashboardId)).toEqual(
      expectedDashboard(),
    );
    expect(String(fetch.requests[1]?.input)).toBe(
      `/api/dashboards/${dashboardId}`,
    );
    expect(fetch.requests[1]?.init?.cache).toBe("no-store");
  } finally {
    fetch.restore();
  }
});

test("creates and replaces the complete ordered chart list using the strict wire contract", async () => {
  const responses = [
    dashboardResponse(),
    dashboardResponse({ revision: 3, widgets: [] }),
  ];
  const fetch = installFetch((_input, init) => {
    const response = responses.shift();
    return jsonResponse(response, init?.method === "POST" ? 201 : 200);
  });
  try {
    const created = await createOpenViewDashboard({
      name: "Operations",
      widgets: [
        {
          widgetType: "chart",
          config: { version: 1, chartType: "bar", query: groupQuery },
        },
      ],
    });
    expect(created).toEqual(expectedDashboard());
    const createRequest = fetch.requests[0];
    expect(createRequest?.init?.method).toBe("POST");
    expect(JSON.parse(String(createRequest?.init?.body))).toEqual({
      name: "Operations",
      refresh_cadence: "manual",
      widgets: [
        {
          widget_type: "chart",
          config: { version: 1, chart_type: "bar", query: wireGroupRequest },
        },
      ],
    });
    expect(fetch.requests[0]?.init?.cache).toBe("no-store");

    const updated = await updateOpenViewDashboard({
      id: dashboardId,
      revision: 2,
      widgets: [],
    });
    expect(updated.revision).toBe(3);
    expect(updated.widgets).toEqual([]);
    const updateRequest = fetch.requests[1];
    expect(updateRequest?.init?.method).toBe("PATCH");
    expect(String(updateRequest?.input)).toBe(`/api/dashboards/${dashboardId}`);
    expect(JSON.parse(String(updateRequest?.init?.body))).toEqual({
      revision: 2,
      widgets: [],
    });
  } finally {
    fetch.restore();
  }
});

test("maps all live widget types and persists the visible refresh cadence", async () => {
  const saved = dashboardResponse({
    refresh_cadence: "one-minute",
    widgets: wireLiveWidgets.map((widget) => ({
      ...widget,
      id: widget.id === widgetId ? widgetId : widget.id,
    })),
  });
  const fetch = installFetch((_input, init) =>
    jsonResponse(saved, init?.method === "POST" ? 201 : 200),
  );
  const widgets = [
    {
      widgetType: "chart" as const,
      config: {
        version: 1 as const,
        chartType: "bar" as const,
        query: groupQuery,
      },
    },
    {
      widgetType: "summary" as const,
      config: { version: 1 as const, query: groupQuery },
    },
    {
      widgetType: "workload" as const,
      config: { version: 1 as const, query: groupQuery },
    },
    {
      widgetType: "records" as const,
      config: { version: 1 as const, query: { moduleId, definition } },
    },
  ];
  try {
    const created = await createOpenViewDashboard({
      name: "Operations",
      refreshCadence: "one-minute",
      widgets,
    });
    expect(created.refreshCadence).toBe("one-minute");
    expect(created.widgets.map((widget) => widget.widgetType)).toEqual([
      "chart",
      "summary",
      "workload",
      "records",
    ]);
    expect(JSON.parse(String(fetch.requests[0]?.init?.body))).toEqual({
      name: "Operations",
      refresh_cadence: "one-minute",
      widgets: [
        {
          widget_type: "chart",
          config: { version: 1, chart_type: "bar", query: wireGroupRequest },
        },
        {
          widget_type: "summary",
          config: { version: 1, query: wireGroupRequest },
        },
        {
          widget_type: "workload",
          config: { version: 1, query: wireGroupRequest },
        },
        {
          widget_type: "records",
          config: {
            version: 1,
            query: { module_id: moduleId, definition: wireDefinition },
          },
        },
      ],
    });

    await updateOpenViewDashboard({
      id: dashboardId,
      revision: 2,
      refreshCadence: "five-minutes",
    });
    expect(JSON.parse(String(fetch.requests[1]?.init?.body))).toEqual({
      revision: 2,
      refresh_cadence: "five-minutes",
    });
  } finally {
    fetch.restore();
  }
});

test("serializes bounded date-series charts with numeric measures", async () => {
  const wireDateQuery = {
    mode: "date_series",
    module_id: moduleId,
    definition: wireDefinition,
    aggregation: "sum",
    measure: { field_id: measureId, expected_type: "decimal" },
    date_field: { field_id: dateFieldId, expected_type: "datetime" },
    from_date: "2026-01-01",
    to_date: "2027-01-01",
  };
  const fetch = installFetch(() =>
    jsonResponse(
      dashboardResponse({
        widgets: [
          {
            ...wireWidget,
            config: { version: 1, chart_type: "line", query: wireDateQuery },
          },
        ],
      }),
    ),
  );
  try {
    const result = await createOpenViewDashboard({
      name: "Daily totals",
      widgets: [
        {
          widgetType: "chart",
          config: {
            version: 1,
            chartType: "line",
            query: {
              moduleId,
              definition,
              mode: "date_series",
              aggregation: "sum",
              measure: { fieldId: measureId, expectedType: "decimal" },
              dateField: { fieldId: dateFieldId, expectedType: "datetime" },
              fromDate: "2026-01-01",
              toDate: "2027-01-01",
            },
          },
        },
      ],
    });
    expect(result.widgets[0]?.config.query).toMatchObject({
      mode: "date_series",
      fromDate: "2026-01-01",
      toDate: "2027-01-01",
      measure: { fieldId: measureId, expectedType: "decimal" },
    });
    expect(JSON.parse(String(fetch.requests[0]?.init?.body))).toMatchObject({
      widgets: [
        {
          config: {
            chart_type: "line",
            query: wireDateQuery,
          },
        },
      ],
    });
  } finally {
    fetch.restore();
  }
});

test("archives by revision and restores with a revision precondition", async () => {
  const fetch = installFetch((_input, init) =>
    init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : jsonResponse(dashboardResponse({ revision: 3 })),
  );
  try {
    await archiveOpenViewDashboard({ id: dashboardId, revision: 2 });
    expect(fetch.requests[0]?.init?.method).toBe("DELETE");
    expect(String(fetch.requests[0]?.input)).toBe(
      `/api/dashboards/${dashboardId}?revision=2`,
    );
    expect(fetch.requests[0]?.init?.cache).toBe("no-store");

    const restored = await restoreOpenViewDashboard({
      id: dashboardId,
      revision: 3,
    });
    expect(restored.revision).toBe(3);
    expect(restored.isDeleted).toBe(false);
    expect(fetch.requests[1]?.init?.method).toBe("POST");
    expect(String(fetch.requests[1]?.input)).toBe(
      `/api/dashboards/${dashboardId}/restore`,
    );
    expect(JSON.parse(String(fetch.requests[1]?.init?.body))).toEqual({
      revision: 3,
    });
  } finally {
    fetch.restore();
  }
});

test("rejects malformed IDs, chart/query mismatches, and audience or snapshot data before fetch", async () => {
  const fetch = installFetch(() => jsonResponse(dashboardResponse()));
  try {
    await expect(getOpenViewDashboard("sample-dashboard")).rejects.toThrow();
    const sharedInput = {
      name: "Shared",
      audience: { kind: "everyone" },
      refresh: "five-minutes",
      widgets: [],
    };
    await expect(createOpenViewDashboard(sharedInput)).rejects.toThrow();
    await expect(
      createOpenViewDashboard({
        name: "Invalid chart",
        widgets: [
          {
            widgetType: "chart",
            config: {
              version: 1,
              chartType: "line",
              query: groupQuery,
            },
          },
        ],
      }),
    ).rejects.toThrow();
    const queryWithSnapshot = {
      ...groupQuery,
      resultSnapshot: [{ key: "private" }],
    };
    const snapshotInput: OpenViewDashboardCreateInput = {
      name: "Materialized data is not saved",
      widgets: [
        {
          widgetType: "chart",
          config: {
            version: 1,
            chartType: "bar",
            query: queryWithSnapshot,
          },
        },
      ],
    };
    await expect(createOpenViewDashboard(snapshotInput)).rejects.toThrow();
    expect(fetch.requests).toHaveLength(0);
  } finally {
    fetch.restore();
  }
});

test("rejects unexpected stored fields and preserves safe API conflicts", async () => {
  const malformed = installFetch(() =>
    jsonResponse({
      items: [
        dashboardResponse({
          widgets: [
            {
              ...wireWidget,
              config: { ...wireWidget.config, result_snapshot: [] },
            },
          ],
        }),
      ],
      pagination: pageResponse,
    }),
  );
  let contractFailure: unknown;
  try {
    await listOpenViewDashboards().catch((error: unknown) => {
      contractFailure = error;
    });
    expect(contractFailure).toBeInstanceOf(ApiContractError);
  } finally {
    malformed.restore();
  }

  const conflictFetch = installFetch(() =>
    jsonResponse(
      {
        detail: {
          code: "stale_revision",
          message: "Dashboard changed; reload before saving",
          current_revision: 4,
        },
      },
      409,
    ),
  );
  try {
    let apiFailure: unknown;
    await getOpenViewDashboard(dashboardId).catch((error: unknown) => {
      apiFailure = error;
    });
    expect(apiFailure).toBeInstanceOf(ApiError);
    expect(getOpenViewDashboardConflict(apiFailure)).toEqual({
      code: "stale_revision",
      message: "Dashboard changed; reload before saving",
      currentRevision: 4,
    });
    expect(
      getOpenViewDashboardConflict(new Error("internal detail")),
    ).toBeNull();
  } finally {
    conflictFetch.restore();
  }
});
