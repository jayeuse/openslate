"use client";

import {
  BarChart3,
  CalendarClock,
  Download,
  LineChart as LineChartIcon,
  PieChart as PieChartIcon,
  Printer,
  RotateCcw,
  Save,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { OpenViewChartPreview } from "./chart-preview";
import { OpenViewFilterEditor } from "./filter-editor";
import { sampleOperationMessage } from "../../shared/runtime/sample-async";
import {
  OPENVIEW_MODULES,
  decodeChartSettings,
  defaultChartSettings,
  getModuleDefinition,
  getOpenViewOperationalDeadlineField,
  getOpenViewRows,
  normalizeChartSettings,
  type ChartSettings,
  type OpenViewModuleId,
  type OpenViewRow,
} from "../domain/model";
import {
  analyticsFilterOperatorLabel,
  chartAggregationOptions,
  chartRows,
  clone,
  emptyFilters,
  fieldLabel,
  formatSampleSnapshotDate,
  isNumericChartMetric,
  type ChartDatum,
} from "./analytics-data";
import { ExportConfirmation, type ExportRequest } from "./analytics-export";
import { EmptyState } from "./analytics-shared";
import { OPENVIEW_SAMPLE_TIMEZONE } from "../helpers/operations";
import { Choice, Workbench } from "./analytics-shared";
import type {
  OpenViewCommandController,
  OpenViewReadSnapshot,
} from "../adapters/controller";

function ChartPreview({
  settings,
  data,
}: {
  settings: ChartSettings;
  data: ChartDatum[];
}) {
  return (
    <OpenViewChartPreview
      data={data}
      type={settings.type}
      valueLabel={
        settings.metric === "count"
          ? "Records"
          : fieldLabel(settings.moduleId, settings.metric)
      }
      showLabels={settings.showLabels}
      showLegend={settings.showLegend}
      allowDecimals={settings.aggregation === "average"}
      className="border-border/70 bg-muted/15 h-[20rem] w-full rounded-[var(--radius)] border p-3"
    />
  );
}

export function Charts({
  moduleId = "service-requests",
  commands,
  snapshot,
  onChartDirtyChange,
}: {
  moduleId?: OpenViewModuleId;
  commands: OpenViewCommandController;
  snapshot: OpenViewReadSnapshot;
  onChartDirtyChange?: (dirty: boolean) => void;
}) {
  const commandPending = commands.isPending();
  const records = snapshot.records;
  const rawSettings = snapshot.chart;
  const storedSettings = useMemo(
    () => decodeChartSettings(rawSettings),
    [rawSettings],
  );
  const initialSettings =
    storedSettings.moduleId === moduleId
      ? storedSettings
      : defaultChartSettings(moduleId);
  const [settings, setSettings] = useState<ChartSettings>(() => {
    return clone(initialSettings);
  });
  const [baseline, setBaseline] = useState<ChartSettings>(() =>
    clone(initialSettings),
  );
  const modulePropRef = useRef(moduleId);
  const draftRevision = useRef(0);
  useEffect(() => {
    if (modulePropRef.current === moduleId) return;
    modulePropRef.current = moduleId;
    const next = defaultChartSettings(moduleId);
    draftRevision.current += 1;
    setSettings(next);
    setBaseline(next);
  }, [moduleId]);
  const [exportRequest, setExportRequest] = useState<ExportRequest | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const dirty = JSON.stringify(settings) !== JSON.stringify(baseline);
  useEffect(() => {
    onChartDirtyChange?.(dirty);
    return () => onChartDirtyChange?.(false);
  }, [dirty, onChartDirtyChange]);
  const rows = useMemo(
    () => getOpenViewRows(settings.moduleId, records),
    [settings.moduleId, records],
  );
  const { rows: filteredRows, data } = useMemo(
    () => chartRows(settings, rows),
    [settings, rows],
  );
  const moduleDefinition = getModuleDefinition(settings.moduleId);
  const dateFields = moduleDefinition.fields.filter(
    (field) => field.type === "date",
  );
  const operationalDateField = getOpenViewOperationalDeadlineField(
    settings.moduleId,
  );
  const selectedDateField = dateFields.find(
    (field) => field.id === settings.dateField,
  );
  const invalidDateRange = Boolean(
    settings.from && settings.to && settings.from > settings.to,
  );
  const chartTotal = data.reduce((total, item) => total + item.value, 0);
  const topGroup = data[0];

  function update(change: Partial<ChartSettings>) {
    const next = normalizeChartSettings({ ...settings, ...change });
    draftRevision.current += 1;
    setSettings(next);
    setMessage("");
  }

  async function saveSettings() {
    if (commandPending) return;
    const submittedRevision = draftRevision.current;
    setMessage("");
    try {
      const result = await commands.saveChartSettings(settings);
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setBaseline(result.value);
      if (submittedRevision !== draftRevision.current) {
        setMessage(
          "Chart settings saved. Your newer edits remain open as an unsaved draft.",
        );
        return;
      }
      draftRevision.current = 0;
      setSettings(result.value);
      setMessage("Chart settings saved in this tab.");
    } catch (error) {
      setMessage(
        sampleOperationMessage(
          error,
          "The chart settings could not be saved. Try again.",
        ),
      );
    }
  }

  async function resetSettings() {
    if (commandPending) return;
    const submittedRevision = draftRevision.current;
    setMessage("");
    try {
      const result = await commands.resetChartSettings(settings.moduleId);
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setBaseline(result.value);
      if (submittedRevision !== draftRevision.current) {
        setMessage(
          "The chart reset was accepted, but your newer edits remain open.",
        );
        return;
      }
      draftRevision.current = 0;
      setSettings(result.value);
      setMessage("Chart settings reset for this data source.");
    } catch (error) {
      setMessage(
        sampleOperationMessage(
          error,
          "The chart settings could not be reset. Try again.",
        ),
      );
    }
  }

  function chartExportRows(): { rows: OpenViewRow[]; fields: string[] } {
    const fields =
      settings.metric === "count"
        ? [settings.dimension, "count"]
        : [settings.dimension, settings.metric];
    return {
      fields,
      rows: data.map((item) => ({
        id: `chart-${item.key}`,
        moduleId: settings.moduleId,
        values: {
          [settings.dimension]: item.label,
          [settings.metric]: item.value,
        },
      })),
    };
  }

  return (
    <Workbench
      controls={
        <FieldGroup>
          <div>
            <h2 className="font-semibold">Chart builder</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Compose a small, readable summary from one module.
            </p>
          </div>
          <Choice
            id="chart-module"
            label="Source module"
            value={settings.moduleId}
            values={OPENVIEW_MODULES.map((item) => ({
              value: item.id,
              label: item.name,
            }))}
            onChange={(moduleId) => {
              const nextModuleId = moduleId as OpenViewModuleId;
              const nextModule = getModuleDefinition(nextModuleId);
              update({
                moduleId: nextModuleId,
                dimension:
                  nextModule.fields.find((field) => field.type === "select")
                    ?.id ?? nextModule.primaryField,
                metric: "count",
                dateField:
                  getOpenViewOperationalDeadlineField(nextModuleId) ?? "",
                filters: emptyFilters(),
                from: "",
                to: "",
              });
            }}
          />
          <FieldSet>
            <FieldLegend>Chart type</FieldLegend>
            <ToggleGroup
              aria-label="Chart type"
              value={[settings.type]}
              onValueChange={(values) => {
                const type = values[0];
                if (type === "bar" || type === "line" || type === "pie")
                  update({ type });
              }}
            >
              <ToggleGroupItem className="min-h-11" value="bar">
                <BarChart3 data-icon="inline-start" />
                Bar
              </ToggleGroupItem>
              <ToggleGroupItem className="min-h-11" value="line">
                <LineChartIcon data-icon="inline-start" />
                Line
              </ToggleGroupItem>
              <ToggleGroupItem className="min-h-11" value="pie">
                <PieChartIcon data-icon="inline-start" />
                Pie
              </ToggleGroupItem>
            </ToggleGroup>
          </FieldSet>
          <Choice
            id="chart-dimension"
            label="Dimension"
            value={settings.dimension}
            values={moduleDefinition.fields.map((field) => ({
              value: field.id,
              label: field.label,
            }))}
            onChange={(dimension) => update({ dimension })}
          />
          <Choice
            id="chart-metric"
            label="Metric"
            value={settings.metric}
            values={[
              { value: "count", label: "Record count" },
              ...moduleDefinition.fields
                .filter((field) => field.type === "number")
                .map((field) => ({ value: field.id, label: field.label })),
            ]}
            onChange={(metric) => {
              const nextMetric =
                metric === "count" ||
                isNumericChartMetric(settings.moduleId, metric)
                  ? metric
                  : "count";
              update({
                metric: nextMetric,
                aggregation: nextMetric === "count" ? "count" : "sum",
              });
            }}
          />
          <Choice
            id="chart-aggregation"
            label="Aggregation"
            value={settings.aggregation}
            values={chartAggregationOptions(settings.moduleId, settings.metric)}
            onChange={(aggregation) =>
              update({
                aggregation: aggregation as ChartSettings["aggregation"],
              })
            }
            description={
              settings.metric === "count"
                ? "Record count is the only available aggregation for this metric."
                : "Numeric metrics support sum or average."
            }
          />
          {dateFields.length > 0 ? (
            <>
              <Choice
                id="chart-date-field"
                label="Date field"
                value={settings.dateField}
                values={dateFields.map((field) => ({
                  value: field.id,
                  label:
                    field.id === operationalDateField
                      ? `${field.label} · operational deadline`
                      : field.label,
                }))}
                onChange={(dateField) => update({ dateField })}
                description="Choose which date should control the chart window."
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="chart-from">From date</FieldLabel>
                  <Input
                    id="chart-from"
                    className="min-h-11"
                    type="date"
                    value={settings.from}
                    onChange={(event) => update({ from: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="chart-to">To date</FieldLabel>
                  <Input
                    id="chart-to"
                    className="min-h-11"
                    type="date"
                    value={settings.to}
                    onChange={(event) => update({ to: event.target.value })}
                  />
                </Field>
              </div>
            </>
          ) : (
            <Alert>
              This module has no date field in the current records, so date
              filtering is unavailable.
            </Alert>
          )}
          {invalidDateRange ? (
            <Alert variant="destructive">
              End date must be on or after the start date.
            </Alert>
          ) : null}
          <OpenViewFilterEditor
            module={moduleDefinition}
            rows={rows}
            filters={settings.filters}
            onChange={(filters) => update({ filters })}
            title="Chart filters"
            idPrefix="openview-chart-filter"
            operatorMode="all"
            clearValueOnFieldChange
            selectValueFields
            showLogicWhenEmpty={false}
            logicControl="select"
            logicLabel="Match"
            logicOptions={{
              and: "All conditions (AND)",
              or: "Any condition (OR)",
            }}
            valueMaxLength={null}
            operatorLabel={analyticsFilterOperatorLabel}
            addOperator="contains"
          />
          <Field>
            <FieldLabel htmlFor="chart-limit">Top results</FieldLabel>
            <Input
              id="chart-limit"
              className="min-h-11"
              type="number"
              min={1}
              max={20}
              value={settings.limit}
              onChange={(event) =>
                update({
                  limit: Math.max(
                    1,
                    Math.min(20, Number(event.target.value) || 1),
                  ),
                })
              }
            />
            <FieldDescription>
              Limit the chart to the highest-value groups.
            </FieldDescription>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field className="min-h-11 flex-row items-center gap-3">
              <Checkbox
                id="chart-legend"
                className="size-5 after:-inset-3"
                checked={settings.showLegend}
                onCheckedChange={(checked) =>
                  update({ showLegend: Boolean(checked) })
                }
              />
              <FieldLabel htmlFor="chart-legend">Show legend</FieldLabel>
            </Field>
            <Field className="min-h-11 flex-row items-center gap-3">
              <Checkbox
                id="chart-labels"
                className="size-5 after:-inset-3"
                checked={settings.showLabels}
                onCheckedChange={(checked) =>
                  update({ showLabels: Boolean(checked) })
                }
              />
              <FieldLabel htmlFor="chart-labels">Show values</FieldLabel>
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11"
              disabled={!dirty || commandPending}
              onClick={() => void saveSettings()}
            >
              <Save data-icon="inline-start" />
              {commands.isPending("openview.chart.save")
                ? "Saving…"
                : "Save settings"}
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={!dirty || commandPending}
              onClick={() => void resetSettings()}
            >
              <RotateCcw data-icon="inline-start" />
              {commands.isPending("openview.chart.reset")
                ? "Resetting…"
                : "Reset settings"}
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={invalidDateRange || data.length === 0}
              onClick={() => {
                const exportData = chartExportRows();
                setExportRequest({
                  kind: "csv",
                  title: `${moduleDefinition.name} chart`,
                  source: moduleDefinition.name,
                  dateField: selectedDateField?.label,
                  dateFrom: settings.from,
                  dateTo: settings.to,
                  fields: exportData.fields,
                  fieldLabels: {
                    [settings.dimension]: fieldLabel(
                      settings.moduleId,
                      settings.dimension,
                    ),
                    [settings.metric]:
                      settings.metric === "count"
                        ? "Records"
                        : fieldLabel(settings.moduleId, settings.metric),
                  },
                  rows: exportData.rows,
                  filters: settings.filters,
                  grouping: settings.dimension,
                  totals: false,
                });
              }}
            >
              <Download data-icon="inline-start" />
              Download CSV
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={invalidDateRange || data.length === 0}
              onClick={() => {
                const exportData = chartExportRows();
                setExportRequest({
                  kind: "pdf",
                  title: `${moduleDefinition.name} chart`,
                  source: moduleDefinition.name,
                  dateField: selectedDateField?.label,
                  dateFrom: settings.from,
                  dateTo: settings.to,
                  fields: exportData.fields,
                  fieldLabels: {
                    [settings.dimension]: fieldLabel(
                      settings.moduleId,
                      settings.dimension,
                    ),
                    [settings.metric]:
                      settings.metric === "count"
                        ? "Records"
                        : fieldLabel(settings.moduleId, settings.metric),
                  },
                  rows: exportData.rows,
                  filters: settings.filters,
                  grouping: settings.dimension,
                  totals: false,
                  chart: { settings, data },
                });
              }}
            >
              <Printer data-icon="inline-start" />
              Print / save PDF
            </Button>
          </div>
        </FieldGroup>
      }
    >
      <Card className="overflow-hidden">
        <CardHeader className="bg-muted/25">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>
                {topGroup
                  ? `${topGroup.label} leads this view`
                  : `${moduleDefinition.name} chart`}
              </CardTitle>
              <CardDescription className="mt-1 space-y-0.5">
                <span className="block">
                  Source: {moduleDefinition.name} · {data.length} groups from{" "}
                  {filteredRows.length} matching records ·{" "}
                  {settings.aggregation}{" "}
                  {settings.metric === "count"
                    ? "records"
                    : fieldLabel(settings.moduleId, settings.metric)}
                </span>
                <span className="block">
                  Date field: {selectedDateField?.label ?? "None"}
                  {settings.from || settings.to
                    ? ` · window ${settings.from || "any date"} → ${settings.to || "any date"}`
                    : " · all dates"}
                </span>
                <span className="block">
                  Snapshot: {formatSampleSnapshotDate()} ·{" "}
                  {OPENVIEW_SAMPLE_TIMEZONE}
                </span>
              </CardDescription>
            </div>
          </div>
          {data.length ? (
            <div className="border-border mt-4 flex flex-wrap gap-x-8 gap-y-3 border-t pt-3 text-sm">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="bg-chart-1 size-2.5 shrink-0 rounded-full"
                  aria-hidden="true"
                />
                <span className="text-muted-foreground">Largest group</span>
                <span className="truncate font-semibold">
                  {topGroup?.label}
                </span>
                <span className="font-semibold tabular-nums">
                  {topGroup?.value.toLocaleString(undefined, {
                    maximumFractionDigits:
                      settings.aggregation === "average" ? 2 : 0,
                  })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="bg-chart-3 size-2.5 shrink-0 rounded-full"
                  aria-hidden="true"
                />
                <span className="text-muted-foreground">
                  {settings.aggregation === "average"
                    ? "Combined displayed value"
                    : "Displayed total"}
                </span>
                <span className="font-semibold tabular-nums">
                  {chartTotal.toLocaleString(undefined, {
                    maximumFractionDigits:
                      settings.aggregation === "average" ? 2 : 0,
                  })}
                </span>
              </div>
            </div>
          ) : null}
        </CardHeader>
        <CardContent>
          {invalidDateRange ? (
            <EmptyState
              icon={<CalendarClock />}
              title="Correct the date range"
              description="The chart will appear after the end date is on or after the start date."
            />
          ) : data.length === 0 ? (
            <EmptyState
              icon={<BarChart3 />}
              title="No matching groups"
              description="Try clearing a filter or widening the date range."
            />
          ) : (
            <Tabs defaultValue="chart">
              <TabsList>
                <TabsTrigger value="chart" className="min-h-11">
                  Chart
                </TabsTrigger>
                <TabsTrigger value="table" className="min-h-11">
                  Data table
                </TabsTrigger>
              </TabsList>
              <TabsContent value="chart" className="mt-5">
                <ChartPreview settings={settings} data={data} />
              </TabsContent>
              <TabsContent value="table" className="mt-5">
                <ChartTable settings={settings} data={data} />
              </TabsContent>
            </Tabs>
          )}
          {message ? (
            <Alert variant="success" className="mt-5">
              {message}
            </Alert>
          ) : null}
        </CardContent>
      </Card>
      <ExportConfirmation
        request={exportRequest}
        onClose={() => setExportRequest(null)}
        onComplete={(result) => {
          setExportRequest(null);
          setMessage(result);
        }}
      />
    </Workbench>
  );
}

function ChartTable({
  settings,
  data,
}: {
  settings: ChartSettings;
  data: ChartDatum[];
}) {
  const max = Math.max(...data.map((item) => item.value), 1);
  return (
    <Table className="overflow-hidden rounded-[var(--radius)] border">
      <TableCaption className="sr-only">
        Chart values for {fieldLabel(settings.moduleId, settings.dimension)}.
      </TableCaption>
      <TableHeader className="bg-muted/65">
        <TableRow className="hover:bg-muted/65">
          <TableHead className="px-4 text-[0.6875rem] font-semibold tracking-wide uppercase">
            {fieldLabel(settings.moduleId, settings.dimension)}
          </TableHead>
          <TableHead className="px-4 text-right text-[0.6875rem] font-semibold tracking-wide uppercase">
            {settings.aggregation === "count"
              ? "Records"
              : settings.aggregation}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((item, index) => (
          <TableRow key={item.key} className="odd:bg-muted/20">
            <TableCell className="px-4 font-medium">
              <span className="flex items-center gap-2">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor: `var(--chart-${(index % 5) + 1})`,
                  }}
                  aria-hidden="true"
                />
                {item.label}
              </span>
            </TableCell>
            <TableCell className="relative overflow-hidden px-4 text-right tabular-nums">
              <span
                className="absolute inset-y-1 right-0 opacity-15"
                style={{
                  width: `${Math.max(6, (item.value / max) * 100)}%`,
                  backgroundColor: `var(--chart-${(index % 5) + 1})`,
                }}
                aria-hidden="true"
              />
              <span className="relative font-semibold">
                {item.value.toLocaleString(undefined, {
                  maximumFractionDigits:
                    settings.aggregation === "average" ? 2 : 0,
                })}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
