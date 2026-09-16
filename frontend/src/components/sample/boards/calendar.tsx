"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Edit3,
  Eye,
  MapPin,
  Plus,
  Repeat2,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Calendar as MonthCalendar } from "@/components/ui/calendar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { datetimeInputToUtc, formatDateTimeLocal } from "@/lib/date-time";
import type { SampleRecord } from "@/components/sample/sample-data";
import { BoardEmpty, ConfirmAction, EditSheet } from "./ui";
import {
  AudienceField,
  ContentAttachments,
  ContentFields,
} from "./content-fields";
import type { BoardPerson } from "./content-fields";
import {
  BOARD_INPUT_LIMITS,
  BOARD_TIMEZONE,
  type BoardAudience,
  type BoardEvent,
  type BoardPersonalState,
  type BoardReminder,
  type BoardRecurrence,
} from "./model";
import { boardAudienceLabel, expandBoardEventOccurrences } from "./content";
import type { BoardMutationResult } from "./commands";
import { releaseLocalAttachment } from "../comms/local-attachments";

type CalendarRole = { id: string; name: string };

export type BoardCalendarCapabilities = {
  view: boolean;
  edit: boolean;
  manage: boolean;
};

export type BoardCalendarMutationScope = "single" | "series";
export type BoardReminderOption = "now" | "start" | "15m" | "1d";
export type BoardCalendarEventAction = "archive" | "restore" | "delete";

export interface BoardCalendarProps {
  boardId: string;
  boardName?: string;
  boardArchived?: boolean;
  events: readonly BoardEvent[];
  records: readonly SampleRecord[];
  viewer: Pick<BoardPerson, "id" | "name" | "active">;
  people: readonly BoardPerson[];
  roles: readonly CalendarRole[];
  departments: readonly string[];
  capabilities: BoardCalendarCapabilities;
  timezone?: string;
  selectedDate: string;
  personal: Pick<
    BoardPersonalState,
    "identityId" | "calendarView" | "reminders"
  >;
  previewAs?: string | null;
  onDateChange: (date: string) => void;
  onSave: (
    event: BoardEvent,
    scope: BoardCalendarMutationScope,
    original?: BoardEvent,
  ) => BoardMutationResult;
  onAction: (
    event: BoardEvent,
    action: BoardCalendarEventAction,
  ) => BoardMutationResult;
  onRemind: (
    event: BoardEvent,
    option: BoardReminderOption,
    occurrenceStart: string,
  ) => BoardMutationResult;
  onCancelReminder: (
    event: BoardEvent,
    occurrenceStart: string,
  ) => BoardMutationResult;
  onPreferenceChange: (
    patch: Partial<Pick<BoardPersonalState, "calendarView">>,
  ) => BoardMutationResult;
}

type DraftEvent = {
  id: string;
  boardId: string;
  authorId: string;
  title: string;
  details: string;
  location: string;
  start: string;
  end: string;
  allDay: boolean;
  timezone: string;
  audience: BoardAudience;
  recurrence: BoardRecurrence;
  endDate: string;
  attachments: BoardEvent["attachments"];
  links: BoardEvent["links"];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  original?: BoardEvent;
};

type PendingDelete = {
  event: BoardEvent;
  scope: BoardCalendarMutationScope;
} | null;

type EventOccurrence = {
  event: BoardEvent;
  date: string;
  endDate: string;
  occurrenceStart: string;
};

