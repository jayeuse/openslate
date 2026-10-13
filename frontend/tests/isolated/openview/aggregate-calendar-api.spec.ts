import { expect, test } from "@playwright/test";
import * as analytics from "../../../src/components/systems/openview/adapters/analytics-api";
import {
  bindOpenViewAccess,
  isOpenViewAccessDenied,
} from "../../../src/components/systems/openview/adapters/openview-access";
import { getOpenViewDashboard } from "../../../src/components/systems/openview/adapters/dashboards-api";
import { wirePagination } from "../../helpers/pagination";

const moduleId = "00000000-0000-4000-8000-000000000701";
const fieldId = "00000000-0000-4000-8000-000000000702";
const measureId = "00000000-0000-4000-8000-000000000703";
const definition = {
  version: 1 as const,
  columns: [],
  filters: [],
  sort: [],
  logic: "and" as const,
  deleted: "exclude" as const,
  search: null,
  searchFields: [],
};
const dateQuery = {
  mode: "date_series" as const,
  moduleId,
  definition,
  aggregation: "average" as const,
  dateField: { fieldId, expectedType: "date" as const },
  measure: { fieldId: measureId, expectedType: "decimal" as const },
  fromDate: "2026-10-01",
  toDate: "2026-10-02",
};
const groupQuery = {
  mode: "groups" as const,
  moduleId,
  definition,
  aggregation: "count" as const,
  dimension: { fieldId, expectedType: "text" as const },
};

function snapshot(
  keys: readonly string[],
  values: readonly (number | string | null)[] = [],
) {
  return {
    items: keys.map((key, index) => ({
      key,
      label: key,
      value: values[index] ?? null,
      record_count: index === 0 ? 1 : 0,
    })),
    pagination: wirePagination({
      limit: Math.max(1, keys.length),
      count: keys.length,
      total: keys.length,
    }),
  };
}

function mockApi(responder: (path: string, body: unknown) => Response) {
  const original = globalThis.fetch;
  const calls: { path: string; body: unknown }[] = [];
  bindOpenViewAccess();
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body });
    return responder(path, body);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("date snapshot preserves a missing average as null and exact decimal text", async () => {
  const mock = mockApi(() =>
    Response.json(
      snapshot(["2026-10-01", "2026-10-02"], ["1.2345678901234567", null]),
    ),
  );
  try {
    const result = await analytics.queryOpenViewAggregateSnapshot(dateQuery);
    expect(result.items.map((item) => item.value)).toEqual([
      "1.2345678901234567",
      null,
    ]);
    expect(mock.calls[0].body).toMatchObject({
      bucket: "day",
      aggregation: "average",
    });
  } finally {
    mock.restore();
  }
});

test("numeric extrema and primitive Distinct serialize typed measures before fetch", async () => {
  const mock = mockApi(() =>
    Response.json(snapshot(["group"], ["-1.2345678901234567"])),
  );
  try {
    for (const aggregation of ["min", "max", "distinct"] as const) {
      const expectedType =
        aggregation === "distinct" ? ("text" as const) : ("decimal" as const);
      await analytics.queryOpenViewAggregateSnapshot({
        ...groupQuery,
        aggregation,
        measure: { fieldId: measureId, expectedType },
      });
      expect(mock.calls.at(-1)?.body).toMatchObject({
        aggregation,
        measure: { field_id: measureId, expected_type: expectedType },
      });
    }
    const calls = mock.calls.length;
    await expect(
      analytics.queryOpenViewAggregateSnapshot({
        ...groupQuery,
        aggregation: "min",
        measure: { fieldId: measureId, expectedType: "date" },
      }),
    ).rejects.toThrow();
    await expect(
      analytics.queryOpenViewAggregateSnapshot({
        ...groupQuery,
        aggregation: "distinct",
      }),
    ).rejects.toThrow();
    expect(mock.calls).toHaveLength(calls);
  } finally {
    mock.restore();
  }
});

