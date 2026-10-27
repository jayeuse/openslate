import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  getBoardAccessPreview,
  getMyBoardAccess,
  listBoardActivity,
  listBoardPreviewUsers,
} from "../../../src/components/systems/boards/adapters/board-tools-api";

const boardId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const activityId = "00000000-0000-4000-8000-000000000003";

function installFetch(responder: () => Response) {
  const original = globalThis.fetch;
  const paths: string[] = [];
  const requests: RequestInit[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    paths.push(String(input));
    requests.push(init ?? {});
    return responder();
  }) as typeof fetch;
  return {
    paths,
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

const page = { limit: 25, offset: 0, count: 1, total: 1, has_more: false };
const activity = {
  id: activityId,
  created_at: "2026-09-23T00:00:00Z",
  kind: "board",
  action: "create",
  summary: "Board created",
  actor_label: "Avery",
  group: null,
};
const groupActivityId = "00000000-0000-4000-8000-000000000004";
const groupActivity = {
  id: groupActivityId,
  created_at: "2026-09-24T00:00:00Z",
  kind: "group",
  action: "update",
  summary: "Board groups changed",
  actor_label: "Avery",
  group: { name: "Internal Audit", level: "write", previous_level: "read" },
};

test("my Board access reads the actor's level and its flags", async () => {
  const fetch = installFetch(() =>
    jsonResponse({ level: "manage", read: true, write: true, manage: true }),
  );
  try {
    await expect(getMyBoardAccess(boardId)).resolves.toEqual({
      level: "manage",
      view: true,
      edit: true,
      manage: true,
    });
    expect(fetch.paths).toEqual([`/api/boards/${boardId}/my-access`]);
    expect(fetch.requests[0].cache).toBe("no-store");
    await expect(getMyBoardAccess("../other")).rejects.toThrow();
    expect(fetch.paths).toHaveLength(1);
  } finally {
    fetch.restore();
  }
});

test("my Board access rejects malformed or expanded permission payloads", async () => {
  for (const payload of [
    { level: null, read: false, write: false, manage: false },
    { level: "read", read: true, write: "yes", manage: false },
    {
      level: "read",
      read: true,
      write: false,
      manage: false,
      principal_id: userId,
    },
    { level: "manage", read: true, write: false, manage: true },
    { level: "write", read: true, write: true, manage: true },
    { view: true, edit: false, manage: false },
  ]) {
    const fetch = installFetch(() => jsonResponse(payload));
    try {
      await expect(getMyBoardAccess(boardId)).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      fetch.restore();
    }
  }
});

test("my Board access preserves hidden-board denial and masks untrusted server detail", async () => {
  const missing = installFetch(() =>
    jsonResponse({ detail: "Board not found" }, 404),
  );
  try {
    await expect(getMyBoardAccess(boardId)).rejects.toMatchObject({
      status: 404,
      message: "Board not found",
    });
  } finally {
    missing.restore();
  }

  const privateDetail = installFetch(() =>
    jsonResponse({ detail: "internal policy: secret grant" }, 403),
  );
  try {
    await expect(getMyBoardAccess(boardId)).rejects.toMatchObject({
      status: 403,
      message: "Request could not be completed",
      details: undefined,
    });
  } finally {
    privateDetail.restore();
  }
});

test("Board access preview sends only validated IDs and receives the person's level", async () => {
  const fetch = installFetch(() =>
    jsonResponse({ level: "read", read: true, write: false, manage: false }),
  );
  try {
    await expect(getBoardAccessPreview(boardId, userId)).resolves.toEqual({
      level: "read",
      view: true,
      edit: false,
      manage: false,
    });
    expect(fetch.paths).toEqual([
      `/api/boards/${boardId}/access-preview?user_id=${userId}`,
    ]);
    await expect(getBoardAccessPreview("../other", userId)).rejects.toThrow();
    await expect(getBoardAccessPreview(boardId, "../other")).rejects.toThrow();
    expect(fetch.paths).toHaveLength(1);
  } finally {
    fetch.restore();
  }
});

test("Board preview user chooser validates and pages only active-label DTOs", async () => {
  const fetch = installFetch(() =>
    jsonResponse({
      items: [{ id: userId, username: "avery", display_name: "Avery Lin" }],
      pagination: page,
    }),
  );
  try {
    await expect(
      listBoardPreviewUsers(boardId, { search: "  Ave  ", sortOrder: "desc" }),
    ).resolves.toEqual({
      items: [{ id: userId, username: "avery", displayName: "Avery Lin" }],
      pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
    });
    expect(fetch.paths).toEqual([
      `/api/boards/${boardId}/preview-users?limit=25&offset=0&sort_by=display_name&sort_order=desc&search=Ave`,
    ]);
    await expect(
      listBoardPreviewUsers(boardId, { limit: 0 }),
    ).rejects.toThrow();
    await expect(
      listBoardPreviewUsers(boardId, { limit: 101 }),
    ).rejects.toThrow();
    await expect(
      listBoardPreviewUsers(boardId, { offset: -1 }),
    ).rejects.toThrow();
    expect(fetch.paths).toHaveLength(1);
  } finally {
    fetch.restore();
  }
});

test("Board Activity uses supported paging and sort but never sends unsupported search", async () => {
  const fetch = installFetch(() =>
    jsonResponse({
      items: [activity, groupActivity],
      pagination: { ...page, count: 2, total: 2 },
    }),
  );
  try {
    await expect(listBoardActivity(boardId)).resolves.toEqual({
      items: [
        {
          id: activityId,
          createdAt: "2026-09-23T00:00:00Z",
          kind: "board",
          action: "create",
          summary: "Board created",
          actorLabel: "Avery",
          group: null,
        },
        {
          id: groupActivityId,
          createdAt: "2026-09-24T00:00:00Z",
          kind: "group",
          action: "update",
          summary: "Board groups changed",
          actorLabel: "Avery",
          group: {
            name: "Internal Audit",
            level: "write",
            previousLevel: "read",
          },
        },
      ],
      pagination: { limit: 25, offset: 0, count: 2, total: 2, hasMore: false },
    });
    expect(fetch.paths).toEqual([
      `/api/boards/${boardId}/activity?limit=25&offset=0&sort_by=created_at&sort_order=desc`,
    ]);
    await expect(
      listBoardActivity(boardId, { search: "grant" } as never),
    ).rejects.toThrow();
    expect(fetch.paths).toHaveLength(1);
  } finally {
    fetch.restore();
  }
});

test("Board tools reject raw audit snapshots and principal fields in responses", async () => {
  for (const item of [
    { ...activity, before: { private_token: "not-public" } },
    // A group change names the group, never its id.
    {
      ...groupActivity,
      group: { ...groupActivity.group, group_id: userId },
    },
  ]) {
    const activityFetch = installFetch(() =>
      jsonResponse({ items: [item], pagination: page }),
    );
    try {
      await expect(listBoardActivity(boardId)).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      activityFetch.restore();
    }
  }

  const chooserFetch = installFetch(() =>
    jsonResponse({
      items: [
        {
          id: userId,
          username: "avery",
          display_name: "Avery Lin",
          email: "private@example.invalid",
        },
      ],
      pagination: page,
    }),
  );
  try {
    await expect(listBoardPreviewUsers(boardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    chooserFetch.restore();
  }
});

test("Board tools fail closed on malformed ACL flags, IDs, and pagination", async () => {
  const accessFetch = installFetch(() =>
    jsonResponse({
      view: true,
      edit: false,
      manage: false,
      principal_id: userId,
    }),
  );
  try {
    await expect(getBoardAccessPreview(boardId, userId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    accessFetch.restore();
  }

  const activityFetch = installFetch(() =>
    jsonResponse({
      items: [{ ...activity, id: "not-uuid" }],
      pagination: page,
    }),
  );
  try {
    await expect(listBoardActivity(boardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    activityFetch.restore();
  }

  const pageFetch = installFetch(() =>
    jsonResponse({
      items: [{ id: userId, username: "Avery" }],
      pagination: { ...page, limit: 0 },
    }),
  );
  try {
    await expect(listBoardPreviewUsers(boardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    pageFetch.restore();
  }
});

test("Board tools preserve the safe API denial without exposing private response data", async () => {
  const fetch = installFetch(() =>
    jsonResponse({ detail: "Board not found" }, 404),
  );
  try {
    await expect(listBoardActivity(boardId)).rejects.toMatchObject({
      status: 404,
      message: "Board not found",
    });
    await expect(listBoardPreviewUsers(boardId)).rejects.toBeInstanceOf(
      ApiError,
    );
  } finally {
    fetch.restore();
  }
});

test("Board access preview shows a person with no level on the Board", async () => {
  const fetch = installFetch(() =>
    jsonResponse({ level: null, read: false, write: false, manage: false }),
  );
  try {
    await expect(getBoardAccessPreview(boardId, userId)).resolves.toEqual({
      level: null,
      view: false,
      edit: false,
      manage: false,
    });
  } finally {
    fetch.restore();
  }
});
