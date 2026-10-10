"use client";

import type { Dispatch, SetStateAction, ReactNode } from "react";
import { CalendarDays, Filter, ListFilter } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, type SelectProps } from "@/components/ui/select";
import { cn } from "@/lib/utils";
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
} from "../../adapters/views-api";
import {
  aggregationLabel,
  compileChartEditorDraft,
  editorDateWindowValid,
  editorField,
  editorFieldReference,
  editorFilterValidation,
  isCategoricalField,
  isNumericField,
  NUMERIC_TYPES,
  newChartEditorDraft,
  type ChartEditorDraft,
  type Aggregation,
  type ChartType,
  type FilterDraft,
  type FilterLogic,
} from "../../domain/chart-query";
import type { AggregateBucket } from "../../domain/aggregate-buckets";
import { ChartFilterControls } from "../chart-filter-controls";

export type ChartEditorCatalog = {
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
  fields: OpenViewDataSourceField[];
};

export type ChartEditorActions = {
  retryCatalog: () => void;
  retryFields: () => void;
  loadMoreSources: () => Promise<void>;
  loadMoreFields: () => Promise<void>;
};

type ChartEditorProps = {
  catalog: ChartEditorCatalog;
  value: ChartEditorDraft;
  onChange: (value: ChartEditorDraft) => void;
  actions: ChartEditorActions;
  queryLoading: boolean;
  onApply?: () => void;
  children?: ReactNode;
};

function EditorOptions(props: {
  title: string;
  label?: string;
  headerTitle?: string;
  icon: ReactNode;
  badge?: ReactNode;
  description: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            aria-label={props.label ?? props.title}
          />
        }
      >
        {props.icon}
        <span>{props.title}</span>
        {props.badge}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        className={cn(
          "max-h-[min(36rem,calc(100dvh-6rem))] gap-4 overflow-y-auto p-4",
          props.className,
        )}
      >
        <PopoverHeader>
          <PopoverTitle>{props.headerTitle ?? props.title}</PopoverTitle>
          <PopoverDescription>{props.description}</PopoverDescription>
        </PopoverHeader>
        {props.children}
      </PopoverContent>
    </Popover>
  );
}

