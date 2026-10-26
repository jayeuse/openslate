import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  archiveBoard,
  createBoard,
  listBoards,
  previewBoardPurge,
  readBoard,
  readBoardGroups,
  replaceBoardGroups,
  restoreBoard,
  updateBoard,
} from "../../../src/components/systems/boards/adapters/board-management-api";
import { wireBoard } from "../../helpers/wire";
import { installNoArgumentFetch as installFetch } from "../helpers/fake-fetch";

const boardId = "00000000-0000-4000-8000-000000000001";
const newBoardId = "00000000-0000-4000-8000-000000000002";
const departmentId = "00000000-0000-4000-8000-000000000003";
const groupId = "00000000-0000-4000-8000-000000000004";
const timestamp = "2026-09-23T00:00:00Z";

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function boardResponse(id = newBoardId) {
  return wireBoard({
    id,
    name: "Dispatch",
    description: "Daily handoffs",
    level: "manage",
    created_at: timestamp,
    updated_at: timestamp,
  });
}

test("Board collection sends bounded filters and returns a validated page", async () => {
  const mock = installFetch(() =>
    jsonResponse({
      items: [
        {
          ...boardResponse(boardId),
          scope: "department",
          department_id: departmentId,
          status: "archived",
          level: "read",
        },
      ],
      pagination: {
        limit: 10,
        offset: 20,
        count: 1,
        total: 25,
        has_more: true,
      },
    }),
  );
  try {
    const page = await listBoards({
      limit: 10,
      offset: 20,
      sortBy: "updated_at",
      sortOrder: "desc",
      search: "  Dispatch  ",
      status: "archived",
      scope: "department",
      departmentId,
    });
    expect(page.items[0]).toMatchObject({
      id: boardId,
      scope: "department",
      departmentId,
      level: "read",
    });
    expect(page.pagination).toEqual({
      limit: 10,
      offset: 20,
      count: 1,
      total: 25,
      hasMore: true,
    });
    const requestUrl = new URL(
      String(mock.requests[0]?.input),
      "http://localhost",
    );
    expect(requestUrl.pathname).toBe("/api/boards");
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
      limit: "10",
      offset: "20",
      sort_by: "updated_at",
      sort_order: "desc",
      status: "archived",
      scope: "department",
      search: "Dispatch",
      department_id: departmentId,
    });
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("Board create, read, revisioned update, archive and restore use server IDs and DTOs", async () => {
  const responses = [
    jsonResponse(boardResponse(), 201),
    jsonResponse(boardResponse()),
    jsonResponse({ ...boardResponse(), revision: 2, description: null }),
    jsonResponse({ ...boardResponse(), revision: 3, status: "archived" }),
    jsonResponse({ ...boardResponse(), revision: 4 }),
  ];
  const mock = installFetch(() => responses.shift()!);
  try {
    await expect(
      createBoard({
        name: "  Dispatch  ",
        description: "  Handoffs  ",
      }),
    ).resolves.toMatchObject({ id: newBoardId, scope: "project" });
    await expect(readBoard(newBoardId)).resolves.toMatchObject({
      id: newBoardId,
      revision: 1,
    });
    await expect(
      updateBoard(newBoardId, { revision: 1, description: null }),
    ).resolves.toMatchObject({ revision: 2, description: null });
    await expect(archiveBoard(newBoardId, 2)).resolves.toMatchObject({
      revision: 3,
      status: "archived",
    });
    await expect(restoreBoard(newBoardId, 3)).resolves.toMatchObject({
      revision: 4,
      status: "active",
    });
    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      ["/api/boards", "POST"],
      [`/api/boards/${newBoardId}`, undefined],
      [`/api/boards/${newBoardId}`, "PATCH"],
      [`/api/boards/${newBoardId}/archive`, "POST"],
      [`/api/boards/${newBoardId}/restore`, "POST"],
    ]);
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      name: "Dispatch",
      description: "Handoffs",
    });
    expect(JSON.parse(String(mock.requests[2]?.init?.body))).toEqual({
      revision: 1,
      description: null,
    });
    expect(JSON.parse(String(mock.requests[3]?.init?.body))).toEqual({
      revision: 2,
    });
    expect(JSON.parse(String(mock.requests[4]?.init?.body))).toEqual({
      revision: 3,
    });
    expect(mock.requests.every(({ init }) => init?.cache === "no-store")).toBe(
      true,
    );
  } finally {
    mock.restore();
  }
});

