import { expect, test } from "@playwright/test";
import { search } from "../../../src/components/systems/comms/adapters/search-api";
import { ApiContractError } from "../../../src/lib/api";
import { installFetch } from "../helpers/fake-fetch";

const org = "00000000-0000-4000-8000-000000000001";
const user = "00000000-0000-4000-8000-000000000002";
const conversationId = "00000000-0000-4000-8000-000000000003";
const messageId = "00000000-0000-4000-8000-000000000004";
const other = "00000000-0000-4000-8000-000000000005";
const context = { org_id: org, user_id: user };
const hit = {
  message_id: messageId,
  conversation_id: conversationId,
  conversation_name: "Dispatch",
  seq: 7,
  author_id: user,
  author_name: "Alex",
  created_at: "2026-10-19T08:00:00Z",
  excerpt: "😀 İ comet",
  matches: [{ start: 4, end: 9 }],
  parent_id: null,
};
const page = {
  items: [hit],
  pagination: { limit: 25, offset: 0, count: 1, total: 1, has_more: false },
};

test("search maps parsed D16 filters to one readonly organization-bound request", async () => {
  const signal = new AbortController().signal;
  const response = {
    ...page,
    pagination: {
      limit: 100,
      offset: 125,
      count: 1,
      total: 126,
      has_more: false,
    },
  };
  const mock = installFetch(() => Response.json(response));
  try {
    await expect(
      search(
        context,
        {
          q: " comet ",
          from: user,
          in: conversationId,
          after: "2026-10-18",
          before: "2026-10-20",
          on: "2026-10-19",
          has: "file",
          is: "thread",
          sort_by: "created_at",
          sort_order: "desc",
          limit: 100,
          offset: 125,
        },
        { signal },
      ),
    ).resolves.toEqual(response);
    expect(mock.requests).toHaveLength(1);
    const { input, init } = mock.requests[0];
    const url = new URL(String(input), "http://test.invalid");
    expect(url.pathname).toBe("/api/comms/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "comet",
      from: user,
      in: conversationId,
      after: "2026-10-18",
      before: "2026-10-20",
      on: "2026-10-19",
      has: "file",
      is: "thread",
      sort_by: "created_at",
      sort_order: "desc",
      limit: "100",
      offset: "125",
    });
    expect(init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    expect(init?.body).toBe(undefined);
    expect(new Headers(init?.headers).get("X-Org")).toBe(org);
    expect(new Headers(init?.headers).has("If-Match")).toBe(false);
  } finally {
    mock.restore();
  }
});

test("search preserves root and reply context, literal excerpts and code-point offsets", async () => {
  const reply = {
    ...hit,
    message_id: other,
    seq: 8,
    parent_id: messageId,
    excerpt: "<b>comet</b>",
    matches: [{ start: 3, end: 8 }],
  };
  const response = {
    items: [hit, reply],
    pagination: { ...page.pagination, count: 2, total: 2 },
  };
  const mock = installFetch(() => Response.json(response));
  try {
    await expect(
      search(context, { q: "comet", is: "thread" }),
    ).resolves.toEqual(response);
  } finally {
    mock.restore();
  }
});

test("search defaults allow an empty result and omit explicit undefined optional filters", async () => {
  const empty = {
    items: [],
    pagination: { ...page.pagination, count: 0, total: 0 },
  };
  const mock = installFetch(() => Response.json(empty));
  try {
    await expect(
      search(context, {
        q: undefined,
        from: undefined,
        in: undefined,
        on: undefined,
        after: undefined,
        before: undefined,
        has: undefined,
        is: undefined,
      }),
    ).resolves.toEqual(empty);
    const url = new URL(String(mock.requests[0].input), "http://test.invalid");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "25",
      offset: "0",
      sort_order: "asc",
      sort_by: "relevance",
      q: "",
    });
  } finally {
    mock.restore();
  }
});

