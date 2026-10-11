import { expect, test, type Page } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyAppearancePreferences } from "../../src/lib/appearance-preferences";
import { ApiError } from "../../src/lib/api";
import { captureOpenViewReview } from "./helpers/openview-review-capture";
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

import { group as accessGroupFixture } from "../isolated/access/fixtures";
import { hideDevOverlay } from "./helpers/test-styles";
import { isEventStream } from "./helpers/test";

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
  confirmation_name: board.name,
  last_successful_backup_at: "2026-09-23T18:30:00Z",
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
    if (isEventStream(route)) return route.fallback();
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
  expect(html).toContain("Changed by someone else — review latest");
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
        "Permanent delete is turned off for this installation.",
        undefined,
        "purge_disabled",
      ),
      "preview",
    ),
  ).toBe("Permanent delete is turned off for this installation.");
  expect(
    management.boardPurgeFailureMessage(
      new ApiError(
        422,
        "The Board name confirmation did not match",
        undefined,
        "confirmation_name_mismatch",
      ),
      "execute",
    ),
  ).toBe("The Board name confirmation did not match");
});

test("Board purge explains its impact and keeps stale challenges recoverable without losing access", async ({
  page,
}) => {
  const api = await installArchivedBoard(page);
  let previews = 0;
  api.workspace.locale = "en-GB";
  api.workspace.timezone = "Asia/Manila";
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
  await expect(manage.getByText(board.name, { exact: true })).toBeVisible();
  await expect(manage.getByText(/Last successful backup/)).toHaveText(
    "Last successful backup: 24 Sept 2026, 02:30 · Asia/Manila",
  );
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
    await manage.getByLabel("Type the Board name").fill(board.name);
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
      .getByRole("region", { name: "Status messages", exact: true })
      .getByText("Board created.", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Status messages", exact: true })
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
  await form.getByLabel("Type the Board name").fill(board.name);
  await form
    .getByLabel("Administrator password")
    .fill("synthetic-owned-passphrase");
  await form
    .getByRole("button", { name: "Confirm permanent deletion", exact: true })
    .click();
  await expect(form).toBeHidden();
  await expect(
    page
      .getByRole("region", { name: "Status messages", exact: true })
      .getByText("Board permanently deleted.", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Status messages", exact: true })
      .getByText("Board permanently deleted.", { exact: true }),
  ).toHaveCount(1);
});

test("Board group picker finds groups beyond one hundred and preserves the selected label and draft", async ({
  page,
}) => {
  await installArchivedBoard(page);
  const activeBoard = {
    id: boardId,
    scope: "project",
    department_id: null,
    name: board.name,
    description: board.description,
    status: "active",
    revision: board.revision,
    level: "manage",
    created_at: board.createdAt,
    updated_at: board.updatedAt,
  };
  await page.route("**/api/boards", (route) =>
    route.fulfill({
      json: {
        items: [activeBoard],
        pagination: {
          limit: 25,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      },
    }),
  );
  await page.route(`**/api/boards/${boardId}`, (route) =>
    route.fulfill({ json: activeBoard }),
  );
  const choices = Array.from({ length: 125 }, (_, index) => ({
    ...accessGroupFixture,
    id: `00000000-0000-4000-8000-${String(index + 500).padStart(12, "0")}`,
    name:
      index === 124
        ? "Zora group beyond one hundred"
        : `Group ${String(index).padStart(3, "0")}`,
  }));
  const requests: string[] = [];
  await page.route("**/api/access/groups?*", (route) => {
    const url = new URL(route.request().url());
    requests.push(url.search);
    const search = (url.searchParams.get("search") ?? "").toLocaleLowerCase();
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    const filtered = choices.filter((choice) =>
      choice.name.toLocaleLowerCase().includes(search),
    );
    const items = filtered.slice(offset, offset + limit);
    return route.fulfill({
      json: {
        items,
        pagination: {
          limit,
          offset,
          count: items.length,
          total: filtered.length,
          has_more: offset + items.length < filtered.length,
        },
      },
    });
  });
  await page.goto(`/boards?board=${boardId}&section=overview`);
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Manage Board and groups", exact: true })
    .click();
  const manage = page.getByRole("dialog", { name: "Manage Board" });
  await manage
    .getByRole("combobox", { name: "Add a group", exact: true })
    .click();
  const groupSearch = page
    .getByRole("combobox", { name: "Add a group", exact: true })
    .and(page.getByPlaceholder("Search…", { exact: true }));
  await groupSearch.fill("Zora");
  await expect(
    page.getByRole("option", { name: "Zora group beyond one hundred" }),
  ).toBeVisible();
  await page
    .getByRole("option", { name: "Zora group beyond one hundred" })
    .click();
  await manage
    .getByRole("combobox", { name: "Add a group", exact: true })
    .filter({ hasText: "Zora group beyond one hundred" })
    .click();
  await groupSearch.fill("Group 001");
  await expect
    .poll(() =>
      requests.some(
        (query) => new URLSearchParams(query).get("search") === "Group 001",
      ),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(
    manage
      .getByRole("combobox", { name: "Add a group", exact: true })
      .filter({ hasText: "Zora group beyond one hundred" }),
  ).toContainText("Zora group beyond one hundred");
  await manage.getByRole("button", { name: "Add group", exact: true }).click();
  await expect(
    manage.getByRole("list", { name: "Board groups", exact: true }),
  ).toContainText("Zora group beyond one hundred");
  await expect(
    manage.getByRole("button", { name: "Save groups", exact: true }),
  ).toBeEnabled();
  if (process.env.OPENVIEW_CAPTURE_DIR) {
    for (const mode of ["light", "dark"] as const) {
      await page.evaluate((value) => {
        document.documentElement.classList.toggle("dark", value === "dark");
      }, mode);
      await captureOpenViewReview(page, `s08-board-groups-${mode}`);
    }
  }
});

const controlFileId = "00000000-0000-4000-8000-000000000041";
const controlFile = {
  id: controlFileId,
  purpose: "board_attachment",
  record_id: null,
  department_id: null,
  board_id: boardId,
  creator_id: actorId,
  filename: "building-map.pdf",
  media_type: "application/pdf",
  expected_size: 5,
  actual_size: 5,
  state: "ready",
  failure_code: null,
  is_deleted: false,
  created_at: board.createdAt,
  updated_at: board.updatedAt,
};

async function installFileManagement(page: Page, startArchived = false) {
  const api = await installArchivedBoard(page);
  const currentBoard = {
    id: boardId,
    scope: "project",
    department_id: null,
    name: board.name,
    description: board.description,
    status: startArchived ? "archived" : "active",
    revision: board.revision,
    level: "manage",
    created_at: board.createdAt,
    updated_at: board.updatedAt,
  };
  let file = { ...controlFile };
  let fileReadsWhileArchived = 0;
  let purgeAttempts = 0;
  let failChallenge = false;
  let malformedFile = false;
  const writes: string[] = [];
  const preview = {
    ...purgePreview,
    confirmation_name: controlFile.filename,
    last_successful_backup_at: null,
    impact: {
      ...purgePreview.impact,
      target_type: "file",
      target_id: controlFileId,
      rows: [purgeRow("files", controlFileId)],
    },
  };
  await page.route("**/api/boards**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/boards")
      return route.fulfill({
        json: {
          items: [currentBoard],
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
      return route.fulfill({ json: currentBoard });
    if (
      [
        `/api/boards/${boardId}/archive`,
        `/api/boards/${boardId}/restore`,
      ].includes(path)
    ) {
      currentBoard.status = path.endsWith("/archive") ? "archived" : "active";
      currentBoard.revision += 1;
      writes.push(currentBoard.status);
      return route.fulfill({ json: currentBoard });
    }
    if (path === `/api/boards/${boardId}/files`) {
      if (currentBoard.status !== "active") fileReadsWhileArchived += 1;
      const archived = url.searchParams.get("deleted") === "only";
      const items =
        file.is_deleted === archived
          ? [{ ...file, board_id: malformedFile ? departmentId : boardId }]
          : [];
      return route.fulfill({
        json: {
          items,
          pagination: {
            limit: 25,
            offset: 0,
            count: items.length,
            total: items.length,
            has_more: false,
          },
        },
      });
    }
    if (path === `/api/boards/${boardId}/files/${controlFileId}/archive`) {
      file = { ...file, is_deleted: true };
      writes.push("file_archive");
      return route.fulfill({ json: file });
    }
    if (path === `/api/boards/${boardId}/files/${controlFileId}/purge/preview`)
      return route.fulfill({ json: preview });
    if (path === `/api/boards/${boardId}/files/${controlFileId}/purge`) {
      purgeAttempts += 1;
      expect(request.postDataJSON()).toEqual({
        token: preview.token,
        confirmation_name: controlFile.filename,
        password: "synthetic-file-password",
      });
      if (failChallenge)
        return route.fulfill({
          status: 404,
          json: {
            detail: {
              code: "challenge_not_found",
              message: "private internals",
            },
          },
        });
      file = { ...file, state: "purged" };
      writes.push("file_purge");
      return route.fulfill({ json: file });
    }
    if (path === `/api/boards/${boardId}/purge/preview`) {
      expect(file.state).toBe("purged");
      return route.fulfill({ json: purgePreview });
    }
    if (path === `/api/boards/${boardId}/purge`) {
      writes.push("board_purge");
      return route.fulfill({
        json: { impact: purgePreview.impact, operation_id: null },
      });
    }
    return route.fallback();
  });
  return {
    ...api,
    writes,
    get fileReadsWhileArchived() {
      return fileReadsWhileArchived;
    },
    get purgeAttempts() {
      return purgeAttempts;
    },
    expireChallenge() {
      failChallenge = true;
    },
    wrongBoard() {
      malformedFile = true;
    },
    archiveRemote() {
      file = { ...file, is_deleted: true };
    },
    purgeRemote() {
      file = { ...file, is_deleted: true, state: "purged" };
    },
    renameRemote() {
      currentBoard.name = "Remote Dispatch";
      currentBoard.revision += 1;
    },
  };
}

test("S11 another Board invalidation refreshes the current bounded selector search in place", async ({
  page,
}) => {
  await installFileManagement(page);
  const otherId = "00000000-0000-4000-8000-000000000099";
  let name = "Dispatch partner";
  const queries: URLSearchParams[] = [];
  await page.route(
    (url) => url.pathname === "/api/boards",
    (route) => {
      const params = new URL(route.request().url()).searchParams;
      queries.push(params);
      return route.fulfill({
        json: {
          items: [
            {
              id: otherId,
              scope: "project",
              department_id: null,
              name,
              description: "",
              status: "active",
              revision: 1,
              level: "manage",
              created_at: board.createdAt,
              updated_at: board.updatedAt,
            },
          ],
          pagination: {
            limit: 25,
            offset: 0,
            count: 1,
            total: 1,
            has_more: false,
          },
        },
      });
    },
  );
  await page.goto(`/boards?board=${boardId}&section=posts`);
  await page.getByRole("button", { name: "Switch board", exact: true }).click();
  await page.getByLabel("Search accessible Boards").fill("Dispatch");
  await page
    .getByRole("button", { name: "Search boards", exact: true })
    .click();
  await expect.poll(() => queries.at(-1)?.get("search")).toBe("Dispatch");
  const before = queries.length;
  name = "Remote dispatch partner";
  await sendOpenViewEvent(page, "invalidate", {
    entity: "boards",
    board_id: otherId,
  });
  await expect.poll(() => queries.length).toBe(before + 1);
  expect(queries.at(-1)?.get("search")).toBe("Dispatch");
  expect(queries.at(-1)?.get("limit")).toBe("25");
  expect(queries.at(-1)?.get("offset")).toBe("0");
  expect(queries.at(-1)?.get("status")).toBe("active");
  await expect(page.getByLabel("Search accessible Boards")).toHaveValue(
    "Dispatch",
  );
  await page.getByRole("combobox", { name: "Board", exact: true }).click();
  await expect(
    page.getByRole("option", { name: /Remote dispatch partner/ }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`board=${boardId}`));
});

test("S11 live unattached-file list and Board metadata retain the management draft", async ({
  page,
}) => {
  const api = await installFileManagement(page);
  await page.goto(`/boards?board=${boardId}&section=overview`);
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Manage Board and groups", exact: true })
    .click();
  const manage = page.getByRole("dialog", { name: "Manage Board" });
  await expect(
    manage.getByRole("button", {
      name: `Archive ${controlFile.filename}`,
      exact: true,
    }),
  ).toBeVisible();
  await manage
    .getByLabel("Board name", { exact: true })
    .fill("My local Board name");
  api.archiveRemote();
  await sendOpenViewEvent(page, "invalidate", { entity: "files" });
  await expect(
    manage.getByText("No unattached files on this page.", { exact: true }),
  ).toBeVisible();
  await expect(manage.getByLabel("Board name", { exact: true })).toHaveValue(
    "My local Board name",
  );
  api.renameRemote();
  await sendOpenViewEvent(page, "invalidate", {
    entity: "boards",
    board_id: boardId,
  });
  await expect(
    manage.getByText("Changed by someone else — review latest", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(manage.getByLabel("Board name", { exact: true })).toHaveValue(
    "My local Board name",
  );
  expect(api.writes).toHaveLength(0);
});

for (const changed of [false, true]) {
  test(`S11 fresh file read ${changed ? "invalidates a held preview after remote purge" : "preserves an unchanged review and gates confirmation while loading"}`, async ({
    page,
  }) => {
    const api = await installFileManagement(page);
    api.archiveRemote();
    if (process.env.OPENVIEW_CAPTURE_DIR)
      await page.route("**/api/users/*/preferences", (route) =>
        route.fulfill({
          json: {
            user_id: new URL(route.request().url()).pathname.split("/")[3],
            theme: "light",
            appearance: { motion: "reduce", keyboard_shortcuts: true },
          },
        }),
      );
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (changed)
      await page.route(
        `**/api/boards/${boardId}/files/${controlFileId}/purge/preview`,
        async (route) => {
          await held;
          return route.fallback();
        },
      );
    await page.goto(`/boards?board=${boardId}&section=overview`);
    await page.getByRole("button", { name: "Board menu", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Manage Board and groups", exact: true })
      .click();
    const manage = page.getByRole("dialog", { name: "Manage Board" });
    await manage.getByLabel("File status").selectOption("only");
    await manage
      .getByRole("button", {
        name: `Permanently delete ${controlFile.filename}`,
        exact: true,
      })
      .click();
    const review = page.getByRole("dialog", {
      name: "Permanently delete file?",
    });
    try {
      if (changed) {
        await expect(
          review.getByText("Preparing review…", { exact: true }),
        ).toBeVisible();
        api.purgeRemote();
        const read = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === `/api/boards/${boardId}/files`,
        );
        await sendOpenViewEvent(page, "invalidate", { entity: "files" });
        await read;
        await expect(
          manage.getByText("Permanently deleted", { exact: true }),
        ).toHaveCount(1);
        await expect(review).toBeHidden();
        release();
        await expect(manage.getByLabel("File status")).toBeEnabled();
        await expect(review).toBeHidden();
      } else {
        await review
          .getByLabel("Type the file name")
          .fill(controlFile.filename);
        if (process.env.OPENVIEW_CAPTURE_DIR) {
          await hideDevOverlay(page);
          await page.evaluate(() => document.fonts.ready);
          for (const mode of ["light", "dark"] as const) {
            await page.evaluate(applyAppearancePreferences, {
              mode,
              reduceMotion: true,
            });
            await captureOpenViewReview(page, `s11-file-review-${mode}`, {
              beforeScreenshot: async () => {
                await expect(review).toBeInViewport();
                expect(
                  await page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth,
                  ),
                ).toBe(true);
              },
            });
          }
        }
        await review
          .getByLabel("Administrator password")
          .fill("synthetic-file-password");
        const confirm = review.getByRole("button", {
          name: "Confirm permanent deletion",
          exact: true,
        });
        await expect(confirm).toBeEnabled();
        await page.route(
          (url) => url.pathname === `/api/boards/${boardId}/files`,
          async (route) => {
            await held;
            return route.fallback();
          },
        );
        const read = page.waitForRequest(
          (request) =>
            new URL(request.url()).pathname === `/api/boards/${boardId}/files`,
        );
        await sendOpenViewEvent(page, "invalidate", { entity: "files" });
        await read;
        await expect(confirm).toBeDisabled();
        release();
        await expect(confirm).toBeEnabled();
        await expect(review.getByLabel("Type the file name")).toHaveValue(
          controlFile.filename,
        );
      }
      expect(api.purgeAttempts).toBe(0);
    } finally {
      release();
    }
  });
}

for (const startArchived of [false, true]) {
  test(`S04 owned unattached file can be archived and purged before its ${startArchived ? "restored" : "active"} Board`, async ({
    page,
  }) => {
    const api = await installFileManagement(page, startArchived);
    await page.goto(
      `/boards?board=${boardId}&section=overview${startArchived ? "&status=archived" : ""}`,
    );
    await page.getByRole("button", { name: "Board menu", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Manage Board and groups", exact: true })
      .click();
    const manage = page.getByRole("dialog", { name: "Manage Board" });
    if (startArchived) {
      await expect(
        manage.getByText("Restore this Board to manage its unattached files."),
      ).toBeVisible();
      expect(api.fileReadsWhileArchived).toBe(0);
      await manage
        .getByRole("button", { name: "Restore Board", exact: true })
        .click();
      await page
        .getByRole("alertdialog", { name: "Restore Board?" })
        .getByRole("button", { name: "Restore Board", exact: true })
        .click();
    }
    await manage
      .getByRole("button", {
        name: `Archive ${controlFile.filename}`,
        exact: true,
      })
      .click();
    await manage.getByLabel("File status").selectOption("only");
    await manage
      .getByRole("button", {
        name: `Permanently delete ${controlFile.filename}`,
        exact: true,
      })
      .click();
    const review = page.getByRole("dialog", {
      name: "Permanently delete file?",
    });
    await expect(
      review.getByText(
        "Last successful backup: No successful backup recorded.",
      ),
    ).toBeVisible();
    await review
      .getByLabel("Type the file name")
      .fill(` ${controlFile.filename}`);
    await review
      .getByLabel("Administrator password")
      .fill("synthetic-file-password");
    await expect(
      review.getByRole("button", {
        name: "Confirm permanent deletion",
        exact: true,
      }),
    ).toBeDisabled();
    expect(api.purgeAttempts).toBe(0);
    await review.getByLabel("Type the file name").fill(controlFile.filename);
    await review
      .getByRole("button", { name: "Confirm permanent deletion", exact: true })
      .click();
    await expect(review).toBeHidden();
    await expect(
      manage.getByText("Permanently deleted", { exact: true }),
    ).toBeVisible();
    await manage
      .getByRole("button", { name: "Archive Board", exact: true })
      .click();
    const archive = page.getByRole("alertdialog", { name: "Archive Board?" });
    await archive
      .getByLabel(`Type “${board.name}” to confirm`)
      .fill(board.name);
    await archive
      .getByRole("button", { name: "Archive Board", exact: true })
      .click();
    await manage
      .getByRole("button", { name: "Permanently delete Board", exact: true })
      .click();
    await manage.getByLabel("Type the Board name").fill(board.name);
    await manage
      .getByLabel("Administrator password")
      .fill("synthetic-file-password");
    await manage
      .getByRole("button", { name: "Confirm permanent deletion", exact: true })
      .click();
    await expect(manage).toBeHidden();
    expect(api.writes).toEqual([
      ...(startArchived ? ["active"] : []),
      "file_archive",
      "file_purge",
      "archived",
      "board_purge",
    ]);
    expect(api.fileReadsWhileArchived).toBe(0);
  });
}
test("S04 correction: obsolete file preview cannot unlock a fresh Board review after real refresh", async ({
  page,
}) => {
  await installFileManagement(page);
  let current = {
    id: boardId,
    scope: "project",
    department_id: null,
    name: board.name,
    description: board.description,
    status: "active",
    revision: board.revision,
    level: "manage",
    created_at: board.createdAt,
    updated_at: board.updatedAt,
  };
  let holdNext = false,
    detailHeld = false,
    fileHeld = false,
    boardHeld = false;
  let releaseDetail = () => {},
    releaseFile = () => {},
    releaseBoard = () => {};
  const detailGate = new Promise<void>((resolve) => {
    releaseDetail = resolve;
  });
  const fileGate = new Promise<void>((resolve) => {
    releaseFile = resolve;
  });
  const boardGate = new Promise<void>((resolve) => {
    releaseBoard = resolve;
  });
  let purges = 0;
  await page.route(`**/api/boards/${boardId}`, async (route) => {
    if (holdNext) {
      holdNext = false;
      detailHeld = true;
      await detailGate;
    }
    return route.fulfill({ json: current });
  });
  await page.route("**/api/boards?**", (route) => {
    const wanted =
      new URL(route.request().url()).searchParams.get("status") ?? "active";
    const items =
      wanted === "all" || wanted === current.status ? [current] : [];
    return route.fulfill({
      json: {
        items,
        pagination: {
          limit: 25,
          offset: 0,
          count: items.length,
          total: items.length,
          has_more: false,
        },
      },
    });
  });
  await page.route(
    `**/api/boards/${boardId}/files/${controlFileId}/purge/preview`,
    async (route) => {
      fileHeld = true;
      await fileGate;
      return route.fulfill({
        json: {
          ...purgePreview,
          confirmation_name: controlFile.filename,
          impact: {
            ...purgePreview.impact,
            target_type: "file",
            target_id: controlFileId,
            rows: [purgeRow("files", controlFileId)],
          },
        },
      });
    },
  );
  await page.route(`**/api/boards/${boardId}/purge/preview`, async (route) => {
    boardHeld = true;
    await boardGate;
    return route.fulfill({
      json: {
        ...purgePreview,
        impact: { ...purgePreview.impact, rows: [purgeRow("boards", boardId)] },
      },
    });
  });
  await page.route("**/api/**", (route) => {
    if (
      route.request().method() === "POST" &&
      new URL(route.request().url()).pathname.endsWith("/purge")
    ) {
      purges += 1;
      return route.fulfill({
        status: 409,
        json: { detail: "Unexpected diagnostic purge" },
      });
    }
    return route.fallback();
  });
  try {
    await page.goto(`/boards?board=${boardId}&section=overview`);
    await expect(
      page.getByRole("heading", { name: board.name, exact: true }),
    ).toBeVisible();
    holdNext = true;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => detailHeld).toBe(true);
    await page.getByRole("button", { name: "Board menu", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Manage Board and groups", exact: true })
      .click();
    const manage = page.getByRole("dialog", { name: "Manage Board" });
    await manage
      .getByRole("button", {
        name: `Archive ${controlFile.filename}`,
        exact: true,
      })
      .click();
    await manage.getByLabel("File status").selectOption("only");
    await manage
      .getByRole("button", {
        name: `Permanently delete ${controlFile.filename}`,
        exact: true,
      })
      .click();
    await expect.poll(() => fileHeld).toBe(true);
    current = {
      ...current,
      status: "archived",
      revision: current.revision + 1,
    };
    releaseDetail();
    await expect(
      manage.getByText("Restore this Board to manage its unattached files."),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Permanently delete file?" }),
    ).toBeHidden();
    const begin = manage.getByRole("button", {
      name: "Permanently delete Board",
      exact: true,
    });
    await expect(begin).toBeEnabled();
    await begin.click();
    await expect.poll(() => boardHeld).toBe(true);
    const oldResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/files/${controlFileId}/purge/preview`),
    );
    releaseFile();
    await oldResponse;
    await expect(
      manage.getByText("This permanently removes 1 file."),
    ).toHaveCount(0);
    await expect(
      manage.getByText(controlFile.filename, { exact: true }),
    ).toHaveCount(0);
    await expect(manage.getByLabel("Type the Board name")).toHaveCount(0);
    await expect(
      manage.getByRole("button", { name: "Preparing review…", exact: true }),
    ).toBeDisabled();
    releaseBoard();
    await expect(
      manage.getByText("This permanently removes 1 Board."),
    ).toBeVisible();
    await expect(manage.getByLabel("Type the Board name")).toBeVisible();
    expect(purges).toBe(0);
  } finally {
    releaseDetail();
    releaseFile();
    releaseBoard();
  }
});
