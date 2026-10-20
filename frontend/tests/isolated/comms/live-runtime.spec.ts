import { expect, test } from "@playwright/test";
import { QueryClient } from "@tanstack/react-query";
import { createLiveCommsRuntime } from "../../../src/components/systems/comms/adapters/live-runtime";
import { installFetch } from "../helpers/fake-fetch";
import {
  context,
  conversationId,
  rootId,
  live,
  replyRequest,
  messagePath,
} from "./s18-fixtures";

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
