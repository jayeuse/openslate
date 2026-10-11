import {
  controlledSession,
  expect,
  heldResponse,
  settleReact,
  signedInAs,
  test,
  type Page,
  type Route,
} from "./helpers/test";

import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";

const userId = "00000000-0000-4000-8000-000000000101";
const notificationId = "00000000-0000-4000-8000-000000000102";
const reportId = "00000000-0000-4000-8000-000000000103";
const runId = "00000000-0000-4000-8000-000000000104";
const boardId = "00000000-0000-4000-8000-000000000105";
const postId = "00000000-0000-4000-8000-000000000106";
const revisionId = "00000000-0000-4000-8000-000000000107";
const eventId = "00000000-0000-4000-8000-000000000108";
const timestamp = "2026-09-23T00:00:00Z";

async function notificationRoute(
  page: Page,
  handler: (route: Route) => Promise<void>,
) {
  await page.route("**/api/notifications**", async (route) => {
    if (
      new URL(route.request().url()).pathname ===
      "/api/notifications/unread-count"
    ) {
      await route.fulfill({ json: { unread_count: 1 } });
      return;
    }
    await handler(route);
  });
}

async function mockSession(page: Page) {
  await installTitleSources(page);
  await signedInAs(page, { id: userId, role: "admin" });
}

async function fakeEventSource(page: Page) {
  await installOpenViewEventSource(page);
}

function notification(status: "unread" | "read") {
  return {
    id: notificationId,
    kind: "report-run",
    subject_type: "report_run",
    subject_id: runId,
    report_id: reportId,
    run_id: runId,
    status,
    scheduled_for: timestamp,
    created_at: timestamp,
    read_at: status === "read" ? timestamp : null,
  };
}

test("connected Report notifications show reference status and refetch after mark-read", async ({
  page,
}) => {
  await mockSession(page);
  await fakeEventSource(page);
  let status: "unread" | "read" = "unread";
  await notificationRoute(page, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      status = "read";
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(notification(status)),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [notification(status)],
        pagination: {
          limit: 25,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      }),
    });
  });

  await page.goto("/platform?section=notifications");
  const connected = page.getByRole("region", {
    name: "Notifications",
  });
  await expect(connected.getByText("Scheduled report run")).toBeVisible();
  await expect(
    connected
      .getByRole("list", { name: "Notifications" })
      .getByText("Unread", { exact: true }),
  ).toBeVisible();
  await expect(connected).not.toContainText(reportId);
  await expect(connected).not.toContainText(runId);
  await expect(
    connected.getByRole("link", { name: "Open report" }),
  ).toHaveAttribute(
    "href",
    `/openview?section=reports&report=${reportId}&run=${runId}`,
  );
  await connected.getByRole("button", { name: "Mark as read" }).click();
  // The command writes nothing to the cache (notification-items.tsx), so the
  // Read label can come only from the refetched list.
  await expect(connected.getByText("Read", { exact: true })).toBeVisible();
});

test("connected inbox shows Board publication and reminder references without content", async ({
  page,
}) => {
  await mockSession(page);
  await fakeEventSource(page);
  await notificationRoute(page, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: notificationId,
            kind: "post-publish",
            subject_type: "board_post",
            subject_id: postId,
            board_id: boardId,
            post_id: postId,
            publication_revision_id: revisionId,
            status: "unread",
            scheduled_for: timestamp,
            created_at: timestamp,
            read_at: null,
          },
          {
            id: runId,
            kind: "event-reminder",
            subject_type: "board_event",
            subject_id: eventId,
            board_id: boardId,
            event_id: eventId,
            occurrence_id: `${eventId}:2026-09-23`,
            occurrence_start_at: timestamp,
            status: "unread",
            scheduled_for: timestamp,
            created_at: timestamp,
            read_at: null,
          },
        ],
        pagination: {
          limit: 25,
          offset: 0,
          count: 2,
          total: 2,
          has_more: false,
        },
      }),
    });
  });

  await page.goto("/platform?section=notifications");
  const connected = page.getByRole("region", {
    name: "Notifications",
  });
  await expect(
    connected.getByText("Field operations", { exact: true }),
  ).toBeVisible();
  await expect(
    connected.getByText("Safety briefing", { exact: true }),
  ).toBeVisible();
  await expect(
    connected.getByText("Board post", { exact: true }),
  ).toBeVisible();
  await expect(
    connected.getByText("Event reminder", { exact: true }),
  ).toBeVisible();
  await expect(connected).not.toContainText(postId);
  await expect(connected).not.toContainText(eventId);
  await expect(connected).not.toContainText("Publication body");
  await expect(connected).not.toContainText("Private event details");
  await expect(
    connected.getByRole("link", { name: "Open post" }),
  ).toHaveAttribute(
    "href",
    `/boards?board=${boardId}&section=posts&post=${postId}`,
  );
  await expect(
    connected.getByRole("link", { name: "Open event" }),
  ).toHaveAttribute(
    "href",
    `/boards?board=${boardId}&section=calendar&event=${eventId}`,
  );
});

