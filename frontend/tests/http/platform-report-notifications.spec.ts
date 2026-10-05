import { expect, test, type Page } from "./helpers/test";

const userId = "00000000-0000-4000-8000-000000000101";
const notificationId = "00000000-0000-4000-8000-000000000102";
const reportId = "00000000-0000-4000-8000-000000000103";
const runId = "00000000-0000-4000-8000-000000000104";
const boardId = "00000000-0000-4000-8000-000000000105";
const postId = "00000000-0000-4000-8000-000000000106";
const revisionId = "00000000-0000-4000-8000-000000000107";
const eventId = "00000000-0000-4000-8000-000000000108";
const timestamp = "2026-09-23T00:00:00Z";

async function mockSession(page: Page) {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: userId,
        setup_required: false,
      }),
    });
  });
}

async function fakeEventSource(page: Page) {
  await page.addInitScript(() => {
    class FakeEventSource extends EventTarget {
      closed = false;
      constructor(readonly url: string) {
        super();
        (
          window as Window & { reportEventSources?: FakeEventSource[] }
        ).reportEventSources?.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    (
      window as Window & { reportEventSources?: FakeEventSource[] }
    ).reportEventSources = [];
    Object.defineProperty(window, "EventSource", { value: FakeEventSource });
  });
}

function notification(status: "unread" | "read") {
  return {
    id: notificationId,
    kind: "report-run",
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
  let listReadsAfterMutation = 0;
  await page.route("**/api/notifications**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      status = "read";
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(notification(status)),
      });
      return;
    }
    if (status === "read") listReadsAfterMutation += 1;
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
    name: "Connected notifications",
  });
  await expect(connected.getByText("Scheduled report run")).toBeVisible();
  await expect(connected.getByText("Unread")).toBeVisible();
  await expect(connected).not.toContainText(reportId);
  await expect(connected).not.toContainText(runId);
  await expect(connected.getByRole("link")).toHaveCount(0);
  await connected.getByRole("button", { name: "Mark as read" }).click();
  await expect(connected.getByText("Read", { exact: true })).toBeVisible();
  expect(listReadsAfterMutation).toBeGreaterThanOrEqual(1);
  await expect(
    page.getByText("Preview notifications", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Preview preferences")).toHaveCount(0);
});

test("connected inbox shows Board publication and reminder references without content", async ({
  page,
}) => {
  await mockSession(page);
  await fakeEventSource(page);
  await page.route("**/api/notifications**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: notificationId,
            kind: "post-publish",
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
    name: "Connected notifications",
  });
  await expect(
    connected.getByText("Board post", { exact: true }),
  ).toBeVisible();
  await expect(
    connected.getByText("Event reminder", { exact: true }),
  ).toBeVisible();
  await expect(connected).not.toContainText(postId);
  await expect(connected).not.toContainText(eventId);
  await expect(connected).not.toContainText("Publication body");
  await expect(
    connected.getByRole("link", { name: "Open Board posts" }),
  ).toHaveAttribute("href", `/boards?board=${boardId}&section=posts`);
  await expect(
    connected.getByRole("link", { name: "Open Board calendar" }),
  ).toHaveAttribute("href", `/boards?board=${boardId}&section=calendar`);
});

test("Report notification SSE resync and recipient invalidation refresh without exposing event IDs", async ({
  page,
}) => {
  await mockSession(page);
  await fakeEventSource(page);
  let available = false;
  let listReads = 0;
  await page.route("**/api/notifications**", async (route) => {
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
    name: "Connected notifications",
  });
  await expect(
    connected.getByText("No connected notifications on this page."),
  ).toBeVisible();
  await page.evaluate(() => {
    const stream = (
      window as Window & {
        reportEventSources?: Array<EventTarget & { closed: boolean }>;
      }
    ).reportEventSources?.findLast((candidate) => !candidate.closed);
    stream?.dispatchEvent(new MessageEvent("resync", { data: "{}" }));
  });
  const baselineReads = listReads;
  available = true;
  await page.evaluate(() => {
    const stream = (
      window as Window & {
        reportEventSources?: Array<EventTarget & { closed: boolean }>;
      }
    ).reportEventSources?.findLast((candidate) => !candidate.closed);
    stream?.dispatchEvent(
      new MessageEvent("invalidate", {
        data: JSON.stringify({ entity: "reports", entity_id: "private" }),
      }),
    );
  });
  expect(listReads).toBe(baselineReads);
  await page.evaluate(() => {
    const stream = (
      window as Window & {
        reportEventSources?: Array<EventTarget & { closed: boolean }>;
      }
    ).reportEventSources?.findLast((candidate) => !candidate.closed);
    stream?.dispatchEvent(new MessageEvent("resync", { data: "{}" }));
  });
  await expect(connected.getByText("Scheduled report run")).toBeVisible();
  available = false;
  await page.evaluate(() => {
    const stream = (
      window as Window & {
        reportEventSources?: Array<EventTarget & { closed: boolean }>;
      }
    ).reportEventSources?.findLast((candidate) => !candidate.closed);
    stream?.dispatchEvent(
      new MessageEvent("invalidate", {
        data: JSON.stringify({ entity: "in_app_notifications" }),
      }),
    );
  });
  await expect(
    connected.getByText("No connected notifications on this page."),
  ).toBeVisible();
  await page.getByRole("link", { name: "Search workspace" }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search workspace" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const streams = (
          window as Window & { reportEventSources?: Array<{ closed: boolean }> }
        ).reportEventSources;
        return streams?.every((stream) => stream.closed) ?? false;
      }),
    )
    .toBe(true);
});

