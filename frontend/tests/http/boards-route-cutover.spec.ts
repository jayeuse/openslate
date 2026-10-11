import { expect, test } from "./helpers/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import {
  authorAccess,
  board,
  boardId,
  installBoardApi,
  otherBoard,
  readerAccess,
  userId,
} from "./helpers/boards-api";
import { pageOf } from "./helpers/openview-catalog";

test("Board menu keeps administration reachable without crowding the section", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.route(`**/api/boards/${boardId}/groups`, (route) =>
    route.fulfill({
      json: { board_id: boardId, revision: 1, groups: [] },
    }),
  );
  await page.route("**/api/access/groups?**", (route) =>
    route.fulfill({
      json: pageOf([], { limit: 25 }),
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
          ...pageOf(items, {
            limit: 100,
            offset: Number(offset),
            total: items.length === 0 ? 0 : 101,
            hasMore: items.length === 100,
          }),
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

test.describe("Boards workspace regional activity", () => {
  test.use({ locale: "en-US", timezoneId: "UTC" });
  test("Board activity retains its timezone label while formatting the workspace timestamp", async ({
    page,
  }) => {
    await installBoardApi(page, () => true);
    await page.route("**/api/workspace", (route) =>
      route.fulfill({
        json: {
          display_name: "OpenSlate",
          mark: "OS",
          logo_file_id: null,
          revision: 1,
          today: "2026-09-25",
          week_start: "monday",
          locale: "fr-FR",
          timezone: "America/Los_Angeles",
        },
      }),
    );
    await page.route(`**/api/boards/${boardId}/activity?**`, (route) =>
      route.fulfill({
        json: pageOf(
          [
            {
              id: "00000000-0000-4000-8000-000000000199",
              created_at: "2026-09-23T00:00:00Z",
              kind: "board",
              action: "update",
              summary: "Regional activity",
              actor_label: "Regional test actor",
            },
          ],
          { limit: 25 },
        ),
      }),
    );
    await page.goto(`/boards?board=${boardId}&section=posts`);
    await page.getByRole("button", { name: "Board menu", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "View activity", exact: true })
      .click();
    const activity = page.getByRole("dialog", {
      name: "Board activity",
      exact: true,
    });
    await expect(
      activity.getByText("Regional activity", { exact: true }),
    ).toBeVisible();
    await expect(activity.locator("time")).toHaveText(
      /22 sept\. 2026.*17:00.*(?:UTC|GMT).*7/,
    );
  });

  test("Calendar main Refresh replaces a held cold workspace read", async ({
    page,
  }) => {
    await installOpenViewEventSource(page);
    await installBoardApi(page, () => true);
    let workspaceReads = 0;
    let oldReleased = false;
    let releaseOld!: () => void;
    let markFirstStarted!: () => void;
    let markOldDelivered!: () => void;
    let markOldSettled!: () => void;
    const heldOld = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const oldDelivered = new Promise<void>((resolve) => {
      markOldDelivered = resolve;
    });
    const oldSettled = new Promise<void>((resolve) => {
      markOldSettled = resolve;
    });
    await page.route("**/api/workspace", async (route) => {
      const read = ++workspaceReads;
      if (read === 1) {
        const oldRequest = route.request();
        page.on("requestfinished", (request) => {
          if (request !== oldRequest) return;
          markOldSettled();
        });
        page.on("requestfailed", (request) => {
          if (request !== oldRequest) return;
          markOldSettled();
        });
        markFirstStarted();
        await heldOld;
        try {
          await route.fulfill({
            json: {
              display_name: "OpenSlate",
              mark: "OS",
              logo_file_id: null,
              revision: 1,
              today: "2026-09-25",
              week_start: "monday",
              locale: "en-US",
              timezone: "UTC",
            },
          });
        } catch {
          // The page can abandon the old read; only its effect on the day is under test.
        } finally {
          markOldDelivered();
        }
        return;
      }
      await route.fulfill({
        json: {
          display_name: "OpenSlate",
          mark: "OS",
          logo_file_id: null,
          revision: 1,
          today: "2026-09-26",
          week_start: "monday",
          locale: "en-US",
          timezone: "UTC",
        },
      });
    });
    try {
      await page.goto(`/boards?board=${boardId}&section=calendar`);
      await firstStarted;
      await expect(
        page.getByRole("heading", { name: board.name, exact: true }),
      ).toBeVisible();
      const refresh = page.getByRole("button", {
        name: "Refresh",
        exact: true,
      });
      await expect(refresh).toBeEnabled();
      await refresh.click();
      await expect.poll(() => workspaceReads).toBeGreaterThan(1);
      const latest = page.getByRole("button", { name: /View .*Sep 26/ });
      await expect(latest).toHaveAttribute("aria-current", "date");
      oldReleased = true;
      releaseOld();
      await Promise.all([oldDelivered, oldSettled]);
      await expect(latest).toHaveAttribute("aria-current", "date");
    } finally {
      if (!oldReleased) {
        oldReleased = true;
        releaseOld();
      }
    }
  });

  test("Calendar manual Refresh and rollover keep the selected day and last-good settings", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-09-25T12:00:00Z") });
    await installBoardApi(page, () => true);
    let today = "2026-09-25";
    let failRegionalRead = false;
    await page.route("**/api/workspace", (route) =>
      failRegionalRead
        ? route.fulfill({ status: 503, json: { detail: "Unavailable" } })
        : route.fulfill({
            json: {
              display_name: "OpenSlate",
              mark: "OS",
              logo_file_id: null,
              revision: 1,
              today,
              week_start: "monday",
              locale: "en-US",
              timezone: "UTC",
            },
          }),
    );
    await page.goto(`/boards?board=${boardId}&section=calendar`);
    const chosen = page.getByRole("button", { name: /View .*Sep 27/ });
    await chosen.click();
    today = "2026-09-26";
    const refresh = page.getByRole("button", { name: "Refresh", exact: true });
    await refresh.click();
    await expect(
      page.getByRole("button", { name: /View .*Sep 26/ }),
    ).toHaveAttribute("aria-current", "date");
    await expect(chosen).toHaveAttribute("aria-pressed", "true");
    failRegionalRead = true;
    today = "2026-09-27";
    await refresh.click();
    const retry = page.getByRole("button", {
      name: "Retry Workspace date",
      exact: true,
    });
    await expect(retry).toBeVisible();
    await expect(
      page.getByRole("button", { name: /View .*Sep 26/ }),
    ).toHaveAttribute("aria-current", "date");
    await expect(chosen).toHaveAttribute("aria-pressed", "true");
    failRegionalRead = false;
    await retry.click();
    await expect(chosen).toHaveAttribute("aria-current", "date");
    today = "2026-09-28";
    await page.clock.runFor(60_000);
    await expect(
      page.getByRole("button", { name: /View .*Sep 28/ }),
    ).toHaveAttribute("aria-current", "date");
    await expect(chosen).toHaveAttribute("aria-pressed", "true");
  });
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

test("a live refresh keeps an open post draft mounted and editable", async ({
  page,
}) => {
  await installOpenViewEventSource(page);
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await page.getByRole("button", { name: "New post", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "Post editor",
    exact: true,
  });
  const title = editor.getByLabel("Title", { exact: true });
  await title.fill("Draft");

  // Hold the editor's access re-check so the live refresh stays in flight.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(`**/api/boards/${boardId}/my-access`, async (route) => {
    started();
    await held;
    await route.fallback();
  });
  await sendOpenViewEvent(page, "resync");
  await begun;

  // The form stays mounted and focused, and typing continues mid-refresh.
  await expect(title).toBeFocused();
  await title.press("End");
  await title.pressSequentially(" to keep");
  release();
  await expect(title).toHaveValue("Draft to keep");
  await expect(
    editor.getByText("Loading editable posts…", { exact: true }),
  ).toHaveCount(0);
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
          ...pageOf([event()], { limit: 25 }),
          board_revision: 1,
        }),
      });
    }
    // A background resync re-reads the event under an open editor.
    if (
      path === `/api/boards/${boardId}/events/${eventId}` &&
      route.request().method() === "GET"
    )
      return route.fulfill({ json: event() });
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