for (const range of [
  {
    bucket: "month" as const,
    fromDate: "2026-12-15",
    toDate: "2027-01-10",
    keys: ["2026-12-01", "2027-01-01"],
  },
  {
    bucket: "quarter" as const,
    fromDate: "2026-09-30",
    toDate: "2027-01-01",
    keys: ["2026-07-01", "2026-10-01", "2027-01-01"],
  },
  {
    bucket: "year" as const,
    fromDate: "2000-03-01",
    toDate: "2365-12-31",
    keys: Array.from(
      { length: 366 },
      (_, index) => String(2000 + index) + "-01-01",
    ),
  },
  {
    bucket: "year" as const,
    fromDate: "9999-12-31",
    toDate: "9999-12-31",
    keys: ["9999-01-01"],
  },
]) {
  test(
    "calendar snapshot validates exact " +
      range.bucket +
      " starts from " +
      range.fromDate,
    async () => {
      let returned = range.keys;
      const mock = mockApi(() => Response.json(snapshot(returned)));
      const { keys, ...window } = range;
      try {
        const result = await analytics.queryOpenViewAggregateSnapshot({
          ...dateQuery,
          ...window,
        });
        expect(result.items.map((item) => item.key)).toEqual(keys);
        expect(mock.calls[0].body).toMatchObject({
          bucket: range.bucket,
          from_date: range.fromDate,
          to_date: range.toDate,
        });
        returned = [range.toDate];
        await expect(
          analytics.queryOpenViewAggregateSnapshot({ ...dateQuery, ...window }),
        ).rejects.toThrow();
      } finally {
        mock.restore();
      }
    },
  );
}

test("weekly batch reads one workspace anchor and rejects a changed or incomplete calendar", async () => {
  let keys = ["2026-10-04", "2026-10-11"];
  const mock = mockApi((path) =>
    path === "/api/workspace"
      ? Response.json({
          week_start: "sunday",
          timezone: "Asia/Manila",
          locale: "en-PH",
          today: "2026-10-09",
        })
      : Response.json({ items: [snapshot(keys), snapshot(keys)] }),
  );
  const request = {
    ...dateQuery,
    bucket: "week" as const,
    fromDate: "2026-10-07",
    toDate: "2026-10-13",
  };
  try {
    const result = await analytics.queryOpenViewAggregateSnapshots([
      request,
      request,
    ]);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].items.map((item) => item.key)).toEqual(keys);
    expect(
      mock.calls.filter((call) => call.path === "/api/workspace"),
    ).toHaveLength(1);
    expect(mock.calls.at(-1)?.body).toMatchObject({
      queries: [{ bucket: "week" }, { bucket: "week" }],
    });
    keys = ["2026-10-05", "2026-10-12"];
    await expect(
      analytics.queryOpenViewAggregateSnapshots([request, request]),
    ).rejects.toThrow();
  } finally {
    mock.restore();
  }
});

test("weekly workspace refusal joins OpenView refusal and never sends the snapshot", async () => {
  const mock = mockApi(() =>
    Response.json({ detail: "Forbidden" }, { status: 403 }),
  );
  try {
    await expect(
      analytics.queryOpenViewAggregateSnapshot({
        ...dateQuery,
        bucket: "week",
      }),
    ).rejects.toThrow();
    expect(isOpenViewAccessDenied()).toBe(true);
    expect(mock.calls.map((call) => call.path)).toEqual(["/api/workspace"]);
  } finally {
    mock.restore();
  }
});

