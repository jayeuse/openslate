import {
  authMeBody,
  defaultOrganization,
  expect,
  expectNoHorizontalScroll,
  expectNoPageScroll,
  settleReact,
  test,
  type Locator,
  type Page,
  isEventStream,
} from "./helpers/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import { applyAppearancePreferences } from "../../src/lib/appearance-preferences";
import { pageOf } from "../helpers/pagination";
import { wireBoard, wireWorkspace } from "../helpers/wire";

const boardId = "00000000-0000-4000-8000-000000000001";
const otherBoardId = "00000000-0000-4000-8000-000000000002";
const otherUserId = "00000000-0000-4000-8000-000000000007";
const postId = "00000000-0000-4000-8000-000000000003";
const authorId = "00000000-0000-4000-8000-000000000004";
const viewerId = otherUserId;
const publishedAt = "2026-09-23T00:00:00Z";

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

const browserBoard = wireBoard({
  id: boardId,
  name: "Operations board",
  description: "Current authorized workspace content",
  revision: 4,
  level: "write",
  created_at: publishedAt,
  updated_at: publishedAt,
});

function wirePage(items: unknown[]) {
  return { ...pageOf(items, { limit: 25 }), board_revision: 4 };
}

/** The Posts list panel, a row's open button, and the reading pane. */
function postList(page: Page) {
  return page.getByRole("region", { name: "Posts", exact: true });
}
/** The list behind an open dialog, which hides it from the role tree. */
function hiddenPostList(page: Page) {
  return page.getByRole("region", {
    name: "Posts",
    exact: true,
    includeHidden: true,
  });
}
function postRow(page: Page, title: string) {
  return postList(page).getByRole("button", {
    name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`),
  });
}
function postPane(page: Page, title: string) {
  return page.getByRole("article", { name: title, exact: true });
}
async function openFilters(page: Page) {
  await postList(page)
    .getByRole("button", { name: /^Filters/ })
    .click();
  return page.getByRole("dialog", { name: "Filters", exact: true });
}

function versionRow(history: Locator, number: number) {
  return history.getByRole("listitem").filter({
    has: history
      .page()
      .getByRole("button", { name: new RegExp(`Version ${number}`) }),
  });
}

async function expectPostAppearanceMatrix(
  page: Page,
  assertState: () => Promise<void>,
) {
  const previous = await page.evaluate(() => ({
    mode: document.documentElement.classList.contains("dark")
      ? ("dark" as const)
      : ("light" as const),
    reduceMotion: document.documentElement.dataset.motion === "reduced",
  }));
  try {
    for (const mode of ["light", "dark"] as const) {
      await page.evaluate(applyAppearancePreferences, {
        mode,
        reduceMotion: true,
      });
      const originalViewport = page.viewportSize();
      const originalScrollY = await page.evaluate(() => window.scrollY);
      try {
        await page.evaluate(() => window.scrollTo(0, 0));
        for (const viewport of [
          { width: 1440, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          await assertState();
        }
      } finally {
        if (originalViewport) await page.setViewportSize(originalViewport);
        await page.evaluate((y) => window.scrollTo(0, y), originalScrollY);
      }
    }
  } finally {
    await page.evaluate(applyAppearancePreferences, previous);
  }
}

async function expectPostMotionMatrix(page: Page, anchor?: Locator) {
  await page.evaluate(() => document.fonts.ready);
  await expectPostAppearanceMatrix(page, async () => {
    if (anchor) {
      await anchor.evaluate((element) =>
        element.scrollIntoView({ block: "center", behavior: "instant" }),
      );
      await expect(anchor).toBeInViewport();
    }
    await expect(page.locator("html")).toHaveAttribute(
      "data-motion",
      "reduced",
    );
  });
}

async function installPostBrowserApi(page: Page) {
  let authorChoices = [{ id: authorId, label: "Avery" }];
  let currentViewerId = viewerId;
  const authorRequests: string[] = [];
  let authorFailure = 0;
  let publishedItems: Record<string, unknown>[] = [browserPost];
  let detailPost: Record<string, unknown> = browserPost;
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
    isEventStream(route)
      ? route.fallback()
      : route.fulfill({
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
        organization_id: defaultOrganization.org_id,
        user_id: currentViewerId,
        default_organization_blocked: null,
        setup_required: false,
      }),
    }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authMeBody({
        id: currentViewerId,
        role: "member",
        access: [],
        default_organization_blocked: null,
      }),
    }),
  );
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        display_name: "OpenSlate",
        mark: "OS",
        logo_file_id: null,
        revision: 1,
        today: "2026-09-23",
        week_start: "monday",
        locale: "en-US",
        timezone: "UTC",
      }),
    }),
  );
  await page.route("**/api/views/data-sources**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(pageOf([], { limit: 25 })),
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
      return reply(
        200,
        pageOf(
          [
            browserBoard,
            {
              ...browserBoard,
              id: otherBoardId,
              name: "Second operations board",
            },
          ],
          { limit: 25 },
        ),
      );
    const secondPrefix = `/api/boards/${otherBoardId}`;
    if (path === secondPrefix)
      return reply(200, {
        ...browserBoard,
        id: otherBoardId,
        name: "Second operations board",
      });
    if (path === `${secondPrefix}/my-access`)
      return reply(200, {
        level: "write",
        read: true,
        write: true,
        manage: false,
      });
    if (path === `${secondPrefix}/posts`)
      return reply(
        200,
        wirePage([
          {
            ...browserPost,
            board_id: otherBoardId,
            title: "Second published update",
          },
        ]),
      );
    if (path === `${secondPrefix}/post-authors`) {
      const ids = url.searchParams.getAll("ids");
      const items =
        ids.length === 0 || ids.includes(authorId)
          ? [{ id: authorId, label: "Morgan second board" }]
          : [];
      return reply(
        200,
        pageOf(items, { limit: Number(url.searchParams.get("limit") ?? 25) }),
      );
    }
    if (path === `${prefix}/my-access`)
      return reply(200, {
        level: "write",
        read: true,
        write: true,
        manage: false,
      });
    if (path === `${prefix}/post-authors`) {
      authorRequests.push(url.search);
      if (authorFailure) return reply(authorFailure, { detail: "Unavailable" });
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const search = (url.searchParams.get("search") ?? "").toLocaleLowerCase();
      const ids = url.searchParams.getAll("ids");
      const filtered = authorChoices.filter(
        (choice) =>
          choice.label.toLocaleLowerCase().includes(search) &&
          (ids.length === 0 || ids.includes(choice.id)),
      );
      const items = filtered.slice(offset, offset + limit);
      return reply(
        200,
        pageOf(items, {
          limit,
          offset,
          total: filtered.length,
          hasMore: offset + items.length < filtered.length,
        }),
      );
    }
    if (path === `${prefix}/posts`) {
      const view = url.searchParams.get("view");
      const author = url.searchParams.get("author_id");
      const items =
        view === "published"
          ? publishedItems.filter(
              (post) => !author || post.author_id === author,
            )
          : [];
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const visible = items.slice(offset, offset + limit);
      return reply(200, {
        ...wirePage(visible),
        pagination: {
          limit,
          offset,
          count: visible.length,
          total: items.length,
          has_more: offset + visible.length < items.length,
        },
      });
    }
    if (
      path === `${prefix}/posts/${postId}` &&
      url.searchParams.get("view") === "published"
    )
      return reply(200, detailPost);
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
    if (path.endsWith("/attachments") || path.endsWith("/record-links"))
      return reply(200, {
        items: [],
        limit: Number(url.searchParams.get("limit") ?? 25),
        offset: Number(url.searchParams.get("offset") ?? 0),
        has_more: false,
      });
    if (path === prefix) return reply(200, browserBoard);
    return reply(404, { detail: "Unmocked post test API route" });
  });

  return {
    authorRequests,
    setAuthorFailure(status: number) {
      authorFailure = status;
    },
    setAuthorChoices(choices: typeof authorChoices) {
      authorChoices = choices;
    },
    setPublishedItems(items: typeof publishedItems) {
      publishedItems = items;
    },
    setDetailPost(post: typeof detailPost) {
      detailPost = post;
    },
    setViewerId(id: string) {
      currentViewerId = id;
    },
  };
}

test("a ?post= link opens the post in the reading pane, survives reload, and keeps other parameters", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  api.setPublishedItems([]);
  const href = `/boards?board=${boardId}&section=posts&post=${postId}&event=${otherBoardId}&keep=chosen`;
  await page.goto(href);
  const reader = postPane(page, browserPost.title);
  await expect(reader).toBeVisible();
  await expect(
    reader.getByText(browserPost.body, { exact: true }),
  ).toBeVisible();
  await expect(reader.locator("script")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(reader).toBeVisible();
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("post") === postId &&
      url.searchParams.get("board") === boardId &&
      url.searchParams.get("section") === "posts" &&
      url.searchParams.get("event") === otherBoardId &&
      url.searchParams.get("keep") === "chosen",
  );
  await expect(
    postList(page).getByRole("heading", { name: "No published posts yet" }),
  ).toBeVisible();
});

test("a ?post= link to an invalid, missing, or denied post shows one unavailable state without private content", async ({
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
  const unavailable = page.getByRole("article", {
    name: "This post is not available.",
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
    await expect(unavailable).toContainText(
      "It may have been removed, or you may not have access.",
    );
    await expect(page.getByText("Private post title")).toHaveCount(0);
    await expect(page.getByText(browserPost.body)).toHaveCount(0);
    await expect(
      unavailable.getByRole("button", { name: "Retry" }),
    ).toHaveCount(0);
  }
});

test("a failed post read retries in the pane", async ({ page }) => {
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
  const unavailable = page.getByRole("article", {
    name: "This post is not available.",
  });
  await expect(unavailable).toBeVisible();
  available = true;
  await unavailable.getByRole("button", { name: "Retry" }).click();
  await expect(postPane(page, browserPost.title)).toBeVisible();
});

test("a late read of a post that is no longer open never replaces the open post", async ({
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
  await postRow(page, nextPost.title).click();
  const nextReader = postPane(page, nextPost.title);
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
  await expect(postPane(page, browserPost.title)).toHaveCount(0);
});

test("list rows are two lines that open the post, pinned first, with no cards or zone", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  api.setPublishedItems([
    browserPost,
    {
      ...browserPost,
      id: otherBoardId,
      title: "Older yard notice",
      pinned: false,
      published_at: "2026-09-20T00:00:00Z",
    },
  ]);
  await page.route(
    `**/api/boards/${boardId}/posts/${otherBoardId}?view=published`,
    (route) =>
      route.fulfill({
        json: { ...browserPost, id: otherBoardId, title: "Older yard notice" },
      }),
  );
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const list = postList(page);
  const rows = list.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Published safety update");
  await expect(rows.nth(0)).toContainText("Pinned");
  await expect(rows.nth(0)).toContainText("Avery");
  await expect(rows.nth(0)).toContainText("Sep 23");
  await expect(list).not.toContainText("UTC");
  await expect(list.getByRole("button", { name: "Open post" })).toHaveCount(0);
  await expect(list.getByRole("article")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "More filters" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Search" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage posts" })).toHaveCount(
    0,
  );
  await expect(list.getByText("Rows per page")).toHaveCount(0);
  await expect(
    list.getByRole("navigation", { name: "Post pages" }),
  ).toContainText("1–2 of 2");

  // From 1024px the bare view opens its first post with a URL replace.
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("post") === postId,
  );
  // The open row's button carries aria-current.
  await expect(rows.nth(0).getByRole("button")).toHaveAttribute(
    "aria-current",
    "true",
  );
  const reader = postPane(page, browserPost.title);
  await expect(
    reader.getByText(browserPost.body, { exact: true }),
  ).toBeVisible();
  await expect(reader.locator("script")).toHaveCount(0);

  await postRow(page, "Older yard notice").click();
  await expect(postPane(page, "Older yard notice")).toBeVisible();
  await expect(rows.nth(1).getByRole("button")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(rows.nth(0).getByRole("button")).not.toHaveAttribute(
    "aria-current",
    "true",
  );

  api.setPublishedItems([]);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await expect(
    list.getByRole("heading", { name: "No published posts yet" }),
  ).toBeVisible();
  await expect(rows).toHaveCount(0);
});

test("a row's author uses only an authorized label or a generic fallback", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await expect(
    postList(page).getByText("Avery", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(authorId, { exact: true })).toHaveCount(0);

  api.setAuthorChoices([]);
  await page.reload();
  await expect(
    postList(page).getByText("Author unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(authorId, { exact: true })).toHaveCount(0);
});

test("an edited post opens its edit history and each earlier version", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  const edited = { ...browserPost, publication_number: 2, edited: true };
  api.setPublishedItems([edited]);
  api.setDetailPost(edited);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const reader = postPane(page, browserPost.title);
  await reader.getByRole("button", { name: "Edited", exact: true }).click();
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

test.describe("Boards workspace regional post dates", () => {
  test.use({ locale: "en-US", timezoneId: "UTC" });
  test("rows, the reading pane and edit history use the workspace date and timezone", async ({
    page,
  }) => {
    const api = await installPostBrowserApi(page);
    const edited = { ...browserPost, publication_number: 2, edited: true };
    api.setPublishedItems([edited]);
    api.setDetailPost(edited);
    await page.route("**/api/workspace", (route) =>
      route.fulfill({
        json: {
          display_name: "OpenSlate",
          mark: "OS",
          logo_file_id: null,
          revision: 1,
          today: "2026-09-23",
          week_start: "monday",
          locale: "fr-FR",
          timezone: "America/Los_Angeles",
        },
      }),
    );
    await page.goto(`/boards?board=${boardId}&section=posts`);
    await expect(postList(page).getByRole("listitem")).toContainText(
      "22 sept.",
    );
    const reader = postPane(page, "Published safety update");
    await expect(reader.locator("time").first()).toHaveText(
      /22 sept\. 2026.*17:00/,
    );
    await reader.getByRole("button", { name: "Edited", exact: true }).click();
    const history = page.getByRole("dialog", {
      name: "Edit history",
      exact: true,
    });
    await expect(
      history.getByRole("button", { name: /Version 2/ }),
    ).toContainText(/22 sept\. 2026.*17:00/);
  });
});

test("a post published once shows no edit history", async ({ page }) => {
  await installPostBrowserApi(page);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const reader = postPane(page, "Published safety update");
  await expect(reader).toBeVisible();
  await expect(reader.getByRole("button", { name: "Edited" })).toHaveCount(0);
  await reader.getByRole("button", { name: "More post actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Edit history" }),
  ).toHaveCount(0);
});

test("the Author filter searches beyond the first page, shows a chip, and resets on reload", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  const laterId = "00000000-0000-4000-8000-000000000099";
  api.setAuthorChoices([
    { id: authorId, label: "Avery" },
    ...Array.from({ length: 25 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      label: `First author ${index}`,
    })),
    { id: laterId, label: "Zora later-page author" },
  ]);
  api.setPublishedItems([
    browserPost,
    ...Array.from({ length: 25 }, (_, index) => ({
      ...browserPost,
      id: `00000000-0000-4000-8000-${String(index + 200).padStart(12, "0")}`,
      author_id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      title: `First author ${index} update`,
    })),
    {
      ...browserPost,
      id: laterId,
      author_id: laterId,
      title: "Zora safety update",
    },
  ]);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await expect(
    postList(page).getByText("Avery", { exact: true }),
  ).toBeVisible();
  expect(api.authorRequests.length).toBeGreaterThan(0);
  expect(
    api.authorRequests.every(
      (query) => new URLSearchParams(query).get("offset") === "0",
    ),
  ).toBe(true);
  const filters = await openFilters(page);
  await filters.getByRole("combobox", { name: "Author", exact: true }).click();
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await page.getByRole("option", { name: "Zora later-page author" }).click();
  const selectedAuthorControl = filters
    .getByRole("combobox", { name: "Author", exact: true })
    .filter({ hasText: "Zora later-page author" });
  await expect(selectedAuthorControl).toContainText("Zora later-page author");
  await selectedAuthorControl.click();
  await page
    .getByRole("combobox", { name: "Search author", exact: true })
    .fill("First author 0");
  await expect
    .poll(() =>
      api.authorRequests.some(
        (query) =>
          new URLSearchParams(query).get("search") === "First author 0",
      ),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(selectedAuthorControl).toContainText("Zora later-page author");
  await page.keyboard.press("Escape");
  const chips = page.getByRole("group", { name: "Active filters" });
  await expect(chips).toContainText("Author: Zora later-page author");
  await expect(
    postList(page).getByRole("button", { name: "Filters, 1 active" }),
  ).toBeVisible();
  await expect(postRow(page, "Zora safety update")).toBeVisible();
  await expect(postList(page).getByRole("listitem")).toHaveCount(1);
  await chips.getByRole("button", { name: "Remove Author filter" }).click();
  await expect(chips).toHaveCount(0);
  await expect(postList(page).getByRole("listitem")).toHaveCount(25);
  await page.reload();
  const again = await openFilters(page);
  await expect(
    again.getByRole("combobox", { name: "Author", exact: true }),
  ).toContainText("All authors");
});

test("off-page authors keep their labels through the picker, the pane and history", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  const label = "Zora published author";
  api.setAuthorChoices([
    ...Array.from({ length: 26 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      label: `First author ${index}`,
    })),
    { id: authorId, label },
  ]);
  const editedPost = { ...browserPost, publication_number: 2, edited: true };
  api.setPublishedItems([
    editedPost,
    ...Array.from({ length: 26 }, (_, index) => ({
      ...browserPost,
      id: `00000000-0000-4000-8000-${String(index + 200).padStart(12, "0")}`,
      author_id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      title: `First author ${index} update`,
    })),
  ]);
  api.setDetailPost(editedPost);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const list = postList(page);
  await expect(list.getByText(label, { exact: true })).toBeVisible();

  const lookupQueries = () =>
    api.authorRequests
      .map((query) => new URLSearchParams(query))
      .filter((query) => query.has("ids"));
  expect(lookupQueries().length).toBeGreaterThan(0);
  for (const query of lookupQueries()) {
    expect(query.getAll("ids")).toContain(authorId);
    expect(Number(query.get("limit"))).toBeLessThanOrEqual(100);
    expect(query.get("offset")).toBe("0");
    expect(query.has("search")).toBe(false);
  }

  const filters = await openFilters(page);
  await filters.getByRole("combobox", { name: "Author", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search author", exact: true })
    .fill("First author 0");
  await expect(
    page.getByRole("option", { name: "First author 0", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(list.getByText(label, { exact: true })).toBeVisible();
  const reader = postPane(page, browserPost.title);
  await expect(reader.getByText(label, { exact: true })).toBeVisible();
  await expectPostAppearanceMatrix(page, async () => {
    if ((page.viewportSize()?.width ?? 0) >= 1024)
      await expect(reader.getByText(label, { exact: true })).toBeVisible();
  });
  await reader.getByRole("button", { name: "Edited", exact: true }).click();
  const history = page.getByRole("dialog", {
    name: "Edit history",
    exact: true,
  });
  await expect(versionRow(history, 2)).toContainText(label);
  await expect(versionRow(history, 1)).toContainText(label);
});

test("an open edit history keeps its author after a held list refresh replaces the rows", async ({
  page,
}) => {
  await installOpenViewEventSource(page);
  const api = await installPostBrowserApi(page);
  const replacementAuthorId = "00000000-0000-4000-8000-000000000008";
  const editedPost = { ...browserPost, publication_number: 2, edited: true };
  const otherPosts = Array.from({ length: 25 }, (_, index) => ({
    ...browserPost,
    id: `00000000-0000-4000-8000-${String(index + 300).padStart(12, "0")}`,
    author_id: replacementAuthorId,
    title: `Replacement author update ${index + 1}`,
    pinned: false,
  }));
  api.setAuthorChoices([
    { id: authorId, label: "Avery" },
    { id: replacementAuthorId, label: "Bailey" },
  ]);
  api.setPublishedItems([editedPost]);
  api.setDetailPost(editedPost);
  let holdFeed = false;
  let releaseFeed: () => void = () => {};
  const heldFeed = new Promise<void>((resolve) => {
    releaseFeed = resolve;
  });
  let feedStarted: () => void = () => {};
  const feedEntered = new Promise<void>((resolve) => {
    feedStarted = resolve;
  });
  let feedReads = 0;
  await page.route(
    (url) =>
      url.pathname === `/api/boards/${boardId}/posts` &&
      url.searchParams.get("view") === "published",
    async (route) => {
      feedReads += 1;
      if (!holdFeed) return route.fallback();
      feedStarted();
      await heldFeed;
      await route.fallback();
    },
  );
  try {
    await page.goto(`/boards?board=${boardId}&section=posts`);
    const reader = postPane(page, browserPost.title);
    await expect(reader.getByText("Avery", { exact: true })).toBeVisible();
    const readsBeforeRefresh = feedReads;
    holdFeed = true;
    await sendOpenViewEvent(page, "invalidate", {
      entity: "board_posts",
      board_id: boardId,
    });
    await feedEntered;
    await reader.getByRole("button", { name: "Edited", exact: true }).click();
    const history = page.getByRole("dialog", {
      name: "Edit history",
      exact: true,
    });
    await expect(versionRow(history, 2)).toContainText("Avery");
    api.setPublishedItems([...otherPosts, editedPost]);
    const replaced = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === `/api/boards/${boardId}/posts` &&
        url.searchParams.get("view") === "published"
      );
    });
    releaseFeed();
    expect((await replaced).status()).toBe(200);
    await expect(
      hiddenPostList(page).getByText("Replacement author update 1", {
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(history).toBeVisible();
    await expect(versionRow(history, 2)).toContainText("Avery");
    await expect(versionRow(history, 1)).toContainText("Avery");
    await expect(history).not.toContainText("Author unavailable");
    expect(feedReads - readsBeforeRefresh).toBe(1);
  } finally {
    releaseFeed();
  }
});

test("an author refusal clears names and an older label response cannot restore them", async ({
  page,
}) => {
  await installPostBrowserApi(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const labelStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let settled: () => void = () => {};
  const labelSettled = new Promise<void>((resolve) => {
    settled = resolve;
  });
  await page.route(`**/api/boards/${boardId}/post-authors**`, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.has("ids")) {
      started();
      await held;
      try {
        await route.fulfill({
          json: pageOf([{ id: authorId, label: "Private author" }], {
            limit: Number(query.get("limit")),
          }),
        });
      } finally {
        settled();
      }
      return;
    }
    if (query.has("search"))
      return route.fulfill({
        status: 403,
        json: { detail: "Private denial detail" },
      });
    return route.fallback();
  });
  try {
    await page.goto(`/boards?board=${boardId}&section=posts`);
    await labelStarted;
    const filters = await openFilters(page);
    await filters
      .getByRole("combobox", { name: "Author", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Search author", exact: true })
      .fill("Private author");
    await expect(
      page
        .getByText("Author choices unavailable. Check your access or retry.")
        .first(),
    ).toBeVisible();
    release();
    await labelSettled;
    await expect(page.getByText("Private author", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByText("Avery", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText("Private denial detail", { exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
  }
});

test("switching Boards ignores the previous Board's late author label read", async ({
  page,
}) => {
  await installPostBrowserApi(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const labelStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let settled: () => void = () => {};
  const labelSettled = new Promise<void>((resolve) => {
    settled = resolve;
  });
  await page.route(`**/api/boards/${boardId}/post-authors**`, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (!query.has("ids")) return route.fallback();
    started();
    await held;
    try {
      await route.fulfill({
        json: pageOf([{ id: authorId, label: "Old Board private author" }], {
          limit: Number(query.get("limit")),
        }),
      });
    } finally {
      settled();
    }
  });
  try {
    await page.goto(`/boards?board=${boardId}&section=posts`);
    await labelStarted;
    await page
      .getByRole("navigation", { name: "Main navigation", exact: true })
      .getByRole("link", { name: "Second operations board", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Second operations board announcements",
        level: 1,
      }),
    ).toBeVisible();
    const list = postList(page);
    await expect(postRow(page, "Second published update")).toBeVisible();
    await expect(
      list.getByText("Morgan second board", { exact: true }),
    ).toBeVisible();
    release();
    await labelSettled;
    await expect(
      page.getByText("Old Board private author", { exact: true }),
    ).toHaveCount(0);
    await expect(
      list.getByText("Morgan second board", { exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
});

test("switching verified accounts hides previous author names while new labels load", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  let hold = false;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const labelStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(`**/api/boards/${boardId}/post-authors**`, async (route) => {
    if (hold && new URL(route.request().url()).searchParams.has("ids")) {
      started();
      await held;
    }
    await route.fallback();
  });
  try {
    await page.goto(`/boards?board=${boardId}&section=posts`);
    const list = postList(page);
    await expect(list.getByText("Avery", { exact: true })).toBeVisible();
    hold = true;
    api.setViewerId("00000000-0000-4000-8000-000000000008");
    api.setAuthorChoices([{ id: authorId, label: "Morgan new account" }]);
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    await labelStarted;
    await expect(page.getByText("Avery", { exact: true })).toHaveCount(0);
    release();
    await expect(
      list.getByText("Morgan new account", { exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
});

for (const status of [403, 404]) {
  test(`known-author label refusal ${status} hides stored names until an authorized retry`, async ({
    page,
  }) => {
    await installOpenViewEventSource(page);
    await installPostBrowserApi(page);
    let refused = false;
    let recoveryArmed = false;
    let activeReads = 0;
    let deniedEnded: () => void = () => {};
    const deniedComplete = new Promise<void>((resolve) => {
      deniedEnded = resolve;
    });
    let recoveryStarted: () => void = () => {};
    const recoveryObserved = new Promise<void>((resolve) => {
      recoveryStarted = resolve;
    });
    let recoveryEnded: () => void = () => {};
    const recoveryComplete = new Promise<void>((resolve) => {
      recoveryEnded = resolve;
    });
    let releaseRecovery: () => void = () => {};
    const heldRecovery = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    await page.route(
      `**/api/boards/${boardId}/post-authors**`,
      async (route) => {
        const query = new URL(route.request().url()).searchParams;
        if (!query.has("ids")) return route.fallback();
        const phase = recoveryArmed
          ? "recovery"
          : refused
            ? "denied"
            : "authorized";
        activeReads += 1;
        try {
          if (phase === "recovery") {
            recoveryStarted();
            await heldRecovery;
            await route.fallback();
          } else if (phase === "denied") {
            await route.fulfill({
              status,
              json: { detail: "Private refusal detail" },
            });
          } else {
            await route.fallback();
          }
        } finally {
          activeReads -= 1;
          if (phase === "denied") deniedEnded();
          if (phase === "recovery") recoveryEnded();
        }
      },
    );
    try {
      await page.goto(`/boards?board=${boardId}&section=posts`);
      const list = postList(page);
      const rows = list.getByRole("list");
      await expect(rows.getByText("Avery", { exact: true })).toBeVisible();
      const filters = await openFilters(page);
      const picker = filters.getByRole("combobox", {
        name: "Author",
        exact: true,
      });
      await picker.click();
      const selectedFeed = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `/api/boards/${boardId}/posts` &&
          url.searchParams.get("author_id") === authorId
        );
      });
      await page.getByRole("option", { name: "Avery", exact: true }).click();
      await selectedFeed;
      await expect(rows.getByText("Avery", { exact: true })).toBeVisible();
      await expect(picker).toContainText("Avery");
      await page.keyboard.press("Escape");
      await expect.poll(() => activeReads).toBe(0);
      refused = true;
      await sendOpenViewEvent(page, "invalidate", {
        entity: "board_posts",
        board_id: boardId,
      });
      await deniedComplete;
      await expect(
        list.getByText(
          "Author labels unavailable. Check your access or retry.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.getByText("Avery", { exact: true })).toHaveCount(0);
      await expect(
        page.getByText("Private refusal detail", { exact: true }),
      ).toHaveCount(0);
      const reopened = await openFilters(page);
      await expect(
        reopened.getByRole("combobox", { name: "Author", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect.poll(() => activeReads).toBe(0);
      recoveryArmed = true;
      await Promise.all([
        recoveryObserved,
        list.getByRole("button", { name: "Retry", exact: true }).click(),
      ]);
      await expect(page.getByText("Avery", { exact: true })).toHaveCount(0);
      releaseRecovery();
      await recoveryComplete;
      await expect(rows.getByText("Avery", { exact: true })).toBeVisible();
    } finally {
      releaseRecovery();
    }
  });
}

test("a transient label refresh retains the current byline and retries its bounded lookup", async ({
  page,
}) => {
  await installOpenViewEventSource(page);
  const api = await installPostBrowserApi(page);
  let failed = false;
  await page.route(`**/api/boards/${boardId}/post-authors**`, (route) =>
    failed && new URL(route.request().url()).searchParams.has("ids")
      ? route.fulfill({
          status: 503,
          json: { detail: "Internal failure detail" },
        })
      : route.fallback(),
  );
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const list = postList(page);
  await expect(list.getByText("Avery", { exact: true })).toBeVisible();
  failed = true;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "board_posts",
    board_id: boardId,
  });
  await expect(
    list.getByText(
      "Could not refresh author labels. Showing the last loaded labels.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(list.getByText("Avery", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Internal failure detail", { exact: true }),
  ).toHaveCount(0);
  failed = false;
  api.setAuthorChoices([{ id: authorId, label: "Avery renamed" }]);
  await list.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(list.getByText("Avery renamed", { exact: true })).toBeVisible();
  await expect(page.getByText("Avery", { exact: true })).toHaveCount(0);
});

// S05 uses the existing rendered Board and a stateful client boundary. The
// editable parent can be scheduled while the independently displayed version
// remains published; revisions always come from the current server read.
async function installS05PostApi(page: Page, manage = true, timezone = "UTC") {
  await installOpenViewEventSource(page);
  const reader = await installPostBrowserApi(page);
  reader.setViewerId(authorId);
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: wireWorkspace({
        id: "00000000-0000-4000-8000-000000000102",
        locale: "en-US",
        timezone,
        currency: "PHP",
        today: "2035-06-01",
        purge_enabled: false,
      }),
    }),
  );
  let boardRevision = 4;
  let working: Record<string, unknown> | null = null;
  let published: Record<string, unknown>[] = [];
  let failure = 0;
  let manageStatus = "scheduled";
  let publishedBefore = true;
  const writes: {
    method: string;
    path: string;
    body: Record<string, unknown>;
  }[] = [];
  const prefix = `/api/boards/${boardId}`;
  await page.route(`**/api/users/${authorId}/preferences`, (route) =>
    route.fulfill({
      json: {
        user_id: authorId,
        theme: "light",
        appearance: { motion: "reduce", keyboard_shortcuts: true },
      },
    }),
  );
  await page.route("**/api/boards**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const reply = (json: unknown, status = 200) =>
      route.fulfill({ status, json });
    const board = {
      ...browserBoard,
      revision: boardRevision,
      level: manage ? "manage" : "write",
    };
    if (path === "/api/boards") return reply(pageOf([board], { limit: 25 }));
    if (path === prefix) return reply(board);
    if (path === `${prefix}/my-access`)
      return reply({ level: board.level, read: true, write: true, manage });
    if (path === `${prefix}/posts` && request.method() === "GET") {
      const view = url.searchParams.get("view");
      const status = working?.status;
      const items =
        view === "published"
          ? published
          : working &&
              (view === "editable" ||
                (view === "archive"
                  ? status === "archived"
                  : status === "draft" || status === "scheduled"))
            ? [working]
            : [];
      return reply({ ...wirePage(items), board_revision: boardRevision });
    }
    if (path === `${prefix}/posts/${postId}/manage-state`)
      return reply({
        id: postId,
        status: manageStatus,
        post_revision: 9,
        board_revision: boardRevision,
        published_before: publishedBefore,
      });
    if (path === `${prefix}/posts/${postId}` && request.method() === "GET")
      return reply(
        url.searchParams.get("view") === "published" ? published[0] : working,
      );
    if (path.endsWith("/attachments") || path.endsWith("/record-links"))
      return reply({
        items: [],
        limit: Number(url.searchParams.get("limit") ?? 25),
        offset: Number(url.searchParams.get("offset") ?? 0),
        has_more: false,
      });
    if (
      ["POST", "PATCH"].includes(request.method()) &&
      path.startsWith(`${prefix}/posts`)
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ method: request.method(), path, body });
      if (failure)
        return reply(
          {
            detail: {
              code: failure === 409 ? "stale_post_revision" : "post_expired",
              message: "Unavailable",
            },
          },
          failure,
        );
      boardRevision += 1;
      if (path.endsWith("/publish")) {
        const key = (body as { publication_key: string }).publication_key;
        published = [
          {
            ...browserPost,
            ...working,
            status: "published",
            post_revision: null,
            publication_number: 1,
            published_at: "2035-06-01T00:00:00Z",
            publish_at: "2035-06-01T00:00:00Z",
            board_revision: boardRevision,
          },
        ];
        working = null;
        return reply({
          id: "00000000-0000-4000-8000-000000000071",
          post_id: postId,
          publication_number: 1,
          publication_key: key,
          published_at: "2035-06-01T00:00:00Z",
        });
      }
      if (path.endsWith("/archive") || path.endsWith("/restore")) {
        const archiving = path.endsWith("/archive");
        manageStatus = archiving ? "archived" : "published";
        working = archiving
          ? {
              ...browserPost,
              status: "archived",
              publication_number: null,
              published_at: null,
              post_revision: 9,
              board_revision: boardRevision,
            }
          : null;
        if (archiving) published = [];
        else published = [{ ...browserPost, board_revision: boardRevision }];
        return reply({
          id: postId,
          post_revision: 10,
          board_revision: boardRevision,
        });
      }
      if (path.endsWith("/unpublish")) {
        published = [];
        working = {
          ...browserPost,
          author_id: authorId,
          status: "draft",
          publication_number: null,
          published_at: null,
          publish_at: null,
          post_revision: 10,
          board_revision: boardRevision,
        };
      } else {
        working = {
          ...browserPost,
          author_id: authorId,
          status: "draft",
          publication_number: null,
          published_at: null,
          publish_at: null,
          pinned: false,
          ...working,
          ...body,
          ...(path.endsWith("/schedule") ? { status: "scheduled" } : {}),
          id: postId,
          board_id: boardId,
          post_revision: Number(working?.post_revision ?? 0) + 1,
          board_revision: boardRevision,
          updated_at: "2035-06-01T00:00:00Z",
        };
        delete working.boardRevision;
      }
      return reply(
        {
          id: postId,
          post_revision: working?.post_revision,
          board_revision: boardRevision,
        },
        request.method() === "POST" && path === `${prefix}/posts` ? 201 : 200,
      );
    }
    return route.fallback();
  });
  return {
    writes,
    setFailure(status: number) {
      failure = status;
    },
    setWorking(post: Record<string, unknown>) {
      working = post;
      boardRevision = Number(post.board_revision ?? boardRevision);
    },
    setPublished(post: Record<string, unknown>) {
      published = [post];
    },
    setManageStatus(status: "draft" | "scheduled" | "published" | "archived") {
      manageStatus = status;
    },
    setPublishedBefore(value: boolean) {
      publishedBefore = value;
    },
  };
}

test("matching post burst refreshes the bounded list without wrong-scope reads or reload", async ({
  page,
}) => {
  await page.clock.install();
  const api = await installS05PostApi(page);
  api.setPublished(browserPost);
  const reads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === `/api/boards/${boardId}/posts` &&
      url.searchParams.get("view") === "published"
    )
      reads.push(url.search);
  });
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await expect(postRow(page, browserPost.title)).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.s11Document = "retained";
  });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const before = reads.length;
  for (const data of [
    { entity: "board_posts", board_id: otherBoardId },
    { entity: "board_posts", board_id: "invalid" },
    { entity: "board_posts" },
    { entity: "board_posts", board_id: boardId, module_id: otherBoardId },
    { entity: "boards", board_id: otherBoardId },
  ] as Record<string, string>[])
    await sendOpenViewEvent(page, "invalidate", data);
  await page.clock.runFor(301);
  expect(reads).toHaveLength(before);
  api.setPublished({
    ...browserPost,
    title: "Remote safety notice",
    publication_number: 2,
  });
  for (let index = 0; index < 3; index += 1)
    await sendOpenViewEvent(page, "invalidate", {
      entity: "board_posts",
      board_id: boardId,
    });
  await page.clock.runFor(299);
  expect(reads).toHaveLength(before);
  await page.clock.runFor(2);
  await expect
    .poll(async () => {
      await page.clock.runFor(1);
      return postRow(page, "Remote safety notice").count();
    })
    .toBe(1);
  expect(reads).toHaveLength(before + 1);
  expect(new URLSearchParams(reads.at(-1)).get("limit")).toBe("25");
  expect(new URLSearchParams(reads.at(-1)).get("offset")).toBe("0");
  await expect(page.locator("html")).toHaveAttribute(
    "data-s11-document",
    "retained",
  );
  expect(api.writes).toHaveLength(0);
});

/** Opens a draft from the Drafts list in the post editor. */
async function editDraft(page: Page, title: string) {
  await page.goto(`/boards?board=${boardId}&section=posts&show=drafts`);
  await postRow(page, title).click();
  await postPane(page, title)
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Edit post", exact: true });
}

/** Opens the editor's Advanced block (Pin to top, Expires on) if closed. */
async function openAdvanced(editor: Locator) {
  const trigger = editor.getByRole("button", { name: /^Advanced/ });
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
}

const s05Draft = {
  ...browserPost,
  author_id: authorId,
  title: "Pinned working draft",
  body: "Original working text",
  status: "draft",
  publish_at: null,
  published_at: null,
  publication_number: null,
  post_revision: 2,
  pinned: true,
  expires_at: "2035-06-02T04:30:00Z",
};

for (const dirty of [false, true]) {
  test(`newer selected post ${dirty ? "retains the complete dirty draft with a review notice" : "updates a clean draft"}`, async ({
    page,
  }) => {
    const api = await installS05PostApi(page);
    api.setWorking({
      ...s05Draft,
      links: [{ label: "Original guide", url: "https://example.org/original" }],
    });
    await page.clock.setFixedTime(new Date("2035-06-01T00:00:00Z"));
    const editor = await editDraft(page, s05Draft.title);
    await expect(editor.getByLabel("Title", { exact: true })).toHaveValue(
      s05Draft.title,
    );
    await openAdvanced(editor);
    if (dirty) {
      await editor
        .getByLabel("Title", { exact: true })
        .fill("My local safety draft");
      await editor
        .getByLabel("Message", { exact: true })
        .fill("Retain this local message");
      await editor
        .getByLabel("Link 1 label", { exact: true })
        .fill("My local guide");
      await editor
        .getByLabel("Expires on", { exact: true })
        .fill("2035-06-03T10:30");
    }
    api.setWorking({
      ...s05Draft,
      title: "Remote working draft",
      body: "Remote message",
      pinned: false,
      expires_at: null,
      post_revision: 3,
      board_revision: 5,
      links: [{ label: "Remote guide", url: "https://example.org/remote" }],
    });
    await sendOpenViewEvent(page, "invalidate", {
      entity: "board_posts",
      board_id: boardId,
    });
    if (dirty) {
      const notice = editor.getByText("Someone changed this post first.", {
        exact: true,
      });
      await expect(notice).toBeVisible();
      await expect(editor.getByLabel("Title", { exact: true })).toHaveValue(
        "My local safety draft",
      );
      await expect(editor.getByLabel("Message", { exact: true })).toHaveValue(
        "Retain this local message",
      );
      await expect(
        editor.getByLabel("Link 1 label", { exact: true }),
      ).toHaveValue("My local guide");
      await expect(
        editor.getByRole("checkbox", { name: "Pin to top" }),
      ).toBeChecked();
      await expect(
        editor.getByLabel("Expires on", { exact: true }),
      ).toHaveValue("2035-06-03T10:30");
      await expect(
        editor.getByRole("button", { name: "Save draft", exact: true }),
      ).toBeDisabled();
      await expectPostMotionMatrix(page, notice);
    } else {
      await expect(editor.getByLabel("Title", { exact: true })).toHaveValue(
        "Remote working draft",
      );
      await expect(editor.getByLabel("Message", { exact: true })).toHaveValue(
        "Remote message",
      );
      await expect(
        editor.getByRole("checkbox", { name: "Pin to top" }),
      ).not.toBeChecked();
      await expect(
        editor.getByText("Someone changed this post first.", { exact: true }),
      ).toHaveCount(0);
    }
    expect(api.writes).toHaveLength(0);
  });
}

test("post invalidation keeps a held Save in its editor while the list updates", async ({
  page,
}) => {
  const api = await installS05PostApi(page);
  api.setWorking(s05Draft);
  api.setPublished(browserPost);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/boards/${boardId}/posts/${postId}`,
    async (route) => {
      if (route.request().method() === "PATCH") await held;
      return route.fallback();
    },
  );
  await page.clock.setFixedTime(new Date("2035-06-01T00:00:00Z"));
  const editor = await editDraft(page, s05Draft.title);
  await editor
    .getByLabel("Message", { exact: true })
    .fill("Pending local save");
  try {
    await editor
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await expect(
      editor.getByRole("button", { name: "Saving…", exact: true }),
    ).toBeDisabled();
    api.setWorking({ ...s05Draft, title: "Live draft during Save" });
    await sendOpenViewEvent(page, "invalidate", {
      entity: "board_posts",
      board_id: boardId,
    });
    await expect(
      hiddenPostList(page).getByText("Live draft during Save", { exact: true }),
    ).toHaveCount(1);
    await expect(
      editor.getByRole("button", { name: "Saving…", exact: true }),
    ).toBeDisabled();
    await expect(editor.getByLabel("Message", { exact: true })).toHaveValue(
      "Pending local save",
    );
    release();
    await expect(
      editor.getByRole("status").getByText("Draft saved", { exact: true }),
    ).toBeVisible();
    expect(api.writes).toHaveLength(1);
  } finally {
    release();
  }
});

