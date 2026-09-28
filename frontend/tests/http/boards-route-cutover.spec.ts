import { expect, test, type Page } from "./helpers/test";

const boardId = "00000000-0000-4000-8000-000000000011";
const userId = "00000000-0000-4000-8000-000000000012";
const board = {
  id: boardId,
  scope: "project",
  department_id: null,
  name: "Live operations board",
  description: "Current authorized workspace content",
  status: "active",
  revision: 1,
  level: "manage",
  created_at: "2026-09-23T00:00:00Z",
  updated_at: "2026-09-23T00:00:00Z",
};
const otherBoard = {
  ...board,
  id: "00000000-0000-4000-8000-000000000013",
  name: "Second live board",
  description: "Another authorized Board",
};

const managerAccess = {
  level: "manage",
  read: true,
  write: true,
  manage: true,
};
const readerAccess = { level: "read", read: true, write: false, manage: false };

async function installBoardApi(page: Page, isAllowed: () => boolean) {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Not available in this route test" }),
    }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { id: userId, role: "admin", access: [] } }),
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: userId,
        setup_required: false,
      }),
    }),
  );
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ today: "2026-09-25" }),
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
  await page.route("**/api/boards**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const reply = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/boards")
      return reply(200, {
        items: [board, otherBoard],
        pagination: {
          limit: 25,
          offset: 0,
          count: 2,
          total: 2,
          has_more: false,
        },
      });
    if (path === `/api/boards/${boardId}/my-access`)
      return reply(200, managerAccess);
    if (path === `/api/boards/${boardId}/events/occurrences`)
      return reply(200, {
        items: [],
        pagination: {
          limit: 100,
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
        board_revision: 1,
      });
    if (path === `/api/boards/${boardId}/post-authors`)
      return reply(200, [{ id: userId, label: "Current user" }]);
    if (path === `/api/boards/${boardId}/posts`)
      return reply(200, {
        items: [],
        pagination: {
          limit: 25,
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
        board_revision: 1,
      });
    if (path === `/api/boards/${boardId}/widgets`)
      return reply(200, {
        items: [],
        pagination: {
          limit: 25,
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
        board_revision: 1,
      });
    if (path === `/api/boards/${boardId}`)
      return isAllowed()
        ? reply(200, board)
        : reply(404, { detail: "Board not found" });
    if (path === `/api/boards/${otherBoard.id}`) return reply(200, otherBoard);
    return reply(404, { detail: "Not available in this route test" });
  });
}

test("Board menu keeps administration reachable without crowding the section", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.route(`**/api/boards/${boardId}/groups`, (route) =>
    route.fulfill({
      json: { board_id: boardId, revision: 1, groups: [] },
    }),
  );
  await page.goto(`/boards?board=${boardId}&section=overview`);
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "New project Board", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "New project Board" }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "New project Board" })
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await expect(
    page.getByRole("menuitem", {
      name: /Manage access|Templates|favorites|home board/,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("menuitem", { name: "Manage Board and groups", exact: true })
    .click();
  const manage = page.getByRole("dialog", { name: "Manage Board" });
  await expect(manage).toBeVisible();
  await expect(
    manage.getByText("No groups yet. Only administrators open this Board."),
  ).toBeVisible();
  await manage
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Configurations", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Board configurations" }),
  ).toBeVisible();
});

test("a member reading a Board sees no Board menu and no manager actions", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { id: userId, role: "member", access: [] } }),
  );
  const reader = { ...board, level: "read" };
  await page.route(`**/api/boards/${boardId}`, (route) =>
    route.fulfill({ json: reader }),
  );
  await page.route(`**/api/boards/${boardId}/my-access`, (route) =>
    route.fulfill({ json: readerAccess }),
  );
  await page.goto(`/boards?board=${boardId}&section=overview`);
  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Board menu", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Manage widgets" }),
  ).toHaveCount(0);
});

test("read-only Boards viewers cannot open the post editor", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.route(`**/api/boards/${boardId}/my-access`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(readerAccess),
    }),
  );
  const access = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/boards/${boardId}/my-access`,
  );
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await access;
  await expect(
    page.getByRole("heading", { name: "Published posts", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New post", exact: true }),
  ).toHaveCount(0);
});

test("visible Boards route opens authorized server Board and keeps section URL", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=overview`);

  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();
  await expect(page.getByText(board.description)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Switch board" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Link a record" })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Reminders and Board files are unavailable"),
  ).toHaveCount(0);

  await page.getByRole("link", { name: "Calendar", exact: true }).click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/boards" &&
      url.searchParams.get("board") === boardId &&
      url.searchParams.get("section") === "calendar",
  );
  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();
});

