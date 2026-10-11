import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { installOpenViewEventSource } from "./helpers/openview-event-source";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../src/lib/api";
import type { BoardManagementBoard } from "../../src/components/systems/boards/adapters/board-management-api";
import { ServerBoardPortabilityDisplay } from "../../src/components/systems/boards/components/server-backed-board-portability";
import {
  duplicateCurrentBoardStructure,
  prepareBoardConfiguration,
} from "../../src/components/systems/boards/hooks/use-server-board-portability";
import { isEventStream } from "./helpers/test";

const boardId = "00000000-0000-4000-8000-000000000001";
const newBoardId = "00000000-0000-4000-8000-000000000002";
const departmentId = "00000000-0000-4000-8000-000000000003";
const timestamp = "2026-09-23T00:00:00Z";
const board: BoardManagementBoard = {
  id: boardId,
  scope: "department",
  departmentId,
  name: "Dispatch",
  description: "Daily handoffs",
  status: "active",
  revision: 4,
  level: "manage",
  createdAt: timestamp,
  updatedAt: timestamp,
};

const s26NamedDefinition = {
  version: 1,
  logic: "and",
  deleted: "exclude",
  search: "00000000-0000-4000-8000-000000000101",
  columns: Array.from({ length: 100 }, (_, index) => ({
    name: `Label ${index}`,
    expected_type: "text",
  })),
  filters: Array.from({ length: 10 }, () => ({
    name: "Status",
    expected_type: "select",
    operator: "eq",
    value: "Open",
  })),
  sort: [
    { name: "Label 0", expected_type: "text", direction: "asc" },
    { name: "Label 1", expected_type: "text", direction: "desc" },
    { name: "Assignee", expected_type: "user", direction: "asc" },
  ],
  search_fields: [{ name: "Label 0", expected_type: "text" }],
};
const s26NamedBundle = {
  kind: "openslate-board",
  version: 3,
  configuration: {
    name: "Named query board",
    description: "Complete named definitions",
    widgets: [
      ...["count", "sum", "average", "min", "max", "distinct"].map(
        (aggregation, index) => ({
          name: `${aggregation} groups`,
          widget_type: "summary",
          source: { department_name: "Operations", module_name: "Requests" },
          config: {
            version: 1,
            size: ["S", "M", "L"][index % 3],
            pinned: index % 2 === 0,
            refresh: "manual",
            query: {
              mode: "groups",
              definition: s26NamedDefinition,
              aggregation,
              measure:
                aggregation === "count"
                  ? null
                  : { name: "Amount", expected_type: "decimal" },
              dimension: { name: "Status", expected_type: "select" },
              date_field: null,
              from_date: null,
              to_date: null,
            },
          },
        }),
      ),
      {
        name: "Yearly amount",
        widget_type: "chart",
        source: { department_name: "Operations", module_name: "Requests" },
        config: {
          version: 1,
          size: "L",
          pinned: false,
          refresh: "manual",
          chart_type: "line",
          query: {
            mode: "date_series",
            definition: s26NamedDefinition,
            aggregation: "sum",
            measure: { name: "Amount", expected_type: "decimal" },
            date_field: { name: "Opened", expected_type: "date" },
            from_date: "2020-01-01",
            to_date: "2022-12-31",
            bucket: "year",
          },
        },
      },
      {
        name: "Named records",
        widget_type: "records",
        source: { department_name: "Operations", module_name: "Requests" },
        config: {
          version: 1,
          size: "S",
          pinned: true,
          refresh: "manual",
          query: {
            definition: {
              ...s26NamedDefinition,
              columns: [{ name: "Assignee", expected_type: "user" }],
              filters: [
                {
                  name: "Assignee",
                  expected_type: "user",
                  operator: "not_empty",
                  value: null,
                },
              ],
            },
          },
        },
      },
    ],
  },
};

