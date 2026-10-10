"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, ApiContractError } from "@/lib/api";
import {
  listBoardWidgets,
  type BoardWidget,
} from "../adapters/board-widgets-api";
import {
  buildBoardWidgetQueryPlan,
  buildNativeBoardWidgetPlan,
  type BoardWidgetQueryPlan,
} from "../domain/live-widget-query";
import {
  getOpenViewDataSourceField,
  type OpenViewDataSourceField,
  queryOpenViewRecords,
  type OpenViewPage,
  type OpenViewRecord,
} from "../../openview/adapters/views-api";
import {
  queryOpenViewAggregates,
  queryOpenViewAggregateSnapshot,
  type OpenViewAggregateResult,
  type OpenViewAggregateSnapshotResult,
} from "../../openview/adapters/analytics-api";
import {
  getOpenViewChart,
  chartMatchesWidget,
  chartSourceStamp,
  type SavedChart,
} from "../../openview/adapters/charts-api";
import type { WorkspaceInvalidation } from "../../shared/adapters/invalidation-events";
import { useInvalidationRefresh } from "../../shared/adapters/use-invalidation-refresh";
import { invalidatesRecords } from "../../openview/adapters/openview-queries";

type ResolvedBoardPlan = Exclude<
  BoardWidgetQueryPlan,
  { kind: "unavailable" | "reference" }
>;
export type LiveWidgetData = (
  | {
      kind: "records";
      result: OpenViewPage<OpenViewRecord>;
      fieldNames: Record<string, string>;
    }
  | { kind: "aggregate"; result: OpenViewAggregateResult }
  | { kind: "snapshot"; result: OpenViewAggregateSnapshotResult }
) & { resolvedPlan?: ResolvedBoardPlan; sourceStamp?: string };

export type LiveWidgetItem = {
  widget: BoardWidget;
  plan: BoardWidgetQueryPlan;
  signature: string;
  status: "loading" | "ready" | "unavailable" | "error";
  data: LiveWidgetData | null;
  error: string | null;
};

export type LiveWidgetsState = {
  key: string | null;
  sequence: number;
  status: "idle" | "loading" | "ready" | "error";
  items: LiveWidgetItem[];
  error: string | null;
};

export type LiveWidgetsEvent =
  | { type: "begin"; key: string; sequence: number }
  | {
      type: "metadata";
      key: string;
      sequence: number;
      widgets: BoardWidget[];
      workspaceToday?: string;
    }
  | {
      type: "result";
      key: string;
      sequence: number;
      widgetId: string;
      signature: string;
      data: LiveWidgetData;
    }
  | {
      type: "item-error";
      key: string;
      sequence: number;
      widgetId: string;
      signature: string;
      retain: boolean;
      error: string;
    }
  | {
      type: "reject";
      key: string;
      sequence: number;
      retain: boolean;
      error: string;
    };

export const emptyLiveWidgetsState: LiveWidgetsState = {
  key: null,
  sequence: 0,
  status: "idle",
  items: [],
  error: null,
};

function widgetSignature(widget: BoardWidget): string {
  return JSON.stringify([
    widget.id,
    widget.boardId,
    widget.moduleId,
    widget.widgetType,
    widget.config,
    widget.chartId,
    widget.size,
    widget.pinned,
    widget.updatedAt,
  ]);
}

export function transitionLiveWidgetsState(
  state: LiveWidgetsState,
  event: LiveWidgetsEvent,
): LiveWidgetsState {
  if (event.type === "begin") {
    const sameBoardAndDay = state.key === event.key;
    return {
      key: event.key,
      sequence: event.sequence,
      status: "loading",
      items: sameBoardAndDay
        ? state.items.map((item) => ({
            ...item,
            data: item.widget.widgetType === "records" ? null : item.data,
            status:
              item.plan.kind === "unavailable" ? "unavailable" : "loading",
            error: null,
          }))
        : [],
      error: null,
    };
  }
  if (state.key !== event.key || state.sequence !== event.sequence)
    return state;
  if (event.type === "metadata") {
    const previous = new Map(state.items.map((item) => [item.widget.id, item]));
    return {
      ...state,
      status: "ready",
      items: event.widgets.map((widget) => {
        const plan = buildBoardWidgetQueryPlan(widget, {
          workspaceToday: event.workspaceToday,
        });
        const signature = widgetSignature(widget);
        const retained = previous.get(widget.id);
        const data =
          widget.widgetType !== "records" &&
          retained?.signature === signature &&
          (retained.plan.kind === plan.kind ||
            (plan.kind === "reference" &&
              retained.data?.resolvedPlan?.kind === retained.plan.kind))
            ? retained.data
            : null;
        return {
          widget,
          plan: data && plan.kind === "reference" ? retained!.plan : plan,
          signature,
          status: plan.kind === "unavailable" ? "unavailable" : "loading",
          data: plan.kind === "unavailable" ? null : data,
          error: null,
        };
      }),
    };
  }
  if (event.type === "reject") {
    return {
      ...state,
      status: event.retain && state.items.length > 0 ? "ready" : "error",
      items: event.retain
        ? state.items.map((item) => ({
            ...item,
            status:
              item.plan.kind === "unavailable"
                ? "unavailable"
                : item.data === null
                  ? "error"
                  : "ready",
          }))
        : [],
      error: event.error,
    };
  }
  return {
    ...state,
    items: state.items.map((item) => {
      if (
        item.widget.id !== event.widgetId ||
        item.signature !== event.signature
      )
        return item;
      if (event.type === "result") {
        const plan = event.data.resolvedPlan ?? item.plan;
        if (plan.kind !== event.data.kind) return item;
        return {
          ...item,
          plan,
          status: "ready",
          data: event.data,
          error: null,
        };
      }
      const data = event.retain ? item.data : null;
      return {
        ...item,
        status: data === null ? "error" : "ready",
        data,
        error: event.error,
      };
    }),
  };
}

