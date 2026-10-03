import { expect, test, type Page } from "./helpers/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../src/lib/api";
import type { BoardPostPage } from "../../src/components/systems/boards/adapters/board-posts-api";
import { ServerBoardPostReaderContent } from "../../src/components/systems/boards/components/server-board-post-feed-display";
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
} from "../../src/components/systems/boards/hooks/use-server-board-posts";

const boardId = "00000000-0000-4000-8000-000000000001";
const otherBoardId = "00000000-0000-4000-8000-000000000002";
const otherUserId = "00000000-0000-4000-8000-000000000007";
const postId = "00000000-0000-4000-8000-000000000003";
const authorId = "00000000-0000-4000-8000-000000000004";
const viewerId = otherUserId;
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

const browserPost = {
  ...wirePost,
  body: "Use the new entrance.\n<script>not markup</script>",
};

const browserBoard = {
  id: boardId,
  scope: "project",
  department_id: null,
  name: "Operations board",
  description: "Current authorized workspace content",
  status: "active",
  revision: 4,
  level: "write",
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

async function installPostBrowserApi(page: Page) {
  let authorChoices = [{ id: authorId, label: "Avery" }];
  let publishedItems: Record<string, unknown>[] = [browserPost];
  const revisionIds = [
    "00000000-0000-4000-8000-000000000011",
    "00000000-0000-4000-8000-000000000012",
  ];
  const revision = (number: 1 | 2) => ({
    id: revisionIds[number - 1],
    post_id: postId,
    publication_number: number,
    author_id: authorId,
    title: number === 2 ? "Published safety update" : "Safety update draft",
    published_at: publishedAt,
  });

  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Unmocked post test API route" }),
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
      return reply(200, {
        level: "write",
        read: true,
        write: true,
        manage: false,
      });
    if (path === `${prefix}/post-authors`) return reply(200, authorChoices);
    if (path === `${prefix}/posts`) {
      const view = url.searchParams.get("view");
      return reply(200, wirePage(view === "published" ? publishedItems : []));
    }
    if (
      path === `${prefix}/posts/${postId}` &&
      url.searchParams.get("view") === "published"
    )
      return reply(200, browserPost);
    if (path === `${prefix}/posts/${postId}/revisions`)
      return reply(200, { post_id: postId, items: [revision(2), revision(1)] });
    for (const number of [1, 2] as const)
      if (
        path ===
        `${prefix}/posts/${postId}/revisions/${revisionIds[number - 1]}`
      )
        return reply(200, {
          ...revision(number),
          body:
            number === 2 ? "Use the new entrance." : "Use the old entrance.",
          links: [],
          expires_at: null,
        });
    if (path === prefix) return reply(200, browserBoard);
    return reply(404, { detail: "Unmocked post test API route" });
  });

  return {
    setAuthorChoices(choices: typeof authorChoices) {
      authorChoices = choices;
    },
    setPublishedItems(items: typeof publishedItems) {
      publishedItems = items;
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

test("URL-selected published post opens outside the feed, survives reload, and closes only its target", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  api.setPublishedItems([]);
  const href = `/boards?board=${boardId}&section=posts&post=${postId}&event=${otherBoardId}&keep=chosen`;
  await page.goto(href);
  const reader = page.getByRole("dialog", {
    name: browserPost.title,
    exact: true,
  });
  await expect(reader).toBeVisible();
  await expect(
    reader.getByText(browserPost.body, { exact: true }),
  ).toBeVisible();
  await expect(reader.locator("script")).toHaveCount(0);
  await page.reload();
  await expect(reader).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reader).toHaveCount(0);
  await expect(page).toHaveURL(
    (url) =>
      !url.searchParams.has("post") &&
      url.searchParams.get("board") === boardId &&
      url.searchParams.get("section") === "posts" &&
      url.searchParams.get("event") === otherBoardId &&
      url.searchParams.get("keep") === "chosen",
  );
  await expect(
    page.getByRole("searchbox", { name: "Search posts" }),
  ).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "No published posts" }),
  ).toBeVisible();
});

test("URL-selected post rejects invalid, missing, and denied targets without private content", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  api.setPublishedItems([]);
  const reads: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith(
        `/api/boards/${boardId}/posts/`,
      )
    )
      reads.push(request.url());
  });
  await page.goto(`/boards?board=${boardId}&section=posts&post=invalid`);
  const unavailable = page.getByRole("dialog", {
    name: "Post unavailable",
    exact: true,
  });
  await expect(unavailable).toBeVisible();
  expect(reads).toEqual([]);
  for (const status of [403, 404]) {
    await page.route(
      `**/api/boards/${boardId}/posts/${postId}?view=published`,
      (route) =>
        route.fulfill({ status, json: { detail: "Private post title" } }),
    );
    await page.goto(`/boards?board=${boardId}&section=posts&post=${postId}`);
    await expect(unavailable).toBeVisible();
    await expect(unavailable.getByText("Private post title")).toHaveCount(0);
    await expect(unavailable.getByText(browserPost.body)).toHaveCount(0);
    await unavailable.getByRole("button", { name: "Close post" }).click();
    await expect(page).toHaveURL((url) => !url.searchParams.has("post"));
  }
});

