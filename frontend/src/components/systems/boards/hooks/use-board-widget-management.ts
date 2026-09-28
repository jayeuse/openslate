"use client";

import { useEffect, useRef, useState } from "react";
import { ApiContractError, ApiError } from "@/lib/api";
import {
  createBoardWidget,
  deleteBoardWidget,
  duplicateBoardWidget,
  listBoardWidgets,
  reorderBoardWidgets,
  updateBoardWidget,
} from "../adapters/board-widgets-api";
import type {
  BoardWidget,
  BoardWidgetInput,
  BoardWidgetPage,
} from "../adapters/board-widgets-api";
import { getMyBoardAccess } from "../adapters/board-tools-api";
import type { BoardMyAccess } from "../adapters/board-tools-api";
import {
  listOpenViewDataSources,
  type OpenViewDataSource,
} from "../../openview/adapters/views-api";
import { readBoard } from "../adapters/board-management-api";

export type WidgetSettingsDraft = {
  source: BoardWidget;
  name: string;
  size: "half" | "full";
  pinned: boolean;
};

export type WidgetManagementSnapshot = {
  page: BoardWidgetPage;
  access: BoardMyAccess;
};

export function createSummaryWidgetInput(
  name: string,
  moduleId: string,
): BoardWidgetInput {
  return {
    name: name.trim(),
    widgetType: "summary",
    moduleId,
    config: {
      version: 1,
      fields: [],
      filters: [],
      logic: "and",
      metric: null,
      visualization: "bar",
      size: "half",
      refresh: "manual",
      pinned: false,
    },
  };
}

export function draftFromBoardWidget(widget: BoardWidget): WidgetSettingsDraft {
  return {
    source: widget,
    name: widget.name,
    size: widget.config.size,
    pinned: widget.config.pinned,
  };
}

function sameWidgetVersion(
  current: BoardWidget,
  original: BoardWidget,
): boolean {
  return (
    current.id === original.id &&
    current.boardId === original.boardId &&
    current.updatedAt === original.updatedAt &&
    current.name === original.name &&
    current.widgetType === original.widgetType &&
    current.moduleId === original.moduleId &&
    JSON.stringify(current.config) === JSON.stringify(original.config)
  );
}

export function updateInputForWidgetDraft(
  widget: BoardWidget,
  draft: WidgetSettingsDraft,
): BoardWidgetInput {
  if (!sameWidgetVersion(widget, draft.source)) throw new ApiContractError();
  return {
    name: draft.name.trim(),
    widgetType: widget.widgetType,
    moduleId: widget.moduleId,
    config: {
      ...widget.config,
      size: draft.size,
      pinned: draft.pinned,
    },
  };
}

export function retainWidgetDraftAfterConflict(
  draft: WidgetSettingsDraft,
  visible: BoardWidget[],
): WidgetSettingsDraft | null {
  return visible.some((widget) => widget.id === draft.source.id) ? draft : null;
}

export async function loadWidgetManagementSnapshot(
  boardId: string,
): Promise<WidgetManagementSnapshot> {
  const [access, page] = await Promise.all([
    getMyBoardAccess(boardId),
    listBoardWidgets(boardId, {
      limit: 12,
      offset: 0,
      sortBy: "position",
      sortOrder: "asc",
    }),
  ]);
  if (
    !access.view ||
    page.pagination.offset !== 0 ||
    page.pagination.hasMore ||
    page.pagination.count !== page.items.length ||
    page.pagination.total !== page.items.length ||
    page.items.some((widget) => widget.boardId !== boardId) ||
    new Set(page.items.map((widget) => widget.id)).size !== page.items.length
  )
    throw new ApiContractError();
  return { access, page };
}

export function reorderVisibleWidgetIds(
  page: BoardWidgetPage,
  widgetId: string,
  direction: -1 | 1,
): string[] | null {
  const ids = page.items.map((widget) => widget.id);
  const index = ids.indexOf(widgetId);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= ids.length) return null;
  [ids[index], ids[next]] = [ids[next], ids[index]];
  return ids;
}

