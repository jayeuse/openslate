import { expect, test } from "@playwright/test";
import { ApiError } from "../../src/lib/api";
import type { BoardPlacementPage } from "../../src/components/systems/boards/adapters/board-placements-api";
import {
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
const userId = "00000000-0000-4000-8000-000000000007";
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

test("record shortcut picker opens on demand, adds the chosen record, and closes", async ({
  page,
}) => {
  const board = {
    id: boardId,
    owner_id: userId,
    department_id: null,
    name: "Operations board",
    description: "Current authorized workspace content",
    status: "active",
    default_section: "overview",
    revision: 4,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const source = {
    id: moduleId,
    name: "Suppliers",
    department_id: "00000000-0000-4000-8000-000000000008",
  };
  const unavailablePlacement = {
    id: "00000000-0000-4000-8000-000000000009",
    board_id: boardId,
    record_id: "00000000-0000-4000-8000-000000000010",
    module_id: null,
    available: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const placementRequests: unknown[] = [];
  let createdPlacement: Record<string, unknown> | null = null;

  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Not available in this test" }),
    }),
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: userId,
        setup_required: false,
      }),
    }),
  );
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ today: "2026-09-23" }),
    }),
  );
  await page.route("**/api/views/data-sources**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/views/data-sources")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [source],
          pagination: {
            limit: 25,
            offset: 0,
            count: 1,
            total: 1,
            has_more: false,
          },
        }),
      });
    if (path === `/api/views/data-sources/${moduleId}/fields`)
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: fieldId,
              module_id: moduleId,
              name: "Supplier name",
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
      });
    return route.fulfill({ status: 404, body: "Not found" });
  });
  await page.route("**/api/records/query", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: recordId,
            module_id: moduleId,
            data: { [fieldId]: "Northstar Office Supply" },
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
    }),
  );
  await page.route("**/api/boards**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/boards/personal")
      return reply(200, { favorite_board_ids: [], home_board_id: null });
    if (path === "/api/boards")
      return reply(200, {
        items: [board],
        pagination: {
          limit: 25,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      });
    if (path === `/api/boards/${boardId}/my-access`)
      return reply(200, { view: true, edit: true, manage: true });
    if (path === `/api/boards/${boardId}/widgets`)
      return reply(200, {
        items: [],
        pagination: {
          limit: 12,
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
        board_revision: 4,
      });
    if (path === `/api/boards/${boardId}/placements`) {
      if (request.method() === "POST") {
        const body = request.postDataJSON() as {
          revision: number;
          record_id: string;
        };
        placementRequests.push(body);
        createdPlacement = {
          id: placementId,
          board_id: boardId,
          record_id: body.record_id,
          module_id: moduleId,
          available: true,
          created_at: timestamp,
          updated_at: timestamp,
        };
        return reply(201, { placement: createdPlacement, board_revision: 5 });
      }
      const items = createdPlacement
        ? [unavailablePlacement, createdPlacement]
        : [unavailablePlacement];
      return reply(200, {
        items,
        pagination: {
          limit: 25,
          offset: 0,
          count: items.length,
          total: items.length,
          has_more: false,
        },
        board_revision: createdPlacement ? 5 : 4,
      });
    }
    if (path === `/api/boards/${boardId}`) return reply(200, board);
    return reply(404, { detail: "Not available in this test" });
  });

  await page.goto(`/boards?board=${boardId}&section=overview`);
  await expect(
    page.getByRole("heading", { name: "Linked records" }),
  ).toBeVisible();
  const unavailableRow = page
    .getByRole("row")
    .filter({ hasText: "Unavailable record" });
  await expect(unavailableRow).toBeVisible();
  await expect(
    unavailableRow.getByRole("link", { name: "Open record" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Unavailable source", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Add record shortcut" }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const trigger = page.getByRole("button", {
    name: "Add shortcut",
    exact: true,
  });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Add record shortcut" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Record source").selectOption(moduleId);
  await expect(
    dialog.getByRole("option", { name: "Northstar Office Supply" }),
  ).toBeAttached();
  await dialog.getByLabel("Record", { exact: true }).selectOption(recordId);
  await dialog.getByRole("button", { name: "Add shortcut" }).click();

  await expect(dialog).toBeHidden();
  expect(placementRequests).toEqual([{ revision: 4, record_id: recordId }]);
  await expect(
    page.getByRole("table", { name: "Linked record shortcuts" }),
  ).toBeVisible();
  await expect(
    page.getByText("Record shortcut", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Suppliers", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open record" })).toBeVisible();
  await expect(page.getByText("Northstar Office Supply")).toHaveCount(0);
  await expect(page.getByText(fieldId, { exact: true })).toHaveCount(0);
  await expect(unavailableRow).toBeVisible();
  await expect(
    unavailableRow.getByRole("link", { name: "Open record" }),
  ).toHaveCount(0);
});

