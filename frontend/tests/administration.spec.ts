import {
  expect,
  test,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";

type JsonObject = Record<string, unknown>;
type Capability = (typeof CAPABILITIES)[number];
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

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const OPERATOR_ID = "33333333-3333-4333-8333-333333333333";
const ARCHIVED_ROLE_ID = "44444444-4444-4444-8444-444444444444";
const PENDING_ID = "55555555-5555-4555-8555-555555555555";
const ACTIVE_ID = "66666666-6666-4666-8666-666666666666";
const DISABLED_ID = "77777777-7777-4777-8777-777777777777";
const DELETED_ID = "88888888-8888-4888-8888-888888888888";
const INVITED_ID = "99999999-9999-4999-8999-999999999999";

const CAPABILITIES = [
  "departments.read",
  "departments.write",
  "fields.read",
  "fields.write",
  "modules.read",
  "modules.write",
  "records.read",
  "records.write",
  "relationships.read",
  "relationships.write",
] as const;

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

function listResponse(items: unknown[]): JsonObject {
  return {
    items,
    pagination: {
      limit: 100,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  };
}

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function pathForRequest(request: Request) {
  return new URL(request.url()).pathname.replace(/^\/bff/, "");
}

async function installSessionMocks(page: Page) {
  await page.route("**/session/status", (route) =>
    json(route, 200, { authenticated: true }),
  );
  await page.route("**/session/realtime-token", (route) =>
    json(route, 401, { detail: "Authentication required" }),
  );
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

test("people shows an initial skeleton and retains rows during refresh", async ({
  page,
}) => {
  await installSessionMocks(page);
  const role = roleFixture(OPERATOR_ID, "operator");
  const user = userFixture(
    ACTIVE_ID,
    "active@example.com",
    "active",
    OPERATOR_ID,
    "active",
  );
  let userRequests = 0;
  let releaseInitial!: () => void;
  let releaseRefresh!: () => void;
  const initialResponse = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  const refreshResponse = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route("**/bff/**", async (route) => {
    const request = route.request();
    const path = pathForRequest(request);
    if (request.method() === "GET" && path === "/users") {
      userRequests += 1;
      if (userRequests === 1) await initialResponse;
      if (userRequests === 2) await refreshResponse;
      await json(route, 200, listResponse([user]));
    } else if (request.method() === "GET" && path === "/roles") {
      await json(route, 200, listResponse([role]));
    } else if (request.method() === "POST" && path === "/users") {
      await json(route, 201, user);
    } else {
      await json(route, 404, {
        detail: `Unhandled ${request.method()} ${path}`,
      });
    }
  });

  const navigation = page.goto("/administration/users");
  await expect(page.locator('[aria-busy="true"]')).toBeVisible();
  releaseInitial();
  await navigation;
  await expect(page.getByText("active@example.com")).toBeVisible();

  await page.getByLabel("Email").fill("new@example.com");
  await page.getByRole("textbox", { name: "Username" }).fill("new");
  await page.getByRole("combobox", { name: "Role" }).selectOption(OPERATOR_ID);
  await page
    .getByRole("button", { name: "Send invitation", exact: true })
    .click();
  await expect(page.getByText("active@example.com")).toBeVisible();
  await expect(
    page.getByText("Refreshing authoritative list…", { exact: true }),
  ).toBeVisible();
  releaseRefresh();
  await expect(
    page.getByText("Invitation sent.", { exact: true }),
  ).toBeVisible();
});

test("roles use the fixed capability payload and protect built-in lifecycle", async ({
  page,
}) => {
  await installSessionMocks(page);
  const permissions = Object.fromEntries(
    CAPABILITIES.map((capability) => [capability, false]),
  );
  let roles: TestRole[] = [
    roleFixture(ADMIN_ID, "admin", false, permissions),
    roleFixture(MEMBER_ID, "member", false, permissions),
    roleFixture(OPERATOR_ID, "operator", false, { "records.read": true }),
    roleFixture(ARCHIVED_ROLE_ID, "old-operator", true, {
      "records.read": true,
    }),
  ];
  let createBody: JsonObject | undefined;
  let updateBody: JsonObject | undefined;
  let archiveAttempts = 0;
  await page.route("**/bff/**", async (route) => {
    const request = route.request();
    const path = pathForRequest(request);
    if (request.method() === "GET" && path === "/roles") {
      await json(route, 200, listResponse(roles));
    } else if (request.method() === "POST" && path === "/roles") {
      createBody = request.postDataJSON() as JsonObject;
      const created = roleFixture(
        "99999999-9999-4999-8999-999999999999",
        String(createBody.role),
        false,
        createBody.permissions as TestPermissions,
      );
      roles = [...roles, created];
      await json(route, 201, created);
    } else if (
      request.method() === "PATCH" &&
      path === `/roles/${OPERATOR_ID}`
    ) {
      const body = request.postDataJSON() as JsonObject;
      updateBody = body;
      roles = roles.map((role) =>
        role.id === OPERATOR_ID
          ? {
              ...role,
              role: String(body.role),
              permissions: body.permissions as TestPermissions,
            }
          : role,
      );
      await json(
        route,
        200,
        roles.find((role) => role.id === OPERATOR_ID),
      );
    } else if (
      request.method() === "DELETE" &&
      path === `/roles/${OPERATOR_ID}`
    ) {
      archiveAttempts += 1;
      if (archiveAttempts === 1) {
        await json(route, 409, { detail: "Role has assigned users" });
      } else {
        roles = roles.map((role) =>
          role.id === OPERATOR_ID ? { ...role, is_deleted: true } : role,
        );
        await route.fulfill({ status: 204 });
      }
    } else if (
      request.method() === "POST" &&
      path === `/roles/${ARCHIVED_ROLE_ID}/restore`
    ) {
      roles = roles.map((role) =>
        role.id === ARCHIVED_ROLE_ID
          ? { ...role, is_deleted: false, deleted_at: null }
          : role,
      );
      await json(
        route,
        200,
        roles.find((role) => role.id === ARCHIVED_ROLE_ID),
      );
    } else {
      await json(route, 404, {
        detail: `Unhandled ${request.method()} ${path}`,
      });
    }
  });

  await page.goto("/administration/roles");

  await expect(page.getByText("Built-in role", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Archive admin" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Archive member" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Exactly ten flat capabilities", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(10);

  await page.getByLabel("Role name", { exact: true }).fill("support");
  await page.getByRole("checkbox", { name: "records.write" }).check();
  await page.getByRole("button", { name: "Create role" }).click();
  await expect(page.getByText("support", { exact: true })).toBeVisible();
  await expect(page.getByText("Role created.", { exact: true })).toBeVisible();
  expect(createBody).toEqual({
    role: "support",
    permissions: { ...permissions, "records.write": true },
  });
  expect((createBody?.permissions as JsonObject)["records.write"]).toBe(true);

  await page.getByRole("button", { name: "Edit operator" }).click();
  await page.getByLabel("Role name for operator").fill("ops lead");
  await page
    .locator(`[data-role-id="${OPERATOR_ID}"]`)
    .getByRole("checkbox", { name: "records.read" })
    .uncheck();
  await page.getByRole("button", { name: "Save role operator" }).click();
  await expect(page.getByText("ops lead", { exact: true })).toBeVisible();
  expect(updateBody?.role).toBe("ops lead");
  expect((updateBody?.permissions as JsonObject)["records.read"]).toBe(false);

  await page.getByRole("button", { name: "Edit ops lead" }).click();
  await expect(page.getByLabel("Role name for ops lead")).toBeVisible();
  await page.getByRole("button", { name: "Archive ops lead" }).click();
  const archiveConfirmation = page.getByRole("alertdialog");
  await expect(
    archiveConfirmation.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  await archiveConfirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(archiveConfirmation).toHaveCount(0);
  await page.getByRole("button", { name: "Archive ops lead" }).click();
  await page.getByRole("alertdialog").press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Archive ops lead" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({
      hasText:
        "This role cannot be archived while users are assigned to it. Move those users to another role, then try again.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Role has assigned users")).toHaveCount(0);
  await expect(page.getByLabel("Role name for ops lead")).toHaveCount(0);
  await page.getByRole("button", { name: "Archive ops lead" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Restore ops lead" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Restore old-operator" }).click();
  await expect(
    page.getByRole("button", { name: "Archive old-operator" }),
  ).toBeVisible();
});

test("people reflow on mobile and expose labelled edit controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSessionMocks(page);
  const role = roleFixture(OPERATOR_ID, "operator");
  const user = userFixture(
    ACTIVE_ID,
    "mobile@example.com",
    "mobile",
    OPERATOR_ID,
    "active",
  );
  await page.route("**/bff/**", async (route) => {
    const request = route.request();
    const path = pathForRequest(request);
    if (request.method() === "GET" && path === "/users") {
      await json(route, 200, listResponse([user]));
    } else if (request.method() === "GET" && path === "/roles") {
      await json(route, 200, listResponse([role]));
    } else {
      await json(route, 404, { detail: "Unhandled mock route" });
    }
  });

  await page.goto("/administration/users");
  await page
    .getByRole("button", { name: "Actions for mobile", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Edit username and role for mobile" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Disable mobile" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Reconcile mobile authentication" }),
  ).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Username" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);

  await page
    .getByRole("menuitem", { name: "Edit username and role for mobile" })
    .click();
  await expect(page.getByLabel("Username for mobile")).toHaveValue("mobile");
  await expect(
    page.getByRole("combobox", { name: "Role for mobile" }),
  ).toHaveValue(OPERATOR_ID);
});

function pagedResponse(
  items: unknown[],
  offset: number,
  total: number,
  hasMore: boolean,
): JsonObject {
  return {
    items,
    pagination: {
      limit: 100,
      offset,
      count: items.length,
      total,
      has_more: hasMore,
    },
  };
}

test("audit and security loading skeletons use valid block markup", async ({
  page,
}) => {
  await installSessionMocks(page);
  const pending = Promise.withResolvers<void>();
  await page.route("**/bff/**", async (route) => {
    await pending.promise;
    await json(route, 200, listResponse([]));
  });

  try {
    await page.goto("/administration/audit");
    for (const label of ["Audit logs", "Security events"]) {
      await page.getByRole("tab", { name: label, exact: true }).click();
      const loading = page
        .getByRole("status")
        .filter({ hasText: `Loading ${label.toLowerCase()}…` });
      await expect(loading).toBeVisible();
      await expect(loading.locator('[aria-hidden="true"]')).toHaveCount(1);
      expect(
        await loading.evaluate((element) => element.closest("p")),
      ).toBeNull();
    }
  } finally {
    pending.resolve();
  }
});

test("audit governance switches views, filters, paginates, details, and exports", async ({
  page,
}) => {
  await installSessionMocks(page);
  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const auditFirst = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    created_at: "2026-02-01T10:00:00.000Z",
    performed_by: ADMIN_ID,
    action: "update",
    entity_type: "records",
    entity_id: ACTIVE_ID,
    before: { state: "before-value" },
    after: { state: "after-value" },
    request_id: operationId,
    request_method: "PATCH",
    request_path: "/records/66666666-6666-4666-8666-666666666666",
    actor_label: "Admin actor",
    note: "Updated from administration",
  };
  const auditSecond = {
    ...auditFirst,
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    created_at: "2026-02-02T10:00:00.000Z",
    request_path: "/records/66666666-6666-4666-8666-666666666666/page-2",
    before: { state: "second-before" },
    after: { state: "second-after" },
  };
  const securityFirst = {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    occurred_at: "2026-02-03T10:00:00.000Z",
    event_type: "login.denied",
    outcome: "denied",
    source: "identity",
    operation_id: operationId,
    actor_id: ADMIN_ID,
    subject_id: ACTIVE_ID,
    labels: {},
    fingerprint: null,
    reason: "MFA required",
    request_id: operationId,
    request_method: "POST",
    request_path: "/auth/login",
    metadata: {},
  };
  const securitySecond = {
    ...securityFirst,
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    occurred_at: "2026-02-04T10:00:00.000Z",
    event_type: "login.success",
    outcome: "success",
    reason: "MFA completed",
  };
  const requests: URL[] = [];
  await page.route("**/bff/**", async (route) => {
    const request = route.request();
    const path = pathForRequest(request);
    const url = new URL(request.url());
    if (request.method() !== "GET") {
      await json(route, 404, { detail: "Unhandled method" });
      return;
    }
    requests.push(url);
    if (path === "/audit-logs") {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      await json(
        route,
        200,
        pagedResponse(
          [offset === 100 ? auditSecond : auditFirst],
          offset,
          101,
          offset === 0,
        ),
      );
    } else if (path === "/audit-logs/export") {
      await json(route, 200, [auditSecond]);
    } else if (path === "/security-events") {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      await json(
        route,
        200,
        pagedResponse(
          [offset === 100 ? securitySecond : securityFirst],
          offset,
          101,
          offset === 0,
        ),
      );
    } else if (path === "/security-events/export") {
      await json(route, 200, [securitySecond]);
    } else {
      await json(route, 404, { detail: `Unhandled ${path}` });
    }
  });

  await page.goto("/administration/audit");
  await expect(
    page.getByRole("heading", { name: "Audit logs", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("records", { exact: true }).first(),
  ).toBeVisible();

  await page.getByLabel("Search audit trail").fill("records");
  await page.getByLabel("Action").selectOption("update");
  await page.getByLabel("Entity type").fill("records");
  await page.getByLabel("From date").fill("2026-02-01");
  await page.getByLabel("To date").fill("2026-02-28");
  await expect
    .poll(() =>
      requests.some(
        (url) =>
          url.pathname.endsWith("/audit-logs") &&
          url.searchParams.get("search") === "records" &&
          url.searchParams.get("action") === "update" &&
          url.searchParams.get("entity_type") === "records" &&
          url.searchParams.get("created_after") ===
            "2026-02-01T00:00:00.000Z" &&
          url.searchParams.get("created_before") === "2026-02-28T23:59:59.999Z",
      ),
    )
    .toBe(true);

  await page.getByRole("button", { name: "Next audit logs page" }).click();
  await expect(page.getByText("second-before", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Previous audit logs page" }),
  ).toBeEnabled();
  await expect
    .poll(() =>
      requests.some(
        (url) =>
          url.pathname.endsWith("/audit-logs") &&
          url.searchParams.get("offset") === "100",
      ),
    )
    .toBe(true);
  await expect(
    page.getByText("/records/66666666-6666-4666-8666-666666666666/page-2", {
      exact: true,
    }),
  ).toBeVisible();

  const auditDetails = page.getByText("View details", { exact: true }).first();
  await auditDetails.click();
  await expect(page.getByText(/second-before/)).toBeVisible();
  await expect(page.getByText(/second-after/)).toBeVisible();
  await expect(
    page.getByText(operationId, { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("Admin actor", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Updated from administration", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "PATCH /records/66666666-6666-4666-8666-666666666666/page-2",
      { exact: true },
    ),
  ).toBeVisible();

  const auditDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON", exact: true }).click();
  const auditDownload = await auditDownloadPromise;
  expect(auditDownload.suggestedFilename()).toBe("audit-logs.json");
  const auditExportUrl = requests.find((url) =>
    url.pathname.endsWith("/audit-logs/export"),
  );
  expect(auditExportUrl?.searchParams.get("limit")).toBe("100");
  expect(auditExportUrl?.searchParams.get("offset")).toBe("100");
  expect(auditExportUrl?.searchParams.get("sort_by")).toBe("created_at");
  expect(auditExportUrl?.searchParams.get("sort_order")).toBe("desc");
  expect(auditExportUrl?.searchParams.get("action")).toBe("update");

  const securityTab = page.getByRole("tab", { name: "Security events" });
  await securityTab.focus();
  await expect(securityTab).toHaveAttribute("aria-selected", "false");
  await expect(
    page.getByRole("heading", { name: "Audit logs", exact: true }),
  ).toBeVisible();
  await securityTab.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Security events" }),
  ).toBeVisible();
  await expect(
    page.getByText("login.denied", { exact: true }).first(),
  ).toBeVisible();
  await page.getByLabel("Search security events").fill("login");
  await page.getByLabel("Operation ID").fill(operationId);
  await expect
    .poll(() =>
      requests.some(
        (url) =>
          url.pathname.endsWith("/security-events") &&
          url.searchParams.get("search") === "login" &&
          url.searchParams.get("operation_id") === operationId,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Next security events page" }).click();
  await expect(
    page.getByText("login.success", { exact: true }).first(),
  ).toBeVisible();
  await page.getByText("View details", { exact: true }).first().click();
  await expect(page.getByText("MFA completed", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Operation ID (correlation)", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(ADMIN_ID, { exact: true })).toBeVisible();
  await expect(page.getByText(ACTIVE_ID, { exact: true })).toBeVisible();

  const securityDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON", exact: true }).click();
  const securityDownload = await securityDownloadPromise;
  expect(securityDownload.suggestedFilename()).toBe("security-events.json");
  const securityExportUrl = requests.find((url) =>
    url.pathname.endsWith("/security-events/export"),
  );
  expect(securityExportUrl?.searchParams.get("limit")).toBe("100");
  expect(securityExportUrl?.searchParams.get("operation_id")).toBe(operationId);
  expect(securityExportUrl?.searchParams.has("search")).toBe(false);
  expect(securityExportUrl?.searchParams.has("offset")).toBe(false);
  expect(securityExportUrl?.searchParams.has("sort_by")).toBe(false);
});

test("audit governance gives safe authorization and failure retry guidance", async ({
  page,
}) => {
  await installSessionMocks(page);
  let allowAudit = false;
  let allowSecurity = false;
  const emptyAudit = listResponse([]);
  const emptySecurity = listResponse([]);
  await page.route("**/bff/**", async (route) => {
    const request = route.request();
    const path = pathForRequest(request);
    if (request.method() === "GET" && path === "/audit-logs") {
      if (!allowAudit) {
        await json(route, 403, {
          detail: "internal permission explanation must not be shown",
        });
      } else {
        await json(route, 200, emptyAudit);
      }
    } else if (request.method() === "GET" && path === "/security-events") {
      if (!allowSecurity) {
        await json(route, 503, {
          detail: "internal security service secret",
        });
      } else {
        await json(route, 200, emptySecurity);
      }
    } else {
      await json(route, 404, { detail: "Unhandled mock route" });
    }
  });

  await page.goto("/administration/audit");
  await expect(
    page.getByText("Administrator access is required to load audit logs.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/internal permission explanation/)).toHaveCount(
    0,
  );
  allowAudit = true;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("No audit logs found for the current filters.", {
      exact: true,
    }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Security events" }).click();
  await expect(
    page.getByText("security events could not be loaded. Try again.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/internal security service secret/)).toHaveCount(
    0,
  );
  allowSecurity = true;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("No security events found for the current filters.", {
      exact: true,
    }),
  ).toBeVisible();
});