test("Report notification SSE resync and recipient invalidation refresh without exposing event IDs", async ({
  page,
}) => {
  await mockSession(page);
  await fakeEventSource(page);
  let available = false;
  let listReads = 0;
  await notificationRoute(page, async (route) => {
    listReads += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: available ? [notification("unread")] : [],
        pagination: {
          limit: 25,
          offset: 0,
          count: available ? 1 : 0,
          total: available ? 1 : 0,
          has_more: false,
        },
      }),
    });
  });

  await page.goto("/platform?section=notifications");
  const connected = page.getByRole("region", {
    name: "Notifications",
  });
  await expect(
    connected.getByText("No notifications on this page."),
  ).toBeVisible();
  const openingPage = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/notifications" &&
      url.searchParams.get("limit") === "25"
    );
  });
  await sendOpenViewEvent(page, "resync");
  await (await openingPage).finished();
  await expect(connected.getByText("Refreshing notifications…")).toHaveCount(0);
  const baselineReads = listReads;
  available = true;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "reports",
    entity_id: "private",
  });
  expect(listReads).toBe(baselineReads);
  await sendOpenViewEvent(page, "resync");
  await expect(connected.getByText("Scheduled report run")).toBeVisible();
  available = false;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "in_app_notifications",
  });
  await expect(
    connected.getByText("No notifications on this page."),
  ).toBeVisible();
  await page.getByRole("link", { name: "Search workspace" }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search workspace" }),
  ).toBeVisible();
});

test("Report notification refresh retains last good on transient failure and clears it on denial", async ({
  page,
}) => {
  await mockSession(page);
  await fakeEventSource(page);
  let responseStatus = 200;
  await notificationRoute(page, async (route) => {
    if (responseStatus !== 200) {
      await route.fulfill({
        status: responseStatus,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Internal detail must not render" }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [notification("unread")],
        pagination: {
          limit: 25,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      }),
    });
  });
  await page.goto("/platform?section=notifications");
  const connected = page.getByRole("region", {
    name: "Notifications",
  });
  await expect(connected.getByText("Scheduled report run")).toBeVisible();
  responseStatus = 500;
  await connected.getByRole("button", { name: "Refresh" }).click();
  await expect(
    connected.getByText(
      "Couldn’t refresh notifications. Showing the last loaded page.",
    ),
  ).toBeVisible();
  await expect(connected.getByText("Scheduled report run")).toBeVisible();
  responseStatus = 403;
  await connected.getByRole("button", { name: "Refresh" }).click();
  await expect(
    connected.getByText(
      "Notifications are unavailable. Sign in or ask for access, then try again.",
    ),
  ).toBeVisible();
  await expect(connected.getByText("Scheduled report run")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const streams = (
          window as Window & { reportEventSources?: Array<{ closed: boolean }> }
        ).reportEventSources;
        return streams?.filter((stream) => !stream.closed).length ?? 0;
      }),
    )
    .toBe(1);
  await sendOpenViewEvent(page, "invalidate", {
    entity: "in_app_notifications",
  });
  await expect(connected.getByText("Scheduled report run")).toHaveCount(0);
  await expect(connected).not.toContainText("Internal detail must not render");
});

test("a revoked notification 404 clears old references before a failed first-page refetch", async ({
  page,
}) => {
  await mockSession(page);
  await fakeEventSource(page);
  let staleRefreshRequested = false;
  let revoked = false;
  let followUpRequested = false;
  const followUpOffsets: (string | null)[] = [];
  const staleRefresh = heldResponse();
  const followUp = heldResponse();
  const oldPage = {
    items: [notification("unread")],
    pagination: { limit: 25, offset: 0, count: 1, total: 1, has_more: false },
  };
  await notificationRoute(page, async (route) => {
    if (route.request().method() === "POST") {
      revoked = true;
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Notification not found" }),
      });
      return;
    }
    if (revoked) {
      followUpOffsets.push(
        new URL(route.request().url()).searchParams.get("offset"),
      );
      followUpRequested = true;
      followUp.enter();
      await followUp.released;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Internal detail must not render" }),
      });
      return;
    }
    if (staleRefreshRequested) {
      staleRefresh.enter();
      await staleRefresh.released;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(oldPage),
    });
  });

  await page.goto("/platform?section=notifications");
  const connected = page.getByRole("region", {
    name: "Notifications",
  });
  await expect(connected.getByText("Scheduled report run")).toBeVisible();
  await sendOpenViewEvent(page, "resync");
  staleRefreshRequested = true;
  await sendOpenViewEvent(page, "resync");
  await staleRefresh.entered;
  await connected.getByRole("button", { name: "Mark as read" }).click();
  await expect.poll(() => followUpRequested).toBe(true);
  await expect(connected.getByText("Scheduled report run")).toHaveCount(0);
  staleRefresh.release();
  followUp.release();
  await expect(
    connected.getByText("Couldn’t load notifications."),
  ).toBeVisible();
  await expect(connected.getByText("Scheduled report run")).toHaveCount(0);
  await expect(connected).not.toContainText(reportId);
  // The recovery after the revoked notice rereads only the first page.
  expect([...new Set(followUpOffsets)]).toEqual(["0"]);
});