test("URL-selected post retries a failed detail read without falling back to the feed", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  api.setPublishedItems([]);
  let available = false;
  await page.route(
    `**/api/boards/${boardId}/posts/${postId}?view=published`,
    (route) =>
      route.fulfill(
        available
          ? { json: browserPost }
          : { status: 503, json: { detail: "Unavailable" } },
      ),
  );
  await page.goto(`/boards?board=${boardId}&section=posts&post=${postId}`);
  const unavailable = page.getByRole("dialog", { name: "Post unavailable" });
  await expect(unavailable).toBeVisible();
  available = true;
  await unavailable.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("dialog", { name: browserPost.title }),
  ).toBeVisible();
});

test("closing a URL-selected post ignores its late detail response after another post opens", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  const nextPost = {
    ...browserPost,
    id: otherBoardId,
    title: "Second public update",
    body: "Use the west entrance.",
  };
  api.setPublishedItems([nextPost]);
  await page.route(
    `**/api/boards/${boardId}/posts/${otherBoardId}?view=published`,
    (route) => route.fulfill({ json: nextPost }),
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/boards/${boardId}/posts/${postId}?view=published`,
    async (route) => {
      await held;
      await route.fulfill({ json: browserPost });
    },
  );
  const requested = page.waitForRequest(
    `**/api/boards/${boardId}/posts/${postId}?view=published`,
  );
  await page.goto(`/boards?board=${boardId}&section=posts&post=${postId}`);
  await requested;
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close post" })
    .click();
  await expect(page).toHaveURL((url) => !url.searchParams.has("post"));
  await page.getByRole("button", { name: "Open post", exact: true }).click();
  const nextReader = page.getByRole("dialog", {
    name: nextPost.title,
    exact: true,
  });
  await expect(nextReader).toBeVisible();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("post") === otherBoardId,
  );
  const response = page.waitForResponse(
    `**/api/boards/${boardId}/posts/${postId}?view=published`,
  );
  release();
  await (await response).finished();
  await expect(
    nextReader.getByText(nextPost.body, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: browserPost.title, exact: true }),
  ).toHaveCount(0);
  await nextReader.getByRole("button", { name: "Close post" }).click();
  await expect(page).toHaveURL((url) => !url.searchParams.has("post"));
});

test("published search sends one applied title/body query while preserving server totals", async () => {
  const mock = installFetch(() =>
    Response.json({
      ...wirePage([wirePost]),
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

test("published feed shows only returned safe text and clears when the server returns an empty page", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  await page.goto(`/boards?board=${boardId}&section=posts`);

  await expect(
    page.getByRole("heading", { name: "Published safety update" }),
  ).toBeVisible();
  await expect(page.getByText("Pinned", { exact: true })).toBeVisible();
  const summary = page.locator("article p").first();
  await expect(summary).toBeVisible();
  expect(await summary.textContent()).toBe(browserPost.body);
  await expect(page.locator("article script")).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain("sample-board");
  expect(await page.locator("body").innerText()).not.toContain(
    "Unpublished replacement",
  );

  api.setPublishedItems([]);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "No published posts" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Published safety update" }),
  ).toHaveCount(0);
});

test("published card author byline uses only an authorized choice label or a generic fallback", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  await page.goto(`/boards?board=${boardId}&section=posts`);

  await expect(page.getByText("Avery", { exact: true })).toBeVisible();
  await expect(page.getByText(authorId, { exact: true })).toHaveCount(0);

  api.setAuthorChoices([]);
  await page.reload();
  await expect(
    page.getByText("Author unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(authorId, { exact: true })).toHaveCount(0);
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

test("an edited post links to its edit history and each earlier version", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  api.setPublishedItems([
    { ...browserPost, publication_number: 2, edited: true },
  ]);
  await page.goto(`/boards?board=${boardId}&section=posts`);

  const edited = page.getByRole("button", {
    name: "Edit history of Published safety update",
  });
  await expect(edited).toBeVisible();
  await edited.click();
  const dialog = page.getByRole("dialog", { name: "Edit history" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Version 2 · current/ }),
  ).toHaveAttribute("aria-current", "true");
  await expect(dialog.getByText("Use the new entrance.")).toBeVisible();
  await dialog.getByRole("button", { name: /Version 1/ }).click();
  await expect(dialog.getByText("Use the old entrance.")).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Safety update draft" }),
  ).toBeVisible();
});

test("a post published once shows no edit history link", async ({ page }) => {
  await installPostBrowserApi(page);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await expect(
    page.getByRole("heading", { name: "Published safety update" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Edit history/ })).toHaveCount(
    0,
  );
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
