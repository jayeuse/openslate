import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";
import { expect, test } from "../coverage";
import {
  ACTIVE_ID,
  ADMIN_ID,
  installSessionMocks,
  json,
  listResponse,
  pathForRequest,
  type JsonObject,
} from "../helpers/administration-fixtures";

type Capability =
  `${"departments" | "fields" | "modules" | "records" | "relationships"}.${"read" | "write"}`;

type TestPermissions = Partial<Record<Capability, boolean>>;

type BaseFixture = {
  id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_deleted: boolean;
  performed_by: null;
};

type TestRole = BaseFixture & {
  role: string;
  permissions: TestPermissions;
};

type TestUser = BaseFixture & {
  email: string;
  username: string;
  role_id: string;
  status: "pending" | "active" | "disabled";
};

const OPERATOR_ID = "33333333-3333-4333-8333-333333333333";

const PENDING_ID = "55555555-5555-4555-8555-555555555555";

const DISABLED_ID = "77777777-7777-4777-8777-777777777777";

const DELETED_ID = "88888888-8888-4888-8888-888888888888";

const INVITED_ID = "99999999-9999-4999-8999-999999999999";

function baseEntity(id: string, isDeleted = false): BaseFixture {
  return {
    id,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: isDeleted ? "2026-01-02T00:00:00.000Z" : null,
    is_deleted: isDeleted,
    performed_by: null,
  };
}

function roleFixture(
  id: string,
  role: string,
  isDeleted = false,
  permissions: TestPermissions = {},
): TestRole {
  return {
    ...baseEntity(id, isDeleted),
    role,
    permissions,
  };
}

function userFixture(
  id: string,
  email: string,
  username: string,
  roleId: string,
  status: "pending" | "active" | "disabled",
  isDeleted = false,
): TestUser {
  return {
    ...baseEntity(id, isDeleted),
    email,
    username,
    status,
    role_id: roleId,
  };
}