export async function saveWidgetDraft(
  boardId: string,
  page: BoardWidgetPage,
  draft: WidgetSettingsDraft,
) {
  const current = page.items.find((widget) => widget.id === draft.source.id);
  if (!current) throw new ApiContractError();
  return updateBoardWidget(
    boardId,
    current.id,
    page.boardRevision,
    updateInputForWidgetDraft(current, draft),
  );
}

export async function loadWidgetSourcePage(offset: number) {
  const page = await listOpenViewDataSources({ limit: 100, offset });
  if (
    page.pagination.offset !== offset ||
    page.pagination.count !== page.items.length ||
    page.pagination.total < offset + page.items.length ||
    (page.pagination.hasMore && page.items.length === 0) ||
    new Set(page.items.map((source) => source.id)).size !== page.items.length
  )
    throw new ApiContractError();
  return page;
}

type SummaryDraft = { name: string; moduleId: string };
const blankSummary: SummaryDraft = { name: "", moduleId: "" };

type ManagerState = {
  key: string | null;
  status: "idle" | "loading" | "ready" | "error" | "denied";
  snapshot: WidgetManagementSnapshot | null;
  draft: WidgetSettingsDraft | null;
  summary: SummaryDraft;
  pending: boolean;
  conflict: boolean;
  archiveLocked: boolean;
  error: string | null;
  notice: string | null;
};

type SourceState = {
  key: string | null;
  status: "idle" | "loading" | "ready" | "error";
  items: OpenViewDataSource[];
  hasMore: boolean;
  error: string | null;
};

const emptyManager: ManagerState = {
  key: null,
  status: "idle",
  snapshot: null,
  draft: null,
  summary: blankSummary,
  pending: false,
  conflict: false,
  archiveLocked: false,
  error: null,
  notice: null,
};
const emptySources: SourceState = {
  key: null,
  status: "idle",
  items: [],
  hasMore: false,
  error: null,
};

export function beginWidgetManagerState(
  previous: ManagerState,
  boardId: string,
  boardActive = true,
): ManagerState {
  return {
    ...emptyManager,
    key: boardId,
    status: "loading",
    draft: previous.key === boardId ? previous.draft : null,
    summary: previous.key === boardId ? previous.summary : blankSummary,
    archiveLocked:
      previous.key === boardId && boardActive ? previous.archiveLocked : false,
  };
}

export function deniedWidgetManagerState(boardId: string): ManagerState {
  return {
    ...emptyManager,
    key: boardId,
    status: "denied",
    error: "Board widgets are unavailable with your current access.",
  };
}

export function canMutateBoardWidgets(
  state: ManagerState,
  boardActive: boolean,
): boolean {
  return (
    boardActive &&
    state.status === "ready" &&
    state.snapshot?.access.manage === true &&
    !state.pending &&
    !state.conflict &&
    !state.archiveLocked
  );
}

export function cancelWidgetEdit(state: ManagerState): ManagerState {
  return { ...state, draft: null, conflict: false, error: null };
}

export function widgetManagerAfterConflict(
  previous: ManagerState,
  error: ApiError,
  snapshot: WidgetManagementSnapshot,
): ManagerState {
  const draft =
    snapshot.access.manage && previous.draft
      ? retainWidgetDraftAfterConflict(previous.draft, snapshot.page.items)
      : null;
  const archiveLocked =
    previous.archiveLocked || error.code === "board_archived";
  return {
    ...previous,
    status: "ready",
    snapshot,
    draft,
    summary: snapshot.access.manage ? previous.summary : blankSummary,
    pending: false,
    conflict: !sameDraftSource(draft, snapshot),
    archiveLocked,
    error: archiveLocked
      ? "This Board is archived. Widget changes are locked until it is restored."
      : draft === null && previous.draft !== null
        ? "This widget is no longer available. Your settings draft was cleared."
        : `${error.message}. Review the latest widgets before retrying.`,
  };
}

