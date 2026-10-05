import { expect, test } from "@playwright/test";
import { ApiContractError } from "../../../src/lib/api";
import {
  attachBoardFile,
  detachBoardFile,
  downloadBoardAttachment,
  listBoardAttachments,
  reserveBoardFile,
  uploadBoardFile,
  type BoardAttachmentTarget,
} from "../../../src/components/systems/boards/adapters/board-files-api";

const boardId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";
const postId = "00000000-0000-4000-8000-000000000003";
const fileId = "00000000-0000-4000-8000-000000000004";
const actorId = "00000000-0000-4000-8000-000000000005";
const timestamp = "2026-09-24T00:00:00Z";

const readyFile = {
  id: fileId,
  purpose: "board_attachment",
  record_id: null,
  board_id: boardId,
  creator_id: actorId,
  filename: "building-map.pdf",
  media_type: "application/pdf",
  expected_size: 5,
  actual_size: 5,
  state: "ready",
  failure_code: null,
  is_deleted: false,
  created_at: timestamp,
  updated_at: timestamp,
};

type CapturedRequest = { input: RequestInfo | URL; init?: RequestInit };

function installFetch(responder: (request: CapturedRequest) => Response) {
  const original = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = { input, init };
    requests.push(request);
    return Promise.resolve(responder(request));
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function path(request: CapturedRequest): string {
  return String(request.input);
}

function init(request: CapturedRequest): RequestInit {
  return request.init ?? {};
}

function fileList(items: unknown[]) {
  return {
    items,
    limit: 25,
    offset: 0,
    has_more: false,
  };
}

test("Board attachment upload stays on authenticated Board-scoped binary routes", async () => {
  const mock = installFetch((request) =>
    Response.json(
      path(request).endsWith("/content")
        ? readyFile
        : { ...readyFile, state: "awaiting_upload", actual_size: null },
    ),
  );
  try {
    const reserved = await reserveBoardFile(boardId, {
      filename: readyFile.filename,
      expectedSize: readyFile.expected_size,
    });
    expect(reserved).toMatchObject({
      id: fileId,
      boardId,
      state: "awaiting_upload",
      filename: readyFile.filename,
    });

    const bytes = new Blob(["hello"], { type: "application/pdf" });
    const uploaded = await uploadBoardFile(boardId, fileId, bytes);

    expect(uploaded).toMatchObject({
      id: fileId,
      boardId,
      state: "ready",
      actualSize: 5,
    });
    expect(mock.requests.map(path)).toEqual([
      `/api/boards/${boardId}/files`,
      `/api/boards/${boardId}/files/${fileId}/content`,
    ]);
    const reservation = init(mock.requests[0]!);
    expect(reservation.method).toBe("POST");
    expect(JSON.parse(String(reservation.body))).toEqual({
      filename: readyFile.filename,
      expected_size: 5,
    });
    const upload = init(mock.requests[1]!);
    expect(upload.method).toBe("PUT");
    expect(upload.credentials).toBe("same-origin");
    expect(new Headers(upload.headers).get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect(upload.body).toBe(bytes);
    expect(
      mock.requests.every((request) => !path(request).includes("/api/files/")),
    ).toBe(true);
  } finally {
    mock.restore();
  }
});

test("attachment listing and content download retain Event and Post scope", async () => {
  const targets: BoardAttachmentTarget[] = [
    { kind: "event", boardId, contentId: eventId },
    {
      kind: "post",
      boardId,
      contentId: postId,
      view: "published",
    },
    {
      kind: "post",
      boardId,
      contentId: postId,
      view: "draft",
    },
  ];
  const mock = installFetch((request) => {
    if (path(request).includes("/content"))
      return new Response("hello", {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition":
            "attachment; filename*=UTF-8''building-map.pdf",
          "X-Content-Type-Options": "nosniff",
          "Content-Length": "5",
        },
      });
    return Response.json(fileList([readyFile]));
  });
  try {
    for (const target of targets) {
      const listed = await listBoardAttachments(target);
      expect(listed.items[0]).toMatchObject({
        id: fileId,
        boardId,
        state: "ready",
      });
    }
    const downloaded = await downloadBoardAttachment(targets[1]!, fileId, 5);
    expect(await downloaded.text()).toBe("hello");
    expect(mock.requests.map(path)).toEqual([
      `/api/boards/${boardId}/events/${eventId}/attachments?limit=25&offset=0`,
      `/api/boards/${boardId}/posts/${postId}/attachments?view=published&limit=25&offset=0`,
      `/api/boards/${boardId}/posts/${postId}/attachments?view=draft&limit=25&offset=0`,
      `/api/boards/${boardId}/posts/${postId}/attachments/${fileId}/content?view=published`,
    ]);
    expect(
      mock.requests.every(
        (request) => init(request).credentials === "same-origin",
      ),
    ).toBe(true);
  } finally {
    mock.restore();
  }
});

test("attachment mutations send the current dual revisions and preserve 409 conflicts", async () => {
  const target: BoardAttachmentTarget = {
    kind: "event",
    boardId,
    contentId: eventId,
  };
  const mock = installFetch((request) =>
    init(request).method === "DELETE"
      ? Response.json(
          { detail: "Board content changed; reload before attaching" },
          { status: 409 },
        )
      : Response.json(readyFile),
  );
  try {
    await attachBoardFile(target, fileId, {
      boardRevision: 8,
      contentRevision: 4,
    });
    await expect(
      detachBoardFile(target, fileId, {
        boardRevision: 8,
        contentRevision: 4,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mock.requests.map(path)).toEqual([
      `/api/boards/${boardId}/events/${eventId}/attachments`,
      `/api/boards/${boardId}/events/${eventId}/attachments/${fileId}`,
    ]);
    expect(JSON.parse(String(init(mock.requests[0]!).body))).toEqual({
      file_id: fileId,
      board_revision: 8,
      content_revision: 4,
    });
    expect(JSON.parse(String(init(mock.requests[1]!).body))).toEqual({
      board_revision: 8,
      content_revision: 4,
    });
    expect(init(mock.requests[1]!).method).toBe("DELETE");
  } finally {
    mock.restore();
  }
});

test("file adapter rejects another Board's metadata and oversized content responses", async () => {
  const bytes = new Blob(["hello"], { type: "application/pdf" });
  for (const response of [
    { ...readyFile, board_id: eventId },
    { ...readyFile, board_id: null },
    { ...readyFile, purpose: "record_attachment" },
    { ...readyFile, record_id: eventId },
    { ...readyFile, is_deleted: true },
    { ...readyFile, id: eventId },
    { ...readyFile, state: "archived" },
  ]) {
    const wrongFile = installFetch(() => Response.json(response));
    try {
      await expect(
        uploadBoardFile(boardId, fileId, bytes),
      ).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      wrongFile.restore();
    }
  }

  for (const declaredLength of ["6", null]) {
    const headers = new Headers({
      "Content-Type": "application/pdf",
      "Content-Disposition": "attachment; filename*=UTF-8''building-map.pdf",
      "X-Content-Type-Options": "nosniff",
    });
    if (declaredLength !== null) headers.set("Content-Length", declaredLength);
    const oversized = installFetch(
      () => new Response(new Uint8Array(6), { headers }),
    );
    try {
      await expect(
        downloadBoardAttachment(
          { kind: "event", boardId, contentId: eventId },
          fileId,
          5,
        ),
      ).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      oversized.restore();
    }
  }
});
