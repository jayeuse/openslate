"use client";
import {
  useDisplayRegion,
  useDisplayWeekStart,
} from "@/components/use-display-region";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  authMeOptions,
  invalidatesRecords,
} from "../../openview/adapters/openview-queries";
import { encodeTemporaryDefinition } from "../../openview/domain/temporary-view";
import { moduleHref } from "@/components/department-navigation-model";
import { departmentTone } from "@/lib/sandbox/department-tone";
import {
  lifecycleErrorMessage,
  type LifecyclePurgePreview,
} from "@/lib/lifecycle";
import {
  workspaceLifecycleQueryOptions,
  subscribeWorkspaceLifecycleSettings,
} from "../../manage/adapters/workspace-api";
import { subscribeWorkspaceInvalidations } from "../../shared/adapters/invalidation-events";
import {
  previewBoardEventPurge,
  purgeBoardEvent,
} from "../adapters/board-events-api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { reportDone, reportError } from "@/lib/feedback";
import { formatWorkspaceDate } from "@/lib/date-time";
import { useWorkspaceNavigationRequest } from "@/components/workspace-navigation-guard";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "@/components/systems/shared/runtime/workspace-identity";
import {
  archiveBoardEvent,
  createBoardEvent,
  listBoardEvents,
  readBoardEvent,
  restoreBoardEvent,
  updateBoardEvent,
  type BoardEvent,
  type BoardEventPage,
} from "../adapters/board-events-api";
import {
  addBoardCalendarSource,
  addMyCalendarSource,
  removeBoardCalendarSource,
  type CalendarSource,
} from "../adapters/board-calendar-sources-api";
import type { DueCard } from "../adapters/board-due-cards-api";
import type { BoardAttachmentVersions } from "../adapters/board-files-api";
import { readBoard } from "../adapters/board-management-api";
import type { WorkspaceCalendarSettings } from "../../manage/adapters/workspace-api";
import {
  getMyBoardAccess,
  type BoardMyAccess,
} from "../adapters/board-tools-api";
import {
  monthGrid,
  parseCalendarShow,
  parseCalendarView,
  shiftAnchor,
  viewWindow,
  weekDays,
  type CalendarShow,
  type CalendarView,
} from "../domain/calendar-dates";
import {
  calendarColor,
  calendarEmptyStatus,
  filterCalendarItems,
  type CalendarItem,
  type CalendarTone,
} from "../domain/calendar-items";
import {
  browserStorage,
  hiddenCalendarsKey,
  readHiddenCalendars,
  writeHiddenCalendars,
} from "../domain/hidden-calendars";
import {
  boardCalendarKeys,
  boardDueCalendarId,
  boardEventsCalendarId,
  boardSourceCalendarId,
  useBoardCalendarSources,
  useBoardCalendarWindow,
} from "../hooks/use-board-calendar-data";
import { BoardEmpty, ConfirmAction } from "./ui";
import {
  BoardEventDraftError,
  boardEventDraftFromEvent,
  boardEventInputFromDraft,
  newBoardEventDraft,
  prepareBoardEventConflictRetry,
  type BoardEventDraft,
  type BoardEventLatestVersion,
} from "./server-backed-board-event-editor";
import {
  prepareBoardEventLifecycleAction,
  ServerArchivedBoardEventsDisplay,
  type BoardEventLifecycleAction,
} from "./server-backed-board-event-lifecycle";
import {
  boardEventTimeLabel,
  boardOccurrenceTimeLabel,
} from "./server-board-calendar-display";
import { dayLabel, type CalendarInfo } from "./board-calendar-chips";
import { BoardCalendarToolbar } from "./board-calendar-toolbar";
import {
  BoardCalendarMonth,
  BoardCalendarPhoneMonth,
} from "./board-calendar-month";
import {
  BoardCalendarPhoneWeek,
  BoardCalendarWeek,
} from "./board-calendar-week";
import {
  BoardCalendarUpcoming,
  UpcomingGroupList,
} from "./board-calendar-upcoming";
import {
  CalendarList,
  CalendarsPopover,
  MiniMonth,
  type CalendarListActions,
  type CalendarListRow,
} from "./board-calendar-rail";
import { BoardCalendarSourceDialog } from "./board-calendar-source-dialog";
import { BoardCardDuePopover } from "./board-card-due-popover";
import { BoardEventSheet, type EventSheetState } from "./board-event-sheet";
import { BoardEventEditorDialog } from "./board-event-editor-dialog";
import {
  BoardEventLifecycleDialog,
  BoardEventPurgeDialog,
} from "./board-event-lifecycle-dialogs";
import { upcomingGroups } from "../domain/calendar-items";

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

