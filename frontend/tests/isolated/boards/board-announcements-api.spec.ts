import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  archiveBoardAnnouncement,
  createBoardAnnouncement,
  deleteBoardAnnouncement,
  listBoardAnnouncements,
  publishBoardAnnouncement,
  readBoardAnnouncement,
  restoreBoardAnnouncement,
  scheduleBoardAnnouncement,
  unpublishBoardAnnouncement,
  updateBoardAnnouncement,
} from "../../../src/components/systems/boards/adapters/board-announcements-api";

const boardId = "00000000-0000-4000-8000-000000000001";
const announcementId = "00000000-0000-4000-8000-000000000002";
const authorId = "00000000-0000-4000-8000-000000000003";
const roleId = "00000000-0000-4000-8000-000000000004";
const publicationKey = "00000000-0000-4000-8000-000000000005";
const revisionId = "00000000-0000-4000-8000-000000000006";
const timestamp = "2026-09-23T00:00:00Z";

type CapturedRequest = { input: RequestInfo | URL; init?: RequestInit };

function installFetch(responder: () => Response) {
  const original = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return Promise.resolve(responder());
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const jsonResponse = (body: unknown, status = 200) =>
  Response.json(body, { status });
const audience = {
  kind: "role",
  role_id: roleId,
  user_id: null,
  department_id: null,
};
const published = {
  id: announcementId,
  board_id: boardId,
  author_id: authorId,
  title: "Earlier published",
  body: "Public text",
  links: [{ label: "Release", url: "https://example.org/release" }],
  audience,
  status: "published",
  publish_at: timestamp,
  expires_at: null,
  pinned: false,
  announcement_revision: null,
  board_revision: 4,
  publication_number: 1,
  published_at: timestamp,
  created_at: timestamp,
  updated_at: timestamp,
};
const draft = {
  ...published,
  title: "Unpublished replacement",
  body: "Unpublished text",
  links: [{ label: "Draft", url: "https://example.org/draft" }],
  status: "draft",
  publish_at: null,
  announcement_revision: 2,
  publication_number: null,
  published_at: null,
};
const mutation = {
  id: announcementId,
  announcement_revision: 2,
  board_revision: 4,
};
const page = { limit: 25, offset: 0, count: 1, total: 1, has_more: false };

test("announcement published list uses bounded query and immutable published fields", async () => {
  const mock = installFetch(() =>
    jsonResponse({ items: [published], pagination: page, board_revision: 4 }),
  );
  try {
    const result = await listBoardAnnouncements(boardId, {
      view: "published",
      sortBy: "created_at",
      sortOrder: "asc",
      search: "  Earlier  ",
      authorId: authorId,
    });
    expect(result.items[0]).toMatchObject({
      id: announcementId,
      title: "Earlier published",
      status: "published",
      announcementRevision: null,
      publicationNumber: 1,
      publishedAt: timestamp,
      links: [{ label: "Release", url: "https://example.org/release" }],
      audience: { kind: "role", roleId },
    });
    expect(result.pagination).toEqual({
      limit: 25,
      offset: 0,
      count: 1,
      total: 1,
      hasMore: false,
    });
    expect(result.boardRevision).toBe(4);
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/boards/${boardId}/announcements?view=published&limit=25&offset=0&sort_by=created_at&sort_order=asc&search=Earlier&author_id=${authorId}`,
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("announcement editor loads mutable published content without using the recipient feed", async () => {
  const editable = {
    ...draft,
    status: "published",
    publish_at: timestamp,
  };
  const mock = installFetch(() =>
    jsonResponse({ items: [editable], pagination: page, board_revision: 4 }),
  );
  try {
    const result = await listBoardAnnouncements(boardId, { view: "editable" });
    expect(result.items[0]).toMatchObject({
      id: announcementId,
      title: "Unpublished replacement",
      status: "published",
      announcementRevision: 2,
      publicationNumber: null,
    });
    expect(String(mock.requests[0]?.input)).toContain("view=editable");
  } finally {
    mock.restore();
  }
});

test("announcement draft read and writes preserve exclusive audience and UTC fields", async () => {
  const responses = [
    jsonResponse(draft),
    jsonResponse(mutation, 201),
    jsonResponse(mutation),
    jsonResponse(mutation),
  ];
  const mock = installFetch(() => responses.shift()!);
  try {
    await expect(
      readBoardAnnouncement(boardId, announcementId, "draft"),
    ).resolves.toMatchObject({
      status: "draft",
      announcementRevision: 2,
      publicationNumber: null,
      links: [{ label: "Draft", url: "https://example.org/draft" }],
    });
    await expect(
      createBoardAnnouncement(boardId, {
        boardRevision: 3,
        title: "  Opening  ",
        body: "  News  ",
        audience: { kind: "role", roleId },
        expiresAt: "2026-09-30T00:00:00Z",
        pinned: false,
        links: [{ label: "  Source  ", url: "  https://example.org/source  " }],
      }),
    ).resolves.toEqual({
      id: announcementId,
      announcementRevision: 2,
      boardRevision: 4,
    });
    await expect(
      updateBoardAnnouncement(boardId, announcementId, {
        boardRevision: 4,
        announcementRevision: 2,
        title: "  Revised  ",
        audience: { kind: "author" },
        expiresAt: null,
        links: [],
      }),
    ).resolves.toMatchObject({ id: announcementId });
    await expect(
      scheduleBoardAnnouncement(boardId, announcementId, {
        boardRevision: 4,
        announcementRevision: 2,
        publishAt: "2026-09-30T00:00:00Z",
      }),
    ).resolves.toMatchObject({ id: announcementId });
    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      [
        `/api/boards/${boardId}/announcements/${announcementId}?view=draft`,
        undefined,
      ],
      [`/api/boards/${boardId}/announcements`, "POST"],
      [`/api/boards/${boardId}/announcements/${announcementId}`, "PATCH"],
      [
        `/api/boards/${boardId}/announcements/${announcementId}/schedule`,
        "POST",
      ],
    ]);
    expect(JSON.parse(String(mock.requests[1]?.init?.body))).toEqual({
      board_revision: 3,
      title: "Opening",
      body: "News",
      audience: { kind: "role", role_id: roleId },
      expires_at: "2026-09-30T00:00:00Z",
      pinned: false,
      links: [{ label: "Source", url: "https://example.org/source" }],
    });
    expect(JSON.parse(String(mock.requests[2]?.init?.body))).toEqual({
      board_revision: 4,
      announcement_revision: 2,
      title: "Revised",
      audience: { kind: "author" },
      expires_at: null,
      links: [],
    });
    expect(JSON.parse(String(mock.requests[3]?.init?.body))).toEqual({
      board_revision: 4,
      announcement_revision: 2,
      publish_at: "2026-09-30T00:00:00Z",
    });
    expect(mock.requests.every(({ init }) => init?.cache === "no-store")).toBe(
      true,
    );
  } finally {
    mock.restore();
  }
});

test("announcement publication keeps caller retry key and lifecycle sends revisions", async () => {
  const responses = [
    jsonResponse({
      id: revisionId,
      announcement_id: announcementId,
      publication_number: 1,
      publication_key: publicationKey,
      published_at: timestamp,
    }),
    jsonResponse(mutation),
    jsonResponse(mutation),
    jsonResponse(mutation),
    new Response(null, { status: 204 }),
  ];
  const mock = installFetch(() => responses.shift()!);
  try {
    await expect(
      publishBoardAnnouncement(boardId, announcementId, {
        boardRevision: 4,
        announcementRevision: 2,
        publicationKey,
      }),
    ).resolves.toMatchObject({
      id: revisionId,
      announcementId,
      publicationNumber: 1,
      publicationKey,
    });
    await unpublishBoardAnnouncement(boardId, announcementId, 4, 2);
    await archiveBoardAnnouncement(boardId, announcementId, 5, 3);
    await restoreBoardAnnouncement(boardId, announcementId, 6, 4);
    await expect(
      deleteBoardAnnouncement(boardId, announcementId, 7, 5),
    ).resolves.toBeUndefined();
    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      [
        `/api/boards/${boardId}/announcements/${announcementId}/publish`,
        "POST",
      ],
      [
        `/api/boards/${boardId}/announcements/${announcementId}/unpublish`,
        "POST",
      ],
      [
        `/api/boards/${boardId}/announcements/${announcementId}/archive`,
        "POST",
      ],
      [
        `/api/boards/${boardId}/announcements/${announcementId}/restore`,
        "POST",
      ],
      [`/api/boards/${boardId}/announcements/${announcementId}`, "DELETE"],
    ]);
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      board_revision: 4,
      announcement_revision: 2,
      publication_key: publicationKey,
    });
    expect(JSON.parse(String(mock.requests[4]?.init?.body))).toEqual({
      board_revision: 7,
      announcement_revision: 5,
    });
    expect(mock.requests.every(({ init }) => init?.cache === "no-store")).toBe(
      true,
    );
  } finally {
    mock.restore();
  }
});

test("announcement adapter rejects invalid IDs, audience combinations, UTC offsets, and empty patches before fetch", async () => {
  const mock = installFetch(() => jsonResponse(mutation));
  try {
    await expect(listBoardAnnouncements("../outside")).rejects.toThrow();
    await expect(
      listBoardAnnouncements(boardId, { limit: 101 }),
    ).rejects.toThrow();
    await expect(
      listBoardAnnouncements(boardId, { authorId: "not-a-uuid" }),
    ).rejects.toThrow();
    await expect(
      listBoardAnnouncements(boardId, { deleted: "include" } as never),
    ).rejects.toThrow();
    await expect(
      readBoardAnnouncement(boardId, "../outside"),
    ).rejects.toThrow();
    await expect(
      createBoardAnnouncement(boardId, {
        boardRevision: 1,
        title: "Notice",
        body: "Body",
        audience: { kind: "role", roleId, userId: authorId } as never,
      }),
    ).rejects.toThrow();
    await expect(
      createBoardAnnouncement(boardId, {
        boardRevision: 1,
        title: "Notice",
        body: "Body",
        expiresAt: "2026-09-30T08:00:00+08:00",
      }),
    ).rejects.toThrow();
    await expect(
      updateBoardAnnouncement(boardId, announcementId, {
        boardRevision: 1,
        announcementRevision: 1,
      }),
    ).rejects.toThrow();
    await expect(
      scheduleBoardAnnouncement(boardId, announcementId, {
        boardRevision: 1,
        announcementRevision: 1,
        publishAt: "2026-09-30T08:00:00+08:00",
      }),
    ).rejects.toThrow();
    await expect(
      publishBoardAnnouncement(boardId, announcementId, {
        boardRevision: 1,
        announcementRevision: 1,
        publicationKey: "same-key",
      }),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("announcement adapter fails closed on leaked or cross-Board DTOs and inconsistent publication fields", async () => {
  for (const payload of [
    { ...published, private_token: "secret" },
    { ...published, board_id: authorId },
    { ...published, announcement_revision: 2 },
    { ...published, audience: { ...audience, user_id: authorId } },
    { ...published, links: undefined },
    { ...published, links: [{ label: "Unsafe", url: "javascript:alert(1)" }] },
    {
      ...published,
      links: [{ label: "Credential", url: "https://user@example.org" }],
    },
    {
      ...published,
      links: [{ label: "Empty credential", url: "https://@example.org" }],
    },
    { ...published, links: [{ label: "", url: "https://example.org" }] },
    {
      ...published,
      links: Array.from({ length: 21 }, () => ({
        label: "Excess",
        url: "https://example.org",
      })),
    },
  ]) {
    const mock = installFetch(() => jsonResponse(payload));
    try {
      await expect(
        readBoardAnnouncement(boardId, announcementId),
      ).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
  const mock = installFetch(() =>
    jsonResponse({
      items: [published],
      pagination: { ...page, total: 0 },
      board_revision: 4,
    }),
  );
  try {
    await expect(listBoardAnnouncements(boardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
  const mismatchedPublication = installFetch(() =>
    jsonResponse({
      id: revisionId,
      announcement_id: authorId,
      publication_number: 1,
      publication_key: publicationKey,
      published_at: timestamp,
    }),
  );
  try {
    await expect(
      publishBoardAnnouncement(boardId, announcementId, {
        boardRevision: 4,
        announcementRevision: 2,
        publicationKey,
      }),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    mismatchedPublication.restore();
  }
});

test("announcement link input rejects unsafe and oversized values before fetch", async () => {
  const mock = installFetch(() => jsonResponse(mutation));
  try {
    for (const links of [
      [{ label: "Unsafe", url: "data:text/html,unsafe" }],
      [{ label: "Credential", url: "https://user:pass@example.org" }],
      [{ label: "Empty credential", url: "https://@example.org" }],
      [{ label: "", url: "https://example.org" }],
      Array.from({ length: 21 }, () => ({
        label: "Excess",
        url: "https://example.org",
      })),
    ]) {
      await expect(
        createBoardAnnouncement(boardId, {
          boardRevision: 3,
          title: "Notice",
          body: "Body",
          links,
        }),
      ).rejects.toThrow();
    }
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("announcement adapter redacts hidden server detail but retains known safe conflicts", async () => {
  const secret = "hidden announcement body and internal row";
  const conflict = installFetch(() =>
    jsonResponse(
      {
        detail: {
          code: "stale_announcement_revision",
          message: secret,
          current_revision: 17,
        },
      },
      409,
    ),
  );
  try {
    const error = await updateBoardAnnouncement(boardId, announcementId, {
      boardRevision: 3,
      announcementRevision: 1,
      title: "New title",
    }).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "stale_announcement_revision",
      message: "Announcement changed; reload before saving",
    });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain("current_revision");
  } finally {
    conflict.restore();
  }
  const denied = installFetch(() => jsonResponse({ detail: secret }, 404));
  try {
    await expect(
      readBoardAnnouncement(boardId, announcementId),
    ).rejects.toMatchObject({
      status: 404,
      message: "Request could not be completed",
    });
  } finally {
    denied.restore();
  }
  const deleteConflict = installFetch(() =>
    jsonResponse(
      { detail: { code: "announcement_not_archived", message: secret } },
      409,
    ),
  );
  try {
    const error = await deleteBoardAnnouncement(
      boardId,
      announcementId,
      4,
      2,
    ).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({
      status: 409,
      code: "announcement_not_archived",
      message: "Archive the announcement first",
    });
    expect(JSON.stringify(error)).not.toContain(secret);
  } finally {
    deleteConflict.restore();
  }
});
