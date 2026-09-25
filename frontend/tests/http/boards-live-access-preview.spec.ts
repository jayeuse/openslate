import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardAccessPreviewResult } from "../../src/components/systems/boards/components/server-backed-board-access-preview";
import {
  transitionAccessPreview,
  transitionBoardPreviewEligibility,
  type AccessPreviewState,
  type BoardPreviewEligibility,
} from "../../src/components/systems/boards/hooks/use-server-board-access-preview";

const boardId = "00000000-0000-4000-8000-000000000001";
const otherBoardId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const otherUserId = "00000000-0000-4000-8000-000000000004";
const initial: AccessPreviewState = {
  key: null,
  sequence: 0,
  data: null,
  status: "idle",
  error: null,
};

test("read-only Board manager becomes preview-eligible from the manager-only chooser, not my-access.write", () => {
  const readOnlyManager = { view: true, edit: false, manage: false };
  const initialEligibility: BoardPreviewEligibility = {
    key: null,
    status: "loading",
    error: null,
  };
  const checking = transitionBoardPreviewEligibility(initialEligibility, {
    type: "begin",
    key: boardId,
  });
  const eligible = transitionBoardPreviewEligibility(checking, {
    type: "chooser-resolved",
    key: boardId,
    page: {
      items: [],
      pagination: { limit: 25, offset: 0, count: 0, total: 0, hasMore: false },
    },
  });
  expect(readOnlyManager.manage).toBe(false);
  expect(eligible).toEqual({ key: boardId, status: "ready", error: null });
  const denied = transitionBoardPreviewEligibility(eligible, {
    type: "reject",
    key: boardId,
    error: "Board access preview is unavailable.",
  });
  expect(denied.status).toBe("error");
  expect(
    transitionBoardPreviewEligibility(denied, {
      type: "chooser-resolved",
      key: otherBoardId,
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
  ).toEqual(denied);
});

test("Board access preview states effective permissions without claiming content audience visibility", () => {
  const html = renderToStaticMarkup(
    createElement(BoardAccessPreviewResult, {
      user: { id: userId, username: "Alex <script>not markup</script>" },
      access: { view: true, edit: false, manage: false },
    }),
  );
  expect(html).toContain("Alex &lt;script&gt;not markup&lt;/script&gt;");
  expect(html).toContain("Board-level access");
  expect(html).toContain("Can view Board");
  expect(html).toContain("Can edit Board");
  expect(html).toContain("Can manage Board");
  expect(html).toContain("Event and announcement audiences");
  expect(html).not.toContain(userId);
  expect(html).not.toContain("<script>");
});

test("Board access preview clears old data on target or Board switch and ignores stale completions", () => {
  const key = `${boardId}:${userId}`;
  const ready = transitionAccessPreview(
    transitionAccessPreview(initial, { type: "begin", key, sequence: 1 }),
    {
      type: "resolve",
      key,
      sequence: 1,
      data: { view: true, edit: true, manage: false },
    },
  );
  expect(ready.data?.edit).toBe(true);

  for (const nextKey of [
    `${boardId}:${otherUserId}`,
    `${otherBoardId}:${userId}`,
  ]) {
    const switched = transitionAccessPreview(ready, {
      type: "begin",
      key: nextKey,
      sequence: 2,
    });
    expect(switched.data).toBeNull();
    expect(switched.status).toBe("loading");
    expect(
      transitionAccessPreview(switched, {
        type: "resolve",
        key,
        sequence: 1,
        data: { view: true, edit: true, manage: true },
      }),
    ).toEqual(switched);
  }
});

test("Board access preview clears permission data after a denied or unavailable request", () => {
  const key = `${boardId}:${userId}`;
  const ready: AccessPreviewState = {
    key,
    sequence: 1,
    data: { view: true, edit: true, manage: true },
    status: "ready",
    error: null,
  };
  const refreshing = transitionAccessPreview(ready, {
    type: "begin",
    key,
    sequence: 2,
  });
  expect(refreshing.data).toBeNull();
  const denied = transitionAccessPreview(refreshing, {
    type: "reject",
    key,
    sequence: 2,
    error: "Board access preview is unavailable. Refresh Board access.",
  });
  expect(denied.data).toBeNull();
  expect(denied.status).toBe("error");
  expect(denied.error).toContain("Refresh Board access");
});
