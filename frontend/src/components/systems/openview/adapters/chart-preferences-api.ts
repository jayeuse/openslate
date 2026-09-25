import { z } from "zod";
import { apiFetch } from "@/lib/api";
import type { OpenViewQueryDefinition } from "./views-api";

const uuidSchema = z.string().uuid();
const fieldTypeSchema = z.enum([
  "text",
  "long_text",
  "email",
  "url",
  "number",
  "decimal",
  "int",
  "boolean",
  "date",
  "datetime",
  "select",
]);
const scalarSchema = z.union([
  z.string().max(4000),
  z.boolean(),
  z.number().finite(),
]);
const preferenceFilterSchema = z
  .object({
    fieldId: uuidSchema,
    expectedType: fieldTypeSchema,
    operator: z.enum([
      "eq",
      "neq",
      "lt",
      "lte",
      "gt",
      "gte",
      "contains",
      "prefix",
      "suffix",
      "in",
      "empty",
      "not_empty",
      "blank",
      "not_blank",
    ]),
    value: z
      .union([scalarSchema, z.array(scalarSchema).min(1).max(100)])
      .nullish(),
  })
  .strict();

const preferenceConfigSchema = z
  .object({
    version: z.literal(1),
    moduleId: uuidSchema,
    chartType: z.enum(["bar", "line", "pie"]),
    dimensionId: uuidSchema.nullable(),
    dateFieldId: uuidSchema.nullable(),
    aggregation: z.enum(["count", "sum", "average"]),
    measureId: uuidSchema.nullable(),
    filterLogic: z.enum(["and", "or"]),
    filters: z.array(preferenceFilterSchema).max(10),
    fromDate: z.iso.date().nullable(),
    toDate: z.iso.date().nullable(),
    top: z
      .union([z.literal(5), z.literal(10), z.literal(20), z.literal(50)])
      .nullable(),
    showLegend: z.boolean(),
    showValues: z.boolean(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.aggregation === "count" && config.measureId !== null) {
      context.addIssue({
        code: "custom",
        message: "Count does not use a measure",
      });
    } else if (config.aggregation !== "count" && config.measureId === null) {
      context.addIssue({
        code: "custom",
        message: "Aggregation requires a measure",
      });
    }
    if ((config.fromDate === null) !== (config.toDate === null)) {
      context.addIssue({
        code: "custom",
        message: "Date windows require both bounds",
      });
    }
    if (
      (config.fromDate !== null || config.toDate !== null) &&
      config.dateFieldId === null
    ) {
      context.addIssue({
        code: "custom",
        message: "Date windows require a date field",
      });
    }
    if (config.fromDate !== null && config.toDate !== null) {
      const start = Date.parse(`${config.fromDate}T00:00:00Z`);
      const end = Date.parse(`${config.toDate}T00:00:00Z`);
      const days = (end - start) / 86_400_000 + 1;
      if (!Number.isFinite(days) || days < 1 || days > 366) {
        context.addIssue({
          code: "custom",
          message: "Date window is outside its allowed range",
        });
      }
    }
    if (config.chartType === "line") {
      if (
        config.dimensionId !== null ||
        config.dateFieldId === null ||
        config.fromDate === null ||
        config.toDate === null ||
        config.top !== null
      ) {
        context.addIssue({
          code: "custom",
          message: "Line chart settings are incomplete",
        });
      }
    } else if (config.dimensionId === null) {
      context.addIssue({
        code: "custom",
        message: "Categorical chart requires a dimension",
      });
    }
  });

const wirePreferenceFilterSchema = z
  .object({
    field_id: uuidSchema,
    expected_type: fieldTypeSchema,
    operator: preferenceFilterSchema.shape.operator,
    value: preferenceFilterSchema.shape.value,
  })
  .strict()
  .transform(({ field_id, expected_type, ...filter }) => ({
    fieldId: field_id,
    expectedType: expected_type,
    ...filter,
  }));
const wirePreferenceConfigSchema = z
  .object({
    version: z.literal(1),
    module_id: uuidSchema,
    chart_type: z.enum(["bar", "line", "pie"]),
    dimension_id: uuidSchema.nullable(),
    date_field_id: uuidSchema.nullable(),
    aggregation: z.enum(["count", "sum", "average"]),
    measure_id: uuidSchema.nullable(),
    filter_logic: z.enum(["and", "or"]),
    filters: z.array(wirePreferenceFilterSchema).max(10),
    from_date: z.iso.date().nullable(),
    to_date: z.iso.date().nullable(),
    top: z
      .union([z.literal(5), z.literal(10), z.literal(20), z.literal(50)])
      .nullable(),
    show_legend: z.boolean(),
    show_values: z.boolean(),
  })
  .strict()
  .transform(
    ({
      module_id,
      chart_type,
      dimension_id,
      date_field_id,
      measure_id,
      filter_logic,
      from_date,
      to_date,
      show_legend,
      show_values,
      ...config
    }) => ({
      ...config,
      moduleId: module_id,
      chartType: chart_type,
      dimensionId: dimension_id,
      dateFieldId: date_field_id,
      measureId: measure_id,
      filterLogic: filter_logic,
      fromDate: from_date,
      toDate: to_date,
      showLegend: show_legend,
      showValues: show_values,
    }),
  )
  .pipe(preferenceConfigSchema);

export type OpenViewChartPreferenceConfig = z.infer<
  typeof preferenceConfigSchema
> & {
  filters: OpenViewQueryDefinition["filters"];
};

export type OpenViewChartPreferences = {
  config: OpenViewChartPreferenceConfig | null;
};

const wireResponseSchema = z
  .object({ config: wirePreferenceConfigSchema.nullable() })
  .strict()
  .transform(({ config }) => ({ config }));

function wireConfig(config: OpenViewChartPreferenceConfig) {
  const parsed = preferenceConfigSchema.parse(config);
  return {
    version: parsed.version,
    module_id: parsed.moduleId,
    chart_type: parsed.chartType,
    dimension_id: parsed.dimensionId,
    date_field_id: parsed.dateFieldId,
    aggregation: parsed.aggregation,
    measure_id: parsed.measureId,
    filter_logic: parsed.filterLogic,
    filters: parsed.filters.map((filter) => ({
      field_id: filter.fieldId,
      expected_type: filter.expectedType,
      operator: filter.operator,
      ...(filter.value === undefined ? {} : { value: filter.value }),
    })),
    from_date: parsed.fromDate,
    to_date: parsed.toDate,
    top: parsed.top,
    show_legend: parsed.showLegend,
    show_values: parsed.showValues,
  };
}

export async function getOpenViewChartPreferences(): Promise<OpenViewChartPreferences> {
  return apiFetch("/charts/preferences", wireResponseSchema);
}

export async function putOpenViewChartPreferences(
  config: OpenViewChartPreferenceConfig,
): Promise<OpenViewChartPreferences> {
  return apiFetch("/charts/preferences", wireResponseSchema, {
    method: "PUT",
    body: JSON.stringify({ config: wireConfig(config) }),
  });
}
