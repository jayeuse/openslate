"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { subscribeWorkspaceInvalidations } from "../../shared/adapters/invalidation-events";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { reportDone, reportError } from "@/lib/feedback";
import { useWorkspaceNavigationRequest } from "@/components/workspace-navigation-guard";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "@/components/systems/shared/runtime/workspace-identity";
import { readBoardEvent, type BoardEvent } from "../adapters/board-events-api";
import {
  addBoardCalendarSource,
  addMyCalendarSource,
  removeBoardCalendarSource,
  type CalendarSource,
} from "../adapters/board-calendar-sources-api";
import type { DueCard } from "../adapters/board-due-cards-api";
import type { WorkspaceCalendarSettings } from "../../manage/adapters/workspace-api";
import {
  getMyBoardAccess,
  type BoardMyAccess,
} from "../adapters/board-tools-api";
import {
  parseCalendarShow,
  type CalendarShow,
  type CalendarView,
} from "../domain/calendar-dates";
import {
  calendarColor,
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
import { useBoardEventEditor } from "../hooks/use-board-event-editor";
import { useCalendarPeriod } from "../hooks/use-calendar-period";
import { useBoardEventLifecycle } from "../hooks/use-board-event-lifecycle";
import { BoardEmpty, ConfirmAction } from "./ui";
import {
  prepareBoardEventLifecycleAction,
  ServerArchivedBoardEventsDisplay,
} from "./server-backed-board-event-lifecycle";
import {
  boardEventTimeLabel,
  boardOccurrenceTimeLabel,
} from "./server-board-calendar-display";
import { dayLabel, type CalendarInfo } from "./board-calendar-chips";
import { BoardCalendarToolbar } from "./board-calendar-toolbar";
import { CalendarViews, useCalendarEmpty } from "./board-calendar-views";
import { UpcomingGroupList } from "./board-calendar-upcoming";
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
  // Closing the event sheet returns focus to the chip or row that opened
  // it; a sheet opened from an `?event=` link returns it to Today.
  const sheetOpener = useRef<HTMLElement | null>(null);
  const sheetReturn = useRef<HTMLElement | null>(null);
  const [selectedRetry, setSelectedRetry] = useState(0);
  const selectedKey = `${viewerId}:${boardId}:${selectedEventId}:${refreshKey}:${selectedRetry}`;
  const [selectedDetail, setSelectedDetail] = useState<{
    key: string;
    event: BoardEvent | null;
    error: string | null;
    refused: boolean;
  } | null>(null);
  const period = useCalendarPeriod({ workspaceCalendar, requestedView });
  const {
    today: workspaceToday,
    displayRegion,
    region,
    view,
    wide,
    days,
    title,
    anchorDate,
  } = period;
  const [search, setSearch] = useState("");
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
  const [access, setAccess] = useState<{
    key: string;
    status: "loading" | "ready" | "denied" | "error";
    value: BoardMyAccess | null;
  } | null>(null);
  const [accessVersion, setAccessVersion] = useState(0);
  const [blockedBoardId, setBlockedBoardId] = useState<string | null>(null);
  const calendarWindow = period.window;
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
  const selectedCalendarDate = period.newEventDate;
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
  const show = parseCalendarShow(requestedShow, {
    mine: canEdit,
    archived: canBrowseArchived,
  });
  // The event draft and the event lifecycle each have one owner.
  const editor = useBoardEventEditor({
    boardId,
    viewerId,
    boardActive,
    liveKey,
    canEdit,
    calendarPage,
    eventsState: state,
    retry,
    invalidate,
    onSaved: (savedId) => {
      // After Create or Save, the event sheet opens on it (BR21).
      setSelectedOccurrence(null);
      onParams({ event: savedId });
      setAccessVersion((value) => value + 1);
    },
    onAccessDenied: (recheck) => {
      setBlockedBoardId(boardId);
      setAccess({ key: accessKey, status: "denied", value: null });
      if (recheck) setAccessVersion((value) => value + 1);
    },
  });
  const activeDraft = editor.activeDraft;
  const lifecycle = useBoardEventLifecycle({
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
    hasDraft: activeDraft !== null,
    selectedEventId,
    // Archiving the open event closes its sheet, as Close does.
    onArchivedSelected: () => closeSheet(),
    invalidate,
    onAccessChanged: () => setAccessVersion((value) => value + 1),
    onAccessDenied: () => {
      setBlockedBoardId(boardId);
      editor.dropDraft();
      setAccessVersion((value) => value + 1);
    },
  });
  const archivedPage = lifecycle.archived.page;

  useEffect(() => {
    if (!viewerId || selectedEventId === null || accessDenied) {
      setSelectedDetail(null);
      return;
    }
    let active = true;
    void readBoardEvent(boardId, selectedEventId)
      .then((event) => {
        if (active)
          setSelectedDetail({
            key: selectedKey,
            event,
            error: null,
            refused: false,
          });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const refused =
          error instanceof ApiError && [401, 403, 404].includes(error.status);
        setSelectedDetail({
          key: selectedKey,
          event: null,
          error: refused
            ? "This event is unavailable or you no longer have access."
            : "Could not load the event. Try again.",
          refused,
        });
      });
    return () => {
      active = false;
    };
  }, [accessDenied, boardId, selectedEventId, selectedKey, viewerId]);

  useEffect(() => {
    onDraftStateChange?.(
      boardId,
      editor.hasDraft,
      editor.pending ||
        lifecycle.pending ||
        editor.attachmentPending ||
        editor.recordLinkPending,
    );
  }, [
    editor.attachmentPending,
    editor.recordLinkPending,
    boardId,
    editor.hasDraft,
    lifecycle.pending,
    onDraftStateChange,
    editor.pending,
  ]);

  useEffect(
    () => () => onDraftStateChange?.(boardId, false, false),
    [boardId, onDraftStateChange],
  );

  useEffect(() => {
    invalidateRef.current = invalidate;
  }, [invalidate]);

  useEffect(() => {
    setBlockedBoardId(null);
  }, [boardId]);

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
          editor.dropDraft();
          lifecycle.closeOnDenial();
          editor.setEditorError("Event editing is unavailable for this Board.");
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

  function mayEditEvent(event: BoardEvent): boolean {
    return canEditBoardEvent(
      event,
      boardId,
      viewerId,
      currentAccess,
      boardActive,
    );
  }

  function editEvent(event: BoardEvent) {
    if (mayEditEvent(event)) editor.editEvent(event);
  }

  // ---- The calendars, their items, and what opens them ----
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
      sheetOpener.current = anchorElement;
      sheetReturn.current = anchorElement;
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
          retryable: !currentSelectedDetail.refused,
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
  const nextEvent = data.nextOccurrence;
  const hiddenCount = rows.filter((row) => hidden.has(row.id)).length;
  // A search or hidden calendar that emptied the view says so first; the
  // words show on the grid, and one live region announces them.
  const empty = useCalendarEmpty({
    period,
    items,
    ready: data.eventsReady,
    search,
    hiddenCount,
    show,
    nextOccurrence: nextEvent,
    onClearSearch: () => setSearch(""),
    onShowAll: () => {
      if (!hiddenKey) return;
      setHiddenState({ key: hiddenKey, ids: [] });
      writeHiddenCalendars(browserStorage, hiddenKey, []);
    },
  });
  const showOptions: CalendarShow[] = [
    "all",
    ...(canEdit ? (["mine"] as const) : []),
    ...(canBrowseArchived ? (["archived"] as const) : []),
  ];
  function closeSheet() {
    const opener = sheetOpener.current;
    sheetReturn.current = opener?.isConnected
      ? opener
      : period.todayRef.current;
    sheetOpener.current = null;
    onParams({ event: null });
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
              {archivedPage.items.length === 0
                ? 0
                : lifecycle.archived.offset + 1}
              –{lifecycle.archived.offset + archivedPage.items.length}
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
              onRestoreEvent={(event) =>
                lifecycle.beginLifecycle("restore", event)
              }
              canPurgeEvent={lifecycle.purge.mayPurge}
              onPurgeEvent={(event) => void lifecycle.purge.review(event)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 xl:min-h-8"
                disabled={lifecycle.archived.offset === 0}
                onClick={() =>
                  lifecycle.archived.setOffset((current) =>
                    Math.max(0, current - 25),
                  )
                }
              >
                Previous archived events
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 xl:min-h-8"
                disabled={!archivedPage.pagination.hasMore}
                onClick={() =>
                  lifecycle.archived.setOffset((current) => current + 25)
                }
              >
                Next archived events
              </Button>
            </div>
          </>
        ) : null}
        {canBrowseArchived &&
        lifecycle.archived.state?.key === lifecycle.archived.key &&
        lifecycle.archived.state.status === "loading" ? (
          <p role="status" className="text-muted-foreground py-8 text-sm">
            Loading archived events…
          </p>
        ) : null}
        {canBrowseArchived &&
        lifecycle.archived.state?.key === lifecycle.archived.key &&
        lifecycle.archived.state.error ? (
          <Alert variant="destructive">
            {lifecycle.archived.state.error}
            <Button
              type="button"
              variant="outline"
              className="ml-2 min-h-11 xl:min-h-8"
              onClick={lifecycle.archived.retry}
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
  } else {
    main = (
      <CalendarViews
        period={{ ...period, region, today: workspaceToday }}
        items={items}
        calendars={calendars}
        ready={data.eventsReady}
        nextOccurrence={nextEvent}
        empty={empty}
        onOpen={openItem}
        onShowDay={(date) => {
          period.jump(date);
          onParams({ view: "week" });
        }}
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
            onClick={() =>
              editor.newEvent(calendarPage.boardRevision, selectedCalendarDate)
            }
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
      {editor.editorError && !activeDraft ? (
        <Alert variant="destructive">{editor.editorError}</Alert>
      ) : null}
      {lifecycle.error && !lifecycle.target ? (
        <Alert variant="destructive">{lifecycle.error}</Alert>
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
                weekStart={period.weekStart}
                highlight={view === "week" ? days : []}
                region={region}
                onPick={period.pick}
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
            todayRef={period.todayRef}
            titleRef={period.titleRef}
            onPrevious={() => period.move(-1)}
            onNext={() => period.move(1)}
            onToday={() => {
              if (!workspaceToday) return;
              period.pick(workspaceToday);
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
          />
          <p role="status" className="sr-only">
            {empty.message}
          </p>
          {main}
        </div>
      </div>
      <BoardEventSheet
        open={viewerId !== null && selectedEventId !== null && !activeDraft}
        state={sheetState}
        calendar={{ name: calendarName, color: boardColor }}
        canEdit={sheetEvent !== null && mayEditEvent(sheetEvent)}
        canArchive={
          sheetEvent !== null && lifecycle.canArchiveEvent(sheetEvent)
        }
        finalFocus={sheetReturn}
        onClose={closeSheet}
        onRetry={() => setSelectedRetry((current) => current + 1)}
        onEdit={editEvent}
        onArchive={(event) => lifecycle.beginLifecycle("archive", event)}
      />
      <BoardEventEditorDialog
        draft={activeDraft}
        dirty={editor.draftDirty}
        busy={
          editor.pending || editor.attachmentPending || editor.recordLinkPending
        }
        conflict={editor.conflict}
        error={editor.editorError}
        onChange={editor.change}
        onClose={editor.close}
        onSave={() => {
          void editor.saveEvent();
        }}
        onCheckLatest={() => {
          void editor.checkLatestVersion();
        }}
        onUseLatest={editor.loadLatestEvent}
        onKeepMine={editor.retryWithLatestVersion}
        onAttachmentBusyChange={editor.changeAttachmentPending}
        onRecordLinkBusyChange={editor.changeRecordLinkPending}
        refreshAttachmentVersions={editor.refreshAttachmentVersions}
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
          lifecycle.purge.event !== null &&
          lifecycle.purge.event.boardId === boardId &&
          lifecycle.purge.enabled
        }
        pending={lifecycle.pending}
        enabled={lifecycle.purge.enabled}
        preview={lifecycle.purge.preview}
        error={lifecycle.purge.error}
        name={lifecycle.purge.name}
        password={lifecycle.purge.password}
        region={displayRegion}
        onName={lifecycle.purge.setName}
        onPassword={lifecycle.purge.setPassword}
        onConfirm={() => void lifecycle.purge.confirm()}
        onReviewAgain={() => {
          const event = lifecycle.purge.event;
          if (event) void lifecycle.purge.review(event);
        }}
        onClose={lifecycle.purge.close}
      />
      <BoardEventLifecycleDialog
        open={
          lifecycle.target?.boardId === boardId &&
          !accessDenied &&
          boardActive &&
          (lifecycle.canConfirmLifecycle(lifecycle.target) ||
            Boolean(lifecycle.error))
        }
        target={lifecycle.target}
        error={lifecycle.error}
        pending={lifecycle.pending}
        canConfirm={lifecycle.canConfirmLifecycle(lifecycle.target)}
        onCancel={lifecycle.cancelLifecycle}
        onConfirm={() => void lifecycle.confirmLifecycle()}
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
