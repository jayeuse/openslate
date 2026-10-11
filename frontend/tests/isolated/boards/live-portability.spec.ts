import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../../src/lib/api";
import type { BoardManagementBoard } from "../../../src/components/systems/boards/adapters/board-management-api";
import { ServerBoardPortabilityDisplay } from "../../../src/components/systems/boards/components/server-backed-board-portability";
import {
  duplicateCurrentBoardStructure,
  prepareBoardConfiguration,
} from "../../../src/components/systems/boards/hooks/use-server-board-portability";

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
