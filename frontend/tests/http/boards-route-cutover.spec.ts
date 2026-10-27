import { authMeBody, expect, test, type Page } from "./helpers/test";
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
import { pageOf } from "../helpers/pagination";
import { wireField, wireRecord } from "../helpers/wire";

test("Board settings holds a board's details, access and activity, and All boards offers a new project board", async ({
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
  await page.goto("/boards?section=all");
  await page
    .getByRole("button", { name: "New project board", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "New project board" }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "New project board" })
    .getByRole("button", { name: "Close new project board", exact: true })
    .click();
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await page
    .getByRole("button", { name: "Board settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: board.name, exact: true });
  // The exact list leaves no room for a retired item (access grants,
  // templates, favorites, a home Board, a new Board).
  await expect(settings.getByRole("tab")).toHaveText([
    "Details",
    "Access",
    "Activity",
  ]);
  await settings.getByRole("tab", { name: "Access", exact: true }).click();
  await expect(
    settings.getByText("No groups yet. Only administrators open this board."),
  ).toBeVisible();
});

test("a member reading a Board sees no Board settings and no manager actions", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authMeBody({
        id: userId,
        role: "member",
        access: [],
        default_organization_blocked: null,
      }),
    }),
  );
  const reader = { ...board, level: "read" };
  await page.route(`**/api/boards/${boardId}`, (route) =>
    route.fulfill({ json: reader }),
  );
  await page.route(`**/api/boards/${boardId}/my-access`, (route) =>
    route.fulfill({ json: readerAccess }),
  );
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Board settings", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Manage posts", exact: true }),
  ).toHaveCount(0);
});

