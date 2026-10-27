import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import type {
  BoardManagementBoard,
  BoardPurgePreview,
} from "../../src/components/systems/boards/adapters/board-management-api";

import { group as accessGroupFixture } from "../isolated/access/fixtures";
import { authMeBody, defaultOrganization, isEventStream } from "./helpers/test";
import { pageOf } from "../helpers/pagination";
import { wireBoard } from "../helpers/wire";

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

/** Board settings, found by its tabs, since its title follows the board's name. */
function settingsSheet(page: Page): Locator {
  return page.getByRole("dialog").filter({
    has: page.getByRole("tablist", { name: "Board settings", exact: true }),
  });
}

async function openBoardSettings(page: Page): Promise<Locator> {
  await page
    .getByRole("button", { name: "Board settings", exact: true })
    .click();
  return settingsSheet(page);
}

/** Opens the closed Advanced block of Details, which holds files and lifecycle. */
async function openAdvanced(sheet: Locator): Promise<void> {
  await sheet.getByRole("button", { name: /^Advanced/ }).click();
}

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
  const archived = wireBoard({
    id: boardId,
    name: board.name,
    description: board.description,
    status: "archived",
    revision: board.revision,
    level: "manage",
    created_at: board.createdAt,
    updated_at: board.updatedAt,
  });
  await page.route("**/api/**", (route) => {
    if (isEventStream(route)) return route.fallback();
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          authenticated: true,
          organization_id: defaultOrganization.org_id,
          user_id: actorId,
          setup_required: false,
          default_organization_blocked: null,
        },
      });
    if (path === "/api/auth/me")
      return route.fulfill({
        json: authMeBody({
          id: actorId,
          role: "admin",
          access: [],
          default_organization_blocked: null,
        }),
      });
    if (path === "/api/workspace")
      return route.fulfill(
        workspaceFailure
          ? { status: 503, json: { detail: "Workspace unavailable" } }
          : { json: workspace },
      );
    if (path === "/api/boards")
      return route.fulfill({
        json: pageOf([archived], { limit: 25 }),
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
    if (
      path === `/api/boards/${boardId}/preview-users` ||
      path === `/api/boards/${boardId}/activity`
    )
      return route.fulfill({ json: pageOf([], { limit: 25 }) });
    return route.fulfill({
      json: { ...pageOf([], { limit: 25 }), board_revision: board.revision },
    });
  });
  return {
    workspace,
    failWorkspaceRead: (failed: boolean) => {
      workspaceFailure = failed;
    },
  };
}

