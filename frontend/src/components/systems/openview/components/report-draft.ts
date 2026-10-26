import Papa from "papaparse";
import type {
  OpenViewReport,
  OpenViewReportRecipe,
} from "../adapters/reports-api";

export class ReportDraftError extends Error {}

export type ReportFilterDraft = {
  key: string;
  fieldId: string;
  expectedType: OpenViewReportRecipe["fields"][number]["expectedType"];
  operator: OpenViewReportRecipe["filters"][number]["operator"];
  value: string;
  originalValue?: OpenViewReportRecipe["filters"][number]["value"];
  originalText?: string;
};

export type ReportDraft = {
  moduleId: string;
  name: string;
  subtitle: string;
  fields: OpenViewReportRecipe["fields"];
  filters: ReportFilterDraft[];
  logic: OpenViewReportRecipe["logic"];
  sorts: OpenViewReportRecipe["sorts"];
  groupBy: OpenViewReportRecipe["groupBy"];
  includeRowCount: boolean;
};

export function emptyReportDraft(moduleId = ""): ReportDraft {
  return {
    moduleId,
    name: "",
    subtitle: "",
    fields: [],
    filters: [],
    logic: "and",
    sorts: [],
    groupBy: null,
    includeRowCount: false,
  };
}

const VALUELESS_OPERATORS = new Set([
  "empty",
  "not_empty",
  "blank",
  "not_blank",
]);

export function reportDraftFrom(report: OpenViewReport): ReportDraft {
  return draftFromRecipe(
    report.moduleId,
    report.name,
    report.subtitle ?? "",
    report.recipe,
  );
}

function draftFromRecipe(
  moduleId: string,
  name: string,
  subtitle: string,
  recipe: OpenViewReportRecipe,
): ReportDraft {
  return {
    moduleId,
    name,
    subtitle,
    fields: recipe.fields.map((field) => ({ ...field })),
    filters: recipe.filters.map((filter, index) => {
      const value = Array.isArray(filter.value)
        ? filter.value.join(", ")
        : filter.value === null || filter.value === undefined
          ? ""
          : String(filter.value);
      return {
        key: `${filter.fieldId}-${index}`,
        fieldId: filter.fieldId,
        expectedType: filter.expectedType,
        operator: filter.operator,
        value,
        originalValue: filter.value,
        originalText: value,
      };
    }),
    logic: recipe.logic,
    sorts: recipe.sorts.map((sort) => ({ ...sort })),
    groupBy: recipe.groupBy ? { ...recipe.groupBy } : null,
    includeRowCount: recipe.includeRowCount,
  };
}

/** What a module page's current view holds, for "Make a report from this view". */
export type ReportViewSource = {
  name: string;
  columns: OpenViewReportRecipe["fields"];
  filters: Array<
    Omit<OpenViewReportRecipe["filters"][number], "value"> & {
      value?: OpenViewReportRecipe["filters"][number]["value"];
    }
  >;
  logic: OpenViewReportRecipe["logic"];
  sort: OpenViewReportRecipe["sorts"];
  groupBy: OpenViewReportRecipe["groupBy"];
};

/**
 * The recipe of the view a person is looking at (DC7): its columns, its
 * finished filters, its first three sorts and its grouping. The view's search
 * has no place in a recipe, so it is left out.
 */
export function reportDraftFromView(
  moduleId: string,
  view: ReportViewSource,
): ReportDraft {
  const filters = view.filters.flatMap((filter) =>
    VALUELESS_OPERATORS.has(filter.operator) ||
    (filter.value !== undefined &&
      filter.value !== null &&
      filter.value !== "" &&
      !(Array.isArray(filter.value) && filter.value.length === 0))
      ? [{ ...filter, value: filter.value ?? null }]
      : [],
  );
  return draftFromRecipe(moduleId, view.name, "", {
    version: 1,
    fields: view.columns.slice(0, 100),
    filters: filters.slice(0, 10),
    logic: view.logic,
    sorts: view.sort.slice(0, 3),
    groupBy: view.groupBy,
    includeRowCount: false,
  });
}

export function reportDraftSignature(draft: ReportDraft): string {
  return JSON.stringify({
    moduleId: draft.moduleId,
    name: draft.name,
    subtitle: draft.subtitle,
    fields: draft.fields,
    filters: draft.filters.map((filter) => ({
      fieldId: filter.fieldId,
      expectedType: filter.expectedType,
      operator: filter.operator,
      value: filter.value,
    })),
    logic: draft.logic,
    sorts: draft.sorts,
    groupBy: draft.groupBy,
    includeRowCount: draft.includeRowCount,
  });
}

function filterValue(filter: ReportFilterDraft) {
  if (
    filter.originalText !== undefined &&
    filter.value === filter.originalText
  ) {
    return filter.originalValue;
  }
  if (VALUELESS_OPERATORS.has(filter.operator)) return null;
  const value = filter.value.trim();
  if (!value || value.length > 4000) {
    throw new ReportDraftError("Enter a value for each Report filter");
  }
  if (filter.operator === "in") {
    const parsed = Papa.parse<string[]>(value, {
      delimiter: ",",
      skipEmptyLines: false,
    });
    const choices = parsed.data[0]?.map((choice) => choice.trim()) ?? [];
    if (
      filter.expectedType !== "select" ||
      parsed.errors.length > 0 ||
      parsed.data.length !== 1 ||
      choices.some((choice) => !choice) ||
      choices.length > 100
    ) {
      throw new ReportDraftError(
        "Enter comma-separated choices for membership filters",
      );
    }
    return choices;
  }
  if (filter.expectedType === "boolean") {
    if (value !== "true" && value !== "false") {
      throw new ReportDraftError("Choose true or false for Boolean filters");
    }
    return value === "true";
  }
  if (filter.expectedType === "int") {
    if (
      !/^-?(0|[1-9][0-9]*)$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    ) {
      throw new ReportDraftError(
        "Enter a valid number for each numeric filter",
      );
    }
    return Number(value);
  }
  if (filter.expectedType === "number") {
    if (!Number.isFinite(Number(value))) {
      throw new ReportDraftError(
        "Enter a valid number for each numeric filter",
      );
    }
    return Number(value);
  }
  if (filter.expectedType === "decimal") {
    if (!/^-?(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
      throw new ReportDraftError(
        "Enter a valid number for each numeric filter",
      );
    }
    return value;
  }
  return filter.value;
}

export function reportRecipeFromDraft(
  draft: ReportDraft,
): OpenViewReportRecipe {
  if (draft.fields.length < 1) {
    throw new ReportDraftError("Choose at least one Report field");
  }
  if (
    draft.fields.length > 100 ||
    draft.filters.length > 10 ||
    draft.sorts.length > 3
  ) {
    throw new ReportDraftError(
      "The Report has too many fields, filters, or sorts",
    );
  }
  if (
    new Set(draft.fields.map((field) => field.fieldId)).size !==
      draft.fields.length ||
    new Set(draft.sorts.map((sort) => sort.fieldId)).size !== draft.sorts.length
  ) {
    throw new ReportDraftError("Choose each Report field or sort only once");
  }
  return {
    version: 1,
    fields: draft.fields,
    filters: draft.filters.map((filter) => ({
      fieldId: filter.fieldId,
      expectedType: filter.expectedType,
      operator: filter.operator,
      value: filterValue(filter),
    })),
    logic: draft.logic,
    sorts: draft.sorts,
    groupBy: draft.groupBy,
    includeRowCount: draft.includeRowCount,
  };
}