test("a cold /boards opens Posts for a member reader without widget, record or field reads", async ({
  page,
}) => {
  await installBoardApi(page, () => true, readerAccess);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authMeBody({
        id: userId,
        role: "member",
        access: [],
        default_organization_blocked: null,
      }),
    }),
  );
  const published = "2026-09-24T00:00:00Z";
  const post = {
    id: "00000000-0000-4000-8000-000000000021",
    board_id: boardId,
    author_id: userId,
    title: "Dock rota for Friday",
    body: "Shifts start at 7.",
    links: [],
    status: "published",
    publish_at: published,
    expires_at: null,
    pinned: false,
    post_revision: null,
    board_revision: 1,
    publication_number: 1,
    published_at: published,
    edited: false,
    created_at: published,
    updated_at: published,
  };
  await page.route(`**/api/boards/${boardId}/posts?**`, (route) => {
    const view = new URL(route.request().url()).searchParams.get("view");
    return route.fulfill({
      json: {
        ...pageOf(view === "published" ? [post] : [], { limit: 25 }),
        board_revision: 1,
      },
    });
  });
  const retired: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      /\/widgets(\/|$)/.test(path) ||
      path === "/api/records/query" ||
      path.startsWith("/api/fields/")
    )
      retired.push(path);
  });

  await page.goto("/boards");

  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("board") === boardId &&
      url.searchParams.get("section") === "posts",
  );
  await expect(
    page.getByRole("link", { name: "Posts", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByText(post.title)).toBeVisible();
  expect(retired).toEqual([]);
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
    page.getByRole("region", { name: "Posts", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New post", exact: true }),
  ).toHaveCount(0);
});

test("visible Boards route opens authorized server Board and keeps section URL", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=posts`);

  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();
  await expect(page.getByText(board.description)).toBeVisible();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: `${board.name} announcements`,
    }),
  ).toBeVisible();

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
  await installOpenViewEventSource(page);
  await installBoardApi(page, () => allowed);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await expect(page.getByRole("heading", { name: board.name })).toBeVisible();

  allowed = false;
  // A change to the Board arrives on the live stream (BR7).
  await sendOpenViewEvent(page, "invalidate", {
    entity: "boards",
    board_id: boardId,
  });
  await expect(
    page.getByText("It may have been removed, or you may not have access."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: board.name })).toHaveCount(0);
  await expect(page.getByText(board.description)).toHaveCount(0);
});

test("an unsaved event draft asks before it closes, then the board navigates freely", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=calendar`);
  await page.getByRole("button", { name: "New event" }).click();
  const editor = page.getByRole("dialog", { name: "New event" });
  await editor.getByLabel("Event title").fill("Draft to keep");
  await editor.getByRole("button", { name: "Close event editor" }).click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Discard unsaved event changes?",
  });
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(editor.getByLabel("Event title")).toHaveValue("Draft to keep");
  await editor.getByRole("button", { name: "Close event editor" }).click();
  await confirmation.getByRole("button", { name: "Discard changes" }).click();
  await expect(editor).toBeHidden();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Second live board", exact: true })
    .click();
  await expect(page).toHaveURL(`/boards?board=${otherBoard.id}&section=posts`);
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
    page.getByRole("button", { name: "Fri, Sep 25, show week", exact: true }),
  ).toHaveAttribute("aria-current", "date");
  // A busy month is read to its end, so its last event is one click away.
  await expect
    .poll(() => requests.some((item) => item.offset === "100"))
    .toBe(true);
  await page.getByRole("button", { name: /^\d+ more on Thu, Sep 24$/ }).click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: /^Late occurrence,/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Search events").fill("missing");
  await expect(page.getByRole("button", { name: /^Earlier 1,/ })).toHaveCount(
    0,
  );
  expect(requests.some((item) => item.search === "missing")).toBe(true);
  await page.getByLabel("Search events").fill("");
  await expect(
    page.getByRole("button", { name: /^\d+ more on Thu, Sep 24$/ }),
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

test("a phone Calendar opens on the day list and permits Month", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=calendar`);
  await expect(
    page.getByRole("button", { name: "Week", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Month", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("view") === "month",
  );
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
    await page
      .getByRole("button", { name: "Board settings", exact: true })
      .click();
    const activity = page.getByRole("dialog", {
      name: board.name,
      exact: true,
    });
    await activity.getByRole("tab", { name: "Activity", exact: true }).click();
    await expect(
      activity.getByRole("list", { name: "Board activity", exact: true }),
    ).toContainText("Changed details · Regional test actor");
    await expect(activity.locator("time")).toHaveText(
      /22 sept\. 2026.*17:00.*(?:UTC|GMT).*7/,
    );
  });

  test("a live workspace change replaces a held cold workspace read on Calendar", async ({
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
        page.getByRole("heading", {
          name: `${board.name} announcements`,
          exact: true,
        }),
      ).toBeVisible();
      await sendOpenViewEvent(page, "invalidate", {
        entity: "workspace_profiles",
      });
      await expect.poll(() => workspaceReads).toBeGreaterThan(1);
      const latest = page.getByRole("button", {
        name: "Sat, Sep 26, show week",
        exact: true,
      });
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

  test("Calendar live workspace changes and rollover keep the chosen month and last-good settings", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-09-25T12:00:00Z") });
    await installOpenViewEventSource(page);
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
    const todayMark = (name: string) =>
      page.getByRole("button", { name: `${name}, show week`, exact: true });
    await expect(todayMark("Fri, Sep 25")).toHaveAttribute(
      "aria-current",
      "date",
    );
    today = "2026-09-26";
    const refresh = () =>
      sendOpenViewEvent(page, "invalidate", { entity: "workspace_profiles" });
    await refresh();
    await expect(todayMark("Sat, Sep 26")).toHaveAttribute(
      "aria-current",
      "date",
    );
    await page.getByRole("button", { name: "Next month" }).click();
    const october = page.getByRole("heading", {
      name: "October 2026",
      exact: true,
    });
    await expect(october).toBeVisible();
    failRegionalRead = true;
    today = "2026-09-27";
    await refresh();
    const retry = page.getByRole("button", {
      name: "Retry date",
      exact: true,
    });
    await expect(retry).toBeVisible();
    await expect(october).toBeVisible();
    failRegionalRead = false;
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(october).toBeVisible();
    today = "2026-09-28";
    await page.clock.runFor(60_000);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(todayMark("Mon, Sep 28")).toHaveAttribute(
      "aria-current",
      "date",
    );
  });
});

test("post editor retains a canceled close and discards only on confirmation", async ({
  page,
}) => {
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await page
    .getByRole("button", { name: "New post", exact: true })
    .first()
    .click();
  const editor = page.getByRole("dialog", {
    name: "New post",
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
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Second live board", exact: true })
    .click();
  await expect(page).toHaveURL(`/boards?board=${otherBoard.id}&section=posts`);
});

test("a live refresh keeps an open post draft mounted and editable", async ({
  page,
}) => {
  await installOpenViewEventSource(page);
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await page
    .getByRole("button", { name: "New post", exact: true })
    .first()
    .click();
  const editor = page.getByRole("dialog", {
    name: "New post",
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
    editor.getByText("Opening the post…", { exact: true }),
  ).toHaveCount(0);
});

test("the post editor has no audience choice", async ({ page }) => {
  await installBoardApi(page, () => true);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await page.getByRole("button", { name: "New post" }).first().click();
  const editor = page.getByRole("dialog", { name: "New post", exact: true });
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
  const editor = page.getByRole("form", { name: "Create event" });
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

  await page.route(
    new RegExp(`/api/boards/${boardId}/events/(${eventId}|${otherEventId})$`),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
      return route.fulfill({
        json:
          id === eventId
            ? event(eventId, userId, "My planning session", archived ? 2 : 1)
            : event(
                otherEventId,
                otherAuthorId,
                "Team planning session",
                archived ? 2 : 1,
              ),
      });
    },
  );
  await page.goto(`/boards?board=${boardId}&section=calendar`);
  const month = page.getByRole("region", { name: "September 2026 calendar" });
  await month.getByRole("button", { name: /^Team planning session,/ }).click();
  const teamSheet = page.getByRole("dialog", { name: "Team planning session" });
  await teamSheet.getByRole("button", { name: "More event actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Archive event" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await teamSheet.getByRole("button", { name: "Close event" }).click();
  await month.getByRole("button", { name: /^My planning session,/ }).click();
  await page
    .getByRole("dialog", { name: "My planning session" })
    .getByRole("button", { name: "More event actions" })
    .click();
  await page.getByRole("menuitem", { name: "Archive event" }).click();
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
    month.getByRole("button", { name: /^My planning session,/ }),
  ).toHaveCount(0);
  await expect(page).toHaveURL((url) => !url.searchParams.has("event"));
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

  await installOpenViewEventSource(page);

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

  await page.route(`**/api/boards/${boardId}/events/${eventId}`, (route) =>
    route.fulfill({
      json: {
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
    }),
  );
  await page.goto(`/boards?board=${boardId}&section=calendar`);
  await page.getByRole("button", { name: /^Equipment handover,/ }).click();
  await expect(
    page.getByRole("link", { name: "Cooling manifold" }),
  ).toBeVisible();
  await expect.poll(() => linkRequests).toBeGreaterThan(0);
  const beforeInvalidation = linkRequests;

  label = "Cooling manifold updated";
  await sendOpenViewEvent(page, "invalidate", {
    entity: "records",
    module_id: moduleId,
  });

  await expect.poll(() => linkRequests).toBeGreaterThan(beforeInvalidation);
  await expect(
    page.getByRole("link", { name: "Cooling manifold updated" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Cooling manifold", exact: true }),
  ).toHaveCount(0);

  const beforeEligibilityInvalidation = linkRequests;
  label = "Record title after eligibility change";
  await sendOpenViewEvent(page, "invalidate", {
    entity: "group_access",
    module_id: moduleId,
  });

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

/** An author's published post, another author's, and their revisions. */
async function installAuthorPosts(page: Page, archiveStatus: 200 | 409) {
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
    post_revision: null,
    board_revision: 1,
    publication_number: 1,
    published_at: now,
    edited: false,
    created_at: now,
    updated_at: now,
  });
  const ownPost = post(postId, userId, "My editable notice");
  const otherPost = post(otherPostId, otherAuthorId, "Another author's notice");
  const state = { archived: false, archiveBody: null as unknown };
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
        url.searchParams.get("view") === "published"
          ? state.archived
            ? [otherPost]
            : [ownPost, otherPost]
          : [];
      return reply(200, { ...pageOf(items, { limit: 25 }), board_revision: 1 });
    }
    for (const item of [ownPost, otherPost])
      if (path === `/api/boards/${boardId}/posts/${item.id}`)
        return state.archived && item === ownPost
          ? reply(404, { detail: "Post not found" })
          : reply(200, item);
    if (path === `/api/boards/${boardId}/posts/${postId}/manage-state`)
      return reply(200, {
        id: postId,
        status: "published",
        board_revision: 1,
        post_revision: 3,
        published_before: true,
      });
    if (
      path === `/api/boards/${boardId}/posts/${postId}/archive` &&
      request.method() === "POST"
    ) {
      state.archiveBody = request.postDataJSON();
      if (archiveStatus === 409)
        return reply(409, {
          detail: {
            code: "stale_post_revision",
            message: "Post changed; reload before saving",
          },
        });
      state.archived = true;
      return reply(200, { id: postId, post_revision: 4, board_revision: 2 });
    }
    if (path.endsWith("/attachments") || path.endsWith("/record-links"))
      return reply(200, { items: [], limit: 25, offset: 0, has_more: false });
    return reply(404, { detail: "Unmocked author post route" });
  });
  return { postId, otherPostId, state };
}

test("an author archives their own post from the reading pane with current revisions", async ({
  page,
}) => {
  const api = await installAuthorPosts(page, 200);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `/boards?board=${boardId}&section=posts&post=${api.otherPostId}`,
  );
  const other = page.getByRole("article", { name: "Another author's notice" });
  await other.getByRole("button", { name: "More post actions" }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Copy link"]);
  await page.keyboard.press("Escape");
  await expect(other.getByRole("button", { name: "Edit" })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/boards?board=${boardId}&section=posts&post=${api.postId}`);
  const own = page.getByRole("article", { name: "My editable notice" });
  await own.getByRole("button", { name: "More post actions" }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Archive post?",
  });
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole("button", { name: "Archive post", exact: true })
    .click();
  await expect(page.getByText("Post archived", { exact: true })).toBeVisible();
  expect(api.state.archiveBody).toEqual({
    board_revision: 1,
    post_revision: 3,
  });
  await expect(page).toHaveURL((url) => !url.searchParams.has("post"));
  await expect(
    page
      .getByRole("region", { name: "Posts", exact: true })
      .getByText("My editable notice"),
  ).toHaveCount(0);
});

