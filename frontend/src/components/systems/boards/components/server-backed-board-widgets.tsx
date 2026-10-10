"use client";

import { createElement, useEffect, useState, type ReactNode } from "react";
import { getBoardWorkspaceToday } from "../adapters/board-workspace-date-api";
import type { OpenViewRecord } from "../../openview/adapters/views-api";
import type { OpenViewAggregateSnapshotResult } from "../../openview/adapters/analytics-api";
import { collapseBoardWidgetPie } from "../domain/live-widget-query";
import { OpenViewChartPreview } from "../../openview/components/chart-preview";
import {
  useLiveBoardWidgets,
  type LiveWidgetItem,
  type LiveWidgetsState,
} from "../hooks/use-live-widgets";

const colors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function unavailableReason(item: LiveWidgetItem): string {
  if (item.plan.kind !== "unavailable") return "Widget data unavailable.";
  switch (item.plan.reason) {
    case "missing-workspace-date":
      return "Workspace date is unavailable, so this daily chart cannot be shown yet.";
    case "invalid-workspace-date":
      return "The workspace date could not be read. Refresh or ask an administrator to check it.";
    case "missing-dimension":
      return "Choose a field for this widget before its data can be shown.";
    case "unsupported-dimension":
      return "This field type is not supported by this widget.";
    case "invalid-source":
      return "Widget data unavailable.";
  }
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (typeof value === "string" || typeof value === "boolean")
    return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "Value cannot be displayed";
}

function displayRecordFieldValue(
  record: OpenViewRecord,
  field: { fieldId: string; expectedType: string },
): unknown {
  const raw = record.data[field.fieldId];
  if (raw === null || raw === undefined || raw === "") return raw;
  const label = record.displayValues[field.fieldId];
  if (typeof label === "string" && label.trim()) return label;
  if (field.expectedType === "user") return "Unavailable user";
  if (field.expectedType === "select") return "Unavailable option";
  return raw;
}

function recordsContent(item: LiveWidgetItem): ReactNode {
  if (item.data?.kind !== "records") return null;
  const { result, fieldNames } = item.data;
  const fields =
    item.plan.kind === "records" ? item.plan.request.definition.columns : [];
  if (item.widget.widgetType === "summary")
    return createElement(
      "p",
      { className: "flex flex-col gap-1" },
      createElement(
        "span",
        { className: "text-foreground text-4xl font-semibold tabular-nums" },
        result.pagination.total,
      ),
      createElement(
        "span",
        { className: "text-muted-foreground text-sm" },
        "Matching records",
      ),
    );
  if (fields.some((field) => !fieldNames[field.fieldId]?.trim()))
    return createElement(
      "p",
      { className: "text-muted-foreground text-sm", role: "alert" },
      "Field names unavailable. Record values are hidden. Refresh or ask an administrator to check this widget.",
    );
  if (result.items.length === 0)
    return createElement(
      "p",
      { className: "text-muted-foreground text-sm" },
      "No matching records. Adjust the widget filters to see results.",
    );
  return createElement(
    "div",
    { className: "space-y-3" },
    createElement(
      "p",
      { className: "text-muted-foreground text-sm" },
      `Showing ${result.items.length} of ${result.pagination.total} matching records`,
    ),
    createElement(
      "ol",
      { className: "divide-border divide-y" },
      ...result.items.map((record, index) =>
        createElement(
          "li",
          { key: record.id, className: "min-w-0 py-3 first:pt-0" },
          createElement(
            "p",
            { className: "font-medium" },
            `Record ${index + 1}`,
          ),
          fields.length === 0
            ? createElement(
                "p",
                { className: "text-muted-foreground text-sm" },
                "No fields selected for this list.",
              )
            : createElement(
                "dl",
                { className: "mt-1 space-y-1 text-sm" },
                ...fields.map((field) =>
                  createElement(
                    "div",
                    {
                      key: field.fieldId,
                      className: "flex min-w-0 flex-wrap gap-x-2",
                    },
                    createElement(
                      "dt",
                      { className: "text-muted-foreground" },
                      fieldNames[field.fieldId],
                    ),
                    createElement(
                      "dd",
                      { className: "min-w-0 break-words" },
                      displayValue(displayRecordFieldValue(record, field)),
                    ),
                  ),
                ),
              ),
        ),
      ),
    ),
  );
}

