import { expect, test } from "@playwright/test";
import { ApiError } from "../../../src/lib/api";
import type {
  BoardWidget,
  BoardWidgetPage,
} from "../../../src/components/systems/boards/adapters/board-widgets-api";
import {
  createSummaryWidgetInput,
  draftFromBoardWidget,
  updateInputForWidgetDraft,
  loadWidgetManagementSnapshot,
  retainWidgetDraftAfterConflict,
  reorderVisibleWidgetIds,
  saveWidgetDraft,
  loadWidgetSourcePage,
  beginWidgetManagerState,
  deniedWidgetManagerState,
  widgetManagerAfterConflict,
  canMutateBoardWidgets,
  cancelWidgetEdit,
  notifyIfBoardViewLost,
} from "../../../src/components/systems/boards/hooks/use-board-widget-management";

const boardId = "00000000-0000-4000-8000-000000000001";
const moduleId = "00000000-0000-4000-8000-000000000002";
const widgetId = "00000000-0000-4000-8000-000000000003";
const otherId = "00000000-0000-4000-8000-000000000004";
const userId = "00000000-0000-4000-8000-000000000005";
const timestamp = "2026-09-23T00:00:00Z";

function widget(): BoardWidget {
  return {
    id: widgetId,
    boardId,
    name: "Safety requests",
    widgetType: "records",
    moduleId,
    position: 0,
    config: {
      version: 1,
      fields: [],
      filters: [],
      logic: "and",
      metric: null,
      visualization: "bar",
      size: "half",
      refresh: "manual",
      pinned: false,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test("new summary widget has no audience and starts unpinned", () => {
  const input = createSummaryWidgetInput("  Open requests  ", moduleId);
  expect(input).not.toHaveProperty("audience");
  expect(input.name).toBe("Open requests");
  expect(input.widgetType).toBe("summary");
  expect(input.config.pinned).toBe(false);
  expect(input.config).not.toHaveProperty("refresh");
});

test("settings edits keep unrelated config exactly", () => {
  const source = widget();
  const draft = {
    ...draftFromBoardWidget(source),
    name: "Updated safety requests",
    size: "full" as const,
    pinned: true,
  };
  const input = updateInputForWidgetDraft(source, draft);
  expect(input).not.toHaveProperty("audience");
  expect(input.config).toEqual({
    version: 1,
    fields: [],
    filters: [],
    logic: "and",
    metric: null,
    visualization: "bar",
    size: "full",
    pinned: true,
  });
  expect(input.moduleId).toBe(moduleId);
  expect(input.widgetType).toBe("records");
});

test("conflict retains a draft only while its source widget is still visible", () => {
  const source = widget();
  const draft = { ...draftFromBoardWidget(source), name: "Unsaved local name" };
  expect(retainWidgetDraftAfterConflict(draft, [source])).toEqual(draft);
  expect(retainWidgetDraftAfterConflict(draft, [])).toBeNull();
  const changed = {
    ...source,
    config: { ...source.config, refresh: "one-minute" as const },
  };
  const retained = retainWidgetDraftAfterConflict(draft, [changed]);
  expect(retained).toEqual(draft);
  expect(() => updateInputForWidgetDraft(changed, draft)).toThrow();
});

test("Board switch and denial clear widget metadata and drafts", () => {
  const source = widget();
  const draft = {
    ...draftFromBoardWidget(source),
    name: "Unsaved private name",
  };
  const page: BoardWidgetPage = {
    items: [source],
    pagination: { limit: 12, offset: 0, count: 1, total: 1, hasMore: false },
    boardRevision: 4,
  };
  const ready = {
    key: boardId,
    status: "ready" as const,
    snapshot: {
      page,
      access: {
        level: "manage" as const,
        view: true,
        edit: true,
        manage: true,
      },
    },
    draft,
    summary: { name: "Draft summary", moduleId },
    pending: false,
    conflict: false,
    archiveLocked: false,
    error: null,
    notice: null,
  };
  expect(beginWidgetManagerState(ready, boardId).draft).toEqual(draft);
  const switched = beginWidgetManagerState(ready, userId);
  expect(switched.snapshot).toBeNull();
  expect(switched.draft).toBeNull();
  expect(switched.summary).toEqual({ name: "", moduleId: "" });
  const denied = deniedWidgetManagerState(boardId);
  expect(denied.snapshot).toBeNull();
  expect(denied.draft).toBeNull();
  expect(denied.summary.name).toBe("");
});

test("widget denial revokes parent Board only after independent VIEW loss confirmation", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  const paths: string[] = [];
  try {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      paths.push(String(input));
      return Promise.resolve(
        Response.json({
          id: boardId,
          scope: "project",
          department_id: null,
          name: "Still visible",
          description: null,
          status: "active",
          revision: 4,
          level: "read",
          created_at: timestamp,
          updated_at: timestamp,
        }),
      );
    }) as typeof fetch;
    await notifyIfBoardViewLost(
      boardId,
      () => true,
      (id) => calls.push(id),
    );
    expect(calls).toEqual([]);

    globalThis.fetch = ((input: RequestInfo | URL) => {
      paths.push(String(input));
      return Promise.resolve(
        Response.json({ detail: "Board not found" }, { status: 404 }),
      );
    }) as typeof fetch;
    await notifyIfBoardViewLost(
      boardId,
      () => true,
      (id) => calls.push(id),
    );
    expect(calls).toEqual([boardId]);
    expect(paths).toEqual([`/api/boards/${boardId}`, `/api/boards/${boardId}`]);
  } finally {
    globalThis.fetch = original;
  }
});

