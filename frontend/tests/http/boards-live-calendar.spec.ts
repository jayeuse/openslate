import {
  eventStreamUrl,
  authMeBody,
  expect,
  test,
  type Page,
  isEventStream,
  signedInAs,
} from "./helpers/test";
import { profilePreferences } from "./helpers/profile-api";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import { pageOf, wirePagination } from "../helpers/pagination";
import { wireBoard } from "../helpers/wire";

const boardId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";
const authorId = "00000000-0000-4000-8000-000000000003";
test.use({ trace: "off", screenshot: "off", video: "off" });

const selectedEventWire = {
  id: eventId,
  board_id: boardId,
  author_id: authorId,
  title: "Winter planning session",
  details: "Bring the printed plan.\n<script>plain text</script>",
  location: "Room 12",
  links: [{ label: "Planning guide", url: "https://example.org/planning" }],
  all_day: true,
  start_date: "2026-12-14",
  end_date: "2026-12-16",
  start_at: null,
  end_at: null,
  timezone_name: "Asia/Manila",
  recurrence: "none",
  repeat_until: null,
  reminders: ["1d"],
  archived: false,
  revision: 1,
  board_revision: 1,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

async function installSelectedEventApi(
  browser: Page,
  weekStart: "monday" | "sunday" = "monday",
) {
  const board = wireBoard({
    id: boardId,
    name: "Calendar board",
    description: "Current calendar",
    level: "read",
    created_at: selectedEventWire.created_at,
    updated_at: selectedEventWire.updated_at,
  });
  await browser.route("**/api/**", (route) =>
    isEventStream(route)
      ? route.fallback()
      : route.fulfill({
          status: 404,
          json: { detail: "Unavailable in calendar test" },
        }),
  );
  await signedInAs(browser, { id: authorId, role: "member" });
  await browser.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        display_name: "OpenSlate",
        mark: "OS",
        logo_file_id: null,
        revision: 1,
        today: "2026-09-14",
        week_start: weekStart,
        locale: "en-US",
        timezone: "UTC",
      },
    }),
  );
  await browser.route("**/api/boards**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const prefix = `/api/boards/${boardId}`;
    const emptyPagination = wirePagination({ limit: 100, count: 0, total: 0 });
    if (path === "/api/boards")
      return route.fulfill({
        json: {
          items: [board],
          pagination: { ...emptyPagination, limit: 25, count: 1, total: 1 },
        },
      });
    if (path === prefix) return route.fulfill({ json: board });
    if (path === `${prefix}/my-access`)
      return route.fulfill({
        json: { level: "read", read: true, write: false, manage: false },
      });
    if (path === `${prefix}/events/occurrences`)
      return route.fulfill({
        json: { items: [], pagination: emptyPagination, board_revision: 1 },
      });
    if (path === `${prefix}/events/${eventId}`)
      return route.fulfill({ json: selectedEventWire });
    if (
      path === `${prefix}/events/${eventId}/attachments` ||
      path === `${prefix}/events/${eventId}/record-links`
    )
      return route.fulfill({
        json: { items: [], limit: 20, offset: 0, has_more: false },
      });
    return route.fulfill({
      status: 404,
      json: { detail: "Unavailable in calendar test" },
    });
  });
}

