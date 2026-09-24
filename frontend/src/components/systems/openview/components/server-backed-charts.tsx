"use client";

import { Download, Printer } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { serializeCsv } from "@/lib/csv";
import {
  queryOpenViewAggregateSnapshot,
  type OpenViewAggregateSnapshotRequest,
  type OpenViewAggregateSnapshotResult,
  type OpenViewAggregateDatum,
} from "../adapters/analytics-api";
import {
  listOpenViewDataSourceFields,
  listOpenViewDataSources,
  type OpenViewDataSource,
  type OpenViewDataSourceField,
  type OpenViewQueryDefinition,
} from "../adapters/views-api";
import { OpenViewChartPreview } from "./chart-preview";

type ChartType = "bar" | "line" | "pie";
type Aggregation = OpenViewAggregateSnapshotRequest["aggregation"];
type FilterOperator = OpenViewQueryDefinition["filters"][number]["operator"];
type FilterDraft = {
  id: number;
  fieldId: string;
  operator: FilterOperator;
  value: string;
};
type AppliedSnapshot = {
  result: OpenViewAggregateSnapshotResult;
  sourceName: string;
  chartType: ChartType;
  labelName: string;
  valueName: string;
  aggregationName: string;
  signature: string;
};

const PAGE_SIZE = 25;
const MAX_CATEGORICAL_PREVIEW_POINTS = 100;
const NUMERIC_TYPES = new Set(["number", "decimal", "int"]);
const CATEGORICAL_TYPES = new Set([
  "text",
  "long_text",
  "email",
  "url",
  "select",
  "boolean",
]);
const EMPTY_OPERATORS = new Set<FilterOperator>([
  "empty",
  "not_empty",
  "blank",
  "not_blank",
]);
const COMMON_FILTER_OPERATORS: FilterOperator[] = [
  "eq",
  "neq",
  "empty",
  "not_empty",
  "blank",
  "not_blank",
];

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isNumericField(field: OpenViewDataSourceField): boolean {
  return NUMERIC_TYPES.has(field.type);
}

function isCategoricalField(field: OpenViewDataSourceField): boolean {
  return CATEGORICAL_TYPES.has(field.type);
}

