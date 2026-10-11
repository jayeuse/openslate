import { expect, test, type Page, isEventStream } from "./helpers/test";
import { profilePreferences } from "./helpers/profile-api";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyAppearancePreferences } from "../../src/lib/appearance-preferences";
import type {
  BoardEventOccurrencePage,
  BoardEventPage,
} from "../../src/components/systems/boards/adapters/board-events-api";
import {
  ServerBoardCalendarDisplay,
  calendarDayCountLabel,
  canEditBoardEvent,
} from "../../src/components/systems/boards/components/server-backed-board-calendar";
import {
  prepareBoardEventLifecycleAction,
  ServerArchivedBoardEventsDisplay,
} from "../../src/components/systems/boards/components/server-backed-board-event-lifecycle";
import {
  BoardEventDraftError,
  boardEventDraftFromEvent,
  boardEventInputFromDraft,
  newBoardEventDraft,
  prepareBoardEventConflictRetry,
} from "../../src/components/systems/boards/components/server-backed-board-event-editor";
import {
  calendarWindowForMonth,
  shiftCalendarMonth,
  transitionCalendarState,
  type CalendarState,
} from "../../src/components/systems/boards/hooks/use-server-board-events";
import { hideDevOverlay } from "./helpers/test-styles";

const boardId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";
const authorId = "00000000-0000-4000-8000-000000000003";
test.use({ trace: "off", screenshot: "off", video: "off" });
const visibleOccurrence: BoardEventOccurrencePage["items"][number] = {
  id: `${eventId}:2026-09-14`,
  eventId,
  date: "2026-09-14",
  start: "2026-09-14",
  end: "2026-09-16",
  event: {
    id: eventId,
    boardId,
    authorId,
    title: "Visible planning session",
    details: "",
    location: "",
    links: [],
    allDay: true,
    startDate: "2026-09-14",
    endDate: "2026-09-16",
    startAt: null,
    endAt: null,
    timezoneName: "Asia/Manila",
    recurrence: "none",
    repeatUntil: null,
    reminders: ["1d"],
    archived: false,
    revision: 1,
    boardRevision: 1,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  },
};
const page: BoardEventOccurrencePage = {
  items: [visibleOccurrence],
  pagination: { limit: 100, offset: 0, count: 1, total: 1, hasMore: false },
  boardRevision: 1,
};

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
  const board = {
    id: boardId,
    scope: "project",
    department_id: null,
    name: "Calendar board",
    description: "Current calendar",
    status: "active",
    revision: 1,
    level: "read",
    created_at: selectedEventWire.created_at,
    updated_at: selectedEventWire.updated_at,
  };
  await browser.route("**/api/**", (route) =>
    isEventStream(route)
      ? route.fallback()
      : route.fulfill({
          status: 404,
          json: { detail: "Unavailable in calendar test" },
        }),
  );
  await browser.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { id: authorId, role: "member", access: [] } }),
  );
  await browser.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: { authenticated: true, user_id: authorId, setup_required: false },
    }),
  );
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
    const emptyPagination = {
      limit: 100,
      offset: 0,
      count: 0,
      total: 0,
      has_more: false,
    };
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
    const board = {
      id: boardId,
      scope: "project",
      department_id: null,
      name: "Calendar board",
      description: "Current calendar",
      status: "active",
      revision: saved.board_revision,
      level: "manage",
      created_at: saved.created_at,
      updated_at: saved.updated_at,
    };
    const pagination = {
      limit: 25,
      offset: 0,
      count: 1,
      total: 1,
      has_more: false,
    };
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
  test(`S11 event invalidation ${dirty ? "retains the dirty event and offers review latest" : "updates the clean event editor"}`, async ({
    page: browser,
  }) => {
    const api = await installS11EventApi(browser);
    await browser.goto(`/boards?board=${boardId}&section=calendar`);
    await browser.getByText("View event", { exact: true }).click();
    await browser
      .getByRole("button", {
        name: `Edit ${selectedEventWire.title}`,
        exact: true,
      })
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
        browser.getByText("Changed by someone else — review latest", {
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
      if (process.env.OPENVIEW_CAPTURE_DIR) {
        await hideDevOverlay(browser);
        await browser.evaluate(() => document.fonts.ready);
        const notice = browser.getByText(
          "Changed by someone else — review latest",
          { exact: true },
        );
        const originalViewport = browser.viewportSize();
        for (const mode of ["light", "dark"] as const) {
          await browser.evaluate(applyAppearancePreferences, {
            mode,
            reduceMotion: true,
          });
          for (const viewport of [
            { width: 1440, height: 900 },
            { width: 390, height: 844 },
          ]) {
            await browser.setViewportSize(viewport);
            await notice.evaluate((element) =>
              element.scrollIntoView({
                block: "center",
                behavior: "instant",
              }),
            );
            await expect(notice).toBeInViewport();
            expect(
              await browser.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            await browser.screenshot({
              path: `${process.env.OPENVIEW_CAPTURE_DIR}/s11-dirty-event-${mode}-${viewport.width}x${viewport.height}.png`,
              animations: "disabled",
              fullPage: false,
            });
          }
        }
        if (originalViewport) await browser.setViewportSize(originalViewport);
        const latest = browser.getByRole("button", {
          name: "Load latest event and discard my draft",
          exact: true,
        });
        await latest.focus();
        await expect(latest).toBeFocused();
        await latest.press("Enter");
        await expect(title).toHaveValue("Remote event title");
      }
    } else {
      await expect(title).toHaveValue("Remote event title");
      await expect(browser.getByLabel("Details", { exact: true })).toHaveValue(
        "Remote planning details",
      );
      await expect(
        browser.getByText("Changed by someone else — review latest", {
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

test("S11 an old live event refusal cannot close a newly created local draft", async ({
  page: browser,
}) => {
  const api = await installS11EventApi(browser);
  await browser.goto(`/boards?board=${boardId}&section=calendar`);
  await browser.getByText("View event", { exact: true }).click();
  await browser
    .getByRole("button", {
      name: `Edit ${selectedEventWire.title}`,
      exact: true,
    })
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

  for (const personal of [false, true]) {
    test(
      personal
        ? "S21 Boards personal week and clock format preserve all-day dates, event zone and query windows"
        : "calendar localizes dates without shifting all-day dates or replacing the event timezone",
      async ({ page: browser }) => {
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
                pagination: {
                  limit: 100,
                  offset: 0,
                  count: 2,
                  total: 2,
                  has_more: false,
                },
                board_revision: 1,
              },
            }),
        );
        await browser.goto(`/boards?board=${boardId}&section=calendar`);
        await expect(
          browser.getByRole("heading", { name: "septembre 2026", exact: true }),
        ).toBeVisible();
        const day = browser.getByRole("button", {
          name: /View lun\. 14 sept\./,
        });
        await expect(day).toHaveAttribute("aria-current", "date");
        await day.click();
        await expect(
          browser.getByText("All day · lun. 14 sept.–mer. 16 sept.", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          browser.getByText(
            personal
              ? /lun\. 14 sept\..*9:00\sAM.*lun\. 14 sept\..*10:00\sAM.*Asia\/Manila/
              : /lun\. 14 sept\..*0?9:00.*lun\. 14 sept\..*10:00.*Asia\/Manila/,
          ),
        ).toBeVisible();
        if (personal) {
          const calendar = browser.getByRole("region", {
            name: "septembre 2026 calendar",
            exact: true,
          });
          await expect(
            calendar.getByText(/^(dim\.|lun\.|mar\.|mer\.|jeu\.|ven\.|sam\.)$/),
          ).toHaveText([
            "dim.",
            "lun.",
            "mar.",
            "mer.",
            "jeu.",
            "ven.",
            "sam.",
          ]);
        }
        expect(windows.length).toBeGreaterThan(0);
        expect(
          windows.every(
            ({ start, end }) => start === "2026-09-01" && end === "2026-09-30",
          ),
        ).toBe(true);
      },
    );
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
        .getByRole("button", { name: "View Tue, Sep 1, 0 events", exact: true })
        .boundingBox();
      expect(tuesday).not.toBeNull();
      expect(firstDay).not.toBeNull();
      expect(
        Math.abs(
          firstDay!.x + firstDay!.width / 2 - (tuesday!.x + tuesday!.width / 2),
        ),
      ).toBeLessThan(2);
      const selected = calendar.getByRole("button", {
        name: "View Wed, Sep 16, 0 events",
        exact: true,
      });
      await selected.click();
      await expect(selected).toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(() => windows.at(-1))
        .toEqual({ start: "2026-09-01", end: "2026-09-30" });
      await expect(
        browser.getByRole("heading", { name: "Wed, Sep 16", exact: true }),
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
  await browser.route("**/api/events", () => undefined);
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

test("calendar month navigation requests one inclusive bounded month", () => {
  expect(calendarWindowForMonth("2026-09")).toMatchObject({
    start: "2026-09-01",
    end: "2026-09-30",
  });
  expect(shiftCalendarMonth("2026-12", 1)).toBe("2027-01");
  expect(shiftCalendarMonth("2026-01", -1)).toBe("2025-12");
});

test("calendar appends the next page only while Board revision and occurrence total are stable", async () => {
  const eventsHookModule =
    await import("../../src/components/systems/boards/hooks/use-server-board-events");
  const merge = eventsHookModule.mergeCalendarOccurrencePages as (
    first: BoardEventOccurrencePage,
    next: BoardEventOccurrencePage,
  ) => BoardEventOccurrencePage | null;
  const first: BoardEventOccurrencePage = {
    ...page,
    pagination: { limit: 100, offset: 0, count: 1, total: 2, hasMore: true },
  };
  const nextItem = {
    ...visibleOccurrence,
    id: `${eventId}:2026-09-15`,
    date: "2026-09-15",
  };
  const next: BoardEventOccurrencePage = {
    ...page,
    items: [nextItem],
    pagination: { limit: 100, offset: 1, count: 1, total: 2, hasMore: false },
  };
  const merged = merge(first, next);
  expect(merged?.items.map((item) => item.id)).toEqual([
    visibleOccurrence.id,
    nextItem.id,
  ]);
  expect(merged?.pagination).toEqual({
    limit: 100,
    offset: 0,
    count: 2,
    total: 2,
    hasMore: false,
  });
  expect(merge(first, { ...next, boardRevision: 2 })).toBeNull();
  expect(
    merge(first, { ...next, pagination: { ...next.pagination, total: 3 } }),
  ).toBeNull();
});

test("calendar compact default follows the 1024px boundary", async () => {
  const calendarModule =
    await import("../../src/components/systems/boards/components/server-backed-board-calendar");
  const defaultView = calendarModule.defaultCalendarViewForViewport as (
    compact: boolean,
  ) => "agenda" | "month";
  expect(defaultView(true)).toBe("agenda");
  expect(defaultView(false)).toBe("month");
});

test("calendar renders only returned occurrences and marks all-day range", () => {
  const html = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      region: { locale: "en-US", timezone: "UTC" },
      page,
      window: calendarWindowForMonth("2026-09"),
      date: "2026-09-15",
    }),
  );
  expect(html).toContain("Visible planning session");
  expect(html).toContain("All day");
  expect(html).toContain("Sep 15");
  expect(html).not.toContain("Hidden payroll review");
  expect(html).not.toContain("sample-board");
  const afterRange = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      region: { locale: "en-US", timezone: "UTC" },
      page,
      window: calendarWindowForMonth("2026-09"),
      date: "2026-09-17",
    }),
  );
  expect(afterRange).not.toContain("Visible planning session");
});

test("calendar shows an edit action only for an explicitly authorized returned event", () => {
  const window = calendarWindowForMonth("2026-09");
  const allowed = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      region: { locale: "en-US", timezone: "UTC" },
      page,
      window,
      date: "2026-09-15",
      canEditEvent: () => true,
      onEditEvent: () => undefined,
    }),
  );
  expect(allowed).toContain("Edit Visible planning session");
  const denied = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      region: { locale: "en-US", timezone: "UTC" },
      page,
      window,
      date: "2026-09-15",
      canEditEvent: () => false,
      onEditEvent: () => undefined,
    }),
  );
  expect(denied).not.toContain("Edit Visible planning session");
  const noAccess = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      region: { locale: "en-US", timezone: "UTC" },
      page,
      window,
      date: "2026-09-15",
    }),
  );
  expect(noAccess).not.toContain("Edit Visible planning session");
});

