import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  BoardEventOccurrencePage,
  BoardEventPage,
} from "../../src/components/systems/boards/adapters/board-events-api";
import {
  ServerBoardCalendarDisplay,
  calendarDayCountLabel,
  canEditBoardEvent,
} from "../../src/components/systems/boards/components/server-backed-board-calendar";
import {
  prepareBoardEventLifecycleAction,
  ServerArchivedBoardEventsDisplay,
} from "../../src/components/systems/boards/components/server-backed-board-event-lifecycle";
import {
  BoardEventDraftError,
  boardEventDraftFromEvent,
  boardEventInputFromDraft,
  newBoardEventDraft,
  prepareBoardEventConflictRetry,
} from "../../src/components/systems/boards/components/server-backed-board-event-editor";
import {
  calendarWindowForMonth,
  shiftCalendarMonth,
  transitionCalendarState,
  type CalendarState,
} from "../../src/components/systems/boards/hooks/use-server-board-events";

const boardId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";
const authorId = "00000000-0000-4000-8000-000000000003";
const visibleOccurrence: BoardEventOccurrencePage["items"][number] = {
  id: `${eventId}:2026-09-14`,
  eventId,
  date: "2026-09-14",
  start: "2026-09-14",
  end: "2026-09-16",
  event: {
    id: eventId,
    boardId,
    authorId,
    title: "Visible planning session",
    details: "",
    location: "",
    links: [],
    allDay: true,
    startDate: "2026-09-14",
    endDate: "2026-09-16",
    startAt: null,
    endAt: null,
    timezoneName: "Asia/Manila",
    recurrence: "none",
    repeatUntil: null,
    audience: {
      kind: "everyone",
      roleId: null,
      userId: null,
      departmentId: null,
    },
    archived: false,
    revision: 1,
    boardRevision: 1,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  },
};
const page: BoardEventOccurrencePage = {
  items: [visibleOccurrence],
  pagination: { limit: 100, offset: 0, count: 1, total: 1, hasMore: false },
  boardRevision: 1,
};

test("calendar month navigation requests one inclusive bounded month", () => {
  expect(calendarWindowForMonth("2026-09")).toMatchObject({
    start: "2026-09-01",
    end: "2026-09-30",
  });
  expect(shiftCalendarMonth("2026-12", 1)).toBe("2027-01");
  expect(shiftCalendarMonth("2026-01", -1)).toBe("2025-12");
});

test("calendar appends the next page only while Board revision and occurrence total are stable", async () => {
  const eventsHookModule =
    await import("../../src/components/systems/boards/hooks/use-server-board-events");
  const merge = eventsHookModule.mergeCalendarOccurrencePages as (
    first: BoardEventOccurrencePage,
    next: BoardEventOccurrencePage,
  ) => BoardEventOccurrencePage | null;
  const first: BoardEventOccurrencePage = {
    ...page,
    pagination: { limit: 100, offset: 0, count: 1, total: 2, hasMore: true },
  };
  const nextItem = {
    ...visibleOccurrence,
    id: `${eventId}:2026-09-15`,
    date: "2026-09-15",
  };
  const next: BoardEventOccurrencePage = {
    ...page,
    items: [nextItem],
    pagination: { limit: 100, offset: 1, count: 1, total: 2, hasMore: false },
  };
  const merged = merge(first, next);
  expect(merged?.items.map((item) => item.id)).toEqual([
    visibleOccurrence.id,
    nextItem.id,
  ]);
  expect(merged?.pagination).toEqual({
    limit: 100,
    offset: 0,
    count: 2,
    total: 2,
    hasMore: false,
  });
  expect(merge(first, { ...next, boardRevision: 2 })).toBeNull();
  expect(
    merge(first, { ...next, pagination: { ...next.pagination, total: 3 } }),
  ).toBeNull();
});

test("calendar compact default follows the 1024px boundary", async () => {
  const calendarModule =
    await import("../../src/components/systems/boards/components/server-backed-board-calendar");
  const defaultView = calendarModule.defaultCalendarViewForViewport as (
    compact: boolean,
  ) => "agenda" | "month";
  expect(defaultView(true)).toBe("agenda");
  expect(defaultView(false)).toBe("month");
});

