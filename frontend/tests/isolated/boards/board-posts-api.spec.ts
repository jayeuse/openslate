import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  archiveBoardPost,
  createBoardPost,
  deleteBoardPost,
  listBoardPostRevisions,
  listBoardPosts,
  publishBoardPost,
  readBoardPost,
  readBoardPostRevision,
  restoreBoardPost,
  scheduleBoardPost,
  unpublishBoardPost,
  updateBoardPost,
} from "../../../src/components/systems/boards/adapters/board-posts-api";
import { installNoArgumentFetch as installFetch } from "../helpers/fake-fetch";

const boardId = "00000000-0000-4000-8000-000000000001";
const postId = "00000000-0000-4000-8000-000000000002";
const authorId = "00000000-0000-4000-8000-000000000003";
const publicationKey = "00000000-0000-4000-8000-000000000005";
const revisionId = "00000000-0000-4000-8000-000000000006";
const timestamp = "2026-09-23T00:00:00Z";

const jsonResponse = (body: unknown, status = 200) =>
  Response.json(body, { status });
const published = {
  id: postId,
  board_id: boardId,
  author_id: authorId,
  title: "Earlier published",
  body: "Public text",
  links: [{ label: "Release", url: "https://example.org/release" }],
  status: "published",
  publish_at: timestamp,
  expires_at: null,
  pinned: false,
  post_revision: null,
  board_revision: 4,
  publication_number: 1,
  published_at: timestamp,
  edited: false,
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
  post_revision: 2,
  publication_number: null,
  published_at: null,
};
const mutation = {
  id: postId,
  post_revision: 2,
  board_revision: 4,
};
const page = { limit: 25, offset: 0, count: 1, total: 1, has_more: false };

