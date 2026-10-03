"use client";

import { createElement, useState, type ReactNode } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type {
  BoardEvent,
  BoardEventPage,
  BoardEventOccurrencePage,
} from "../adapters/board-events-api";
import type { CalendarWindow } from "../hooks/use-server-board-events";
import { BoardEmpty } from "./ui";
import { ServerBoardAttachments } from "./server-backed-board-attachments";
import { ServerBoardRecordLinks } from "./server-backed-board-record-links";

type Occurrence = BoardEventOccurrencePage["items"][number];

function formatDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

function formatOccurrenceTime(
  item: Pick<Occurrence, "event" | "start" | "end">,
): string {
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

function formatGridOccurrenceTime(item: Occurrence): string {
  if (item.event.allDay) return "All day";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: item.event.timezoneName,
    }).format(new Date(item.start));
  } catch {
    return item.start.slice(11, 16) || "Time";
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

function CalendarEventDisclosure({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return createElement(
    "details",
    {
      className: "border-border mt-2 rounded-md border p-3",
      onToggle: (event) => setOpen(event.currentTarget.hasAttribute("open")),
    },
    createElement(
      "summary",
      { className: "min-h-11 cursor-pointer py-2 font-medium" },
      "View event",
    ),
    open ? createElement("div", { className: "mt-2" }, children) : null,
  );
}

function eventContent(
  event: BoardEvent,
  compact: boolean,
  includeAttachments: boolean,
) {
  const details = event.details
    ? createElement(
        "p",
        {
          className: `${compact ? "" : "mt-2 "}whitespace-pre-wrap break-words text-sm`,
        },
        event.details,
      )
    : null;
  const location = event.location
    ? createElement(
        "p",
        {
          className: "text-muted-foreground mt-1 text-sm break-words",
        },
        event.location,
      )
    : null;
  const links =
    event.links.length > 0
      ? createElement(
          "ul",
          {
            "aria-label": "Event links",
            className: `${compact ? "" : "mt-2 "}flex min-w-0 flex-col gap-1`,
          },
          ...event.links.map((link, index) =>
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
      : null;
  const attachments = includeAttachments
    ? createElement(ServerBoardAttachments, {
        key: `attachments:${event.id}`,
        access: "read",
        target: {
          kind: "event",
          boardId: event.boardId,
          contentId: event.id,
        },
      })
    : null;
  const recordLinks = includeAttachments
    ? createElement(ServerBoardRecordLinks, {
        key: `record-links:${event.id}`,
        access: "read",
        target: {
          kind: "event",
          boardId: event.boardId,
          contentId: event.id,
        },
      })
    : null;
  return { details, location, links, attachments, recordLinks };
}

export function boardEventTimeLabel(event: BoardEvent): string {
  return formatOccurrenceTime({
    event,
    start: event.startDate ?? event.startAt ?? "",
    end: event.endDate ?? event.endAt ?? "",
  });
}

export function ServerBoardEventReaderContent({
  event,
}: {
  event: BoardEvent;
}) {
  const { details, location, links, attachments, recordLinks } = eventContent(
    event,
    false,
    true,
  );
  return createElement(
    "div",
    { className: "mt-5 space-y-3" },
    details,
    location,
    links,
    attachments,
    recordLinks,
  );
}

export function ServerBoardCalendarDisplay({
  page,
  window,
  date,
  compact = false,
  canEditEvent,
  onEditEvent,
  canArchiveEvent,
  onArchiveEvent,
  includeAttachments = false,
}: {
  page: BoardEventOccurrencePage;
  window: CalendarWindow;
  date?: string;
  compact?: boolean;
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
          ...items.map((item) => {
            const title = createElement(
              "p",
              { className: "font-medium break-words" },
              item.event.title,
            );
            const editAction =
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
                : null;
            const archiveAction =
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
                : null;
            const time = createElement(
              "p",
              { className: "text-muted-foreground mt-1 text-sm" },
              formatOccurrenceTime(item),
            );
            const { details, location, links, attachments, recordLinks } =
              eventContent(item.event, compact, includeAttachments);
            const onDemandActions =
              editAction || archiveAction
                ? createElement(
                    "div",
                    { className: "flex flex-wrap items-center gap-2" },
                    editAction,
                    archiveAction,
                  )
                : null;
            const hasDisclosureContent = Boolean(
              details || links || attachments || recordLinks || onDemandActions,
            );
            const disclosure =
              compact && hasDisclosureContent
                ? createElement(
                    CalendarEventDisclosure,
                    null,
                    createElement(
                      "div",
                      { className: "space-y-3" },
                      details,
                      links,
                      attachments,
                      recordLinks,
                      onDemandActions,
                    ),
                  )
                : null;
            const contents = compact
              ? [title, time, location, disclosure]
              : [
                  title,
                  editAction,
                  archiveAction,
                  time,
                  details,
                  location,
                  links,
                  attachments,
                  recordLinks,
                ];
            return createElement(
              "li",
              {
                key: item.id,
                className: "border-border rounded-xl border p-3",
              },
              ...contents,
            );
          }),
        ),
  );
}

export function MonthGrid({
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
                const visibleOccurrences = occurrences.slice(0, 2);
                const hiddenOccurrenceCount =
                  occurrences.length - visibleOccurrences.length;
                return (
                  <div
                    key={date}
                    className="min-h-24 min-w-0 border-r border-b p-1"
                  >
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
                    {visibleOccurrences.length > 0 && (
                      <ul
                        aria-label={`${formatDate(date)} event titles`}
                        className="mt-1 space-y-1"
                      >
                        {visibleOccurrences.map((item) => (
                          <li
                            key={item.id}
                            className="bg-muted/50 flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-xs"
                          >
                            <span className="text-muted-foreground shrink-0 tabular-nums">
                              {formatGridOccurrenceTime(item)}
                            </span>
                            <span className="min-w-0 truncate font-medium">
                              {item.event.title}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {hiddenOccurrenceCount > 0 && (
                      <p className="text-muted-foreground mt-1 px-1 text-xs">
                        +{hiddenOccurrenceCount} more
                      </p>
                    )}
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

export function MyEventsDisplay({
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
                  {myEventSchedule(event)}
                  {event.reminders.length > 0
                    ? ` · ${event.reminders.length} ${event.reminders.length === 1 ? "reminder" : "reminders"}`
                    : ""}
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
