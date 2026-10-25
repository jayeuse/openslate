"use client";

import { useEffect, useRef, useState } from "react";
import {
  useQueries,
  useQuery,
  useQueryClient,
  type Query,
  type QueryKey,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { apiErrorMessage } from "@/lib/api-errors";
import { ApiContractError, ApiError } from "@/lib/api";
import { isOpenViewAccessDenied } from "../adapters/openview-access";
import {
  dashboardKeys,
  dashboardAggregateSnapshotOptions,
  dashboardRecordSnapshotOptions,
  dashboardSnapshotSignature,
} from "../adapters/dashboard-queries";
import type { OpenViewDashboard } from "../adapters/dashboards-api";
import {
  configSignature,
  draftWidgetFrom,
  type DraftWidget,
  type SnapshotState,
} from "../domain/dashboard-draft";
import { chunks } from "../domain/dashboard-grid";

function refused(error: unknown) {
  return (
    error instanceof ApiContractError ||
    (error instanceof ApiError && [401, 403, 404].includes(error.status))
  );
}

function cadenceInterval(dashboard: OpenViewDashboard | null): number {
  return dashboard?.refreshCadence === "one-minute"
    ? 60_000
    : dashboard?.refreshCadence === "five-minutes"
      ? 300_000
      : 0;
}

/** D23: the cadence counts from the end of the last read, never in the background. */
function nextRefresh(
  candidate: {
    state: {
      error: unknown;
      fetchStatus: string;
      dataUpdatedAt: number;
      errorUpdatedAt: number;
    };
  },
  automatic: boolean,
  interval: number,
): number | false {
  const state = candidate.state;
  if (!automatic || refused(state.error) || state.fetchStatus !== "idle")
    return false;
  const finished = Math.max(state.dataUpdatedAt, state.errorUpdatedAt);
  return Math.max(1, interval - (finished ? Date.now() - finished : 0));
}

function overdue(
  state:
    | {
        error: unknown;
        fetchStatus: string;
        dataUpdatedAt: number;
        errorUpdatedAt: number;
      }
    | undefined,
  interval: number,
): boolean {
  if (!state || refused(state.error) || state.fetchStatus !== "idle")
    return false;
  const finished = Math.max(state.dataUpdatedAt, state.errorUpdatedAt);
  return finished > 0 && Date.now() - finished >= interval;
}

export function useDashboardVisibility() {
  const client = useQueryClient();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const update = () => {
      const next = document.visibilityState === "visible";
      if (!next)
        void client.cancelQueries(
          { queryKey: dashboardKeys.snapshots },
          { revert: true },
        );
      setVisible(next);
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [client]);
  return visible;
}

/** One lifecycle for the cohort and each independently authorized records page.
 * D23 counts from completion; hidden/dirty time pauses cadence, not explicit reads. */
function useSnapshotRead<T>(
  options: UseQueryOptions<T>,
  dashboard: OpenViewDashboard | null,
  enabled: boolean,
  dirty: boolean,
) {
  const client = useQueryClient();
  const interval = cadenceInterval(dashboard);
  const automatic = enabled && !dirty && !dashboard?.isDeleted && interval > 0;
  const query = useQuery<T>({
    ...options,
    enabled: (candidate) => enabled && !refused(candidate.state.error),
    refetchIntervalInBackground: false,
    refetchInterval: (candidate) => nextRefresh(candidate, automatic, interval),
  });
  const eligibleKey = automatic ? JSON.stringify(options.queryKey) : "";
  const previousEligibleKey = useRef("");
  useEffect(() => {
    const returning =
      Boolean(eligibleKey) && previousEligibleKey.current !== eligibleKey;
    previousEligibleKey.current = eligibleKey;
    const finished = Math.max(query.dataUpdatedAt, query.errorUpdatedAt);
    if (
      returning &&
      !refused(query.error) &&
      !query.isFetching &&
      finished > 0 &&
      Date.now() - finished >= interval
    )
      void query.refetch();
  }, [
    eligibleKey,
    interval,
    query.dataUpdatedAt,
    query.errorUpdatedAt,
    query.error,
    query.isFetching,
    query.refetch,
  ]);
  useEffect(
    () => () => {
      // The shared refusal latch cancels its own failing read. Do not let that
      // reverted last-good cache reappear when an unrelated metadata read recovers.
      if (isOpenViewAccessDenied())
        client.removeQueries({ queryKey: options.queryKey, exact: true });
    },
    [client, options.queryKey],
  );
  return {
    data: refused(query.error) ? undefined : query.data,
    loading: enabled && query.isFetching,
    error: readError(query.error, query.isFetching),
    locked: lockedRead(query.error),
    refresh: () => {
      if (enabled && !query.isFetching) void query.refetch();
    },
  };
}

export function savedWidgetUnchanged(
  dashboard: OpenViewDashboard | null,
  widget: DraftWidget,
) {
  const saved = dashboard?.widgets.find(
    (candidate) => candidate.id === widget.key,
  );
  return Boolean(
    saved &&
    configSignature(draftWidgetFrom(saved)) === configSignature(widget),
  );
}

/**
 * The widgets read together: saved inline widgets of one module share one
 * `aggregate-snapshots` read (at most 12 queries each), and each saved Chart
 * is read on its own. A refused module then locks only its own widgets (BD6).
 * The order follows the saved list, so results stay correlated by widget key.
 */
export function dashboardCohorts(
  dashboard: OpenViewDashboard | null,
  widgets: readonly DraftWidget[],
): DraftWidget[][] {
  const groups = new Map<string, DraftWidget[]>();
  for (const saved of dashboard?.widgets ?? []) {
    const widget = widgets.find((candidate) => candidate.key === saved.id);
    if (
      !widget ||
      widget.widgetType === "records" ||
      !savedWidgetUnchanged(dashboard, widget)
    )
      continue;
    const group =
      widget.chartId != null
        ? `chart:${widget.chartId}`
        : `module:${widget.config?.query.moduleId ?? ""}`;
    groups.set(group, [...(groups.get(group) ?? []), widget]);
  }
  return [...groups.values()].flatMap((group) => chunks(group, 12));
}

/** A refusal of the viewer's read of one source: its widgets show a lock. */
export function lockedRead(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 403 ||
      error.status === 404 ||
      error.code === "chart_source_unavailable")
  );
}

