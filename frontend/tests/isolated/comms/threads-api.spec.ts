import { expect, test } from "@playwright/test";
import * as api from "../../../src/components/systems/comms/adapters/threads-api";
import { ApiContractError } from "../../../src/lib/api";
import { installFetch } from "../helpers/fake-fetch";
import {
  context,
  org,
  user,
  other,
  conversationId,
  rootId,
  messageId,
  threadPath,
  messagePath,
  thread,
  live,
  tombstone,
  replyRequest,
  history,
  page,
  etag,
  conditional,
} from "./s18-fixtures";

test("thread GET rejects another context and never creates missing state", async () => {
  const foreign = installFetch(() =>
    Response.json({ ...thread, org_id: other }, { headers: { ETag: etag } }),
  );
  try {
    await expect(
      api.getThread(context, conversationId, rootId),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    foreign.restore();
  }
  const missing = installFetch(() =>
    Response.json(
      { detail: { code: "comms_not_found", message: "Not found" } },
      { status: 404 },
    ),
  );
  try {
    await expect(
      api.getThread(context, conversationId, rootId),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      missing.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([[threadPath, "GET"]]);
  } finally {
    missing.restore();
  }
});

test("thread reads creation and shared updates retain resource versions and exact request semantics", async () => {
  const signal = new AbortController().signal;
  for (const row of [
    {
      call: () => api.getThread(context, conversationId, rootId, { signal }),
      method: "GET",
      status: 200,
      body: undefined,
      response: thread,
    },
    {
      call: () => api.createThread(context, conversationId, rootId, { signal }),
      method: "POST",
      status: 201,
      body: undefined,
      response: thread,
    },
    {
      call: () => api.createThread(context, conversationId, rootId, { signal }),
      method: "POST",
      status: 200,
      body: undefined,
      response: thread,
    },
    {
      call: () =>
        api.updateThread(
          context,
          conversationId,
          rootId,
          { name: "Changed", resolved: true },
          { ...conditional, signal },
        ),
      method: "PATCH",
      status: 200,
      body: { name: "Changed", resolved: true },
      response: { ...thread, name: "Changed", resolved: true },
    },
  ]) {
    const mock = installFetch(() =>
      Response.json(row.response, {
        status: row.status,
        headers: {
          ETag: etag,
          ...(row.status === 201 ? { Location: threadPath } : {}),
        },
      }),
    );
    try {
      await expect(row.call()).resolves.toEqual({ data: row.response, etag });
      expect(mock.requests).toHaveLength(1);
      const { input, init } = mock.requests[0];
      expect(String(input)).toBe(threadPath);
      expect(init?.method).toBe(row.method);
      expect(init?.signal).toBe(signal);
      expect(init?.credentials).toBe("same-origin");
      expect(new Headers(init?.headers).get("X-Org")).toBe(org);
      expect(new Headers(init?.headers).get("If-Match")).toBe(
        row.method === "PATCH" ? conditional.if_match : null,
      );
      if (row.body === undefined) expect(init?.body).toBe(undefined);
      else expect(JSON.parse(String(init?.body))).toEqual(row.body);
    } finally {
      mock.restore();
    }
  }
});

test("thread replies retain exclusive history cursors and 201 versus current 200 replay", async () => {
  const mock = installFetch(() => Response.json(history));
  try {
    await expect(
      api.getReplies(context, conversationId, rootId, {
        after_seq: 6,
        before_seq: undefined,
      }),
    ).resolves.toEqual(history);
    const url = new URL(String(mock.requests[0].input), "http://test.invalid");
    expect(url.pathname).toBe(`${threadPath}/replies`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "50",
      after_seq: "6",
    });
  } finally {
    mock.restore();
  }
  for (const [status, message] of [
    [201, live],
    [200, live],
    [200, tombstone],
  ] as const) {
    const sending = installFetch(() =>
      Response.json(message, {
        status,
        headers: status === 201 ? { Location: messagePath } : {},
      }),
    );
    try {
      await expect(
        api.sendReply(context, conversationId, rootId, replyRequest),
      ).resolves.toEqual({ status, message });
      expect(String(sending.requests[0].input)).toBe(`${threadPath}/replies`);
      expect(sending.requests[0].init?.method).toBe("POST");
      expect(JSON.parse(String(sending.requests[0].init?.body))).toEqual({
        ...replyRequest,
        attachment_ids: [],
        record_ids: [],
        mention_user_ids: [],
        mentions_channel: false,
        mentions_here: false,
        reply_to_id: null,
      });
    } finally {
      sending.restore();
    }
  }
});

test("thread and pin lists retain offset paging and filters without creating resources", async () => {
  for (const row of [
    {
      call: () =>
        api.listThreads(context, {
          followed: true,
          resolved: false,
          archived: true,
        }),
      wire: page([thread]),
      path: "/api/comms/threads",
      query: {
        limit: "25",
        offset: "0",
        sort_by: "created_at",
        sort_order: "asc",
        followed: "true",
        resolved: "false",
        archived: "true",
      },
    },
    {
      call: () => api.listPins(context, conversationId),
      wire: page([live]),
      path: `/api/comms/conversations/${conversationId}/pins`,
      query: {
        limit: "25",
        offset: "0",
        sort_by: "created_at",
        sort_order: "asc",
      },
    },
  ]) {
    const mock = installFetch(() => Response.json(row.wire));
    try {
      await expect(row.call()).resolves.toEqual(row.wire);
      const url = new URL(
        String(mock.requests[0].input),
        "http://test.invalid",
      );
      expect(url.pathname).toBe(row.path);
      expect(Object.fromEntries(url.searchParams)).toEqual(row.query);
      expect(mock.requests[0].init?.method).toBe("GET");
    } finally {
      mock.restore();
    }
  }
});

test("follow off reaction removal and unpin express actor-owned commands without client identity or preconditions", async () => {
  for (const row of [
    {
      call: () =>
        api.followThread(context, conversationId, rootId, { followed: false }),
      path: `${threadPath}/follow`,
      method: "PUT",
      body: { followed: false },
      wire: thread,
    },
    {
      call: () =>
        api.addReaction(context, conversationId, messageId, { emoji: "👍" }),
      path: `${messagePath}/reactions`,
      method: "POST",
      body: { emoji: "👍" },
      wire: live,
    },
    {
      call: () =>
        api.removeReaction(context, conversationId, messageId, { emoji: "👍" }),
      path: `${messagePath}/reactions`,
      method: "DELETE",
      body: { emoji: "👍" },
      wire: live,
    },
    {
      call: () =>
        api.setPin(context, conversationId, messageId, { pinned: false }),
      path: `${messagePath}/pin`,
      method: "PUT",
      body: { pinned: false },
      wire: live,
    },
  ]) {
    const mock = installFetch(() => Response.json(row.wire));
    try {
      await expect(row.call()).resolves.toEqual(row.wire);
      const { input, init } = mock.requests[0];
      expect(String(input)).toBe(row.path);
      expect(init?.method).toBe(row.method);
      expect(JSON.parse(String(init?.body))).toEqual(row.body);
      expect(new Headers(init?.headers).get("X-Org")).toBe(org);
      expect(new Headers(init?.headers).has("If-Match")).toBe(false);
    } finally {
      mock.restore();
    }
  }
});

test("thread and reply acknowledgements refuse wrong parent scope actor status and validators", async () => {
  for (const row of [
    {
      call: () => api.getThread(context, conversationId, rootId),
      wire: { ...thread, root_message_id: other },
      status: 200,
      headers: { ETag: etag },
    },
    {
      call: () => api.getThread(context, conversationId, rootId),
      wire: thread,
      status: 200,
      headers: {},
    },
    {
      call: () => api.getThread(context, conversationId, rootId),
      wire: thread,
      status: 201,
      headers: { ETag: etag },
    },
    {
      call: () => api.createThread(context, conversationId, rootId),
      wire: thread,
      status: 201,
      headers: { ETag: etag, Location: "/api/comms/wrong" },
    },
    {
      call: () =>
        api.updateThread(
          context,
          conversationId,
          rootId,
          { locked: true },
          conditional,
        ),
      wire: { ...thread, conversation_id: other },
      status: 200,
      headers: { ETag: etag },
    },
    {
      call: () =>
        api.getReplies(context, conversationId, rootId, { after_seq: 7 }),
      wire: history,
      status: 200,
      headers: {},
    },
    {
      call: () => api.getReplies(context, conversationId, rootId),
      wire: {
        ...history,
        thread_root_id: other,
        items: [{ ...live, parent_id: other }],
      },
      status: 200,
      headers: {},
    },
    {
      call: () => api.sendReply(context, conversationId, rootId, replyRequest),
      wire: tombstone,
      status: 201,
      headers: { Location: messagePath },
    },
    {
      call: () => api.sendReply(context, conversationId, rootId, replyRequest),
      wire: { ...live, parent_id: other },
      status: 200,
      headers: {},
    },
    {
      call: () => api.sendReply(context, conversationId, rootId, replyRequest),
      wire: { ...live, author_id: other },
      status: 200,
      headers: {},
    },
    {
      call: () => api.sendReply(context, conversationId, rootId, replyRequest),
      wire: { ...live, client_key: other },
      status: 200,
      headers: {},
    },
    {
      call: () =>
        api.followThread(context, conversationId, rootId, { followed: false }),
      wire: { ...thread, root_message_id: other },
      status: 200,
      headers: {},
    },
    {
      call: () =>
        api.removeReaction(context, conversationId, messageId, { emoji: "👍" }),
      wire: { ...live, id: other },
      status: 200,
      headers: {},
    },
    {
      call: () =>
        api.setPin(context, conversationId, messageId, { pinned: true }),
      wire: { ...live, org_id: other },
      status: 200,
      headers: {},
    },
    {
      call: () => api.listThreads(context),
      wire: page([{ ...thread, org_id: other }]),
      status: 200,
      headers: {},
    },
    {
      call: () => api.listPins(context, conversationId),
      wire: page([{ ...live, conversation_id: other }]),
      status: 200,
      headers: {},
    },
  ]) {
    const mock = installFetch(() =>
      Response.json(row.wire, {
        status: row.status,
        headers: new Headers(
          Object.entries(row.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      }),
    );
    try {
      await expect(row.call()).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
});

test("thread inputs reject invalid paths actor injection and missing conditional versions before dispatch", async () => {
  const injected = { emoji: "👍", user_id: user };
  const mock = installFetch(() => Response.json({}));
  try {
    for (const call of [
      () => api.getThread(context, "../other", rootId),
      () => api.createThread(context, conversationId, "invalid"),
      () =>
        api.getReplies(context, conversationId, rootId, {
          before_seq: 1,
          after_seq: 2,
        }),
      () =>
        api.sendReply(context, conversationId, rootId, {
          ...replyRequest,
          body: " ",
        }),
      () =>
        api.updateThread(
          context,
          conversationId,
          rootId,
          { locked: true },
          { if_match: "*" },
        ),
      () => api.addReaction(context, conversationId, messageId, injected),
      () => api.listThreads(context, { limit: 101 }),
    ])
      await expect(call()).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});
