import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../src/lib/api";
import type { BoardAnnouncementPage } from "../../src/components/systems/boards/adapters/board-announcements-api";
import { ServerBoardAnnouncementFeedDisplay } from "../../src/components/systems/boards/components/server-backed-board-announcements";
import {
  announcementFeedKey,
  announcementFeedFailure,
  announcementAuthorChoiceFailure,
  loadPublishedAnnouncementFeed,
  initialAnnouncementAuthorsState,
  transitionAnnouncementAuthors,
  transitionAnnouncementFeed,
  visibleAnnouncementAuthorId,
  type AnnouncementFeedState,
} from "../../src/components/systems/boards/hooks/use-server-board-announcements";

const boardId = "00000000-0000-4000-8000-000000000001";
const otherBoardId = "00000000-0000-4000-8000-000000000002";
const otherUserId = "00000000-0000-4000-8000-000000000007";
const announcementId = "00000000-0000-4000-8000-000000000003";
const authorId = "00000000-0000-4000-8000-000000000004";
const publishedAt = "2026-09-23T00:00:00Z";
const page: BoardAnnouncementPage = {
  items: [
    {
      id: announcementId,
      boardId,
      authorId,
      title: "Published safety update",
      body: "Use the new entrance.\n<script>not markup</script>",
      links: [],
      audience: {
        kind: "department",
        roleId: null,
        userId: null,
        departmentId: "00000000-0000-4000-8000-000000000005",
      },
      status: "published",
      publishAt: publishedAt,
      expiresAt: null,
      pinned: true,
      announcementRevision: null,
      boardRevision: 4,
      publicationNumber: 1,
      publishedAt,
      createdAt: publishedAt,
      updatedAt: publishedAt,
    },
  ],
  pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
  boardRevision: 4,
};

const wireAnnouncement = {
  id: announcementId,
  board_id: boardId,
  author_id: authorId,
  title: "Published safety update",
  body: "Use the new entrance.",
  links: [],
  audience: {
    kind: "department",
    role_id: null,
    user_id: null,
    department_id: "00000000-0000-4000-8000-000000000005",
  },
  status: "published",
  publish_at: publishedAt,
  expires_at: null,
  pinned: true,
  announcement_revision: null,
  board_revision: 4,
  publication_number: 1,
  published_at: publishedAt,
  created_at: publishedAt,
  updated_at: publishedAt,
};

