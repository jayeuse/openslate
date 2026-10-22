import { expect, test } from "@playwright/test";
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { ApiError } from "../../../src/lib/api";
import { installFetch } from "../helpers/fake-fetch";
import {
  createCommsQueryScope,
  querySettled,
} from "../../../src/components/systems/comms/adapters/comms-queries";
import type {
  CommsContext,
  HistoryPage,
} from "../../../src/components/systems/comms/contract/types";

const id = (n: number) =>
  `81000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = { user_id: id(1), org_id: id(2) };
const conversation = id(3);
const otherConversation = id(4);
const client = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function history(
  sequences: number[],
  older: boolean,
  newer: boolean,
): HistoryPage {
  return {
    org_id: owner.org_id,
    conversation_id: conversation,
    thread_root_id: null,
    items: sequences.map((seq) => ({
      id: id(seq),
      org_id: owner.org_id,
      conversation_id: conversation,
      seq,
      author_id: owner.user_id,
      client_key: id(seq + 1000),
      created_at: "2026-10-20T00:00:00Z",
      parent_id: null,
      reply_to_id: null,
      also_send_to_channel: false,
      thread: null,
      state: "live",
      body: `Server message ${seq}`,
      edited_at: null,
      pinned_at: null,
      pinned_by: null,
      attachments: [],
      record_references: [],
      mention_user_ids: [],
      mentions_channel: false,
      mentions_here: false,
      reactions: [],
      link_previews: [],
    })),
    pagination: {
      limit: 50,
      count: sequences.length,
      first_seq: sequences[0] ?? null,
      last_seq: sequences.at(-1) ?? null,
      high_water_seq: 302,
      has_older: older,
      has_newer: newer,
    },
  };
}

test("Comms cached bootstrap reuses only its exact account and organization", async () => {
  const cache = client();
  const contexts: CommsContext[] = [
    owner,
    { ...owner, org_id: id(5) },
    { ...owner, user_id: id(6) },
  ];
  let active = owner;
  const fetch = installFetch(() =>
    Response.json({ ...active, categories: [], conversations: [] }),
  );
  const scopes = contexts.map((context) =>
    createCommsQueryScope(cache, context),
  );
  try {
    for (const [index, context] of contexts.entries()) {
      active = context;
      const options = scopes[index].bootstrapOptions();
      await expect(cache.fetchQuery(options)).resolves.toMatchObject(context);
      await expect(cache.fetchQuery(options)).resolves.toMatchObject(context);
    }
    expect(fetch.requests).toHaveLength(3);
    expect(
      fetch.requests.map((request) =>
        new Headers(request.init?.headers).get("X-Org"),
      ),
    ).toEqual([owner.org_id, id(5), owner.org_id]);
  } finally {
    scopes.forEach((scope) => scope.dispose());
    cache.clear();
    fetch.restore();
  }
});

test("Comms refusal removes its conversation data and older success cannot reopen it", async () => {
  const cache = client(),
    scope = createCommsQueryScope(cache, owner);
  const late = deferred<string>();
  const afterRecovery = deferred<string>();
  try {
    cache.setQueryData(
      scope.keys.conversation(conversation),
      "Previously authorized private text",
    );
    cache.setQueryData(
      scope.keys.conversation(otherConversation),
      "Other conversation",
    );
    const old = scope.read(conversation, () => late.promise);
    const oldestAfterRecovery = scope.read(
      conversation,
      () => afterRecovery.promise,
    );
    const refused = new ApiError(404, "Not available");
    await expect(
      scope.read(conversation, () => Promise.reject(refused)),
    ).rejects.toBe(refused);
    expect(scope.isRefused(conversation)).toBe(true);
    expect(
      cache.getQueryData(scope.keys.conversation(conversation)),
    ).toBeUndefined();
    expect(cache.getQueryData(scope.keys.conversation(otherConversation))).toBe(
      "Other conversation",
    );
    late.resolve("Old private response");
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    expect(scope.isRefused(conversation)).toBe(true);
    await expect(
      scope.read(conversation, async () => "Fresh authorized response"),
    ).resolves.toBe("Fresh authorized response");
    expect(scope.isRefused(conversation)).toBe(false);
    afterRecovery.resolve("Pre-refusal bytes arriving after recovery");
    await expect(oldestAfterRecovery).rejects.toMatchObject({
      name: "AbortError",
    });
  } finally {
    scope.dispose();
    cache.clear();
  }
});

test("Comms stale refusal cannot override a later-started success and 503 is not denial", async () => {
  const cache = client(),
    scope = createCommsQueryScope(cache, owner);
  const late = deferred<string>();
  try {
    const old = scope.read(conversation, () => late.promise);
    await scope.read(conversation, async () => "New current authorization");
    late.reject(new ApiError(403, "Older refusal"));
    await expect(old).rejects.toMatchObject({ status: 403 });
    expect(scope.isRefused(conversation)).toBe(false);
    cache.setQueryData(scope.keys.conversation(conversation), "Last good");
    await expect(
      scope.read(conversation, async () => {
        throw new ApiError(503, "Unavailable");
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(scope.isRefused(conversation)).toBe(false);
    expect(cache.getQueryData(scope.keys.conversation(conversation))).toBe(
      "Last good",
    );
  } finally {
    scope.dispose();
    cache.clear();
  }
});

test("a presence read never clears its conversation's refusal", async () => {
  const cache = client(),
    scope = createCommsQueryScope(cache, owner);
  try {
    await expect(
      scope.read(conversation, async () => {
        throw new ApiError(403, "Refused");
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(scope.isRefused(conversation)).toBe(true);
    // Presence is organization data: its success says nothing about access.
    await cache.fetchQuery(
      scope.presenceOptions(conversation, 1, [id(9)], {
        getPresence: async () => ({
          items: [{ user_id: id(9), state: "online" }],
        }),
      } as unknown as Parameters<typeof scope.presenceOptions>[3]),
    );
    expect(scope.isRefused(conversation)).toBe(true);
  } finally {
    scope.dispose();
    cache.clear();
  }
});

test("Comms disposal aborts reads and rejects late completion without touching another scope", async () => {
  const cache = client(),
    scope = createCommsQueryScope(cache, owner);
  const other = createCommsQueryScope(cache, { ...owner, org_id: id(5) });
  const held = deferred<string>();
  let signal: AbortSignal | undefined;
  try {
    cache.setQueryData(scope.keys.conversation(conversation), "Old data");
    cache.setQueryData(
      other.keys.conversation(conversation),
      "Other organization",
    );
    const old = scope.read(conversation, (value) => {
      signal = value;
      return held.promise;
    });
    scope.dispose();
    expect(signal?.aborted).toBe(true);
    held.resolve("Late old data");
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    expect(
      cache.getQueryData(scope.keys.conversation(conversation)),
    ).toBeUndefined();
    expect(cache.getQueryData(other.keys.conversation(conversation))).toBe(
      "Other organization",
    );
    let called = false;
    await expect(
      scope.read(conversation, async () => {
        called = true;
        return "Forbidden old request";
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(called).toBe(false);
    const rebound = createCommsQueryScope(cache, owner);
    cache.setQueryData(
      rebound.keys.conversation(conversation),
      "New admitted lifetime",
    );
    scope.dispose();
    expect(cache.getQueryData(rebound.keys.conversation(conversation))).toBe(
      "New admitted lifetime",
    );
    rebound.dispose();
  } finally {
    scope.dispose();
    other.dispose();
    cache.clear();
  }
});

test("Comms bootstrap refusal reaches conversation observers without clearing a narrower refusal", async () => {
  const cache = client(),
    scope = createCommsQueryScope(cache, owner);
  const observer = new QueryObserver(cache, scope.refusalOptions(conversation));
  const stop = observer.subscribe(() => {});
  try {
    expect(observer.getCurrentResult().data).toBe(false);
    await expect(
      scope.read(otherConversation, async () => {
        throw new ApiError(404, "Hidden conversation");
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      scope.read(undefined, async () => {
        throw new ApiError(403, "Organization unavailable");
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(observer.getCurrentResult().data).toBe(true);
    await scope.read(
      conversation,
      async () => "A single authorized conversation",
    );
    expect(observer.getCurrentResult().data).toBe(true);
    await scope.read(undefined, async () => "Fresh authorized bootstrap");
    expect(observer.getCurrentResult().data).toBe(false);
    expect(scope.isRefused(otherConversation)).toBe(true);
  } finally {
    stop();
    scope.dispose();
    cache.clear();
  }
});

test("a fresh admission does not inherit a retired refusal observer", async () => {
  const cache = client();
  const old = createCommsQueryScope(cache, owner);
  const observer = new QueryObserver(cache, old.refusalOptions(conversation));
  const stop = observer.subscribe(() => {});
  let fresh: ReturnType<typeof createCommsQueryScope> | undefined;
  try {
    await expect(
      old.read(conversation, async () => {
        throw new ApiError(404, "Not found");
      }),
    ).rejects.toThrow();
    expect(observer.getCurrentResult().data).toBe(true);
    old.dispose();
    // A committed render can finish binding its old options during retirement.
    observer.setOptions(old.refusalOptions(conversation));
    fresh = createCommsQueryScope(cache, owner);
    observer.setOptions(fresh.refusalOptions(conversation));
    await fresh.read(undefined, async () => "Fresh authorized metadata");
    expect(observer.getCurrentResult().data).toBe(false);
  } finally {
    stop();
    old.dispose();
    fresh?.dispose();
    cache.clear();
  }
});

test("Comms infinite history uses exclusive cursors in both directions and retains only two pages", async () => {
  const cache = client(),
    scope = createCommsQueryScope(cache, owner);
  const pages = [
    history([301, 302], true, false),
    history([299, 300], true, true),
    history([297, 298], true, true),
    history([301, 302], true, false),
  ];
  let index = 0;
  const fetch = installFetch(() => Response.json(pages[index++]));
  const options = scope.historyOptions(conversation);
  const observer = new InfiniteQueryObserver(cache, options);
  const stop = observer.subscribe(() => {});
  try {
    await cache.fetchInfiniteQuery(options);
    await observer.fetchPreviousPage();
    await observer.fetchPreviousPage();
    expect(
      observer
        .getCurrentResult()
        .data?.pages.flatMap((page) =>
          page.items.map((message) => message.seq),
        ),
    ).toEqual([297, 298, 299, 300]);
    await observer.fetchNextPage();
    expect(
      observer
        .getCurrentResult()
        .data?.pages.flatMap((page) =>
          page.items.map((message) => message.seq),
        ),
    ).toEqual([299, 300, 301, 302]);
    expect(
      fetch.requests.map((request) =>
        Object.fromEntries(
          new URL(String(request.input), "http://localhost").searchParams,
        ),
      ),
    ).toEqual([
      { limit: "50" },
      { limit: "50", before_seq: "301" },
      { limit: "50", before_seq: "299" },
      { limit: "50", after_seq: "300" },
    ]);
  } finally {
    stop();
    scope.dispose();
    cache.clear();
    fetch.restore();
  }
});

test("waiting for a bootstrap read ends when sign-out clears it mid-read", async () => {
  const cache = client(),
    scope = createCommsQueryScope(cache, owner);
  const held = deferred<never>();
  try {
    void cache
      .fetchQuery({
        queryKey: scope.keys.bootstrap,
        queryFn: () => held.promise,
      })
      .catch(() => {});
    const waiting = querySettled(cache, scope.keys.bootstrap);
    cache.clear();
    await expect(
      Promise.race([
        waiting.then(() => "settled"),
        new Promise((done) => setTimeout(() => done("still waiting"), 1_000)),
      ]),
    ).resolves.toBe("settled");
  } finally {
    held.reject(new Error("Test finished"));
    scope.dispose();
    cache.clear();
  }
});
