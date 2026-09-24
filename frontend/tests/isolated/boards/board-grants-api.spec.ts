import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  createBoardGrant,
  listBoardGrantRoles,
  listBoardGrants,
  revokeBoardGrant,
} from "../../../src/components/systems/boards/adapters/board-grants-api";

const boardId = "00000000-0000-4000-8000-000000000001";
const grantId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const grant = {
  id: grantId,
  principal_type: "user",
  principal_user_id: userId,
  principal_role_id: null,
  principal_label: "Avery",
  principal_available: true,
  permission: "edit",
  effect: "allow",
  created_at: "2026-09-23T00:00:00Z",
  updated_at: "2026-09-23T00:00:00Z",
};
const page = { limit: 25, offset: 0, count: 1, total: 1, has_more: false };

function installFetch(responder: () => Response) {
  const original = globalThis.fetch;
  const requests: { path: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ path: String(input), init: init ?? {} });
    return responder();
  }) as typeof fetch;
  return { requests, restore: () => (globalThis.fetch = original) };
}

test("Board grants list validates a page and preserves the Board revision", async () => {
  const fetch = installFetch(() =>
    Response.json({ items: [grant], pagination: page, board_revision: 4 }),
  );
  try {
    await expect(listBoardGrants(boardId)).resolves.toEqual({
      items: [
        {
          id: grantId,
          principalType: "user",
          principalUserId: userId,
          principalRoleId: null,
          principalLabel: "Avery",
          principalAvailable: true,
          permission: "edit",
          effect: "allow",
          createdAt: grant.created_at,
          updatedAt: grant.updated_at,
        },
      ],
      pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
      boardRevision: 4,
    });
    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0].path).toBe(
      `/api/boards/${boardId}/grants?limit=25&offset=0&sort_by=principal_type&sort_order=asc`,
    );
    expect(fetch.requests[0].init.cache).toBe("no-store");
  } finally {
    fetch.restore();
  }
});

test("Board grant role choices use the manager-only Board endpoint and reject extra identity data", async () => {
  const roleId = "00000000-0000-4000-8000-000000000004";
  const fetch = installFetch(() =>
    Response.json({
      items: [{ id: roleId, role: "Coordinator" }],
      pagination: page,
    }),
  );
  try {
    await expect(
      listBoardGrantRoles(boardId, { search: "Coord", limit: 25 }),
    ).resolves.toMatchObject({ items: [{ id: roleId, role: "Coordinator" }] });
    expect(fetch.requests[0].path).toBe(
      `/api/boards/${boardId}/grant-roles?limit=25&offset=0&sort_by=role&sort_order=asc&search=Coord`,
    );
    expect(fetch.requests[0].init.cache).toBe("no-store");
  } finally {
    fetch.restore();
  }
  const invalid = installFetch(() =>
    Response.json({
      items: [
        { id: roleId, role: "Coordinator", email: "private@example.invalid" },
      ],
      pagination: page,
    }),
  );
  try {
    await expect(listBoardGrantRoles(boardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    invalid.restore();
  }
});

test("Board grants create sends only a matching principal and revision", async () => {
  const fetch = installFetch(() =>
    Response.json({ grant, board_revision: 5 }, { status: 201 }),
  );
  try {
    await expect(
      createBoardGrant(boardId, {
        revision: 4,
        principalType: "user",
        principalUserId: userId,
        permission: "edit",
        effect: "allow",
      }),
    ).resolves.toMatchObject({
      grant: { id: grantId, principalType: "user", principalUserId: userId },
      boardRevision: 5,
    });
    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0].path).toBe(`/api/boards/${boardId}/grants`);
    expect(fetch.requests[0].init.method).toBe("POST");
    expect(fetch.requests[0].init.cache).toBe("no-store");
    expect(JSON.parse(String(fetch.requests[0].init.body))).toEqual({
      revision: 4,
      principal_type: "user",
      principal_user_id: userId,
      permission: "edit",
      effect: "allow",
    });
  } finally {
    fetch.restore();
  }
});

test("Board grants create rejects a successful response for a different grant decision", async () => {
  const fetch = installFetch(() =>
    Response.json(
      { grant: { ...grant, effect: "deny" }, board_revision: 5 },
      { status: 201 },
    ),
  );
  try {
    await expect(
      createBoardGrant(boardId, {
        revision: 4,
        principalType: "user",
        principalUserId: userId,
        permission: "edit",
        effect: "allow",
      }),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    fetch.restore();
  }
});

test("Board grants revoke sends revision and accepts the 204 empty response", async () => {
  const fetch = installFetch(() => new Response(null, { status: 204 }));
  try {
    await expect(
      revokeBoardGrant(boardId, grantId, 5),
    ).resolves.toBeUndefined();
    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0].path).toBe(
      `/api/boards/${boardId}/grants/${grantId}?revision=5`,
    );
    expect(fetch.requests[0].init.method).toBe("DELETE");
    expect(fetch.requests[0].init.cache).toBe("no-store");
  } finally {
    fetch.restore();
  }
});

