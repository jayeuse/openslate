import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  createBoardPlacement,
  deleteBoardPlacement,
  listBoardPlacements,
} from "../../../src/components/systems/boards/adapters/board-placements-api";

const boardId = "00000000-0000-4000-8000-000000000001";
const placementId = "00000000-0000-4000-8000-000000000002";
const recordId = "00000000-0000-4000-8000-000000000003";
const moduleId = "00000000-0000-4000-8000-000000000004";
const timestamp = "2026-09-23T00:00:00Z";

type CapturedRequest = { input: RequestInfo | URL; init?: RequestInit };

function installFetch(responder: () => Response) {
  const original = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return Promise.resolve(responder());
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function placementResponse(available = true) {
  return {
    id: placementId,
    board_id: boardId,
    record_id: recordId,
    module_id: available ? moduleId : null,
    available,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

test("Board placement list preserves page scope, board revision, and unavailable shortcuts", async () => {
  const mock = installFetch(() =>
    jsonResponse({
      items: [placementResponse(false)],
      pagination: { limit: 1, offset: 0, count: 1, total: 1, has_more: false },
      board_revision: 7,
    }),
  );
  try {
    const page = await listBoardPlacements(boardId, {
      limit: 1,
      sortBy: "updated_at",
      sortOrder: "desc",
    });
    expect(page.items).toEqual([
      {
        id: placementId,
        boardId,
        recordId,
        moduleId: null,
        available: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]);
    expect(page.pagination).toEqual({
      limit: 1,
      offset: 0,
      count: 1,
      total: 1,
      hasMore: false,
    });
    expect(page.boardRevision).toBe(7);
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/boards/${boardId}/placements?limit=1&offset=0&sort_by=updated_at&sort_order=desc`,
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("Board placement create and delete use only record and Board revision inputs", async () => {
  const responses = [
    jsonResponse({ placement: placementResponse(), board_revision: 2 }, 201),
    new Response(null, { status: 204 }),
  ];
  const mock = installFetch(() => responses.shift()!);
  try {
    const created = await createBoardPlacement(boardId, 1, recordId);
    expect(created).toMatchObject({
      placement: {
        id: placementId,
        boardId,
        recordId,
        moduleId,
        available: true,
      },
      boardRevision: 2,
    });
    await expect(
      deleteBoardPlacement(boardId, placementId, 2),
    ).resolves.toBeUndefined();
    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      [`/api/boards/${boardId}/placements`, "POST"],
      [`/api/boards/${boardId}/placements/${placementId}?revision=2`, "DELETE"],
    ]);
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      revision: 1,
      record_id: recordId,
    });
    expect(mock.requests.every(({ init }) => init?.cache === "no-store")).toBe(
      true,
    );
  } finally {
    mock.restore();
  }
});

test("Board placement inputs reject invalid IDs, revisions, and unsupported list filters", async () => {
  const mock = installFetch(() =>
    jsonResponse({ placement: placementResponse(), board_revision: 2 }),
  );
  try {
    await expect(listBoardPlacements("../other")).rejects.toThrow();
    await expect(
      listBoardPlacements(boardId, { search: "private" } as never),
    ).rejects.toThrow();
    await expect(
      listBoardPlacements(boardId, { deleted: "include" } as never),
    ).rejects.toThrow();
    await expect(
      listBoardPlacements(boardId, { limit: 101 }),
    ).rejects.toThrow();
    await expect(createBoardPlacement(boardId, 0, recordId)).rejects.toThrow();
    await expect(
      createBoardPlacement(boardId, 1, "not-a-uuid"),
    ).rejects.toThrow();
    await expect(
      deleteBoardPlacement(boardId, placementId, 0),
    ).rejects.toThrow();
    await expect(
      deleteBoardPlacement(boardId, "../other", 1),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("Board placement responses reject extra fields, foreign Board IDs, and contradictory availability", async () => {
  const extra = installFetch(() =>
    jsonResponse({
      items: [{ ...placementResponse(), private_record: { label: "secret" } }],
      pagination: { limit: 25, offset: 0, count: 1, total: 1, has_more: false },
      board_revision: 1,
    }),
  );
  try {
    await expect(listBoardPlacements(boardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    extra.restore();
  }
  const foreign = installFetch(() =>
    jsonResponse(
      {
        placement: { ...placementResponse(), board_id: moduleId },
        board_revision: 2,
      },
      201,
    ),
  );
  try {
    await expect(
      createBoardPlacement(boardId, 1, recordId),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    foreign.restore();
  }
  const contradictory = installFetch(() =>
    jsonResponse(
      {
        placement: { ...placementResponse(), module_id: null },
        board_revision: 2,
      },
      201,
    ),
  );
  try {
    await expect(
      createBoardPlacement(boardId, 1, recordId),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    contradictory.restore();
  }
});

test("Board placement errors expose safe codes but not source or ACL details", async () => {
  const secret = "private record name and raw SQL";
  const conflict = installFetch(() =>
    jsonResponse(
      {
        detail: {
          code: "placement_exists",
          message: secret,
          record_name: secret,
        },
      },
      409,
    ),
  );
  try {
    const error = await createBoardPlacement(boardId, 1, recordId).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "placement_exists",
      message: "This record is already linked to the Board",
    });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain("record_name");
  } finally {
    conflict.restore();
  }
  const missing = installFetch(() =>
    jsonResponse({ detail: "Board placement not found" }, 404),
  );
  try {
    await expect(
      deleteBoardPlacement(boardId, placementId, 1),
    ).rejects.toMatchObject({
      status: 404,
      message: "Board placement not found",
    });
  } finally {
    missing.restore();
  }
  const denied = installFetch(() => jsonResponse({ detail: secret }, 403));
  try {
    await expect(listBoardPlacements(boardId)).rejects.toMatchObject({
      status: 403,
      message: "Request could not be completed",
    });
  } finally {
    denied.restore();
  }
});
