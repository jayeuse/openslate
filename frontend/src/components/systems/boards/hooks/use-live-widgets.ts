"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, ApiContractError } from "@/lib/api";
import {
  listBoardWidgets,
  type BoardWidget,
} from "../adapters/board-widgets-api";
import {
  buildBoardWidgetQueryPlan,
  type BoardWidgetQueryPlan,
} from "../domain/live-widget-query";
import {
  listOpenViewDataSourceFields,
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
import { subscribeOpenViewInvalidations } from "../../openview/adapters/invalidation-events";
import { invalidatesRecords } from "../../openview/adapters/openview-queries";

export type LiveWidgetData =
  | {
      kind: "records";
      result: OpenViewPage<OpenViewRecord>;
      fieldNames: Record<string, string>;
    }
  | { kind: "aggregate"; result: OpenViewAggregateResult }
  | { kind: "snapshot"; result: OpenViewAggregateSnapshotResult };

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
          retained.plan.kind === plan.kind
            ? retained.data
            : null;
        return {
          widget,
          plan,
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
        if (item.plan.kind !== event.data.kind) return item;
        return { ...item, status: "ready", data: event.data, error: null };
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
  catalogs: Map<string, Promise<Map<string, string>>> = new Map(),
): Promise<LiveWidgetData> {
  if (plan.kind === "records") {
    const fieldNames: Record<string, string> = {};
    if (
      plan.widgetType === "records" &&
      plan.request.definition.columns.length > 0
    ) {
      let catalog = catalogs.get(plan.request.moduleId);
      if (!catalog) {
        catalog = loadOpenViewFieldCatalog(plan.request.moduleId);
        catalogs.set(plan.request.moduleId, catalog);
      }
      const names = await catalog;
      for (const field of plan.request.definition.columns) {
        const name = names.get(field.fieldId)?.trim();
        if (!name) throw new ApiContractError();
        fieldNames[field.fieldId] = name;
      }
    }
    return {
      kind: "records",
      fieldNames,
      result: await queryOpenViewRecords(plan.request),
    };
  }
  if (plan.kind === "aggregate") {
    return {
      kind: "aggregate",
      result: await queryOpenViewAggregates(plan.request),
    };
  }
  return {
    kind: "snapshot",
    result: await queryOpenViewAggregateSnapshot(plan.request),
  };
}

const FIELD_CATALOG_PAGE_SIZE = 100;
const MAX_FIELD_CATALOG_PAGES = 3;

async function loadOpenViewFieldCatalog(
  moduleId: string,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let offset = 0;
  for (
    let pageNumber = 0;
    pageNumber < MAX_FIELD_CATALOG_PAGES;
    pageNumber += 1
  ) {
    const page = await listOpenViewDataSourceFields(moduleId, {
      limit: FIELD_CATALOG_PAGE_SIZE,
      offset,
    });
    if (
      page.pagination.offset !== offset ||
      page.pagination.count !== page.items.length ||
      page.pagination.total < offset + page.items.length
    )
      throw new ApiContractError();
    for (const field of page.items) names.set(field.id, field.name);
    if (!page.pagination.hasMore) break;
    if (page.items.length === 0) throw new ApiContractError();
    offset += page.items.length;
  }
  return names;
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
  const [invalidationKey, setInvalidationKey] = useState(0);
  const sequence = useRef(0);
  const stateRef = useRef(state);
  const key = boardId === null ? null : `${boardId}:${workspaceToday ?? ""}`;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (boardId === null || key === null) return;
    const refresh = () => setInvalidationKey((value) => value + 1);
    return subscribeOpenViewInvalidations((event) => {
      if (event.type === "resync") {
        refresh();
        return;
      }
      if (!invalidatesRecords(event.entity)) return;
      const current = stateRef.current;
      if (
        current.key !== key ||
        (current.status !== "ready" && current.items.length === 0) ||
        event.moduleId === undefined ||
        current.items.some((item) => item.widget.moduleId === event.moduleId)
      )
        refresh();
    }, refresh);
  }, [boardId, key]);

  useEffect(() => {
    if (boardId === null || key === null) {
      sequence.current += 1;
      setState(emptyLiveWidgetsState);
      return;
    }
    const requestKey = key;
    const request = ++sequence.current;
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
        const catalogs = new Map<string, Promise<Map<string, string>>>();
        let next = 0;
        async function work(): Promise<void> {
          while (request === sequence.current && next < tasks.length) {
            const task = tasks[next++];
            try {
              const data = await loadLiveWidgetData(task.plan, catalogs);
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
                      "Widgets unavailable. Check your access or try again.",
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