test("a revoked notice on a later page reloads the authorized first page", async ({
  page,
}) => {
  await mockSession(page);
  await fakeEventSource(page);
  let revoked = false;
  let recoveryOffset: string | null = null;
  await notificationRoute(page, async (route) => {
    if (route.request().method() === "POST") {
      revoked = true;
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Notification not found" }),
      });
      return;
    }
    const offset = new URL(route.request().url()).searchParams.get("offset");
    if (revoked) {
      recoveryOffset = offset;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              ...notification("read"),
              id: "00000000-0000-4000-8000-000000000301",
              created_at: "2026-10-01T00:00:00Z",
              scheduled_for: "2026-10-01T00:00:00Z",
            },
          ],
          pagination: {
            limit: 25,
            offset: 0,
            count: 1,
            total: 1,
            has_more: false,
          },
        }),
      });
      return;
    }
    const items =
      offset === "0"
        ? Array.from({ length: 25 }, (_, index) => ({
            ...notification("read"),
            id: `00000000-0000-4000-8000-${String(400 + index).padStart(12, "0")}`,
          }))
        : [notification("unread")];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items,
        pagination: {
          limit: 25,
          offset: Number(offset),
          count: items.length,
          total: 26,
          has_more: offset === "0",
        },
      }),
    });
  });

  await page.goto("/platform?section=notifications");
  const connected = page.getByRole("region", {
    name: "Notifications",
  });
  await expect(connected.getByText("Scheduled report run")).toHaveCount(25);
  await connected.getByRole("button", { name: "Next" }).click();
  await expect(connected.getByText("26–26 of 26")).toBeVisible();
  await connected.getByRole("button", { name: "Mark as read" }).click();
  await expect(connected.getByText(/Oct 1, 2026/)).toHaveCount(2);
  await expect(connected.getByText(/Sep 23, 2026/)).toHaveCount(0);
  expect(recoveryOffset).toBe("0");
  await expect(connected.getByText("1 notification")).toBeVisible();
});

test("Report notification paging remains bounded to the server page", async ({
  page,
}) => {
  await mockSession(page);
  await fakeEventSource(page);
  await notificationRoute(page, async (route) => {
    const offset = Number(
      new URL(route.request().url()).searchParams.get("offset"),
    );
    const items =
      offset === 0
        ? Array.from({ length: 25 }, (_, index) => ({
            ...notification("unread"),
            id: `00000000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`,
          }))
        : [
            {
              ...notification("read"),
              id: "00000000-0000-4000-8000-000000000225",
            },
          ];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items,
        pagination: {
          limit: 25,
          offset,
          count: items.length,
          total: 26,
          has_more: offset === 0,
        },
      }),
    });
  });
  await page.goto("/platform?section=notifications");
  const connected = page.getByRole("region", {
    name: "Notifications",
  });
  await expect(connected.getByText("Scheduled report run")).toHaveCount(25);
  await connected.getByRole("button", { name: "Next" }).click();
  await expect(connected.getByText("Scheduled report run")).toHaveCount(1);
  await expect(connected.getByText("26–26 of 26")).toBeVisible();
  await connected.getByRole("button", { name: "Previous" }).click();
  await expect(connected.getByText("Scheduled report run")).toHaveCount(25);
});

function noticePage(
  items: ReturnType<typeof notification>[],
  limit: number,
  offset: number,
  total: number,
) {
  return {
    items,
    pagination: {
      limit,
      offset,
      count: items.length,
      total,
      has_more: offset + items.length < total,
    },
  };
}

async function installTitleSources(page: Page) {
  await page.route(`**/api/reports/${reportId}`, (route) =>
    route.fulfill({
      json: {
        id: reportId,
        module_id: revisionId,
        name: "Operations review",
        subtitle: null,
        revision: 1,
        recipe: {
          version: 1,
          fields: [{ field_id: postId, expected_type: "text" }],
          filters: [],
          logic: "and",
          sorts: [],
          group_by: null,
          include_row_count: true,
        },
        is_deleted: false,
        created_at: timestamp,
        updated_at: timestamp,
      },
    }),
  );
  await page.route(`**/api/boards/${boardId}`, (route) =>
    route.fulfill({
      json: {
        id: boardId,
        name: "Field operations",
        scope: "project",
        department_id: null,
        description: "",
        status: "active",
        revision: 1,
        level: "read",
        created_at: timestamp,
        updated_at: timestamp,
      },
    }),
  );
  await page.route(`**/api/boards/${boardId}/events/${eventId}`, (route) =>
    route.fulfill({
      json: {
        id: eventId,
        board_id: boardId,
        author_id: userId,
        title: "Safety briefing",
        details: "Private event details",
        location: "",
        links: [],
        timezone_name: "UTC",
        recurrence: "none",
        repeat_until: null,
        reminders: ["start"],
        archived: false,
        revision: 1,
        board_revision: 1,
        created_at: timestamp,
        updated_at: timestamp,
        all_day: false,
        start_date: null,
        end_date: null,
        start_at: timestamp,
        end_at: "2026-09-23T01:00:00Z",
      },
    }),
  );
}

