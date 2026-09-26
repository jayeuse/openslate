import { expect, test, type Page } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../src/lib/api";
import type { BoardAnnouncementPage } from "../../src/components/systems/boards/adapters/board-announcements-api";
import { ServerBoardAnnouncementReaderContent } from "../../src/components/systems/boards/components/server-board-announcement-feed-display";
import {
  announcementFeedQueryForSort,
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
const viewerId = otherUserId;
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

const browserAnnouncement = {
  ...wireAnnouncement,
  body: "Use the new entrance.\n<script>not markup</script>",
};

const browserBoard = {
  id: boardId,
  owner_id: viewerId,
  department_id: null,
  name: "Operations board",
  description: "Current authorized workspace content",
  status: "active",
  default_section: "announcements",
  revision: 4,
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

async function installAnnouncementBrowserApi(page: Page) {
  let authorChoices = [{ id: authorId, label: "Avery" }];
  let publishedItems = [browserAnnouncement];
  const personalRows = [
    {
      announcement_id: announcementId,
      publication_number: 1,
      read: false,
      bookmarked: true,
    },
  ];
  let personalBarrier: Promise<void> | null = null;
  let releasePersonalBarrier: (() => void) | null = null;
  let personalRequestObserved = Promise.resolve();
  let observePersonalRequest: (() => void) | null = null;

  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Unmocked announcement test API route" }),
    }),
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: viewerId,
        setup_required: false,
      }),
    }),
  );
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ today: "2026-09-23" }),
    }),
  );
  await page.route("**/api/views/data-sources**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [],
        pagination: {
          limit: 25,
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
      }),
    }),
  );
  await page.route("**/api/boards**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const prefix = `/api/boards/${boardId}`;
    const reply = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/boards/personal")
      return reply(200, { favorite_board_ids: [], home_board_id: null });
    if (path === "/api/boards")
      return reply(200, {
        items: [browserBoard],
        pagination: {
          limit: 25,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      });
    if (path === `${prefix}/my-access`)
      return reply(200, { view: true, edit: true, manage: true });
    if (path === `${prefix}/content-audience-targets`)
      return reply(200, {
        items: [],
        pagination: {
          limit: 25,
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
      });
    if (path === `${prefix}/announcement-authors`)
      return reply(200, authorChoices);
    if (path === `${prefix}/announcements`) {
      const view = url.searchParams.get("view");
      return reply(200, wirePage(view === "published" ? publishedItems : []));
    }
    if (path === `${prefix}/announcement-personal`) {
      observePersonalRequest?.();
      if (personalBarrier) await personalBarrier;
      const requestedIds = url.searchParams.getAll("announcement_id");
      return reply(
        200,
        personalRows.filter((row) =>
          requestedIds.includes(row.announcement_id),
        ),
      );
    }
    if (path === prefix) return reply(200, browserBoard);
    return reply(404, { detail: "Unmocked announcement test API route" });
  });

  return {
    setAuthorChoices(choices: typeof authorChoices) {
      authorChoices = choices;
    },
    setPublishedItems(items: typeof publishedItems) {
      publishedItems = items;
    },
    holdPersonalResponse() {
      personalBarrier = new Promise<void>((resolve) => {
        releasePersonalBarrier = resolve;
      });
      personalRequestObserved = new Promise<void>((resolve) => {
        observePersonalRequest = resolve;
      });
    },
    waitForPersonalRequest() {
      return personalRequestObserved;
    },
    releasePersonalResponse() {
      releasePersonalBarrier?.();
      personalBarrier = null;
      releasePersonalBarrier = null;
      observePersonalRequest = null;
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
        ...announcementFeedQueryForSort(sort.selection),
      };
      const loaded = await loadPublishedAnnouncementFeed(
        boardId,
        10,
        () => {},
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
      expect(loaded.page.pagination).toMatchObject({
        limit: 5,
        offset: 10,
        total: 12,
        hasMore: true,
      });
      if (sort.selection === "title")
        expect(
          announcementFeedKey(boardId, 10, authorId, "", null, options),
        ).not.toBe(announcementFeedKey(boardId, 10, authorId));
    }
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

test("published feed shows only returned safe text and clears when the server returns an empty page", async ({
  page,
}) => {
  const api = await installAnnouncementBrowserApi(page);
  await page.goto(`/boards?board=${boardId}&section=announcements`);

  await expect(
    page.getByRole("heading", { name: "Published safety update" }),
  ).toBeVisible();
  await expect(page.getByText("Pinned", { exact: true })).toBeVisible();
  const summary = page.locator("article p").first();
  await expect(summary).toBeVisible();
  expect(await summary.textContent()).toBe(browserAnnouncement.body);
  await expect(page.locator("article script")).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain("sample-board");
  expect(await page.locator("body").innerText()).not.toContain(
    "Unpublished replacement",
  );

  api.setPublishedItems([]);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "No published announcements" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Published safety update" }),
  ).toHaveCount(0);
});

test("published card author byline uses only an authorized choice label or a generic fallback", async ({
  page,
}) => {
  const api = await installAnnouncementBrowserApi(page);
  await page.goto(`/boards?board=${boardId}&section=announcements`);

  await expect(page.getByText("Avery", { exact: true })).toBeVisible();
  await expect(page.getByText(authorId, { exact: true })).toHaveCount(0);

  api.setAuthorChoices([]);
  await page.reload();
  await expect(
    page.getByText("Author unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(authorId, { exact: true })).toHaveCount(0);
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
    createElement(ServerBoardAnnouncementReaderContent, {
      announcement: linked.items[0],
    }),
  );
  expect(html).toContain("Policy &lt;script&gt;update&lt;/script&gt;");
  expect(html).toContain('href="https://example.org/policy?a=1&amp;b=2"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('referrerPolicy="no-referrer"');
  expect(html).not.toContain("<script>");
});

test("published personal flags stay hidden until the authoritative batch response resolves", async ({
  page,
}) => {
  const api = await installAnnouncementBrowserApi(page);
  api.holdPersonalResponse();
  try {
    await page.goto(`/boards?board=${boardId}&section=announcements`);
    await api.waitForPersonalRequest();

    await expect(
      page.getByRole("heading", { name: "Published safety update" }),
    ).toHaveCount(0);
    await expect(page.getByText("Unread", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Mark as read" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Bookmarked" })).toHaveCount(
      0,
    );

    api.releasePersonalResponse();
    await expect(
      page.getByRole("heading", { name: "Published safety update" }),
    ).toBeVisible();
    await expect(page.getByText("Unread", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Mark as read" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Bookmarked" }),
    ).toBeVisible();
  } finally {
    api.releasePersonalResponse();
  }
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