function numericValue(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function groupContent(item: LiveWidgetItem): ReactNode {
  if (item.data?.kind !== "aggregate" && item.data?.kind !== "snapshot")
    return null;
  const { items, pagination } = item.data.result;
  if (items.length === 0)
    return createElement(
      "p",
      { className: "text-muted-foreground text-sm" },
      "No matching groups. Adjust the widget filters to see results.",
    );
  const values = items.map((entry) => numericValue(entry.value));
  const hasNegative = values.some((value) => value !== null && value < 0);
  const hasUnchartableValue = items.some(
    (entry, index) => entry.value !== null && values[index] === null,
  );
  const finite = values.filter((value): value is number => value !== null);
  const safeRange = Number.isFinite(
    Math.max(0, ...finite) - Math.min(0, ...finite),
  );
  return createElement(
    "div",
    { className: "space-y-3" },
    createElement(
      "p",
      { className: "text-muted-foreground text-sm" },
      pagination.hasMore
        ? `Showing ${items.length} of ${pagination.total} groups. `
        : `${pagination.total} ${pagination.total === 1 ? "group" : "groups"}. `,
      hasNegative
        ? "Negative values cannot be shown as bars. Exact values are listed below."
        : "Exact values are listed below; bar lengths are approximate.",
    ),
    hasUnchartableValue || !safeRange
      ? createElement(
          "p",
          { className: "text-muted-foreground text-sm" },
          "Some values are too large to chart. Exact values remain below.",
        )
      : null,
    !hasNegative && !hasUnchartableValue && safeRange && finite.length > 0
      ? createElement(OpenViewChartPreview, {
          type: "bar",
          valueLabel: "Value",
          showLabels: false,
          showLegend: false,
          className: "h-52 w-full min-w-0",
          allowDecimals: true,
          data: items.map((entry, index) => ({
            key: `board-point-${index}`,
            label: entry.label,
            value: values[index],
          })),
        })
      : null,
    createElement(
      "ol",
      { className: "space-y-3" },
      ...items.map((entry) =>
        createElement(
          "li",
          { key: entry.key ?? "unspecified", className: "min-w-0" },
          createElement(
            "div",
            {
              className: "flex min-w-0 flex-wrap justify-between gap-1 text-sm",
            },
            createElement(
              "span",
              { className: "min-w-0 break-words" },
              entry.label,
            ),
            createElement(
              "span",
              { className: "font-medium tabular-nums" },
              entry.value === null ? "—" : String(entry.value),
            ),
          ),
        ),
      ),
    ),
  );
}

function nativeSnapshotValues(
  result: OpenViewAggregateSnapshotResult,
): ReactNode {
  return createElement(
    "ol",
    { className: "space-y-1 text-sm" },
    ...result.items.map((entry, index) =>
      createElement(
        "li",
        {
          key: `${entry.key ?? "null"}:${index}`,
          className: "flex min-w-0 flex-wrap justify-between gap-2",
        },
        createElement(
          "span",
          { className: "min-w-0 break-words" },
          entry.label,
        ),
        createElement(
          "span",
          { className: "font-medium tabular-nums" },
          entry.value === null ? "—" : String(entry.value),
        ),
        createElement(
          "span",
          { className: "text-muted-foreground text-xs" },
          `${entry.recordCount} records`,
        ),
      ),
    ),
  );
}

function pieContent(item: LiveWidgetItem): ReactNode {
  if (item.data?.kind !== "snapshot") return null;
  const legacy = item.widget.config !== null && "fields" in item.widget.config;
  const projection = collapseBoardWidgetPie(item.data.result, legacy);
  if (projection.kind === "unavailable")
    return createElement(
      "div",
      { className: "space-y-2" },
      createElement(
        "p",
        { className: "text-muted-foreground text-sm" },
        "This chart cannot be shown from an incomplete or unrepresentable result.",
      ),
      legacy ? null : nativeSnapshotValues(item.data.result),
    );
  if (projection.points.length === 0)
    return createElement(
      "div",
      { className: "space-y-2" },
      createElement(
        "p",
        { className: "text-muted-foreground text-sm" },
        "No matching groups. Adjust the widget filters to see results.",
      ),
      legacy ? null : nativeSnapshotValues(item.data.result),
    );
  const total = projection.points.reduce((sum, point) => sum + point.value, 0);
  if (!Number.isFinite(total))
    return createElement(
      "div",
      { className: "space-y-2 text-sm" },
      createElement(
        "p",
        null,
        "Values too large to chart. Exact values remain below.",
      ),
      legacy
        ? createElement(
            "ol",
            { className: "space-y-1" },
            ...item.data.result.items.map((entry) =>
              createElement(
                "li",
                {
                  key: entry.key ?? "unspecified",
                  className: "flex min-w-0 justify-between gap-2",
                },
                createElement(
                  "span",
                  { className: "min-w-0 break-words" },
                  entry.label,
                ),
                createElement(
                  "span",
                  { className: "font-medium tabular-nums" },
                  entry.value === null ? "—" : String(entry.value),
                ),
              ),
            ),
          )
        : nativeSnapshotValues(item.data.result),
    );
  return createElement(
    "div",
    { className: "flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center" },
    total > 0
      ? createElement(OpenViewChartPreview, {
          type: "pie",
          valueLabel: "Value",
          showLabels: false,
          showLegend: false,
          className: "h-52 w-full min-w-0 sm:w-1/2",
          pieInnerRadius: 44,
          pieOuterRadius: 76,
          data: projection.points.map((point, index) => ({
            key: `board-point-${index}`,
            label: point.label,
            value: point.value,
          })),
        })
      : null,
    createElement(
      "div",
      { className: "min-w-0 flex-1 space-y-2" },
      createElement(
        "p",
        { className: "text-muted-foreground text-sm" },
        projection.rolledUpGroups
          ? `${projection.totalGroups} groups; ${projection.rolledUpGroups} included in Other. Chart values are approximate.`
          : `${projection.totalGroups} groups. Chart values are approximate.`,
      ),
      legacy
        ? createElement(
            "ol",
            { className: "space-y-1 text-sm" },
            ...projection.points.map((point, index) =>
              createElement(
                "li",
                {
                  key: point.key,
                  className: "flex min-w-0 flex-wrap justify-between gap-2",
                },
                createElement(
                  "span",
                  { className: "flex min-w-0 items-center gap-2 break-words" },
                  createElement("span", {
                    "aria-hidden": "true",
                    className: "size-2.5 shrink-0 rounded-full",
                    style: { backgroundColor: colors[index % colors.length] },
                  }),
                  point.label,
                ),
                createElement(
                  "span",
                  { className: "font-medium tabular-nums" },
                  point.key === "rollup:other"
                    ? String(point.value)
                    : String(
                        item.data?.kind === "snapshot"
                          ? (item.data.result.items.find(
                              (entry) =>
                                (entry.key === null
                                  ? "group:null"
                                  : `group:value:${entry.key}`) === point.key,
                            )?.value ?? point.value)
                          : point.value,
                      ),
                ),
              ),
            ),
          )
        : nativeSnapshotValues(item.data.result),
    ),
  );
}

function lineContent(item: LiveWidgetItem): ReactNode {
  if (item.data?.kind !== "snapshot") return null;
  const bucket =
    item.plan.kind === "snapshot" && item.plan.request.mode === "date_series"
      ? (item.plan.request.bucket ?? "day")
      : "day";
  const { items, pagination } = item.data.result;
  if (pagination.hasMore || pagination.total !== items.length)
    return createElement(
      "p",
      { className: "text-muted-foreground text-sm" },
      `The ${bucket === "day" ? "daily" : bucket} chart is incomplete. Refresh to try again.`,
    );
  if (items.length === 0)
    return createElement(
      "p",
      { className: "text-muted-foreground text-sm" },
      "No dates matched this widget.",
    );
  const values = items.map((entry) => numericValue(entry.value));
  const finite = values.filter((value): value is number => value !== null);
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const range = max - min || 1;
  const hasUnchartableValue = items.some(
    (entry, index) => entry.value !== null && values[index] === null,
  );
  const canDraw =
    finite.length > 0 && !hasUnchartableValue && Number.isFinite(range);
  return createElement(
    "div",
    { className: "min-w-0 space-y-3" },
    createElement(
      "p",
      { className: "text-muted-foreground text-sm" },
      `${items.length} ${bucket}${items.length === 1 ? "" : "s"} shown. Exact values are listed below; the line is approximate.`,
    ),
    canDraw
      ? createElement(OpenViewChartPreview, {
          type: "line",
          valueLabel: "Value",
          showLabels: false,
          showPoints: true,
          showLegend: false,
          className: "h-52 w-full min-w-0",
          allowDecimals: true,
          data: items.map((entry, index) => ({
            key: `board-point-${index}`,
            label: entry.label,
            value: values[index],
          })),
        })
      : createElement(
          "p",
          { className: "text-muted-foreground text-sm" },
          hasUnchartableValue || finite.length > 0
            ? "Values too large to chart. Exact values remain below."
            : "No chartable values are available. Exact values remain below.",
        ),
    createElement(
      "ol",
      { className: "grid gap-2 text-sm sm:grid-cols-2" },
      ...items.map((entry) =>
        createElement(
          "li",
          {
            key: entry.key ?? entry.label,
            className: "flex min-w-0 justify-between gap-2",
          },
          createElement(
            "span",
            { className: "min-w-0 break-words" },
            entry.label,
          ),
          createElement(
            "span",
            { className: "font-medium tabular-nums" },
            entry.value === null ? "—" : String(entry.value),
          ),
        ),
      ),
    ),
  );
}

function widgetContent(item: LiveWidgetItem): ReactNode {
  if (item.plan.kind === "unavailable")
    return createElement(
      "p",
      { className: "text-muted-foreground text-sm" },
      unavailableReason(item),
    );
  if (item.data === null)
    return createElement(
      "p",
      {
        className: "text-muted-foreground text-sm",
        role: item.status === "loading" ? "status" : "alert",
      },
      item.status === "loading"
        ? "Loading widget data…"
        : item.error || "Widget data unavailable. Refresh to try again.",
    );
  if (item.plan.kind !== item.data.kind)
    return createElement(
      "p",
      { className: "text-muted-foreground text-sm", role: "alert" },
      "Widget data unavailable. Refresh to try again.",
    );
  if (item.plan.kind === "records") return recordsContent(item);
  if (item.plan.kind === "aggregate") return groupContent(item);
  if (item.plan.kind === "snapshot" && item.plan.widgetType !== "chart")
    return item.data?.kind === "snapshot"
      ? nativeSnapshotValues(item.data.result)
      : null;
  if (item.plan.visualization === "bar") return groupContent(item);
  return item.plan.visualization === "pie"
    ? pieContent(item)
    : lineContent(item);
}

function widgetCard(
  item: LiveWidgetItem,
  onRetry: () => void,
  gridColumns: 2 | 3,
): ReactNode {
  const fullWidth =
    item.widget.size === "L"
      ? gridColumns === 3
        ? "lg:col-span-3"
        : "lg:col-span-2"
      : "";
  return createElement(
    "li",
    {
      key: item.widget.id,
      className: `border-border bg-card text-card-foreground min-w-0 rounded-xl border p-5 ${fullWidth}`,
    },
    createElement(
      "div",
      {
        className:
          "mb-4 flex min-w-0 flex-wrap items-start justify-between gap-2",
      },
      createElement(
        "h3",
        { className: "min-w-0 text-base font-semibold break-words" },
        item.widget.name,
      ),
      item.widget.pinned
        ? createElement(
            "span",
            {
              className:
                "bg-secondary text-secondary-foreground rounded-md px-2 py-0.5 text-xs",
            },
            "Pinned",
          )
        : null,
    ),
    item.status === "loading" && item.data !== null
      ? createElement(
          "p",
          { className: "text-muted-foreground mb-3 text-sm", role: "status" },
          "Refreshing… showing the last loaded data.",
        )
      : null,
    item.error && item.data !== null
      ? createElement(
          "p",
          {
            className:
              "text-muted-foreground mb-3 flex flex-wrap gap-2 text-sm",
            role: "alert",
          },
          "Showing the last loaded data. ",
          item.error,
          createElement(
            "button",
            {
              type: "button",
              className:
                "text-primary min-h-11 rounded-md px-2 font-medium underline underline-offset-2",
              onClick: onRetry,
            },
            "Retry",
          ),
        )
      : null,
    item.error && item.data === null
      ? createElement(
          "button",
          {
            type: "button",
            className:
              "text-primary min-h-11 rounded-md px-2 font-medium underline underline-offset-2",
            onClick: onRetry,
          },
          "Retry",
        )
      : null,
    widgetContent(item),
  );
}

export function ServerBoardWidgetsDisplay({
  state,
  onRetry,
}: {
  state: LiveWidgetsState;
  onRetry: () => void;
}) {
  const failed = state.status === "error";
  const items = failed ? [] : state.items;
  const summaries = items.filter(
    (item) => item.widget.widgetType === "summary",
  );
  const gridColumns: 2 | 3 = summaries.length === items.length ? 3 : 2;
  return createElement(
    "section",
    { "aria-label": "Record summaries", className: "min-w-0 space-y-4" },
    createElement(
      "div",
      { className: "space-y-1" },
      createElement(
        "h2",
        { className: "text-lg font-semibold" },
        "Record summaries",
      ),
      createElement(
        "p",
        { className: "text-muted-foreground text-sm" },
        "Counts come from records that match each widget’s filters.",
      ),
    ),
    state.error
      ? createElement(
          "div",
          {
            role: "alert",
            className:
              "border-border bg-muted/40 rounded-lg border p-4 text-sm",
          },
          items.length > 0 ? "Showing the last loaded widgets. " : "",
          state.error,
          createElement(
            "button",
            {
              type: "button",
              className:
                "text-primary focus-visible:outline-ring ml-2 min-h-11 rounded-md px-2 font-medium underline underline-offset-2 focus-visible:outline-2",
              onClick: onRetry,
            },
            "Retry",
          ),
        )
      : null,
    !failed && state.status === "loading" && items.length === 0
      ? createElement(
          "p",
          { role: "status", className: "text-muted-foreground py-8 text-sm" },
          "Loading Board widgets…",
        )
      : null,
    !failed && state.status === "ready" && items.length === 0
      ? createElement(
          "div",
          { className: "border-border rounded-xl border border-dashed p-6" },
          createElement("h3", { className: "font-medium" }, "No widgets yet"),
          createElement(
            "p",
            { className: "text-muted-foreground mt-2 text-sm" },
            "A Board manager can add widgets to this overview.",
          ),
        )
      : null,
    items.length > 0
      ? createElement(
          "ol",
          {
            className:
              gridColumns === 3
                ? "grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
                : "grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2",
          },
          ...items.map((item) => widgetCard(item, onRetry, gridColumns)),
        )
      : null,
  );
}

export function ServerBackedBoardWidgets({
  boardId,
  refreshKey,
}: {
  boardId: string;
  refreshKey: number;
}) {
  const [workspaceToday, setWorkspaceToday] = useState<string>();
  useEffect(() => {
    let active = true;
    async function refreshWorkspaceToday() {
      try {
        const today = await getBoardWorkspaceToday();
        if (active) setWorkspaceToday(today);
      } catch {
        if (active) setWorkspaceToday(undefined);
      }
    }
    void refreshWorkspaceToday();
    const timer = window.setInterval(
      () => void refreshWorkspaceToday(),
      60_000,
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshKey]);
  const { state, retry } = useLiveBoardWidgets(
    boardId,
    workspaceToday,
    refreshKey,
  );
  return createElement(ServerBoardWidgetsDisplay, { state, onRetry: retry });
}