test("visible Boards route clears the last Board when access is revoked", async ({
  page,
}) => {
  let allowed = true;
  await installBoardApi(page, () => allowed);
  await page.goto(`/boards?board=${boardId}&section=overview`);
  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();

  allowed = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("Board unavailable. Choose another Board or retry."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: board.name })).toHaveCount(0);
  await expect(page.getByText(board.description)).toHaveCount(0);
});

test("the Board type filter asks the server for that scope", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=overview`);
  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();
  await page.getByRole("button", { name: "Switch board" }).click();
  const listed = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/boards" &&
      new URL(request.url()).searchParams.get("scope") === "department",
  );
  await page.getByRole("combobox", { name: "Board type" }).click();
  await page.getByRole("option", { name: "Departments" }).click();
  await listed;
});

test("unsaved Event draft asks before changing Board or section", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=calendar`);
  await page.getByRole("button", { name: "New event" }).click();
  await expect(page.getByRole("heading", { name: "New event" })).toBeVisible();

  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page).toHaveURL(`/boards?board=${boardId}&section=calendar`);
  await expect(
    page.getByRole("alertdialog", { name: "Discard unsaved Board changes?" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New event" })).toBeVisible();
  await page.getByRole("button", { name: "Switch board" }).click();
  await page.getByRole("combobox", { name: "Board", exact: true }).click();
  await page.getByRole("option", { name: /Second live board/ }).click();
  await expect(page).toHaveURL(`/boards?board=${boardId}&section=calendar`);
  await expect(
    page.getByRole("alertdialog", { name: "Discard unsaved Board changes?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(page).toHaveURL(
    `/boards?board=${otherBoard.id}&section=overview`,
  );
  await expect(page.getByRole("heading", { name: "New event" })).toHaveCount(0);
});

test("Calendar uses Workspace today and reaches later occurrences", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  const occurrence = (index: number) => {
    const eventId = `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`;
    return {
      id: `${eventId}:2026-09-24`,
      event_id: eventId,
      start: "2026-09-24",
      end: "2026-09-24",
      date: "2026-09-24",
      event: {
        id: eventId,
        board_id: boardId,
        author_id: userId,
        title: index === 100 ? "Late occurrence" : `Earlier ${index + 1}`,
        details: "",
        location: "",
        links: [],
        all_day: true,
        start_date: "2026-09-24",
        end_date: "2026-09-24",
        start_at: null,
        end_at: null,
        timezone_name: "Asia/Manila",
        recurrence: "none",
        repeat_until: null,
        reminders: [],
        archived: false,
        revision: 1,
        board_revision: 1,
        created_at: "2026-09-23T00:00:00Z",
        updated_at: "2026-09-23T00:00:00Z",
      },
    };
  };
  const first = Array.from({ length: 100 }, (_, index) => occurrence(index));
  const late = occurrence(100);
  const requests: Array<{
    offset: string | null;
    search: string | null;
    start: string | null;
  }> = [];
  await page.route(
    `**/api/boards/${boardId}/events/occurrences?**`,
    (route) => {
      const url = new URL(route.request().url());
      const offset = url.searchParams.get("offset");
      const search = url.searchParams.get("search");
      requests.push({
        offset,
        search,
        start: url.searchParams.get("window_start"),
      });
      const items =
        search === "missing" ||
        url.searchParams.get("window_start") === "2026-10-01"
          ? []
          : offset === "100"
            ? [late]
            : first;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items,
          pagination: {
            limit: 100,
            offset: Number(offset),
            count: items.length,
            total: items.length === 0 ? 0 : 101,
            has_more: items.length === 100,
          },
          board_revision: 1,
        }),
      });
    },
  );
  await page.goto(`/boards?board=${boardId}&section=calendar`);
  await expect(
    page.getByRole("heading", { name: "September 2026" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /View .*Sep 25/ }),
  ).toHaveAttribute("aria-current", "date");
  await page.getByRole("button", { name: "Load next 100 events" }).click();
  await expect(page.getByText("101 occurrences")).toBeVisible();
  expect(requests.some((item) => item.offset === "100")).toBe(true);
  await page.getByLabel("Search events").fill("missing");
  await expect(page.getByText("No events on this day.")).toBeVisible();
  expect(requests.some((item) => item.search === "missing")).toBe(true);
  await page.getByLabel("Search events").fill("");
  await expect(
    page.getByRole("button", { name: "Load next 100 events" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(
    page.getByRole("heading", { name: "October 2026" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Today" }).click();
  await expect(
    page.getByRole("heading", { name: "September 2026" }),
  ).toBeVisible();
  expect(requests.some((item) => item.start === "2026-10-01")).toBe(true);
});

test("compact Calendar enters Agenda and permits manual Month selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=calendar`);
  await expect(page.getByRole("button", { name: "Agenda" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Month", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("post editor retains a canceled close and discards only on confirmation", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await page.getByRole("button", { name: "New post", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "Post editor",
    exact: true,
  });
  await editor.getByLabel("Title", { exact: true }).fill("Draft to keep");
  await editor.getByRole("button", { name: "Close post editor" }).click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Discard unsaved post changes?",
  });
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(editor.getByLabel("Title", { exact: true })).toHaveValue(
    "Draft to keep",
  );
  await editor.getByRole("button", { name: "Close post editor" }).click();
  await confirmation
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(editor).toBeHidden();
  await page.getByRole("button", { name: "Switch board" }).click();
  await page.getByRole("combobox", { name: "Board", exact: true }).click();
  await page.getByRole("option", { name: /Second live board/ }).click();
  await expect(page).toHaveURL(
    `/boards?board=${otherBoard.id}&section=overview`,
  );
});

test("the post editor has no audience choice", async ({ page }) => {
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await page.getByRole("button", { name: "New post" }).click();
  const editor = page.getByRole("dialog", { name: "Post editor", exact: true });
  await expect(editor.getByLabel("Title", { exact: true })).toBeVisible();
  await expect(editor.getByRole("combobox", { name: "Audience" })).toHaveCount(
    0,
  );
});

test("an author sets reminder timings on a new event", async ({ page }) => {
  await installBoardApi(page, () => true);
  let created: Record<string, unknown> | null = null;
  await page.route(`**/api/boards/${boardId}/events`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    created = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      status: 201,
      json: {
        id: "00000000-0000-4000-8000-000000000016",
        event_revision: 1,
        board_revision: 2,
      },
    });
  });
  await page.goto(`/boards?board=${boardId}&section=calendar`);
  await page.getByRole("button", { name: "New event" }).click();
  const editor = page.getByRole("form", { name: "Create Board event" });
  await editor.getByLabel("Event title").fill("Shift handover");
  await expect(editor.getByText("Reminders", { exact: true })).toBeVisible();
  await editor.getByRole("checkbox", { name: "1 day before" }).click();
  await editor.getByRole("checkbox", { name: "When it starts" }).click();
  await editor.getByRole("button", { name: "Create event" }).click();
  await expect.poll(() => created).not.toBeNull();
  expect(created).toMatchObject({
    title: "Shift handover",
    reminders: ["1d", "start"],
  });
  expect(created).not.toHaveProperty("audience");
});

