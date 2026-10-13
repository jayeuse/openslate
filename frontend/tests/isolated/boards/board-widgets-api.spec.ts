import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  createBoardWidget,
  deleteBoardWidget,
  duplicateBoardWidget,
  listBoardWidgets,
  reorderBoardWidgets,
  updateBoardWidget,
} from "../../../src/components/systems/boards/adapters/board-widgets-api";
import { installNoArgumentFetch as installFetch } from "../helpers/fake-fetch";

const boardId = "00000000-0000-4000-8000-000000000001";
const widgetId = "00000000-0000-4000-8000-000000000002";
const duplicateId = "00000000-0000-4000-8000-000000000003";
const moduleId = "00000000-0000-4000-8000-000000000004";
const fieldId = "00000000-0000-4000-8000-000000000005";
const targetId = "00000000-0000-4000-8000-000000000006";
const timestamp = "2026-09-23T00:00:00Z";

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

const config = {
  version: 1,
  fields: [{ field_id: fieldId, expected_type: "text" }],
  filters: [],
  logic: "and",
  metric: null,
  visualization: "bar",
  refresh: "manual",
};

function widgetResponse(id = widgetId) {
  return {
    id,
    board_id: boardId,
    name: "Requests",
    widget_type: "records",
    module_id: moduleId,
    position: 0,
    size: "M",
    pinned: false,
    chart_id: null,
    config,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

const widgetInput = {
  name: "Requests",
  widgetType: "records" as const,
  moduleId,
  config: {
    fields: [{ fieldId, expectedType: "text" as const }],
  },
};

test("widget list is a bounded page of the Board widgets", async () => {
  const mock = installFetch(() =>
    jsonResponse({
      items: [widgetResponse()],
      pagination: { limit: 1, offset: 0, count: 1, total: 1, has_more: false },
      board_revision: 7,
    }),
  );
  try {
    const page = await listBoardWidgets(boardId, {
      limit: 1,
      sortBy: "created_at",
      sortOrder: "desc",
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: widgetId,
      boardId,
      config: { fields: [{ fieldId, expectedType: "text" }] },
    });
    expect(page.items[0]).not.toHaveProperty("audience");
    expect(page.pagination).toEqual({
      limit: 1,
      offset: 0,
      count: 1,
      total: 1,
      hasMore: false,
    });
    expect(page.boardRevision).toBe(7);
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/boards/${boardId}/widgets?limit=1&offset=0&sort_by=created_at&sort_order=desc`,
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("widget create, patch, duplicate, reorder and delete send revisioned contracts", async () => {
  const responses = [
    jsonResponse({ widget: widgetResponse(), board_revision: 2 }, 201),
    jsonResponse({
      widget: { ...widgetResponse(), name: "Updated" },
      board_revision: 3,
    }),
    jsonResponse(
      { widget: widgetResponse(duplicateId), board_revision: 4 },
      201,
    ),
    jsonResponse({
      items: [widgetResponse(duplicateId), widgetResponse()],
      board_revision: 5,
    }),
    new Response(null, { status: 204 }),
  ];
  const mock = installFetch(() => responses.shift()!);
  try {
    const created = await createBoardWidget(boardId, 1, widgetInput);
    expect(created.widget.id).toBe(widgetId);
    expect(created.boardRevision).toBe(2);
    await expect(
      updateBoardWidget(boardId, widgetId, 2, {
        ...widgetInput,
        name: "Updated",
      }),
    ).resolves.toMatchObject({ boardRevision: 3, widget: { name: "Updated" } });
    await expect(
      duplicateBoardWidget(boardId, widgetId, 3),
    ).resolves.toMatchObject({
      boardRevision: 4,
      widget: { id: duplicateId },
    });
    await expect(
      reorderBoardWidgets(boardId, 4, [duplicateId, widgetId]),
    ).resolves.toMatchObject({
      boardRevision: 5,
      items: [{ id: duplicateId }, { id: widgetId }],
    });
    await expect(
      deleteBoardWidget(boardId, widgetId, 5),
    ).resolves.toBeUndefined();
    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      [`/api/boards/${boardId}/widgets`, "POST"],
      [`/api/boards/${boardId}/widgets/${widgetId}`, "PATCH"],
      [`/api/boards/${boardId}/widgets/${widgetId}/duplicate`, "POST"],
      [`/api/boards/${boardId}/widgets/order`, "PUT"],
      [`/api/boards/${boardId}/widgets/${widgetId}?revision=5`, "DELETE"],
    ]);
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      revision: 1,
      widget: {
        name: "Requests",
        widget_type: "records",
        module_id: moduleId,
        size: "M",
        pinned: false,
        chart_id: null,
        config: {
          version: 1,
          fields: config.fields,
          filters: [],
          logic: "and",
          aggregation: "count",
          metric: null,
          visualization: "bar",
        },
      },
    });
    expect(JSON.parse(String(mock.requests[2]?.init?.body))).toEqual({
      revision: 3,
    });
    expect(JSON.parse(String(mock.requests[3]?.init?.body))).toEqual({
      revision: 4,
      widget_ids: [duplicateId, widgetId],
    });
    expect(mock.requests.every(({ init }) => init?.cache === "no-store")).toBe(
      true,
    );
  } finally {
    mock.restore();
  }
});

test("widget inputs reject audience, invalid source, filters and order before fetch", async () => {
  const mock = installFetch(() =>
    jsonResponse({ widget: widgetResponse(), board_revision: 2 }),
  );
  try {
    await expect(
      listBoardWidgets(boardId, { search: "secret" } as never),
    ).rejects.toThrow();
    await expect(
      createBoardWidget("../other", 1, widgetInput),
    ).rejects.toThrow();
    await expect(createBoardWidget(boardId, 0, widgetInput)).rejects.toThrow();
    await expect(
      createBoardWidget(boardId, 1, {
        ...widgetInput,
        ownerId: targetId,
      } as never),
    ).rejects.toThrow();
    await expect(
      createBoardWidget(boardId, 1, {
        ...widgetInput,
        audience: { kind: "everyone" },
      } as never),
    ).rejects.toThrow();
    await expect(
      createBoardWidget(boardId, 1, {
        ...widgetInput,
        config: {
          fields: [{ fieldId, expectedType: "relationship" }],
        } as never,
      }),
    ).rejects.toThrow();
    await expect(
      createBoardWidget(boardId, 1, {
        ...widgetInput,
        config: {
          fields: [
            { fieldId, expectedType: "text" },
            { fieldId, expectedType: "text" },
          ],
        },
      }),
    ).rejects.toThrow();
    await expect(
      reorderBoardWidgets(boardId, 1, [widgetId, widgetId]),
    ).rejects.toThrow();
    await expect(deleteBoardWidget(boardId, widgetId, 0)).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("widget responses reject private extras, audience fields and foreign board IDs", async () => {
  const privateDto = installFetch(() =>
    jsonResponse({
      items: [{ ...widgetResponse(), creator_id: targetId }],
      pagination: { limit: 25, offset: 0, count: 1, total: 1, has_more: false },
      board_revision: 1,
    }),
  );
  try {
    await expect(listBoardWidgets(boardId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    privateDto.restore();
  }
  const badAudience = installFetch(() =>
    jsonResponse(
      {
        widget: {
          ...widgetResponse(),
          audience: { kind: "everyone", user_id: null },
        },
        board_revision: 2,
      },
      201,
    ),
  );
  try {
    await expect(
      createBoardWidget(boardId, 1, widgetInput),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    badAudience.restore();
  }
  const foreign = installFetch(() =>
    jsonResponse(
      {
        widget: { ...widgetResponse(), board_id: targetId },
        board_revision: 2,
      },
      201,
    ),
  );
  try {
    await expect(
      createBoardWidget(boardId, 1, widgetInput),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    foreign.restore();
  }
  const unrequested = installFetch(() =>
    jsonResponse({
      items: [widgetResponse(), widgetResponse(duplicateId)],
      board_revision: 2,
    }),
  );
  try {
    await expect(
      reorderBoardWidgets(boardId, 1, [widgetId]),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    unrequested.restore();
  }
  const reused = installFetch(() =>
    jsonResponse({ widget: widgetResponse(), board_revision: 2 }, 201),
  );
  try {
    await expect(
      duplicateBoardWidget(boardId, widgetId, 1),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    reused.restore();
  }
});

test("widget errors preserve safe codes but not hidden audience or server detail", async () => {
  const secret = "private audience and SQL";
  const conflict = installFetch(() =>
    jsonResponse(
      {
        detail: {
          code: "widget_order_invalid",
          message: secret,
          hidden_widget_ids: [widgetId],
        },
      },
      409,
    ),
  );
  try {
    const error = await reorderBoardWidgets(boardId, 1, [widgetId]).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "widget_order_invalid" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain("hidden_widget_ids");
  } finally {
    conflict.restore();
  }
  const hidden = installFetch(() =>
    jsonResponse({ detail: "Board widget not found" }, 404),
  );
  try {
    await expect(
      duplicateBoardWidget(boardId, widgetId, 1),
    ).rejects.toMatchObject({
      status: 404,
      message: "Board widget not found",
    });
  } finally {
    hidden.restore();
  }
  const denied = installFetch(() => jsonResponse({ detail: secret }, 403));
  try {
    await expect(listBoardWidgets(boardId)).rejects.toMatchObject({
      status: 403,
      message: "Request could not be completed",
    });
  } finally {
    denied.restore();
  }
  const unknown = installFetch(() =>
    jsonResponse({ detail: { code: "__proto__", message: secret } }, 409),
  );
  try {
    await expect(listBoardWidgets(boardId)).rejects.toMatchObject({
      status: 409,
      message: "Request could not be completed",
    });
  } finally {
    unknown.restore();
  }
});
