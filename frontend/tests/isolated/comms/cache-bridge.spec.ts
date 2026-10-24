import { expect, test } from "@playwright/test";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import {
  createCommsQueryScope,
  querySettled,
} from "../../../src/components/systems/comms/adapters/comms-queries";
import { createCommsCacheBridge } from "../../../src/components/systems/comms/adapters/cache-bridge";
import { createReadyHttpCommsClient } from "../../../src/components/systems/comms/adapters/http-client";
import type {
  CommsEvent,
  HistoryPage,
  Message,
} from "../../../src/components/systems/comms/contract/types";
import { installFetch } from "../helpers/fake-fetch";
import { context, conversationId, live } from "./s18-fixtures";
import { channel } from "./structure-fixtures";

function message(seq: number, body = `Message ${seq}`): Message {
  return {
    ...live,
    state: "live",
    id: `91000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    client_key: `92000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    seq,
    parent_id: null,
    body,
  };
}
function page(
  items: Message[],
  head: number,
  newer = false,
  limit = 50,
): HistoryPage {
  return {
    org_id: context.org_id,
    conversation_id: conversationId,
    thread_root_id: null,
    items,
    pagination: {
      limit,
      count: items.length,
      first_seq: items[0]?.seq ?? null,
      last_seq: items.at(-1)?.seq ?? null,
      high_water_seq: head,
      has_older: false,
      has_newer: newer,
    },
  };
}
function event(
  seq: number,
  kind: "created" | "edited" = "created",
): CommsEvent {
  return {
    topic: `org:${context.org_id}:conversation:${conversationId}`,
    private: true,
    event: "message",
    payload: { conversation_id: conversationId, seq, kind },
  };
}
function setup() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const scope = createCommsQueryScope(cache, context);
  const http = createReadyHttpCommsClient(context, scope.signal);
  const bridge = createCommsCacheBridge(cache, scope, http);
  const observer = new InfiniteQueryObserver(
    cache,
    scope.historyOptions(conversationId),
  );
  const stop = observer.subscribe(() => {});
  return {
    cache,
    scope,
    bridge,
    observer,
    close() {
      stop();
      scope.dispose();
      cache.clear();
    },
  };
}
const bootstrap = {
  ...context,
  categories: [],
  conversations: [
    {
      conversation: { ...channel, category_id: null },
      preferences: {
        notify: "all",
        mute: { kind: "off" },
        starred: false,
        hidden: false,
        manual_unread: false,
      },
      last_read_seq: 0,
      high_water_seq: 3,
      unread_count: 3,
      mention_count: 0,
      first_unread_seq: 1,
    },
  ],
};

test("message events hydrate cached content and a sequence gap repairs history without invalidation", async () => {
  let current = page([message(1)], 1);
  const fetch = installFetch((input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("bootstrap")) return Response.json(bootstrap);
    if (url.pathname.endsWith("by-sequence/1"))
      return Response.json(message(1, "Edited on server"), {
        headers: { ETag: '"message-2"' },
      });
    if (url.pathname.endsWith("by-sequence/3"))
      return Response.json(message(3), { headers: { ETag: '"message-1"' } });
    if (url.searchParams.get("after_seq") === "1")
      return Response.json(page([message(2), message(3)], 3));
    if (url.searchParams.get("after_seq") === "0")
      return Response.json(page([message(1, "Edited on server")], 3, true, 1));
    return Response.json(current);
  });
  const owner = setup();
  try {
    await owner.cache.fetchInfiniteQuery(
      owner.scope.historyOptions(conversationId),
    );
    await owner.bridge.event(event(1, "edited"));
    expect(
      owner.observer.getCurrentResult().data?.pages[0].items[0],
    ).toMatchObject({ body: "Edited on server" });
    current = page([message(1), message(2), message(3)], 3);
    await owner.bridge.event(event(3));
    expect(
      owner.observer
        .getCurrentResult()
        .data?.pages.flatMap((p) => p.items.map((m) => m.seq)),
    ).toEqual([1, 2, 3]);
    expect(
      fetch.requests.some((request) =>
        String(request.input).includes("after_seq=1"),
      ),
    ).toBe(true);
    expect(
      owner.cache.getQueryState(owner.scope.keys.history(conversationId, null))
        ?.isInvalidated,
    ).toBe(false);
  } finally {
    owner.close();
    fetch.restore();
  }
});

test("a message event during the first history read repairs the gap that read missed", async () => {
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = installFetch(async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("bootstrap")) return Response.json(bootstrap);
    if (url.searchParams.get("after_seq") === "1")
      return Response.json(page([message(2), message(3)], 3));
    if (url.searchParams.get("after_seq") === "0")
      return Response.json(page([message(1)], 3, true, 1));
    // The first read was answered before messages 2 and 3 existed.
    entered();
    await held;
    return Response.json(page([message(1)], 1));
  });
  const owner = setup();
  try {
    await reading;
    const pending = owner.bridge.event(event(3));
    release();
    await pending;
    await querySettled(
      owner.cache,
      owner.scope.keys.history(conversationId, null),
    );
    expect(
      owner.observer
        .getCurrentResult()
        .data?.pages.flatMap((p) => p.items.map((m) => m.seq)),
    ).toEqual([1, 2, 3]);
  } finally {
    owner.close();
    fetch.restore();
  }
});