async function installS11EventApi(browser: Page) {
  await installOpenViewEventSource(browser);
  await installSelectedEventApi(browser);
  await browser.route("**/api/users/*/preferences", (route) =>
    route.fulfill({
      json: {
        user_id: new URL(route.request().url()).pathname.split("/")[3],
        theme: "light",
        appearance: { motion: "reduce", keyboard_shortcuts: true },
      },
    }),
  );
  let saved = {
    ...selectedEventWire,
    start_date: "2026-09-14",
    end_date: "2026-09-16",
  };
  const reads: string[] = [];
  const writes: string[] = [];
  await browser.route("**/api/boards**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const prefix = `/api/boards/${boardId}`;
    if (request.method() !== "GET") {
      writes.push(url.pathname);
      return route.fulfill({
        status: 409,
        json: { detail: "Unexpected write" },
      });
    }
    reads.push(url.pathname);
    const board = wireBoard({
      id: boardId,
      name: "Calendar board",
      description: "Current calendar",
      revision: saved.board_revision,
      level: "manage",
      created_at: saved.created_at,
      updated_at: saved.updated_at,
    });
    const pagination = wirePagination({ limit: 25, count: 1, total: 1 });
    if (url.pathname === "/api/boards")
      return route.fulfill({ json: { items: [board], pagination } });
    if (url.pathname === prefix) return route.fulfill({ json: board });
    if (url.pathname === `${prefix}/my-access`)
      return route.fulfill({
        json: { level: "manage", read: true, write: true, manage: true },
      });
    if (url.pathname === `${prefix}/events/${eventId}`)
      return route.fulfill({ json: saved });
    if (url.pathname === `${prefix}/events/occurrences`)
      return route.fulfill({
        json: {
          items: [
            {
              id: `${eventId}:2026-09-14`,
              event_id: eventId,
              date: "2026-09-14",
              start: "2026-09-14",
              end: "2026-09-16",
              event: saved,
            },
          ],
          pagination: { ...pagination, limit: 100 },
          board_revision: saved.board_revision,
        },
      });
    return route.fallback();
  });
  return {
    reads,
    writes,
    change() {
      saved = {
        ...saved,
        title: "Remote event title",
        details: "Remote planning details",
        revision: 2,
        board_revision: 2,
      };
    },
  };
}