const phoneQuery = "(max-width: 47.99rem)";
const railQuery = "(min-width: 90rem)";
function subscribeQuery(media: string) {
  return (notify: () => void) => {
    const query = window.matchMedia(media);
    query.addEventListener("change", notify);
    return () => query.removeEventListener("change", notify);
  };
}
const subscribePhone = subscribeQuery(phoneQuery);
const subscribeRail = subscribeQuery(railQuery);
function useMedia(
  query: string,
  subscribe: (notify: () => void) => () => void,
) {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** A draft without its revisions, to tell an edit from a refreshed base. */
function draftContent(draft: BoardEventDraft | null): string {
  return JSON.stringify(
    draft ? { ...draft, boardRevision: 0, eventRevision: 0 } : null,
  );
}

function minuteNow(timezone: string | undefined): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
    }).formatToParts(new Date());
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    return Number.isFinite(hour) && Number.isFinite(minute)
      ? hour * 60 + minute
      : null;
  } catch {
    return null;
  }
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

export type BoardCalendarParams = {
  view?: CalendarView | null;
  show?: CalendarShow | null;
  event?: string | null;
};

/**
 * A board's Calendar tab (P3a): Month, Week, and Upcoming over the board's
 * events, its record sources, and its due cards, with the calendar list, the
 * event sheet, and the event editor. This component owns the event drafts,
 * conflicts, lifecycle, and purge; the views only draw `CalendarItem`s.
 */
