"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidatesRecords } from "../../openview/adapters/openview-queries";
import { encodeTemporaryDefinition } from "../../openview/domain/temporary-view";
import { moduleHref } from "@/components/department-navigation-model";
import { boardsNavigationKey } from "@/components/boards-navigation-model";
import { departmentTone } from "@/lib/sandbox/department-tone";
import { subscribeWorkspaceInvalidations } from "../../shared/adapters/invalidation-events";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { reportDone, reportError } from "@/lib/feedback";
import { useWorkspaceNavigationRequest } from "@/components/workspace-navigation-guard";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";
import type {
  BoardEvent,
  BoardEventOccurrencePage,
} from "../adapters/board-events-api";
import {
  addMyCalendarSource,
  removeMyCalendarSource,
  type CalendarSource,
} from "../adapters/board-calendar-sources-api";
import type { MyDueCard } from "../adapters/board-due-cards-api";
import type { BoardManagementBoard } from "../adapters/board-management-api";
import type { WorkspaceCalendarSettings } from "../../manage/adapters/workspace-api";
import { parseCalendarShow, type CalendarShow } from "../domain/calendar-dates";
import {
  calendarColor,
  type CalendarItem,
  type CalendarTone,
} from "../domain/calendar-items";
import {
  browserStorage,
  myCalendarHiddenKey,
  readHiddenCalendars,
  writeHiddenCalendars,
} from "../domain/hidden-calendars";
import {
  boardAccessFromLevel,
  postableBoards,
  type MyCalendarBoard,
} from "../domain/my-calendar";
import { boardSourceCalendarId } from "../hooks/use-board-calendar-data";
import {
  MY_DUE_CALENDAR,
  myCalendarKeys,
  myCalendarSourcesOptions,
  myDueCalendarId,
  useMyCalendarWindow,
} from "../hooks/use-my-calendar-data";
import { useMyCalendarSheet } from "../hooks/use-my-calendar-sheet";
import { useBoardEventEditor } from "../hooks/use-board-event-editor";
import { useBoardEventLifecycle } from "../hooks/use-board-event-lifecycle";
import { useCalendarPeriod } from "../hooks/use-calendar-period";
import { canonicalBoardUrl } from "../hooks/use-server-boards";
import { ConfirmAction } from "./ui";
import {
  canEditBoardEvent,
  type BoardCalendarParams,
} from "./server-backed-board-calendar";
import type { CalendarInfo } from "./board-calendar-chips";
import { BoardCalendarToolbar } from "./board-calendar-toolbar";
import { CalendarViews, useCalendarEmpty } from "./board-calendar-views";
import {
  CalendarList,
  CalendarsPopover,
  MiniMonth,
  type CalendarListActions,
  type CalendarListRow,
} from "./board-calendar-rail";
import { BoardCalendarSourceDialog } from "./board-calendar-source-dialog";
import { BoardCardDuePopover } from "./board-card-due-popover";
import { BoardEventSheet } from "./board-event-sheet";
import { BoardEventEditorDialog } from "./board-event-editor-dialog";
import { BoardEventLifecycleDialog } from "./board-event-lifecycle-dialogs";
import {
  BOARD_FIELD_ID,
  MyCalendarBoardField,
  MyLaterWindow,
  shownItems,
} from "./my-calendar-parts";

/** A board's own address for one event: it opens from any month. */
function boardEventHref(board: MyCalendarBoard, eventId: string): string {
  const event = `event=${encodeURIComponent(eventId)}`;
  if (board.scope === null)
    return `/boards?board=${encodeURIComponent(board.id)}&section=calendar&${event}`;
  return canonicalBoardUrl(
    { id: board.id, scope: board.scope, departmentId: board.departmentId },
    "calendar",
    event,
  );
}

/** One board's slice of the window, for the event editor and lifecycle. */
function boardPage(
  board: MyCalendarBoard | null,
  occurrences: readonly BoardEventOccurrencePage["items"][number][],
): BoardEventOccurrencePage | null {
  if (!board || board.revision === null) return null;
  const items = occurrences.filter((item) => item.event.boardId === board.id);
  return {
    items,
    pagination: {
      limit: 100,
      offset: 0,
      count: items.length,
      total: items.length,
      hasMore: false,
    },
    boardRevision: board.revision,
    nextOccurrence: null,
  };
}

