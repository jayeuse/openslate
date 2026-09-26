import { expect, test } from "@playwright/test";

const userId = "00000000-0000-4000-8000-000000000001";
const roleId = "00000000-0000-4000-8000-000000000002";
const identityId = "00000000-0000-4000-8000-000000000004";
const timestamp = "2026-09-23T00:00:00Z";

function pageResult(items: unknown[]) {
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

test("Access explains where its detailed rules currently apply", async ({
  page,
}) => {
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    let body: unknown;
    const headers: Record<string, string> = {};
    if (pathname === "/api/auth/session") {
      body = { authenticated: true, user_id: userId, setup_required: false };
    } else if (pathname === "/api/access/capabilities") {
      body = {
        items: [
          {
            id: "records.read",
            label: "Read records",
            description: "Read workspace records.",
            group: "Records",
          },
        ],
      };
    } else if (pathname === "/api/roles") {
      body = pageResult([
        {
          id: roleId,
          role: "member",
          description: "Standard workspace access.",
          permissions: { "records.read": true },
          created_at: timestamp,
          updated_at: timestamp,
          deleted_at: null,
          is_deleted: false,
          performed_by: null,
        },
      ]);
    } else if (pathname === "/api/access/defaults") {
      headers.ETag = '"defaults-1"';
      body = {
        id: "00000000-0000-4000-8000-000000000003",
        default_role_id: roleId,
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
      };
    } else if (pathname === "/api/access/rules") {
      headers.ETag = '"workspace-1"';
      body = pageResult([]);
    } else if (pathname === "/api/users") {
      body = pageResult([
        {
          id: identityId,
          email: "policy-check@example.test",
          username: "policy-check",
          status: "active",
          role_id: roleId,
          display_name: "Policy check person",
          identity_kind: "internal",
          job_title: "Test identity",
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
      ]);
    } else if (
      [
        "/api/departments",
        "/api/access/groups",
        "/api/access/service-identities",
      ].includes(pathname)
    ) {
      body = pageResult([]);
    } else {
      await route.fulfill({ status: 404, body: "Unmocked API route" });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      headers,
      body: JSON.stringify(body),
    });
  });

  await page.goto("/access?view=permissions");
  await page
    .getByRole("button", { name: "Configure Everyone", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Workspace rules", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Read records options", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Advanced rule setup", exact: true })
    .click();
  await page.getByText("About rule coverage", { exact: true }).click();
  await expect(
    page.getByText(
      /Workspace-wide rules apply to Sandbox data and related files and automations, including Record values queried through OpenView or Boards and delivered in Report output\./,
    ),
  ).toBeVisible();

  await page.goto("/access?view=identities");
  await expect(
    page.getByRole("heading", { name: "People & services", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "View details for Policy check person" })
    .click();
  const preview = page.getByRole("dialog", {
    name: "Access details",
    exact: true,
  });
  await preview.getByRole("tab", { name: "Check access", exact: true }).click();
  await expect(
    preview.getByText(/This read-only check uses current workspace policy/),
  ).toBeVisible();
});
