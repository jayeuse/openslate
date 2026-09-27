import { expect, test, type Page } from "@playwright/test";

const timestamp = "2026-09-23T00:00:00Z";
const roleId = "00000000-0000-4000-8000-000000000001";
const adminRoleId = "00000000-0000-4000-8000-000000000002";
const groupId = "00000000-0000-4000-8000-000000000003";
const person = {
  id: "00000000-0000-4000-8000-000000000005",
  email: "alex@example.test",
  username: "alex",
  status: "active",
  role_id: roleId,
  display_name: "Alex Ops",
  identity_kind: "internal",
  job_title: "Operator",
  sponsor_user_id: null,
  expires_at: null,
  department_ids: [],
  primary_department_id: null,
  invitation_sent_at: timestamp,
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: null,
  is_deleted: false,
  performed_by: null,
};

function collection(items: unknown[]) {
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

async function mockAccess(
  page: Page,
  onCreate?: () => void,
  acceptCreate = false,
  currentUsers: unknown[] | (() => unknown[]) = [],
) {
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (value: unknown, status = 200, headers = {}) =>
      route.fulfill({
        status,
        headers,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (pathname === "/api/auth/session")
      return json({
        authenticated: true,
        user_id: "00000000-0000-4000-8000-000000000010",
        setup_required: false,
      });
    if (pathname === "/api/access/capabilities")
      return json({
        items: [
          {
            id: "records.read",
            label: "Read records",
            description: "Read workspace records.",
            group: "Records",
          },
        ],
      });
    if (pathname === "/api/roles")
      return json(
        collection(
          [
            {
              id: roleId,
              role: "member",
              description: "Standard access.",
              permissions: { "records.read": true },
            },
            {
              id: adminRoleId,
              role: "admin",
              description: "Administration.",
              permissions: {},
            },
          ].map((role) => ({
            ...role,
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          })),
        ),
      );
    if (pathname === "/api/access/groups")
      return json(
        collection([
          {
            id: groupId,
            name: "Operations",
            description: "Operations team.",
            revision: 1,
            member_ids: [],
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          },
        ]),
      );
    if (pathname === `/api/access/groups/${groupId}`)
      return json(
        {
          id: groupId,
          name: "Operations",
          description: "Operations team.",
          revision: 1,
          member_ids: [],
          created_at: timestamp,
          updated_at: timestamp,
          deleted_at: null,
          is_deleted: false,
          performed_by: null,
        },
        200,
        { ETag: '"group-1"' },
      );
    if (pathname === "/api/access/defaults")
      return json(
        {
          id: "00000000-0000-4000-8000-000000000004",
          default_role_id: roleId,
          group_ids: [groupId],
          department_ids: [],
          invitation_expiry_days: 14,
          guest_duration_days: 30,
          service_duration_days: 90,
          default_deny: true,
          require_guest_sponsor: true,
          require_service_owner: true,
          revision: 1,
          created_at: timestamp,
          updated_at: timestamp,
          deleted_at: null,
          is_deleted: false,
          performed_by: null,
        },
        200,
        { ETag: '"defaults-1"' },
      );
    if (pathname === "/api/access/rules")
      return json(collection([]), 200, { ETag: '"workspace-1"' });
    if (pathname === "/api/users")
      return json(
        collection(
          typeof currentUsers === "function" ? currentUsers() : currentUsers,
        ),
      );
    if (
      pathname === "/api/departments" ||
      pathname === "/api/access/service-identities"
    )
      return json(collection([]));
    if (
      pathname === "/api/auth/invitations" &&
      route.request().method() === "POST"
    ) {
      onCreate?.();
      if (!acceptCreate)
        return json({ detail: "Unexpected create request" }, 500);
      return json({
        user: {
          id: "00000000-0000-4000-8000-000000000005",
          email: "alex@example.test",
          username: "alex",
          status: "pending",
          role_id: roleId,
          display_name: "Alex Ops",
          identity_kind: "internal",
          job_title: "",
          sponsor_user_id: null,
          expires_at: null,
          department_ids: [],
          primary_department_id: null,
          invitation_sent_at: timestamp,
          created_at: timestamp,
          updated_at: timestamp,
          deleted_at: null,
          is_deleted: false,
          performed_by: null,
        },
        delivery: "email",
      });
    }
    return json({ detail: "Unexpected request" }, 404);
  });
}

test("identity submission blocks before the API when its safety marker cannot be stored", async ({
  page,
}) => {
  let creates = 0;
  await mockAccess(page, () => {
    creates += 1;
  });
  await page.goto("/access?view=identities");
  await page.getByRole("button", { name: "Add person or service" }).click();
  await page.getByRole("menuitem", { name: "Internal person" }).click();
  const editor = page.getByRole("dialog", { name: /Add internal person/ });
  await editor.getByLabel("Name", { exact: true }).fill("Alex Ops");
  await editor.getByLabel("Email", { exact: true }).fill("alex@example.test");
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.endsWith(".identity") && value.includes('"state":"uncertain"'))
        throw new Error("Identity safety marker blocked");
      return setItem.call(this, key, value);
    };
  });
  await editor.getByRole("button", { name: "Add person" }).click();
  await page.getByRole("button", { name: "Create identity" }).click();

  expect(creates).toBe(0);
  await expect(editor.getByText(/cannot safely submit/i)).toBeVisible();
});