test("calendar renders archive only when the supplied event policy allows it", () => {
  const window = calendarWindowForMonth("2026-09");
  const manager = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      region: { locale: "en-US", timezone: "UTC" },
      page,
      window,
      date: "2026-09-15",
      canEditEvent: () => true,
      onEditEvent: () => undefined,
      canArchiveEvent: () => true,
      onArchiveEvent: () => undefined,
    }),
  );
  expect(manager).toContain("Archive Visible planning session");
  const editor = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      region: { locale: "en-US", timezone: "UTC" },
      page,
      window,
      date: "2026-09-15",
      canEditEvent: () => true,
      onEditEvent: () => undefined,
      canArchiveEvent: () => false,
      onArchiveEvent: () => undefined,
    }),
  );
  expect(editor).toContain("Edit Visible planning session");
  expect(editor).not.toContain("Archive Visible planning session");
});

test("event edit authority requires current Board edit and author or manager", () => {
  const event = visibleOccurrence.event;
  const author = {
    level: "write" as const,
    view: true,
    edit: true,
    manage: false,
  };
  expect(canEditBoardEvent(event, boardId, authorId, author, true)).toBe(true);
  expect(canEditBoardEvent(event, boardId, eventId, author, true)).toBe(false);
  expect(
    canEditBoardEvent(
      event,
      boardId,
      eventId,
      { ...author, level: "manage" as const, manage: true },
      true,
    ),
  ).toBe(true);
  expect(
    canEditBoardEvent(
      event,
      boardId,
      authorId,
      { ...author, level: "read" as const, edit: false },
      true,
    ),
  ).toBe(false);
  expect(canEditBoardEvent(event, boardId, authorId, author, false)).toBe(
    false,
  );
  expect(canEditBoardEvent(event, eventId, authorId, author, true)).toBe(false);
  expect(
    canEditBoardEvent(
      { ...event, archived: true },
      boardId,
      authorId,
      author,
      true,
    ),
  ).toBe(false);
});

