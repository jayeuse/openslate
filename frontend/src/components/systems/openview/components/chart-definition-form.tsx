"use client";

import type { Dispatch, FormEvent, SetStateAction } from "react";
import { CalendarDays, Filter, SlidersHorizontal } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import type {
  OpenViewDataSource,
  OpenViewDataSourceField,
} from "../adapters/views-api";
import {
  type Aggregation,
  type ChartType,
  type FilterDraft,
  type FilterLogic,
} from "../domain/chart-query";
import { ChartFilterControls } from "./chart-filter-controls";

type ChartDefinitionCatalog = {
  sources: OpenViewDataSource[];
  sourcesLoading: boolean;
  sourcesError: string;
  sourcesHasMore: boolean;
  fieldsLoading: boolean;
  fieldsError: string;
  fieldsHasMore: boolean;
  metadataError: string;
  metadataRetryTarget: "sources" | "fields" | null;
  metadataLoading: boolean;
  sourceName: string;
  categoryFields: OpenViewDataSourceField[];
  dateFields: OpenViewDataSourceField[];
  numericFields: OpenViewDataSourceField[];
  filterFields: OpenViewDataSourceField[];
};

type ChartDefinitionDraft = {
  moduleId: string;
  chartType: ChartType;
  dateSeries: boolean;
  selectedDateField: OpenViewDataSourceField | undefined;
  selectedDimension: OpenViewDataSourceField | undefined;
  dateFieldId: string;
  aggregation: Aggregation;
  selectedMeasure: OpenViewDataSourceField | undefined;
  fromDate: string;
  toDate: string;
  dateWindowValid: boolean;
  top: string;
  filters: FilterDraft[];
  filterLogic: FilterLogic;
  filterValidation: FilterDraft | undefined;
  showLegend: boolean;
  showValues: boolean;
  queryLoading: boolean;
  canRunQuery: boolean;
};

type ChartDefinitionActions = {
  retryCatalog: () => void;
  retryFields: () => void;
  loadMoreSources: () => Promise<void>;
  loadMoreFields: () => Promise<void>;
  setModuleId: (moduleId: string) => void;
  setChartType: (chartType: ChartType) => void;
  setDateFieldId: (fieldId: string) => void;
  setDimensionId: (fieldId: string) => void;
  setAggregation: (aggregation: Aggregation) => void;
  setMeasureId: (fieldId: string) => void;
  setFromDate: (date: string) => void;
  setToDate: (date: string) => void;
  setTop: (top: string) => void;
  setFilters: Dispatch<SetStateAction<FilterDraft[]>>;
  setFilterLogic: (logic: FilterLogic) => void;
  setShowLegend: Dispatch<SetStateAction<boolean>>;
  setShowValues: Dispatch<SetStateAction<boolean>>;
  addFilter: () => void;
  applySnapshot: (event?: FormEvent<HTMLFormElement>) => Promise<void>;
};

type ChartDefinitionFormProps = {
  catalog: ChartDefinitionCatalog;
  draft: ChartDefinitionDraft;
  actions: ChartDefinitionActions;
};

