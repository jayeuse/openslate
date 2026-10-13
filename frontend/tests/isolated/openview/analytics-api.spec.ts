import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  queryOpenViewAggregateSnapshot,
  queryOpenViewAggregates,
  queryOpenViewGroupedRecords,
  type OpenViewGroupSelector,
} from "../../../src/components/systems/openview/adapters/analytics-api";
import {
  serializeOpenViewQueryDefinition,
  type OpenViewQueryDefinition,
} from "../../../src/components/systems/openview/adapters/views-api";
import { wirePagination } from "../../helpers/pagination";

const moduleId = "00000000-0000-4000-8000-000000000011";
const fieldId = "00000000-0000-4000-8000-000000000012";
const groupFieldId = "00000000-0000-4000-8000-000000000013";
const recordId = "00000000-0000-4000-8000-000000000014";

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

const definition: OpenViewQueryDefinition = {
  version: 1,
  logic: "and",
  columns: [{ fieldId, expectedType: "text" }],
  filters: [],
  sort: [],
  deleted: "exclude",
  search: null,
  searchFields: [],
};

const groupPagination = wirePagination({ limit: 100, count: 0, total: 0 });

const emptyGroupResult = {
  items: [],
  pagination: null,
  groups: [],
  group_pagination: groupPagination,
  selected_group: null,
};

const record = {
  id: recordId,
  module_id: moduleId,
  data: { [fieldId]: "Pump 04" },
  display_values: {},
  created_at: "2026-09-23T00:00:00Z",
  updated_at: "2026-09-23T00:00:00Z",
  deleted_at: null,
  is_deleted: false,
  performed_by: null,
};

function dailyAggregateResult(
  days: readonly string[],
  paginationOverride?: Partial<{
    limit: number;
    offset: number;
    count: number;
    total: number;
    has_more: boolean;
  }>,
) {
  return {
    items: days.map((day) => ({
      key: day,
      label: day,
      value: "0.00",
      record_count: 0,
    })),
    pagination: {
      limit: days.length,
      offset: 0,
      count: days.length,
      total: days.length,
      has_more: false,
      ...paginationOverride,
    },
  };
}

function isEmptyValueSelection(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "value" &&
    "value" in value &&
    value.value === ""
  );
}

test("omitted and null group selections both return headers without member rows", async () => {
  const mock = installFetch(() => Response.json(emptyGroupResult));
  try {
    await expect(
      queryOpenViewGroupedRecords({
        moduleId,
        definition,
        groupBy: { fieldId: groupFieldId, expectedType: "select" },
      }),
    ).resolves.toMatchObject({
      items: [],
      pagination: null,
      groups: [],
      selectedGroup: null,
    });
    await expect(
      queryOpenViewGroupedRecords({
        moduleId,
        definition,
        groupBy: { fieldId: groupFieldId, expectedType: "select" },
        selectedGroup: null,
      }),
    ).resolves.toMatchObject({ selectedGroup: null, pagination: null });

    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      "/api/records/grouped-query",
      "/api/records/grouped-query",
    ]);
    const firstBody = JSON.parse(String(mock.requests[0]?.init?.body));
    const secondBody = JSON.parse(String(mock.requests[1]?.init?.body));
    expect(firstBody).not.toHaveProperty("selected_group");
    expect(secondBody).toHaveProperty("selected_group", null);
    expect(firstBody).toMatchObject({
      module_id: moduleId,
      definition: serializeOpenViewQueryDefinition(definition),
      limit: 25,
      offset: 0,
      group_limit: 100,
      group_offset: 0,
      group_by: { field_id: groupFieldId, expected_type: "select" },
    });
  } finally {
    mock.restore();
  }
});