async function installNotificationJourney(page: Page, count = 125) {
  await installTitleSources(page);
  const session = await controlledSession(page, { id: userId, role: "admin" });
  await fakeEventSource(page);
  const state = {
    session,
    items: Array.from({ length: Math.max(70, count) }, (_, index) => ({
      ...notification(index < count ? "unread" : "read"),
      id: `00000000-0000-4000-8000-${String(500 + index).padStart(12, "0")}`,
    })),
    count,
    countBody: null as unknown,
    readStatus: 200,
    listStatus: 200,
    countStatus: 200,
    countReads: 0,
    listReads: [] as Array<{
      limit: number;
      offset: number;
      status: string | null;
    }>,
    commands: [] as string[],
    holdCommand: null as Promise<void> | null,
    newAfterReadAll: false,
    listBody: null as unknown,
    readAllBody: null as unknown,
    holdCount: null as Promise<void> | null,
    holdList: null as Promise<void> | null,
  };
  await page.route("**/api/notifications**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/notifications/unread-count") {
      state.countReads += 1;
      const body = state.countBody ?? { unread_count: state.count };
      await state.holdCount;
      return route.fulfill({ status: state.countStatus, json: body });
    }
    if (request.method() === "POST") {
      state.commands.push(url.pathname);
      await state.holdCommand;
      if (state.readStatus !== 200)
        return route.fulfill({
          status: state.readStatus,
          json: { detail: "Internal detail must not render" },
        });
      if (url.pathname === "/api/notifications/read-all") {
        const updated = state.items.filter(
          (item) => item.status === "unread",
        ).length;
        state.items = state.items.map((item) => ({
          ...item,
          status: "read",
          read_at: timestamp,
        }));
        state.count = 0;
        if (state.newAfterReadAll) {
          state.items.unshift({
            ...notification("unread"),
            id: notificationId,
          });
          state.count = 1;
        }
        return route.fulfill({
          json: state.readAllBody ?? { updated_count: updated },
        });
      }
      const id = url.pathname.split("/")[3];
      const item = state.items.find((candidate) => candidate.id === id);
      if (!item)
        return route.fulfill({
          status: 404,
          json: { detail: "Notification not found" },
        });
      item.status = "read";
      item.read_at = timestamp;
      state.count = Math.max(0, state.count - 1);
      return route.fulfill({ json: item });
    }
    if (state.listStatus !== 200)
      return route.fulfill({
        status: state.listStatus,
        json: { detail: "Internal detail must not render" },
      });
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    const status = url.searchParams.get("status");
    state.listReads.push({ limit, offset, status });
    const items =
      status === "unread"
        ? state.items.filter((item) => item.status === "unread")
        : state.items;
    const body =
      state.listBody ??
      noticePage(
        items.slice(offset, offset + limit),
        limit,
        offset,
        items.length,
      );
    await state.holdList;
    return route.fulfill({ json: body });
  });
  return state;
}

async function notificationPopover(page: Page) {
  await page.getByRole("button", { name: /^Notifications(?:,|$)/ }).click();
  const popup = page.getByRole("dialog", {
    name: "Notifications",
    exact: true,
  });
  await expect(popup).toBeVisible();
  return popup;
}

for (const count of [0, 8, 125]) {
  test(`shell uses confirmed unread count ${count} and latest ten authorized titles`, async ({
    page,
  }) => {
    const state = await installNotificationJourney(page, count);
    if (count === 125) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/platform");
    await expect(
      page.getByRole("button", {
        name: `Notifications, ${count} unread`,
        exact: true,
      }),
    ).toBeVisible();
    if (count === 125) {
      const bell = page.getByRole("button", {
        name: "Notifications, 125 unread",
      });
      await expect(bell).toContainText("99+");
      const geometry = await bell.evaluate((button) => {
        const badge = [...button.querySelectorAll("span")].find(
          (element) => element.textContent === "99+",
        );
        const icon = button.querySelector("svg");
        if (!badge || !icon)
          throw new Error("Visible bell badge or icon is missing");
        const controlBounds = button.getBoundingClientRect();
        const badgeBounds = badge.getBoundingClientRect();
        const iconBounds = icon.getBoundingClientRect();
        return {
          fontSize: parseFloat(getComputedStyle(badge).fontSize),
          width: controlBounds.width,
          height: controlBounds.height,
          contained:
            badgeBounds.left >= controlBounds.left &&
            badgeBounds.right <= controlBounds.right &&
            badgeBounds.top >= controlBounds.top &&
            badgeBounds.bottom <= controlBounds.bottom,
          separate: badgeBounds.bottom <= iconBounds.top,
        };
      });
      expect(geometry.fontSize).toBeGreaterThanOrEqual(12);
      expect(geometry.width).toBeGreaterThanOrEqual(44);
      expect(geometry.height).toBeGreaterThanOrEqual(44);
      expect(geometry.contained).toBe(true);
      expect(geometry.separate).toBe(true);
    }
    const popup = await notificationPopover(page);
    await expect(
      popup.getByText("Operations review", { exact: true }),
    ).toHaveCount(10);
    await expect(popup).not.toContainText(reportId);
    expect(state.listReads).toContainEqual({
      limit: 10,
      offset: 0,
      status: null,
    });
    await popup.getByRole("link", { name: "View all" }).click();
    const inbox = page.getByRole("region", { name: "Notifications" });
    await expect(
      inbox.getByText("Operations review", { exact: true }),
    ).toHaveCount(25);
    await expect(
      inbox.getByText(`1–25 of ${Math.max(70, count)}`),
    ).toBeVisible();
  });
}

