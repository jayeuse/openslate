"use client";

import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogFrameFooter } from "@/components/ui/dialog-frame";
import { DisabledReason } from "@/components/ui/disabled-reason";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api-errors";
import { cn } from "@/lib/utils";
import {
  archiveOpenViewChart,
  chartArchiveUsage,
  getOpenViewChartUsage,
  restoreOpenViewChart,
  type SavedChart,
} from "../adapters/charts-api";
import { queryDashboardWidgetData } from "../adapters/dashboard-queries";
import type {
  OpenViewDashboard,
  OpenViewWidgetSource,
} from "../adapters/dashboards-api";
import { chartListOptions, openViewKeys } from "../adapters/openview-queries";
import type { OpenViewDataSource } from "../adapters/views-api";
import type { DashboardWidgetData } from "../domain/dashboard-draft";
import type { Size, WidgetKind } from "../domain/dashboard-grid";
import { kindLabel } from "../domain/dashboard-widget-text";
import type { BuilderResult } from "./dashboard-chart-builder";
import { PreviewCard } from "./dashboard-preview-card";

function chartKind(chart: SavedChart): WidgetKind {
  if (chart.chartType === "summary") return "number";
  if (chart.chartType === "workload") return "table";
  return chart.chartType;
}

function chartSource(chart: SavedChart): OpenViewWidgetSource {
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

function sizeText(size: Size) {
  return `${size.columns} × ${size.rows}`;
}

/**
 * "Use a saved chart instead" (the capability map): the saved charts this
 * dashboard may show, each with its result, the dashboards that use it, and
 * Archive or Restore. Adding one stores a reference, so a later change to the
 * saved chart shows everywhere it is used.
 */
export function DashboardSavedCharts(props: {
  departmentId: string;
  moduleIds: ReadonlySet<string>;
  sources: readonly OpenViewDataSource[];
  departmentNames: ReadonlyMap<string, string>;
  dashboard: OpenViewDashboard | null;
  sizes: (kind: WidgetKind) => Size[];
  onBack: () => void;
  onCancel: () => void;
  onAdd: (result: BuilderResult) => void;
  applyLabel: string;
}) {
  const id = useId();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const list = useQuery(
    chartListOptions(search, undefined, archived ? "only" : "exclude"),
  );
  const charts = (list.data?.items ?? []).filter((chart) =>
    props.moduleIds.has(chart.moduleId),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = charts.find((chart) => chart.id === selectedId) ?? null;
  const [preview, setPreview] = useState<{
    id: string;
    data: DashboardWidgetData | null;
    error: string;
  } | null>(null);
  const [usage, setUsage] = useState<{ id: string; names: string[] } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const kind = selected ? chartKind(selected) : null;
  const sizes = kind ? props.sizes(kind) : [];
  const [chosen, setChosen] = useState<Size | null>(null);
  const size =
    chosen &&
    sizes.some(
      (option) =>
        option.columns === chosen.columns && option.rows === chosen.rows,
    )
      ? chosen
      : (sizes[0] ?? null);

  // Opening a saved chart shows its result and where it is used.
  useEffect(() => {
    if (!selected || selected.isDeleted) return;
    const controller = new AbortController();
    void queryDashboardWidgetData(
      chartSource(selected),
      0,
      5,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted)
          setPreview({ id: selected.id, data, error: "" });
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setPreview({
            id: selected.id,
            data: null,
            error: apiErrorMessage(failure, "This chart could not be read."),
          });
      });
    void getOpenViewChartUsage(selected.id, 0, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted)
          setUsage({
            id: selected.id,
            names: page.items
              .filter((item) => item.kind === "dashboard")
              .map((item) => item.name),
          });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setUsage({ id: selected.id, names: [] });
      });
    return () => controller.abort();
  }, [selected]);

  async function lifecycle(chart: SavedChart) {
    setBusy(true);
    setError("");
    try {
      if (chart.isDeleted) await restoreOpenViewChart(chart.id, chart.revision);
      else await archiveOpenViewChart(chart.id, chart.revision);
      if (selectedId === chart.id) setSelectedId(null);
      await client.invalidateQueries({ queryKey: openViewKeys.chartLists });
    } catch (failure) {
      const used = chartArchiveUsage(failure);
      setError(
        used
          ? `“${chart.name}” is still used on ${used.items.map((item) => item.name).join(", ") || "a page you cannot see"}. Remove it there first.`
          : apiErrorMessage(failure, "The saved chart could not be changed."),
      );
    } finally {
      setBusy(false);
    }
  }

  const reason = !selected
    ? "Choose a saved chart"
    : selected.isDeleted
      ? "Restore this chart first"
      : !size
        ? "No room for it here"
        : null;
  const shownPreview = preview?.id === selected?.id ? preview : null;

  return (
    <>
      <div className="-mx-5 grid min-h-0 flex-1 lg:grid-cols-[22.5rem_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col gap-2 border-b px-5 py-4 lg:border-r lg:border-b-0">
          <Input
            type="search"
            aria-label="Find a saved chart"
            placeholder="Find a saved chart"
            value={search}
            maxLength={100}
            onChange={(event) => setSearch(event.target.value)}
          />
          <label className="flex min-h-11 items-center gap-2 text-sm xl:min-h-8">
            <Checkbox
              checked={archived}
              onCheckedChange={(next) => {
                setArchived(next === true);
                setSelectedId(null);
              }}
            />
            Archived charts
          </label>
          <ul
            aria-label={archived ? "Archived saved charts" : "Saved charts"}
            className="-mx-2 min-h-0 flex-1 overflow-y-auto"
          >
            {list.isPending ? (
              <li role="status" className="text-muted-foreground px-2 text-sm">
                Loading saved charts…
              </li>
            ) : charts.length === 0 ? (
              <li className="text-muted-foreground px-2 text-sm">
                {list.error
                  ? "Saved charts could not be loaded."
                  : archived
                    ? "No archived charts."
                    : "No saved charts for this dashboard yet."}
              </li>
            ) : (
              charts.map((chart) => {
                const source = props.sources.find(
                  (candidate) => candidate.id === chart.moduleId,
                );
                return (
                  <li
                    key={chart.id}
                    className={cn(
                      "flex items-center gap-1 rounded-md pr-1",
                      chart.id === selectedId && "bg-action-tint",
                    )}
                  >
                    <button
                      type="button"
                      aria-pressed={chart.id === selectedId}
                      onClick={() => setSelectedId(chart.id)}
                      className="hover:bg-muted flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-md px-2 py-1 text-left xl:min-h-10"
                    >
                      <span className="truncate text-sm font-medium">
                        {chart.name}
                      </span>
                      <span className="text-muted-foreground truncate text-xs">
                        {source?.name ?? "Module"} ·{" "}
                        {kindLabel(chartKind(chart))}
                      </span>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-11 shrink-0"
                            aria-label={`${chart.name}, actions`}
                            disabled={busy}
                          />
                        }
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="slim-ui min-w-40"
                      >
                        <DropdownMenuItem
                          className="min-h-11 xl:min-h-8"
                          onClick={() => void lifecycle(chart)}
                        >
                          {chart.isDeleted ? "Restore" : "Archive"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })
            )}
          </ul>
          {error ? (
            <p role="alert" className="text-danger-text text-sm">
              {error}
            </p>
          ) : null}
        </div>
        <section
          aria-label="Preview"
          className="bg-muted/40 flex min-h-0 flex-col gap-3 overflow-y-auto px-5 py-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{selected?.name ?? "Preview"}</h3>
            {size ? (
              <span className="text-muted-foreground text-xs">
                as it shows at {sizeText(size)}
              </span>
            ) : null}
            {selected && sizes.length ? (
              <label className="ml-auto flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Size</span>
                <Select
                  id={`${id}-size`}
                  className="w-24"
                  value={size ? sizeText(size) : ""}
                  onValueChange={(value) => {
                    const [columns, rows] = value.split(" × ").map(Number);
                    setChosen({ columns, rows });
                  }}
                >
                  {sizes.map((option) => (
                    <option key={sizeText(option)} value={sizeText(option)}>
                      {sizeText(option)}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
          </div>
          {selected ? (
            <>
              <PreviewCard
                data={shownPreview?.data ?? null}
                stale={false}
                kind={chartKind(selected)}
                size={size}
                sources={props.sources}
                departmentNames={props.departmentNames}
                dashboard={props.dashboard}
                source={chartSource(selected)}
              />
              {shownPreview?.error ? (
                <p role="alert" className="text-danger-text text-sm">
                  {shownPreview.error}
                </p>
              ) : null}
              <p className="text-muted-foreground text-sm">
                {usage?.id !== selected.id
                  ? "Checking where it is used…"
                  : usage.names.length
                    ? `Used on ${usage.names.join(", ")}.`
                    : "Not used on a dashboard yet."}
              </p>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              Choose a saved chart to see it here.
            </p>
          )}
        </section>
      </div>
      <DialogFrameFooter className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          className="text-muted-foreground mr-auto min-h-11"
          onClick={props.onBack}
        >
          Build a new chart instead
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          onClick={props.onCancel}
        >
          Cancel
        </Button>
        <DisabledReason reason={reason} stable>
          <Button
            type="button"
            className="min-h-11"
            onClick={() => {
              if (selected && size && kind && !selected.isDeleted)
                props.onAdd({ source: chartSource(selected), kind, size });
            }}
          >
            {props.applyLabel}
          </Button>
        </DisabledReason>
      </DialogFrameFooter>
    </>
  );
}