test("preserves empty-string and unspecified group selectors and empty member pages", async () => {
  const unspecified: OpenViewGroupSelector = { kind: "unspecified" };
  const emptyValue: OpenViewGroupSelector = { kind: "value", value: "" };
  const mock = installFetch((_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      selected_group?: unknown;
    };
    if (isEmptyValueSelection(request.selected_group)) {
      return Response.json({
        items: [],
        pagination: wirePagination({
          limit: 10,
          offset: 5,
          count: 0,
          total: 2,
        }),
        groups: [{ value: "", label: "", count: 2 }],
        group_pagination: wirePagination({ limit: 100, count: 1, total: 1 }),
        selected_group: emptyValue,
      });
    }
    return Response.json({
      items: [record],
      pagination: wirePagination({ limit: 25, count: 1, total: 1 }),
      groups: [{ value: null, label: "Unspecified", count: 1 }],
      group_pagination: wirePagination({ limit: 100, count: 1, total: 1 }),
      selected_group: unspecified,
    });
  });
  try {
    await expect(
      queryOpenViewGroupedRecords({
        moduleId,
        definition,
        groupBy: { fieldId: groupFieldId, expectedType: "text" },
        selectedGroup: emptyValue,
        limit: 10,
        offset: 5,
      }),
    ).resolves.toMatchObject({
      items: [],
      pagination: { count: 0, total: 2 },
      groups: [{ value: "", label: "", count: 2 }],
      selectedGroup: emptyValue,
    });
    await expect(
      queryOpenViewGroupedRecords({
        moduleId,
        definition,
        groupBy: { fieldId: groupFieldId, expectedType: "text" },
        selectedGroup: unspecified,
      }),
    ).resolves.toMatchObject({
      items: [
        {
          id: recordId,
          moduleId,
          data: { [fieldId]: "Pump 04" },
        },
      ],
      groups: [{ value: null, label: "Unspecified", count: 1 }],
      selectedGroup: unspecified,
    });

    const firstBody = JSON.parse(String(mock.requests[0]?.init?.body));
    const secondBody = JSON.parse(String(mock.requests[1]?.init?.body));
    expect(firstBody.selected_group).toEqual({ kind: "value", value: "" });
    expect(firstBody).toMatchObject({ limit: 10, offset: 5 });
    expect(secondBody.selected_group).toEqual({ kind: "unspecified" });
  } finally {
    mock.restore();
  }
});

test("sends aggregate groups through the shared definition serializer and preserves decimal strings", async () => {
  const mock = installFetch(() =>
    Response.json({
      items: [
        {
          key: "Copper",
          label: "Copper",
          value: "0.3000000000",
          record_count: 2,
        },
      ],
      pagination: wirePagination({ limit: 12, count: 1, total: 1 }),
    }),
  );
  try {
    await expect(
      queryOpenViewAggregates({
        mode: "groups",
        moduleId,
        definition,
        aggregation: "sum",
        measure: { fieldId, expectedType: "decimal" },
        dimension: { fieldId: groupFieldId, expectedType: "select" },
        limit: 12,
      }),
    ).resolves.toEqual({
      items: [
        {
          key: "Copper",
          label: "Copper",
          value: "0.3000000000",
          recordCount: 2,
        },
      ],
      pagination: {
        limit: 12,
        offset: 0,
        count: 1,
        total: 1,
        hasMore: false,
      },
    });

    expect(String(mock.requests[0]?.input)).toBe(
      "/api/records/aggregate-query",
    );
    expect(mock.requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      mode: "groups",
      module_id: moduleId,
      definition: serializeOpenViewQueryDefinition(definition),
      aggregation: "sum",
      measure: { field_id: fieldId, expected_type: "decimal" },
      dimension: { field_id: groupFieldId, expected_type: "select" },
      limit: 12,
      offset: 0,
    });
  } finally {
    mock.restore();
  }
});

