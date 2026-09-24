import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiContractError } from "../../src/lib/api";
import type {
  BoardManagementBoard,
  BoardTemplate,
} from "../../src/components/systems/boards/adapters/board-management-api";
import { ServerBoardTemplatesDisplay } from "../../src/components/systems/boards/components/server-backed-board-templates";
import {
  emptyBoardTemplatesState,
  instantiateListedBoardTemplate,
  loadBoardTemplates,
  saveCurrentBoardTemplate,
  transitionBoardTemplates,
} from "../../src/components/systems/boards/hooks/use-server-board-templates";

const boardId = "00000000-0000-4000-8000-000000000001";
const otherBoardId = "00000000-0000-4000-8000-000000000002";
const ownerId = "00000000-0000-4000-8000-000000000003";
const templateId = "00000000-0000-4000-8000-000000000004";
const timestamp = "2026-09-23T00:00:00Z";
const board: BoardManagementBoard = {
  id: boardId,
  ownerId,
  departmentId: null,
  name: "Dispatch",
  description: "Daily handoffs",
  status: "active",
  defaultSection: "overview",
  revision: 4,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const template: BoardTemplate = {
  id: templateId,
  name: "Dispatch template",
  widgetCount: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function boardResponse(revision = 4) {
  return {
    id: boardId,
    owner_id: ownerId,
    department_id: null,
    name: "Dispatch",
    description: "Daily handoffs",
    status: "active",
    default_section: "overview",
    revision,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function templateResponse() {
  return {
    id: templateId,
    name: template.name,
    widget_count: 2,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

test("template list is complete, workspace-authorized and paired with current Board access", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    if (path.startsWith("/api/board-templates?"))
      return Promise.resolve(
        Response.json({
          items: [templateResponse()],
          pagination: {
            limit: 50,
            offset: 0,
            count: 1,
            total: 1,
            has_more: false,
          },
        }),
      );
    if (path.endsWith("/my-access"))
      return Promise.resolve(
        Response.json({ view: true, edit: true, manage: true }),
      );
    if (path === `/api/boards/${boardId}`)
      return Promise.resolve(Response.json(boardResponse()));
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  try {
    await expect(loadBoardTemplates(board)).resolves.toEqual({
      templates: [template],
      source: board,
      canManage: true,
    });
    expect(paths).toEqual(
      expect.arrayContaining([
        "/api/board-templates?limit=50&offset=0&sort_by=name&sort_order=asc",
        `/api/boards/${boardId}/my-access`,
        `/api/boards/${boardId}`,
      ]),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("partial template pages and global denial never become usable lists", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({
        items: [templateResponse()],
        pagination: {
          limit: 50,
          offset: 0,
          count: 1,
          total: 2,
          has_more: true,
        },
      }),
    )) as typeof fetch;
  try {
    await expect(loadBoardTemplates(null)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    globalThis.fetch = original;
  }
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({ detail: "Denied" }, { status: 403 }),
    )) as typeof fetch;
  try {
    await expect(loadBoardTemplates(null)).rejects.toMatchObject({
      status: 403,
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("switch and authorization denial clear private template rows and stale responses", () => {
  const loading = transitionBoardTemplates(emptyBoardTemplatesState, {
    type: "begin",
    key: boardId,
    sequence: 1,
  });
  const ready = transitionBoardTemplates(loading, {
    type: "resolve",
    key: boardId,
    sequence: 1,
    templates: [template],
    source: board,
    canManage: true,
  });
  expect(ready.templates).toEqual([template]);
  const switched = transitionBoardTemplates(ready, {
    type: "begin",
    key: otherBoardId,
    sequence: 2,
  });
  expect(switched.templates).toBeNull();
  expect(switched.source).toBeNull();
  expect(
    transitionBoardTemplates(switched, {
      type: "resolve",
      key: boardId,
      sequence: 1,
      templates: [template],
      source: board,
      canManage: true,
    }),
  ).toEqual(switched);
  const denied = transitionBoardTemplates(ready, {
    type: "reject",
    key: boardId,
    sequence: 1,
    error: "Access unavailable",
    retain: false,
  });
  expect(denied.templates).toBeNull();
  expect(denied.source).toBeNull();
  expect(denied.canManage).toBe(false);
});

test("save rechecks Board manage access and exact revision before writing", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    if (path.endsWith("/my-access"))
      return Promise.resolve(
        Response.json({ view: true, edit: true, manage: true }),
      );
    if (path === `/api/boards/${boardId}`)
      return Promise.resolve(Response.json(boardResponse(5)));
    throw new Error(`Unexpected write: ${path}`);
  }) as typeof fetch;
  try {
    await expect(
      saveCurrentBoardTemplate(board, "  Dispatch  "),
    ).rejects.toMatchObject({ status: 409 });
    expect(paths).not.toContain("/api/board-templates");
  } finally {
    globalThis.fetch = original;
  }
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    if (path.endsWith("/my-access"))
      return Promise.resolve(
        Response.json({ view: true, edit: true, manage: false }),
      );
    if (path === `/api/boards/${boardId}`)
      return Promise.resolve(Response.json(boardResponse()));
    throw new Error(`Unexpected write: ${path}`);
  }) as typeof fetch;
  try {
    await expect(
      saveCurrentBoardTemplate(board, "Dispatch"),
    ).rejects.toMatchObject({ status: 403 });
    expect(paths).not.toContain("/api/board-templates");
  } finally {
    globalThis.fetch = original;
  }
});

test("save and instantiate use only verified server IDs and return new Board", async () => {
  const original = globalThis.fetch;
  const requests: { path: string; method?: string; body?: string }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push({
      path,
      method: init?.method,
      body: String(init?.body ?? ""),
    });
    if (path.endsWith("/my-access"))
      return Promise.resolve(
        Response.json({ view: true, edit: true, manage: true }),
      );
    if (path === `/api/boards/${boardId}`)
      return Promise.resolve(Response.json(boardResponse()));
    if (path === "/api/board-templates" && init?.method === "POST")
      return Promise.resolve(
        Response.json(templateResponse(), { status: 201 }),
      );
    if (path === `/api/board-templates/${templateId}`)
      return Promise.resolve(Response.json(templateResponse()));
    if (path === `/api/board-templates/${templateId}/boards`)
      return Promise.resolve(
        Response.json(
          {
            ...boardResponse(),
            id: otherBoardId,
            revision: 1,
          },
          { status: 201 },
        ),
      );
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  try {
    await expect(
      saveCurrentBoardTemplate(board, "  Dispatch template  "),
    ).resolves.toEqual(template);
    await expect(
      instantiateListedBoardTemplate(template),
    ).resolves.toMatchObject({
      id: otherBoardId,
      status: "active",
    });
    expect(
      JSON.parse(
        requests.find((request) => request.path === "/api/board-templates")!
          .body!,
      ),
    ).toEqual({
      board_id: boardId,
      name: "Dispatch template",
    });
    expect(requests.map((request) => request.path)).toContain(
      `/api/board-templates/${templateId}/boards`,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("template changed or removed after listing cannot be instantiated from stale selection", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    return Promise.resolve(
      Response.json({ ...templateResponse(), name: "Changed template" }),
    );
  }) as typeof fetch;
  try {
    await expect(
      instantiateListedBoardTemplate(template),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(paths).toEqual([`/api/board-templates/${templateId}`]);
  } finally {
    globalThis.fetch = original;
  }
});

test("template panel is structure-only and hides current Board save unless server confirms manager", () => {
  const ready = transitionBoardTemplates(
    transitionBoardTemplates(emptyBoardTemplatesState, {
      type: "begin",
      key: boardId,
      sequence: 1,
    }),
    {
      type: "resolve",
      key: boardId,
      sequence: 1,
      templates: [template],
      source: board,
      canManage: false,
    },
  );
  const html = renderToStaticMarkup(
    createElement(ServerBoardTemplatesDisplay, { state: ready, board }),
  );
  expect(html).toContain("Dispatch template");
  expect(html).toContain("2 widgets");
  expect(html).toContain("structure only");
  expect(html).not.toContain("Save current Board as template");
  expect(html).not.toContain(templateId);
  expect(html).not.toContain(ownerId);
  expect(html).not.toContain("Daily handoffs");
});
