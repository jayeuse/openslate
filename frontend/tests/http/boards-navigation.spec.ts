import {
  authMeBody,
  expect,
  signedInSession,
  test,
  type Page,
} from "./helpers/test";
import { pageOf } from "../helpers/pagination";
import { wireBoard } from "../helpers/wire";
import { installOpenViewEventSource } from "./helpers/openview-event-source";
import {
  directoryIds,
  installBoardApi,
  installBoardDirectory,
} from "./helpers/boards-api";

const boardId = "00000000-0000-4000-8000-000000000021";
const userId = "00000000-0000-4000-8000-000000000022";
const board = wireBoard({
  id: boardId,
  name: "Authorized operations",
  description: null,
  level: "read",
  created_at: "2026-09-23T00:00:00Z",
  updated_at: "2026-09-23T00:00:00Z",
});

async function installServerBoards(page: Page) {
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
  await signedInSession(page, userId);
  await page.route("**/api/boards**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const reply = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/boards")
      return reply(200, pageOf([board], { limit: 25 }));
    if (path === `/api/boards/${boardId}`) return reply(200, board);
    if (path === `/api/boards/${boardId}/my-access`)
      return reply(200, {
        level: "read",
        read: true,
        write: false,
        manage: false,
      });
    if (path === `/api/boards/${boardId}/post-authors`)
      return reply(200, pageOf([], { limit: 25 }));
    return reply(404, { detail: "Content route unavailable" });
  });
}

test("legacy sample Board URL cannot reveal browser-local Board content", async ({
  page,
}) => {
  await installServerBoards(page);
  await page.goto("/boards?board=sample-board-organization&section=posts");

  await expect(
    page.getByText("It may have been removed, or you may not have access."),
  ).toBeVisible();
  // The refusal leads to the Company board, and offers no Retry that cannot
  // succeed. No loading placeholder stays behind once there is no Board to
  // wait for.
  const main = page.locator("#main-content");
  await expect(
    main.getByText("This board is not available.", { exact: true }),
  ).toBeVisible();
  await expect(
    main.getByRole("link", { name: "Go to Company board" }),
  ).toHaveAttribute("href", "/boards");
  await expect(main.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(main.locator(".animate-pulse")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Organization board" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage board" })).toHaveCount(
    0,
  );
});

test("Board content sections stay on the authorized UUID and fail closed when content APIs are unavailable", async ({
  page,
}) => {
  await installServerBoards(page);
  await page.goto(`/boards?board=${boardId}&section=calendar`);

  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();
  await expect(
    page.getByText(
      "No events are shown. Retry or ask a Board manager to check your access.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Manager-visible event")).toHaveCount(0);

  await page
    .getByRole("navigation", { name: `${board.name} announcements views` })
    .getByRole("link", { name: "Posts", exact: true })
    .click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/boards" &&
      url.searchParams.get("board") === boardId &&
      url.searchParams.get("section") === "posts",
  );
  await expect(
    page.getByText("Posts unavailable. Check your access or try again."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Manager-visible post" }),
  ).toHaveCount(0);
});

/**
 * Holds the Board list request until the test releases it, with the page's
 * timers on a paused clock, so the skeleton delay and minimum are exact.
 */
async function openBoardsWithHeldList(page: Page) {
  await installServerBoards(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/boards**", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/boards") await held;
    await route.fallback();
  });
  await page.clock.install({ time: new Date("2026-09-27T09:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-27T09:00:01Z"));
  await page.goto("/boards");
  await expect(
    page.getByRole("heading", { level: 1, name: "Boards" }),
  ).toBeVisible();
  const region = page.locator('[data-slot="loading-region"]');
  await expect(region).toHaveAttribute("aria-busy", "true");
  return {
    region,
    label: page.getByRole("status").filter({ hasText: "Loading Boards" }),
    release,
  };
}