for (const dirty of [false, true]) {
  test(`event invalidation ${dirty ? "retains the dirty event and offers review latest" : "updates the clean event editor"}`, async ({
    page: browser,
  }) => {
    const api = await installS11EventApi(browser);
    await browser.goto(`/boards?board=${boardId}&section=calendar`);
    await browser
      .getByRole("button", { name: /^Winter planning session,/ })
      .click();
    await browser
      .getByRole("dialog", { name: selectedEventWire.title })
      .getByRole("button", { name: "Edit event", exact: true })
      .click();
    const title = browser.getByLabel("Event title", { exact: true });
    await expect(title).toHaveValue(selectedEventWire.title);
    if (dirty) {
      await title.fill("My local event title");
      await browser
        .getByLabel("Details", { exact: true })
        .fill("My complete local planning draft");
      await browser
        .getByLabel("Location", { exact: true })
        .fill("Local room 42");
    }
    api.change();
    await sendOpenViewEvent(browser, "invalidate", {
      entity: "board_events",
      board_id: boardId,
    });
    if (dirty) {
      await expect(
        browser.getByText("Someone changed this event first.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(title).toHaveValue("My local event title");
      await expect(browser.getByLabel("Details", { exact: true })).toHaveValue(
        "My complete local planning draft",
      );
      await expect(browser.getByLabel("Location", { exact: true })).toHaveValue(
        "Local room 42",
      );
      await expect(
        browser.getByRole("button", { name: "Save event", exact: true }),
      ).toBeDisabled();
      await browser
        .getByText("Review the latest saved event", { exact: true })
        .click();
      await expect(
        browser
          .getByRole("definition")
          .filter({ hasText: "Remote planning details" }),
      ).toBeVisible();
    } else {
      await expect(title).toHaveValue("Remote event title");
      await expect(browser.getByLabel("Details", { exact: true })).toHaveValue(
        "Remote planning details",
      );
      await expect(
        browser.getByText("Someone changed this event first.", {
          exact: true,
        }),
      ).toHaveCount(0);
    }
    expect(api.writes).toHaveLength(0);
    expect(
      api.reads.filter((path) => path.endsWith(`/events/${eventId}`)).length,
    ).toBeGreaterThan(0);
    await expect(
      browser.getByRole("heading", { name: "September 2026", exact: true }),
    ).toBeVisible();
  });
}

test("an old live event refusal cannot close a newly created local draft", async ({
  page: browser,
}) => {
  const api = await installS11EventApi(browser);
  await browser.goto(`/boards?board=${boardId}&section=calendar`);
  await browser
    .getByRole("button", { name: /^Winter planning session,/ })
    .click();
  await browser
    .getByRole("dialog", { name: selectedEventWire.title })
    .getByRole("button", { name: "Edit event", exact: true })
    .click();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await browser.route(
    `**/api/boards/${boardId}/events/${eventId}`,
    async (route) => {
      await held;
      return route.fulfill({
        status: 403,
        json: { detail: "Old event is unavailable" },
      });
    },
  );
  try {
    const entered = browser.waitForRequest(
      (request) =>
        new URL(request.url()).pathname ===
        `/api/boards/${boardId}/events/${eventId}`,
    );
    api.change();
    await sendOpenViewEvent(browser, "invalidate", {
      entity: "board_events",
      board_id: boardId,
    });
    await entered;
    await browser.getByRole("button", { name: "Cancel", exact: true }).click();
    // Cancel returns to the event's sheet; closing it leaves the month.
    await browser.getByRole("button", { name: "Close event" }).click();
    await browser
      .getByRole("button", { name: "New event", exact: true })
      .click();
    await browser
      .getByLabel("Event title", { exact: true })
      .fill("My new local event");
    const completed = browser.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        `/api/boards/${boardId}/events/${eventId}`,
    );
    release();
    await completed;
    await expect(
      browser.getByLabel("Event title", { exact: true }),
    ).toHaveValue("My new local event");
    await expect(
      browser.getByText(
        "This event or Board is no longer available. The editor was closed.",
        { exact: true },
      ),
    ).toHaveCount(0);
    expect(api.writes).toHaveLength(0);
  } finally {
    release();
  }
});

test.describe("Boards workspace regional dates", () => {
  test.use({ locale: "en-US", timezoneId: "UTC" });

  for (const [personal, title] of [
    [
      false,
      "calendar localizes dates without shifting all-day dates or replacing the event timezone",
    ],
    [
      true,
      "Boards personal week and clock format preserve all-day dates, event zone and query windows",
    ],
  ] as const) {
    test(title, async ({ page: browser }) => {
      await installSelectedEventApi(browser);
      if (personal) {
        await browser.setViewportSize({ width: 1440, height: 900 });
        await browser.route(`**/api/users/${authorId}/preferences`, (route) =>
          route.fulfill({
            json: profilePreferences(authorId, {
              timezone: "Asia/Tokyo",
              date_format: "ymd",
              time_format: "12h",
              week_start: "sunday",
            }),
          }),
        );
      }
      const windows: { start: string | null; end: string | null }[] = [];
      browser.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/events/occurrences"))
          windows.push({
            start: url.searchParams.get("window_start"),
            end: url.searchParams.get("window_end"),
          });
      });
      await browser.route("**/api/workspace", (route) =>
        route.fulfill({
          json: {
            display_name: "OpenSlate",
            mark: "OS",
            logo_file_id: null,
            revision: 1,
            today: "2026-09-14",
            week_start: "monday",
            locale: "fr-FR",
            timezone: "America/Los_Angeles",
          },
        }),
      );
      const timedId = "00000000-0000-4000-8000-000000000099";
      const items = [
        {
          id: `${eventId}:2026-09-14`,
          event_id: eventId,
          date: "2026-09-14",
          start: "2026-09-14",
          end: "2026-09-16",
          event: {
            ...selectedEventWire,
            title: "Regional all-day event",
            start_date: "2026-09-14",
            end_date: "2026-09-16",
          },
        },
        {
          id: `${timedId}:2026-09-14T01:00:00Z`,
          event_id: timedId,
          date: "2026-09-14",
          start: "2026-09-14T01:00:00Z",
          end: "2026-09-14T02:00:00Z",
          event: {
            ...selectedEventWire,
            id: timedId,
            title: "Regional timed event",
            all_day: false,
            start_date: null,
            end_date: null,
            start_at: "2026-09-14T01:00:00Z",
            end_at: "2026-09-14T02:00:00Z",
            timezone_name: "Asia/Manila",
          },
        },
      ];
      await browser.route(
        `**/api/boards/${boardId}/events/occurrences?**`,
        (route) =>
          route.fulfill({
            json: {
              items,
              pagination: wirePagination({ limit: 100, count: 2, total: 2 }),
              board_revision: 1,
            },
          }),
      );
      // The sheet reads each event's detail.
      for (const item of items)
        await browser.route(
          `**/api/boards/${boardId}/events/${item.event_id}`,
          (route) => route.fulfill({ json: item.event }),
        );
      await browser.goto(`/boards?board=${boardId}&section=calendar`);
      await expect(
        browser.getByRole("heading", { name: "septembre 2026", exact: true }),
      ).toBeVisible();
      const day = browser.getByRole("button", {
        name: "lun. 14 sept.",
        exact: true,
      });
      await expect(day).toHaveAttribute("aria-current", "date");
      await browser
        .getByRole("button", { name: /^Regional all-day event,/ })
        .click();
      const sheet = browser.getByRole("dialog", {
        name: "Regional all-day event",
      });
      await expect(
        sheet.getByText("All day · lun. 14 sept.–mer. 16 sept.", {
          exact: true,
        }),
      ).toBeVisible();
      await sheet.getByRole("button", { name: "Close event" }).click();
      await browser
        .getByRole("button", { name: /^Regional timed event,/ })
        .click();
      await expect(
        browser
          .getByRole("dialog", { name: "Regional timed event" })
          .getByText(
            personal
              ? /lun\. 14 sept\..*9:00\sAM.*lun\. 14 sept\..*10:00\sAM.*Asia\/Manila/
              : /lun\. 14 sept\..*0?9:00.*lun\. 14 sept\..*10:00.*Asia\/Manila/,
          ),
      ).toBeVisible();
      await browser.getByRole("button", { name: "Close event" }).click();
      if (personal) {
        const calendar = browser.getByRole("region", {
          name: "septembre 2026 calendar",
          exact: true,
        });
        await expect(
          calendar.getByText(/^(dim\.|lun\.|mar\.|mer\.|jeu\.|ven\.|sam\.)$/),
        ).toHaveText(["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."]);
      }
      expect(windows.length).toBeGreaterThan(0);
      expect(
        windows.every(
          ({ start, end }) => start === "2026-09-01" && end === "2026-09-30",
        ),
      ).toBe(true);
    });
  }
});

