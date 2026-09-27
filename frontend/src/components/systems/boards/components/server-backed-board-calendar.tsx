"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";
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
import { getBoardWorkspaceToday } from "../adapters/board-workspace-date-api";
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
import { ServerBoardReminders } from "./server-backed-board-reminders";
import {
  MonthGrid,
  MyEventsDisplay,
  ServerBoardCalendarDisplay,
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
    JSON.stringify(left.audience) === JSON.stringify(right.audience) &&
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
  boardActive = false,
  onDraftStateChange,
}: {
  boardId: string;
  refreshKey: number;
  boardActive?: boolean;
  onDraftStateChange?: (
    boardId: string,
    dirty: boolean,
    pending: boolean,
  ) => void;
}) {
  const viewerId = useVerifiedWorkspaceUserId();
  const [workspaceToday, setWorkspaceToday] = useState<string | null>(null);
  const [workspaceDateError, setWorkspaceDateError] = useState<string | null>(
    null,
  );
  const [workspaceDateRetry, setWorkspaceDateRetry] = useState(0);
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
  const [lifecycleNotice, setLifecycleNotice] = useState<string | null>(null);
  const [access, setAccess] = useState<{
    key: string;
    status: "loading" | "ready" | "denied" | "error";
    value: BoardMyAccess | null;
  } | null>(null);
  const [accessVersion, setAccessVersion] = useState(0);
  const [blockedBoardId, setBlockedBoardId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BoardEventDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [attachmentPending, setAttachmentPending] = useState(false);
  const attachmentPendingRef = useRef(false);
  const [recordLinkPending, setRecordLinkPending] = useState(false);
  const recordLinkPendingRef = useRef(false);
  const pendingRef = useRef(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorNotice, setEditorNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    eventId: string | null;
    status: "needs-check" | "checking" | "ready";
    latest: BoardEventLatestVersion | null;
  } | null>(null);
  const calendarMonth = month ?? workspaceToday?.slice(0, 7) ?? null;
  const calendarWindow = calendarMonth
    ? calendarWindowForMonth(calendarMonth)
    : null;
  const selectedCalendarDate =
    selectedDate ?? workspaceToday ?? calendarWindow?.start ?? "";
  const { state, retry, invalidate, loadMore, isLoadingMore, loadMoreError } =
    useServerBoardEvents(boardId, calendarWindow, refreshKey, search);
  const invalidateRef = useRef(invalidate);
  const accessKey = `${boardId}:${refreshKey}:${boardActive}:${accessVersion}`;
  const currentAccess =
    access?.key === accessKey && access.status === "ready"
      ? access.value
      : null;
  const accessDenied = boardActive && blockedBoardId === boardId;
  const accessFailed =
    boardActive && access?.key === accessKey && access.status === "error";
  const calendarPage = accessDenied ? null : state.data;
  const canEdit = boardActive && currentAccess?.edit === true;
  const canManage =
    boardActive && currentAccess?.manage === true && !accessDenied;
  const archivedKey = `${boardId}:${refreshKey}:${archivedOffset}:${archivedVersion}`;
  const archivedPage =
    canManage &&
    archivedState?.key === archivedKey &&
    archivedState.status === "ready"
      ? archivedState.page
      : null;
  const activeDraft = canEdit && draft?.boardId === boardId ? draft : null;
  const myEventsKey = `${boardId}:${refreshKey}:${myEventsOffset}:${myEventsRetry}`;

  useEffect(() => {
    let active = true;
    async function refreshWorkspaceDate() {
      try {
        const today = await getBoardWorkspaceToday();
        if (!active) return;
        setWorkspaceToday(today);
        setWorkspaceDateError(null);
        setMonth((current) => current ?? today.slice(0, 7));
        setSelectedDate((current) => current ?? today);
      } catch {
        if (active) setWorkspaceDateError("Could not load the Workspace date.");
      }
    }
    void refreshWorkspaceDate();
    const timer = globalThis.window.setInterval(
      () => void refreshWorkspaceDate(),
      60_000,
    );
    return () => {
      active = false;
      globalThis.window.clearInterval(timer);
    };
  }, [refreshKey, workspaceDateRetry]);

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
    attachmentPendingRef.current = false;
    recordLinkPendingRef.current = false;
    setAttachmentPending(false);
    setRecordLinkPending(false);
    setEditorError(null);
    setEditorNotice(null);
    setConflict(null);
    setBlockedBoardId(null);
    setArchivedOffset(0);
    setArchivedState(null);
    setLifecycleTarget(null);
    setLifecycleNotice(null);
    lifecycleRequest.current += 1;
    lifecyclePendingRef.current = false;
    setLifecyclePending(false);
  }, [boardId]);

  useEffect(() => {
    setLifecycleTarget(null);
  }, [refreshKey]);

  useEffect(() => {
    if (!canManage) {
      setArchivedState(null);
      setLifecycleTarget(null);
    }
  }, [canManage]);

  useEffect(() => {
    if (!boardActive) {
      setDraft(null);
      setEditorError(null);
      setConflict(null);
      setLifecycleTarget(null);
      setArchivedState(null);
      setView((current) => (current === "archived" ? "month" : current));
    }
  }, [boardActive]);

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
    if (!boardActive) return;
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
          setEditorNotice("Event editing is unavailable for this Board.");
          invalidateRef.current();
        }
      });
    return () => {
      active = false;
    };
  }, [boardActive, boardId, refreshKey, accessVersion, accessKey]);

  useEffect(() => {
    if (view !== "archived" || !canManage) return;
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
  }, [archivedKey, archivedOffset, boardId, canManage, view]);

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
    );
    if (!action) return;
    setLifecycleNotice(null);
    setLifecycleTarget(action);
  }

  async function confirmLifecycle() {
    const action = lifecycleTarget;
    if (!action || lifecyclePendingRef.current) return;
    const page = action.kind === "archive" ? calendarPage : archivedPage;
    const listed =
      action.kind === "archive"
        ? calendarPage?.items.some(
            (item) =>
              item.event.id === action.eventId &&
              item.event.revision === action.eventRevision,
          )
        : archivedPage?.items.some(
            (item) =>
              item.id === action.eventId &&
              item.revision === action.eventRevision,
          );
    if (
      action.boardId !== boardId ||
      !canManage ||
      !page ||
      page.boardRevision !== action.boardRevision ||
      !listed
    ) {
      setLifecycleTarget(null);
      setLifecycleNotice("Event details changed. Refresh before trying again.");
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
      setLifecycleNotice(
        action.kind === "archive" ? "Event archived." : "Event restored.",
      );
      invalidate();
      setArchivedState(null);
      setArchivedVersion((value) => value + 1);
      setAccessVersion((value) => value + 1);
    } catch (error) {
      if (request !== lifecycleRequest.current) return;
      setLifecycleTarget(null);
      setArchivedState(null);
      invalidate();
      setArchivedVersion((value) => value + 1);
      setAccessVersion((value) => value + 1);
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        setBlockedBoardId(boardId);
        setDraft(null);
        setConflict(null);
        setLifecycleNotice(
          "Your access changed. Event actions were closed and the calendar is refreshing.",
        );
      } else if (error instanceof ApiError && error.status === 409) {
        setLifecycleNotice(
          "The Board or event changed. Review refreshed events before trying again.",
        );
      } else {
        setLifecycleNotice(
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
      setEditorNotice(draftToSave.eventId ? "Event saved." : "Event created.");
      retry();
      setMyEventsRetry((value) => value + 1);
      setAccessVersion((value) => value + 1);
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        setBlockedBoardId(boardId);
        setDraft(null);
        setConflict(null);
        setEditorNotice("Your access changed. The event editor was closed.");
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
            ? `${error.message}. Your draft is retained. Check the latest version before choosing how to continue.`
            : error instanceof ApiError && error.status === 422
              ? `${error.message}. Your draft is retained; check the fields and try again.`
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
        setEditorNotice("Your access changed. The event editor was closed.");
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
        setEditorNotice(
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
    setEditorNotice(null);
    setConflict(null);
    setDraft(boardEventDraftFromEvent(event));
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
      ) !== null
    );
  }

  function displayCalendarEvents(date?: string, compact = false) {
    if (!calendarPage || !calendarWindow) return null;
    return (
      <ServerBoardCalendarDisplay
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
              Plan upcoming work and keep track of your reminders.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(canManage || canEdit) && !activeDraft && (
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
                  {canManage && (
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
                  setEditorNotice(null);
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
          <Alert variant="warning">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {workspaceToday
                  ? "The Workspace date could not be refreshed. The last loaded date is still in use."
                  : workspaceDateError}
              </span>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setWorkspaceDateRetry((value) => value + 1)}
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
      {editorNotice && <Alert role="status">{editorNotice}</Alert>}
      {lifecycleNotice && <Alert role="status">{lifecycleNotice}</Alert>}
      {accessFailed && (
        <Alert variant="warning">
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
        <Alert variant="warning">
          <div className="flex min-w-0 flex-col gap-3">
            <p className="font-medium">
              The saved version changed. Your draft is still here.
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
                        <dt className="font-medium">Audience</dt>
                        <dd>{conflict.latest.event.audience.kind}</dd>
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
                      schedule, and recurrence. Audience changes only if you
                      selected a new one.{" "}
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
          <Alert variant="warning">
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
            page={myEventsState.page}
            onEdit={(event) => {
              if (!mayEditEvent(event)) return;
              setEditorError(null);
              setEditorNotice(null);
              setConflict(null);
              setDraft(boardEventDraftFromEvent(event));
            }}
            onPrevious={() =>
              setMyEventsOffset((value) => Math.max(0, value - 25))
            }
            onNext={() => setMyEventsOffset((value) => value + 25)}
          />
        )}
      {view !== "archived" && view !== "mine" && state.error && (
        <Alert variant={state.data ? "warning" : "destructive"}>
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
                  page to include more events and reminder choices.
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
              <Alert variant="warning">
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
                  <MonthGrid
                    window={calendarWindow}
                    page={calendarPage}
                    selectedDate={selectedCalendarDate}
                    today={workspaceToday}
                    onSelect={setSelectedDate}
                  />
                ) : (
                  <div id="server-board-calendar-day">
                    {displayCalendarEvents()}
                  </div>
                )}
              </div>
              <aside
                aria-label={
                  view === "month" ? "Selected day and reminders" : "Reminders"
                }
                className="min-w-0 space-y-4"
              >
                {view === "month" && (
                  <div id="server-board-calendar-day">
                    {displayCalendarEvents(selectedCalendarDate, true)}
                  </div>
                )}
                <ServerBoardReminders
                  boardId={boardId}
                  boardActive={boardActive}
                  occurrences={calendarPage.items}
                  refreshKey={calendarPage.boardRevision}
                />
              </aside>
            </div>
          </>
        )}
      {view === "archived" && canManage && archivedPage && (
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
        canManage &&
        archivedState?.key === archivedKey &&
        archivedState.status === "loading" && (
          <p role="status" className="text-muted-foreground py-8 text-sm">
            Loading archived events…
          </p>
        )}
      {view === "archived" &&
        canManage &&
        archivedState?.key === archivedKey &&
        archivedState.error && (
          <Alert variant="warning">
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
      {view === "archived" && !canManage && !accessDenied && (
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
      <AlertDialog
        open={lifecycleTarget?.boardId === boardId && canManage}
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
              disabled={lifecyclePending}
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
