import { expect, test } from "@playwright/test";
import { ApiContractError } from "../../../src/lib/api";
import { getBoardPostManageState } from "../../../src/components/systems/boards/adapters/board-post-manage-state-api";

const boardId = "00000000-0000-4000-8000-000000000001";
const postId = "00000000-0000-4000-8000-000000000002";

test("manager-state reads exact revisions and whether the post was ever published", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return Promise.resolve(
      Response.json({
        id: postId,
        status: "published",
        board_revision: 7,
        post_revision: 3,
        published_before: true,
      }),
    );
  }) as typeof fetch;
  try {
    await expect(getBoardPostManageState(boardId, postId)).resolves.toEqual({
      id: postId,
      status: "published",
      boardRevision: 7,
      postRevision: 3,
      publishedBefore: true,
    });
    expect(String(requests[0]?.input)).toBe(
      `/api/boards/${boardId}/posts/${postId}/manage-state`,
    );
    expect(requests[0]?.init?.cache).toBe("no-store");
  } finally {
    globalThis.fetch = original;
  }
});

test("manager-state rejects another item and unexpected content without returning a revision", async () => {
  const original = globalThis.fetch;
  const responses = [
    {
      id: boardId,
      status: "published",
      board_revision: 7,
      post_revision: 3,
    },
    {
      id: postId,
      status: "published",
      board_revision: 7,
      post_revision: 3,
      title: "Private content that must not be in metadata",
    },
  ];
  globalThis.fetch = (() =>
    Promise.resolve(Response.json(responses.shift()))) as typeof fetch;
  try {
    await expect(
      getBoardPostManageState(boardId, postId),
    ).rejects.toBeInstanceOf(ApiContractError);
    await expect(getBoardPostManageState(boardId, postId)).rejects.toThrow();
  } finally {
    globalThis.fetch = original;
  }
});