test("event lifecycle fails closed for author edit without a viewer ID and requires current revision", () => {
  const event = visibleOccurrence.event;
  const author = {
    level: "write" as const,
    view: true,
    edit: true,
    manage: false,
  };
  expect(
    prepareBoardEventLifecycleAction(
      event,
      boardId,
      1,
      author,
      true,
      "archive",
    ),
  ).toBeNull();
  const manager = {
    level: "manage" as const,
    view: true,
    edit: true,
    manage: true,
  };
  expect(
    prepareBoardEventLifecycleAction(
      event,
      boardId,
      1,
      manager,
      true,
      "archive",
    ),
  ).toMatchObject({
    kind: "archive",
    boardId,
    eventId,
    boardRevision: 1,
    eventRevision: 1,
  });
  expect(
    prepareBoardEventLifecycleAction(
      event,
      boardId,
      2,
      manager,
      true,
      "archive",
    ),
  ).toBeNull();
  expect(
    prepareBoardEventLifecycleAction(
      event,
      eventId,
      1,
      manager,
      true,
      "archive",
    ),
  ).toBeNull();
  expect(
    prepareBoardEventLifecycleAction(
      event,
      boardId,
      1,
      manager,
      false,
      "archive",
    ),
  ).toBeNull();
  expect(
    prepareBoardEventLifecycleAction(
      event,
      boardId,
      1,
      manager,
      true,
      "restore",
    ),
  ).toBeNull();
  expect(
    prepareBoardEventLifecycleAction(
      { ...event, archived: true },
      boardId,
      1,
      manager,
      true,
      "restore",
    ),
  ).toMatchObject({ kind: "restore", eventId });
});