test("a list refresh keeps a held Unpublish and its confirmation", async ({
  page,
}) => {
  const api = await installS05PostApi(page);
  api.setPublished(browserPost);
  api.setManageStatus("published");
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const reader = postPane(page, browserPost.title);
  await reader.getByRole("button", { name: "More post actions" }).click();
  await page.getByRole("menuitem", { name: "Unpublish", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Unpublish post?",
    exact: true,
  });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/boards/${boardId}/posts/${postId}/unpublish`,
    async (route) => {
      await held;
      return route.fallback();
    },
  );
  try {
    await confirmation
      .getByRole("button", { name: "Unpublish post", exact: true })
      .click();
    api.setPublished({ ...browserPost, title: "Feed update during Unpublish" });
    await sendOpenViewEvent(page, "invalidate", {
      entity: "board_posts",
      board_id: boardId,
    });
    await expect(
      hiddenPostList(page).getByText("Feed update during Unpublish", {
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(
      confirmation.getByRole("button", { name: "Unpublish post", exact: true }),
    ).toBeDisabled();
    release();
    await expect(
      page.getByText("Post unpublished", { exact: true }),
    ).toBeVisible();
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0]?.body).toEqual({
      board_revision: 4,
      post_revision: 9,
    });
  } finally {
    release();
  }
});

for (const phase of ["timer", "read"] as const) {
  test(`Board switch cancels the old ${phase} without refreshing or restoring its list`, async ({
    page,
  }) => {
    await page.clock.install();
    const api = await installS05PostApi(page);
    api.setPublished(browserPost);
    const partner = {
      ...browserBoard,
      id: otherBoardId,
      name: "Partner Board",
      level: "manage",
    };
    const partnerPost = {
      ...browserPost,
      board_id: otherBoardId,
      id: "00000000-0000-4000-8000-000000000098",
      title: "Partner update",
    };
    await page.route(
      (url) => url.pathname === "/api/boards",
      (route) =>
        route.fulfill({
          json: pageOf([{ ...browserBoard, level: "manage" }, partner], {
            limit: 25,
          }),
        }),
    );
    await page.route(`**/api/boards/${otherBoardId}**`, (route) => {
      const url = new URL(route.request().url());
      const prefix = `/api/boards/${otherBoardId}`;
      if (url.pathname === prefix) return route.fulfill({ json: partner });
      if (url.pathname === `${prefix}/my-access`)
        return route.fulfill({
          json: { level: "manage", read: true, write: true, manage: true },
        });
      if (url.pathname === `${prefix}/post-authors`)
        return route.fulfill({
          json: pageOf([{ id: authorId, label: "Avery" }], {
            limit: Number(url.searchParams.get("limit") ?? 25),
            offset: Number(url.searchParams.get("offset") ?? 0),
          }),
        });
      if (url.pathname === `${prefix}/posts/${partnerPost.id}`)
        return route.fulfill({ json: partnerPost });
      if (
        url.pathname.endsWith("/attachments") ||
        url.pathname.endsWith("/record-links")
      )
        return route.fulfill({
          json: { items: [], limit: 25, offset: 0, has_more: false },
        });
      const items =
        url.pathname.endsWith("/posts") &&
        url.searchParams.get("view") === "published"
          ? [partnerPost]
          : [];
      return route.fulfill({ json: { ...wirePage(items), board_revision: 4 } });
    });
    let oldReads = 0;
    let partnerReads = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.pathname === `/api/boards/${boardId}/posts` &&
        url.searchParams.get("view") === "published"
      )
        oldReads += 1;
      if (
        url.pathname === `/api/boards/${otherBoardId}/posts` &&
        url.searchParams.get("view") === "published"
      )
        partnerReads += 1;
    });
    await page.goto(`/boards?board=${boardId}&section=posts`);
    await expect(postRow(page, browserPost.title)).toBeVisible();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (phase === "read")
      await page.route(
        (url) =>
          url.pathname === `/api/boards/${boardId}/posts` &&
          url.searchParams.get("view") === "published",
        async (route) => {
          await held;
          return route.fallback();
        },
      );
    api.setPublished({ ...browserPost, title: "Old Board private update" });
    const entered =
      phase === "read"
        ? page.waitForRequest(
            (request) =>
              new URL(request.url()).pathname ===
                `/api/boards/${boardId}/posts` &&
              new URL(request.url()).searchParams.get("view") === "published",
          )
        : null;
    await sendOpenViewEvent(page, "invalidate", {
      entity: "board_posts",
      board_id: boardId,
    });
    if (entered) {
      await page.clock.runFor(301);
      await entered;
    }
    const beforeSwitch = oldReads;
    try {
      const partnerReply = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `/api/boards/${otherBoardId}/posts` &&
          url.searchParams.get("view") === "published"
        );
      });
      await page
        .getByRole("navigation", { name: "Main navigation", exact: true })
        .getByRole("link", { name: /Partner Board/ })
        .click();
      await expect
        .poll(async () => {
          await page.clock.runFor(1);
          return page.getByRole("heading", { level: 1 }).textContent();
        })
        .toContain("Partner Board");
      await expect
        .poll(async () => {
          await page.clock.runFor(1);
          return postRow(page, "Partner update").count();
        })
        .toBe(1);
      await partnerReply;
      const partnerBefore = partnerReads;
      const completed =
        phase === "read"
          ? page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname ===
                  `/api/boards/${boardId}/posts` &&
                new URL(response.url()).searchParams.get("view") ===
                  "published",
            )
          : null;
      release();
      if (completed) await completed;
      await page.clock.runFor(301);
      await expect
        .poll(async () => {
          await page.clock.runFor(1);
          return postRow(page, "Partner update").count();
        })
        .toBe(1);
      expect(oldReads).toBe(beforeSwitch);
      expect(partnerReads).toBe(partnerBefore);
      await expect(
        page.getByText("Old Board private update", { exact: true }),
      ).toHaveCount(0);
      expect(api.writes).toHaveLength(0);
    } finally {
      release();
    }
  });
}

// A post's times are typed and shown in the workspace's zone (here Manila),
// as the list and the pane show them, never in the browser's.
test.describe("workspace-zone post times", () => {
  test.use({ timezoneId: "America/Los_Angeles" });
  test("manager creates, reloads, edits and clears pin and local expiry", async ({
    page,
  }) => {
    const api = await installS05PostApi(page, true, "Asia/Manila");
    await page.clock.setFixedTime(new Date("2035-06-01T00:00:00Z"));
    await page.goto(`/boards?board=${boardId}&section=posts`);
    await page
      .getByRole("button", { name: "New post", exact: true })
      .first()
      .click();
    const editor = page.getByRole("dialog", { name: "New post", exact: true });
    await editor
      .getByLabel("Title", { exact: true })
      .fill("Pinned working draft");
    await editor
      .getByLabel("Message", { exact: true })
      .fill("Original working text");
    await openAdvanced(editor);
    await editor.getByRole("checkbox", { name: "Pin to top" }).check();
    await editor
      .getByLabel("Expires on", { exact: true })
      .fill("2035-06-02T12:30");
    await editor
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await expect(
      editor.getByRole("status").getByText("Draft saved", { exact: true }),
    ).toBeVisible();
    expect(api.writes[0]?.body).toMatchObject({
      pinned: true,
      expires_at: "2035-06-02T04:30:00.000Z",
    });
    await editor
      .getByRole("button", { name: "Close post editor", exact: true })
      .click();
    await expect(editor).toHaveCount(0);
    const reopened = await editDraft(page, "Pinned working draft");
    await openAdvanced(reopened);
    await expect(
      reopened.getByRole("checkbox", { name: "Pin to top" }),
    ).toBeChecked();
    await expect(
      reopened.getByLabel("Expires on", { exact: true }),
    ).toHaveValue("2035-06-02T12:30");
    await expectPostMotionMatrix(
      page,
      reopened.getByLabel("Expires on", { exact: true }),
    );
    await reopened.getByRole("checkbox", { name: "Pin to top" }).uncheck();
    await reopened.getByLabel("Expires on", { exact: true }).fill("");
    await reopened
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await expect(
      reopened.getByRole("status").getByText("Draft saved", { exact: true }),
    ).toBeVisible();
    expect(api.writes[1]?.body).toMatchObject({
      pinned: false,
      expires_at: null,
    });
    await expect(
      reopened.getByLabel("Expires on", { exact: true }),
    ).toHaveValue("");
  });
  test("a writer keeps an existing pin while editing their own post", async ({
    page,
  }) => {
    const api = await installS05PostApi(page, false, "Asia/Manila");
    api.setWorking(s05Draft);
    const editor = await editDraft(page, s05Draft.title);
    await openAdvanced(editor);
    const pin = editor.getByRole("checkbox", { name: "Pin to top" });
    await expect(pin).toBeDisabled();
    await expect(pin).toBeChecked();
    await expect(editor).toContainText("Only board managers pin posts.");
    await editor.getByLabel("Message", { exact: true }).fill("Own edited text");
    await editor
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await expect(
      editor.getByRole("status").getByText("Draft saved", { exact: true }),
    ).toBeVisible();
    expect(api.writes[0]?.body).not.toHaveProperty("pinned");
    expect(api.writes[0]?.body).not.toHaveProperty("expires_at");
  });
  for (const failure of [409, 503]) {
    test(`pin and expiry survive save refusal ${failure}`, async ({ page }) => {
      const api = await installS05PostApi(page, true, "Asia/Manila");
      api.setWorking(s05Draft);
      api.setFailure(failure);
      const editor = await editDraft(page, s05Draft.title);
      await openAdvanced(editor);
      await editor.getByRole("checkbox", { name: "Pin to top" }).uncheck();
      await editor
        .getByLabel("Expires on", { exact: true })
        .fill("2035-06-03T12:30");
      await editor
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      await expect(editor.getByRole("alert").first()).toBeVisible();
      await expect(
        editor.getByLabel("Expires on", { exact: true }),
      ).toHaveValue("2035-06-03T12:30");
      await expect(
        editor.getByRole("checkbox", { name: "Pin to top" }),
      ).not.toBeChecked();
      await expect(
        editor.getByRole("status").getByText("Draft saved", { exact: true }),
      ).toHaveCount(0);
    });
  }
  test("schedule at expiry is refused and a refused publish keeps the draft open", async ({
    page,
  }) => {
    const api = await installS05PostApi(page, true, "Asia/Manila");
    api.setWorking(s05Draft);
    await page.clock.setFixedTime(new Date("2035-06-01T00:00:00Z"));
    const editor = await editDraft(page, s05Draft.title);
    await editor
      .getByRole("button", { name: "Schedule…", exact: true })
      .click();
    await editor.getByLabel("Publish at").fill("2035-06-02T12:30");
    await expect(editor).toContainText("Asia/Manila");
    await editor.getByRole("button", { name: "Schedule", exact: true }).click();
    await expect(
      editor.getByText("Choose a publication time before this post expires."),
    ).toBeVisible();
    expect(api.writes).toHaveLength(0);
    api.setFailure(422);
    await editor.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(editor.getByRole("alert").first()).toBeVisible();
    await openAdvanced(editor);
    await expect(editor.getByLabel("Expires on", { exact: true })).toHaveValue(
      "2035-06-02T12:30",
    );
    await expect(page.getByText("Post published", { exact: true })).toHaveCount(
      0,
    );
  });
  test("a scheduled time is read and shown in the workspace zone, once", async ({
    page,
  }) => {
    const api = await installS05PostApi(page, true, "Asia/Manila");
    api.setWorking({ ...s05Draft, expires_at: null });
    await page.clock.setFixedTime(new Date("2035-06-01T00:00:00Z"));
    const editor = await editDraft(page, s05Draft.title);
    await editor
      .getByRole("button", { name: "Schedule…", exact: true })
      .click();
    await editor.getByLabel("Publish at").fill("2035-06-02T09:00");
    await expect(editor.getByLabel("Publish at")).toHaveAccessibleDescription(
      "Asia/Manila",
    );
    await editor.getByRole("button", { name: "Schedule", exact: true }).click();
    await expect(
      editor.getByText("Publishes Sat, Jun 2, 9:00 AM", { exact: true }),
    ).toBeVisible();
    expect(api.writes.at(-1)).toMatchObject({
      path: `/api/boards/${boardId}/posts/${postId}/schedule`,
      body: { publish_at: "2035-06-02T01:00:00.000Z" },
    });
    // Reopened, the field shows the time as it was typed.
    await expect(editor.getByLabel("Publish at")).toHaveValue(
      "2035-06-02T09:00",
    );
  });
});

test.describe("unavailable workspace-local expiry", () => {
  // 02:30 on 2035-03-11 does not exist in New York, the workspace's zone;
  // the browser's zone (UTC) has it.
  test.use({ timezoneId: "UTC" });
  test("skipped local clock time has a linked error and sends no save", async ({
    page,
  }) => {
    const api = await installS05PostApi(page, true, "America/New_York");
    await page.goto(`/boards?board=${boardId}&section=posts`);
    await page
      .getByRole("button", { name: "New post", exact: true })
      .first()
      .click();
    const editor = page.getByRole("dialog", { name: "New post", exact: true });
    await editor
      .getByLabel("Title", { exact: true })
      .fill("Clock change draft");
    await editor
      .getByLabel("Message", { exact: true })
      .fill("Keep these unsaved fields.");
    await openAdvanced(editor);
    const expiry = editor.getByLabel("Expires on", { exact: true });
    await expiry.fill("2035-03-11T02:30");
    await editor
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await expect(expiry).toHaveAttribute("aria-invalid", "true");
    const errorId = await expiry.getAttribute("aria-describedby");
    expect(errorId).toContain("board-post-expiry-error");
    await expect(
      editor.getByText(
        "Choose a valid local expiry time. Clock changes can make some local times unavailable.",
      ),
    ).toBeVisible();
    expect(api.writes).toHaveLength(0);
  });
});

test("an expired publication shows Expired in its row and its pane", async ({
  page,
}) => {
  const api = await installS05PostApi(page);
  await page.clock.setFixedTime(new Date("2035-06-03T00:00:00Z"));
  api.setPublished({ ...browserPost, expires_at: "2035-06-02T04:30:00Z" });
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await expect(
    postList(page).getByText("Expired", { exact: true }),
  ).toBeVisible();
  await expectPostMotionMatrix(page);
  await expect(postPane(page, browserPost.title)).toContainText(
    /Expired .*Jun 2, 2035/,
  );
});

for (const replacement of ["draft", "scheduled"] as const) {
  test(`a manager unpublishes the displayed version with a ${replacement} replacement`, async ({
    page,
  }) => {
    const api = await installS05PostApi(page);
    api.setPublished(browserPost);
    api.setManageStatus(replacement);
    await page.goto(`/boards?board=${boardId}&section=posts`);
    await postPane(page, browserPost.title)
      .getByRole("button", { name: "More post actions" })
      .click();
    await page
      .getByRole("menuitem", { name: "Unpublish", exact: true })
      .click();
    const confirmation = page.getByRole("alertdialog", {
      name: "Unpublish post?",
      exact: true,
    });
    await expect(confirmation).toContainText("scheduled replacement");
    await expectPostMotionMatrix(page);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      `**/api/boards/${boardId}/posts/${postId}/unpublish`,
      async (route) => {
        await held;
        await route.fallback();
      },
    );
    const entered = page.waitForRequest(
      `**/api/boards/${boardId}/posts/${postId}/unpublish`,
    );
    await confirmation
      .getByRole("button", { name: "Unpublish post", exact: true })
      .click();
    await entered;
    await expect(
      confirmation.getByRole("button", { name: "Unpublish post", exact: true }),
    ).toBeDisabled();
    release();
    await expect(
      page.getByText("Post unpublished", { exact: true }),
    ).toBeVisible();
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0]?.body).toEqual({
      board_revision: 4,
      post_revision: 9,
    });
    await expect(postRow(page, browserPost.title)).toHaveCount(0);
  });
}
for (const failure of [409, 403, 503]) {
  test(`unpublish refusal ${failure} never claims success`, async ({
    page,
  }) => {
    const api = await installS05PostApi(page);
    api.setPublished(browserPost);
    api.setFailure(failure);
    await page.goto(`/boards?board=${boardId}&section=posts`);
    await postPane(page, browserPost.title)
      .getByRole("button", { name: "More post actions" })
      .click();
    await page
      .getByRole("menuitem", { name: "Unpublish", exact: true })
      .click();
    await page
      .getByRole("alertdialog", { name: "Unpublish post?", exact: true })
      .getByRole("button", { name: "Unpublish post", exact: true })
      .click();
    await expect(
      page
        .getByText(
          failure === 403
            ? "This post is not available."
            : failure === 409
              ? "This post changed elsewhere. Refresh posts before trying again."
              : "Post request failed. Try again.",
          { exact: true },
        )
        .first(),
    ).toBeVisible();
    await expect(
      page.getByText("Post unpublished", { exact: true }),
    ).toHaveCount(0);
    expect(api.writes).toHaveLength(1);
  });
}

test("the state filter follows the viewer's level and keeps its state in the address", async ({
  page,
}) => {
  const api = await installS05PostApi(page, false);
  api.setPublished(browserPost);
  api.setWorking({
    ...s05Draft,
    title: "Shift change next week",
    status: "scheduled",
    publish_at: "2035-06-05T01:00:00Z",
    pinned: false,
  });
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const states = postList(page).getByRole("group", { name: "Post state" });
  await expect(states.getByRole("button")).toHaveText([
    "Published",
    "Scheduled",
    "Drafts",
  ]);
  await states.getByRole("button", { name: "Scheduled" }).click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("show") === "scheduled",
  );
  await expect(postRow(page, "Shift change next week")).toContainText(
    "Publishes",
  );
  await expect(postRow(page, browserPost.title)).toHaveCount(0);
  await page.reload();
  await expect(
    states.getByRole("button", { name: "Scheduled" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(postPane(page, "Shift change next week")).toBeVisible();
  await states.getByRole("button", { name: "Drafts" }).click();
  await expect(
    postList(page).getByRole("heading", { name: "No drafts" }),
  ).toBeVisible();

  const manager = await page.context().newPage();
  const managerApi = await installS05PostApi(manager);
  managerApi.setPublished(browserPost);
  await manager.goto(`/boards?board=${boardId}&section=posts&show=archived`);
  await expect(
    postList(manager)
      .getByRole("group", { name: "Post state" })
      .getByRole("button"),
  ).toHaveText(["Published", "Scheduled", "Drafts", "Archived"]);
  await expect(
    postList(manager).getByRole("heading", { name: "No archived posts" }),
  ).toBeVisible();
});

test("a reader sees published posts only, a clean pane, and the board's reason when it is empty", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  await page.route(`**/api/boards/${boardId}`, (route) =>
    route.fulfill({ json: { ...browserBoard, level: "read" } }),
  );
  await page.route(`**/api/boards/${boardId}/my-access`, (route) =>
    route.fulfill({
      json: { level: "read", read: true, write: false, manage: false },
    }),
  );
  // A reader's menu offers no Delete draft, so it reads no manage state
  // (which the server refuses with 403).
  const manageReads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/manage-state"))
      manageReads.push(request.url());
  });
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const reader = postPane(page, browserPost.title);
  await expect(reader).toBeVisible();
  await expect(reader.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(
    postList(page).getByRole("group", { name: "Post state" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New post" })).toHaveCount(0);
  await expect(page.getByText(/Post editing is unavailable/)).toHaveCount(0);
  await expect(
    page.locator('[data-slot="badge"]', { hasText: /^Read$/ }),
  ).toBeVisible();
  await reader.getByRole("button", { name: "More post actions" }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Copy link"]);
  // Request events can arrive after the menu renders: two polls in a row
  // see no manage-state read.
  let previous = -1;
  await expect
    .poll(
      () => {
        const settled = manageReads.length === previous;
        previous = manageReads.length;
        return settled;
      },
      { intervals: [250] },
    )
    .toBe(true);
  expect(manageReads).toEqual([]);
  await page.keyboard.press("Escape");

  api.setPublishedItems([]);
  await page.reload();
  const list = postList(page);
  await expect(
    list.getByRole("heading", { name: "No published posts yet" }),
  ).toBeVisible();
  await expect(list).toContainText(
    "Posting needs write access through one of this board's groups.",
  );
  await expect(list.getByRole("button", { name: "New post" })).toHaveCount(0);
});

test("the pane shows Links and Files only when the post has them, at the reading measure", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  const linked = {
    ...browserPost,
    body: "Supplier costs went up. ".repeat(20),
    links: [{ label: "Supplier notice", url: "https://example.org/notice" }],
  };
  api.setPublishedItems([linked]);
  api.setDetailPost(linked);
  await page.route(
    `**/api/boards/${boardId}/posts/${postId}/attachments**`,
    (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: "00000000-0000-4000-8000-000000000081",
              purpose: "board_attachment",
              record_id: null,
              department_id: null,
              board_id: boardId,
              creator_id: authorId,
              filename: "Price list.pdf",
              media_type: "application/pdf",
              expected_size: 1200,
              actual_size: 1200,
              state: "ready",
              failure_code: null,
              is_deleted: false,
              created_at: publishedAt,
              updated_at: publishedAt,
            },
          ],
          limit: 25,
          offset: 0,
          has_more: false,
        },
      }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const reader = postPane(page, browserPost.title);
  await expect(
    reader.getByRole("link", { name: /Supplier notice/ }),
  ).toBeVisible();
  await expect(
    reader.getByRole("button", { name: "Download Price list.pdf" }),
  ).toBeVisible();
  await expect(
    reader.getByRole("heading", { name: "Files", exact: true }),
  ).toBeVisible();
  await expect(
    reader.getByRole("heading", { name: "Linked records" }),
  ).toHaveCount(0);
  await expect(reader.getByText("No attachments yet.")).toHaveCount(0);
  await expect(reader.getByText("No linked records.")).toHaveCount(0);
  const message = reader.getByText(linked.body.trim(), { exact: false });
  const box = await message.boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(672);
  await expect(message).toHaveCSS("line-height", "24px");
});

test("New post publishes from the editor dialog with one consequence line and a toast", async ({
  page,
}) => {
  const api = await installS05PostApi(page);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await expect(
    page.getByRole("button", { name: "More post actions" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "New post", exact: true })
    .first()
    .click();
  const editor = page.getByRole("dialog", { name: "New post", exact: true });
  await expect(editor).toContainText(
    "Everyone who reads Operations board sees this post.",
  );
  await expect(editor).not.toContainText("sent to the server in UTC");
  await editor
    .getByLabel("Title", { exact: true })
    .fill("Dock 3 closes Friday");
  await editor
    .getByLabel("Message", { exact: true })
    .fill("Use Dock 4 for all loading.");
  // Publish saves the draft and publishes it in one step: the draft's Files
  // and Linked records are not read for a draft that is about to be
  // published (the read would race the publish and fail with 404).
  const draftReads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      /\/(attachments|record-links)$/.test(url.pathname) &&
      url.searchParams.get("view") === "draft"
    )
      draftReads.push(`${url.pathname}${url.search}`);
  });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/boards/${boardId}/posts/${postId}/publish`,
    async (route) => {
      await held;
      await route.fallback();
    },
  );
  try {
    await editor.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(
      editor.getByRole("button", { name: "Publishing…", exact: true }),
    ).toBeVisible();
    await settleReact(page);
    release();
    await expect(
      page.getByText("Post published", { exact: true }),
    ).toBeVisible();
    await expect(editor).toHaveCount(0);
  } finally {
    release();
  }
  expect(api.writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
    `POST /api/boards/${boardId}/posts`,
    `POST /api/boards/${boardId}/posts/${postId}/publish`,
  ]);
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("post") === postId && !url.searchParams.has("show"),
  );
  await expect(postPane(page, "Dock 3 closes Friday")).toBeVisible();
  expect(draftReads).toEqual([]);
});

