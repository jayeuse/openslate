import { expect, test } from "@playwright/test";
import {
  executeBoardCommand,
  type BoardsState,
  type BoardCommandContext,
} from "../../../src/components/sample/boards/commands";
import {
  INITIAL_BOARDS,
  INITIAL_EVENTS,
  INITIAL_ANNOUNCEMENTS,
} from "../../../src/components/sample/boards/model";

function state(): BoardsState {
  return {
    boards: structuredClone(INITIAL_BOARDS),
    events: structuredClone(INITIAL_EVENTS),
    announcements: [],
    placements: [],
    personal: {},
    templates: [],
    activity: [],
  };
}
const context: BoardCommandContext = {
  actorId: "sample-mara",
  preview: false,
  now: "2026-09-15T01:00:00.000Z",
  id: "activity-test",
  can: () => true,
  audienceLookup: {
    roles: [
      { id: "sample-admin", name: "Administrator" },
      { id: "sample-member", name: "Member" },
    ],
    identities: [{ id: "sample-mara", name: "Mara" }],
    departments: [{ id: "Operations", name: "Operations" }],
  },
  recordIds: [],
};

test("saving an edited board preserves a newer Access visibility change and rejects conflicting edits", () => {
  const current = state();
  const original = structuredClone(current.boards[0]);
  current.boards[0].visibleRoleIds = [];
  const draft = { ...original, name: "Dispatch board" };
  const saved = executeBoardCommand(
    current,
    { type: "save-board", original, draft },
    context,
  );
  expect(saved.result.ok).toBe(true);
  expect(saved.state.boards[0].name).toBe("Dispatch board");
  expect(saved.state.boards[0].visibleRoleIds).toEqual([]);
  const conflicting = structuredClone(current);
  conflicting.boards[0].name = "Renamed elsewhere";
  const refused = executeBoardCommand(
    conflicting,
    { type: "save-board", original, draft },
    context,
  );
  expect(refused.result.ok).toBe(false);
  expect(refused.state).toBe(conflicting);
});

test("preview and view-only users cannot create events through the command boundary", () => {
  const current = state();
  const event = {
    ...current.events[0],
    id: "new-event",
    recurrence: "none" as const,
    endDate: null,
  };
  for (const constrained of [
    { ...context, preview: true },
    { ...context, can: () => false },
  ]) {
    const result = executeBoardCommand(
      current,
      { type: "save-event", event },
      constrained,
    );
    expect(result.result.ok).toBe(false);
    expect(result.state).toBe(current);
  }
});

test("archived boards reject edits and permanent deletion removes only their dependent content", () => {
  const current = state();
  current.boards[0].status = "archived";
  const rejected = executeBoardCommand(
    current,
    {
      type: "save-board",
      original: current.boards[0],
      draft: { ...current.boards[0], name: "Changed" },
    },
    context,
  );
  expect(rejected.result.ok).toBe(false);
  const deleted = executeBoardCommand(
    current,
    { type: "board-action", boardId: current.boards[0].id, action: "delete" },
    context,
  );
  expect(deleted.result.ok).toBe(true);
  expect(deleted.state.boards).toEqual([]);
  expect(deleted.state.events).toEqual([]);
});

test("archive requires an explicit restore and retains the published revision", () => {
  const current = state();
  current.announcements = structuredClone(INITIAL_ANNOUNCEMENTS);
  const post = current.announcements[0];
  const published = executeBoardCommand(
    current,
    {
      type: "save-announcement",
      announcement: { ...post, expiresAt: null },
      intent: "publish",
    },
    context,
  );
  expect(published.result.ok).toBe(true);
  const archived = executeBoardCommand(
    published.state,
    {
      type: "announcement-action",
      boardId: post.boardId,
      announcementId: post.id,
      action: "archive",
    },
    context,
  );
  const bypass = executeBoardCommand(
    archived.state,
    {
      type: "save-announcement",
      announcement: { ...archived.state.announcements[0], status: "draft" },
      intent: "draft",
    },
    context,
  );
  expect(bypass.result.ok).toBe(false);
  const restored = executeBoardCommand(
    archived.state,
    {
      type: "announcement-action",
      boardId: post.boardId,
      announcementId: post.id,
      action: "restore",
    },
    context,
  );
  expect(restored.result.ok).toBe(true);
  expect(restored.state.announcements[0].publishedRevision).toEqual(
    published.state.announcements[0].publishedRevision,
  );
});

test("archived events cannot bypass restoration and unsafe file metadata is rejected", () => {
  const current = state();
  current.events[0].archived = true;
  expect(
    executeBoardCommand(
      current,
      { type: "save-event", event: { ...current.events[0], archived: false } },
      context,
    ).result.ok,
  ).toBe(false);
  const active = state();
  const event = {
    ...active.events[0],
    recurrence: "none" as const,
    endDate: null,
    attachments: [
      { id: "unsafe", name: "script.svg", size: 5, type: "image/svg+xml" },
    ],
  };
  expect(
    executeBoardCommand(active, { type: "save-event", event }, context).result
      .ok,
  ).toBe(false);
});