test("archived event list exposes only returned content and gated restore actions", () => {
  const archived = { ...visibleOccurrence.event, archived: true };
  const archivedPage: BoardEventPage = {
    items: [archived],
    pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
    boardRevision: 1,
  };
  const markup = (allowed: boolean) =>
    renderToStaticMarkup(
      createElement(ServerArchivedBoardEventsDisplay, {
        page: archivedPage,
        canRestoreEvent: () => allowed,
        onRestoreEvent: () => undefined,
      }),
    );
  expect(markup(true)).toContain("Restore Visible planning session");
  expect(markup(false)).not.toContain("Restore Visible planning session");
  expect(markup(true)).not.toContain("Hidden payroll review");
  expect(markup(true)).not.toContain(authorId);
});

test("event editor creates valid all-day series input and retains client draft on invalid dates", () => {
  const draft = {
    ...newBoardEventDraft(boardId, 5, "2026-09-15"),
    title: "  Safety briefing  ",
    recurrence: "weekly" as const,
    repeatUntil: "2026-10-15",
  };
  expect(boardEventInputFromDraft(draft)).toMatchObject({
    boardRevision: 5,
    title: "Safety briefing",
    allDay: true,
    startDate: "2026-09-15",
    endDate: "2026-09-15",
    repeatUntil: "2026-10-15",
    reminders: [],
  });
  expect(() =>
    boardEventInputFromDraft({ ...draft, end: "2026-09-14" }),
  ).toThrow(BoardEventDraftError);
  expect(() =>
    boardEventInputFromDraft({ ...draft, repeatUntil: "2026-09-01" }),
  ).toThrow(BoardEventDraftError);
});

test("event editor sends reminder timings for a new event and only changed timings for an edit", () => {
  const draft = {
    ...newBoardEventDraft(boardId, 5, "2026-09-15"),
    title: "Department briefing",
    reminders: ["start" as const, "1d" as const],
  };
  expect(boardEventInputFromDraft(draft)).toMatchObject({
    reminders: ["1d", "start"],
  });
  const existing = boardEventDraftFromEvent(visibleOccurrence.event);
  expect(existing.reminders).toEqual(["1d"]);
  expect(
    boardEventInputFromDraft({ ...existing, title: "Renamed" }),
  ).not.toHaveProperty("reminders");
  expect(
    boardEventInputFromDraft({ ...existing, reminders: ["15m", "1d"] }),
  ).toMatchObject({ reminders: ["1d", "15m"] });
  expect(
    boardEventInputFromDraft({ ...existing, reminders: [] }),
  ).toMatchObject({ reminders: [] });
});