test("calendar renders only returned occurrences and marks all-day range", () => {
  const html = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      page,
      window: calendarWindowForMonth("2026-09"),
      date: "2026-09-15",
    }),
  );
  expect(html).toContain("Visible planning session");
  expect(html).toContain("All day");
  expect(html).toContain("Sep 15");
  expect(html).not.toContain("Hidden payroll review");
  expect(html).not.toContain("sample-board");
  const afterRange = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      page,
      window: calendarWindowForMonth("2026-09"),
      date: "2026-09-17",
    }),
  );
  expect(afterRange).not.toContain("Visible planning session");
});

test("calendar shows an edit action only for an explicitly authorized returned event", () => {
  const window = calendarWindowForMonth("2026-09");
  const allowed = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      page,
      window,
      date: "2026-09-15",
      canEditEvent: () => true,
      onEditEvent: () => undefined,
    }),
  );
  expect(allowed).toContain("Edit Visible planning session");
  const denied = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      page,
      window,
      date: "2026-09-15",
      canEditEvent: () => false,
      onEditEvent: () => undefined,
    }),
  );
  expect(denied).not.toContain("Edit Visible planning session");
  const noAccess = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      page,
      window,
      date: "2026-09-15",
    }),
  );
  expect(noAccess).not.toContain("Edit Visible planning session");
});

test("calendar offers archive only for a manager-approved returned event, not an author with edit access", () => {
  const window = calendarWindowForMonth("2026-09");
  const manager = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      page,
      window,
      date: "2026-09-15",
      canEditEvent: () => true,
      onEditEvent: () => undefined,
      canArchiveEvent: () => true,
      onArchiveEvent: () => undefined,
    }),
  );
  expect(manager).toContain("Archive Visible planning session");
  const editor = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      page,
      window,
      date: "2026-09-15",
      canEditEvent: () => true,
      onEditEvent: () => undefined,
      canArchiveEvent: () => false,
      onArchiveEvent: () => undefined,
    }),
  );
  expect(editor).toContain("Edit Visible planning session");
  expect(editor).not.toContain("Archive Visible planning session");
});

test("event edit authority requires current Board edit and author or manager", () => {
  const event = visibleOccurrence.event;
  const author = { view: true, edit: true, manage: false };
  expect(canEditBoardEvent(event, boardId, authorId, author, true)).toBe(true);
  expect(canEditBoardEvent(event, boardId, eventId, author, true)).toBe(false);
  expect(
    canEditBoardEvent(
      event,
      boardId,
      eventId,
      { ...author, manage: true },
      true,
    ),
  ).toBe(true);
  expect(
    canEditBoardEvent(
      event,
      boardId,
      authorId,
      { ...author, edit: false },
      true,
    ),
  ).toBe(false);
  expect(canEditBoardEvent(event, boardId, authorId, author, false)).toBe(
    false,
  );
  expect(canEditBoardEvent(event, eventId, authorId, author, true)).toBe(false);
  expect(
    canEditBoardEvent(
      { ...event, archived: true },
      boardId,
      authorId,
      author,
      true,
    ),
  ).toBe(false);
});

test("event lifecycle requires Board manager access and current revision, not author edit", () => {
  const event = visibleOccurrence.event;
  const author = { view: true, edit: true, manage: false };
  expect(
    prepareBoardEventLifecycleAction(
      event,
      boardId,
      1,
      author,
      true,
      "archive",
    ),
  ).toBeNull();
  const manager = { view: true, edit: false, manage: true };
  expect(
    prepareBoardEventLifecycleAction(
      event,
      boardId,
      1,
      manager,
      true,
      "archive",
    ),
  ).toMatchObject({
    kind: "archive",
    boardId,
    eventId,
    boardRevision: 1,
    eventRevision: 1,
  });
  expect(
    prepareBoardEventLifecycleAction(
      event,
      boardId,
      2,
      manager,
      true,
      "archive",
    ),
  ).toBeNull();
  expect(
    prepareBoardEventLifecycleAction(
      event,
      eventId,
      1,
      manager,
      true,
      "archive",
    ),
  ).toBeNull();
  expect(
    prepareBoardEventLifecycleAction(
      event,
      boardId,
      1,
      manager,
      false,
      "archive",
    ),
  ).toBeNull();
  expect(
    prepareBoardEventLifecycleAction(
      event,
      boardId,
      1,
      manager,
      true,
      "restore",
    ),
  ).toBeNull();
  expect(
    prepareBoardEventLifecycleAction(
      { ...event, archived: true },
      boardId,
      1,
      manager,
      true,
      "restore",
    ),
  ).toMatchObject({ kind: "restore", eventId });
});