test("unconfirmed or stale Board VIEW probes never revoke parent detail", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({ detail: "Unavailable" }, { status: 503 }),
      )) as typeof fetch;
    await notifyIfBoardViewLost(
      boardId,
      () => true,
      (id) => calls.push(id),
    );
    expect(calls).toEqual([]);

    let finish!: (response: Response) => void;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    globalThis.fetch = (() => {
      started();
      return response;
    }) as typeof fetch;
    let current = true;
    const check = notifyIfBoardViewLost(
      boardId,
      () => current,
      (id) => calls.push(id),
    );
    await requestStarted;
    current = false;
    finish(Response.json({ detail: "Forbidden" }, { status: 403 }));
    await check;
    expect(calls).toEqual([]);
  } finally {
    globalThis.fetch = original;
  }
});

test("remote Board archive locks every widget mutation until Board status is restored", () => {
  const source = widget();
  const page: BoardWidgetPage = {
    items: [source],
    pagination: { limit: 12, offset: 0, count: 1, total: 1, hasMore: false },
    boardRevision: 5,
  };
  const snapshot = {
    page,
    access: { level: "manage" as const, view: true, edit: true, manage: true },
  };
  const ready = {
    ...beginWidgetManagerState(deniedWidgetManagerState(boardId), boardId),
    status: "ready" as const,
    snapshot,
    draft: draftFromBoardWidget(source),
  };
  expect(canMutateBoardWidgets(ready, true)).toBe(true);
  const locked = widgetManagerAfterConflict(
    ready,
    new ApiError(
      409,
      "Restore the Board before changing widgets",
      { code: "board_archived" },
      "board_archived",
    ),
    snapshot,
  );
  expect(locked.archiveLocked).toBe(true);
  expect(locked.draft).toEqual(ready.draft);
  expect(canMutateBoardWidgets(locked, true)).toBe(false);
  expect(
    canMutateBoardWidgets(beginWidgetManagerState(locked, boardId), true),
  ).toBe(false);
  expect(canMutateBoardWidgets(cancelWidgetEdit(locked), true)).toBe(false);
  const archivedStatus = beginWidgetManagerState(locked, boardId, false);
  expect(archivedStatus.archiveLocked).toBe(false);
  expect(canMutateBoardWidgets(archivedStatus, false)).toBe(false);
});

test("stale settings conflict retains draft and pauses all mutation controls until cancel", () => {
  const source = widget();
  const originalPage: BoardWidgetPage = {
    items: [source],
    pagination: { limit: 12, offset: 0, count: 1, total: 1, hasMore: false },
    boardRevision: 5,
  };
  const ready = {
    ...beginWidgetManagerState(deniedWidgetManagerState(boardId), boardId),
    status: "ready" as const,
    snapshot: {
      page: originalPage,
      access: {
        level: "manage" as const,
        view: true,
        edit: true,
        manage: true,
      },
    },
    draft: { ...draftFromBoardWidget(source), name: "Unsaved edit" },
  };
  const changed = {
    ...source,
    name: "New server title",
    updatedAt: "2026-09-24T00:00:00Z",
  };
  const latest = {
    ...ready.snapshot,
    page: { ...originalPage, items: [changed], boardRevision: 6 },
  };
  const conflicted = widgetManagerAfterConflict(
    ready,
    new ApiError(
      409,
      "Board changed; reload before saving",
      { code: "stale_revision" },
      "stale_revision",
    ),
    latest,
  );
  expect(conflicted.draft?.name).toBe("Unsaved edit");
  expect(conflicted.conflict).toBe(true);
  expect(canMutateBoardWidgets(conflicted, true)).toBe(false);
  const cancelled = cancelWidgetEdit(conflicted);
  expect(cancelled.draft).toBeNull();
  expect(canMutateBoardWidgets(cancelled, true)).toBe(true);
});

