import { expect, test, type Page } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../src/lib/api";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import type {
  BoardManagementBoard,
  BoardPurgePreview,
} from "../../src/components/systems/boards/adapters/board-management-api";
import {
  ServerBoardManagementDisplay,
  boardCreateForDraft,
  boardUpdateForDraft,
  rebaseBoardDraft,
  revokeBoardManagementState,
  type BoardManagementDraft,
  type BoardManagementView,
} from "../../src/components/systems/boards/components/server-backed-board-management";

const boardId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const departmentId = "00000000-0000-4000-8000-000000000003";
const board: BoardManagementBoard = {
  id: boardId,
  scope: "project",
  departmentId: null,
  name: "Dispatch",
  description: "Daily handoffs",
  status: "active",
  revision: 4,
  level: "manage",
  createdAt: "2026-09-23T00:00:00Z",
  updatedAt: "2026-09-23T00:00:00Z",
};
const departmentBoard: BoardManagementBoard = {
  ...board,
  scope: "department",
  departmentId,
  name: "Operations",
};
const draft: BoardManagementDraft = {
  name: "Dispatch updated",
  description: "Keep my draft",
};
const baseView: BoardManagementView = {
  mode: "manage",
  board: departmentBoard,
  access: "ready",
  canManage: true,
  draft,
  pending: false,
  conflict: false,
  error: null,
  notice: null,
};

function markup(view: BoardManagementView): string {
  return renderToStaticMarkup(
    createElement(ServerBoardManagementDisplay, { view }),
  );
}

const purgePreview: BoardPurgePreview = {
  impact: {
    target_type: "board",
    target_id: boardId,
    operation: "purge",
    actor_id: actorId,
    rows: [],
    external_impacts: [],
    key_strips: [],
    blockers: [],
    impact_digest: "a".repeat(64),
  },
  token: "server-issued-challenge",
  expires_at: "2026-09-25T00:00:00Z",
  confirmation_name: boardId,
};

function purgeRow(entityType: string, entityId: string) {
  return {
    entity_type: entityType,
    entity_id: entityId,
    is_deleted: true,
    deleted_at: "2026-09-24T00:00:00Z",
    updated_at: "2026-09-24T00:00:00Z",
    state_fingerprint: "synthetic-state",
  };
}

async function installArchivedBoard(page: Page) {
  await installOpenViewEventSource(page);
  const workspace = {
    display_name: "OpenSlate",
    mark: "OS",
    logo_file_id: null,
    revision: 1,
    today: "2026-09-25",
    week_start: "monday",
    locale: "en-US",
    timezone: "UTC",
    purge_enabled: true as boolean | undefined,
  };
  let workspaceFailure = false;
  const archived = {
    id: boardId,
    scope: "project",
    department_id: null,
    name: board.name,
    description: board.description,
    status: "archived",
    revision: board.revision,
    level: "manage",
    created_at: board.createdAt,
    updated_at: board.updatedAt,
  };
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({
        json: { authenticated: true, user_id: actorId, setup_required: false },
      });
    if (path === "/api/auth/me")
      return route.fulfill({
        json: { id: actorId, role: "admin", access: [] },
      });
    if (path === "/api/workspace")
      return route.fulfill(
        workspaceFailure
          ? { status: 503, json: { detail: "Workspace unavailable" } }
          : { json: workspace },
      );
    if (path === "/api/boards")
      return route.fulfill({
        json: {
          items: [archived],
          pagination: {
            limit: 25,
            offset: 0,
            count: 1,
            total: 1,
            has_more: false,
          },
        },
      });
    if (path === `/api/boards/${boardId}`)
      return route.fulfill({ json: archived });
    if (path === `/api/boards/${boardId}/my-access`)
      return route.fulfill({
        json: { level: "manage", read: true, write: true, manage: true },
      });
    if (path === `/api/boards/${boardId}/groups`)
      return route.fulfill({
        json: { board_id: boardId, revision: board.revision, groups: [] },
      });
    return route.fulfill({
      json: {
        items: [],
        pagination: {
          limit: 25,
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
        board_revision: board.revision,
      },
    });
  });
  return {
    workspace,
    failWorkspaceRead: (failed: boolean) => {
      workspaceFailure = failed;
    },
  };
}

