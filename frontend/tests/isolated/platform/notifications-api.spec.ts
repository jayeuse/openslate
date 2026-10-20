import { expect, test } from "@playwright/test";

import { ApiContractError } from "../../../src/lib/api";
import {
  getNotificationUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../../../src/components/systems/shared/adapters/notifications-api";
import { setCurrentOrganizationId } from "../../../src/lib/organization-context";
import { ids, installFetch, notificationWire, pagination } from "./fixtures";
import { wirePagination } from "../../helpers/pagination";

// The shell bell, its popover and the inbox trust only a confirmed unread
// count, a confirmed read-all result and a page that matches the request.
// Anything else is refused whole, so the bell stays neutral and no private
// notice renders. The http journeys keep one example of each with its exact
// body: "unknown count stays neutral and retries after malformed scalar",
// "an unconfirmed read-all result ... cannot announce success" and "a
// duplicate notification page fails safely and recovers through explicit
// retry". The wire shape of each notification kind is owned by
// isolated/openview/report-notification-api.spec.ts.

// The first three rows of each table are the bodies the http journeys sent.
const refusedCounts: { name: string; body: unknown }[] = [
  { name: "a negative count", body: { unread_count: -1 } },
  { name: "a fractional count", body: { unread_count: 1.5 } },
  {
    name: "an extra private field",
    body: { unread_count: 0, secret: "private" },
  },
  { name: "a missing count", body: {} },
  { name: "a count sent as text", body: { unread_count: "3" } },
];

for (const row of refusedCounts)
  test(`unread count refuses ${row.name}`, async () => {
    const mock = installFetch(() => Response.json(row.body));
    try {
      await expect(getNotificationUnreadCount()).rejects.toBeInstanceOf(
        ApiContractError,
      );
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

test("unread count reads the confirmed scalar without a cache", async () => {
  const mock = installFetch(() => Response.json({ unread_count: 0 }));
  try {
    await expect(getNotificationUnreadCount()).resolves.toBe(0);
    expect(String(mock.requests[0]?.input)).toBe(
      "/api/notifications/unread-count",
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

const refusedReadAll: { name: string; body: unknown }[] = [
  { name: "a negative update count", body: { updated_count: -1 } },
  { name: "a fractional update count", body: { updated_count: 0.5 } },
  {
    name: "an extra private field",
    body: { updated_count: 8, secret: "Private update detail" },
  },
  { name: "a missing update count", body: {} },
];

for (const row of refusedReadAll)
  test(`read-all result refuses ${row.name}`, async () => {
    const mock = installFetch(() => Response.json(row.body));
    try {
      await expect(markAllNotificationsRead()).rejects.toBeInstanceOf(
        ApiContractError,
      );
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

test("read-all sends one body-less command and returns the confirmed count", async () => {
  const mock = installFetch(() => Response.json({ updated_count: 8 }));
  try {
    await expect(markAllNotificationsRead()).resolves.toBe(8);
    expect(mock.requests).toHaveLength(1);
    expect(String(mock.requests[0]?.input)).toBe("/api/notifications/read-all");
    expect(mock.requests[0]?.init?.method).toBe("POST");
    expect(mock.requests[0]?.init?.body).toBeUndefined();
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

const notice = notificationWire();
const otherNotice = notificationWire({ id: ids.otherNotification });

type PageRow = {
  name: string;
  request: Parameters<typeof listNotifications>[0];
  body: unknown;
};

// The popover asks for the latest ten; its first three rows are the pages the
// "a ${invalid} notification page fails safely" journey sent.
const refusedPages: PageRow[] = [
  {
    name: "the same notice twice",
    request: { limit: 10 },
    body: {
      items: [notice, notice],
      pagination: pagination(2, { limit: 10 }),
    },
  },
  {
    name: "a page size that does not echo the request",
    request: { limit: 10 },
    body: { items: [notice], pagination: pagination(1, { limit: 25 }) },
  },
  {
    name: "an extra private field beside the page",
    request: { limit: 10 },
    body: {
      items: [notice],
      pagination: pagination(1, { limit: 10 }),
      private_detail: "Private title must not render",
    },
  },
  {
    name: "an extra field in the pagination",
    request: { limit: 10 },
    body: {
      items: [notice],
      pagination: { ...pagination(1, { limit: 10 }), cursor: "next" },
    },
  },
  {
    name: "an offset that does not echo the request",
    request: { limit: 10 },
    body: {
      items: [notice],
      pagination: pagination(1, { limit: 10, offset: 10 }),
    },
  },
  {
    name: "a count that differs from the rows",
    request: { limit: 10 },
    body: {
      items: [notice, otherNotice],
      pagination: pagination(3, { limit: 10 }),
    },
  },
  {
    name: "more rows than the requested limit",
    request: { limit: 1 },
    body: {
      items: [notice, otherNotice],
      pagination: pagination(2, { limit: 1 }),
    },
  },
  {
    name: "a total below the rows on the page",
    request: { limit: 10 },
    body: {
      items: [notice],
      pagination: { ...pagination(1, { limit: 10 }), total: 0 },
    },
  },
  {
    name: "has_more on an empty page",
    request: { limit: 10 },
    body: {
      items: [],
      pagination: {
        ...pagination(0, { limit: 10 }),
        total: 1,
        has_more: true,
      },
    },
  },
  {
    name: "a flipped has_more",
    request: { limit: 10 },
    body: {
      items: [notice],
      pagination: { ...pagination(1, { limit: 10 }), has_more: true },
    },
  },
  {
    name: "a read notice in the unread list",
    request: { limit: 25, status: "unread" },
    body: {
      items: [notificationWire({ status: "read", read_at: notice.created_at })],
      pagination: pagination(1),
    },
  },
];

for (const row of refusedPages)
  test(`notification page refuses ${row.name}`, async () => {
    const mock = installFetch(() => Response.json(row.body));
    try {
      await expect(listNotifications(row.request)).rejects.toBeInstanceOf(
        ApiContractError,
      );
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

test("notification page reads only unread notices when asked", async () => {
  const mock = installFetch(() =>
    Response.json({ items: [notice], pagination: pagination(1) }),
  );
  try {
    const page = await listNotifications({ status: "unread" });
    expect(page.items.map((item) => item.id)).toEqual([ids.notification]);
    expect(String(mock.requests[0]?.input)).toBe(
      "/api/notifications?limit=25&offset=0&status=unread",
    );
  } finally {
    mock.restore();
  }
});

test("notification page accepts an empty terminal page after concurrent removal", async () => {
  // Notices were removed after page two was opened: the total is now below
  // the requested offset, and the empty page is the true end of the inbox.
  const mock = installFetch(() =>
    Response.json({
      items: [],
      pagination: wirePagination({ limit: 25, offset: 25, count: 0, total: 0 }),
    }),
  );
  try {
    const page = await listNotifications({ offset: 25 });
    expect(page).toEqual({
      items: [],
      pagination: {
        limit: 25,
        offset: 25,
        count: 0,
        total: 0,
        hasMore: false,
      },
    });
  } finally {
    mock.restore();
  }
});

test.describe("Comms notification references", () => {
  const org = "00000000-0000-4000-8000-000000000301";
  const conversation = "00000000-0000-4000-8000-000000000302";
  const message = "00000000-0000-4000-8000-000000000303";
  const created = "2026-10-20T10:00:00Z";
  const wire = {
    id: ids.notification,
    org_id: org,
    kind: "comms-mention",
    subject_type: "comms_message",
    subject_id: message,
    conversation_id: conversation,
    message_id: message,
    status: "unread",
    scheduled_for: null,
    created_at: created,
    read_at: null,
  };
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  test.beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
    setCurrentOrganizationId(org);
  });
  test.afterEach(() => {
    setCurrentOrganizationId(null);
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  for (const kind of [
    "comms-mention",
    "comms-direct",
    "comms-thread-reply",
    "comms-keyword",
  ])
    test(`Comms accepts ${kind} and its confirmed read without content`, async () => {
      const mock = installFetch((_input, init) =>
        Response.json(
          init?.method === "POST"
            ? { ...wire, kind, status: "read", read_at: created }
            : { items: [{ ...wire, kind }], pagination: pagination(1) },
        ),
      );
      try {
        const expected = {
          id: ids.notification,
          orgId: org,
          kind,
          subjectType: "comms_message",
          subjectId: message,
          conversationId: conversation,
          messageId: message,
          status: "unread",
          scheduledFor: null,
          createdAt: created,
          readAt: null,
        };
        expect((await listNotifications()).items).toEqual([expected]);
        await expect(markNotificationRead(ids.notification)).resolves.toEqual({
          ...expected,
          status: "read",
          readAt: created,
        });
      } finally {
        mock.restore();
      }
    });

  test("Comms refuses foreign, inconsistent, incomplete and content-bearing references", async () => {
    let row: Record<string, unknown> = wire;
    const mock = installFetch(() =>
      Response.json({ items: [row], pagination: pagination(1) }),
    );
    try {
      // A valid control prevents a decoder that rejects all Comms from passing.
      expect((await listNotifications()).items).toHaveLength(1);
      for (const change of [
        { org_id: ids.otherUser },
        { org_id: undefined },
        { conversation_id: "invalid" },
        { message_id: undefined },
        { subject_id: ids.otherUser },
        { subject_type: "record" },
        { kind: "comms-unknown" },
        { scheduled_for: created },
        { created_at: "2026-10-20T11:00:00+01:00" },
        { body: "Private message" },
        { preview: "Private preview" },
        { title: "Captured title" },
      ]) {
        row = { ...wire, ...change };
        await expect(listNotifications()).rejects.toBeInstanceOf(
          ApiContractError,
        );
      }
    } finally {
      mock.restore();
    }
  });

  test("Comms discards a response completed after the tab changes organization", async () => {
    const mock = installFetch(() => {
      setCurrentOrganizationId(ids.otherUser);
      return Response.json({ items: [wire], pagination: pagination(1) });
    });
    try {
      await expect(listNotifications()).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      mock.restore();
    }
  });
});
