"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  dashboardKeys,
  dashboardSnapshotOptions,
  dashboardSnapshotSignature,
} from "../adapters/dashboard-queries";
import type { OpenViewDashboard } from "../adapters/dashboards-api";
import type { DraftWidget, SnapshotState } from "../domain/dashboard-draft";

export function useDashboardSnapshot(
  dashboard: OpenViewDashboard | null,
  routeId: string | undefined,
  widget: DraftWidget | undefined,
  persisted: boolean,
  dirty: boolean,
  page: number,
  pageSize: number,
) {
  const client = useQueryClient();
  const [visible, setVisible] = useState(false);
  const enabled = Boolean(
    dashboard && routeId === dashboard.id && widget && persisted && visible,
  );
  const interval =
    dashboard?.refreshCadence === "one-minute"
      ? 60_000
      : dashboard?.refreshCadence === "five-minutes"
        ? 300_000
        : 0;
  const automatic = enabled && !dirty && !dashboard?.isDeleted && interval > 0;
  const options = dashboardSnapshotOptions(
    dashboard?.id ?? "",
    widget,
    page,
    pageSize,
    automatic ? interval : false,
  );
  const query = useQuery({ ...options, enabled });
  const eligibleKey = automatic ? JSON.stringify(options.queryKey) : "";
  const previousEligibleKey = useRef("");

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

  useEffect(() => {
    const returning =
      Boolean(eligibleKey) && previousEligibleKey.current !== eligibleKey;
    previousEligibleKey.current = eligibleKey;
    const finished = Math.max(query.dataUpdatedAt, query.errorUpdatedAt);
    if (
      returning &&
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
    query.isFetching,
    query.refetch,
  ]);

  const snapshot: SnapshotState | null =
    widget && persisted && query.data
      ? {
          widgetKey: widget.key,
          configSignature: dashboardSnapshotSignature(widget, page, pageSize),
          data: query.data,
        }
      : null;
  const refresh = () => {
    if (enabled && !query.isFetching) void query.refetch();
  };
  return {
    snapshot,
    loading: enabled && query.isFetching,
    error:
      query.error && !query.isFetching
        ? apiErrorMessage(
            query.error,
            "This Dashboard widget could not be refreshed.",
          )
        : "",
    refresh,
  };
}