test("a new Board is a project Board with only a name and description", () => {
  const html = markup({ ...baseView, mode: "create", board: null });
  expect(html).toContain("Create Board");
  expect(html).not.toContain("Department");
  expect(html).not.toContain("Default section");
  expect(boardCreateForDraft(draft)).toEqual({
    name: "Dispatch updated",
    description: "Keep my draft",
  });
});

test("a department Board keeps its department name and cannot be archived", () => {
  const html = markup({ ...baseView, draft: { ...draft, name: "Operations" } });
  expect(html).toContain("always has its department");
  expect(html).toContain("readOnly");
  expect(html).not.toContain("Archive Board");
  expect(html).toContain("archived when its department closes");
  expect(boardUpdateForDraft(departmentBoard, draft)).toEqual({
    revision: 4,
    description: "Keep my draft",
  });
  expect(
    boardUpdateForDraft(departmentBoard, {
      name: "Renamed",
      description: "Daily handoffs",
    }),
  ).toBeNull();
});

test("the company Board can be renamed but not archived", () => {
  const company = { ...board, scope: "company" as const, name: "Company" };
  const html = markup({
    ...baseView,
    board: company,
    draft: { name: "Company", description: "Daily handoffs" },
  });
  expect(html).not.toContain("Archive Board");
  expect(html).toContain("The company Board is always open.");
  expect(boardUpdateForDraft(company, { ...draft, name: "Everyone" })).toEqual({
    revision: 4,
    name: "Everyone",
    description: "Keep my draft",
  });
});

test("a project Board shows its group editor slot and can be archived", () => {
  const html = renderToStaticMarkup(
    createElement(ServerBoardManagementDisplay, {
      view: { ...baseView, board, draft },
      groups: createElement("p", null, "Group editor slot"),
    }),
  );
  expect(html).toContain("Group editor slot");
  expect(html.indexOf("Group editor slot")).toBeLessThan(
    html.indexOf("Archive Board"),
  );
  expect(
    renderToStaticMarkup(
      createElement(ServerBoardManagementDisplay, {
        view: baseView,
        groups: createElement("p", null, "Group editor slot"),
      }),
    ),
  ).not.toContain("Group editor slot");
  expect(boardUpdateForDraft(board, draft)).toEqual({
    revision: 4,
    name: "Dispatch updated",
    description: "Keep my draft",
  });
});

test("existing Board management requires server-confirmed manage access", () => {
  for (const view of [
    { ...baseView, access: "loading" as const, canManage: false },
    { ...baseView, access: "denied" as const, canManage: false },
    { ...baseView, access: "ready" as const, canManage: false },
  ]) {
    const html = markup(view);
    expect(html).not.toContain("Keep my draft");
    expect(html).not.toContain("Save changes");
    expect(html).not.toContain("Archive Board");
  }
});

test("revision conflict retains the draft and blocks unreviewed overwrite", () => {
  const html = markup({ ...baseView, conflict: true });
  expect(html).toContain("Keep my draft");
  expect(html).toContain("Board changed elsewhere");
  expect(html).toContain("Refresh latest Board");
  expect(html).toMatch(/disabled=""[^>]*>Save changes/);
});

test("conflict retry reapplies only locally changed fields onto the latest Board", () => {
  const latest = {
    ...board,
    revision: 5,
    description: "Changed remotely",
  };
  const originalDraft = { ...draft, description: "Daily handoffs" };
  expect(rebaseBoardDraft(board, latest, originalDraft)).toEqual({
    name: "Dispatch updated",
    description: "Changed remotely",
  });
});

