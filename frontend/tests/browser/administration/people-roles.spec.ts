import { expect, test } from "@playwright/test";
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
