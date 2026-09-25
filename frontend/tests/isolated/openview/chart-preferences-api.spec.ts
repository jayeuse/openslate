import { expect, test } from "@playwright/test";
import { ApiContractError } from "../../../src/lib/api";
import {
  getOpenViewChartPreferences,
  putOpenViewChartPreferences,
  type OpenViewChartPreferenceConfig,
} from "../../../src/components/systems/openview/adapters/chart-preferences-api";

const moduleId = "00000000-0000-4000-8000-000000000011";
const dimensionId = "00000000-0000-4000-8000-000000000012";
const dateFieldId = "00000000-0000-4000-8000-000000000013";

type CapturedRequest = { input: RequestInfo | URL; init?: RequestInit };

function installFetch(responder: (request: CapturedRequest) => Response) {
  const original = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = { input, init };
    requests.push(request);
    return Promise.resolve(responder(request));
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const config: OpenViewChartPreferenceConfig = {
  version: 1,
  moduleId,
  chartType: "bar",
  dimensionId,
  dateFieldId,
  aggregation: "count",
  measureId: null,
  filterLogic: "or",
  filters: [],
  fromDate: "2026-09-01",
  toDate: "2026-09-30",
  top: 5,
  showLegend: false,
  showValues: true,
};

function wireConfig() {
  return {
    version: 1,
    module_id: moduleId,
    chart_type: "bar",
    dimension_id: dimensionId,
    date_field_id: dateFieldId,
    aggregation: "count",
    measure_id: null,
    filter_logic: "or",
    filters: [],
    from_date: "2026-09-01",
    to_date: "2026-09-30",
    top: 5,
    show_legend: false,
    show_values: true,
  };
}

test("loads the current user's optional versioned Chart preference", async () => {
  const mock = installFetch(({ input }) => {
    expect(String(input)).toBe("/api/charts/preferences");
    return Response.json({ config: wireConfig() });
  });
  try {
    await expect(getOpenViewChartPreferences()).resolves.toEqual({ config });
    expect(mock.requests[0]?.init?.method).toBeUndefined();
  } finally {
    mock.restore();
  }
});

test("writes an owner-scoped Chart preference using the strict wire shape", async () => {
  const mock = installFetch(({ input, init }) => {
    expect(String(input)).toBe("/api/charts/preferences");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ config: wireConfig() });
    return Response.json({ config: wireConfig() });
  });
  try {
    await expect(putOpenViewChartPreferences(config)).resolves.toEqual({
      config,
    });
  } finally {
    mock.restore();
  }
});

test("rejects malformed or extra Chart preference response fields", async () => {
  const mock = installFetch(() =>
    Response.json({ config: { ...wireConfig(), server_only: "unexpected" } }),
  );
  try {
    await expect(getOpenViewChartPreferences()).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
});
