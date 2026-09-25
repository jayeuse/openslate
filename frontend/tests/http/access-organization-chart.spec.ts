import { expect, test, type Page } from "@playwright/test";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stamp = "2026-09-26T00:00:00Z";
const metadata = {
  created_at: stamp,
  updated_at: stamp,
  deleted_at: null,
  is_deleted: false,
  performed_by: null,
};
const departments = [
  { id: id(20), department_name: "Finance", ...metadata },
  { id: id(21), department_name: "Operations", ...metadata },
];
const people = [
  {
    id: id(30),
    display_name: "Alex Morgan",
    department_ids: [id(20), id(21)],
    primary_department_id: id(20),
    identity_kind: "internal",
  },
  {
    id: id(31),
    display_name: "Taylor Brooks",
    department_ids: [id(21)],
    primary_department_id: id(21),
    identity_kind: "internal",
  },
  {
    id: id(32),
    display_name: "Robin Park",
    department_ids: [],
    primary_department_id: null,
    identity_kind: "internal",
  },
  {
    id: id(33),
    display_name: "Guest Person",
    department_ids: [],
    primary_department_id: null,
    identity_kind: "guest",
    sponsor_user_id: id(30),
    expires_at: "2027-01-01T00:00:00Z",
  },
].map((person) => ({
  ...metadata,
  email: `person-${person.id.slice(-2)}@example.test`,
  username: `person-${person.id.slice(-2)}`,
  status: "active",
  role_id: id(1),
  job_title: "Specialist",
  sponsor_user_id: null,
  expires_at: null,
  invitation_sent_at: stamp,
  ...person,
}));
function collection(items: unknown[]) {
  return {
    items,
    pagination: {
      offset: 0,
      limit: 100,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  };
}
async function setup(page: Page, empty = false) {
  const mutations: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") mutations.push(path);
    const payload: Record<string, unknown> = {
      "/api/auth/session": {
        authenticated: true,
        user_id: id(30),
        setup_required: false,
      },
      "/api/access/capabilities": {
        items: [
          {
            id: "records.read",
            label: "Read records",
            description: "Read records",
            group: "Records",
          },
        ],
      },
      "/api/users": collection(empty ? [] : people),
      "/api/roles": collection([
        {
          id: id(1),
          role: "member",
          description: "Member",
          permissions: { "records.read": true },
          ...metadata,
        },
      ]),
      "/api/departments": collection(empty ? [] : departments),
      "/api/access/groups": collection([]),
      "/api/access/service-identities": collection([]),
      "/api/access/rules": collection([]),
      "/api/access/defaults": {
        id: id(4),
        default_role_id: id(1),
        group_ids: [],
        department_ids: [],
        invitation_expiry_days: 7,
        guest_duration_days: 30,
        service_duration_days: 90,
        default_deny: true,
        require_guest_sponsor: true,
        require_service_owner: true,
        revision: 1,
        ...metadata,
      },
    };
    await route.fulfill({
      status: path in payload ? 200 : 404,
      contentType: "application/json",
      headers: { ETag: '"workspace-1"' },
      body: JSON.stringify(payload[path] ?? { detail: "Not mocked" }),
    });
  });
  await page.goto("/access?view=groups");
  await page
    .getByRole("tab", { name: "Organization chart", exact: true })
    .click();
  return mutations;
}