test("a stale archive keeps the post open and says it changed elsewhere", async ({
  page,
}) => {
  const api = await installAuthorPosts(page, 409);
  await page.goto(`/boards?board=${boardId}&section=posts&post=${api.postId}`);
  const own = page.getByRole("article", { name: "My editable notice" });
  await own.getByRole("button", { name: "More post actions" }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "Archive post?" })
    .getByRole("button", { name: "Archive post", exact: true })
    .click();
  await expect(
    page
      .getByText(
        "This post changed elsewhere. Refresh posts before trying again.",
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  await expect(page.getByText("Post archived", { exact: true })).toHaveCount(0);
  await expect(own).toBeVisible();
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
          items: Array.from({ length: 100 }, (_, index) =>
            wireField({
              id: `00000000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`,
              module_id: moduleId,
              name: `Other field ${index + 1}`,
              type: "text",
              position: index,
              config: { kind: "text" },
            }),
          ),
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
          wireRecord({
            id: recordId,
            module_id: moduleId,
            data: { [fieldId]: "Request 27" },
            display_values: { [fieldId]: "Request 27" },
            created_at: now,
            updated_at: now,
            performed_by: userId,
          }),
        ],
        { limit: 25 },
      ),
    });
  });

  await page.goto(`/boards?board=${boardId}&section=posts&show=drafts`);
  await page
    .getByRole("article", { name: "Request handoff", exact: true })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Edit post", exact: true });
  const links = editor.getByRole("region", { name: "Record links" });
  await expect(links).toContainText("Record links could not be loaded.");
  await expect
    .soft(
      links
        .getByRole("alert")
        .filter({ hasText: "Record links could not be loaded." }),
    )
    .toHaveAttribute("data-variant", "destructive");
  await expect(links).not.toContainText("No linked records.");
  await expect(links).not.toContainText("Private failure canary");
  expect(submitted).toBeNull();
  listUnavailable = false;
  await links.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    links.getByText("No linked records.", { exact: true }),
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
    links.getByRole("button", { name: "Link record", exact: true }),
  ).toBeDisabled();
  expect(queryColumns).toEqual([]);
  await expect(links).not.toContainText("Private title canary");
  expect(submitted).toBeNull();
  titleUnavailable = false;
  await links.getByLabel("Search records", { exact: true }).fill("Request");
  await expect.poll(() => queryColumns.length).toBeGreaterThan(0);
  await expect(links).toContainText("Records could not be loaded.");
  recordsUnavailable = false;
  await links.getByLabel("Search records", { exact: true }).fill("Request 27");
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
  await links.getByRole("button", { name: "Link record" }).click();
  await expect(links.getByRole("link", { name: "Request 27" })).toBeVisible();
  await expect(links.getByRole("status")).toHaveText("Record linked.");
  expect(submitted).toEqual({
    record_id: recordId,
    board_revision: 1,
    content_revision: 2,
  });
});
