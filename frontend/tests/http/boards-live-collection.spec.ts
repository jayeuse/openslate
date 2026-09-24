import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../src/lib/api";
import type { BoardManagementBoard } from "../../src/components/systems/boards/adapters/board-management-api";
import {
  applyBoardMutationToDetail,
  boardListKey,
  boardUrl,
  chooseBoardCandidate,
  invalidateBoardResourcesIfAuthorizationDenied,
  parseBoardRoute,
  resolveBoardSection,
  transitionResource,
  type ResourceState,
} from "../../src/components/systems/boards/hooks/use-server-boards";
import {
  ServerBackedBoardsLoading,
  boardSearchEmptyCopy,
  isSelectedBoardAnnouncementManagerOpen,
  isSelectedBoardWidgetManagerOpen,
} from "../../src/components/systems/boards/components/server-backed-boards";

const boardId = "00000000-0000-4000-8000-000000000001";
const homeId = "00000000-0000-4000-8000-000000000002";
const archivedId = "00000000-0000-4000-8000-000000000003";
const activeBoard: BoardManagementBoard = {
  id: boardId,
  ownerId: homeId,
  departmentId: null,
  name: "Operations",
  description: null,
  status: "active",
  defaultSection: "overview",
  revision: 3,
  createdAt: "2026-09-23T00:00:00Z",
  updatedAt: "2026-09-23T00:00:00Z",
};

test("Board search keys distinguish server-filtered pages without losing status and offset", () => {
  expect(boardListKey("active", 0, null)).not.toBe(
    boardListKey("active", 0, "Operations"),
  );
  expect(boardListKey("active", 0, "Operations")).not.toBe(
    boardListKey("active", 25, "Operations"),
  );
  expect(boardListKey("active", 0, "Operations")).not.toBe(
    boardListKey("archived", 0, "Operations"),
  );
});

test("archived search matches prompt selection instead of claiming no Boards match", () => {
  const route = parseBoardRoute("");
  for (const status of ["archived", "all"] as const) {
    const matches = [{ id: archivedId, status: "archived" as const }];
    expect(chooseBoardCandidate(route, matches, null, null)).toBeNull();
    const copy = boardSearchEmptyCopy(
      "Payroll",
      matches.length,
      matches.length,
    );
    expect(copy.title, status).toBe("Choose a matching Board");
    expect(copy.description).toContain("switcher");
    expect(copy.description).not.toContain("Try another search");
  }
  expect(boardSearchEmptyCopy("Payroll", 0, 0).title).toBe(
    "No Boards match your search",
  );
});

test("an empty later Board page with positive total points to Previous, not no matches", () => {
  const copy = boardSearchEmptyCopy("Payroll", 0, 3);
  expect(copy.title).toBe("No Boards on this page");
  expect(copy.description).toContain("Previous");
  expect(copy.description).not.toContain("No Boards match");
  expect(boardSearchEmptyCopy(null, 0, 3).title).toBe("No Boards on this page");
});

test("widget manager stays open across same-Board refresh and closes on Board switch", () => {
  expect(isSelectedBoardWidgetManagerOpen(boardId, boardId)).toBe(true);
  expect(isSelectedBoardWidgetManagerOpen(boardId, archivedId)).toBe(false);
  expect(isSelectedBoardWidgetManagerOpen(boardId, null)).toBe(false);
});

test("announcement manager stays open across same-Board refresh but closes outside that section", () => {
  expect(
    isSelectedBoardAnnouncementManagerOpen(boardId, boardId, "announcements"),
  ).toBe(true);
  expect(
    isSelectedBoardAnnouncementManagerOpen(
      boardId,
      archivedId,
      "announcements",
    ),
  ).toBe(false);
  expect(
    isSelectedBoardAnnouncementManagerOpen(boardId, boardId, "overview"),
  ).toBe(false);
  expect(
    isSelectedBoardAnnouncementManagerOpen(boardId, null, "announcements"),
  ).toBe(false);
});

