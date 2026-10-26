import { expect, test } from "@playwright/test";
import { ApiError } from "../../../src/lib/api";
import {
  postActionFailure,
  notifyIfBoardViewLost,
} from "../../../src/components/systems/boards/hooks/use-server-board-post-lifecycle";

const boardId = "00000000-0000-4000-8000-000000000001";

test("a conflicting post action asks for a refresh instead of claiming success", () => {
  expect(postActionFailure(new ApiError(409, "stale revision"))).toEqual({
    message: "This post changed elsewhere. Refresh posts before trying again.",
    denied: false,
    conflict: true,
  });
  expect(postActionFailure(new Error("network"))).toEqual({
    message: "Post request failed. Try again.",
    denied: false,
    conflict: false,
  });
});

test("a content denial hides the post without assuming Board VIEW was lost", () => {
  for (const status of [401, 403, 404])
    expect(postActionFailure(new ApiError(status, "hidden"))).toEqual({
      message: "This post is not available.",
      denied: true,
      conflict: false,
    });
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