test("a slow Board list shows its skeleton only after 300ms, and for at least 300ms", async ({
  page,
}) => {
  const { region, label, release } = await openBoardsWithHeldList(page);
  // The loading shell never shows sample Board content.
  const loadingHtml = await page.locator("main").innerHTML();
  expect(loadingHtml).not.toContain("Organization board");
  expect(loadingHtml).not.toContain("sample-board");

  await page.clock.runFor(250);
  await expect(label).toHaveCount(0);
  await page.clock.runFor(100);
  await expect(label).toHaveCount(1);

  // The list arrives 50ms after the skeleton shows; the skeleton stays to 300ms.
  await page.clock.runFor(50);
  const listed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/boards",
  );
  release();
  await listed;
  await page.clock.runFor(100);
  await expect(label).toHaveCount(1);
  // The frame already names the Board; the region still holds its skeleton.
  await expect(region).toHaveAttribute("aria-busy", "true");
  await page.clock.runFor(200);
  // Count, never wait: a waiting read would block the paused clock it needs.
  const settled = page.locator(
    '[data-slot="loading-region"][aria-busy="false"]',
  );
  await expect
    .poll(
      async () => {
        await page.clock.runFor(1);
        return settled.count();
      },
      { intervals: [50] },
    )
    .toBe(1);
  // The region now holds the Board's posts (here, its fail-closed notice).
  await expect(
    region.getByText("Posts unavailable. Check your access or try again."),
  ).toBeVisible();
  await expect(label).toHaveCount(0);
});

test("a Board list that arrives within 300ms never shows the skeleton", async ({
  page,
}) => {
  const { region, label, release } = await openBoardsWithHeldList(page);
  await page.clock.runFor(200);
  release();
  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();
  await expect(region).toHaveAttribute("aria-busy", "false");
  await page.clock.runFor(1_000);
  await expect(label).toHaveCount(0);
});

// docs/specs/boards-relayout.md P1: the sidebar rows, the breadcrumb, the
// page header and All boards (BR1–BR9, BR41, BR47, BF-7).

const sidebar = (page: Page) =>
  page.getByRole("navigation", { name: "Main navigation" });
const crumbs = (page: Page) =>
  page.getByRole("navigation", { name: "breadcrumb" });

test("a department's Announcements row opens its board by department, and a Board link to it is replaced in place", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await installBoardDirectory(page);
  const postId = "00000000-0000-4000-8000-000000000041";
  await page.goto("/platform?section=search");
  await page.goto(
    `/boards?board=${directoryIds.sales}&section=posts&post=${postId}&keep=chosen`,
  );
  // The shell reads the address alone: the department, never the Board id.
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("department") === directoryIds.salesDepartment &&
      !url.searchParams.has("board") &&
      url.searchParams.get("section") === "posts" &&
      url.searchParams.get("post") === postId &&
      url.searchParams.get("keep") === "chosen",
  );
  // The post link still opens its post; this one is not on the board.
  await expect(
    page.getByRole("article", { name: "This post is not available." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "Sales announcements" }),
  ).toBeVisible();
  const salesPages = sidebar(page).getByRole("list", { name: "Sales pages" });
  await expect(salesPages.getByRole("link")).toHaveText([
    "Dashboard",
    "Announcements",
    "Contacts",
  ]);
  const row = salesPages.getByRole("link", { name: "Announcements" });
  await expect(row).toHaveAttribute(
    "href",
    `/boards?department=${directoryIds.salesDepartment}`,
  );
  await expect(row).toHaveAttribute("aria-current", "page");
  await expect(crumbs(page)).toHaveText(/^Sales\s*Announcements$/);
  // A department's board is not a Boards row, so that group stays closed.
  await expect(
    sidebar(page).getByRole("link", { name: "Company", exact: true }),
  ).toHaveCount(0);
  // The replace kept one history entry: Back leaves Boards.
  await page.goBack();
  await expect(page).toHaveURL(/\/platform\?section=search$/);
});