test.describe("organization calendar week start", () => {
  for (const weekStart of ["monday", "sunday"] as const) {
    test(`Boards ${weekStart} preference aligns dates with weekdays and retains the selected day`, async ({
      page: browser,
    }) => {
      await installSelectedEventApi(browser, weekStart);
      const windows: { start: string | null; end: string | null }[] = [];
      browser.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/events/occurrences"))
          windows.push({
            start: url.searchParams.get("window_start"),
            end: url.searchParams.get("window_end"),
          });
      });
      await browser.goto(`/boards?board=${boardId}&section=calendar`);
      const calendar = browser.getByRole("region", {
        name: "September 2026 calendar",
        exact: true,
      });
      await expect(calendar).toBeVisible();
      await expect(
        calendar.getByText(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/),
      ).toHaveText(
        weekStart === "monday"
          ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
          : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      );
      const tuesday = await calendar
        .getByText("Tue", { exact: true })
        .boundingBox();
      const firstDay = await calendar
        .getByRole("button", { name: "Tue, Sep 1", exact: true })
        .boundingBox();
      expect(tuesday).not.toBeNull();
      expect(firstDay).not.toBeNull();
      // The day number sits at the left of the weekday's column.
      expect(Math.abs(firstDay!.x - tuesday!.x)).toBeLessThan(8);
      await expect
        .poll(() => windows.at(-1))
        .toEqual({ start: "2026-09-01", end: "2026-09-30" });
      // A day number opens its week, which starts on the week start.
      await calendar
        .getByRole("button", { name: "Wed, Sep 16", exact: true })
        .click();
      await expect
        .poll(() => windows.at(-1))
        .toEqual(
          weekStart === "monday"
            ? { start: "2026-09-14", end: "2026-09-20" }
            : { start: "2026-09-13", end: "2026-09-19" },
        );
      await expect(
        browser.getByRole("heading", {
          name:
            weekStart === "monday"
              ? "Sep 14 – Sep 20, 2026"
              : "Sep 13 – Sep 19, 2026",
          exact: true,
        }),
      ).toBeVisible();
    });
  }
});

