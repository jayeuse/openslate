import { z } from "zod";
import { ApiContractError, ApiError, apiFetch } from "@/lib/api";
import { listSchema } from "./views-schemas";
import { openViewReadFetch } from "./openview-access";
import {
  dashboardWidgetWireConfigSchema,
  type OpenViewDashboardWidgetType,
} from "./dashboards-api";

const uuid = z.string().uuid();
const timestamp = z.iso.datetime({ offset: true });
const chartSchema = z
  .object({
    id: uuid,
    department_id: uuid,
    module_id: uuid,
    name: z.string().min(1).max(200),
    chart_type: z.enum([
      "bar",
      "line",
      "pie",
      "summary",
      "workload",
      "records",
    ]),
    query: z.unknown(),
    revision: z.number().int().min(1),
    is_deleted: z.boolean(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict()
  .transform((chart, context) => {
    const config = dashboardWidgetWireConfigSchema.safeParse({
      version: 1,
      query: chart.query,
      ...(["bar", "line", "pie"].includes(chart.chart_type)
        ? { chart_type: chart.chart_type }
        : {}),
    });
    if (
      !config.success ||
      config.data.query.moduleId !== chart.module_id ||
      (chart.chart_type === "records") !==
        (config.success && !("mode" in config.data.query))
    ) {
      context.addIssue({
        code: "custom",
        message: "Saved Chart definition is invalid",
      });
      return z.NEVER;
    }
    return {
      id: chart.id,
      departmentId: chart.department_id,
      moduleId: chart.module_id,
      name: chart.name,
      chartType: chart.chart_type,
      config: config.data,
      revision: chart.revision,
      isDeleted: chart.is_deleted,
      createdAt: chart.created_at,
      updatedAt: chart.updated_at,
    };
  });

export type SavedChart = z.output<typeof chartSchema>;

const chartListRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    search: z.string().trim().max(100).default(""),
    moduleId: uuid.optional(),
  })
  .strict();

/** Picker metadata only. A result or write must resolve its selected ID afresh. */
export async function listOpenViewCharts(
  options: {
    limit?: number;
    offset?: number;
    search?: string;
    moduleId?: string;
    signal?: AbortSignal;
  } = {},
) {
  const { signal, ...input } = options;
  const request = chartListRequestSchema.parse(input);
  const parameters = new URLSearchParams({
    limit: String(request.limit),
    offset: String(request.offset),
    sort_by: "name",
    sort_order: "asc",
    deleted: "exclude",
  });
  if (request.search) parameters.set("search", request.search);
  if (request.moduleId) parameters.set("module_id", request.moduleId);
  const page = await openViewReadFetch(
    `/charts?${parameters}`,
    listSchema(chartSchema),
    { signal, cache: "no-store" },
  );
  signal?.throwIfAborted();
  if (
    page.pagination.offset !== request.offset ||
    page.pagination.count !== page.items.length ||
    page.pagination.total < request.offset + page.items.length ||
    (page.pagination.hasMore && !page.items.length) ||
    new Set(page.items.map((chart) => chart.id)).size !== page.items.length ||
    page.items.some(
      (chart) =>
        chart.isDeleted ||
        (request.moduleId && chart.moduleId !== request.moduleId),
    )
  )
    throw new ApiContractError();
  return page;
}

/** A detail read is fresh per result request, never an authority-bearing cache. */
export async function getOpenViewChart(
  id: string,
  signal?: AbortSignal,
): Promise<SavedChart> {
  const requested = uuid.parse(id);
  try {
    const chart = await apiFetch(`/charts/${requested}`, chartSchema, {
      cache: "no-store",
      signal,
    });
    signal?.throwIfAborted();
    if (chart.id !== requested) throw new ApiContractError();
    if (chart.isDeleted)
      throw new ApiError(
        404,
        "Saved Chart is unavailable",
        undefined,
        "chart_source_unavailable",
      );
    return chart;
  } catch (error) {
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
      throw new ApiError(
        error.status,
        "Saved Chart is unavailable",
        undefined,
        "chart_source_unavailable",
      );
    }
    throw error;
  }
}

export function chartMatchesWidget(
  chart: SavedChart,
  widgetType: OpenViewDashboardWidgetType,
  moduleId?: string,
): boolean {
  return (
    (!moduleId || moduleId === chart.moduleId) &&
    (widgetType === "chart"
      ? ["bar", "line", "pie"].includes(chart.chartType)
      : chart.chartType === widgetType)
  );
}

export function chartSourceStamp(chart: SavedChart): string {
  return JSON.stringify([
    chart.id,
    chart.revision,
    chart.moduleId,
    chart.chartType,
    chart.name,
    chart.config,
  ]);
}