test("event editor retains external links and rejects unsafe link input", () => {
  const event = {
    ...visibleOccurrence.event,
    links: [{ label: "Safety policy", url: "https://example.org/safety" }],
  };
  const draft = boardEventDraftFromEvent(event);
  expect(draft.links).toEqual(event.links);
  expect(boardEventInputFromDraft(draft)).not.toHaveProperty("links");
  expect(
    boardEventInputFromDraft({
      ...newBoardEventDraft(boardId, 1, "2026-09-15"),
      title: "New linked event",
      links: event.links,
    }),
  ).toMatchObject({ links: event.links });
  expect(() =>
    boardEventInputFromDraft({
      ...draft,
      links: [{ label: "Unsafe", url: "javascript:alert(1)" }],
    }),
  ).toThrow(BoardEventDraftError);
  expect(() =>
    boardEventInputFromDraft({
      ...draft,
      links: [{ label: "Credentials", url: "https://name:secret@example.org" }],
    }),
  ).toThrow(BoardEventDraftError);
  expect(() =>
    boardEventInputFromDraft({
      ...draft,
      links: Array.from({ length: 21 }, (_, index) => ({
        label: `Link ${index + 1}`,
        url: "https://example.org",
      })),
    }),
  ).toThrow(BoardEventDraftError);
});

test("title-only conflict retry keeps the other editor's newer links", () => {
  const original = {
    ...visibleOccurrence.event,
    links: [{ label: "Old policy", url: "https://example.org/old" }],
  };
  const latestLinks = [{ label: "New policy", url: "https://example.org/new" }];
  const draft = { ...boardEventDraftFromEvent(original), title: "New title" };
  expect(boardEventInputFromDraft(draft)).not.toHaveProperty("links");
  const retry = prepareBoardEventConflictRetry(draft, {
    boardId,
    boardRevision: 7,
    boardActive: true,
    event: { ...original, revision: 3, boardRevision: 7, links: latestLinks },
  });
  expect(retry.links).toEqual(latestLinks);
  expect(boardEventInputFromDraft(retry)).toMatchObject({
    boardRevision: 7,
    eventRevision: 3,
    title: "New title",
  });
  expect(boardEventInputFromDraft(retry)).not.toHaveProperty("links");
});

test("intentional link replacement survives a conflict retry", () => {
  const original = {
    ...visibleOccurrence.event,
    links: [{ label: "Old policy", url: "https://example.org/old" }],
  };
  const myLinks = [{ label: "My policy", url: "https://example.org/mine" }];
  const latestLinks = [{ label: "New policy", url: "https://example.org/new" }];
  const draft = { ...boardEventDraftFromEvent(original), links: myLinks };
  expect(boardEventInputFromDraft(draft)).toMatchObject({ links: myLinks });
  const retry = prepareBoardEventConflictRetry(draft, {
    boardId,
    boardRevision: 7,
    boardActive: true,
    event: { ...original, revision: 3, boardRevision: 7, links: latestLinks },
  });
  expect(retry.links).toEqual(myLinks);
  expect(boardEventInputFromDraft(retry)).toMatchObject({
    boardRevision: 7,
    eventRevision: 3,
    links: myLinks,
  });
});

test("event editor updates timed series in its IANA timezone", () => {
  const event = {
    ...visibleOccurrence.event,
    allDay: false as const,
    startDate: null,
    endDate: null,
    startAt: "2026-09-14T01:00:00Z",
    endAt: "2026-09-14T02:00:00Z",
    recurrence: "weekly" as const,
    repeatUntil: "2026-10-15",
  };
  const draft = boardEventDraftFromEvent(event);
  expect(draft).toMatchObject({
    start: "2026-09-14T09:00",
    end: "2026-09-14T10:00",
  });
  const input = boardEventInputFromDraft(draft);
  expect(input).toMatchObject({
    eventRevision: 1,
    boardRevision: 1,
    allDay: false,
    startAt: "2026-09-14T01:00:00Z",
    endAt: "2026-09-14T02:00:00Z",
  });
  expect(input).not.toHaveProperty("audience");
});

test("editing event text preserves untouched subsecond UTC instants", () => {
  const event = {
    ...visibleOccurrence.event,
    allDay: false as const,
    startDate: null,
    endDate: null,
    startAt: "2026-09-14T01:00:00.123456Z",
    endAt: "2026-09-14T02:00:00.987654Z",
  };
  const draft = boardEventDraftFromEvent(event);
  expect(
    boardEventInputFromDraft({ ...draft, title: "Renamed" }),
  ).toMatchObject({
    startAt: event.startAt,
    endAt: event.endAt,
  });
});

test("switching an existing all-day event to timed clears date-only fields", () => {
  const draft = boardEventDraftFromEvent(visibleOccurrence.event);
  expect(
    boardEventInputFromDraft({
      ...draft,
      allDay: false,
      start: "2026-09-14T09:00",
      end: "2026-09-14T10:00",
      timezoneName: "Asia/Manila",
    }),
  ).toMatchObject({
    eventRevision: 1,
    allDay: false,
    startDate: null,
    endDate: null,
    startAt: "2026-09-14T01:00:00Z",
    endAt: "2026-09-14T02:00:00Z",
  });
});