test("URL-selected event opens outside the month, survives reload, and closes only its target", async ({
  page: browser,
}) => {
  await installSelectedEventApi(browser);
  const href = `/boards?board=${boardId}&section=calendar&event=${eventId}&post=${authorId}&keep=chosen`;
  await browser.goto(href);
  const reader = browser.getByRole("dialog", {
    name: selectedEventWire.title,
    exact: true,
  });
  await expect(reader).toBeVisible();
  await expect(
    reader.getByText(selectedEventWire.details, { exact: true }),
  ).toBeVisible();
  await expect(
    reader.getByText(selectedEventWire.location, { exact: true }),
  ).toBeVisible();
  await expect(reader.getByText(/All day.*Dec 14.*Dec 16/)).toBeVisible();
  await expect(
    reader.getByRole("link", { name: /Planning guide/ }),
  ).toHaveAttribute("rel", "noopener noreferrer");
  await expect(
    reader.getByRole("button", { name: /Edit|Archive/ }),
  ).toHaveCount(0);
  await expect(reader.locator("script")).toHaveCount(0);
  await browser.reload();
  await expect(reader).toBeVisible();
  await browser.keyboard.press("Escape");
  await expect(reader).toHaveCount(0);
  await expect(browser).toHaveURL(
    (url) =>
      !url.searchParams.has("event") &&
      url.searchParams.get("board") === boardId &&
      url.searchParams.get("section") === "calendar" &&
      url.searchParams.get("post") === authorId &&
      url.searchParams.get("keep") === "chosen",
  );
  await expect(
    browser.getByRole("button", { name: "Today", exact: true }),
  ).toBeFocused();
  await expect(
    browser.getByRole("heading", { name: "September 2026", exact: true }),
  ).toBeVisible();
});

test("URL-selected event rejects invalid, missing, and denied targets without private content", async ({
  page: browser,
}) => {
  await installSelectedEventApi(browser);
  const reads: string[] = [];
  browser.on("request", (request) => {
    if (
      new URL(request.url()).pathname ===
      `/api/boards/${boardId}/events/invalid`
    )
      reads.push(request.url());
  });
  await browser.goto(`/boards?board=${boardId}&section=calendar&event=invalid`);
  const unavailable = browser.getByRole("dialog", {
    name: "Event unavailable",
    exact: true,
  });
  await expect(unavailable).toBeVisible();
  expect(reads).toEqual([]);
  for (const status of [403, 404]) {
    await browser.route(`**/api/boards/${boardId}/events/${eventId}`, (route) =>
      route.fulfill({ status, json: { detail: "Private event title" } }),
    );
    await browser.goto(
      `/boards?board=${boardId}&section=calendar&event=${eventId}`,
    );
    await expect(unavailable).toBeVisible();
    await expect(unavailable.getByText("Private event title")).toHaveCount(0);
    await expect(unavailable.getByText(selectedEventWire.details)).toHaveCount(
      0,
    );
    await unavailable.getByRole("button", { name: "Close event" }).click();
    await expect(browser).toHaveURL((url) => !url.searchParams.has("event"));
  }
});

test("URL-selected event retries a failed detail read without changing the calendar month", async ({
  page: browser,
}) => {
  await installSelectedEventApi(browser);
  // A held event stream sends no resync, so only Retry can recover the read.
  await browser.route(eventStreamUrl, () => undefined);
  let available = false;
  await browser.route(`**/api/boards/${boardId}/events/${eventId}`, (route) =>
    route.fulfill(
      available
        ? { json: selectedEventWire }
        : { status: 503, json: { detail: "Unavailable" } },
    ),
  );
  await browser.goto(
    `/boards?board=${boardId}&section=calendar&event=${eventId}`,
  );
  const unavailable = browser.getByRole("dialog", {
    name: "Event unavailable",
  });
  await expect(unavailable).toBeVisible();
  const retry = unavailable.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  available = true;
  await retry.click();
  await expect(
    browser.getByRole("dialog", { name: selectedEventWire.title }),
  ).toBeVisible();
});