test("archived event list exposes only returned content and gated restore actions", () => {
  const archived = { ...visibleOccurrence.event, archived: true };
  const archivedPage: BoardEventPage = {
    items: [archived],
    pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
    boardRevision: 1,
  };
  const markup = (allowed: boolean) =>
    renderToStaticMarkup(
      createElement(ServerArchivedBoardEventsDisplay, {
        page: archivedPage,
        canRestoreEvent: () => allowed,
        onRestoreEvent: () => undefined,
      }),
    );
  expect(markup(true)).toContain("Restore Visible planning session");
  expect(markup(false)).not.toContain("Restore Visible planning session");
  expect(markup(true)).not.toContain("Hidden payroll review");
  expect(markup(true)).not.toContain(authorId);
});

test("event editor creates valid all-day series input and retains client draft on invalid dates", () => {
  const draft = {
    ...newBoardEventDraft(boardId, 5, "2026-09-15"),
    title: "  Safety briefing  ",
    recurrence: "weekly" as const,
    repeatUntil: "2026-10-15",
  };
  expect(boardEventInputFromDraft(draft)).toMatchObject({
    boardRevision: 5,
    title: "Safety briefing",
    allDay: true,
    startDate: "2026-09-15",
    endDate: "2026-09-15",
    repeatUntil: "2026-10-15",
    audience: { kind: "everyone" },
  });
  expect(() =>
    boardEventInputFromDraft({ ...draft, end: "2026-09-14" }),
  ).toThrow(BoardEventDraftError);
  expect(() =>
    boardEventInputFromDraft({ ...draft, repeatUntil: "2026-09-01" }),
  ).toThrow(BoardEventDraftError);
});

test("event editor submits a chosen active target and rejects an unchosen target", () => {
  const draft = {
    ...newBoardEventDraft(boardId, 5, "2026-09-15"),
    title: "Department briefing",
    audience: {
      kind: "department" as const,
      targetId: "00000000-0000-4000-8000-000000000004",
    },
  };
  expect(boardEventInputFromDraft(draft)).toMatchObject({
    audience: {
      kind: "department",
      departmentId: "00000000-0000-4000-8000-000000000004",
    },
  });
  expect(() =>
    boardEventInputFromDraft({
      ...draft,
      audience: { kind: "department", targetId: null },
    }),
  ).toThrow(BoardEventDraftError);
});

test("event editor retains external links and rejects unsafe link input", () => {
  const event = {
    ...visibleOccurrence.event,
    links: [{ label: "Safety policy", url: "https://example.org/safety" }],
  };
  const draft = boardEventDraftFromEvent(event);
  expect(draft.links).toEqual(event.links);
  expect(boardEventInputFromDraft(draft)).not.toHaveProperty("links");
  expect(
    boardEventInputFromDraft({
      ...newBoardEventDraft(boardId, 1, "2026-09-15"),
      title: "New linked event",
      links: event.links,
    }),
  ).toMatchObject({ links: event.links });
  expect(() =>
    boardEventInputFromDraft({
      ...draft,
      links: [{ label: "Unsafe", url: "javascript:alert(1)" }],
    }),
  ).toThrow(BoardEventDraftError);
  expect(() =>
    boardEventInputFromDraft({
      ...draft,
      links: [{ label: "Credentials", url: "https://name:secret@example.org" }],
    }),
  ).toThrow(BoardEventDraftError);
  expect(() =>
    boardEventInputFromDraft({
      ...draft,
      links: Array.from({ length: 21 }, (_, index) => ({
        label: `Link ${index + 1}`,
        url: "https://example.org",
      })),
    }),
  ).toThrow(BoardEventDraftError);
});

test("title-only conflict retry keeps the other editor's newer links", () => {
  const original = {
    ...visibleOccurrence.event,
    links: [{ label: "Old policy", url: "https://example.org/old" }],
  };
  const latestLinks = [{ label: "New policy", url: "https://example.org/new" }];
  const draft = { ...boardEventDraftFromEvent(original), title: "New title" };
  expect(boardEventInputFromDraft(draft)).not.toHaveProperty("links");
  const retry = prepareBoardEventConflictRetry(draft, {
    boardId,
    boardRevision: 7,
    boardActive: true,
    event: { ...original, revision: 3, boardRevision: 7, links: latestLinks },
  });
  expect(retry.links).toEqual(latestLinks);
  expect(boardEventInputFromDraft(retry)).toMatchObject({
    boardRevision: 7,
    eventRevision: 3,
    title: "New title",
  });
  expect(boardEventInputFromDraft(retry)).not.toHaveProperty("links");
});