test("linked record pages use server limits and reset the offset when the page size changes", async ({
  page,
}) => {
  const board = {
    id: boardId,
    owner_id: userId,
    department_id: null,
    name: "Operations board",
    description: "Current authorized workspace content",
    status: "active",
    default_section: "overview",
    revision: 4,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const source = {
    id: moduleId,
    name: "Suppliers",
    department_id: null,
  };
  const placements = Array.from({ length: 6 }, (_, index) => {
    const id = `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`;
    return {
      id,
      board_id: boardId,
      record_id: id,
      module_id: moduleId,
      available: true,
      created_at: timestamp,
      updated_at: timestamp,
    };
  });
  const placementRequests: { limit: number; offset: number }[] = [];
  const deleteRevisions: string[] = [];

  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Not available in this test" }),
    }),
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: userId,
        setup_required: false,
      }),
    }),
  );
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ today: "2026-09-23" }),
    }),
  );
  await page.route("**/api/views/data-sources**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [source],
        pagination: {
          limit: 25,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      }),
    }),
  );
  await page.route("**/api/boards**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const reply = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/boards/personal")
      return reply(200, { favorite_board_ids: [], home_board_id: null });
    if (path === "/api/boards")
      return reply(200, {
        items: [board],
        pagination: {
          limit: 25,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      });
    if (path === `/api/boards/${boardId}/my-access`)
      return reply(200, { view: true, edit: true, manage: false });
    if (path === `/api/boards/${boardId}/widgets`)
      return reply(200, {
        items: [],
        pagination: {
          limit: 12,
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
        board_revision: 4,
      });
    const placementsPath = `/api/boards/${boardId}/placements`;
    if (path === placementsPath && request.method() === "GET") {
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      placementRequests.push({ limit, offset });
      const items = placements.slice(offset, offset + limit);
      return reply(200, {
        items,
        pagination: {
          limit,
          offset,
          count: items.length,
          total: placements.length,
          has_more: offset + items.length < placements.length,
        },
        board_revision: deleteRevisions.length > 0 ? 5 : 4,
      });
    }
    if (
      path.startsWith(`${placementsPath}/`) &&
      request.method() === "DELETE"
    ) {
      deleteRevisions.push(url.searchParams.get("revision") ?? "");
      const removedId = path.slice(`${placementsPath}/`.length);
      const removedIndex = placements.findIndex(({ id }) => id === removedId);
      if (removedIndex >= 0) placements.splice(removedIndex, 1);
      return reply(200, null);
    }
    if (path === `/api/boards/${boardId}`) return reply(200, board);
    return reply(404, { detail: "Not available in this test" });
  });

  await page.goto(`/boards?board=${boardId}&section=overview`);
  await expect(
    page.getByRole("table", { name: "Linked record shortcuts" }),
  ).toBeVisible();
  await expect(
    page.getByText("Showing 1–6 of 6", { exact: true }),
  ).toBeVisible();
  const rowsPerPage = page.getByLabel("Rows per page", { exact: true });
  await expect(rowsPerPage).toHaveValue("25");

  await rowsPerPage.selectOption("5");
  await expect(
    page.getByText("Showing 1–5 of 6", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => placementRequests.at(-1))
    .toEqual({ limit: 5, offset: 0 });
  await page.getByRole("button", { name: "Go to next page" }).click();
  await expect(
    page.getByText("Showing 6–6 of 6", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => placementRequests.at(-1))
    .toEqual({ limit: 5, offset: 5 });

  await rowsPerPage.selectOption("10");
  await expect(
    page.getByText("Showing 1–6 of 6", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => placementRequests.at(-1))
    .toEqual({ limit: 10, offset: 0 });

  await rowsPerPage.selectOption("5");
  await expect(
    page.getByText("Showing 1–5 of 6", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Go to next page" }).click();
  await expect(
    page.getByText("Showing 6–6 of 6", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove shortcut" }).click();
  await expect(
    page.getByText("Showing 1–5 of 5", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => placementRequests.at(-1))
    .toEqual({ limit: 5, offset: 0 });
  expect(deleteRevisions).toEqual(["4"]);
});
