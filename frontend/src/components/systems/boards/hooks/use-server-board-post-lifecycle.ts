"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { toast } from "@/components/ui/toast";
import {
  archiveBoardPost,
  deleteBoardPost,
  restoreBoardPost,
  unpublishBoardPost,
  type BoardPost,
} from "../adapters/board-posts-api";
import {
  getBoardPostManageState,
  type BoardPostManageState,
} from "../adapters/board-post-manage-state-api";
import { getMyBoardAccess } from "../adapters/board-tools-api";

export type PostLifecycleAction = {
  kind: "unpublish" | "archive" | "restore" | "delete";
  boardId: string;
  postId: string;
  title: string;
  boardRevision: number;
  postRevision: number;
};

function isDenial(error: unknown): error is ApiError {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

/**
 * The words a failed post action shows. A conflict asks for a refresh; a
 * denial hides the post; anything else is a generic retry.
 */
export function postActionFailure(error: unknown): {
  message: string;
  denied: boolean;
  conflict: boolean;
} {
  if (isDenial(error))
    return {
      message: "This post is not available.",
      denied: true,
      conflict: false,
    };
  if (error instanceof ApiError && error.status === 409)
    return {
      message:
        "This post changed elsewhere. Refresh posts before trying again.",
      denied: false,
      conflict: true,
    };
  return {
    message: "Post request failed. Try again.",
    denied: false,
    conflict: false,
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

async function runAction(action: PostLifecycleAction): Promise<void> {
  const { boardId, postId, boardRevision, postRevision } = action;
  if (action.kind === "unpublish")
    await unpublishBoardPost(boardId, postId, boardRevision, postRevision);
  else if (action.kind === "archive")
    await archiveBoardPost(boardId, postId, boardRevision, postRevision);
  else if (action.kind === "restore")
    await restoreBoardPost(boardId, postId, boardRevision, postRevision);
  else {
    const deletion = await deleteBoardPost(
      boardId,
      postId,
      boardRevision,
      postRevision,
    );
    if (deletion.outcome !== "deleted") throw new ApiError(409, "Post changed");
  }
}

const DONE: Record<PostLifecycleAction["kind"], string> = {
  unpublish: "Post unpublished",
  archive: "Post archived",
  restore: "Post restored",
  delete: "Draft deleted",
};

/**
 * The reading pane's post actions (BR12, BR14): each reads the post's
 * current revisions first. Restore acts at once; Unpublish, Archive and
 * Delete draft wait for their confirmation. The result shows as a toast, with
 * Undo where the step can be reversed (the Four Moments Rule).
 */
export function useBoardPostActions({
  boardId,
  canManage,
  onChanged,
  onAccessDenied,
}: {
  boardId: string;
  canManage: boolean;
  /** After a change, or `null` after a conflict: refresh what shows. */
  onChanged: (action: PostLifecycleAction | null) => void;
  onAccessDenied?: (boardId: string) => void;
}) {
  const [pendingPostId, setPendingPostId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<PostLifecycleAction | null>(
    null,
  );
  const sequence = useRef(0);
  const scope = useRef(boardId);
  const latest = useRef({ onChanged, onAccessDenied, canManage });
  useEffect(() => {
    latest.current = { onChanged, onAccessDenied, canManage };
  });
  useEffect(() => {
    scope.current = boardId;
    sequence.current += 1;
    setPendingPostId(null);
    setConfirmation(null);
    return () => {
      sequence.current += 1;
    };
  }, [boardId]);

  function current(operation: number): boolean {
    return operation === sequence.current && scope.current === boardId;
  }

  function fail(operation: number, error: unknown) {
    if (!current(operation)) return;
    setPendingPostId(null);
    setConfirmation(null);
    const failure = postActionFailure(error);
    toast.add({ title: failure.message, type: "error" });
    // A conflict refreshes the list and the pane, so the next try is current.
    if (failure.conflict) latest.current.onChanged(null);
    if (failure.denied)
      void notifyIfBoardViewLost(boardId, (id) => {
        if (current(operation)) latest.current.onAccessDenied?.(id);
      });
  }

  /** Reads the post's revisions and returns the action they allow. */
  async function prepare(
    item: BoardPost,
    kind: PostLifecycleAction["kind"],
  ): Promise<PostLifecycleAction | "kept" | null> {
    const state = await getBoardPostManageState(boardId, item.id);
    const resolved = resolveDeleteKind(kind, state);
    if (resolved === null) return "kept";
    return prepareBoardPostLifecycleAction(
      { ...item, boardRevision: state.boardRevision },
      state,
      resolved,
    );
  }

  async function execute(action: PostLifecycleAction, operation: number) {
    try {
      await runAction(action);
      if (!current(operation)) return;
      setPendingPostId(null);
      setConfirmation(null);
      latest.current.onChanged(action);
      const undo: PostLifecycleAction["kind"] | null =
        action.kind === "restore"
          ? "archive"
          : action.kind === "archive" && latest.current.canManage
            ? "restore"
            : null;
      toast.add({
        title: DONE[action.kind],
        type: "success",
        action: undo
          ? {
              label: "Undo",
              onClick: () => void reverse(action, undo),
            }
          : undefined,
      });
    } catch (error) {
      fail(operation, error);
    }
  }

  /** Undo: the opposite step on the same post, without a second question. */
  async function reverse(
    done: PostLifecycleAction,
    kind: PostLifecycleAction["kind"],
  ) {
    if (scope.current !== done.boardId) return;
    const operation = ++sequence.current;
    setPendingPostId(done.postId);
    try {
      const state = await getBoardPostManageState(done.boardId, done.postId);
      if (!current(operation)) return;
      const action: PostLifecycleAction = {
        kind,
        boardId: done.boardId,
        postId: done.postId,
        title: done.title,
        boardRevision: state.boardRevision,
        postRevision: state.postRevision,
      };
      if (
        (kind === "archive" && state.status === "archived") ||
        (kind === "restore" && state.status !== "archived")
      )
        throw new ApiError(409, "Post changed");
      await runAction(action);
      if (!current(operation)) return;
      setPendingPostId(null);
      latest.current.onChanged(action);
      toast.add({ title: DONE[kind], type: "success" });
    } catch (error) {
      fail(operation, error);
    }
  }

  function begin(item: BoardPost, kind: PostLifecycleAction["kind"]) {
    if (pendingPostId !== null || item.boardId !== boardId) return;
    const operation = ++sequence.current;
    setPendingPostId(item.id);
    void (async () => {
      try {
        const action = await prepare(item, kind);
        if (!current(operation)) return;
        if (action === "kept") {
          setPendingPostId(null);
          toast.add({
            title: "This post was published, so it stays archived.",
            type: "info",
          });
          return;
        }
        if (action === null) throw new ApiError(409, "Post changed");
        if (action.kind === "restore") await execute(action, operation);
        else {
          setPendingPostId(null);
          setConfirmation(action);
        }
      } catch (error) {
        fail(operation, error);
      }
    })();
  }

  function confirm() {
    const action = confirmation;
    if (!action || pendingPostId !== null || action.boardId !== boardId) return;
    const operation = ++sequence.current;
    setPendingPostId(action.postId);
    void execute(action, operation);
  }

  function cancel() {
    if (pendingPostId !== null) return;
    setConfirmation(null);
  }

  return { pendingPostId, confirmation, begin, confirm, cancel };
}