test("keeps the complete workspace-local daily date series and rejects a missing day", async () => {
  const fromDate = "2026-09-20";
  const toDate = "2026-09-23";
  const days = [fromDate, "2026-09-21", "2026-09-22", toDate];
  const responses: unknown[] = [
    dailyAggregateResult(days),
    dailyAggregateResult(
      days.filter((day) => day !== "2026-09-21"),
      {
        limit: 3,
        count: 3,
        total: 3,
      },
    ),
  ];
  const mock = installFetch(() => Response.json(responses.shift()));
  try {
    await expect(
      queryOpenViewAggregates({
        mode: "date_series",
        moduleId,
        definition,
        aggregation: "average",
        measure: { fieldId, expectedType: "decimal" },
        dateField: { fieldId: groupFieldId, expectedType: "datetime" },
        fromDate,
        toDate,
      }),
    ).resolves.toMatchObject({
      items: days.map((day) => ({
        key: day,
        label: day,
        value: "0.00",
        recordCount: 0,
      })),
      pagination: {
        limit: 4,
        offset: 0,
        count: 4,
        total: 4,
        hasMore: false,
      },
    });
    const body = JSON.parse(String(mock.requests[0]?.init?.body));
    expect(body).toMatchObject({
      mode: "date_series",
      from_date: fromDate,
      to_date: toDate,
      date_field: { field_id: groupFieldId, expected_type: "datetime" },
    });

    await expect(
      queryOpenViewAggregates({
        mode: "date_series",
        moduleId,
        definition,
        aggregation: "average",
        measure: { fieldId, expectedType: "decimal" },
        dateField: { fieldId: groupFieldId, expectedType: "datetime" },
        fromDate,
        toDate,
      }),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    mock.restore();
  }
});

test("rejects records in an unselected group response", async () => {
  const mock = installFetch(() =>
    Response.json({
      ...emptyGroupResult,
      items: [record],
    }),
  );
  try {
    await expect(
      queryOpenViewGroupedRecords({
        moduleId,
        definition,
        groupBy: { fieldId: groupFieldId, expectedType: "select" },
      }),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    mock.restore();
  }
});

test("preserves structured FastAPI analytics errors", async () => {
  const mock = installFetch(() =>
    Response.json(
      {
        detail: {
          code: "view_invalid",
          message: "A referenced field has changed; repair the view",
        },
      },
      { status: 409 },
    ),
  );
  try {
    let caught: unknown;
    try {
      await queryOpenViewAggregates({
        mode: "groups",
        moduleId,
        definition,
        aggregation: "count",
        dimension: { fieldId: groupFieldId, expectedType: "select" },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({
      status: 409,
      code: "view_invalid",
      details: {
        code: "view_invalid",
        message: "A referenced field has changed; repair the view",
      },
    });
  } finally {
    mock.restore();
  }
});

test("sends complete grouped aggregate snapshots without pagination and preserves decimals", async () => {
  let responseIndex = 0;
  const mock = installFetch(() =>
    responseIndex++ === 0
      ? Response.json({
          items: [
            {
              key: "Copper",
              label: "Copper",
              value: "0.3000000000",
              record_count: 2,
            },
            {
              key: null,
              label: "Unspecified",
              value: 3,
              record_count: 1,
            },
          ],
          pagination: wirePagination({ limit: 2, count: 2, total: 2 }),
        })
      : Response.json({
          items: [],
          pagination: wirePagination({ limit: 1, count: 0, total: 0 }),
        }),
  );
  try {
    await expect(
      queryOpenViewAggregateSnapshot({
        mode: "groups",
        moduleId,
        definition,
        aggregation: "sum",
        measure: { fieldId, expectedType: "decimal" },
        dimension: { fieldId: groupFieldId, expectedType: "select" },
      }),
    ).resolves.toEqual({
      items: [
        {
          key: "Copper",
          label: "Copper",
          value: "0.3000000000",
          recordCount: 2,
        },
        { key: null, label: "Unspecified", value: 3, recordCount: 1 },
      ],
      pagination: {
        limit: 2,
        offset: 0,
        count: 2,
        total: 2,
        hasMore: false,
      },
    });

    expect(String(mock.requests[0]?.input)).toBe(
      "/api/records/aggregate-snapshot",
    );
    expect(mock.requests[0]?.init?.method).toBe("POST");
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      mode: "groups",
      module_id: moduleId,
      definition: serializeOpenViewQueryDefinition(definition),
      aggregation: "sum",
      measure: { field_id: fieldId, expected_type: "decimal" },
      dimension: { field_id: groupFieldId, expected_type: "select" },
    });
    await expect(
      queryOpenViewAggregateSnapshot({
        mode: "groups",
        moduleId,
        definition,
        aggregation: "count",
        dimension: { fieldId: groupFieldId, expectedType: "select" },
      }),
    ).resolves.toEqual({
      items: [],
      pagination: {
        limit: 1,
        offset: 0,
        count: 0,
        total: 0,
        hasMore: false,
      },
    });
  } finally {
    mock.restore();
  }
});

test("sends a full explicit 366-day date-series aggregate snapshot", async () => {
  const fromDate = "2026-01-01";
  const toDate = "2027-01-01";
  const days = Array.from({ length: 366 }, (_, index) => {
    const date = new Date(`${fromDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
  const mock = installFetch(() => Response.json(dailyAggregateResult(days)));
  try {
    const result = await queryOpenViewAggregateSnapshot({
      mode: "date_series",
      moduleId,
      definition,
      aggregation: "average",
      measure: { fieldId, expectedType: "decimal" },
      dateField: { fieldId: groupFieldId, expectedType: "datetime" },
      fromDate,
      toDate,
    });

    expect(result.items).toHaveLength(366);
    expect(result.items[0]).toMatchObject({ key: fromDate, label: fromDate });
    expect(result.items.at(-1)).toMatchObject({ key: toDate, label: toDate });
    expect(result.pagination).toEqual({
      limit: 366,
      offset: 0,
      count: 366,
      total: 366,
      hasMore: false,
    });
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      mode: "date_series",
      module_id: moduleId,
      definition: serializeOpenViewQueryDefinition(definition),
      aggregation: "average",
      measure: { field_id: fieldId, expected_type: "decimal" },
      date_field: { field_id: groupFieldId, expected_type: "datetime" },
      from_date: fromDate,
      to_date: toDate,
      bucket: "day",
    });
  } finally {
    mock.restore();
  }
});

test("rejects paginated group snapshot requests and date windows over 366 days", async () => {
  const mock = installFetch(() => Response.json({}));
  try {
    await expect(
      queryOpenViewAggregateSnapshot({
        mode: "groups",
        moduleId,
        definition,
        aggregation: "count",
        dimension: { fieldId: groupFieldId, expectedType: "select" },
        limit: 12,
      } as never),
    ).rejects.toThrow();
    await expect(
      queryOpenViewAggregateSnapshot({
        mode: "date_series",
        moduleId,
        definition,
        aggregation: "count",
        dateField: { fieldId: groupFieldId, expectedType: "date" },
        fromDate: "2026-01-01",
        toDate: "2027-01-02",
      }),
    ).rejects.toThrow();
    await expect(
      queryOpenViewAggregateSnapshot({
        mode: "date_series",
        moduleId,
        definition,
        aggregation: "count",
        dateField: { fieldId: groupFieldId, expectedType: "date" },
        toDate: "2026-01-01",
      } as never),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("rejects incomplete and oversized snapshot pages and preserves structured API errors", async () => {
  const responses: Response[] = [
    Response.json({
      items: [
        { key: "Copper", label: "Copper", value: "1.25", record_count: 2 },
      ],
      pagination: wirePagination({ limit: 1, count: 1, total: 2 }),
    }),
    Response.json({
      items: [
        { key: "Copper", label: "Copper", value: "1.25", record_count: 2 },
      ],
      pagination: wirePagination({
        limit: 1,
        count: 1,
        total: 1,
        has_more: true,
      }),
    }),
    Response.json({
      items: [
        { key: "Copper", label: "Copper", value: "1.25", record_count: 2 },
      ],
      pagination: wirePagination({ limit: 10_001, count: 1, total: 1 }),
    }),
    Response.json(
      {
        detail: {
          code: "aggregate_snapshot_limit_exceeded",
          message: "Aggregate snapshot exceeds the bounded result size",
        },
      },
      { status: 422 },
    ),
  ];
  const mock = installFetch(() => responses.shift() ?? Response.json({}));
  const request = {
    mode: "groups" as const,
    moduleId,
    definition,
    aggregation: "count" as const,
    dimension: { fieldId: groupFieldId, expectedType: "select" as const },
  };
  try {
    await expect(
      queryOpenViewAggregateSnapshot(request),
    ).rejects.toBeInstanceOf(ApiContractError);
    await expect(
      queryOpenViewAggregateSnapshot(request),
    ).rejects.toBeInstanceOf(ApiContractError);
    await expect(
      queryOpenViewAggregateSnapshot(request),
    ).rejects.toBeInstanceOf(ApiContractError);

    let caught: unknown;
    try {
      await queryOpenViewAggregateSnapshot(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({
      status: 422,
      code: "aggregate_snapshot_limit_exceeded",
      details: {
        code: "aggregate_snapshot_limit_exceeded",
        message: "Aggregate snapshot exceeds the bounded result size",
      },
    });
  } finally {
    mock.restore();
  }
});