/**
 * My calendar (P3b, BR22): one calendar over every active board the person
 * reads, with their own record sources and "My cards · Due". It reuses a
 * board Calendar tab's period, views, rail, sheet, and editor; each board is
 * its own calendar, and editing follows that board's level in the board list.
 */
export function ServerBackedMyCalendar({
  listed,
  departmentIndexOf,
  workspaceCalendar,
  workspaceDateError,
  onRetryWorkspaceDate,
  selectedEventId = null,
  view: requestedView = null,
  show: requestedShow = null,
  onParams,
  onDraftStateChange,
  regionClassName,
}: {
  /** The active boards the person reads, with their level (the board list). */
  listed: readonly BoardManagementBoard[];
  /** A department's place in the sidebar: its mark and its list order. */
  departmentIndexOf: (departmentId: string) => number | null;
  workspaceCalendar: WorkspaceCalendarSettings | undefined;
  workspaceDateError: boolean;
  onRetryWorkspaceDate: () => void;
  selectedEventId?: string | null;
  view?: string | null;
  show?: string | null;
  onParams: (params: BoardCalendarParams) => void;
  onDraftStateChange: (dirty: boolean, pending: boolean) => void;
  /** The page's still region: from 1280px only its panel scrolls. */
  regionClassName: string;
}) {
  const viewerId = useVerifiedWorkspaceUserId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const requestNavigation = useWorkspaceNavigationRequest();
  const [primarySlot, setPrimarySlot] = useState<HTMLElement | null>(null);
  // Closing the event sheet returns focus to the chip that opened it; a
  // sheet opened from an `?event=` link returns it to Today.
  const sheetOpener = useRef<HTMLElement | null>(null);
  const sheetReturn = useRef<HTMLElement | null>(null);
  const period = useCalendarPeriod({ workspaceCalendar, requestedView });
  const { today, region, view, wide, days, title, anchorDate } = period;
  const [search, setSearch] = useState("");
  const hiddenKey = viewerId ? myCalendarHiddenKey(viewerId) : null;
  const [hiddenState, setHiddenState] = useState<{
    key: string;
    ids: string[];
  } | null>(null);
  const hidden = new Set(
    hiddenState && hiddenState.key === hiddenKey
      ? hiddenState.ids
      : hiddenKey
        ? readHiddenCalendars(browserStorage, hiddenKey)
        : [],
  );
  const [dueCard, setDueCard] = useState<{
    card: MyDueCard;
    anchor: HTMLElement;
  } | null>(null);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [sourceToRemove, setSourceToRemove] = useState<CalendarSource | null>(
    null,
  );
  const [editorBoardId, setEditorBoardId] = useState<string | null>(null);
  // Each board's live changes, so an open draft or sheet rechecks its own.
  const [liveKeys, setLiveKeys] = useState<Record<string, number>>({});

  const sourcesQuery = useQuery(myCalendarSourcesOptions());
  const sources = sourcesQuery.data ?? [];
  const data = useMyCalendarWindow({
    window: period.window,
    search,
    sources,
    hidden,
    listed,
    departmentOrder: departmentIndexOf,
  });
  const boards = data.boards;
  const boardById = new Map(boards.map((board) => [board.id, board]));
  const postable = postableBoards(boards);
  const show = parseCalendarShow(requestedShow, {
    mine: postable.length > 0,
    archived: false,
  });
  const sheet = useMyCalendarSheet({
    viewerId,
    selectedEventId,
    occurrences: data.occurrences,
    eventsReady: data.eventsReady,
    boardById,
    region,
  });
  const sheetBoard = sheet.board;
  const sheetAccess = boardAccessFromLevel(sheetBoard?.level ?? null);

  const refetchWindow = () =>
    void queryClient.invalidateQueries({
      queryKey: myCalendarKeys.occurrences,
    });
  // A refused write means a level changed: read the list and window again.
  const refreshAccess = () => {
    refetchWindow();
    void queryClient.invalidateQueries({ queryKey: boardsNavigationKey() });
  };
  const editorBoard =
    (editorBoardId ? boardById.get(editorBoardId) : undefined) ??
    postable[0] ??
    null;
  const editor = useBoardEventEditor({
    boardId: editorBoard?.id ?? "",
    viewerId,
    boardActive: editorBoard !== null,
    liveKey: editorBoard ? (liveKeys[editorBoard.id] ?? 0) : 0,
    canEdit: boardAccessFromLevel(editorBoard?.level ?? null)?.edit === true,
    calendarPage: boardPage(editorBoard, data.occurrences),
    // A board whose events could not be read drops its draft, as a board's
    // own unavailable calendar does.
    eventsState:
      editorBoard?.status === "error"
        ? {
            status: "error",
            error:
              "Calendar unavailable. This board's events could not be read.",
          }
        : { status: "ready", error: null },
    retry: refetchWindow,
    invalidate: refetchWindow,
    onSaved: (savedId) => {
      if (editorBoard) sheet.remember(savedId, editorBoard.id);
      onParams({ event: savedId });
    },
    onAccessDenied: refreshAccess,
  });
  const activeDraft = editor.activeDraft;
  const lifecycle = useBoardEventLifecycle({
    boardId: sheetBoard?.id ?? "",
    viewerId,
    boardActive: sheetBoard !== null,
    refreshKey: 0,
    liveKey: sheetBoard ? (liveKeys[sheetBoard.id] ?? 0) : 0,
    show: "all",
    isPurgeAdmin: false,
    accessDenied: false,
    currentAccess: sheetAccess,
    canManage: sheetAccess?.manage === true,
    canBrowseArchived: false,
    calendarPage: boardPage(sheetBoard, data.occurrences),
    hasDraft: activeDraft !== null,
    selectedEventId,
    onArchivedSelected: () => closeSheet(),
    invalidate: refetchWindow,
    onAccessChanged: refetchWindow,
    onAccessDenied: refreshAccess,
  });

  useEffect(() => {
    onDraftStateChange(
      editor.hasDraft,
      editor.pending ||
        lifecycle.pending ||
        editor.attachmentPending ||
        editor.recordLinkPending,
    );
  }, [
    editor.attachmentPending,
    editor.hasDraft,
    editor.pending,
    editor.recordLinkPending,
    lifecycle.pending,
    onDraftStateChange,
  ]);
  useEffect(() => () => onDraftStateChange(false, false), [onDraftStateChange]);

  // Live (H9): a listed board's events, or the boards themselves, refresh
  // the window; record changes refresh the source reads. Personal sources
  // publish no live event. This uses the one shared stream.
  const listedIds = boards.map((board) => board.id).join(",");
  useEffect(() => {
    const ids = new Set(listedIds.split(",").filter(Boolean));
    return subscribeWorkspaceInvalidations((event) => {
      if (event.type === "resync") {
        for (const queryKey of [
          myCalendarKeys.occurrences,
          myCalendarKeys.sources,
          myCalendarKeys.due,
        ])
          void queryClient.invalidateQueries({ queryKey });
        return;
      }
      if (event.entity === "board_events" || event.entity === "boards") {
        const boardId = event.boardId;
        if (event.entity === "boards" || !boardId || ids.has(boardId))
          void queryClient.invalidateQueries({
            queryKey: myCalendarKeys.occurrences,
          });
        if (boardId && ids.has(boardId))
          setLiveKeys((current) => ({
            ...current,
            [boardId]: (current[boardId] ?? 0) + 1,
          }));
      } else if (invalidatesRecords(event.entity))
        void queryClient.invalidateQueries({
          queryKey: ["boards", "calendar", "source-records"],
        });
    });
  }, [listedIds, queryClient]);

  // ---- Calendars: each board, My cards · Due, and the person's sources ----
  const toneOf = (index: number | null): CalendarTone =>
    index === null
      ? { kind: "neutral" }
      : { kind: "department", tone: departmentTone(index) as 1 | 2 | 3 | 4 };
  const boardColor = (board: MyCalendarBoard) =>
    calendarColor(
      toneOf(
        board.scope === "department" && board.departmentId
          ? departmentIndexOf(board.departmentId)
          : null,
      ),
    );
  const rows: CalendarListRow[] = [
    ...boards.map((board): CalendarListRow => ({
      id: board.calendarId,
      name: board.name,
      color: boardColor(board),
      kind: "events",
    })),
    {
      id: MY_DUE_CALENDAR,
      name: "My cards · Due",
      color: "var(--ink-muted)",
      kind: "due",
    },
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
  // A due card's chip takes its board's name and color (BR58), while the
  // list keeps one "My cards · Due" row.
  const calendars = new Map<string, CalendarInfo>(
    rows.map((row) => [row.id, row]),
  );
  for (const board of boards)
    calendars.set(myDueCalendarId(board.id), {
      id: myDueCalendarId(board.id),
      name: board.name,
      color: boardColor(board),
    });
  for (const card of data.dueCards)
    if (!calendars.has(myDueCalendarId(card.board.id)))
      calendars.set(myDueCalendarId(card.board.id), {
        id: myDueCalendarId(card.board.id),
        name:
          card.board.scope === "company"
            ? "Company announcements"
            : `${card.board.name} announcements`,
        color: "var(--ink-muted)",
      });
  const items = shownItems(data.items, { hidden, show, viewerId, search });

  function writeHidden(ids: string[]) {
    if (!hiddenKey) return;
    setHiddenState({ key: hiddenKey, ids });
    writeHiddenCalendars(browserStorage, hiddenKey, ids);
  }
  function refreshSources() {
    void queryClient.invalidateQueries({ queryKey: myCalendarKeys.sources });
  }
  async function confirmRemoveSource(source: CalendarSource) {
    try {
      await removeMyCalendarSource(source.id);
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
    // A person adds and removes their own sources.
    canManage: true,
    onToggle: (id) =>
      writeHidden(
        hidden.has(id)
          ? [...hidden].filter((entry) => entry !== id)
          : [...hidden, id],
      ),
    onRetry: data.retry,
    onAddSource: () => setSourceDialogOpen(true),
    onRemoveSource: setSourceToRemove,
  };

  function openItem(item: CalendarItem, anchorElement: HTMLElement) {
    const target = item.target;
    if (target.kind === "event") {
      sheetOpener.current = anchorElement;
      sheetReturn.current = anchorElement;
      sheet.remember(
        target.eventId,
        item.calendarId.slice("board:".length),
        item.key,
      );
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
  function closeSheet() {
    const opener = sheetOpener.current;
    sheetReturn.current = opener?.isConnected
      ? opener
      : period.todayRef.current;
    sheetOpener.current = null;
    onParams({ event: null });
  }
  const mayEdit = (event: BoardEvent) =>
    sheetBoard !== null &&
    canEditBoardEvent(event, sheetBoard.id, viewerId, sheetAccess, true);
  const sheetEvent = sheet.event;

  // ---- The period ----
  const empty = useCalendarEmpty({
    period,
    items,
    ready: data.eventsReady,
    search,
    hiddenCount: rows.filter((row) => hidden.has(row.id)).length,
    show,
    nextOccurrence: data.nextOccurrence,
    onClearSearch: () => setSearch(""),
    onShowAll: () => writeHidden([]),
  });
  const showOptions: CalendarShow[] = [
    "all",
    ...(postable.length > 0 ? (["mine"] as const) : []),
  ];

  const main =
    !period.window || !region || !today ? (
      workspaceDateError ? null : (
        <p role="status" className="text-muted-foreground py-8 text-sm">
          Loading the Workspace date…
        </p>
      )
    ) : (
      <CalendarViews
        period={{ ...period, region, today }}
        items={items}
        calendars={calendars}
        ready={data.eventsReady}
        nextOccurrence={data.nextOccurrence}
        empty={empty}
        onOpen={openItem}
        onShowDay={(date) => {
          period.jump(date);
          onParams({ view: "week" });
        }}
        renderLater={(window) => (
          <MyLaterWindow
            window={window}
            search={search}
            sources={sources}
            hidden={hidden}
            show={show}
            viewerId={viewerId}
            listed={listed}
            departmentOrder={departmentIndexOf}
            today={today}
            calendars={calendars}
            region={region}
            onOpen={openItem}
          />
        )}
      />
    );

  return (
    <>
      <div className="slim-ui shrink-0">
        <PageHeader
          className="mb-3"
          title="My calendar"
          description={
            data.eventsReady
              ? `${boards.length} ${boards.length === 1 ? "board" : "boards"}`
              : " "
          }
          actions={<div ref={setPrimarySlot} className="contents" />}
        />
      </div>
      <div className={regionClassName}>
        <div>
          <section
            aria-label="My calendar"
            className="slim-ui flex min-w-0 flex-col gap-3 xl:min-h-0 xl:flex-1"
          >
            {postable.length > 0 && !activeDraft && primarySlot && today
              ? createPortal(
                  <Button
                    type="button"
                    className="min-h-11 xl:min-h-8"
                    onClick={() => {
                      const board = postable[0];
                      if (board.revision === null) return;
                      setEditorBoardId(board.id);
                      editor.newEvent(board.revision, period.newEventDate);
                    }}
                  >
                    <Plus data-icon="inline-start" /> New event
                  </Button>,
                  primarySlot,
                )
              : null}
            {workspaceDateError ? (
              <Alert variant="destructive">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {today
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
            {data.eventsError ? (
              <Alert variant="destructive">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {data.occurrences.length
                      ? "Showing the last loaded events. "
                      : ""}
                    {data.eventsError}
                  </span>
                  <Button
                    variant="outline"
                    className="min-h-11 xl:min-h-8"
                    onClick={() => data.retry("events")}
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
                      today={today}
                      weekStart={period.weekStart}
                      highlight={view === "week" ? days : []}
                      region={region}
                      onPick={period.pick}
                    />
                  ) : null}
                  <CalendarList rows={rows} actions={listActions} personal />
                </aside>
              ) : null}
              <div className="flex min-w-0 flex-col gap-3 xl:min-h-0 xl:flex-1">
                <BoardCalendarToolbar
                  calendars={
                    wide ? null : (
                      <CalendarsPopover
                        rows={rows}
                        actions={listActions}
                        personal
                      />
                    )
                  }
                  title={title}
                  view={view}
                  show={show}
                  showOptions={showOptions}
                  search={search}
                  navigation={
                    view === "upcoming"
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
                    if (today) period.pick(today);
                  }}
                  onView={(next) => onParams({ view: next })}
                  onShow={(next) =>
                    onParams({ show: next === "all" ? null : next })
                  }
                  onSearch={setSearch}
                />
                <p role="status" className="sr-only">
                  {empty.message}
                </p>
                {main}
              </div>
            </div>
          </section>
        </div>
      </div>
      <BoardEventSheet
        open={viewerId !== null && selectedEventId !== null && !activeDraft}
        state={sheet.state}
        calendar={
          sheetBoard && selectedEventId
            ? {
                name: sheetBoard.name,
                color: boardColor(sheetBoard),
                href: boardEventHref(sheetBoard, selectedEventId),
              }
            : { name: "Board", color: "var(--ink-muted)" }
        }
        canEdit={sheetEvent !== null && mayEdit(sheetEvent)}
        canArchive={
          sheetEvent !== null && lifecycle.canArchiveEvent(sheetEvent)
        }
        finalFocus={sheetReturn}
        onClose={closeSheet}
        onRetry={sheet.retry}
        onEdit={(event) => {
          if (!mayEdit(event) || !sheetBoard) return;
          setEditorBoardId(sheetBoard.id);
          editor.editEvent(event);
        }}
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
        leading={
          activeDraft && activeDraft.eventId === null && editorBoard ? (
            <MyCalendarBoardField
              boards={postable}
              value={editorBoard}
              disabled={editor.pending}
              onChange={(board) => {
                if (board.revision === null) return;
                setEditorBoardId(board.id);
                editor.change({
                  boardId: board.id,
                  boardRevision: board.revision,
                });
              }}
            />
          ) : undefined
        }
        leadingId={BOARD_FIELD_ID}
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
        open={sourceDialogOpen}
        existing={sources}
        onClose={() => setSourceDialogOpen(false)}
        onAdd={async (input) => {
          await addMyCalendarSource(input);
          reportDone("Record source added");
          refreshSources();
        }}
      />
      <ConfirmAction
        open={sourceToRemove !== null}
        title="Remove this record source?"
        description="Its records leave My calendar. The records do not change."
        action="Remove source"
        onCancel={() => setSourceToRemove(null)}
        onConfirm={() => {
          if (sourceToRemove) void confirmRemoveSource(sourceToRemove);
        }}
      />
      {region ? (
        <BoardCardDuePopover
          boardId={dueCard?.card.board.id ?? ""}
          boardName={
            dueCard
              ? calendars.get(myDueCalendarId(dueCard.card.board.id))?.name
              : undefined
          }
          card={dueCard?.card ?? null}
          anchor={dueCard?.anchor ?? null}
          region={region}
          onClose={() => setDueCard(null)}
        />
      ) : null}
      <BoardEventLifecycleDialog
        open={
          lifecycle.target !== null &&
          lifecycle.target.boardId === sheetBoard?.id &&
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
    </>
  );
}