export function ChartDefinitionForm({
  catalog,
  draft,
  actions,
}: ChartDefinitionFormProps) {
  const {
    sources,
    sourcesLoading,
    sourcesError,
    sourcesHasMore,
    fieldsLoading,
    fieldsError,
    fieldsHasMore,
    metadataError,
    metadataRetryTarget,
    metadataLoading,
    sourceName,
    categoryFields,
    dateFields,
    numericFields,
    filterFields,
  } = catalog;
  const {
    moduleId,
    chartType,
    dateSeries,
    selectedDateField,
    selectedDimension,
    dateFieldId,
    aggregation,
    selectedMeasure,
    fromDate,
    toDate,
    dateWindowValid,
    top,
    filters,
    filterLogic,
    filterValidation,
    showLegend,
    showValues,
    queryLoading,
    canRunQuery,
  } = draft;
  const {
    retryCatalog,
    retryFields,
    loadMoreSources,
    loadMoreFields,
    setModuleId,
    setChartType,
    setDateFieldId,
    setDimensionId,
    setAggregation,
    setMeasureId,
    setFromDate,
    setToDate,
    setTop,
    setFilters,
    setFilterLogic,
    setShowLegend,
    setShowValues,
    addFilter,
    applySnapshot,
  } = actions;

  const dateWindowActive = Boolean(
    fromDate &&
    toDate &&
    dateWindowValid &&
    (dateSeries ? selectedDateField : dateFieldId),
  );
  const displayOptionsCount =
    Number(Boolean(top)) + Number(!showLegend) + Number(!showValues);

  return (
    <Card className="w-full min-w-0 print:hidden">
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
              onClick={() => retryCatalog()}
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
              onClick={() => retryFields()}
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
            className="flex flex-col gap-4"
            onSubmit={(event) => void applySnapshot(event)}
          >
            <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Field>
                <FieldLabel htmlFor="chart-data-source">Data source</FieldLabel>
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
                  <FieldLabel htmlFor="chart-date-field">Group by</FieldLabel>
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
                  ) : (
                    <FieldDescription>
                      Choose the date field for this chronological series.
                    </FieldDescription>
                  )}
                </Field>
              ) : (
                <Field>
                  <FieldLabel htmlFor="chart-dimension">Group by</FieldLabel>
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
                <FieldLabel htmlFor="chart-aggregation">Measure</FieldLabel>
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
                <Field className="sm:col-start-2 xl:col-start-4">
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
                      Sum and average require an available numeric field.
                    </FieldDescription>
                  ) : null}
                </Field>
              ) : null}
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

            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      aria-label={`Filters (${filters.length})`}
                    />
                  }
                >
                  <Filter data-icon="inline-start" aria-hidden="true" />
                  <span>Filters</span>
                  <Badge variant="secondary">{filters.length}</Badge>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  collisionPadding={12}
                  className="max-h-[min(36rem,calc(100dvh-6rem))] w-[min(44rem,calc(100vw-2rem))] gap-4 overflow-y-auto p-4"
                >
                  <PopoverHeader>
                    <PopoverTitle>Chart filters</PopoverTitle>
                    <PopoverDescription>
                      Filter the source records before aggregation. The date
                      window is combined with these filters.
                    </PopoverDescription>
                  </PopoverHeader>
                  <ChartFilterControls
                    key={moduleId}
                    moduleId={moduleId}
                    filterFields={filterFields}
                    filters={filters}
                    filterLogic={filterLogic}
                    filterValidation={filterValidation}
                    queryLoading={queryLoading}
                    setFilters={setFilters}
                    setFilterLogic={setFilterLogic}
                    addFilter={addFilter}
                  />
                </PopoverContent>
              </Popover>

              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      aria-label="Date window"
                    />
                  }
                >
                  <CalendarDays data-icon="inline-start" aria-hidden="true" />
                  <span>Date window</span>
                  {dateWindowActive ? (
                    <Badge variant="secondary">Active</Badge>
                  ) : null}
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  collisionPadding={12}
                  className="max-h-[min(36rem,calc(100dvh-6rem))] w-[min(30rem,calc(100vw-2rem))] gap-4 overflow-y-auto p-4"
                >
                  <PopoverHeader>
                    <PopoverTitle>Date window</PopoverTitle>
                    <PopoverDescription>
                      {dateSeries
                        ? "Choose an inclusive 1–366 day period for this date series."
                        : "Optionally limit grouped results to an inclusive date range; it is ANDed with the field filters."}
                    </PopoverDescription>
                  </PopoverHeader>
                  {!dateSeries ? (
                    <Field>
                      <FieldLabel htmlFor="chart-date-field">
                        Chart date field
                      </FieldLabel>
                      <Select
                        id="chart-date-field"
                        className="min-h-11"
                        value={dateFieldId}
                        disabled={
                          fieldsLoading || !dateFields.length || queryLoading
                        }
                        onValueChange={setDateFieldId}
                      >
                        <option value="">No date window</option>
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
                  ) : null}
                  {dateSeries || dateFieldId || fromDate || toDate ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="chart-from-date">
                          {dateSeries ? "From date" : "Chart from date"}
                        </FieldLabel>
                        <Input
                          id="chart-from-date"
                          className="min-h-11"
                          type="date"
                          value={fromDate}
                          disabled={queryLoading}
                          onChange={(event) => setFromDate(event.target.value)}
                        />
                        {!fromDate && !toDate ? (
                          <FieldDescription>
                            Enter both dates for an inclusive window of 1–366
                            days.
                          </FieldDescription>
                        ) : null}
                        {(dateSeries || fromDate || toDate) &&
                        !dateWindowValid ? (
                          <FieldError>
                            Choose a range of 1–366 days, with the start date on
                            or before the end.
                          </FieldError>
                        ) : null}
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="chart-to-date">
                          {dateSeries ? "To date" : "Chart to date"}
                        </FieldLabel>
                        <Input
                          id="chart-to-date"
                          className="min-h-11"
                          type="date"
                          value={toDate}
                          disabled={queryLoading}
                          onChange={(event) => setToDate(event.target.value)}
                        />
                        {(dateSeries || fromDate || toDate) &&
                        !dateWindowValid ? (
                          <FieldError>
                            Choose a range of 1–366 days, with the start date on
                            or before the end.
                          </FieldError>
                        ) : null}
                      </Field>
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      Choose a chart date field to add an optional date window.
                    </p>
                  )}
                </PopoverContent>
              </Popover>

              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      aria-label={`Display options (${displayOptionsCount} active)`}
                    />
                  }
                >
                  <SlidersHorizontal
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  <span>Display options</span>
                  {displayOptionsCount ? (
                    <Badge variant="secondary">{displayOptionsCount}</Badge>
                  ) : null}
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  collisionPadding={12}
                  className="max-h-[min(36rem,calc(100dvh-6rem))] w-[min(24rem,calc(100vw-2rem))] gap-4 overflow-y-auto p-4"
                >
                  <PopoverHeader>
                    <PopoverTitle>Display options</PopoverTitle>
                    <PopoverDescription>
                      These settings affect the chart preview. The complete
                      table and exports retain every returned value.
                    </PopoverDescription>
                  </PopoverHeader>
                  {!dateSeries ? (
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
                        categorical previews show at most 100 groups; the table,
                        CSV, and print retain the full snapshot.
                      </FieldDescription>
                    </Field>
                  ) : null}
                  <fieldset className="flex flex-col gap-3 rounded-[var(--radius)] border p-3">
                    <legend className="px-1 text-sm font-medium">
                      Chart display
                    </legend>
                    <Field className="flex-row items-center gap-3">
                      <Checkbox
                        id="chart-show-legend"
                        checked={showLegend}
                        disabled={queryLoading}
                        onCheckedChange={(checked) =>
                          setShowLegend(checked === true)
                        }
                      />
                      <FieldLabel
                        htmlFor="chart-show-legend"
                        className="font-normal"
                      >
                        Show legend
                      </FieldLabel>
                    </Field>
                    <Field className="flex-row items-center gap-3">
                      <Checkbox
                        id="chart-show-values"
                        checked={showValues}
                        disabled={queryLoading}
                        onCheckedChange={(checked) =>
                          setShowValues(checked === true)
                        }
                      />
                      <FieldLabel
                        htmlFor="chart-show-values"
                        className="font-normal"
                      >
                        Show values
                      </FieldLabel>
                    </Field>
                  </fieldset>
                </PopoverContent>
              </Popover>

              <Button
                type="submit"
                className="min-h-11 sm:ml-auto"
                disabled={!canRunQuery}
              >
                {queryLoading ? "Loading complete snapshot…" : "Apply chart"}
              </Button>
            </div>
            <p className="text-muted-foreground text-sm">
              Chart query changes take effect after Apply. Display options
              update the preview; the table and exports retain the full last
              successful snapshot.
            </p>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
