import { expect, test } from "@playwright/test";
import type {
  BoardAnnouncement,
  BoardEvent,
} from "../../../src/components/systems/boards/domain/model";
import {
  canViewBoardAudience,
  dedupeBoardReminders,
  expandBoardEventOccurrences,
  getAnnouncementLifecycle,
  getReminderDueAt,
  inspectBoardEvent,
  validateBoardEvent,
  validateBoardAnnouncement,
  type BoardEventOccurrence,
  type BoardViewer,
} from "../../../src/components/systems/boards/domain/content";

const baseEvent: BoardEvent = {
  id: "event-briefing",
  boardId: "sample-board-organization",
  authorId: "sample-mara",
  title: "Weekly briefing",
  details: "Review open work.",
  location: "Operations room",
  start: "2026-09-14",
  end: "2026-09-14",
  allDay: true,
  timezone: "Asia/Manila",
  audience: { kind: "everyone" },
  recurrence: "none",
  endDate: null,
  attachments: [],
  links: [],
  archived: false,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
};

function event(overrides: Partial<BoardEvent> = {}): BoardEvent {
  return { ...baseEvent, ...overrides };
}

test("event validation distinguishes all-day dates from timed UTC instants", () => {
  expect(validateBoardEvent(event())).toEqual({ ok: true });
  expect(inspectBoardEvent(event())).toEqual({ valid: true, issues: [] });

  const timed = event({
    allDay: false,
    start: "2026-09-14T01:00:00.000Z",
    end: "2026-09-14T02:00:00.000Z",
    timezone: "Asia/Manila",
  });
  expect(validateBoardEvent(timed)).toEqual({ ok: true });

  const invalid = inspectBoardEvent(
    event({
      allDay: true,
      start: "2026-02-30",
      end: "2026-09-13T00:00:00.000Z",
      timezone: "Not/AZone",
      recurrence: "daily",
      endDate: null,
    }),
  );
  expect(invalid.valid).toBe(false);
  expect(invalid.issues.map((issue) => issue.field)).toEqual(
    expect.arrayContaining(["start", "end", "timezone", "endDate"]),
  );
});

test("announcement command validation distinguishes draft, publish, and schedule intent", () => {
  const announcement: BoardAnnouncement = {
    id: "announcement-validation",
    boardId: "sample-board-organization",
    authorId: "sample-mara",
    title: "A notice",
    body: "A message",
    audience: { kind: "everyone" },
    status: "draft",
    publishAt: null,
    expiresAt: null,
    pinned: false,
    attachments: [],
    links: [],
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    publishedRevision: null,
  };
  expect(
    validateBoardAnnouncement(
      announcement,
      "draft",
      "2026-09-14T01:00:00.000Z",
    ),
  ).toEqual({ ok: true });
  expect(
    validateBoardAnnouncement(
      announcement,
      "schedule",
      "2026-09-14T01:00:00.000Z",
    ),
  ).toEqual(expect.objectContaining({ ok: false }));
  expect(
    validateBoardAnnouncement(
      { ...announcement, publishAt: "2026-09-14T02:00:00.000Z" },
      "schedule",
      "2026-09-14T01:00:00.000Z",
    ),
  ).toEqual({ ok: true });
});

test("recurrence expansion is inclusive, skips nonexistent monthly dates, and reports the cap", () => {
  const monthly = event({
    id: "event-monthly",
    start: "2026-01-31",
    end: "2026-01-31",
    recurrence: "monthly",
    endDate: "2026-04-30",
  });
  const expanded = expandBoardEventOccurrences(monthly, {
    start: "2026-01-01",
    end: "2026-04-30",
  });

  expect(expanded.truncated).toBe(false);
  expect(expanded.occurrences.map((occurrence) => occurrence.date)).toEqual([
    "2026-01-31",
    "2026-03-31",
  ]);
  expect(expanded.occurrences[0]).toEqual({
    id: "event-monthly:2026-01-31",
    eventId: "event-monthly",
    start: "2026-01-31",
    end: "2026-01-31",
    date: "2026-01-31",
  });

  const daily = event({
    id: "event-daily",
    recurrence: "daily",
    endDate: "2027-01-01",
  });
  const capped = expandBoardEventOccurrences(
    daily,
    { start: "2026-09-14", end: "2027-01-01" },
    100,
  );
  expect(capped.occurrences).toHaveLength(100);
  expect(capped.truncated).toBe(true);
});

