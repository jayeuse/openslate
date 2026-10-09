"use client";

import { useEffect, useRef, useState } from "react";
import {
  useQuery,
  useQueryClient,
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
  type DraftWidget,
  type SnapshotState,
} from "../domain/dashboard-draft";

function refused(error: unknown) {
  return (
    error instanceof ApiContractError ||
    (error instanceof ApiError && [401, 403, 404].includes(error.status))
  );
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
  const interval =
    dashboard?.refreshCadence === "one-minute"
      ? 60_000
      : dashboard?.refreshCadence === "five-minutes"
        ? 300_000
        : 0;
  const automatic = enabled && !dirty && !dashboard?.isDeleted && interval > 0;
  const query = useQuery<T>({
    ...options,
    enabled: (candidate) => enabled && !refused(candidate.state.error),
    refetchIntervalInBackground: false,
    refetchInterval: (candidate) => {
      if (
        !automatic ||
        refused(candidate.state.error) ||
        candidate.state.fetchStatus !== "idle"
      )
        return false;
      const finished = Math.max(
        candidate.state.dataUpdatedAt,
        candidate.state.errorUpdatedAt,
      );
      return Math.max(1, interval - (finished ? Date.now() - finished : 0));
    },
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
    error:
      query.error && !query.isFetching
        ? query.error instanceof ApiError &&
          query.error.code === "chart_source_unavailable" &&
          query.error.status === 403
          ? "You do not have access to this data."
          : apiErrorMessage(
              query.error,
              "These Dashboard results could not be refreshed.",
            )
        : "",
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
    configSignature({ ...saved, key: saved.id }) === configSignature(widget),
  );
}

export function useDashboardAggregateSnapshots(
  dashboard: OpenViewDashboard | null,
  widgets: DraftWidget[],
  visible: boolean,
  dirty: boolean,
) {
  // Preserve persisted order across presentation-only draft moves. The response
  // carries each stable key, so neither tile order nor size can misassign it.
  const cohort = (dashboard?.widgets ?? []).flatMap((saved) => {
    const widget = widgets.find((candidate) => candidate.key === saved.id);
    return widget &&
      widget.widgetType !== "records" &&
      savedWidgetUnchanged(dashboard, widget)
      ? [widget]
      : [];
  });
  return useSnapshotRead(
    dashboardAggregateSnapshotOptions(dashboard?.id ?? "", cohort),
    dashboard,
    visible && cohort.length > 0,
    dirty,
  );
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
