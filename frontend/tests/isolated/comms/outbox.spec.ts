import { expect, test } from "@playwright/test";
import { createCommsOutbox } from "../../../src/components/systems/comms/adapters/outbox";
import { createReadyHttpCommsClient } from "../../../src/components/systems/comms/adapters/http-client";
import { installFetch } from "../helpers/fake-fetch";
import {
  context,
  conversationId,
  rootId,
  live,
  replyRequest,
  messagePath,
} from "./s18-fixtures";

test("outbox retries the original client key and accepts a replay without inventing a message", async () => {
  const lifetime = new AbortController();
  const http = createReadyHttpCommsClient(context, lifetime.signal);
  const box = createCommsOutbox(http, lifetime.signal);
  let fail = true;
  const fetch = installFetch(() =>
    fail
      ? Promise.reject(new TypeError("Response lost"))
      : Response.json(live, { status: 200 }),
  );
  try {
    await expect(
      box.sendReply(conversationId, rootId, replyRequest),
    ).rejects.toThrow();
    expect(box.getSnapshot()).toMatchObject([
      { client_key: replyRequest.client_key, state: "not-sent" },
    ]);
    fail = false;
    await expect(box.retry(replyRequest.client_key)).resolves.toMatchObject({
      status: 200,
      message: { id: live.id },
    });
    expect(
      fetch.requests.map(
        (request) => JSON.parse(String(request.init?.body)).client_key,
      ),
    ).toEqual([replyRequest.client_key, replyRequest.client_key]);
    expect(box.getSnapshot()).toEqual([]);
  } finally {
    lifetime.abort();
    fetch.restore();
  }
});

test("outbox coalesces an in-flight send but cannot silently replace its immutable content", async () => {
  const lifetime = new AbortController();
  const http = createReadyHttpCommsClient(context, lifetime.signal);
  const box = createCommsOutbox(http, lifetime.signal);
  let release!: (response: Response) => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const fetch = installFetch(() => {
    entered();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  try {
    const first = box.sendReply(conversationId, rootId, replyRequest);
    await waiting;
    const second = box.sendReply(conversationId, rootId, replyRequest);
    expect(fetch.requests).toHaveLength(1);
    await expect(
      box.sendReply(conversationId, rootId, {
        ...replyRequest,
        body: "Different content",
      }),
    ).rejects.toThrow();
    release(
      Response.json(live, { status: 201, headers: { Location: messagePath } }),
    );
    await expect(first).resolves.toMatchObject({ status: 201 });
    await expect(second).resolves.toMatchObject({ status: 201 });
    expect(box.getSnapshot()).toEqual([]);
  } finally {
    lifetime.abort();
    fetch.restore();
  }
});

test("outbox draft identity survives a composer remount but disposal erases entries and rejects late sends", async () => {
  const lifetime = new AbortController();
  const http = createReadyHttpCommsClient(context, lifetime.signal);
  const box = createCommsOutbox(http, lifetime.signal);
  let release!: (response: Response) => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const fetch = installFetch(() => {
    entered();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  try {
    const key = box.identity("channel-composer", "same draft");
    expect(box.identity("channel-composer", "same draft")).toBe(key);
    expect(box.identity("thread-composer", "same draft")).not.toBe(key);
    const pending = box.sendReply(conversationId, rootId, replyRequest);
    await waiting;
    lifetime.abort();
    expect(box.getSnapshot()).toEqual([]);
    release(
      Response.json(live, { status: 201, headers: { Location: messagePath } }),
    );
    await expect(pending).rejects.toThrow();
    await expect(box.retry(replyRequest.client_key)).rejects.toThrow();
    expect(fetch.requests).toHaveLength(1);
  } finally {
    lifetime.abort();
    fetch.restore();
  }
});
