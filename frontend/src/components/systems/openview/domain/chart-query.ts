import {
  serializeOpenViewQueryDefinition,
  type OpenViewQueryFieldReference,
  type OpenViewQueryFilter,
  type OpenViewDataSourceField,
  type OpenViewQueryDefinition,
} from "../adapters/views-api";
import {
  dashboardWidgetConfigInputSchema,
  type OpenViewDashboardChartConfig,
  type OpenViewDashboardAggregateConfig,
  type OpenViewDashboardRecordsConfig,
} from "../adapters/dashboards-api";
import {
  validAggregateBucketWindow,
  type AggregateBucket,
} from "./aggregate-buckets";

export type ChartType = "bar" | "line" | "pie";
export type Aggregation =
  "count" | "sum" | "average" | "min" | "max" | "distinct";
export function aggregationLabel(aggregation: Aggregation): string {
  const labels: Record<Aggregation, string> = {
    count: "Count",
    sum: "Sum",
    average: "Average",
    min: "Minimum",
    max: "Maximum",
    distinct: "Distinct",
  };
  return labels[aggregation];
}

export type FilterLogic = OpenViewQueryDefinition["logic"];
export type FilterOperator =
  OpenViewQueryDefinition["filters"][number]["operator"];
export type FilterDraft = {
  id: number;
  fieldId: string;
  operator: FilterOperator;
  value: string;
};

export const NUMERIC_TYPES = new Set(["number", "decimal", "int"]);
export const CATEGORICAL_TYPES = new Set([
  "text",
  "long_text",
  "email",
  "url",
  "select",
  "user",
  "boolean",
]);
export const EMPTY_OPERATORS = new Set<FilterOperator>([
  "empty",
  "not_empty",
  "blank",
  "not_blank",
]);
export const COMMON_FILTER_OPERATORS: FilterOperator[] = [
  "eq",
  "neq",
  "empty",
  "not_empty",
  "blank",
  "not_blank",
];

export function isNumericField(field: OpenViewDataSourceField): boolean {
  return NUMERIC_TYPES.has(field.type);
}

export function isCategoricalField(field: OpenViewDataSourceField): boolean {
  return CATEGORICAL_TYPES.has(field.type);
}

/**
 * The field a new chart groups by: a choice first, then a person, then yes or
 * no. Free text groups one bar per record, so it is never picked for you; with
 * nothing better the chart waits for its Group by.
 */
export function defaultDimension(
  fields: readonly OpenViewDataSourceField[],
): OpenViewDataSourceField | undefined {
  for (const type of ["select", "user", "boolean"])
    for (const field of fields) if (field.type === type) return field;
  return undefined;
}

export function operatorsFor(field: OpenViewDataSourceField): FilterOperator[] {
  if (["text", "long_text", "email", "url"].includes(field.type)) {
    return [...COMMON_FILTER_OPERATORS, "contains", "prefix", "suffix"];
  }
  if (field.type === "select") return [...COMMON_FILTER_OPERATORS, "contains"];
  if (field.type === "user") return COMMON_FILTER_OPERATORS;
  if (
    NUMERIC_TYPES.has(field.type) ||
    ["date", "datetime"].includes(field.type)
  ) {
    return [...COMMON_FILTER_OPERATORS, "lt", "lte", "gt", "gte"];
  }
  return COMMON_FILTER_OPERATORS;
}

export function operatorLabel(operator: FilterOperator): string {
  const labels: Record<FilterOperator, string> = {
    eq: "Is",
    neq: "Is not",
    lt: "Less than",
    lte: "At most",
    gt: "Greater than",
    gte: "At least",
    contains: "Contains",
    prefix: "Starts with",
    suffix: "Ends with",
    in: "Is one of",
    empty: "Is empty",
    not_empty: "Is not empty",
    blank: "Is blank",
    not_blank: "Is not blank",
  };
  return labels[operator];
}