test("My events refreshes after saving and when the current tab reselects it", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  const eventId = "00000000-0000-4000-8000-000000000015";
  let title = "My planning meeting";
  let revision = 1;
  let listRequests = 0;
  const event = () => ({
    id: eventId,
    board_id: boardId,
    author_id: userId,
    title,
    details: "",
    location: "",
    links: [],
    all_day: true,
    start_date: "2026-09-25",
    end_date: "2026-09-25",
    start_at: null,
    end_at: null,
    timezone_name: "UTC",
    recurrence: "none",
    repeat_until: null,
    reminders: [],
    archived: false,
    revision,
    board_revision: 1,
    created_at: "2026-09-25T00:00:00Z",
    updated_at: "2026-09-25T00:00:00Z",
  });
  await page.route("**/api/boards/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/boards/${boardId}/events/mine`) {
      listRequests += 1;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [event()],
          pagination: {
            limit: 25,
            offset: 0,
            count: 1,
            total: 1,
            has_more: false,
          },
          board_revision: 1,
        }),
      });
    }
    if (
      path === `/api/boards/${boardId}/events/${eventId}` &&
      route.request().method() === "PATCH"
    ) {
      const body = route.request().postDataJSON() as { title: string };
      title = body.title;
      revision += 1;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: eventId,
          event_revision: revision,
          board_revision: 2,
        }),
      });
    }
    return route.fallback();
  });

  await page.goto(`/boards?board=${boardId}&section=calendar`);
  await page.getByRole("button", { name: "Event lists" }).click();
  await page.getByRole("menuitem", { name: "My events" }).click();
  const myEvents = page.getByRole("region", { name: "My events" });
  await myEvents
    .getByRole("button", { name: "Edit My planning meeting" })
    .click();
  const editor = page.getByRole("form", { name: "Edit Board event" });
  await editor.getByLabel("Event title").fill("My planning meeting updated");
  await editor.getByRole("button", { name: "Save event" }).click();
  await expect(
    myEvents.getByRole("button", { name: "Edit My planning meeting updated" }),
  ).toBeVisible();

  const beforeReselect = listRequests;
  title = "My planning meeting externally updated";
  await page.getByRole("button", { name: "Event lists" }).click();
  await page.getByRole("menuitem", { name: "My events" }).click();
  await expect(
    myEvents.getByRole("button", {
      name: "Edit My planning meeting externally updated",
    }),
  ).toBeVisible();
  expect(listRequests).toBeGreaterThan(beforeReselect);
});