test("S26 real configuration download and import preserve the complete named normalized v3 bundle", async ({
  page,
}) => {
  await installOpenViewEventSource(page);
  const actor = "00000000-0000-4000-8000-000000000671";
  const exact = JSON.stringify(s26NamedBundle, null, 2);
  const writes: Buffer[] = [];
  let imported = false;
  const pageOf = (items: unknown[], limit = 25) => ({
    items,
    pagination: {
      limit,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  });
  await page.route("**/api/**", (route) => {
    if (isEventStream(route)) return route.fallback();
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === "/api/auth/session")
      return json({
        authenticated: true,
        user_id: actor,
        setup_required: false,
      });
    if (path === "/api/auth/me")
      return json({ id: actor, role: "admin", access: [] });
    if (path === `/api/users/${actor}/preferences`)
      return json({
        user_id: actor,
        theme: "light",
        appearance: { motion: "reduce", keyboard_shortcuts: true },
      });
    if (path === "/api/workspace")
      return json({
        id: departmentId,
        display_name: "OpenSlate",
        legal_name: null,
        description: null,
        contact_email: null,
        contact_phone: null,
        postal_address: null,
        logo_file_id: null,
        locale: "en-US",
        timezone: "UTC",
        mark: "OS",
        currency: "USD",
        week_start: "monday",
        business_hours: "09:00–18:00",
        theme: "slate",
        revision: 1,
        today: "2026-10-07",
        purge_enabled: true,
      });
    if (path === "/api/boards/import") {
      expect(route.request().headers()["content-type"]).toBe(
        "application/octet-stream",
      );
      writes.push(route.request().postDataBuffer()!);
      imported = true;
      return route.fulfill({
        status: 201,
        headers: { Location: `/api/boards/${newBoardId}` },
        json: { ...boardResponse(newBoardId, 1), name: "Named query board" },
      });
    }
    if (path === `/api/boards/${boardId}/configuration`)
      return route.fulfill({
        contentType: "application/json",
        body: exact,
        headers: {
          "Content-Disposition":
            'attachment; filename="board-configuration.json"',
        },
      });
    if (path === "/api/boards")
      return json(
        pageOf(
          imported
            ? [
                boardResponse(boardId),
                { ...boardResponse(newBoardId, 1), name: "Named query board" },
              ]
            : [boardResponse(boardId)],
        ),
      );
    if (path === `/api/boards/${boardId}`) return json(boardResponse(boardId));
    if (path === `/api/boards/${newBoardId}`)
      return json({
        ...boardResponse(newBoardId, 1),
        name: "Named query board",
      });
    if (path.endsWith("/my-access"))
      return json({ level: "manage", read: true, write: true, manage: true });
    if (path.endsWith("/widgets"))
      return json({
        ...pageOf([], 12),
        board_revision: imported && path.includes(newBoardId) ? 1 : 4,
      });
    return route.fulfill({ status: 404, json: { detail: "No route fixture" } });
  });
  await page.goto(`/boards?board=${boardId}`);
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Configurations", exact: true })
    .click();
  const panel = page.getByRole("dialog", {
    name: "Board configurations",
    exact: true,
  });
  await panel
    .getByRole("button", { name: "Export configuration", exact: true })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await panel
    .getByRole("link", { name: "Download configuration", exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("board-configuration.json");
  const path = await download.path();
  if (!path) throw new Error("A real configuration download is required");
  const bytes = await readFile(path);
  expect(bytes.toString()).toBe(exact);
  expect(JSON.parse(bytes.toString())).toEqual(s26NamedBundle);
  await panel
    .getByLabel("Board configuration file", { exact: true })
    .setInputFiles({
      name: "named.json",
      mimeType: "application/json",
      buffer: bytes,
    });
  await panel
    .getByRole("button", { name: "Import configuration", exact: true })
    .click();
  const confirm = page.getByRole("alertdialog", {
    name: "Import Board configuration?",
    exact: true,
  });
  await confirm
    .getByRole("button", { name: "Create project Board", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Named query board", exact: true }),
  ).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.toString()).toBe(exact);
});

function boardResponse(id = boardId, revision = 4) {
  return {
    id,
    scope: id === boardId ? "department" : "project",
    department_id: id === boardId ? departmentId : null,
    name: "Dispatch",
    description: "Daily handoffs",
    status: "active",
    revision,
    level: "manage",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

test("portability panel explains structure-only scope and hides stale Board actions", () => {
  const html = renderToStaticMarkup(
    createElement(ServerBoardPortabilityDisplay, {
      board,
      source: { ...board, revision: 5 },
      sourceStatus: "ready",
      canDuplicate: true,
      pending: null,
      selectedFileName: null,
      preparedFilename: null,
      error: null,
      notice: null,
    }),
  );
  expect(html).toContain("name, description and widgets");
  expect(html).toContain("does not include posts, events, files");
  expect(html).toContain("Import configuration");
  expect(html).toContain("Refresh the Board");
  expect(html).not.toContain("Export configuration");
  expect(html).not.toContain("Duplicate Board");
  expect(html).not.toContain(boardId);
  expect(html).not.toContain(departmentId);
});

test("import remains available without a selected Board and names the new project Board outcome", () => {
  const html = renderToStaticMarkup(
    createElement(ServerBoardPortabilityDisplay, {
      board: null,
      selectedFileName: "structure.json",
    }),
  );
  expect(html).toContain("Import configuration");
  expect(html).toContain("new project Board");
  expect(html).not.toContain("Current Board structure");
  expect(html).not.toContain("Export configuration");
  expect(html).not.toContain("Duplicate Board");
});

test("prepared export offers only the validated download and unavailable source hides Board actions", () => {
  const prepared = renderToStaticMarkup(
    createElement(ServerBoardPortabilityDisplay, {
      board,
      source: board,
      sourceStatus: "ready",
      canDuplicate: true,
      preparedFilename: "board-configuration.json",
      preparedUrl: "blob:http://localhost/configuration",
    }),
  );
  expect(prepared).toContain("Export configuration");
  expect(prepared).toContain("Duplicate Board");
  expect(prepared).toContain('download="board-configuration.json"');
  expect(prepared).not.toContain(boardId);

  const unavailable = renderToStaticMarkup(
    createElement(ServerBoardPortabilityDisplay, {
      board,
      sourceStatus: "unavailable",
    }),
  );
  expect(unavailable).toContain("Retry Board access");
  expect(unavailable).toContain("Import configuration");
  expect(unavailable).not.toContain("Export configuration");
  expect(unavailable).not.toContain("Duplicate Board");
});

test("export rechecks the selected Board and rejects a stale revision before fetching bytes", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    if (path === `/api/boards/${boardId}`)
      return Promise.resolve(Response.json(boardResponse(boardId, 5)));
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  try {
    await expect(prepareBoardConfiguration(board)).rejects.toMatchObject({
      status: 409,
    });
    expect(paths).toEqual([`/api/boards/${boardId}`]);
  } finally {
    globalThis.fetch = original;
  }
});

test("export returns adapter-validated structure without requesting Record bytes", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  const bundle = {
    kind: "openslate-board",
    version: 3,
    configuration: {
      name: "Dispatch",
      description: "Daily handoffs",
      widgets: [],
    },
  };
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    if (path === `/api/boards/${boardId}`)
      return Promise.resolve(Response.json(boardResponse()));
    if (path === `/api/boards/${boardId}/configuration`)
      return Promise.resolve(
        Response.json(bundle, {
          headers: {
            "Content-Disposition":
              'attachment; filename="board-configuration.json"',
          },
        }),
      );
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  try {
    const prepared = await prepareBoardConfiguration(board);
    expect(prepared.filename).toBe("board-configuration.json");
    expect(prepared.bundle).toEqual(bundle);
    expect(JSON.parse(await prepared.blob.text())).toEqual(bundle);
    expect(paths).toEqual([
      `/api/boards/${boardId}`,
      `/api/boards/${boardId}/configuration`,
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("duplicate requires current server-confirmed manage access and returns a different Board ID", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  let manage = false;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    if (path === `/api/boards/${boardId}`)
      return Promise.resolve(Response.json(boardResponse()));
    if (path.endsWith("/my-access"))
      return Promise.resolve(
        Response.json({
          level: manage ? "manage" : "read",
          read: true,
          write: manage,
          manage,
        }),
      );
    if (path === `/api/boards/${boardId}/duplicate`)
      return Promise.resolve(
        Response.json(boardResponse(newBoardId, 1), { status: 201 }),
      );
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  try {
    await expect(duplicateCurrentBoardStructure(board)).rejects.toEqual(
      expect.objectContaining({ status: 403 }),
    );
    expect(paths).not.toContain(`/api/boards/${boardId}/duplicate`);
    manage = true;
    await expect(duplicateCurrentBoardStructure(board)).resolves.toMatchObject({
      id: newBoardId,
      scope: "project",
    });
    expect(paths).toContain(`/api/boards/${boardId}/duplicate`);
  } finally {
    globalThis.fetch = original;
  }
});

test("Board read denial prevents both export and duplicate requests", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  const denied: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    paths.push(String(input));
    return Promise.resolve(
      Response.json({ detail: "Board not found" }, { status: 404 }),
    );
  }) as typeof fetch;
  try {
    for (const action of [
      prepareBoardConfiguration,
      duplicateCurrentBoardStructure,
    ]) {
      await expect(
        action(board, (id) => denied.push(id)),
      ).rejects.toBeInstanceOf(ApiError);
    }
    expect(paths).toEqual([`/api/boards/${boardId}`, `/api/boards/${boardId}`]);
    expect(denied).toEqual([boardId, boardId]);
  } finally {
    globalThis.fetch = original;
  }
});

test("downstream export denial clears the Board only when a new Board read is denied", async () => {
  const original = globalThis.fetch;
  try {
    for (const viewLost of [true, false]) {
      const paths: string[] = [];
      const denied: string[] = [];
      let reads = 0;
      const deniedStatus = viewLost ? 403 : 404;
      globalThis.fetch = ((input: RequestInfo | URL) => {
        const path = String(input);
        paths.push(path);
        if (path === `/api/boards/${boardId}`) {
          reads += 1;
          return Promise.resolve(
            reads === 2 && viewLost
              ? Response.json({ detail: "Forbidden" }, { status: 403 })
              : Response.json(boardResponse()),
          );
        }
        if (path === `/api/boards/${boardId}/configuration`)
          return Promise.resolve(
            Response.json({ detail: "Unavailable" }, { status: deniedStatus }),
          );
        throw new Error(`Unexpected request: ${path}`);
      }) as typeof fetch;
      await expect(
        prepareBoardConfiguration(board, (id) => denied.push(id)),
      ).rejects.toMatchObject({ status: deniedStatus });
      expect(paths).toEqual([
        `/api/boards/${boardId}`,
        `/api/boards/${boardId}/configuration`,
        `/api/boards/${boardId}`,
      ]);
      expect(denied).toEqual(viewLost ? [boardId] : []);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("downstream duplicate denial distinguishes lost Board view from lost manage access", async () => {
  const original = globalThis.fetch;
  try {
    for (const viewLost of [true, false]) {
      const paths: string[] = [];
      const denied: string[] = [];
      let reads = 0;
      globalThis.fetch = ((input: RequestInfo | URL) => {
        const path = String(input);
        paths.push(path);
        if (path === `/api/boards/${boardId}`) {
          reads += 1;
          return Promise.resolve(
            reads === 2 && viewLost
              ? Response.json({ detail: "Board not found" }, { status: 404 })
              : Response.json(boardResponse()),
          );
        }
        if (path.endsWith("/my-access"))
          return Promise.resolve(
            Response.json({
              level: "manage",
              read: true,
              write: true,
              manage: true,
            }),
          );
        if (path === `/api/boards/${boardId}/duplicate`)
          return Promise.resolve(
            Response.json({ detail: "Board not found" }, { status: 404 }),
          );
        throw new Error(`Unexpected request: ${path}`);
      }) as typeof fetch;
      await expect(
        duplicateCurrentBoardStructure(board, (id) => denied.push(id)),
      ).rejects.toMatchObject({ status: 404 });
      expect(paths).toEqual([
        `/api/boards/${boardId}`,
        `/api/boards/${boardId}/my-access`,
        `/api/boards/${boardId}/duplicate`,
        `/api/boards/${boardId}`,
      ]);
      expect(denied).toEqual(viewLost ? [boardId] : []);
    }
  } finally {
    globalThis.fetch = original;
  }
});
