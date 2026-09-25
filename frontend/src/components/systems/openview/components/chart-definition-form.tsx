"use client";

import type { Dispatch, FormEvent, SetStateAction } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { OpenViewChartPreferenceConfig } from "../adapters/chart-preferences-api";
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

type ChartDefinitionPreferences = {
  preferencesError: string;
  preferencesNotice: string;
  preferencesLoading: boolean;
  preferencesLoaded: boolean;
  preferencesSaving: boolean;
  settingsDenied: boolean;
  preferenceConfigDraft: OpenViewChartPreferenceConfig | null;
};

type ChartDefinitionActions = {
  retryPreferences: () => void;
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
  saveSettings: () => Promise<void>;
  resetSettings: () => Promise<void>;
  applySnapshot: (event?: FormEvent<HTMLFormElement>) => Promise<void>;
};

type ChartDefinitionFormProps = {
  catalog: ChartDefinitionCatalog;
  draft: ChartDefinitionDraft;
  preferences: ChartDefinitionPreferences;
  actions: ChartDefinitionActions;
};

export function ChartDefinitionForm({
  catalog,
  draft,
  preferences,
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
    preferencesError,
    preferencesNotice,
    preferencesLoading,
    preferencesLoaded,
    preferencesSaving,
    settingsDenied,
    preferenceConfigDraft,
  } = preferences;
  const {
    retryPreferences,
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
    saveSettings,
    resetSettings,
    applySnapshot,
  } = actions;

  return (
    <Card className="print:hidden">
      <CardHeader>
        <CardTitle>Live charts</CardTitle>
        <CardDescription>
          Apply a chart definition to request one complete, authorized aggregate
          snapshot. Draft changes do not reload data until applied.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {preferencesError ? (
          <Alert
            role="alert"
            variant="warning"
            className="mb-4 flex flex-wrap items-center justify-between gap-3"
          >
            <span>{preferencesError}</span>
            {!settingsDenied ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={preferencesLoading}
                onClick={() => retryPreferences()}
              >
                Retry saved settings
              </Button>
            ) : null}
          </Alert>
        ) : null}
        {preferencesNotice ? (
          <p role="status" className="text-muted-foreground mb-4 text-sm">
            {preferencesNotice}
          </p>
        ) : null}
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
            className="flex flex-col gap-5"
            onSubmit={(event) => void applySnapshot(event)}
          >
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
                  <FieldLabel htmlFor="chart-date-field">Date field</FieldLabel>
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
              <Field>
                <FieldLabel htmlFor="chart-aggregation">Aggregation</FieldLabel>
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
              {dateSeries || dateFieldId || fromDate || toDate ? (
                <>
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
                        {dateSeries
                          ? "Choose both dates for an inclusive window of 1–366 days."
                          : "Optionally bound grouped results to a date window; it is ANDed with the field filters."}
                      </FieldDescription>
                    ) : null}
                    {(dateSeries || fromDate || toDate) && !dateWindowValid ? (
                      <FieldError>
                        Choose an inclusive range of 1–366 days, with the start
                        date on or before the end.
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
                    {(dateSeries || fromDate || toDate) && !dateWindowValid ? (
                      <FieldError>
                        Choose an inclusive range of 1–366 days, with the start
                        date on or before the end.
                      </FieldError>
                    ) : null}
                  </Field>
                </>
              ) : null}
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
                    categorical previews show at most 100 groups; table, CSV,
                    and print retain the full snapshot.
                  </FieldDescription>
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

            <ChartFilterControls
              filterFields={filterFields}
              filters={filters}
              filterLogic={filterLogic}
              filterValidation={filterValidation}
              queryLoading={queryLoading}
              setFilters={setFilters}
              setFilterLogic={setFilterLogic}
              addFilter={addFilter}
            />

            <fieldset className="flex flex-wrap gap-x-6 gap-y-3 rounded-[var(--radius)] border p-4">
              <legend className="px-1 text-sm font-medium">
                Chart display
              </legend>
              <Field className="flex-row items-center gap-3">
                <Checkbox
                  id="chart-show-legend"
                  checked={showLegend}
                  disabled={queryLoading}
                  onCheckedChange={(checked) => setShowLegend(checked === true)}
                />
                <FieldLabel htmlFor="chart-show-legend" className="font-normal">
                  Show legend
                </FieldLabel>
              </Field>
              <Field className="flex-row items-center gap-3">
                <Checkbox
                  id="chart-show-values"
                  checked={showValues}
                  disabled={queryLoading}
                  onCheckedChange={(checked) => setShowValues(checked === true)}
                />
                <FieldLabel htmlFor="chart-show-values" className="font-normal">
                  Show values
                </FieldLabel>
              </Field>
            </fieldset>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={
                  !preferencesLoaded ||
                  preferencesLoading ||
                  preferencesSaving ||
                  settingsDenied ||
                  !preferenceConfigDraft
                }
                onClick={() => void saveSettings()}
              >
                {preferencesSaving ? "Saving settings…" : "Save settings"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={
                  !preferencesLoaded ||
                  preferencesLoading ||
                  preferencesSaving ||
                  settingsDenied ||
                  !moduleId ||
                  (categoryFields.length === 0 && dateFields.length === 0)
                }
                onClick={() => void resetSettings()}
              >
                Reset settings
              </Button>
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
  );
}