function EditorSelect({
  label,
  options,
  description,
  className,
  children,
  ...select
}: Pick<
  SelectProps,
  "id" | "value" | "disabled" | "onValueChange" | "placeholder"
> & {
  label: string;
  options: ReadonlyArray<readonly [string, string]>;
  description?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Field className={className}>
      <FieldLabel htmlFor={select.id}>{label}</FieldLabel>
      <Select {...select} className="min-h-11">
        {select.value && !options.some(([id]) => id === select.value) ? (
          <option value={select.value} disabled>
            Unavailable field or source
          </option>
        ) : null}
        {options.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </Select>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {children}
    </Field>
  );
}

export function ChartEditor({
  catalog,
  value,
  onChange,
  actions,
  queryLoading,
  onApply,
  children,
}: ChartEditorProps) {
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
    fields: filterFields,
  } = catalog;
  const { moduleId, filters } = value;
  const records = value.mode === "records";
  const dateSeries = value.mode === "date_series";
  const categoryFields = filterFields.filter(isCategoricalField);
  const dateFields = filterFields.filter((field) =>
    ["date", "datetime"].includes(field.type),
  );
  const aggregation = records ? "count" : value.aggregation;
  const measureFields =
    aggregation === "distinct"
      ? filterFields
      : filterFields.filter(isNumericField);
  const groupReference =
    value.mode === "groups"
      ? value.dimension
      : value.mode === "date_series"
        ? value.dateField
        : null;
  const dateFieldId = records ? "" : (value.dateField?.fieldId ?? "");
  const selectedDateField = records
    ? undefined
    : editorField(value.dateField, dateFields);
  const fromDate = records ? "" : value.fromDate;
  const toDate = records ? "" : value.toDate;
  const dateWindowValid = editorDateWindowValid(value);
  const filterValidation = editorFilterValidation(value, filterFields);
  const filterLogic = value.definition.logic;
  const canRunQuery = Boolean(
    !queryLoading &&
    !sourcesLoading &&
    !sourcesError &&
    !fieldsLoading &&
    !fieldsError &&
    sources.some((source) => source.id === moduleId) &&
    compileChartEditorDraft(value, filterFields),
  );
  const { retryCatalog, retryFields, loadMoreSources, loadMoreFields } =
    actions;

  function setModuleId(next: string) {
    const fresh = newChartEditorDraft(next, []);
    const base = {
      moduleId: next,
      definition: fresh.definition,
      filters: [],
      nextFilterId: value.nextFilterId,
    };
    if (value.mode === "records") onChange({ ...value, ...base });
    else {
      const aggregate = {
        ...value,
        ...base,
        dateField: null,
        measure: null,
        fromDate: "",
        toDate: "",
      };
      onChange(
        aggregate.mode === "groups"
          ? { ...aggregate, dimension: null }
          : aggregate,
      );
    }
  }
  function setChartType(next: ChartType) {
    if (value.widgetType !== "chart") return;
    const base = {
      moduleId: value.moduleId,
      definition: value.definition,
      filters: value.filters,
      nextFilterId: value.nextFilterId,
      aggregation: value.aggregation,
      measure: value.measure,
      fromDate: value.fromDate,
      toDate: value.toDate,
      dateField: value.dateField,
    };
    onChange(
      next === "line"
        ? {
            ...base,
            widgetType: "chart",
            chartType: "line",
            mode: "date_series",
            bucket: value.mode === "date_series" ? value.bucket : "day",
            dateField:
              value.dateField ??
              (dateFields[0] ? editorFieldReference(dateFields[0]) : null),
          }
        : {
            ...base,
            widgetType: "chart",
            chartType: next,
            mode: "groups",
            dimension:
              value.mode === "groups"
                ? value.dimension
                : categoryFields[0]
                  ? editorFieldReference(categoryFields[0])
                  : null,
          },
    );
  }
  function setReference(
    key: "dimension" | "dateField" | "measure",
    fieldId: string,
  ) {
    if (
      value.mode === "records" ||
      (key === "dimension" && value.mode !== "groups")
    )
      return;
    const field = filterFields.find((field) => field.id === fieldId);
    onChange({ ...value, [key]: field ? editorFieldReference(field) : null });
  }
  const setDimensionId = (id: string) => setReference("dimension", id);
  const setDateFieldId = (id: string) => setReference("dateField", id);
  const setMeasureId = (id: string) => setReference("measure", id);
  function setAggregation(next: Aggregation) {
    if (value.mode === "records") return;
    const measure =
      next === "count" ||
      (next !== "distinct" &&
        value.measure &&
        !NUMERIC_TYPES.has(value.measure.expectedType))
        ? null
        : value.measure;
    onChange({ ...value, aggregation: next, measure });
  }
  const setFilterLogic = (logic: FilterLogic) =>
    onChange({ ...value, definition: { ...value.definition, logic } });
  const setFilters: Dispatch<SetStateAction<FilterDraft[]>> = (change) => {
    const next =
      typeof change === "function"
        ? change(filters.filter((row) => row.operator !== "in"))
        : change;
    const byId = new Map(next.map((row) => [row.id, row]));
    onChange({
      ...value,
      filters: filters.flatMap((old) => {
        if (old.operator === "in") return [old];
        const row = byId.get(old.id);
        if (!row) return [];
        const field = filterFields.find((field) => field.id === row.fieldId);
        return [
          {
            ...old,
            ...row,
            expectedType:
              row.fieldId === old.fieldId
                ? old.expectedType
                : (field?.type ?? old.expectedType),
          },
        ];
      }),
    });
  };
  function addFilter() {
    const field = filterFields[0];
    if (!field || filters.length >= 10) return;
    onChange({
      ...value,
      filters: [
        ...filters,
        {
          id: value.nextFilterId,
          fieldId: field.id,
          expectedType: field.type,
          operator: "eq",
          value: "",
          original: null,
        },
      ],
      nextFilterId: value.nextFilterId + 1,
    });
  }
  const dateWindowActive = Boolean(
    fromDate &&
    toDate &&
    dateWindowValid &&
    (dateSeries ? selectedDateField : dateFieldId),
  );

  const groupFields = dateSeries ? dateFields : categoryFields;
  const errors = [
    {
      message: sourcesError
        ? `${sourcesError} ${sources.length ? "Previously loaded data sources remain available." : "No data-source list has been loaded yet."}`
        : "",
      label: "Retry catalog",
      retry: retryCatalog,
    },
    { message: fieldsError, label: "Retry fields", retry: retryFields },
    {
      message: metadataError,
      label: "Retry catalog page",
      retry: () =>
        void (metadataRetryTarget === "sources"
          ? loadMoreSources()
          : loadMoreFields()),
    },
  ].filter((error) => error.message);

  return (
    <Card className="w-full min-w-0 print:hidden">
      <CardContent>
        {errors.map((error) => (
          <Alert
            key={error.label}
            role="alert"
            variant="destructive"
            className="mb-4 flex flex-wrap items-center justify-between gap-3"
          >
            <span>{error.message}</span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={error.retry}
            >
              {error.label}
            </Button>
          </Alert>
        ))}
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
          <div className="flex flex-col gap-4">
            <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <EditorSelect
                id="chart-data-source"
                label="Data source"
                value={moduleId}
                placeholder="Select a data source"
                options={sources.map((source) => [source.id, source.name])}
                disabled={sourcesLoading || !sources.length || queryLoading}
                onValueChange={setModuleId}
              >
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
              </EditorSelect>
              {value.widgetType === "chart" ? (
                <EditorSelect
                  id="chart-type"
                  label="Chart type"
                  value={value.chartType}
                  options={[
                    ["bar", "Bar"],
                    ["line", "Line (date series)"],
                    ["pie", "Pie"],
                  ]}
                  // The type picks its default fields, so it waits for them.
                  disabled={
                    queryLoading || sourcesLoading || fieldsLoading || !moduleId
                  }
                  onValueChange={(next) => setChartType(next as ChartType)}
                />
              ) : null}
              {!records ? (
                <>
                  <EditorSelect
                    id={dateSeries ? "chart-date-field" : "chart-dimension"}
                    label="Group by"
                    value={groupReference?.fieldId ?? ""}
                    options={[
                      [
                        "",
                        dateSeries
                          ? "Select a date field"
                          : "Select a categorical field",
                      ],
                      ...groupFields
                        .filter(
                          (field) =>
                            field.id !== groupReference?.fieldId ||
                            field.type === groupReference.expectedType,
                        )
                        .map((field): [string, string] => [
                          field.id,
                          field.name,
                        ]),
                    ]}
                    disabled={
                      fieldsLoading || !groupFields.length || queryLoading
                    }
                    onValueChange={dateSeries ? setDateFieldId : setDimensionId}
                    description={
                      !groupFields.length && !fieldsLoading
                        ? dateSeries
                          ? "No date fields are available."
                          : "No categorical fields are available."
                        : dateSeries
                          ? "Choose the date field for this chronological series."
                          : undefined
                    }
                  />
                  <EditorSelect
                    id="chart-aggregation"
                    label="Measure"
                    value={aggregation}
                    options={(
                      [
                        "count",
                        "sum",
                        "average",
                        "min",
                        "max",
                        "distinct",
                      ] as const
                    ).map((metric) => [metric, aggregationLabel(metric)])}
                    disabled={queryLoading}
                    onValueChange={(next) =>
                      setAggregation(next as Aggregation)
                    }
                  />
                </>
              ) : null}

              {records ? (
                <EditorOptions
                  title="Records options"
                  icon={<ListFilter aria-hidden="true" />}
                  className="w-[min(40rem,calc(100vw-2rem))]"
                  description="Choose ordered columns, search scope, sorting and record lifecycle. Preview paging is not stored in the query."
                >
                  <RecordsOptions
                    value={value}
                    fields={filterFields}
                    disabled={queryLoading}
                    onChange={onChange}
                  />
                </EditorOptions>
              ) : null}
              {value.mode === "date_series" ? (
                <EditorSelect
                  id="chart-bucket"
                  label="Calendar bucket"
                  value={value.bucket}
                  options={[
                    ["day", "Day"],
                    ["week", "Week"],
                    ["month", "Month"],
                    ["quarter", "Quarter"],
                    ["year", "Year"],
                  ]}
                  disabled={queryLoading}
                  onValueChange={(bucket) =>
                    onChange({ ...value, bucket: bucket as AggregateBucket })
                  }
                  description="Calendar periods use the workspace’s timezone and week start."
                />
              ) : null}
              {value.mode !== "records" && aggregation !== "count" ? (
                <EditorSelect
                  id="chart-measure"
                  label={
                    aggregation === "distinct"
                      ? "Measure field"
                      : "Numeric measure"
                  }
                  className="sm:col-start-2 xl:col-start-4"
                  value={value.measure?.fieldId ?? ""}
                  options={measureFields
                    .filter(
                      (field) =>
                        field.id !== value.measure?.fieldId ||
                        field.type === value.measure.expectedType,
                    )
                    .map((field) => [field.id, field.name])}
                  disabled={
                    fieldsLoading || !measureFields.length || queryLoading
                  }
                  onValueChange={setMeasureId}
                  placeholder={
                    aggregation === "distinct"
                      ? "Select a field"
                      : "Select a numeric field"
                  }
                  description={
                    !measureFields.length
                      ? aggregation === "distinct"
                        ? "Distinct requires an available field."
                        : "Sum, average, minimum and maximum require an available numeric field."
                      : undefined
                  }
                />
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
              <EditorOptions
                title="Filters"
                label={`Filters (${filters.length})`}
                headerTitle="Chart filters"
                icon={<Filter data-icon="inline-start" aria-hidden="true" />}
                badge={<Badge variant="secondary">{filters.length}</Badge>}
                className="w-[min(44rem,calc(100vw-2rem))]"
                description="Filter the source records before aggregation. The date window is combined with these filters."
              >
                <ChartFilterControls
                  key={moduleId}
                  moduleId={moduleId}
                  filterFields={filterFields}
                  filters={filters.filter((row) => row.operator !== "in")}
                  filterLogic={filterLogic}
                  filterValidation={filterValidation}
                  queryLoading={queryLoading}
                  setFilters={setFilters}
                  setFilterLogic={setFilterLogic}
                  addFilter={addFilter}
                />
                {filters.some((row) => row.operator === "in") ? (
                  <p className="text-muted-foreground text-sm">
                    Existing membership filters are retained with their complete
                    selected-option IDs.
                  </p>
                ) : null}
              </EditorOptions>

              {!records ? (
                <EditorOptions
                  title="Date window"
                  icon={
                    <CalendarDays data-icon="inline-start" aria-hidden="true" />
                  }
                  badge={
                    dateWindowActive ? (
                      <Badge variant="secondary">Active</Badge>
                    ) : null
                  }
                  className="w-[min(30rem,calc(100vw-2rem))]"
                  description={
                    dateSeries
                      ? "Choose an inclusive period containing 1–366 calendar buckets."
                      : "Optionally limit grouped results to an inclusive date range; it is ANDed with the field filters."
                  }
                >
                  {!dateSeries ? (
                    <EditorSelect
                      id="chart-date-field"
                      label="Chart date field"
                      value={dateFieldId}
                      options={[
                        ["", "No date window"],
                        ...dateFields
                          .filter(
                            (field) =>
                              field.id !== dateFieldId ||
                              Boolean(selectedDateField),
                          )
                          .map((field): [string, string] => [
                            field.id,
                            field.name,
                          ]),
                      ]}
                      disabled={
                        fieldsLoading || !dateFields.length || queryLoading
                      }
                      onValueChange={setDateFieldId}
                      description={
                        !dateFields.length && !fieldsLoading
                          ? "No date fields are available."
                          : undefined
                      }
                    />
                  ) : null}
                  {dateSeries || dateFieldId || fromDate || toDate ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(["from", "to"] as const).map((bound) => (
                        <Field key={bound}>
                          <FieldLabel htmlFor={`chart-${bound}-date`}>
                            {dateSeries
                              ? bound === "from"
                                ? "From date"
                                : "To date"
                              : bound === "from"
                                ? "Chart from date"
                                : "Chart to date"}
                          </FieldLabel>
                          <Input
                            id={`chart-${bound}-date`}
                            className="min-h-11"
                            type="date"
                            value={bound === "from" ? fromDate : toDate}
                            disabled={queryLoading}
                            aria-invalid={!dateWindowValid}
                            aria-describedby={
                              !dateWindowValid
                                ? `chart-${bound}-error`
                                : undefined
                            }
                            onChange={(event) =>
                              onChange({
                                ...value,
                                [bound === "from" ? "fromDate" : "toDate"]:
                                  event.target.value,
                              })
                            }
                          />
                          {!dateWindowValid ? (
                            <FieldError id={`chart-${bound}-error`}>
                              {dateSeries
                                ? "Choose a range of 1–366 calendar buckets, with the start date on or before the end."
                                : "Choose a range of 1–366 days, with the start date on or before the end."}
                            </FieldError>
                          ) : null}
                        </Field>
                      ))}
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      Choose a chart date field to add an optional date window.
                    </p>
                  )}
                </EditorOptions>
              ) : null}

              {children}

              {onApply ? (
                <Button
                  type="button"
                  onClick={onApply}
                  className="min-h-11 sm:ml-auto"
                  disabled={!canRunQuery}
                >
                  {queryLoading ? "Loading complete snapshot…" : "Apply chart"}
                </Button>
              ) : null}
            </div>
            {onApply ? (
              <p className="text-muted-foreground text-sm">
                Chart query changes take effect after Apply. Display options
                update the preview; the table and exports retain the full last
                successful snapshot.
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecordsOptions({
  value,
  fields,
  disabled,
  onChange,
}: {
  value: ChartEditorDraft;
  fields: OpenViewDataSourceField[];
  disabled: boolean;
  onChange: (value: ChartEditorDraft) => void;
}) {
  const definition = value.definition;
  function change(patch: Partial<typeof definition>) {
    onChange({ ...value, definition: { ...definition, ...patch } });
  }
  function toggle(
    key: "columns" | "searchFields",
    field: OpenViewDataSourceField,
    checked: boolean,
  ) {
    change({
      [key]: checked
        ? [...definition[key], editorFieldReference(field)]
        : definition[key].filter((ref) => ref.fieldId !== field.id),
    });
  }
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">
          Display columns (in order)
        </legend>
        {definition.columns.map((ref, index) => {
          const name = editorField(ref, fields)?.name ?? "Unavailable field";
          return (
            <div
              key={ref.fieldId}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span>
                {index + 1}. {name}
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={disabled || index === 0}
                  aria-label={`Move ${name} earlier`}
                  onClick={() => {
                    const columns = [...definition.columns];
                    [columns[index - 1], columns[index]] = [
                      columns[index],
                      columns[index - 1],
                    ];
                    change({ columns });
                  }}
                >
                  Earlier
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={disabled}
                  aria-label={`Remove ${name} column`}
                  onClick={() =>
                    change({
                      columns: definition.columns.filter(
                        (column) => column.fieldId !== ref.fieldId,
                      ),
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            </div>
          );
        })}
        <div className="grid gap-2 sm:grid-cols-2">
          {fields.map((field) => (
            <label
              key={field.id}
              className="flex min-h-11 items-center gap-2 text-sm"
            >
              <input
                type="checkbox"
                aria-label={`Include ${field.name}`}
                checked={definition.columns.some(
                  (ref) => ref.fieldId === field.id,
                )}
                disabled={disabled}
                onChange={(event) =>
                  toggle("columns", field, event.target.checked)
                }
              />
              {field.name}
            </label>
          ))}
        </div>
      </fieldset>
      <Field>
        <FieldLabel htmlFor="record-search">Record search</FieldLabel>
        <Input
          id="record-search"
          className="min-h-11"
          value={definition.search ?? ""}
          maxLength={240}
          disabled={disabled}
          onChange={(event) => change({ search: event.target.value || null })}
        />
      </Field>
      <fieldset>
        <legend className="text-sm font-medium">Search fields</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {fields
            .filter((field) =>
              ["text", "long_text", "email", "url", "select"].includes(
                field.type,
              ),
            )
            .map((field) => (
              <label
                key={field.id}
                className="flex min-h-11 items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  aria-label={`Search ${field.name}`}
                  checked={definition.searchFields.some(
                    (ref) => ref.fieldId === field.id,
                  )}
                  disabled={disabled}
                  onChange={(event) =>
                    toggle("searchFields", field, event.target.checked)
                  }
                />
                {field.name}
              </label>
            ))}
        </div>
      </fieldset>
      <EditorSelect
        id="record-lifecycle"
        label="Record lifecycle"
        value={definition.deleted}
        options={[
          ["exclude", "Active records"],
          ["include", "Active and archived records"],
          ["only", "Archived records"],
        ]}
        disabled={disabled}
        onValueChange={(deleted) =>
          change({ deleted: deleted as typeof definition.deleted })
        }
      />
      {(definition.sort.length ? definition.sort : [null]).map(
        (sort, index) => (
          <div key={index} className="grid gap-3 sm:grid-cols-2">
            <EditorSelect
              id={`record-sort-${index}`}
              label={index === 0 ? "Sort field" : `Sort ${index + 1} field`}
              value={sort?.fieldId ?? ""}
              options={[
                ["", "No sort"],
                ...fields.map((field): [string, string] => [
                  field.id,
                  field.name,
                ]),
              ]}
              disabled={disabled}
              onValueChange={(id) => {
                const next = [...definition.sort];
                const field = fields.find((field) => field.id === id);
                if (field)
                  next[index] = {
                    ...editorFieldReference(field),
                    direction: sort?.direction ?? "asc",
                  };
                else next.splice(index, 1);
                change({ sort: next });
              }}
            />
            <EditorSelect
              id={`record-direction-${index}`}
              label={
                index === 0 ? "Sort direction" : `Sort ${index + 1} direction`
              }
              value={sort?.direction ?? "asc"}
              options={[
                ["asc", "Ascending"],
                ["desc", "Descending"],
              ]}
              disabled={disabled || !sort}
              onValueChange={(direction) => {
                if (sort)
                  change({
                    sort: definition.sort.map((current, i) =>
                      i === index
                        ? { ...current, direction: direction as "asc" | "desc" }
                        : current,
                    ),
                  });
              }}
            />
          </div>
        ),
      )}
      {definition.sort.length > 0 && definition.sort.length < 3 ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={
            disabled ||
            !fields.some(
              (field) =>
                !definition.sort.some((sort) => sort.fieldId === field.id),
            )
          }
          onClick={() => {
            const field = fields.find(
              (field) =>
                !definition.sort.some((sort) => sort.fieldId === field.id),
            );
            if (field)
              change({
                sort: [
                  ...definition.sort,
                  { ...editorFieldReference(field), direction: "asc" },
                ],
              });
          }}
        >
          Add sort
        </Button>
      ) : null}
    </div>
  );
}