test("archiving asks once with its consequence; restore acts at once with Undo", async ({
  page,
}) => {
  const api = await installS05PostApi(page);
  api.setPublished(browserPost);
  api.setManageStatus("published");
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await postPane(page, browserPost.title)
    .getByRole("button", { name: "More post actions" })
    .click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "Copy link",
    "Unpublish",
    "Archive",
  ]);
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Archive post?",
    exact: true,
  });
  await expect(confirmation).toContainText(
    "Readers no longer see it. A board manager can restore it.",
  );
  await confirmation
    .getByRole("button", { name: "Archive post", exact: true })
    .click();
  await expect(page.getByText("Post archived", { exact: true })).toBeVisible();
  await expect(postRow(page, browserPost.title)).toHaveCount(0);

  await postList(page)
    .getByRole("group", { name: "Post state" })
    .getByRole("button", { name: "Archived" })
    .click();
  const archived = postPane(page, browserPost.title);
  await archived.getByRole("button", { name: "More post actions" }).click();
  const writesBefore = api.writes.length;
  await page.getByRole("menuitem", { name: "Restore", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByText("Post restored", { exact: true })).toBeVisible();
  expect(api.writes.slice(writesBefore).map(({ path }) => path)).toEqual([
    `/api/boards/${boardId}/posts/${postId}/restore`,
  ]);
  await page
    .getByText("Post restored", { exact: true })
    .first()
    .locator("xpath=ancestor::*[.//button[normalize-space()='Undo']][1]")
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await expect
    .poll(() => api.writes.slice(writesBefore).map(({ path }) => path))
    .toEqual([
      `/api/boards/${boardId}/posts/${postId}/restore`,
      `/api/boards/${boardId}/posts/${postId}/archive`,
    ]);
});

