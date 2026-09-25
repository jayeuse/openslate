"use client";

import { createElement, useEffect, useRef, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
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
import { Card, CardContent } from "@/components/ui/card";
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
  type BoardEventOccurrencePage,
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
  type CalendarWindow,
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
import { ServerBoardAttachments } from "./server-backed-board-attachments";
import { ServerBoardReminders } from "./server-backed-board-reminders";
import { ServerBoardRecordLinks } from "./server-backed-board-record-links";

type Occurrence = BoardEventOccurrencePage["items"][number];
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

function formatDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

function formatOccurrenceTime(item: Occurrence): string {
  if (item.event.allDay) {
    return item.start === item.end
      ? `All day · ${formatDate(item.start)}`
      : `All day · ${formatDate(item.start)}–${formatDate(item.end)}`;
  }
  try {
    const formatter = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: item.event.timezoneName,
    });
    return `${formatter.format(new Date(item.start))}–${formatter.format(new Date(item.end))} · ${item.event.timezoneName.replaceAll("_", " ")}`;
  } catch {
    return `${item.start}–${item.end} UTC`;
  }
}

function appearsOnDate(item: Occurrence, date: string): boolean {
  if (item.event.allDay) return item.start <= date && date <= item.end;
  try {
    const localDay = Temporal.PlainDate.from(date);
    const dayStart = localDay
      .toZonedDateTime({
        timeZone: item.event.timezoneName,
        plainTime: "00:00",
      })
      .toInstant();
    const nextDayStart = localDay
      .add({ days: 1 })
      .toZonedDateTime({
        timeZone: item.event.timezoneName,
        plainTime: "00:00",
      })
      .toInstant();
    return (
      Temporal.Instant.compare(
        Temporal.Instant.from(item.start),
        nextDayStart,
      ) < 0 &&
      Temporal.Instant.compare(Temporal.Instant.from(item.end), dayStart) > 0
    );
  } catch {
    return false;
  }
}

