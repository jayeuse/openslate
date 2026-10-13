import { expect, test } from "@playwright/test";
import { ZodError } from "zod";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  queryOpenViewWindowRecords,
  type OpenViewWindowQueryRequest,
} from "../../../src/components/systems/openview/adapters/window-api";
import {
  serializeOpenViewQueryDefinition,
  type OpenViewQueryDefinition,
} from "../../../src/components/systems/openview/adapters/views-api";
import { wirePagination } from "../../helpers/pagination";
import { emptyQuery } from "../../helpers/query-definitions";

const moduleId = "00000000-0000-4000-8000-000000000101";
const dateFieldId = "00000000-0000-4000-8000-000000000102";
const startFieldId = "00000000-0000-4000-8000-000000000103";
const endFieldId = "00000000-0000-4000-8000-000000000104";
const recordId = "00000000-0000-4000-8000-000000000105";
const unrelatedFieldId = "00000000-0000-4000-8000-000000000106";
const deadlineFieldId = "00000000-0000-4000-8000-000000000107";

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

const calendarDefinition: OpenViewQueryDefinition = emptyQuery({
  columns: [{ fieldId: dateFieldId, expectedType: "date" }],
});

const timelineDefinition: OpenViewQueryDefinition = {
  ...calendarDefinition,
  columns: [
    { fieldId: startFieldId, expectedType: "datetime" },
    { fieldId: endFieldId, expectedType: "datetime" },
  ],
};

const calendarRequest: OpenViewWindowQueryRequest = {
  moduleId,
  definition: calendarDefinition,
  mode: "calendar",
  scope: "window",
  dateField: { fieldId: dateFieldId, expectedType: "date" },
  fromDate: "2024-01-01",
  toDate: "2024-12-31",
  limit: 10,
  offset: 7,
};

const timelineRequest: OpenViewWindowQueryRequest = {
  moduleId,
  definition: timelineDefinition,
  mode: "timeline",
  scope: "unscheduled",
  startField: { fieldId: startFieldId, expectedType: "datetime" },
  endField: { fieldId: endFieldId, expectedType: "datetime" },
};

function calendarResponse() {
  return {
    items: [
      {
        id: recordId,
        module_id: moduleId,
        data: { [dateFieldId]: "2024-02-29" },
        display_values: {},
        created_at: "2026-09-23T00:00:00Z",
        updated_at: "2026-09-23T00:00:00Z",
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      },
    ],
    pagination: wirePagination({ limit: 10, offset: 7, count: 1, total: 8 }),
    timezone: null,
  };
}

test("serializes a 366-day Calendar window and preserves DATE values and pagination", async () => {
  const mock = installFetch(() => Response.json(calendarResponse()));
  try {
    await expect(queryOpenViewWindowRecords(calendarRequest)).resolves.toEqual({
      items: [
        {
          id: recordId,
          moduleId,
          data: { [dateFieldId]: "2024-02-29" },
          displayValues: {},
          createdAt: "2026-09-23T00:00:00Z",
          updatedAt: "2026-09-23T00:00:00Z",
          deletedAt: null,
          isDeleted: false,
          performedBy: null,
        },
      ],
      pagination: {
        limit: 10,
        offset: 7,
        count: 1,
        total: 8,
        hasMore: false,
      },
      timezone: null,
    });

    expect(String(mock.requests[0]?.input)).toBe("/api/records/window-query");
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      module_id: moduleId,
      definition: serializeOpenViewQueryDefinition(calendarDefinition),
      mode: "calendar",
      scope: "window",
      date_field: { field_id: dateFieldId, expected_type: "date" },
      from_date: "2024-01-01",
      to_date: "2024-12-31",
      limit: 10,
      offset: 7,
    });
  } finally {
    mock.restore();
  }
});

test("serializes Timeline refs and preserves offset DATETIME strings and timezone", async () => {
  const response = {
    ...calendarResponse(),
    items: [
      {
        ...calendarResponse().items[0],
        data: {
          [startFieldId]: "2026-03-08T01:30:00-05:00",
          [endFieldId]: "2026-03-08T03:30:00-04:00",
        },
      },
    ],
    pagination: wirePagination({
      limit: 25,
      count: 1,
      total: 2,
      has_more: true,
    }),
    timezone: "America/New_York",
  };
  const mock = installFetch(() => Response.json(response));
  try {
    const result = await queryOpenViewWindowRecords(timelineRequest);
    expect(result.items[0]?.data).toEqual({
      [startFieldId]: "2026-03-08T01:30:00-05:00",
      [endFieldId]: "2026-03-08T03:30:00-04:00",
    });
    expect(result.pagination).toEqual({
      limit: 25,
      offset: 0,
      count: 1,
      total: 2,
      hasMore: true,
    });
    expect(result.timezone).toBe("America/New_York");

    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      module_id: moduleId,
      definition: serializeOpenViewQueryDefinition(timelineDefinition),
      mode: "timeline",
      scope: "unscheduled",
      start_field: { field_id: startFieldId, expected_type: "datetime" },
      end_field: { field_id: endFieldId, expected_type: "datetime" },
      limit: 25,
      offset: 0,
    });
  } finally {
    mock.restore();
  }
});

