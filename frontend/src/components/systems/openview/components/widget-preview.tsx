"use client";

import Link from "next/link";
import { ArrowRight, ChevronDown, List } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import {
  getModuleDefinition,
  type OpenViewRow,
  type OpenViewWidget,
} from "../domain/model";
import {
  OPENVIEW_SAMPLE_SNAPSHOT_DATE,
  getOpenViewOperationalFacts,
  summarizeOpenViewOperationalRows,
} from "../helpers/operations";
import { OpenViewChartPreview } from "./chart-preview";
import {
  chooseDimension,
  chooseWorkloadDimension,
  formatOperationalDate,
  formatValue,
  operationalTimingLabel,
  operationalTimingVariant,
  summarizeRows,
} from "./widget-model";

const widgetVisualTones = [
  {
    surface: "bg-chart-1/12",
    solid: "bg-chart-1",
    border: "border-chart-1/35",
  },
  {
    surface: "bg-chart-2/12",
    solid: "bg-chart-2",
    border: "border-chart-2/35",
  },
  {
    surface: "bg-chart-3/12",
    solid: "bg-chart-3",
    border: "border-chart-3/35",
  },
  {
    surface: "bg-chart-4/12",
    solid: "bg-chart-4",
    border: "border-chart-4/35",
  },
  {
    surface: "bg-chart-5/12",
    solid: "bg-chart-5",
    border: "border-chart-5/35",
  },
] as const;

export function widgetTone(index: number) {
  return (
    widgetVisualTones[index % widgetVisualTones.length] ?? widgetVisualTones[0]
  );
}