export function canonicalDecimal(value: string): string | null {
  if (value.length > 58) return null;
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (!match) return null;
  const [, sign, integerPart, rawFraction = ""] = match;
  if (integerPart.length > 38 || rawFraction.length > 18) return null;
  const fraction = rawFraction.replace(/0+$/, "");
  const negative = sign === "-" && !(integerPart === "0" && !fraction);
  return `${negative ? "-" : ""}${integerPart}${fraction ? `.${fraction}` : ""}`;
}

export function isValidInteger(value: string): boolean {
  return (
    /^-?(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))
  );
}

export function scalarForFilter(
  field: OpenViewDataSourceField,
  value: string,
): string | number | boolean {
  if (field.type === "decimal") return canonicalDecimal(value) ?? value;
  if (NUMERIC_TYPES.has(field.type)) return Number(value);
  if (field.type === "boolean") return value === "true";
  return value;
}

// Editor-only row identity and raw input never enter a saved/wire definition.
// The original typed filter keeps null/omitted values and membership arrays
// lossless until that row is edited; metadata is not a substitute for its type.
export type EditorFilterDraft = FilterDraft & {
  expectedType: OpenViewQueryFieldReference["expectedType"];
  original: OpenViewQueryFilter | null;
};
type EditorQueryDraft = {
  moduleId: string;
  definition: Omit<OpenViewQueryDefinition, "filters">;
  filters: EditorFilterDraft[];
  nextFilterId: number;
};
type EditorAggregateDraft = EditorQueryDraft & {
  aggregation: Aggregation;
  measure: OpenViewQueryFieldReference | null;
  dateField: OpenViewQueryFieldReference | null;
  fromDate: string;
  toDate: string;
};
export type ChartEditorDraft =
  | (EditorAggregateDraft & {
      mode: "groups";
      dimension: OpenViewQueryFieldReference | null;
    } & (
        | { widgetType: "chart"; chartType: "bar" | "pie" }
        | { widgetType: "summary" | "workload" }
      ))
  | (EditorAggregateDraft & {
      mode: "date_series";
      widgetType: "chart";
      chartType: "line";
      bucket: AggregateBucket;
    })
  | (EditorQueryDraft & { mode: "records"; widgetType: "records" });

// These are the actual E config families, not another permissive DTO/schema.
export type InlineChartEditorValue =
  | { widgetType: "chart"; config: OpenViewDashboardChartConfig }
  | {
      widgetType: "summary" | "workload";
      config: OpenViewDashboardAggregateConfig;
    }
  | { widgetType: "records"; config: OpenViewDashboardRecordsConfig };

// Switching source never destroys the caller's incomplete inline instructions.
// A saved source stores only its ID; resolved definitions are result metadata.
export type ChartSourceDraft = {
  inline: ChartEditorDraft;
  chartId: string | null;
};

export function changeChartEditorWidgetType(
  value: ChartEditorDraft,
  widgetType: ChartEditorDraft["widgetType"],
  fields: OpenViewDataSourceField[],
): ChartEditorDraft {
  if (value.widgetType === widgetType) return value;
  const base = {
    moduleId: value.moduleId,
    definition: value.definition,
    filters: value.filters,
    nextFilterId: value.nextFilterId,
  };
  if (widgetType === "records") return { ...base, widgetType, mode: "records" };
  const initial = newChartEditorDraft(value.moduleId, fields);
  if (initial.mode !== "groups") throw new Error("A new chart is grouped");
  const aggregate = value.mode === "records" ? initial : value;
  const grouped = {
    ...base,
    mode: "groups" as const,
    aggregation: aggregate.aggregation,
    measure: aggregate.measure,
    dateField: aggregate.dateField,
    fromDate: aggregate.fromDate,
    toDate: aggregate.toDate,
    dimension:
      aggregate.mode === "groups" ? aggregate.dimension : initial.dimension,
  };
  return widgetType === "chart"
    ? { ...grouped, widgetType, chartType: "bar" }
    : { ...grouped, widgetType };
}