// The count rules (negative, fractional, extra field, missing, text) are
// owned by isolated/platform/notifications-api.spec.ts.
test("unknown count stays neutral and retries after a malformed scalar", async ({
  page,
}) => {
  const state = await installNotificationJourney(page);
  state.countBody = { unread_count: 0, secret: "private" };
  await page.goto("/platform");
  await expect(
    page.getByRole("button", { name: "Notifications", exact: true }),
  ).toBeVisible();
  const popup = await notificationPopover(page);
  await expect(popup.getByText("Couldn’t load notifications.")).toBeVisible();
  await expect(popup).not.toContainText("private");
  state.countBody = { unread_count: 8 };
  await popup.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("button", { name: "Notifications, 8 unread" }),
  ).toBeVisible();
});

test("shared read guard prevents overlapping bell and inbox commands and explicitly reconciles read-all", async ({
  page,
}) => {
  const state = await installNotificationJourney(page, 70);
  state.newAfterReadAll = true;
  await page.goto("/platform?section=notifications");
  const inbox = page.getByRole("region", { name: "Notifications" });
  await expect(
    inbox.getByText("Operations review", { exact: true }),
  ).toHaveCount(25);
  const popup = await notificationPopover(page);
  const command = heldResponse();
  state.holdCommand = command.released;
  await popup.getByRole("button", { name: "Mark all as read" }).click();
  await expect.poll(() => state.commands.length).toBe(1);
  await expect(
    inbox.getByRole("button", { name: "Mark as read" }).first(),
  ).toBeDisabled();
  await expect(
    inbox.getByRole("button", { name: "Marking all as read…" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Notifications, 70 unread" }),
  ).toBeVisible();
  command.release();
  await expect(
    page.getByRole("button", { name: "Notifications, 1 unread" }),
  ).toBeVisible();
  await expect(popup.getByText("Unread", { exact: true })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await inbox.getByRole("button", { name: "Unread", exact: true }).click();
  await expect(
    inbox.getByText("Operations review", { exact: true }),
  ).toHaveCount(1);
  expect(state.listReads).toContainEqual({
    limit: 25,
    offset: 0,
    status: "unread",
  });
  expect(state.commands).toEqual(["/api/notifications/read-all"]);
});

test("source titles deduplicate only displayed reads, suppress denied names and retry transient failures", async ({
  page,
}) => {
  const state = await installNotificationJourney(page);
  let sourceReads = 0;
  let sourceStatus = 200;
  await page.route(`**/api/reports/${reportId}`, async (route) => {
    sourceReads += 1;
    if (sourceStatus !== 200)
      return route.fulfill({
        status: sourceStatus,
        json: { detail: "Private Operations detail" },
      });
    return route.fallback();
  });
  await page.goto("/platform?section=notifications");
  const inbox = page.getByRole("region", { name: "Notifications" });
  await expect(
    inbox.getByText("Operations review", { exact: true }),
  ).toHaveCount(25);
  // StrictMode may abandon one cold owner before the shared observed read.
  // The 25 displayed rows still request at most one read per live owner.
  expect(sourceReads).toBeLessThanOrEqual(2);
  const popup = await notificationPopover(page);
  await expect(
    popup.getByText("Operations review", { exact: true }),
  ).toHaveCount(10);
  sourceStatus = 503;
  await page.keyboard.press("Escape");
  await notificationPopover(page);
  await expect(
    popup
      .getByRole("alert")
      .filter({ hasText: "The title couldn’t be loaded." })
      .first(),
  ).toBeVisible();
  sourceStatus = 200;
  await popup.getByRole("button", { name: "Try again" }).first().click();
  await expect(
    popup.getByText("Operations review", { exact: true }),
  ).toHaveCount(10);
  sourceStatus = 404;
  await page.keyboard.press("Escape");
  await notificationPopover(page);
  await expect(
    popup.getByText("Operations review", { exact: true }),
  ).toHaveCount(0);
  await expect(
    inbox.getByText("Operations review", { exact: true }),
  ).toHaveCount(0);
  await expect(popup.getByRole("link", { name: "Open report" })).toHaveCount(0);
  await expect(popup).not.toContainText("Private Operations detail");
  expect(state.countReads).toBeGreaterThan(1);
});

test("failed read-all retains authoritative count and does not resend until explicit retry", async ({
  page,
}) => {
  const state = await installNotificationJourney(page, 70);
  state.readStatus = 503;
  await page.goto("/platform?section=notifications");
  const inbox = page.getByRole("region", { name: "Notifications" });
  await expect(
    inbox.getByText("Operations review", { exact: true }),
  ).toHaveCount(25);
  await inbox.getByRole("button", { name: "Mark all as read" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Notifications could not be marked as read. Try again.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Notifications, 70 unread" }),
  ).toBeVisible();
  expect(state.commands).toHaveLength(1);
  const repeatedFailure = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/notifications/read-all" &&
      response.status() === 503,
  );
  await inbox.getByRole("button", { name: "Mark all as read" }).click();
  await (await repeatedFailure).finished();
  await expect.poll(() => state.commands.length).toBe(2);
  await expect(
    inbox.getByRole("button", { name: "Mark all as read" }),
  ).toBeEnabled();
  await settleReact(page, 1);
  await expect(
    page.getByRole("heading", {
      name: "Notifications could not be marked as read. Try again.",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(1);
  state.readStatus = 200;
  await inbox.getByRole("button", { name: "Mark all as read" }).click();
  await expect(
    page.getByRole("button", { name: "Notifications, 0 unread" }),
  ).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Mark as read" })).toHaveCount(
    0,
  );
  expect(state.commands).toHaveLength(3);
});

test("opening resync replaces cold count and popup reads and ignores their late old responses", async ({
  page,
}) => {
  const state = await installNotificationJourney(page, 1);
  const coldCount = heldResponse();
  const coldList = heldResponse();
  state.holdCount = coldCount.released;
  state.holdList = coldList.released;
  await page.goto("/platform");
  const popup = await notificationPopover(page);
  await expect.poll(() => state.countReads).toBeGreaterThan(0);
  await expect.poll(() => state.listReads.length).toBeGreaterThan(0);
  state.count = 8;
  state.items = [];
  state.holdCount = null;
  state.holdList = null;
  await sendOpenViewEvent(page, "resync");
  try {
    await expect(
      page.getByRole("button", { name: "Notifications, 8 unread" }),
    ).toBeVisible();
    await expect(popup.getByText("No notifications yet.")).toBeVisible();
  } finally {
    coldCount.release();
    coldList.release();
  }
  await expect(
    page.getByRole("button", { name: "Notifications, 1 unread" }),
  ).toHaveCount(0);
  await expect(
    popup.getByText("Operations review", { exact: true }),
  ).toHaveCount(0);
});

test("the shell keeps one active stream and only unavailable-stream focus refreshes count", async ({
  page,
}) => {
  const state = await installNotificationJourney(page, 8);
  await page.goto("/platform?section=notifications");
  const inbox = page.getByRole("region", { name: "Notifications" });
  await expect(
    inbox.getByText("Operations review", { exact: true }),
  ).toHaveCount(25);
  await sendOpenViewEvent(page, "resync");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __openViewStreamState?: () => { active: number };
            }
          ).__openViewStreamState?.().active,
      ),
    )
    .toBe(1);
  state.count = 9;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "in_app_notifications",
  });
  await expect(
    page.getByRole("button", { name: "Notifications, 9 unread" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Search workspace" }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search workspace" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __openViewStreamState?: () => { active: number };
            }
          ).__openViewStreamState?.().active,
      ),
    )
    .toBe(1);
  const errorCountRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/notifications/unread-count" &&
      response.status() === 200,
  );
  await page.evaluate(() =>
    (
      window as Window & { __failOpenViewStream?: () => void }
    ).__failOpenViewStream?.(),
  );
  await (await errorCountRead).finished();
  await expect.poll(() => state.countReads).toBeGreaterThan(2);
  const oldListReads = state.listReads.length;
  const oldCountReads = state.countReads;
  const sessionCheck = heldResponse();
  state.session.hold = sessionCheck;
  state.count = 12;
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await sessionCheck.entered;
  try {
    await expect(
      page.getByRole("dialog", { name: "Session verification" }),
    ).toBeVisible();
    expect(state.countReads).toBe(oldCountReads);
    expect(state.listReads).toHaveLength(oldListReads);
  } finally {
    sessionCheck.release();
  }
  await expect(
    page.getByRole("button", { name: "Notifications, 12 unread" }),
  ).toBeVisible();
  expect(state.listReads).toHaveLength(oldListReads);
  await sendOpenViewEvent(page, "resync");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __openViewStreamState?: () => { active: number };
            }
          ).__openViewStreamState?.().active,
      ),
    )
    .toBe(1);
});