export function ServerBackedBoardCalendar({
  boardId,
  calendarName,
  departmentIndex,
  departmentIndexOf,
  refreshKey,
  liveKey,
  workspaceCalendar,
  workspaceDateError,
  onRetryWorkspaceDate,
  boardActive = false,
  onDraftStateChange,
  selectedEventId = null,
  view: requestedView = null,
  show: requestedShow = null,
  onParams,
  primarySlot = null,
}: {
  /** The page header's place for the tab's one primary (BR6, BR50). */
  primarySlot?: HTMLElement | null;
  boardId: string;
  /** The board's page title, the name of its own calendar. */
  calendarName: string;
  /** The board's department mark; null for Company and project boards. */
  departmentIndex: number | null;
  /** A record source's department mark, from its module's department. */
  departmentIndexOf: (departmentId: string) => number | null;
  refreshKey: number;
  liveKey: number;
  workspaceCalendar: WorkspaceCalendarSettings | undefined;
  workspaceDateError: boolean;
  onRetryWorkspaceDate: () => void;
  boardActive?: boolean;
  selectedEventId?: string | null;
  view?: string | null;
  show?: string | null;
  /** Calendar address changes: they keep drafts, so they skip the guard. */
  onParams: (params: BoardCalendarParams) => void;
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
  const displayRegion = useDisplayRegion(workspaceCalendar);
  const displayWeekStart = useDisplayWeekStart(
    workspaceCalendar?.week_start ?? "monday",
  );
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const phone = useMedia(phoneQuery, subscribePhone);
  const wide = useMedia(railQuery, subscribeRail);
  const view = parseCalendarView(requestedView, phone);
  const [hiddenState, setHiddenState] = useState<{
    key: string;
    ids: string[];
  } | null>(null);
  const [selectedOccurrence, setSelectedOccurrence] = useState<string | null>(
    null,
  );
  const [dueCard, setDueCard] = useState<{
    card: DueCard;
    anchor: HTMLElement;
  } | null>(null);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [sourceToRemove, setSourceToRemove] = useState<CalendarSource | null>(
    null,
  );
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
  // A new event's starting draft, to tell an edit from an untouched form.
  const [draftOrigin, setDraftOrigin] = useState<BoardEventDraft | null>(null);
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
  const currentAnchor = anchor ?? workspaceToday;
  const calendarWindow =
    currentAnchor && workspaceToday
      ? viewWindow(view, currentAnchor, displayWeekStart, workspaceToday)
      : null;
  const hiddenKey = viewerId ? hiddenCalendarsKey(viewerId, boardId) : null;
  const hidden = new Set(
    hiddenState && hiddenState.key === hiddenKey
      ? hiddenState.ids
      : hiddenKey
        ? readHiddenCalendars(browserStorage, hiddenKey)
        : [],
  );
  const sourcesQuery = useBoardCalendarSources(boardId);
  const sources = sourcesQuery.data ?? [];
  const data = useBoardCalendarWindow({
    boardId,
    window: calendarWindow,
    search,
    liveKey,
    sources,
    hidden,
    dueCards: true,
  });
  const { state, retry, invalidate } = data.events;
  const selectedCalendarDate =
    selectedDay ?? currentAnchor ?? calendarWindow?.start ?? "";
  const invalidateRef = useRef(invalidate);
  const accessKey = `${boardId}:${refreshKey}:${boardActive}:${isPurgeAdmin}:${accessVersion}`;
  // A re-check keeps this Board's last confirmed access, so open menus and
  // editors stay mounted; a denial or failure still clears it.
  const currentAccess =
    access?.key.startsWith(`${boardId}:`) &&
    (access.status === "ready" || access.status === "loading")
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
  const show = parseCalendarShow(requestedShow, {
    mine: canEdit,
    archived: canBrowseArchived,
  });

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
    setAnchor((current) => current ?? workspaceToday);
  }, [workspaceToday]);

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
      if (!isPurgeAdmin) setArchivedState(null);
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
    setAccess((current) => ({
      key: accessKey,
      status: "loading",
      value: current?.status === "ready" ? current.value : null,
    }));
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
      if (action.kind === "archive" && selectedEventId === action.eventId)
        onParams({ event: null });
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
      let savedId: string;
      if (draftToSave.eventId !== null && "eventRevision" in input)
        savedId = (await updateBoardEvent(boardId, draftToSave.eventId, input))
          .id;
      else if (draftToSave.eventId === null && !("eventRevision" in input))
        savedId = (await createBoardEvent(boardId, input)).id;
      else throw new Error("Event editor state is invalid.");
      setDraft(null);
      setConflict(null);
      reportDone(draftToSave.eventId ? "Event saved." : "Event created.");
      retry();
      // After Create or Save, the event sheet opens on it (BR21).
      setSelectedOccurrence(null);
      onParams({ event: savedId });
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
  // ---- The calendars, their items, and what opens them ----
  const region = displayRegion ?? workspaceCalendar;
  const requestNavigation = useWorkspaceNavigationRequest();
  const router = useRouter();
  const toneOf = (index: number | null): CalendarTone =>
    index === null
      ? { kind: "neutral" }
      : { kind: "department", tone: departmentTone(index) as 1 | 2 | 3 | 4 };
  const boardColor = calendarColor(toneOf(departmentIndex));
  const eventsCalendar = boardEventsCalendarId(boardId);
  const dueCalendar = boardDueCalendarId(boardId);
  const rows: CalendarListRow[] = [
    {
      id: eventsCalendar,
      name: calendarName,
      color: boardColor,
      kind: "events",
    },
    { id: dueCalendar, name: "Cards · Due", color: boardColor, kind: "due" },
    ...sources.map((source): CalendarListRow => {
      const changes = encodeTemporaryDefinition({
        filters: [
          {
            fieldId: source.dateFieldId,
            expectedType: source.fieldType,
            operator: "empty",
            value: null,
          },
        ],
      });
      return {
        id: boardSourceCalendarId(source.id),
        name: `${source.moduleName} · ${source.fieldName}`,
        color: calendarColor(toneOf(departmentIndexOf(source.departmentId))),
        kind: "source",
        source,
        undatedHref: changes
          ? `${moduleHref(source.moduleId)}&changes=${changes}`
          : undefined,
      };
    }),
  ];
  const calendars = new Map<string, CalendarInfo>(
    rows.map((row) => [row.id, row]),
  );
  const query = search.trim().toLocaleLowerCase();
  // Events are searched by the server; record and card titles in the browser.
  const items = filterCalendarItems(data.items, {
    hidden,
    show,
    viewerId,
    search: "",
  }).filter(
    (item) =>
      item.kind === "event" ||
      !query ||
      item.title.toLocaleLowerCase().includes(query),
  );
  const canManageSources = boardActive && currentAccess?.manage === true;

  useEffect(
    () =>
      subscribeWorkspaceInvalidations((event) => {
        if (event.type === "resync") {
          void queryClient.invalidateQueries({
            queryKey: boardCalendarKeys.all,
          });
          return;
        }
        if (
          event.entity === "board_calendar_sources" &&
          event.boardId === boardId
        )
          void queryClient.invalidateQueries({
            queryKey: boardCalendarKeys.sources(boardId),
          });
        else if (invalidatesRecords(event.entity))
          void queryClient.invalidateQueries({
            queryKey: boardCalendarKeys.sourceRecords,
          });
      }),
    [boardId, queryClient],
  );

  function toggleCalendar(id: string) {
    if (!hiddenKey) return;
    const next = hidden.has(id)
      ? [...hidden].filter((entry) => entry !== id)
      : [...hidden, id];
    setHiddenState({ key: hiddenKey, ids: next });
    writeHiddenCalendars(browserStorage, hiddenKey, next);
  }

  function refreshSources() {
    void queryClient.invalidateQueries({
      queryKey: boardCalendarKeys.sources(boardId),
    });
  }

  async function confirmRemoveSource(source: CalendarSource) {
    try {
      await removeBoardCalendarSource(boardId, source.id);
      reportDone("Record source removed");
    } catch (failure) {
      reportError(
        failure instanceof ApiError && failure.message
          ? failure.message
          : "The record source was not removed. Try again.",
      );
    } finally {
      setSourceToRemove(null);
      refreshSources();
    }
  }

  const listActions: CalendarListActions = {
    hidden,
    statuses: data.statuses,
    canManage: canManageSources,
    onToggle: toggleCalendar,
    onRetry: data.retry,
    onAddSource: () => setSourceDialogOpen(true),
    onRemoveSource: setSourceToRemove,
    onAddToMyCalendar: (source) => {
      void addMyCalendarSource({
        moduleId: source.moduleId,
        dateFieldId: source.dateFieldId,
      }).then(
        () => reportDone("Added to My calendar"),
        (failure: unknown) =>
          reportError(
            failure instanceof ApiError && failure.message
              ? failure.message
              : "Could not add it to My calendar. Try again.",
          ),
      );
    },
  };

  function openItem(item: CalendarItem, anchorElement: HTMLElement) {
    const target = item.target;
    if (target.kind === "event") {
      setSelectedOccurrence(item.key);
      onParams({ event: target.eventId });
      return;
    }
    if (target.kind === "record") {
      // Until the shared record sheet (P4), a record opens on its module page.
      const href =
        `/openview?section=views&module=${encodeURIComponent(target.moduleId)}&record=${encodeURIComponent(target.recordId)}` as Route;
      const go = () => router.push(href);
      if (requestNavigation(href, go)) go();
      return;
    }
    const card = data.dueCards.find((entry) => entry.id === target.cardId);
    if (card) setDueCard({ card, anchor: anchorElement });
  }

  // ---- The event sheet ----
  const occurrence =
    calendarPage?.items.find(
      (item) =>
        item.id === selectedOccurrence && item.eventId === selectedEventId,
    ) ?? null;
  const listedEvent =
    calendarPage?.items.find((item) => item.eventId === selectedEventId)
      ?.event ?? null;
  const sheetEvent =
    selectedEvent ?? (currentSelectedDetail ? null : listedEvent);
  const sheetState: EventSheetState = accessDenied
    ? {
        status: "error",
        message: "This event is unavailable or you no longer have access.",
        retryable: false,
      }
    : currentSelectedDetail?.error
      ? {
          status: "error",
          message: currentSelectedDetail.error,
          retryable: true,
        }
      : sheetEvent
        ? {
            status: "ready",
            event: sheetEvent,
            when: occurrence
              ? boardOccurrenceTimeLabel(
                  { ...occurrence, event: sheetEvent },
                  region,
                )
              : boardEventTimeLabel(sheetEvent, region),
          }
        : { status: "loading" };

  // ---- The period ----
  const anchorDate = currentAnchor ?? "";
  const monthName =
    region && anchorDate
      ? formatWorkspaceDate(`${anchorDate.slice(0, 7)}-01`, region, {
          month: "long",
        })
      : "";
  const days =
    anchorDate && view === "week" ? weekDays(anchorDate, displayWeekStart) : [];
  const title =
    !region || !anchorDate
      ? "Calendar"
      : view === "month"
        ? formatWorkspaceDate(`${anchorDate.slice(0, 7)}-01`, region, {
            month: phone ? "short" : "long",
            year: "numeric",
          })
        : view === "week"
          ? `${formatWorkspaceDate(days[0], region, { month: "short", day: "numeric" })} – ${formatWorkspaceDate(days[6], region, { month: "short", day: "numeric" })}${phone ? "" : `, ${days[6].slice(0, 4)}`}`
          : workspaceToday
            ? `From ${dayLabel(workspaceToday, region)}`
            : "Upcoming";
  const nextEvent = data.nextOccurrence;
  const status =
    view === "month" &&
    show === "all" &&
    !query &&
    !hidden.has(eventsCalendar) &&
    data.eventsReady &&
    items.length === 0 &&
    region
      ? calendarEmptyStatus(
          monthName,
          nextEvent ? dayLabel(nextEvent.date, region) : null,
        )
      : null;
  const showOptions: CalendarShow[] = [
    "all",
    ...(canEdit ? (["mine"] as const) : []),
    ...(canBrowseArchived ? (["archived"] as const) : []),
  ];
  const daySelected =
    selectedDay &&
    (view !== "month" || selectedDay.slice(0, 7) === anchorDate.slice(0, 7))
      ? selectedDay
      : workspaceToday && workspaceToday.slice(0, 7) === anchorDate.slice(0, 7)
        ? workspaceToday
        : view === "week"
          ? (days[0] ?? anchorDate)
          : `${anchorDate.slice(0, 7)}-01`;
  const draftDirty =
    activeDraft !== null &&
    draftContent(activeDraft) !==
      draftContent(
        draftBase && activeDraft.eventId === draftBase.id
          ? boardEventDraftFromEvent(draftBase)
          : draftOrigin,
      );

  function move(amount: number) {
    if (!anchorDate) return;
    const next = shiftAnchor(view, anchorDate, amount);
    setAnchor(next);
    setSelectedDay(view === "week" ? next : null);
  }

  const calendarList = <CalendarList rows={rows} actions={listActions} />;

  let main: ReactNode;
  if (show === "archived") {
    main = (
      <div className="bg-card flex min-w-0 flex-col gap-3 rounded-lg border p-4 xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
        {canBrowseArchived && archivedPage ? (
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
                className="min-h-11 xl:min-h-8"
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
                className="min-h-11 xl:min-h-8"
                disabled={!archivedPage.pagination.hasMore}
                onClick={() => setArchivedOffset((current) => current + 25)}
              >
                Next archived events
              </Button>
            </div>
          </>
        ) : null}
        {canBrowseArchived &&
        archivedState?.key === archivedKey &&
        archivedState.status === "loading" ? (
          <p role="status" className="text-muted-foreground py-8 text-sm">
            Loading archived events…
          </p>
        ) : null}
        {canBrowseArchived &&
        archivedState?.key === archivedKey &&
        archivedState.error ? (
          <Alert variant="destructive">
            {archivedState.error}
            <Button
              type="button"
              variant="outline"
              className="ml-2 min-h-11 xl:min-h-8"
              onClick={() => setArchivedVersion((value) => value + 1)}
            >
              Retry archived events
            </Button>
          </Alert>
        ) : null}
      </div>
    );
  } else if (!calendarWindow || !region || !workspaceToday) {
    main = workspaceDateError ? null : (
      <p role="status" className="text-muted-foreground py-8 text-sm">
        Loading the Workspace date…
      </p>
    );
  } else if (
    !calendarPage &&
    (accessDenied ||
      (state.status === "error" &&
        state.error?.startsWith("Calendar unavailable.")))
  ) {
    main = (
      <BoardEmpty
        title="Calendar unavailable"
        description="No events are shown. Retry or ask a Board manager to check your access."
      />
    );
  } else if (view === "month") {
    const grid = monthGrid(anchorDate, displayWeekStart);
    main = phone ? (
      <BoardCalendarPhoneMonth
        grid={grid}
        anchor={anchorDate}
        today={workspaceToday}
        label={title}
        items={items}
        calendars={calendars}
        region={region}
        selected={daySelected}
        onSelect={setSelectedDay}
        onOpen={openItem}
      />
    ) : (
      <BoardCalendarMonth
        grid={grid}
        anchor={anchorDate}
        today={workspaceToday}
        weekStart={displayWeekStart}
        label={title}
        items={items}
        calendars={calendars}
        region={region}
        onOpen={openItem}
        onShowDay={(date) => {
          setAnchor(date);
          setSelectedDay(date);
          onParams({ view: "week" });
        }}
      />
    );
  } else if (view === "week") {
    main = phone ? (
      <BoardCalendarPhoneWeek
        days={days}
        today={workspaceToday}
        items={items}
        calendars={calendars}
        region={region}
        selected={daySelected}
        onSelect={setSelectedDay}
        onOpen={openItem}
      />
    ) : (
      <BoardCalendarWeek
        days={days}
        label={title}
        today={workspaceToday}
        nowMinute={minuteNow(region.timezone)}
        items={items}
        calendars={calendars}
        region={region}
        onOpen={openItem}
      />
    );
  } else {
    main = (
      <BoardCalendarUpcoming
        today={workspaceToday}
        items={items}
        ready={data.eventsReady}
        nextOccurrence={nextEvent}
        calendars={calendars}
        region={region}
        onOpen={openItem}
        renderLater={(window) => (
          <LaterWindow
            boardId={boardId}
            window={window}
            search={search}
            liveKey={liveKey}
            sources={sources}
            hidden={hidden}
            show={show}
            viewerId={viewerId}
            today={workspaceToday}
            calendars={calendars}
            region={region}
            onOpen={openItem}
          />
        )}
      />
    );
  }

  return (
    <section
      aria-label="Board calendar"
      className="slim-ui flex min-w-0 flex-col gap-3 xl:min-h-0 xl:flex-1"
    >
      {show !== "archived" &&
        canEdit &&
        calendarPage &&
        !activeDraft &&
        primarySlot &&
        createPortal(
          <Button
            type="button"
            className="min-h-11 xl:min-h-8"
            onClick={() => {
              setEditorError(null);
              setConflict(null);
              const next = newBoardEventDraft(
                boardId,
                calendarPage.boardRevision,
                selectedCalendarDate,
              );
              setDraftOrigin(next);
              setDraftBase(null);
              setDraft(next);
            }}
          >
            <Plus data-icon="inline-start" /> New event
          </Button>,
          primarySlot,
        )}
      {workspaceDateError ? (
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
              className="min-h-11 xl:min-h-8"
              onClick={onRetryWorkspaceDate}
            >
              Retry Workspace date
            </Button>
          </div>
        </Alert>
      ) : null}
      {editorError && !activeDraft ? (
        <Alert variant="destructive">{editorError}</Alert>
      ) : null}
      {lifecycleError && !lifecycleTarget ? (
        <Alert variant="destructive">{lifecycleError}</Alert>
      ) : null}
      {accessFailed ? (
        <Alert variant="destructive">
          Could not check edit access. Your unsaved draft is retained.
          <Button
            type="button"
            variant="outline"
            className="ml-2 min-h-11 xl:min-h-8"
            onClick={() => setAccessVersion((value) => value + 1)}
          >
            Retry access
          </Button>
        </Alert>
      ) : null}
      {show !== "archived" && data.eventsError ? (
        <Alert variant="destructive">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {calendarPage ? "Showing the last loaded events. " : ""}
              {data.eventsError}
            </span>
            <Button
              variant="outline"
              className="min-h-11 xl:min-h-8"
              onClick={() => data.retry(eventsCalendar)}
            >
              <RefreshCw data-icon="inline-start" /> Retry
            </Button>
          </div>
        </Alert>
      ) : null}
      <div className="flex min-w-0 flex-col gap-4 xl:min-h-0 xl:flex-1 min-[90rem]:grid min-[90rem]:grid-cols-[232px_minmax(0,1fr)] min-[90rem]:grid-rows-[minmax(0,1fr)]">
        {wide ? (
          <aside
            aria-label="Calendars"
            className="bg-card flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain rounded-lg border p-3"
          >
            {region && anchorDate ? (
              <MiniMonth
                anchor={anchorDate}
                today={workspaceToday}
                weekStart={displayWeekStart}
                highlight={view === "week" ? days : []}
                region={region}
                onPick={(date) => {
                  setAnchor(date);
                  setSelectedDay(date);
                }}
              />
            ) : null}
            {calendarList}
          </aside>
        ) : null}
        <div className="flex min-w-0 flex-col gap-3 xl:min-h-0 xl:flex-1">
          <BoardCalendarToolbar
            calendars={
              wide || show === "archived" ? null : (
                <CalendarsPopover rows={rows} actions={listActions} />
              )
            }
            title={show === "archived" ? "Archived events" : title}
            view={view}
            show={show}
            showOptions={showOptions}
            search={search}
            navigation={
              show === "archived" || view === "upcoming"
                ? null
                : view === "week"
                  ? { previous: "Previous week", next: "Next week" }
                  : { previous: "Previous month", next: "Next month" }
            }
            todayRef={todayButton}
            status={status}
            onPrevious={() => move(-1)}
            onNext={() => move(1)}
            onToday={() => {
              if (!workspaceToday) return;
              setAnchor(workspaceToday);
              setSelectedDay(workspaceToday);
              if (show === "archived") onParams({ show: null });
            }}
            onView={(next) =>
              onParams({
                view: next,
                show: show === "archived" ? null : undefined,
              })
            }
            onShow={(next) => onParams({ show: next === "all" ? null : next })}
            onSearch={setSearch}
            onGoToNext={() => {
              if (!nextEvent) return;
              setAnchor(nextEvent.date);
              setSelectedDay(nextEvent.date);
            }}
          />
          {main}
        </div>
      </div>
      <BoardEventSheet
        open={viewerId !== null && selectedEventId !== null && !activeDraft}
        state={sheetState}
        canEdit={sheetEvent !== null && mayEditEvent(sheetEvent)}
        canArchive={sheetEvent !== null && canArchiveEvent(sheetEvent)}
        finalFocus={todayButton}
        onClose={() => onParams({ event: null })}
        onRetry={() => setSelectedRetry((current) => current + 1)}
        onEdit={editEvent}
        onArchive={(event) => beginLifecycle("archive", event)}
      />
      <BoardEventEditorDialog
        draft={activeDraft}
        dirty={draftDirty}
        busy={pending || attachmentPending || recordLinkPending}
        conflict={activeDraft ? conflict : null}
        error={editorError}
        onChange={(patch) =>
          setDraft((current) => (current ? { ...current, ...patch } : null))
        }
        onClose={() => {
          setDraft(null);
          setEditorError(null);
          setConflict(null);
        }}
        onSave={() => {
          void saveEvent();
        }}
        onCheckLatest={() => {
          void checkLatestVersion();
        }}
        onUseLatest={loadLatestEvent}
        onKeepMine={retryWithLatestVersion}
        onAttachmentBusyChange={changeAttachmentPending}
        onRecordLinkBusyChange={changeRecordLinkPending}
        refreshAttachmentVersions={refreshEventAttachmentVersions}
      />
      <BoardCalendarSourceDialog
        open={sourceDialogOpen && canManageSources}
        existing={sources}
        onClose={() => setSourceDialogOpen(false)}
        onAdd={async (input) => {
          await addBoardCalendarSource(boardId, input);
          reportDone("Record source added");
          refreshSources();
        }}
      />
      <ConfirmAction
        open={sourceToRemove !== null}
        title="Remove this record source?"
        description="Its records leave this calendar for everyone who reads the board. The records do not change."
        action="Remove source"
        onCancel={() => setSourceToRemove(null)}
        onConfirm={() => {
          if (sourceToRemove) void confirmRemoveSource(sourceToRemove);
        }}
      />
      {region ? (
        <BoardCardDuePopover
          boardId={boardId}
          card={dueCard?.card ?? null}
          anchor={dueCard?.anchor ?? null}
          region={region}
          onClose={() => setDueCard(null)}
        />
      ) : null}
      <BoardEventPurgeDialog
        open={
          purgeEvent !== null && purgeEvent.boardId === boardId && purgeEnabled
        }
        pending={lifecyclePending}
        enabled={purgeEnabled}
        preview={purgePreview}
        error={purgeError}
        name={purgeName}
        password={purgePassword}
        region={displayRegion}
        onName={setPurgeName}
        onPassword={setPurgePassword}
        onConfirm={() => void confirmEventPurge()}
        onReviewAgain={() => {
          if (purgeEvent) void reviewEventPurge(purgeEvent);
        }}
        onClose={() => {
          purgeRequest.current += 1;
          setPurgeEvent(null);
          setPurgePreview(null);
          setPurgeName("");
          setPurgePassword("");
          setPurgeError("");
        }}
      />
      <BoardEventLifecycleDialog
        open={
          lifecycleTarget?.boardId === boardId &&
          !accessDenied &&
          boardActive &&
          (canConfirmLifecycle(lifecycleTarget) || Boolean(lifecycleError))
        }
        target={lifecycleTarget}
        error={lifecycleError}
        pending={lifecyclePending}
        canConfirm={canConfirmLifecycle(lifecycleTarget)}
        onCancel={() => setLifecycleTarget(null)}
        onConfirm={() => void confirmLifecycle()}
      />
    </section>
  );
}

