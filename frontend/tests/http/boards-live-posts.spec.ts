import {
  expect,
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
        user_id: currentViewerId,
        default_organization_blocked: null,
        setup_required: false,
      }),
    }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        id: currentViewerId,
        role: "member",
        access: [],
        default_organization_blocked: null,
      },
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
  await expect.poll(() => summary.textContent()).toBe(browserPost.body);
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

test.describe("Boards workspace regional post dates", () => {
  test.use({ locale: "en-US", timezoneId: "UTC" });
  test("published feed, reader and edit history use the workspace date and timezone", async ({
    page,
  }) => {
    const api = await installPostBrowserApi(page);
    api.setPublishedItems([
      { ...browserPost, publication_number: 2, edited: true },
    ]);
    await page.route(
      `**/api/boards/${boardId}/posts/${postId}?view=published`,
      (route) =>
        route.fulfill({
          json: { ...browserPost, publication_number: 2, edited: true },
        }),
    );
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
    await expect(page.locator("article time")).toHaveText(
      /22 sept\. 2026.*17:00/,
    );
    await page.getByRole("button", { name: "Open post", exact: true }).click();
    const reader = page.getByRole("dialog", {
      name: "Published safety update",
      exact: true,
    });
    await expect(reader.locator("time")).toHaveText(/22 sept\. 2026.*17:00/);
    await reader.getByRole("button", { name: "Edited", exact: true }).click();
    const history = page.getByRole("dialog", {
      name: "Edit history",
      exact: true,
    });
    await expect(
      history.getByRole("button", { name: /Version 2/ }),
    ).toContainText(/22 sept\. 2026.*17:00/);
    await history.getByRole("button", { name: /Version 1/ }).click();
    await expect(
      history.getByRole("button", { name: /Version 1/ }),
    ).toContainText(/22 sept\. 2026.*17:00/);
  });
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

test("author picker searches beyond the first page and retains a selected author across searches", async ({
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
    page.getByRole("heading", { name: "Published safety update" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Published posts" })
      .getByText("Avery", { exact: true }),
  ).toBeVisible();
  expect(api.authorRequests.length).toBeGreaterThan(0);
  expect(
    api.authorRequests.every(
      (query) => new URLSearchParams(query).get("offset") === "0",
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "More filters" }).click();
  await page
    .getByRole("combobox", { name: "Post author", exact: true })
    .click();
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "Zora later-page author" }),
  ).toBeVisible();
  await page.getByRole("option", { name: "Zora later-page author" }).click();
  const selectedAuthorControl = page
    .getByRole("combobox", { name: "Post author", exact: true })
    .filter({ hasText: "Zora later-page author" });
  await expect(selectedAuthorControl).toContainText("Zora later-page author");
  await selectedAuthorControl.click();
  await page
    .getByRole("combobox", { name: "Search post author", exact: true })
    .fill("First author 0");
  await expect
    .poll(() =>
      api.authorRequests.some(
        (query) =>
          new URLSearchParams(query).get("search") === "First author 0",
      ),
    )
    .toBe(true);
  await expect(
    page.getByRole("option", { name: "Zora later-page author" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(selectedAuthorControl).toContainText("Zora later-page author");
  await expect(
    page
      .getByRole("region", { name: "Published posts" })
      .getByText("Zora later-page author", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "More filters" }).click();
  await expect(
    page.getByRole("combobox", { name: "Post author", exact: true }),
  ).toContainText("All authors");
});

test("off-page post authors keep their labels through picker search, reader, and history", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  const label = "Zora published author";
  const expectLabelAppearance = async (visibleLabel: Locator) => {
    await expectPostAppearanceMatrix(page, async () => {
      await expect(visibleLabel).toBeVisible();
    });
  };
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
  const feed = page.getByRole("region", { name: "Published posts" });
  await expect(feed.getByText(label, { exact: true })).toBeVisible();

  const lookupQueries = () =>
    api.authorRequests
      .map((query) => new URLSearchParams(query))
      .filter((query) => query.has("ids"));
  expect(lookupQueries().length).toBeGreaterThan(0);
  for (const query of lookupQueries()) {
    expect(query.getAll("ids")).toContain(authorId);
    expect(query.getAll("ids")).toHaveLength(25);
    expect(Number(query.get("limit"))).toBeLessThanOrEqual(100);
    expect(query.get("offset")).toBe("0");
    expect(query.has("search")).toBe(false);
  }
  expect(
    api.authorRequests.every(
      (query) => new URLSearchParams(query).get("offset") === "0",
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "More filters" }).click();
  await page
    .getByRole("combobox", { name: "Post author", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Search post author", exact: true })
    .fill("First author 0");
  await expect(
    page.getByRole("option", { name: "First author 0", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(feed.getByText(label, { exact: true })).toBeVisible();
  await expectLabelAppearance(feed.getByText(label, { exact: true }));
  await feed
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: browserPost.title, exact: true }),
    })
    .getByRole("button", { name: "Open post", exact: true })
    .click();
  const reader = page.getByRole("dialog", {
    name: browserPost.title,
    exact: true,
  });
  await expect(reader.getByText(label, { exact: true })).toBeVisible();
  await expectLabelAppearance(reader.getByText(label, { exact: true }));
  await reader.getByRole("button", { name: "Edited", exact: true }).click();
  const history = page.getByRole("dialog", {
    name: "Edit history",
    exact: true,
  });
  await expect(versionRow(history, 2)).toContainText(label);
  await expect(versionRow(history, 1)).toContainText(label);
  await page.keyboard.press("Escape");

  api.setPublishedItems([]);
  await page.goto(`/boards?board=${boardId}&section=posts&post=${postId}`);
  await expect(reader.getByText(label, { exact: true })).toBeVisible();
  await reader.getByRole("button", { name: "Close post", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No published posts" }),
  ).toBeVisible();
});

test("local card history keeps its eligible author after a held feed refresh replaces the card", async ({
  page,
}) => {
  const api = await installPostBrowserApi(page);
  const replacementAuthorId = "00000000-0000-4000-8000-000000000008";
  const editedPost = { ...browserPost, publication_number: 2, edited: true };
  const olderPost = {
    ...browserPost,
    id: "00000000-0000-4000-8000-000000000299",
    author_id: replacementAuthorId,
    title: "Earlier Bailey update",
  };
  const otherPosts = Array.from({ length: 25 }, (_, index) => ({
    ...browserPost,
    id: `00000000-0000-4000-8000-${String(index + 300).padStart(12, "0")}`,
    author_id: replacementAuthorId,
    title: `Replacement author update ${index + 1}`,
    publish_at: "2026-09-23T01:00:00Z",
    published_at: "2026-09-23T01:00:00Z",
    created_at: "2026-09-23T01:00:00Z",
    updated_at: "2026-09-23T01:00:00Z",
  }));
  api.setAuthorChoices([
    { id: authorId, label: "Avery" },
    { id: replacementAuthorId, label: "Bailey" },
  ]);
  api.setPublishedItems([editedPost, olderPost]);
  let holdFeed = false;
  let releaseFeed: () => void = () => {};
  const heldFeed = new Promise<void>((resolve) => {
    releaseFeed = resolve;
  });
  let feedStarted: () => void = () => {};
  const feedEntered = new Promise<void>((resolve) => {
    feedStarted = resolve;
  });
  let feedEnded: () => void = () => {};
  const feedCompleted = new Promise<void>((resolve) => {
    feedEnded = resolve;
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
      try {
        await route.fallback();
      } finally {
        feedEnded();
      }
    },
  );
  try {
    await page.goto(`/boards?board=${boardId}&section=posts`);
    const feed = page.getByRole("region", { name: "Published posts" });
    await expect(feed.getByText("Avery", { exact: true })).toBeVisible();
    // A Strict Mode remount can abort the first load after it reached the
    // route, so count only the reads that Refresh causes.
    const readsBeforeRefresh = feedReads;
    holdFeed = true;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await feedEntered;
    await page
      .getByRole("button", {
        name: `Edit history of ${browserPost.title}`,
        exact: true,
      })
      .click();
    const history = page.getByRole("dialog", {
      name: "Edit history",
      exact: true,
    });
    await expect(versionRow(history, 2)).toContainText("Avery");
    await expect(versionRow(history, 1)).toContainText("Avery");
    await expect(page).toHaveURL((url) => !url.searchParams.has("post"));
    api.setPublishedItems([...otherPosts, editedPost, olderPost]);
    const replaced = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === `/api/boards/${boardId}/posts` &&
        url.searchParams.get("view") === "published"
      );
    });
    releaseFeed();
    expect((await replaced).status()).toBe(200);
    await feedCompleted;
    const replacedFeed = page.getByRole("region", {
      name: "Published posts",
      exact: true,
      includeHidden: true,
    });
    await expect(
      replacedFeed.getByRole("heading", {
        name: "Replacement author update 1",
        exact: true,
        includeHidden: true,
      }),
    ).toHaveCount(1);
    await expect(
      replacedFeed.getByRole("heading", {
        name: browserPost.title,
        exact: true,
        includeHidden: true,
      }),
    ).toHaveCount(0);
    await expect(history).toBeVisible();
    await expect(versionRow(history, 2)).toContainText("Avery");
    await expect(versionRow(history, 1)).toContainText("Avery");
    await expect(history).not.toContainText("Author unavailable");
    expect(feedReads - readsBeforeRefresh).toBe(1);
    await expectPostAppearanceMatrix(page, async () => {
      const version = versionRow(history, 2);
      await version.scrollIntoViewIfNeeded();
      await expect(version).toContainText("Avery");
      await expect(version.getByText("Avery")).toBeInViewport();
      await expect(history).not.toContainText("Author unavailable");
    });
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
    await page.getByRole("button", { name: "More filters" }).click();
    await page
      .getByRole("combobox", { name: "Post author", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Search post author", exact: true })
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
      .getByRole("button", { name: "Switch board", exact: true })
      .click();
    await page.getByRole("combobox", { name: "Board", exact: true }).click();
    await page
      .getByRole("option", { name: /^Second operations board\b/ })
      .click();
    await expect(
      page.getByRole("heading", { name: "Second operations board", level: 1 }),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "Main navigation", exact: true })
      .getByRole("link", { name: "Posts", exact: true })
      .click();
    const feed = page.getByRole("region", { name: "Published posts" });
    await expect(
      feed.getByRole("heading", { name: "Second published update" }),
    ).toBeVisible();
    await expect(
      feed.getByText("Morgan second board", { exact: true }),
    ).toBeVisible();
    release();
    await labelSettled;
    await expect(
      page.getByText("Old Board private author", { exact: true }),
    ).toHaveCount(0);
    await expect(
      feed.getByText("Morgan second board", { exact: true }),
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
    const feed = page.getByRole("region", { name: "Published posts" });
    await expect(feed.getByText("Avery", { exact: true })).toBeVisible();
    hold = true;
    api.setViewerId("00000000-0000-4000-8000-000000000008");
    api.setAuthorChoices([{ id: authorId, label: "Morgan new account" }]);
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    await labelStarted;
    await expect(page.getByText("Avery", { exact: true })).toHaveCount(0);
    release();
    await expect(
      feed.getByText("Morgan new account", { exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
});

for (const status of [403, 404]) {
  test(`known-author label refusal ${status} hides stored names until an authorized retry`, async ({
    page,
  }) => {
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
      const feed = page.getByRole("region", { name: "Published posts" });
      await expect(feed.getByText("Avery", { exact: true })).toBeVisible();
      await page
        .getByRole("button", { name: "More filters", exact: true })
        .click();
      const picker = page
        .getByRole("region", { name: "Post filters", exact: true })
        .getByRole("combobox", { name: "Post author", exact: true });
      await picker.click();
      const selectedFeed = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `/api/boards/${boardId}/posts` &&
          url.searchParams.get("author_id") === authorId
        );
      });
      const selectedLabel = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `/api/boards/${boardId}/post-authors` &&
          url.searchParams.has("ids")
        );
      });
      await page.getByRole("option", { name: "Avery", exact: true }).click();
      await selectedFeed;
      await selectedLabel;
      await expect(feed.getByText("Avery", { exact: true })).toBeVisible();
      await expect(picker).toContainText("Avery");
      await expect.poll(() => activeReads).toBe(0);
      refused = true;
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await deniedComplete;
      await expect(
        page.getByText(
          "Author labels unavailable. Check your access or retry.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.getByText("Avery", { exact: true })).toHaveCount(0);
      await expect(picker).toBeDisabled();
      await expect(
        page.getByText("Private refusal detail", { exact: true }),
      ).toHaveCount(0);
      await expect.poll(() => activeReads).toBe(0);
      recoveryArmed = true;
      await Promise.all([
        recoveryObserved,
        page
          .getByRole("button", { name: "Retry authors", exact: true })
          .click(),
      ]);
      await expect(page.getByText("Avery", { exact: true })).toHaveCount(0);
      releaseRecovery();
      await recoveryComplete;
      await expect(feed.getByText("Avery", { exact: true })).toBeVisible();
      await expect(picker).toContainText("Avery");
    } finally {
      releaseRecovery();
    }
  });
}

test("a transient label refresh retains the current byline and retries its bounded lookup", async ({
  page,
}) => {
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
  const feed = page.getByRole("region", { name: "Published posts" });
  await expect(feed.getByText("Avery", { exact: true })).toBeVisible();
  failed = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText(
      "Could not refresh author labels. Showing the last loaded labels.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(feed.getByText("Avery", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Internal failure detail", { exact: true }),
  ).toHaveCount(0);
  failed = false;
  api.setAuthorChoices([{ id: authorId, label: "Avery renamed" }]);
  await page
    .getByRole("button", { name: "Retry authors", exact: true })
    .click();
  await expect(feed.getByText("Avery renamed", { exact: true })).toBeVisible();
  await expect(page.getByText("Avery", { exact: true })).toHaveCount(0);
});

// S05 uses the existing rendered Board and a stateful client boundary. The
// editable parent can be scheduled while the independently displayed version
// remains published; revisions always come from the current server read.
async function installS05PostApi(page: Page, manage = true) {
  await installOpenViewEventSource(page);
  const reader = await installPostBrowserApi(page);
  reader.setViewerId(authorId);
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: wireWorkspace({
        id: "00000000-0000-4000-8000-000000000102",
        locale: "en-US",
        timezone: "UTC",
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
      const items = view === "published" ? published : working ? [working] : [];
      return reply({ ...wirePage(items), board_revision: boardRevision });
    }
    if (path === `${prefix}/posts/${postId}/manage-state`)
      return reply({
        id: postId,
        status: manageStatus,
        post_revision: 9,
        board_revision: boardRevision,
        published_before: true,
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
    setManageStatus(status: "draft" | "scheduled") {
      manageStatus = status;
    },
  };
}

test("matching post burst refreshes the bounded feed without wrong-scope reads or reload", async ({
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
  const feed = page.getByRole("region", { name: "Published posts" });
  await expect(
    feed.getByRole("heading", { name: browserPost.title, exact: true }),
  ).toBeVisible();
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
      return feed
        .getByRole("heading", { name: "Remote safety notice", exact: true })
        .count();
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

async function openS05Drafts(page: Page) {
  await page.getByRole("button", { name: "More post actions" }).click();
  await page.getByRole("menuitem", { name: "Edit drafts" }).click();
  return page.getByRole("dialog", { name: "Post editor" });
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
    await page.goto(`/boards?board=${boardId}&section=posts`);
    const editor = await openS05Drafts(page);
    await editor
      .getByRole("button", { name: s05Draft.title, exact: true })
      .click();
    await expect(editor.getByLabel("Title", { exact: true })).toHaveValue(
      s05Draft.title,
    );
    if (dirty) {
      await editor
        .getByLabel("Title", { exact: true })
        .fill("My local safety draft");
      await editor
        .getByLabel("Message", { exact: true })
        .fill("Retain this local message");
      await editor
        .getByLabel("External link 1 label", { exact: true })
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
      const notice = editor.getByText(
        "Changed by someone else — review latest",
        { exact: true },
      );
      await expect(notice).toBeVisible();
      await expect(editor.getByLabel("Title", { exact: true })).toHaveValue(
        "My local safety draft",
      );
      await expect(editor.getByLabel("Message", { exact: true })).toHaveValue(
        "Retain this local message",
      );
      await expect(
        editor.getByLabel("External link 1 label", { exact: true }),
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
        editor.getByText("Changed by someone else — review latest", {
          exact: true,
        }),
      ).toHaveCount(0);
    }
    expect(api.writes).toHaveLength(0);
  });
}

test("post invalidation preserves the held Save owner while its feed updates", async ({
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
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const editor = await openS05Drafts(page);
  await editor
    .getByRole("button", { name: s05Draft.title, exact: true })
    .click();
  await editor
    .getByLabel("Message", { exact: true })
    .fill("Pending local save");
  try {
    await editor
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await expect(
      editor.getByRole("button", { name: "Working…", exact: true }),
    ).toBeDisabled();
    api.setPublished({ ...browserPost, title: "Live notice during Save" });
    await sendOpenViewEvent(page, "invalidate", {
      entity: "board_posts",
      board_id: boardId,
    });
    await expect(
      page.getByRole("heading", {
        name: "Live notice during Save",
        exact: true,
        includeHidden: true,
      }),
    ).toHaveCount(1);
    await expect(
      editor.getByRole("button", { name: "Working…", exact: true }),
    ).toBeDisabled();
    await expect(editor.getByLabel("Message", { exact: true })).toHaveValue(
      "Pending local save",
    );
    release();
    await expect(
      editor.getByText("Draft saved.", { exact: true }),
    ).toBeVisible();
    expect(api.writes).toHaveLength(1);
  } finally {
    release();
  }
});

test("lifecycle updates its current list without losing a held Unpublish owner", async ({
  page,
}) => {
  const api = await installS05PostApi(page);
  api.setPublished(browserPost);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await page.getByRole("button", { name: "Manage posts", exact: true }).click();
  const manager = page.getByRole("dialog", {
    name: "Manage posts",
    exact: true,
  });
  api.setPublished({ ...browserPost, title: "Remote published post" });
  await sendOpenViewEvent(page, "invalidate", {
    entity: "board_posts",
    board_id: boardId,
  });
  await expect(
    manager.getByRole("button", {
      name: "Unpublish post Remote published post",
      exact: true,
    }),
  ).toBeVisible();
  await manager
    .getByRole("button", {
      name: "Unpublish post Remote published post",
      exact: true,
    })
    .click();
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
      page
        .getByRole("region", {
          name: "Published posts",
          exact: true,
          includeHidden: true,
        })
        .getByRole("heading", {
          name: "Feed update during Unpublish",
          exact: true,
          includeHidden: true,
        }),
    ).toHaveCount(1);
    await expect(
      confirmation.getByRole("button", { name: "Unpublish post", exact: true }),
    ).toBeDisabled();
    release();
    await expect(
      manager.getByText("Post unpublished.", { exact: true }),
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
  test(`Board switch cancels the old ${phase} without refreshing or restoring its feed`, async ({
    page,
  }) => {
    const startedAt = Date.now();
    const metadata: {
      kind: "request" | "response";
      elapsedMs: number;
      method: string;
      path: string;
      query: [string, string][];
      status?: number;
    }[] = [];
    const requestMetadata = (urlString: string, method: string) => {
      const url = new URL(urlString);
      if (
        url.pathname !== "/api/boards" &&
        !url.pathname.startsWith(`/api/boards/${boardId}`) &&
        !url.pathname.startsWith(`/api/boards/${otherBoardId}`)
      )
        return null;
      const keys = new Set([
        "limit",
        "offset",
        "sort_by",
        "sort_order",
        "view",
        "search",
        "author_id",
        "ids",
      ]);
      return {
        elapsedMs: Date.now() - startedAt,
        method,
        path: url.pathname,
        query: [...url.searchParams.entries()].filter(([key]) => keys.has(key)),
      };
    };
    page.on("request", (request) => {
      const safe = requestMetadata(request.url(), request.method());
      if (safe) metadata.push({ kind: "request", ...safe });
    });
    page.on("response", (response) => {
      const safe = requestMetadata(response.url(), response.request().method());
      if (safe)
        metadata.push({ kind: "response", ...safe, status: response.status() });
    });
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
    await expect(
      page.getByRole("heading", { name: browserPost.title, exact: true }),
    ).toBeVisible();
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
      await page
        .getByRole("button", { name: "Switch board", exact: true })
        .click();
      await page.clock.runFor(20);
      await page.getByRole("combobox", { name: "Board", exact: true }).click();
      await page.clock.runFor(20);
      await page.getByRole("option", { name: /Partner Board/ }).click();
      await expect(
        page.getByRole("button", { name: "Switch board", exact: true }),
      ).toContainText("Partner Board");
      const partnerReply = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `/api/boards/${otherBoardId}/posts` &&
          url.searchParams.get("view") === "published"
        );
      });
      const partnerAuthorsReply = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          `/api/boards/${otherBoardId}/post-authors`,
      );
      await page.getByRole("link", { name: "Posts", exact: true }).click();
      await page
        .getByRole("region", { name: "Post search and filters", exact: true })
        .waitFor({ state: "visible" });
      await expect
        .poll(async () => {
          await page.clock.runFor(0);
          return metadata.some(
            (item) =>
              item.kind === "response" &&
              item.path === `/api/boards/${otherBoardId}/post-authors`,
          );
        })
        .toBe(true);
      await (await partnerAuthorsReply).finished();
      await page.clock.runFor(0);
      await partnerReply;
      const feed = page.getByRole("region", {
        name: "Published posts",
        exact: true,
      });
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
          return feed
            .getByRole("heading", { name: "Partner update", exact: true })
            .count();
        })
        .toBe(1);
      expect(oldReads).toBe(beforeSwitch);
      expect(partnerReads).toBe(partnerBefore);
      await expect(
        feed.getByRole("heading", { name: "Partner update", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Old Board private update", { exact: true }),
      ).toHaveCount(0);
      expect(api.writes).toHaveLength(0);
    } finally {
      release();
    }
  });
}

test.describe("local post expiry", () => {
  test.use({ timezoneId: "Asia/Manila" });
  test("manager creates, reloads, edits and clears pin and local expiry", async ({
    page,
  }) => {
    const api = await installS05PostApi(page);
    await page.clock.setFixedTime(new Date("2035-06-01T00:00:00Z"));
    await page.goto(`/boards?board=${boardId}&section=posts`);
    await page.getByRole("button", { name: "New post", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Post editor" });
    await editor
      .getByLabel("Title", { exact: true })
      .fill("Pinned working draft");
    await editor
      .getByLabel("Message", { exact: true })
      .fill("Original working text");
    await editor.getByRole("checkbox", { name: "Pin to top" }).check();
    await editor
      .getByLabel("Expires on", { exact: true })
      .fill("2035-06-02T12:30");
    await expect(editor).toContainText("Asia/Manila");
    await editor
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await expect(
      editor.getByText("Draft saved.", { exact: true }),
    ).toBeVisible();
    expect(api.writes[0]?.body).toMatchObject({
      pinned: true,
      expires_at: "2035-06-02T04:30:00.000Z",
    });
    await editor.getByRole("button", { name: "Close", exact: true }).click();
    await page.reload();
    const reopened = await openS05Drafts(page);
    await reopened
      .getByRole("button", { name: "Pinned working draft", exact: true })
      .click();
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
      reopened.getByText("Draft saved.", { exact: true }),
    ).toBeVisible();
    expect(api.writes[1]?.body).toMatchObject({
      pinned: false,
      expires_at: null,
    });
    await expect(
      reopened.getByLabel("Expires on", { exact: true }),
    ).toHaveValue("");
  });
  test("nonmanager preserves an existing pin while editing their own post", async ({
    page,
  }) => {
    const api = await installS05PostApi(page, false);
    api.setWorking(s05Draft);
    await page.goto(`/boards?board=${boardId}&section=posts`);
    const editor = await openS05Drafts(page);
    await editor
      .getByRole("button", { name: s05Draft.title, exact: true })
      .click();
    await expect(
      editor.getByRole("checkbox", { name: "Pin to top" }),
    ).toHaveCount(0);
    await editor.getByLabel("Message", { exact: true }).fill("Own edited text");
    await editor
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await expect(
      editor.getByText("Draft saved.", { exact: true }),
    ).toBeVisible();
    expect(api.writes[0]?.body).not.toHaveProperty("pinned");
    expect(api.writes[0]?.body).not.toHaveProperty("expires_at");
  });
  for (const failure of [409, 503]) {
    test(`pin and expiry survive save refusal ${failure} and draft refresh`, async ({
      page,
    }) => {
      const api = await installS05PostApi(page);
      api.setWorking(s05Draft);
      api.setFailure(failure);
      await page.goto(`/boards?board=${boardId}&section=posts`);
      const editor = await openS05Drafts(page);
      await editor
        .getByRole("button", { name: s05Draft.title, exact: true })
        .click();
      await editor.getByRole("checkbox", { name: "Pin to top" }).uncheck();
      await editor
        .getByLabel("Expires on", { exact: true })
        .fill("2035-06-03T12:30");
      await editor
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      await expect(editor.getByRole("alert").first()).toBeVisible();
      await editor
        .getByRole("button", { name: "Refresh posts", exact: true })
        .click();
      await expect(
        editor.getByLabel("Expires on", { exact: true }),
      ).toHaveValue("2035-06-03T12:30");
      await expect(
        editor.getByRole("checkbox", { name: "Pin to top" }),
      ).not.toBeChecked();
      await expect(
        editor.getByRole("button", { name: "New post", exact: true }),
      ).toBeDisabled();
      await expect(
        editor.getByText("Draft saved.", { exact: true }),
      ).toHaveCount(0);
    });
  }
  test("schedule at expiry is refused and expired publication failure retains the draft", async ({
    page,
  }) => {
    const api = await installS05PostApi(page);
    api.setWorking(s05Draft);
    await page.clock.setFixedTime(new Date("2035-06-01T00:00:00Z"));
    await page.goto(`/boards?board=${boardId}&section=posts`);
    const editor = await openS05Drafts(page);
    await editor
      .getByRole("button", { name: s05Draft.title, exact: true })
      .click();
    await editor
      .getByLabel("Publication date and time")
      .fill("2035-06-02T12:30");
    await editor
      .getByRole("button", { name: "Schedule publication", exact: true })
      .click();
    await expect(
      editor.getByText("Choose a publication time before this post expires."),
    ).toBeVisible();
    expect(api.writes).toHaveLength(0);
    await editor.getByLabel("Publication date and time").fill("");
    api.setFailure(422);
    await editor
      .getByRole("button", { name: "Publish now", exact: true })
      .click();
    await expect(editor.getByRole("alert").first()).toBeVisible();
    await expect(editor.getByLabel("Expires on", { exact: true })).toHaveValue(
      "2035-06-02T12:30",
    );
    await expect(
      editor.getByText("Published successfully.", { exact: true }),
    ).toHaveCount(0);
  });
});

test.describe("unavailable local expiry", () => {
  test.use({ timezoneId: "America/New_York" });
  test("skipped local clock time has a linked error and sends no save", async ({
    page,
  }) => {
    const api = await installS05PostApi(page);
    await page.goto(`/boards?board=${boardId}&section=posts`);
    await page.getByRole("button", { name: "New post", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Post editor" });
    await editor
      .getByLabel("Title", { exact: true })
      .fill("Clock change draft");
    await editor
      .getByLabel("Message", { exact: true })
      .fill("Keep these unsaved fields.");
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

test("source-returned expired publication shows expiry in the feed and reader", async ({
  page,
}) => {
  const api = await installS05PostApi(page);
  await page.clock.setFixedTime(new Date("2035-06-03T00:00:00Z"));
  api.setPublished({ ...browserPost, expires_at: "2035-06-02T04:30:00Z" });
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const feed = page.getByRole("region", {
    name: "Published posts",
    exact: true,
  });
  await expect(feed.getByText("Expired", { exact: true })).toBeVisible();
  await expect(feed.getByText(/Expired on.*Jun 2, 2035/)).toBeVisible();
  await expectPostMotionMatrix(page);
  await feed.getByRole("button", { name: "Open post", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: browserPost.title }),
  ).toContainText(/Expired on.*Jun 2, 2035/);
});

for (const replacement of ["draft", "scheduled"] as const) {
  test(`manager unpublishes the displayed version with a ${replacement} replacement`, async ({
    page,
  }) => {
    const api = await installS05PostApi(page);
    api.setPublished(browserPost);
    api.setManageStatus(replacement);
    await page.goto(`/boards?board=${boardId}&section=posts`);
    await page
      .getByRole("button", { name: "Manage posts", exact: true })
      .click();
    const manager = page.getByRole("dialog", {
      name: "Manage posts",
      exact: true,
    });
    await manager
      .getByRole("button", {
        name: `Unpublish post ${browserPost.title}`,
        exact: true,
      })
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
      manager.getByText("Post unpublished.", { exact: true }),
    ).toBeVisible();
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0]?.body).toEqual({
      board_revision: 4,
      post_revision: 9,
    });
    await expect(
      manager.getByRole("button", {
        name: `Unpublish post ${browserPost.title}`,
        exact: true,
      }),
    ).toHaveCount(0);
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
    await page
      .getByRole("button", { name: "Manage posts", exact: true })
      .click();
    const manager = page.getByRole("dialog", {
      name: "Manage posts",
      exact: true,
    });
    await manager
      .getByRole("button", {
        name: `Unpublish post ${browserPost.title}`,
        exact: true,
      })
      .click();
    await page
      .getByRole("alertdialog", { name: "Unpublish post?", exact: true })
      .getByRole("button", { name: "Unpublish post", exact: true })
      .click();
    await expect(
      manager.getByText(
        failure === 403
          ? "Post management is unavailable for your current access."
          : failure === 409
            ? "This post changed elsewhere. Refresh posts before trying again."
            : "Post request failed. Try again.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      manager.getByText("Post unpublished.", { exact: true }),
    ).toHaveCount(0);
    expect(api.writes).toHaveLength(1);
  });
}