test("Board access revocation clears private management state and invalidates pending responses", () => {
  const accessRequest = { current: 2 };
  const actionRequest = { current: 4 };
  let currentBoard: BoardManagementBoard | null = board;
  let currentDraft = draft;
  let currentDraftBase: BoardManagementBoard | null = board;
  let access = "ready";
  let conflict = true;
  let latestReady = true;
  let error: string | null = "Old error";
  let notice: string | null = "Private notice";
  let confirmation: string | null = "archive";
  let discardOpen = true;
  let notifications = 0;
  revokeBoardManagementState({
    accessRequest,
    actionRequest,
    setBoard: (value) => {
      currentBoard = value;
    },
    setDraft: (value) => {
      currentDraft = value;
    },
    setDraftBase: (value) => {
      currentDraftBase = value;
    },
    setAccess: (value) => {
      access = value;
    },
    setConflict: (value) => {
      conflict = value;
    },
    setLatestReady: (value) => {
      latestReady = value;
    },
    setError: (value) => {
      error = value;
    },
    setNotice: (value) => {
      notice = value;
    },
    setConfirmation: (value) => {
      confirmation = value;
    },
    setDiscardOpen: (value) => {
      discardOpen = value;
    },
    onAccessDenied: () => {
      notifications += 1;
    },
  });
  expect([currentBoard, currentDraftBase]).toEqual([null, null]);
  expect(currentDraft).toEqual({ name: "", description: "" });
  expect([
    access,
    conflict,
    latestReady,
    error,
    notice,
    confirmation,
    discardOpen,
  ]).toEqual(["denied", false, false, null, null, null, false]);
  expect([accessRequest.current, actionRequest.current]).toEqual([3, 5]);
  expect(notifications).toBe(1);
});

test("manage-only denial clears its editor without revoking the authorized Board", () => {
  let boardRevocations = 0;
  const noOp = () => undefined;
  revokeBoardManagementState(
    {
      accessRequest: { current: 0 },
      actionRequest: { current: 0 },
      setBoard: noOp,
      setDraft: noOp,
      setDraftBase: noOp,
      setAccess: noOp,
      setConflict: noOp,
      setLatestReady: noOp,
      setError: noOp,
      setNotice: noOp,
      setConfirmation: noOp,
      setDiscardOpen: noOp,
      onAccessDenied: () => {
        boardRevocations += 1;
      },
    },
    false,
  );
  expect(boardRevocations).toBe(0);
});

test("archived project Board offers restore without editable metadata", () => {
  const html = markup({
    ...baseView,
    board: { ...board, status: "archived" },
  });
  expect(html).toContain("Restore Board");
  expect(html).not.toContain("Save changes");
});

test("archived Board permanent-deletion controls are hidden from non-admins", () => {
  const html = renderToStaticMarkup(
    createElement(ServerBoardManagementDisplay, {
      view: { ...baseView, board: { ...board, status: "archived" } },
      purgePreview,
      isAdmin: false,
    } as Parameters<typeof ServerBoardManagementDisplay>[0]),
  );
  expect(html).not.toContain("Permanent deletion");
  expect(html).not.toContain("Permanently delete Board");
  expect(html).toContain("Restore Board");
});

