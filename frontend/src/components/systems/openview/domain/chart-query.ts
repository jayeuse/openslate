import type { OpenViewChartPreferenceConfig } from "../adapters/chart-preferences-api";
import type {
  OpenViewDataSourceField,
  OpenViewQueryDefinition,
} from "../adapters/views-api";

export type ChartType = "bar" | "line" | "pie";
export type Aggregation = OpenViewChartPreferenceConfig["aggregation"];
export type FilterLogic = OpenViewChartPreferenceConfig["filterLogic"];
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

export function operatorsFor(field: OpenViewDataSourceField): FilterOperator[] {
  if (["text", "long_text", "email", "url"].includes(field.type)) {
    return [...COMMON_FILTER_OPERATORS, "contains", "prefix", "suffix"];
  }
  if (field.type === "select") return [...COMMON_FILTER_OPERATORS, "contains"];
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

export function dateWindowDays(fromDate: string, toDate: string): number {
  if (!fromDate || !toDate) return 0;
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.floor((to - from) / 86_400_000) + 1;
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