test("event deletion removes its reminders for every identity while preserving other personal state", () => {
  const current = state();
  const event = current.events[0];
  const otherEvent = {
    ...event,
    id: "sample-event-other",
    title: "Other event",
  };
  const targetReminder = (identityId: string) => ({
    id: `${identityId}-target-reminder`,
    eventId: event.id,
    identityId,
    occurrenceStart: event.start,
    dueAt: event.start,
    status: "pending" as const,
    createdAt: event.createdAt,
  });
  const otherReminder = (identityId: string) => ({
    id: `${identityId}-other-reminder`,
    eventId: otherEvent.id,
    identityId,
    occurrenceStart: otherEvent.start,
    dueAt: otherEvent.start,
    status: "dismissed" as const,
    createdAt: otherEvent.createdAt,
  });
  current.events = [event, otherEvent];
  current.personal = {
    "sample-mara": {
      identityId: "sample-mara",
      favoriteBoardIds: [event.boardId],
      homeBoardId: event.boardId,
      calendarView: "month",
      readAnnouncementIds: ["read-announcement"],
      bookmarkedAnnouncementIds: ["bookmarked-announcement"],
      reminders: [targetReminder("sample-mara"), otherReminder("sample-mara")],
    },
    "sample-lee": {
      identityId: "sample-lee",
      favoriteBoardIds: [],
      homeBoardId: null,
      calendarView: "agenda",
      readAnnouncementIds: [],
      bookmarkedAnnouncementIds: [],
      reminders: [targetReminder("sample-lee"), otherReminder("sample-lee")],
    },
  };

  const archived = executeBoardCommand(
    current,
    {
      type: "event-action",
      boardId: event.boardId,
      eventId: event.id,
      action: "archive",
    },
    context,
  );
  expect(archived.result.ok).toBe(true);
  expect(archived.state.personal).toEqual(current.personal);

  const restored = executeBoardCommand(
    archived.state,
    {
      type: "event-action",
      boardId: event.boardId,
      eventId: event.id,
      action: "restore",
    },
    context,
  );
  expect(restored.result.ok).toBe(true);
  expect(restored.state.personal).toEqual(current.personal);

  const deleted = executeBoardCommand(
    executeBoardCommand(
      restored.state,
      {
        type: "event-action",
        boardId: event.boardId,
        eventId: event.id,
        action: "archive",
      },
      context,
    ).state,
    {
      type: "event-action",
      boardId: event.boardId,
      eventId: event.id,
      action: "delete",
    },
    context,
  );

  expect(deleted.result.ok).toBe(true);
  expect(deleted.state.events).toEqual([otherEvent]);
  expect(deleted.state.personal["sample-mara"]).toEqual({
    ...current.personal["sample-mara"],
    reminders: [otherReminder("sample-mara")],
  });
  expect(deleted.state.personal["sample-lee"]).toEqual({
    ...current.personal["sample-lee"],
    reminders: [otherReminder("sample-lee")],
  });
});

test("editing a schedule that has gone live preserves that revision for readers", () => {
  const current = state();
  const post = {
    ...structuredClone(INITIAL_ANNOUNCEMENTS[0]),
    status: "scheduled" as const,
    publishAt: "2026-09-14T00:00:00Z",
    expiresAt: null,
    title: "Scheduled replacement",
    publishedRevision: null,
  };
  current.announcements = [post];
  const result = executeBoardCommand(
    current,
    {
      type: "save-announcement",
      original: post,
      announcement: { ...post, title: "Unpublished next draft" },
      intent: "draft",
    },
    context,
  );
  expect(result.result.ok).toBe(true);
  expect(result.state.announcements[0].publishedRevision?.title).toBe(
    "Scheduled replacement",
  );
});

test("saving a draft preserves its chosen publish time without publishing it", () => {
  const current = state();
  const publishAt = "2026-09-20T08:00:00.000Z";
  const draft = {
    ...structuredClone(INITIAL_ANNOUNCEMENTS[0]),
    id: "announcement-draft-with-publish-time",
    status: "draft" as const,
    publishAt,
    publishedRevision: null,
    title: "Draft with a chosen publish time",
    body: "This remains a draft until explicitly published.",
  };
  current.announcements = [];

  const result = executeBoardCommand(
    current,
    { type: "save-announcement", announcement: draft, intent: "draft" },
    context,
  );

  expect(result.result.ok).toBe(true);
  expect(result.state.announcements[0]).toEqual(
    expect.objectContaining({
      status: "draft",
      publishAt,
      publishedRevision: null,
    }),
  );
});

test("content lifecycle requires manage access even for the author", () => {
  const current = state();
  const ownPost = {
    ...structuredClone(INITIAL_ANNOUNCEMENTS[0]),
    authorId: context.actorId,
  };
  current.announcements = [ownPost];
  current.events[0].authorId = context.actorId;
  const editor = {
    ...context,
    can: (_board: string | null, permission: string) => permission !== "manage",
  };
  expect(
    executeBoardCommand(
      current,
      {
        type: "announcement-action",
        boardId: ownPost.boardId,
        announcementId: ownPost.id,
        action: "archive",
      },
      editor,
    ).result.ok,
  ).toBe(false);
  expect(
    executeBoardCommand(
      current,
      {
        type: "event-action",
        boardId: current.events[0].boardId,
        eventId: current.events[0].id,
        action: "archive",
      },
      editor,
    ).result.ok,
  ).toBe(false);
});