/** A later Upcoming window: its own reads, filtered like the first. */
function LaterWindow({
  boardId,
  window,
  search,
  liveKey,
  sources,
  hidden,
  show,
  viewerId,
  today,
  calendars,
  region,
  onOpen,
}: {
  boardId: string;
  window: { start: string; end: string };
  search: string;
  liveKey: number;
  sources: readonly CalendarSource[];
  hidden: ReadonlySet<string>;
  show: CalendarShow;
  viewerId: string | null;
  today: string;
  calendars: ReadonlyMap<string, CalendarInfo>;
  region: NonNullable<Parameters<typeof dayLabel>[1]>;
  onOpen: (item: CalendarItem, anchor: HTMLElement) => void;
}) {
  const data = useBoardCalendarWindow({
    boardId,
    window,
    search,
    liveKey,
    sources,
    hidden,
    dueCards: true,
  });
  const query = search.trim().toLocaleLowerCase();
  const items = filterCalendarItems(data.items, {
    hidden,
    show,
    viewerId,
    search: "",
  }).filter(
    (item) =>
      item.kind === "event" ||
      !query ||
      item.title.toLocaleLowerCase().includes(query),
  );
  if (data.eventsError)
    return (
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
        <span role="alert" className="text-danger-text">
          Later events could not be loaded.
        </span>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 xl:min-h-8"
          onClick={() => data.retry(boardEventsCalendarId(boardId))}
        >
          Retry later events
        </Button>
      </div>
    );
  if (!data.eventsReady)
    return (
      <p role="status" className="text-muted-foreground px-4 py-3 text-sm">
        Loading later events…
      </p>
    );
  return (
    <UpcomingGroupList
      groups={upcomingGroups(items, window.start)}
      today={today}
      calendars={calendars}
      region={region}
      onOpen={onOpen}
    />
  );
}
