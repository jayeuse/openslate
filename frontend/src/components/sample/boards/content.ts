import { BOARD_INPUT_LIMITS } from "./model";
import { Temporal } from "@js-temporal/polyfill";
import type {
  BoardAnnouncement,
  BoardAnnouncementRevision,
  BoardAudience,
  BoardAudienceLookup,
  BoardEvent,
  BoardReminder,
} from "./model";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UTC_INSTANT_PATTERN = /Z$/;
const MAX_OCCURRENCES = 100;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export type BoardEventValidationField =
  "title" | "start" | "end" | "timezone" | "recurrence" | "endDate";

export type BoardEventValidationIssue = {
  field: BoardEventValidationField;
  message: string;
};

export type BoardEventValidation = {
  valid: boolean;
  issues: BoardEventValidationIssue[];
};

export type BoardCommandValidation =
  { ok: true } | { ok: false; error: string };

export type BoardEventTemporalInput = Pick<
  BoardEvent,
  "id" | "start" | "end" | "allDay" | "timezone" | "recurrence" | "endDate"
>;

export type BoardEventOccurrence = {
  id: string;
  eventId: string;
  start: string;
  end: string;
  date: string;
};

export type BoardEventOccurrenceRange = {
  start: string;
  end: string;
};

export type BoardEventOccurrenceResult = {
  occurrences: BoardEventOccurrence[];
  truncated: boolean;
};

function parseDate(value: string): Temporal.PlainDate | null {
  if (!DATE_PATTERN.test(value)) return null;
  try {
    const parsed = Temporal.PlainDate.from(value);
    return parsed.toString() === value ? parsed : null;
  } catch {
    return null;
  }
}

function parseUtcInstant(value: string): Temporal.Instant | null {
  if (!UTC_INSTANT_PATTERN.test(value)) return null;
  try {
    return Temporal.Instant.from(value);
  } catch {
    return null;
  }
}

