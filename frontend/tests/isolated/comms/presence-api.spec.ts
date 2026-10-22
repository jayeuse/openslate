import { expect, test } from "@playwright/test";
import * as api from "../../../src/components/systems/comms/adapters/presence-api";
import type { HttpHeartbeatRequest } from "../../../src/components/systems/comms/adapters/presence-contract";
import { ApiContractError } from "../../../src/lib/api";
import { installFetch } from "../helpers/fake-fetch";

const org = "00000000-0000-4000-8000-000000000001";
const user = "00000000-0000-4000-8000-000000000002";
const peer = "00000000-0000-4000-8000-000000000003";
const other = "00000000-0000-4000-8000-000000000004";
const conversation = "00000000-0000-4000-8000-000000000010";
const nextConversation = "00000000-0000-4000-8000-000000000011";
const context = { org_id: org, user_id: user };
const noStore = { "Cache-Control": "no-store" };
const emptyHeartbeat = { ...context, changed: [], truncated: false };
const sequence = { conversation_id: conversation, high_water_seq: 0 };
const sequences = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    conversation_id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
    high_water_seq: index,
  }));

test("presence snapshot requests explicit people and preserves the server-visible subset", async () => {
  const signal = new AbortController().signal;
  const snapshot = {
    org_id: org,
    items: [
      { user_id: peer, state: "away" },
      { user_id: user, state: "offline" },
    ],
  };
  const mock = installFetch(() => Response.json(snapshot));
  try {
    await expect(
      api.getPresence(context, { user_ids: [user, peer, other] }, { signal }),
    ).resolves.toEqual(snapshot);
    expect(mock.requests).toHaveLength(1);
    const { input, init } = mock.requests[0];
    const url = new URL(String(input), "http://test.invalid");
    expect(url.pathname).toBe("/api/comms/presence");
    expect(url.searchParams.getAll("user_ids")).toEqual([user, peer, other]);
    expect(init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    expect(init?.body).toBe(undefined);
    expect(new Headers(init?.headers).get("X-Org")).toBe(org);
  } finally {
    mock.restore();
  }
});

test("presence snapshot rejects foreign context unsolicited people and duplicate states", async () => {
  for (const snapshot of [
    { org_id: other, items: [] },
    { org_id: org, items: [{ user_id: other, state: "online" }] },
    {
      org_id: org,
      items: [
        { user_id: user, state: "online" },
        { user_id: user, state: "away" },
      ],
    },
    { org_id: org, items: [{ user_id: user, state: "busy" }] },
  ]) {
    const mock = installFetch(() => Response.json(snapshot));
    try {
      await expect(
        api.getPresence(context, { user_ids: [user] }),
      ).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
  const mock = installFetch(() => Response.json({ org_id: org, items: [] }));
  try {
    await expect(api.getPresence(context, { user_ids: [] })).resolves.toEqual({
      org_id: org,
      items: [],
    });
    expect(
      new URL(
        String(mock.requests[0].input),
        "http://test.invalid",
      ).searchParams.getAll("user_ids"),
    ).toEqual([]);
  } finally {
    mock.restore();
  }
});

test("HTTP heartbeat defaults the observed baseline and returns unknown zero heads", async () => {
  const reply = { ...context, changed: [sequence], truncated: false };
  const mock = installFetch(() => Response.json(reply, { headers: noStore }));
  try {
    await expect(
      api.heartbeatPresence(context, { state: "online" }),
    ).resolves.toEqual(reply);
    expect(mock.requests).toHaveLength(1);
    expect(String(mock.requests[0].input)).toBe("/api/comms/presence");
    expect(JSON.parse(String(mock.requests[0].init?.body))).toEqual({
      state: "online",
      known_sequences: [],
    });
  } finally {
    mock.restore();
  }
});

test("HTTP heartbeat accepts lower server heads and preserves bootstrap truncation without consuming it", async () => {
  const known = {
    state: "away" as const,
    known_sequences: sequences(100).map((value) => ({
      ...value,
      high_water_seq: Number.MAX_SAFE_INTEGER,
    })),
  };
  for (const reply of [
    {
      ...context,
      changed: [
        { conversation_id: other, high_water_seq: 0 },
        { ...sequence, high_water_seq: 3 },
      ],
      truncated: false,
    },
    { ...context, changed: sequences(100), truncated: true },
    emptyHeartbeat,
  ]) {
    const mock = installFetch(() => Response.json(reply, { headers: noStore }));
    try {
      await expect(api.heartbeatPresence(context, known)).resolves.toEqual(
        reply,
      );
      expect(mock.requests).toHaveLength(1);
      expect(JSON.parse(String(mock.requests[0].init?.body))).toEqual(known);
    } finally {
      mock.restore();
    }
  }
});

test("HTTP heartbeat rejects a response outside the bound organization or actor", async () => {
  for (const reply of [
    { ...emptyHeartbeat, org_id: other },
    { ...emptyHeartbeat, user_id: peer },
  ]) {
    const mock = installFetch(() => Response.json(reply, { headers: noStore }));
    try {
      await expect(
        api.heartbeatPresence(context, { state: "online" }),
      ).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
});

test("HTTP heartbeat requires 200 JSON and a no-store response", async () => {
  const replies: { status: number; body: unknown; headers?: HeadersInit }[] = [
    { status: 201, body: emptyHeartbeat, headers: noStore },
    { status: 200, body: emptyHeartbeat },
    {
      status: 200,
      body: emptyHeartbeat,
      headers: { "Cache-Control": "private" },
    },
    { status: 204, body: null, headers: noStore },
  ];
  for (const reply of replies) {
    const mock = installFetch(() =>
      reply.status === 204
        ? new Response(null, reply)
        : Response.json(reply.body, reply),
    );
    try {
      await expect(
        api.heartbeatPresence(context, { state: "online" }),
      ).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
});

test("HTTP heartbeat validates changed UUID order uniqueness bounds and empty truncation", async () => {
  const letter = {
    conversation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    high_water_seq: 0,
  };
  for (const reply of [
    { ...emptyHeartbeat, changed: [sequence, sequence] },
    {
      ...emptyHeartbeat,
      changed: [
        letter,
        { ...letter, conversation_id: letter.conversation_id.toUpperCase() },
      ],
    },
    {
      ...emptyHeartbeat,
      changed: [
        { conversation_id: nextConversation, high_water_seq: 1 },
        sequence,
      ],
    },
    { ...emptyHeartbeat, changed: sequences(101) },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((high_water_seq) => ({
      ...emptyHeartbeat,
      changed: [{ ...sequence, high_water_seq }],
    })),
    {
      ...emptyHeartbeat,
      changed: [{ ...sequence, conversation_id: "invalid" }],
    },
    { ...emptyHeartbeat, changed: [{ ...sequence, private_data: "extra" }] },
    { ...emptyHeartbeat, truncated: true },
    { ...emptyHeartbeat, truncated: "false" },
    { ...emptyHeartbeat, extra: true },
  ]) {
    const mock = installFetch(() => Response.json(reply, { headers: noStore }));
    try {
      await expect(
        api.heartbeatPresence(context, { state: "online" }),
      ).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
});

test("HTTP heartbeat rejects malformed observed baselines before dispatch", async () => {
  const letter = {
    conversation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    high_water_seq: 0,
  };
  const inputs: unknown[] = [
    {
      state: "online",
      known_sequences: [sequence, { ...sequence, high_water_seq: 1 }],
    },
    {
      state: "online",
      known_sequences: [
        letter,
        { ...letter, conversation_id: letter.conversation_id.toUpperCase() },
      ],
    },
    { state: "away", known_sequences: sequences(101) },
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((high_water_seq) => ({
      state: "online",
      known_sequences: [{ ...sequence, high_water_seq }],
    })),
    { state: "offline" },
    { state: "online", user_id: other },
    {
      state: "online",
      known_sequences: [{ ...sequence, conversation_id: "invalid" }],
    },
  ];
  const mock = installFetch(() =>
    Response.json(emptyHeartbeat, { headers: noStore }),
  );
  try {
    for (const input of inputs)
      await expect(
        api.heartbeatPresence(context, input as HttpHeartbeatRequest),
      ).rejects.toThrow();
    await expect(
      api.getPresence(context, { user_ids: [user, user] }),
    ).rejects.toThrow();
    await expect(
      api.getPresence(context, {
        user_ids: sequences(101).map((value) => value.conversation_id),
      }),
    ).rejects.toThrow();
    await expect(api.sendTyping(context, "../other")).rejects.toThrow();
    await expect(
      api.heartbeatPresence(
        { ...context, org_id: "invalid" },
        { state: "online" },
      ),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("heartbeat and typing keep shared CSRF cancellation and actor-free mutation bodies", async () => {
  const signal = new AbortController().signal;
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "openslate_csrf=presence-test" },
  });
  const mock = installFetch((input) =>
    String(input).endsWith("/typing")
      ? new Response(null, { status: 204 })
      : Response.json(emptyHeartbeat, { headers: noStore }),
  );
  try {
    await expect(
      api.heartbeatPresence(context, { state: "away" }, { signal }),
    ).resolves.toEqual(emptyHeartbeat);
    await expect(
      api.sendTyping(context, conversation, { signal }),
    ).resolves.toBe(undefined);
    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      "/api/comms/presence",
      `/api/comms/conversations/${conversation}/typing`,
    ]);
    expect(JSON.parse(String(mock.requests[0].init?.body))).toEqual({
      state: "away",
      known_sequences: [],
    });
    expect(mock.requests[1].init?.body).toBe(undefined);
    for (const { init } of mock.requests) {
      expect(init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Org")).toBe(org);
      expect(headers.get("X-CSRF-Token")).toBe("presence-test");
      expect(headers.has("If-Match")).toBe(false);
    }
  } finally {
    mock.restore();
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("presence and typing refuse undocumented success and preserve dependency errors", async () => {
  for (const row of [
    {
      call: () => api.getPresence(context, { user_ids: [] }),
      response: () =>
        Response.json({ org_id: org, items: [] }, { status: 201 }),
    },
    {
      call: () => api.sendTyping(context, conversation),
      response: () => Response.json(null),
    },
    {
      call: () => api.sendTyping(context, conversation),
      response: () => Response.json({ ok: true }),
    },
  ]) {
    const mock = installFetch(row.response);
    try {
      await expect(row.call()).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
  for (const [status, code] of [
    [403, "comms_post_denied"],
    [429, "comms_rate_limited"],
    [503, "comms_unavailable"],
  ] as const) {
    const mock = installFetch(() =>
      Response.json(
        { detail: { code, message: "Request refused" } },
        { status, headers: status === 429 ? { "Retry-After": "2" } : {} },
      ),
    );
    try {
      await expect(api.sendTyping(context, conversation)).rejects.toMatchObject(
        { status, code, retryAfter: status === 429 ? 2 : undefined },
      );
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
      await expect(
        api.heartbeatPresence(context, { state: "online" }),
      ).rejects.toBe(error);
    } finally {
      mock.restore();
    }
  }
});