for (const state of ["disabled", "unknown", "unavailable"] as const) {
  test(`an archived Board remains restorable while permanent deletion is ${state}`, async ({
    page,
  }) => {
    const api = await installArchivedBoard(page);
    api.workspace.purge_enabled = state === "unknown" ? undefined : false;
    api.failWorkspaceRead(state === "unavailable");
    await page.goto(`/boards?board=${boardId}&section=posts&status=archived`);
    const manage = await openBoardSettings(page);
    await openAdvanced(manage);
    await expect(
      manage.getByRole("button", { name: "Restore board" }),
    ).toBeEnabled();
    await expect(
      manage.getByRole("button", {
        name: "Delete forever",
        exact: true,
      }),
    ).toHaveCount(0);
  });
}

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
  await page.goto(`/boards?board=${boardId}&section=posts&status=archived`);
  const manage = await openBoardSettings(page);
  await openAdvanced(manage);
  const begin = manage.getByRole("button", {
    name: "Delete forever",
    exact: true,
  });
  await begin.click();
  await expect(
    manage.getByText("This deletes 1 Board and 2 posts forever."),
  ).toBeVisible();
  await expect(manage.getByRole("code")).toHaveText(board.name);
  await expect(manage.getByText(/Last successful backup/)).toHaveText(
    "Last successful backup: 24 Sept 2026, 02:30 · Asia/Manila",
  );
  await expect(manage.getByLabel("Administrator password")).toBeVisible();
  api.failWorkspaceRead(true);
  await sendOpenViewEvent(page, "invalidate", { entity: "workspace_profiles" });
  await expect(manage.getByLabel("Administrator password")).toHaveCount(0);
  await expect(
    manage.getByRole("button", { name: "Restore board" }),
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
    name: "Delete board forever",
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
    await manage.getByLabel("Type the board name").fill(board.name);
    await manage
      .getByLabel("Administrator password")
      .fill("synthetic-test-passphrase");
    await confirm.click();
    await expect(
      manage.getByText("The review is unavailable. Request a new review."),
    ).toBeVisible();
    await expect(
      manage.getByRole("button", { name: "Restore board" }),
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

test("New project board creates the board and opens its settings on Access", async ({
  page,
}) => {
  await installArchivedBoard(page);
  const created = wireBoard({
    id: departmentId,
    name: "New dispatch",
    description: "Owned feedback journey",
    level: "manage",
    created_at: board.createdAt,
    updated_at: board.updatedAt,
  });
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
  await page.route(`**/api/boards/${departmentId}/groups`, (route) =>
    route.fulfill({
      json: { board_id: departmentId, revision: 1, groups: [] },
    }),
  );
  await page.route(`**/api/boards/${departmentId}/preview-users?*`, (route) =>
    route.fulfill({ json: pageOf([], { limit: 25 }) }),
  );
  await page.goto("/boards?section=all");
  await page
    .getByRole("button", { name: "New project board", exact: true })
    .click();
  const form = page.getByRole("dialog", { name: "New project board" });
  const create = form.getByRole("button", {
    name: "Create board",
    exact: true,
  });
  // Create says why it waits until the board has a name.
  await expect(create).toHaveAccessibleDescription("Name the board first.");
  await form.getByLabel("Name", { exact: true }).fill(created.name);
  await create.click();
  await expect(form).toBeHidden();
  await expect(page).toHaveURL(
    new RegExp(
      `/boards\\?board=${departmentId}&section=posts&settings=access$`,
    ),
  );
  const settings = page.getByRole("dialog", {
    name: created.name,
    exact: true,
  });
  await expect(
    settings.getByRole("tab", { name: "Access", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    settings.getByText("No groups yet. Only admins open this board."),
  ).toBeVisible();
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
  await page.goto(`/boards?board=${boardId}&section=posts&status=archived`);
  const form = await openBoardSettings(page);
  await openAdvanced(form);
  await form
    .getByRole("button", { name: "Delete forever", exact: true })
    .click();
  await form.getByLabel("Type the board name").fill(board.name);
  await form
    .getByLabel("Administrator password")
    .fill("synthetic-owned-passphrase");
  await form
    .getByRole("button", { name: "Delete board forever", exact: true })
    .click();
  await expect(form).toBeHidden();
  await expect(
    page
      .getByRole("region", { name: "Status messages", exact: true })
      .getByText("Board deleted forever.", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Status messages", exact: true })
      .getByText("Board deleted forever.", { exact: true }),
  ).toHaveCount(1);
});

test("Board group picker finds groups beyond one hundred and preserves the selected label and draft", async ({
  page,
}) => {
  await installArchivedBoard(page);
  const activeBoard = wireBoard({
    id: boardId,
    name: board.name,
    description: board.description,
    revision: board.revision,
    level: "manage",
    created_at: board.createdAt,
    updated_at: board.updatedAt,
  });
  await page.route("**/api/boards", (route) =>
    route.fulfill({
      json: pageOf([activeBoard], { limit: 25 }),
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
      json: pageOf(items, {
        limit,
        offset,
        total: filtered.length,
        hasMore: offset + items.length < filtered.length,
      }),
    });
  });
  const puts: unknown[] = [];
  await page.route(`**/api/boards/${boardId}/groups`, (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const body = route.request().postDataJSON() as {
      revision: number;
      groups: { group_id: string; level: string }[];
    };
    puts.push(body);
    return route.fulfill({
      json: {
        board_id: boardId,
        revision: body.revision + 1,
        groups: body.groups.map((entry) => ({
          ...entry,
          name:
            choices.find((choice) => choice.id === entry.group_id)?.name ??
            "Unknown",
        })),
      },
    });
  });
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const manage = await openBoardSettings(page);
  await manage.getByRole("tab", { name: "Access", exact: true }).click();
  // With no group chosen, Add group says why it waits.
  await expect(
    manage.getByRole("button", { name: "Add group", exact: true }),
  ).toHaveAccessibleDescription("Choose a group first.");
  await manage
    .getByRole("combobox", { name: "Add a group", exact: true })
    .click();
  const groupSearch = page.getByRole("combobox", {
    name: "Search add a group",
    exact: true,
  });
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
  const groups = manage.getByRole("list", {
    name: "Board groups",
    exact: true,
  });
  await expect(groups).toContainText("Zora group beyond one hundred");
  // Adding saves at once with the board revision; focus waits on the picker
  // for the next group, since Add group turns off with nothing chosen.
  await expect(groups.getByText("Saved.", { exact: true })).toBeVisible();
  expect(puts).toEqual([
    {
      revision: board.revision,
      groups: [{ group_id: choices[124].id, level: "read" }],
    },
  ]);
  await expect(
    manage.getByRole("combobox", { name: "Add a group", exact: true }),
  ).toBeFocused();
  // Removing the last group leaves focus on the picker too.
  await manage
    .getByRole("button", {
      name: "Remove access for Zora group beyond one hundred",
      exact: true,
    })
    .click();
  await expect(
    manage.getByText("Removed Zora group beyond one hundred", { exact: false }),
  ).toBeVisible();
  await expect(
    manage.getByRole("combobox", { name: "Add a group", exact: true }),
  ).toBeFocused();
  expect(puts.at(-1)).toEqual({ revision: board.revision + 1, groups: [] });
});

const fieldCrewId = "00000000-0000-4000-8000-000000000061";
const guestReadersId = "00000000-0000-4000-8000-000000000062";
const nightShiftId = "00000000-0000-4000-8000-000000000063";

/** A project board's groups, saved whole with the board revision. */
async function installBoardGroups(page: Page) {
  let state = {
    board_id: boardId,
    revision: board.revision,
    groups: [
      { group_id: fieldCrewId, name: "Field Crew", level: "write" },
      { group_id: guestReadersId, name: "Guest Readers", level: "read" },
    ],
  };
  const names = new Map(state.groups.map((g) => [g.group_id, g.name]));
  const puts: unknown[] = [];
  let reads = 0;
  let stale = false;
  await page.route(`**/api/boards/${boardId}/groups`, (route) => {
    if (route.request().method() === "GET") {
      reads += 1;
      return route.fulfill({ json: state });
    }
    const body = route.request().postDataJSON() as {
      revision: number;
      groups: { group_id: string; level: string }[];
    };
    puts.push(body);
    if (stale) {
      stale = false;
      // Someone else added a group first.
      names.set(nightShiftId, "Night Shift");
      state = {
        ...state,
        revision: state.revision + 1,
        groups: [
          ...state.groups,
          { group_id: nightShiftId, name: "Night Shift", level: "read" },
        ],
      };
      return route.fulfill({
        status: 409,
        json: { detail: { code: "stale_revision", message: "Private" } },
      });
    }
    state = {
      ...state,
      revision: body.revision + 1,
      groups: body.groups.map((entry) => ({
        ...entry,
        name: names.get(entry.group_id) ?? "Unknown",
      })),
    };
    return route.fulfill({ json: state });
  });
  await page.route("**/api/access/groups?*", (route) =>
    route.fulfill({ json: pageOf([], { limit: 25 }) }),
  );
  return {
    puts,
    get reads() {
      return reads;
    },
    staleNext() {
      stale = true;
    },
  };
}

test("Access saves each group change at once, offers Undo after Remove, and reads a stale board again", async ({
  page,
}) => {
  await installFileManagement(page);
  const api = await installBoardGroups(page);
  await page.goto(`/boards?board=${boardId}&section=posts&settings=access`);
  const sheet = settingsSheet(page);
  const groups = sheet.getByRole("list", { name: "Board groups", exact: true });
  const level = (name: string) =>
    sheet.getByRole("combobox", { name: `Level for ${name}`, exact: true });
  // One set of level words: the select says what the level chip says.
  await expect(level("Field Crew").locator("option")).toHaveText([
    "Read",
    "Post",
    "Manager",
  ]);
  await expect(level("Field Crew")).toHaveValue("write");
  await expect(
    sheet.getByText("also adds posts, events and cards."),
  ).toBeVisible();
  await expect(
    sheet.getByText("also edits stages and labels, and pins posts."),
  ).toBeVisible();
  await expect(
    sheet.getByText("A person in several groups gets the highest level.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(sheet.getByRole("button", { name: /^Save/ })).toHaveCount(0);

  // A level change saves at once with the board revision.
  await level("Field Crew").selectOption("manage");
  await expect(groups.getByText("Saved.", { exact: true })).toBeVisible();
  expect(api.puts).toEqual([
    {
      revision: board.revision,
      groups: [
        { group_id: fieldCrewId, level: "manage" },
        { group_id: guestReadersId, level: "read" },
      ],
    },
  ]);

  // Remove saves at once and offers Undo; focus moves to the next row.
  await sheet
    .getByRole("button", { name: "Remove access for Field Crew", exact: true })
    .click();
  await expect(
    sheet.getByText("Removed Field Crew", { exact: false }),
  ).toBeVisible();
  await expect(level("Guest Readers")).toBeFocused();
  await expect(groups).not.toContainText("Field Crew");
  expect(api.puts.at(-1)).toEqual({
    revision: board.revision + 1,
    groups: [{ group_id: guestReadersId, level: "read" }],
  });
  await sheet.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(level("Field Crew")).toHaveValue("manage");
  await expect(level("Field Crew")).toBeFocused();
  expect(api.puts.at(-1)).toEqual({
    revision: board.revision + 2,
    groups: [
      { group_id: fieldCrewId, level: "manage" },
      { group_id: guestReadersId, level: "read" },
    ],
  });

  // A stale revision says so and reads the groups again.
  const readsBefore = api.reads;
  api.staleNext();
  await level("Guest Readers").selectOption("write");
  await expect(
    sheet.getByText("Someone changed this board first.", { exact: true }),
  ).toBeVisible();
  await expect(groups).toContainText("Night Shift");
  await expect(level("Guest Readers")).toHaveValue("read");
  expect(api.reads).toBeGreaterThan(readsBefore);
});

test("a manager who is not an admin reads the groups as level chips", async ({
  page,
}) => {
  await installFileManagement(page);
  await installBoardGroups(page);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authMeBody({
        id: actorId,
        role: "member",
        access: [],
        default_organization_blocked: null,
      }),
    }),
  );
  await page.goto(`/boards?board=${boardId}&section=posts&settings=access`);
  const sheet = settingsSheet(page);
  const groups = sheet.getByRole("list", { name: "Board groups", exact: true });
  await expect(
    groups
      .getByRole("listitem")
      .filter({ hasText: "Field Crew" })
      .locator('[data-slot="badge"]'),
  ).toHaveText("Post");
  await expect(groups.getByRole("combobox")).toHaveCount(0);
  await expect(
    sheet.getByText("Only an admin can change these groups.", { exact: true }),
  ).toBeVisible();
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
  const currentBoard = wireBoard({
    id: boardId,
    name: board.name,
    description: board.description,
    status: startArchived ? "archived" : "active",
    revision: board.revision,
    level: "manage",
    created_at: board.createdAt,
    updated_at: board.updatedAt,
  });
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
        json: pageOf([currentBoard], { limit: 25 }),
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
        json: pageOf(items, { limit: 25 }),
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

test("another Board invalidation refreshes the All boards search in place", async ({
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
        json: pageOf(
          [
            wireBoard({
              id: otherId,
              name,
              description: "",
              level: "manage",
              created_at: board.createdAt,
              updated_at: board.updatedAt,
            }),
          ],
          { limit: 25 },
        ),
      });
    },
  );
  await page.goto("/boards?section=all");
  await page.getByRole("searchbox", { name: "Search boards" }).fill("Dispatch");
  await expect.poll(() => queries.at(-1)?.get("search")).toBe("Dispatch");
  const before = queries.length;
  name = "Remote dispatch partner";
  await sendOpenViewEvent(page, "invalidate", {
    entity: "boards",
    board_id: otherId,
  });
  await expect.poll(() => queries.length).toBe(before + 1);
  expect(queries.at(-1)?.get("search")).toBe("Dispatch");
  expect(queries.at(-1)?.get("limit")).toBe("100");
  expect(queries.at(-1)?.get("offset")).toBe("0");
  expect(queries.at(-1)?.get("status")).toBe("active");
  await expect(
    page.getByRole("searchbox", { name: "Search boards" }),
  ).toHaveValue("Dispatch");
  await expect(
    page
      .getByRole("list", { name: "All boards" })
      .getByRole("link", { name: /Remote dispatch partner/ }),
  ).toBeVisible();
  await expect(page).toHaveURL(/section=all/);
});

test("live unattached-file list and Board metadata retain the management draft", async ({
  page,
}) => {
  const api = await installFileManagement(page);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const manage = await openBoardSettings(page);
  await openAdvanced(manage);
  await expect(
    manage.getByRole("button", {
      name: `Archive ${controlFile.filename}`,
      exact: true,
    }),
  ).toBeVisible();
  await manage.getByLabel("Name", { exact: true }).fill("My local Board name");
  api.archiveRemote();
  await sendOpenViewEvent(page, "invalidate", { entity: "files" });
  await expect(
    manage.getByText("No unattached files on this page.", { exact: true }),
  ).toBeVisible();
  await expect(manage.getByLabel("Name", { exact: true })).toHaveValue(
    "My local Board name",
  );
  api.renameRemote();
  await sendOpenViewEvent(page, "invalidate", {
    entity: "boards",
    board_id: boardId,
  });
  await expect(
    manage.getByText("Someone changed this board first.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(manage.getByLabel("Name", { exact: true })).toHaveValue(
    "My local Board name",
  );
  expect(api.writes).toHaveLength(0);
});

for (const changed of [false, true]) {
  test(`fresh file read ${changed ? "invalidates a held preview after remote purge" : "preserves an unchanged review and gates confirmation while loading"}`, async ({
    page,
  }) => {
    const api = await installFileManagement(page);
    api.archiveRemote();
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
    await page.goto(`/boards?board=${boardId}&section=posts`);
    const manage = await openBoardSettings(page);
    await openAdvanced(manage);
    await manage.getByLabel("File status").selectOption("only");
    await manage
      .getByRole("button", {
        name: `Delete ${controlFile.filename} forever`,
        exact: true,
      })
      .click();
    const review = page.getByRole("dialog", {
      name: "Delete file forever?",
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
          manage.getByText("Deleted forever", { exact: true }),
        ).toHaveCount(1);
        await expect(review).toBeHidden();
        release();
        await expect(manage.getByLabel("File status")).toBeEnabled();
        await expect(review).toBeHidden();
      } else {
        await review
          .getByLabel("Type the file name")
          .fill(controlFile.filename);
        await review
          .getByLabel("Administrator password")
          .fill("synthetic-file-password");
        const confirm = review.getByRole("button", {
          name: "Delete file forever",
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
  test(`owned unattached file can be archived and purged before its ${startArchived ? "restored" : "active"} Board`, async ({
    page,
  }) => {
    const api = await installFileManagement(page, startArchived);
    await page.goto(
      `/boards?board=${boardId}&section=posts${startArchived ? "&status=archived" : ""}`,
    );
    const manage = await openBoardSettings(page);
    await openAdvanced(manage);
    if (startArchived) {
      await expect(
        manage.getByText("Restore this board to manage its unattached files."),
      ).toBeVisible();
      expect(api.fileReadsWhileArchived).toBe(0);
      await manage
        .getByRole("button", { name: "Restore board", exact: true })
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
        name: `Delete ${controlFile.filename} forever`,
        exact: true,
      })
      .click();
    const review = page.getByRole("dialog", {
      name: "Delete file forever?",
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
        name: "Delete file forever",
        exact: true,
      }),
    ).toBeDisabled();
    expect(api.purgeAttempts).toBe(0);
    await review.getByLabel("Type the file name").fill(controlFile.filename);
    await review
      .getByRole("button", { name: "Delete file forever", exact: true })
      .click();
    await expect(review).toBeHidden();
    await expect(
      manage.getByText("Deleted forever", { exact: true }),
    ).toBeVisible();
    // Said once, in the sheet that stays open; no toast under it.
    await expect(
      manage.getByText("File deleted forever.", { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Status messages", exact: true })
        .getByText("File deleted forever.", { exact: true }),
    ).toHaveCount(0);
    await manage
      .getByRole("button", { name: "Archive board", exact: true })
      .click();
    const archive = page.getByRole("alertdialog", { name: "Archive board?" });
    await archive
      .getByRole("button", { name: "Archive board", exact: true })
      .click();
    await manage
      .getByRole("button", { name: "Delete forever", exact: true })
      .click();
    await manage.getByLabel("Type the board name").fill(board.name);
    await manage
      .getByLabel("Administrator password")
      .fill("synthetic-file-password");
    await manage
      .getByRole("button", { name: "Delete board forever", exact: true })
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
test("obsolete file preview cannot unlock a fresh Board review after real refresh", async ({
  page,
}) => {
  await installFileManagement(page);
  let current = wireBoard({
    id: boardId,
    name: board.name,
    description: board.description,
    revision: board.revision,
    level: "manage",
    created_at: board.createdAt,
    updated_at: board.updatedAt,
  });
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
      json: pageOf(items, { limit: 25 }),
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
    await page.goto(`/boards?board=${boardId}&section=posts`);
    await expect(
      page.getByRole("heading", {
        name: `${board.name} announcements`,
        exact: true,
      }),
    ).toBeVisible();
    holdNext = true;
    await sendOpenViewEvent(page, "invalidate", {
      entity: "boards",
      board_id: boardId,
    });
    await expect.poll(() => detailHeld).toBe(true);
    const manage = await openBoardSettings(page);
    await openAdvanced(manage);
    await manage
      .getByRole("button", {
        name: `Archive ${controlFile.filename}`,
        exact: true,
      })
      .click();
    await manage.getByLabel("File status").selectOption("only");
    await manage
      .getByRole("button", {
        name: `Delete ${controlFile.filename} forever`,
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
      manage.getByText("Restore this board to manage its unattached files."),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Delete file forever?" }),
    ).toBeHidden();
    const begin = manage.getByRole("button", {
      name: "Delete forever",
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
    await expect(manage.getByText("This deletes 1 file forever.")).toHaveCount(
      0,
    );
    await expect(
      manage.getByText(controlFile.filename, { exact: true }),
    ).toHaveCount(0);
    await expect(manage.getByLabel("Type the board name")).toHaveCount(0);
    await expect(
      manage.getByRole("button", { name: "Preparing review…", exact: true }),
    ).toBeDisabled();
    releaseBoard();
    await expect(
      manage.getByText("This deletes 1 Board forever."),
    ).toBeVisible();
    await expect(manage.getByLabel("Type the board name")).toBeVisible();
    expect(purges).toBe(0);
  } finally {
    releaseDetail();
    releaseFile();
    releaseBoard();
  }
});

test("Board settings opens on each tab from the address and closes by name", async ({
  page,
}) => {
  await installFileManagement(page);
  let activityReads = 0;
  await page.route(`**/api/boards/${boardId}/activity?*`, (route) => {
    activityReads += 1;
    return route.fulfill({
      json: pageOf(
        [
          {
            id: "00000000-0000-4000-8000-000000000071",
            created_at: "2026-09-24T09:30:00Z",
            kind: "board",
            action: "update",
            summary: "Board updated",
            actor_label: "ho-admin",
            group: null,
          },
          {
            id: "00000000-0000-4000-8000-000000000072",
            created_at: "2026-09-24T09:00:00Z",
            kind: "group",
            action: "update",
            summary: "Board groups changed",
            actor_label: "ho-admin",
            group: {
              name: "Internal Audit",
              level: "write",
              previous_level: "read",
            },
          },
        ],
        { limit: 25 },
      ),
    });
  });
  await page.clock.setFixedTime(new Date("2026-10-27T12:00:00Z"));
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const sheet = await openBoardSettings(page);
  await expect(
    page.getByRole("dialog", { name: board.name, exact: true }),
  ).toBeVisible();
  await expect(sheet.getByText("Project board · Active")).toBeVisible();
  await expect(page).toHaveURL(/settings=details/);
  const tab = (name: string) => sheet.getByRole("tab", { name, exact: true });
  // The sheet opens on its tab, not on Close.
  await expect(tab("Details")).toBeFocused();
  await tab("Access").click();
  await expect(page).toHaveURL(/settings=access/);
  await expect(tab("Access")).toHaveAttribute("aria-selected", "true");
  await expect(
    sheet.getByRole("heading", { name: "Check a person", exact: true }),
  ).toBeVisible();
  await tab("Activity").click();
  await expect(page).toHaveURL(/settings=activity/);
  await expect(tab("Activity")).toHaveAttribute("aria-selected", "true");
  await expect(
    sheet.getByRole("list", { name: "Board activity", exact: true }),
  ).toContainText("Changed details · ho-admin · Sep 24, 9:30 AM");
  // A group row says which group changed, and from which level to which.
  await expect(
    sheet.getByRole("list", { name: "Board activity", exact: true }),
  ).toContainText(
    "Changed Internal Audit · Read → Post · ho-admin · Sep 24, 9:00 AM",
  );
  await expect(sheet.locator("time").first()).toHaveAttribute(
    "title",
    "Thursday, September 24, 2026 at 9:30:00 AM UTC",
  );
  // Activity is read once, and once more for a change to this board.
  expect(activityReads).toBe(1);
  await sendOpenViewEvent(page, "invalidate", {
    entity: "boards",
    board_id: boardId,
  });
  await expect.poll(() => activityReads).toBe(2);
  await expect(tab("Activity")).toHaveAttribute("aria-selected", "true");
  await sheet
    .getByRole("button", { name: "Close board settings", exact: true })
    .click();
  await expect(settingsSheet(page)).toBeHidden();
  await expect(page).not.toHaveURL(/settings=/);
  // A shared link opens the sheet on its tab.
  await page.goto(`/boards?board=${boardId}&section=posts&settings=activity`);
  await expect(
    settingsSheet(page).getByRole("tab", { name: "Activity", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    settingsSheet(page).getByRole("tab", { name: "Activity", exact: true }),
  ).toBeFocused();
});

test("renaming a project board saves with its revision and names a conflict", async ({
  page,
}) => {
  await installFileManagement(page);
  const saves: unknown[] = [];
  await page.route(`**/api/boards/${boardId}`, (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    saves.push(route.request().postDataJSON());
    if (saves.length === 1)
      return route.fulfill({
        status: 409,
        json: {
          detail: { code: "stale_revision", message: "Private detail" },
        },
      });
    return route.fulfill({
      json: wireBoard({
        id: boardId,
        name: "Dispatch desk",
        description: board.description,
        revision: board.revision + 1,
        level: "manage",
        created_at: board.createdAt,
        updated_at: board.updatedAt,
      }),
    });
  });
  await page.goto(`/boards?board=${boardId}&section=posts&settings=details`);
  const sheet = settingsSheet(page);
  const save = sheet.getByRole("button", { name: "Save changes", exact: true });
  await expect(save).toBeDisabled();
  await expect(save).toHaveAccessibleDescription("No changes to save.");
  await sheet.getByLabel("Name", { exact: true }).fill("Dispatch desk");
  await save.click();
  await expect(
    sheet.getByText("Someone changed this board first.", { exact: true }),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  await sheet
    .getByRole("button", { name: "Refresh board", exact: true })
    .click();
  await sheet
    .getByRole("button", { name: "Retry with my draft", exact: true })
    .click();
  await save.click();
  await expect(
    sheet.getByText("Board details saved.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Dispatch desk", exact: true }),
  ).toBeVisible();
  expect(saves).toEqual([
    { revision: board.revision, name: "Dispatch desk" },
    { revision: board.revision, name: "Dispatch desk" },
  ]);
});

test("Archive asks once with its consequence, Restore acts at once, and each says so in the sheet", async ({
  page,
}) => {
  const api = await installFileManagement(page);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const sheet = await openBoardSettings(page);
  await openAdvanced(sheet);
  await sheet
    .getByRole("button", { name: "Archive board", exact: true })
    .click();
  const archive = page.getByRole("alertdialog", { name: "Archive board?" });
  await expect(archive).toContainText(
    "People who can read it now still can; nobody can post.",
  );
  await expect(archive.getByRole("textbox")).toHaveCount(0);
  // The question sits inside Board settings: Escape closes it alone.
  await page.keyboard.press("Escape");
  await expect(archive).toBeHidden();
  await expect(sheet).toBeVisible();
  await sheet
    .getByRole("button", { name: "Archive board", exact: true })
    .click();
  const confirm = archive.getByRole("button", {
    name: "Archive board",
    exact: true,
  });
  await expect(confirm).not.toHaveAttribute("data-variant", "destructive");
  await confirm.click();
  const toasts = page.getByRole("region", {
    name: "Status messages",
    exact: true,
  });
  // The sheet stays open over the toasts, so the result shows in it.
  await expect(
    sheet.getByText("Board archived.", { exact: true }),
  ).toBeVisible();
  const restore = sheet.getByRole("button", {
    name: "Restore board",
    exact: true,
  });
  await expect(restore).toHaveAttribute("data-variant", "outline");
  // Archive's button is gone; focus follows to the one that took its place.
  await expect(restore).toBeFocused();
  await restore.click();
  await expect(
    sheet.getByText("Board restored.", { exact: true }),
  ).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Archive board", exact: true }),
  ).toBeFocused();
  await expect(toasts.getByText(/^Board (archived|restored)\.$/)).toHaveCount(
    0,
  );
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(
    sheet.getByRole("button", { name: "Archive board", exact: true }),
  ).toBeVisible();
  expect(api.writes).toEqual(["archived", "active"]);
});

test("Check a person finds a person by name and shows their level on this board and why", async ({
  page,
}) => {
  await installFileManagement(page);
  const personId = "00000000-0000-4000-8000-000000000081";
  const checked: string[] = [];
  await page.route(`**/api/boards/${boardId}/preview-users?*`, (route) => {
    const search = new URL(route.request().url()).searchParams.get("search");
    return route.fulfill({
      json: pageOf(
        search === null || "sam rivera".includes(search.toLowerCase())
          ? [{ id: personId, username: "sam", display_name: "Sam Rivera" }]
          : [],
        { limit: 25 },
      ),
    });
  });
  await page.route(`**/api/boards/${boardId}/access-preview?*`, (route) => {
    checked.push(
      new URL(route.request().url()).searchParams.get("user_id") ?? "",
    );
    return route.fulfill({
      json: { level: "read", read: true, write: false, manage: false },
    });
  });
  await page.goto(`/boards?board=${boardId}&section=posts&settings=access`);
  const sheet = settingsSheet(page);
  await sheet.getByRole("combobox", { name: "Person", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search person", exact: true })
    .fill("rive");
  // The option names the person; the username is its second line.
  const option = page.getByRole("option", { name: /^Sam Rivera/ });
  await expect(option).toContainText("sam");
  await option.click();
  const result = sheet.getByRole("definition").filter({
    hasText: "can read · cannot post · cannot manage",
  });
  await expect(result).toBeVisible();
  // The result is named for the person by name, not by username.
  await expect(
    sheet.getByLabel("Sam Rivera on this board", { exact: true }),
  ).toContainText("can read · cannot post · cannot manage");
  await expect(
    sheet.getByRole("term").filter({ hasText: /^Access$/ }),
  ).toBeVisible();
  await expect(
    sheet.getByText(
      "Posting needs write access through one of this board's groups. Guests read only.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(checked).toEqual([personId]);
});

const salesBoardId = "00000000-0000-4000-8000-000000000051";

async function installSalesBoard(
  page: Page,
  viewer: { role: "admin" | "member"; level: "read" | "manage" },
) {
  await installOpenViewEventSource(page);
  const sales = wireBoard({
    id: salesBoardId,
    scope: "department",
    department_id: departmentId,
    name: "Sales",
    description: null,
    level: viewer.level,
    created_at: board.createdAt,
    updated_at: board.updatedAt,
  });
  const reads: string[] = [];
  await page.route("**/api/**", (route) => {
    if (isEventStream(route)) return route.fallback();
    const path = new URL(route.request().url()).pathname;
    reads.push(path);
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          authenticated: true,
          organization_id: defaultOrganization.org_id,
          user_id: actorId,
          setup_required: false,
          default_organization_blocked: null,
        },
      });
    if (path === "/api/auth/me")
      return route.fulfill({
        json: authMeBody({
          id: actorId,
          role: viewer.role,
          access: [],
          default_organization_blocked: null,
        }),
      });
    if (path === "/api/boards")
      return route.fulfill({ json: pageOf([sales], { limit: 25 }) });
    if (path === `/api/boards/${salesBoardId}`)
      return route.fulfill({ json: sales });
    if (path === `/api/boards/${salesBoardId}/my-access`)
      return route.fulfill({
        json: { level: "manage", read: true, write: true, manage: true },
      });
    if (path === `/api/boards/${salesBoardId}/preview-users`)
      return route.fulfill({ json: pageOf([], { limit: 25 }) });
    return route.fulfill({
      json: { ...pageOf([], { limit: 25 }), board_revision: 1 },
    });
  });
  return { reads };
}

test("a department board's name is read-only and Access shows how to let a group post", async ({
  page,
}) => {
  await installSalesBoard(page, { role: "admin", level: "manage" });
  await page.goto(`/boards?department=${departmentId}&section=posts`);
  const sheet = await openBoardSettings(page);
  await expect(
    sheet.getByText("Named after its department", { exact: true }),
  ).toBeVisible();
  await expect(sheet.getByRole("textbox", { name: "Name" })).toHaveCount(0);
  await expect(sheet.getByLabel("Description", { exact: true })).toBeEditable();
  await sheet.getByRole("tab", { name: "Access", exact: true }).click();
  await expect(
    sheet.getByText("Write on some Sales modules", { exact: true }),
  ).toBeVisible();
  await expect(
    sheet.getByText("Give this group a department-level Write row.", {
      exact: true,
    }),
  ).toBeVisible();
  // One place to change it: one link, named for the place.
  await expect(sheet.getByRole("link")).toHaveCount(1);
  await expect(
    sheet.getByRole("link", {
      name: "Change department roles in Access › Groups",
      exact: true,
    }),
  ).toHaveAttribute("href", "/access?view=groups");
});

test("a reader sees why they cannot post and no Board settings, even from a link", async ({
  page,
}) => {
  const api = await installSalesBoard(page, { role: "member", level: "read" });
  await page.goto(
    `/boards?department=${departmentId}&section=posts&settings=details`,
  );
  await expect(
    page.getByRole("heading", { name: "Sales announcements", exact: true }),
  ).toBeVisible();
  // The reason opens on focus and on a tap, not on hover alone.
  const chip = page.getByRole("button", { name: "Read", exact: true });
  await expect(chip).toHaveAccessibleDescription(
    "Posting needs write access to Sales.",
  );
  const tooltip = page.locator('[data-slot="tooltip-content"]');
  await chip.focus();
  await expect(tooltip).toHaveText("Posting needs write access to Sales.");
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await chip.click();
  await expect(tooltip).toHaveText("Posting needs write access to Sales.");
  await expect(
    page.getByRole("button", { name: "Board settings", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Nothing of Board settings is read for a reader.
  expect(
    api.reads.filter((path) => /\/(activity|preview-users|files)$/.test(path)),
  ).toEqual([]);
});

test("an archived board says so once, in its Archived chip, whose reason opens on focus and tap", async ({
  page,
}) => {
  await installArchivedBoard(page);
  await page.goto(`/boards?board=${boardId}&section=posts`);
  const chip = page
    .getByRole("button", { name: "Archived", exact: true })
    .and(page.locator("[aria-describedby]"));
  await expect(chip).toHaveAccessibleDescription(
    "Archived boards are read-only.",
  );
  const tooltip = page.locator('[data-slot="tooltip-content"]');
  await chip.focus();
  await expect(tooltip).toHaveText("Archived boards are read-only.");
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await chip.click();
  await expect(tooltip).toHaveText("Archived boards are read-only.");
  // No band above the page repeats it.
  await expect(page.getByText(/archived and read-only/)).toHaveCount(0);
});
