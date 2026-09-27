import { expect, test } from "@playwright/test";
import {
  canSetBoardReminder,
  findEligibleBoardReminders,
  readBoardsRuntimeSnapshot,
  type BoardReminderEligibilityOptions,
} from "../../../src/components/systems/boards/state/controller";
import type { BoardsState } from "../../../src/components/systems/boards/domain/commands";
import type {
  BoardEvent,
  BoardReminder,
} from "../../../src/components/systems/boards/domain/model";
import {
  INITIAL_BOARDS,
  INITIAL_EVENTS,
} from "../../../src/components/systems/boards/domain/model";
import type { BoardViewer } from "../../../src/components/systems/boards/domain/content";
import { canAccessSampleBoard } from "../../../src/components/systems/boards/domain/sample-access";
import {
  initialPeople,
  initialRoles,
} from "../../../src/components/systems/shared/data/sample-people";

const now = "2026-09-15T01:00:00.000Z";
const actorId = "sample-eli";
const boardViewer: BoardViewer = {
  id: actorId,
  active: true,
  accessStatus: "active",
  roleIds: ["sample-member"],
  departmentIds: ["operations"],
};

function event(
  id: string,
  boardId: string,
  overrides: Partial<BoardEvent> = {},
): BoardEvent {
  return {
    ...structuredClone(INITIAL_EVENTS[0]),
    id,
    boardId,
    recurrence: "none",
    endDate: null,
    ...overrides,
  };
}

function reminder(
  id: string,
  eventId: string,
  identityId = actorId,
): BoardReminder {
  return {
    id,
    eventId,
    identityId,
    occurrenceStart: "2026-09-14",
    dueAt: "2026-09-15T00:00:00.000Z",
    status: "pending",
    createdAt: "2026-09-14T00:00:00.000Z",
  };
}

function personal(reminders: BoardReminder[]) {
  return {
    identityId: actorId,
    favoriteBoardIds: [],
    homeBoardId: null,
    calendarView: "month" as const,
    readAnnouncementIds: [],
    bookmarkedAnnouncementIds: [],
    reminders,
  };
}

function options(
  state: BoardsState,
  overrides: Partial<BoardReminderEligibilityOptions> = {},
): BoardReminderEligibilityOptions {
  return {
    state,
    personal: state.personal[actorId],
    actorId,
    viewer: boardViewer,
    now,
    canViewBoard: () => true,
    ...overrides,
  };
}

test("findEligibleBoardReminders spans accessible active boards and filters stale or revoked reminders", () => {
  const organization = structuredClone(INITIAL_BOARDS[0]);
  const operations = {
    ...organization,
    id: "sample-board-operations",
    name: "Operations board",
  };
  const denied = { ...organization, id: "sample-board-denied" };
  const archived = {
    ...organization,
    id: "sample-board-archived",
    status: "archived" as const,
  };
  const organizationEvent = event("event-organization", organization.id);
  const operationsEvent = event("event-operations", operations.id);
  const deniedEvent = event("event-denied", denied.id);
  const archivedBoardEvent = event("event-archived-board", archived.id);
  const archivedEvent = event("event-archived", organization.id, {
    archived: true,
  });
  const revokedEvent = event("event-revoked", operations.id, {
    audience: { kind: "identity", id: "sample-mara" },
  });
  const state: BoardsState = {
    boards: [organization, operations, denied, archived],
    events: [
      organizationEvent,
      operationsEvent,
      deniedEvent,
      archivedBoardEvent,
      archivedEvent,
      revokedEvent,
    ],
    announcements: [],
    placements: [],
    personal: {},
    templates: [],
    activity: [],
  };
  state.personal[actorId] = personal([
    reminder("reminder-organization", organizationEvent.id),
    reminder("reminder-operations", operationsEvent.id),
    reminder("reminder-denied", deniedEvent.id),
    reminder("reminder-archived-board", archivedBoardEvent.id),
    reminder("reminder-archived-event", archivedEvent.id),
    reminder("reminder-revoked", revokedEvent.id),
    reminder("reminder-missing", "event-missing"),
    reminder("reminder-wrong-identity", organizationEvent.id, "sample-mara"),
  ]);

  const eligible = findEligibleBoardReminders(
    options(state, {
      canViewBoard: (boardId) => boardId !== denied.id,
    }),
  );

  expect(eligible.map(({ event: item }) => item.id)).toEqual([
    organizationEvent.id,
    operationsEvent.id,
  ]);

  const managerEligible = findEligibleBoardReminders(
    options(state, {
      canViewBoard: (boardId) => boardId !== denied.id,
      viewer: { ...boardViewer, roleIds: ["sample-admin"] },
    }),
  );
  expect(managerEligible.map(({ event: item }) => item.id)).toEqual([
    organizationEvent.id,
    operationsEvent.id,
  ]);
});

