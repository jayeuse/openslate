"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChartColumn,
  ChartLine,
  ChartPie,
  Filter,
  Hash,
  List,
  RefreshCw,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DialogFrameFooter,
  DialogFrameHeader,
  dialogFrameContentClass,
} from "@/components/ui/dialog-frame";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api-errors";
import { cn } from "@/lib/utils";
import {
  createOpenViewChart,
  getOpenViewChart,
  updateOpenViewChart,
  type SavedChart,
} from "../adapters/charts-api";
import {
  linkedFieldsOptions,
  linkedModuleIds,
  queryDashboardWidgetData,
} from "../adapters/dashboard-queries";
import type {
  OpenViewDashboard,
  OpenViewWidgetSource,
} from "../adapters/dashboards-api";
import { fieldsFirstPageOptions } from "../adapters/openview-queries";
import type { OpenViewDataSource } from "../adapters/views-api";
import {
  aggregationLabel,
  compileChartEditorDraft,
  editorFieldReference,
  editorFilterValidation,
  isCategoricalField,
  NUMERIC_TYPES,
  type Aggregation,
  type ChartEditorDraft,
  type FilterDraft,
} from "../domain/chart-query";
import type { AggregateBucket } from "../domain/aggregate-buckets";
import {
  draftForKind,
  draftKind,
  draftOnModule,
  fillDraft,
  newKindDraft,
} from "../domain/dashboard-builder-draft";
import {
  dashboardWidgetEditorDraft,
  type DashboardWidgetData,
  type DraftWidget,
} from "../domain/dashboard-draft";
import {
  SIZE_RULES,
  type Size,
  type WidgetKind,
} from "../domain/dashboard-grid";
import { widgetTitle } from "../domain/dashboard-widget-text";
import { ChartFilterControls } from "./chart-filter-controls";
import { DashboardSavedCharts } from "./dashboard-saved-charts";
import { PreviewCard } from "./dashboard-preview-card";

export type BuilderRequest = {
  /** Add from an empty cell, a preset space or Add widget; edit a widget. */
  mode: "add" | "edit";
  kind: WidgetKind | null;
  /** The widget being edited, with what it shows. */
  widget: DraftWidget | null;
  /** The sizes each kind can take here, largest first; empty means it does not fit. */
  sizes: (kind: WidgetKind) => Size[];
  /** The size the request starts with (an edited widget's own size). */
  size: Size | null;
  /** Open the saved-chart list first (the old Charts page links). */
  savedList: boolean;
};

export type BuilderResult = {
  source: OpenViewWidgetSource;
  kind: WidgetKind;
  size: Size;
};

const KINDS: { kind: WidgetKind; icon: LucideIcon }[] = [
  { kind: "number", icon: Hash },
  { kind: "bar", icon: ChartColumn },
  { kind: "line", icon: ChartLine },
  { kind: "pie", icon: ChartPie },
  { kind: "table", icon: Table2 },
  { kind: "records", icon: List },
];
const SHORT_KIND: Record<WidgetKind, string> = {
  number: "Number",
  bar: "Bar",
  line: "Line",
  pie: "Pie",
  table: "Table",
  records: "Records",
};

function sizeText(size: Size) {
  return `${size.columns} × ${size.rows}`;
}

/**
 * The chart builder (BD10, BD11): Setup on the left in label-left rows, the
 * widget as it shows at its size on the right, updated on request. It
 * replaces the Charts page; "Use a saved chart instead" lists saved charts.
 */