test("plural snapshots preserve query order and nullable values without partial acceptance", async () => {
  let results = [
    snapshot(["Maximum"], ["8.25"]),
    snapshot(["Minimum"], [null]),
  ];
  const mock = mockApi(() => Response.json({ items: results }));
  try {
    const result = await analytics.queryOpenViewAggregateSnapshots([
      groupQuery,
      groupQuery,
    ]);
    expect(result.items.map((item) => item.items[0].value)).toEqual([
      "8.25",
      null,
    ]);
    results = [results[0]];
    await expect(
      analytics.queryOpenViewAggregateSnapshots([groupQuery, groupQuery]),
    ).rejects.toThrow();
    for (const queries of [[], Array.from({ length: 13 }, () => groupQuery)])
      await expect(
        analytics.queryOpenViewAggregateSnapshots(queries),
      ).rejects.toThrow();
    expect(mock.calls).toHaveLength(2);
  } finally {
    mock.restore();
  }
});

test("plural limits cover all snapshots and their outer wrapper", async () => {
  let results = [
    snapshot(Array.from({ length: 6000 }, (_, i) => "first-" + i)),
    snapshot(Array.from({ length: 6000 }, (_, i) => "second-" + i)),
  ];
  const mock = mockApi(() => Response.json({ items: results }));
  try {
    await expect(
      analytics.queryOpenViewAggregateSnapshots([groupQuery, groupQuery]),
    ).rejects.toThrow();
    results = [
      snapshot(Array.from({ length: 5000 }, (_, i) => "first-" + i)),
      snapshot(Array.from({ length: 5000 }, (_, i) => "second-" + i)),
    ];
    const limit = 8 * 1024 * 1024;
    const bodySize = () =>
      new TextEncoder().encode(JSON.stringify({ items: results })).byteLength;
    const filler = Math.floor((limit - bodySize()) / 10000);
    results.forEach((result) =>
      result.items.forEach((item) => {
        item.label += "x".repeat(filler);
      }),
    );
    const remaining = limit - bodySize();
    results
      .flatMap((result) => result.items)
      .slice(0, remaining)
      .forEach((item) => {
        item.label += "x";
      });
    expect(bodySize()).toBe(limit);
    await expect(
      analytics.queryOpenViewAggregateSnapshots([groupQuery, groupQuery]),
    ).resolves.toMatchObject({
      items: [{ pagination: { count: 5000 } }, { pagination: { count: 5000 } }],
    });
    results[1].items[0].label += "x";
    await expect(
      analytics.queryOpenViewAggregateSnapshots([groupQuery, groupQuery]),
    ).rejects.toThrow();
  } finally {
    mock.restore();
  }
});

test("stored Dashboard non-day query retains its bucket and legacy daily config defaults day", async () => {
  let bucket: "month" | undefined = "month";
  const mock = mockApi(() =>
    Response.json({
      id: measureId,
      department_id: moduleId,
      position: 0,
      name: "Calendar",
      refresh_cadence: "manual",
      revision: 1,
      is_deleted: false,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
      widgets: [
        {
          id: fieldId,
          position: 0,
          widget_type: "chart",
          size: "M",
          chart_id: null,
          created_at: "2026-10-01T00:00:00Z",
          updated_at: "2026-10-01T00:00:00Z",
          config: {
            version: 1,
            chart_type: "line",
            query: {
              mode: "date_series",
              module_id: moduleId,
              definition: {
                version: 1,
                columns: [],
                filters: [],
                sort: [],
                logic: "and",
                deleted: "exclude",
                search: null,
                search_fields: [],
              },
              aggregation: "average",
              measure: { field_id: measureId, expected_type: "decimal" },
              date_field: { field_id: fieldId, expected_type: "date" },
              from_date: "2026-10-01",
              to_date: "2026-10-02",
              ...(bucket ? { bucket } : {}),
            },
          },
        },
      ],
    }),
  );
  try {
    const first = await getOpenViewDashboard(measureId);
    expect(first.widgets[0].config).toMatchObject({
      query: { bucket: "month" },
    });
    bucket = undefined;
    const legacy = await getOpenViewDashboard(measureId);
    expect(legacy.widgets[0].config).toMatchObject({
      query: { bucket: "day" },
    });
  } finally {
    mock.restore();
  }
});
