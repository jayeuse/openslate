import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../../src/lib/api";
import type { BoardPostPage } from "../../../src/components/systems/boards/adapters/board-posts-api";
import { ServerBoardPostReaderContent } from "../../../src/components/systems/boards/components/server-board-post-feed-display";
import {
  postFeedQueryForSort,
  postFeedKey,
  postFeedFailure,
  postAuthorChoiceFailure,
  loadPublishedPostFeed,
  initialPostAuthorsState,
  transitionPostAuthors,
  transitionPostFeed,
  visiblePostAuthorId,
  type PostFeedState,
} from "../../../src/components/systems/boards/hooks/use-server-board-posts";
import { wirePagination } from "../../helpers/pagination";

const boardId = "00000000-0000-4000-8000-000000000001";
const otherBoardId = "00000000-0000-4000-8000-000000000002";
const otherUserId = "00000000-0000-4000-8000-000000000007";
const postId = "00000000-0000-4000-8000-000000000003";
const authorId = "00000000-0000-4000-8000-000000000004";
const publishedAt = "2026-09-23T00:00:00Z";
const page: BoardPostPage = {
  items: [
    {
      id: postId,
      boardId,
      authorId,
      title: "Published safety update",
      body: "Use the new entrance.\n<script>not markup</script>",
      links: [],
      status: "published",
      publishAt: publishedAt,
      expiresAt: null,
      pinned: true,
      postRevision: null,
      boardRevision: 4,
      publicationNumber: 1,
      publishedAt,
      edited: false,
      createdAt: publishedAt,
      updatedAt: publishedAt,
    },
  ],
  pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
  boardRevision: 4,
};

const wirePost = {
  id: postId,
  board_id: boardId,
  author_id: authorId,
  title: "Published safety update",
  body: "Use the new entrance.",
  links: [],
  status: "published",
  publish_at: publishedAt,
  expires_at: null,
  pinned: true,
  post_revision: null,
  board_revision: 4,
  publication_number: 1,
  published_at: publishedAt,
  edited: false,
  created_at: publishedAt,
  updated_at: publishedAt,
};

function wirePage(items: unknown[]) {
  return {
    items,
    pagination: wirePagination({
      limit: 25,
      count: items.length,
      total: items.length,
    }),
    board_revision: 4,
  };
}