test("an event author can archive their event, while another author's event stays protected", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installBoardApi(page, () => true, authorAccess);
  const eventId = "00000000-0000-4000-8000-000000000031";
  const otherEventId = "00000000-0000-4000-8000-000000000032";
  const otherAuthorId = "00000000-0000-4000-8000-000000000033";
  const event = (
    id: string,
    authorId: string,
    title: string,
    boardRevision: number,
  ) => ({
    id,
    board_id: boardId,
    author_id: authorId,
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
    revision: 1,
    board_revision: boardRevision,
    created_at: "2026-09-25T00:00:00Z",
    updated_at: "2026-09-25T00:00:00Z",
  });
  const occurrence = (
    id: string,
    title: string,
    authorId: string,
    boardRevision: number,
  ) => ({
    id: `${id}:2026-09-25`,
    event_id: id,
    start: "2026-09-25",
    end: "2026-09-25",
    date: "2026-09-25",
    event: event(id, authorId, title, boardRevision),
  });
  let archived = false;
  let archiveAttempts = 0;
  let archiveBody: unknown = null;
  await page.route(
    `**/api/boards/${boardId}/events/occurrences?**`,
    (route) => {
      const boardRevision = archived ? 2 : 1;
      const items = [
        ...(!archived
          ? [occurrence(eventId, "My planning session", userId, boardRevision)]
          : []),
        occurrence(
          otherEventId,
          "Team planning session",
          otherAuthorId,
          boardRevision,
        ),
      ];
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...pageOf(items, { limit: 100 }),
          board_revision: boardRevision,
        }),
      });
    },
  );
  await page.route(
    `**/api/boards/${boardId}/events/${eventId}/archive`,
    async (route) => {
      archiveBody = route.request().postDataJSON();
      archiveAttempts++;
      if (archiveAttempts === 1)
        return route.fulfill({
          status: 409,
          json: {
            detail: {
              code: "stale_revision",
              message: "Private event implementation detail",
            },
          },
        });
      archived = true;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: eventId,
          event_revision: 2,
          board_revision: 2,
        }),
      });
    },
  );

  await page.goto(`/boards?board=${boardId}&section=calendar`);
  const selectedEvents = page.getByRole("region", {
    name: "Fri, Sep 25 events",
  });
  await selectedEvents.getByText("View event", { exact: true }).nth(0).click();
  await selectedEvents.getByText("View event", { exact: true }).nth(1).click();
  await expect(
    selectedEvents.getByRole("button", {
      name: "Archive My planning session",
    }),
  ).toBeVisible();
  await expect(
    selectedEvents.getByRole("button", {
      name: "Archive Team planning session",
    }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Agenda", exact: true }).click();
  const agendaEvents = page.getByRole("region", {
    name: "September 2026 events",
  });
  await expect(
    agendaEvents.getByRole("button", {
      name: "Archive My planning session",
    }),
  ).toBeVisible();
  await expect(
    agendaEvents.getByRole("button", {
      name: "Archive Team planning session",
    }),
  ).toHaveCount(0);
  await agendaEvents
    .getByRole("button", { name: "Archive My planning session" })
    .click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Archive event?",
  });
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole("button", { name: "Archive event", exact: true })
    .click();
  await expect(confirmation).toBeVisible();
  const actionFailure = confirmation.getByRole("alert");
  await expect(actionFailure).toContainText("changed");
  await expect(actionFailure).toHaveAttribute("data-variant", "destructive");
  await expect(
    page.getByText("Private event implementation detail"),
  ).toHaveCount(0);
  const archivedResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/boards/${boardId}/events/${eventId}/archive` &&
      response.request().method() === "POST",
  );
  await confirmation
    .getByRole("button", { name: "Archive event", exact: true })
    .click();
  const response = await archivedResponse;
  expect(response.status()).toBe(200);
  await expect(page.getByText("Event archived.")).toBeVisible();
  await expect(
    agendaEvents.getByRole("button", {
      name: "Archive My planning session",
    }),
  ).toHaveCount(0);
  expect(archiveBody).toEqual({ board_revision: 1, event_revision: 1 });
});

test("Board Record link labels refresh after linked module invalidations", async ({
  page,
}) => {
  await installBoardApi(page, () => true, readerAccess);
  const eventId = "00000000-0000-4000-8000-000000000051";
  const recordId = "00000000-0000-4000-8000-000000000052";
  const moduleId = "00000000-0000-4000-8000-000000000053";
  const linkId = "00000000-0000-4000-8000-000000000054";
  let label = "Cooling manifold";
  let linkRequests = 0;

  await page.addInitScript(() => {
    const sources: EventTarget[] = [];
    class TestEventSource extends EventTarget {
      constructor(readonly url: string) {
        super();
        sources.push(this);
      }

      close() {}
    }
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: TestEventSource,
    });
    Object.defineProperty(window, "__boardTestEventSources", {
      configurable: true,
      value: sources,
    });
  });

  await page.route(`**/api/boards/${boardId}/events/occurrences?**`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...pageOf(
          [
            {
              id: `${eventId}:2026-09-25`,
              event_id: eventId,
              start: "2026-09-25",
              end: "2026-09-25",
              date: "2026-09-25",
              event: {
                id: eventId,
                board_id: boardId,
                author_id: userId,
                title: "Equipment handover",
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
                revision: 1,
                board_revision: 1,
                created_at: "2026-09-25T00:00:00Z",
                updated_at: "2026-09-25T00:00:00Z",
              },
            },
          ],
          { limit: 100 },
        ),
        board_revision: 1,
      }),
    }),
  );
  await page.route(
    `**/api/boards/${boardId}/events/${eventId}/record-links?**`,
    (route) => {
      linkRequests += 1;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: linkId,
              record_id: recordId,
              module_id: moduleId,
              label,
              available: true,
              url: `/openview?module=${moduleId}&record=${recordId}`,
            },
          ],
          limit: 20,
          offset: 0,
          has_more: false,
        }),
      });
    },
  );

  await page.goto(`/boards?board=${boardId}&section=calendar`);
  const selectedEvents = page.getByRole("region", {
    name: "Fri, Sep 25 events",
  });
  await selectedEvents.getByText("View event", { exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Cooling manifold" }),
  ).toBeVisible();
  await expect.poll(() => linkRequests).toBeGreaterThan(0);
  const beforeInvalidation = linkRequests;

  label = "Cooling manifold updated";
  await page.evaluate((targetModuleId) => {
    type EventWindow = Window & {
      __boardTestEventSources?: EventTarget[];
    };
    const source = (window as EventWindow).__boardTestEventSources?.[0];
    source?.dispatchEvent(
      new MessageEvent("invalidate", {
        data: JSON.stringify({ entity: "records", module_id: targetModuleId }),
      }),
    );
  }, moduleId);

  await expect.poll(() => linkRequests).toBeGreaterThan(beforeInvalidation);
  await expect(
    page.getByRole("link", { name: "Cooling manifold updated" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Cooling manifold", exact: true }),
  ).toHaveCount(0);

  const beforeEligibilityInvalidation = linkRequests;
  label = "Record title after eligibility change";
  await page.evaluate((targetModuleId) => {
    type EventWindow = Window & {
      __boardTestEventSources?: EventTarget[];
    };
    const source = (window as EventWindow).__boardTestEventSources?.[0];
    source?.dispatchEvent(
      new MessageEvent("invalidate", {
        data: JSON.stringify({
          entity: "group_access",
          module_id: targetModuleId,
        }),
      }),
    );
  }, moduleId);

  await expect
    .poll(() => linkRequests)
    .toBeGreaterThan(beforeEligibilityInvalidation);
  await expect(
    page.getByRole("link", { name: "Record title after eligibility change" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Cooling manifold updated", exact: true }),
  ).toHaveCount(0);
});

test("Board record widgets refresh user labels after eligibility invalidation", async ({
  page,
}) => {
  const moduleId = "00000000-0000-4000-8000-000000000061";
  const widgetId = "00000000-0000-4000-8000-000000000062";
  const assigneeFieldId = "00000000-0000-4000-8000-000000000063";
  const assigneeId = "00000000-0000-4000-8000-000000000064";
  await installBoardApi(page, () => true, readerAccess);
  await installOpenViewEventSource(page);
  let assigneeLabel = "Alex Reader";
  let recordQueries = 0;

  await page.route(`**/api/boards/${boardId}/widgets**`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...pageOf(
          [
            {
              id: widgetId,
              board_id: boardId,
              name: "Assignment queue",
              widget_type: "records",
              module_id: moduleId,
              position: 0,
              size: "M",
              pinned: false,
              chart_id: null,
              config: {
                version: 1,
                fields: [{ field_id: assigneeFieldId, expected_type: "user" }],
                filters: [],
                logic: "and",
                metric: null,
                visualization: "bar",
                refresh: "manual",
              },
              created_at: "2026-09-25T00:00:00Z",
              updated_at: "2026-09-25T00:00:00Z",
            },
          ],
          { limit: 12 },
        ),
        board_revision: 1,
      }),
    }),
  );
  await page.route(`**/api/fields/${assigneeFieldId}`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: assigneeFieldId,
        module_id: moduleId,
        name: "Assignee",
        type: "user",
        required: false,
        position: 0,
        config: { kind: "user" },
        is_deleted: false,
      }),
    }),
  );
  await page.route("**/api/records/query", (route) => {
    recordQueries += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        pageOf(
          [
            {
              id: "00000000-0000-4000-8000-000000000065",
              module_id: moduleId,
              data: { [assigneeFieldId]: assigneeId },
              display_values: { [assigneeFieldId]: assigneeLabel },
              created_at: "2026-09-25T00:00:00Z",
              updated_at: "2026-09-25T00:00:00Z",
              deleted_at: null,
              is_deleted: false,
              performed_by: userId,
            },
          ],
          { limit: 5 },
        ),
      ),
    });
  });

  await page.goto(`/boards?board=${boardId}&section=overview`);
  await expect(page.getByText("Alex Reader", { exact: true })).toBeVisible();
  const beforeInvalidation = recordQueries;
  await expect(page.getByText(assigneeId, { exact: true })).toHaveCount(0);

  assigneeLabel = "Unavailable user";
  await sendOpenViewEvent(page, "invalidate", {
    entity: "group_access",
    module_id: moduleId,
  });

  await expect.poll(() => recordQueries).toBeGreaterThan(beforeInvalidation);
  await expect(
    page.getByText("Unavailable user", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Alex Reader", { exact: true })).toHaveCount(0);
  await expect(page.getByText(assigneeId, { exact: true })).toHaveCount(0);
});

test("an author can archive their own editable post with current revisions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installBoardApi(page, () => true, authorAccess);
  const postId = "00000000-0000-4000-8000-000000000041";
  const otherPostId = "00000000-0000-4000-8000-000000000042";
  const otherAuthorId = "00000000-0000-4000-8000-000000000043";
  const now = "2026-09-25T00:00:00Z";
  const post = (id: string, authorId: string, title: string) => ({
    id,
    board_id: boardId,
    author_id: authorId,
    title,
    body: `${title} body`,
    links: [],
    status: "published",
    publish_at: now,
    expires_at: null,
    pinned: false,
    post_revision: 3,
    board_revision: 1,
    publication_number: null,
    published_at: null,
    edited: false,
    created_at: now,
    updated_at: now,
  });
  const ownPost = post(postId, userId, "My editable notice");
  const otherPost = post(otherPostId, otherAuthorId, "Another author's notice");
  let archived = false;
  let archiveBody: unknown = null;
  await page.route(`**/api/boards/${boardId}/posts**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const reply = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === `/api/boards/${boardId}/posts` && request.method() === "GET") {
      const view = url.searchParams.get("view");
      const items =
        view === "editable"
          ? archived
            ? [otherPost]
            : [ownPost, otherPost]
          : [];
      return reply(200, { ...pageOf(items, { limit: 25 }), board_revision: 1 });
    }
    if (
      path === `/api/boards/${boardId}/posts/${postId}` &&
      request.method() === "GET"
    )
      return archived
        ? reply(404, { detail: "Post not found" })
        : reply(200, ownPost);
    if (
      path === `/api/boards/${boardId}/posts/${postId}/archive` &&
      request.method() === "POST"
    ) {
      archiveBody = request.postDataJSON();
      archived = true;
      return reply(200, {
        id: postId,
        post_revision: 4,
        board_revision: 2,
      });
    }
    return reply(404, { detail: "Unmocked author post route" });
  });

  await page.goto(`/boards?board=${boardId}&section=posts`);
  await page.getByRole("button", { name: "More post actions" }).click();
  await page.getByRole("menuitem", { name: "Edit drafts" }).click();
  const editor = page.getByRole("dialog", { name: "Post editor", exact: true });
  const ownPostChoice = editor.getByRole("button", {
    name: "My editable notice · Published",
  });
  await expect(ownPostChoice).toBeVisible();
  await expect(
    editor.getByRole("button", { name: /Another author's notice/ }),
  ).toHaveCount(0);
  await ownPostChoice.click();
  const archiveButton = editor.getByRole("button", {
    name: "Archive post",
    exact: true,
  });
  await expect(archiveButton).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(archiveButton).toBeVisible();
  await archiveButton.scrollIntoViewIfNeeded();
  const confirmation = page.getByRole("alertdialog", {
    name: "Archive post?",
  });
  await archiveButton.click();
  await expect(confirmation).toBeVisible();
  const archivedResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/boards/${boardId}/posts/${postId}/archive` &&
      response.request().method() === "POST",
  );
  await confirmation
    .getByRole("button", { name: "Archive post", exact: true })
    .click();
  const response = await archivedResponse;
  expect(response.status()).toBe(200);
  await expect(editor.getByText("Post archived.")).toBeVisible();
  await expect(ownPostChoice).toHaveCount(0);
  expect(archiveBody).toEqual({ board_revision: 1, post_revision: 3 });
});

test("a stale author post archive preserves the selected post and local form", async ({
  page,
}) => {
  await installBoardApi(page, () => true, authorAccess);
  const postId = "00000000-0000-4000-8000-000000000051";
  const now = "2026-09-25T00:00:00Z";
  const ownPost = {
    id: postId,
    board_id: boardId,
    author_id: userId,
    title: "My notice",
    body: "Keep this saved text.",
    links: [],
    status: "published",
    publish_at: now,
    expires_at: null,
    pinned: false,
    post_revision: 3,
    board_revision: 1,
    publication_number: null,
    published_at: null,
    edited: false,
    created_at: now,
    updated_at: now,
  };
  await page.route(`**/api/boards/${boardId}/posts**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const reply = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === `/api/boards/${boardId}/posts` && request.method() === "GET") {
      const items =
        url.searchParams.get("view") === "editable" ? [ownPost] : [];
      return reply(200, { ...pageOf(items, { limit: 25 }), board_revision: 1 });
    }
    if (
      path === `/api/boards/${boardId}/posts/${postId}` &&
      request.method() === "GET"
    )
      return reply(200, ownPost);
    if (
      path === `/api/boards/${boardId}/posts/${postId}/archive` &&
      request.method() === "POST"
    )
      return reply(409, {
        detail: {
          code: "stale_post_revision",
          message: "Post changed; reload before saving",
        },
      });
    return reply(404, { detail: "Unmocked author post route" });
  });

  await page.goto(`/boards?board=${boardId}&section=posts`);
  await page.getByRole("button", { name: "More post actions" }).click();
  await page.getByRole("menuitem", { name: "Edit drafts" }).click();
  const editor = page.getByRole("dialog", { name: "Post editor", exact: true });
  await editor.getByRole("button", { name: "My notice · Published" }).click();
  const title = editor.getByLabel("Title", { exact: true });
  const archiveButton = editor.getByRole("button", {
    name: "Archive post",
    exact: true,
  });
  await expect(archiveButton).toBeVisible();
  const confirmation = page.getByRole("alertdialog", {
    name: "Archive post?",
  });
  await archiveButton.click();
  await confirmation
    .getByRole("button", { name: "Archive post", exact: true })
    .click();
  await expect(
    editor.getByText(/Post changed; reload before saving/),
  ).toBeVisible();
  await expect(title).toHaveValue("My notice");
  await expect(
    editor.getByRole("button", { name: "My notice · Published" }),
  ).toBeVisible();
  await expect(archiveButton).toBeDisabled();
});

