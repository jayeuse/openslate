import { expect, test, type Page } from "@playwright/test";

const boardId = "00000000-0000-4000-8000-000000000011";
const userId = "00000000-0000-4000-8000-000000000012";
const audienceRoleId = "00000000-0000-4000-8000-000000000014";
const board = {
  id: boardId,
  owner_id: userId,
  department_id: null,
  name: "Live operations board",
  description: "Current authorized workspace content",
  status: "active",
  default_section: "overview",
  revision: 1,
  created_at: "2026-09-23T00:00:00Z",
  updated_at: "2026-09-23T00:00:00Z",
};
const otherBoard = {
  ...board,
  id: "00000000-0000-4000-8000-000000000013",
  name: "Second live board",
  description: "Another authorized Board",
};

async function installBoardApi(page: Page, isAllowed: () => boolean) {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Not available in this route test" }),
    }),
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
    if (path === "/api/boards/personal")
      return reply(200, { favorite_board_ids: [], home_board_id: null });
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
      return reply(200, { view: true, edit: true, manage: true });
    if (path === `/api/boards/${boardId}/content-audience-targets`)
      return reply(200, {
        items: [{ id: audienceRoleId, label: "Operations" }],
        pagination: {
          limit: 25,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      });
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
    if (path === `/api/boards/${boardId}/announcement-authors`)
      return reply(200, [{ id: userId, label: "Current user" }]);
    if (path === `/api/boards/${boardId}/announcements`)
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
    if (
      path === `/api/boards/${boardId}/placements` ||
      path === `/api/boards/${boardId}/widgets`
    )
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
  await page.goto(`/boards?board=${boardId}&section=overview`);
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "New Board", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Create a Board" }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Create a Board" })
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Manage Board", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Manage Board" }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Manage Board" })
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Templates", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Board templates" }),
  ).toBeVisible();
});