test("failed heartbeat recovery keeps its fetched cursor even after bootstrap observes a higher head", async () => {
  let fail = true;
  const fetch = installFetch((input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("bootstrap")) return Response.json(bootstrap);
    if (url.searchParams.get("after_seq") === "2")
      return fail
        ? Response.json({ detail: "Unavailable" }, { status: 503 })
        : Response.json(page([message(3)], 3));
    return Response.json(
      page(
        [message(1), message(2)],
        2,
        false,
        Number(url.searchParams.get("limit")),
      ),
    );
  });
  const owner = setup();
  try {
    await owner.cache.fetchInfiniteQuery(
      owner.scope.historyOptions(conversationId),
    );
    const receipt = {
      ...context,
      changed: [{ conversation_id: conversationId, high_water_seq: 3 }],
      truncated: false,
    };
    await expect(owner.bridge.heartbeat(receipt)).rejects.toThrow();
    expect(owner.bridge.knownSequences()).toEqual([
      { conversation_id: conversationId, high_water_seq: 2 },
    ]);
    fail = false;
    await owner.bridge.heartbeat(receipt);
    expect(
      owner.observer
        .getCurrentResult()
        .data?.pages.flatMap((p) => p.items.map((m) => m.seq)),
    ).toEqual([1, 2, 3]);
    expect(
      fetch.requests.filter((request) =>
        String(request.input).includes("after_seq=2"),
      ),
    ).toHaveLength(2);
  } finally {
    owner.close();
    fetch.restore();
  }
});

test("reconnect reconciles an older loaded window without replacing it with the newest messages", async () => {
  const fetch = installFetch((input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("bootstrap")) return Response.json(bootstrap);
    if (url.searchParams.get("after_seq") === "100")
      return Response.json(page([message(101)], 101));
    if (url.searchParams.get("after_seq") === "0")
      return Response.json(
        page([message(1, "Changed while offline"), message(2)], 101, true, 2),
      );
    return Response.json(page([message(1), message(2)], 100, true));
  });
  const owner = setup();
  try {
    await owner.cache.fetchInfiniteQuery(
      owner.scope.historyOptions(conversationId),
    );
    await owner.bridge.recover();
    const items = owner.observer
      .getCurrentResult()
      .data?.pages.flatMap((p) => p.items);
    expect(items?.map((m) => m.seq)).toEqual([1, 2]);
    expect(items?.[0]).toMatchObject({ body: "Changed while offline" });
    expect(owner.bridge.knownSequences()).toEqual([
      { conversation_id: conversationId, high_water_seq: 101 },
    ]);
  } finally {
    owner.close();
    fetch.restore();
  }
});

test("foreign events cannot dispatch reads and retired hydration cannot repopulate cleared history", async () => {
  let release!: (value: Response) => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const fetch = installFetch((input) => {
    if (String(input).includes("by-sequence")) {
      entered();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }
    return Response.json(page([message(1)], 1));
  });
  const owner = setup();
  try {
    await owner.cache.fetchInfiniteQuery(
      owner.scope.historyOptions(conversationId),
    );
    await expect(
      owner.bridge.event({
        ...event(1),
        topic: "org:foreign:conversation:hidden",
      }),
    ).rejects.toThrow();
    expect(fetch.requests).toHaveLength(1);
    const pending = owner.bridge.event(event(1, "edited"));
    await waiting;
    owner.scope.dispose();
    release(
      Response.json(message(1, "Retired content"), {
        headers: { ETag: '"message-2"' },
      }),
    );
    await expect(pending).rejects.toThrow();
    expect(
      owner.cache.getQueryData(owner.scope.keys.history(conversationId, null)),
    ).toBeUndefined();
  } finally {
    owner.close();
    fetch.restore();
  }
});

test("a purged sequence repairs the loaded range without discarding the readable conversation", async () => {
  const fetch = installFetch((input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("bootstrap")) return Response.json(bootstrap);
    if (url.pathname.includes("by-sequence"))
      return Response.json({ detail: "Not found" }, { status: 404 });
    if (url.searchParams.get("after_seq") === "2")
      return Response.json(page([], 2));
    if (url.searchParams.get("after_seq") === "0")
      return Response.json(page([message(2)], 2, false, 2));
    return Response.json(page([message(1), message(2)], 2));
  });
  const owner = setup();
  try {
    await owner.cache.fetchInfiniteQuery(
      owner.scope.historyOptions(conversationId),
    );
    await owner.bridge.event(event(1, "edited"));
    expect(
      owner.observer
        .getCurrentResult()
        .data?.pages.flatMap((p) => p.items.map((m) => m.seq)),
    ).toEqual([2]);
    expect(owner.scope.isRefused(conversationId)).toBe(false);
  } finally {
    owner.close();
    fetch.restore();
  }
});