function wirePage(items: unknown[]) {
  return {
    items,
    pagination: {
      limit: 25,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
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

test("current published page uses one bounded batch for personal flags", async () => {
  const mock = installFetch((path) =>
    path.includes("announcement-personal")
      ? Response.json([
          {
            announcement_id: announcementId,
            publication_number: 1,
            read: false,
            bookmarked: true,
          },
        ])
      : Response.json(wirePage([wireAnnouncement])),
  );
  try {
    const loaded = await loadPublishedAnnouncementFeed(boardId, 0);
    expect(loaded.page.items).toHaveLength(1);
    expect(loaded.personal[announcementId]).toMatchObject({
      read: false,
      bookmarked: true,
    });
    expect(mock.paths).toHaveLength(2);
    expect(mock.paths[1]).toBe(
      `/api/boards/${boardId}/announcement-personal?announcement_id=${announcementId}`,
    );
  } finally {
    mock.restore();
  }
});

test("published search sends one applied title/body query while preserving server totals", async () => {
  const mock = installFetch((path) =>
    path.includes("announcement-personal")
      ? Response.json([
          {
            announcement_id: announcementId,
            publication_number: 1,
            read: false,
            bookmarked: false,
          },
        ])
      : Response.json({
          ...wirePage([wireAnnouncement]),
          pagination: {
            limit: 25,
            offset: 0,
            count: 1,
            total: 7,
            has_more: true,
          },
        }),
  );
  try {
    const loaded = await loadPublishedAnnouncementFeed(
      boardId,
      0,
      () => {},
      "safety",
    );
    expect(loaded.page.pagination).toMatchObject({
      count: 1,
      total: 7,
      hasMore: true,
    });
    expect(mock.paths[0]).toContain("search=safety");
    expect(mock.paths).toHaveLength(2);
  } finally {
    mock.restore();
  }
});

test("selected visible author is sent as a server filter and isolated in the feed key", async () => {
  const mock = installFetch((path) =>
    path.includes("announcement-personal")
      ? Response.json([
          {
            announcement_id: announcementId,
            publication_number: 1,
            read: false,
            bookmarked: false,
          },
        ])
      : Response.json(wirePage([wireAnnouncement])),
  );
  try {
    const loaded = await loadPublishedAnnouncementFeed(
      boardId,
      0,
      () => {},
      "safety",
      authorId,
    );
    expect(loaded.page.items[0]?.authorId).toBe(authorId);
    expect(mock.paths[0]).toContain(`author_id=${authorId}`);
    expect(mock.paths[0]).toContain("search=safety");
    expect(
      announcementFeedKey(boardId, 0, authorId, "safety", authorId),
    ).not.toBe(
      announcementFeedKey(boardId, 0, authorId, "safety", otherUserId),
    );
  } finally {
    mock.restore();
  }
});

test("author choices clear across identity or denial and remove an author that disappears", () => {
  const firstKey = `${authorId}:${boardId}`;
  const secondKey = `${otherUserId}:${boardId}`;
  const choices = [{ id: authorId, label: "Avery" }];
  const loaded = transitionAnnouncementAuthors(
    transitionAnnouncementAuthors(initialAnnouncementAuthorsState, {
      type: "begin",
      key: firstKey,
      sequence: 1,
    }),
    { type: "resolve", key: firstKey, sequence: 1, data: choices },
  );
  expect(loaded.data).toEqual(choices);
  expect(visibleAnnouncementAuthorId(authorId, choices)).toBe(authorId);
  expect(visibleAnnouncementAuthorId(authorId, [])).toBeNull();
  expect(announcementFeedKey(boardId, 0, authorId, "", authorId)).not.toBe(
    announcementFeedKey(
      boardId,
      0,
      authorId,
      "",
      visibleAnnouncementAuthorId(authorId, []),
    ),
  );
  for (const status of [401, 403, 404])
    expect(
      announcementAuthorChoiceFailure(new ApiError(status, "Hidden")),
    ).toMatchObject({
      denied: true,
      retain: false,
    });
  expect(
    announcementAuthorChoiceFailure(new ApiError(503, "Unavailable")),
  ).toMatchObject({
    denied: false,
    retain: true,
  });
  const refreshing = transitionAnnouncementAuthors(loaded, {
    type: "begin",
    key: firstKey,
    sequence: 2,
  });
  expect(refreshing.data).toEqual(choices);
  const transient = transitionAnnouncementAuthors(refreshing, {
    type: "reject",
    key: firstKey,
    sequence: 2,
    error: "Could not refresh author choices",
    retain: true,
    denied: false,
  });
  expect(transient).toMatchObject({ status: "ready", data: choices });
  const denied = transitionAnnouncementAuthors(refreshing, {
    type: "reject",
    key: firstKey,
    sequence: 2,
    error: "Author choices unavailable",
    retain: false,
    denied: true,
  });
  expect(denied).toMatchObject({ status: "denied", data: null });
  const switched = transitionAnnouncementAuthors(loaded, {
    type: "begin",
    key: secondKey,
    sequence: 3,
  });
  expect(switched.data).toBeNull();
  expect(
    transitionAnnouncementAuthors(switched, {
      type: "resolve",
      key: firstKey,
      sequence: 1,
      data: choices,
    }),
  ).toEqual(switched);
});

test("hidden item in batch clears old page and refetches published content once", async () => {
  let lists = 0;
  let hidden = 0;
  const mock = installFetch((path) => {
    if (path.includes("announcement-personal"))
      return Response.json({ detail: "Not found" }, { status: 404 });
    lists += 1;
    return Response.json(wirePage(lists === 1 ? [wireAnnouncement] : []));
  });
  try {
    const loaded = await loadPublishedAnnouncementFeed(boardId, 0, () => {
      hidden += 1;
    });
    expect(hidden).toBe(1);
    expect(lists).toBe(2);
    expect(loaded.page.items).toEqual([]);
    expect(loaded.personal).toEqual({});
    expect(mock.paths).toHaveLength(3);
  } finally {
    mock.restore();
  }
});

test("published announcement feed renders returned revision as safe text without sample fallback", () => {
  const html = renderToStaticMarkup(
    createElement(ServerBoardAnnouncementFeedDisplay, { page }),
  );
  expect(html).toContain("Published safety update");
  expect(html).toContain("Use the new entrance.");
  expect(html).toContain("&lt;script&gt;not markup&lt;/script&gt;");
  expect(html).toContain("Pinned");
  expect(html).not.toContain("sample-board");
  expect(html).not.toContain("Unpublished replacement");

  const empty = renderToStaticMarkup(
    createElement(ServerBoardAnnouncementFeedDisplay, {
      page: {
        ...page,
        items: [],
        pagination: { ...page.pagination, count: 0, total: 0 },
      },
    }),
  );
  expect(empty).toContain("No published announcements");
  expect(empty).not.toContain("Published safety update");
});

test("published card author byline uses only an authorized choice label or a generic fallback", () => {
  const named = renderToStaticMarkup(
    createElement(ServerBoardAnnouncementFeedDisplay, {
      page,
      authorLabels: { [authorId]: "Avery" },
    }),
  );
  expect(named).toContain("Avery");
  expect(named).not.toContain(authorId);
  const absent = renderToStaticMarkup(
    createElement(ServerBoardAnnouncementFeedDisplay, {
      page,
      authorLabels: {},
    }),
  );
  expect(absent).toContain("Author unavailable");
  expect(absent).not.toContain(authorId);
});

test("published announcement revision renders its validated external links safely", () => {
  const linked: BoardAnnouncementPage = {
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
    createElement(ServerBoardAnnouncementFeedDisplay, { page: linked }),
  );
  expect(html).toContain("Policy &lt;script&gt;update&lt;/script&gt;");
  expect(html).toContain('href="https://example.org/policy?a=1&amp;b=2"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('referrerPolicy="no-referrer"');
  expect(html).not.toContain("<script>");
});

test("published feed shows personal flags only after authoritative batch state loads", () => {
  const unresolved = renderToStaticMarkup(
    createElement(ServerBoardAnnouncementFeedDisplay, { page }),
  );
  expect(unresolved).not.toContain("Unread");
  expect(unresolved).not.toContain("Mark as read");
  expect(unresolved).not.toContain("Bookmark</button>");

  const loaded = renderToStaticMarkup(
    createElement(ServerBoardAnnouncementFeedDisplay, {
      page,
      personal: {
        [announcementId]: {
          announcementId,
          publicationNumber: 1,
          read: false,
          bookmarked: true,
        },
      },
    }),
  );
  expect(loaded).toContain("Unread");
  expect(loaded).toContain("Mark as read");
  expect(loaded).toContain("Bookmarked");
  expect(loaded).toContain('aria-pressed="true"');
});

test("announcement feed clears denied and switched private content and ignores stale responses", () => {
  const initial: AnnouncementFeedState = {
    key: null,
    sequence: 0,
    data: null,
    personal: null,
    status: "idle",
    error: null,
    pendingId: null,
    actionError: null,
  };
  const ready = transitionAnnouncementFeed(
    transitionAnnouncementFeed(initial, {
      type: "begin",
      key: `${boardId}:0`,
      sequence: 1,
    }),
    { type: "resolve", key: `${boardId}:0`, sequence: 1, data: page },
  );
  expect(ready.data?.items[0]?.title).toBe("Published safety update");

  for (const status of [401, 403, 404]) {
    const failure = announcementFeedFailure(new ApiError(status, "Denied"));
    const denied = transitionAnnouncementFeed(ready, {
      type: "reject",
      key: `${boardId}:0`,
      sequence: 1,
      ...failure,
    });
    expect(denied.data).toBeNull();
    expect(denied.status).toBe("error");
  }

  const switched = transitionAnnouncementFeed(ready, {
    type: "begin",
    key: `${otherBoardId}:0`,
    sequence: 2,
  });
  expect(switched.data).toBeNull();
  expect(
    transitionAnnouncementFeed(switched, {
      type: "resolve",
      key: `${boardId}:0`,
      sequence: 1,
      data: page,
    }),
  ).toEqual(switched);
});

test("same Board and offset cannot retain prior verified user's content or personal flags", () => {
  const firstKey = announcementFeedKey(boardId, 0, authorId);
  const secondKey = announcementFeedKey(boardId, 0, otherUserId);
  const ready: AnnouncementFeedState = {
    key: firstKey,
    sequence: 1,
    data: page,
    personal: {
      [announcementId]: {
        announcementId,
        publicationNumber: 1,
        read: true,
        bookmarked: true,
      },
    },
    status: "ready",
    error: null,
    pendingId: null,
    actionError: null,
  };
  expect(secondKey).not.toBe(firstKey);
  const switched = transitionAnnouncementFeed(ready, {
    type: "begin",
    key: secondKey,
    sequence: 2,
  });
  expect(switched.data).toBeNull();
  expect(switched.personal).toBeNull();
  expect(
    transitionAnnouncementFeed(switched, {
      type: "resolve",
      key: firstKey,
      sequence: 1,
      data: page,
      personal: ready.personal ?? {},
    }),
  ).toEqual(switched);
});

test("same actor and Board cannot retain a prior applied search or accept its late response", () => {
  const firstKey = announcementFeedKey(boardId, 0, authorId, "safety");
  const nextKey = announcementFeedKey(boardId, 0, authorId, "policy");
  expect(nextKey).not.toBe(firstKey);
  const ready: AnnouncementFeedState = {
    key: firstKey,
    sequence: 5,
    data: page,
    personal: {
      [announcementId]: {
        announcementId,
        publicationNumber: 1,
        read: false,
        bookmarked: true,
      },
    },
    status: "ready",
    error: null,
    pendingId: null,
    actionError: null,
  };
  const switched = transitionAnnouncementFeed(ready, {
    type: "begin",
    key: nextKey,
    sequence: 6,
  });
  expect(switched.data).toBeNull();
  expect(switched.personal).toBeNull();
  expect(
    transitionAnnouncementFeed(switched, {
      type: "resolve",
      key: firstKey,
      sequence: 5,
      data: page,
      personal: ready.personal ?? {},
    }),
  ).toEqual(switched);
});

test("announcement feed retains same-board last-good only for transient failure", () => {
  const ready: AnnouncementFeedState = {
    key: `${boardId}:0`,
    sequence: 1,
    data: page,
    personal: null,
    status: "ready",
    error: null,
    pendingId: null,
    actionError: null,
  };
  const refreshing = transitionAnnouncementFeed(ready, {
    type: "begin",
    key: `${boardId}:0`,
    sequence: 2,
  });
  expect(refreshing.data).toEqual(page);
  const transient = transitionAnnouncementFeed(refreshing, {
    type: "reject",
    key: `${boardId}:0`,
    sequence: 2,
    ...announcementFeedFailure(new ApiError(503, "Unavailable")),
  });
  expect(transient.data).toEqual(page);
  expect(transient.error).toContain("refresh");
  const contractFailure = transitionAnnouncementFeed(refreshing, {
    type: "reject",
    key: `${boardId}:0`,
    sequence: 2,
    ...announcementFeedFailure(new Error("Invalid response")),
  });
  expect(contractFailure.data).toBeNull();
});

test("personal flags follow the current publication and clear with denied feed content", () => {
  const started = transitionAnnouncementFeed(
    {
      key: null,
      sequence: 0,
      data: null,
      personal: null,
      status: "idle",
      error: null,
      pendingId: null,
      actionError: null,
    },
    { type: "begin", key: `${boardId}:0`, sequence: 1 },
  );
  const loaded = transitionAnnouncementFeed(started, {
    type: "resolve",
    key: `${boardId}:0`,
    sequence: 1,
    data: page,
    personal: {
      [announcementId]: {
        announcementId,
        publicationNumber: 1,
        read: false,
        bookmarked: true,
      },
    },
  });
  expect(loaded.personal).toMatchObject({
    [announcementId]: { read: false, bookmarked: true },
  });
  const pending = transitionAnnouncementFeed(loaded, {
    type: "action-begin",
    key: `${boardId}:0`,
    sequence: 1,
    id: announcementId,
  });
  expect(pending.pendingId).toBe(announcementId);
  const saved = transitionAnnouncementFeed(pending, {
    type: "action-resolve",
    key: `${boardId}:0`,
    sequence: 1,
    state: {
      announcementId,
      publicationNumber: 1,
      read: true,
      bookmarked: true,
    },
  });
  expect(saved.personal?.[announcementId]).toMatchObject({
    read: true,
    bookmarked: true,
  });
  expect(saved.pendingId).toBeNull();
  const conflict = transitionAnnouncementFeed(saved, {
    type: "action-reject",
    key: `${boardId}:0`,
    sequence: 1,
    error: "Published announcement changed",
    clear: true,
  });
  expect(conflict.data).toBeNull();
  expect(conflict.personal).toBeNull();
  const denied = transitionAnnouncementFeed(loaded, {
    type: "reject",
    key: `${boardId}:0`,
    sequence: 1,
    error: "Announcements unavailable",
    retain: false,
  });
  expect(denied.data).toBeNull();
  expect(denied.personal).toBeNull();
});
