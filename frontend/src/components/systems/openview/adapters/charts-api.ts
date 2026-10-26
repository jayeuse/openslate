import { z } from "zod";
import { ApiContractError, ApiError, apiFetch } from "@/lib/api";
import { listSchema } from "./views-schemas";
import { openViewReadFetch } from "./openview-access";
import {
  dashboardWidgetWireConfigSchema,
  serializeDashboardWidgetConfig,
  type OpenViewDashboardWidgetType,
} from "./dashboard-widget-config";
import type { InlineChartEditorValue } from "../domain/chart-query";

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
    deleted: z.enum(["exclude", "include", "only"]).default("exclude"),
  })
  .strict();

/** Picker metadata only. A result or write must resolve its selected ID afresh. */
export async function listOpenViewCharts(
  options: {
    limit?: number;
    offset?: number;
    search?: string;
    moduleId?: string;
    deleted?: "exclude" | "include" | "only";
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
    deleted: request.deleted,
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
        (request.deleted === "exclude" && chart.isDeleted) ||
        (request.deleted === "only" && !chart.isDeleted) ||
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
  const chart = await readOpenViewChart(id, signal);
  if (chart.isDeleted)
    throw new ApiError(
      404,
      "Saved Chart is unavailable",
      undefined,
      "chart_source_unavailable",
    );
  return chart;
}

/** Management can read an archived object, but it can never run as a source. */
export async function readOpenViewChart(
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

const chartName = z.string().trim().min(1).max(120);
const revisionSchema = z.number().int().min(1);
function definitionBody(input: InlineChartEditorValue) {
  const config = serializeDashboardWidgetConfig(input.widgetType, input.config);
  return {
    chart_type:
      input.widgetType === "chart" ? input.config.chartType : input.widgetType,
    query: config.query,
  };
}

export async function createOpenViewChart(
  name: string,
  input: InlineChartEditorValue,
) {
  const body = {
    module_id: uuid.parse(input.config.query.moduleId),
    name: chartName.parse(name),
    ...definitionBody(input),
  };
  const chart = await apiFetch("/charts", chartSchema, {
    method: "POST",
    body: JSON.stringify(body),
    refreshOnUnauthorized: false,
  });
  if (
    chart.isDeleted ||
    chart.moduleId !== body.module_id ||
    chart.name !== body.name ||
    chart.chartType !== body.chart_type
  )
    throw new ApiContractError();
  return chart;
}

export async function updateOpenViewChart(
  id: string,
  revision: number,
  name: string,
  input: InlineChartEditorValue,
) {
  const requested = uuid.parse(id);
  const body = {
    revision: revisionSchema.parse(revision),
    name: chartName.parse(name),
    ...definitionBody(input),
  };
  const chart = await apiFetch(`/charts/${requested}`, chartSchema, {
    method: "PATCH",
    body: JSON.stringify(body),
    refreshOnUnauthorized: false,
  });
  if (
    chart.id !== requested ||
    chart.isDeleted ||
    chart.moduleId !== input.config.query.moduleId ||
    chart.revision < revision ||
    chart.name !== body.name ||
    chart.chartType !== body.chart_type
  )
    throw new ApiContractError();
  return chart;
}

export async function archiveOpenViewChart(id: string, revision: number) {
  return apiFetch(
    `/charts/${uuid.parse(id)}?revision=${revisionSchema.parse(revision)}`,
    z.null(),
    { method: "DELETE", refreshOnUnauthorized: false },
  );
}

export async function restoreOpenViewChart(id: string, revision: number) {
  const requested = uuid.parse(id);
  const chart = await apiFetch(`/charts/${requested}/restore`, chartSchema, {
    method: "POST",
    body: JSON.stringify({ revision: revisionSchema.parse(revision) }),
    refreshOnUnauthorized: false,
  });
  if (chart.id !== requested || chart.isDeleted || chart.revision <= revision)
    throw new ApiContractError();
  return chart;
}

const usageItemSchema = z
  .object({
    kind: z.literal("dashboard"),
    id: uuid,
    name: z.string().min(1),
  })
  .strict();
const usageSchema = listSchema(usageItemSchema)
  .extend({ has_restricted_usage: z.boolean() })
  .transform(({ has_restricted_usage, ...page }) => ({
    ...page,
    hasRestrictedUsage: has_restricted_usage,
  }));
export type ChartUsage = z.output<typeof usageSchema>;

export function chartArchiveUsage(error: unknown): ChartUsage | null {
  if (
    !(error instanceof ApiError) ||
    error.status !== 409 ||
    error.code !== "chart_in_use"
  )
    return null;
  const detail = z.object({ usage: usageSchema }).safeParse(error.details);
  return detail.success ? detail.data.usage : null;
}

export async function getOpenViewChartUsage(
  id: string,
  offset = 0,
  signal?: AbortSignal,
) {
  const page = await apiFetch(
    `/charts/${uuid.parse(id)}/usage?${new URLSearchParams({ limit: "25", offset: String(z.number().int().min(0).parse(offset)), sort_by: "name", sort_order: "asc" })}`,
    usageSchema,
    { signal, cache: "no-store" },
  );
  signal?.throwIfAborted();
  if (
    page.pagination.offset !== offset ||
    page.pagination.count !== page.items.length ||
    page.pagination.total < offset + page.items.length ||
    (page.pagination.hasMore && !page.items.length) ||
    new Set(page.items.map((item) => `${item.kind}:${item.id}`)).size !==
      page.items.length
  )
    throw new ApiContractError();
  return page;
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