const MAX_AGENDA_DAYS = 14;
const MAX_UP_NEXT_OCCURRENCES = 3;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dateKeyToDate(key: string): Date {
  if (!DATE_PATTERN.test(key)) return new Date();
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function dateToKey(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function addDateKey(key: string, amount: number): string {
  const date = dateKeyToDate(key);
  date.setUTCDate(date.getUTCDate() + amount);
  return dateToKey(date);
}

function monthStart(key: string): string {
  const date = dateKeyToDate(key);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-01`;
}

function monthEnd(key: string): string {
  const date = dateKeyToDate(key);
  const next = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 12),
  );
  return dateToKey(next);
}

function formatMonth(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatDay(key: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(dateKeyToDate(key));
}

function formatShortDay(key: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(dateKeyToDate(key));
}

function todayKey(timezone: string): string {
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return dateToKey(
      new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12)),
    );
  }
}

function zonedDateKey(value: string, timezone: string): string {
  if (DATE_PATTERN.test(value)) return value.slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value.slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return value.slice(0, 10);
  }
}

function displayTime(value: string, timezone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return "";
  }
}

function inputDateTime(
  value: string,
  timezone: string,
  fallbackDate: string,
): string {
  if (DATE_PATTERN.test(value)) return `${value}T09:00`;
  const local = formatDateTimeLocal(value, timezone);
  return local || `${fallbackDate}T09:00`;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

function cloneEvent(event: BoardEvent): BoardEvent {
  return {
    ...event,
    attachments: event.attachments.map((attachment) => ({ ...attachment })),
    links: event.links.map((link) => ({ ...link })),
  };
}

function releaseDraftAttachments(draft: DraftEvent | null): void {
  if (!draft) return;
  const originalIds = new Set(
    (draft.original?.attachments ?? []).map((attachment) => attachment.id),
  );
  for (const attachment of draft.attachments) {
    if (!originalIds.has(attachment.id)) releaseLocalAttachment(attachment.id);
  }
}

function eventDateKey(event: BoardEvent, timezone: string): string {
  return zonedDateKey(
    event.start,
    event.allDay ? "UTC" : event.timezone || timezone,
  );
}

function eventEndDateKey(event: BoardEvent, timezone: string): string {
  const end = event.end || event.start;
  const endTimestamp = Date.parse(end);
  return zonedDateKey(
    event.allDay || !Number.isFinite(endTimestamp)
      ? end
      : new Date(endTimestamp - 1).toISOString(),
    event.allDay ? "UTC" : event.timezone || timezone,
  );
}

function expandOccurrences(
  events: readonly BoardEvent[],
  boardId: string,
  start: string,
  end: string,
  timezone: string,
  query: string,
): EventOccurrence[] {
  const normalizedQuery = query.trim().toLowerCase();
  return events
    .flatMap((event) => {
      if (event.boardId !== boardId || event.archived) return [];
      if (
        normalizedQuery &&
        ![event.title, event.details, event.location]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery)
      )
        return [];
      return expandBoardEventOccurrences(event, { start, end }).occurrences.map(
        (occurrence) => ({
          event,
          date: occurrence.date,
          endDate: eventEndDateKey({ ...event, end: occurrence.end }, timezone),
          occurrenceStart: occurrence.start,
        }),
      );
    })
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        Number(right.event.allDay) - Number(left.event.allDay) ||
        left.occurrenceStart.localeCompare(right.occurrenceStart) ||
        left.event.id.localeCompare(right.event.id),
    );
}

function archivedOccurrences(
  events: readonly BoardEvent[],
  boardId: string,
  timezone: string,
  query: string,
): EventOccurrence[] {
  const normalizedQuery = query.trim().toLowerCase();
  return events.flatMap((event) => {
    if (event.boardId !== boardId || !event.archived) return [];
    if (
      normalizedQuery &&
      ![event.title, event.details, event.location]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery)
    ) {
      return [];
    }
    return [
      {
        event,
        date: eventDateKey(event, timezone),
        endDate: eventEndDateKey(event, timezone),
        occurrenceStart: event.start,
      },
    ];
  });
}

function formatCalendarSummary(
  occurrences: readonly EventOccurrence[],
): string {
  const eventSeries = new Set(
    occurrences.map((occurrence) => occurrence.event.id),
  );
  const recurringSeries = new Set(
    occurrences
      .filter((occurrence) => occurrence.event.recurrence !== "none")
      .map((occurrence) => occurrence.event.id),
  );
  const occurrenceLabel = `${occurrences.length} scheduled ${occurrences.length === 1 ? "date" : "dates"}`;
  if (!occurrences.length) return "No scheduled dates in this view";

  if (recurringSeries.size === eventSeries.size && eventSeries.size > 0) {
    return `${occurrenceLabel} · ${eventSeries.size} ${eventSeries.size === 1 ? "recurring event" : "recurring events"}`;
  }

  const seriesLabel = `${eventSeries.size} ${eventSeries.size === 1 ? "event" : "events"}`;
  return recurringSeries.size > 0
    ? `${occurrenceLabel} · ${seriesLabel} (${recurringSeries.size} recurring)`
    : `${occurrenceLabel} · ${seriesLabel}`;
}

function newDraft(
  boardId: string,
  authorId: string,
  selectedDate: string,
  timezone: string,
): DraftEvent {
  const timestamp = new Date().toISOString();
  return {
    id: "",
    boardId,
    authorId,
    title: "",
    details: "",
    location: "",
    start: `${selectedDate}T09:00`,
    end: `${selectedDate}T10:00`,
    allDay: false,
    timezone,
    audience: { kind: "everyone" },
    recurrence: "none",
    endDate: "",
    attachments: [],
    links: [],
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function draftFromEvent(event: BoardEvent, timezone: string): DraftEvent {
  return {
    ...event,
    start: event.allDay
      ? eventDateKey(event, timezone)
      : inputDateTime(
          event.start,
          event.timezone || timezone,
          eventDateKey(event, timezone),
        ),
    end: event.allDay
      ? eventEndDateKey(event, timezone)
      : inputDateTime(
          event.end || event.start,
          event.timezone || timezone,
          eventDateKey(event, timezone),
        ),
    endDate: event.endDate ?? "",
  };
}

function serializedDraft(draft: DraftEvent | null): string {
  if (!draft) return "";
  return JSON.stringify(draft);
}

function isPendingReminder(
  reminders: readonly BoardReminder[],
  event: BoardEvent,
  occurrence: string,
  identityId: string,
): boolean {
  return reminders.some(
    (reminder) =>
      reminder.eventId === event.id &&
      reminder.identityId === identityId &&
      reminder.occurrenceStart === occurrence &&
      reminder.status === "pending",
  );
}

function safeEventMutation(
  callback: () => BoardMutationResult,
): BoardMutationResult {
  try {
    return callback();
  } catch {
    return {
      ok: false,
      error: "The calendar change could not be saved. Try again.",
    };
  }
}

function EventMeta({
  event,
  occurrence,
  timezone,
}: {
  event: BoardEvent;
  occurrence: EventOccurrence;
  timezone: string;
}) {
  const time = event.allDay
    ? "All day"
    : displayTime(occurrence.occurrenceStart, event.timezone || timezone);
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="inline-flex items-center gap-1.5">
        <Clock3 aria-hidden="true" />
        {time}
      </span>
      {event.location ? (
        <span className="inline-flex items-center gap-1.5">
          <MapPin aria-hidden="true" />
          <span className="truncate">{event.location}</span>
        </span>
      ) : null}
    </div>
  );
}

function EventOccurrenceCard({
  occurrence,
  timezone,
  people,
  roles,
  departments,
  records,
  viewer,
  capabilities,
  previewAs,
  boardArchived,
  reminders,
  identityId,
  onEdit,
  onAction,
  onRemind,
  onCancelReminder,
}: {
  occurrence: EventOccurrence;
  timezone: string;
  people: readonly BoardPerson[];
  roles: readonly CalendarRole[];
  departments: readonly string[];
  records: readonly SampleRecord[];
  viewer: BoardCalendarProps["viewer"];
  capabilities: BoardCalendarCapabilities;
  previewAs?: string | null;
  boardArchived: boolean;
  reminders: readonly BoardReminder[];
  identityId: string;
  onEdit: (event: BoardEvent) => void;
  onAction: (event: BoardEvent, action: BoardCalendarEventAction) => void;
  onRemind: (
    event: BoardEvent,
    occurrenceStart: string,
    option: BoardReminderOption,
  ) => void;
  onCancelReminder: (event: BoardEvent, occurrenceStart: string) => void;
}) {
  const { event } = occurrence;
  const [reminderOpen, setReminderOpen] = useState(false);
  const ownEvent = event.authorId === viewer.id;
  const canModerate = capabilities.manage && !previewAs && !boardArchived;
  const canEdit =
    capabilities.edit &&
    !event.archived &&
    (ownEvent || capabilities.manage) &&
    !previewAs &&
    !boardArchived;
  const canArchive = canModerate && !event.archived;
  const canRestore = event.archived && canModerate;
  const canDelete = event.archived && canModerate;
  const reminderSet = isPendingReminder(
    reminders,
    event,
    occurrence.occurrenceStart,
    identityId,
  );
  const author = people.find((person) => person.id === event.authorId);
  const linkedRecord = event.links.find((link) => link.recordId);
  const hasMore = Boolean(
    event.details || event.attachments.length || event.links.length,
  );

  return (
    <article className="group hover:bg-muted/20 flex min-w-0 flex-col gap-4 p-5 transition-colors sm:flex-row sm:items-start">
      <div className="flex shrink-0 items-start gap-3 sm:w-28 sm:flex-col sm:gap-1">
        <time className="text-sm font-semibold" dateTime={occurrence.date}>
          {formatShortDay(occurrence.date)}
        </time>
        {occurrence.endDate !== occurrence.date && (
          <span className="text-muted-foreground text-sm">
            through{" "}
            <time dateTime={occurrence.endDate}>
              {formatShortDay(occurrence.endDate)}
            </time>
          </span>
        )}
        {event.recurrence !== "none" ? (
          <Badge variant="outline" className="gap-1">
            <Repeat2 aria-hidden="true" />
            {event.recurrence}
          </Badge>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">{event.title}</h3>
            <EventMeta
              event={event}
              occurrence={occurrence}
              timezone={timezone}
            />
          </div>
          <Badge variant="outline" className="max-w-full truncate">
            {boardAudienceLabel(event.audience, {
              identities: people,
              roles,
              departments: departments.map((name) => ({
                id: slug(name),
                name,
              })),
            })}
          </Badge>
        </div>
        {event.details ? (
          <p className="text-muted-foreground mt-3 max-w-3xl text-sm leading-6">
            {event.details}
          </p>
        ) : null}
        {author ? (
          <p className="text-muted-foreground mt-3 inline-flex items-center gap-1.5 text-xs">
            <UserRound aria-hidden="true" />
            Added by {author.name}
            {ownEvent ? " · You" : ""}
          </p>
        ) : null}
        {linkedRecord ? (
          <a
            className="text-primary mt-3 block w-fit max-w-full truncate text-sm underline underline-offset-4"
            href={
              linkedRecord.recordId
                ? `/openview?record=${encodeURIComponent(linkedRecord.recordId)}`
                : linkedRecord.url
            }
          >
            {records.find((record) => record.id === linkedRecord.recordId)
              ?.title ?? linkedRecord.label}
          </a>
        ) : null}
        {hasMore ? (
          <Collapsible className="mt-3 max-w-3xl">
            <CollapsibleTrigger
              render={<Button variant="ghost" className="min-h-11" />}
            >
              Show attachments and links
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ContentAttachments
                attachments={event.attachments}
                links={event.links}
                records={records}
              />
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        {!canEdit &&
        capabilities.edit &&
        !previewAs &&
        !boardArchived &&
        !ownEvent &&
        !capabilities.manage ? (
          <p className="text-muted-foreground mt-3 text-xs">
            Only the event author or a manager can edit this event.
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1 sm:justify-end">
        {!event.archived && reminderSet ? (
          <Button
            variant="secondary"
            className="min-h-11"
            disabled={Boolean(previewAs) || boardArchived}
            onClick={() => onCancelReminder(event, occurrence.occurrenceStart)}
          >
            <BellOff aria-hidden="true" />
            Cancel reminder
          </Button>
        ) : !event.archived ? (
          <Popover open={reminderOpen} onOpenChange={setReminderOpen}>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={Boolean(previewAs) || boardArchived}
                />
              }
            >
              <Bell aria-hidden="true" />
              Remind
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64">
              <PopoverHeader>
                <PopoverTitle>Set a personal reminder</PopoverTitle>
                <p className="text-muted-foreground text-xs">
                  Only you will see this reminder in the sample workspace.
                </p>
              </PopoverHeader>
              <div className="flex flex-col gap-1">
                {(
                  [
                    ["now", "Remind me now"],
                    ["start", "At event start"],
                    ["15m", "15 minutes before"],
                    ["1d", "One day before"],
                  ] as const
                ).map(([option, label]) => (
                  <Button
                    key={option}
                    type="button"
                    variant="ghost"
                    className="min-h-11 justify-start"
                    onClick={() => {
                      onRemind(event, occurrence.occurrenceStart, option);
                      setReminderOpen(false);
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
        {canEdit ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label={`Edit ${event.title}`}
            onClick={() => onEdit(event)}
          >
            <Edit3 aria-hidden="true" />
          </Button>
        ) : null}
        {canArchive ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label={`Archive ${event.title}`}
            onClick={() => onAction(event, "archive")}
          >
            <Archive aria-hidden="true" />
          </Button>
        ) : null}
        {canRestore ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label={`Restore ${event.title}`}
            onClick={() => onAction(event, "restore")}
          >
            <ArchiveRestore aria-hidden="true" />
          </Button>
        ) : null}
        {canDelete ? (
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive hover:text-destructive size-11"
            aria-label={`Delete ${event.title}`}
            onClick={() => onAction(event, "delete")}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        ) : null}
        {canModerate && !ownEvent ? (
          <Badge variant="secondary" className="hidden sm:inline-flex">
            Manager
          </Badge>
        ) : null}
      </div>
    </article>
  );
}

function UpNextList({
  occurrences,
  rangeStart,
  rangeEnd,
  query,
  timezone,
  onSelect,
}: {
  occurrences: readonly EventOccurrence[];
  rangeStart: string;
  rangeEnd: string;
  query: string;
  timezone: string;
  onSelect: (occurrence: EventOccurrence) => void;
}) {
  return (
    <section
      aria-labelledby="board-calendar-up-next-heading"
      className="border-border/70 border-t pt-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div>
          <h3
            id="board-calendar-up-next-heading"
            className="text-sm font-semibold"
          >
            Up next
          </h3>
          <p className="text-muted-foreground text-xs">
            Next {MAX_AGENDA_DAYS} days · {formatShortDay(rangeStart)} –{" "}
            {formatShortDay(rangeEnd)}
          </p>
        </div>
      </div>
      {occurrences.length > 0 ? (
        <ol className="mt-3 grid gap-2 sm:grid-cols-3">
          {occurrences.map((occurrence) => {
            const { event } = occurrence;
            const time = event.allDay
              ? "All day"
              : displayTime(
                  occurrence.occurrenceStart,
                  event.timezone || timezone,
                );
            return (
              <li key={event.id + ":" + occurrence.occurrenceStart}>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto min-h-11 w-full items-start justify-start gap-3 border px-3 py-2 text-left"
                  aria-label={
                    "View " + event.title + " on " + formatDay(occurrence.date)
                  }
                  onClick={() => onSelect(occurrence)}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      event.allDay ? "bg-chart-2" : "bg-chart-1",
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {event.title}
                    </span>
                    <time
                      className="text-muted-foreground mt-0.5 block truncate text-xs"
                      dateTime={
                        event.allDay
                          ? occurrence.date
                          : occurrence.occurrenceStart
                      }
                    >
                      {formatShortDay(occurrence.date)} · {time}
                    </time>
                    {event.location ? (
                      <span className="text-muted-foreground mt-0.5 block truncate text-xs">
                        {event.location}
                      </span>
                    ) : null}
                  </span>
                </Button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-muted-foreground mt-3 text-sm" role="status">
          {query.trim()
            ? "No matching events in the next " + MAX_AGENDA_DAYS + " days."
            : "No upcoming events in the next " + MAX_AGENDA_DAYS + " days."}
        </p>
      )}
    </section>
  );
}

function EventList({
  occurrences,
  timezone,
  people,
  roles,
  departments,
  records,
  viewer,
  capabilities,
  previewAs,
  boardArchived,
  reminders,
  identityId,
  onEdit,
  onAction,
  onRemind,
  onCancelReminder,
}: Omit<React.ComponentProps<typeof EventOccurrenceCard>, "occurrence"> & {
  occurrences: readonly EventOccurrence[];
}) {
  if (occurrences.length === 0) {
    return (
      <BoardEmpty
        title="No events found"
        description="Try another date or search term, or create an event to plan what comes next."
        icon={<CalendarDays aria-hidden="true" />}
      />
    );
  }
  return (
    <div className="divide-border bg-card divide-y overflow-hidden rounded-xl border">
      {occurrences.map((occurrence) => (
        <EventOccurrenceCard
          key={`${occurrence.event.id}:${occurrence.date}`}
          occurrence={occurrence}
          timezone={timezone}
          people={people}
          roles={roles}
          departments={departments}
          records={records}
          viewer={viewer}
          capabilities={capabilities}
          previewAs={previewAs}
          boardArchived={boardArchived}
          reminders={reminders}
          identityId={identityId}
          onEdit={onEdit}
          onAction={onAction}
          onRemind={onRemind}
          onCancelReminder={onCancelReminder}
        />
      ))}
    </div>
  );
}

function CalendarMonth({
  month,
  selectedDate,
  occurrences,
  timezone,
  onSelect,
}: {
  month: Date;
  selectedDate: string;
  occurrences: readonly EventOccurrence[];
  timezone: string;
  onSelect: (date: string) => void;
}) {
  const firstDay = dateKeyToDate(monthStart(dateToKey(month)));
  const monthKey = dateToKey(firstDay).slice(0, 7);
  const dayCount = dateKeyToDate(monthEnd(dateToKey(month))).getUTCDate();
  const leadingDays = firstDay.getUTCDay();
  const cells = Array.from(
    { length: Math.ceil((leadingDays + dayCount) / 7) * 7 },
    (_, index) => {
      const day = index - leadingDays + 1;
      return day > 0 && day <= dayCount ? day : null;
    },
  );
  const today = todayKey(timezone);
  return (
    <Card className="w-full overflow-hidden">
      <CardContent className="p-0">
        <div
          className="focus-visible:outline-ring overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2"
          role="region"
          aria-label={`${formatMonth(month)} calendar`}
          tabIndex={0}
        >
          <div className="min-w-[46rem]">
            <div className="bg-muted/25 grid grid-cols-7 border-b">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                <div
                  key={day}
                  className="text-muted-foreground px-2 py-2 text-center text-[0.6875rem] font-semibold tracking-wide uppercase"
                >
                  {day}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {cells.map((day, index) => {
                if (day === null)
                  return (
                    <div
                      key={`blank-${index}`}
                      aria-hidden="true"
                      className="bg-muted/15 min-h-28 border-r border-b"
                    />
                  );
                const date = `${monthKey}-${pad(day)}`;
                const items = occurrences.filter(
                  (occurrence) =>
                    occurrence.date <= date && occurrence.endDate >= date,
                );
                return (
                  <div
                    key={date}
                    className={cn(
                      "min-h-28 border-r border-b p-1.5",
                      date === today && "bg-primary/5",
                      date === selectedDate &&
                        "ring-primary/40 ring-1 ring-inset",
                    )}
                  >
                    <div className="mb-1 flex items-center justify-between gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-11 text-xs tabular-nums"
                        aria-label={`View ${formatDay(date)}`}
                        aria-pressed={date === selectedDate}
                        aria-current={date === today ? "date" : undefined}
                        aria-controls="board-calendar-day-details"
                        onClick={() => onSelect(date)}
                      >
                        {day}
                      </Button>
                      {date === today && (
                        <Badge
                          variant="secondary"
                          className="px-1.5 py-0 text-[0.625rem]"
                        >
                          Today
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      {items.slice(0, 3).map((occurrence) => (
                        <Button
                          key={`${occurrence.event.id}:${occurrence.occurrenceStart}`}
                          variant="ghost"
                          className={cn(
                            "h-auto min-h-11 w-full items-start justify-start border px-2 py-1.5 text-left text-xs whitespace-normal",
                            occurrence.event.allDay
                              ? "border-chart-2/35 bg-chart-2/12"
                              : "border-chart-1/35 bg-chart-1/12",
                          )}
                          aria-controls="board-calendar-day-details"
                          onClick={() => onSelect(date)}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "mt-1.5 size-1.5 shrink-0 rounded-full",
                              occurrence.event.allDay
                                ? "bg-chart-2"
                                : "bg-chart-1",
                            )}
                          />
                          <span className="min-w-0">
                            <span className="line-clamp-2 font-medium">
                              {occurrence.event.title}
                            </span>
                            <span className="text-muted-foreground mt-0.5 block text-[0.6875rem]">
                              {occurrence.event.allDay
                                ? "All day"
                                : occurrence.date < date
                                  ? "Continues"
                                  : displayTime(
                                      occurrence.occurrenceStart,
                                      occurrence.event.timezone || timezone,
                                    )}
                            </span>
                          </span>
                        </Button>
                      ))}
                      {items.length > 3 && (
                        <Button
                          variant="ghost"
                          className="min-h-11 justify-start px-2 text-xs"
                          aria-controls="board-calendar-day-details"
                          onClick={() => onSelect(date)}
                        >
                          +{items.length - 3} more
                        </Button>
                      )}
                    </div>
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

function EventEditor({
  draft,
  timezone,
  people,
  roles,
  departments,
  records,
  disabled,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: DraftEvent;
  timezone: string;
  people: readonly BoardPerson[];
  roles: readonly CalendarRole[];
  departments: readonly string[];
  records: readonly SampleRecord[];
  disabled: boolean;
  error: string;
  onChange: (patch: Partial<DraftEvent>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const recurrenceNeedsEnd = draft.recurrence !== "none";
  const startLabel = draft.allDay ? "Start date" : "Starts";
  const endLabel = draft.allDay ? "End date" : "Ends";
  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="board-event-title">Event title</FieldLabel>
          <Input
            id="board-event-title"
            value={draft.title}
            autoFocus
            required
            maxLength={BOARD_INPUT_LIMITS.maxEventTitle}
            placeholder="e.g. Weekly operations briefing"
            disabled={disabled}
            onChange={(event) => onChange({ title: event.target.value })}
          />
          <FieldDescription>
            Use a short title your team can scan quickly.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="board-event-details">Details</FieldLabel>
          <Textarea
            id="board-event-details"
            value={draft.details}
            maxLength={BOARD_INPUT_LIMITS.maxEventDetails}
            placeholder="What should attendees know or prepare?"
            disabled={disabled}
            onChange={(event) => onChange({ details: event.target.value })}
          />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="board-event-location">Location</FieldLabel>
            <Input
              id="board-event-location"
              value={draft.location}
              maxLength={240}
              placeholder="Room, address, or video link"
              disabled={disabled}
              onChange={(event) => onChange({ location: event.target.value })}
            />
          </Field>
          <AudienceField
            value={draft.audience}
            onChange={(nextAudience) => onChange({ audience: nextAudience })}
            people={people}
            roles={roles}
            departments={departments}
            disabled={disabled}
          />
        </div>
        <Field className="flex flex-row items-start gap-3 rounded-lg border p-3">
          <Checkbox
            id="board-event-all-day"
            checked={draft.allDay}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange({
                allDay: checked === true,
                start: checked
                  ? draft.start.slice(0, 10)
                  : `${draft.start.slice(0, 10)}T09:00`,
                end: checked
                  ? draft.end.slice(0, 10)
                  : `${draft.end.slice(0, 10)}T10:00`,
              })
            }
          />
          <div className="flex flex-col gap-1">
            <FieldLabel htmlFor="board-event-all-day">All-day event</FieldLabel>
            <FieldDescription>
              Use this for milestones, deadlines, and office-wide dates.
            </FieldDescription>
          </div>
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="board-event-start">{startLabel}</FieldLabel>
            <Input
              id="board-event-start"
              type={draft.allDay ? "date" : "datetime-local"}
              value={draft.start}
              required
              disabled={disabled}
              onChange={(event) => onChange({ start: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="board-event-end">{endLabel}</FieldLabel>
            <Input
              id="board-event-end"
              type={draft.allDay ? "date" : "datetime-local"}
              value={draft.end}
              required
              disabled={disabled}
              onChange={(event) => onChange({ end: event.target.value })}
            />
          </Field>
        </div>
        <p className="text-muted-foreground text-xs">
          Event timezone: {timezone}.
        </p>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="board-event-recurrence">Repeats</FieldLabel>
            <NativeSelect
              id="board-event-recurrence"
              value={draft.recurrence}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  recurrence: event.target.value as BoardRecurrence,
                  endDate: event.target.value === "none" ? "" : draft.endDate,
                })
              }
            >
              <option value="none">Does not repeat</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
            </NativeSelect>
          </Field>
          {recurrenceNeedsEnd ? (
            <Field>
              <FieldLabel htmlFor="board-event-end-date">
                Repeat until
              </FieldLabel>
              <Input
                id="board-event-end-date"
                type="date"
                value={draft.endDate}
                required
                disabled={disabled}
                onChange={(event) => onChange({ endDate: event.target.value })}
              />
              <FieldDescription>
                Recurring events are limited to the dates shown in the calendar.
              </FieldDescription>
            </Field>
          ) : null}
        </div>
        <ContentFields
          attachments={draft.attachments}
          originalAttachments={draft.original?.attachments ?? []}
          links={draft.links}
          records={records}
          disabled={disabled}
          onChange={(patch) => onChange(patch)}
        />
      </FieldGroup>
      {error ? (
        <Alert variant="destructive" role="alert">
          {error}
        </Alert>
      ) : null}
      <div className="mt-auto flex flex-col-reverse gap-2 border-t pt-5 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" className="min-h-11" disabled={disabled}>
          {draft.id ? "Save event" : "Create event"}
        </Button>
      </div>
    </form>
  );
}

export function BoardCalendar({
  boardId,
  boardName,
  boardArchived = false,
  events,
  records,
  viewer,
  people,
  roles,
  departments,
  capabilities,
  timezone = BOARD_TIMEZONE,
  selectedDate,
  personal,
  previewAs,
  onDateChange,
  onSave,
  onAction,
  onRemind,
  onCancelReminder,
  onPreferenceChange,
}: BoardCalendarProps) {
  const [month, setMonth] = useState(() =>
    dateKeyToDate(monthStart(selectedDate)),
  );
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<DraftEvent | null>(null);
  const [draftBaseline, setDraftBaseline] = useState("");
  const [editorError, setEditorError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);
  const [status, setStatus] = useState("");
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [nowTimestamp, setNowTimestamp] = useState<number | null>(null);
  const draftRef = useRef<DraftEvent | null>(null);
  const dayDetailsRef = useRef<HTMLDivElement | null>(null);
  const editorLifecycle = useRef(0);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    const generation = ++editorLifecycle.current;
    return () => {
      queueMicrotask(() => {
        if (editorLifecycle.current === generation) {
          releaseDraftAttachments(draftRef.current);
        }
      });
    };
  }, []);
  useEffect(() => {
    const updateNow = () => setNowTimestamp(Date.now());
    updateNow();
    const interval = window.setInterval(updateNow, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const selected = DATE_PATTERN.test(selectedDate)
    ? selectedDate
    : todayKey(timezone);
  useEffect(() => {
    if (DATE_PATTERN.test(selectedDate))
      setMonth(dateKeyToDate(monthStart(selectedDate)));
  }, [selectedDate]);

  const boardEvents = useMemo(
    () =>
      events.filter((event) => event.boardId === boardId && !event.archived),
    [boardId, events],
  );
  const boardArchivedEvents = useMemo(
    () => events.filter((event) => event.boardId === boardId && event.archived),
    [boardId, events],
  );
  const monthRange = useMemo(
    () => ({
      start: monthStart(dateToKey(month)),
      end: monthEnd(dateToKey(month)),
    }),
    [month],
  );
  const monthOccurrences = useMemo(
    () =>
      expandOccurrences(
        boardEvents,
        boardId,
        monthRange.start,
        monthRange.end,
        timezone,
        query,
      ),
    [boardEvents, boardId, monthRange.end, monthRange.start, query, timezone],
  );
  const upNextStart = todayKey(timezone);
  const upNextEnd = addDateKey(upNextStart, MAX_AGENDA_DAYS - 1);
  const upNextOccurrences = useMemo(
    () =>
      expandOccurrences(
        boardEvents,
        boardId,
        upNextStart,
        upNextEnd,
        timezone,
        query,
      )
        .filter((occurrence) => {
          if (occurrence.event.allDay) return true;
          const occurrenceTimestamp = Date.parse(occurrence.occurrenceStart);
          return (
            Number.isFinite(occurrenceTimestamp) &&
            (nowTimestamp === null || occurrenceTimestamp >= nowTimestamp)
          );
        })
        .slice(0, MAX_UP_NEXT_OCCURRENCES),
    [
      boardEvents,
      boardId,
      nowTimestamp,
      query,
      timezone,
      upNextEnd,
      upNextStart,
    ],
  );
  const selectedOccurrences = useMemo(
    () =>
      expandOccurrences(
        boardEvents,
        boardId,
        selected,
        selected,
        timezone,
        query,
      ),
    [boardEvents, boardId, query, selected, timezone],
  );
  const agendaEnd = addDateKey(selected, MAX_AGENDA_DAYS - 1);
  const agendaOccurrences = useMemo(
    () =>
      expandOccurrences(
        boardEvents,
        boardId,
        selected,
        agendaEnd,
        timezone,
        query,
      ),
    [agendaEnd, boardEvents, boardId, query, selected, timezone],
  );
  const archivedEventOccurrences = useMemo(
    () => archivedOccurrences(boardArchivedEvents, boardId, timezone, query),
    [boardArchivedEvents, boardId, query, timezone],
  );
  const draftDirty = Boolean(draft && serializedDraft(draft) !== draftBaseline);
  const canCreate =
    capabilities.edit && !boardArchived && !previewAs && viewer.active;
  const monthDate = dateKeyToDate(monthRange.start);
  const selectedDateObject = dateKeyToDate(selected);
  const selectedPersonName =
    people.find((person) => person.id === previewAs)?.name ?? previewAs;

  function selectDate(date: string) {
    onDateChange(date);
    setMonth(dateKeyToDate(monthStart(date)));
  }

  function selectUpNext(occurrence: EventOccurrence) {
    selectDate(occurrence.date);
    if (personal.calendarView === "month") {
      requestAnimationFrame(() =>
        dayDetailsRef.current?.scrollIntoView({ block: "nearest" }),
      );
    }
  }

  function beginCreate() {
    if (!canCreate) return;
    const next = newDraft(boardId, viewer.id, selected, timezone);
    setDraft(next);
    setDraftBaseline(serializedDraft(next));
    setEditorError("");
    setStatus("");
  }

  function beginEdit(event: BoardEvent) {
    const next = {
      ...draftFromEvent(event, timezone),
      original: cloneEvent(event),
    };
    setDraft(next);
    setDraftBaseline(serializedDraft(next));
    setEditorError("");
    setStatus("");
  }

  function closeEditor(discard = true) {
    if (discard) releaseDraftAttachments(draft);
    setDraft(null);
    setDraftBaseline("");
    setEditorError("");
  }

  function saveDraft() {
    if (!draft) return;
    if (draft.boardId !== boardId) {
      setEditorError(
        "This draft belongs to another board. Return to that board before saving, or discard this draft.",
      );
      return;
    }
    if (previewAs || boardArchived || !capabilities.edit || !viewer.active) {
      setEditorError(
        "Leave read-only preview and choose an active identity before saving.",
      );
      return;
    }
    const title = draft.title.trim();
    if (!title) {
      setEditorError("Add an event title before saving.");
      return;
    }
    if (!draft.start || !draft.end) {
      setEditorError("Choose a start and end time.");
      return;
    }
    if (draft.allDay) {
      if (!DATE_PATTERN.test(draft.start) || !DATE_PATTERN.test(draft.end)) {
        setEditorError("Choose valid calendar dates.");
        return;
      }
      if (draft.end < draft.start) {
        setEditorError("The end date must be on or after the start date.");
        return;
      }
    }
    if (draft.recurrence !== "none") {
      if (!DATE_PATTERN.test(draft.endDate)) {
        setEditorError("Choose an end date for this recurring event.");
        return;
      }
      const seriesStart = draft.allDay ? draft.start : draft.start.slice(0, 10);
      if (draft.endDate < seriesStart) {
        setEditorError(
          "The repeat-until date must be on or after the start date.",
        );
        return;
      }
    }
    let start = draft.start;
    let end = draft.end;
    if (!draft.allDay) {
      try {
        start = datetimeInputToUtc(draft.start, draft.timezone);
        end = datetimeInputToUtc(draft.end, draft.timezone);
      } catch (cause) {
        setEditorError(
          cause instanceof Error
            ? cause.message
            : "Choose a valid time in the event timezone.",
        );
        return;
      }
      if (new Date(end).getTime() < new Date(start).getTime()) {
        setEditorError("The end time must be after the start time.");
        return;
      }
    }
    const timestamp = new Date().toISOString();
    const nextEvent: BoardEvent = {
      id: draft.id || makeId("sample-event"),
      boardId,
      authorId: draft.authorId,
      title,
      details: draft.details.trim(),
      location: draft.location.trim(),
      start,
      end,
      allDay: draft.allDay,
      timezone: draft.timezone,
      audience: draft.audience,
      recurrence: draft.recurrence,
      endDate: draft.recurrence === "none" ? null : draft.endDate,
      attachments: draft.attachments,
      links: draft.links,
      archived: false,
      createdAt: draft.createdAt,
      updatedAt: timestamp,
    };
    const scope = nextEvent.recurrence === "none" ? "single" : "series";
    const result = safeEventMutation(() =>
      onSave(nextEvent, scope, draft.original),
    );
    if (!result.ok) {
      setEditorError(result.error);
      return;
    }
    setStatus(draft.id ? "Event updated." : "Event created.");
    closeEditor(false);
  }

  function requestEventAction(
    event: BoardEvent,
    action: BoardCalendarEventAction,
  ) {
    if (!capabilities.edit || boardArchived || previewAs) return;
    if (action === "archive" && event.archived) return;
    if (action === "restore" && (!event.archived || !capabilities.manage))
      return;
    if (action === "delete") {
      if (!event.archived || !capabilities.manage) return;
      setPendingDelete({
        event,
        scope: event.recurrence === "none" ? "single" : "series",
      });
      return;
    }
    const result = safeEventMutation(() => onAction(event, action));
    if (!result.ok) {
      setStatus(result.error);
      return;
    }
    setStatus(action === "archive" ? "Event archived." : "Event restored.");
  }

  function confirmDelete() {
    if (!pendingDelete || previewAs || boardArchived || !capabilities.manage)
      return;
    const result = safeEventMutation(() =>
      onAction(pendingDelete.event, "delete"),
    );
    if (!result.ok) {
      setStatus(result.error);
      return;
    }
    setStatus(
      pendingDelete.scope === "series"
        ? "Event series deleted."
        : "Event deleted.",
    );
    setPendingDelete(null);
  }

  function showReminder(
    event: BoardEvent,
    occurrenceStart: string,
    option: BoardReminderOption,
  ) {
    if (previewAs || boardArchived) return;
    const result = safeEventMutation(() =>
      onRemind(event, option, occurrenceStart),
    );
    if (!result.ok) {
      setStatus(result.error);
      return;
    }
    setStatus(`Personal reminder set for ${event.title}.`);
  }

  function cancelReminder(event: BoardEvent, occurrenceStart: string) {
    if (previewAs || boardArchived) return;
    const result = safeEventMutation(() =>
      onCancelReminder(event, occurrenceStart),
    );
    if (!result.ok) {
      setStatus(result.error);
      return;
    }
    setStatus(`Reminder canceled for ${event.title}.`);
  }

  function changeCalendarView(value: string[]) {
    if (previewAs || !viewer.active) return;
    const view = value[0];
    if (view !== "agenda" && view !== "month") return;
    const result = safeEventMutation(() =>
      onPreferenceChange({ calendarView: view }),
    );
    if (!result.ok) {
      setStatus(result.error);
      return;
    }
    setStatus(
      `Calendar switched to ${view === "agenda" ? "agenda" : "month"} view.`,
    );
  }

  function changeMonth(amount: number) {
    const date = dateKeyToDate(monthRange.start);
    date.setUTCMonth(date.getUTCMonth() + amount);
    selectDate(dateToKey(date));
  }

  function handleMonthPicker(date: string) {
    selectDate(date);
    setMonthPickerOpen(false);
  }

  if (!capabilities.view) {
    return (
      <BoardEmpty
        title="Calendar unavailable"
        description="You do not have access to this board's calendar."
        icon={<Eye aria-hidden="true" />}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <h2 className="sr-only">
        Calendar{boardName ? ` for ${boardName}` : ""}
      </h2>

      {previewAs ? (
        <Alert>
          <div className="flex items-start gap-3">
            <Eye aria-hidden="true" className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">
                Previewing as {selectedPersonName ?? "another person"}
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                This view is read-only. Personal reminders are disabled while
                previewing.
              </p>
            </div>
          </div>
        </Alert>
      ) : null}
      {boardArchived ? (
        <Alert variant="warning">
          <div className="flex items-start gap-3">
            <Archive aria-hidden="true" className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">This board is archived</p>
              <p className="mt-1 text-sm">
                Calendar content is available for reference. Restore the board
                before making changes.
              </p>
            </div>
          </div>
        </Alert>
      ) : null}

      <section aria-label="Calendar controls" className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => selectDate(todayKey(timezone))}
            >
              Today
            </Button>
            <div className="flex items-center gap-1" aria-label="Change month">
              <Button
                variant="ghost"
                size="icon"
                className="size-11"
                aria-label="Previous month"
                onClick={() => changeMonth(-1)}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <Popover open={monthPickerOpen} onOpenChange={setMonthPickerOpen}>
                <PopoverTrigger
                  render={
                    <Button
                      variant="ghost"
                      className="min-h-11 min-w-32 justify-center text-base font-semibold sm:min-w-44"
                    />
                  }
                >
                  {formatMonth(monthDate)}
                </PopoverTrigger>
                <PopoverContent align="center" className="w-auto">
                  <PopoverHeader>
                    <PopoverTitle>Choose a month</PopoverTitle>
                  </PopoverHeader>
                  <MonthCalendar
                    mode="single"
                    timeZone="UTC"
                    today={dateKeyToDate(todayKey(timezone))}
                    selected={selectedDateObject}
                    month={monthDate}
                    onMonthChange={setMonth}
                    onSelect={(date) => {
                      if (date) handleMonthPicker(dateToKey(date));
                    }}
                    className="rounded-lg border-0 p-0"
                  />
                </PopoverContent>
              </Popover>
              <Button
                variant="ghost"
                size="icon"
                className="size-11"
                aria-label="Next month"
                onClick={() => changeMonth(1)}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="relative w-full min-w-0 sm:w-52">
              <SearchField
                id="board-calendar-search"
                label="Search calendar"
                value={query}
                placeholder="Search events"
                className="pr-10"
                onValueChange={setQuery}
              />
              {query ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 bottom-0 size-11"
                  aria-label="Clear calendar search"
                  onClick={() => setQuery("")}
                >
                  <X aria-hidden="true" />
                </Button>
              ) : null}
            </div>
            <ToggleGroup
              variant="outline"
              value={[personal.calendarView]}
              onValueChange={changeCalendarView}
              disabled={Boolean(previewAs) || !viewer.active}
              aria-label="Calendar view"
              className="min-h-11"
            >
              <ToggleGroupItem value="agenda" className="min-h-11 px-3">
                Agenda
              </ToggleGroupItem>
              <ToggleGroupItem value="month" className="min-h-11 px-3">
                Month
              </ToggleGroupItem>
            </ToggleGroup>
            <Button
              className="min-h-11 shrink-0"
              onClick={beginCreate}
              disabled={!canCreate}
              title={
                !canCreate
                  ? "Only editors can create events on an active board."
                  : undefined
              }
            >
              <Plus aria-hidden="true" />
              New event
            </Button>
          </div>
        </div>
        <div
          className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
          role="status"
          aria-live="polite"
        >
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays aria-hidden="true" />
            {formatCalendarSummary(
              personal.calendarView === "month"
                ? monthOccurrences
                : agendaOccurrences,
            )}
          </span>
          <span>
            {timezone === "Asia/Manila"
              ? "Manila time"
              : timezone.replaceAll("_", " ")}
          </span>
          {query ? <span>Filtering by “{query}”</span> : null}
        </div>
        <UpNextList
          occurrences={upNextOccurrences}
          rangeStart={upNextStart}
          rangeEnd={upNextEnd}
          query={query}
          timezone={timezone}
          onSelect={selectUpNext}
        />
      </section>

      {personal.calendarView === "month" ? (
        <div className="flex min-w-0 flex-col gap-5">
          <CalendarMonth
            month={monthDate}
            selectedDate={selected}
            occurrences={monthOccurrences}
            timezone={timezone}
            onSelect={(date) => {
              selectDate(date);
              requestAnimationFrame(() =>
                dayDetailsRef.current?.scrollIntoView({ block: "nearest" }),
              );
            }}
          />
          <div id="board-calendar-day-details" ref={dayDetailsRef}>
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>{formatDay(selected)}</CardTitle>
                <CardDescription>
                  {selectedOccurrences.length
                    ? `${selectedOccurrences.length} ${selectedOccurrences.length === 1 ? "occurrence" : "occurrences"}`
                    : "No occurrences scheduled for this day"}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <EventList
                  occurrences={selectedOccurrences}
                  timezone={timezone}
                  people={people}
                  roles={roles}
                  departments={departments}
                  records={records}
                  viewer={viewer}
                  capabilities={capabilities}
                  previewAs={previewAs}
                  boardArchived={boardArchived}
                  reminders={personal.reminders}
                  identityId={personal.identityId}
                  onEdit={beginEdit}
                  onAction={requestEventAction}
                  onRemind={showReminder}
                  onCancelReminder={cancelReminder}
                />
              </CardContent>
            </Card>
          </div>
        </div>
      ) : (
        <section
          aria-labelledby="board-agenda-heading"
          className="flex min-w-0 flex-col gap-4"
        >
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 id="board-agenda-heading" className="text-lg font-semibold">
                Upcoming agenda
              </h3>
              <p className="text-muted-foreground text-sm">
                Starting {formatDay(selected)} · next {MAX_AGENDA_DAYS} days
              </p>
            </div>
            <Button
              variant="outline"
              className="min-h-11 w-fit"
              onClick={() => selectDate(todayKey(timezone))}
            >
              Jump to today
            </Button>
          </div>
          <EventList
            occurrences={agendaOccurrences}
            timezone={timezone}
            people={people}
            roles={roles}
            departments={departments}
            records={records}
            viewer={viewer}
            capabilities={capabilities}
            previewAs={previewAs}
            boardArchived={boardArchived}
            reminders={personal.reminders}
            identityId={personal.identityId}
            onEdit={beginEdit}
            onAction={requestEventAction}
            onRemind={showReminder}
            onCancelReminder={cancelReminder}
          />
        </section>
      )}

      {capabilities.manage &&
      !previewAs &&
      !boardArchived &&
      boardArchivedEvents.length > 0 ? (
        <section
          aria-labelledby="board-archived-events-heading"
          className="flex min-w-0 flex-col gap-4"
        >
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3
                id="board-archived-events-heading"
                className="text-lg font-semibold"
              >
                Archived events
              </h3>
              <p className="text-muted-foreground text-sm">
                Restore an event to make it visible again, or permanently delete
                it after review.
              </p>
            </div>
            <Badge variant="secondary">
              {boardArchivedEvents.length} archived
            </Badge>
          </div>
          <EventList
            occurrences={archivedEventOccurrences}
            timezone={timezone}
            people={people}
            roles={roles}
            departments={departments}
            records={records}
            viewer={viewer}
            capabilities={capabilities}
            previewAs={previewAs}
            boardArchived={boardArchived}
            reminders={personal.reminders}
            identityId={personal.identityId}
            onEdit={beginEdit}
            onAction={requestEventAction}
            onRemind={showReminder}
            onCancelReminder={cancelReminder}
          />
        </section>
      ) : null}

      {status ? (
        <p
          role="status"
          aria-live="polite"
          className="text-muted-foreground text-sm"
        >
          {status}
        </p>
      ) : null}

      <EditSheet
        open={Boolean(draft)}
        title={draft?.id ? "Edit event" : "New event"}
        description={
          draft?.recurrence && draft.recurrence !== "none"
            ? "Changes apply to the whole event series."
            : "Add the details your team needs to plan the day."
        }
        dirty={draftDirty}
        onClose={closeEditor}
      >
        {(requestClose) =>
          draft ? (
            <EventEditor
              draft={draft}
              timezone={draft.timezone}
              people={people}
              roles={roles}
              departments={departments}
              records={records}
              disabled={
                Boolean(previewAs) || boardArchived || !capabilities.edit
              }
              error={editorError}
              onChange={(patch) =>
                setDraft((current) =>
                  current ? { ...current, ...patch } : current,
                )
              }
              onSubmit={saveDraft}
              onCancel={requestClose}
            />
          ) : null
        }
      </EditSheet>

      <ConfirmAction
        open={Boolean(pendingDelete)}
        title={
          pendingDelete?.scope === "series"
            ? "Delete event series permanently?"
            : "Delete this event permanently?"
        }
        description={
          pendingDelete?.scope === "series"
            ? `This permanently removes all occurrences of “${pendingDelete.event.title}” from this board.`
            : `This permanently removes “${pendingDelete?.event.title ?? "this event"}” from the board.`
        }
        action={
          pendingDelete?.scope === "series"
            ? "Delete series permanently"
            : "Delete event permanently"
        }
        phrase={pendingDelete?.event.title}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

export default BoardCalendar;
