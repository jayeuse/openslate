"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";
import {
  archiveBoardPost,
  deleteBoardPost,
  listBoardPosts,
  restoreBoardPost,
  unpublishBoardPost,
  type BoardPost,
  type BoardPostView,
} from "../adapters/board-posts-api";
import {
  getBoardPostManageState,
  type BoardPostManageState,
} from "../adapters/board-post-manage-state-api";
import { getMyBoardAccess } from "../adapters/board-tools-api";
import type {
  PostLifecycleAction,
  PostLifecycleView,
} from "../components/server-backed-board-post-lifecycle";

type InternalState = PostLifecycleView & { key: string };

function emptyState(
  key: string,
  active: boolean,
  view: BoardPostView,
): InternalState {
  return {
    key,
    status: "loading",
    active,
    canManage: false,
    view,
    page: null,
    pending: false,
    conflict: false,
    error: null,
    notice: null,
    confirmation: null,
  };
}

function isDenial(error: unknown): error is ApiError {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

export function postLifecycleFailure(
  view: PostLifecycleView,
  error: unknown,
): PostLifecycleView {
  const safe = {
    ...view,
    canManage: false,
    page: null,
    pending: false,
    confirmation: null,
    notice: null,
  };
  if (isDenial(error))
    return { ...safe, status: "denied", conflict: false, error: null };
  if (error instanceof ApiError && error.status === 409)
    return {
      ...safe,
      status: "error",
      conflict: true,
      error: "This post changed elsewhere. Refresh posts before trying again.",
    };
  return {
    ...safe,
    status: "error",
    conflict: false,
    error: "Post request failed. Try again.",
  };
}

export async function notifyIfBoardViewLost(
  boardId: string,
  onAccessDenied?: (boardId: string) => void,
): Promise<boolean> {
  try {
    await getMyBoardAccess(boardId);
    return false;
  } catch (error) {
    if (!isDenial(error)) return false;
    onAccessDenied?.(boardId);
    return true;
  }
}

/**
 * Delete removes only a post that was never published. For a published post
 * it becomes archive, and an archived published post has nothing to do.
 */
export function resolveDeleteKind(
  kind: PostLifecycleAction["kind"],
  state: BoardPostManageState,
): PostLifecycleAction["kind"] | null {
  if (kind !== "delete" || !state.publishedBefore) return kind;
  return state.status === "archived" ? null : "archive";
}

export function prepareBoardPostLifecycleAction(
  item: BoardPost,
  state: BoardPostManageState,
  kind: PostLifecycleAction["kind"],
): PostLifecycleAction | null {
  if (
    item.id !== state.id ||
    item.boardRevision !== state.boardRevision ||
    (item.postRevision !== null && item.postRevision !== state.postRevision)
  )
    return null;
  if (kind === "unpublish") {
    if (
      item.status !== "published" ||
      item.publicationNumber === null ||
      !state.publishedBefore ||
      state.status === "archived"
    )
      return null;
  } else if (kind === "archive") {
    if (
      item.status === "archived" ||
      state.status === "archived" ||
      (item.status !== "published" && item.status !== state.status)
    )
      return null;
  } else if (kind === "restore") {
    if (item.status !== "archived" || state.status !== "archived") return null;
  } else if (state.publishedBefore || item.status !== state.status) {
    return null;
  }
  return {
    kind,
    boardId: item.boardId,
    postId: item.id,
    title: item.title,
    boardRevision: state.boardRevision,
    postRevision: state.postRevision,
  };
}

export function useServerBoardPostLifecycle({
  boardId,
  boardStatus,
  refreshKey,
  onChanged,
  onAccessDenied,
}: {
  boardId: string;
  boardStatus: "active" | "archived";
  refreshKey: number;
  onChanged?: (boardId: string) => void;
  onAccessDenied?: (boardId: string) => void;
}) {
  const actorId = useVerifiedWorkspaceUserId();
  const [selectedView, setSelectedView] = useState<BoardPostView>("published");
  const [offset, setOffset] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  const scope = `${boardId}:${actorId}:${boardStatus}:${selectedView}:${offset}`;
  const key = `${scope}:${retryKey}`;
  const active = boardStatus === "active";
  const [state, setState] = useState<InternalState>(() =>
    emptyState(key, active, selectedView),
  );
  const current =
    state.key === key ? state : emptyState(key, active, selectedView);
  const loadSequence = useRef(0);
  const mutationSequence = useRef(0);
  const operationPendingRef = useRef(false);
  const onAccessDeniedRef = useRef(onAccessDenied);

  useEffect(() => {
    onAccessDeniedRef.current = onAccessDenied;
  }, [onAccessDenied]);

  useEffect(() => {
    const request = ++loadSequence.current;
    mutationSequence.current += 1;
    operationPendingRef.current = false;
    if (!active) {
      setState({ ...emptyState(key, false, selectedView), status: "ready" });
      return () => {
        loadSequence.current += 1;
      };
    }
    setState((previous) => ({
      ...emptyState(key, true, selectedView),
      notice: previous.key.startsWith(`${scope}:`) ? previous.notice : null,
    }));
    void (async () => {
      try {
        const access = await getMyBoardAccess(boardId);
        if (request !== loadSequence.current) return;
        if (!access.manage) {
          setState({
            ...emptyState(key, true, selectedView),
            status: "denied",
          });
          return;
        }
        const page = await listBoardPosts(boardId, {
          view: selectedView,
          offset,
          limit: 25,
          sortBy: "updated_at",
          sortOrder: "desc",
        });
        if (request !== loadSequence.current) return;
        setState((previous) => ({
          ...emptyState(key, true, selectedView),
          status: "ready",
          canManage: true,
          page,
          notice: previous.key.startsWith(`${scope}:`) ? previous.notice : null,
        }));
      } catch (error) {
        if (request !== loadSequence.current) return;
        if (!isDenial(error)) {
          setState({
            ...emptyState(key, true, selectedView),
            status: "error",
            error: "Posts are unavailable. Try again.",
          });
          return;
        }
        setState({ ...emptyState(key, true, selectedView), status: "denied" });
        if (request === loadSequence.current)
          await notifyIfBoardViewLost(boardId, (id) => {
            if (request === loadSequence.current)
              onAccessDeniedRef.current?.(id);
          });
      }
    })();
    return () => {
      loadSequence.current += 1;
      mutationSequence.current += 1;
      operationPendingRef.current = false;
    };
  }, [active, boardId, key, offset, refreshKey, scope, selectedView]);

  async function clearOnDenied(
    scopeKey: string,
    operation: number,
    error: unknown,
  ): Promise<void> {
    if (operation !== mutationSequence.current) return;
    setState((previous) =>
      previous.key === scopeKey
        ? { ...previous, ...postLifecycleFailure(previous, error) }
        : previous,
    );
    await notifyIfBoardViewLost(boardId, (id) => {
      if (operation === mutationSequence.current)
        onAccessDeniedRef.current?.(id);
    });
  }

  function failAction(
    scopeKey: string,
    operation: number,
    error: unknown,
  ): void {
    if (operation !== mutationSequence.current) return;
    if (isDenial(error)) {
      void clearOnDenied(scopeKey, operation, error);
      return;
    }
    setState((previous) =>
      previous.key !== scopeKey
        ? previous
        : { ...previous, ...postLifecycleFailure(previous, error) },
    );
  }

  async function execute(
    action: PostLifecycleAction,
    operation: number,
  ): Promise<void> {
    try {
      if (action.kind === "unpublish")
        await unpublishBoardPost(
          action.boardId,
          action.postId,
          action.boardRevision,
          action.postRevision,
        );
      else if (action.kind === "archive")
        await archiveBoardPost(
          action.boardId,
          action.postId,
          action.boardRevision,
          action.postRevision,
        );
      else if (action.kind === "restore")
        await restoreBoardPost(
          action.boardId,
          action.postId,
          action.boardRevision,
          action.postRevision,
        );
      else {
        const deletion = await deleteBoardPost(
          action.boardId,
          action.postId,
          action.boardRevision,
          action.postRevision,
        );
        if (deletion.outcome !== "deleted")
          throw new ApiError(409, "Post changed");
      }
      if (operation !== mutationSequence.current) return;
      setState((previous) =>
        previous.key === key
          ? {
              ...emptyState(key, active, selectedView),
              notice:
                action.kind === "unpublish"
                  ? "Post unpublished."
                  : action.kind === "archive"
                    ? "Post archived."
                    : action.kind === "restore"
                      ? "Post restored."
                      : "Draft deleted.",
            }
          : previous,
      );
      setRetryKey((value) => value + 1);
      onChanged?.(boardId);
    } catch (error) {
      failAction(key, operation, error);
    } finally {
      if (operation === mutationSequence.current)
        operationPendingRef.current = false;
    }
  }

  function beginAction(
    item: BoardPost,
    kind: PostLifecycleAction["kind"],
  ): void {
    if (
      !active ||
      current.status !== "ready" ||
      !current.canManage ||
      current.conflict ||
      current.pending ||
      operationPendingRef.current ||
      !current.page?.items.some((row) => row.id === item.id && row === item)
    )
      return;
    const operation = ++mutationSequence.current;
    operationPendingRef.current = true;
    setState((previous) =>
      previous.key === key
        ? { ...previous, pending: true, error: null, notice: null }
        : previous,
    );
    void (async () => {
      try {
        const managerState = await getBoardPostManageState(boardId, item.id);
        if (operation !== mutationSequence.current) return;
        const resolved = resolveDeleteKind(kind, managerState);
        if (resolved === null) {
          setState((previous) =>
            previous.key === key
              ? {
                  ...previous,
                  pending: false,
                  notice:
                    "This post was published, so it keeps its edit history. It stays archived and cannot be deleted.",
                }
              : previous,
          );
          return;
        }
        const action = prepareBoardPostLifecycleAction(
          item,
          managerState,
          resolved,
        );
        if (action === null) {
          failAction(key, operation, new ApiError(409, "Post changed"));
          return;
        }
        if (resolved === "restore") {
          await execute(action, operation);
        } else {
          setState((previous) =>
            previous.key === key
              ? { ...previous, pending: false, confirmation: action }
              : previous,
          );
        }
      } catch (error) {
        failAction(key, operation, error);
      } finally {
        if (operation === mutationSequence.current)
          operationPendingRef.current = false;
      }
    })();
  }

  function confirm(): void {
    const action = current.confirmation;
    if (
      !action ||
      current.status !== "ready" ||
      current.conflict ||
      current.pending ||
      operationPendingRef.current ||
      action.boardId !== boardId ||
      action.kind === "restore"
    )
      return;
    const operation = ++mutationSequence.current;
    operationPendingRef.current = true;
    setState((previous) =>
      previous.key === key ? { ...previous, pending: true } : previous,
    );
    void execute(action, operation);
  }

  function cancelConfirmation(): void {
    if (current.pending) return;
    setState((previous) =>
      previous.key === key ? { ...previous, confirmation: null } : previous,
    );
  }

  function retry(): void {
    if (current.pending) return;
    setRetryKey((value) => value + 1);
  }

  function selectView(view: BoardPostView): void {
    if (current.pending || operationPendingRef.current || view === selectedView)
      return;
    setSelectedView(view);
    setOffset(0);
  }

  function selectPage(next: number): void {
    if (
      current.pending ||
      operationPendingRef.current ||
      current.status !== "ready" ||
      !current.page ||
      !Number.isInteger(next) ||
      next < 0 ||
      next % 25 !== 0 ||
      (next > offset && !current.page.pagination.hasMore)
    )
      return;
    setOffset(next);
  }

  return {
    view: current,
    selectView,
    selectPage,
    retry,
    beginAction,
    confirm,
    cancelConfirmation,
  };
}