test("closing a URL-selected event ignores its late detail response", async ({
  page: browser,
}) => {
  await installSelectedEventApi(browser);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await browser.route(
    `**/api/boards/${boardId}/events/${eventId}`,
    async (route) => {
      await held;
      await route.fulfill({ json: selectedEventWire });
    },
  );
  const requested = browser.waitForRequest(
    `**/api/boards/${boardId}/events/${eventId}`,
  );
  await browser.goto(
    `/boards?board=${boardId}&section=calendar&event=${eventId}`,
  );
  await requested;
  await browser
    .getByRole("dialog")
    .getByRole("button", { name: "Close event" })
    .click();
  await expect(browser).toHaveURL((url) => !url.searchParams.has("event"));
  const response = browser.waitForResponse(
    `**/api/boards/${boardId}/events/${eventId}`,
  );
  release();
  await response;
  await expect(browser.getByRole("dialog")).toHaveCount(0);
});

async function installArchivedEventPurge(
  browser: Page,
  role: "admin" | "member" = "admin",
  failChallenge = false,
  holdPreview = false,
) {
  await installOpenViewEventSource(browser);
  await installSelectedEventApi(browser);
  await browser.route("**/api/auth/me", (route) =>
    route.fulfill({ json: authMeBody({ id: authorId, role, access: [] }) }),
  );
  const workspace = {
    display_name: "OpenSlate",
    mark: "OS",
    logo_file_id: null,
    revision: 1,
    today: "2026-09-14",
    week_start: "monday",
    locale: "en-US",
    timezone: "UTC",
    purge_enabled: true,
  };
  await browser.route("**/api/workspace", (route) =>
    route.fulfill({ json: workspace }),
  );
  let releasePreview = () => {};
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  await browser.route(`**/api/boards/${boardId}/my-access`, (route) =>
    route.fulfill({
      json: {
        level: "manage",
        read: true,
        write: true,
        manage: true,
      },
    }),
  );
  const impact = {
    target_type: "board_event",
    target_id: eventId,
    actor_id: authorId,
    operation: "purge",
    rows: [],
    external_impacts: [],
    key_strips: [],
    blockers: [],
    impact_digest: "a".repeat(64),
  };
  let purges = 0;
  let deleted = false;
  await browser.route(`**/api/boards/${boardId}/events?**`, (route) => {
    const items = deleted ? [] : [{ ...selectedEventWire, archived: true }];
    return route.fulfill({
      json: {
        ...pageOf(items, { limit: 25 }),
        board_revision: deleted ? 2 : 1,
      },
    });
  });
  await browser.route(
    `**/api/boards/${boardId}/events/${eventId}/purge**`,
    async (route) => {
      if (route.request().url().endsWith("/preview")) {
        if (holdPreview) await previewGate;
        return route.fulfill({
          json: {
            impact,
            token: "owned-event-preview",
            expires_at: "2026-09-26T00:00:00Z",
            confirmation_name: selectedEventWire.title,
            last_successful_backup_at: null,
          },
        });
      }
      purges += 1;
      expect(route.request().postDataJSON()).toEqual({
        token: "owned-event-preview",
        confirmation_name: selectedEventWire.title,
        password: "synthetic-event-password",
      });
      if (failChallenge)
        return route.fulfill({
          status: 404,
          json: {
            detail: {
              code: "challenge_not_found",
              message: "private event internals",
            },
          },
        });
      deleted = true;
      return route.fulfill({ json: { impact, operation_id: null } });
    },
  );
  return {
    workspace,
    releasePreview,
    get purges() {
      return purges;
    },
  };
}