test.describe("still page", () => {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ])
    test(`only the list and the pane scroll at ${viewport.width}×${viewport.height}`, async ({
      page,
    }) => {
      const api = await installPostBrowserApi(page);
      api.setPublishedItems(
        Array.from({ length: 25 }, (_, index) => ({
          ...browserPost,
          id: `00000000-0000-4000-8000-${String(index + 400).padStart(12, "0")}`,
          title: `Yard notice ${index + 1}`,
          pinned: false,
        })),
      );
      api.setDetailPost({
        ...browserPost,
        id: "00000000-0000-4000-8000-000000000400",
        title: "Yard notice 1",
        body: "A long message line.\n".repeat(80),
      });
      await page.route(
        `**/api/boards/${boardId}/posts/00000000-0000-4000-8000-000000000400?view=published`,
        (route) =>
          route.fulfill({
            json: {
              ...browserPost,
              id: "00000000-0000-4000-8000-000000000400",
              title: "Yard notice 1",
              body: "A long message line.\n".repeat(80),
            },
          }),
      );
      await page.setViewportSize(viewport);
      await page.goto(`/boards?board=${boardId}&section=posts`);
      await expect(postPane(page, "Yard notice 1")).toBeVisible();
      await expectNoPageScroll(page);
      const listBody = postList(page).getByRole("list");
      expect(
        await listBody.evaluate(
          (list) =>
            list.parentElement!.scrollHeight > list.parentElement!.clientHeight,
        ),
      ).toBe(true);
      const search = postList(page).getByRole("searchbox", {
        name: "Search posts",
      });
      expect(
        (
          await search
            .locator("xpath=ancestor::*[@data-slot='input-group'][1]")
            .boundingBox()
        )?.height,
      ).toBeLessThanOrEqual(32);
      const row = postList(page).getByRole("listitem").first();
      expect((await row.boundingBox())?.height).toBeGreaterThanOrEqual(40);
    });

  test("a phone shows the list, then the post with Back, at 44px targets", async ({
    page,
  }) => {
    await installPostBrowserApi(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/boards?board=${boardId}&section=posts`);
    const row = postRow(page, browserPost.title);
    await expect(row).toBeVisible();
    await expect(page).toHaveURL((url) => !url.searchParams.has("post"));
    await expectNoHorizontalScroll(page);
    for (const target of [
      row,
      postList(page).getByRole("searchbox", { name: "Search posts" }),
      postList(page).getByRole("button", { name: /^Filters/ }),
      postList(page).getByRole("button", { name: /^Sort/ }),
    ])
      expect((await target.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await row.click();
    const reader = postPane(page, browserPost.title);
    await expect(reader).toBeVisible();
    await expect(postList(page)).toBeHidden();
    const back = reader.getByRole("button", { name: "Back to posts" });
    expect((await back.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalScroll(page);
    await back.click();
    await expect(postList(page)).toBeVisible();
    await expect(page).toHaveURL((url) => !url.searchParams.has("post"));
  });

  test("a phone moves focus with the post, and Back works like the system Back", async ({
    page,
  }) => {
    await installPostBrowserApi(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/boards?board=${boardId}&section=posts`);
    const row = postRow(page, browserPost.title);
    await row.click();
    const reader = postPane(page, browserPost.title);
    // The open post takes focus at its title, where a screen reader starts.
    await expect(
      reader.getByRole("heading", { level: 2, name: browserPost.title }),
    ).toBeFocused();
    await reader.getByRole("button", { name: "Back to posts" }).click();
    await expect(postList(page)).toBeVisible();
    // Focus returns to the row of the post that was open.
    await expect(row).toBeFocused();
    // Opening the row added a history entry, and Back to posts went back
    // over it, so Forward opens the post again.
    await page.goForward();
    await expect(reader).toBeVisible();
    // The system Back returns to the list.
    await page.goBack();
    await expect(postList(page)).toBeVisible();
    await expect(page).toHaveURL((url) => !url.searchParams.has("post"));
  });
});

