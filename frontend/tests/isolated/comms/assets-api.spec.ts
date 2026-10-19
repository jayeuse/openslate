import { expect, test } from "@playwright/test";
import * as api from "../../../src/components/systems/comms/adapters/assets-api";
import { ApiContractError } from "../../../src/lib/api";
import { installFetch } from "../helpers/fake-fetch";
import {
  context,
  org,
  conversationId,
  fileId,
  other,
  file,
  ready,
  reservation,
  downloadHeaders,
  available,
  unavailable,
  page,
} from "./s18-fixtures";

const contentPath = `/api/comms/conversations/${conversationId}/files/${fileId}/content`;
test("attachment reservation rejects a different conversation", async () => {
  const mock = installFetch(() =>
    Response.json(
      { ...file, conversation_id: other },
      {
        status: 201,
        headers: { Location: contentPath.replace("/content", "") },
      },
    ),
  );
  try {
    await expect(
      api.reserveAttachment(context, conversationId, reservation),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    mock.restore();
  }
});

test("attachment reservation and raw upload stay in the authenticated conversation API", async () => {
  const controller = new AbortController();
  const progress: { loaded_bytes: number; total_bytes: number }[] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "openslate_csrf=files-test" },
  });
  const mock = installFetch((input) =>
    String(input).endsWith("/content")
      ? Response.json(ready)
      : Response.json(file, {
          status: 201,
          headers: { Location: contentPath.replace("/content", "") },
        }),
  );
  try {
    await expect(
      api.reserveAttachment(context, conversationId, reservation, {
        signal: controller.signal,
      }),
    ).resolves.toEqual(file);
    const bytes = new Blob(["hello"], { type: "application/pdf" });
    await expect(
      api.uploadAttachment(context, conversationId, fileId, bytes, {
        signal: controller.signal,
        on_progress: (value) => progress.push(value),
      }),
    ).resolves.toEqual(ready);
    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      `/api/comms/conversations/${conversationId}/files`,
      contentPath,
    ]);
    expect(JSON.parse(String(mock.requests[0].init?.body))).toEqual(
      reservation,
    );
    expect(mock.requests[1].init?.body).toBe(bytes);
    expect(mock.requests[1].init?.method).toBe("PUT");
    expect(
      new Headers(mock.requests[1].init?.headers).get("Content-Type"),
    ).toBe("application/octet-stream");
    for (const { init } of mock.requests) {
      expect(new Headers(init?.headers).get("X-Org")).toBe(org);
      expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("files-test");
      expect(init?.credentials).toBe("same-origin");
      expect(init?.signal).toBe(controller.signal);
    }
    expect(progress).toEqual([
      { loaded_bytes: 0, total_bytes: 5 },
      { loaded_bytes: 5, total_bytes: 5 },
    ]);
  } finally {
    mock.restore();
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("attachment download returns bounded private bytes and a decoded safe filename, never a Storage URL", async () => {
  const signal = new AbortController().signal;
  const mock = installFetch(
    () => new Response("hello", { headers: downloadHeaders }),
  );
  try {
    const result = await api.downloadAttachment(
      context,
      conversationId,
      fileId,
      { signal },
    );
    expect(await result.bytes.text()).toBe("hello");
    expect(result.filename).toBe("résumé.pdf");
    expect(result.media_type).toBe("application/pdf");
    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      contentPath,
    ]);
    expect(mock.requests[0].init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      redirect: "error",
      signal,
    });
    expect(new Headers(mock.requests[0].init?.headers).get("X-Org")).toBe(org);
  } finally {
    mock.restore();
  }
});

