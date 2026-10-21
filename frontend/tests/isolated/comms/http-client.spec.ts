import { expect, test } from "@playwright/test";
import { createReadyHttpCommsClient } from "../../../src/components/systems/comms/adapters/http-client";
import { installFetch } from "../helpers/fake-fetch";
import { setCurrentOrganizationId } from "../../../src/lib/organization-context";
import {
  context,
  conversationId,
  rootId,
  live,
  replyRequest,
  messagePath,
} from "./s18-fixtures";
import {
  retained,
  retentionRequest,
  proof,
  conditional,
} from "./jobs-fixtures";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("bound HTTP client fences a late accepted reply after its admission lifetime ends", async () => {
  const lifetime = new AbortController();
  const client = createReadyHttpCommsClient(context, lifetime.signal);
  const entered = deferred<void>(),
    response = deferred<Response>();
  const fetch = installFetch(() => {
    entered.resolve();
    return response.promise;
  });
  try {
    const sending = client.sendReply(conversationId, rootId, replyRequest);
    await entered.promise;
    lifetime.abort();
    expect(fetch.requests[0].init?.signal?.aborted).toBe(true);
    response.resolve(
      Response.json(live, { status: 201, headers: { Location: messagePath } }),
    );
    await expect(sending).rejects.toMatchObject({ kind: "cancelled" });
    await expect(client.bootstrap()).rejects.toMatchObject({
      kind: "cancelled",
    });
    expect(fetch.requests).toHaveLength(1);
  } finally {
    lifetime.abort();
    fetch.restore();
  }
});

test("bound HTTP client preserves write-only proof and validators while combining cancellation", async () => {
  const lifetime = new AbortController(),
    caller = new AbortController();
  const client = createReadyHttpCommsClient(context, lifetime.signal);
  const fetch = installFetch(() =>
    Response.json(retained, {
      headers: { ETag: '"retention-2"', "Cache-Control": "private, no-store" },
    }),
  );
  try {
    await expect(
      client.updateRetention(retentionRequest, {
        ...proof,
        signal: caller.signal,
      }),
    ).resolves.toEqual({ data: retained, etag: '"retention-2"' });
    const request = fetch.requests[0];
    expect(new Headers(request.init?.headers).get("X-Org")).toBe(
      context.org_id,
    );
    expect(new Headers(request.init?.headers).get("If-Match")).toBe(
      conditional.if_match,
    );
    expect(JSON.parse(String(request.init?.body))).toEqual({
      ...retentionRequest,
      password: proof.password,
    });
    caller.abort();
    expect(request.init?.signal?.aborted).toBe(true);
    expect(client.context).toEqual(context);
  } finally {
    lifetime.abort();
    fetch.restore();
  }
});

test("bound HTTP heartbeat keeps the canonical 200 result rather than a void or fabricated response", async () => {
  const lifetime = new AbortController();
  const client = createReadyHttpCommsClient(context, lifetime.signal);
  const receipt = {
    ...context,
    changed: [{ conversation_id: conversationId, high_water_seq: 7 }],
    truncated: false,
  };
  const fetch = installFetch(() =>
    Response.json(receipt, { headers: { "Cache-Control": "no-store" } }),
  );
  try {
    await expect(
      client.heartbeatPresence({
        state: "online",
        known_sequences: [
          { conversation_id: conversationId, high_water_seq: 4 },
        ],
      }),
    ).resolves.toEqual(receipt);
    expect(JSON.parse(String(fetch.requests[0].init?.body))).toEqual({
      state: "online",
      known_sequences: [{ conversation_id: conversationId, high_water_seq: 4 }],
    });
  } finally {
    lifetime.abort();
    fetch.restore();
  }
});

test("bound client sends templates, settings history and join requests to their live routes", async () => {
  const lifetime = new AbortController();
  const client = createReadyHttpCommsClient(context, lifetime.signal);
  const fetch = installFetch((input) => {
    const url = new URL(String(input), "http://localhost");
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    return Response.json(
      {
        items: [],
        pagination: { limit, offset, count: 0, total: 0, has_more: false },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  });
  try {
    await expect(client.listTemplates()).resolves.toMatchObject({ items: [] });
    await expect(
      client.listConfigurationHistory({ kind: "workspace" }),
    ).resolves.toMatchObject({ items: [] });
    await expect(client.listAdmissions(conversationId)).resolves.toMatchObject({
      items: [],
    });
    expect(
      fetch.requests.map((request) => ({
        path: new URL(String(request.input), "http://localhost").pathname,
        org: new Headers(request.init?.headers).get("X-Org"),
      })),
    ).toEqual([
      { path: "/api/comms/templates", org: context.org_id },
      { path: "/api/comms/settings/workspace/history", org: context.org_id },
      {
        path: `/api/comms/conversations/${conversationId}/admissions`,
        org: context.org_id,
      },
    ]);
  } finally {
    lifetime.abort();
    fetch.restore();
  }
});

test("bound HTTP client keeps the server slow-mode refusal usable by the retained composer", async () => {
  const lifetime = new AbortController();
  const client = createReadyHttpCommsClient(context, lifetime.signal);
  const detail = {
    code: "comms_slow_mode",
    message: "Wait before posting again",
  };
  const fetch = installFetch(() =>
    Response.json(
      { detail },
      { status: 429, headers: { "Retry-After": "12" } },
    ),
  );
  try {
    await expect(
      client.sendReply(conversationId, rootId, replyRequest),
    ).rejects.toMatchObject({
      kind: "http",
      failure: { status: 429, body: { detail }, retry_after_seconds: 12 },
    });
  } finally {
    lifetime.abort();
    fetch.restore();
  }
});

test("activity filters the existing notification service before paging and fences the bound organization", async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  setCurrentOrganizationId(context.org_id);
  const lifetime = new AbortController();
  const client = createReadyHttpCommsClient(context, lifetime.signal);
  const common = {
    status: "unread",
    scheduled_for: null,
    created_at: "2026-10-21T12:00:00Z",
    read_at: null,
  };
  const first = {
    ...common,
    id: "93000000-0000-4000-8000-000000000001",
    kind: "comms-mention",
    subject_type: "comms_message",
    subject_id: rootId,
    message_id: rootId,
    conversation_id: conversationId,
    org_id: context.org_id,
  };
  const second = {
    ...first,
    id: "93000000-0000-4000-8000-000000000002",
    created_at: "2026-10-21T13:00:00Z",
  };
  const unrelated = {
    ...common,
    id: "93000000-0000-4000-8000-000000000003",
    kind: "backup-failed",
    subject_type: "backup_run",
    subject_id: rootId,
  };
  const fetch = installFetch(() =>
    Response.json({
      items: [second, unrelated, first],
      pagination: {
        limit: 100,
        offset: 0,
        count: 3,
        total: 3,
        has_more: false,
      },
    }),
  );
  try {
    await expect(
      client.listActivity({ limit: 1, offset: 1, sort_order: "asc" }),
    ).resolves.toEqual({
      items: [second],
      pagination: { limit: 1, offset: 1, count: 1, total: 2, has_more: false },
    });
    expect(new Headers(fetch.requests[0].init?.headers).get("X-Org")).toBe(
      context.org_id,
    );
    setCurrentOrganizationId("93000000-0000-4000-8000-000000000004");
    await expect(client.listActivity()).rejects.toThrow();
    expect(fetch.requests).toHaveLength(1);
  } finally {
    lifetime.abort();
    fetch.restore();
    setCurrentOrganizationId(null);
    if (windowDescriptor)
      Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