test("a transient count refresh retains its last confirmed number and an empty popup stays usable", async ({
  page,
}) => {
  const state = await installNotificationJourney(page, 8);
  await page.goto("/platform");
  await expect(
    page.getByRole("button", { name: "Notifications, 8 unread" }),
  ).toBeVisible();
  const popup = await notificationPopover(page);
  await expect(
    popup.getByText("Operations review", { exact: true }),
  ).toHaveCount(10);
  state.items = [];
  state.count = 0;
  state.countStatus = 503;
  await sendOpenViewEvent(page, "resync");
  await expect(popup.getByText("Couldn’t load notifications.")).toBeVisible();
  await expect(popup.getByText("No notifications yet.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Notifications, 8 unread" }),
  ).toBeVisible();
  state.countStatus = 200;
  state.count = 0;
  await popup.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("button", { name: "Notifications, 0 unread" }),
  ).toBeVisible();
  await expect(popup.getByRole("link", { name: "View all" })).toBeVisible();
});

test("read-all remains available when the unread notice lies beyond the displayed inbox page", async ({
  page,
}) => {
  const state = await installNotificationJourney(page, 1);
  state.items.reverse();
  await page.goto("/platform?section=notifications");
  const inbox = page.getByRole("region", { name: "Notifications" });
  await expect(inbox.getByText("Read", { exact: true })).toHaveCount(25);
  await expect(
    page.getByRole("button", { name: "Notifications, 1 unread" }),
  ).toBeVisible();
  await expect(
    inbox.getByRole("button", { name: "Mark all as read" }),
  ).toBeEnabled();
  await inbox.getByRole("button", { name: "Mark all as read" }).click();
  await expect(
    page.getByRole("button", { name: "Notifications, 0 unread" }),
  ).toBeVisible();
  expect(state.commands).toHaveLength(1);
});

