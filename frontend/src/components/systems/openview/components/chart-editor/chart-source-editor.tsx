"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { SearchSelect } from "@/components/ui/search-select";
import { ApiContractError } from "@/lib/api";
import { subscribeWorkspaceInvalidations } from "../../../shared/adapters/invalidation-events";
import {
  chartListOptions,
  extendsRead,
  isAuthorizationDenied,
  readStamp,
} from "../../adapters/openview-queries";
import {
  chartMatchesWidget,
  getOpenViewChart,
  listOpenViewCharts,
  chartSourceStamp,
  type SavedChart,
} from "../../adapters/charts-api";
import type { OpenViewWidgetSource } from "../../adapters/dashboards-api";
import { useOpenViewAccessDenied } from "../../adapters/openview-access";
import {
  compileChartEditorDraft,
  type ChartSourceDraft,
} from "../../domain/chart-query";
import {
  ChartEditor,
  type ChartEditorCatalog,
  type ChartEditorActions,
} from "./chart-editor";

export type ChartSourceEditorProps = {
  value: ChartSourceDraft;
  onChange: (value: ChartSourceDraft) => void;
  catalog: ChartEditorCatalog;
  actions: ChartEditorActions;
  disabled: boolean;
  restrictModule?: boolean;
  onUnavailable?: () => void;
  refusedChartId?: string | null;
  onRetrySource?: () => void;
  children: (
    input: OpenViewWidgetSource | null,
    sourceStamp: string | null,
  ) => ReactNode;
};

/** Source controls are shared; the caller still owns its draft and actions. */
export function ChartSourceEditor(props: ChartSourceEditorProps) {
  const { value, onChange } = props;
  const inline =
    !props.catalog.sourcesLoading &&
    !props.catalog.sourcesError &&
    !props.catalog.fieldsLoading &&
    !props.catalog.fieldsError &&
    props.catalog.sources.some((source) => source.id === value.inline.moduleId)
      ? compileChartEditorDraft(value.inline, props.catalog.fields)
      : null;
  return (
    <div className="min-w-0 space-y-4">
      <Field>
        <FieldLabel htmlFor="chart-source">Chart source</FieldLabel>
        <Select
          id="chart-source"
          className="min-h-11"
          value={value.chartId === null ? "inline" : "saved"}
          disabled={props.disabled}
          onValueChange={(source) =>
            onChange({ ...value, chartId: source === "inline" ? null : "" })
          }
        >
          <option value="inline">Inline query</option>
          <option value="saved">Saved Chart</option>
        </Select>
      </Field>
      {value.chartId === null ? (
        <>
          <ChartEditor
            catalog={props.catalog}
            actions={props.actions}
            value={value.inline}
            onChange={(inline) => onChange({ ...value, inline })}
            queryLoading={props.disabled}
          />
          {props.children(inline ? { ...inline, chartId: null } : null, null)}
        </>
      ) : (
        <SavedChartPicker {...props} />
      )}
    </div>
  );
}