test("explicit conflict retry uses fetched Board and Event revisions while retaining edits", () => {
  const stale = {
    ...boardEventDraftFromEvent(visibleOccurrence.event),
    title: "My revised planning session",
  };
  const latest = {
    boardId,
    boardRevision: 7,
    boardActive: true,
    event: {
      ...visibleOccurrence.event,
      revision: 3,
      boardRevision: 7,
      title: "Someone else's update",
    },
  };
  const retry = prepareBoardEventConflictRetry(stale, latest);
  expect(retry.title).toBe("My revised planning session");
  expect(boardEventInputFromDraft(retry)).toMatchObject({
    boardRevision: 7,
    eventRevision: 3,
    title: "My revised planning session",
  });
  const newEvent = {
    ...newBoardEventDraft(boardId, 2, "2026-09-15"),
    title: "New session",
  };
  expect(
    boardEventInputFromDraft(
      prepareBoardEventConflictRetry(newEvent, {
        boardId,
        boardRevision: 7,
        boardActive: true,
        event: null,
      }),
    ),
  ).toMatchObject({ boardRevision: 7, title: "New session" });
  expect(() =>
    prepareBoardEventConflictRetry(stale, {
      ...latest,
      event: { ...latest.event, id: "00000000-0000-4000-8000-000000000099" },
    }),
  ).toThrow(BoardEventDraftError);
  expect(() =>
    prepareBoardEventConflictRetry(stale, { ...latest, boardActive: false }),
  ).toThrow(BoardEventDraftError);
});

test("event editor requires an explicit UTC offset for ambiguous local times", () => {
  const draft = {
    ...newBoardEventDraft(boardId, 1, "2026-11-01"),
    title: "Clock change",
    allDay: false,
    start: "2026-11-01T01:15",
    end: "2026-11-01T01:45",
    timezoneName: "America/New_York",
  };
  expect(() => boardEventInputFromDraft(draft)).toThrow(/occurs twice/);
  expect(
    boardEventInputFromDraft({
      ...draft,
      startOffset: "-04:00",
      endOffset: "-05:00",
    }),
  ).toMatchObject({
    startAt: "2026-11-01T05:15:00Z",
    endAt: "2026-11-01T06:45:00Z",
  });
});

test("calendar renders returned external event links as safe labelled anchors", () => {
  const linked = {
    ...visibleOccurrence,
    event: {
      ...visibleOccurrence.event,
      links: [
        {
          label: "Safety <script>guide</script>",
          url: "https://example.org/guide?a=1&b=2",
        },
      ],
    },
  };
  const html = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      region: { locale: "en-US", timezone: "UTC" },
      page: { ...page, items: [linked] },
      window: calendarWindowForMonth("2026-09"),
      date: "2026-09-15",
    }),
  );
  expect(html).toContain("Safety &lt;script&gt;guide&lt;/script&gt;");
  expect(html).toContain('href="https://example.org/guide?a=1&amp;b=2"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('referrerPolicy="no-referrer"');
  expect(html).not.toContain("<script>");
});

test("calendar shows returned event details as escaped plain text", () => {
  const detailed = {
    ...visibleOccurrence,
    event: {
      ...visibleOccurrence.event,
      details: "Bring the <safety> checklist.",
    },
  };
  const html = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      region: { locale: "en-US", timezone: "UTC" },
      page: { ...page, items: [detailed] },
      window: calendarWindowForMonth("2026-09"),
      date: "2026-09-15",
    }),
  );
  expect(html).toContain("Bring the &lt;safety&gt; checklist.");
  expect(html).not.toContain("<safety>");
});

test("calendar keeps Agenda details inline and offers compact event details on demand", () => {
  const detailed = {
    ...visibleOccurrence,
    event: {
      ...visibleOccurrence.event,
      details: "Bring the planning checklist.",
      location: "Room 3",
    },
  };
  const detailedPage = { ...page, items: [detailed] };
  const window = calendarWindowForMonth("2026-09");
  const agenda = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      region: { locale: "en-US", timezone: "UTC" },
      page: detailedPage,
      window,
      canEditEvent: () => true,
      onEditEvent: () => undefined,
    }),
  );
  expect(agenda).toContain("Bring the planning checklist.");
  expect(agenda).toContain("Edit event");
  expect(agenda).not.toContain("<details");

  const compactProps = {
    region: { locale: "en-US", timezone: "UTC" },
    page: detailedPage,
    window,
    date: "2026-09-14",
    compact: true,
    canEditEvent: () => true,
    onEditEvent: () => undefined,
  };
  const selectedDay = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, compactProps),
  );
  expect(selectedDay).toContain("Visible planning session");
  expect(selectedDay).toContain("Room 3");
  expect(selectedDay).toContain("View event");
  expect(selectedDay).toContain("<details");
});