export type WidgetRead = {
  snapshot: SnapshotState | null;
  loading: boolean;
  error: string;
  locked: boolean;
};

function readError(error: unknown, fetching: boolean): string {
  if (!error || fetching || lockedRead(error)) return "";
  return apiErrorMessage(error, "These results could not be refreshed.");
}

export function useDashboardAggregateSnapshots(
  dashboard: OpenViewDashboard | null,
  widgets: readonly DraftWidget[],
  visible: boolean,
  dirty: boolean,
) {
  const client = useQueryClient();
  const cohorts = dashboardCohorts(dashboard, widgets);
  const interval = cadenceInterval(dashboard);
  const automatic = visible && !dirty && !dashboard?.isDeleted && interval > 0;
  const results = useQueries({
    queries: cohorts.map((cohort) => ({
      ...dashboardAggregateSnapshotOptions(dashboard?.id ?? "", cohort),
      enabled: (candidate: Query<SnapshotState[]>) =>
        visible && !refused(candidate.state.error),
      refetchIntervalInBackground: false,
      refetchInterval: (candidate: Query<SnapshotState[]>) =>
        nextRefresh(candidate, automatic, interval),
    })),
  });
  const keys = cohorts.map((cohort) =>
    JSON.stringify(
      dashboardAggregateSnapshotOptions(dashboard?.id ?? "", cohort).queryKey,
    ),
  );
  const keyList = keys.join("|");
  const eligibleKey = automatic ? keyList : "";
  const previousEligibleKey = useRef("");
  useEffect(() => {
    const returning =
      Boolean(eligibleKey) && previousEligibleKey.current !== eligibleKey;
    previousEligibleKey.current = eligibleKey;
    if (!returning) return;
    // A cohort overdue while hidden or edited reads once on return (D23).
    for (const key of eligibleKey.split("|").filter(Boolean)) {
      const queryKey = JSON.parse(key) as QueryKey;
      if (overdue(client.getQueryState(queryKey), interval))
        void client.refetchQueries({ queryKey, exact: true });
    }
  }, [client, eligibleKey, interval]);
  useEffect(
    () => () => {
      // The shared refusal latch cancels its own failing read. Do not let that
      // reverted last-good cache reappear when an unrelated read recovers.
      if (isOpenViewAccessDenied())
        for (const key of keyList.split("|").filter(Boolean))
          client.removeQueries({ queryKey: JSON.parse(key), exact: true });
    },
    [client, keyList],
  );
  const reads = new Map<string, WidgetRead>();
  cohorts.forEach((cohort, index) => {
    const result = results[index];
    if (!result) return;
    const locked = lockedRead(result.error);
    const data = refused(result.error) ? undefined : result.data;
    for (const widget of cohort)
      reads.set(widget.key, {
        snapshot: data?.find((item) => item.widgetKey === widget.key) ?? null,
        loading: visible && result.isFetching,
        error: readError(result.error, result.isFetching),
        locked,
      });
  });
  return {
    reads,
    /** Read every cohort again, the locked ones too (the header's Refresh). */
    refresh: () => {
      for (const result of results)
        if (!result.isFetching) void result.refetch();
    },
  };
}

export function useDashboardRecordSnapshot(
  dashboard: OpenViewDashboard | null,
  widget: DraftWidget,
  visible: boolean,
  dirty: boolean,
  page: number,
  pageSize: number,
) {
  const persisted = savedWidgetUnchanged(dashboard, widget);
  const query = useSnapshotRead(
    dashboardRecordSnapshotOptions(dashboard?.id ?? "", widget, page, pageSize),
    dashboard,
    visible && persisted,
    dirty,
  );
  const snapshot: SnapshotState | null =
    persisted && query.data
      ? {
          widgetKey: widget.key,
          configSignature: dashboardSnapshotSignature(widget, page, pageSize),
          data: query.data,
        }
      : null;
  return { ...query, snapshot, persisted };
}
