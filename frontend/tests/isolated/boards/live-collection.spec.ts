import { expect, test } from "@playwright/test";
import { ApiError } from "../../../src/lib/api";
import type { BoardManagementBoard } from "../../../src/components/systems/boards/adapters/board-management-api";
import {
  applyBoardMutationToDetail,
  boardUrl,
  canonicalBoardUrl,
  chooseBoardCandidate,
  invalidateBoardResourcesIfAuthorizationDenied,
  parseBoardRoute,
  transitionResource,
  type ResourceState,
} from "../../../src/components/systems/boards/hooks/use-server-boards";

const boardId = "00000000-0000-4000-8000-000000000001";
const homeId = "00000000-0000-4000-8000-000000000002";
const archivedId = "00000000-0000-4000-8000-000000000003";
const activeBoard: BoardManagementBoard = {
  id: boardId,
  scope: "project",
  departmentId: null,
  name: "Operations",
  description: null,
  status: "active",
  revision: 3,
  level: "manage",
  createdAt: "2026-09-23T00:00:00Z",
  updatedAt: "2026-09-23T00:00:00Z",
};

test("an archived Board alone is not opened by default", () => {
  const route = parseBoardRoute("");
  const matches = [
    {
      id: archivedId,
      scope: "project" as const,
      status: "archived" as const,
    },
  ];
  expect(chooseBoardCandidate(route, matches)).toBeNull();
});

test("explicit Board URL retains its UUID outside the page and fails closed on invalid IDs", () => {
  const direct = parseBoardRoute(`?board=${homeId}&section=calendar`);
  expect(direct).toEqual({
    kind: "board",
    boardId: homeId,
    section: "calendar",
  });
  expect(
    chooseBoardCandidate(direct, [
      { id: boardId, scope: "project", status: "active" },
    ]),
  ).toEqual({
    id: homeId,
    source: "explicit",
  });
  const invalid = parseBoardRoute(
    "?board=sample-board-organization&section=calendar",
  );
  expect(invalid).toEqual({ kind: "invalid-board", section: "calendar" });
  expect(
    chooseBoardCandidate(invalid, [
      { id: boardId, scope: "company", status: "active" },
    ]),
  ).toBeNull();
  expect(parseBoardRoute("?board=&section=calendar").kind).toBe(
    "invalid-board",
  );
  expect(parseBoardRoute(`?board=${boardId}&board=${homeId}`).kind).toBe(
    "invalid-board",
  );
  expect(boardUrl(homeId, "posts")).toBe(
    `/boards?board=${homeId}&section=posts`,
  );
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
  let detail: ResourceState<string> = {
    key: homeId,
    sequence: 5,
    data: "Selected Board outside page",
    status: "ready",
    error: null,
  };
  const sequences = {
    list: { current: 3 },
    detail: { current: 5 },
  };
  const handled = invalidateBoardResourcesIfAuthorizationDenied<string, string>(
    new ApiError(status, "Denied"),
    sequences,
    {
      list: (
        update: (current: ResourceState<string>) => ResourceState<string>,
      ) => {
        list = update(list);
      },
      detail: (
        update: (current: ResourceState<string>) => ResourceState<string>,
      ) => {
        detail = update(detail);
      },
    },
  );
  return { handled, list, detail, sequences };
}

test("detail authorization denial clears the unrelated list and direct Board detail", () => {
  const { handled, list, detail, sequences } =
    runAuthorizationDenialScenario(401);
  expect(handled).toBe(true);
  expect([list.data, detail.data]).toEqual([null, null]);
  expect([sequences.list.current, sequences.detail.current]).toEqual([4, 6]);
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

test("forbidden authorization clears the selected Board even without a mutation target", () => {
  const { handled, list, detail } = runAuthorizationDenialScenario(403);
  expect(handled).toBe(true);
  expect(list).toMatchObject({ data: null, status: "error" });
  expect(detail).toMatchObject({ data: null, status: "error" });
});

test("transient errors do not globally clear retained Board resources", () => {
  const { handled, list, detail } = runAuthorizationDenialScenario(500);
  expect(handled).toBe(false);
  expect([list.data, detail.data]).toEqual([
    "A different Board on this page",
    "Selected Board outside page",
  ]);
});

test("each Board has one address: Company without an id, a department by its department, a project by its id", () => {
  const departmentId = "00000000-0000-4000-8000-0000000000d1";
  const company = { id: homeId, scope: "company" as const, departmentId: null };
  const sales = {
    id: archivedId,
    scope: "department" as const,
    departmentId,
  };
  const project = {
    id: boardId,
    scope: "project" as const,
    departmentId: null,
  };
  // Other parameters (a post, an event, anything else) stay; the Board's
  // address replaces only the Board part (BR41).
  expect(
    canonicalBoardUrl(
      company,
      "posts",
      `?board=${homeId}&section=posts&post=p1`,
    ),
  ).toBe("/boards?section=posts&post=p1");
  expect(
    canonicalBoardUrl(
      sales,
      "calendar",
      `?board=${archivedId}&section=calendar&event=e1&keep=chosen`,
    ),
  ).toBe(
    `/boards?department=${departmentId}&section=calendar&event=e1&keep=chosen`,
  );
  expect(canonicalBoardUrl(sales, "posts", "?section=overview")).toBe(
    `/boards?department=${departmentId}&section=posts`,
  );
  expect(canonicalBoardUrl(project, "posts", `?post=p1&board=${boardId}`)).toBe(
    `/boards?board=${boardId}&section=posts&post=p1`,
  );

  expect(
    parseBoardRoute(`?department=${departmentId}&section=calendar`),
  ).toEqual({ kind: "department", departmentId, section: "calendar" });
  // All boards is a page without a Board; with a Board, `all` is no section.
  expect(parseBoardRoute("?section=all")).toEqual({ kind: "all" });
  expect(parseBoardRoute(`?section=all&board=${boardId}`)).toEqual({
    kind: "board",
    boardId,
    section: null,
  });
  expect(parseBoardRoute("?department=sales").kind).toBe("invalid-board");
  expect(
    parseBoardRoute(`?department=${departmentId}&board=${boardId}`).kind,
  ).toBe("invalid-board");

  const route = parseBoardRoute(`?department=${departmentId}`);
  const listed = [
    { id: homeId, scope: "company" as const, status: "active" as const },
    {
      id: archivedId,
      scope: "department" as const,
      departmentId,
      status: "active" as const,
    },
  ];
  expect(chooseBoardCandidate(route, listed)).toEqual({
    id: archivedId,
    source: "list",
  });
  // The open Board answers before the list does, so a replace reads nothing.
  expect(
    chooseBoardCandidate(route, [], { ...sales, status: "active" }),
  ).toEqual({ id: archivedId, source: "list" });
  expect(chooseBoardCandidate(route, listed.slice(0, 1))).toBeNull();
  expect(
    chooseBoardCandidate(parseBoardRoute("?section=all"), listed),
  ).toBeNull();
});