test("post published list uses bounded query and immutable published fields", async () => {
  const mock = installFetch(() =>
    jsonResponse({ items: [published], pagination: page, board_revision: 4 }),
  );
  try {
    const result = await listBoardPosts(boardId, {
      view: "published",
      sortBy: "created_at",
      sortOrder: "asc",
      search: "  Earlier  ",
      authorId: authorId,
    });
    expect(result.items[0]).toMatchObject({
      id: postId,
      title: "Earlier published",
      status: "published",
      postRevision: null,
      publicationNumber: 1,
      publishedAt: timestamp,
      links: [{ label: "Release", url: "https://example.org/release" }],
      edited: false,
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
      `/api/boards/${boardId}/posts?view=published&limit=25&offset=0&sort_by=created_at&sort_order=asc&search=Earlier&author_id=${authorId}`,
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("post editor loads mutable published content without using the recipient feed", async () => {
  const editable = {
    ...draft,
    status: "published",
    publish_at: timestamp,
  };
  const mock = installFetch(() =>
    jsonResponse({ items: [editable], pagination: page, board_revision: 4 }),
  );
  try {
    const result = await listBoardPosts(boardId, { view: "editable" });
    expect(result.items[0]).toMatchObject({
      id: postId,
      title: "Unpublished replacement",
      status: "published",
      postRevision: 2,
      publicationNumber: null,
    });
    expect(String(mock.requests[0]?.input)).toContain("view=editable");
  } finally {
    mock.restore();
  }
});

test("post draft read and writes send UTC fields and no audience", async () => {
  const responses = [
    jsonResponse(draft),
    jsonResponse(mutation, 201),
    jsonResponse(mutation),
    jsonResponse(mutation),
  ];
  const mock = installFetch(() => responses.shift()!);
  try {
    await expect(
      readBoardPost(boardId, postId, "draft"),
    ).resolves.toMatchObject({
      status: "draft",
      postRevision: 2,
      publicationNumber: null,
      links: [{ label: "Draft", url: "https://example.org/draft" }],
    });
    await expect(
      createBoardPost(boardId, {
        boardRevision: 3,
        title: "  Opening  ",
        body: "  News  ",
        expiresAt: "2026-09-30T00:00:00Z",
        pinned: false,
        links: [{ label: "  Source  ", url: "  https://example.org/source  " }],
      }),
    ).resolves.toEqual({
      id: postId,
      postRevision: 2,
      boardRevision: 4,
    });
    await expect(
      updateBoardPost(boardId, postId, {
        boardRevision: 4,
        postRevision: 2,
        title: "  Revised  ",
        expiresAt: null,
        links: [],
      }),
    ).resolves.toMatchObject({ id: postId });
    await expect(
      scheduleBoardPost(boardId, postId, {
        boardRevision: 4,
        postRevision: 2,
        publishAt: "2026-09-30T00:00:00Z",
      }),
    ).resolves.toMatchObject({ id: postId });
    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      [`/api/boards/${boardId}/posts/${postId}?view=draft`, undefined],
      [`/api/boards/${boardId}/posts`, "POST"],
      [`/api/boards/${boardId}/posts/${postId}`, "PATCH"],
      [`/api/boards/${boardId}/posts/${postId}/schedule`, "POST"],
    ]);
    expect(JSON.parse(String(mock.requests[1]?.init?.body))).toEqual({
      board_revision: 3,
      title: "Opening",
      body: "News",
      expires_at: "2026-09-30T00:00:00Z",
      pinned: false,
      links: [{ label: "Source", url: "https://example.org/source" }],
    });
    expect(JSON.parse(String(mock.requests[2]?.init?.body))).toEqual({
      board_revision: 4,
      post_revision: 2,
      title: "Revised",
      expires_at: null,
      links: [],
    });
    expect(JSON.parse(String(mock.requests[3]?.init?.body))).toEqual({
      board_revision: 4,
      post_revision: 2,
      publish_at: "2026-09-30T00:00:00Z",
    });
    expect(mock.requests.every(({ init }) => init?.cache === "no-store")).toBe(
      true,
    );
  } finally {
    mock.restore();
  }
});

test("post publication keeps caller retry key and lifecycle sends revisions", async () => {
  const responses = [
    jsonResponse({
      id: revisionId,
      post_id: postId,
      publication_number: 1,
      publication_key: publicationKey,
      published_at: timestamp,
    }),
    jsonResponse(mutation),
    jsonResponse(mutation),
    jsonResponse(mutation),
    jsonResponse({
      id: postId,
      outcome: "archived",
      post_revision: 6,
      board_revision: 8,
    }),
  ];
  const mock = installFetch(() => responses.shift()!);
  try {
    await expect(
      publishBoardPost(boardId, postId, {
        boardRevision: 4,
        postRevision: 2,
        publicationKey,
      }),
    ).resolves.toMatchObject({
      id: revisionId,
      postId,
      publicationNumber: 1,
      publicationKey,
    });
    await unpublishBoardPost(boardId, postId, 4, 2);
    await archiveBoardPost(boardId, postId, 5, 3);
    await restoreBoardPost(boardId, postId, 6, 4);
    await expect(deleteBoardPost(boardId, postId, 7, 5)).resolves.toEqual({
      id: postId,
      outcome: "archived",
      postRevision: 6,
      boardRevision: 8,
    });
    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      [`/api/boards/${boardId}/posts/${postId}/publish`, "POST"],
      [`/api/boards/${boardId}/posts/${postId}/unpublish`, "POST"],
      [`/api/boards/${boardId}/posts/${postId}/archive`, "POST"],
      [`/api/boards/${boardId}/posts/${postId}/restore`, "POST"],
      [`/api/boards/${boardId}/posts/${postId}`, "DELETE"],
    ]);
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      board_revision: 4,
      post_revision: 2,
      publication_key: publicationKey,
    });
    expect(JSON.parse(String(mock.requests[4]?.init?.body))).toEqual({
      board_revision: 7,
      post_revision: 5,
    });
    expect(mock.requests.every(({ init }) => init?.cache === "no-store")).toBe(
      true,
    );
  } finally {
    mock.restore();
  }
});

