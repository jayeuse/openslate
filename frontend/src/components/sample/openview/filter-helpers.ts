import {
  FILTER_OPERATORS,
  type FilterClause,
  type FilterGroup,
  type FilterOperator,
  type OpenViewField,
  type OpenViewModule,
  type OpenViewRow,
} from "./model";

export type FilterOperatorMode = "field-compatible" | "all";

export const FILTER_OPERATOR_LABELS: Record<FilterOperator, string> = {
  contains: "contains",
  equals: "is",
  "not-equals": "is not",
  "starts-with": "starts with",
  "ends-with": "ends with",
  "on-or-after": "on or after",
  "on-or-before": "on or before",
  "is-empty": "is empty",
  "is-not-empty": "is not empty",
};

export function filterOperatorLabel(operator: FilterOperator): string {
  return FILTER_OPERATOR_LABELS[operator];
}

export function operatorsForField(field: OpenViewField): FilterOperator[] {
  if (field.type === "date") {
    return [
      "equals",
      "not-equals",
      "on-or-after",
      "on-or-before",
      "is-empty",
      "is-not-empty",
    ];
  }
  if (field.type === "number" || field.type === "boolean") {
    return ["equals", "not-equals", "is-empty", "is-not-empty"];
  }
  if (field.type === "select") {
    return ["equals", "not-equals", "contains", "is-empty", "is-not-empty"];
  }
  return [
    "contains",
    "equals",
    "not-equals",
    "starts-with",
    "ends-with",
    "is-empty",
    "is-not-empty",
  ];
}

export function inputTypeForField(
  field: OpenViewField | undefined,
): "date" | "number" | "text" {
  if (field?.type === "date") return "date";
  if (field?.type === "number") return "number";
  return "text";
}

export function valuesForFilterField(
  rows: OpenViewRow[],
  fieldId: string,
): string[] {
  return [
    ...new Set(
      rows.map((row) => String(row.values[fieldId] ?? "")).filter(Boolean),
    ),
  ].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
}

function isFilterOperator(value: unknown): value is FilterOperator {
  return (
    typeof value === "string" &&
    (FILTER_OPERATORS as readonly string[]).includes(value)
  );
}

function defaultAddOperatorForField(field: OpenViewField): FilterOperator {
  return field.type === "date" ? "on-or-after" : "contains";
}

export type FilterUpdateOptions = {
  operatorMode?: FilterOperatorMode;
  clearValueOnFieldChange?: boolean;
};

export function updateFilterClause(
  module: OpenViewModule,
  filters: FilterGroup,
  index: number,
  patch: Partial<FilterClause>,
  options: FilterUpdateOptions = {},
): FilterGroup {
  const current = filters.clauses[index];
  if (!current) return filters;

  const nextField = module.fields.find(
    (field) => field.id === (patch.field ?? current.field),
  );
  const selectedField = nextField ??
    module.fields[0] ?? { id: "", label: "", type: "text" as const };
  const allowedOperators =
    options.operatorMode === "all"
      ? [...FILTER_OPERATORS]
      : operatorsForField(selectedField);
  const nextOperator = patch.operator ?? current.operator;
  const fieldChanged =
    patch.field !== undefined && patch.field !== current.field;
  const operator = allowedOperators.includes(nextOperator)
    ? nextOperator
    : (allowedOperators[0] ?? "contains");
  const clearValue =
    fieldChanged &&
    (options.clearValueOnFieldChange === true ||
      !allowedOperators.includes(current.operator));

  return {
    ...filters,
    clauses: filters.clauses.map((clause, clauseIndex) =>
      clauseIndex === index
        ? {
            ...clause,
            ...patch,
            operator,
            value: clearValue ? "" : (patch.value ?? clause.value),
          }
        : clause,
    ),
  };
}

export type AddFilterOptions = {
  operator?: FilterOperator | ((field: OpenViewField) => FilterOperator);
};

export function addFilterClause(
  module: OpenViewModule,
  filters: FilterGroup,
  options: AddFilterOptions = {},
): FilterGroup {
  const field = module.fields[0];
  if (!field || filters.clauses.length >= 8) return filters;
  const operator =
    typeof options.operator === "function"
      ? options.operator(field)
      : (options.operator ?? defaultAddOperatorForField(field));
  return {
    ...filters,
    clauses: [...filters.clauses, { field: field.id, operator, value: "" }],
  };
}

export function normalizeFilterGroup(
  filters: FilterGroup | undefined,
  module: OpenViewModule,
  operatorMode: FilterOperatorMode = "field-compatible",
): FilterGroup {
  if (
    !filters ||
    (filters.logic !== "and" && filters.logic !== "or") ||
    !Array.isArray(filters.clauses)
  ) {
    return { logic: "and", clauses: [] };
  }
  return {
    logic: filters.logic,
    clauses: filters.clauses.slice(0, 8).flatMap((clause) => {
      const field = module.fields.find(
        (candidate) => candidate.id === clause.field,
      );
      if (!field || !isFilterOperator(clause.operator)) return [];
      const allowedOperators =
        operatorMode === "all"
          ? [...FILTER_OPERATORS]
          : operatorsForField(field);
      const operatorIsCompatible = allowedOperators.includes(clause.operator);
      const operator = operatorIsCompatible
        ? clause.operator
        : (allowedOperators[0] ?? "contains");
      return [
        {
          field: field.id,
          operator,
          value: operatorIsCompatible
            ? String(clause.value ?? "").slice(0, 240)
            : "",
        },
      ];
    }),
  };
}