test("timed occurrence displays its event timezone without changing its date", () => {
  const timed: BoardEventOccurrencePage["items"][number] = {
    ...visibleOccurrence,
    id: `${eventId}:2026-09-14T01:00:00Z`,
    date: "2026-09-14",
    start: "2026-09-14T01:00:00Z",
    end: "2026-09-14T02:00:00Z",
    event: {
      ...visibleOccurrence.event,
      allDay: false,
      startDate: null,
      endDate: null,
      startAt: "2026-09-14T01:00:00Z",
      endAt: "2026-09-14T02:00:00Z",
      title: "Timed planning session",
    },
  };
  const html = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      region: { locale: "en-US", timezone: "UTC" },
      page: { ...page, items: [timed] },
      window: calendarWindowForMonth("2026-09"),
    }),
  );
  expect(html).toContain("Timed planning session");
  expect(html).toContain("Sep 14");
  expect(html).toContain("9:00");
  expect(html).toContain("10:00");
  expect(html).toContain("Asia/Manila");
});

test("overnight timed occurrence appears on the next local day across months, except at exclusive end", () => {
  const overnight: BoardEventOccurrencePage["items"][number] = {
    ...visibleOccurrence,
    id: `${eventId}:2026-08-31T15:00:00Z`,
    date: "2026-08-31",
    start: "2026-08-31T15:00:00Z",
    end: "2026-08-31T17:00:00Z",
    event: {
      ...visibleOccurrence.event,
      allDay: false,
      startDate: null,
      endDate: null,
      startAt: "2026-08-31T15:00:00Z",
      endAt: "2026-08-31T17:00:00Z",
      title: "Overnight handoff",
    },
  };
  const september = calendarWindowForMonth("2026-09");
  const onSeptemberFirst = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      region: { locale: "en-US", timezone: "UTC" },
      page: { ...page, items: [overnight] },
      window: september,
      date: "2026-09-01",
    }),
  );
  expect(onSeptemberFirst).toContain("Overnight handoff");
  expect(onSeptemberFirst).toContain("Aug 31");
  expect(onSeptemberFirst).toContain("Sep 1");
  const endsAtMidnight = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      region: { locale: "en-US", timezone: "UTC" },
      page: {
        ...page,
        items: [{ ...overnight, end: "2026-08-31T16:00:00Z" }],
      },
      window: september,
      date: "2026-09-01",
    }),
  );
  expect(endsAtMidnight).not.toContain("Overnight handoff");
});

test("partial occurrence page never presents exact day counts or a confirmed empty day", () => {
  const partial: BoardEventOccurrencePage = {
    ...page,
    pagination: { ...page.pagination, total: 101, hasMore: true },
  };
  expect(calendarDayCountLabel(0, true)).toContain("incomplete");
  expect(calendarDayCountLabel(1, true)).toContain("At least 1 event");
  expect(calendarDayCountLabel(1, false)).toBe("1 event");
  const html = renderToStaticMarkup(
    createElement(ServerBoardCalendarDisplay, {
      region: { locale: "en-US", timezone: "UTC" },
      page: partial,
      window: calendarWindowForMonth("2026-09"),
      date: "2026-09-17",
    }),
  );
  expect(html).toContain("may be available");
  expect(html).not.toContain("No events on this day.");
});

test("calendar clears switched or denied content and ignores stale response", () => {
  const empty: CalendarState = {
    key: null,
    sequence: 0,
    data: null,
    status: "idle",
    error: null,
  };
  const key = `${boardId}:2026-09-01:2026-09-30`;
  const started = transitionCalendarState(empty, {
    type: "begin",
    key,
    sequence: 1,
  });
  const ready = transitionCalendarState(started, {
    type: "resolve",
    key,
    sequence: 1,
    data: page,
  });
  expect(ready.data?.items[0]?.event.title).toBe("Visible planning session");
  const denied = transitionCalendarState(ready, {
    type: "reject",
    key,
    sequence: 1,
    error: "Calendar unavailable",
    retain: false,
  });
  expect(denied.data).toBeNull();
  const switched = transitionCalendarState(ready, {
    type: "begin",
    key: "00000000-0000-4000-8000-000000000099:2026-09-01:2026-09-30",
    sequence: 2,
  });
  expect(switched.data).toBeNull();
  expect(
    transitionCalendarState(switched, {
      type: "resolve",
      key,
      sequence: 1,
      data: page,
    }),
  ).toEqual(switched);
  const sameMonthRefresh = transitionCalendarState(ready, {
    type: "begin",
    key,
    sequence: 2,
  });
  const transientFailure = transitionCalendarState(sameMonthRefresh, {
    type: "reject",
    key,
    sequence: 2,
    error: "Refresh failed",
    retain: true,
  });
  expect(transientFailure.data).toEqual(page);
  expect(transientFailure.error).toBe("Refresh failed");
});

