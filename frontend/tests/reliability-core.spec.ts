import { expect, test } from "@playwright/test";

import {
  parseJsonBody,
  PayloadTooLargeError,
  readLimitedStream,
  RequestDeadlineExceededError,
  withinDeadline,
} from "../src/lib/reliability-core";

function streamFrom(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

test.describe("reliability stream guards", () => {
  test("rejects a declared request body over the limit before reading it", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readLimitedStream(stream, new Headers({ "content-length": "5" }), 4),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(cancelled).toBe(true);
  });

  test("counts streamed bytes even when Content-Length lies", async () => {
    await expect(
      readLimitedStream(
        streamFrom(new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])),
        new Headers({ "content-length": "2" }),
        4,
      ),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  test("preserves bounded body bytes for JSON validation", async () => {
    const body = await readLimitedStream(
      streamFrom(new TextEncoder().encode('{"safe":true}')),
      new Headers(),
      32,
    );

    expect(parseJsonBody(body)).toEqual({ safe: true });
    expect(
      parseJsonBody(new TextEncoder().encode("not json").buffer),
    ).toBeNull();
  });

  test("stops waiting when the enclosing request deadline aborts", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      withinDeadline(Promise.resolve("late"), controller.signal),
    ).rejects.toBeInstanceOf(RequestDeadlineExceededError);
  });

  test("discards a slow stream when the enclosing request is cancelled", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const body = readLimitedStream(
      stream,
      new Headers(),
      16,
      controller.signal,
    );
    controller.abort();

    await expect(body).rejects.toBeInstanceOf(RequestDeadlineExceededError);
    expect(cancelled).toBe(true);
  });
});