function installFetch(responder: (path: string) => Response) {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    return Promise.resolve(responder(path));
  }) as typeof fetch;
  return {
    paths,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("the published page is one bounded request with no personal state", async () => {
  const mock = installFetch(() => Response.json(wirePage([wirePost])));
  try {
    const loaded = await loadPublishedPostFeed(boardId, 0);
    expect(loaded.items).toHaveLength(1);
    expect(loaded.items[0]?.edited).toBe(false);
    expect(mock.paths).toEqual([
      `/api/boards/${boardId}/posts?view=published&limit=25&offset=0&sort_by=updated_at&sort_order=desc`,
    ]);
  } finally {
    mock.restore();
  }
});

test("published search sends one applied title/body query while preserving server totals", async () => {
  const mock = installFetch(() =>
    Response.json({
      ...wirePage([wirePost]),
      pagination: wirePagination({
        limit: 25,
        count: 1,
        total: 7,
        has_more: true,
      }),
    }),
  );
  try {
    const loaded = await loadPublishedPostFeed(boardId, 0, "safety");
    expect(loaded.pagination).toMatchObject({
      count: 1,
      total: 7,
      hasMore: true,
    });
    expect(mock.paths[0]).toContain("search=safety");
    expect(mock.paths).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("selected visible author is sent as a server filter and isolated in the feed key", async () => {
  const mock = installFetch(() => Response.json(wirePage([wirePost])));
  try {
    const loaded = await loadPublishedPostFeed(boardId, 0, "safety", authorId);
    expect(loaded.items[0]?.authorId).toBe(authorId);
    expect(mock.paths[0]).toContain(`author_id=${authorId}`);
    expect(mock.paths[0]).toContain("search=safety");
    expect(postFeedKey(boardId, 0, authorId, "safety", authorId)).not.toBe(
      postFeedKey(boardId, 0, authorId, "safety", otherUserId),
    );
  } finally {
    mock.restore();
  }
});

test("published sort and page size reach the server before offset paging", async () => {
  const mock = installFetch(() =>
    Response.json({
      ...wirePage([]),
      pagination: {
        limit: 5,
        offset: 10,
        count: 0,
        total: 12,
        has_more: true,
      },
    }),
  );
  try {
    const sorts = [
      {
        selection: "newest" as const,
        expectedBy: "updated_at",
        expectedOrder: "desc",
      },
      {
        selection: "oldest" as const,
        expectedBy: "updated_at",
        expectedOrder: "asc",
      },
      {
        selection: "title" as const,
        expectedBy: "title",
        expectedOrder: "asc",
      },
    ];
    for (const [index, sort] of sorts.entries()) {
      const options = {
        limit: 5,
        ...postFeedQueryForSort(sort.selection),
      };
      const loaded = await loadPublishedPostFeed(
        boardId,
        10,
        "",
        null,
        options,
      );
      const query = new URL(mock.paths[index] ?? "", "https://example.test")
        .searchParams;
      expect(query.get("limit")).toBe("5");
      expect(query.get("offset")).toBe("10");
      expect(query.get("sort_by")).toBe(sort.expectedBy);
      expect(query.get("sort_order")).toBe(sort.expectedOrder);
      expect(loaded.pagination).toMatchObject({
        limit: 5,
        offset: 10,
        total: 12,
        hasMore: true,
      });
      if (sort.selection === "title")
        expect(postFeedKey(boardId, 10, authorId, "", null, options)).not.toBe(
          postFeedKey(boardId, 10, authorId),
        );
    }
  } finally {
    mock.restore();
  }
});

test("author choices clear across identity or denial and remove an author that disappears", () => {
  const firstKey = `${authorId}:${boardId}`;
  const secondKey = `${otherUserId}:${boardId}`;
  const choices = [{ id: authorId, label: "Avery" }];
  const loaded = transitionPostAuthors(
    transitionPostAuthors(initialPostAuthorsState, {
      type: "begin",
      key: firstKey,
      sequence: 1,
    }),
    { type: "resolve", key: firstKey, sequence: 1, data: choices },
  );
  expect(loaded.data).toEqual(choices);
  expect(visiblePostAuthorId(authorId, choices)).toBe(authorId);
  expect(visiblePostAuthorId(authorId, [])).toBeNull();
  expect(postFeedKey(boardId, 0, authorId, "", authorId)).not.toBe(
    postFeedKey(boardId, 0, authorId, "", visiblePostAuthorId(authorId, [])),
  );
  for (const status of [401, 403, 404])
    expect(
      postAuthorChoiceFailure(new ApiError(status, "Hidden")),
    ).toMatchObject({
      denied: true,
      retain: false,
    });
  expect(
    postAuthorChoiceFailure(new ApiError(503, "Unavailable")),
  ).toMatchObject({
    denied: false,
    retain: true,
  });
  const refreshing = transitionPostAuthors(loaded, {
    type: "begin",
    key: firstKey,
    sequence: 2,
  });
  expect(refreshing.data).toEqual(choices);
  const transient = transitionPostAuthors(refreshing, {
    type: "reject",
    key: firstKey,
    sequence: 2,
    error: "Could not refresh author choices",
    retain: true,
    denied: false,
  });
  expect(transient).toMatchObject({ status: "ready", data: choices });
  const denied = transitionPostAuthors(refreshing, {
    type: "reject",
    key: firstKey,
    sequence: 2,
    error: "Author choices unavailable",
    retain: false,
    denied: true,
  });
  expect(denied).toMatchObject({ status: "denied", data: null });
  const switched = transitionPostAuthors(loaded, {
    type: "begin",
    key: secondKey,
    sequence: 3,
  });
  expect(switched.data).toBeNull();
  expect(
    transitionPostAuthors(switched, {
      type: "resolve",
      key: firstKey,
      sequence: 1,
      data: choices,
    }),
  ).toEqual(switched);
});

test("published post revision renders its validated external links safely", () => {
  const linked: BoardPostPage = {
    ...page,
    items: [
      {
        ...page.items[0],
        links: [
          {
            label: "Policy <script>update</script>",
            url: "https://example.org/policy?a=1&b=2",
          },
        ],
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(ServerBoardPostReaderContent, {
      post: linked.items[0],
    }),
  );
  expect(html).toContain("Policy &lt;script&gt;update&lt;/script&gt;");
  expect(html).toContain('href="https://example.org/policy?a=1&amp;b=2"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('referrerPolicy="no-referrer"');
  expect(html).not.toContain("<script>");
});

test("post feed clears denied and switched private content and ignores stale responses", () => {
  const initial: PostFeedState = {
    key: null,
    sequence: 0,
    data: null,
    status: "idle",
    error: null,
  };
  const ready = transitionPostFeed(
    transitionPostFeed(initial, {
      type: "begin",
      key: `${boardId}:0`,
      sequence: 1,
    }),
    { type: "resolve", key: `${boardId}:0`, sequence: 1, data: page },
  );
  expect(ready.data?.items[0]?.title).toBe("Published safety update");

  for (const status of [401, 403, 404]) {
    const failure = postFeedFailure(new ApiError(status, "Denied"));
    const denied = transitionPostFeed(ready, {
      type: "reject",
      key: `${boardId}:0`,
      sequence: 1,
      ...failure,
    });
    expect(denied.data).toBeNull();
    expect(denied.status).toBe("error");
  }

  const switched = transitionPostFeed(ready, {
    type: "begin",
    key: `${otherBoardId}:0`,
    sequence: 2,
  });
  expect(switched.data).toBeNull();
  expect(
    transitionPostFeed(switched, {
      type: "resolve",
      key: `${boardId}:0`,
      sequence: 1,
      data: page,
    }),
  ).toEqual(switched);
});

test("same Board and offset cannot retain prior verified user's content", () => {
  const firstKey = postFeedKey(boardId, 0, authorId);
  const secondKey = postFeedKey(boardId, 0, otherUserId);
  const ready: PostFeedState = {
    key: firstKey,
    sequence: 1,
    data: page,
    status: "ready",
    error: null,
  };
  expect(secondKey).not.toBe(firstKey);
  const switched = transitionPostFeed(ready, {
    type: "begin",
    key: secondKey,
    sequence: 2,
  });
  expect(switched.data).toBeNull();
  expect(
    transitionPostFeed(switched, {
      type: "resolve",
      key: firstKey,
      sequence: 1,
      data: page,
    }),
  ).toEqual(switched);
});

test("same actor and Board cannot retain a prior applied search or accept its late response", () => {
  const firstKey = postFeedKey(boardId, 0, authorId, "safety");
  const nextKey = postFeedKey(boardId, 0, authorId, "policy");
  expect(nextKey).not.toBe(firstKey);
  const ready: PostFeedState = {
    key: firstKey,
    sequence: 5,
    data: page,
    status: "ready",
    error: null,
  };
  const switched = transitionPostFeed(ready, {
    type: "begin",
    key: nextKey,
    sequence: 6,
  });
  expect(switched.data).toBeNull();
  expect(
    transitionPostFeed(switched, {
      type: "resolve",
      key: firstKey,
      sequence: 5,
      data: page,
    }),
  ).toEqual(switched);
});

test("post feed retains same-board last-good only for transient failure", () => {
  const ready: PostFeedState = {
    key: `${boardId}:0`,
    sequence: 1,
    data: page,
    status: "ready",
    error: null,
  };
  const refreshing = transitionPostFeed(ready, {
    type: "begin",
    key: `${boardId}:0`,
    sequence: 2,
  });
  expect(refreshing.data).toEqual(page);
  const transient = transitionPostFeed(refreshing, {
    type: "reject",
    key: `${boardId}:0`,
    sequence: 2,
    ...postFeedFailure(new ApiError(503, "Unavailable")),
  });
  expect(transient.data).toEqual(page);
  expect(transient.error).toContain("refresh");
  const contractFailure = transitionPostFeed(refreshing, {
    type: "reject",
    key: `${boardId}:0`,
    sequence: 2,
    ...postFeedFailure(new Error("Invalid response")),
  });
  expect(contractFailure.data).toBeNull();
});
