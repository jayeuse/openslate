import { expect, test } from "@playwright/test";

import * as api from "../../../src/components/systems/comms/adapters/message-api";
import { ApiContractError } from "../../../src/lib/api";
import { installFetch } from "../helpers/fake-fetch";

const org = "00000000-0000-4000-8000-000000000001";
const user = "00000000-0000-4000-8000-000000000002";
const conversation = "00000000-0000-4000-8000-000000000003";
const messageId = "00000000-0000-4000-8000-000000000004";
const clientKey = "00000000-0000-4000-8000-000000000005";
const other = "00000000-0000-4000-8000-000000000006";
const context = { org_id: org, user_id: user };
const timestamp = "2026-10-19T08:00:00Z";
const etag = '"message-7"';
const bootstrap = { ...context, categories: [], conversations: [] };
const identity = {
  id: messageId,
  org_id: org,
  conversation_id: conversation,
  seq: 7,
  author_id: user,
  client_key: clientKey,
  created_at: timestamp,
  parent_id: null,
  reply_to_id: null,
  also_send_to_channel: false,
  thread: null,
};
const live = {
  ...identity,
  state: "live",
  body: "Current server text",
  edited_at: timestamp,
  pinned_at: null,
  pinned_by: null,
  attachments: [],
  record_references: [],
  mention_user_ids: [],
  mentions_channel: false,
  mentions_here: false,
  reactions: [],
  link_previews: [],
};
const tombstone = { ...identity, state: "deleted", deleted_at: timestamp };
const send = { client_key: clientKey, body: "Original text" };
const edit = {
  body: "Edited text",
  mention_user_ids: [],
  mentions_channel: false,
  mentions_here: false,
};
const messagePath = `/api/comms/conversations/${conversation}/messages`;
const readState = { conversation_id: conversation, last_read_seq: 7 };
const history = {
  org_id: org,
  conversation_id: conversation,
  thread_root_id: null,
  items: [live],
  pagination: {
    limit: 50,
    count: 1,
    first_seq: 7,
    last_seq: 7,
    high_water_seq: 9,
    has_older: true,
    has_newer: true,
  },
};

test("message bootstrap uses the explicit bound organization and shared request options", async () => {
  const controller = new AbortController();
  const mock = installFetch(() => Response.json(bootstrap));
  try {
    await expect(
      api.bootstrap(context, { signal: controller.signal }),
    ).resolves.toEqual(bootstrap);
    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      "/api/comms/bootstrap",
    ]);
    expect(mock.requests[0].init).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    expect(new Headers(mock.requests[0].init?.headers).get("X-Org")).toBe(org);
  } finally {
    mock.restore();
  }
});

test("message bootstrap refuses another organization or actor instead of returning foreign state", async () => {
  for (const body of [
    { ...bootstrap, org_id: other },
    { ...bootstrap, user_id: other },
    { ...bootstrap, private_detail: "unexpected" },
  ]) {
    const mock = installFetch(() => Response.json(body));
    try {
      await expect(api.bootstrap(context)).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      mock.restore();
    }
  }
});

test("message history sends exclusive or around cursors and retains the server page", async () => {
  for (const { request, query } of [
    { request: {}, query: { limit: "50" } },
    {
      request: {
        before_seq: undefined,
        after_seq: undefined,
        around_seq: undefined,
      },
      query: { limit: "50" },
    },
    { request: { after_seq: 6 }, query: { limit: "50", after_seq: "6" } },
    { request: { before_seq: 8 }, query: { limit: "50", before_seq: "8" } },
    {
      request: { around_seq: 7, limit: 10 },
      query: { limit: "10", around_seq: "7" },
    },
  ]) {
    const page = {
      ...history,
      pagination: { ...history.pagination, limit: request.limit ?? 50 },
    };
    const mock = installFetch(() => Response.json(page));
    try {
      await expect(
        api.getHistory(context, conversation, request),
      ).resolves.toEqual(page);
      const url = new URL(
        String(mock.requests[0].input),
        "http://test.invalid",
      );
      expect(url.pathname).toBe(messagePath);
      expect(Object.fromEntries(url.searchParams)).toEqual(query);
      expect(new Headers(mock.requests[0].init?.headers).get("X-Org")).toBe(
        org,
      );
    } finally {
      mock.restore();
    }
  }
});