export function calendarDayCountLabel(
  count: number,
  incomplete: boolean,
): string {
  if (incomplete && count === 0) return "Event count incomplete";
  const noun = count === 1 ? "event" : "events";
  return incomplete ? `At least ${count} ${noun}` : `${count} ${noun}`;
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

export function ServerBoardCalendarDisplay({
  page,
  window,
  date,
  canEditEvent,
  onEditEvent,
  canArchiveEvent,
  onArchiveEvent,
  includeAttachments = false,
}: {
  page: BoardEventOccurrencePage;
  window: CalendarWindow;
  date?: string;
  canEditEvent?: (event: BoardEvent) => boolean;
  onEditEvent?: (event: BoardEvent) => void;
  canArchiveEvent?: (event: BoardEvent) => boolean;
  onArchiveEvent?: (event: BoardEvent) => void;
  includeAttachments?: boolean;
}) {
  const items = date
    ? page.items.filter((item) => appearsOnDate(item, date))
    : page.items;
  const label = date ? formatDate(date) : window.label;
  return createElement(
    "section",
    { "aria-label": `${label} events` },
    createElement("h3", { className: "text-base font-semibold" }, label),
    items.length === 0
      ? createElement(
          "p",
          { className: "text-muted-foreground mt-2 text-sm" },
          page.pagination.hasMore
            ? date
              ? "No events shown for this day. More events may be available."
              : "No events in the loaded results. More events may be available."
            : date
              ? "No events on this day."
              : "No events in this month.",
        )
      : createElement(
          "ul",
          { className: "mt-3 flex flex-col gap-2" },
          ...items.map((item) =>
            createElement(
              "li",
              {
                key: item.id,
                className: "border-border rounded-xl border p-3",
              },
              createElement(
                "p",
                { className: "font-medium break-words" },
                item.event.title,
              ),
              onEditEvent && canEditEvent?.(item.event)
                ? createElement(
                    "button",
                    {
                      type: "button",
                      className:
                        "border-border bg-card text-foreground hover:bg-muted focus-visible:outline-ring mt-2 inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2",
                      onClick: () => onEditEvent(item.event),
                      "aria-label": `Edit ${item.event.title}`,
                    },
                    "Edit event",
                  )
                : null,
              onArchiveEvent && canArchiveEvent?.(item.event)
                ? createElement(
                    "button",
                    {
                      type: "button",
                      className:
                        "border-border bg-card text-foreground hover:bg-muted focus-visible:outline-ring mt-2 ml-2 inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2",
                      onClick: () => onArchiveEvent(item.event),
                      "aria-label": `Archive ${item.event.title}`,
                    },
                    "Archive event",
                  )
                : null,
              createElement(
                "p",
                { className: "text-muted-foreground mt-1 text-sm" },
                formatOccurrenceTime(item),
              ),
              item.event.details
                ? createElement(
                    "p",
                    {
                      className: "mt-2 whitespace-pre-wrap break-words text-sm",
                    },
                    item.event.details,
                  )
                : null,
              item.event.location
                ? createElement(
                    "p",
                    {
                      className:
                        "text-muted-foreground mt-1 text-sm break-words",
                    },
                    item.event.location,
                  )
                : null,
              item.event.links.length > 0
                ? createElement(
                    "ul",
                    {
                      "aria-label": "Event links",
                      className: "mt-2 flex min-w-0 flex-col gap-1",
                    },
                    ...item.event.links.map((link, index) =>
                      createElement(
                        "li",
                        { key: `${link.url}:${link.label}:${index}` },
                        createElement(
                          "a",
                          {
                            href: link.url,
                            target: "_blank",
                            rel: "noopener noreferrer",
                            referrerPolicy: "no-referrer",
                            className:
                              "text-primary focus-visible:outline-ring inline-block min-h-11 max-w-full rounded-sm py-2.5 text-sm break-words underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2",
                          },
                          link.label,
                          createElement(
                            "span",
                            { className: "sr-only" },
                            " (opens in a new tab)",
                          ),
                        ),
                      ),
                    ),
                  )
                : null,
              includeAttachments
                ? createElement(ServerBoardAttachments, {
                    key: `attachments:${item.event.id}`,
                    access: "read",
                    target: {
                      kind: "event",
                      boardId: item.event.boardId,
                      contentId: item.event.id,
                    },
                  })
                : null,
              includeAttachments
                ? createElement(ServerBoardRecordLinks, {
                    key: `record-links:${item.event.id}`,
                    access: "read",
                    target: {
                      kind: "event",
                      boardId: item.event.boardId,
                      contentId: item.event.id,
                    },
                  })
                : null,
            ),
          ),
        ),
  );
}

function MonthGrid({
  window,
  page,
  selectedDate,
  today,
  onSelect,
}: {
  window: CalendarWindow;
  page: BoardEventOccurrencePage;
  selectedDate: string;
  today: string | null;
  onSelect: (date: string) => void;
}) {
  const first = new Date(`${window.start}T12:00:00Z`);
  const leading = first.getUTCDay();
  const days = Number(window.end.slice(-2));
  const cells = Array.from(
    { length: Math.ceil((leading + days) / 7) * 7 },
    (_, index) => index - leading + 1,
  );
  return (
    <Card className="min-w-0 overflow-hidden">
      <CardContent className="p-0">
        <div
          role="region"
          aria-label={`${window.label} calendar`}
          tabIndex={0}
          className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <div className="min-w-[36rem]">
            <div className="bg-muted/25 grid grid-cols-7 border-b">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((name) => (
                <span
                  key={name}
                  className="text-muted-foreground p-2 text-center text-xs font-medium"
                >
                  {name}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {cells.map((day, index) => {
                if (day < 1 || day > days)
                  return (
                    <div
                      key={`blank-${index}`}
                      aria-hidden="true"
                      className="bg-muted/10 min-h-24 border-r border-b"
                    />
                  );
                const date = `${window.start.slice(0, 8)}${String(day).padStart(2, "0")}`;
                const occurrences = page.items.filter((item) =>
                  appearsOnDate(item, date),
                );
                const countLabel = calendarDayCountLabel(
                  occurrences.length,
                  page.pagination.hasMore,
                );
                return (
                  <div key={date} className="min-h-24 border-r border-b p-1">
                    <Button
                      type="button"
                      variant={selectedDate === date ? "secondary" : "ghost"}
                      className="min-h-11 w-full flex-col items-start justify-center gap-0.5 whitespace-normal"
                      aria-label={`View ${formatDate(date)}, ${countLabel}`}
                      aria-pressed={selectedDate === date}
                      aria-current={today === date ? "date" : undefined}
                      aria-controls="server-board-calendar-day"
                      onClick={() => onSelect(date)}
                    >
                      <span className="font-medium tabular-nums">{day}</span>
                      <span className="text-muted-foreground text-xs">
                        {occurrences.length || page.pagination.hasMore
                          ? countLabel
                          : ""}
                      </span>
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function myEventSchedule(event: BoardEvent): string {
  return event.allDay
    ? `${event.startDate}–${event.endDate} · All day`
    : `${event.startAt}–${event.endAt} · ${event.timezoneName}`;
}

function MyEventsDisplay({
  page,
  onEdit,
  onPrevious,
  onNext,
}: {
  page: BoardEventPage;
  onEdit: (event: BoardEvent) => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const first = page.pagination.count === 0 ? 0 : page.pagination.offset + 1;
  const last = page.pagination.offset + page.pagination.count;
  return (
    <section aria-label="My events" className="space-y-4">
      <p role="status" className="text-muted-foreground text-sm">
        Showing {first}–{last} of {page.pagination.total} events you created.
      </p>
      {page.items.length === 0 ? (
        <BoardEmpty
          title="No events created by you"
          description="Events you create appear here, including events that are not addressed to you."
        />
      ) : (
        <ul className="space-y-3" aria-label="Events you created">
          {page.items.map((event) => (
            <li
              key={event.id}
              className="border-border flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
            >
              <div className="min-w-0 space-y-1">
                <h3 className="font-medium break-words">{event.title}</h3>
                <p className="text-muted-foreground text-sm">
                  {myEventSchedule(event)} · Audience: {event.audience.kind}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                aria-label={`Edit ${event.title}`}
                onClick={() => onEdit(event)}
              >
                Edit
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2" aria-label="My events pages">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={page.pagination.offset === 0}
          onClick={onPrevious}
        >
          Previous events
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={!page.pagination.hasMore}
          onClick={onNext}
        >
          Next events
        </Button>
      </div>
    </section>
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

  return (
    <section
      aria-label="Board calendar"
      className="flex min-w-0 flex-col gap-4"
    >
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Button
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
            className="min-w-32 text-center text-lg font-semibold"
            aria-live="polite"
          >
            {calendarWindow?.label ?? "Calendar"}
          </h2>
          <Button
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
            variant={view === "agenda" ? "secondary" : "ghost"}
            className="min-h-11"
            aria-pressed={view === "agenda"}
            onClick={() => setView("agenda")}
          >
            Agenda
          </Button>
          <Button
            variant={view === "month" ? "secondary" : "ghost"}
            className="min-h-11"
            aria-pressed={view === "month"}
            onClick={() => setView("month")}
          >
            Month
          </Button>
          {canManage && !activeDraft && (
            <Button
              variant={view === "archived" ? "secondary" : "ghost"}
              className="min-h-11"
              aria-pressed={view === "archived"}
              onClick={() => {
                setArchivedState(null);
                setView("archived");
              }}
            >
              Archived events
            </Button>
          )}
          {canEdit && !activeDraft && (
            <Button
              variant={view === "mine" ? "secondary" : "ghost"}
              className="min-h-11"
              aria-pressed={view === "mine"}
              onClick={() => {
                setMyEventsOffset(0);
                setMyEventsState(null);
                setMyEventsRetry((value) => value + 1);
                setView("mine");
              }}
            >
              My events
            </Button>
          )}
        </div>
      </div>
      {view !== "archived" && view !== "mine" && calendarWindow && (
        <label className="grid max-w-xl gap-1 text-sm font-medium">
          <span>Search events</span>
          <input
            type="search"
            className="border-input bg-background min-h-11 rounded-md border px-3 font-normal"
            maxLength={100}
            value={search}
            disabled={activeDraft !== null}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </label>
      )}
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
      {view !== "archived" && canEdit && calendarPage && !activeDraft && (
        <div className="flex justify-end">
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
            New event
          </Button>
        </div>
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
            {view === "month" && (
              <MonthGrid
                window={calendarWindow}
                page={calendarPage}
                selectedDate={selectedCalendarDate}
                today={workspaceToday}
                onSelect={setSelectedDate}
              />
            )}
            <div id="server-board-calendar-day">
              <ServerBoardCalendarDisplay
                page={calendarPage}
                window={calendarWindow}
                date={view === "month" ? selectedCalendarDate : undefined}
                includeAttachments
                canEditEvent={mayEditEvent}
                onEditEvent={(event) => {
                  if (!mayEditEvent(event)) return;
                  setEditorError(null);
                  setEditorNotice(null);
                  setConflict(null);
                  setDraft(boardEventDraftFromEvent(event));
                }}
                canArchiveEvent={(event) =>
                  !activeDraft &&
                  prepareBoardEventLifecycleAction(
                    event,
                    boardId,
                    calendarPage.boardRevision,
                    currentAccess,
                    boardActive,
                    "archive",
                  ) !== null
                }
                onArchiveEvent={(event) => beginLifecycle("archive", event)}
              />
            </div>
            <ServerBoardReminders
              boardId={boardId}
              boardActive={boardActive}
              occurrences={calendarPage.items}
              refreshKey={calendarPage.boardRevision}
            />
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