function isTimezone(value: string): boolean {
  if (!value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function eventStartDate(
  event: BoardEventTemporalInput,
): Temporal.PlainDate | null {
  if (event.allDay) return parseDate(event.start);
  const instant = parseUtcInstant(event.start);
  if (!instant || !isTimezone(event.timezone)) return null;
  try {
    return instant.toZonedDateTimeISO(event.timezone).toPlainDate();
  } catch {
    return null;
  }
}

function eventEndDate(
  event: BoardEventTemporalInput,
): Temporal.PlainDate | null {
  if (event.allDay) return parseDate(event.end);
  const instant = parseUtcInstant(event.end);
  if (!instant || !isTimezone(event.timezone)) return null;
  try {
    return instant.toZonedDateTimeISO(event.timezone).toPlainDate();
  } catch {
    return null;
  }
}

/** Inspect the explicit temporal contract used by BoardEvent. */
export function inspectBoardEvent(event: BoardEvent): BoardEventValidation {
  const issues: BoardEventValidationIssue[] = [];
  const issue = (field: BoardEventValidationField, message: string) =>
    issues.push({ field, message });

  if (!event.title.trim()) issue("title", "Event title is required.");
  if (event.title.length > 100)
    issue("title", "Event title must be 100 characters or fewer.");
  if (!isTimezone(event.timezone))
    issue("timezone", "Choose a valid IANA timezone.");

  if (event.allDay) {
    const start = parseDate(event.start);
    const end = parseDate(event.end);
    if (!start)
      issue("start", "All-day events need a valid YYYY-MM-DD start date.");
    if (!end) issue("end", "All-day events need a valid YYYY-MM-DD end date.");
    if (start && end && Temporal.PlainDate.compare(start, end) > 0)
      issue("end", "Event end must be on or after its start date.");
  } else {
    const start = parseUtcInstant(event.start);
    const end = parseUtcInstant(event.end);
    if (!start)
      issue("start", "Timed events need an ISO UTC start ending in Z.");
    if (!end) issue("end", "Timed events need an ISO UTC end ending in Z.");
    if (start && end && Temporal.Instant.compare(start, end) >= 0)
      issue("end", "Event end must be after its start time.");
  }

  if (event.recurrence !== "none") {
    const recurrenceEnd = parseDate(event.endDate ?? "");
    if (!recurrenceEnd)
      issue("endDate", "Recurring events need a valid ending date.");
    const startDate = eventStartDate(event);
    if (
      recurrenceEnd &&
      startDate &&
      Temporal.PlainDate.compare(recurrenceEnd, startDate) < 0
    )
      issue("endDate", "Recurrence must end on or after the event start date.");
  }

  return { valid: issues.length === 0, issues };
}

/** Validate a BoardEvent for command/controller callers. */
export function validateBoardEvent(event: BoardEvent): BoardCommandValidation {
  const result = inspectBoardEvent(event);
  return result.valid
    ? { ok: true }
    : {
        ok: false,
        error: result.issues.map((entry) => entry.message).join(" "),
      };
}

function validRange(
  range: BoardEventOccurrenceRange,
): [Temporal.PlainDate, Temporal.PlainDate] | null {
  const start = parseDate(range.start);
  const end = parseDate(range.end);
  if (!start || !end || Temporal.PlainDate.compare(start, end) > 0) return null;
  return [start, end];
}

function instantIso(value: Temporal.Instant): string {
  return new Date(Number(value.epochMilliseconds)).toISOString();
}

function timedOccurrence(
  event: BoardEventTemporalInput,
  date: Temporal.PlainDate,
  durationMs: number,
): BoardEventOccurrence | null {
  const startInstant = parseUtcInstant(event.start);
  if (!startInstant || !isTimezone(event.timezone)) return null;
  try {
    const startZoned = startInstant.toZonedDateTimeISO(event.timezone);
    const localDateTime = date.toPlainDateTime(startZoned.toPlainTime());
    const occurrenceStart = localDateTime
      .toZonedDateTime(event.timezone, { disambiguation: "compatible" })
      .toInstant();
    const occurrenceEnd = occurrenceStart.add({ milliseconds: durationMs });
    const start = instantIso(occurrenceStart);
    const end = instantIso(occurrenceEnd);
    return {
      id: `${event.id}:${date.toString()}`,
      eventId: event.id,
      start,
      end,
      date: date.toString(),
    };
  } catch {
    return null;
  }
}

function allDayOccurrence(
  event: BoardEventTemporalInput,
  date: Temporal.PlainDate,
  durationDays: number,
): BoardEventOccurrence {
  const start = date.toString();
  const end = date.add({ days: Math.max(0, durationDays - 1) }).toString();
  return {
    id: `${event.id}:${start}`,
    eventId: event.id,
    start,
    end,
    date: start,
  };
}

function dayStartInstant(
  date: Temporal.PlainDate,
  timezone: string,
): Temporal.Instant | null {
  try {
    return date
      .toZonedDateTime({ timeZone: timezone, plainTime: "00:00" })
      .toInstant();
  } catch {
    return null;
  }
}

function timedRangeBounds(
  rangeStart: Temporal.PlainDate,
  rangeEnd: Temporal.PlainDate,
  timezone: string,
): [Temporal.Instant, Temporal.Instant] | null {
  const start = dayStartInstant(rangeStart, timezone);
  const end = dayStartInstant(rangeEnd.add({ days: 1 }), timezone);
  return start && end ? [start, end] : null;
}

function occurrenceOverlapsRange(
  occurrence: BoardEventOccurrence,
  allDay: boolean,
  rangeStart: Temporal.PlainDate,
  rangeEnd: Temporal.PlainDate,
  timedBounds: [Temporal.Instant, Temporal.Instant] | null,
): boolean {
  if (allDay) {
    const occurrenceStart = parseDate(occurrence.start);
    const occurrenceEnd = parseDate(occurrence.end);
    return Boolean(
      occurrenceStart &&
      occurrenceEnd &&
      Temporal.PlainDate.compare(occurrenceStart, rangeEnd) <= 0 &&
      Temporal.PlainDate.compare(occurrenceEnd, rangeStart) >= 0,
    );
  }

  const occurrenceStart = parseUtcInstant(occurrence.start);
  const occurrenceEnd = parseUtcInstant(occurrence.end);
  return Boolean(
    occurrenceStart &&
    occurrenceEnd &&
    timedBounds &&
    Temporal.Instant.compare(occurrenceStart, timedBounds[1]) < 0 &&
    Temporal.Instant.compare(occurrenceEnd, timedBounds[0]) > 0,
  );
}

function recurrenceSearchStart(
  event: BoardEventTemporalInput,
  startDate: Temporal.PlainDate,
  rangeStart: Temporal.PlainDate,
  durationDays: number,
  durationMs: number,
): Temporal.PlainDate {
  try {
    if (event.allDay) {
      return rangeStart.subtract({ days: durationDays - 1 });
    }

    const rangeStartInstant = dayStartInstant(rangeStart, event.timezone);
    if (!rangeStartInstant) return startDate;
    return rangeStartInstant
      .subtract({ milliseconds: durationMs })
      .toZonedDateTimeISO(event.timezone)
      .toPlainDate()
      .subtract({ days: 1 });
  } catch {
    return startDate;
  }
}

/**
 * Expand a bounded event into occurrences for an inclusive calendar range.
 * Monthly recurrence is anchored to the starting day and skips months that do
 * not contain that day. At most 100 matches are returned.
 */
export function expandBoardEventOccurrences(
  event: BoardEventTemporalInput,
  range: BoardEventOccurrenceRange,
  requestedLimit = MAX_OCCURRENCES,
): BoardEventOccurrenceResult {
  const limit = Math.min(
    MAX_OCCURRENCES,
    Math.max(
      1,
      Math.floor(
        Number.isFinite(requestedLimit) ? requestedLimit : MAX_OCCURRENCES,
      ),
    ),
  );
  const parsedRange = validRange(range);
  if (!parsedRange) return { occurrences: [], truncated: false };
  const [rangeStart, rangeEnd] = parsedRange;
  const validation = inspectBoardEvent({
    ...event,
    title: "Temporal validation",
    details: "",
    location: "",
    authorId: "sample-mara",
    boardId: "sample-board-organization",
    audience: { kind: "everyone" },
    attachments: [],
    links: [],
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  if (!validation.valid) return { occurrences: [], truncated: false };

  const startDate = eventStartDate(event);
  const endDate = eventEndDate(event);
  const recurrenceEnd =
    event.recurrence === "none" ? null : parseDate(event.endDate ?? "");
  if (!startDate || !endDate || (event.recurrence !== "none" && !recurrenceEnd))
    return { occurrences: [], truncated: false };

  const durationDays = event.allDay
    ? endDate.since(startDate, { largestUnit: "day" }).days + 1
    : 0;
  const durationMs = event.allDay
    ? 0
    : Number(
        (parseUtcInstant(event.end)?.epochMilliseconds ?? 0) -
          (parseUtcInstant(event.start)?.epochMilliseconds ?? 0),
      );
  const occurrences: BoardEventOccurrence[] = [];
  let truncated = false;
  const timedBounds = event.allDay
    ? null
    : timedRangeBounds(rangeStart, rangeEnd, event.timezone);
  if (!event.allDay && !timedBounds) {
    return { occurrences: [], truncated: false };
  }

  const add = (date: Temporal.PlainDate) => {
    const occurrence = event.allDay
      ? allDayOccurrence(event, date, durationDays)
      : timedOccurrence(event, date, durationMs);
    if (
      !occurrence ||
      !occurrenceOverlapsRange(
        occurrence,
        event.allDay,
        rangeStart,
        rangeEnd,
        timedBounds,
      )
    )
      return false;
    if (occurrences.length >= limit) {
      truncated = true;
      return true;
    }
    occurrences.push(occurrence);
    return false;
  };

  if (event.recurrence === "none") {
    const occurrence = event.allDay
      ? allDayOccurrence(event, startDate, durationDays)
      : {
          id: `${event.id}:${event.start}`,
          eventId: event.id,
          start: event.start,
          end: event.end,
          date: startDate.toString(),
        };
    if (
      occurrenceOverlapsRange(
        occurrence,
        event.allDay,
        rangeStart,
        rangeEnd,
        timedBounds,
      )
    ) {
      occurrences.push(occurrence);
    }
    return { occurrences, truncated: false };
  }

  if (!recurrenceEnd) return { occurrences: [], truncated: false };
  const searchStart = recurrenceSearchStart(
    event,
    startDate,
    rangeStart,
    durationDays,
    durationMs,
  );
  const firstDate =
    Temporal.PlainDate.compare(searchStart, startDate) > 0
      ? searchStart
      : startDate;
  const lastDate =
    Temporal.PlainDate.compare(rangeEnd, recurrenceEnd) < 0
      ? rangeEnd
      : recurrenceEnd;
  if (Temporal.PlainDate.compare(firstDate, lastDate) > 0) {
    return { occurrences, truncated };
  }

  if (event.recurrence === "monthly") {
    const anchorDay = startDate.day;
    let month = firstDate.with({ day: 1 });
    while (Temporal.PlainDate.compare(month, lastDate) <= 0) {
      if (anchorDay <= month.daysInMonth) {
        const candidateDate = month.with({ day: anchorDay });
        if (
          Temporal.PlainDate.compare(candidateDate, firstDate) >= 0 &&
          Temporal.PlainDate.compare(candidateDate, lastDate) <= 0 &&
          add(candidateDate)
        )
          break;
      }
      month = month.add({ months: 1 });
    }
  } else {
    const stepDays = event.recurrence === "weekly" ? 7 : 1;
    const elapsedDays = firstDate.since(startDate, { largestUnit: "day" }).days;
    const periods = Math.ceil(elapsedDays / stepDays);
    let date = startDate.add({ days: periods * stepDays });
    while (Temporal.PlainDate.compare(date, lastDate) <= 0) {
      if (add(date)) break;
      date = date.add({ days: stepDays });
    }
  }
  return { occurrences, truncated };
}

export const expandEventOccurrences = expandBoardEventOccurrences;

export type AnnouncementLifecycleStatus =
  "draft" | "scheduled" | "published" | "expired" | "archived";

export type BoardAnnouncementLifecycle = {
  status: AnnouncementLifecycleStatus;
  visible: boolean;
  revision: BoardAnnouncementRevision | null;
};

function clock(value: string | number | Date): Date | null {
  const result =
    value instanceof Date ? new Date(value.valueOf()) : new Date(value);
  return Number.isNaN(result.valueOf()) ? null : result;
}

function lifecycleTime(value: string | null): number | null {
  if (!value) return null;
  if (DATE_PATTERN.test(value)) {
    const date = parseDate(value);
    return date
      ? Number(
          date
            .add({ days: 1 })
            .toZonedDateTime({ timeZone: "UTC", plainTime: "00:00" })
            .epochMilliseconds,
        )
      : null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.valueOf();
}

function currentRevision(
  announcement: BoardAnnouncement,
  publishedAt: string,
): BoardAnnouncementRevision {
  return {
    id: `${announcement.id}:published`,
    authorId: announcement.authorId,
    title: announcement.title,
    body: announcement.body,
    audience: announcement.audience,
    expiresAt: announcement.expiresAt,
    publishedAt,
    createdAt: announcement.createdAt,
    updatedAt: announcement.updatedAt,
    attachments: announcement.attachments,
    links: announcement.links,
  };
}

function validAnnouncementClock(value: string | null): boolean {
  return value === null || lifecycleTime(value) !== null;
}

/** Validate announcement content and its draft/publish/schedule intent. */
export function validateBoardAnnouncement(
  announcement: BoardAnnouncement,
  intent: "draft" | "publish" | "schedule",
  now: string,
): BoardCommandValidation {
  const errors: string[] = [];
  if (!announcement.title.trim())
    errors.push("Announcement title is required.");
  if (announcement.title.length > BOARD_INPUT_LIMITS.maxAnnouncementTitle)
    errors.push("Announcement title must be 100 characters or fewer.");
  if (!announcement.body.trim()) errors.push("Announcement body is required.");
  if (announcement.body.length > BOARD_INPUT_LIMITS.maxAnnouncementBody)
    errors.push("Announcement body must be 2,000 characters or fewer.");
  if (!validAnnouncementClock(announcement.publishAt))
    errors.push("Choose a valid publish time.");
  if (!validAnnouncementClock(announcement.expiresAt))
    errors.push("Choose a valid expiration time.");

  const current = clock(now);
  const publishAt = lifecycleTime(announcement.publishAt);
  const expiresAt = lifecycleTime(announcement.expiresAt);
  if (!current) errors.push("The validation clock is invalid.");
  if (announcement.status === "archived")
    errors.push("Archived announcements cannot be changed.");
  if (intent === "schedule") {
    if (publishAt === null)
      errors.push("Scheduled announcements need a publish time.");
    else if (current && publishAt <= current.valueOf())
      errors.push("Choose a future publish time.");
  }
  if (
    intent === "publish" &&
    expiresAt !== null &&
    current &&
    expiresAt <= current.valueOf()
  )
    errors.push("Expiration must be after the publish time.");
  if (
    intent === "schedule" &&
    publishAt !== null &&
    expiresAt !== null &&
    expiresAt <= publishAt
  )
    errors.push("Expiration must be after the publish time.");

  return errors.length === 0
    ? { ok: true }
    : { ok: false, error: errors.join(" ") };
}

/** Resolve reader-facing announcement state without mutating the draft. */
export function getAnnouncementLifecycle(
  announcement: BoardAnnouncement,
  now: string | number | Date = new Date(),
): BoardAnnouncementLifecycle {
  const current = clock(now);
  if (!current) return { status: "draft", visible: false, revision: null };

  if (announcement.status === "archived")
    return {
      status: "archived",
      visible: false,
      revision: announcement.publishedRevision,
    };

  let status: AnnouncementLifecycleStatus = announcement.status;
  let revision: BoardAnnouncementRevision | null = null;

  if (announcement.status === "draft") {
    revision = announcement.publishedRevision;
    if (!revision) return { status: "draft", visible: false, revision: null };
    status = "published";
  } else if (announcement.status === "scheduled") {
    const publishAt = lifecycleTime(announcement.publishAt);
    if (publishAt === null || current.valueOf() < publishAt) {
      // A scheduled draft must not hide the last published revision while it
      // is waiting. Its audience and expiry remain authoritative until the
      // replacement reaches its publish time.
      revision = announcement.publishedRevision;
      if (!revision)
        return { status: "scheduled", visible: false, revision: null };
      status = "published";
    } else {
      revision = currentRevision(
        announcement,
        announcement.publishAt ?? current.toISOString(),
      );
      status = "published";
    }
  } else {
    revision =
      announcement.publishedRevision ??
      currentRevision(
        announcement,
        announcement.publishAt ?? announcement.updatedAt,
      );
  }

  const expiresAt = lifecycleTime(revision?.expiresAt ?? null);
  if (expiresAt !== null && current.valueOf() >= expiresAt)
    return { status: "expired", visible: false, revision };
  return { status, visible: true, revision };
}

export const resolveAnnouncementLifecycle = getAnnouncementLifecycle;

export type BoardViewer = {
  id: string;
  active: boolean;
  accessStatus?: string;
  roleIds?: readonly string[];
  departmentIds?: readonly string[];
  role?: string;
  roles?: readonly string[];
  departments?: readonly string[];
};

function normalized(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

function activeViewer(viewer: BoardViewer): boolean {
  return viewer.active && (viewer.accessStatus ?? "active") === "active";
}

/** Return whether an active sample identity may see an audience. */
export function canViewBoardAudience(
  audience: BoardAudience,
  viewer: BoardViewer,
  ownerId?: string,
): boolean {
  if (!activeViewer(viewer)) return false;
  switch (audience.kind) {
    case "private":
      return (
        audience.unresolved === undefined &&
        ownerId !== undefined &&
        ownerId === viewer.id
      );
    case "everyone":
      return true;
    case "identity":
      return audience.id === viewer.id;
    case "role":
      return (
        viewer.roleIds?.includes(audience.id) === true ||
        viewer.roles?.includes(audience.id) === true ||
        viewer.role === audience.id
      );
    case "department":
      return (
        viewer.departmentIds?.includes(audience.id) === true ||
        viewer.departments?.some(
          (department) =>
            department === audience.id ||
            normalized(department) === normalized(audience.id),
        ) === true
      );
  }
}

export const isBoardAudienceVisible = canViewBoardAudience;

export function encodeBoardAudience(audience: BoardAudience): string {
  if (audience.kind === "private") return "private";
  if (audience.kind === "everyone") return "everyone";
  return `${audience.kind}:${audience.id}`;
}

export function boardAudienceLabel(
  audience: BoardAudience,
  lookup: BoardAudienceLookup = {},
): string {
  if (audience.kind === "private") {
    return audience.unresolved
      ? `Only me · unresolved ${audience.unresolved.kind === "role" ? "role" : "person"}`
      : "Only me";
  }
  if (audience.kind === "everyone") return "Everyone";
  if (audience.kind === "role")
    return `Role: ${lookup.roles?.find((role) => role.id === audience.id)?.name ?? "Unresolved"}`;
  if (audience.kind === "identity")
    return `User: ${lookup.identities?.find((identity) => identity.id === audience.id)?.name ?? "Unresolved"}`;
  return `Department: ${lookup.departments?.find((department) => department.id === audience.id)?.name ?? "Unresolved"}`;
}

export type BoardReminderTiming = "now" | "start" | "15m" | "1d";
export const BOARD_REMINDER_TIMINGS: readonly BoardReminderTiming[] = [
  "now",
  "start",
  "15m",
  "1d",
];

function occurrenceInstant(start: string): Date | null {
  if (DATE_PATTERN.test(start)) {
    const date = parseDate(start);
    return date
      ? new Date(
          Number(
            date.toZonedDateTime({ timeZone: "UTC", plainTime: "00:00" })
              .epochMilliseconds,
          ),
        )
      : null;
  }
  const result = new Date(start);
  return Number.isNaN(result.valueOf()) ? null : result;
}

export function getReminderDueAt(
  occurrence: Pick<BoardEventOccurrence, "start">,
  timing: BoardReminderTiming,
  now: string | number | Date = new Date(),
): string {
  const start = occurrenceInstant(occurrence.start);
  const current = clock(now) ?? new Date(0);
  if (!start) return current.toISOString();
  const offset =
    timing === "15m" ? 15 * MINUTE_MS : timing === "1d" ? DAY_MS : 0;
  return new Date(
    timing === "now" ? current.valueOf() : start.valueOf() - offset,
  ).toISOString();
}

export function boardReminderKey(
  reminder: Pick<
    BoardReminder,
    "eventId" | "identityId" | "occurrenceStart" | "dueAt"
  >,
): string {
  return `${reminder.identityId}:${reminder.eventId}:${reminder.occurrenceStart}:${reminder.dueAt}`;
}

export function dedupeBoardReminders(
  reminders: readonly BoardReminder[],
): BoardReminder[] {
  const seen = new Set<string>();
  return reminders.filter((reminder) => {
    const key = boardReminderKey(reminder);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function dueBoardReminders(
  reminders: readonly BoardReminder[],
  now: string | number | Date = new Date(),
): BoardReminder[] {
  const current = clock(now);
  if (!current) return [];
  return dedupeBoardReminders(reminders).filter(
    (reminder) =>
      reminder.status === "pending" &&
      (() => {
        const dueAt = new Date(reminder.dueAt);
        return (
          !Number.isNaN(dueAt.valueOf()) && dueAt.valueOf() <= current.valueOf()
        );
      })(),
  );
}