function SavedChartPicker({
  value,
  onChange,
  disabled,
  restrictModule,
  onUnavailable,
  children,
  refusedChartId,
  onRetrySource,
}: ChartSourceEditorProps) {
  const client = useQueryClient();
  const accessDenied = useOpenViewAccessDenied();
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const [extra, setExtra] = useState<{
    search: string;
    readAt: number;
    items: SavedChart[];
    hasMore: boolean;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState("");
  const [detail, setDetail] = useState<{
    key: string;
    chart: SavedChart | null;
    error: boolean;
  } | null>(null);
  const moduleId = restrictModule ? value.inline.moduleId : undefined;
  const type = value.inline.widgetType;
  const list = useQuery(chartListOptions(search, moduleId));
  const key = JSON.stringify([value.chartId, type, moduleId, revision]);
  const selected =
    value.chartId && refusedChartId === value.chartId
      ? { key, chart: null, error: true }
      : detail?.key === key
        ? detail
        : null;
  // Only a refused list revokes the accepted chart; a transient list failure is
  // retryable picker metadata.
  const listDenied = isAuthorizationDenied(list.error);
  const chart = listDenied || accessDenied ? null : (selected?.chart ?? null);
  const extension =
    extra?.search === search && extendsRead(extra.readAt, list) ? extra : null;
  // A refused selected chart keeps the rest of the list, so a replacement can be
  // chosen without showing the refused chart again.
  const items =
    list.error || accessDenied
      ? []
      : [...(list.data?.items ?? []), ...(extension?.items ?? [])].filter(
          (item) => !selected?.error || item.id !== value.chartId,
        );
  const hasMore = extension?.hasMore ?? list.data?.pagination.hasMore ?? false;
  useEffect(
    () =>
      subscribeWorkspaceInvalidations((event) => {
        if (
          event.type === "resync" ||
          event.entity === "charts" ||
          event.entity === "group_access" ||
          event.entity === "group_members"
        ) {
          setRevision((current) => current + 1);
          void client.invalidateQueries({
            queryKey: ["openview", "catalog", "charts"],
          });
        }
      }),
    [client],
  );
  useEffect(() => {
    if (listDenied || accessDenied) onUnavailable?.();
  }, [listDenied, accessDenied, onUnavailable]);
  useEffect(() => {
    const controller = new AbortController();
    if (!value.chartId) return;
    void getOpenViewChart(value.chartId, controller.signal)
      .then((chart) => {
        if (!chartMatchesWidget(chart, type, moduleId))
          throw new ApiContractError();
        if (!controller.signal.aborted) setDetail({ key, chart, error: false });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setDetail({ key, chart: null, error: true });
        onUnavailable?.();
      });
    return () => controller.abort();
  }, [key, value.chartId, type, moduleId, onUnavailable]);

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    const readAt = readStamp(list);
    const offset =
      (list.data?.items.length ?? 0) + (extension?.items.length ?? 0);
    setLoadingMore(true);
    setPageError("");
    try {
      const page = await listOpenViewCharts({ search, moduleId, offset });
      if (page.items.some((item) => items.some((old) => old.id === item.id)))
        throw new ApiContractError();
      setExtra({
        search,
        readAt,
        items: [...(extension?.items ?? []), ...page.items],
        hasMore: page.pagination.hasMore,
      });
    } catch {
      setPageError("Saved Charts could not be loaded. Retry the list.");
    } finally {
      setLoadingMore(false);
    }
  }
  return (
    <>
      <SearchSelect
        label="Saved Chart"
        value={value.chartId ?? ""}
        disabled={disabled}
        options={items
          .filter((chart) => chartMatchesWidget(chart, type, moduleId))
          .map((chart) => ({ value: chart.id, label: chart.name }))}
        selectedOption={
          chart ? { value: chart.id, label: chart.name } : undefined
        }
        onValueChange={(chartId) => onChange({ ...value, chartId })}
        search={search}
        onSearchChange={(search) => {
          setSearch(search.slice(0, 100));
          setPageError("");
        }}
        loading={list.isFetching}
        error={
          list.error || accessDenied
            ? "Saved Charts are unavailable. Retry the list."
            : pageError
        }
        onRetry={() => {
          setPageError("");
          void list.refetch();
        }}
        hasMore={hasMore && !accessDenied}
        onLoadMore={() => void loadMore()}
        loadingMore={loadingMore}
      />
      {value.chartId && !selected ? (
        <p role="status" className="text-muted-foreground text-sm">
          Checking the current saved Chart…
        </p>
      ) : null}
      {selected?.error ? (
        <Alert role="alert" variant="destructive">
          Saved Chart is unavailable. Your source selection is retained; retry
          or choose another Chart.
          <Button
            type="button"
            variant="outline"
            className="mt-3 min-h-11"
            onClick={() => {
              onRetrySource?.();
              setRevision((current) => current + 1);
            }}
          >
            Retry saved Chart
          </Button>
        </Alert>
      ) : null}
      <p className="text-muted-foreground text-sm">
        This widget stores a reference only. The current authorized Chart is
        checked again before reading or saving.
      </p>
      {children(
        chart ? { widgetType: type, chartId: chart.id, config: null } : null,
        chart ? chartSourceStamp(chart) : null,
      )}
    </>
  );
}
