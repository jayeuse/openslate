"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authMeOptions } from "../../openview/adapters/openview-queries";
import { LifecyclePurgeReview } from "../../shared/lifecycle-purge-review";
import {
  lifecycleErrorMessage,
  type LifecyclePurgePreview,
} from "@/lib/lifecycle";
import {
  workspaceLifecycleQueryOptions,
  subscribeWorkspaceLifecycleSettings,
} from "../../manage/adapters/workspace-api";
import {
  previewBoardEventPurge,
  purgeBoardEvent,
} from "../adapters/board-events-api";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { reportDone } from "@/lib/feedback";
import { formatWorkspaceDate } from "@/lib/date-time";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "@/components/systems/shared/runtime/workspace-identity";
import {
  archiveBoardEvent,
  createBoardEvent,
  listBoardEvents,
  listMyBoardEvents,
  readBoardEvent,
  restoreBoardEvent,
  updateBoardEvent,
  type BoardEvent,
  type BoardEventPage,
} from "../adapters/board-events-api";
import type { BoardAttachmentVersions } from "../adapters/board-files-api";
import { readBoard } from "../adapters/board-management-api";
import type { WorkspaceCalendarSettings } from "../../manage/adapters/workspace-api";
import {
  getMyBoardAccess,
  type BoardMyAccess,
} from "../adapters/board-tools-api";
import {
  calendarWindowForMonth,
  shiftCalendarMonth,
  useServerBoardEvents,
} from "../hooks/use-server-board-events";
import { BoardEmpty } from "./ui";
import {
  BoardEventDraftError,
  boardEventDraftFromEvent,
  boardEventInputFromDraft,
  boardEventLinksChanged,
  newBoardEventDraft,
  prepareBoardEventConflictRetry,
  ServerBoardEventEditorForm,
  type BoardEventDraft,
  type BoardEventLatestVersion,
} from "./server-backed-board-event-editor";
import {
  prepareBoardEventLifecycleAction,
  ServerArchivedBoardEventsDisplay,
  type BoardEventLifecycleAction,
} from "./server-backed-board-event-lifecycle";
import {
  MonthGrid,
  MyEventsDisplay,
  ServerBoardCalendarDisplay,
  ServerBoardEventReaderContent,
  boardEventTimeLabel,
} from "./server-board-calendar-display";
export {
  ServerBoardCalendarDisplay,
  calendarDayCountLabel,
} from "./server-board-calendar-display";

type CalendarView = "month" | "agenda" | "archived" | "mine";
type MyEventsState = {
  key: string;
  status: "loading" | "ready" | "error";
  page: BoardEventPage | null;
  error: string | null;
};

function sameEventContent(left: BoardEvent, right: BoardEvent): boolean {
  return (
    left.id === right.id &&
    left.boardId === right.boardId &&
    left.authorId === right.authorId &&
    left.title === right.title &&
    left.details === right.details &&
    left.location === right.location &&
    JSON.stringify(left.links) === JSON.stringify(right.links) &&
    left.allDay === right.allDay &&
    left.startDate === right.startDate &&
    left.endDate === right.endDate &&
    left.startAt === right.startAt &&
    left.endAt === right.endAt &&
    left.timezoneName === right.timezoneName &&
    left.recurrence === right.recurrence &&
    left.repeatUntil === right.repeatUntil &&
    JSON.stringify(left.reminders) === JSON.stringify(right.reminders) &&
    left.archived === right.archived
  );
}

export function defaultCalendarViewForViewport(
  compact: boolean,
): "agenda" | "month" {
  return compact ? "agenda" : "month";
}

export function canEditBoardEvent(
  event: BoardEvent,
  boardId: string,
  viewerId: string,
  access: BoardMyAccess | null,
  boardActive: boolean,
): boolean {
  return (
    boardActive &&
    access?.edit === true &&
    !event.archived &&
    event.boardId === boardId &&
    (event.authorId === viewerId || access.manage)
  );
}