test("monthly recurrence stops before an anchor date after repeat-until", () => {
  const monthly = event({
    id: "event-monthly-boundary",
    start: "2026-01-31",
    end: "2026-01-31",
    recurrence: "monthly",
    endDate: "2026-03-10",
  });

  const expanded = expandBoardEventOccurrences(monthly, {
    start: "2026-01-01",
    end: "2026-03-31",
  });

  expect(expanded).toEqual({
    occurrences: [
      expect.objectContaining({
        date: "2026-01-31",
        start: "2026-01-31",
        end: "2026-01-31",
      }),
    ],
    truncated: false,
  });
});

test("all-day occurrence duration stays inclusive and recurring spans include an earlier start", () => {
  const recurring = event({
    id: "event-all-day-span",
    start: "2026-09-14",
    end: "2026-09-16",
    recurrence: "daily",
    endDate: "2026-09-17",
  });

  const expanded = expandBoardEventOccurrences(recurring, {
    start: "2026-09-15",
    end: "2026-09-15",
  });

  expect(expanded.occurrences.map((occurrence) => occurrence.date)).toEqual([
    "2026-09-14",
    "2026-09-15",
  ]);
  expect(expanded.occurrences.map((occurrence) => occurrence.end)).toEqual([
    "2026-09-16",
    "2026-09-17",
  ]);
});

test("timed recurring spans use an exclusive end when selecting a day", () => {
  const recurring = event({
    id: "event-timed-span",
    allDay: false,
    start: "2026-09-14T00:00:00.000Z",
    end: "2026-09-16T00:00:00.000Z",
    timezone: "UTC",
    recurrence: "daily",
    endDate: "2026-09-16",
  });

  const expanded = expandBoardEventOccurrences(recurring, {
    start: "2026-09-16",
    end: "2026-09-16",
  });

  expect(expanded.occurrences.map((occurrence) => occurrence.date)).toEqual([
    "2026-09-15",
    "2026-09-16",
  ]);
  expect(expanded.occurrences[0]).toEqual(
    expect.objectContaining({
      start: "2026-09-15T00:00:00.000Z",
      end: "2026-09-17T00:00:00.000Z",
    }),
  );
});

test("long recurring queries return only the requested window", () => {
  const daily = event({
    id: "event-long-history",
    start: "0001-01-01",
    end: "0001-01-01",
    recurrence: "daily",
    endDate: "9999-12-31",
  });

  const expanded = expandBoardEventOccurrences(daily, {
    start: "9999-12-31",
    end: "9999-12-31",
  });

  expect(expanded).toEqual({
    occurrences: [
      expect.objectContaining({
        date: "9999-12-31",
        start: "9999-12-31",
        end: "9999-12-31",
      }),
    ],
    truncated: false,
  });
});