test("explicit Board URL retains its UUID outside the page and fails closed on invalid IDs", () => {
  const direct = parseBoardRoute(`?board=${homeId}&section=calendar`);
  expect(direct).toEqual({
    kind: "board",
    boardId: homeId,
    section: "calendar",
  });
  expect(
    chooseBoardCandidate(
      direct,
      [{ id: boardId, status: "active" }],
      null,
      null,
    ),
  ).toEqual({
    id: homeId,
    source: "explicit",
  });
  const invalid = parseBoardRoute(
    "?board=sample-board-organization&section=overview",
  );
  expect(invalid).toEqual({ kind: "invalid-board", section: "overview" });
  expect(
    chooseBoardCandidate(
      invalid,
      [{ id: boardId, status: "active" }],
      homeId,
      null,
    ),
  ).toBeNull();
  expect(parseBoardRoute("?board=&section=overview").kind).toBe(
    "invalid-board",
  );
  expect(parseBoardRoute(`?board=${boardId}&board=${homeId}`).kind).toBe(
    "invalid-board",
  );
  expect(boardUrl(homeId, "announcements")).toBe(
    `/boards?board=${homeId}&section=announcements`,
  );
});

test("no-ID selection prefers accessible home then first active list item", () => {
  const none = parseBoardRoute("?section=announcements");
  const page = [
    { id: archivedId, status: "archived" as const },
    { id: boardId, status: "active" as const },
  ];
  expect(chooseBoardCandidate(none, page, homeId, null)).toEqual({
    id: homeId,
    source: "home",
  });
  expect(chooseBoardCandidate(none, page, homeId, homeId)).toEqual({
    id: boardId,
    source: "list",
  });
  expect(chooseBoardCandidate(none, page, null, null)).toEqual({
    id: boardId,
    source: "list",
  });
  expect(
    chooseBoardCandidate(
      none,
      [{ id: archivedId, status: "archived" }],
      null,
      null,
    ),
  ).toBeNull();
  expect(resolveBoardSection(none, { defaultSection: "calendar" })).toBe(
    "announcements",
  );
  expect(
    resolveBoardSection(parseBoardRoute("?section=unsupported"), {
      defaultSection: "calendar",
    }),
  ).toBe("calendar");
});

test("resource transitions keep last good on refresh failure but clear revoked or switched Boards", () => {
  const initial = {
    key: null,
    sequence: 0,
    data: null,
    status: "idle" as const,
    error: null,
  };
  const began = transitionResource(initial, {
    type: "begin",
    key: boardId,
    sequence: 1,
  });
  const ready = transitionResource(began, {
    type: "resolve",
    key: boardId,
    sequence: 1,
    data: "Board A",
  });
  const refreshing = transitionResource(ready, {
    type: "begin",
    key: boardId,
    sequence: 2,
  });
  expect(refreshing.data).toBe("Board A");
  const networkFailure = transitionResource(refreshing, {
    type: "reject",
    key: boardId,
    sequence: 2,
    error: "Refresh failed",
    denied: false,
  });
  expect(networkFailure).toMatchObject({
    data: "Board A",
    status: "ready",
    error: "Refresh failed",
  });
  const switched = transitionResource(networkFailure, {
    type: "begin",
    key: homeId,
    sequence: 3,
  });
  expect(switched.data).toBeNull();
  expect(
    transitionResource(switched, {
      type: "resolve",
      key: boardId,
      sequence: 2,
      data: "Stale A",
    }),
  ).toEqual(switched);
  const denied = transitionResource(ready, {
    type: "reject",
    key: boardId,
    sequence: 1,
    error: "Board unavailable",
    denied: true,
  });
  expect(denied).toMatchObject({
    data: null,
    status: "error",
    error: "Board unavailable",
  });
});