test("intentional link replacement survives a conflict retry", () => {
  const original = {
    ...visibleOccurrence.event,
    links: [{ label: "Old policy", url: "https://example.org/old" }],
  };
  const myLinks = [{ label: "My policy", url: "https://example.org/mine" }];
  const latestLinks = [{ label: "New policy", url: "https://example.org/new" }];
  const draft = { ...boardEventDraftFromEvent(original), links: myLinks };
  expect(boardEventInputFromDraft(draft)).toMatchObject({ links: myLinks });
  const retry = prepareBoardEventConflictRetry(draft, {
    boardId,
    boardRevision: 7,
    boardActive: true,
    event: { ...original, revision: 3, boardRevision: 7, links: latestLinks },
  });
  expect(retry.links).toEqual(myLinks);
  expect(boardEventInputFromDraft(retry)).toMatchObject({
    boardRevision: 7,
    eventRevision: 3,
    links: myLinks,
  });
});

test("event editor updates timed series in its IANA timezone without changing a restricted audience", () => {
  const event = {
    ...visibleOccurrence.event,
    allDay: false as const,
    startDate: null,
    endDate: null,
    startAt: "2026-09-14T01:00:00Z",
    endAt: "2026-09-14T02:00:00Z",
    recurrence: "weekly" as const,
    repeatUntil: "2026-10-15",
    audience: {
      kind: "role" as const,
      roleId: "00000000-0000-4000-8000-000000000090",
      userId: null,
      departmentId: null,
    },
  };
  const draft = boardEventDraftFromEvent(event);
  expect(draft).toMatchObject({
    start: "2026-09-14T09:00",
    end: "2026-09-14T10:00",
    audience: "keep",
  });
  const input = boardEventInputFromDraft(draft);
  expect(input).toMatchObject({
    eventRevision: 1,
    boardRevision: 1,
    allDay: false,
    startAt: "2026-09-14T01:00:00Z",
    endAt: "2026-09-14T02:00:00Z",
  });
  expect(input).not.toHaveProperty("audience");
});

test("editing event text preserves untouched subsecond UTC instants", () => {
  const event = {
    ...visibleOccurrence.event,
    allDay: false as const,
    startDate: null,
    endDate: null,
    startAt: "2026-09-14T01:00:00.123456Z",
    endAt: "2026-09-14T02:00:00.987654Z",
  };
  const draft = boardEventDraftFromEvent(event);
  expect(
    boardEventInputFromDraft({ ...draft, title: "Renamed" }),
  ).toMatchObject({
    startAt: event.startAt,
    endAt: event.endAt,
  });
});

test("switching an existing all-day event to timed clears date-only fields", () => {
  const draft = boardEventDraftFromEvent(visibleOccurrence.event);
  expect(
    boardEventInputFromDraft({
      ...draft,
      allDay: false,
      start: "2026-09-14T09:00",
      end: "2026-09-14T10:00",
      timezoneName: "Asia/Manila",
    }),
  ).toMatchObject({
    eventRevision: 1,
    allDay: false,
    startDate: null,
    endDate: null,
    startAt: "2026-09-14T01:00:00Z",
    endAt: "2026-09-14T02:00:00Z",
  });
});

test("explicit conflict retry uses fetched Board and Event revisions while retaining edits", () => {
  const stale = {
    ...boardEventDraftFromEvent(visibleOccurrence.event),
    title: "My revised planning session",
  };
  const latest = {
    boardId,
    boardRevision: 7,
    boardActive: true,
    event: {
      ...visibleOccurrence.event,
      revision: 3,
      boardRevision: 7,
      title: "Someone else's update",
    },
  };
  const retry = prepareBoardEventConflictRetry(stale, latest);
  expect(retry.title).toBe("My revised planning session");
  expect(boardEventInputFromDraft(retry)).toMatchObject({
    boardRevision: 7,
    eventRevision: 3,
    title: "My revised planning session",
  });
  const newEvent = {
    ...newBoardEventDraft(boardId, 2, "2026-09-15"),
    title: "New session",
  };
  expect(
    boardEventInputFromDraft(
      prepareBoardEventConflictRetry(newEvent, {
        boardId,
        boardRevision: 7,
        boardActive: true,
        event: null,
      }),
    ),
  ).toMatchObject({ boardRevision: 7, title: "New session" });
  expect(() =>
    prepareBoardEventConflictRetry(stale, {
      ...latest,
      event: { ...latest.event, id: "00000000-0000-4000-8000-000000000099" },
    }),
  ).toThrow(BoardEventDraftError);
  expect(() =>
    prepareBoardEventConflictRetry(stale, { ...latest, boardActive: false }),
  ).toThrow(BoardEventDraftError);
});

