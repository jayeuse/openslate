"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { reportDone } from "@/lib/feedback";
import {
  lifecycleErrorMessage,
  type LifecyclePurgePreview,
} from "@/lib/lifecycle";
import {
  subscribeWorkspaceLifecycleSettings,
  workspaceLifecycleQueryOptions,
} from "../../manage/adapters/workspace-api";
import {
  archiveBoardEvent,
  listBoardEvents,
  previewBoardEventPurge,
  purgeBoardEvent,
  restoreBoardEvent,
  type BoardEvent,
  type BoardEventOccurrencePage,
  type BoardEventPage,
} from "../adapters/board-events-api";
import type { BoardMyAccess } from "../adapters/board-tools-api";
import type { CalendarShow } from "../domain/calendar-dates";
import {
  prepareBoardEventLifecycleAction,
  type BoardEventLifecycleAction,
} from "../components/server-backed-board-event-lifecycle";

/**
 * The board calendar's event lifecycle: its one owner. It holds the archived
 * list, Archive and Restore with their confirmation, and the admin's Delete
 * forever review, each with one pending guard. The calendar passes in the
 * viewer's access and the events read, and is told when access changed.
 */
export function useBoardEventLifecycle({
  boardId,
  viewerId,
  boardActive,
  refreshKey,
  liveKey,
  show,
  isPurgeAdmin,
  accessDenied,
  currentAccess,
  canManage,
  canBrowseArchived,
  calendarPage,
  hasDraft,
  selectedEventId,
  onArchivedSelected,
  invalidate,
  onAccessChanged,
  onAccessDenied,
}: {
  boardId: string;
  viewerId: string;
  boardActive: boolean;
  refreshKey: number;
  liveKey: number;
  show: CalendarShow;
  isPurgeAdmin: boolean;
  accessDenied: boolean;
  currentAccess: BoardMyAccess | null;
  canManage: boolean;
  canBrowseArchived: boolean;
  calendarPage: BoardEventOccurrencePage | null;
  /** An event draft is open; lifecycle actions wait for it. */
  hasDraft: boolean;
  selectedEventId: string | null;
  /** The open event was archived: close its sheet. */
  onArchivedSelected: () => void;
  invalidate: () => void;
  /** A change went through: read the viewer's access again. */
  onAccessChanged: () => void;
  /** A read or action was refused: close the editor, mark the board. */
  onAccessDenied: () => void;
}) {
  const queryClient = useQueryClient();
  const [archivedOffset, setArchivedOffset] = useState(0);
  const [archivedVersion, setArchivedVersion] = useState(0);
  const [archivedState, setArchivedState] = useState<{
    key: string;
    status: "loading" | "ready" | "error";
    page: BoardEventPage | null;
    error: string | null;
  } | null>(null);
  const archivedRequest = useRef(0);
  const lifecycleRequest = useRef(0);
  const lifecyclePendingRef = useRef(false);
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const [lifecycleTarget, setLifecycleTarget] =
    useState<BoardEventLifecycleAction | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const invalidateRef = useRef(invalidate);
  const latest = useRef({ onAccessDenied });
  useEffect(() => {
    invalidateRef.current = invalidate;
    latest.current = { onAccessDenied };
  });

  const archivedKey = `${boardId}:${liveKey}:${archivedOffset}:${archivedVersion}`;
  const archivedPage =
    canBrowseArchived &&
    archivedState?.key === archivedKey &&
    archivedState.status === "ready"
      ? archivedState.page
      : null;

  useEffect(() => {
    setArchivedOffset(0);
    setArchivedState(null);
    setLifecycleTarget(null);
    setLifecycleError(null);
    lifecycleRequest.current += 1;
    lifecyclePendingRef.current = false;
    setLifecyclePending(false);
  }, [boardId]);

  useEffect(() => {
    setLifecycleTarget(null);
  }, [refreshKey]);

  useEffect(() => {
    if (!canBrowseArchived) {
      setArchivedState(null);
      setLifecycleTarget(null);
    }
  }, [canBrowseArchived]);

  useEffect(() => {
    if (!boardActive) {
      setLifecycleTarget(null);
      if (!isPurgeAdmin) setArchivedState(null);
    }
  }, [boardActive, isPurgeAdmin]);

  useEffect(() => {
    if (show !== "archived" || !canBrowseArchived) return;
    const request = ++archivedRequest.current;
    setArchivedState({
      key: archivedKey,
      status: "loading",
      page: null,
      error: null,
    });
    void listBoardEvents(boardId, {
      archived: "archived",
      limit: 25,
      offset: archivedOffset,
      sortBy: "title",
      sortOrder: "asc",
    })
      .then((page) => {
        if (request !== archivedRequest.current) return;
        setArchivedState({
          key: archivedKey,
          status: "ready",
          page,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (request !== archivedRequest.current) return;
        const denied =
          error instanceof ApiError && [401, 403, 404].includes(error.status);
        setArchivedState({
          key: archivedKey,
          status: "error",
          page: null,
          error: denied
            ? "Archived events are unavailable. Ask a Board manager to check your access."
            : "Could not load archived events. Try again.",
        });
        if (denied) {
          setLifecycleTarget(null);
          latest.current.onAccessDenied();
          invalidateRef.current();
        }
      });
    return () => {
      archivedRequest.current += 1;
    };
  }, [archivedKey, archivedOffset, boardId, canBrowseArchived, show]);

  const lifecycleSettings = useQuery({
    ...workspaceLifecycleQueryOptions(),
    enabled: isPurgeAdmin && show === "archived" && canBrowseArchived,
  });
  const purgeEnabled =
    isPurgeAdmin &&
    canBrowseArchived &&
    lifecycleSettings.isSuccess &&
    lifecycleSettings.data.purge_enabled;
  const [purgeEvent, setPurgeEvent] = useState<BoardEvent | null>(null);
  const [purgePreview, setPurgePreview] =
    useState<LifecyclePurgePreview | null>(null);
  const [purgeName, setPurgeName] = useState("");
  const [purgePassword, setPurgePassword] = useState("");
  const [purgeError, setPurgeError] = useState("");
  const purgeRequest = useRef(0);
  useEffect(() => {
    if (isPurgeAdmin && show === "archived" && canBrowseArchived)
      return subscribeWorkspaceLifecycleSettings(queryClient);
  }, [isPurgeAdmin, show, canBrowseArchived, queryClient]);
  useEffect(() => {
    purgeRequest.current += 1;
    setPurgeEvent(null);
    setPurgePreview(null);
    setPurgeName("");
    setPurgePassword("");
    setPurgeError("");
    return () => {
      purgeRequest.current += 1;
    };
  }, [boardId, viewerId, refreshKey, purgeEnabled]);

  function mayPurge(event: BoardEvent) {
    return (
      purgeEnabled &&
      !lifecyclePendingRef.current &&
      !hasDraft &&
      event.archived &&
      event.boardId === boardId &&
      event.boardRevision === archivedPage?.boardRevision
    );
  }

  async function reviewEventPurge(event: BoardEvent) {
    if (!mayPurge(event)) return;
    const request = ++purgeRequest.current;
    const pendingOwner = ++lifecycleRequest.current;
    lifecyclePendingRef.current = true;
    setLifecyclePending(true);
    setPurgeEvent(event);
    setPurgePreview(null);
    setPurgeName("");
    setPurgePassword("");
    setPurgeError("");
    try {
      const preview = await previewBoardEventPurge(boardId, event.id);
      if (request === purgeRequest.current) setPurgePreview(preview);
    } catch (failure) {
      if (request === purgeRequest.current)
        setPurgeError(
          lifecycleErrorMessage(
            failure,
            "The event review could not be prepared. Request a new review.",
          ),
        );
    } finally {
      if (pendingOwner === lifecycleRequest.current) {
        lifecyclePendingRef.current = false;
        setLifecyclePending(false);
      }
    }
  }

  async function confirmEventPurge() {
    const event = purgeEvent,
      preview = purgePreview;
    if (
      !event ||
      !preview ||
      !mayPurge(event) ||
      preview.impact.blockers.length ||
      purgeName !== preview.confirmation_name ||
      !purgePassword ||
      !archivedPage?.items.some(
        (row) => row.id === event.id && row.revision === event.revision,
      )
    )
      return;
    const request = ++purgeRequest.current;
    const pendingOwner = ++lifecycleRequest.current;
    lifecyclePendingRef.current = true;
    setLifecyclePending(true);
    try {
      await purgeBoardEvent(boardId, event.id, {
        token: preview.token,
        confirmationName: purgeName,
        password: purgePassword,
      });
      if (request !== purgeRequest.current) return;
      setPurgeEvent(null);
      setPurgePreview(null);
      setPurgeName("");
      setPurgePassword("");
      reportDone("Event permanently deleted.");
      invalidate();
      setArchivedState(null);
      setArchivedVersion((value) => value + 1);
      onAccessChanged();
    } catch (failure) {
      if (request !== purgeRequest.current) return;
      setPurgeError(
        lifecycleErrorMessage(
          failure,
          "The event was not permanently deleted. Request a new review.",
        ),
      );
      setPurgePreview(null);
      setPurgeName("");
    } finally {
      if (pendingOwner === lifecycleRequest.current) {
        setPurgePassword("");
        lifecyclePendingRef.current = false;
        setLifecyclePending(false);
      }
    }
  }

  function closePurge() {
    purgeRequest.current += 1;
    setPurgeEvent(null);
    setPurgePreview(null);
    setPurgeName("");
    setPurgePassword("");
    setPurgeError("");
  }

  function beginLifecycle(kind: "archive" | "restore", event: BoardEvent) {
    if (lifecyclePendingRef.current || hasDraft) return;
    const page = kind === "archive" ? calendarPage : archivedPage;
    if (!page) return;
    const action = prepareBoardEventLifecycleAction(
      event,
      boardId,
      page.boardRevision,
      currentAccess,
      boardActive,
      kind,
      viewerId,
    );
    if (!action) return;
    setLifecycleError(null);
    setLifecycleTarget(action);
  }

  async function confirmLifecycle() {
    const action = lifecycleTarget;
    if (!action || lifecyclePendingRef.current) return;
    const page = action.kind === "archive" ? calendarPage : archivedPage;
    const listedEvent =
      action.kind === "archive"
        ? calendarPage?.items.find(
            (item) =>
              item.event.id === action.eventId &&
              item.event.revision === action.eventRevision &&
              !item.event.archived,
          )?.event
        : undefined;
    const listed =
      action.kind === "archive"
        ? listedEvent !== undefined
        : archivedPage?.items.some(
            (item) =>
              item.id === action.eventId &&
              item.revision === action.eventRevision,
          );
    const authorized =
      action.kind === "restore"
        ? canManage
        : boardActive &&
          !accessDenied &&
          (currentAccess?.manage === true ||
            (currentAccess?.edit === true &&
              listedEvent?.authorId === viewerId));
    if (
      action.boardId !== boardId ||
      !authorized ||
      !page ||
      page.boardRevision !== action.boardRevision ||
      !listed
    ) {
      setLifecycleTarget(null);
      setLifecycleError("Event details changed. Refresh before trying again.");
      return;
    }
    lifecyclePendingRef.current = true;
    setLifecyclePending(true);
    const request = ++lifecycleRequest.current;
    try {
      if (action.kind === "archive")
        await archiveBoardEvent(
          boardId,
          action.eventId,
          action.boardRevision,
          action.eventRevision,
        );
      else
        await restoreBoardEvent(
          boardId,
          action.eventId,
          action.boardRevision,
          action.eventRevision,
        );
      if (request !== lifecycleRequest.current) return;
      setLifecycleTarget(null);
      setLifecycleError(null);
      reportDone(
        action.kind === "archive" ? "Event archived." : "Event restored.",
      );
      if (action.kind === "archive" && selectedEventId === action.eventId)
        onArchivedSelected();
      invalidate();
      setArchivedState(null);
      setArchivedVersion((value) => value + 1);
      onAccessChanged();
    } catch (error) {
      if (request !== lifecycleRequest.current) return;
      setArchivedState(null);
      invalidate();
      setArchivedVersion((value) => value + 1);
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        setLifecycleTarget(null);
        onAccessDenied();
        setLifecycleError(
          "Your access changed. Event actions were closed and the calendar is refreshing.",
        );
      } else if (error instanceof ApiError && error.status === 409) {
        setLifecycleError(
          "The Board or event changed. Review refreshed events before trying again.",
        );
      } else {
        setLifecycleError(
          "Could not confirm the event action. Review refreshed events before trying again.",
        );
      }
    } finally {
      if (request === lifecycleRequest.current) {
        lifecyclePendingRef.current = false;
        setLifecyclePending(false);
      }
    }
  }

  function canArchiveEvent(event: BoardEvent): boolean {
    return (
      !hasDraft &&
      prepareBoardEventLifecycleAction(
        event,
        boardId,
        calendarPage?.boardRevision ?? 0,
        currentAccess,
        boardActive,
        "archive",
        viewerId,
      ) !== null
    );
  }

  function canConfirmLifecycle(action: BoardEventLifecycleAction | null) {
    if (!action || action.boardId !== boardId) return false;
    if (action.kind === "restore") return canManage;
    const listed = calendarPage?.items.find(
      (item) =>
        item.event.id === action.eventId &&
        item.event.revision === action.eventRevision &&
        !item.event.archived,
    );
    return (
      boardActive &&
      !accessDenied &&
      (currentAccess?.manage === true ||
        (currentAccess?.edit === true && listed?.event.authorId === viewerId))
    );
  }

  /** The board's access was refused: close the list and any confirmation. */
  function closeOnDenial() {
    setArchivedState(null);
    setLifecycleTarget(null);
  }

  return {
    archived: {
      key: archivedKey,
      state: archivedState,
      page: archivedPage,
      offset: archivedOffset,
      setOffset: setArchivedOffset,
      retry: () => setArchivedVersion((value) => value + 1),
    },
    pending: lifecyclePending,
    target: lifecycleTarget,
    error: lifecycleError,
    beginLifecycle,
    confirmLifecycle,
    cancelLifecycle: () => setLifecycleTarget(null),
    canArchiveEvent,
    canConfirmLifecycle,
    closeOnDenial,
    purge: {
      enabled: purgeEnabled,
      event: purgeEvent,
      preview: purgePreview,
      name: purgeName,
      password: purgePassword,
      error: purgeError,
      setName: setPurgeName,
      setPassword: setPurgePassword,
      mayPurge,
      review: reviewEventPurge,
      confirm: confirmEventPurge,
      close: closePurge,
    },
  };
}