test("denied latest-version check clears cached occurrences even when retry fails", () => {
  const empty: CalendarState = {
    key: null,
    sequence: 0,
    data: null,
    status: "idle",
    error: null,
  };
  const key = `${boardId}:2026-09-01:2026-09-30`;
  const ready = transitionCalendarState(
    transitionCalendarState(empty, { type: "begin", key, sequence: 1 }),
    { type: "resolve", key, sequence: 1, data: page },
  );
  const denied = transitionCalendarState(ready, {
    type: "invalidate",
    key,
    sequence: 2,
  });
  expect(denied.data).toBeNull();
  const retrying = transitionCalendarState(denied, {
    type: "begin",
    key,
    sequence: 3,
  });
  const failed = transitionCalendarState(retrying, {
    type: "reject",
    key,
    sequence: 3,
    error: "Could not refresh this calendar.",
    retain: true,
  });
  expect(failed.data).toBeNull();
  expect(failed.status).toBe("error");
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
    route.fulfill({ json: { id: authorId, role, access: [] } }),
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
        items,
        pagination: {
          limit: 25,
          offset: 0,
          count: items.length,
          total: items.length,
          has_more: false,
        },
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
  test(`S04 archived event purge ${failChallenge ? "retains its row after an unavailable challenge" : "removes only its confirmed archived row"}`, async ({
    page: browser,
  }) => {
    const api = await installArchivedEventPurge(
      browser,
      "admin",
      failChallenge,
    );
    await browser.goto(`/boards?board=${boardId}&section=calendar`);
    await browser
      .getByRole("button", { name: "Event lists", exact: true })
      .click();
    await browser
      .getByRole("menuitem", { name: "Archived events", exact: true })
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

test("S04 archived event remains restorable by a member without permanent-delete authority", async ({
  page: browser,
}) => {
  const api = await installArchivedEventPurge(browser, "member");
  await browser.goto(`/boards?board=${boardId}&section=calendar`);
  await browser
    .getByRole("button", { name: "Event lists", exact: true })
    .click();
  await browser
    .getByRole("menuitem", { name: "Archived events", exact: true })
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

test("S04 pending event review can recover after purge setting changes without accepting its late preview", async ({
  page: browser,
}) => {
  const api = await installArchivedEventPurge(browser, "admin", false, true);
  await browser.goto(`/boards?board=${boardId}&section=calendar`);
  await browser
    .getByRole("button", { name: "Event lists", exact: true })
    .click();
  await browser
    .getByRole("menuitem", { name: "Archived events", exact: true })
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
test("S04 correction: admin purges archived-parent event while ordinary lifecycle editing stays unavailable", async ({
  page: browser,
}) => {
  const api = await installArchivedEventPurge(browser);
  const archivedParent = {
    id: boardId,
    scope: "project",
    department_id: null,
    name: "Calendar board",
    description: "Current calendar",
    status: "archived",
    revision: 1,
    level: "manage",
    created_at: selectedEventWire.created_at,
    updated_at: selectedEventWire.updated_at,
  };
  await browser.route(`**/api/boards/${boardId}`, (route) =>
    route.fulfill({ json: archivedParent }),
  );
  await browser.route("**/api/boards?**", (route) =>
    route.fulfill({
      json: {
        items: [archivedParent],
        pagination: {
          limit: 25,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      },
    }),
  );
  await browser.goto(
    `/boards?board=${boardId}&section=calendar&status=archived`,
  );
  await expect(
    browser.getByRole("heading", { name: "Calendar", exact: true }).last(),
  ).toBeVisible();
  await expect(
    browser.getByRole("button", { name: "Event lists", exact: true }),
  ).toBeVisible();
  await browser
    .getByRole("button", { name: "Event lists", exact: true })
    .click();
  await browser
    .getByRole("menuitem", { name: "Archived events", exact: true })
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

test("S04 correction: archived-parent admin retains current-access retry after an event-list failure", async ({
  page: browser,
}) => {
  await installArchivedEventPurge(browser);
  const parent = {
    id: boardId,
    scope: "project",
    department_id: null,
    name: "Calendar board",
    description: "Current calendar",
    status: "archived",
    revision: 1,
    level: "manage",
    created_at: selectedEventWire.created_at,
    updated_at: selectedEventWire.updated_at,
  };
  await browser.route(`**/api/boards/${boardId}`, (route) =>
    route.fulfill({ json: parent }),
  );
  await browser.route("**/api/boards?**", (route) =>
    route.fulfill({
      json: {
        items: [parent],
        pagination: {
          limit: 25,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      },
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
        items: [{ ...selectedEventWire, archived: true }],
        pagination: {
          limit: 25,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
        board_revision: 1,
      },
    });
  });
  await browser.goto(
    `/boards?board=${boardId}&section=calendar&status=archived`,
  );
  await browser
    .getByRole("button", { name: "Event lists", exact: true })
    .click();
  await browser
    .getByRole("menuitem", { name: "Archived events", exact: true })
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
