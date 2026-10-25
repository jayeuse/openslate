/**
 * The chart builder's draft by "Show as" kind (BD10). The builder edits the
 * same ChartEditorDraft the Charts page did; these rules only turn one kind
 * into another and fill the fields a kind needs from the module's fields.
 */
import type { OpenViewDataSourceField } from "../adapters/views-api";
import {
  changeChartEditorWidgetType,
  editorFieldReference,
  isCategoricalField,
  newChartEditorDraft,
  type ChartEditorDraft,
} from "./chart-query";
import type { WidgetKind } from "./dashboard-grid";

export function draftKind(draft: ChartEditorDraft): WidgetKind {
  if (draft.widgetType === "summary") return "number";
  if (draft.widgetType === "workload") return "table";
  if (draft.widgetType === "records") return "records";
  if (draft.mode === "date_series") return "line";
  return draft.mode === "groups" && draft.widgetType === "chart"
    ? draft.chartType
    : "bar";
}

function dateFields(fields: readonly OpenViewDataSourceField[]) {
  return fields.filter((field) => ["date", "datetime"].includes(field.type));
}

/** Twelve weeks up to `today` (YYYY-MM-DD): a new line's first window. */
export function lastTwelveWeeks(today: string) {
  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end.getTime() - 83 * 24 * 60 * 60 * 1000);
  return { fromDate: start.toISOString().slice(0, 10), toDate: today };
}

/** The draft shown as another kind; filters and the module stay. */
export function draftForKind(
  draft: ChartEditorDraft,
  kind: WidgetKind,
  fields: readonly OpenViewDataSourceField[],
  today?: string,
): ChartEditorDraft {
  const list = [...fields];
  if (kind === "records")
    return fillDraft(
      changeChartEditorWidgetType(draft, "records", list),
      fields,
    );
  if (kind === "number" || kind === "table") {
    const next = changeChartEditorWidgetType(
      draft,
      kind === "number" ? "summary" : "workload",
      list,
    );
    // A number adds its groups up, so only additive measures stay (numberValue).
    if (
      kind === "number" &&
      next.mode === "groups" &&
      (next.aggregation === "average" || next.aggregation === "distinct")
    )
      return fillDraft(
        { ...next, aggregation: "count", measure: null },
        fields,
      );
    return fillDraft(next, fields);
  }
  const chart =
    draft.widgetType === "chart"
      ? draft
      : changeChartEditorWidgetType(draft, "chart", list);
  if (chart.widgetType !== "chart") return chart;
  const base = {
    moduleId: chart.moduleId,
    definition: chart.definition,
    filters: chart.filters,
    nextFilterId: chart.nextFilterId,
    aggregation: chart.aggregation,
    measure: chart.measure,
    fromDate: chart.fromDate,
    toDate: chart.toDate,
    dateField: chart.dateField,
  };
  if (kind === "line")
    return fillDraft(
      {
        ...base,
        ...(today && !(base.fromDate && base.toDate)
          ? lastTwelveWeeks(today)
          : {}),
        widgetType: "chart",
        chartType: "line",
        mode: "date_series",
        bucket: chart.mode === "date_series" ? chart.bucket : "week",
      },
      fields,
    );
  return fillDraft(
    {
      ...base,
      widgetType: "chart",
      chartType: kind === "pie" ? "pie" : "bar",
      mode: "groups",
      dimension: chart.mode === "groups" ? chart.dimension : null,
    },
    fields,
  );
}

/**
 * Fill what the kind needs and the draft lacks: the first category to group
 * by, the first date field of a line, and the first three columns of a list.
 */
export function fillDraft(
  draft: ChartEditorDraft,
  fields: readonly OpenViewDataSourceField[],
): ChartEditorDraft {
  const own = fields.filter((field) => field.moduleId === draft.moduleId);
  if (!own.length) return draft;
  if (draft.mode === "records")
    return draft.definition.columns.length
      ? draft
      : {
          ...draft,
          definition: {
            ...draft.definition,
            columns: own.slice(0, 3).map(editorFieldReference),
          },
        };
  if (draft.mode === "date_series") {
    if (draft.dateField) return draft;
    const date = dateFields(own)[0];
    return date ? { ...draft, dateField: editorFieldReference(date) } : draft;
  }
  if (draft.dimension) return draft;
  const category = own.find(isCategoricalField);
  return category
    ? { ...draft, dimension: editorFieldReference(category) }
    : draft;
}

/** A fresh draft of a kind on a module. */
export function newKindDraft(
  moduleId: string,
  kind: WidgetKind,
  fields: readonly OpenViewDataSourceField[],
  today?: string,
): ChartEditorDraft {
  return draftForKind(newChartEditorDraft(moduleId, []), kind, fields, today);
}

/** The same kind on another module; its fields and filters start over. */
export function draftOnModule(
  draft: ChartEditorDraft,
  moduleId: string,
  fields: readonly OpenViewDataSourceField[],
  today?: string,
): ChartEditorDraft {
  return newKindDraft(moduleId, draftKind(draft), fields, today);
}
