import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../src/lib/api";
import type {
  BoardActivity,
  BoardToolsPage,
} from "../../src/components/systems/boards/adapters/board-tools-api";
import { ServerBoardActivityDisplay } from "../../src/components/systems/boards/components/server-backed-board-activity";
import { isSelectedBoardActivityOpen } from "../../src/components/systems/boards/components/server-backed-boards";
import {
  boardActivityFailure,
  transitionBoardActivity,
  type BoardActivityState,
} from "../../src/components/systems/boards/hooks/use-server-board-activity";

const boardId = "00000000-0000-4000-8000-000000000001";
const otherBoardId = "00000000-0000-4000-8000-000000000002";
const activityId = "00000000-0000-4000-8000-000000000003";
const entry: BoardActivity = {
  id: activityId,
  createdAt: "2026-09-23T04:00:00Z",
  kind: "widget",
  action: "update",
  summary: "Board widget updated",
  actorLabel: "Team <script>member</script>",
};
const page: BoardToolsPage<BoardActivity> = {
  items: [entry],
  pagination: { limit: 25, offset: 0, count: 1, total: 26, hasMore: true },
};
const initial: BoardActivityState = {
  key: null,
  sequence: 0,
  data: null,
  status: "idle",
  error: null,
};

test("Board Activity renders only sanitized summaries with server totals and a clear empty state", () => {
  const html = renderToStaticMarkup(
    createElement(ServerBoardActivityDisplay, { page }),
  );
  expect(html).toContain("Board widget updated");
  expect(html).toContain("Showing 1–1 of 26");
  expect(html).toContain("Team &lt;script&gt;member&lt;/script&gt;");
  expect(html).not.toContain(activityId);
  expect(html).not.toContain("sample-board");

  const empty = renderToStaticMarkup(
    createElement(ServerBoardActivityDisplay, {
      page: {
        items: [],
        pagination: {
          limit: 25,
          offset: 0,
          count: 0,
          total: 0,
          hasMore: false,
        },
      },
    }),
  );
  expect(empty).toContain("No Board activity yet");
  expect(empty).not.toContain("Board widget updated");
});

test("Board Activity clears denied and switched history and ignores stale completion", () => {
  const key = `${boardId}:0`;
  const ready = transitionBoardActivity(
    transitionBoardActivity(initial, { type: "begin", key, sequence: 1 }),
    { type: "resolve", key, sequence: 1, data: page },
  );
  expect(ready.data?.items[0]?.summary).toBe("Board widget updated");

  for (const status of [401, 403, 404]) {
    const denied = transitionBoardActivity(ready, {
      type: "reject",
      key,
      sequence: 1,
      ...boardActivityFailure(new ApiError(status, "private snapshot")),
    });
    expect(denied.data).toBeNull();
    expect(denied.error).not.toContain("private snapshot");
  }

  const switched = transitionBoardActivity(ready, {
    type: "begin",
    key: `${otherBoardId}:0`,
    sequence: 2,
  });
  expect(switched.data).toBeNull();
  expect(
    transitionBoardActivity(switched, {
      type: "resolve",
      key,
      sequence: 1,
      data: page,
    }),
  ).toEqual(switched);
});

test("Board Activity retains same-page last-good only after transient failure", () => {
  const key = `${boardId}:0`;
  const ready: BoardActivityState = {
    key,
    sequence: 1,
    data: page,
    status: "ready",
    error: null,
  };
  const refreshing = transitionBoardActivity(ready, {
    type: "begin",
    key,
    sequence: 2,
  });
  expect(refreshing.data).toEqual(page);
  const transient = transitionBoardActivity(refreshing, {
    type: "reject",
    key,
    sequence: 2,
    ...boardActivityFailure(new ApiError(503, "private snapshot")),
  });
  expect(transient.data).toEqual(page);
  expect(transient.error).not.toContain("private snapshot");
  const contractFailure = transitionBoardActivity(refreshing, {
    type: "reject",
    key,
    sequence: 2,
    ...boardActivityFailure(new Error("Unexpected raw audit payload")),
  });
  expect(contractFailure.data).toBeNull();
});

test("Activity selection closes for a different, denied, or refreshed Board", () => {
  const selection = { boardId, detailSequence: 7 };
  expect(isSelectedBoardActivityOpen(selection, boardId, 7)).toBe(true);
  expect(isSelectedBoardActivityOpen(selection, otherBoardId, 8)).toBe(false);
  expect(isSelectedBoardActivityOpen(selection, null, 8)).toBe(false);
  expect(isSelectedBoardActivityOpen(selection, boardId, 8)).toBe(false);
});

test("Activity endpoint denial signals closing while transient failure keeps the panel available", () => {
  for (const status of [401, 403, 404])
    expect(boardActivityFailure(new ApiError(status, "Denied")).denied).toBe(
      true,
    );
  expect(boardActivityFailure(new ApiError(503, "Unavailable")).denied).toBe(
    false,
  );
});