export function ServerBackedBoardCalendar({
  boardId,
  refreshKey,
  liveKey,
  workspaceCalendar,
  workspaceDateError,
  onRetryWorkspaceDate,
  boardActive = false,
  onDraftStateChange,
  selectedEventId = null,
  onCloseSelectedEvent,
}: {
  boardId: string;
  refreshKey: number;
  liveKey: number;
  workspaceCalendar: WorkspaceCalendarSettings | undefined;
  workspaceDateError: boolean;
  onRetryWorkspaceDate: () => void;
  boardActive?: boolean;
  selectedEventId?: string | null;
  onCloseSelectedEvent?: () => void;
  onDraftStateChange?: (
    boardId: string,
    dirty: boolean,
    pending: boolean,
  ) => void;
}) {
  const viewerId = useVerifiedWorkspaceUserId();
  const suspended = useWorkspaceInteractionSuspended();
  const queryClient = useQueryClient();
  const identityQuery = useQuery(authMeOptions());
  const isPurgeAdmin =
    identityQuery.isSuccess &&
    identityQuery.data.id === viewerId &&
    identityQuery.data.role === "admin" &&
    !suspended;
  const todayButton = useRef<HTMLButtonElement>(null);
  const [selectedRetry, setSelectedRetry] = useState(0);
  const selectedKey = `${viewerId}:${boardId}:${selectedEventId}:${refreshKey}:${selectedRetry}`;
  const [selectedDetail, setSelectedDetail] = useState<{
    key: string;
    event: BoardEvent | null;
    error: string | null;
  } | null>(null);
  const workspaceToday = workspaceCalendar?.today ?? null;
  const [month, setMonth] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [view, setView] = useState<CalendarView>("month");
  const [search, setSearch] = useState("");
  const [myEventsOffset, setMyEventsOffset] = useState(0);
  const [myEventsRetry, setMyEventsRetry] = useState(0);
  const [myEventsState, setMyEventsState] = useState<MyEventsState | null>(
    null,
  );
  const initializedBoard = useRef(boardId);
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
  const [access, setAccess] = useState<{
    key: string;
    status: "loading" | "ready" | "denied" | "error";
    value: BoardMyAccess | null;
  } | null>(null);
  const [accessVersion, setAccessVersion] = useState(0);
  const [blockedBoardId, setBlockedBoardId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BoardEventDraft | null>(null);
  const [draftBase, setDraftBase] = useState<BoardEvent | null>(null);
  const liveDraft = useRef<{
    draft: BoardEventDraft | null;
    base: BoardEvent | null;
  }>({ draft: null, base: null });
  const consumedLiveKey = useRef<string | null>(null);
  const liveDraftRequest = useRef(0);
  const [pending, setPending] = useState(false);
  const [attachmentPending, setAttachmentPending] = useState(false);
  const attachmentPendingRef = useRef(false);
  const [recordLinkPending, setRecordLinkPending] = useState(false);
  const recordLinkPendingRef = useRef(false);
  const pendingRef = useRef(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    eventId: string | null;
    status: "needs-check" | "checking" | "ready";
    latest: BoardEventLatestVersion | null;
  } | null>(null);
  const calendarMonth = month ?? workspaceToday?.slice(0, 7) ?? null;
  const calendarWindow = calendarMonth
    ? {
        ...calendarWindowForMonth(calendarMonth),
        label: workspaceCalendar
          ? formatWorkspaceDate(`${calendarMonth}-01`, workspaceCalendar, {
              month: "long",
              year: "numeric",
            })
          : "Date unavailable",
      }
    : null;
  const selectedCalendarDate =
    selectedDate ?? workspaceToday ?? calendarWindow?.start ?? "";
  const { state, retry, invalidate, loadMore, isLoadingMore, loadMoreError } =
    useServerBoardEvents(boardId, calendarWindow, liveKey, search);
  const invalidateRef = useRef(invalidate);
  const accessKey = `${boardId}:${refreshKey}:${boardActive}:${isPurgeAdmin}:${accessVersion}`;
  const currentAccess =
    access?.key === accessKey && access.status === "ready"
      ? access.value
      : null;
  const accessDenied = blockedBoardId === boardId;
  const currentSelectedDetail =
    selectedDetail?.key === selectedKey && !accessDenied
      ? selectedDetail
      : null;
  const selectedEvent = currentSelectedDetail?.event ?? null;
  const accessFailed = access?.key === accessKey && access.status === "error";
  const calendarPage = accessDenied ? null : state.data;
  const canEdit = boardActive && currentAccess?.edit === true;
  const canManage =
    boardActive && currentAccess?.manage === true && !accessDenied;
  const canBrowseArchived =
    !accessDenied &&
    currentAccess?.manage === true &&
    (boardActive || isPurgeAdmin);
  const archivedKey = `${boardId}:${liveKey}:${archivedOffset}:${archivedVersion}`;
  const archivedPage =
    canBrowseArchived &&
    archivedState?.key === archivedKey &&
    archivedState.status === "ready"
      ? archivedState.page
      : null;
  const activeDraft = canEdit && draft?.boardId === boardId ? draft : null;
  const myEventsKey = `${boardId}:${liveKey}:${myEventsOffset}:${myEventsRetry}`;

  useEffect(() => {
    liveDraft.current = { draft, base: draftBase };
  }, [draft, draftBase]);

  useEffect(() => {
    if (pending || attachmentPending || recordLinkPending) return;
    const signal = `${viewerId}:${boardId}:${liveKey}`;
    if (consumedLiveKey.current === signal) return;
    consumedLiveKey.current = signal;
    const selected = liveDraft.current.draft;
    if (
      !viewerId ||
      !boardActive ||
      !selected?.eventId ||
      selected.boardId !== boardId
    )
      return;
    const request = ++liveDraftRequest.current;
    void Promise.all([
      readBoardEvent(boardId, selected.eventId),
      readBoard(boardId),
    ])
      .then(([event, board]) => {
        const current = liveDraft.current;
        if (
          request !== liveDraftRequest.current ||
          !current.draft ||
          current.draft.eventId !== selected.eventId ||
          current.draft.eventRevision !== selected.eventRevision
        )
          return;
        if (
          event.id !== selected.eventId ||
          event.boardId !== boardId ||
          board.id !== boardId ||
          event.boardRevision !== board.revision
        ) {
          setEditorError(
            "Could not verify the latest event. Your draft is retained; try again.",
          );
          return;
        }
        if (event.revision < (current.draft.eventRevision ?? 0)) return;
        if (event.revision === current.draft.eventRevision) {
          setDraft((value) =>
            value?.eventId === event.id
              ? { ...value, boardRevision: board.revision }
              : value,
          );
          return;
        }
        const original = current.base && boardEventDraftFromEvent(current.base);
        const dirty =
          original === null ||
          JSON.stringify({
            ...current.draft,
            boardRevision: 0,
            eventRevision: 0,
          }) !==
            JSON.stringify({ ...original, boardRevision: 0, eventRevision: 0 });
        if (dirty || event.archived || board.status !== "active") {
          setConflict({
            eventId: event.id,
            status: "ready",
            latest: {
              boardId: board.id,
              boardRevision: board.revision,
              boardActive: board.status === "active",
              event,
            },
          });
        } else {
          setDraft(boardEventDraftFromEvent(event));
          setDraftBase(event);
          setConflict(null);
        }
      })
      .catch((failure: unknown) => {
        const current = liveDraft.current.draft;
        if (
          request !== liveDraftRequest.current ||
          current?.eventId !== selected.eventId ||
          current.eventRevision !== selected.eventRevision
        )
          return;
        if (
          failure instanceof ApiError &&
          [401, 403, 404].includes(failure.status)
        ) {
          setDraft(null);
          setDraftBase(null);
          setConflict(null);
          invalidateRef.current();
          setEditorError(
            "This event or Board is no longer available. The editor was closed.",
          );
        } else {
          setConflict({
            eventId: selected.eventId,
            status: "needs-check",
            latest: null,
          });
          setEditorError(
            "Could not check the latest version. Your draft is retained; try again.",
          );
        }
      });
    return () => {
      liveDraftRequest.current += 1;
    };
  }, [
    liveKey,
    boardId,
    viewerId,
    boardActive,
    pending,
    attachmentPending,
    recordLinkPending,
  ]);

  useEffect(() => {
    if (!viewerId || selectedEventId === null || accessDenied) {
      setSelectedDetail(null);
      return;
    }
    let active = true;
    void readBoardEvent(boardId, selectedEventId)
      .then((event) => {
        if (active) setSelectedDetail({ key: selectedKey, event, error: null });
      })
      .catch((error: unknown) => {
        if (active)
          setSelectedDetail({
            key: selectedKey,
            event: null,
            error:
              error instanceof ApiError &&
              [401, 403, 404].includes(error.status)
                ? "This event is unavailable or you no longer have access."
                : "Could not load the event. Try again.",
          });
      });
    return () => {
      active = false;
    };
  }, [accessDenied, boardId, selectedEventId, selectedKey, viewerId]);

  useEffect(() => {
    if (!workspaceToday) return;
    setMonth((current) => current ?? workspaceToday.slice(0, 7));
    setSelectedDate((current) => current ?? workspaceToday);
  }, [workspaceToday]);

  useEffect(() => {
    setView(
      defaultCalendarViewForViewport(
        globalThis.window.matchMedia("(max-width: 1023px)").matches,
      ),
    );
  }, []);

  useEffect(() => {
    if (initializedBoard.current === boardId) return;
    initializedBoard.current = boardId;
    setMonth(workspaceToday?.slice(0, 7) ?? null);
    setSelectedDate(workspaceToday);
    setView(
      defaultCalendarViewForViewport(
        globalThis.window.matchMedia("(max-width: 1023px)").matches,
      ),
    );
    setSearch("");
    setMyEventsOffset(0);
    setMyEventsState(null);
  }, [boardId, workspaceToday]);

  useEffect(() => {
    if (view !== "mine" || !canEdit) {
      setMyEventsState(null);
      return;
    }
    let active = true;
    setMyEventsState({
      key: myEventsKey,
      status: "loading",
      page: null,
      error: null,
    });
    void listMyBoardEvents(boardId, {
      limit: 25,
      offset: myEventsOffset,
      archived: "active",
    })
      .then((page) => {
        if (active)
          setMyEventsState({
            key: myEventsKey,
            status: "ready",
            page,
            error: null,
          });
      })
      .catch((error: unknown) => {
        if (active)
          setMyEventsState({
            key: myEventsKey,
            status: "error",
            page: null,
            error:
              error instanceof ApiError &&
              [401, 403, 404].includes(error.status)
                ? "My events are unavailable because Board access changed."
                : "Could not load your events. Try again.",
          });
      });
    return () => {
      active = false;
    };
  }, [boardId, canEdit, myEventsKey, myEventsOffset, view]);

  useEffect(() => {
    onDraftStateChange?.(
      boardId,
      draft !== null,
      pending || lifecyclePending || attachmentPending || recordLinkPending,
    );
  }, [
    attachmentPending,
    recordLinkPending,
    boardId,
    draft,
    lifecyclePending,
    onDraftStateChange,
    pending,
  ]);

  useEffect(
    () => () => onDraftStateChange?.(boardId, false, false),
    [boardId, onDraftStateChange],
  );

  useEffect(() => {
    invalidateRef.current = invalidate;
  }, [invalidate]);

  useEffect(() => {
    setDraft(null);
    setDraftBase(null);
    attachmentPendingRef.current = false;
    recordLinkPendingRef.current = false;
    setAttachmentPending(false);
    setRecordLinkPending(false);
    setEditorError(null);

    setConflict(null);
    setBlockedBoardId(null);
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
      setDraft(null);
      setEditorError(null);
      setConflict(null);
      setLifecycleTarget(null);
      if (!isPurgeAdmin) {
        setArchivedState(null);
        setView((current) => (current === "archived" ? "month" : current));
      }
    }
  }, [boardActive, isPurgeAdmin]);

  useEffect(() => {
    if (
      state.status === "error" &&
      state.error?.startsWith("Calendar unavailable.")
    ) {
      setDraft(null);
      setEditorError(null);
      setConflict(null);
    }
  }, [state.error, state.status]);

  useEffect(() => {
    if (!boardActive && !isPurgeAdmin) return;
    let active = true;
    setAccess({ key: accessKey, status: "loading", value: null });
    void getMyBoardAccess(boardId)
      .then((value) => {
        if (active) {
          setAccess({ key: accessKey, status: "ready", value });
          setBlockedBoardId(null);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        const denied =
          error instanceof ApiError && [401, 403, 404].includes(error.status);
        setAccess({
          key: accessKey,
          status: denied ? "denied" : "error",
          value: null,
        });
        if (denied) {
          setBlockedBoardId(boardId);
          setDraft(null);
          setEditorError(null);
          setConflict(null);
          setArchivedState(null);
          setLifecycleTarget(null);
          setEditorError("Event editing is unavailable for this Board.");
          invalidateRef.current();
        }
      });
    return () => {
      active = false;
    };
  }, [
    boardActive,
    isPurgeAdmin,
    boardId,
    refreshKey,
    accessVersion,
    accessKey,
  ]);

  useEffect(() => {
    if (view !== "archived" || !canBrowseArchived) return;
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
          setBlockedBoardId(boardId);
          setLifecycleTarget(null);
          setDraft(null);
          setConflict(null);
          setAccessVersion((value) => value + 1);
          invalidateRef.current();
        }
      });
    return () => {
      archivedRequest.current += 1;
    };
  }, [archivedKey, archivedOffset, boardId, canBrowseArchived, view]);

  const lifecycleSettings = useQuery({
    ...workspaceLifecycleQueryOptions(),
    enabled: isPurgeAdmin && view === "archived" && canBrowseArchived,
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
    if (isPurgeAdmin && view === "archived" && canBrowseArchived)
      return subscribeWorkspaceLifecycleSettings(queryClient);
  }, [isPurgeAdmin, view, canBrowseArchived, queryClient]);
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
      !activeDraft &&
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
      setAccessVersion((value) => value + 1);
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

  function beginLifecycle(kind: "archive" | "restore", event: BoardEvent) {
    if (lifecyclePendingRef.current || activeDraft) return;
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
      invalidate();
      setArchivedState(null);
      setArchivedVersion((value) => value + 1);
      setAccessVersion((value) => value + 1);
    } catch (error) {
      if (request !== lifecycleRequest.current) return;
      setArchivedState(null);
      invalidate();
      setArchivedVersion((value) => value + 1);
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        setLifecycleTarget(null);
        setAccessVersion((value) => value + 1);
        setBlockedBoardId(boardId);
        setDraft(null);
        setConflict(null);
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

  function mayEditEvent(event: BoardEvent): boolean {
    return canEditBoardEvent(
      event,
      boardId,
      viewerId,
      currentAccess,
      boardActive,
    );
  }

  async function saveEvent(draftToSave: BoardEventDraft | null = activeDraft) {
    if (
      !draftToSave ||
      pendingRef.current ||
      attachmentPendingRef.current ||
      recordLinkPendingRef.current ||
      draftToSave.boardId !== boardId
    )
      return;
    pendingRef.current = true;
    setPending(true);
    setEditorError(null);
    try {
      const input = boardEventInputFromDraft(draftToSave);
      if (draftToSave.eventId !== null && "eventRevision" in input)
        await updateBoardEvent(boardId, draftToSave.eventId, input);
      else if (draftToSave.eventId === null && !("eventRevision" in input))
        await createBoardEvent(boardId, input);
      else throw new Error("Event editor state is invalid.");
      setDraft(null);
      setConflict(null);
      reportDone(draftToSave.eventId ? "Event saved." : "Event created.");
      retry();
      setMyEventsRetry((value) => value + 1);
      setAccessVersion((value) => value + 1);
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        setBlockedBoardId(boardId);
        setDraft(null);
        setConflict(null);
        setEditorError("Your access changed. The event editor was closed.");
        setAccess({ key: accessKey, status: "denied", value: null });
        setAccessVersion((value) => value + 1);
        invalidate();
      } else {
        if (error instanceof ApiError && error.status === 409)
          setConflict({
            eventId: draftToSave.eventId,
            status: "needs-check",
            latest: null,
          });
        setEditorError(
          error instanceof ApiError && error.status === 409
            ? `${apiErrorMessage(error, "Could not save the event.")} Your draft is retained. Check the latest version before choosing how to continue.`
            : error instanceof ApiError && error.status === 422
              ? `${apiErrorMessage(error, "Could not save the event.")} Your draft is retained; check the fields and try again.`
              : error instanceof BoardEventDraftError
                ? error.message
                : "Could not save the event. Your draft is still here; try again.",
        );
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function refreshEventAttachmentVersions(): Promise<BoardAttachmentVersions> {
    const selected = activeDraft;
    if (!selected?.eventId)
      throw new ApiError(409, "Save the event before attaching files.");
    try {
      const [latestEvent, latestBoard] = await Promise.all([
        readBoardEvent(boardId, selected.eventId),
        readBoard(boardId),
      ]);
      const baseline =
        calendarPage?.items.find((item) => item.event.id === selected.eventId)
          ?.event ?? null;
      const latest: BoardEventLatestVersion = {
        boardId: latestBoard.id,
        boardRevision: latestBoard.revision,
        boardActive: latestBoard.status === "active",
        event: latestEvent,
      };
      if (
        latestBoard.id !== boardId ||
        latestEvent.id !== selected.eventId ||
        latestEvent.boardId !== boardId ||
        latestEvent.boardRevision !== latestBoard.revision ||
        !baseline ||
        !sameEventContent(baseline, latestEvent)
      ) {
        setConflict({
          eventId: selected.eventId,
          status: "ready",
          latest,
        });
        setEditorError(
          "The saved event changed while you were editing. Your draft is retained; review the latest version before continuing.",
        );
        throw new ApiError(
          409,
          "Event content changed; review the latest version.",
        );
      }
      const versions = {
        boardRevision: latestBoard.revision,
        contentRevision: latestEvent.revision,
      };
      setDraft((current) =>
        current?.eventId === selected.eventId
          ? {
              ...current,
              boardRevision: versions.boardRevision,
              eventRevision: versions.contentRevision,
            }
          : current,
      );
      retry();
      return versions;
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        setBlockedBoardId(boardId);
        setDraft(null);
        setConflict(null);
        setEditorError("Your access changed. The event editor was closed.");
        setAccess({ key: accessKey, status: "denied", value: null });
        invalidate();
      }
      throw error;
    }
  }

  function changeAttachmentPending(value: boolean) {
    attachmentPendingRef.current = value;
    setAttachmentPending(value);
  }

  function changeRecordLinkPending(value: boolean) {
    recordLinkPendingRef.current = value;
    setRecordLinkPending(value);
  }

  async function checkLatestVersion() {
    if (
      !activeDraft ||
      !conflict ||
      pendingRef.current ||
      conflict.eventId !== activeDraft.eventId
    )
      return;
    pendingRef.current = true;
    setPending(true);
    setEditorError(null);
    setConflict({ ...conflict, status: "checking", latest: null });
    try {
      const latestEvent = activeDraft.eventId
        ? await readBoardEvent(boardId, activeDraft.eventId)
        : null;
      const latestBoard = await readBoard(boardId);
      const latest: BoardEventLatestVersion = {
        boardId: latestBoard.id,
        boardRevision: latestBoard.revision,
        boardActive: latestBoard.status === "active",
        event: latestEvent,
      };
      setConflict({ eventId: activeDraft.eventId, status: "ready", latest });
      setEditorError(
        !latest.boardActive
          ? "This Board is archived. Keep a copy of your draft and ask a Board manager to restore it."
          : latest.event?.archived
            ? "This event is archived. Keep a copy of your draft and ask a Board manager to restore it."
            : null,
      );
      retry();
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        setDraft(null);
        setConflict(null);
        setEditorError(
          "This event or Board is no longer available. The editor was closed.",
        );
        invalidate();
      } else {
        setConflict({
          eventId: activeDraft.eventId,
          status: "needs-check",
          latest: null,
        });
        setEditorError(
          "Could not check the latest version. Your draft is retained; try again.",
        );
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  function loadLatestEvent() {
    if (!activeDraft || !conflict?.latest?.event || pendingRef.current) return;
    const latest = conflict.latest;
    const event = latest.event;
    if (!event) return;
    if (
      event.id !== activeDraft.eventId ||
      !latest.boardActive ||
      event.archived
    )
      return;
    setDraft({
      ...boardEventDraftFromEvent(event),
      boardRevision: latest.boardRevision,
    });
    setDraftBase(event);
    setConflict(null);
    setEditorError(null);
  }

  function retryWithLatestVersion() {
    if (!activeDraft || !conflict?.latest || pendingRef.current) return;
    try {
      const updated = prepareBoardEventConflictRetry(
        activeDraft,
        conflict.latest,
      );
      setDraft(updated);
      setConflict(null);
      setEditorError(null);
      void saveEvent(updated);
    } catch (error) {
      setEditorError(
        error instanceof BoardEventDraftError
          ? error.message
          : "The latest event cannot be used. Your draft is retained.",
      );
    }
  }

  function moveMonth(amount: number) {
    if (!calendarMonth) return;
    const next = shiftCalendarMonth(calendarMonth, amount);
    setMonth(next);
    setSelectedDate(`${next}-01`);
  }

  function editEvent(event: BoardEvent) {
    if (!mayEditEvent(event)) return;
    setEditorError(null);

    setConflict(null);
    setDraft(boardEventDraftFromEvent(event));
    setDraftBase(event);
  }

  function canArchiveEvent(event: BoardEvent): boolean {
    return (
      !activeDraft &&
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

  function displayCalendarEvents(date?: string, compact = false) {
    if (!calendarPage || !calendarWindow) return null;
    return (
      <ServerBoardCalendarDisplay
        region={workspaceCalendar}
        page={calendarPage}
        window={calendarWindow}
        date={date}
        compact={compact}
        includeAttachments
        canEditEvent={mayEditEvent}
        onEditEvent={editEvent}
        canArchiveEvent={canArchiveEvent}
        onArchiveEvent={(event) => beginLifecycle("archive", event)}
      />
    );
  }

  return (
    <section
      aria-label="Board calendar"
      className="flex min-w-0 flex-col gap-4"
    >
      {viewerId && selectedEventId !== null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) onCloseSelectedEvent?.();
          }}
        >
          <DialogContent
            className="max-w-3xl p-5 sm:p-7"
            finalFocus={todayButton}
          >
            <DialogHeader>
              <DialogTitle className="pr-10 text-xl leading-snug break-words">
                {selectedEvent?.title ??
                  (currentSelectedDetail?.error || accessDenied
                    ? "Event unavailable"
                    : "Opening event")}
              </DialogTitle>
              <DialogDescription>
                {selectedEvent
                  ? boardEventTimeLabel(selectedEvent, workspaceCalendar)
                  : accessDenied
                    ? "This event is unavailable or you no longer have access."
                    : (currentSelectedDetail?.error ?? "Loading the event.")}
              </DialogDescription>
            </DialogHeader>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute top-3 right-3 size-11"
              onClick={onCloseSelectedEvent}
              aria-label="Close event"
            >
              <X aria-hidden="true" />
            </Button>
            {selectedEvent ? (
              <ServerBoardEventReaderContent
                key={selectedKey}
                event={selectedEvent}
              />
            ) : currentSelectedDetail?.error && !accessDenied ? (
              <Button
                type="button"
                variant="outline"
                className="mt-5 min-h-11"
                onClick={() => setSelectedRetry((current) => current + 1)}
              >
                Retry
              </Button>
            ) : null}
          </DialogContent>
        </Dialog>
      )}
      <header className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h2
              data-slot="section-title"
              className="text-2xl font-semibold tracking-tight"
            >
              Calendar
            </h2>
            <p className="text-muted-foreground">
              Events for everyone who can read this Board.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(canBrowseArchived || canEdit) && !activeDraft && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      aria-label="Event lists"
                    />
                  }
                >
                  Event lists
                  <ChevronDown aria-hidden="true" data-icon="inline-end" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canEdit && (
                    <DropdownMenuItem
                      className="min-h-11"
                      onClick={() => {
                        setMyEventsOffset(0);
                        setMyEventsState(null);
                        setMyEventsRetry((value) => value + 1);
                        setView("mine");
                      }}
                    >
                      My events
                    </DropdownMenuItem>
                  )}
                  {canBrowseArchived && (
                    <DropdownMenuItem
                      className="min-h-11"
                      onClick={() => {
                        setArchivedState(null);
                        setView("archived");
                      }}
                    >
                      Archived events
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {view !== "archived" && canEdit && calendarPage && !activeDraft && (
              <Button
                type="button"
                className="min-h-11"
                onClick={() => {
                  setEditorError(null);

                  setConflict(null);
                  setDraft(
                    newBoardEventDraft(
                      boardId,
                      calendarPage.boardRevision,
                      selectedCalendarDate,
                    ),
                  );
                }}
              >
                <Plus data-icon="inline-start" /> New event
              </Button>
            )}
          </div>
        </div>
        {workspaceDateError && (
          <Alert variant="destructive">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {workspaceToday
                  ? "The Workspace date could not be refreshed. The last loaded date is still in use."
                  : "Could not load the Workspace date."}
              </span>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={onRetryWorkspaceDate}
              >
                Retry Workspace date
              </Button>
            </div>
          </Alert>
        )}
        {!calendarWindow && !workspaceDateError && (
          <p role="status" className="text-muted-foreground">
            Loading the Workspace date…
          </p>
        )}
      </header>
      {view !== "archived" && view !== "mine" && calendarWindow && (
        <label className="grid min-w-0 gap-1 text-sm font-medium">
          <span>Search events</span>
          <span className="relative block min-w-0">
            <Search
              aria-hidden="true"
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            />
            <Input
              type="search"
              className="bg-background text-foreground min-h-11 min-w-0 rounded-md py-2 pr-3 pl-10 font-normal"
              maxLength={100}
              value={search}
              disabled={activeDraft !== null}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          </span>
        </label>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11"
            disabled={!calendarMonth}
            aria-label="Previous month"
            onClick={() => moveMonth(-1)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <h2
            data-slot="section-title"
            className="min-w-32 text-center text-lg font-semibold"
            aria-live="polite"
          >
            {calendarWindow?.label ?? "Calendar"}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11"
            disabled={!calendarMonth}
            aria-label="Next month"
            onClick={() => moveMonth(1)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            className="ml-2 min-h-11"
            ref={todayButton}
            disabled={workspaceToday === null}
            onClick={() => {
              if (!workspaceToday) return;
              setMonth(workspaceToday.slice(0, 7));
              setSelectedDate(workspaceToday);
            }}
          >
            Today
          </Button>
        </div>
        <div role="group" aria-label="Calendar view" className="flex gap-1">
          <Button
            type="button"
            variant={view === "agenda" ? "secondary" : "ghost"}
            className="min-h-11"
            aria-pressed={view === "agenda"}
            onClick={() => setView("agenda")}
          >
            Agenda
          </Button>
          <Button
            type="button"
            variant={view === "month" ? "secondary" : "ghost"}
            className="min-h-11"
            aria-pressed={view === "month"}
            onClick={() => setView("month")}
          >
            Month
          </Button>
        </div>
      </div>
      {editorError && !activeDraft && (
        <Alert variant="destructive">{editorError}</Alert>
      )}
      {lifecycleError && !lifecycleTarget && (
        <Alert variant="destructive">{lifecycleError}</Alert>
      )}
      {accessFailed && (
        <Alert variant="destructive">
          Could not check edit access. Your unsaved draft is retained.
          <Button
            type="button"
            variant="outline"
            className="ml-2 min-h-11"
            onClick={() => setAccessVersion((value) => value + 1)}
          >
            Retry access
          </Button>
        </Alert>
      )}
      {activeDraft && (
        <ServerBoardEventEditorForm
          draft={activeDraft}
          busy={pending || attachmentPending || recordLinkPending}
          saveBlocked={conflict !== null}
          error={editorError}
          onChange={(patch) =>
            setDraft((current) => (current ? { ...current, ...patch } : null))
          }
          onCancel={() => {
            setDraft(null);
            setEditorError(null);
            setConflict(null);
          }}
          onSave={() => {
            void saveEvent();
          }}
          onAttachmentBusyChange={changeAttachmentPending}
          onRecordLinkBusyChange={changeRecordLinkPending}
          refreshAttachmentVersions={refreshEventAttachmentVersions}
        />
      )}
      {activeDraft && conflict && (
        <Alert variant="destructive">
          <div className="flex min-w-0 flex-col gap-3">
            <p className="font-medium">
              Changed by someone else — review latest
            </p>
            {conflict.status === "needs-check" && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 self-start"
                onClick={() => {
                  void checkLatestVersion();
                }}
              >
                Check latest version
              </Button>
            )}
            {conflict.status === "checking" && (
              <p role="status">Checking the latest version…</p>
            )}
            {conflict.status === "ready" && conflict.latest && (
              <>
                <p className="text-sm">
                  Current Board revision {conflict.latest.boardRevision}.
                  {conflict.latest.event
                    ? ` Current event revision ${conflict.latest.event.revision}.`
                    : " No existing event will be replaced."}
                </p>
                {conflict.latest.event && (
                  <details className="border-border rounded-md border p-3 text-sm">
                    <summary className="min-h-11 cursor-pointer py-2 font-medium">
                      Review the latest saved event
                    </summary>
                    <dl className="mt-2 grid gap-2 break-words">
                      <div>
                        <dt className="font-medium">Title</dt>
                        <dd>{conflict.latest.event.title}</dd>
                      </div>
                      <div>
                        <dt className="font-medium">Details</dt>
                        <dd className="whitespace-pre-wrap">
                          {conflict.latest.event.details || "None"}
                        </dd>
                      </div>
                      <div>
                        <dt className="font-medium">Location</dt>
                        <dd>{conflict.latest.event.location || "None"}</dd>
                      </div>
                      <div>
                        <dt className="font-medium">When</dt>
                        <dd>
                          {conflict.latest.event.allDay
                            ? `${conflict.latest.event.startDate}–${conflict.latest.event.endDate} · All day`
                            : `${conflict.latest.event.startAt}–${conflict.latest.event.endAt} UTC · ${conflict.latest.event.timezoneName}`}
                        </dd>
                      </div>
                      <div>
                        <dt className="font-medium">Repeats</dt>
                        <dd>
                          {conflict.latest.event.recurrence}
                          {conflict.latest.event.repeatUntil
                            ? ` until ${conflict.latest.event.repeatUntil}`
                            : ""}
                        </dd>
                      </div>
                      <div>
                        <dt className="font-medium">Reminders</dt>
                        <dd>
                          {conflict.latest.event.reminders.length > 0
                            ? conflict.latest.event.reminders.length
                            : "None"}
                        </dd>
                      </div>
                      <div>
                        <dt className="font-medium">Links</dt>
                        <dd>
                          {conflict.latest.event.links.length} in the latest
                          event.{" "}
                          {boardEventLinksChanged(activeDraft)
                            ? "Your edited links will replace them if you retry."
                            : "You did not edit links; the latest links will be kept."}
                        </dd>
                      </div>
                    </dl>
                  </details>
                )}
                {conflict.latest.boardActive &&
                  !conflict.latest.event?.archived && (
                    <div className="flex flex-wrap gap-2">
                      {conflict.latest.event && (
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          onClick={loadLatestEvent}
                        >
                          Load latest event and discard my draft
                        </Button>
                      )}
                      <Button
                        type="button"
                        className="min-h-11"
                        onClick={retryWithLatestVersion}
                      >
                        {conflict.latest.event
                          ? "Replace latest editable fields with my draft"
                          : "Use latest Board version and create event"}
                      </Button>
                    </div>
                  )}
                {conflict.latest.event &&
                  conflict.latest.boardActive &&
                  !conflict.latest.event.archived && (
                    <p className="text-muted-foreground text-sm">
                      Replacing uses your draft’s title, details, location,
                      schedule, and recurrence. Reminders change only if you
                      changed them.{" "}
                      {boardEventLinksChanged(activeDraft)
                        ? "Your edited links will replace the latest links."
                        : "The latest links will be kept."}
                    </p>
                  )}
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 self-start"
                  onClick={() => {
                    void checkLatestVersion();
                  }}
                >
                  Check again
                </Button>
              </>
            )}
          </div>
        </Alert>
      )}
      {view === "mine" &&
        canEdit &&
        !activeDraft &&
        myEventsState?.key === myEventsKey &&
        myEventsState.status === "loading" && (
          <p role="status" className="text-muted-foreground py-8 text-sm">
            Loading your events…
          </p>
        )}
      {view === "mine" &&
        canEdit &&
        !activeDraft &&
        myEventsState?.key === myEventsKey &&
        myEventsState.error && (
          <Alert variant="destructive">
            {myEventsState.error}
            <Button
              type="button"
              variant="outline"
              className="ml-2 min-h-11"
              onClick={() => setMyEventsRetry((value) => value + 1)}
            >
              Retry My events
            </Button>
          </Alert>
        )}
      {view === "mine" &&
        canEdit &&
        !activeDraft &&
        myEventsState?.key === myEventsKey &&
        myEventsState.page && (
          <MyEventsDisplay
            region={workspaceCalendar}
            page={myEventsState.page}
            onEdit={(event) => {
              if (!mayEditEvent(event)) return;
              setEditorError(null);

              setConflict(null);
              setDraft(boardEventDraftFromEvent(event));
              setDraftBase(event);
            }}
            onPrevious={() =>
              setMyEventsOffset((value) => Math.max(0, value - 25))
            }
            onNext={() => setMyEventsOffset((value) => value + 25)}
          />
        )}
      {view !== "archived" && view !== "mine" && state.error && (
        <Alert variant="destructive">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {state.data ? "Showing the last loaded month. " : ""}
              {state.error}
            </span>
            <Button variant="outline" className="min-h-11" onClick={retry}>
              <RefreshCw data-icon="inline-start" /> Retry
            </Button>
          </div>
        </Alert>
      )}
      {view !== "archived" &&
        view !== "mine" &&
        calendarPage &&
        calendarWindow && (
          <>
            {calendarPage.pagination.hasMore && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Alert variant="warning">
                  Showing {calendarPage.items.length} of{" "}
                  {calendarPage.pagination.total} occurrences. Load the next
                  page to include more events.
                </Alert>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={isLoadingMore}
                  onClick={() => void loadMore()}
                >
                  {isLoadingMore
                    ? "Loading next 100 events…"
                    : "Load next 100 events"}
                </Button>
              </div>
            )}
            {loadMoreError && (
              <Alert variant="destructive">
                {loadMoreError}{" "}
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={isLoadingMore}
                  onClick={() => void loadMore()}
                >
                  Retry next 100 events
                </Button>
              </Alert>
            )}
            <p
              className="text-muted-foreground text-sm"
              role="status"
              aria-live="polite"
            >
              {calendarPage.items.length}{" "}
              {calendarPage.items.length === 1 ? "occurrence" : "occurrences"}
              {state.status === "loading" ? " · Refreshing…" : ""}
            </p>
            <div
              className={
                view === "month"
                  ? "grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] xl:items-start"
                  : "min-w-0 space-y-4"
              }
            >
              <div className="min-w-0">
                {view === "month" ? (
                  workspaceCalendar ? (
                    <MonthGrid
                      region={workspaceCalendar}
                      window={calendarWindow}
                      page={calendarPage}
                      selectedDate={selectedCalendarDate}
                      today={workspaceToday}
                      weekStart={workspaceCalendar.week_start}
                      onSelect={setSelectedDate}
                    />
                  ) : null
                ) : (
                  <div id="server-board-calendar-day">
                    {displayCalendarEvents()}
                  </div>
                )}
              </div>
              {view === "month" && (
                <aside aria-label="Selected day" className="min-w-0 space-y-4">
                  <div id="server-board-calendar-day">
                    {displayCalendarEvents(selectedCalendarDate, true)}
                  </div>
                </aside>
              )}
            </div>
          </>
        )}
      {view === "archived" && canBrowseArchived && archivedPage && (
        <>
          <p className="text-muted-foreground text-sm" role="status">
            {archivedPage.pagination.total} archived events · Showing{" "}
            {archivedPage.items.length === 0 ? 0 : archivedOffset + 1}–
            {archivedOffset + archivedPage.items.length}
          </p>
          <ServerArchivedBoardEventsDisplay
            page={archivedPage}
            canRestoreEvent={(event) =>
              prepareBoardEventLifecycleAction(
                event,
                boardId,
                archivedPage.boardRevision,
                currentAccess,
                boardActive,
                "restore",
              ) !== null
            }
            onRestoreEvent={(event) => beginLifecycle("restore", event)}
            canPurgeEvent={mayPurge}
            onPurgeEvent={(event) => void reviewEventPurge(event)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={archivedOffset === 0}
              onClick={() =>
                setArchivedOffset((current) => Math.max(0, current - 25))
              }
            >
              Previous archived events
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={!archivedPage.pagination.hasMore}
              onClick={() => setArchivedOffset((current) => current + 25)}
            >
              Next archived events
            </Button>
          </div>
        </>
      )}
      {view === "archived" &&
        canBrowseArchived &&
        archivedState?.key === archivedKey &&
        archivedState.status === "loading" && (
          <p role="status" className="text-muted-foreground py-8 text-sm">
            Loading archived events…
          </p>
        )}
      {view === "archived" &&
        canBrowseArchived &&
        archivedState?.key === archivedKey &&
        archivedState.error && (
          <Alert variant="destructive">
            {archivedState.error}
            <Button
              type="button"
              variant="outline"
              className="ml-2 min-h-11"
              onClick={() => setArchivedVersion((value) => value + 1)}
            >
              Retry archived events
            </Button>
          </Alert>
        )}
      {view === "archived" && !canBrowseArchived && !accessDenied && (
        <p role="status" className="text-muted-foreground py-8 text-sm">
          {currentAccess
            ? "Archived events require Board manager access."
            : "Checking Board manager access…"}
        </p>
      )}
      {view !== "archived" &&
        view !== "mine" &&
        calendarWindow &&
        !calendarPage &&
        !accessDenied &&
        state.status === "loading" && (
          <p role="status" className="text-muted-foreground py-8 text-sm">
            Loading this month’s events…
          </p>
        )}
      {!calendarPage &&
        (accessDenied ||
          (view !== "archived" &&
            view !== "mine" &&
            state.status === "error")) && (
          <BoardEmpty
            title="Calendar unavailable"
            description="No events are shown. Retry or ask a Board manager to check your access."
          />
        )}
      <Dialog
        open={
          purgeEvent !== null && purgeEvent.boardId === boardId && purgeEnabled
        }
        dismissible={!lifecyclePending}
        onOpenChange={(open) => {
          if (!open && !lifecyclePendingRef.current) {
            purgeRequest.current += 1;
            setPurgeEvent(null);
            setPurgePreview(null);
            setPurgeName("");
            setPurgePassword("");
            setPurgeError("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permanently delete event?</DialogTitle>
            <DialogDescription>
              This permanently removes the archived event and its occurrences.
            </DialogDescription>
          </DialogHeader>
          {lifecyclePending && !purgePreview && (
            <p role="status">Preparing review…</p>
          )}
          {purgeError && (
            <p role="alert" className="text-destructive text-sm">
              {purgeError}
            </p>
          )}
          {purgePreview ? (
            <div className="mt-4 space-y-4">
              <LifecyclePurgeReview
                preview={purgePreview}
                region={workspaceCalendar}
              />
              {purgePreview.impact.blockers.length === 0 && (
                <form
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void confirmEventPurge();
                  }}
                >
                  <p className="text-sm break-words">
                    Event name: <code>{purgePreview.confirmation_name}</code>
                  </p>
                  <label className="block space-y-2 text-sm">
                    Type the event name
                    <Input
                      autoComplete="off"
                      value={purgeName}
                      disabled={lifecyclePending}
                      onChange={(event) => setPurgeName(event.target.value)}
                    />
                  </label>
                  <label className="block space-y-2 text-sm">
                    Administrator password
                    <Input
                      type="password"
                      autoComplete="current-password"
                      value={purgePassword}
                      disabled={lifecyclePending}
                      onChange={(event) => setPurgePassword(event.target.value)}
                    />
                  </label>
                  <Button
                    type="submit"
                    variant="destructive"
                    className="min-h-11"
                    disabled={
                      lifecyclePending ||
                      !purgeEnabled ||
                      purgeName !== purgePreview.confirmation_name ||
                      !purgePassword
                    }
                  >
                    Confirm permanent deletion
                  </Button>
                </form>
              )}
            </div>
          ) : (
            !lifecyclePending &&
            purgeEvent && (
              <Button
                className="mt-4 min-h-11"
                variant="outline"
                onClick={() => {
                  if (purgeEvent) void reviewEventPurge(purgeEvent);
                }}
              >
                Review again
              </Button>
            )
          )}
          <Button
            className="mt-4 min-h-11"
            variant="outline"
            disabled={lifecyclePending}
            onClick={() => {
              setPurgeEvent(null);
              setPurgePreview(null);
              setPurgeName("");
              setPurgePassword("");
              setPurgeError("");
            }}
          >
            Cancel
          </Button>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={
          lifecycleTarget?.boardId === boardId &&
          !accessDenied &&
          boardActive &&
          (canConfirmLifecycle(lifecycleTarget) || Boolean(lifecycleError))
        }
        onOpenChange={(open) => {
          if (!open && !lifecyclePending) setLifecycleTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {lifecycleTarget?.kind === "archive"
                ? "Archive event?"
                : "Restore event?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {lifecycleTarget?.kind === "archive"
                ? `Archive “${lifecycleTarget.title}” and all its occurrences? It will leave the active calendar and can be restored by a Board manager.`
                : `Restore “${lifecycleTarget?.title ?? "this event"}” and its occurrences to the active calendar?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {lifecycleError && (
            <Alert variant="destructive">{lifecycleError}</Alert>
          )}
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={lifecyclePending}
              onClick={() => setLifecycleTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={
                lifecycleTarget?.kind === "archive" ? "destructive" : "default"
              }
              className="min-h-11"
              disabled={
                lifecyclePending || !canConfirmLifecycle(lifecycleTarget)
              }
              onClick={() => void confirmLifecycle()}
            >
              {lifecyclePending
                ? "Saving…"
                : lifecycleTarget?.kind === "archive"
                  ? "Archive event"
                  : "Restore event"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