test("Board lifecycle rejects invalid filters and mass-assignment inputs before fetch", async () => {
  const mock = installFetch(() => jsonResponse(boardResponse()));
  try {
    await expect(listBoards({ status: "deleted" } as never)).rejects.toThrow();
    await expect(listBoards({ deleted: "include" } as never)).rejects.toThrow();
    await expect(listBoards({ limit: 101 })).rejects.toThrow();
    await expect(createBoard({ name: " " })).rejects.toThrow();
    for (const extra of [
      { departmentId },
      { defaultSection: "posts" },
      { scope: "company" },
    ])
      await expect(
        createBoard({ name: "Dispatch", ...extra } as never),
      ).rejects.toThrow();
    await expect(updateBoard(boardId, { revision: 1 })).rejects.toThrow();
    await expect(
      updateBoard(boardId, { revision: 1, name: null } as never),
    ).rejects.toThrow();
    await expect(archiveBoard(boardId, 0)).rejects.toThrow();
    await expect(readBoard("../other")).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("Board purge maps lifecycle denial and confirmation errors to their actual statuses", async () => {
  for (const { code, status, message } of [
    {
      code: "purge_disabled",
      status: 403,
      message: "Permanent delete is turned off for this installation.",
    },
    {
      code: "confirmation_name_mismatch",
      status: 422,
      message: "The Board name confirmation did not match",
    },
    {
      code: "challenge_not_found",
      status: 404,
      message: "The review is unavailable; get a new review",
    },
    {
      code: "challenge_binding_mismatch",
      status: 403,
      message: "The review is unavailable; get a new review",
    },
  ]) {
    const mock = installFetch(() =>
      jsonResponse({ detail: { code, message: "untrusted detail" } }, status),
    );
    try {
      await expect(previewBoardPurge(boardId)).rejects.toMatchObject({
        status,
        code,
        message,
      });
    } finally {
      mock.restore();
    }
  }
});

test("Board lifecycle rejects private DTO fields and redacts conflict details", async () => {
  const privateList = installFetch(() =>
    jsonResponse({
      items: [{ ...boardResponse(), owner_id: departmentId }],
      pagination: { limit: 25, offset: 0, count: 1, total: 1, has_more: false },
    }),
  );
  try {
    await expect(listBoards()).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    privateList.restore();
  }
  const privateDto = installFetch(() =>
    jsonResponse({ ...boardResponse(), owner_id: departmentId }),
  );
  try {
    await expect(readBoard(newBoardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    privateDto.restore();
  }
  const mismatchedId = installFetch(() => jsonResponse(boardResponse(boardId)));
  try {
    await expect(readBoard(newBoardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mismatchedId.restore();
  }
  const secret = "raw SQL and private audience";
  const conflict = installFetch(() =>
    jsonResponse(
      {
        detail: {
          code: "stale_revision",
          message: secret,
          current_revision: 7,
        },
      },
      409,
    ),
  );
  try {
    await expect(
      updateBoard(newBoardId, { revision: 1, name: "Updated" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "stale_revision",
      message: "Board changed; reload before saving",
    });
    const archivedError = await archiveBoard(newBoardId, 1).then(
      () => null,
      (error: unknown) => error,
    );
    expect(archivedError).toBeInstanceOf(ApiError);
    expect(JSON.stringify(archivedError)).not.toContain(secret);
    expect(JSON.stringify(archivedError)).not.toContain("current_revision");
  } finally {
    conflict.restore();
  }
  const denied = installFetch(() =>
    jsonResponse({ detail: "private ACL and user record" }, 403),
  );
  try {
    await expect(readBoard(newBoardId)).rejects.toMatchObject({
      status: 403,
      message: "Request could not be completed",
    });
  } finally {
    denied.restore();
  }
  const missing = installFetch(() =>
    jsonResponse({ detail: "Board not found" }, 404),
  );
  try {
    await expect(readBoard(newBoardId)).rejects.toMatchObject({
      status: 404,
      message: "Board not found",
    });
  } finally {
    missing.restore();
  }
});

test("project Board groups are read and replaced with the Board revision", async () => {
  const groups = {
    board_id: boardId,
    revision: 5,
    groups: [{ group_id: groupId, name: "Field crew", level: "write" }],
  };
  const responses = [
    jsonResponse(groups),
    jsonResponse({ ...groups, revision: 6, groups: [] }),
  ];
  const mock = installFetch(() => responses.shift()!);
  try {
    await expect(readBoardGroups(boardId)).resolves.toEqual({
      boardId,
      revision: 5,
      groups: [{ groupId, name: "Field crew", level: "write" }],
    });
    await expect(
      replaceBoardGroups(boardId, { revision: 5, groups: [] }),
    ).resolves.toMatchObject({ revision: 6, groups: [] });
    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      [`/api/boards/${boardId}/groups`, undefined],
      [`/api/boards/${boardId}/groups`, "PUT"],
    ]);
    expect(JSON.parse(String(mock.requests[1]?.init?.body))).toEqual({
      revision: 5,
      groups: [],
    });
    await expect(
      replaceBoardGroups(boardId, {
        revision: 5,
        groups: [
          { groupId, level: "read" },
          { groupId, level: "write" },
        ],
      }),
    ).rejects.toThrow();
    await expect(
      replaceBoardGroups(boardId, {
        revision: 5,
        groups: [{ groupId, level: "admin" as never }],
      }),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(2);
  } finally {
    mock.restore();
  }
  const foreign = installFetch(() =>
    jsonResponse({ board_id: newBoardId, revision: 1, groups: [] }),
  );
  try {
    await expect(readBoardGroups(boardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    foreign.restore();
  }
});

test("all Board management errors discard untrusted server detail", async () => {
  const secret = "raw SQL and private audience";
  const jsonMock = installFetch(() =>
    jsonResponse(
      {
        detail: { code: "board_name_fixed", message: secret, debug: secret },
      },
      409,
    ),
  );
  try {
    const error = await updateBoard(boardId, {
      revision: 1,
      name: "Renamed",
    }).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "board_name_fixed" });
    expect(JSON.stringify(error)).not.toContain(secret);
  } finally {
    jsonMock.restore();
  }

  const rawMock = installFetch(() => jsonResponse({ detail: secret }, 500));
  try {
    await expect(readBoard(boardId)).rejects.toMatchObject({
      status: 500,
      message: "Request could not be completed",
    });
  } finally {
    rawMock.restore();
  }
});