for (const failChallenge of [false, true]) {
  test(`archived event purge ${failChallenge ? "retains its row after an unavailable challenge" : "removes only its confirmed archived row"}`, async ({
    page: browser,
  }) => {
    const api = await installArchivedEventPurge(
      browser,
      "admin",
      failChallenge,
    );
    await browser.goto(`/boards?board=${boardId}&section=calendar`);
    await browser.getByRole("button", { name: "Show: All" }).click();
    await browser
      .getByRole("menuitemradio", { name: "Archived", exact: true })
      .click();
    const archived = browser.getByRole("region", {
      name: "Archived Board events",
      exact: true,
    });
    await archived
      .getByRole("button", {
        name: `Permanently delete ${selectedEventWire.title}`,
        exact: true,
      })
      .click();
    const review = browser.getByRole("dialog", {
      name: "Permanently delete event?",
    });
    await expect(
      review.getByText(
        "Last successful backup: No successful backup recorded.",
      ),
    ).toBeVisible();
    await review
      .getByLabel("Type the event name")
      .fill(selectedEventWire.title + " ");
    await review
      .getByLabel("Administrator password")
      .fill("synthetic-event-password");
    await expect(
      review.getByRole("button", {
        name: "Confirm permanent deletion",
        exact: true,
      }),
    ).toBeDisabled();
    expect(api.purges).toBe(0);
    await review
      .getByLabel("Type the event name")
      .fill(selectedEventWire.title);
    await review
      .getByRole("button", { name: "Confirm permanent deletion", exact: true })
      .click();
    if (failChallenge) {
      await expect(
        review.getByText("The review is unavailable. Request a new review."),
      ).toBeVisible();
      await review
        .getByRole("button", { name: "Review again", exact: true })
        .click();
      await expect(review.getByLabel("Administrator password")).toHaveValue("");
      await review.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(
        archived.getByRole("button", {
          name: `Restore ${selectedEventWire.title}`,
          exact: true,
        }),
      ).toBeVisible();
    } else {
      await expect(review).toBeHidden();
      await expect(
        archived.getByText(selectedEventWire.title, { exact: true }),
      ).toHaveCount(0);
      await expect(
        browser.getByText("Event permanently deleted.", { exact: true }),
      ).toBeVisible();
    }
    expect(api.purges).toBe(1);
    await expect(browser.getByText("private event internals")).toHaveCount(0);
  });
}