function accessLost(error: unknown): boolean {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

export async function notifyIfBoardViewLost(
  boardId: string,
  stillCurrent: () => boolean,
  onAccessDenied: (boardId: string) => void,
): Promise<void> {
  try {
    await readBoard(boardId);
    return;
  } catch (error: unknown) {
    if (!accessLost(error)) return;
  }
  if (stillCurrent()) onAccessDenied(boardId);
}

function sameDraftSource(
  draft: WidgetSettingsDraft | null,
  snapshot: WidgetManagementSnapshot,
): boolean {
  if (!draft) return true;
  const current = snapshot.page.items.find(
    (item) => item.id === draft.source.id,
  );
  return current !== undefined && sameWidgetVersion(current, draft.source);
}

export function useBoardWidgetManagement({
  boardId,
  boardActive,
  refreshKey,
  onChanged,
  onBoardRefresh,
  onAccessDenied,
}: {
  boardId: string;
  boardActive: boolean;
  refreshKey: number;
  onChanged?: () => void;
  onBoardRefresh: () => void | Promise<void>;
  onAccessDenied: (boardId: string) => void;
}) {
  const [state, setState] = useState<ManagerState>(emptyManager);
  const [sources, setSources] = useState<SourceState>(emptySources);
  const [reloadKey, setReloadKey] = useState(0);
  const sequence = useRef(0);
  const sourceSequence = useRef(0);
  const pending = useRef(false);
  const activeBoard = useRef<string | null>(null);
  const deferredReload = useRef(false);
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  const boardRefreshRef = useRef(onBoardRefresh);
  boardRefreshRef.current = onBoardRefresh;
  const accessDeniedRef = useRef(onAccessDenied);
  accessDeniedRef.current = onAccessDenied;
  const renderedBoard = useRef(boardId);
  renderedBoard.current = boardId;
  const current = state.key === boardId ? state : emptyManager;
  const currentSources = sources.key === boardId ? sources : emptySources;

  function recheckBoardView(request: number) {
    void notifyIfBoardViewLost(
      boardId,
      () =>
        request === sequence.current &&
        renderedBoard.current === boardId &&
        activeBoard.current === boardId,
      (deniedBoardId) => accessDeniedRef.current(deniedBoardId),
    );
  }

  useEffect(() => {
    if (pending.current && activeBoard.current === boardId) {
      deferredReload.current = true;
      return;
    }
    activeBoard.current = boardId;
    deferredReload.current = false;
    const request = ++sequence.current;
    sourceSequence.current += 1;
    pending.current = false;
    setState((previous) =>
      beginWidgetManagerState(previous, boardId, boardActive),
    );
    setSources({ ...emptySources, key: boardId });
    void loadWidgetManagementSnapshot(boardId)
      .then((snapshot) => {
        if (request !== sequence.current) return;
        setState((previous) => {
          const draft =
            snapshot.access.manage && previous.draft
              ? retainWidgetDraftAfterConflict(
                  previous.draft,
                  snapshot.page.items,
                )
              : null;
          return {
            ...previous,
            key: boardId,
            status: "ready",
            snapshot,
            draft,
            summary: snapshot.access.manage ? previous.summary : blankSummary,
            conflict: !sameDraftSource(draft, snapshot),
            error: null,
          };
        });
        if (!snapshot.access.manage || !boardActive) return;
        const sourceRequest = ++sourceSequence.current;
        setSources({ ...emptySources, key: boardId, status: "loading" });
        void loadWidgetSourcePage(0)
          .then((page) => {
            if (sourceRequest !== sourceSequence.current) return;
            setSources({
              key: boardId,
              status: "ready",
              items: page.items,
              hasMore: page.pagination.hasMore,
              error: null,
            });
          })
          .catch((error: unknown) => {
            if (sourceRequest !== sourceSequence.current) return;
            setSources({
              ...emptySources,
              key: boardId,
              status: "error",
              error: "Could not load active record sources. Retry.",
            });
            if (accessLost(error)) {
              const deniedRequest = ++sequence.current;
              pending.current = false;
              setSources({ ...emptySources, key: boardId });
              setState(deniedWidgetManagerState(boardId));
              recheckBoardView(deniedRequest);
            }
          });
      })
      .catch((error: unknown) => {
        if (request !== sequence.current) return;
        if (accessLost(error)) {
          setSources({ ...emptySources, key: boardId });
          setState(deniedWidgetManagerState(boardId));
          recheckBoardView(request);
        } else {
          setState((previous) => ({
            ...previous,
            key: boardId,
            status: "error",
            snapshot: null,
            error: "Could not load Board widgets. Retry.",
          }));
        }
      });
    return () => {
      sourceSequence.current += 1;
    };
  }, [boardId, boardActive, refreshKey, reloadKey]);

  useEffect(
    () => () => {
      sequence.current += 1;
      sourceSequence.current += 1;
      activeBoard.current = null;
      deferredReload.current = false;
    },
    [],
  );

  function reload() {
    if (pending.current) return;
    setReloadKey((value) => value + 1);
  }

  function edit(widgetId: string) {
    const snapshot = current.snapshot;
    if (
      !snapshot ||
      !canMutateBoardWidgets(current, boardActive) ||
      pending.current
    )
      return;
    const widget = snapshot.page.items.find((item) => item.id === widgetId);
    if (!widget) return;
    setState((previous) => ({
      ...previous,
      draft: draftFromBoardWidget(widget),
      conflict: false,
      error: null,
      notice: null,
    }));
  }

  function changeDraft(
    patch: Partial<Pick<WidgetSettingsDraft, "name" | "size" | "pinned">>,
  ) {
    setState((previous) => ({
      ...previous,
      draft: previous.draft ? { ...previous.draft, ...patch } : null,
      error: null,
    }));
  }

  function cancelEdit() {
    setState(cancelWidgetEdit);
  }

  function changeSummary(patch: Partial<SummaryDraft>) {
    setState((previous) => ({
      ...previous,
      summary: { ...previous.summary, ...patch },
      error: null,
    }));
  }

  async function runMutation(
    action: (snapshot: WidgetManagementSnapshot) => Promise<unknown>,
    message: string,
    resetSummary = false,
  ) {
    const initialSnapshot = current.snapshot;
    if (
      !initialSnapshot ||
      pending.current ||
      !canMutateBoardWidgets(current, boardActive)
    )
      return;
    pending.current = true;
    const request = ++sequence.current;
    let submitted = false;
    setState((previous) => ({
      ...previous,
      pending: true,
      error: null,
      notice: null,
    }));
    try {
      await action(initialSnapshot);
      submitted = true;
      if (request !== sequence.current) return;
      const snapshot = await loadWidgetManagementSnapshot(boardId);
      if (request !== sequence.current) return;
      setState((previous) => ({
        ...previous,
        status: "ready",
        snapshot,
        draft: null,
        summary: resetSummary ? blankSummary : previous.summary,
        pending: false,
        conflict: false,
        error: null,
        notice: message,
      }));
      if (!snapshot.access.manage) {
        sourceSequence.current += 1;
        setSources({ ...emptySources, key: boardId });
      }
      changedRef.current?.();
    } catch (error: unknown) {
      if (request !== sequence.current) return;
      if (accessLost(error)) {
        sourceSequence.current += 1;
        setSources({ ...emptySources, key: boardId });
        setState(deniedWidgetManagerState(boardId));
        recheckBoardView(request);
      } else if (error instanceof ApiError && error.status === 409) {
        if (error.code === "board_archived") {
          setState((previous) => ({
            ...previous,
            archiveLocked: true,
            error:
              "This Board is archived. Widget changes are locked until it is restored.",
          }));
          void Promise.resolve()
            .then(() => boardRefreshRef.current())
            .catch(() => {
              setState((previous) =>
                previous.key === boardId
                  ? {
                      ...previous,
                      error:
                        "Board status could not be refreshed. Widget changes remain locked.",
                    }
                  : previous,
              );
            });
        }
        try {
          const snapshot = await loadWidgetManagementSnapshot(boardId);
          if (request !== sequence.current) return;
          if (!snapshot.access.manage) {
            sourceSequence.current += 1;
            setSources({ ...emptySources, key: boardId });
          }
          setState((previous) =>
            widgetManagerAfterConflict(previous, error, snapshot),
          );
        } catch (reloadError: unknown) {
          if (request !== sequence.current) return;
          if (accessLost(reloadError)) {
            sourceSequence.current += 1;
            setSources({ ...emptySources, key: boardId });
            setState(deniedWidgetManagerState(boardId));
            recheckBoardView(request);
          } else {
            setState((previous) => ({
              ...previous,
              status: "error",
              snapshot: null,
              pending: false,
              conflict: true,
              error:
                "Board changed, but the latest widgets could not be loaded. Your draft is retained; retry refresh.",
            }));
          }
        }
      } else if (error instanceof ApiContractError) {
        setState((previous) => ({
          ...previous,
          pending: false,
          conflict: true,
          error:
            "This widget changed. Cancel and reopen its settings before saving.",
        }));
      } else {
        setState((previous) => ({
          ...previous,
          status: "error",
          snapshot: null,
          pending: false,
          error: submitted
            ? "Widget changed, but the latest list could not be loaded. Retry refresh before editing again."
            : "Widget change could not be confirmed. Retry refresh before editing again.",
        }));
      }
    } finally {
      if (request === sequence.current) {
        pending.current = false;
        if (deferredReload.current && activeBoard.current === boardId) {
          deferredReload.current = false;
          setReloadKey((value) => value + 1);
        }
      }
    }
  }

  function createSummary() {
    if (
      !current.summary.name.trim() ||
      current.summary.name.trim().length > 80 ||
      !currentSources.items.some(
        (source) => source.id === current.summary.moduleId,
      )
    )
      return;
    void runMutation(
      (snapshot) =>
        createBoardWidget(
          boardId,
          snapshot.page.boardRevision,
          createSummaryWidgetInput(
            current.summary.name,
            current.summary.moduleId,
          ),
        ),
      "Summary widget created.",
      true,
    );
  }

  function saveSettings() {
    if (
      !current.draft ||
      !current.draft.name.trim() ||
      current.draft.name.trim().length > 80
    )
      return;
    const draft = current.draft;
    void runMutation(
      (snapshot) => saveWidgetDraft(boardId, snapshot.page, draft),
      "Widget settings saved.",
    );
  }

  function duplicate(widgetId: string) {
    void runMutation((snapshot) => {
      if (!snapshot.page.items.some((widget) => widget.id === widgetId))
        throw new ApiContractError();
      return duplicateBoardWidget(
        boardId,
        widgetId,
        snapshot.page.boardRevision,
      );
    }, "Widget duplicated.");
  }

  function move(widgetId: string, direction: -1 | 1) {
    void runMutation((snapshot) => {
      const ids = reorderVisibleWidgetIds(snapshot.page, widgetId, direction);
      if (!ids) throw new ApiContractError();
      return reorderBoardWidgets(boardId, snapshot.page.boardRevision, ids);
    }, "Widgets reordered.");
  }

  function remove(widgetId: string) {
    void runMutation((snapshot) => {
      if (!snapshot.page.items.some((widget) => widget.id === widgetId))
        throw new ApiContractError();
      return deleteBoardWidget(boardId, widgetId, snapshot.page.boardRevision);
    }, "Widget removed.");
  }

  async function loadMoreSources() {
    if (
      currentSources.status !== "ready" ||
      !currentSources.hasMore ||
      !current.snapshot?.access.manage ||
      !boardActive ||
      pending.current
    )
      return;
    const request = ++sourceSequence.current;
    setSources((previous) => ({ ...previous, status: "loading", error: null }));
    try {
      const page = await loadWidgetSourcePage(currentSources.items.length);
      if (request !== sourceSequence.current) return;
      if (
        page.items.some((item) =>
          currentSources.items.some((old) => old.id === item.id),
        )
      )
        throw new ApiContractError();
      setSources({
        key: boardId,
        status: "ready",
        items: [...currentSources.items, ...page.items],
        hasMore: page.pagination.hasMore,
        error: null,
      });
    } catch (error: unknown) {
      if (request !== sourceSequence.current) return;
      setSources((previous) => ({
        ...previous,
        status: "error",
        error: "Could not load more record sources. Retry refresh.",
      }));
      if (accessLost(error)) {
        const deniedRequest = ++sequence.current;
        pending.current = false;
        setSources({ ...emptySources, key: boardId });
        setState(deniedWidgetManagerState(boardId));
        recheckBoardView(deniedRequest);
      }
    }
  }

  return {
    state: current,
    sources: currentSources,
    reload,
    edit,
    changeDraft,
    cancelEdit,
    changeSummary,
    createSummary,
    saveSettings,
    duplicate,
    move,
    remove,
    loadMoreSources,
  };
}