test("message history rejects scope, cursor and malformed page responses through the request schema", async () => {
  for (const { body, after_seq } of [
    {
      body: { ...history, org_id: other, items: [{ ...live, org_id: other }] },
      after_seq: 6,
    },
    {
      body: {
        ...history,
        conversation_id: other,
        items: [{ ...live, conversation_id: other }],
      },
      after_seq: 6,
    },
    {
      body: {
        ...history,
        thread_root_id: other,
        items: [{ ...live, parent_id: other }],
      },
      after_seq: 6,
    },
    {
      body: { ...history, pagination: { ...history.pagination, limit: 10 } },
      after_seq: 6,
    },
    { body: history, after_seq: 7 },
    { body: { ...history, items: [{ ...live, body: 42 }] }, after_seq: 6 },
  ]) {
    const mock = installFetch(() => Response.json(body));
    try {
      await expect(
        api.getHistory(context, conversation, { after_seq }),
      ).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
});

test("message reads and ordinary mutations preserve ETags and use only the eight current routes", async () => {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const rows = [
    {
      call: () => api.getMessage(context, conversation, messageId, options),
      method: "GET",
      path: `${messagePath}/${messageId}`,
      body: undefined,
      wire: live,
      expected: { data: live, etag },
    },
    {
      call: () => api.getMessageBySequence(context, conversation, 7, options),
      method: "GET",
      path: `${messagePath}/by-sequence/7`,
      body: undefined,
      wire: tombstone,
      expected: { data: tombstone, etag },
    },
    {
      call: () =>
        api.editMessage(context, conversation, messageId, edit, options),
      method: "PATCH",
      path: `${messagePath}/${messageId}`,
      body: edit,
      wire: { ...live, body: edit.body },
      expected: { data: { ...live, body: edit.body }, etag },
    },
    {
      call: () => api.deleteMessage(context, conversation, messageId, options),
      method: "DELETE",
      path: `${messagePath}/${messageId}`,
      body: undefined,
      wire: tombstone,
      expected: { data: tombstone, etag },
    },
    {
      call: () =>
        api.markRead(context, conversation, { last_read_seq: 99 }, options),
      method: "PUT",
      path: `/api/comms/conversations/${conversation}/read`,
      body: { last_read_seq: 99 },
      wire: readState,
      expected: readState,
    },
  ];
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "openslate_csrf=owned-test-token" },
  });
  try {
    for (const row of rows) {
      const mock = installFetch(() =>
        Response.json(row.wire, { headers: { ETag: etag } }),
      );
      try {
        await expect(row.call()).resolves.toEqual(row.expected);
        expect(mock.requests).toHaveLength(1);
        const { input, init } = mock.requests[0];
        expect(String(input)).toBe(row.path);
        expect(init?.method ?? "GET").toBe(row.method);
        if (row.body === undefined) expect(init?.body).toBe(undefined);
        else expect(JSON.parse(String(init?.body))).toEqual(row.body);
        expect(init?.signal).toBe(controller.signal);
        expect(init?.credentials).toBe("same-origin");
        const headers = new Headers(init?.headers);
        expect(headers.get("X-Org")).toBe(org);
        expect(headers.has("If-Match")).toBe(false);
        if (row.method !== "GET")
          expect(headers.get("X-CSRF-Token")).toBe("owned-test-token");
      } finally {
        mock.restore();
      }
    }
  } finally {
    if (originalDocument)
      Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("message sends distinguish created, current replay and deleted replay without comparing stale content", async () => {
  for (const { status, message } of [
    { status: 201, message: live },
    { status: 200, message: live },
    { status: 200, message: tombstone },
  ]) {
    const mock = installFetch(() => Response.json(message, { status }));
    try {
      await expect(
        api.sendMessage(context, conversation, send),
      ).resolves.toEqual({ status, message });
      expect(String(mock.requests[0].input)).toBe(messagePath);
      expect(mock.requests[0].init?.method).toBe("POST");
      expect(new Headers(mock.requests[0].init?.headers).get("X-Org")).toBe(
        org,
      );
      expect(JSON.parse(String(mock.requests[0].init?.body))).toEqual({
        ...send,
        attachment_ids: [],
        record_ids: [],
        mention_user_ids: [],
        mentions_channel: false,
        mentions_here: false,
        reply_to_id: null,
      });
    } finally {
      mock.restore();
    }
  }
});

test("message send refuses impossible success statuses and mismatched actor, key or conversation", async () => {
  for (const { status, message } of [
    { status: 201, message: tombstone },
    { status: 202, message: live },
    { status: 200, message: { ...live, author_id: other } },
    { status: 201, message: { ...live, client_key: other } },
    { status: 201, message: { ...live, conversation_id: other } },
    { status: 201, message: { ...live, org_id: other } },
    { status: 201, message: { ...live, parent_id: other } },
  ]) {
    const mock = installFetch(() => Response.json(message, { status }));
    try {
      await expect(
        api.sendMessage(context, conversation, send),
      ).rejects.toBeInstanceOf(ApiContractError);
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  }
});

test("message responses must identify the requested resource, sequence and mutation result", async () => {
  for (const { call, body } of [
    {
      call: () => api.getMessage(context, conversation, messageId),
      body: { ...live, id: other },
    },
    {
      call: () => api.getMessage(context, conversation, messageId),
      body: { ...live, org_id: other },
    },
    {
      call: () => api.getMessageBySequence(context, conversation, 7),
      body: { ...live, seq: 8 },
    },
    {
      call: () => api.editMessage(context, conversation, messageId, edit),
      body: { ...live, conversation_id: other },
    },
    {
      call: () => api.editMessage(context, conversation, messageId, edit),
      body: tombstone,
    },
    {
      call: () => api.deleteMessage(context, conversation, messageId),
      body: { ...tombstone, id: other },
    },
    {
      call: () => api.deleteMessage(context, conversation, messageId),
      body: live,
    },
    {
      call: () => api.markRead(context, conversation, { last_read_seq: 7 }),
      body: { ...readState, conversation_id: other },
    },
  ]) {
    const mock = installFetch(() =>
      Response.json(body, { headers: { ETag: etag } }),
    );
    try {
      await expect(call()).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
});

test("versioned messages refuse missing ETags instead of manufacturing a validator", async () => {
  for (const { call, body } of [
    {
      call: () => api.getMessage(context, conversation, messageId),
      body: live,
    },
    {
      call: () => api.getMessageBySequence(context, conversation, 7),
      body: live,
    },
    {
      call: () => api.editMessage(context, conversation, messageId, edit),
      body: live,
    },
    {
      call: () => api.deleteMessage(context, conversation, messageId),
      body: tombstone,
    },
  ]) {
    const mock = installFetch(() => Response.json(body));
    try {
      await expect(call()).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
});

test("invalid message requests and path identities fail before dispatch", async () => {
  const mock = installFetch(() => Response.json(live));
  try {
    for (const call of [
      () => api.bootstrap({ ...context, org_id: "invalid" }),
      () =>
        api.getHistory(context, conversation, { before_seq: 7, after_seq: 1 }),
      () => api.getMessage(context, "../other", messageId),
      () => api.getMessage(context, conversation, "invalid"),
      () => api.getMessageBySequence(context, conversation, 0),
      () => api.sendMessage(context, conversation, { ...send, body: " " }),
      () =>
        api.editMessage(context, conversation, messageId, {
          ...edit,
          body: "x".repeat(4_001),
        }),
      () => api.deleteMessage(context, conversation, "invalid"),
      () => api.markRead(context, conversation, { last_read_seq: -1 }),
    ])
      await expect(call()).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("message transport propagates HTTP refusal, network failure and cancellation without a success fallback", async () => {
  for (const [status, code] of [
    [403, "comms_post_denied"],
    [404, "comms_not_found"],
    [409, "comms_idempotency_mismatch"],
    [422, "comms_invalid_input"],
    [429, "comms_rate_limited"],
    [503, "comms_unavailable"],
  ] as const) {
    const mock = installFetch(() =>
      Response.json(
        { detail: { code, message: "Request refused" } },
        { status, headers: status === 429 ? { "Retry-After": "3" } : {} },
      ),
    );
    try {
      await expect(
        api.sendMessage(context, conversation, send),
      ).rejects.toMatchObject({
        status,
        code,
        retryAfter: status === 429 ? 3 : undefined,
      });
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  }
  for (const failure of [
    new TypeError("Network unavailable"),
    new DOMException("Cancelled", "AbortError"),
  ]) {
    const mock = installFetch(() => Promise.reject(failure));
    try {
      await expect(
        api.getMessage(context, conversation, messageId),
      ).rejects.toBe(failure);
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  }
});