test("read-only Boards viewers cannot open the announcement editor", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.route(`**/api/boards/${boardId}/my-access`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ view: true, edit: false, manage: false }),
    }),
  );
  const access = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/boards/${boardId}/my-access`,
  );
  await page.goto(`/boards?board=${boardId}&section=announcements`);
  await access;
  await expect(
    page.getByRole("heading", { name: "Published announcements", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New announcement", exact: true }),
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

test("Favorites only reflects a confirmed favorite removal without manual Refresh", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  let favorite = true;
  let rejectNextRemoval = true;
  await page.route("**/api/boards**", async (route) => {
    const url = new URL(route.request().url());
    const reply = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (url.pathname === "/api/boards/personal")
      return reply(200, {
        favorite_board_ids: favorite ? [boardId] : [],
        home_board_id: null,
      });
    if (
      url.pathname === "/api/boards" &&
      url.searchParams.get("favorites_only") === "true"
    ) {
      const items = favorite ? [board] : [];
      return reply(200, {
        items,
        pagination: {
          limit: 25,
          offset: 0,
          count: items.length,
          total: items.length,
          has_more: false,
        },
      });
    }
    if (
      url.pathname === `/api/boards/personal/favorites/${boardId}` &&
      route.request().method() === "PUT"
    ) {
      if (rejectNextRemoval) {
        rejectNextRemoval = false;
        return reply(500, { detail: "Preference not saved" });
      }
      favorite = false;
      return reply(200, { favorite_board_ids: [], home_board_id: null });
    }
    return route.fallback();
  });

  await page.goto(`/boards?board=${boardId}&section=overview`);
  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();
  await page.getByRole("button", { name: "Switch board" }).click();
  await page.getByRole("button", { name: "Favorites only" }).click();
  await expect(page.getByText("1 on this page · 1 accessible")).toBeVisible();
  await page.getByRole("button", { name: "Switch board" }).click();

  await page.getByRole("button", { name: "Board menu" }).click();
  await page.getByRole("menuitem", { name: "Remove from favorites" }).click();
  await expect(
    page.getByText("Board preferences could not be saved. Try again.").first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Switch board" }).click();
  await expect(page.getByText("1 on this page · 1 accessible")).toBeVisible();
  await page.getByRole("button", { name: "Switch board" }).click();

  await page.getByRole("button", { name: "Board menu" }).click();
  await page.getByRole("menuitem", { name: "Remove from favorites" }).click();
  await page.getByRole("button", { name: "Switch board" }).click();
  await expect(page.getByText("0 on this page · 0 accessible")).toBeVisible();
  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();
});

test("Favorites only refetches when enabled while a favorite removal is pending", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  let favorite = true;
  let confirmRemoval: () => void = () => undefined;
  const heldRemoval = new Promise<void>((resolve) => {
    confirmRemoval = resolve;
  });
  let markRemovalStarted: () => void = () => undefined;
  const removalStarted = new Promise<void>((resolve) => {
    markRemovalStarted = resolve;
  });
  await page.route("**/api/boards**", async (route) => {
    const url = new URL(route.request().url());
    const reply = (body: unknown) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (url.pathname === "/api/boards/personal")
      return reply({
        favorite_board_ids: favorite ? [boardId] : [],
        home_board_id: null,
      });
    if (
      url.pathname === "/api/boards" &&
      url.searchParams.get("favorites_only") === "true"
    ) {
      const items = favorite ? [board] : [];
      return reply({
        items,
        pagination: {
          limit: 25,
          offset: 0,
          count: items.length,
          total: items.length,
          has_more: false,
        },
      });
    }
    if (
      url.pathname === `/api/boards/personal/favorites/${boardId}` &&
      route.request().method() === "PUT"
    ) {
      markRemovalStarted();
      await heldRemoval;
      favorite = false;
      return reply({ favorite_board_ids: [], home_board_id: null });
    }
    return route.fallback();
  });

  await page.goto(`/boards?board=${boardId}&section=overview`);
  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();
  await page.getByRole("button", { name: "Board menu" }).click();
  await page.getByRole("menuitem", { name: "Remove from favorites" }).click();
  await removalStarted;

  await page.getByRole("button", { name: "Switch board" }).click();
  await page.getByRole("button", { name: "Favorites only" }).click();
  await expect(page.getByText("1 on this page · 1 accessible")).toBeVisible();
  confirmRemoval();
  await expect(page.getByText("0 on this page · 0 accessible")).toBeVisible();
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

test("Calendar uses Workspace today and reaches later occurrences for reminders", async ({
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
        audience: {
          kind: "everyone",
          role_id: null,
          user_id: null,
          department_id: null,
        },
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
  await page.route(`**/api/boards/${boardId}/reminders?**`, (route) =>
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
  let reminderOccurrence = "";
  await page.route(`**/api/boards/${boardId}/events/*/reminders`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const eventId = path.split("/").at(-2)!;
    const body = route.request().postDataJSON() as {
      occurrence_id: string;
      timing: string;
    };
    reminderOccurrence = body.occurrence_id;
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "00000000-0000-4000-8000-000000000999",
        event_id: eventId,
        occurrence_id: body.occurrence_id,
        timing: body.timing,
        occurrence_start_at: "2026-09-24T00:00:00Z",
        due_at: "2026-09-24T00:00:00Z",
        state: "pending",
      }),
    });
  });

  await page.goto(`/boards?board=${boardId}&section=calendar`);
  await expect(
    page.getByRole("heading", { name: "September 2026" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /View .*Sep 25/ }),
  ).toHaveAttribute("aria-current", "date");
  await page.getByRole("button", { name: "Load next 100 events" }).click();
  await expect(page.getByText("101 occurrences")).toBeVisible();
  await page.getByText("Add reminder", { exact: true }).click();
  await page.getByLabel("Event occurrence for reminder").selectOption(late.id);
  await page.getByLabel("Reminder timing").selectOption("now");
  await page.getByRole("button", { name: "Save reminder" }).click();
  await expect(
    page.getByText("Reminder saved for this occurrence."),
  ).toBeVisible();
  expect(reminderOccurrence).toBe(late.id);
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

test("announcement editor retains a canceled close and discards only on confirmation", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=announcements`);
  await page
    .getByRole("button", { name: "New announcement", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Announcement editor",
    exact: true,
  });
  await editor.getByLabel("Title", { exact: true }).fill("Draft to keep");
  await editor
    .getByRole("button", { name: "Close announcement editor" })
    .click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Discard unsaved announcement changes?",
  });
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(editor.getByLabel("Title", { exact: true })).toHaveValue(
    "Draft to keep",
  );
  await editor
    .getByRole("button", { name: "Close announcement editor" })
    .click();
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

test("Announcement editor requires a selected active role before saving", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=announcements`);
  await page.getByRole("button", { name: "New announcement" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Operations update");
  await page.getByLabel("Message").fill("Read the latest instructions.");
  await page.getByRole("combobox", { name: "Audience" }).selectOption("role");
  await expect(page.getByRole("button", { name: "Save draft" })).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Role", exact: true })
    .selectOption(audienceRoleId);
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled();
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
    audience: {
      kind: "author",
      role_id: null,
      user_id: null,
      department_id: null,
    },
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