export function WidgetPreview({
  widget,
  rows,
  totalRows,
  moduleName,
  board,
}: {
  widget: OpenViewWidget;
  rows: OpenViewRow[];
  totalRows: number;
  moduleName: string;
  board: boolean;
}) {
  if (!rows.length) {
    return (
      <Empty className="min-h-44 border-0 p-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <List aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>
            {totalRows > 0 ? "No matching records" : "No records yet"}
          </EmptyTitle>
          <EmptyDescription>
            {totalRows > 0
              ? "Clear a filter to see matching rows in this widget."
              : `Add ${moduleName.toLocaleLowerCase()} records to see this widget.`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (widget.type === "workload") {
    return <WorkloadPreview widget={widget} rows={rows} />;
  }
  if (widget.type === "records") {
    return <RecordsPreview board={board} widget={widget} rows={rows} />;
  }
  if (widget.type === "chart") {
    return <ChartPreview widget={widget} rows={rows} />;
  }
  return <SummaryPreview widget={widget} rows={rows} />;
}

function SummaryPreview({
  widget,
  rows,
}: {
  widget: OpenViewWidget;
  rows: OpenViewRow[];
}) {
  const moduleDefinition = getModuleDefinition(widget.moduleId);
  const summary = summarizeOpenViewOperationalRows(rows, widget.moduleId);
  const dimension =
    moduleDefinition.fields.find((field) => field.id === "status") ??
    chooseDimension(widget);
  const groups = summarizeRows(rows, dimension, widget.metric);
  const noun = widget.moduleId === "service-requests" ? "request" : "record";
  const causes = [
    { label: "Blocked", state: "blocked" },
    { label: "Overdue", state: "overdue" },
    { label: "Planned after deadline", state: "late-plan" },
    { label: "Due soon", state: "due-soon" },
    { label: "Missing dates", state: "unscheduled" },
  ]
    .map((cause) => ({
      ...cause,
      count: summary.attention.filter(
        (item) => item.timingState === cause.state,
      ).length,
    }))
    .filter((cause) => cause.count > 0);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-lg leading-snug font-semibold">
          {summary.needsAttention
            ? `${summary.needsAttention} of ${summary.total} ${noun}${summary.total === 1 ? " needs" : "s need"} attention.`
            : `All ${summary.total} ${noun}${summary.total === 1 ? " is" : "s are"} on track or complete.`}
        </p>
        <p className="text-muted-foreground text-sm">
          {summary.highPriority} high priority · Dates assessed as of{" "}
          {formatOperationalDate(summary.snapshotDate)}
        </p>
      </div>
      {!!causes.length && (
        <dl
          className="grid grid-cols-2 gap-x-5 gap-y-3"
          aria-label="Reasons for attention"
        >
          {causes.map((cause) => (
            <div
              key={cause.label}
              className="flex items-baseline justify-between gap-3"
            >
              <dt className="text-sm">{cause.label}</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {cause.count}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {!!summary.attention.length && (
        <Collapsible className="flex flex-col gap-3">
          <CollapsibleTrigger
            render={
              <Button
                variant="outline"
                className="min-h-11 w-full justify-between"
              />
            }
          >
            See {summary.attention.length} {noun}
            {summary.attention.length === 1 ? "" : "s"} needing attention
            <ChevronDown data-icon="inline-end" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul
              className="divide-border max-h-80 divide-y overflow-y-auto"
              aria-label="Items needing attention"
            >
              {summary.attention.map((item) => (
                <li
                  key={item.rowId}
                  className="flex flex-col gap-2 py-3 first:pt-0"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 font-medium break-words">
                      {item.label}
                    </p>
                    <Badge variant={operationalTimingVariant(item.timingState)}>
                      {operationalTimingLabel(item.timingState)}
                    </Badge>
                  </div>
                  {item.attentionReason && (
                    <p className="text-sm">{item.attentionReason}</p>
                  )}
                  <p className="text-muted-foreground text-sm">
                    {item.owner || "Unassigned"} ·{" "}
                    {item.deadline
                      ? `Due ${formatOperationalDate(item.deadline)}`
                      : "No deadline"}
                  </p>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
      <div className="flex flex-col gap-3 border-t pt-4">
        <p className="text-sm font-medium">
          By {dimension.label.toLocaleLowerCase()}
          {widget.metric !== "count"
            ? ` · total ${moduleDefinition.fields.find((field) => field.id === widget.metric)?.label ?? widget.metric}`
            : ""}
        </p>
        <ul
          className="grid gap-x-5 gap-y-2 sm:grid-cols-2"
          aria-label="Status distribution"
        >
          {groups.slice(0, 6).map((group, index) => (
            <li
              key={group.label}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    widgetTone(index).solid,
                  )}
                  aria-hidden="true"
                />
                <span className="break-words">{group.label}</span>
              </span>
              <span className="font-semibold tabular-nums">
                {group.value.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
        {groups.length > 6 && (
          <p className="text-muted-foreground text-sm">
            Showing 6 of {groups.length} groups.
          </p>
        )}
      </div>
    </div>
  );
}

function WorkloadPreview({
  widget,
  rows,
}: {
  widget: OpenViewWidget;
  rows: OpenViewRow[];
}) {
  const moduleDefinition = getModuleDefinition(widget.moduleId);
  const dimension = chooseWorkloadDimension(widget, rows);
  const groups = summarizeRows(rows, dimension, widget.metric);
  const counts = summarizeRows(rows, dimension, "count");
  const leaders = counts.filter((group) => group.value === counts[0]?.value);
  const highest = counts[0]?.value ?? 0;
  const total = groups.reduce((sum, group) => sum + group.value, 0);
  const max = Math.max(...groups.map((group) => group.value), 1);
  const noun = widget.moduleId === "service-requests" ? "request" : "record";
  const metricLabel =
    moduleDefinition.fields.find((field) => field.id === widget.metric)
      ?.label ?? widget.metric;
  const leaderNames =
    leaders.length <= 3
      ? new Intl.ListFormat("en", {
          style: "long",
          type: "conjunction",
        }).format(leaders.map((group) => group.label))
      : `${leaders.length} groups`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="text-lg leading-snug font-semibold">
          {rows.length} {noun}
          {rows.length === 1 ? "" : "s"} by{" "}
          {dimension.label.toLocaleLowerCase()}
        </p>
        {widget.metric === "count" && (
          <p className="text-muted-foreground text-sm">
            {leaders.length > 1
              ? `${leaderNames} ${leaders.length > 3 ? "tie for the most, with" : "each have"} ${highest} ${noun}${highest === 1 ? "" : "s"}${leaders.length > 3 ? " each" : ""}.`
              : `${leaderNames} has the most: ${highest} ${noun}${highest === 1 ? "" : "s"}.`}
          </p>
        )}
        {widget.metric !== "count" && (
          <p className="text-muted-foreground text-sm">
            Bars show total {metricLabel.toLocaleLowerCase()}, relative to the
            largest total.
          </p>
        )}
      </div>
      <ul
        className="flex flex-col gap-4"
        aria-label={`${widget.metric === "count" ? "Record count" : metricLabel} by ${dimension.label}`}
      >
        {groups.slice(0, 8).map((group) => (
          <li key={group.label} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 break-words">{group.label}</span>
              <span className="shrink-0 font-semibold tabular-nums">
                {group.value.toLocaleString()}
                {widget.metric === "count" && (
                  <span className="text-muted-foreground ml-2 font-normal">
                    of {rows.length}
                  </span>
                )}
              </span>
            </div>
            <div
              className="bg-muted h-2 overflow-hidden rounded-full"
              aria-hidden="true"
            >
              <div
                className="bg-chart-1 h-full rounded-full"
                style={{
                  width: `${(group.value / (widget.metric === "count" ? Math.max(total, 1) : max)) * 100}%`,
                }}
              />
            </div>
          </li>
        ))}
      </ul>
      {groups.length > 8 && (
        <p className="text-muted-foreground text-sm">
          Showing the largest 8 of {groups.length} groups. Totals include every
          group.
        </p>
      )}
    </div>
  );
}

function RecordsPreview({
  board,
  widget,
  rows,
}: {
  board: boolean;
  widget: OpenViewWidget;
  rows: OpenViewRow[];
}) {
  const moduleDefinition = getModuleDefinition(widget.moduleId);
  const primaryField = moduleDefinition.primaryField;
  const secondaryField =
    widget.fields.find((field) => field !== primaryField) ??
    moduleDefinition.fields[1]?.id;
  const statusField = moduleDefinition.fields.find(
    (field) => field.id === "status",
  );
  return (
    <ul
      className="divide-border divide-y"
      aria-label={`${moduleDefinition.name} records`}
    >
      {rows.slice(0, 5).map((row, index) => {
        const tone = widgetTone(index);
        const facts = getOpenViewOperationalFacts(row);
        const status = statusField
          ? formatValue(row.values[statusField.id])
          : "";
        const timingLabel = operationalTimingLabel(facts.timingState);
        const timingVariant = operationalTimingVariant(facts.timingState);
        return (
          <li key={row.id}>
            <Link
              href={`/openview?module=${encodeURIComponent(widget.moduleId)}&record=${encodeURIComponent(row.id)}`}
              className="focus-visible:ring-ring hover:bg-muted/55 flex min-h-16 items-center justify-between gap-3 rounded-[var(--radius)] px-2 py-3 outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
            >
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-[var(--radius)] text-xs font-semibold tabular-nums",
                  tone.surface,
                )}
                aria-hidden="true"
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {formatValue(row.values[primaryField]) || row.id}
                </span>
                {secondaryField ? (
                  <span className="text-muted-foreground mt-1 block truncate text-xs">
                    {formatValue(row.values[secondaryField])}
                  </span>
                ) : null}
                {status ? (
                  <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                    <span
                      className={cn("size-1.5 rounded-full", tone.solid)}
                      aria-hidden="true"
                    />
                    <span>{status}</span>
                    {facts.priority ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{facts.priority} priority</span>
                      </>
                    ) : null}
                  </span>
                ) : null}
                <span className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span>{facts.owner || "Unassigned"}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {facts.deadline
                      ? `Due ${formatOperationalDate(facts.deadline)}`
                      : "No deadline"}
                  </span>
                  <Badge variant={timingVariant}>{timingLabel}</Badge>
                </span>
                {facts.progress !== null ? (
                  <span className="mt-2 flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground shrink-0">
                      Progress
                    </span>
                    <RecordProgress board={board} value={facts.progress} />
                    <span className="font-medium tabular-nums">
                      {facts.progress}%
                    </span>
                  </span>
                ) : null}
              </span>
              <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
                Open
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function RecordProgress({ board, value }: { board: boolean; value: number }) {
  if (board) {
    return (
      <Progress
        className="h-1.5 min-w-16 flex-1"
        value={value}
        aria-label={`${value}% complete`}
      />
    );
  }
  return (
    <span
      className="bg-muted h-1.5 min-w-16 flex-1 overflow-hidden rounded-full"
      role="progressbar"
      aria-label={`${value}% complete`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
    >
      <span
        className="bg-chart-3 block h-full rounded-full"
        style={{ width: `${value}%` }}
      />
    </span>
  );
}

function ChartPreview({
  widget,
  rows,
}: {
  widget: OpenViewWidget;
  rows: OpenViewRow[];
}) {
  const dimension = chooseDimension(widget);
  const data = summarizeRows(rows, dimension, widget.metric)
    .slice(0, 8)
    .map((group, index) => ({
      ...group,
      key: `group-${index}`,
    }));
  const topGroup = data[0];
  const metricLabel =
    widget.metric === "count"
      ? "record count"
      : (getModuleDefinition(widget.moduleId).fields.find(
          (field) => field.id === widget.metric,
        )?.label ?? "metric");
  return (
    <figure
      className="space-y-4"
      aria-label={`${widget.visualization} chart of ${dimension.label}`}
    >
      <figcaption className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="font-semibold">
            {topGroup
              ? `${topGroup.label} leads this view`
              : `No ${dimension.label.toLocaleLowerCase()} groups`}
          </span>
          <Badge variant="outline" className="bg-muted/40">
            {widget.metric === "count" ? "Count" : "Metric"}
          </Badge>
        </div>
        <p className="text-muted-foreground text-xs">
          Source: {getModuleDefinition(widget.moduleId).name} · grouped by{" "}
          {dimension.label.toLocaleLowerCase()} · {metricLabel} · snapshot{" "}
          {OPENVIEW_SAMPLE_SNAPSHOT_DATE}
        </p>
      </figcaption>
      <OpenViewChartPreview
        data={data}
        type={widget.visualization}
        valueLabel={
          widget.metric === "count"
            ? "Records"
            : (getModuleDefinition(widget.moduleId).fields.find(
                (field) => field.id === widget.metric,
              )?.label ?? "Metric")
        }
        className="border-border/70 bg-muted/15 h-[18rem] w-full rounded-[var(--radius)] border p-3"
        barRadius={6}
        maxBarSize={52}
        pieInnerRadius={60}
        pieOuterRadius={92}
      />
    </figure>
  );
}