test("a blank new post closes at once, and typed text asks before it is discarded", async ({
  page,
}) => {
  await installS05PostApi(page);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const newPost = page
    .getByRole("button", { name: "New post", exact: true })
    .first();
  await newPost.click();
  const editor = page.getByRole("dialog", { name: "New post", exact: true });
  await expect(editor).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  // A click outside closes a blank post too.
  await newPost.click();
  await expect(editor).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  await newPost.click();
  await editor.getByLabel("Title", { exact: true }).fill("Dock 3 closes");
  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", {
    name: "Discard unsaved post changes?",
    exact: true,
  });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor.getByLabel("Title", { exact: true })).toHaveValue(
    "Dock 3 closes",
  );
  await expect(discard).toHaveCount(0);
  // A click outside asks the same question.
  await page.mouse.click(4, 4);
  await expect(discard).toBeVisible();
  await discard
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(editor).toHaveCount(0);
});

test("Delete draft shows only for a draft that was never published, and asks once", async ({
  page,
}) => {
  const api = await installS05PostApi(page);
  // The manage state reads revision 9, so the draft holds it too.
  api.setWorking({ ...s05Draft, post_revision: 9 });
  api.setManageStatus("draft");
  api.setPublishedBefore(true);
  await page.goto(`/boards?board=${boardId}&section=posts&show=drafts`);
  const pane = postPane(page, s05Draft.title);
  const more = pane.getByRole("button", { name: "More post actions" });
  await more.click();
  await expect(page.getByRole("menuitem")).toHaveText(["Archive"]);
  await page.keyboard.press("Escape");

  api.setPublishedBefore(false);
  await more.click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "Archive",
    "Delete draft",
  ]);
  await page
    .getByRole("menuitem", { name: "Delete draft", exact: true })
    .click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Delete draft?",
    exact: true,
  });
  await expect(confirmation).toContainText(
    "It was never published, so it goes with its files and record links.",
  );
  await expect(confirmation.getByRole("textbox")).toHaveCount(0);
  await expect(
    confirmation.getByRole("button", { name: "Delete draft", exact: true }),
  ).toBeEnabled();
});