export function DashboardChartBuilder(props: {
  request: BuilderRequest | null;
  dashboard: OpenViewDashboard | null;
  dashboardName: string;
  departmentId: string;
  departmentNames: ReadonlyMap<string, string>;
  sources: readonly OpenViewDataSource[];
  onClose: () => void;
  onApply: (result: BuilderResult) => void;
}) {
  return (
    <Dialog
      open={props.request !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className={cn(
          dialogFrameContentClass,
          "h-[min(43.75rem,calc(100dvh-3rem))] max-w-[min(67.5rem,calc(100vw-2rem))] gap-0 overflow-hidden",
        )}
      >
        {props.request ? (
          <BuilderBody {...props} request={props.request} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function BuilderBody({
  request,
  dashboard,
  dashboardName,
  departmentId,
  departmentNames,
  sources,
  onClose,
  onApply,
}: Parameters<typeof DashboardChartBuilder>[0] & { request: BuilderRequest }) {
  const id = useId();
  const own = useMemo(
    () => sources.filter((source) => source.departmentId === departmentId),
    [sources, departmentId],
  );
  const relationships = useQuery(linkedFieldsOptions());
  const linked = useMemo(() => {
    const ids = linkedModuleIds(
      new Set(own.map((source) => source.id)),
      relationships.data?.items ?? [],
    );
    return sources.filter((source) => ids.has(source.id));
  }, [own, relationships.data, sources]);
  const firstModule = own[0]?.id ?? linked[0]?.id ?? "";
  // A new chart starts as the kind that best fills its space.
  const startKind =
    request.kind ??
    (["bar", "table", "records", "line", "pie", "number"] as const).find(
      (kind) => request.sizes(kind).length > 0,
    ) ??
    "bar";
  const [today] = useState(localToday);
  const [draft, setDraft] = useState<ChartEditorDraft>(() =>
    request.widget?.config
      ? dashboardWidgetEditorDraft(request.widget, request.widget.config)
      : newKindDraft(firstModule, startKind, [], today),
  );
  const kind = draftKind(draft);
  const fieldsQuery = useQuery(fieldsFirstPageOptions(draft.moduleId));
  const fields = useMemo(
    () => fieldsQuery.data?.items ?? [],
    [fieldsQuery.data],
  );
  // The fields a kind needs arrive with the module's fields.
  useEffect(() => {
    if (fields.length) setDraft((current) => fillDraft(current, fields));
  }, [fields]);
  // A saved chart on the widget: read it, and edit a copy or the chart itself.
  const [reference, setReference] = useState<SavedChart | null>(null);
  const [referenceError, setReferenceError] = useState("");
  const [everywhere, setEverywhere] = useState(false);
  const referenceId = request.widget?.chartId ?? null;
  useEffect(() => {
    if (!referenceId) return;
    const controller = new AbortController();
    void getOpenViewChart(referenceId, controller.signal)
      .then((chart) => {
        if (controller.signal.aborted) return;
        setReference(chart);
        setDraft(
          dashboardWidgetEditorDraft(
            { ...request.widget!, config: chart.config } as DraftWidget,
            chart.config,
          ),
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setReferenceError(
            apiErrorMessage(error, "The saved chart could not be opened."),
          );
      });
    return () => controller.abort();
  }, [referenceId, request.widget]);

  const sizes = request.sizes(kind);
  const [chosenSize, setChosenSize] = useState<Size | null>(request.size);
  const size =
    chosenSize &&
    sizes.some(
      (option) =>
        option.columns === chosenSize.columns &&
        option.rows === chosenSize.rows,
    )
      ? chosenSize
      : (sizes[0] ?? null);
  const [saveForReuse, setSaveForReuse] = useState(false);
  const [reuseName, setReuseName] = useState("");
  const [savedMode, setSavedMode] = useState(request.savedList);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{
    signature: string;
    data: DashboardWidgetData;
  } | null>(null);
  const previewRead = useRef<AbortController | null>(null);
  useEffect(() => () => previewRead.current?.abort(), []);

  const compiled = compileChartEditorDraft(draft, fields);
  const signature = JSON.stringify(compiled);
  const moduleName =
    sources.find((source) => source.id === draft.moduleId)?.name ?? null;
  const generatedTitle = widgetTitle({
    kind,
    config: compiled?.config ?? null,
    savedName: null,
    moduleName,
    fields,
  });
  const titleText = everywhere && reference ? reference.name : generatedTitle;

  function changeKind(next: WidgetKind) {
    setDraft((current) => draftForKind(current, next, fields, today));
  }

  async function updatePreview(source: OpenViewWidgetSource, key: string) {
    previewRead.current?.abort();
    const controller = new AbortController();
    previewRead.current = controller;
    setPending(true);
    setError("");
    try {
      const data = await queryDashboardWidgetData(
        source,
        0,
        size ? 4 + Math.max(0, size.rows - 2) * 3 : 5,
        controller.signal,
      );
      if (!controller.signal.aborted) setPreview({ signature: key, data });
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          apiErrorMessage(failure, "The preview could not be read. Try again."),
        );
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  async function apply() {
    if (!compiled || !size || pending) return;
    setPending(true);
    setError("");
    try {
      let source: OpenViewWidgetSource = { ...compiled, chartId: null };
      if (reference && everywhere) {
        const chart = await updateOpenViewChart(
          reference.id,
          reference.revision,
          reference.name,
          compiled,
        );
        source = sourceForChart(chart);
      } else if (saveForReuse) {
        const chart = await createOpenViewChart(reuseName.trim(), compiled);
        source = sourceForChart(chart);
      }
      onApply({ source, kind, size });
    } catch (failure) {
      setError(
        apiErrorMessage(
          failure,
          "The chart could not be saved. Your choices are still here.",
        ),
      );
      setPending(false);
    }
  }

  const applyReason = !size
    ? `No room for a ${SIZE_RULES[kind].label} here`
    : !compiled
      ? "Finish the setup first"
      : saveForReuse && !reuseName.trim()
        ? "Name the chart to save it for reuse"
        : pending
          ? "Saving…"
          : null;
  const applyLabel =
    request.mode === "edit" ? "Apply changes" : "Add to dashboard";
  const sizeLabel = size ? `${sizeText(size)} space` : "no free space";

  return (
    <>
      <DialogFrameHeader
        title={
          <span className="flex flex-wrap items-baseline gap-x-3">
            <DialogTitle>
              {request.mode === "edit" ? "Edit chart" : "Add a chart"}
            </DialogTitle>
            <span className="text-muted-foreground text-sm">
              {dashboardName} · {sizeLabel}
            </span>
          </span>
        }
        closeLabel={
          request.mode === "edit"
            ? "Close without changing"
            : "Close without adding"
        }
        onClose={onClose}
      />
      {savedMode ? (
        <DashboardSavedCharts
          departmentId={departmentId}
          moduleIds={new Set([...own, ...linked].map((source) => source.id))}
          sources={sources}
          departmentNames={departmentNames}
          dashboard={dashboard}
          sizes={request.sizes}
          onBack={() => setSavedMode(false)}
          onCancel={onClose}
          onAdd={onApply}
          applyLabel={applyLabel}
        />
      ) : (
        <>
          <div className="-mx-5 grid min-h-0 flex-1 lg:grid-cols-[22.5rem_minmax(0,1fr)]">
            <div className="min-h-0 overflow-y-auto border-b px-5 py-4 lg:border-r lg:border-b-0">
              <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5">
                {referenceError ? (
                  <p
                    role="alert"
                    className="text-danger-text col-span-2 text-sm"
                  >
                    {referenceError}
                  </p>
                ) : null}
                <Row label="Show as" id={`${id}-kinds`} top>
                  <div
                    role="radiogroup"
                    aria-labelledby={`${id}-kinds`}
                    className="grid grid-cols-3 gap-1.5"
                  >
                    {KINDS.map((option) => {
                      const room = request.sizes(option.kind).length > 0;
                      const rule = SIZE_RULES[option.kind];
                      const reason = room
                        ? null
                        : `A ${rule.label} needs at least ${rule.minColumns} × ${rule.minRows}`;
                      const checked = option.kind === kind;
                      return (
                        <DisabledReason key={option.kind} reason={reason}>
                          <button
                            type="button"
                            role="radio"
                            aria-checked={checked}
                            disabled={pending}
                            onClick={() => changeKind(option.kind)}
                            className={cn(
                              "flex h-14 flex-col items-center justify-center gap-1 rounded-md border text-xs",
                              checked
                                ? "border-primary bg-action-tint text-action-text font-medium"
                                : "bg-card hover:bg-muted",
                              reason && "text-muted-foreground opacity-55",
                            )}
                          >
                            <option.icon
                              aria-hidden="true"
                              className="size-4"
                            />
                            {SHORT_KIND[option.kind]}
                          </button>
                        </DisabledReason>
                      );
                    })}
                  </div>
                </Row>
                <Row label="Records" id={`${id}-module`}>
                  <Select
                    id={`${id}-module`}
                    value={draft.moduleId}
                    disabled={pending}
                    onValueChange={(moduleId) =>
                      setDraft((current) =>
                        draftOnModule(current, moduleId, [], today),
                      )
                    }
                  >
                    {draft.moduleId &&
                    ![...own, ...linked].some(
                      (source) => source.id === draft.moduleId,
                    ) ? (
                      <option value={draft.moduleId}>
                        {moduleName ?? "Unavailable module"}
                      </option>
                    ) : null}
                    <optgroup
                      label={
                        departmentNames.get(departmentId) ?? "This department"
                      }
                    >
                      {own.map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.name}
                        </option>
                      ))}
                    </optgroup>
                    {linked.length ? (
                      <optgroup label="Linked departments">
                        {linked.map((source) => (
                          <option key={source.id} value={source.id}>
                            {departmentNames.get(source.departmentId) ??
                              "Other"}{" "}
                            › {source.name}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                  </Select>
                </Row>
                <KindRows
                  id={id}
                  draft={draft}
                  setDraft={setDraft}
                  fields={fields}
                  kind={kind}
                  disabled={pending}
                />
                <Row label="Title" id={`${id}-title`}>
                  {saveForReuse ? (
                    <Input
                      id={`${id}-title`}
                      value={reuseName}
                      maxLength={120}
                      placeholder={generatedTitle}
                      onChange={(event) => setReuseName(event.target.value)}
                    />
                  ) : (
                    <p id={`${id}-title`} className="truncate py-1.5 text-sm">
                      {titleText}
                    </p>
                  )}
                </Row>
                <Row label="Size" id={`${id}-size`}>
                  <Select
                    id={`${id}-size`}
                    value={size ? sizeText(size) : ""}
                    disabled={pending || sizes.length === 0}
                    onValueChange={(value) => {
                      const [columns, rows] = value.split(" × ").map(Number);
                      setChosenSize({ columns, rows });
                    }}
                  >
                    {sizes.length === 0 ? (
                      <option value="">No room here</option>
                    ) : null}
                    {sizes.map((option) => (
                      <option key={sizeText(option)} value={sizeText(option)}>
                        {sizeText(option)}
                      </option>
                    ))}
                  </Select>
                </Row>
              </div>
            </div>
            <section
              aria-label="Preview"
              className="bg-muted/40 flex min-h-0 flex-col gap-3 overflow-y-auto px-5 py-4"
            >
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">Preview</h3>
                <span className="text-muted-foreground text-xs">
                  {size ? `as it shows at ${sizeText(size)}` : null}
                </span>
                <DisabledReason
                  reason={
                    compiled
                      ? pending
                        ? "Reading…"
                        : null
                      : "Finish the setup first"
                  }
                >
                  <Button
                    type="button"
                    variant="ghost"
                    className="ml-auto min-h-11"
                    onClick={() => {
                      if (compiled)
                        void updatePreview(
                          { ...compiled, chartId: null },
                          signature,
                        );
                    }}
                  >
                    <RefreshCw aria-hidden="true" />
                    Update preview
                  </Button>
                </DisabledReason>
              </div>
              <PreviewCard
                data={preview?.signature === signature ? preview.data : null}
                stale={Boolean(preview && preview.signature !== signature)}
                kind={kind}
                size={size}
                sources={sources}
                departmentNames={departmentNames}
                dashboard={dashboard}
              />
              {moduleName ? (
                <p className="text-muted-foreground text-xs">
                  People who cannot open {moduleName} see a locked card instead
                  of this chart.
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="text-danger-text text-sm">
                  {error}
                </p>
              ) : null}
            </section>
          </div>
          <DialogFrameFooter className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground mr-auto min-h-11"
              disabled={pending}
              onClick={() => setSavedMode(true)}
            >
              Use a saved chart instead
            </Button>
            {reference ? (
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <Checkbox
                  checked={everywhere}
                  disabled={pending}
                  onCheckedChange={(checked) => setEverywhere(checked === true)}
                />
                Change “{reference.name}” everywhere
              </label>
            ) : (
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <Checkbox
                  checked={saveForReuse}
                  disabled={pending}
                  onCheckedChange={(checked) => {
                    setSaveForReuse(checked === true);
                    if (checked === true && !reuseName)
                      setReuseName(generatedTitle);
                  }}
                />
                Save for reuse
              </label>
            )}
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={onClose}
            >
              Cancel
            </Button>
            <DisabledReason reason={applyReason} stable>
              <Button
                type="button"
                className="min-h-11"
                onClick={() => void apply()}
              >
                {applyLabel}
              </Button>
            </DisabledReason>
          </DialogFrameFooter>
        </>
      )}
    </>
  );
}

function localToday(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function sourceForChart(chart: SavedChart): OpenViewWidgetSource {
  const widgetType =
    chart.chartType === "bar" ||
    chart.chartType === "line" ||
    chart.chartType === "pie"
      ? "chart"
      : chart.chartType;
  return {
    widgetType,
    chartId: chart.id,
    config: null,
  } as OpenViewWidgetSource;
}

function Row({
  label,
  id,
  top,
  children,
}: {
  label: string;
  id: string;
  top?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <label
        htmlFor={id}
        id={top ? id : undefined}
        className={cn(
          "text-muted-foreground text-sm",
          top && "self-start pt-2",
        )}
      >
        {label}
      </label>
      <div className="min-w-0">{children}</div>
    </>
  );
}

const AGGREGATIONS: Aggregation[] = [
  "count",
  "sum",
  "average",
  "min",
  "max",
  "distinct",
];

/** Group by, Show, Filters, Dates and Order: the rows a kind uses. */
function KindRows({
  id,
  draft,
  setDraft,
  fields,
  kind,
  disabled,
}: {
  id: string;
  draft: ChartEditorDraft;
  setDraft: Dispatch<SetStateAction<ChartEditorDraft>>;
  fields: ChartEditorDraftFields;
  kind: WidgetKind;
  disabled: boolean;
}) {
  const own = fields.filter((field) => field.moduleId === draft.moduleId);
  const categories = own.filter(isCategoricalField);
  const dates = own.filter((field) =>
    ["date", "datetime"].includes(field.type),
  );
  const reference = (fieldId: string) => {
    const field = own.find((candidate) => candidate.id === fieldId);
    return field ? editorFieldReference(field) : null;
  };
  const filters = draft.filters.filter((row) => row.operator !== "in");
  const setFilters: Dispatch<SetStateAction<FilterDraft[]>> = (change) =>
    setDraft((current) => {
      const editable = current.filters.filter((row) => row.operator !== "in");
      const next = typeof change === "function" ? change(editable) : change;
      const byId = new Map(next.map((row) => [row.id, row]));
      return {
        ...current,
        filters: current.filters.flatMap((old) => {
          if (old.operator === "in") return [old];
          const row = byId.get(old.id);
          if (!row) return [];
          const field = own.find((candidate) => candidate.id === row.fieldId);
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
      };
    });
  const addFilter = () =>
    setDraft((current) => {
      const field = own[0];
      if (!field || current.filters.length >= 10) return current;
      return {
        ...current,
        filters: [
          ...current.filters,
          {
            id: current.nextFilterId,
            fieldId: field.id,
            expectedType: field.type,
            operator: "eq",
            value: "",
            original: null,
          },
        ],
        nextFilterId: current.nextFilterId + 1,
      };
    });
  const aggregate = draft.mode === "records" ? null : draft;
  const measures =
    aggregate?.aggregation === "distinct"
      ? own
      : own.filter((field) => NUMERIC_TYPES.has(field.type));
  const aggregations =
    kind === "number"
      ? AGGREGATIONS.filter(
          (value) => value !== "average" && value !== "distinct",
        )
      : AGGREGATIONS;
  return (
    <>
      {draft.mode === "groups" && kind !== "number" ? (
        <Row label="Group by" id={`${id}-group`}>
          <Select
            id={`${id}-group`}
            value={draft.dimension?.fieldId ?? ""}
            disabled={disabled || !categories.length}
            placeholder={
              categories.length ? "Choose a field" : "No category fields"
            }
            onValueChange={(fieldId) =>
              setDraft((current) =>
                current.mode === "groups"
                  ? { ...current, dimension: reference(fieldId) }
                  : current,
              )
            }
          >
            {categories.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </Select>
        </Row>
      ) : null}
      {draft.mode === "date_series" ? (
        <>
          <Row label="Over" id={`${id}-date`}>
            <Select
              id={`${id}-date`}
              value={draft.dateField?.fieldId ?? ""}
              disabled={disabled || !dates.length}
              placeholder={
                dates.length ? "Choose a date field" : "No date fields"
              }
              onValueChange={(fieldId) =>
                setDraft((current) => ({
                  ...current,
                  dateField: reference(fieldId),
                }))
              }
            >
              {dates.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Per" id={`${id}-bucket`}>
            <Select
              id={`${id}-bucket`}
              value={draft.bucket}
              disabled={disabled}
              onValueChange={(bucket) =>
                setDraft((current) =>
                  current.mode === "date_series"
                    ? { ...current, bucket: bucket as AggregateBucket }
                    : current,
                )
              }
            >
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="quarter">Quarter</option>
              <option value="year">Year</option>
            </Select>
          </Row>
        </>
      ) : null}
      {aggregate ? (
        <Row label="Show" id={`${id}-show`}>
          <div className="grid gap-1.5">
            <Select
              id={`${id}-show`}
              value={aggregate.aggregation}
              disabled={disabled}
              onValueChange={(value) =>
                setDraft((current) => {
                  if (current.mode === "records") return current;
                  const aggregation = value as Aggregation;
                  const measure =
                    aggregation === "count" ||
                    (aggregation !== "distinct" &&
                      current.measure &&
                      !NUMERIC_TYPES.has(current.measure.expectedType))
                      ? null
                      : current.measure;
                  return { ...current, aggregation, measure };
                })
              }
            >
              {aggregations.map((value) => (
                <option key={value} value={value}>
                  {value === "count"
                    ? "Number of records"
                    : aggregationLabel(value)}
                </option>
              ))}
            </Select>
            {aggregate.aggregation !== "count" ? (
              <Select
                aria-label="Of the field"
                value={aggregate.measure?.fieldId ?? ""}
                disabled={disabled || !measures.length}
                placeholder={
                  measures.length ? "Of the field" : "No number fields"
                }
                onValueChange={(fieldId) =>
                  setDraft((current) => ({
                    ...current,
                    measure: reference(fieldId),
                  }))
                }
              >
                {measures.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.name}
                  </option>
                ))}
              </Select>
            ) : null}
          </div>
        </Row>
      ) : null}
      {draft.mode === "records" ? (
        <Row label="Columns" id={`${id}-columns`}>
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  id={`${id}-columns`}
                  type="button"
                  variant="outline"
                  className="min-h-11 w-full justify-start"
                  disabled={disabled}
                />
              }
            >
              {draft.definition.columns
                .map(
                  (column) =>
                    own.find((field) => field.id === column.fieldId)?.name ??
                    "Field",
                )
                .join(", ") || "Choose columns"}
            </PopoverTrigger>
            <PopoverContent align="start" className="slim-ui w-72 p-3">
              <PopoverHeader>
                <PopoverTitle>Columns</PopoverTitle>
                <PopoverDescription>
                  The list shows up to three.
                </PopoverDescription>
              </PopoverHeader>
              <div className="mt-2 grid gap-1">
                {own.map((field) => {
                  const checked = draft.definition.columns.some(
                    (column) => column.fieldId === field.id,
                  );
                  return (
                    <label
                      key={field.id}
                      className="flex min-h-11 items-center gap-2 text-sm xl:min-h-8"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) =>
                          setDraft((current) => ({
                            ...current,
                            definition: {
                              ...current.definition,
                              columns:
                                next === true
                                  ? [
                                      ...current.definition.columns,
                                      editorFieldReference(field),
                                    ]
                                  : current.definition.columns.filter(
                                      (column) => column.fieldId !== field.id,
                                    ),
                            },
                          }))
                        }
                      />
                      {field.name}
                    </label>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        </Row>
      ) : null}
      <Row label="Filters" id={`${id}-filters`}>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                id={`${id}-filters`}
                type="button"
                variant="ghost"
                className="min-h-11 px-0"
                disabled={disabled || !own.length}
              />
            }
          >
            <Filter aria-hidden="true" />
            {draft.filters.length
              ? `${draft.filters.length} ${draft.filters.length === 1 ? "filter" : "filters"}`
              : "Add filter"}
          </PopoverTrigger>
          <PopoverContent
            align="start"
            collisionPadding={12}
            className="slim-ui max-h-[min(36rem,calc(100dvh-6rem))] w-[min(44rem,calc(100vw-2rem))] gap-4 overflow-y-auto p-4"
          >
            <PopoverHeader>
              <PopoverTitle>Filters</PopoverTitle>
              <PopoverDescription>
                Only matching records count.
              </PopoverDescription>
            </PopoverHeader>
            <ChartFilterControls
              key={draft.moduleId}
              moduleId={draft.moduleId}
              filterFields={own}
              filters={filters}
              filterLogic={draft.definition.logic}
              filterValidation={editorFilterValidation(draft, own)}
              queryLoading={disabled}
              setFilters={setFilters}
              setFilterLogic={(logic) =>
                setDraft((current) => ({
                  ...current,
                  definition: { ...current.definition, logic },
                }))
              }
              addFilter={addFilter}
            />
          </PopoverContent>
        </Popover>
      </Row>
      {aggregate ? (
        <Row label="Dates" id={`${id}-dates`}>
          <DatesRow
            id={`${id}-dates`}
            draft={aggregate}
            dates={dates}
            disabled={disabled}
            setDraft={setDraft}
          />
        </Row>
      ) : null}
      {draft.mode === "records" ? (
        <Row label="Order" id={`${id}-order`}>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
            <Select
              id={`${id}-order`}
              value={draft.definition.sort[0]?.fieldId ?? ""}
              disabled={disabled}
              onValueChange={(fieldId) =>
                setDraft((current) => {
                  const field = reference(fieldId);
                  return {
                    ...current,
                    definition: {
                      ...current.definition,
                      sort: field
                        ? [
                            {
                              ...field,
                              direction:
                                current.definition.sort[0]?.direction ?? "desc",
                            },
                          ]
                        : [],
                    },
                  };
                })
              }
            >
              <option value="">As entered</option>
              {own.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Direction"
              className="w-32"
              value={draft.definition.sort[0]?.direction ?? "desc"}
              disabled={disabled || !draft.definition.sort.length}
              onValueChange={(direction) =>
                setDraft((current) => ({
                  ...current,
                  definition: {
                    ...current.definition,
                    sort: current.definition.sort.map((sort, index) =>
                      index === 0
                        ? { ...sort, direction: direction as "asc" | "desc" }
                        : sort,
                    ),
                  },
                }))
              }
            >
              <option value="desc">Newest or largest first</option>
              <option value="asc">Oldest or smallest first</option>
            </Select>
          </div>
        </Row>
      ) : null}
    </>
  );
}

type ChartEditorDraftFields = Parameters<typeof compileChartEditorDraft>[1];

function DatesRow({
  id,
  draft,
  dates,
  disabled,
  setDraft,
}: {
  id: string;
  draft: Exclude<ChartEditorDraft, { mode: "records" }>;
  dates: ChartEditorDraftFields;
  disabled: boolean;
  setDraft: Dispatch<SetStateAction<ChartEditorDraft>>;
}) {
  const series = draft.mode === "date_series";
  const windowOn = series || Boolean(draft.dateField);
  return (
    <div className="grid gap-1.5">
      {series ? null : (
        <Select
          id={id}
          value={draft.dateField?.fieldId ?? ""}
          disabled={disabled || !dates.length}
          onValueChange={(fieldId) =>
            setDraft((current) => {
              const field = dates.find((candidate) => candidate.id === fieldId);
              return {
                ...current,
                dateField: field ? editorFieldReference(field) : null,
                ...(field ? {} : { fromDate: "", toDate: "" }),
              } as ChartEditorDraft;
            })
          }
        >
          <option value="">All dates</option>
          {dates.map((field) => (
            <option key={field.id} value={field.id}>
              By {field.name}
            </option>
          ))}
        </Select>
      )}
      {windowOn ? (
        <div className="grid grid-cols-2 gap-1.5">
          <Input
            id={series ? id : undefined}
            type="date"
            aria-label="From"
            value={draft.fromDate}
            disabled={disabled}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                fromDate: event.target.value,
              }))
            }
          />
          <Input
            type="date"
            aria-label="To"
            value={draft.toDate}
            disabled={disabled}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                toDate: event.target.value,
              }))
            }
          />
        </div>
      ) : null}
    </div>
  );
}