test("attachment writes reject mismatched identity state status and oversize bytes", async () => {
  for (const row of [
    { wire: { ...file, creator_id: other }, status: 201, reserve: true },
    { wire: { ...file, expected_size: 6 }, status: 201, reserve: true },
    { wire: file, status: 200, reserve: true },
    { wire: { ...ready, id: other }, status: 200, reserve: false },
    { wire: { ...ready, org_id: other }, status: 200, reserve: false },
    { wire: { ...ready, actual_size: 6 }, status: 200, reserve: false },
    { wire: file, status: 200, reserve: false },
    { wire: ready, status: 201, reserve: false },
  ]) {
    const mock = installFetch(() =>
      Response.json(row.wire, {
        status: row.status,
        headers: { Location: contentPath.replace("/content", "") },
      }),
    );
    try {
      const result = row.reserve
        ? api.reserveAttachment(context, conversationId, reservation)
        : api.uploadAttachment(
            context,
            conversationId,
            fileId,
            new Blob(["hello"]),
          );
      await expect(result).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
  const mock = installFetch(() => Response.json(ready));
  try {
    await expect(
      api.uploadAttachment(
        context,
        conversationId,
        fileId,
        new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]),
      ),
    ).rejects.toThrow();
    await expect(
      api.uploadAttachment(context, conversationId, fileId, new Blob()),
    ).rejects.toThrow();
    await expect(
      api.reserveAttachment(context, conversationId, {
        ...reservation,
        filename: "../file.pdf",
      }),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("attachment downloads refuse unsafe headers length mismatch and overlong streams", async () => {
  const invalidHeaders: Record<string, string>[] = [
    {
      ...downloadHeaders,
      "Content-Disposition": "inline; filename*=UTF-8''file.pdf",
    },
    {
      ...downloadHeaders,
      "Content-Disposition": "attachment; filename*=UTF-8''..%2Ffile.pdf",
    },
    {
      ...downloadHeaders,
      "Content-Disposition": "attachment; filename*=UTF-8''%ZZ",
    },
    { ...downloadHeaders, "X-Content-Type-Options": "" },
    { ...downloadHeaders, "Cache-Control": "public" },
    { ...downloadHeaders, "Content-Type": "" },
    { ...downloadHeaders, "Content-Length": "4" },
    { ...downloadHeaders, "Content-Length": "6" },
    { ...downloadHeaders, "Content-Length": String(10 * 1024 * 1024 + 1) },
  ];
  for (const headers of invalidHeaders) {
    const mock = installFetch(() => new Response("hello", { headers }));
    try {
      await expect(
        api.downloadAttachment(context, conversationId, fileId),
      ).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const headers = new Headers(downloadHeaders);
  headers.delete("Content-Length");
  const mock = installFetch(() => new Response(stream, { headers }));
  try {
    await expect(
      api.downloadAttachment(context, conversationId, fileId),
    ).rejects.toBeInstanceOf(ApiContractError);
    expect(cancelled).toBe(true);
  } finally {
    mock.restore();
  }
});

test("file quota refusals and cancellation do not become completed progress or retries", async () => {
  const progress: number[] = [];
  for (const [status, code] of [
    [409, "file_uploads_full"],
    [503, "file_quota_busy"],
  ] as const) {
    const mock = installFetch(() =>
      Response.json({ detail: { code, message: "Try later" } }, { status }),
    );
    try {
      await expect(
        api.uploadAttachment(
          context,
          conversationId,
          fileId,
          new Blob(["hello"]),
          { on_progress: ({ loaded_bytes }) => progress.push(loaded_bytes) },
        ),
      ).rejects.toMatchObject({ status, code });
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  }
  expect(progress).toEqual([0, 0]);
  const error = new DOMException("Cancelled", "AbortError");
  const mock = installFetch(() => Promise.reject(error));
  try {
    await expect(
      api.downloadAttachment(context, conversationId, fileId),
    ).rejects.toBe(error);
  } finally {
    mock.restore();
  }
});

test("record-reference transport preserves current D23 unavailable projection and actual link identity", async () => {
  for (const wire of [available, unavailable]) {
    const mock = installFetch(() => Response.json(wire));
    try {
      await expect(
        api.getRecordReference(context, conversationId, other),
      ).resolves.toEqual(wire);
      expect(String(mock.requests[0].input)).toBe(
        `/api/comms/conversations/${conversationId}/record-references/${other}`,
      );
      expect(new Headers(mock.requests[0].init?.headers).get("X-Org")).toBe(
        org,
      );
    } finally {
      mock.restore();
    }
  }
  const linked = page([unavailable, { ...available, id: fileId }]);
  const listing = installFetch(() => Response.json(linked));
  try {
    await expect(api.listLinkedRecords(context)).resolves.toEqual(linked);
    const url = new URL(
      String(listing.requests[0].input),
      "http://test.invalid",
    );
    expect(url.pathname).toBe("/api/comms/record-references");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "25",
      offset: "0",
      sort_order: "asc",
      sort_by: "created_at",
    });
  } finally {
    listing.restore();
  }
  for (const wire of [
    { ...unavailable, title: "Hidden record" },
    { ...available, id: fileId },
  ]) {
    const mock = installFetch(() => Response.json(wire));
    try {
      await expect(
        api.getRecordReference(context, conversationId, other),
      ).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
});