test("the Boards group lists My calendar, Company, the active project boards by name and All boards, read once", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  const directory = await installBoardDirectory(page);
  await page.goto("/platform?section=search");
  const nav = sidebar(page);
  await expect(
    nav.getByRole("button", { name: "Boards", exact: true }),
  ).toBeVisible();
  await nav.getByRole("button", { name: "Boards", exact: true }).click();
  const rows = nav.getByRole("list", { name: "Boards" });
  await expect(rows.getByRole("link")).toHaveText([
    "My calendar",
    "Company",
    "Customer Renewal",
    "Fleet Reliability",
    "All boards",
  ]);
  await expect(rows.getByRole("link", { name: "My calendar" })).toHaveAttribute(
    "href",
    "/boards?section=my-calendar",
  );
  await expect(rows.getByRole("link", { name: "Company" })).toHaveAttribute(
    "href",
    "/boards",
  );
  await expect(
    rows.getByRole("link", { name: "Fleet Reliability" }),
  ).toHaveAttribute("href", `/boards?board=${directoryIds.fleet}`);
  await expect(rows.getByRole("link", { name: "All boards" })).toHaveAttribute(
    "href",
    "/boards?section=all",
  );
  await rows.getByRole("link", { name: "Fleet Reliability" }).click();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Fleet Reliability announcements",
    }),
  ).toBeVisible();
  await expect(
    rows.getByRole("link", { name: "Fleet Reliability" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(crumbs(page)).toHaveText(/^Boards\s*Fleet Reliability$/);
  // The page reads the list the sidebar already holds.
  expect(directory.listQueries).toHaveLength(1);

  await rows.getByRole("link", { name: "Company" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Company announcements" }),
  ).toBeVisible();
  await expect(rows.getByRole("link", { name: "Company" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(crumbs(page)).toHaveText(/^Boards\s*Company$/);

  // The collapsed rail's Boards button opens the sidebar on the group.
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(rows).toHaveCount(0);
  await nav.getByRole("button", { name: "Boards", exact: true }).click();
  await expect(rows.getByRole("link", { name: "Company" })).toBeVisible();
});

test("a Board page has one header: the title, the level, one meta line, tabs and the tab's primary", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await installBoardDirectory(page);
  await page.goto("/boards?section=overview");
  // A retired Overview link opens Company's Posts.
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("section") === "posts" &&
      !url.searchParams.has("board"),
  );
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toHaveText("Company announcements");
  await expect(page.getByText("Manager", { exact: true })).toBeVisible();
  const tabs = page.getByRole("navigation", {
    name: "Company announcements views",
  });
  await expect(tabs.getByRole("link")).toHaveText([
    "Posts",
    "Calendar",
    "Kanban",
  ]);
  await expect(tabs.getByRole("link", { name: "Posts" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.getByRole("button", { name: "New post", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Board settings", exact: true }),
  ).toBeVisible();
  for (const gone of ["Board menu", "Refresh", "Switch board"])
    await expect(
      page.getByRole("button", { name: gone, exact: true }),
    ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { level: 2, name: "Posts", exact: true }),
  ).toHaveCount(0);

  await tabs.getByRole("link", { name: "Calendar" }).click();
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("section") === "calendar" &&
      !url.searchParams.has("board"),
  );
  await expect(
    page.getByRole("button", { name: "New event", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New post", exact: true }),
  ).toHaveCount(0);
});

test("All boards lists every readable board with its kind and level, searches, and shows archived boards", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  const directory = await installBoardDirectory(page);
  await page.goto("/boards?section=all");
  await expect(
    page.getByRole("heading", { level: 1, name: "All boards" }),
  ).toBeVisible();
  await expect(crumbs(page)).toHaveText(/^Boards\s*All boards$/);
  const list = page.getByRole("list", { name: "All boards", exact: true });
  await expect(list.getByRole("link")).toHaveCount(4);
  const sales = list.getByRole("link", { name: /^Sales/ });
  await expect(sales).toHaveAttribute(
    "href",
    `/boards?department=${directoryIds.salesDepartment}`,
  );
  await expect(sales).toContainText("Department");
  await expect(sales).toContainText("Manager");
  await expect(
    list.getByRole("link", { name: /^Fleet Reliability/ }),
  ).toContainText("Project");
  // No Board is open, so nothing reads one.
  expect(directory.detailReads).toEqual([]);

  await page.getByRole("searchbox", { name: "Search boards" }).fill("fleet");
  await expect(list.getByRole("link")).toHaveCount(1);
  await expect(list.getByRole("link")).toContainText("Fleet Reliability");
  expect(
    directory.listQueries.some(
      (query) => new URLSearchParams(query).get("search") === "fleet",
    ),
  ).toBe(true);
  await page.getByRole("searchbox", { name: "Search boards" }).fill("");
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(list.getByRole("link")).toHaveCount(1);
  await expect(list.getByRole("link")).toContainText("Spring Launch");

  await page
    .getByRole("button", { name: "New project board", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "New project Board" }),
  ).toBeVisible();
  for (const gone of ["Board type", "Board status"])
    await expect(page.getByRole("combobox", { name: gone })).toHaveCount(0);
});

test("only administrators are offered a new project board on All boards", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await installBoardDirectory(page, { level: "read" });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authMeBody({
        id: "00000000-0000-4000-8000-000000000012",
        role: "member",
        access: [],
        default_organization_blocked: null,
      }),
    }),
  );
  await page.goto("/boards?section=all");
  const list = page.getByRole("list", { name: "All boards", exact: true });
  await expect(list.getByRole("link", { name: /^Company/ })).toContainText(
    "Read",
  );
  await expect(
    page.getByRole("button", { name: "New project board", exact: true }),
  ).toHaveCount(0);
});

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
]) {
  test(`a Board page does not scroll the document at ${viewport.width}px; its panel scrolls`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await installBoardApi(page, () => true);
    const published = "2026-09-24T00:00:00Z";
    const posts = Array.from({ length: 12 }, (_, index) => ({
      id: `00000000-0000-4000-8000-0000000005${String(index).padStart(2, "0")}`,
      board_id: directoryIds.company,
      author_id: "00000000-0000-4000-8000-000000000012",
      title: `Shift note ${index + 1}`,
      body: "Shifts start at 7. Bring the dock keys and sign the rota.",
      links: [],
      status: "published",
      publish_at: published,
      expires_at: null,
      pinned: false,
      post_revision: null,
      board_revision: 1,
      publication_number: index + 1,
      published_at: published,
      edited: false,
      created_at: published,
      updated_at: published,
    }));
    await installBoardDirectory(page, {
      posts: { [directoryIds.company]: posts },
    });
    await page.goto("/boards");
    await expect(page.getByText("Shift note 12")).toBeAttached();
    const scroll = await page.evaluate(() => ({
      document: document.documentElement.scrollHeight - window.innerHeight,
      panel: [...document.querySelectorAll("main *")].some(
        (element) =>
          element.scrollHeight > element.clientHeight + 1 &&
          ["auto", "scroll"].includes(getComputedStyle(element).overflowY),
      ),
    }));
    expect(scroll).toEqual({ document: 0, panel: true });
  });
}