test("a confirmed single read refetches both views and rejects an unconfirmed read response", async ({
  page,
}) => {
  const state = await installNotificationJourney(page, 8);
  await page.goto("/platform?section=notifications");
  const inbox = page.getByRole("region", { name: "Notifications" });
  await expect(
    inbox.getByText("Operations review", { exact: true }),
  ).toHaveCount(25);
  const popup = await notificationPopover(page);
  await popup.getByRole("button", { name: "Mark as read" }).first().click();
  await expect(
    page.getByRole("button", { name: "Notifications, 7 unread" }),
  ).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Mark as read" })).toHaveCount(
    7,
  );
  await expect(popup.getByRole("button", { name: "Mark as read" })).toHaveCount(
    7,
  );
  const deniedId = state.items[1].id;
  await page.route(`**/api/notifications/${deniedId}/read`, (route) =>
    route.fulfill({ json: state.items[1] }),
  );
  await popup.getByRole("button", { name: "Mark as read" }).first().click();
  await expect(
    page.getByRole("heading", {
      name: "This notification could not be marked as read. Try again.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Notifications, 7 unread" }),
  ).toBeVisible();
  await expect(popup).not.toContainText(deniedId);
});

test("a refused list clears private count and titles across cached views before a failed recovery", async ({
  page,
}) => {
  const state = await installNotificationJourney(page, 8);
  await page.goto("/platform?section=notifications");
  const inbox = page.getByRole("region", { name: "Notifications" });
  await expect(
    inbox.getByText("Operations review", { exact: true }),
  ).toHaveCount(25);
  const popup = await notificationPopover(page);
  await expect(
    popup.getByText("Operations review", { exact: true }),
  ).toHaveCount(10);
  state.listStatus = 403;
  await sendOpenViewEvent(page, "resync");
  await expect(
    inbox.getByText("Operations review", { exact: true }),
  ).toHaveCount(0);
  await expect(
    popup.getByText("Operations review", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Notifications", exact: true }),
  ).toBeVisible();
  state.listStatus = 503;
  state.count = 0;
  // One retry refetches both the unread count and the list.
  await popup.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("button", { name: "Notifications, 0 unread" }),
  ).toBeVisible();
  await expect(
    popup.getByText("Operations review", { exact: true }),
  ).toHaveCount(0);
  await expect(
    inbox.getByText("Operations review", { exact: true }),
  ).toHaveCount(0);
  await expect(popup).not.toContainText("Internal detail must not render");
});

test("cached inbox revisits retain the authorized page while a refresh is held", async ({
  page,
}) => {
  const state = await installNotificationJourney(page, 8);
  await page.goto("/platform?section=notifications");
  await expect(
    page
      .getByRole("region", { name: "Notifications" })
      .getByText("Operations review", { exact: true }),
  ).toHaveCount(25);
  await page.getByRole("link", { name: "Search workspace" }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search workspace" }),
  ).toBeVisible();
  const refresh = heldResponse();
  state.holdList = refresh.released;
  await page.getByRole("link", { name: "Notifications", exact: true }).click();
  try {
    await expect(
      page
        .getByRole("region", { name: "Notifications" })
        .getByText("Operations review", { exact: true }),
    ).toHaveCount(25);
    await expect(page.getByText("Refreshing notifications…")).toBeVisible();
  } finally {
    refresh.release();
  }
});

