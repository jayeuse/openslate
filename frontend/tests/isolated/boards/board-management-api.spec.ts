import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  archiveBoard,
  createBoard,
  downloadBoardConfiguration,
  duplicateBoardStructure,
  importBoardConfiguration,
  listBoards,
  readBoard,
  readBoardGroups,
  replaceBoardGroups,
  restoreBoard,
  updateBoard,
} from "../../../src/components/systems/boards/adapters/board-management-api";

const boardId = "00000000-0000-4000-8000-000000000001";
const newBoardId = "00000000-0000-4000-8000-000000000002";
const departmentId = "00000000-0000-4000-8000-000000000003";
const groupId = "00000000-0000-4000-8000-000000000004";
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

const bundle = {
  kind: "openslate-board",
  version: 3,
  configuration: {
    name: "Dispatch",
    description: "Daily handoffs",
    widgets: [
      {
        name: "Requests",
        widget_type: "records",
        source: { department_name: "Operations", module_name: "Requests" },
        config: {
          fields: [{ name: "Label", expected_type: "text" }],
          filters: [
            {
              name: "Status",
              expected_type: "select",
              operator: "eq",
              value: "Open",
            },
          ],
          logic: "and",
          metric: null,
          visualization: "bar",
          size: "half",
          refresh: "manual",
          pinned: false,
        },
      },
    ],
  },
};

function boardResponse(id = newBoardId) {
  return {
    id,
    scope: "project",
    department_id: null,
    name: "Dispatch",
    description: "Daily handoffs",
    status: "active",
    revision: 1,
    level: "manage",
    created_at: timestamp,
    updated_at: timestamp,
  };
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

test("downloads exact validated v3 bytes and the fixed safe filename", async () => {
  const exactBytes = new TextEncoder().encode(JSON.stringify(bundle, null, 2));
  const mock = installFetch(
    () =>
      new Response(exactBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition":
            'attachment; filename="board-configuration.json"',
        },
      }),
  );
  try {
    const download = await downloadBoardConfiguration(boardId);
    expect(download.filename).toBe("board-configuration.json");
    expect(download.bundle).toEqual(bundle);
    expect(new Uint8Array(await download.blob.arrayBuffer())).toEqual(
      exactBytes,
    );
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/boards/${boardId}/configuration`,
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
    await expect(downloadBoardConfiguration("../other")).rejects.toThrow();
    expect(mock.requests).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("import sends validated bounded original JSON bytes as octet-stream", async () => {
  const mock = installFetch(() => jsonResponse(boardResponse(), 201));
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  try {
    const created = await importBoardConfiguration(
      new Blob([bytes], { type: "application/json" }),
    );
    expect(created.id).toBe(newBoardId);
    expect(created.scope).toBe("project");
    expect(String(mock.requests[0]?.input)).toBe("/api/boards/import");
    expect(mock.requests[0]?.init?.method).toBe("POST");
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
    expect(
      new Headers(mock.requests[0]?.init?.headers).get("Content-Type"),
    ).toBe("application/octet-stream");
    const sent = mock.requests[0]?.init?.body;
    expect(sent).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (sent as Blob).arrayBuffer())).toEqual(bytes);

    await expect(
      importBoardConfiguration(new Blob([" ".repeat(1024 * 1024 + 1)])),
    ).rejects.toThrow();
    await expect(
      importBoardConfiguration(
        new Blob([JSON.stringify({ ...bundle, version: 2 })]),
      ),
    ).rejects.toThrow();
    await expect(
      importBoardConfiguration(
        new Blob([
          JSON.stringify({
            ...bundle,
            configuration: {
              ...bundle.configuration,
              default_section: "overview",
            },
          }),
        ]),
      ),
    ).rejects.toThrow();
    await expect(
      importBoardConfiguration(
        new Blob([
          JSON.stringify(bundle).replace(
            '"version":3',
            '"version":3,"version":3',
          ),
        ]),
      ),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

for (const token of ["3.0", "3e0"])
  test(`import rejects version token ${token} before upload`, async () => {
    const mock = installFetch(() => jsonResponse(boardResponse(), 201));
    try {
      const raw = JSON.stringify(bundle).replace(
        '"version":3',
        `"version":${token}`,
      );
      await expect(importBoardConfiguration(new Blob([raw]))).rejects.toThrow();
      expect(mock.requests).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

test("duplicate accepts a fresh project Board DTO and rejects identity reuse", async () => {
  const mock = installFetch(() => jsonResponse(boardResponse(), 201));
  try {
    const copied = await duplicateBoardStructure(boardId);
    expect(copied.id).toBe(newBoardId);
    expect(copied.status).toBe("active");
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/boards/${boardId}/duplicate`,
    );
    expect(mock.requests[0]?.init?.method).toBe("POST");
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
  const reused = installFetch(() => jsonResponse(boardResponse(boardId), 201));
  try {
    await expect(duplicateBoardStructure(boardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    reused.restore();
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

test("configuration downloads reject audience fields and duplicate keys", async () => {
  const exportMock = installFetch(
    () =>
      new Response(
        JSON.stringify({
          ...bundle,
          configuration: {
            ...bundle.configuration,
            widgets: [
              {
                ...bundle.configuration.widgets[0],
                audience: { kind: "everyone" },
              },
            ],
          },
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition":
              'attachment; filename="board-configuration.json"',
          },
        },
      ),
  );
  try {
    await expect(downloadBoardConfiguration(boardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    exportMock.restore();
  }

  const duplicateKeys = installFetch(
    () =>
      new Response(
        JSON.stringify(bundle).replace(
          '"version":3',
          '"version":3,"version":3',
        ),
        {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition":
              'attachment; filename="board-configuration.json"',
          },
        },
      ),
  );
  try {
    await expect(downloadBoardConfiguration(boardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    duplicateKeys.restore();
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
    await expect(downloadBoardConfiguration(boardId)).rejects.toMatchObject({
      status: 500,
      message: "Request could not be completed",
    });
  } finally {
    rawMock.restore();
  }
});