test("an accepted identity remains read only after both draft cleanup operations fail", async ({
  page,
}) => {
  let creates = 0;
  await mockAccess(
    page,
    () => {
      creates += 1;
    },
    true,
  );
  await page.goto("/access?view=identities");
  await page.getByRole("button", { name: "Add person or service" }).click();
  await page.getByRole("menuitem", { name: "Internal person" }).click();
  const editor = page.getByRole("dialog", { name: /Add internal person/ });
  await editor.getByLabel("Name", { exact: true }).fill("Alex Ops");
  await editor.getByLabel("Email", { exact: true }).fill("alex@example.test");
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    const removeItem = Storage.prototype.removeItem;
    let submissionSeen = false;
    Storage.prototype.setItem = function (key, value) {
      if (key.endsWith(".identity") && value.includes('"state":"uncertain"'))
        submissionSeen = true;
      if (
        submissionSeen &&
        key.endsWith(".identity") &&
        value.includes('"state":"retired"')
      )
        throw new Error("Identity retirement blocked");
      return setItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) {
      if (submissionSeen && key.endsWith(".identity"))
        throw new Error("Identity removal blocked");
      return removeItem.call(this, key);
    };
  });
  await editor.getByRole("button", { name: "Add person" }).click();
  await page.getByRole("button", { name: "Create identity" }).click();
  await expect(editor.getByText(/may have completed/i)).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Reload Access" }),
  ).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Discard saved draft" }),
  ).toHaveCount(0);
  expect(creates).toBe(1);

  const leavePrompts: string[] = [];
  page.on("dialog", (dialog) => {
    leavePrompts.push(dialog.type());
    void dialog.accept();
  });
  await editor.getByRole("button", { name: "Reload Access" }).click();
  expect(leavePrompts).toEqual([]);
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue(
    "Alex Ops",
  );
  await expect(
    editor.getByRole("button", { name: "Add person" }),
  ).toBeDisabled();
  await editor.getByRole("button", { name: "Discard saved draft" }).click();
  await page
    .getByRole("alertdialog", { name: "Discard uncertain identity change?" })
    .getByRole("button", { name: "Discard saved draft" })
    .click();
  await expect(editor).not.toBeVisible();
  expect(creates).toBe(1);
});

test("identity deletion does not dispatch when its safety marker cannot be stored", async ({
  page,
}) => {
  await mockAccess(page, undefined, false, [person]);
  let deletes = 0;
  page.on("request", (request) => {
    if (
      request.method() === "DELETE" &&
      new URL(request.url()).pathname === `/api/users/${person.id}`
    )
      deletes += 1;
  });
  await page.goto("/access?view=identities");
  await page
    .getByRole("button", { name: "View details for Alex Ops", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Access details", exact: true })
    .getByRole("button", { name: "Edit access", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Alex Ops" });
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.endsWith(".identity") && value.includes('"state":"uncertain"'))
        throw new Error("Identity safety marker blocked");
      return setItem.call(this, key, value);
    };
  });
  await editor.getByRole("button", { name: "Delete identity" }).click();
  await page
    .getByRole("button", { name: "Continue to name confirmation" })
    .click();
  await page
    .getByRole("dialog", { name: "Delete identity?" })
    .getByLabel("Type the name to confirm")
    .fill("Alex Ops");
  await page
    .getByRole("dialog", { name: "Delete identity?" })
    .getByRole("button", { name: "Delete identity" })
    .click();

  expect(deletes).toBe(0);
  await expect(editor.getByText(/cannot safely submit/i)).toBeVisible();
});

test("administrator role confirmation blocks before mutation when storage fails", async ({
  page,
}) => {
  await mockAccess(page, undefined, false, [person]);
  let updates = 0;
  page.on("request", (request) => {
    if (
      request.method() === "PATCH" &&
      new URL(request.url()).pathname === `/api/users/${person.id}`
    )
      updates += 1;
  });
  await page.goto("/access?view=identities");
  await page
    .getByRole("button", { name: "View details for Alex Ops", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Access details", exact: true })
    .getByRole("button", { name: "Edit access", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Alex Ops" });
  await editor.getByLabel("Role").selectOption(adminRoleId);
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.endsWith(".identity") && value.includes('"state":"uncertain"'))
        throw new Error("Identity safety marker blocked");
      return setItem.call(this, key, value);
    };
  });
  await editor.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("button", { name: "Apply changes" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Change administrator access?",
  });
  await confirmation.getByLabel("Type the name to confirm").fill("Alex Ops");
  await confirmation
    .getByRole("button", { name: "Confirm access change" })
    .click();

  expect(updates).toBe(0);
  await expect(editor.getByText(/cannot safely submit/i)).toBeVisible();
});

test("uncertain identity edit compares saved title with freshly loaded current title", async ({
  page,
}) => {
  let currentPerson = { ...person };
  let updates = 0;
  await mockAccess(page, undefined, false, () => [currentPerson]);
  await page.route(`**/api/users/${person.id}`, async (route) => {
    if (route.request().method() === "PATCH") {
      updates += 1;
      currentPerson = { ...person, job_title: "Senior operator" };
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Could not confirm update" }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(currentPerson),
    });
  });

  await page.goto("/access?view=identities");
  await page
    .getByRole("button", { name: "View details for Alex Ops", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Access details", exact: true })
    .getByRole("button", { name: "Edit access", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Alex Ops" });
  await editor.getByLabel("Job title").fill("Shift lead");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("button", { name: "Apply changes" }).click();
  await expect(editor.getByText(/may have completed/i)).toBeVisible();
  expect(updates).toBe(1);

  await editor.getByRole("button", { name: "Reload Access" }).click();
  const comparison = editor.getByRole("table", {
    name: "Saved and current identity values",
  });
  const title = comparison.getByRole("row", { name: /Job title/ });
  await expect(title.getByRole("cell", { name: "Shift lead" })).toBeVisible();
  await expect(
    title.getByRole("cell", { name: "Senior operator" }),
  ).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
});