test("people resolves roles and refreshes authoritative state after success and 503", async ({
  page,
}) => {
  await installSessionMocks(page);
  const roles = [
    roleFixture(ADMIN_ID, "admin"),
    roleFixture(OPERATOR_ID, "operator", false, { "records.read": true }),
  ];
  let users: TestUser[] = [
    userFixture(
      PENDING_ID,
      "pending@example.com",
      "pending",
      OPERATOR_ID,
      "pending",
    ),
    userFixture(ACTIVE_ID, "active@example.com", "active", ADMIN_ID, "active"),
    userFixture(
      DISABLED_ID,
      "disabled@example.com",
      "disabled",
      OPERATOR_ID,
      "disabled",
    ),
    userFixture(
      DELETED_ID,
      "deleted@example.com",
      "deleted",
      OPERATOR_ID,
      "disabled",
      true,
    ),
  ];
  let userListRequests = 0;
  let inviteBody: JsonObject | undefined;
  await page.route("**/bff/**", async (route) => {
    if (await fulfillWorkspaceRequest(route)) return;
    const request = route.request();
    const path = pathForRequest(request);
    if (request.method() === "GET" && path === "/users") {
      userListRequests += 1;
      await json(route, 200, listResponse(users));
    } else if (request.method() === "GET" && path === "/roles") {
      await json(route, 200, listResponse(roles));
    } else if (
      request.method() === "POST" &&
      path === `/auth/invitations/${PENDING_ID}/resend`
    ) {
      await json(route, 200, users[0]);
    } else if (request.method() === "POST" && path === "/users") {
      inviteBody = request.postDataJSON() as JsonObject;
      const invited = userFixture(
        INVITED_ID,
        "invited@example.com",
        "invited",
        String(inviteBody.role_id),
        "pending",
      );
      users = [...users, invited];
      await json(route, 201, invited);
    } else if (request.method() === "PATCH" && path === `/users/${ACTIVE_ID}`) {
      users = users.map((user) =>
        user.id === ACTIVE_ID ? { ...user, status: "disabled" } : user,
      );
      await json(route, 503, {
        detail: "Unable to disable user authentication",
      });
    } else if (
      request.method() === "DELETE" &&
      path === `/users/${ACTIVE_ID}`
    ) {
      users = users.map((user) =>
        user.id === ACTIVE_ID
          ? {
              ...user,
              is_deleted: true,
              deleted_at: "2026-01-03T00:00:00.000Z",
            }
          : user,
      );
      await json(route, 503, {
        detail: "Identity provider deletion timeout",
      });
    } else {
      await json(route, 404, {
        detail: `Unhandled ${request.method()} ${path}`,
      });
    }
  });

  await page.goto("/administration/users");

  await expect(page.getByText("pending@example.com")).toBeVisible();
  await expect(page.locator(`[data-user-id="${PENDING_ID}"]`)).toContainText(
    "operator",
  );
  await expect(page.locator(`[data-user-id="${ACTIVE_ID}"]`)).toContainText(
    "admin",
  );
  await expect(
    page.getByText("Invitation pending", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText("Disabled", { exact: true })).toBeVisible();
  await expect(page.getByText("Deleted", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept invitation for pending" }),
  ).toHaveCount(0);

  await page.getByLabel("Email").fill("invited@example.com");
  await page.getByRole("textbox", { name: "Username" }).fill("invited");
  await page.getByRole("combobox", { name: "Role" }).selectOption(OPERATOR_ID);
  await page
    .getByRole("button", { name: "Send invitation", exact: true })
    .click();
  await expect(page.getByText("invited@example.com")).toBeVisible();
  await expect(
    page.getByText("Invitation sent.", { exact: true }),
  ).toBeVisible();
  expect(inviteBody).toEqual({
    email: "invited@example.com",
    username: "invited",
    role_id: OPERATOR_ID,
  });

  await page
    .getByRole("button", { name: "Actions for pending", exact: true })
    .click();
  await page
    .getByRole("menuitem", {
      name: "Resend invitation to pending@example.com",
    })
    .click();
  await expect(
    page.getByText("Invitation resent.", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => userListRequests).toBeGreaterThan(1);

  await page
    .getByRole("button", { name: "Actions for active", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Disable active" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disable", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({
      hasText: "The people service is temporarily unavailable. Try again.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Unable to disable user authentication", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(`[data-user-id="${ACTIVE_ID}"]`)).toContainText(
    "Disabled",
  );
  await expect.poll(() => userListRequests).toBeGreaterThan(2);

  await page
    .getByRole("button", { name: "Actions for active", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Edit username and role for active" })
    .click();
  await expect(page.getByLabel("Username for active")).toBeVisible();
  await page
    .getByRole("button", { name: "Actions for active", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Delete active" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({
      hasText: "The people service is temporarily unavailable. Try again.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Identity provider deletion timeout"),
  ).toHaveCount(0);
  await expect(page.getByLabel("Username for active")).toHaveCount(0);
  await expect(page.locator(`[data-user-id="${ACTIVE_ID}"]`)).toContainText(
    "Deleted",
  );
});

test("custom roles retain selected capabilities through edit, archive and restore", async ({
  page,
}) => {
  await installSessionMocks(page);
  let roles = [
    roleFixture(ADMIN_ID, "admin"),
    roleFixture(OPERATOR_ID, "member"),
  ];
  const mutations: JsonObject[] = [];
  await page.route("**/bff/**", async (route) => {
    if (await fulfillWorkspaceRequest(route)) return;
    const request = route.request();
    const path = pathForRequest(request);
    if (request.method() === "GET" && path === "/roles") {
      await json(route, 200, listResponse(roles));
    } else if (request.method() === "POST" && path === "/roles") {
      const body = request.postDataJSON() as {
        role: string;
        permissions: TestPermissions;
      };
      mutations.push(body);
      const created = roleFixture(
        INVITED_ID,
        body.role,
        false,
        body.permissions,
      );
      roles.push(created);
      await json(route, 201, created);
    } else if (
      request.method() === "PATCH" &&
      path === `/roles/${INVITED_ID}`
    ) {
      const body = request.postDataJSON() as {
        role: string;
        permissions: TestPermissions;
      };
      mutations.push(body);
      roles = roles.map((role) =>
        role.id === INVITED_ID ? { ...role, ...body } : role,
      );
      await json(route, 200, roles.at(-1));
    } else if (
      request.method() === "DELETE" &&
      path === `/roles/${INVITED_ID}`
    ) {
      roles = roles.map((role) =>
        role.id === INVITED_ID ? { ...role, is_deleted: true } : role,
      );
      await route.fulfill({ status: 204 });
    } else if (
      request.method() === "POST" &&
      path === `/roles/${INVITED_ID}/restore`
    ) {
      roles = roles.map((role) =>
        role.id === INVITED_ID ? { ...role, is_deleted: false } : role,
      );
      await json(route, 200, roles.at(-1));
    } else
      await json(route, 404, { detail: "Unexpected administration request" });
  });
  await page.goto("/administration/roles");
  await expect(
    page.getByText("All ten capabilities are always effective."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^(Edit|Archive) (admin|member)$/ }),
  ).toHaveCount(0);
  await page.getByLabel("Role name", { exact: true }).fill("  dispatcher  ");
  await page
    .getByRole("checkbox", { name: "records.read", exact: true })
    .check();
  await page.getByRole("button", { name: "Create role", exact: true }).click();
  const custom = page.locator(`[data-role-id="${INVITED_ID}"]`);
  await expect(custom).toContainText("1 of 10 capabilities enabled.");
  await expect(page.getByLabel("Role name", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("checkbox", { name: "records.read", exact: true }),
  ).not.toBeChecked();
  expect(mutations[0]).toMatchObject({
    role: "dispatcher",
    permissions: { "records.read": true, "records.write": false },
  });
  await custom
    .getByRole("button", { name: "Edit dispatcher", exact: true })
    .click();
  await expect(
    custom.getByRole("checkbox", { name: "records.read", exact: true }),
  ).toBeChecked();
  await custom.getByLabel("Role name for dispatcher").fill("coordinator");
  await custom
    .getByRole("checkbox", { name: "records.write", exact: true })
    .check();
  await custom
    .getByRole("button", { name: "Save role dispatcher", exact: true })
    .click();
  await expect(custom).toContainText("coordinator");
  await expect(custom).toContainText("2 of 10 capabilities enabled.");
  expect(mutations[1]).toMatchObject({
    role: "coordinator",
    permissions: { "records.read": true, "records.write": true },
  });
  await custom
    .getByRole("button", { name: "Edit coordinator", exact: true })
    .click();
  await custom.getByLabel("Role name for coordinator").fill("discarded draft");
  await custom.getByRole("button", { name: "Cancel", exact: true }).click();
  await custom
    .getByRole("button", { name: "Archive coordinator", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(
    custom.getByRole("button", { name: "Archive coordinator", exact: true }),
  ).toBeVisible();
  await custom
    .getByRole("button", { name: "Archive coordinator", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await expect(custom).toContainText("Archived");
  await expect(
    custom.getByRole("button", { name: "Edit coordinator", exact: true }),
  ).toHaveCount(0);
  await custom
    .getByRole("button", { name: "Restore coordinator", exact: true })
    .click();
  await expect(
    custom.getByRole("button", { name: "Edit coordinator", exact: true }),
  ).toBeVisible();
  await expect(custom).toContainText("2 of 10 capabilities enabled.");
  expect(mutations).toHaveLength(2);
});

test("role archive conflicts preserve the role and failed refreshes can be retried", async ({
  page,
}) => {
  await installSessionMocks(page);
  let listFails = false;
  let createFails = true;
  const roles = [roleFixture(OPERATOR_ID, "operator")];
  await page.route("**/bff/**", async (route) => {
    if (await fulfillWorkspaceRequest(route)) return;
    const request = route.request();
    const path = pathForRequest(request);
    if (request.method() === "GET" && path === "/roles") {
      await json(
        route,
        listFails ? 503 : 200,
        listFails
          ? { detail: "private provider failure" }
          : listResponse(roles),
      );
    } else if (
      request.method() === "DELETE" &&
      path === `/roles/${OPERATOR_ID}`
    ) {
      await json(route, 409, { detail: "private assigned-user identities" });
    } else if (request.method() === "POST" && path === "/roles") {
      listFails = true;
      if (createFails)
        await json(route, 422, { detail: "private validation detail" });
      else {
        roles.push(roleFixture(INVITED_ID, "reviewer"));
        await json(route, 201, roles.at(-1));
      }
    } else
      await json(route, 404, { detail: "Unexpected administration request" });
  });
  await page.goto("/administration/roles");
  await page
    .getByRole("button", { name: "Archive operator", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Move those users to another role" }),
  ).toContainText("The roles were refreshed.");
  await expect(
    page.getByRole("button", { name: "Archive operator", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("private assigned-user identities")).toHaveCount(
    0,
  );
  await page.getByLabel("Role name", { exact: true }).fill("reviewer");
  await page.getByRole("button", { name: "Create role", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "submitted role details were rejected" }),
  ).toContainText("roles service is temporarily unavailable");
  await expect(page.getByLabel("Role name", { exact: true })).toHaveValue(
    "reviewer",
  );
  listFails = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByText("The submitted role details were rejected.", {
      exact: false,
    }),
  ).toHaveCount(0);
  createFails = false;
  await page.getByRole("button", { name: "Create role", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "The action completed, but" }),
  ).toBeVisible();
  await expect(page.getByLabel("Role name", { exact: true })).toHaveValue("");
  listFails = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Edit reviewer", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/private (provider failure|validation detail)/),
  ).toHaveCount(0);
});

test("roles recover from denied loading and include later paginated roles", async ({
  page,
}) => {
  await installSessionMocks(page);
  let denied = true;
  await page.route("**/bff/**", async (route) => {
    if (await fulfillWorkspaceRequest(route)) return;
    const request = route.request();
    if (request.method() === "GET" && pathForRequest(request) === "/roles") {
      if (denied)
        return json(route, 403, { detail: "private authorization detail" });
      const offset = Number(new URL(request.url()).searchParams.get("offset"));
      const items =
        offset === 0
          ? [roleFixture(ADMIN_ID, "admin")]
          : [roleFixture(OPERATOR_ID, "operator")];
      await json(route, 200, {
        items,
        pagination: {
          limit: 100,
          offset,
          count: 1,
          total: 2,
          has_more: offset === 0,
        },
      });
    } else
      await json(route, 404, { detail: "Unexpected administration request" });
  });
  await page.goto("/administration/roles");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Administrator access is required" }),
  ).toBeVisible();
  await expect(page.getByText("private authorization detail")).toHaveCount(0);
  await expect(
    page.getByText("No roles found.", { exact: true }),
  ).toBeVisible();
  denied = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Edit operator", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("All ten capabilities are always effective."),
  ).toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Administrator access is required" }),
  ).toHaveCount(0);
});

test("people save role changes and restore, activate and reconcile an account", async ({
  page,
}) => {
  await installSessionMocks(page);
  let user = userFixture(
    DELETED_ID,
    "returning@example.com",
    "returning",
    OPERATOR_ID,
    "disabled",
    true,
  );
  const writes: { path: string; body: JsonObject | null }[] = [];
  const roles = [
    roleFixture(ADMIN_ID, "admin"),
    roleFixture(OPERATOR_ID, "operator"),
    roleFixture(INVITED_ID, "archived", true),
  ];
  await page.route("**/bff/**", async (route) => {
    if (await fulfillWorkspaceRequest(route)) return;
    const request = route.request();
    const path = pathForRequest(request);
    if (request.method() === "GET" && path === "/users")
      await json(route, 200, listResponse([user]));
    else if (request.method() === "GET" && path === "/roles")
      await json(route, 200, listResponse(roles));
    else if (
      request.method() === "POST" &&
      path === `/users/${DELETED_ID}/restore`
    ) {
      writes.push({ path, body: null });
      user = { ...user, is_deleted: false, deleted_at: null };
      await json(route, 200, user);
    } else if (
      request.method() === "PATCH" &&
      path === `/users/${DELETED_ID}`
    ) {
      const body = request.postDataJSON() as JsonObject;
      writes.push({ path, body });
      if (body.status === "active") user = { ...user, status: "active" };
      else
        user = {
          ...user,
          username: String(body.username),
          role_id: String(body.role_id),
        };
      await json(route, 200, user);
    } else if (
      request.method() === "POST" &&
      path === `/users/${DELETED_ID}/reconcile-auth`
    ) {
      writes.push({ path, body: null });
      await json(route, 200, user);
    } else
      await json(route, 404, { detail: "Unexpected administration request" });
  });
  await page.goto("/administration/users");
  const row = page.locator(`[data-user-id="${DELETED_ID}"]`);
  await expect(row).toContainText("Deleted");
  await page
    .getByRole("button", { name: "Actions for returning", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", {
      name: "Edit username and role for returning",
    }),
  ).toHaveCount(0);
  await page
    .getByRole("menuitem", { name: "Restore returning", exact: true })
    .click();
  await expect(row).toContainText("Disabled");
  await page
    .getByRole("button", { name: "Actions for returning", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Activate returning", exact: true })
    .click();
  await expect(row).toContainText("Active");
  await page
    .getByRole("button", { name: "Actions for returning", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Edit username and role for returning" })
    .click();
  await expect(
    page
      .getByLabel("Role for returning", { exact: true })
      .getByRole("option", { name: "archived" }),
  ).toHaveCount(0);
  await page
    .getByLabel("Username for returning", { exact: true })
    .fill("discarded");
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row).toContainText("returning");
  await page
    .getByRole("button", { name: "Actions for returning", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Edit username and role for returning" })
    .click();
  await expect(
    page.getByLabel("Username for returning", { exact: true }),
  ).toHaveValue("returning");
  await page
    .getByLabel("Username for returning", { exact: true })
    .fill("coordinator");
  await page
    .getByLabel("Role for returning", { exact: true })
    .selectOption(ADMIN_ID);
  await row.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(row).toContainText("coordinator");
  await expect(row).toContainText("admin");
  await page
    .getByRole("button", { name: "Actions for coordinator", exact: true })
    .click();
  await page
    .getByRole("menuitem", {
      name: "Reconcile coordinator authentication",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("coordinator authentication reconciled.", { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([
    { path: `/users/${DELETED_ID}/restore`, body: null },
    { path: `/users/${DELETED_ID}`, body: { status: "active" } },
    {
      path: `/users/${DELETED_ID}`,
      body: { username: "coordinator", role_id: ADMIN_ID },
    },
    { path: `/users/${DELETED_ID}/reconcile-auth`, body: null },
  ]);
});
