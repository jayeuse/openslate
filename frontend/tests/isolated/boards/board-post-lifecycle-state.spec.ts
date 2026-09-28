import { expect, test } from "@playwright/test";
import { ApiError } from "../../../src/lib/api";
import {
  postLifecycleFailure,
  notifyIfBoardViewLost,
} from "../../../src/components/systems/boards/hooks/use-server-board-post-lifecycle";
import type { PostLifecycleView } from "../../../src/components/systems/boards/components/server-backed-board-post-lifecycle";

const boardId = "00000000-0000-4000-8000-000000000001";
const itemId = "00000000-0000-4000-8000-000000000002";
const page = {
  items: [],
  boardRevision: 7,
  pagination: { limit: 25, offset: 0, count: 0, total: 0, hasMore: false },
};
const ready: PostLifecycleView = {
  status: "ready",
  active: true,
  canManage: true,
  view: "published",
  page,
  pending: true,
  conflict: false,
  error: null,
  notice: null,
  confirmation: {
    kind: "archive",
    boardId,
    postId: itemId,
    title: "Private title",
    boardRevision: 7,
    postRevision: 2,
  },
};

test("a conflict discards stale private list and confirmation before retry", () => {
  const failed = postLifecycleFailure(
    ready,
    new ApiError(409, "stale revision"),
  );
  expect(failed).toMatchObject({
    status: "error",
    canManage: false,
    page: null,
    pending: false,
    confirmation: null,
    conflict: true,
  });
  expect(failed.error).toContain("changed elsewhere");
});

test("a content denial clears content without assuming Board VIEW was lost", () => {
  for (const status of [401, 403, 404]) {
    const failed = postLifecycleFailure(ready, new ApiError(status, "hidden"));
    expect(failed).toMatchObject({
      status: "denied",
      canManage: false,
      page: null,
      pending: false,
      confirmation: null,
    });
  }
});

test("Board-wide revoke callback runs only after the independent VIEW probe is denied", async () => {
  const original = globalThis.fetch;
  const revoked: string[] = [];
  let response = Response.json({ view: true, edit: false, manage: false });
  globalThis.fetch = (() => Promise.resolve(response)) as typeof fetch;
  try {
    await expect(
      notifyIfBoardViewLost(boardId, (id) => revoked.push(id)),
    ).resolves.toBe(false);
    expect(revoked).toEqual([]);

    response = Response.json({ detail: "Board not found" }, { status: 404 });
    await expect(
      notifyIfBoardViewLost(boardId, (id) => revoked.push(id)),
    ).resolves.toBe(true);
    expect(revoked).toEqual([boardId]);
  } finally {
    globalThis.fetch = original;
  }
});
