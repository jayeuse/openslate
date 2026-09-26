import { expect, test, type Page } from "@playwright/test";

const timestamp = "2026-09-23T00:00:00Z";
const groupId = "00000000-0000-4000-8000-000000000003";
const memberRoleId = "00000000-0000-4000-8000-000000000001";
const adminRoleId = "00000000-0000-4000-8000-000000000002";

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

async function mockGroupDeleteConflict(page: Page, deleted: string[]) {
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (value: unknown, status = 200, headers = {}) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers,
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
    if (pathname === "/api/users" || pathname === "/api/departments")
      return json(collection([]));
    if (pathname === "/api/roles")
      return json(
        collection([
          {
            id: memberRoleId,
            role: "member",
            description: "Standard workspace access.",
            permissions: {},
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          },
          {
            id: adminRoleId,
            role: "admin",
            description: "Protected administration.",
            permissions: {},
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          },
        ]),
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
    if (pathname === `/api/access/groups/${groupId}`) {
      if (route.request().method() === "DELETE") {
        deleted.push(route.request().headers()["if-match"] ?? "missing");
        return json({ detail: "Group has access rules targeting it" }, 409);
      }
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
    }
    if (pathname === "/api/access/defaults")
      return json(
        {
          id: "00000000-0000-4000-8000-000000000004",
          default_role_id: memberRoleId,
          group_ids: [],
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
    if (pathname === "/api/access/service-identities")
      return json(collection([]));
    if (pathname === "/api/access/rules")
      return json(collection([]), 200, { ETag: '"workspace-1"' });
    return json({ detail: "Unexpected Access HTTP request" }, 404);
  });
}

test("group deletion explains rule references and preserves the editor after a conflict", async ({
  page,
}) => {
  const deletePreconditions: string[] = [];
  await mockGroupDeleteConflict(page, deletePreconditions);
  await page.goto("/access?view=permissions");
  await page
    .getByRole("button", { name: "Configure Operations", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Manage members", exact: true })
    .click();
  await page.getByRole("button", { name: "Delete group" }).click();
  await expect(
    page.getByText(/Deleting the group will not delete those rules/),
  ).toBeVisible();
  await page
    .getByRole("alertdialog")
    .getByLabel("Group name")
    .fill("Operations");
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete group" })
    .click();

  await expect(
    page.getByText(
      "Open Permissions to remove or retarget this group's rules before deleting it.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Edit Operations" }),
  ).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(deletePreconditions).toEqual(['"group-1"']);
});