test("post adapter rejects invalid IDs, audience fields, UTC offsets, and empty patches before fetch", async () => {
  const mock = installFetch(() => jsonResponse(mutation));
  try {
    await expect(listBoardPosts("../outside")).rejects.toThrow();
    await expect(listBoardPosts(boardId, { limit: 101 })).rejects.toThrow();
    await expect(
      listBoardPosts(boardId, { authorId: "not-a-uuid" }),
    ).rejects.toThrow();
    await expect(
      listBoardPosts(boardId, { deleted: "include" } as never),
    ).rejects.toThrow();
    await expect(readBoardPost(boardId, "../outside")).rejects.toThrow();
    await expect(
      createBoardPost(boardId, {
        boardRevision: 1,
        title: "Notice",
        body: "Body",
        audience: { kind: "everyone" },
      } as never),
    ).rejects.toThrow();
    await expect(
      createBoardPost(boardId, {
        boardRevision: 1,
        title: "Notice",
        body: "Body",
        expiresAt: "2026-09-30T08:00:00+08:00",
      }),
    ).rejects.toThrow();
    await expect(
      updateBoardPost(boardId, postId, {
        boardRevision: 1,
        postRevision: 1,
      }),
    ).rejects.toThrow();
    await expect(
      scheduleBoardPost(boardId, postId, {
        boardRevision: 1,
        postRevision: 1,
        publishAt: "2026-09-30T08:00:00+08:00",
      }),
    ).rejects.toThrow();
    await expect(
      publishBoardPost(boardId, postId, {
        boardRevision: 1,
        postRevision: 1,
        publicationKey: "same-key",
      }),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("post adapter fails closed on leaked or cross-Board DTOs and inconsistent publication fields", async () => {
  for (const payload of [
    { ...published, private_token: "secret" },
    { ...published, board_id: authorId },
    { ...published, post_revision: 2 },
    { ...published, audience: { kind: "everyone" } },
    { ...published, edited: undefined },
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
      await expect(readBoardPost(boardId, postId)).rejects.toBeInstanceOf(
        ApiContractError,
      );
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
    await expect(listBoardPosts(boardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
  const mismatchedPublication = installFetch(() =>
    jsonResponse({
      id: revisionId,
      post_id: authorId,
      publication_number: 1,
      publication_key: publicationKey,
      published_at: timestamp,
    }),
  );
  try {
    await expect(
      publishBoardPost(boardId, postId, {
        boardRevision: 4,
        postRevision: 2,
        publicationKey,
      }),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    mismatchedPublication.restore();
  }
});

test("post link input rejects unsafe and oversized values before fetch", async () => {
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
        createBoardPost(boardId, {
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

test("post adapter redacts hidden server detail but retains known safe conflicts", async () => {
  const secret = "hidden post body and internal row";
  const conflict = installFetch(() =>
    jsonResponse(
      {
        detail: {
          code: "stale_post_revision",
          message: secret,
          current_revision: 17,
        },
      },
      409,
    ),
  );
  try {
    const error = await updateBoardPost(boardId, postId, {
      boardRevision: 3,
      postRevision: 1,
      title: "New title",
    }).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "stale_post_revision",
      message: "Post changed; reload before saving",
    });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain("current_revision");
  } finally {
    conflict.restore();
  }
  const denied = installFetch(() => jsonResponse({ detail: secret }, 404));
  try {
    await expect(readBoardPost(boardId, postId)).rejects.toMatchObject({
      status: 404,
      message: "Request could not be completed",
    });
  } finally {
    denied.restore();
  }
  const deleteConflict = installFetch(() =>
    jsonResponse(
      { detail: { code: "post_not_archived", message: secret } },
      409,
    ),
  );
  try {
    const error = await deleteBoardPost(boardId, postId, 4, 2).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({
      status: 409,
      code: "post_not_archived",
      message: "Archive the post first",
    });
    expect(JSON.stringify(error)).not.toContain(secret);
  } finally {
    deleteConflict.restore();
  }
});

test("post delete reports whether the post was deleted or archived", async () => {
  for (const [body, valid] of [
    [
      {
        id: postId,
        outcome: "deleted",
        post_revision: null,
        board_revision: 5,
      },
      true,
    ],
    [
      { id: postId, outcome: "deleted", post_revision: 3, board_revision: 5 },
      false,
    ],
    [
      {
        id: postId,
        outcome: "archived",
        post_revision: null,
        board_revision: 5,
      },
      false,
    ],
    [
      {
        id: authorId,
        outcome: "deleted",
        post_revision: null,
        board_revision: 5,
      },
      false,
    ],
  ] as const) {
    const mock = installFetch(() => jsonResponse(body));
    try {
      const result = deleteBoardPost(boardId, postId, 4, 2);
      if (valid)
        await expect(result).resolves.toEqual({
          id: postId,
          outcome: "deleted",
          postRevision: null,
          boardRevision: 5,
        });
      else await expect(result).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
});

test("post revision history lists published versions and reads one", async () => {
  const summary = {
    id: revisionId,
    post_id: postId,
    publication_number: 2,
    author_id: authorId,
    title: "Second version",
    published_at: timestamp,
  };
  const responses = [
    jsonResponse({ post_id: postId, items: [summary] }),
    jsonResponse({
      ...summary,
      body: "Second body",
      links: [],
      expires_at: null,
    }),
  ];
  const mock = installFetch(() => responses.shift()!);
  try {
    await expect(listBoardPostRevisions(boardId, postId)).resolves.toEqual({
      postId,
      items: [
        {
          id: revisionId,
          postId,
          publicationNumber: 2,
          authorId,
          title: "Second version",
          publishedAt: timestamp,
        },
      ],
    });
    await expect(
      readBoardPostRevision(boardId, postId, revisionId),
    ).resolves.toMatchObject({
      id: revisionId,
      publicationNumber: 2,
      body: "Second body",
      expiresAt: null,
    });
    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      `/api/boards/${boardId}/posts/${postId}/revisions`,
      `/api/boards/${boardId}/posts/${postId}/revisions/${revisionId}`,
    ]);
  } finally {
    mock.restore();
  }
  const foreign = installFetch(() =>
    jsonResponse({
      post_id: postId,
      items: [{ ...summary, post_id: authorId }],
    }),
  );
  try {
    await expect(
      listBoardPostRevisions(boardId, postId),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    foreign.restore();
  }
});