test("Report notification refresh retains last good on transient failure and clears it on denial", async ({
  page,
}) => {
  await mockSession(page);
  await fakeEventSource(page);
  let responseStatus = 200;
  await page.route("**/api/notifications**", async (route) => {
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
    name: "Connected notifications",
  });
  await expect(connected.getByText("Scheduled report run")).toBeVisible();
  responseStatus = 500;
  await connected.getByRole("button", { name: "Refresh" }).click();
  await expect(
    connected.getByText(
      "Could not refresh connected notifications. Showing the last loaded page.",
    ),
  ).toBeVisible();
  await expect(connected.getByText("Scheduled report run")).toBeVisible();
  responseStatus = 403;
  await connected.getByRole("button", { name: "Refresh" }).click();
  await expect(
    connected.getByText(
      "Connected notifications are unavailable. Sign in or ask for access, then retry.",
    ),
  ).toBeVisible();
  await expect(connected.getByText("Scheduled report run")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const streams = (
          window as Window & { reportEventSources?: Array<{ closed: boolean }> }
        ).reportEventSources;
        return streams?.every((stream) => stream.closed) ?? false;
      }),
    )
    .toBe(true);
});

test("a revoked notification 404 clears old references before a failed first-page refetch", async ({
  page,
}) => {
  await mockSession(page);
  await fakeEventSource(page);
  let staleRefreshRequested = false;
  let revoked = false;
  let followUpRequested = false;
  let releaseStaleRefresh = () => {};
  let releaseFollowUp = () => {};
  let signalStaleRefresh = () => {};
  const staleRefreshGate = new Promise<void>((resolve) => {
    releaseStaleRefresh = resolve;
  });
  const followUpGate = new Promise<void>((resolve) => {
    releaseFollowUp = resolve;
  });
  const staleRefreshStarted = new Promise<void>((resolve) => {
    signalStaleRefresh = resolve;
  });
  const oldPage = {
    items: [notification("unread")],
    pagination: { limit: 25, offset: 0, count: 1, total: 1, has_more: false },
  };
  await page.route("**/api/notifications**", async (route) => {
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
      expect(new URL(route.request().url()).searchParams.get("offset")).toBe(
        "0",
      );
      followUpRequested = true;
      await followUpGate;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Internal detail must not render" }),
      });
      return;
    }
    if (staleRefreshRequested) {
      signalStaleRefresh();
      await staleRefreshGate;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(oldPage),
    });
  });

  await page.goto("/platform?section=notifications");
  const connected = page.getByRole("region", {
    name: "Connected notifications",
  });
  await expect(connected.getByText("Scheduled report run")).toBeVisible();
  await page.evaluate(() => {
    const stream = (
      window as Window & {
        reportEventSources?: Array<EventTarget & { closed: boolean }>;
      }
    ).reportEventSources?.findLast((candidate) => !candidate.closed);
    stream?.dispatchEvent(new MessageEvent("resync", { data: "{}" }));
  });
  staleRefreshRequested = true;
  await page.evaluate(() => {
    const stream = (
      window as Window & {
        reportEventSources?: Array<EventTarget & { closed: boolean }>;
      }
    ).reportEventSources?.findLast((candidate) => !candidate.closed);
    stream?.dispatchEvent(new MessageEvent("resync", { data: "{}" }));
  });
  await staleRefreshStarted;
  await connected.getByRole("button", { name: "Mark as read" }).click();
  await expect.poll(() => followUpRequested).toBe(true);
  await expect(connected.getByText("Scheduled report run")).toHaveCount(0);
  releaseStaleRefresh();
  releaseFollowUp();
  await expect(
    connected.getByText(
      "Connected notifications could not be loaded. Try again.",
    ),
  ).toBeVisible();
  await expect(connected.getByText("Scheduled report run")).toHaveCount(0);
  await expect(connected).not.toContainText(reportId);
});

test("a revoked notice on a later page reloads the authorized first page", async ({
  page,
}) => {
  await mockSession(page);
  await fakeEventSource(page);
  let revoked = false;
  let recoveryOffset: string | null = null;
  await page.route("**/api/notifications**", async (route) => {
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
    name: "Connected notifications",
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
  await page.route("**/api/notifications**", async (route) => {
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
    name: "Connected notifications",
  });
  await expect(connected.getByText("Scheduled report run")).toHaveCount(25);
  await connected.getByRole("button", { name: "Next" }).click();
  await expect(connected.getByText("Scheduled report run")).toHaveCount(1);
  await expect(connected.getByText("26–26 of 26")).toBeVisible();
  await connected.getByRole("button", { name: "Previous" }).click();
  await expect(connected.getByText("Scheduled report run")).toHaveCount(25);
});