test("announcement lifecycle serves the published revision while draft edits remain private", () => {
  const announcement: BoardAnnouncement = {
    id: "announcement-briefing",
    boardId: "sample-board-organization",
    authorId: "sample-mara",
    title: "Draft title",
    body: "Draft body",
    audience: { kind: "everyone" },
    status: "draft",
    publishAt: null,
    expiresAt: null,
    pinned: false,
    attachments: [],
    links: [],
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T01:00:00.000Z",
    publishedRevision: {
      id: "announcement-briefing:published",
      authorId: "sample-mara",
      title: "Published title",
      body: "Published body",
      publishedAt: "2026-09-13T00:00:00.000Z",
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z",
      audience: { kind: "everyone" },
      expiresAt: null,
      attachments: [],
      links: [],
    },
  };

  expect(
    getAnnouncementLifecycle(announcement, "2026-09-14T02:00:00.000Z"),
  ).toEqual(
    expect.objectContaining({
      status: "published",
      visible: true,
      revision: expect.objectContaining({ title: "Published title" }),
    }),
  );

  const changedDraft = {
    ...announcement,
    audience: { kind: "private" as const },
    expiresAt: "2026-09-14T01:30:00.000Z",
  };
  expect(
    getAnnouncementLifecycle(changedDraft, "2026-09-14T02:00:00.000Z"),
  ).toEqual(
    expect.objectContaining({
      status: "published",
      visible: true,
      revision: expect.objectContaining({
        audience: { kind: "everyone" },
        expiresAt: null,
      }),
    }),
  );

  const scheduled = {
    ...announcement,
    status: "scheduled" as const,
    publishAt: "2026-09-15T00:00:00.000Z",
    publishedRevision: null,
  };
  expect(
    getAnnouncementLifecycle(scheduled, "2026-09-14T23:59:59.000Z"),
  ).toEqual(expect.objectContaining({ status: "scheduled", visible: false }));

  const scheduledReplacement = {
    ...announcement,
    ...scheduled,
    audience: { kind: "private" as const },
    expiresAt: "2026-09-14T23:30:00.000Z",
    publishedRevision: announcement.publishedRevision,
  };
  expect(
    getAnnouncementLifecycle(scheduledReplacement, "2026-09-14T23:59:59.000Z"),
  ).toEqual(
    expect.objectContaining({
      status: "published",
      visible: true,
      revision: expect.objectContaining({
        title: "Published title",
        audience: { kind: "everyone" },
        expiresAt: null,
      }),
    }),
  );
  expect(
    getAnnouncementLifecycle(scheduled, "2026-09-15T00:00:00.000Z"),
  ).toEqual(expect.objectContaining({ status: "published", visible: true }));
});

const activeViewer: BoardViewer = {
  id: "sample-eli",
  active: true,
  roleIds: ["sample-member"],
  departmentIds: ["operations"],
};

test("audience visibility requires an active identity and honours owner, role, and department semantics", () => {
  expect(canViewBoardAudience({ kind: "everyone" }, activeViewer)).toBe(true);
  expect(
    canViewBoardAudience({ kind: "role", id: "sample-member" }, activeViewer),
  ).toBe(true);
  expect(
    canViewBoardAudience(
      { kind: "department", id: "operations" },
      activeViewer,
    ),
  ).toBe(true);
  expect(
    canViewBoardAudience({ kind: "private" }, activeViewer, "sample-eli"),
  ).toBe(true);
  expect(
    canViewBoardAudience({ kind: "identity", id: "sample-mara" }, activeViewer),
  ).toBe(false);
  expect(
    canViewBoardAudience(
      { kind: "everyone" },
      { ...activeViewer, active: false },
    ),
  ).toBe(false);
  expect(
    canViewBoardAudience(
      { kind: "private", unresolved: { kind: "identity", id: "unknown" } },
      activeViewer,
      activeViewer.id,
    ),
  ).toBe(false);
});

test("reminder due times and keys deduplicate by identity, occurrence, and timing", () => {
  const occurrence: BoardEventOccurrence = {
    id: "event-briefing:2026-09-14",
    eventId: "event-briefing",
    start: "2026-09-14T01:00:00.000Z",
    end: "2026-09-14T02:00:00.000Z",
    date: "2026-09-14",
  };
  expect(getReminderDueAt(occurrence, "15m")).toBe("2026-09-14T00:45:00.000Z");
  expect(getReminderDueAt(occurrence, "1d")).toBe("2026-09-13T01:00:00.000Z");

  const reminders = [
    {
      id: "reminder-first",
      eventId: occurrence.eventId,
      identityId: "sample-eli",
      occurrenceStart: occurrence.start,
      dueAt: "2026-09-14T00:45:00.000Z",
      status: "pending" as const,
      createdAt: "2026-09-13T00:00:00.000Z",
    },
    {
      id: "reminder-duplicate",
      eventId: occurrence.eventId,
      identityId: "sample-eli",
      occurrenceStart: occurrence.start,
      dueAt: "2026-09-14T00:45:00.000Z",
      status: "fired" as const,
      createdAt: "2026-09-13T00:01:00.000Z",
    },
  ];
  expect(dedupeBoardReminders(reminders)).toEqual([reminders[0]]);
});