export function editorFieldReference(
  field: OpenViewDataSourceField,
): OpenViewQueryFieldReference {
  return { fieldId: field.id, expectedType: field.type };
}

export function editorField(
  reference: OpenViewQueryFieldReference | null,
  fields: OpenViewDataSourceField[],
): OpenViewDataSourceField | undefined {
  return fields.find(
    (field) =>
      field.id === reference?.fieldId && field.type === reference.expectedType,
  );
}

function filterInput(filter: OpenViewQueryFilter): string {
  return Array.isArray(filter.value)
    ? JSON.stringify(filter.value)
    : filter.value == null
      ? ""
      : String(filter.value);
}

export function chartEditorDraftFrom(
  value: InlineChartEditorValue,
): ChartEditorDraft {
  const { filters, ...definition } = value.config.query.definition;
  const base: EditorQueryDraft = {
    moduleId: value.config.query.moduleId,
    definition,
    filters: filters.map((filter, id) => ({
      ...filter,
      id,
      value: filterInput(filter),
      original: filter,
    })),
    nextFilterId: filters.length,
  };
  if (value.widgetType === "records")
    return { ...base, widgetType: "records", mode: "records" };
  const query = value.config.query;
  if (
    value.widgetType === "chart" &&
    (value.config.chartType === "line") !== (query.mode === "date_series")
  )
    throw new Error("Chart type and query family must match");
  const aggregate: EditorAggregateDraft = {
    ...base,
    aggregation: query.aggregation,
    measure: query.measure ?? null,
    dateField: query.dateField ?? null,
    fromDate: query.fromDate ?? "",
    toDate: query.toDate ?? "",
  };
  if (value.widgetType === "chart" && query.mode === "date_series") {
    return {
      ...aggregate,
      widgetType: "chart",
      chartType: "line",
      mode: "date_series",
      bucket: query.bucket ?? "day",
    };
  }
  if (query.mode !== "groups")
    throw new Error("Grouped widgets require a grouped query");
  const grouped = {
    ...aggregate,
    widgetType: value.widgetType,
    mode: "groups" as const,
    dimension: query.dimension,
  };
  return value.widgetType === "chart"
    ? {
        ...grouped,
        widgetType: "chart",
        chartType: value.config.chartType === "pie" ? "pie" : "bar",
      }
    : { ...grouped, widgetType: value.widgetType };
}

export function newChartEditorDraft(
  moduleId: string,
  fields: OpenViewDataSourceField[],
): ChartEditorDraft {
  const dimension = defaultDimension(fields);
  return {
    widgetType: "chart",
    chartType: "bar",
    mode: "groups",
    moduleId,
    definition: {
      version: 1,
      logic: "and",
      columns: [],
      sort: [],
      deleted: "exclude",
      search: null,
      searchFields: [],
    },
    filters: [],
    nextFilterId: 0,
    aggregation: "count",
    measure: null,
    dimension: dimension ? editorFieldReference(dimension) : null,
    dateField: null,
    fromDate: "",
    toDate: "",
  };
}

function compileEditorFilter(
  row: EditorFilterDraft,
  fields: OpenViewDataSourceField[],
): OpenViewQueryFilter | null {
  const reference = { fieldId: row.fieldId, expectedType: row.expectedType };
  const field = editorField(reference, fields);
  if (!field) return null;
  const original = row.original;
  if (
    original &&
    original.fieldId === row.fieldId &&
    original.expectedType === row.expectedType &&
    original.operator === row.operator &&
    filterInput(original) === row.value
  )
    return original;
  if (EMPTY_OPERATORS.has(row.operator))
    return { ...reference, operator: row.operator };
  if (row.operator === "in") {
    try {
      const value: unknown = JSON.parse(row.value);
      if (
        !Array.isArray(value) ||
        !value.every(
          (item): item is string | number | boolean =>
            typeof item === "string" ||
            typeof item === "boolean" ||
            (typeof item === "number" && Number.isFinite(item)),
        )
      )
        return null;
      return { ...reference, operator: "in", value };
    } catch {
      return null;
    }
  }
  if (!operatorsFor(field).includes(row.operator) || !row.value.trim())
    return null;
  if (field.type === "decimal" && canonicalDecimal(row.value) === null)
    return null;
  if (field.type === "int" && !isValidInteger(row.value)) return null;
  if (field.type === "number" && !Number.isFinite(Number(row.value)))
    return null;
  if (field.type === "boolean" && !["true", "false"].includes(row.value))
    return null;
  return {
    ...reference,
    operator: row.operator,
    value: scalarForFilter(field, row.value),
  };
}

