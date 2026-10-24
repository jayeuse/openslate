import { expect, test } from "@playwright/test";
import { QueryClient } from "@tanstack/react-query";
import { createLiveCommsRuntime } from "../../../src/components/systems/comms/adapters/live-runtime";
import { installFetch } from "../helpers/fake-fetch";
import {
  context,
  conversationId,
  org,
  user,
  rootId,
  live,
  replyRequest,
  messagePath,
} from "./s18-fixtures";
import { channel } from "./structure-fixtures";

test("an accepted send remains accepted when the subsequent metadata refresh is unavailable", async () => {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let observed!: () => void;
  const refreshed = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const fetch = installFetch((input) => {
    if (String(input).endsWith("bootstrap")) {
      observed();
      return Response.json({ detail: "Unavailable" }, { status: 503 });
    }
    return Response.json(live, {
      status: 201,
      headers: { Location: messagePath },
    });
  });
  const runtime = createLiveCommsRuntime(cache, context);
  try {
    await expect(
      runtime.client.sendReply(conversationId, rootId, replyRequest),
    ).resolves.toMatchObject({ status: 201, message: { id: live.id } });
    // The command runner asks for the follow-up repair, not the send itself.
    await runtime.refresh().catch(() => {});
    await refreshed;
    expect(runtime.outbox.getSnapshot()).toEqual([]);
    expect(
      fetch.requests.filter((request) => request.init?.method === "POST"),
    ).toHaveLength(1);
  } finally {
    runtime.dispose();
    cache.clear();
    fetch.restore();
  }
});

test("a repair drops the presence of a conversation nobody shows instead of keeping it stale", async () => {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const states = ["online", "away"];
  const fetch = installFetch((input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/presence"))
      return Response.json({
        org_id: org,
        items: [{ user_id: user, state: states.shift() }],
      });
    return Response.json({
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
          high_water_seq: 0,
          unread_count: 0,
          mention_count: 0,
          first_unread_seq: null,
        },
      ],
    });
  });
  const runtime = createLiveCommsRuntime(cache, context);
  try {
    // Two member reads: the second started while the first still showed.
    const [first, second] = [1, 2].map((readAt) =>
      runtime.scope.presenceOptions(
        conversationId,
        readAt,
        [user],
        runtime.client,
      ),
    );
    await cache.fetchQuery(first);
    await cache.fetchQuery({ ...second, staleTime: 0 });
    expect(cache.getQueryData(second.queryKey)).toEqual({ [user]: "away" });
    // The conversation is closed: no observer shows its presence.
    await runtime.refresh();
    // Reopened later, it reads presence again rather than show an old read.
    expect(cache.getQueryData(first.queryKey)).toBeUndefined();
    expect(cache.getQueryData(second.queryKey)).toBeUndefined();
  } finally {
    runtime.dispose();
    cache.clear();
    fetch.restore();
  }
});
