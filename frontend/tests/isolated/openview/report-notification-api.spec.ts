import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  listOpenViewReportNotifications,
  markOpenViewReportNotificationRead,
} from "../../../src/components/systems/openview/adapters/report-notification-api";

const notificationId = "00000000-0000-4000-8000-000000000201";
const otherNotificationId = "00000000-0000-4000-8000-000000000202";
const reportId = "00000000-0000-4000-8000-000000000203";
const runId = "00000000-0000-4000-8000-000000000204";
const boardId = "00000000-0000-4000-8000-000000000205";
const announcementId = "00000000-0000-4000-8000-000000000206";
const publicationRevisionId = "00000000-0000-4000-8000-000000000207";
const eventId = "00000000-0000-4000-8000-000000000208";
const timestamp = "2026-09-23T00:00:00+00:00";

type CapturedRequest = { input: RequestInfo | URL; init?: RequestInit };

function installFetch(
  responder: (input: RequestInfo | URL, init?: RequestInit) => Response,
) {
  const original = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return Promise.resolve(responder(input, init));
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function wireNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: notificationId,
    kind: "report-run",
    report_id: reportId,
    run_id: runId,
    status: "unread",
    scheduled_for: timestamp,
    created_at: timestamp,
    read_at: null,
    ...overrides,
  };
}

const pagination = {
  limit: 25,
  offset: 0,
  count: 1,
  total: 1,
  has_more: false,
};

test("lists current-user notification references with bounded paging and no cache", async () => {
  const mock = installFetch((input) =>
    jsonResponse({
      items: [wireNotification()],
      pagination: String(input).includes("limit=5")
        ? { ...pagination, limit: 5, offset: 10 }
        : pagination,
    }),
  );
  try {
    const page = await listOpenViewReportNotifications();
    expect(page).toEqual({
      items: [
        {
          id: notificationId,
          kind: "report-run",
          reportId,
          runId,
          status: "unread",
          scheduledFor: timestamp,
          createdAt: timestamp,
          readAt: null,
        },
      ],
      pagination: {
        limit: 25,
        offset: 0,
        count: 1,
        total: 1,
        hasMore: false,
      },
    });
    expect(String(mock.requests[0]?.input)).toBe(
      "/api/notifications?limit=25&offset=0",
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");

    const laterPage = await listOpenViewReportNotifications({
      limit: 5,
      offset: 10,
    });
    expect(laterPage.pagination).toMatchObject({ limit: 5, offset: 10 });
    expect(String(mock.requests[1]?.input)).toBe(
      "/api/notifications?limit=5&offset=10",
    );
    expect(mock.requests[1]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("marks one notification read without a body or inferred report authority", async () => {
  const mock = installFetch(() =>
    jsonResponse(wireNotification({ status: "read", read_at: timestamp })),
  );
  try {
    await expect(
      markOpenViewReportNotificationRead(notificationId),
    ).resolves.toEqual({
      id: notificationId,
      kind: "report-run",
      reportId,
      runId,
      status: "read",
      scheduledFor: timestamp,
      createdAt: timestamp,
      readAt: timestamp,
    });
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/notifications/${notificationId}/read`,
    );
    expect(mock.requests[0]?.init?.method).toBe("POST");
    expect(mock.requests[0]?.init?.body).toBeUndefined();
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("accepts reference-only Board announcement and Event reminder variants", async () => {
  const mock = installFetch(() =>
    jsonResponse({
      items: [
        {
          id: notificationId,
          kind: "announcement-publish",
          board_id: boardId,
          announcement_id: announcementId,
          publication_revision_id: publicationRevisionId,
          status: "unread",
          scheduled_for: timestamp,
          created_at: timestamp,
          read_at: null,
        },
        {
          id: otherNotificationId,
          kind: "event-reminder",
          board_id: boardId,
          event_id: eventId,
          occurrence_id: `${eventId}:2026-09-23`,
          status: "read",
          scheduled_for: timestamp,
          created_at: timestamp,
          read_at: timestamp,
        },
      ],
      pagination: { ...pagination, count: 2, total: 2 },
    }),
  );
  try {
    const result = await listOpenViewReportNotifications();
    expect(result.items).toEqual([
      {
        id: notificationId,
        kind: "announcement-publish",
        boardId,
        announcementId,
        publicationRevisionId,
        status: "unread",
        scheduledFor: timestamp,
        createdAt: timestamp,
        readAt: null,
      },
      {
        id: otherNotificationId,
        kind: "event-reminder",
        boardId,
        eventId,
        occurrenceId: `${eventId}:2026-09-23`,
        status: "read",
        scheduledFor: timestamp,
        createdAt: timestamp,
        readAt: timestamp,
      },
    ]);
  } finally {
    mock.restore();
  }
});

test("rejects invalid paging and IDs before a request", async () => {
  const mock = installFetch(() => jsonResponse({ items: [], pagination }));
  try {
    await expect(
      listOpenViewReportNotifications({ limit: 101 }),
    ).rejects.toThrow();
    await expect(
      listOpenViewReportNotifications({ offset: -1 }),
    ).rejects.toThrow();
    await expect(
      listOpenViewReportNotifications({ offset: 0.5 }),
    ).rejects.toThrow();
    await expect(
      markOpenViewReportNotificationRead("not-a-uuid"),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("rejects malformed or mismatched private notification response data", async () => {
  const responses = [
    { items: [wireNotification({ run_id: "not-a-uuid" })], pagination },
    {
      items: [wireNotification({ created_at: "2026-09-23T08:00:00+08:00" })],
      pagination,
    },
    wireNotification({
      id: otherNotificationId,
      status: "read",
      read_at: timestamp,
    }),
  ];
  const mock = installFetch(() => jsonResponse(responses.shift()));
  try {
    await expect(listOpenViewReportNotifications()).rejects.toBeInstanceOf(
      ApiContractError,
    );
    await expect(listOpenViewReportNotifications()).rejects.toBeInstanceOf(
      ApiContractError,
    );
    await expect(
      markOpenViewReportNotificationRead(notificationId),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    mock.restore();
  }
});

test("does not expose untrusted server error text", async () => {
  const responses = [
    jsonResponse({ detail: "Notification not found" }, 404),
    jsonResponse({ detail: "internal database secret" }, 500),
  ];
  const mock = installFetch(() => responses.shift()!);
  try {
    await expect(
      markOpenViewReportNotificationRead(notificationId),
    ).rejects.toMatchObject({
      status: 404,
      message: "Notification not found",
    });
    try {
      await listOpenViewReportNotifications();
      throw new Error("Expected a safe API error");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(500);
      expect((error as ApiError).message).toBe(
        "Request could not be completed",
      );
      expect(JSON.stringify(error)).not.toContain("internal database secret");
    }
  } finally {
    mock.restore();
  }
});