export async function loadLiveWidgetMetadata(
  boardId: string,
): Promise<BoardWidget[]> {
  const page = await listBoardWidgets(boardId, {
    limit: 12,
    offset: 0,
    sortBy: "position",
    sortOrder: "asc",
  });
  if (
    page.pagination.offset !== 0 ||
    page.pagination.hasMore ||
    page.pagination.total !== page.items.length ||
    page.pagination.count !== page.items.length
  )
    throw new ApiContractError();
  return page.items;
}

export async function loadLiveWidgetData(
  plan: Exclude<BoardWidgetQueryPlan, { kind: "unavailable" }>,
  fields: Map<string, Promise<OpenViewDataSourceField>> = new Map(),
  charts: Map<string, Promise<SavedChart>> = new Map(),
  signal?: AbortSignal,
): Promise<LiveWidgetData> {
  if (plan.kind === "reference") {
    let read = charts.get(plan.chartId);
    if (!read) {
      read = getOpenViewChart(plan.chartId, signal);
      charts.set(plan.chartId, read);
    }
    const chart = await read;
    signal?.throwIfAborted();
    if (!chartMatchesWidget(chart, plan.widgetType, plan.moduleId))
      throw new ApiContractError();
    const resolvedPlan = buildNativeBoardWidgetPlan(
      plan.widgetType,
      chart.config,
    );
    if (
      resolvedPlan.kind === "unavailable" ||
      resolvedPlan.kind === "reference"
    )
      throw new ApiContractError();
    const data = await loadLiveWidgetData(resolvedPlan, fields, charts, signal);
    return { ...data, resolvedPlan, sourceStamp: chartSourceStamp(chart) };
  }
  if (plan.kind === "records") {
    const fieldNames: Record<string, string> = {};
    if (
      plan.widgetType === "records" &&
      plan.request.definition.columns.length > 0
    ) {
      for (const column of plan.request.definition.columns) {
        const key = `${plan.request.moduleId}:${column.fieldId}`;
        let request = fields.get(key);
        if (!request) {
          request = getOpenViewDataSourceField(
            plan.request.moduleId,
            column.fieldId,
          );
          fields.set(key, request);
        }
        const field = await request;
        signal?.throwIfAborted();
        const name = field.name.trim();
        if (!name || field.type !== column.expectedType)
          throw new ApiContractError();
        fieldNames[column.fieldId] = name;
      }
    }
    signal?.throwIfAborted();
    return {
      kind: "records",
      fieldNames,
      result: await queryOpenViewRecords(plan.request),
    };
  }
  if (plan.kind === "aggregate") {
    signal?.throwIfAborted();
    return {
      kind: "aggregate",
      result: await queryOpenViewAggregates(plan.request),
    };
  }
  signal?.throwIfAborted();
  return {
    kind: "snapshot",
    result: await queryOpenViewAggregateSnapshot(plan.request),
  };
}

export function classifyLiveWidgetFailure(
  error: unknown,
): "access-lost" | "transient" | "hard" {
  if (error instanceof ApiError && [401, 403, 404].includes(error.status))
    return "access-lost";
  if (
    error instanceof TypeError ||
    (error instanceof ApiError &&
      (error.status >= 500 || error.status === 408 || error.status === 429))
  )
    return "transient";
  return "hard";
}