test("findEligibleBoardReminders requires an active actor and excludes preview delivery", () => {
  const board = structuredClone(INITIAL_BOARDS[0]);
  const item = event("event-visible", board.id);
  const state: BoardsState = {
    boards: [board],
    events: [item],
    announcements: [],
    placements: [],
    personal: { [actorId]: personal([reminder("reminder-visible", item.id)]) },
    templates: [],
    activity: [],
  };

  expect(findEligibleBoardReminders(options(state, { preview: true }))).toEqual(
    [],
  );
  expect(
    findEligibleBoardReminders(
      options(state, { viewer: { ...boardViewer, active: false } }),
    ),
  ).toEqual([]);
  expect(
    findEligibleBoardReminders(
      options(state, { viewer: { ...boardViewer, accessStatus: "revoked" } }),
    ),
  ).toEqual([]);
});

test("canSetBoardReminder rechecks the current event audience before personal writes", () => {
  const item = event("event-current-audience", "sample-board-organization", {
    audience: { kind: "identity", id: "sample-mara" },
  });

  expect(canSetBoardReminder(item, boardViewer, () => true)).toBe(false);
  expect(
    canSetBoardReminder(
      item,
      { ...boardViewer, roleIds: ["sample-admin"] },
      () => true,
    ),
  ).toBe(false);
});

test("readBoardsRuntimeSnapshot derives Boards and its audience from the same reader", () => {
  const board = structuredClone(INITIAL_BOARDS[0]);
  board.name = "Current board projection";
  const snapshot = readBoardsRuntimeSnapshot((key, initial) => {
    if (key === "boards-list") return [board] as typeof initial;
    if (key === "access-people")
      return [
        { ...initialPeople[1], name: "Current person" },
      ] as typeof initial;
    return initial;
  });

  expect(snapshot.state.boards.map((item) => item.name)).toEqual([
    "Current board projection",
  ]);
  expect(snapshot.people.map((person) => person.name)).toEqual([
    "Current person",
  ]);
  expect(snapshot.roles.map((role) => role.id)).toEqual(
    initialRoles.map((role) => role.id),
  );
});

test("canAccessSampleBoard gives Administrators every permission and others view by visible role", () => {
  const people = [
    ...initialPeople,
    {
      ...initialPeople[1],
      id: "suspended",
      accessStatus: "suspended" as const,
    },
    {
      ...initialPeople[1],
      id: "expired",
      expiresAt: "2026-09-15T00:00:00.000Z",
    },
    { ...initialPeople[1], id: "unknown-role", role: "missing-role" },
  ];
  const boards = [
    INITIAL_BOARDS[0],
    {
      ...INITIAL_BOARDS[0],
      id: "admin-only",
      visibleRoleIds: ["sample-admin"],
    },
  ];
  const can = (
    identityId: string,
    boardId: string | null,
    permission: "view" | "edit" | "manage",
  ) =>
    canAccessSampleBoard({
      people,
      roles: initialRoles,
      boards,
      identityId,
      boardId,
      permission,
      now,
    });

  for (const permission of ["view", "edit", "manage"] as const) {
    expect(can("sample-mara", INITIAL_BOARDS[0].id, permission)).toBe(true);
    expect(can("sample-mara", null, permission)).toBe(true);
    expect(can("sample-mara", "missing-board", permission)).toBe(false);
  }
  expect(can(actorId, INITIAL_BOARDS[0].id, "view")).toBe(true);
  expect(can(actorId, INITIAL_BOARDS[0].id, "edit")).toBe(false);
  expect(can(actorId, INITIAL_BOARDS[0].id, "manage")).toBe(false);
  expect(can(actorId, "admin-only", "view")).toBe(false);
  expect(can(actorId, null, "manage")).toBe(false);
  for (const identityId of [
    "sample-nina",
    "suspended",
    "expired",
    "unknown-role",
    "missing-person",
  ])
    expect(can(identityId, INITIAL_BOARDS[0].id, "view")).toBe(false);
});