test("the post list announces loading, then how many posts it holds", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  api.setPublishedItems([
    browserPost,
    {
      ...browserPost,
      id: "00000000-0000-4000-8000-000000000031",
      title: "Second yard notice",
    },
  ]);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === `/api/boards/${boardId}/posts`,
    async (route) => {
      await held;
      await route.fallback();
    },
  );
  try {
    await page.goto(`/boards?board=${boardId}&section=posts`);
    const status = postList(page).getByRole("status");
    await expect(status).toHaveText("Loading posts");
    release();
    await expect(status).toHaveText("2 posts");
  } finally {
    release();
  }
  api.setPublishedItems([]);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await expect(postList(page).getByRole("status")).toHaveText(
    "No published posts yet",
  );
  // Beside an empty list, the pane holds no hint.
  await expect(page.getByText("Choose a post to read it.")).toHaveCount(0);
});

test("a post's body lines stop at 65 characters in a wide reading pane", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installPostBrowserApi(page);
  api.setPublishedItems([]);
  await page.goto(`/boards?board=${boardId}&section=posts&post=${postId}`);
  const body = postPane(page, browserPost.title).getByText(browserPost.body, {
    exact: true,
  });
  await expect(body).toBeVisible();
  // The measure is in characters of the body's own font (BR38).
  const characters = await body.evaluate((node) => {
    const zero = document.createElement("span");
    zero.style.font = getComputedStyle(node).font;
    zero.style.position = "absolute";
    zero.textContent = "0";
    document.body.append(zero);
    const ch = zero.getBoundingClientRect().width;
    zero.remove();
    return node.getBoundingClientRect().width / ch;
  });
  expect(characters).toBeLessThanOrEqual(65.5);
});