export function useLiveBoardWidgets(
  boardId: string | null,
  workspaceToday: string | undefined,
  refreshKey: number,
) {
  const [state, setState] = useState<LiveWidgetsState>(emptyLiveWidgetsState);
  const [retryKey, setRetryKey] = useState(0);
  const sequence = useRef(0);
  const stateRef = useRef(state);
  const key = boardId === null ? null : `${boardId}:${workspaceToday ?? ""}`;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const acceptsInvalidation = useCallback(
    (event: WorkspaceInvalidation) => {
      if (event.type !== "invalidate") return false;
      if (event.entity === "board_widgets" || event.entity === "boards")
        return event.boardId === boardId;
      if (!invalidatesRecords(event.entity)) return false;
      const current = stateRef.current;
      return (
        current.key !== key ||
        (current.status !== "ready" && current.items.length === 0) ||
        event.moduleId === undefined ||
        current.items.some((item) => item.widget.moduleId === event.moduleId)
      );
    },
    [boardId, key],
  );
  const invalidationKey = useInvalidationRefresh(key, acceptsInvalidation);

  useEffect(() => {
    if (boardId === null || key === null) {
      sequence.current += 1;
      setState(emptyLiveWidgetsState);
      return;
    }
    const requestKey = key;
    const request = ++sequence.current;
    const controller = new AbortController();
    setState((current) =>
      transitionLiveWidgetsState(current, {
        type: "begin",
        key: requestKey,
        sequence: request,
      }),
    );
    void loadLiveWidgetMetadata(boardId)
      .then((widgets) => {
        if (request !== sequence.current) return;
        setState((current) =>
          transitionLiveWidgetsState(current, {
            type: "metadata",
            key: requestKey,
            sequence: request,
            widgets,
            workspaceToday,
          }),
        );
        const tasks = widgets.flatMap((widget) => {
          const plan = buildBoardWidgetQueryPlan(widget, { workspaceToday });
          return plan.kind === "unavailable"
            ? []
            : [{ id: widget.id, signature: widgetSignature(widget), plan }];
        });
        const fields = new Map<string, Promise<OpenViewDataSourceField>>();
        const charts = new Map<string, Promise<SavedChart>>();
        let next = 0;
        async function work(): Promise<void> {
          while (request === sequence.current && next < tasks.length) {
            const task = tasks[next++];
            try {
              const data = await loadLiveWidgetData(
                task.plan,
                fields,
                charts,
                controller.signal,
              );
              if (request !== sequence.current) return;
              setState((current) =>
                transitionLiveWidgetsState(current, {
                  type: "result",
                  key: requestKey,
                  sequence: request,
                  widgetId: task.id,
                  signature: task.signature,
                  data,
                }),
              );
            } catch (error: unknown) {
              if (request !== sequence.current) return;
              const failure = classifyLiveWidgetFailure(error);
              if (failure === "access-lost") {
                sequence.current += 1;
                setState((current) =>
                  transitionLiveWidgetsState(current, {
                    type: "reject",
                    key: requestKey,
                    sequence: request,
                    retain: false,
                    error:
                      error instanceof ApiError &&
                      error.code === "chart_source_unavailable" &&
                      error.status === 403
                        ? "You do not have access to this data."
                        : "Widgets unavailable. Check your access or try again.",
                  }),
                );
                return;
              }
              setState((current) =>
                transitionLiveWidgetsState(current, {
                  type: "item-error",
                  key: requestKey,
                  sequence: request,
                  widgetId: task.id,
                  signature: task.signature,
                  retain:
                    failure === "transient" &&
                    !(
                      task.plan.kind === "records" &&
                      task.plan.widgetType === "records"
                    ),
                  error:
                    failure === "transient"
                      ? "Could not refresh widget data. Try again."
                      : "Widget data unavailable. Try again.",
                }),
              );
            }
          }
        }
        void Promise.all(
          Array.from({ length: Math.min(3, tasks.length) }, () => work()),
        );
      })
      .catch((error: unknown) => {
        if (request !== sequence.current) return;
        const failure = classifyLiveWidgetFailure(error);
        setState((current) =>
          transitionLiveWidgetsState(current, {
            type: "reject",
            key: requestKey,
            sequence: request,
            retain: failure === "transient",
            error:
              failure === "access-lost"
                ? "Widgets unavailable. Check your access or try again."
                : "Could not refresh widgets. Try again.",
          }),
        );
      });
    return () => {
      controller.abort();
      sequence.current += 1;
    };
  }, [boardId, key, workspaceToday, refreshKey, retryKey, invalidationKey]);

  return {
    state:
      key === null
        ? emptyLiveWidgetsState
        : state.key === key
          ? state
          : {
              ...emptyLiveWidgetsState,
              key,
              status: "loading" as const,
            },
    retry: () => setRetryKey((value) => value + 1),
  };
}