test("event editor requires an explicit UTC offset for ambiguous local times", () => {
  const draft = {
    ...newBoardEventDraft(boardId, 1, "2026-11-01"),
    title: "Clock change",
    allDay: false,
    start: "2026-11-01T01:15",
    end: "2026-11-01T01:45",
    timezoneName: "America/New_York",
  };
  expect(() => boardEventInputFromDraft(draft)).toThrow(/occurs twice/);
  expect(
    boardEventInputFromDraft({
      ...draft,
      startOffset: "-04:00",
      endOffset: "-05:00",
    }),
  ).toMatchObject({
    startAt: "2026-11-01T05:15:00Z",
    endAt: "2026-11-01T06:45:00Z",
  });
});

test("calendar renders returned external event links as safe labelled anchors", () => {
  const linked = {
    ...visibleOccurrence,
    event: {
      ...visibleOccurrence.event,
      links: [
        {
          label: "Safety <script>guide</script>",
          url: "https://example.org/guide?a=1&b=2",
        },
      ],
    },
  };
  const html = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      page: { ...page, items: [linked] },
      window: calendarWindowForMonth("2026-09"),
      date: "2026-09-15",
    }),
  );
  expect(html).toContain("Safety &lt;script&gt;guide&lt;/script&gt;");
  expect(html).toContain('href="https://example.org/guide?a=1&amp;b=2"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('referrerPolicy="no-referrer"');
  expect(html).not.toContain("<script>");
});

test("calendar shows returned event details as escaped plain text", () => {
  const detailed = {
    ...visibleOccurrence,
    event: {
      ...visibleOccurrence.event,
      details: "Bring the <safety> checklist.",
    },
  };
  const html = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      page: { ...page, items: [detailed] },
      window: calendarWindowForMonth("2026-09"),
      date: "2026-09-15",
    }),
  );
  expect(html).toContain("Bring the &lt;safety&gt; checklist.");
  expect(html).not.toContain("<safety>");
});

test("calendar keeps Agenda details inline and offers compact event details on demand", () => {
  const detailed = {
    ...visibleOccurrence,
    event: {
      ...visibleOccurrence.event,
      details: "Bring the planning checklist.",
      location: "Room 3",
    },
  };
  const detailedPage = { ...page, items: [detailed] };
  const window = calendarWindowForMonth("2026-09");
  const agenda = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      page: detailedPage,
      window,
      canEditEvent: () => true,
      onEditEvent: () => undefined,
    }),
  );
  expect(agenda).toContain("Bring the planning checklist.");
  expect(agenda).toContain("Edit event");
  expect(agenda).not.toContain("<details");

  const compactProps = {
    page: detailedPage,
    window,
    date: "2026-09-14",
    compact: true,
    canEditEvent: () => true,
    onEditEvent: () => undefined,
  };
  const selectedDay = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, compactProps),
  );
  expect(selectedDay).toContain("Visible planning session");
  expect(selectedDay).toContain("Room 3");
  expect(selectedDay).toContain("View event");
  expect(selectedDay).toContain("<details");
});

test("timed occurrence displays its event timezone without changing its date", () => {
  const timed: BoardEventOccurrencePage["items"][number] = {
    ...visibleOccurrence,
    id: `${eventId}:2026-09-14T01:00:00Z`,
    date: "2026-09-14",
    start: "2026-09-14T01:00:00Z",
    end: "2026-09-14T02:00:00Z",
    event: {
      ...visibleOccurrence.event,
      allDay: false,
      startDate: null,
      endDate: null,
      startAt: "2026-09-14T01:00:00Z",
      endAt: "2026-09-14T02:00:00Z",
      title: "Timed planning session",
    },
  };
  const html = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      page: { ...page, items: [timed] },
      window: calendarWindowForMonth("2026-09"),
    }),
  );
  expect(html).toContain("Timed planning session");
  expect(html).toContain("Sep 14");
  expect(html).toContain("9:00");
  expect(html).toContain("10:00");
  expect(html).toContain("Asia/Manila");
});