test("management metadata uses Board access and a complete widget page", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    if (path.endsWith("/my-access"))
      return Promise.resolve(
        Response.json({
          level: "manage",
          read: true,
          write: true,
          manage: true,
        }),
      );
    return Promise.resolve(
      Response.json({
        items: [
          {
            id: widgetId,
            board_id: boardId,
            name: "Safety requests",
            widget_type: "records",
            module_id: moduleId,
            position: 0,
            config: {
              version: 1,
              fields: [],
              filters: [],
              logic: "and",
              metric: null,
              visualization: "bar",
              size: "half",
              refresh: "manual",
              pinned: false,
            },
            created_at: timestamp,
            updated_at: timestamp,
          },
        ],
        pagination: {
          limit: 12,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
        board_revision: 7,
      }),
    );
  }) as typeof fetch;
  try {
    const snapshot = await loadWidgetManagementSnapshot(boardId);
    expect(snapshot.page.boardRevision).toBe(7);
    expect(snapshot.access).toEqual({
      level: "manage",
      view: true,
      edit: true,
      manage: true,
    });
    expect(paths).toEqual([
      `/api/boards/${boardId}/my-access`,
      `/api/boards/${boardId}/widgets?limit=12&offset=0&sort_by=position&sort_order=asc`,
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("reorder acts on the widget IDs in the server page", () => {
  const first = widget();
  const second = { ...first, id: userId, position: 2 };
  const third = { ...first, id: otherId, position: 4 };
  const page: BoardWidgetPage = {
    items: [first, second, third],
    pagination: { limit: 12, offset: 0, count: 3, total: 3, hasMore: false },
    boardRevision: 9,
  };
  expect(reorderVisibleWidgetIds(page, second.id, -1)).toEqual([
    second.id,
    first.id,
    third.id,
  ]);
  expect(reorderVisibleWidgetIds(page, second.id, 1)).toEqual([
    first.id,
    third.id,
    second.id,
  ]);
  expect(reorderVisibleWidgetIds(page, first.id, -1)).toBeNull();
});

test("save uses the listed Board revision and sends no audience", async () => {
  const source = widget();
  const page: BoardWidgetPage = {
    items: [source],
    pagination: { limit: 12, offset: 0, count: 1, total: 1, hasMore: false },
    boardRevision: 11,
  };
  const original = globalThis.fetch;
  const requests: { path: string; method: string; body: unknown }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      path: String(input),
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body)),
    });
    return Promise.resolve(
      Response.json({
        widget: {
          id: widgetId,
          board_id: boardId,
          name: "New title",
          widget_type: "records",
          module_id: moduleId,
          position: 0,
          config: {
            version: 1,
            fields: [],
            filters: [],
            logic: "and",
            metric: null,
            visualization: "bar",
            size: "half",
            refresh: "manual",
            pinned: false,
          },
          created_at: timestamp,
          updated_at: timestamp,
        },
        board_revision: 12,
      }),
    );
  }) as typeof fetch;
  try {
    await saveWidgetDraft(boardId, page, {
      ...draftFromBoardWidget(source),
      name: "New title",
    });
    expect(requests).toEqual([
      {
        path: `/api/boards/${boardId}/widgets/${widgetId}`,
        method: "PATCH",
        body: expect.objectContaining({
          revision: 11,
          widget: expect.objectContaining({ name: "New title" }),
        }),
      },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("source chooser reads active OpenView catalog page rather than accepting a guessed module", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    paths.push(String(input));
    return Promise.resolve(
      Response.json({
        items: [
          {
            id: moduleId,
            name: "Accepted source",
            department_id: otherId,
            title_field_id: null,
          },
        ],
        pagination: {
          limit: 100,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      }),
    );
  }) as typeof fetch;
  try {
    const result = await loadWidgetSourcePage(0);
    expect(result.items.map(({ id }) => id)).toEqual([moduleId]);
    expect(paths).toEqual(["/api/views/data-sources?limit=100&offset=0"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("only Board managers may change widgets", () => {
  const page: BoardWidgetPage = {
    items: [widget()],
    pagination: { limit: 12, offset: 0, count: 1, total: 1, hasMore: false },
    boardRevision: 3,
  };
  const ready = (level: "read" | "write" | "manage") => ({
    ...beginWidgetManagerState(deniedWidgetManagerState(boardId), boardId),
    status: "ready" as const,
    snapshot: {
      page,
      access: {
        level,
        view: true,
        edit: level !== "read",
        manage: level === "manage",
      },
    },
  });
  expect(canMutateBoardWidgets(ready("read"), true)).toBe(false);
  expect(canMutateBoardWidgets(ready("write"), true)).toBe(false);
  expect(canMutateBoardWidgets(ready("manage"), true)).toBe(true);
});