test("Access directories share search, sort, and expandable filter controls", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  async function expectToolbar(searchName: string, sortName: string) {
    await expect(page.getByLabel(searchName, { exact: true })).toBeVisible();
    const sort = page.getByLabel(sortName, { exact: true });
    await expect(sort).toBeVisible();
    await expect(sort).toHaveJSProperty("tagName", "SELECT");
    const moreFilters = page.getByRole("button", {
      name: "More filters",
      exact: true,
    });
    await expect(moreFilters).toHaveAttribute("aria-expanded", "false");
    return moreFilters;
  }

  await page.goto("/access?view=identities");
  const identityFilters = await expectToolbar("Search identities", "Sort");
  await expect(page.getByRole("tab", { name: /Internal/ })).toBeVisible();
  await expect(page.getByLabel("Status", { exact: true })).not.toBeVisible();
  await page
    .getByRole("searchbox", { name: "Search identities", exact: true })
    .fill("Alex Morgan");
  await page.getByLabel("Sort", { exact: true }).selectOption("kind");
  await expect(identityFilters).toHaveAccessibleDescription("0 active filters");
  await identityFilters.click();
  await expect(identityFilters).toHaveAttribute("aria-expanded", "true");
  for (const label of ["Status", "Role", "Group", "Department", "Expiry"]) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByLabel(/activity/i)).toHaveCount(0);
  await expect(
    page
      .getByLabel("Sort", { exact: true })
      .locator('option[value="activity"]'),
  ).toHaveCount(0);
  await expect(
    page
      .getByLabel("Status", { exact: true })
      .locator('option[value="deleted"], option[value="suspended"]'),
  ).toHaveCount(0);
  await page.getByLabel("Status", { exact: true }).selectOption("active");
  await expect(identityFilters).toHaveAccessibleDescription("1 active filters");
  await identityFilters.click();
  await expect(identityFilters).toHaveAttribute("aria-expanded", "false");

  await page.goto("/access?view=roles");
  const roleFilters = await expectToolbar("Search roles", "Sort");
  const roleTypes = page.getByRole("group", { name: "Filter roles" });
  await expect(roleTypes).not.toBeVisible();
  const compare = page.getByRole("button", {
    name: "Compare roles",
    exact: true,
  });
  await expect(compare).toBeVisible();
  await roleFilters.click();
  await expect(roleFilters).toHaveAttribute("aria-expanded", "true");
  await expect(roleTypes).toBeVisible();
  await expect(compare).toBeVisible();

  await page.goto("/access?view=groups");
  const groupFilters = await expectToolbar("Search groups", "Sort groups");
  await expect(
    page.getByLabel("Membership", { exact: true }),
  ).not.toBeVisible();
  await groupFilters.click();
  await expect(groupFilters).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByLabel("Membership", { exact: true })).toBeVisible();

  await page
    .getByRole("tab", { name: "Organization chart", exact: true })
    .click();
  const chartFilters = await expectToolbar(
    "Search people or departments",
    "Sort departments",
  );
  const departmentSort = page.getByLabel("Sort departments", { exact: true });
  await expect(departmentSort).toHaveValue("name");
  await departmentSort.selectOption("members");
  await expect(departmentSort).toHaveValue("members");
  const sharedMemberships = page.getByRole("checkbox", {
    name: "Shared memberships",
    exact: true,
  });
  await expect(sharedMemberships).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Fit view", exact: true }),
  ).toBeVisible();
  await chartFilters.click();
  await expect(chartFilters).toHaveAttribute("aria-expanded", "true");
  await expect(sharedMemberships).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Fit view", exact: true }),
  ).toBeVisible();
});

test("organization membership explorer selects people, searches, and restores the branded profile without writes", async ({
  page,
}) => {
  const mutations = await setup(page);
  const profile = page.getByRole("complementary", {
    name: "Organization details",
  });
  await expect(
    profile.getByRole("heading", { name: "Your organization" }),
  ).toBeVisible();
  await expect(profile).toContainText("3 internal people");
  await page
    .getByRole("button", { name: "Explore Operations", exact: true })
    .click();
  await page
    .getByRole("button", { name: "View Alex Morgan", exact: true })
    .click();
  await expect(
    profile.getByRole("heading", { name: "Alex Morgan" }),
  ).toBeVisible();
  await expect(profile).toContainText("Finance");
  await expect(profile).toContainText("Operations");
  await expect(profile).toContainText("Primary");
  const moreFilters = page.getByRole("button", {
    name: "More filters",
    exact: true,
  });
  await expect(moreFilters).toHaveAttribute("aria-expanded", "false");
  const sharedMemberships = page.getByRole("checkbox", {
    name: "Shared memberships",
    exact: true,
  });
  await expect(sharedMemberships).not.toBeVisible();
  await moreFilters.click();
  await expect(moreFilters).toHaveAttribute("aria-expanded", "true");
  await sharedMemberships.check();
  const departmentSort = page.getByLabel("Sort departments", { exact: true });
  await departmentSort.selectOption("members");
  const departmentCards = page
    .getByRole("region", { name: "Department membership graph" })
    .getByRole("button", { name: /^Explore (Finance|Operations)$/ });
  await expect(departmentCards).toHaveCount(2);
  await expect(departmentCards.nth(0)).toHaveAccessibleName(
    "Explore Operations",
  );
  await expect(departmentCards.nth(1)).toHaveAccessibleName("Explore Finance");
  await expect(profile).toContainText("Alex Morgan");
  await page.getByRole("button", { name: "Show organization profile" }).click();
  await expect(
    profile.getByRole("heading", { name: "Your organization" }),
  ).toBeVisible();
  await page
    .getByRole("searchbox", {
      name: "Search people or departments",
      exact: true,
    })
    .fill("Robin");
  await page
    .getByRole("button", { name: "Explore No department", exact: true })
    .click();
  await page
    .getByRole("button", { name: "View Robin Park", exact: true })
    .click();
  await expect(profile).toContainText("No department assigned");
  await page
    .getByRole("searchbox", {
      name: "Search people or departments",
      exact: true,
    })
    .fill("not-a-person");
  await expect(
    page.getByText("No matching people or departments"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Explore Finance", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.getByLabel("Graph zoom")).toHaveText("110%");
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Explore Operations", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Guest Person", { exact: true })).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test("organization chart handles an empty workspace and mobile membership browsing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, true);
  await expect(
    page.getByText("No internal people yet", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