for (const state of ["disabled", "unknown", "unavailable"] as const) {
  test(`an archived Board remains restorable while permanent deletion is ${state}`, async ({
    page,
  }) => {
    const api = await installArchivedBoard(page);
    api.workspace.purge_enabled = state === "unknown" ? undefined : false;
    api.failWorkspaceRead(state === "unavailable");
    await page.goto(
      `/boards?board=${boardId}&section=overview&status=archived`,
    );
    await page.getByRole("button", { name: "Board menu", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Manage Board and groups", exact: true })
      .click();
    const manage = page.getByRole("dialog", { name: "Manage Board" });
    await expect(
      manage.getByRole("button", { name: "Restore Board" }),
    ).toBeEnabled();
    await expect(
      manage.getByRole("button", {
        name: "Permanently delete Board",
        exact: true,
      }),
    ).toHaveCount(0);
  });
}

test("Board purge preserves safe lifecycle messages when the server returns their actual status", async () => {
  const management =
    (await import("../../src/components/systems/boards/components/server-backed-board-management")) as unknown as {
      boardPurgeFailureMessage: (
        error: unknown,
        stage: "preview" | "execute",
      ) => string;
    };
  expect(typeof management.boardPurgeFailureMessage).toBe("function");
  expect(
    management.boardPurgeFailureMessage(
      new ApiError(
        403,
        "Permanent Board deletion is disabled",
        undefined,
        "purge_disabled",
      ),
      "preview",
    ),
  ).toBe("Permanent Board deletion is disabled");
  expect(
    management.boardPurgeFailureMessage(
      new ApiError(
        422,
        "The Board ID confirmation did not match",
        undefined,
        "confirmation_name_mismatch",
      ),
      "execute",
    ),
  ).toBe("The Board ID confirmation did not match");
});

test("Board purge explains its impact and keeps stale challenges recoverable without losing access", async ({
  page,
}) => {
  const api = await installArchivedBoard(page);
  let previews = 0;
  let deletions = 0;
  const preview: BoardPurgePreview = {
    ...purgePreview,
    impact: {
      ...purgePreview.impact,
      rows: [
        purgeRow("boards", boardId),
        purgeRow("board_posts", actorId),
        purgeRow("board_posts", departmentId),
      ],
      external_impacts: [
        {
          edge_id: actorId,
          field_id: actorId,
          external_record_id: departmentId,
          external_record_label: "Dispatch handoff 24",
          external_module_id: departmentId,
          external_module_name: "Dispatch records",
          external_department_id: departmentId,
          external_department_name: "Operations",
        },
      ],
    },
  };
  await page.route(`**/api/boards/${boardId}/purge**`, (route) => {
    if (route.request().url().endsWith("/preview")) {
      previews += 1;
      return route.fulfill({
        json:
          previews < 4
            ? preview
            : {
                ...preview,
                impact: {
                  ...preview.impact,
                  blockers: [
                    {
                      code: "purge_file_dependency",
                      entity_type: "files",
                      entity_id: actorId,
                      detail:
                        "Purge the attached file before deleting this Board.",
                      conflicting_entity_type: null,
                      conflicting_entity_id: null,
                      field_id: null,
                      field_name: null,
                      module_id: null,
                      module_name: null,
                      department_id: null,
                      department_name: null,
                    },
                  ],
                },
              },
      });
    }
    deletions += 1;
    return route.fulfill({
      status: deletions === 1 ? 404 : 403,
      json: {
        detail: {
          code:
            deletions === 1
              ? "challenge_not_found"
              : "challenge_binding_mismatch",
          message: "Untrusted internal challenge detail",
        },
      },
    });
  });
  await page.goto(`/boards?board=${boardId}&section=overview&status=archived`);
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Manage Board and groups", exact: true })
    .click();
  const manage = page.getByRole("dialog", { name: "Manage Board" });
  const begin = manage.getByRole("button", {
    name: "Permanently delete Board",
    exact: true,
  });
  await begin.click();
  await expect(
    manage.getByText("This permanently removes 1 Board and 2 posts."),
  ).toBeVisible();
  await expect(manage.getByText(boardId, { exact: true })).toBeVisible();
  await expect(manage.getByLabel("Administrator password")).toBeVisible();
  api.failWorkspaceRead(true);
  await sendOpenViewEvent(page, "invalidate", { entity: "workspace_profiles" });
  await expect(manage.getByLabel("Administrator password")).toHaveCount(0);
  await expect(
    manage.getByRole("button", { name: "Restore Board" }),
  ).toBeEnabled();
  expect(deletions).toBe(0);
  api.failWorkspaceRead(false);
  await sendOpenViewEvent(page, "invalidate", { entity: "workspace_profiles" });
  await begin.click();
  await expect(manage.getByLabel("Administrator password")).toBeVisible();
  await expect(manage.getByText(/Dispatch records.*Operations/)).toBeVisible();
  await expect(
    manage.getByText(/Dispatch handoff 24.*Dispatch records.*Operations/),
  ).toBeVisible();
  const confirm = manage.getByRole("button", {
    name: "Confirm permanent deletion",
    exact: true,
  });
  const destructiveColor = await confirm.evaluate((element) => {
    const sample = document.createElement("span");
    sample.style.color = "var(--destructive)";
    document.body.append(sample);
    const expected = getComputedStyle(sample).color;
    sample.remove();
    return { expected, actual: getComputedStyle(element).backgroundColor };
  });
  expect(destructiveColor.actual).toBe(destructiveColor.expected);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await manage.getByLabel("Type the Board ID").fill(boardId);
    await manage
      .getByLabel("Administrator password")
      .fill("synthetic-test-passphrase");
    await confirm.click();
    await expect(
      manage.getByText("The review is unavailable. Request a new review."),
    ).toBeVisible();
    await expect(
      manage.getByRole("button", { name: "Restore Board" }),
    ).toBeVisible();
    await manage
      .getByRole("button", { name: "Review again", exact: true })
      .click();
    if (attempt === 0)
      await expect(manage.getByLabel("Administrator password")).toHaveValue("");
  }
  await expect(manage.getByRole("alert")).toContainText(
    "Purge the attached file before deleting this Board.",
  );
  await expect(manage.getByLabel("Administrator password")).toHaveCount(0);
  await expect(confirm).toHaveCount(0);
  expect(deletions).toBe(2);
});

test("Board creation closes its form and confirms the created Board", async ({
  page,
}) => {
  await installArchivedBoard(page);
  const created = {
    id: departmentId,
    scope: "project",
    department_id: null,
    name: "New dispatch",
    description: "Owned feedback journey",
    status: "active",
    revision: 1,
    level: "manage",
    created_at: board.createdAt,
    updated_at: board.updatedAt,
  };
  await page.route("**/api/boards", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 201, json: created })
      : route.fallback(),
  );
  await page.route(`**/api/boards/${departmentId}`, (route) =>
    route.fulfill({ json: created }),
  );
  await page.route(`**/api/boards/${departmentId}/my-access`, (route) =>
    route.fulfill({
      json: { level: "manage", read: true, write: true, manage: true },
    }),
  );
  await page.goto(`/boards?board=${boardId}&section=overview&status=archived`);
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "New project Board", exact: true })
    .click();
  const form = page.getByRole("dialog", { name: "New project Board" });
  await form.getByLabel("Board name").fill(created.name);
  await form.getByRole("button", { name: "Create Board", exact: true }).click();
  await expect(form).toBeHidden();
  await expect(
    page
      .getByRole("region", { name: "Notifications", exact: true })
      .getByText("Board created.", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Notifications", exact: true })
      .getByText("Board created.", { exact: true }),
  ).toHaveCount(1);
});

test("Board permanent deletion closes its review and confirms completion", async ({
  page,
}) => {
  await installArchivedBoard(page);
  await page.route(`**/api/boards/${boardId}/purge**`, (route) =>
    route.request().url().endsWith("/preview")
      ? route.fulfill({ json: purgePreview })
      : route.fulfill({
          json: {
            impact: purgePreview.impact,
            operation_id: null,
          },
        }),
  );
  await page.goto(`/boards?board=${boardId}&section=overview&status=archived`);
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Manage Board and groups", exact: true })
    .click();
  const form = page.getByRole("dialog", { name: "Manage Board" });
  await form
    .getByRole("button", { name: "Permanently delete Board", exact: true })
    .click();
  await form.getByLabel("Type the Board ID").fill(boardId);
  await form
    .getByLabel("Administrator password")
    .fill("synthetic-owned-passphrase");
  await form
    .getByRole("button", { name: "Confirm permanent deletion", exact: true })
    .click();
  await expect(form).toBeHidden();
  await expect(
    page
      .getByRole("region", { name: "Notifications", exact: true })
      .getByText("Board permanently deleted.", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Notifications", exact: true })
      .getByText("Board permanently deleted.", { exact: true }),
  ).toHaveCount(1);
});