test("accepts workspace timezone for a projected DATETIME deadline with DATE interval fields", async () => {
  const definition: OpenViewQueryDefinition = {
    ...timelineDefinition,
    columns: [
      { fieldId: startFieldId, expectedType: "date" },
      { fieldId: endFieldId, expectedType: "date" },
      { fieldId: deadlineFieldId, expectedType: "datetime" },
    ],
  };
  const request: OpenViewWindowQueryRequest = {
    moduleId,
    definition,
    mode: "timeline",
    scope: "window",
    startField: { fieldId: startFieldId, expectedType: "date" },
    endField: { fieldId: endFieldId, expectedType: "date" },
    fromDate: "2026-09-08",
    toDate: "2026-09-10",
  };
  const response = {
    ...calendarResponse(),
    items: [
      {
        ...calendarResponse().items[0],
        data: {
          [startFieldId]: "2026-09-08",
          [endFieldId]: "2026-09-10",
          [deadlineFieldId]: "2026-09-08T18:00:00Z",
        },
      },
    ],
    pagination: { limit: 25, offset: 0, count: 1, total: 1, has_more: false },
    timezone: "Asia/Manila",
  };
  const mock = installFetch(() => Response.json(response));
  try {
    const result = await queryOpenViewWindowRecords(request);
    expect(result.timezone).toBe("Asia/Manila");
    expect(result.items[0]?.data[deadlineFieldId]).toBe("2026-09-08T18:00:00Z");
    expect(JSON.parse(String(mock.requests[0]?.init?.body)).definition).toEqual(
      serializeOpenViewQueryDefinition(definition),
    );
  } finally {
    mock.restore();
  }
});

test("rejects incompatible scopes, refs, and date windows before requesting", async () => {
  const mock = installFetch(() => Response.json(calendarResponse()));
  const invalidRequests: unknown[] = [
    { ...calendarRequest, toDate: "2025-01-01" },
    { ...calendarRequest, scope: "unscheduled" },
    {
      ...calendarRequest,
      dateField: { fieldId: dateFieldId, expectedType: "text" },
    },
    { ...timelineRequest, endField: undefined },
    {
      ...timelineRequest,
      scope: "window",
      fromDate: "2026-01-01",
      toDate: "2027-01-02",
    },
    { ...timelineRequest, fromDate: "2026-01-01" },
  ];
  try {
    for (const request of invalidRequests) {
      await expect(
        queryOpenViewWindowRecords(request as OpenViewWindowQueryRequest),
      ).rejects.toBeInstanceOf(ZodError);
    }
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("rejects incomplete or inconsistent projected response metadata", async () => {
  const valid = calendarResponse();
  const missingHasMore = {
    ...valid,
    pagination: {
      limit: valid.pagination.limit,
      offset: valid.pagination.offset,
      count: valid.pagination.count,
      total: valid.pagination.total,
    },
  };
  const wrongCount = {
    ...valid,
    pagination: { ...valid.pagination, count: 0 },
  };
  const wrongTimezone = { ...valid, timezone: "UTC" };
  const wrongModule = {
    ...valid,
    items: [{ ...valid.items[0], module_id: unrelatedFieldId }],
  };
  const unprojectedData = {
    ...valid,
    items: [
      {
        ...valid.items[0],
        data: { ...valid.items[0].data, [unrelatedFieldId]: "not selected" },
      },
    ],
  };
  const responses: unknown[] = [
    missingHasMore,
    wrongCount,
    wrongTimezone,
    wrongModule,
    unprojectedData,
  ];
  const mock = installFetch(() => Response.json(responses.shift()));
  const responseCount = responses.length;
  try {
    for (let index = 0; index < responseCount; index += 1) {
      await expect(
        queryOpenViewWindowRecords(calendarRequest),
      ).rejects.toBeInstanceOf(ApiContractError);
    }
  } finally {
    mock.restore();
  }
});

test("preserves API errors from the window endpoint", async () => {
  const mock = installFetch(() =>
    Response.json({ detail: "The saved view is invalid" }, { status: 409 }),
  );
  try {
    const error = await queryOpenViewWindowRecords(calendarRequest).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409 });
  } finally {
    mock.restore();
  }
});
