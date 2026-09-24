import { expect, test } from "@playwright/test";
import { ApiContractError } from "../../../src/lib/api";
import { getBoardAnnouncementManageState } from "../../../src/components/systems/boards/adapters/board-announcement-manage-state-api";

const boardId = "00000000-0000-4000-8000-000000000001";
const announcementId = "00000000-0000-4000-8000-000000000002";

test("manager-state reads content-free exact revisions through the private Board route", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return Promise.resolve(
      Response.json({
        id: announcementId,
        status: "published",
        board_revision: 7,
        announcement_revision: 3,
      }),
    );
  }) as typeof fetch;
  try {
    await expect(
      getBoardAnnouncementManageState(boardId, announcementId),
    ).resolves.toEqual({
      id: announcementId,
      status: "published",
      boardRevision: 7,
      announcementRevision: 3,
    });
    expect(String(requests[0]?.input)).toBe(
      `/api/boards/${boardId}/announcements/${announcementId}/manage-state`,
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
      announcement_revision: 3,
    },
    {
      id: announcementId,
      status: "published",
      board_revision: 7,
      announcement_revision: 3,
      title: "Private content that must not be in metadata",
    },
  ];
  globalThis.fetch = (() =>
    Promise.resolve(Response.json(responses.shift()))) as typeof fetch;
  try {
    await expect(
      getBoardAnnouncementManageState(boardId, announcementId),
    ).rejects.toBeInstanceOf(ApiContractError);
    await expect(
      getBoardAnnouncementManageState(boardId, announcementId),
    ).rejects.toThrow();
  } finally {
    globalThis.fetch = original;
  }
});
