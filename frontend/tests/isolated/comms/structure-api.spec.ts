import { expect, test } from "@playwright/test";

import * as api from "../../../src/components/systems/comms/adapters/structure-api";
import { installFetch } from "../helpers/fake-fetch";
import {
  calls,
  categoryRequest,
  channelRequest,
  context,
  conditional,
  conversationId,
  categoryId,
  org,
  user,
  peer,
  page,
} from "./structure-fixtures";

for (const row of calls()) {
  test(`structure transport: ${row.name}`, async () => {
    const controller = new AbortController();
    const current = calls(controller.signal).find(
      (value) => value.name === row.name,
    )!;
    const mock = installFetch(() =>
      row.status === 204
        ? new Response(null, { status: 204 })
        : Response.json(row.wire, {
            status: row.status,
            headers: {
              ETag: '"structure-2"',
              ...(row.location ? { Location: row.location } : {}),
            },
          }),
    );
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { cookie: "openslate_csrf=structure-test" },
    });
    try {
      await expect(current.invoke()).resolves.toEqual(row.expected);
      expect(mock.requests).toHaveLength(1);
      const { input, init } = mock.requests[0];
      const url = new URL(String(input), "http://test.invalid");
      expect(url.pathname).toBe(row.path);
      expect(Object.fromEntries(url.searchParams)).toEqual(row.query ?? {});
      expect(init?.method ?? "GET").toBe(row.method);
      if (row.body === undefined) expect(init?.body).toBe(undefined);
      else expect(JSON.parse(String(init?.body))).toEqual(row.body);
      expect(init?.signal).toBe(controller.signal);
      expect(init?.credentials).toBe("same-origin");
      expect(init?.cache).toBe("no-store");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Org")).toBe(org);
      expect(headers.get("If-Match")).toBe(
        row.conditional ? conditional.if_match : null,
      );
      if (row.method !== "GET")
        expect(headers.get("X-CSRF-Token")).toBe("structure-test");
    } finally {
      mock.restore();
      if (original) Object.defineProperty(globalThis, "document", original);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });
}

test("structure list requests parse filters and omit explicit undefined values", async () => {
  const result = {
    ...page([]),
    pagination: { limit: 2, offset: 4, count: 0, total: 4, has_more: false },
  };
  const mock = installFetch(() => Response.json(result));
  try {
    await api.listConversations(context, {
      limit: 2,
      offset: 4,
      search: " Shift ",
      sort_by: "name",
      sort_order: "desc",
      archived: true,
    });
    await api.listCategories(context, {
      limit: 2,
      offset: 4,
      search: undefined,
    });
    expect(
      mock.requests.map(({ input }) =>
        Object.fromEntries(
          new URL(String(input), "http://test.invalid").searchParams,
        ),
      ),
    ).toEqual([
      {
        limit: "2",
        offset: "4",
        search: "Shift",
        sort_by: "name",
        sort_order: "desc",
        archived: "true",
      },
      { limit: "2", offset: "4", sort_by: "position", sort_order: "asc" },
    ]);
  } finally {
    mock.restore();
  }
});

test("structure requests reject invalid identities, payloads and preconditions before dispatch", async () => {
  const mock = installFetch(() => Response.json({}));
  const invalidCategory = { ...categoryRequest, org_id: org };
  const invalidChannel = { ...channelRequest, author_id: user };
  try {
    for (const call of [
      () =>
        api.getConversation({ ...context, org_id: "invalid" }, conversationId),
      () => api.getCategory(context, "../outside"),
      () => api.listConversations(context, { limit: 101 }),
      () => api.listCategories(context, { offset: -1 }),
      () =>
        api.listMembers(context, conversationId, { search: "x".repeat(101) }),
      () => api.listDirectBlocks(context, { limit: 0 }),
      () => api.createCategory(context, invalidCategory),
      () => api.createChannel(context, invalidChannel),
      () =>
        api.updateCategory(
          context,
          categoryId,
          { ...categoryRequest, name: " " },
          conditional,
        ),
      () =>
        api.updateChannel(
          context,
          conversationId,
          { position: -1 },
          conditional,
        ),
      () => api.findOrCreateDirect(context, { recipient_id: user }),
      () =>
        api.createGroup(context, {
          participant_ids: [peer, categoryId, conversationId],
        }),
      () =>
        api.setMemberRole(
          context,
          conversationId,
          "invalid",
          { role: "member" },
          conditional,
        ),
      () => api.removeMember(context, conversationId, peer, { if_match: "*" }),
      () =>
        api.archiveConversation(context, conversationId, {
          if_match: 'W/"weak"',
        }),
      () => api.restoreConversation(context, conversationId, { if_match: "" }),
      () =>
        api.duplicateChannel(
          context,
          conversationId,
          { name: " ", category_id: null },
          conditional,
        ),
      () => api.blockDirect(context, { blocked_user_id: "invalid" }),
      () => api.unblockDirect(context, "invalid"),
    ])
      await expect(call()).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});