test("archived Board mutation disables writes before refresh and survives transient failure", () => {
  const ready: ResourceState<BoardManagementBoard> = {
    key: boardId,
    sequence: 4,
    data: activeBoard,
    status: "ready",
    error: null,
  };
  const archived = applyBoardMutationToDetail(
    ready,
    { ...activeBoard, status: "archived", revision: 4 },
    5,
  );
  expect(archived.data?.status).toBe("archived");
  const refreshing = transitionResource(archived, {
    type: "begin",
    key: boardId,
    sequence: 6,
  });
  const failed = transitionResource(refreshing, {
    type: "reject",
    key: boardId,
    sequence: 6,
    error: "Refresh failed",
    denied: false,
  });
  expect(failed.data?.status).toBe("archived");
  expect(
    applyBoardMutationToDetail(
      { ...ready, data: null, status: "error" },
      { ...activeBoard, status: "archived", revision: 4 },
      7,
    ).data,
  ).toBeNull();
  expect(
    applyBoardMutationToDetail(
      ready,
      { ...activeBoard, id: archivedId, status: "archived", revision: 4 },
      7,
    ),
  ).toEqual(ready);
});

function runAuthorizationDenialScenario(status: number) {
  let list: ResourceState<string> = {
    key: "active:0",
    sequence: 3,
    data: "A different Board on this page",
    status: "ready",
    error: null,
  };
  let personal: ResourceState<string> = {
    key: "personal",
    sequence: 4,
    data: "Favorite and home IDs",
    status: "ready",
    error: null,
  };
  let detail: ResourceState<string> = {
    key: homeId,
    sequence: 5,
    data: "Selected Board outside page",
    status: "ready",
    error: null,
  };
  const sequences = {
    list: { current: 3 },
    personal: { current: 4 },
    detail: { current: 5 },
  };
  const handled = invalidateBoardResourcesIfAuthorizationDenied<
    string,
    string,
    string
  >(new ApiError(status, "Denied"), sequences, {
    list: (update) => {
      list = update(list);
    },
    personal: (update) => {
      personal = update(personal);
    },
    detail: (update) => {
      detail = update(detail);
    },
  });
  return { handled, list, personal, detail, sequences };
}

test("detail authorization denial clears unrelated list, personal state, and direct Board detail", () => {
  const { handled, list, personal, detail, sequences } =
    runAuthorizationDenialScenario(401);
  expect(handled).toBe(true);
  expect([list.data, personal.data, detail.data]).toEqual([null, null, null]);
  expect([
    sequences.list.current,
    sequences.personal.current,
    sequences.detail.current,
  ]).toEqual([4, 5, 6]);
  expect(
    transitionResource(list, {
      type: "resolve",
      key: "active:0",
      sequence: 3,
      data: "Stale list response",
    }),
  ).toEqual(list);
  expect(
    transitionResource(detail, {
      type: "resolve",
      key: homeId,
      sequence: 5,
      data: "Stale detail response",
    }),
  ).toEqual(detail);
});

test("clear-home authorization denial clears selected Board even without a mutation target", () => {
  const { handled, list, personal, detail } =
    runAuthorizationDenialScenario(403);
  expect(handled).toBe(true);
  expect(list).toMatchObject({ data: null, status: "error" });
  expect(personal).toMatchObject({ data: null, status: "error" });
  expect(detail).toMatchObject({ data: null, status: "error" });
});

test("transient errors do not globally clear retained Board resources", () => {
  const { handled, list, personal, detail } =
    runAuthorizationDenialScenario(500);
  expect(handled).toBe(false);
  expect([list.data, personal.data, detail.data]).toEqual([
    "A different Board on this page",
    "Favorite and home IDs",
    "Selected Board outside page",
  ]);
});

test("initial server-backed shell renders a loading state without sample Board content", () => {
  const html = renderToStaticMarkup(createElement(ServerBackedBoardsLoading));
  expect(html).toContain('role="status"');
  expect(html).toContain("Loading Boards");
  expect(html).not.toContain("Organization board");
  expect(html).not.toContain("sample-board");
});
