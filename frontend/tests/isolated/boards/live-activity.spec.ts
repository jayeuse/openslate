import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../../src/lib/api";
import type {
  BoardActivity,
  BoardToolsPage,
} from "../../../src/components/systems/boards/adapters/board-tools-api";
import { ServerBoardActivityDisplay } from "../../../src/components/systems/boards/components/server-backed-board-activity";
import {
  boardActivitySentence,
  boardActivityTime,
} from "../../../src/components/systems/boards/domain/board-settings";
import {
  boardActivityFailure,
  transitionBoardActivity,
  type BoardActivityState,
} from "../../../src/components/systems/boards/hooks/use-server-board-activity";
import { parsedPagination } from "../../helpers/pagination";

const boardId = "00000000-0000-4000-8000-000000000001";
const otherBoardId = "00000000-0000-4000-8000-000000000002";
const activityId = "00000000-0000-4000-8000-000000000003";
const entry: BoardActivity = {
  id: activityId,
  createdAt: "2026-09-23T04:00:00Z",
  kind: "group",
  action: "update",
  summary: "Board groups changed",
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

test("Board Activity renders sentence rows without ids and names why it is empty", () => {
  const html = renderToStaticMarkup(
    createElement(ServerBoardActivityDisplay, { page }),
  );
  expect(html).toContain("Changed groups");
  expect(html).toContain("Team &lt;script&gt;member&lt;/script&gt;");
  expect(html).not.toContain(activityId);
  expect(html).not.toContain("<script>");

  const empty = renderToStaticMarkup(
    createElement(ServerBoardActivityDisplay, {
      page: {
        items: [],
        pagination: parsedPagination({ limit: 25, count: 0, total: 0 }),
      },
    }),
  );
  expect(empty).toContain("No activity yet");
  expect(empty).toContain(
    "Changes to this board&#x27;s details and groups show here.",
  );
  expect(empty).not.toContain("Changed groups");
});

test("each Activity row reads as a verb with its dot", () => {
  expect(
    [
      { kind: "board" as const, action: "create" as const },
      { kind: "board" as const, action: "update" as const },
      { kind: "board" as const, action: "delete" as const },
      { kind: "group" as const, action: "create" as const },
      { kind: "group" as const, action: "delete" as const },
    ].map(boardActivitySentence),
  ).toEqual([
    { verb: "Created board", tone: "flow" },
    { verb: "Changed details", tone: "action" },
    { verb: "Deleted board", tone: "danger" },
    { verb: "Changed groups", tone: "action" },
    { verb: "Changed groups", tone: "action" },
  ]);
});

test("an Activity row's time drops the zone, and the year within the current year", () => {
  const utc = { timezone: "UTC", locale: "en-US" };
  const now = new Date("2026-10-27T12:00:00Z");
  // This year: no year and no zone; the tooltip keeps the full time.
  expect(boardActivityTime("2026-09-24T09:30:00Z", utc, now)).toEqual({
    text: "Sep 24, 9:30 AM",
    full: "Thursday, September 24, 2026 at 9:30:00 AM UTC",
  });
  // An earlier year keeps its year.
  expect(boardActivityTime("2025-12-30T09:30:00Z", utc, now).text).toBe(
    "Dec 30, 2025, 9:30 AM",
  );
  // The year is the workspace's: New Year's Eve in UTC is already this year
  // in Manila.
  expect(
    boardActivityTime(
      "2025-12-31T23:30:00Z",
      { timezone: "Asia/Manila", locale: "en-US" },
      new Date("2026-01-01T12:00:00Z"),
    ).text,
  ).toBe("Jan 1, 7:30 AM");
});

test("Board Activity clears denied and switched history and ignores stale completion", () => {
  const key = `${boardId}:0`;
  const ready = transitionBoardActivity(
    transitionBoardActivity(initial, { type: "begin", key, sequence: 1 }),
    { type: "resolve", key, sequence: 1, data: page },
  );
  expect(ready.data?.items[0]?.summary).toBe("Board groups changed");

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

test("Activity endpoint denial signals closing while transient failure keeps the panel available", () => {
  for (const status of [401, 403, 404])
    expect(boardActivityFailure(new ApiError(status, "Denied")).denied).toBe(
      true,
    );
  expect(boardActivityFailure(new ApiError(503, "Unavailable")).denied).toBe(
    false,
  );
});
