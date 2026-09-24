import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../src/lib/api";
import type { BoardPlacementPage } from "../../src/components/systems/boards/adapters/board-placements-api";
import {
  ServerBoardPlacementsDisplay,
  emptyPlacementWorkspaceState,
  loadPlacementRecordChoices,
  transitionPlacementWorkspace,
} from "../../src/components/systems/boards/components/server-backed-board-placements";

const boardId = "00000000-0000-4000-8000-000000000001";
const otherBoardId = "00000000-0000-4000-8000-000000000002";
const placementId = "00000000-0000-4000-8000-000000000003";
const moduleId = "00000000-0000-4000-8000-000000000004";
const recordId = "00000000-0000-4000-8000-000000000005";
const fieldId = "00000000-0000-4000-8000-000000000006";
const timestamp = "2026-09-23T00:00:00Z";
const page: BoardPlacementPage = {
  items: [
    {
      id: placementId,
      boardId,
      recordId,
      moduleId,
      available: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
  boardRevision: 4,
};

test("record picker reads candidate labels only through the records.read catalog and query", async () => {
  const original = globalThis.fetch;
  const requests: { path: string; body?: string }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push({ path, body: init?.body?.toString() });
    if (path.startsWith(`/api/views/data-sources/${moduleId}/fields?`))
      return Promise.resolve(
        Response.json({
          items: [
            {
              id: fieldId,
              module_id: moduleId,
              name: "Request title",
              type: "text",
              required: false,
              position: 0,
              config: {},
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
    if (path === "/api/records/query")
      return Promise.resolve(
        Response.json({
          items: [
            {
              id: recordId,
              module_id: moduleId,
              data: { [fieldId]: "Safety task" },
              created_at: timestamp,
              updated_at: timestamp,
              deleted_at: null,
              is_deleted: false,
              performed_by: null,
            },
          ],
          pagination: {
            limit: 25,
            offset: 0,
            count: 1,
            total: 1,
            has_more: false,
          },
        }),
      );
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  try {
    const result = await loadPlacementRecordChoices(moduleId, "Safety", 0);
    expect(result.choices).toEqual([{ id: recordId, label: "Safety task" }]);
    expect(requests.map(({ path }) => path)).toEqual([
      `/api/views/data-sources/${moduleId}/fields?limit=100&offset=0`,
      "/api/records/query",
    ]);
    expect(JSON.parse(requests[1]!.body!)).toMatchObject({
      module_id: moduleId,
      definition: {
        search: "Safety",
        columns: [{ field_id: fieldId, expected_type: "text" }],
      },
      limit: 25,
      offset: 0,
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("record picker stops on catalog denial and does not query records", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    paths.push(String(input));
    return Promise.resolve(
      Response.json({ detail: "Forbidden" }, { status: 403 }),
    );
  }) as typeof fetch;
  try {
    await expect(
      loadPlacementRecordChoices(moduleId, "", 0),
    ).rejects.toMatchObject({ status: 403 });
    expect(paths).toEqual([
      `/api/views/data-sources/${moduleId}/fields?limit=100&offset=0`,
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("placement metadata renders a shortcut without claiming Record field access", () => {
  const html = renderToStaticMarkup(
    createElement(ServerBoardPlacementsDisplay, { page }),
  );
  expect(html).toContain("Record shortcut");
  expect(html).toContain(`/openview?module=${moduleId}&amp;record=${recordId}`);
  expect(html).not.toContain("Safety task");
  expect(html).not.toContain(fieldId);
  const unavailable = renderToStaticMarkup(
    createElement(ServerBoardPlacementsDisplay, {
      page: {
        ...page,
        items: [{ ...page.items[0], moduleId: null, available: false }],
      },
    }),
  );
  expect(unavailable).toContain("Unavailable record");
  expect(unavailable).not.toContain("/openview?");
});

test("Board switch and authorization failure clear private placement rows; stale responses stay ignored", () => {
  const ready = transitionPlacementWorkspace(
    transitionPlacementWorkspace(emptyPlacementWorkspaceState, {
      type: "begin",
      key: boardId,
      sequence: 1,
    }),
    {
      type: "resolve",
      key: boardId,
      sequence: 1,
      page,
      access: { view: true, edit: false, manage: false },
    },
  );
  expect(ready.page).toEqual(page);
  const switched = transitionPlacementWorkspace(ready, {
    type: "begin",
    key: otherBoardId,
    sequence: 2,
  });
  expect(switched.page).toBeNull();
  expect(
    transitionPlacementWorkspace(switched, {
      type: "resolve",
      key: boardId,
      sequence: 1,
      page,
      access: { view: true, edit: false, manage: false },
    }),
  ).toEqual(switched);
  for (const status of [401, 403, 404]) {
    const denied = transitionPlacementWorkspace(ready, {
      type: "reject",
      key: boardId,
      sequence: 1,
      error: new ApiError(status, "Denied").message,
      retain: false,
    });
    expect(denied.page).toBeNull();
    expect(denied.status).toBe("error");
  }
});