function operatorsFor(field: OpenViewDataSourceField): FilterOperator[] {
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

function operatorLabel(operator: FilterOperator): string {
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

function dateWindowDays(fromDate: string, toDate: string): number {
  if (!fromDate || !toDate) return 0;
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.floor((to - from) / 86_400_000) + 1;
}

function canonicalDecimal(value: string): string | null {
  if (value.length > 58) return null;
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (!match) return null;
  const [, sign, integerPart, rawFraction = ""] = match;
  if (integerPart.length > 38 || rawFraction.length > 18) return null;
  const fraction = rawFraction.replace(/0+$/, "");
  const negative = sign === "-" && !(integerPart === "0" && !fraction);
  return `${negative ? "-" : ""}${integerPart}${fraction ? `.${fraction}` : ""}`;
}

function isValidInteger(value: string): boolean {
  return (
    /^-?(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))
  );
}

function fieldReference(field: OpenViewDataSourceField) {
  return { fieldId: field.id, expectedType: field.type };
}

function scalarForFilter(
  field: OpenViewDataSourceField,
  value: string,
): string | number | boolean {
  if (field.type === "decimal") return canonicalDecimal(value) ?? value;
  if (NUMERIC_TYPES.has(field.type)) return Number(value);
  if (field.type === "boolean") return value === "true";
  return value;
}

function formatError(error: unknown, fallback: string): string {
  return messageFor(error, fallback);
}

function downloadCsv(
  result: OpenViewAggregateSnapshotResult,
  dateSeries: boolean,
) {
  const csv = serializeCsv([
    [dateSeries ? "Date" : "Group", "Value", "Record count"],
    ...result.items.map((item) => [item.label, item.value, item.recordCount]),
  ]);
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "openview-chart-data.csv";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function chartNumber(value: OpenViewAggregateDatum["value"]): number | null {
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}

function chartDataFor(
  result: OpenViewAggregateSnapshotResult,
  chartType: ChartType,
  top: string,
) {
  const ranked =
    chartType === "line"
      ? result.items
      : result.items
          .map((item, index) => ({ item, index }))
          .sort((left, right) => {
            const difference =
              Number(right.item.value) - Number(left.item.value);
            return Number.isFinite(difference) && difference !== 0
              ? difference
              : left.index - right.index;
          })
          .map(({ item }) => item);
  const visible =
    chartType === "line"
      ? ranked
      : ranked.slice(0, top ? Number(top) : MAX_CATEGORICAL_PREVIEW_POINTS);
  const displayItems = visible.map((item, index) => ({
    key: `aggregate-${index}`,
    label: item.label,
    value: item.value,
  }));
  const data = displayItems.map((item) => ({
    ...item,
    value: chartNumber(item.value) ?? 0,
  }));
  const hasUnchartableValue = displayItems.some(
    (item) => chartNumber(item.value) === null,
  );
  return {
    data,
    displayItems,
    hasUnchartableValue,
    total: result.items.length,
    previewCapped:
      chartType !== "line" && !top && result.items.length > visible.length,
  };
}

export default function ServerBackedCharts() {
  const [sources, setSources] = useState<OpenViewDataSource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState("");
  const [sourcesHasMore, setSourcesHasMore] = useState(false);
  const [sourcesNextOffset, setSourcesNextOffset] = useState(0);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [metadataError, setMetadataError] = useState("");
  const [metadataRetryTarget, setMetadataRetryTarget] = useState<
    "sources" | "fields" | null
  >(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [moduleId, setModuleId] = useState("");
  const [fields, setFields] = useState<OpenViewDataSourceField[]>([]);
  const [fieldsForModule, setFieldsForModule] = useState("");
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [fieldsError, setFieldsError] = useState("");
  const [fieldsHasMore, setFieldsHasMore] = useState(false);
  const [fieldsNextOffset, setFieldsNextOffset] = useState(0);
  const [fieldsRetry, setFieldsRetry] = useState(0);
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [dimensionId, setDimensionId] = useState("");
  const [dateFieldId, setDateFieldId] = useState("");
  const [aggregation, setAggregation] = useState<Aggregation>("count");
  const [measureId, setMeasureId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [top, setTop] = useState("");
  const [filters, setFilters] = useState<FilterDraft[]>([]);
  const [filterSequence, setFilterSequence] = useState(0);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState("");
  const [applied, setApplied] = useState<AppliedSnapshot | null>(null);
  const [tablePage, setTablePage] = useState(0);

  useEffect(() => {
    let active = true;
    setSourcesLoading(true);
    setSourcesError("");
    void listOpenViewDataSources({ limit: 100, offset: 0 })
      .then((page) => {
        if (!active) return;
        setSources(page.items);
        setSourcesHasMore(page.pagination.hasMore);
        setSourcesNextOffset(page.pagination.count);
        setModuleId((current) =>
          page.items.some((source) => source.id === current)
            ? current
            : (page.items[0]?.id ?? ""),
        );
      })
      .catch((error: unknown) => {
        if (active)
          setSourcesError(
            formatError(
              error,
              "The OpenView data-source catalog could not be loaded.",
            ),
          );
      })
      .finally(() => {
        if (active) setSourcesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [catalogRetry]);

  useEffect(() => {
    if (!moduleId) {
      setFields([]);
      setFieldsForModule("");
      setFieldsHasMore(false);
      return;
    }
    let active = true;
    setFieldsLoading(true);
    setFieldsError("");
    setFields([]);
    setFieldsForModule("");
    setFieldsHasMore(false);
    setFieldsNextOffset(0);
    void listOpenViewDataSourceFields(moduleId, { limit: 100, offset: 0 })
      .then((page) => {
        if (!active) return;
        setFields(page.items);
        setFieldsForModule(moduleId);
        setFieldsHasMore(page.pagination.hasMore);
        setFieldsNextOffset(page.pagination.count);
      })
      .catch((error: unknown) => {
        if (active)
          setFieldsError(
            formatError(error, "The data-source fields could not be loaded."),
          );
      })
      .finally(() => {
        if (active) setFieldsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [moduleId, fieldsRetry]);

  const sourceName =
    sources.find((source) => source.id === moduleId)?.name ?? "Data source";
  const moduleFields = fieldsForModule === moduleId ? fields : [];
  const categoryFields = moduleFields.filter(isCategoricalField);
  const dateFields = moduleFields.filter((field) =>
    ["date", "datetime"].includes(field.type),
  );
  const numericFields = moduleFields.filter(isNumericField);
  const filterFields = moduleFields;
  const selectedDimension =
    categoryFields.find((field) => field.id === dimensionId) ??
    categoryFields[0];
  const selectedDateField =
    dateFields.find((field) => field.id === dateFieldId) ?? dateFields[0];
  const selectedMeasure =
    numericFields.find((field) => field.id === measureId) ?? numericFields[0];
  const dateSeries = chartType === "line";
  const requestedDays = dateWindowDays(fromDate, toDate);
  const dateWindowValid = requestedDays >= 1 && requestedDays <= 366;

  const filterValidation = filters.find((filter) => {
    const field = filterFields.find(
      (candidate) => candidate.id === filter.fieldId,
    );
    if (!field || !operatorsFor(field).includes(filter.operator)) return true;
    if (EMPTY_OPERATORS.has(filter.operator)) return false;
    if (!filter.value.trim()) return true;
    if (field.type === "decimal")
      return canonicalDecimal(filter.value) === null;
    if (field.type === "int") return !isValidInteger(filter.value);
    return field.type === "number" && !Number.isFinite(Number(filter.value));
  });
  const canRunQuery = Boolean(
    !sourcesLoading &&
    !sourcesError &&
    sources.some((source) => source.id === moduleId) &&
    !fieldsLoading &&
    !fieldsError &&
    moduleFields.length > 0 &&
    (dateSeries ? selectedDateField && dateWindowValid : selectedDimension) &&
    (aggregation === "count" || selectedMeasure) &&
    !filterValidation &&
    !queryLoading,
  );

  const draftSignature = JSON.stringify({
    moduleId,
    chartType,
    dimensionId: dateSeries ? null : selectedDimension?.id,
    dateFieldId: dateSeries ? selectedDateField?.id : null,
    aggregation,
    measureId: aggregation === "count" ? null : selectedMeasure?.id,
    fromDate: dateSeries ? fromDate : null,
    toDate: dateSeries ? toDate : null,
    filters,
  });

  async function loadMoreSources() {
    if (metadataLoading || !sourcesHasMore) return;
    setMetadataLoading(true);
    setMetadataError("");
    setMetadataRetryTarget(null);
    try {
      const page = await listOpenViewDataSources({
        limit: 100,
        offset: sourcesNextOffset,
      });
      setSources((current) => [...current, ...page.items]);
      setSourcesHasMore(page.pagination.hasMore);
      setSourcesNextOffset((current) => current + page.pagination.count);
    } catch (error) {
      setMetadataError(
        formatError(error, "More data sources could not be loaded."),
      );
      setMetadataRetryTarget("sources");
    } finally {
      setMetadataLoading(false);
    }
  }

  async function loadMoreFields() {
    if (metadataLoading || !fieldsHasMore || !moduleId) return;
    setMetadataLoading(true);
    setMetadataError("");
    setMetadataRetryTarget(null);
    try {
      const page = await listOpenViewDataSourceFields(moduleId, {
        limit: 100,
        offset: fieldsNextOffset,
      });
      setFields((current) => [...current, ...page.items]);
      setFieldsHasMore(page.pagination.hasMore);
      setFieldsNextOffset((current) => current + page.pagination.count);
    } catch (error) {
      setMetadataError(
        formatError(error, "More data-source fields could not be loaded."),
      );
      setMetadataRetryTarget("fields");
    } finally {
      setMetadataLoading(false);
    }
  }

  async function applySnapshot(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!canRunQuery || !moduleId) return;
    const definition: OpenViewQueryDefinition = {
      version: 1,
      logic: "and",
      columns: [],
      filters: filters.map((filter) => {
        const field = filterFields.find(
          (candidate) => candidate.id === filter.fieldId,
        );
        if (!field)
          throw new Error("Choose an available field for every filter.");
        return {
          fieldId: field.id,
          expectedType: field.type,
          operator: filter.operator,
          ...(EMPTY_OPERATORS.has(filter.operator)
            ? {}
            : { value: scalarForFilter(field, filter.value) }),
        };
      }),
      sort: [],
      deleted: "exclude",
      search: null,
      searchFields: [],
    };
    const request: OpenViewAggregateSnapshotRequest = dateSeries
      ? {
          moduleId,
          definition,
          mode: "date_series",
          dateField: fieldReference(selectedDateField!),
          fromDate,
          toDate,
          aggregation,
          ...(aggregation === "count"
            ? {}
            : { measure: fieldReference(selectedMeasure!) }),
        }
      : {
          moduleId,
          definition,
          mode: "groups",
          dimension: fieldReference(selectedDimension!),
          aggregation,
          ...(aggregation === "count"
            ? {}
            : { measure: fieldReference(selectedMeasure!) }),
        };
    setQueryLoading(true);
    setQueryError("");
    try {
      const result = await queryOpenViewAggregateSnapshot(request);
      const appliedChartType = chartType;
      const labelName = dateSeries
        ? selectedDateField!.name
        : selectedDimension!.name;
      const valueName =
        aggregation === "count" ? "Records" : selectedMeasure!.name;
      setApplied({
        result,
        sourceName,
        chartType: appliedChartType,
        labelName,
        valueName,
        aggregationName:
          aggregation === "average" ? "Average" : titleCase(aggregation),
        signature: draftSignature,
      });
      setTablePage(0);
    } catch (error) {
      setQueryError(
        formatError(
          error,
          "The aggregate snapshot could not be loaded. Try again.",
        ),
      );
    } finally {
      setQueryLoading(false);
    }
  }

  function addFilter() {
    if (filters.length >= 10) return;
    const field = filterFields[0];
    if (!field) return;
    setFilters((current) => [
      ...current,
      { id: filterSequence, fieldId: field.id, operator: "eq", value: "" },
    ]);
    setFilterSequence((current) => current + 1);
  }

  const appliedResult = applied?.result ?? null;
  const allRows = appliedResult?.items ?? [];
  const pageCount = Math.ceil(allRows.length / PAGE_SIZE);
  const visibleRows = allRows.slice(
    tablePage * PAGE_SIZE,
    (tablePage + 1) * PAGE_SIZE,
  );
  const firstRowNumber = allRows.length ? tablePage * PAGE_SIZE + 1 : 0;
  const lastRowNumber = Math.min((tablePage + 1) * PAGE_SIZE, allRows.length);
  const chart = applied
    ? chartDataFor(
        applied.result,
        applied.chartType,
        applied.chartType === "line" ? "" : top,
      )
    : null;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3 sm:gap-4 print:hidden">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            OpenView
          </h1>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            Explore operational records, compose reusable views, and prepare
            analytics for your team.
          </p>
        </div>
      </header>

      <Card className="print:hidden">
        <CardHeader>
          <CardTitle>Live charts</CardTitle>
          <CardDescription>
            Apply a chart definition to request one complete, authorized
            aggregate snapshot. Draft changes do not reload data until applied.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sourcesError ? (
            <Alert
              role="alert"
              variant="warning"
              className="mb-4 flex flex-wrap items-center justify-between gap-3"
            >
              <span>
                {sourcesError}{" "}
                {sources.length
                  ? "Previously loaded data sources remain available."
                  : "No data-source list has been loaded yet."}
              </span>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setCatalogRetry((current) => current + 1)}
              >
                Retry catalog
              </Button>
            </Alert>
          ) : null}
          {fieldsError ? (
            <Alert
              role="alert"
              variant="warning"
              className="mb-4 flex flex-wrap items-center justify-between gap-3"
            >
              <span>{fieldsError}</span>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setFieldsRetry((current) => current + 1)}
              >
                Retry fields
              </Button>
            </Alert>
          ) : null}
          {metadataError ? (
            <Alert
              role="alert"
              variant="warning"
              className="mb-4 flex flex-wrap items-center justify-between gap-3"
            >
              <span>{metadataError}</span>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() =>
                  void (metadataRetryTarget === "sources"
                    ? loadMoreSources()
                    : loadMoreFields())
                }
              >
                Retry catalog page
              </Button>
            </Alert>
          ) : null}
          {sourcesLoading ? (
            <p role="status" className="text-muted-foreground mb-4 text-sm">
              Loading the authorized data-source catalog…
            </p>
          ) : null}
          {fieldsLoading ? (
            <p role="status" className="text-muted-foreground mb-4 text-sm">
              Loading fields for {sourceName}…
            </p>
          ) : null}

          {sources.length === 0 && !sourcesLoading && !sourcesError ? (
            <p className="text-muted-foreground text-sm">
              No authorized data sources are available.
            </p>
          ) : (
            <form
              className="flex flex-col gap-5"
              onSubmit={(event) => void applySnapshot(event)}
            >
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Field>
                  <FieldLabel htmlFor="chart-data-source">
                    Data source
                  </FieldLabel>
                  <Select
                    id="chart-data-source"
                    className="min-h-11"
                    value={moduleId}
                    disabled={
                      sourcesLoading ||
                      !sources.length ||
                      queryLoading ||
                      metadataLoading
                    }
                    onValueChange={(nextModuleId) => {
                      setModuleId(nextModuleId);
                      setFilters([]);
                    }}
                  >
                    {sources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                  </Select>
                  {sourcesHasMore ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="min-h-11 justify-start px-0"
                      disabled={metadataLoading}
                      onClick={() => void loadMoreSources()}
                    >
                      Load more data sources
                    </Button>
                  ) : null}
                </Field>
                <Field>
                  <FieldLabel htmlFor="chart-type">Chart type</FieldLabel>
                  <Select
                    id="chart-type"
                    className="min-h-11"
                    value={chartType}
                    disabled={queryLoading}
                    onValueChange={(value) => setChartType(value as ChartType)}
                  >
                    <option value="bar">Bar</option>
                    <option value="line">Line (date series)</option>
                    <option value="pie">Pie</option>
                  </Select>
                </Field>
                {dateSeries ? (
                  <Field>
                    <FieldLabel htmlFor="chart-date-field">
                      Date field
                    </FieldLabel>
                    <Select
                      id="chart-date-field"
                      className="min-h-11"
                      value={selectedDateField?.id ?? ""}
                      disabled={
                        fieldsLoading || !dateFields.length || queryLoading
                      }
                      onValueChange={setDateFieldId}
                    >
                      <option value="" disabled>
                        Select a date field
                      </option>
                      {dateFields.map((field) => (
                        <option key={field.id} value={field.id}>
                          {field.name}
                        </option>
                      ))}
                    </Select>
                    {!dateFields.length && !fieldsLoading ? (
                      <FieldDescription>
                        No date fields are available.
                      </FieldDescription>
                    ) : null}
                  </Field>
                ) : (
                  <Field>
                    <FieldLabel htmlFor="chart-dimension">Dimension</FieldLabel>
                    <Select
                      id="chart-dimension"
                      className="min-h-11"
                      value={selectedDimension?.id ?? ""}
                      disabled={
                        fieldsLoading || !categoryFields.length || queryLoading
                      }
                      onValueChange={setDimensionId}
                    >
                      <option value="" disabled>
                        Select a categorical field
                      </option>
                      {categoryFields.map((field) => (
                        <option key={field.id} value={field.id}>
                          {field.name}
                        </option>
                      ))}
                    </Select>
                    {!categoryFields.length && !fieldsLoading ? (
                      <FieldDescription>
                        No categorical fields are available.
                      </FieldDescription>
                    ) : null}
                  </Field>
                )}
                <Field>
                  <FieldLabel htmlFor="chart-aggregation">
                    Aggregation
                  </FieldLabel>
                  <Select
                    id="chart-aggregation"
                    className="min-h-11"
                    value={aggregation}
                    disabled={queryLoading}
                    onValueChange={(value) =>
                      setAggregation(value as Aggregation)
                    }
                  >
                    <option value="count">Count</option>
                    <option value="sum">Sum</option>
                    <option value="average">Average</option>
                  </Select>
                </Field>
                {aggregation !== "count" ? (
                  <Field>
                    <FieldLabel htmlFor="chart-measure">
                      Numeric measure
                    </FieldLabel>
                    <Select
                      id="chart-measure"
                      className="min-h-11"
                      value={selectedMeasure?.id ?? ""}
                      disabled={
                        fieldsLoading || !numericFields.length || queryLoading
                      }
                      onValueChange={setMeasureId}
                    >
                      <option value="" disabled>
                        Select a numeric field
                      </option>
                      {numericFields.map((field) => (
                        <option key={field.id} value={field.id}>
                          {field.name}
                        </option>
                      ))}
                    </Select>
                    {!numericFields.length ? (
                      <FieldDescription>
                        Sum and average require a numeric field.
                      </FieldDescription>
                    ) : null}
                  </Field>
                ) : null}
                {dateSeries ? (
                  <>
                    <Field>
                      <FieldLabel htmlFor="chart-from-date">
                        From date
                      </FieldLabel>
                      <Input
                        id="chart-from-date"
                        className="min-h-11"
                        type="date"
                        value={fromDate}
                        disabled={queryLoading}
                        onChange={(event) => setFromDate(event.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="chart-to-date">To date</FieldLabel>
                      <Input
                        id="chart-to-date"
                        className="min-h-11"
                        type="date"
                        value={toDate}
                        disabled={queryLoading}
                        onChange={(event) => setToDate(event.target.value)}
                      />
                      {!fromDate && !toDate ? (
                        <FieldDescription>
                          Choose both dates for an inclusive window of 1–366
                          days.
                        </FieldDescription>
                      ) : null}
                      {(fromDate || toDate) && !dateWindowValid ? (
                        <FieldError>
                          Choose an inclusive range of 1–366 days, with the
                          start date on or before the end.
                        </FieldError>
                      ) : null}
                    </Field>
                  </>
                ) : (
                  <Field>
                    <FieldLabel htmlFor="chart-top">
                      Top groups in chart
                    </FieldLabel>
                    <Select
                      id="chart-top"
                      className="min-h-11"
                      value={top}
                      disabled={queryLoading}
                      onValueChange={setTop}
                    >
                      <option value="">
                        No Top filter (large previews cap at 100)
                      </option>
                      <option value="5">Top 5</option>
                      <option value="10">Top 10</option>
                      <option value="20">Top 20</option>
                      <option value="50">Top 50</option>
                    </Select>
                    <FieldDescription>
                      Top limits the preview only. Without a Top filter, large
                      categorical previews show at most 100 groups; table, CSV,
                      and print retain the full snapshot.
                    </FieldDescription>
                  </Field>
                )}
              </div>

              {fieldsHasMore ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border border-dashed p-3">
                  <p className="text-muted-foreground text-sm">
                    More fields are available in the authorized catalog.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={metadataLoading}
                    onClick={() => void loadMoreFields()}
                  >
                    Load more fields
                  </Button>
                </div>
              ) : null}

              <fieldset className="flex flex-col gap-3 rounded-[var(--radius)] border p-4">
                <legend className="px-1 text-sm font-medium">Filters</legend>
                <p className="text-muted-foreground text-sm">
                  Combine up to 10 field filters with AND before aggregation.
                </p>
                {filters.map((filter, index) => {
                  const field = filterFields.find(
                    (candidate) => candidate.id === filter.fieldId,
                  );
                  const fieldOperators = field
                    ? operatorsFor(field)
                    : COMMON_FILTER_OPERATORS;
                  const choices = field?.config.options;
                  const selectChoices = Array.isArray(choices)
                    ? choices.filter(
                        (choice): choice is string =>
                          typeof choice === "string",
                      )
                    : [];
                  return (
                    <div
                      key={filter.id}
                      className="bg-muted/30 grid gap-3 rounded-[var(--radius)] p-3 sm:grid-cols-2 lg:grid-cols-4"
                    >
                      <Field>
                        <FieldLabel htmlFor={`chart-filter-${filter.id}-field`}>
                          Filter {index + 1} field
                        </FieldLabel>
                        <Select
                          id={`chart-filter-${filter.id}-field`}
                          className="min-h-11"
                          value={filter.fieldId}
                          disabled={queryLoading || !filterFields.length}
                          onValueChange={(fieldId) =>
                            setFilters((current) =>
                              current.map((item) =>
                                item.id === filter.id
                                  ? {
                                      ...item,
                                      fieldId,
                                      operator: "eq",
                                      value: "",
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          {filterFields.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel
                          htmlFor={`chart-filter-${filter.id}-operator`}
                        >
                          Filter {index + 1} operator
                        </FieldLabel>
                        <Select
                          id={`chart-filter-${filter.id}-operator`}
                          className="min-h-11"
                          value={filter.operator}
                          disabled={queryLoading}
                          onValueChange={(operator) =>
                            setFilters((current) =>
                              current.map((item) =>
                                item.id === filter.id
                                  ? {
                                      ...item,
                                      operator: operator as FilterOperator,
                                      value: "",
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          {fieldOperators.map((operator) => (
                            <option key={operator} value={operator}>
                              {operatorLabel(operator)}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      {!EMPTY_OPERATORS.has(filter.operator) ? (
                        <Field>
                          <FieldLabel
                            htmlFor={`chart-filter-${filter.id}-value`}
                          >
                            Filter {index + 1} value
                          </FieldLabel>
                          {selectChoices.length ? (
                            <Select
                              id={`chart-filter-${filter.id}-value`}
                              className="min-h-11"
                              value={filter.value}
                              disabled={queryLoading}
                              onValueChange={(value) =>
                                setFilters((current) =>
                                  current.map((item) =>
                                    item.id === filter.id
                                      ? { ...item, value }
                                      : item,
                                  ),
                                )
                              }
                            >
                              <option value="" disabled>
                                Select a value
                              </option>
                              {selectChoices.map((choice) => (
                                <option key={choice} value={choice}>
                                  {choice}
                                </option>
                              ))}
                            </Select>
                          ) : field?.type === "boolean" ? (
                            <Select
                              id={`chart-filter-${filter.id}-value`}
                              className="min-h-11"
                              value={filter.value}
                              disabled={queryLoading}
                              onValueChange={(value) =>
                                setFilters((current) =>
                                  current.map((item) =>
                                    item.id === filter.id
                                      ? { ...item, value }
                                      : item,
                                  ),
                                )
                              }
                            >
                              <option value="" disabled>
                                Select a value
                              </option>
                              <option value="true">True</option>
                              <option value="false">False</option>
                            </Select>
                          ) : (
                            <Input
                              id={`chart-filter-${filter.id}-value`}
                              className="min-h-11"
                              type={
                                field?.type === "decimal"
                                  ? "text"
                                  : field && NUMERIC_TYPES.has(field.type)
                                    ? "number"
                                    : field?.type === "date"
                                      ? "date"
                                      : field?.type === "datetime"
                                        ? "datetime-local"
                                        : "text"
                              }
                              step={
                                field?.type === "int"
                                  ? 1
                                  : field?.type === "number"
                                    ? "any"
                                    : undefined
                              }
                              inputMode={
                                field?.type === "decimal"
                                  ? "decimal"
                                  : undefined
                              }
                              maxLength={
                                field?.type === "decimal" ? 58 : undefined
                              }
                              value={filter.value}
                              disabled={queryLoading}
                              onChange={(event) =>
                                setFilters((current) =>
                                  current.map((item) =>
                                    item.id === filter.id
                                      ? { ...item, value: event.target.value }
                                      : item,
                                  ),
                                )
                              }
                            />
                          )}
                        </Field>
                      ) : (
                        <p className="text-muted-foreground self-center text-sm">
                          This operator does not need a value.
                        </p>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 self-end"
                        disabled={queryLoading}
                        onClick={() =>
                          setFilters((current) =>
                            current.filter((item) => item.id !== filter.id),
                          )
                        }
                      >
                        Remove filter {index + 1}
                      </Button>
                    </div>
                  );
                })}
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={
                      filters.length >= 10 ||
                      !filterFields.length ||
                      queryLoading
                    }
                    onClick={addFilter}
                  >
                    Add filter
                  </Button>
                </div>
                {filterValidation ? (
                  <p role="alert" className="text-destructive text-sm">
                    Complete each filter with a value allowed by its field type.
                  </p>
                ) : null}
              </fieldset>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  className="min-h-11"
                  disabled={!canRunQuery}
                >
                  {queryLoading ? "Loading complete snapshot…" : "Apply chart"}
                </Button>
                <p className="text-muted-foreground text-sm">
                  Each Apply loads one complete aggregate snapshot; the result
                  reports its full group or date count.
                </p>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      {queryError ? (
        <Alert
          role="alert"
          variant="warning"
          className="flex flex-wrap items-center justify-between gap-3 print:hidden"
        >
          <span>
            {queryError}
            {appliedResult
              ? " Showing the last successful snapshot."
              : " No aggregate snapshot has been applied yet."}
          </span>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={queryLoading || !canRunQuery}
            onClick={() => void applySnapshot()}
          >
            {queryLoading ? "Retrying…" : "Retry chart query"}
          </Button>
        </Alert>
      ) : null}

      {applied ? (
        <>
          <Card className="w-full min-w-0 print:hidden">
            <CardHeader>
              <CardTitle>Chart preview</CardTitle>
              <CardDescription>
                {applied.sourceName} · {applied.aggregationName}{" "}
                {applied.valueName.toLowerCase()} by {applied.labelName}
                {applied.chartType === "line"
                  ? " · chronological date series"
                  : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-3">
              {applied.signature !== draftSignature ? (
                <Alert role="note">
                  Unapplied chart settings; this preview and its exports still
                  use the last successful snapshot.
                </Alert>
              ) : null}
              {applied.chartType !== "line" && top ? (
                <p className="text-muted-foreground text-sm">
                  Showing top {Math.min(Number(top), chart?.total ?? 0)} of{" "}
                  {chart?.total ?? 0} groups in the chart.
                </p>
              ) : null}
              {chart?.previewCapped ? (
                <p className="text-muted-foreground text-sm">
                  Showing top {chart.data.length} of {chart.total} groups in
                  chart; complete table/CSV/print retained.
                </p>
              ) : null}
              <p className="text-muted-foreground text-sm">
                {chart?.data.length ?? 0} chart points ·{" "}
                {applied.result.pagination.total} total{" "}
                {applied.chartType === "line"
                  ? "daily values"
                  : "aggregate groups"}
                . Chart decimal values are numeric approximations; the table and
                exports preserve the returned value strings.
              </p>
              {chart?.hasUnchartableValue ? (
                <Alert role="alert" variant="warning">
                  One or more selected values exceed the chart’s numeric range.
                  The complete returned values remain available in the table and
                  exports.
                </Alert>
              ) : null}
              {chart?.data.length && !chart.hasUnchartableValue ? (
                <div
                  aria-label="Aggregate chart preview"
                  className="w-full min-w-0"
                  role="img"
                >
                  <OpenViewChartPreview
                    data={chart.data}
                    type={applied.chartType}
                    valueLabel={applied.valueName}
                    allowDecimals={applied.aggregationName === "Average"}
                    showLabels={chart.data.length <= 20}
                    showLegend={chart.data.length <= 20}
                    className={cn(
                      "border-border/70 bg-muted/15 h-[20rem] w-full min-w-0 rounded-[var(--radius)] border p-3",
                      applied.chartType === "pie" &&
                        "max-sm:[&_.recharts-legend-wrapper]:hidden max-sm:[&_.recharts-pie-label-text]:hidden",
                    )}
                  />
                </div>
              ) : (
                <p className="text-muted-foreground py-8 text-center text-sm">
                  No chartable aggregate points are available.
                </p>
              )}
              {applied.chartType === "pie" && chart?.displayItems.length ? (
                <ul
                  aria-label="Pie chart categories and values"
                  className="divide-border min-w-0 divide-y sm:hidden"
                >
                  {chart.displayItems.map((item) => (
                    <li
                      key={item.key}
                      className="grid min-h-11 min-w-0 grid-cols-2 gap-3 py-2 text-sm"
                    >
                      <span className="min-w-0 break-words">{item.label}</span>
                      <span className="min-w-0 text-right break-all tabular-nums">
                        {String(item.value)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>

          <Card className="w-full min-w-0 print:hidden">
            <CardHeader className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <CardTitle>Complete aggregate data</CardTitle>
                <CardDescription>
                  {applied.result.pagination.total}{" "}
                  {applied.chartType === "line"
                    ? "daily values"
                    : "aggregate groups"}{" "}
                  · one complete snapshot · no record list is loaded
                </CardDescription>
              </div>
              <div className="flex min-w-0 flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() =>
                    downloadCsv(applied.result, applied.chartType === "line")
                  }
                >
                  <Download aria-hidden="true" /> Download complete CSV
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => window.print()}
                >
                  <Printer aria-hidden="true" /> Print complete table
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p role="status" className="text-muted-foreground text-sm">
                  {allRows.length
                    ? `${firstRowNumber}–${lastRowNumber} of ${allRows.length} ${applied.chartType === "line" ? "daily values" : "aggregate groups"}`
                    : `0 ${applied.chartType === "line" ? "daily values" : "aggregate groups"}`}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    aria-label="Previous data table page"
                    disabled={tablePage <= 0}
                    onClick={() =>
                      setTablePage((current) => Math.max(0, current - 1))
                    }
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    aria-label="Next data table page"
                    disabled={tablePage + 1 >= pageCount}
                    onClick={() =>
                      setTablePage((current) =>
                        Math.min(pageCount - 1, current + 1),
                      )
                    }
                  >
                    Next
                  </Button>
                </div>
              </div>
              <div className="min-w-0 print:hidden">
                <Table aria-label="Complete aggregate data">
                  <TableCaption>
                    Page {Math.min(tablePage + 1, Math.max(1, pageCount))} of{" "}
                    {Math.max(1, pageCount)}. The complete authorized snapshot
                    contains {allRows.length}{" "}
                    {applied.chartType === "line"
                      ? "daily values"
                      : "aggregate groups"}
                    .
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        {applied.chartType === "line" ? "Date" : "Group"}
                      </TableHead>
                      <TableHead>{applied.valueName}</TableHead>
                      <TableHead>Record count</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleRows.map((item, index) => (
                      <TableRow
                        key={`${item.key ?? item.label}-${tablePage * PAGE_SIZE + index}`}
                      >
                        <TableCell>{item.label}</TableCell>
                        <TableCell>{String(item.value)}</TableCell>
                        <TableCell>{item.recordCount}</TableCell>
                      </TableRow>
                    ))}
                    {!allRows.length ? (
                      <TableRow>
                        <TableCell
                          colSpan={3}
                          className="text-muted-foreground py-8 text-center"
                        >
                          No values matched this chart definition.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
          <div className="hidden print:block">
            <h1 className="mb-2 text-xl font-semibold">
              {applied.sourceName} — {applied.labelName} chart data
            </h1>
            <p className="mb-4 text-sm">
              Complete aggregate snapshot: {allRows.length}{" "}
              {applied.chartType === "line" ? "daily values" : "groups"}.
            </p>
            <Table aria-label="Printable complete aggregate data">
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {applied.chartType === "line" ? "Date" : "Group"}
                  </TableHead>
                  <TableHead>{applied.valueName}</TableHead>
                  <TableHead>Record count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allRows.map((item, index) => (
                  <TableRow
                    key={`${item.key ?? item.label}-${index}`}
                    data-print-row
                    data-testid="charts-print-row"
                  >
                    <TableCell>{item.label}</TableCell>
                    <TableCell>{String(item.value)}</TableCell>
                    <TableCell>{item.recordCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      ) : (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle>Chart results</CardTitle>
            <CardDescription>
              Results appear after a successful Apply. No sample or partial
              result is shown.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              No aggregate snapshot has been applied yet.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