test("held count, title and read-command results cannot follow a different verified account", async ({
  page,
}) => {
  const state = await installNotificationJourney(page, 8);
  const accountB = "00000000-0000-4000-8000-000000000901";
  let holdTitle = false;
  const title = heldResponse();
  await page.route(`**/api/reports/${reportId}`, async (route) => {
    const requestedAccount = state.session.identity.id;
    if (requestedAccount === userId && holdTitle) {
      title.enter();
      await title.released;
    }
    await route.fulfill({
      json: {
        id: reportId,
        module_id: revisionId,
        name:
          requestedAccount === userId
            ? "Private operations review"
            : "Finance review",
        subtitle: null,
        revision: 1,
        recipe: {
          version: 1,
          fields: [{ field_id: postId, expected_type: "text" }],
          filters: [],
          logic: "and",
          sorts: [],
          group_by: null,
          include_row_count: true,
        },
        is_deleted: false,
        created_at: timestamp,
        updated_at: timestamp,
      },
    });
  });
  await page.goto("/platform?section=notifications");
  let inbox = page.getByRole("region", { name: "Notifications" });
  await expect(
    inbox.getByText("Private operations review", { exact: true }),
  ).toHaveCount(25);
  const popup = await notificationPopover(page);
  await expect(
    popup.getByText("Private operations review", { exact: true }),
  ).toHaveCount(10);
  const command = heldResponse();
  const oldItem = { ...state.items[0], status: "read", read_at: timestamp };
  await page.route(`**/api/notifications/${oldItem.id}/read`, async (route) => {
    command.enter();
    await command.released;
    await route.fulfill({ json: oldItem });
  });
  await popup.getByRole("button", { name: "Mark as read" }).first().click();
  await command.entered;
  await page.keyboard.press("Escape");
  holdTitle = true;
  await notificationPopover(page);
  await title.entered;
  const count = heldResponse();
  state.holdCount = count.released;
  const priorCountReads = state.countReads;
  await sendOpenViewEvent(page, "resync");
  await expect.poll(() => state.countReads).toBeGreaterThan(priorCountReads);
  state.session.identity = { id: accountB, role: "admin" };
  state.holdCount = null;
  state.count = 1;
  state.items = [{ ...notification("unread"), id: oldItem.id }];
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  inbox = page.getByRole("region", { name: "Notifications" });
  try {
    await expect(
      inbox.getByText("Finance review", { exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Notifications, 1 unread" }),
    ).toBeVisible();
  } finally {
    const oldCommand = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        `/api/notifications/${oldItem.id}/read`,
    );
    const oldTitle = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/reports/${reportId}`,
    );
    count.release();
    title.release();
    command.release();
    await Promise.all([
      (await oldCommand).finished(),
      (await oldTitle).finished(),
    ]);
    await settleReact(page, 1);
  }
  await expect(
    inbox.getByText("Private operations review", { exact: true }),
  ).toHaveCount(0);
  await expect(
    inbox
      .getByRole("list", { name: "Notifications" })
      .getByText("Unread", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Notifications, 8 unread" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: "Notification marked as read.",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __openViewStreamState?: () => { active: number };
            }
          ).__openViewStreamState?.().active,
      ),
    )
    .toBe(1);
});

// The page rules (duplicate, mismatched page, extra field and the rest) are
// owned by isolated/platform/notifications-api.spec.ts.
test("a notification page with a private extra field fails safely and recovers through explicit retry", async ({
  page,
}) => {
  const state = await installNotificationJourney(page, 8);
  const item = state.items[0];
  state.listBody = {
    ...noticePage([item], 10, 0, 1),
    private_detail: "Private title must not render",
  };
  await page.goto("/platform");
  const popup = await notificationPopover(page);
  await expect(popup.getByText("Couldn’t load notifications.")).toBeVisible();
  await expect(popup).not.toContainText("Private title must not render");
  await expect(
    popup.getByText("Operations review", { exact: true }),
  ).toHaveCount(0);
  state.listBody = null;
  await popup.getByRole("button", { name: "Try again" }).click();
  await expect(
    popup.getByText("Operations review", { exact: true }),
  ).toHaveCount(10);
});

// The read-all result rules are owned by
// isolated/platform/notifications-api.spec.ts.
test("an unconfirmed read-all result with a private extra field cannot announce success", async ({
  page,
}) => {
  const state = await installNotificationJourney(page, 8);
  state.readAllBody = { updated_count: 8, secret: "Private update detail" };
  await page.goto("/platform?section=notifications");
  const inbox = page.getByRole("region", { name: "Notifications" });
  await expect(
    inbox.getByText("Operations review", { exact: true }),
  ).toHaveCount(25);
  await inbox.getByRole("button", { name: "Mark all as read" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Notifications could not be marked as read. Try again.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Notifications marked as read.",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Notifications, 8 unread" }),
  ).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText(
    "Private update detail",
  );
  expect(state.commands).toHaveLength(1);
});

test("a confirmed inbox read updates the shared count after leaving the inbox without SSE", async ({
  page,
}) => {
  const state = await installNotificationJourney(page, 8);
  await page.goto("/platform?section=notifications");
  const inbox = page.getByRole("region", { name: "Notifications" });
  await expect(
    inbox.getByText("Operations review", { exact: true }),
  ).toHaveCount(25);
  const command = heldResponse();
  state.holdCommand = command.released;
  await inbox.getByRole("button", { name: "Mark as read" }).first().click();
  await expect.poll(() => state.commands.length).toBe(1);
  await page.getByRole("link", { name: "Search workspace" }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search workspace" }),
  ).toBeVisible();
  command.release();
  await expect(
    page.getByRole("button", { name: "Notifications, 7 unread" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Notification marked as read.",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(state.commands).toHaveLength(1);
});

test("an empty terminal inbox page after concurrent removal is valid and clears its old notices", async ({
  page,
}) => {
  const state = await installNotificationJourney(page, 8);
  await page.goto("/platform?section=notifications");
  const inbox = page.getByRole("region", { name: "Notifications" });
  await expect(inbox.getByText("1–25 of 70")).toBeVisible();
  await inbox.getByRole("button", { name: "Next", exact: true }).click();
  await expect(inbox.getByText("26–50 of 70")).toBeVisible();
  state.items = [];
  state.count = 0;
  await inbox.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(inbox.getByText("No notifications on this page.")).toBeVisible();
  await expect(
    inbox.getByText("0 notifications", { exact: true }),
  ).toBeVisible();
  await expect(
    inbox.getByText("Operations review", { exact: true }),
  ).toHaveCount(0);
  await expect(inbox.getByRole("alert")).toHaveCount(0);
});