test("a cold /boards reads the board list and the open board once each, within 34 requests", async ({
  page,
}) => {
  // A live stream, so its connection is part of the cold load.
  await installOpenViewEventSource(page, { autoResync: true });
  await installBoardApi(page, () => true);
  const directory = await installBoardDirectory(page);
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/"))
      requests.push(`${request.method()} ${url.pathname}${url.search}`);
  });
  await page.goto("/boards");
  await expect(
    page.getByRole("heading", { level: 1, name: "Company announcements" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New post", exact: true }).first(),
  ).toBeVisible();
  // Count once the page stops reading: two polls in a row see no new request.
  let previous = -1;
  await expect
    .poll(
      () => {
        const settled = requests.length === previous;
        previous = requests.length;
        return settled;
      },
      { intervals: [500] },
    )
    .toBe(true);
  expect(directory.listQueries, requests.join("\n")).toHaveLength(1);
  expect(directory.detailReads, requests.join("\n")).toEqual([
    directoryIds.company,
  ]);
  await test.info().attach("cold /boards API requests", {
    body: `${requests.length}\n${requests.join("\n")}`,
    contentType: "text/plain",
  });
  expect(requests.length, requests.join("\n")).toBeLessThanOrEqual(34);
});

test("a refused board offers only the Company board; a failed read offers Retry", async ({
  page,
}) => {
  const refusedId = "00000000-0000-4000-8000-000000000029";
  await installServerBoards(page);
  await page.goto(`/boards?board=${refusedId}&section=posts`);
  const main = page.locator("#main-content");
  await expect(
    main.getByText("This board is not available.", { exact: true }),
  ).toBeVisible();
  await expect(
    main.getByText("It may have been removed, or you may not have access."),
  ).toBeVisible();
  await expect(
    main.getByRole("link", { name: "Go to Company board" }),
  ).toHaveAttribute("href", "/boards");
  await expect(main.getByRole("button", { name: "Retry" })).toHaveCount(0);

  // A temporary failure is not a refusal: Retry reads the board again.
  let failures = 1;
  await page.route(`**/api/boards/${boardId}`, (route) => {
    if (failures-- > 0)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Unavailable" }),
      });
    return route.fallback();
  });
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await expect(
    main.getByText("This board is not available.", { exact: true }),
  ).toHaveCount(0);
  await main.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Authorized operations announcements",
    }),
  ).toBeVisible();
});