test("an author links a Record using its off-page title field without crawling the catalog", async ({
  page,
}) => {
  await installBoardApi(page, () => true, authorAccess);
  const postId = "00000000-0000-4000-8000-000000000071";
  const moduleId = "00000000-0000-4000-8000-000000000072";
  const fieldId = "00000000-0000-4000-8000-000000000073";
  const recordId = "00000000-0000-4000-8000-000000000074";
  const linkId = "00000000-0000-4000-8000-000000000075";
  const now = "2026-09-25T00:00:00Z";
  const post = {
    id: postId,
    board_id: boardId,
    author_id: userId,
    title: "Request handoff",
    body: "Link the request.",
    links: [],
    status: "draft",
    publish_at: null,
    expires_at: null,
    pinned: false,
    post_revision: 2,
    board_revision: 1,
    publication_number: null,
    published_at: null,
    edited: false,
    created_at: now,
    updated_at: now,
  };
  let submitted: unknown = null;
  let linked = false;
  let listUnavailable = true;
  let sourcePageUnavailable = true;
  let titleUnavailable = true;
  let recordsUnavailable = true;
  const fieldOffsets: number[] = [];
  const queryColumns: Array<Array<{ field_id: string }>> = [];
  const dataSources = Array.from({ length: 26 }, (_, index) => ({
    id:
      index === 0
        ? moduleId
        : `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
    name: index === 0 ? "Requests" : `Data source ${index + 1}`,
    department_id: boardId,
    title_field_id: index === 0 ? fieldId : null,
  }));
  const wireLink = {
    id: linkId,
    record_id: recordId,
    module_id: moduleId,
    label: "Request 27",
    available: true,
    url: `/openview?module=${moduleId}&record=${recordId}`,
  };
  await page.route(`**/api/boards/${boardId}/posts**`, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === `/api/boards/${boardId}/posts`)
      return route.fulfill({
        json: { ...pageOf([post], { limit: 25 }), board_revision: 1 },
      });
    if (path === `/api/boards/${boardId}/posts/${postId}`)
      return route.fulfill({ json: post });
    if (path === `/api/boards/${boardId}/posts/${postId}/record-links`) {
      if (request.method() === "POST") {
        submitted = request.postDataJSON();
        linked = true;
        return route.fulfill({ json: wireLink });
      }
      if (listUnavailable)
        return route.fulfill({
          status: 503,
          json: { detail: "Private failure canary" },
        });
      return route.fulfill({
        json: {
          items: linked ? [wireLink] : [],
          limit: 20,
          offset: 0,
          has_more: false,
        },
      });
    }
    return route.fulfill({ status: 404, json: { detail: "Unmocked route" } });
  });
  await page.route("**/api/views/data-sources**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === `/api/views/data-sources/${moduleId}/fields`) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      fieldOffsets.push(offset);
      if (offset !== 0)
        return route.fulfill({
          status: 503,
          json: { detail: "The catalog must not be crawled for a known ID" },
        });
      return route.fulfill({
        json: {
          items: Array.from({ length: 100 }, (_, index) => ({
            id: `00000000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`,
            module_id: moduleId,
            name: `Other field ${index + 1}`,
            type: "text",
            required: false,
            position: index,
            config: { kind: "text" },
          })),
          pagination: {
            limit: 100,
            offset: 0,
            count: 100,
            total: 101,
            has_more: true,
          },
        },
      });
    }
    const offset = Number(
      new URL(route.request().url()).searchParams.get("offset") ?? 0,
    );
    if (offset === 25 && sourcePageUnavailable)
      return route.fulfill({
        status: 503,
        json: { detail: "Private failure canary" },
      });
    const items = dataSources.slice(offset, offset + 25);
    return route.fulfill({
      json: pageOf(items, {
        limit: 25,
        offset,
        total: 26,
        hasMore: offset === 0,
      }),
    });
  });
  await page.route(`**/api/fields/${fieldId}`, (route) =>
    titleUnavailable
      ? route.fulfill({ status: 403, json: { detail: "Private title canary" } })
      : route.fulfill({
          json: {
            id: fieldId,
            module_id: moduleId,
            name: "Request title",
            type: "text",
            required: false,
            position: 100,
            config: { kind: "text" },
            is_deleted: false,
          },
        }),
  );
  await page.route("**/api/records/query", (route) => {
    queryColumns.push(route.request().postDataJSON().definition.columns);
    if (recordsUnavailable)
      return route.fulfill({
        status: 503,
        json: { detail: "Private failure canary" },
      });
    return route.fulfill({
      json: pageOf(
        [
          {
            id: recordId,
            module_id: moduleId,
            data: { [fieldId]: "Request 27" },
            display_values: { [fieldId]: "Request 27" },
            created_at: now,
            updated_at: now,
            deleted_at: null,
            is_deleted: false,
            performed_by: userId,
          },
        ],
        { limit: 25 },
      ),
    });
  });

  await page.goto(`/boards?board=${boardId}&section=posts`);
  await page.getByRole("button", { name: "More post actions" }).click();
  await page.getByRole("menuitem", { name: "Edit drafts" }).click();
  const editor = page.getByRole("dialog", { name: "Post editor", exact: true });
  await editor.getByRole("button", { name: "Request handoff" }).click();
  const links = editor.getByRole("region", { name: "Record links" });
  await expect(links).toContainText("Record links could not be loaded.");
  await expect
    .soft(
      links
        .getByRole("alert")
        .filter({ hasText: "Record links could not be loaded." }),
    )
    .toHaveAttribute("data-variant", "destructive");
  await expect(links).not.toContainText("No linked Records.");
  await expect(links).not.toContainText("Private failure canary");
  expect(submitted).toBeNull();
  listUnavailable = false;
  await links.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    links.getByText("No linked Records.", { exact: true }),
  ).toBeVisible();

  await links
    .getByRole("button", { name: "Next sources", exact: true })
    .click();
  await expect(links).toContainText("Data sources could not be loaded.");
  await expect
    .soft(
      links
        .getByRole("alert")
        .filter({ hasText: "Data sources could not be loaded." }),
    )
    .toHaveAttribute("data-variant", "destructive");
  await expect(links).not.toContainText("Private failure canary");
  expect(submitted).toBeNull();
  sourcePageUnavailable = false;
  await links
    .getByRole("button", { name: "Previous sources", exact: true })
    .click();
  await expect(
    links.getByText("Data sources could not be loaded."),
  ).toHaveCount(0);
  await expect(
    links.getByRole("button", { name: "Previous sources", exact: true }),
  ).toBeDisabled();
  await expect(
    links.getByRole("button", { name: "Next sources", exact: true }),
  ).toBeEnabled();

  await links.getByLabel("Record data source").selectOption(moduleId);
  await expect(links).toContainText("Records could not be loaded.");
  await expect
    .soft(
      links
        .getByRole("alert")
        .filter({ hasText: "Records could not be loaded." }),
    )
    .toHaveAttribute("data-variant", "destructive");
  await expect(links).not.toContainText("Private failure canary");
  await expect(
    links.getByRole("button", { name: "Link Record", exact: true }),
  ).toBeDisabled();
  expect(queryColumns).toEqual([]);
  await expect(links).not.toContainText("Private title canary");
  expect(submitted).toBeNull();
  titleUnavailable = false;
  await links.getByLabel("Search Records", { exact: true }).fill("Request");
  await expect.poll(() => queryColumns.length).toBeGreaterThan(0);
  await expect(links).toContainText("Records could not be loaded.");
  recordsUnavailable = false;
  await links.getByLabel("Search Records", { exact: true }).fill("Request 27");
  await expect(links.getByLabel("Record to link")).toBeVisible();
  await expect(links.getByText("Records could not be loaded.")).toHaveCount(0);
  await links.getByLabel("Record to link").selectOption(recordId);
  await expect(links.getByLabel("Record to link")).toContainText("Request 27");
  expect(fieldOffsets.every((offset) => offset === 0)).toBe(true);
  expect(queryColumns.every((columns) => columns.length <= 100)).toBe(true);
  expect(
    queryColumns.every((columns) =>
      columns.some((column) => column.field_id === fieldId),
    ),
  ).toBe(true);
  await links.getByRole("button", { name: "Link Record" }).click();
  await expect(links.getByRole("link", { name: "Request 27" })).toBeVisible();
  await expect(links.getByRole("status")).toHaveText("Record linked.");
  expect(submitted).toEqual({
    record_id: recordId,
    board_revision: 1,
    content_revision: 2,
  });
});