export function editorFilterValidation(
  value: ChartEditorDraft,
  fields: OpenViewDataSourceField[],
): EditorFilterDraft | undefined {
  return value.filters.find((row) => !compileEditorFilter(row, fields));
}

export function editorDateWindowValid(value: ChartEditorDraft): boolean {
  if (value.mode === "records") return true;
  if (
    value.mode === "groups" &&
    ![value.dateField, value.fromDate, value.toDate].some(Boolean)
  )
    return true;
  const bucket = value.mode === "date_series" ? value.bucket : "day";
  return (
    value.dateField !== null &&
    validAggregateBucketWindow(value.fromDate, value.toDate, bucket)
  );
}

export function compileChartEditorDraft(
  value: ChartEditorDraft,
  catalog: OpenViewDataSourceField[],
): InlineChartEditorValue | null {
  const fields = catalog.filter((field) => field.moduleId === value.moduleId);
  const filters = value.filters.map((row) => compileEditorFilter(row, fields));
  if (filters.some((filter) => filter === null)) return null;
  const definition: OpenViewQueryDefinition = {
    ...value.definition,
    filters: filters.filter(
      (filter): filter is OpenViewQueryFilter => filter !== null,
    ),
  };
  if (
    [
      ...definition.columns,
      ...definition.sort,
      ...definition.searchFields,
    ].some((ref) => !editorField(ref, fields))
  )
    return null;
  try {
    // Reuse the authoritative full grammar, including ordered records fields.
    serializeOpenViewQueryDefinition(definition);
    let output: InlineChartEditorValue;
    if (value.mode === "records") {
      output = {
        widgetType: "records",
        config: {
          version: 1,
          query: { moduleId: value.moduleId, definition },
        },
      };
    } else {
      if (!editorDateWindowValid(value)) return null;
      if (value.dateField && !editorField(value.dateField, fields)) return null;
      if (
        value.aggregation !== "count" &&
        (!editorField(value.measure, fields) ||
          (value.aggregation !== "distinct" &&
            !NUMERIC_TYPES.has(value.measure!.expectedType)))
      )
        return null;
      const base = {
        moduleId: value.moduleId,
        definition,
        aggregation: value.aggregation,
        ...(value.aggregation === "count" ? {} : { measure: value.measure! }),
      };
      const window = {
        dateField: value.dateField!,
        fromDate: value.fromDate,
        toDate: value.toDate,
      };
      let query: OpenViewDashboardChartConfig["query"];
      if (value.mode === "date_series") {
        query = {
          ...base,
          ...window,
          mode: "date_series",
          bucket: value.bucket,
        };
      } else {
        const dimension = editorField(value.dimension, fields);
        if (!dimension || !isCategoricalField(dimension)) return null;
        query = {
          ...base,
          mode: "groups",
          dimension: value.dimension!,
          ...(value.dateField ? window : {}),
        };
      }
      if (value.widgetType === "chart")
        output = {
          widgetType: "chart",
          config: { version: 1, chartType: value.chartType, query },
        };
      else if (query.mode === "groups")
        output = {
          widgetType: value.widgetType,
          config: { version: 1, query },
        };
      else return null;
    }
    return dashboardWidgetConfigInputSchema.safeParse(output.config).success
      ? output
      : null;
  } catch {
    return null;
  }
}
