import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  listBoardAnnouncementPersonal,
  putBoardAnnouncementBookmark,
  putBoardAnnouncementRead,
} from "../../../src/components/systems/boards/adapters/board-announcement-personal-api";

const boardId = "00000000-0000-4000-8000-000000000001";
const firstId = "00000000-0000-4000-8000-000000000002";
const secondId = "00000000-0000-4000-8000-000000000003";

type Captured = { path: string; init?: RequestInit };
function installFetch(
  responder: (path: string, init?: RequestInit) => Response,
) {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, init });
    return Promise.resolve(responder(path, init));
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function state(id: string, read = false, bookmarked = false) {
  return {
    announcement_id: id,
    publication_number: 2,
    read,
    bookmarked,
  };
}

test("batch personal read requests only current page IDs and preserves ordered truthful flags", async () => {
  const mock = installFetch(() =>
    Response.json([state(firstId, false, true), state(secondId, true, false)]),
  );
  try {
    const result = await listBoardAnnouncementPersonal(boardId, [
      firstId,
      secondId,
    ]);
    expect(result).toEqual([
      {
        announcementId: firstId,
        publicationNumber: 2,
        read: false,
        bookmarked: true,
      },
      {
        announcementId: secondId,
        publicationNumber: 2,
        read: true,
        bookmarked: false,
      },
    ]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].path).toBe(
      `/api/boards/${boardId}/announcement-personal?announcement_id=${firstId}&announcement_id=${secondId}`,
    );
    expect(mock.calls[0].init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("batch rejects missing, reordered, duplicated and oversized IDs before flags can render", async () => {
  const mock = installFetch(() =>
    Response.json([state(secondId), state(firstId)]),
  );
  try {
    await expect(
      listBoardAnnouncementPersonal(boardId, [firstId, secondId]),
    ).rejects.toBeInstanceOf(ApiContractError);
    await expect(listBoardAnnouncementPersonal(boardId, [])).rejects.toThrow();
    await expect(
      listBoardAnnouncementPersonal(boardId, [firstId, firstId]),
    ).rejects.toThrow();
    await expect(
      listBoardAnnouncementPersonal(
        boardId,
        Array.from(
          { length: 26 },
          (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        ),
      ),
    ).rejects.toThrow();
    expect(mock.calls).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("read and bookmark writes use separate revision-guarded routes and retain the other server flag", async () => {
  const mock = installFetch((path) =>
    Response.json(
      path.endsWith("/read")
        ? state(firstId, true, true)
        : state(firstId, true, false),
    ),
  );
  try {
    expect(
      await putBoardAnnouncementRead(boardId, firstId, 2, true),
    ).toMatchObject({
      read: true,
      bookmarked: true,
    });
    expect(
      await putBoardAnnouncementBookmark(boardId, firstId, 2, false),
    ).toMatchObject({
      read: true,
      bookmarked: false,
    });
    expect(mock.calls.map((call) => [call.path, call.init?.method])).toEqual([
      [`/api/boards/${boardId}/announcements/${firstId}/personal/read`, "PUT"],
      [
        `/api/boards/${boardId}/announcements/${firstId}/personal/bookmark`,
        "PUT",
      ],
    ]);
    expect(JSON.parse(String(mock.calls[0].init?.body))).toEqual({
      publication_number: 2,
      read: true,
    });
    expect(JSON.parse(String(mock.calls[1].init?.body))).toEqual({
      publication_number: 2,
      bookmarked: false,
    });
  } finally {
    mock.restore();
  }
});

test("stale-publication conflict is safe and preserves its machine-readable code", async () => {
  const mock = installFetch(() =>
    Response.json(
      {
        detail: { code: "stale_publication", message: "Private server detail" },
      },
      { status: 409 },
    ),
  );
  try {
    await expect(
      putBoardAnnouncementRead(boardId, firstId, 2, true),
    ).rejects.toMatchObject({
      status: 409,
      code: "stale_publication",
    });
    await expect(
      putBoardAnnouncementBookmark(boardId, firstId, 2, true),
    ).rejects.toBeInstanceOf(ApiError);
  } finally {
    mock.restore();
  }
});