test("archived event remains restorable by a member without permanent-delete authority", async ({
  page: browser,
}) => {
  const api = await installArchivedEventPurge(browser, "member");
  await browser.goto(`/boards?board=${boardId}&section=calendar`);
  await browser.getByRole("button", { name: "Show: All" }).click();
  await browser
    .getByRole("menuitemradio", { name: "Archived", exact: true })
    .click();
  const archived = browser.getByRole("region", {
    name: "Archived Board events",
    exact: true,
  });
  await expect(
    archived.getByRole("button", {
      name: `Restore ${selectedEventWire.title}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    archived.getByRole("button", {
      name: `Permanently delete ${selectedEventWire.title}`,
      exact: true,
    }),
  ).toHaveCount(0);
  expect(api.purges).toBe(0);
});

test("pending event review can recover after purge setting changes without accepting its late preview", async ({
  page: browser,
}) => {
  const api = await installArchivedEventPurge(browser, "admin", false, true);
  await browser.goto(`/boards?board=${boardId}&section=calendar`);
  await browser.getByRole("button", { name: "Show: All" }).click();
  await browser
    .getByRole("menuitemradio", { name: "Archived", exact: true })
    .click();
  const archived = browser.getByRole("region", {
    name: "Archived Board events",
    exact: true,
  });
  const begin = archived.getByRole("button", {
    name: `Permanently delete ${selectedEventWire.title}`,
    exact: true,
  });
  await begin.click();
  await expect(
    browser
      .getByRole("dialog", { name: "Permanently delete event?" })
      .getByText("Preparing review…"),
  ).toBeVisible();
  api.workspace.purge_enabled = false;
  await sendOpenViewEvent(browser, "invalidate", {
    entity: "workspace_profiles",
  });
  await expect(
    browser.getByRole("dialog", { name: "Permanently delete event?" }),
  ).toBeHidden();
  const released = browser.waitForResponse((response) =>
    response.url().endsWith("/purge/preview"),
  );
  api.releasePreview();
  await released;
  api.workspace.purge_enabled = true;
  await sendOpenViewEvent(browser, "invalidate", {
    entity: "workspace_profiles",
  });
  await expect(begin).toBeVisible();
  await expect(begin).toBeEnabled();
  expect(api.purges).toBe(0);
});
test("admin purges archived-parent event while ordinary lifecycle editing stays unavailable", async ({
  page: browser,
}) => {
  const api = await installArchivedEventPurge(browser);
  const archivedParent = wireBoard({
    id: boardId,
    name: "Calendar board",
    description: "Current calendar",
    status: "archived",
    level: "manage",
    created_at: selectedEventWire.created_at,
    updated_at: selectedEventWire.updated_at,
  });
  await browser.route(`**/api/boards/${boardId}`, (route) =>
    route.fulfill({ json: archivedParent }),
  );
  await browser.route("**/api/boards?**", (route) =>
    route.fulfill({
      json: pageOf([archivedParent], { limit: 25 }),
    }),
  );
  await browser.goto(
    `/boards?board=${boardId}&section=calendar&status=archived`,
  );
  await expect(
    browser.getByRole("button", { name: "Show: All" }),
  ).toBeVisible();
  await browser.getByRole("button", { name: "Show: All" }).click();
  await browser
    .getByRole("menuitemradio", { name: "Archived", exact: true })
    .click();
  const archived = browser.getByRole("region", {
    name: "Archived Board events",
    exact: true,
  });
  await expect(
    archived.getByText(selectedEventWire.title, { exact: true }),
  ).toBeVisible();
  await expect(
    archived.getByRole("button", {
      name: `Restore ${selectedEventWire.title}`,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    browser.getByRole("button", { name: "New event", exact: true }),
  ).toHaveCount(0);
  await expect(
    browser.getByRole("button", { name: "Edit event", exact: true }),
  ).toHaveCount(0);
  await archived
    .getByRole("button", {
      name: `Permanently delete ${selectedEventWire.title}`,
      exact: true,
    })
    .click();
  const review = browser.getByRole("dialog", {
    name: "Permanently delete event?",
  });
  await review.getByLabel("Type the event name").fill(selectedEventWire.title);
  await review
    .getByLabel("Administrator password")
    .fill("synthetic-event-password");
  await review
    .getByRole("button", { name: "Confirm permanent deletion", exact: true })
    .click();
  await expect(review).toBeHidden();
  await expect(
    archived.getByText(selectedEventWire.title, { exact: true }),
  ).toHaveCount(0);
  expect(api.purges).toBe(1);
});

test("archived-parent admin retains current-access retry after an event-list failure", async ({
  page: browser,
}) => {
  await installArchivedEventPurge(browser);
  const parent = wireBoard({
    id: boardId,
    name: "Calendar board",
    description: "Current calendar",
    status: "archived",
    level: "manage",
    created_at: selectedEventWire.created_at,
    updated_at: selectedEventWire.updated_at,
  });
  await browser.route(`**/api/boards/${boardId}`, (route) =>
    route.fulfill({ json: parent }),
  );
  await browser.route("**/api/boards?**", (route) =>
    route.fulfill({
      json: pageOf([parent], { limit: 25 }),
    }),
  );
  let fail = true,
    reads = 0;
  await browser.route(`**/api/boards/${boardId}/events?**`, (route) => {
    reads += 1;
    if (fail)
      return route.fulfill({
        status: 503,
        json: { detail: "Private dependency failure" },
      });
    return route.fulfill({
      json: {
        ...pageOf([{ ...selectedEventWire, archived: true }], { limit: 25 }),
        board_revision: 1,
      },
    });
  });
  await browser.goto(
    `/boards?board=${boardId}&section=calendar&status=archived`,
  );
  await browser.getByRole("button", { name: "Show: All" }).click();
  await browser
    .getByRole("menuitemradio", { name: "Archived", exact: true })
    .click();
  const retry = browser.getByRole("button", {
    name: "Retry archived events",
    exact: true,
  });
  await expect(retry).toBeVisible();
  await expect(browser.getByText("Private dependency failure")).toHaveCount(0);
  await expect(
    browser.getByRole("button", {
      name: `Permanently delete ${selectedEventWire.title}`,
      exact: true,
    }),
  ).toHaveCount(0);
  fail = false;
  await retry.click();
  await expect(
    browser.getByRole("button", {
      name: `Permanently delete ${selectedEventWire.title}`,
      exact: true,
    }),
  ).toBeVisible();
  expect(reads).toBe(2);
  await expect(
    browser.getByRole("button", {
      name: `Restore ${selectedEventWire.title}`,
      exact: true,
    }),
  ).toHaveCount(0);
});