test("Board grants reject malformed IDs, principal shapes, and page options before fetch", async () => {
  const fetch = installFetch(() => Response.json({}));
  try {
    await expect(listBoardGrants("../other")).rejects.toThrow();
    await expect(
      listBoardGrants(boardId, { search: "Avery" } as never),
    ).rejects.toThrow();
    await expect(
      listBoardGrants(boardId, { sortBy: "id" } as never),
    ).rejects.toThrow();
    await expect(
      createBoardGrant(boardId, {
        revision: 1,
        principalType: "everyone",
        principalUserId: userId,
        permission: "view",
        effect: "allow",
      } as never),
    ).rejects.toThrow();
    await expect(
      createBoardGrant(boardId, {
        revision: 0,
        principalType: "user",
        principalUserId: userId,
        permission: "edit",
        effect: "allow",
      }),
    ).rejects.toThrow();
    await expect(revokeBoardGrant(boardId, "../other", 1)).rejects.toThrow();
    await expect(revokeBoardGrant(boardId, grantId, 0)).rejects.toThrow();
    expect(fetch.requests).toHaveLength(0);
  } finally {
    fetch.restore();
  }
});

test("Board grants fail closed on mismatched principal, extra fields, and invalid revisions", async () => {
  const cases = [
    {
      items: [{ ...grant, principal_role_id: userId }],
      pagination: page,
      board_revision: 4,
    },
    {
      items: [grant, grant],
      pagination: { ...page, count: 2, total: 2 },
      board_revision: 4,
    },
    {
      items: [{ ...grant, email: "private@example.invalid" }],
      pagination: page,
      board_revision: 4,
    },
    { items: [grant], pagination: page, board_revision: 0 },
    {
      items: [{ ...grant, principal_label: "" }],
      pagination: page,
      board_revision: 4,
    },
    {
      items: [
        {
          ...grant,
          principal_label: "Former name",
          principal_available: false,
        },
      ],
      pagination: page,
      board_revision: 4,
    },
    { items: [grant], pagination: { ...page, count: 0 }, board_revision: 4 },
  ];
  for (const body of cases) {
    const fetch = installFetch(() => Response.json(body));
    try {
      await expect(listBoardGrants(boardId)).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      fetch.restore();
    }
  }
});

test("Board grants retain only a safe conflict code and validated current revision", async () => {
  const fetch = installFetch(() =>
    Response.json(
      {
        detail: {
          code: "stale_revision",
          message: "private server text",
          current_revision: 6,
          secret: "do not surface",
        },
      },
      { status: 409 },
    ),
  );
  try {
    await expect(revokeBoardGrant(boardId, grantId, 5)).rejects.toMatchObject({
      status: 409,
      code: "stale_revision",
      message: "Board changed; reload before saving",
      details: {
        code: "stale_revision",
        message: "Board changed; reload before saving",
        current_revision: 6,
      },
    });
  } finally {
    fetch.restore();
  }
});

test("Board grants mask unknown server errors and keep hidden Boards as 404", async () => {
  const denied = installFetch(() =>
    Response.json({ detail: "Board not found" }, { status: 404 }),
  );
  try {
    await expect(listBoardGrants(boardId)).rejects.toMatchObject({
      status: 404,
      message: "Board not found",
    });
  } finally {
    denied.restore();
  }
  const unknown = installFetch(() =>
    Response.json({ detail: "private server text" }, { status: 403 }),
  );
  try {
    await expect(listBoardGrants(boardId)).rejects.toMatchObject({
      status: 403,
      message: "Request could not be completed",
    });
    await expect(listBoardGrants(boardId)).rejects.toBeInstanceOf(ApiError);
  } finally {
    unknown.restore();
  }

  const inheritedCode = installFetch(() =>
    Response.json({ detail: { code: "constructor" } }, { status: 409 }),
  );
  try {
    await expect(listBoardGrants(boardId)).rejects.toMatchObject({
      status: 409,
      message: "Request could not be completed",
    });
  } finally {
    inheritedCode.restore();
  }
});