test("overnight timed occurrence appears on the next local day across months, except at exclusive end", () => {
  const overnight: BoardEventOccurrencePage["items"][number] = {
    ...visibleOccurrence,
    id: `${eventId}:2026-08-31T15:00:00Z`,
    date: "2026-08-31",
    start: "2026-08-31T15:00:00Z",
    end: "2026-08-31T17:00:00Z",
    event: {
      ...visibleOccurrence.event,
      allDay: false,
      startDate: null,
      endDate: null,
      startAt: "2026-08-31T15:00:00Z",
      endAt: "2026-08-31T17:00:00Z",
      title: "Overnight handoff",
    },
  };
  const september = calendarWindowForMonth("2026-09");
  const onSeptemberFirst = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      page: { ...page, items: [overnight] },
      window: september,
      date: "2026-09-01",
    }),
  );
  expect(onSeptemberFirst).toContain("Overnight handoff");
  expect(onSeptemberFirst).toContain("Aug 31");
  expect(onSeptemberFirst).toContain("Sep 1");
  const endsAtMidnight = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      page: {
        ...page,
        items: [{ ...overnight, end: "2026-08-31T16:00:00Z" }],
      },
      window: september,
      date: "2026-09-01",
    }),
  );
  expect(endsAtMidnight).not.toContain("Overnight handoff");
});

test("partial occurrence page never presents exact day counts or a confirmed empty day", () => {
  const partial: BoardEventOccurrencePage = {
    ...page,
    pagination: { ...page.pagination, total: 101, hasMore: true },
  };
  expect(calendarDayCountLabel(0, true)).toContain("incomplete");
  expect(calendarDayCountLabel(1, true)).toContain("At least 1 event");
  expect(calendarDayCountLabel(1, false)).toBe("1 event");
  const html = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      page: partial,
      window: calendarWindowForMonth("2026-09"),
      date: "2026-09-17",
    }),
  );
  expect(html).toContain("may be available");
  expect(html).not.toContain("No events on this day.");
});

test("calendar clears switched or denied content and ignores stale response", () => {
  const empty: CalendarState = {
    key: null,
    sequence: 0,
    data: null,
    status: "idle",
    error: null,
  };
  const key = `${boardId}:2026-09-01:2026-09-30`;
  const started = transitionCalendarState(empty, {
    type: "begin",
    key,
    sequence: 1,
  });
  const ready = transitionCalendarState(started, {
    type: "resolve",
    key,
    sequence: 1,
    data: page,
  });
  expect(ready.data?.items[0]?.event.title).toBe("Visible planning session");
  const denied = transitionCalendarState(ready, {
    type: "reject",
    key,
    sequence: 1,
    error: "Calendar unavailable",
    retain: false,
  });
  expect(denied.data).toBeNull();
  const switched = transitionCalendarState(ready, {
    type: "begin",
    key: "00000000-0000-4000-8000-000000000099:2026-09-01:2026-09-30",
    sequence: 2,
  });
  expect(switched.data).toBeNull();
  expect(
    transitionCalendarState(switched, {
      type: "resolve",
      key,
      sequence: 1,
      data: page,
    }),
  ).toEqual(switched);
  const sameMonthRefresh = transitionCalendarState(ready, {
    type: "begin",
    key,
    sequence: 2,
  });
  const transientFailure = transitionCalendarState(sameMonthRefresh, {
    type: "reject",
    key,
    sequence: 2,
    error: "Refresh failed",
    retain: true,
  });
  expect(transientFailure.data).toEqual(page);
  expect(transientFailure.error).toBe("Refresh failed");
});

test("denied latest-version check clears cached occurrences even when retry fails", () => {
  const empty: CalendarState = {
    key: null,
    sequence: 0,
    data: null,
    status: "idle",
    error: null,
  };
  const key = `${boardId}:2026-09-01:2026-09-30`;
  const ready = transitionCalendarState(
    transitionCalendarState(empty, { type: "begin", key, sequence: 1 }),
    { type: "resolve", key, sequence: 1, data: page },
  );
  const denied = transitionCalendarState(ready, {
    type: "invalidate",
    key,
    sequence: 2,
  });
  expect(denied.data).toBeNull();
  const retrying = transitionCalendarState(denied, {
    type: "begin",
    key,
    sequence: 3,
  });
  const failed = transitionCalendarState(retrying, {
    type: "reject",
    key,
    sequence: 3,
    error: "Could not refresh this calendar.",
    retain: true,
  });
  expect(failed.data).toBeNull();
  expect(failed.status).toBe("error");
});