for (const row of [
  {
    name: "conversation",
    request: { in: conversationId },
    wire: { ...hit, conversation_id: other },
  },
  {
    name: "author",
    request: { from: user },
    wire: { ...hit, author_id: other },
  },
])
  test(`search rejects a hit outside the requested ${row.name}`, async () => {
    const mock = installFetch(() =>
      Response.json({ ...page, items: [row.wire] }),
    );
    try {
      await expect(search(context, row.request)).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      mock.restore();
    }
  });

test("search rejects non-200 success and malformed hit representations", async () => {
  for (const row of [
    { status: 201, wire: page },
    {
      status: 200,
      wire: { ...page, items: [{ ...hit, html: "<mark>comet</mark>" }] },
    },
    {
      status: 200,
      wire: { ...page, items: [{ ...hit, excerpt: { text: "comet" } }] },
    },
    {
      status: 200,
      wire: { ...page, items: [{ ...hit, parent_id: "invalid" }] },
    },
    { status: 200, wire: { ...page, org_id: other } },
  ]) {
    const mock = installFetch(() =>
      Response.json(row.wire, { status: row.status }),
    );
    try {
      await expect(search(context)).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
});

test("search rejects reversed empty and UTF-16-sized highlight spans", async () => {
  // This excerpt has nine code points but ten UTF-16 code units.
  for (const matches of [
    [{ start: 6, end: 5 }],
    [{ start: 4, end: 4 }],
    [{ start: 4, end: 10 }],
  ]) {
    const mock = installFetch(() =>
      Response.json({ ...page, items: [{ ...hit, matches }] }),
    );
    try {
      await expect(search(context, { q: "comet" })).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      mock.restore();
    }
  }
});

test("search rejects a hit that names itself as its parent thread", async () => {
  const mock = installFetch(() =>
    Response.json({ ...page, items: [{ ...hit, parent_id: messageId }] }),
  );
  try {
    await expect(search(context)).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    mock.restore();
  }
});

test("search binds response paging and refuses more than one bounded page", async () => {
  for (const pagination of [
    { ...page.pagination, limit: 10 },
    { ...page.pagination, offset: 1, total: 2 },
    { ...page.pagination, count: 2 },
    { ...page.pagination, total: 2, has_more: false },
  ]) {
    const mock = installFetch(() => Response.json({ ...page, pagination }));
    try {
      await expect(search(context)).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
  const items = Array.from({ length: 101 }, (_, index) => ({
    ...hit,
    message_id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
    seq: index + 7,
  }));
  const mock = installFetch(() =>
    Response.json({
      items,
      pagination: {
        limit: 100,
        offset: 0,
        count: 101,
        total: 101,
        has_more: false,
      },
    }),
  );
  try {
    await expect(search(context, { limit: 100 })).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
});

test("search rejects invalid requests before dispatch without accepting caller authority fields", async () => {
  const mock = installFetch(() => Response.json(page));
  const injected = { q: "comet", org_id: other };
  try {
    for (const request of [
      { limit: 101 },
      { offset: -1 },
      { q: "x".repeat(4_001) },
      { in: "../other" },
      { from: "invalid" },
      { after: "2026-10-20", before: "2026-10-19" },
      injected,
    ])
      await expect(search(context, request)).rejects.toThrow();
    await expect(search({ ...context, user_id: "invalid" })).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("search propagates HTTP refusals network errors and cancellation without manufacturing empty success", async () => {
  for (const [status, code] of [
    [404, "comms_not_found"],
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
      await expect(search(context)).rejects.toMatchObject({
        status,
        code,
        retryAfter: status === 429 ? 3 : undefined,
      });
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  }
  for (const error of [
    new TypeError("Network failed"),
    new DOMException("Cancelled", "AbortError"),
  ]) {
    const mock = installFetch(() => Promise.reject(error));
    try {
      await expect(search(context)).rejects.toBe(error);
    } finally {
      mock.restore();
    }
  }
});
