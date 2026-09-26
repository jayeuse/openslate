import { expect, test, type Page } from "@playwright/test";

const timestamp = "2026-09-23T00:00:00Z";
const ids = {
  memberRole: "00000000-0000-4000-8000-000000000001",
  adminRole: "00000000-0000-4000-8000-000000000002",
  group: "00000000-0000-4000-8000-000000000003",
  defaults: "00000000-0000-4000-8000-000000000004",
  person: "00000000-0000-4000-8000-000000000005",
};

const person = {
  id: ids.person,
  email: "alex@example.test",
  username: "alex",
  status: "active",
  role_id: ids.memberRole,
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

const roles = [
  {
    id: ids.memberRole,
    role: "member",
    description: "Standard workspace access.",
    permissions: { "records.read": true },
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  },
  {
    id: ids.adminRole,
    role: "admin",
    description: "Protected administration.",
    permissions: {},
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  },
];

const group = {
  id: ids.group,
  name: "Operations",
  description: "Operations team.",
  revision: 1,
  member_ids: [] as string[],
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: null,
  is_deleted: false,
  performed_by: null,
};

const defaults = {
  id: ids.defaults,
  default_role_id: ids.memberRole,
  group_ids: [ids.group],
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

const directoryUsers = [
  { ...person, role_id: ids.adminRole },
  {
    ...person,
    id: "00000000-0000-4000-8000-000000000006",
    email: "jamie@example.test",
    username: "jamie",
    display_name: "Jamie Chen",
  },
  {
    ...person,
    id: "00000000-0000-4000-8000-000000000007",
    email: "sam@example.test",
    username: "sam",
    display_name: "Sam Rivera",
    identity_kind: "guest" as const,
    status: "pending",
    job_title: null,
    sponsor_user_id: ids.person,
    expires_at: "2026-10-25T16:00:00Z",
  },
  {
    ...person,
    id: "00000000-0000-4000-8000-000000000008",
    email: "taylor@example.test",
    username: "taylor",
    display_name: "Taylor Brooks",
    identity_kind: "guest" as const,
    sponsor_user_id: "00000000-0000-4000-8000-000000000011",
    expires_at: "2026-12-31T16:00:00Z",
  },
];

const directoryServices = [
  {
    id: "00000000-0000-4000-8000-000000000009",
    name: "Weekly summary sync",
    purpose: "Prepare workspace summaries",
    owner_id: ids.person,
    role_id: ids.memberRole,
    expires_at: "2026-12-31T16:00:00Z",
    status: "active",
    effective_status: "active",
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  },
];

function page(items: unknown[]) {
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

async function mockAccessApi(
  pageUnderTest: Page,
  groupPresent: () => boolean = () => true,
  currentRules: () => unknown[] = () => [],
  currentUsers: () => unknown[] = () => [],
  currentRoles: () => unknown[] = () => roles,
  currentGroups: () => (typeof group)[] = () => (groupPresent() ? [group] : []),
  currentServices: () => unknown[] = () => [],
) {
  await pageUnderTest.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/auth/session") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          authenticated: true,
          user_id: "00000000-0000-4000-8000-000000000010",
          setup_required: false,
        }),
      });
      return;
    }
    if (pathname === "/api/access/capabilities") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: "records.read",
              label: "Read records",
              description: "Read workspace records.",
              group: "Records",
            },
          ],
        }),
      });
      return;
    }
    if (pathname === "/api/users") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(page(currentUsers())),
      });
      return;
    }
    if (pathname === "/api/roles") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(page(currentRoles())),
      });
      return;
    }
    if (pathname === "/api/departments") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(page([])),
      });
      return;
    }
    if (pathname === "/api/access/groups") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(page(currentGroups())),
      });
      return;
    }
    if (pathname.startsWith("/api/access/groups/")) {
      const currentGroup = currentGroups().find(
        (item) => item.id === pathname.slice("/api/access/groups/".length),
      );
      if (!currentGroup) {
        await route.fulfill({ status: 404, body: "Group not found" });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        headers: { ETag: `"group-${currentGroup.revision}"` },
        body: JSON.stringify(currentGroup),
      });
      return;
    }
    if (pathname === "/api/access/defaults") {
      await route.fulfill({
        contentType: "application/json",
        headers: { ETag: '"defaults-1"' },
        body: JSON.stringify(defaults),
      });
      return;
    }
    if (pathname === "/api/access/service-identities") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(page(currentServices())),
      });
      return;
    }
    if (pathname.startsWith("/api/access/service-identities/")) {
      const identity = currentServices().find(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "id" in item &&
          item.id === pathname.slice("/api/access/service-identities/".length),
      );
      if (!identity) {
        await route.fulfill({
          status: 404,
          body: "Service identity not found",
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        headers: { ETag: '"service-1"' },
        body: JSON.stringify(identity),
      });
      return;
    }
    if (pathname === "/api/access/rules") {
      await route.fulfill({
        contentType: "application/json",
        headers: { ETag: '"workspace-1"' },
        body: JSON.stringify(page(currentRules())),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        detail: "This HTTP test did not mock the request.",
      }),
    });
  });
}

async function openPermissionSubject(pageUnderTest: Page, name: string) {
  await pageUnderTest.goto("/access?view=permissions");
  const configure = pageUnderTest.getByRole("button", {
    name: `Configure ${name}`,
    exact: true,
  });
  if ((await configure.getAttribute("aria-expanded")) !== "true")
    await configure.click();
  await expect(configure).toHaveAttribute("aria-expanded", "true");
  return configure;
}

async function openEveryoneRules(pageUnderTest: Page) {
  await openPermissionSubject(pageUnderTest, "Everyone");
  await expect(
    pageUnderTest.getByRole("heading", {
      name: "Workspace rules",
      exact: true,
    }),
  ).toBeVisible();
}

async function openGroupEditor(pageUnderTest: Page, name: string) {
  await openPermissionSubject(pageUnderTest, name);
  await pageUnderTest
    .getByRole("button", { name: "Manage members", exact: true })
    .click();
}

async function openRoleEditor(pageUnderTest: Page, name: string) {
  await openPermissionSubject(pageUnderTest, name);
  await pageUnderTest
    .getByRole("button", { name: "Edit role", exact: true })
    .click();
}

async function openCreateDialog(pageUnderTest: Page, kind: "role" | "group") {
  await pageUnderTest
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await pageUnderTest
    .getByRole("menuitem", {
      name: `Create ${kind}`,
      exact: true,
    })
    .click();
}

test("shared directory pagination shows current page and respects boundaries", async ({
  page,
}) => {
  const extraRoles = Array.from({ length: 6 }, (_, index) => ({
    ...roles[0]!,
    id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
    role: `role-${index}`,
  }));
  const extraGroups = Array.from({ length: 6 }, (_, index) => ({
    ...group,
    id: `00000000-0000-4000-8000-${String(index + 200).padStart(12, "0")}`,
    name: `Group ${index}`,
  }));
  await mockAccessApi(
    page,
    () => true,
    () => [],
    () => [],
    () => extraRoles,
    () => extraGroups,
  );
  for (const subjectType of ["Roles", "Groups"]) {
    await page.goto("/access?view=permissions");
    const moreFilters = page.getByRole("button", {
      name: "More filters",
      exact: true,
    });
    await expect(moreFilters).toHaveAttribute("aria-expanded", "false");
    await moreFilters.click();
    await expect(moreFilters).toHaveAttribute("aria-expanded", "true");
    await page
      .getByLabel("Subject type", { exact: true })
      .selectOption({ label: subjectType });
    await page.getByLabel("Rows per page").selectOption("5");
    const navigation = page.getByRole("navigation", {
      name: "Permissions directory pages",
    });
    await expect(
      navigation.getByLabel("Page 1 of 2", { exact: true }),
    ).toHaveText("1");
    await expect(
      navigation.getByRole("button", { name: "Go to previous page" }),
    ).toBeDisabled();
    await navigation.getByRole("button", { name: "Go to next page" }).click();
    await expect(
      navigation.getByLabel("Page 2 of 2", { exact: true }),
    ).toHaveText("2");
    await expect(
      navigation.getByRole("button", { name: "Go to next page" }),
    ).toBeDisabled();
    await navigation
      .getByRole("button", { name: "Go to previous page" })
      .click();
    await expect(
      navigation.getByLabel("Page 1 of 2", { exact: true }),
    ).toHaveText("1");
  }
  await openEveryoneRules(page);
  const navigation = page.getByRole("navigation", { name: "Permission pages" });
  await expect(
    navigation.getByLabel("Page 1 of 1", { exact: true }),
  ).toHaveText("1");
  await expect(
    navigation.getByRole("button", { name: "Go to previous page" }),
  ).toBeDisabled();
  await expect(
    navigation.getByRole("button", { name: "Go to next page" }),
  ).toBeDisabled();
});

test("manual groups can be filtered, sorted, and searched while editing membership", async ({
  page: pageUnderTest,
}) => {
  const morgan = {
    ...person,
    id: "00000000-0000-4000-8000-000000000021",
    email: "morgan@example.test",
    username: "morgan",
    display_name: "Morgan Guest",
    identity_kind: "guest" as const,
    job_title: null,
    sponsor_user_id: ids.person,
    expires_at: "2026-10-25T16:00:00Z",
  };
  const groups = [
    {
      ...group,
      id: "00000000-0000-4000-8000-000000000031",
      name: "Operations",
      description: "Late shift coverage.",
      member_ids: [person.id],
    },
    {
      ...group,
      id: "00000000-0000-4000-8000-000000000032",
      name: "Analytics",
      description: "Metrics review.",
      member_ids: [],
    },
    {
      ...group,
      id: "00000000-0000-4000-8000-000000000033",
      name: "Support",
      description: "Help desk rotation.",
      member_ids: [person.id, morgan.id],
    },
  ];
  await mockAccessApi(
    pageUnderTest,
    undefined,
    undefined,
    () => [person, morgan],
    undefined,
    () => groups,
  );

  await pageUnderTest.setViewportSize({ width: 1280, height: 900 });
  await pageUnderTest.goto("/access?view=permissions");
  const moreFilters = pageUnderTest.getByRole("button", {
    name: "More filters",
    exact: true,
  });
  await expect(moreFilters).toHaveAttribute("aria-expanded", "false");
  await moreFilters.click();
  await expect(moreFilters).toHaveAttribute("aria-expanded", "true");
  await pageUnderTest
    .getByLabel("Subject type", { exact: true })
    .selectOption({ label: "Groups" });
  const table = pageUnderTest.getByRole("table", {
    name: "Permissions directory",
  });
  const membership = pageUnderTest.getByLabel("Membership");
  const sort = pageUnderTest.getByLabel("Sort permissions");

  await expect(table.getByRole("row").nth(1)).toContainText("Analytics");
  await membership.selectOption("with-members");
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table).not.toContainText("Analytics");
  await expect(pageUnderTest.getByText("Showing 1–2 of 2")).toBeVisible();

  await membership.selectOption("empty");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table).toContainText("Analytics");
  await expect(table).not.toContainText("Operations");

  await membership.selectOption("all");
  await sort.selectOption("members");
  await expect(table.getByRole("row").nth(1)).toContainText("Support");
  await expect(table.getByRole("row").nth(2)).toContainText("Operations");

  const createTrigger = pageUnderTest.getByRole("button", {
    name: "Create",
    exact: true,
  });
  await openCreateDialog(pageUnderTest, "group");
  const editor = pageUnderTest.getByRole("dialog", { name: "Create group" });
  await expect(editor.getByText("0 selected")).toBeVisible();
  await expect(
    editor.getByText(
      "Manual groups do not nest. Service identities cannot join.",
    ),
  ).toBeVisible();
  await expect(
    editor.getByRole("checkbox", { name: /Alex Ops/ }),
  ).toBeVisible();
  await expect(
    editor.getByRole("checkbox", { name: /Morgan Guest/ }),
  ).toBeVisible();

  const memberSearch = editor.getByLabel("Search members");
  await memberSearch.fill("morgan");
  await expect(
    editor.getByRole("checkbox", { name: /Morgan Guest/ }),
  ).toBeVisible();
  await expect(editor.getByRole("checkbox", { name: /Alex Ops/ })).toHaveCount(
    0,
  );
  await memberSearch.fill("alex@example.test");
  await expect(
    editor.getByRole("checkbox", { name: /Alex Ops/ }),
  ).toBeVisible();
  await expect(
    editor.getByRole("checkbox", { name: /Morgan Guest/ }),
  ).toHaveCount(0);
  await memberSearch.clear();
  await editor.getByRole("checkbox", { name: /Alex Ops/ }).check();
  await expect(editor.getByText("1 selected")).toBeVisible();
  await memberSearch.fill("morgan");
  await expect(editor.getByText("1 selected")).toBeVisible();

  await editor.getByRole("button", { name: "Cancel" }).click();
  await pageUnderTest.getByRole("button", { name: "Discard changes" }).click();
  await expect(editor).not.toBeVisible();
  await expect(createTrigger).toBeFocused();
  await openCreateDialog(pageUnderTest, "group");
  const freshEditor = pageUnderTest.getByRole("dialog", {
    name: "Create group",
  });
  await expect(freshEditor.getByLabel("Search members")).toHaveValue("");
  await freshEditor.getByRole("button", { name: "Cancel" }).click();
  await pageUnderTest.getByRole("button", { name: "Discard changes" }).click();
  await expect(createTrigger).toBeFocused();

  const support = table.getByRole("button", {
    name: "Configure Support",
    exact: true,
  });
  await support.click();
  const manageMembers = pageUnderTest.getByRole("button", {
    name: "Manage members",
    exact: true,
  });
  await manageMembers.click();
  const supportEditor = pageUnderTest.getByRole("dialog", {
    name: "Edit Support",
  });
  await supportEditor.getByRole("button", { name: "Cancel" }).click();
  await expect(manageMembers).toBeFocused();
});

for (const destination of [
  {
    label: "People & services",
    subject: "People & services",
    query: { view: "identities" },
  },
  {
    label: "Roles",
    subject: "Configure Member",
    query: { view: "permissions", type: "roles" },
  },
  {
    label: "Groups",
    subject: "Configure Operations",
    query: { view: "permissions", type: "groups" },
  },
  {
    label: "Custom rules",
    subject: "Workspace rules",
    query: { view: "permissions", configure: "everyone" },
  },
] as const) {
  test(`Access overview ${destination.label} quick action opens its directory`, async ({
    page: pageUnderTest,
  }) => {
    await mockAccessApi(pageUnderTest);
    await pageUnderTest.goto("/access?view=overview");
    await pageUnderTest
      .getByRole("button", { name: new RegExp(`^Open ${destination.label}:`) })
      .click();
    await expect(pageUnderTest).toHaveURL(
      (url) =>
        url.pathname === "/access" &&
        Object.entries(destination.query).every(
          ([key, value]) => url.searchParams.get(key) === value,
        ),
      { timeout: 15_000 },
    );
    if (destination.subject === "People & services") {
      await expect(
        pageUnderTest.getByRole("heading", {
          name: "People & services",
          exact: true,
        }),
      ).toBeVisible();
    } else {
      await expect(
        pageUnderTest.getByRole("heading", {
          name: "Permissions",
          exact: true,
        }),
      ).toBeVisible();
      if (destination.subject === "Workspace rules") {
        await expect(
          pageUnderTest.getByRole("heading", {
            name: "Workspace rules",
            exact: true,
          }),
        ).toBeVisible();
      } else {
        await expect(
          pageUnderTest.getByRole("button", {
            name: destination.subject,
            exact: true,
          }),
        ).toBeVisible();
      }
    }
  });
}

test("People & services keeps kind filters, advanced filters, and pagination together", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(
    pageUnderTest,
    () => true,
    () => [],
    () => directoryUsers,
    () => roles,
    () => [group],
    () => directoryServices,
  );
  await pageUnderTest.setViewportSize({ width: 1280, height: 900 });
  await pageUnderTest.goto("/access?view=identities");

  await expect(
    pageUnderTest.getByRole("heading", { name: "People & services" }),
  ).toBeVisible();
  await expect(pageUnderTest.getByRole("tab", { name: "All 5" })).toBeVisible();
  await expect(
    pageUnderTest.getByRole("tab", { name: "Internal 2" }),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByRole("tab", { name: "Guests 2" }),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByRole("tab", { name: "Services 1" }),
  ).toBeVisible();
  await expect(pageUnderTest.getByText("Showing 1–5 of 5")).toBeVisible();
  await expect(pageUnderTest.getByLabel("Rows per page")).toHaveValue("10");
  await expect(
    pageUnderTest.getByRole("button", {
      name: "View details for Taylor Brooks",
    }),
  ).toBeVisible();

  await pageUnderTest.getByLabel("Rows per page").selectOption("5");
  await expect(pageUnderTest.getByText("Showing 1–5 of 5")).toBeVisible();
  await expect(
    pageUnderTest.getByRole("button", { name: "Go to next page" }),
  ).toBeDisabled();
  await expect(
    pageUnderTest.getByRole("button", { name: "Go to previous page" }),
  ).toBeDisabled();
  await expect(
    pageUnderTest.getByLabel("Page 1 of 1", { exact: true }),
  ).toHaveText("1");

  await pageUnderTest.getByRole("tab", { name: "Internal 2" }).click();
  await pageUnderTest
    .getByRole("button", { name: "More filters", exact: true })
    .click();
  await pageUnderTest.getByLabel("Role").selectOption(ids.adminRole);
  await expect(pageUnderTest.getByText("Showing 1–1 of 1")).toBeVisible();
  await expect(
    pageUnderTest.getByRole("button", { name: "View details for Alex Ops" }),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByRole("button", { name: "View details for Jamie Chen" }),
  ).toHaveCount(0);

  await expect(
    pageUnderTest.getByRole("button", { name: "Reset directory" }),
  ).toHaveCount(0);
  await pageUnderTest.getByLabel("Role").selectOption("all");
  await pageUnderTest.getByRole("tab", { name: "All 5" }).click();
  await expect(pageUnderTest.getByText("Showing 1–5 of 5")).toBeVisible();
  await expect(pageUnderTest.getByLabel("Rows per page")).toHaveValue("5");
  await expect(
    pageUnderTest.getByRole("tab", { name: "All 5" }),
  ).toHaveAttribute("aria-selected", "true");
});

test("identity previews show current kind-specific details without making changes", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(
    pageUnderTest,
    () => true,
    () => [],
    () => directoryUsers,
    () => roles,
    () => [group],
    () => directoryServices,
  );
  const mutations = trackAccessMutations(pageUnderTest);
  await pageUnderTest.setViewportSize({ width: 1280, height: 900 });
  await pageUnderTest.goto("/access?view=identities");
  await pageUnderTest.getByLabel("Rows per page").selectOption("5");

  const preview = pageUnderTest.getByRole("dialog", {
    name: "Access details",
  });

  await pageUnderTest
    .getByRole("button", { name: "View details for Alex Ops" })
    .click();
  await expect(
    preview.getByRole("heading", { name: "Alex Ops" }),
  ).toBeVisible();
  await expect(preview.getByText("alex@example.test")).toBeVisible();
  await expect(preview.getByText("Internal", { exact: true })).toBeVisible();
  await expect(preview.getByText("Active", { exact: true })).toBeVisible();
  await expect(
    preview.getByText("Administrator", { exact: true }),
  ).toBeVisible();
  await expect(preview.getByText("No expiry", { exact: true })).toBeVisible();
  await preview
    .getByRole("button", { name: "Close access details", exact: true })
    .click();
  await expect(preview).toBeHidden();

  await pageUnderTest
    .getByRole("button", { name: "View details for Sam Rivera" })
    .click();
  await expect(preview.getByText("Sponsor", { exact: true })).toBeVisible();
  await expect(preview.getByText("Alex Ops", { exact: true })).toBeVisible();
  await expect(
    preview.getByText("Access expires", { exact: true }),
  ).toBeVisible();
  await preview
    .getByRole("button", { name: "Close access details", exact: true })
    .click();

  await pageUnderTest
    .getByRole("button", { name: "View details for Taylor Brooks" })
    .click();
  await expect(preview.getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(preview.getByText("Sponsor", { exact: true })).toBeVisible();
  await preview
    .getByRole("button", { name: "Close access details", exact: true })
    .click();

  await pageUnderTest
    .getByRole("button", { name: "View details for Weekly summary sync" })
    .click();
  await expect(preview.getByText("Owner", { exact: true })).toBeVisible();
  await expect(preview.getByText("Alex Ops", { exact: true })).toBeVisible();
  await expect(
    preview.getByText("Prepare workspace summaries", { exact: true }),
  ).toBeVisible();
  await expect(
    preview.getByText("Access expires", { exact: true }),
  ).toBeVisible();
  await expect(preview.getByRole("textbox")).toHaveCount(0);

  expect(mutations).toEqual([]);
});

test("identity preview restores focus on Escape and hands off to the existing editor", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(
    pageUnderTest,
    () => true,
    () => [],
    () => directoryUsers,
    () => roles,
    () => [group],
    () => directoryServices,
  );
  const mutations = trackAccessMutations(pageUnderTest);
  await pageUnderTest.setViewportSize({ width: 1280, height: 900 });
  await pageUnderTest.goto("/access?view=identities");

  const trigger = pageUnderTest.getByRole("button", {
    name: "View details for Alex Ops",
  });
  await trigger.click();
  const preview = pageUnderTest.getByRole("dialog", {
    name: "Access details",
  });
  await expect(preview).toBeVisible();
  await pageUnderTest.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await pageUnderTest
    .getByRole("dialog", { name: "Access details" })
    .getByRole("button", { name: "Edit access" })
    .click();

  const editor = pageUnderTest.getByRole("dialog", { name: "Alex Ops" });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue(
    "Alex Ops",
  );
  await expect(pageUnderTest).toHaveURL(
    new RegExp(`/access\\?view=identities&user=${ids.person}$`),
  );
  expect(mutations).toEqual([]);
});

test("Access rule drafts pause security navigation and resume only after discard", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(pageUnderTest);
  await pageUnderTest.setViewportSize({ width: 390, height: 844 });
  await pageUnderTest.goto("/access?view=overview");
  await expect(
    pageUnderTest.getByRole("heading", { name: "Access overview" }),
  ).toBeVisible();

  await pageUnderTest.getByRole("button", { name: "Open Groups" }).click();
  await expect(
    pageUnderTest.getByRole("heading", { name: "Permissions", exact: true }),
  ).toBeVisible();
  await pageUnderTest
    .getByRole("button", { name: "Configure Operations", exact: true })
    .click();
  await expect(
    pageUnderTest.getByRole("heading", {
      name: "Workspace rules",
      exact: true,
    }),
  ).toBeVisible();

  const decision = pageUnderTest.getByRole("group", {
    name: "Read records decision",
  });
  await decision.getByRole("button", { name: "Allow" }).click();
  await expect(pageUnderTest.getByText("1 staged change")).toBeVisible();
  const permissionsUrl = pageUnderTest.url();

  await pageUnderTest.getByRole("link", { name: /Sign-in & security/ }).click();
  await expect(
    pageUnderTest.getByRole("heading", {
      name: "Discard unsaved Access changes?",
    }),
  ).toBeVisible();
  await expect(pageUnderTest).toHaveURL(permissionsUrl);

  await pageUnderTest.getByRole("button", { name: "Keep editing" }).click();
  await expect(decision.getByRole("button", { name: "Allow" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await pageUnderTest.getByRole("link", { name: /Sign-in & security/ }).click();
  await pageUnderTest
    .getByRole("button", { name: "Discard and continue" })
    .click();
  await expect(pageUnderTest).toHaveURL(/\/manage\?view=security$/);
});

async function openDirtyDefaults(pageUnderTest: Page) {
  await mockAccessApi(pageUnderTest);
  await pageUnderTest.goto("/access?view=overview");
  await pageUnderTest.getByRole("button", { name: "Edit defaults" }).click();
  await pageUnderTest.getByLabel("Invitation expiry days").fill("21");
}

function trackAccessMutations(pageUnderTest: Page): string[] {
  const mutations: string[] = [];
  pageUnderTest.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (
      request.method() !== "GET" &&
      (pathname === "/api/users" ||
        pathname === "/api/roles" ||
        pathname.startsWith("/api/access/"))
    ) {
      mutations.push(`${request.method()} ${pathname}`);
    }
  });
  return mutations;
}

async function discardRestoredDraft(
  pageUnderTest: Page,
  editor: ReturnType<Page["getByRole"]>,
) {
  await editor.getByRole("button", { name: "Cancel" }).click();
  await pageUnderTest.getByRole("button", { name: "Discard changes" }).click();
  await expect(editor).not.toBeVisible();
  await pageUnderTest.reload();
  await expect(editor).not.toBeVisible();
}

test("Escape asks before closing a dirty Access defaults draft", async ({
  page: pageUnderTest,
}) => {
  await openDirtyDefaults(pageUnderTest);

  await pageUnderTest.keyboard.press("Escape");

  await expect(
    pageUnderTest.getByRole("heading", {
      name: "Discard unsaved Access defaults?",
    }),
  ).toBeVisible();
  await expect(pageUnderTest.getByLabel("Invitation expiry days")).toHaveValue(
    "21",
  );
});

test("Cancel asks before discarding a dirty Access defaults draft", async ({
  page: pageUnderTest,
}) => {
  await openDirtyDefaults(pageUnderTest);
  await pageUnderTest.getByRole("button", { name: "Cancel" }).click();

  await expect(
    pageUnderTest.getByRole("heading", {
      name: "Discard unsaved Access defaults?",
    }),
  ).toBeVisible();
  await expect(pageUnderTest.getByLabel("Invitation expiry days")).toHaveValue(
    "21",
  );

  await pageUnderTest.getByRole("button", { name: "Keep editing" }).click();
  await expect(pageUnderTest.getByLabel("Invitation expiry days")).toHaveValue(
    "21",
  );
  await pageUnderTest.getByRole("button", { name: "Cancel" }).click();
  await pageUnderTest.getByRole("button", { name: "Discard changes" }).click();
  await expect(
    pageUnderTest.getByRole("button", { name: "Edit defaults" }),
  ).toBeVisible();
});

test("an accepted reload restores unsaved Access defaults without saving", async ({
  page: pageUnderTest,
}) => {
  await openDirtyDefaults(pageUnderTest);
  await pageUnderTest
    .getByRole("group", { name: "Default groups" })
    .getByRole("button", { name: "Operations" })
    .click();
  const writes: string[] = [];
  pageUnderTest.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/access/defaults" &&
      request.method() !== "GET"
    )
      writes.push(request.method());
  });

  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();

  await expect(
    pageUnderTest.getByRole("heading", { name: "Access defaults" }),
  ).toBeVisible();
  await expect(pageUnderTest.getByLabel("Invitation expiry days")).toHaveValue(
    "21",
  );
  await expect(
    pageUnderTest
      .getByRole("group", { name: "Default groups" })
      .getByRole("button", { name: "Operations" }),
  ).toHaveAttribute("aria-pressed", "false");
  expect(writes).toEqual([]);

  await pageUnderTest.getByRole("button", { name: "Cancel" }).click();
  await pageUnderTest.getByRole("button", { name: "Discard changes" }).click();
  await pageUnderTest.reload();
  await pageUnderTest.getByRole("button", { name: "Edit defaults" }).click();
  await expect(pageUnderTest.getByLabel("Invitation expiry days")).toHaveValue(
    "14",
  );
});

test("an accepted reload restores an unsaved role name and description", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(pageUnderTest);
  await pageUnderTest.goto("/access?view=permissions");
  await openCreateDialog(pageUnderTest, "role");
  await pageUnderTest.getByLabel("Role name").fill("Shift lead");
  await pageUnderTest.getByLabel("Description").fill("Coordinates handoffs");
  await pageUnderTest.getByRole("checkbox", { name: "Read records" }).check();

  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();

  await expect(
    pageUnderTest.getByRole("heading", { name: "Create role" }),
  ).toBeVisible();
  await expect(pageUnderTest.getByLabel("Role name")).toHaveValue("Shift lead");
  await expect(pageUnderTest.getByLabel("Description")).toHaveValue(
    "Coordinates handoffs",
  );
  await expect(
    pageUnderTest.getByRole("checkbox", { name: "Read records" }),
  ).toBeChecked();

  await pageUnderTest.getByRole("button", { name: "Cancel" }).click();
  await pageUnderTest.getByRole("button", { name: "Discard changes" }).click();
  await pageUnderTest.reload();
  await expect(
    pageUnderTest.getByRole("dialog", { name: "Create role" }),
  ).not.toBeVisible();
});

test("a saved role cannot reopen for duplicate submission when draft removal fails", async ({
  page: pageUnderTest,
}) => {
  let currentRoles = [...roles];
  let creates = 0;
  await mockAccessApi(
    pageUnderTest,
    undefined,
    undefined,
    undefined,
    () => currentRoles,
  );
  await pageUnderTest.route("**/api/roles", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(page(currentRoles)),
      });
      return;
    }
    creates += 1;
    const input = route.request().postDataJSON() as {
      role: string;
      description: string;
      permissions: Record<string, boolean>;
    };
    const created = {
      ...roles[0],
      id: "00000000-0000-4000-8000-000000000020",
      role: input.role,
      description: input.description ?? null,
      permissions: input.permissions,
    };
    currentRoles = [...currentRoles, created];
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(created),
    });
  });
  await pageUnderTest.addInitScript(() => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key.startsWith("openslate.access.draft.v1.") && key.endsWith(".role"))
        throw new Error("Access role removal blocked");
      return remove.call(this, key);
    };
  });

  await pageUnderTest.goto("/access?view=permissions");
  await openCreateDialog(pageUnderTest, "role");
  await pageUnderTest.getByLabel("Role name").fill("Shift lead");
  await pageUnderTest.getByRole("button", { name: "Save role" }).click();
  await pageUnderTest.getByRole("button", { name: "Apply changes" }).click();
  await expect(
    pageUnderTest.getByRole("alertdialog", { name: "Apply role changes?" }),
  ).not.toBeVisible();
  await expect(
    pageUnderTest.getByRole("dialog", { name: "Create role" }),
  ).not.toBeVisible();
  expect(creates).toBe(1);

  const retired = await pageUnderTest.evaluate(() => {
    const key = Object.keys(sessionStorage).find((value) =>
      value.endsWith(".role"),
    );
    return key ? JSON.parse(sessionStorage.getItem(key) ?? "null") : null;
  });
  expect(retired).toMatchObject({ state: "retired", owner: "role" });
  await pageUnderTest.reload();
  await expect(
    pageUnderTest.getByRole("dialog", { name: "Create role" }),
  ).not.toBeVisible();
  expect(creates).toBe(1);
});

test("an accepted role stays locked after both draft cleanup operations fail", async ({
  page: pageUnderTest,
}) => {
  let currentRoles: Array<
    Omit<(typeof roles)[number], "permissions"> & {
      permissions: Record<string, boolean | undefined>;
    }
  > = [...roles];
  let creates = 0;
  await mockAccessApi(
    pageUnderTest,
    undefined,
    undefined,
    undefined,
    () => currentRoles,
  );
  await pageUnderTest.route("**/api/access/capabilities", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "records.read",
            label: "Read records",
            description: "Read workspace records.",
            group: "Records",
          },
          {
            id: "records.write",
            label: "Update records",
            description: "Update workspace records.",
            group: "Records",
          },
        ],
      }),
    });
  });
  await pageUnderTest.route("**/api/roles", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(page(currentRoles)),
      });
      return;
    }
    creates += 1;
    const input = route.request().postDataJSON() as {
      role: string;
      description: string;
      permissions: Record<string, boolean>;
    };
    const created = {
      ...roles[0],
      id: "00000000-0000-4000-8000-000000000021",
      role: input.role,
      description: input.description ?? null,
      permissions: input.permissions,
    };
    currentRoles = [
      ...currentRoles,
      {
        ...created,
        description: "Current approved duties.",
        permissions: { "records.write": true },
      },
    ];
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(created),
    });
  });
  await pageUnderTest.addInitScript(() => {
    const set = Storage.prototype.setItem;
    const remove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        key.startsWith("openslate.access.draft.v1.") &&
        key.endsWith(".role") &&
        JSON.parse(value).state === "retired" &&
        sessionStorage.getItem("test.allowAccessCleanup") !== "1"
      )
        throw new Error("Access role retirement blocked");
      return set.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) {
      if (
        key.startsWith("openslate.access.draft.v1.") &&
        key.endsWith(".role") &&
        sessionStorage.getItem("test.allowAccessCleanup") !== "1"
      )
        throw new Error("Access role removal blocked");
      return remove.call(this, key);
    };
  });

  await pageUnderTest.goto("/access?view=permissions");
  await openCreateDialog(pageUnderTest, "role");
  await pageUnderTest.getByLabel("Role name").fill(" Shift lead ");
  await pageUnderTest.getByLabel("Description").fill("Draft night duties.");
  await pageUnderTest.getByRole("checkbox", { name: "Read records" }).check();
  await pageUnderTest.getByRole("button", { name: "Save role" }).click();
  await pageUnderTest.getByRole("button", { name: "Apply changes" }).click();
  expect(creates).toBe(1);

  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();
  await expect(pageUnderTest.getByLabel("Role name")).toHaveValue(
    " Shift lead ",
  );
  await expect(
    pageUnderTest.getByRole("button", { name: "Save role" }),
  ).toBeDisabled();
  await expect(
    pageUnderTest.getByText(
      "Current role: Shift lead, with 1 standard permission.",
    ),
  ).toBeVisible();
  const savedRole = pageUnderTest.getByRole("region", {
    name: "Saved role draft",
  });
  const freshRole = pageUnderTest.getByRole("region", {
    name: "Current Access role",
  });
  await expect(savedRole.getByText("Draft night duties.")).toBeVisible();
  await expect(savedRole.getByText("Read records")).toBeVisible();
  await expect(freshRole.getByText("Current approved duties.")).toBeVisible();
  await expect(freshRole.getByText("Update records")).toBeVisible();
  await expect(
    pageUnderTest.getByText("This role change may have completed."),
  ).toBeVisible();
  expect(creates).toBe(1);

  await pageUnderTest
    .getByRole("button", { name: "Discard after review" })
    .click();
  await pageUnderTest
    .getByRole("button", { name: "Discard and start fresh" })
    .click();
  await expect(
    pageUnderTest.getByRole("button", { name: "Save role" }),
  ).toBeDisabled();
  await expect(
    pageUnderTest.getByText(
      "The browser could not discard this role draft. It remains locked.",
    ),
  ).toBeVisible();
  await pageUnderTest.evaluate(() => {
    sessionStorage.setItem("test.allowAccessCleanup", "1");
  });
  await pageUnderTest
    .getByRole("button", { name: "Discard after review" })
    .click();
  await pageUnderTest
    .getByRole("button", { name: "Discard and start fresh" })
    .click();
  await expect(
    pageUnderTest.getByRole("dialog", { name: "Create role" }),
  ).not.toBeVisible();
  expect(creates).toBe(1);
});

test("an unconfirmed role creation keeps its values locked through accepted reload", async ({
  page: pageUnderTest,
}) => {
  let attempts = 0;
  await mockAccessApi(pageUnderTest);
  await pageUnderTest.route("**/api/roles", async (route) => {
    if (route.request().method() === "POST") {
      attempts += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Role creation unavailable" }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(page(roles)),
    });
  });

  await pageUnderTest.goto("/access?view=permissions");
  await openCreateDialog(pageUnderTest, "role");
  await pageUnderTest.getByLabel("Role name").fill("Shift lead");
  await pageUnderTest.getByRole("button", { name: "Save role" }).click();
  await pageUnderTest.getByRole("button", { name: "Apply changes" }).click();
  await expect(
    pageUnderTest.getByText("Could not apply the change"),
  ).toBeVisible();
  await expect(pageUnderTest.getByLabel("Role name")).toHaveValue("Shift lead");
  expect(attempts).toBe(1);

  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();
  await expect(
    pageUnderTest.getByRole("dialog", { name: "Create role" }),
  ).toBeVisible();
  await expect(pageUnderTest.getByLabel("Role name")).toHaveValue("Shift lead");
  await expect(
    pageUnderTest.getByRole("button", { name: "Save role" }),
  ).toBeDisabled();
  await expect(
    pageUnderTest.getByText("This role change may have completed."),
  ).toBeVisible();
  expect(attempts).toBe(1);
});

test("saved defaults cannot replay after reload when draft removal fails", async ({
  page: pageUnderTest,
}) => {
  let currentDefaults = { ...defaults };
  let saves = 0;
  await mockAccessApi(pageUnderTest);
  await pageUnderTest.route("**/api/access/defaults", async (route) => {
    if (route.request().method() === "PATCH") {
      saves += 1;
      const input = route.request().postDataJSON() as {
        invitation_expiry_days?: number;
      };
      currentDefaults = {
        ...currentDefaults,
        invitation_expiry_days:
          input.invitation_expiry_days ??
          currentDefaults.invitation_expiry_days,
        revision: currentDefaults.revision + 1,
      };
    }
    await route.fulfill({
      contentType: "application/json",
      headers: { ETag: `"defaults-${currentDefaults.revision}"` },
      body: JSON.stringify(currentDefaults),
    });
  });
  await pageUnderTest.addInitScript(() => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (
        key.startsWith("openslate.access.draft.v1.") &&
        key.endsWith(".defaults")
      )
        throw new Error("Access defaults removal blocked");
      return remove.call(this, key);
    };
  });

  await pageUnderTest.goto("/access?view=overview");
  await pageUnderTest.getByRole("button", { name: "Edit defaults" }).click();
  await pageUnderTest.getByLabel("Invitation expiry days").fill("21");
  await pageUnderTest.getByRole("button", { name: "Save defaults" }).click();
  await expect(
    pageUnderTest.getByText("Access defaults updated."),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByRole("dialog", { name: "Access defaults" }),
  ).not.toBeVisible();
  expect(saves).toBe(1);

  const retired = await pageUnderTest.evaluate(() => {
    const key = Object.keys(sessionStorage).find((value) =>
      value.endsWith(".defaults"),
    );
    return key ? JSON.parse(sessionStorage.getItem(key) ?? "null") : null;
  });
  expect(retired).toMatchObject({ state: "retired", owner: "defaults" });
  await pageUnderTest.reload();
  await expect(
    pageUnderTest.getByRole("dialog", { name: "Access defaults" }),
  ).not.toBeVisible();
  await pageUnderTest.getByRole("button", { name: "Edit defaults" }).click();
  await expect(pageUnderTest.getByLabel("Invitation expiry days")).toHaveValue(
    "21",
  );
  expect(saves).toBe(1);
});

test("an accepted reload restores an unsaved group name and description", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(
    pageUnderTest,
    () => true,
    () => [],
    () => [person],
  );
  await pageUnderTest.goto("/access?view=permissions");
  await openCreateDialog(pageUnderTest, "group");
  await pageUnderTest.getByLabel("Group name").fill("Night operations");
  await pageUnderTest.getByLabel("Description").fill("Overnight handoffs");
  await pageUnderTest.getByRole("checkbox", { name: /Alex Ops/ }).check();

  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();

  await expect(
    pageUnderTest.getByRole("heading", { name: "Create group" }),
  ).toBeVisible();
  await expect(pageUnderTest.getByLabel("Group name")).toHaveValue(
    "Night operations",
  );
  await expect(pageUnderTest.getByLabel("Description")).toHaveValue(
    "Overnight handoffs",
  );
  await expect(
    pageUnderTest.getByRole("checkbox", { name: /Alex Ops/ }),
  ).toBeChecked();

  await pageUnderTest.getByRole("button", { name: "Cancel" }).click();
  await pageUnderTest.getByRole("button", { name: "Discard changes" }).click();
  await pageUnderTest.reload();
  await expect(
    pageUnderTest.getByRole("dialog", { name: "Create group" }),
  ).not.toBeVisible();
});

test("a group save sends no request when its safety state cannot be stored", async ({
  page: pageUnderTest,
}) => {
  let creates = 0;
  await mockAccessApi(pageUnderTest);
  await pageUnderTest.route("**/api/access/groups", async (route) => {
    if (route.request().method() === "POST") creates += 1;
    await route.fulfill({
      status: route.request().method() === "POST" ? 500 : 200,
      contentType: "application/json",
      body: JSON.stringify(page([group])),
    });
  });
  await pageUnderTest.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        key.startsWith("openslate.access.draft.v1.") &&
        key.endsWith(".group") &&
        JSON.parse(value).state === "uncertain"
      )
        throw new Error("Access group safety state blocked");
      return set.call(this, key, value);
    };
  });

  await pageUnderTest.goto("/access?view=permissions");
  await openCreateDialog(pageUnderTest, "group");
  await pageUnderTest.getByLabel("Group name").fill("Night operations");
  await pageUnderTest.getByRole("button", { name: "Save group" }).click();
  await pageUnderTest.getByRole("button", { name: "Apply changes" }).click();
  expect(creates).toBe(0);
  await expect(
    pageUnderTest.getByText(
      "Browser draft storage is unavailable. Save was not sent.",
    ),
  ).toBeVisible();
});

test("an uncertain group shows saved and current membership before discard", async ({
  page: pageUnderTest,
}) => {
  const otherPerson = {
    ...person,
    id: "00000000-0000-4000-8000-000000000026",
    email: "morgan@example.test",
    username: "morgan",
    display_name: "Morgan Oncall",
  };
  let currentGroups: Array<
    Omit<typeof group, "member_ids"> & { member_ids: string[] }
  > = [group];
  let creates = 0;
  await mockAccessApi(pageUnderTest, undefined, undefined, () => [
    person,
    otherPerson,
  ]);
  await pageUnderTest.route(
    /\/api\/access\/groups(?:\?.*)?$/,
    async (route) => {
      if (route.request().method() === "POST") {
        creates += 1;
        currentGroups = [
          ...currentGroups,
          {
            ...group,
            id: "00000000-0000-4000-8000-000000000027",
            name: "Night operations",
            description: "Current approved team.",
            member_ids: [otherPerson.id],
          },
        ];
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "The outcome could not be confirmed",
          }),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(page(currentGroups)),
      });
    },
  );
  await pageUnderTest.route(
    "**/api/access/groups/00000000-0000-4000-8000-000000000027",
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        headers: { ETag: '"group-1"' },
        body: JSON.stringify(currentGroups[1]),
      });
    },
  );

  await pageUnderTest.goto("/access?view=permissions");
  await openCreateDialog(pageUnderTest, "group");
  await pageUnderTest.getByLabel("Group name").fill("Night operations");
  await pageUnderTest
    .getByLabel("Description")
    .fill("Draft overnight handoffs.");
  await pageUnderTest.getByRole("checkbox", { name: /Alex Ops/ }).check();
  await pageUnderTest.getByRole("button", { name: "Save group" }).click();
  await pageUnderTest.getByRole("button", { name: "Apply changes" }).click();
  expect(creates).toBe(1);

  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();
  await expect(
    pageUnderTest.getByRole("button", { name: "Save group" }),
  ).toBeDisabled();
  const savedGroup = pageUnderTest.getByRole("region", {
    name: "Saved group draft",
  });
  const freshGroup = pageUnderTest.getByRole("region", {
    name: "Current Access group",
  });
  await expect(savedGroup.getByText("Draft overnight handoffs.")).toBeVisible();
  await expect(savedGroup.getByText("Alex Ops")).toBeVisible();
  await expect(freshGroup.getByText("Current approved team.")).toBeVisible();
  await expect(freshGroup.getByText("Morgan Oncall")).toBeVisible();
  expect(creates).toBe(1);
});

test("an accepted reload restores an unsaved internal identity", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(pageUnderTest);
  await pageUnderTest.goto("/access?view=identities");
  await pageUnderTest
    .getByRole("button", { name: "Add person or service" })
    .click();
  await pageUnderTest
    .getByRole("menuitem", { name: "Internal person" })
    .click();
  const editor = pageUnderTest.getByRole("dialog", {
    name: /Add internal person/,
  });
  await editor.getByLabel("Name", { exact: true }).fill("Alex Ops");
  await editor.getByLabel("Email", { exact: true }).fill("alex@example.test");

  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();

  const restored = pageUnderTest.getByRole("dialog", {
    name: /Add internal person/,
  });
  await expect(restored.getByLabel("Name", { exact: true })).toHaveValue(
    "Alex Ops",
  );
  await expect(restored.getByLabel("Email", { exact: true })).toHaveValue(
    "alex@example.test",
  );

  await restored.getByRole("button", { name: "Cancel" }).click();
  await pageUnderTest.getByRole("button", { name: "Discard changes" }).click();
  await pageUnderTest.reload();
  await expect(
    pageUnderTest.getByRole("dialog", { name: /Add internal person/ }),
  ).not.toBeVisible();
});

test("a guest draft keeps its sponsor and expiry through accepted reload", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(
    pageUnderTest,
    () => true,
    () => [],
    () => [person],
  );
  await pageUnderTest.goto("/access?view=identities");
  await pageUnderTest
    .getByRole("button", { name: "Add person or service" })
    .click();
  await pageUnderTest.getByRole("menuitem", { name: "Guest" }).click();
  const editor = pageUnderTest.getByRole("dialog", {
    name: /Add guest/,
  });
  await editor.getByLabel("Name", { exact: true }).fill("Guest operator");
  await editor.getByLabel("Email", { exact: true }).fill("guest@example.test");
  await editor.getByLabel("Sponsor").selectOption(ids.person);
  await editor.getByLabel("Access expires").fill("2027-09-30T16:45");

  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();

  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue(
    "Guest operator",
  );
  await expect(editor.getByLabel("Sponsor")).toHaveValue(ids.person);
  await expect(editor.getByLabel("Access expires")).toHaveValue(
    "2027-09-30T16:45",
  );
});

test("a restored identity edit cannot turn a deleted target into a new identity", async ({
  page: pageUnderTest,
}) => {
  let personExists = true;
  await mockAccessApi(
    pageUnderTest,
    () => true,
    () => [],
    () => (personExists ? [person] : []),
  );
  await pageUnderTest.goto("/access?view=identities");
  await pageUnderTest
    .getByRole("button", { name: "View details for Alex Ops", exact: true })
    .click();
  await pageUnderTest
    .getByRole("dialog", { name: "Access details", exact: true })
    .getByRole("button", { name: "Edit access", exact: true })
    .click();
  await pageUnderTest.getByLabel("Job title").fill("Shift lead");

  personExists = false;
  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();

  await expect(
    pageUnderTest.getByText(/This identity draft refers to a person/),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await expect(pageUnderTest.getByLabel("Job title")).toHaveValue("Shift lead");
});

test("a restored group edit cannot save after its target is deleted", async ({
  page: pageUnderTest,
}) => {
  let groupExists = true;
  await mockAccessApi(pageUnderTest, () => groupExists);
  await openGroupEditor(pageUnderTest, "Operations");
  await pageUnderTest.getByLabel("Group name").fill("New operations");
  groupExists = false;
  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();

  await expect(
    pageUnderTest.getByText(/This group draft refers to a group or member/),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByRole("button", { name: "Save group" }),
  ).toBeDisabled();
});

test("a restored role edit cannot save after its target is deleted", async ({
  page: pageUnderTest,
}) => {
  const customRole = {
    ...roles[0],
    id: "00000000-0000-4000-8000-000000000006",
    role: "operator",
    description: "Operations role",
  };
  let roleExists = true;
  await mockAccessApi(
    pageUnderTest,
    () => true,
    () => [],
    () => [],
    () => (roleExists ? [...roles, customRole] : roles),
  );
  await openRoleEditor(pageUnderTest, "operator");
  await pageUnderTest.getByLabel("Role name").fill("Shift operator");
  roleExists = false;
  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();

  await expect(
    pageUnderTest.getByText(/This role draft refers to a role or permission/),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByRole("button", { name: "Save role" }),
  ).toBeDisabled();
});

test("a restored defaults draft cannot save after its selected group is deleted", async ({
  page: pageUnderTest,
}) => {
  let groupExists = true;
  await mockAccessApi(pageUnderTest, () => groupExists);
  await pageUnderTest.goto("/access?view=overview");
  await pageUnderTest.getByRole("button", { name: "Edit defaults" }).click();
  await pageUnderTest.getByLabel("Invitation expiry days").fill("21");
  groupExists = false;
  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();

  await expect(
    pageUnderTest.getByText(/This defaults draft refers to a role/),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByRole("button", { name: "Save defaults" }),
  ).toBeDisabled();
});

test("a dirty Access rules draft warns before browser reload", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(pageUnderTest);
  await openEveryoneRules(pageUnderTest);
  const decision = pageUnderTest.getByRole("group", {
    name: "Read records decision",
  });
  await decision.getByRole("button", { name: "Allow" }).click();
  await expect(pageUnderTest.getByText("1 staged change")).toBeVisible();

  const warning = pageUnderTest.waitForEvent("dialog", { timeout: 5_000 });
  const reload = pageUnderTest
    .evaluate(() => window.location.reload())
    .catch(() => undefined);
  const dialog = await warning;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await reload;

  await expect(pageUnderTest).toHaveURL(/\/access\?view=permissions$/);
  await expect(decision.getByRole("button", { name: "Allow" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await pageUnderTest
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  await pageUnderTest.getByRole("button", { name: "Discard changes" }).click();
  await expect(pageUnderTest.getByText("1 staged change")).not.toBeVisible();
  let unexpectedWarnings = 0;
  pageUnderTest.on("dialog", async (unexpectedDialog) => {
    unexpectedWarnings += 1;
    await unexpectedDialog.accept();
  });
  await pageUnderTest.reload();
  expect(unexpectedWarnings).toBe(0);
  await pageUnderTest
    .getByRole("button", { name: "Configure Everyone", exact: true })
    .click();
  await expect(decision.getByRole("button", { name: "Allow" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("an accepted reload restores the Rules draft without submitting it", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(pageUnderTest);
  await openEveryoneRules(pageUnderTest);
  const decision = pageUnderTest.getByRole("group", {
    name: "Read records decision",
  });
  await decision.getByRole("button", { name: "Allow" }).click();
  const readOptionsButton = pageUnderTest.getByRole("button", {
    name: "Read records options",
  });
  await readOptionsButton.click();
  await pageUnderTest
    .getByRole("button", { name: "Advanced rule setup" })
    .click();
  const setupDialog = pageUnderTest.getByRole("dialog", { name: "Rule setup" });
  await setupDialog.getByRole("button", { name: "Lock at this scope" }).click();
  await setupDialog.getByRole("button", { name: "Done" }).click();
  await expect(pageUnderTest.getByText("1 staged change")).toBeVisible();
  const ruleWrites: string[] = [];
  pageUnderTest.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/access/rules" &&
      request.method() !== "GET"
    )
      ruleWrites.push(request.method());
  });

  pageUnderTest.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("beforeunload");
    await dialog.accept();
  });
  await pageUnderTest.reload();

  await expect(decision.getByRole("button", { name: "Allow" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await pageUnderTest
    .getByRole("button", { name: "Read records options" })
    .click();
  await pageUnderTest
    .getByRole("button", { name: "Advanced rule setup" })
    .click();
  await expect(
    pageUnderTest
      .getByRole("dialog", { name: "Rule setup" })
      .getByRole("button", { name: "Locked at this scope" }),
  ).toBeVisible();
  await pageUnderTest
    .getByRole("dialog", { name: "Rule setup" })
    .getByRole("button", { name: "Done" })
    .click();
  await expect(pageUnderTest.getByText("1 staged change")).toBeVisible();
  expect(ruleWrites).toEqual([]);
});

test("browser Back and Forward retain a staged group rule through the legacy Rules view", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(pageUnderTest);
  const mutations = trackAccessMutations(pageUnderTest);
  await pageUnderTest.goto("/access?view=permissions&type=groups");
  const configureGroup = pageUnderTest.getByRole("button", {
    name: "Configure Operations",
    exact: true,
  });
  await configureGroup.click();
  const decision = pageUnderTest.getByRole("group", {
    name: "Read records decision",
  });
  await decision.getByRole("button", { name: "Allow" }).click();
  await expect(pageUnderTest.getByText("1 staged change")).toBeVisible();

  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.goto("/access?view=rules");
  await expect(pageUnderTest).toHaveURL(/\/access\?view=rules$/);
  await expect(
    pageUnderTest.getByRole("heading", { name: "Permissions", exact: true }),
  ).toBeVisible();
  await expect(configureGroup).toHaveAttribute("aria-expanded", "true");
  await expect(decision.getByRole("button", { name: "Allow" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.goBack();
  await expect(pageUnderTest).toHaveURL(
    /\/access\?view=permissions&type=groups$/,
  );
  await expect(configureGroup).toHaveAttribute("aria-expanded", "true");
  await expect(decision.getByRole("button", { name: "Allow" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.goForward();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=rules$/);
  await expect(configureGroup).toHaveAttribute("aria-expanded", "true");
  await expect(decision.getByRole("button", { name: "Allow" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(pageUnderTest.getByText("1 staged change")).toBeVisible();
  expect(mutations).toEqual([]);
});

test("a restored Rules draft for a deleted group cannot be submitted", async ({
  page: pageUnderTest,
}) => {
  let groupExists = true;
  await mockAccessApi(pageUnderTest, () => groupExists);
  await openPermissionSubject(pageUnderTest, "Operations");
  const decision = pageUnderTest.getByRole("group", {
    name: "Read records decision",
  });
  await decision.getByRole("button", { name: "Allow" }).click();
  await expect(pageUnderTest.getByText("1 staged change")).toBeVisible();

  groupExists = false;
  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();

  await expect(
    pageUnderTest.getByText(/This saved Rules draft refers to a person/),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByRole("button", { name: "Review impact" }),
  ).toBeDisabled();
  await expect(pageUnderTest.getByText("1 staged change")).toBeVisible();
});

test("Rules restore keeps the opening baseline when live policy changes", async ({
  page: pageUnderTest,
}) => {
  let liveRuleExists = false;
  await mockAccessApi(
    pageUnderTest,
    () => true,
    () =>
      liveRuleExists
        ? [
            {
              id: "00000000-0000-4000-8000-000000000030",
              subject_kind: "everyone",
              subject_id: null,
              scope_kind: "workspace",
              scope_id: null,
              permission_id: "records.read",
              decision: "deny",
              starts_at: null,
              ends_at: null,
              locked: false,
              policy_version: 2,
              created_at: timestamp,
              updated_at: timestamp,
              deleted_at: null,
              is_deleted: false,
              performed_by: null,
            },
          ]
        : [],
  );
  await openEveryoneRules(pageUnderTest);
  await pageUnderTest
    .getByRole("group", { name: "Read records decision" })
    .getByRole("button", { name: "Allow" })
    .click();
  await expect(pageUnderTest.getByText("1 staged change")).toBeVisible();

  liveRuleExists = true;
  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();
  await pageUnderTest.getByRole("button", { name: "Review impact" }).click();

  await expect(
    pageUnderTest.getByText(/live policy changed for 1 staged permission/),
  ).toBeVisible();
  await expect(pageUnderTest.getByText("Opened: inherit")).toBeVisible();
  await expect(pageUnderTest.getByText("Current: deny")).toBeVisible();
  await expect(pageUnderTest.getByText("Draft: allow")).toBeVisible();
  await expect(
    pageUnderTest.getByRole("button", { name: "Resolve 1 conflict" }),
  ).toBeDisabled();
});

test("an uncertain edited role does not review a recreated role with the same name", async ({
  page: pageUnderTest,
}) => {
  const previousRoleId = "00000000-0000-4000-8000-000000000030";
  const recreatedRole = {
    ...roles[0],
    id: "00000000-0000-4000-8000-000000000031",
    role: "Field dispatch",
    description: "Unrelated replacement role.",
  };
  await mockAccessApi(pageUnderTest, undefined, undefined, undefined, () => [
    ...roles,
    recreatedRole,
  ]);
  await pageUnderTest.addInitScript((targetId) => {
    sessionStorage.setItem(
      "openslate.access.draft.v1.00000000-0000-4000-8000-000000000010.role",
      JSON.stringify({
        version: 1,
        userId: "00000000-0000-4000-8000-000000000010",
        owner: "role",
        target: `edit:${targetId}`,
        state: "uncertain",
        payload: {
          intent: "edit",
          baseline: {
            id: targetId,
            name: "Field dispatch",
            description: "Original role.",
            builtin: false,
            grants: ["records.read"],
          },
          values: {
            name: "Field dispatch",
            description: "Saved uncertain edit.",
            grants: ["records.read"],
          },
        },
      }),
    );
  }, previousRoleId);

  await pageUnderTest.goto("/access?view=permissions");

  const currentRole = pageUnderTest.getByRole("region", {
    name: "Current Access role",
  });
  await expect(
    currentRole.getByText("No matching role is present in current Access."),
  ).toBeVisible();
  await expect(currentRole).not.toContainText("Unrelated replacement role.");
  await expect(
    pageUnderTest.getByRole("region", { name: "Saved role draft" }),
  ).toContainText("Saved uncertain edit.");
});

test("an uncertain edited group does not review a recreated group with the same name", async ({
  page: pageUnderTest,
}) => {
  const previousGroupId = "00000000-0000-4000-8000-000000000032";
  const recreatedGroup = {
    ...group,
    id: "00000000-0000-4000-8000-000000000033",
    name: "Field dispatch",
    description: "Unrelated replacement group.",
  };
  await mockAccessApi(
    pageUnderTest,
    undefined,
    undefined,
    undefined,
    undefined,
    () => [recreatedGroup],
  );
  await pageUnderTest.addInitScript((targetId) => {
    sessionStorage.setItem(
      "openslate.access.draft.v1.00000000-0000-4000-8000-000000000010.group",
      JSON.stringify({
        version: 1,
        userId: "00000000-0000-4000-8000-000000000010",
        owner: "group",
        target: `edit:${targetId}`,
        state: "uncertain",
        payload: {
          intent: "edit",
          baseline: {
            id: targetId,
            name: "Field dispatch",
            description: "Original group.",
            memberIds: [],
          },
          values: {
            name: "Field dispatch",
            description: "Saved uncertain edit.",
            memberIds: [],
          },
        },
      }),
    );
  }, previousGroupId);

  await pageUnderTest.goto("/access?view=permissions");

  const currentGroup = pageUnderTest.getByRole("region", {
    name: "Current Access group",
  });
  await expect(
    currentGroup.getByText("No matching group is present in current Access."),
  ).toBeVisible();
  await expect(currentGroup).not.toContainText("Unrelated replacement group.");
  await expect(
    pageUnderTest.getByRole("region", { name: "Saved group draft" }),
  ).toContainText("Saved uncertain edit.");
});

test("Rules warns when tab storage cannot protect a new change", async ({
  page: pageUnderTest,
}) => {
  await pageUnderTest.addInitScript(() => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("openslate.access.draft.v1."))
        throw new DOMException(
          "Draft storage unavailable",
          "QuotaExceededError",
        );
      return originalSetItem.call(this, key, value);
    };
  });
  await mockAccessApi(pageUnderTest);
  await openEveryoneRules(pageUnderTest);
  const decision = pageUnderTest.getByRole("group", {
    name: "Read records decision",
  });
  await decision.getByRole("button", { name: "Allow" }).click();

  await expect(pageUnderTest.getByText("1 staged change")).toBeVisible();
  await expect(
    pageUnderTest.getByRole("alert").filter({
      hasText:
        "The browser could not keep your latest Rules change for reload.",
    }),
  ).toBeVisible();
});

test("browser Back and Forward restore an unsaved identity editor without submitting", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(pageUnderTest);
  const mutations = trackAccessMutations(pageUnderTest);
  await pageUnderTest.goto("/access?view=overview");
  await pageUnderTest
    .getByRole("link", { name: "People & services", exact: true })
    .click();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=identities$/);

  await pageUnderTest
    .getByRole("button", { name: "Add person or service" })
    .click();
  await pageUnderTest
    .getByRole("menuitem", { name: "Internal person" })
    .click();
  const editor = pageUnderTest.getByRole("dialog", {
    name: /Add internal person/,
  });
  await editor.getByLabel("Name", { exact: true }).fill("Alex Ops");
  await editor.getByLabel("Email", { exact: true }).fill("alex@example.test");

  await pageUnderTest.goBack();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=overview$/);
  await expect(
    pageUnderTest.getByRole("heading", { name: "Access overview" }),
  ).toBeVisible();
  await pageUnderTest.goForward();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=identities$/);

  const restored = pageUnderTest.getByRole("dialog", {
    name: /Add internal person/,
  });
  await expect(restored).toBeVisible();
  await expect(restored.getByLabel("Name", { exact: true })).toHaveValue(
    "Alex Ops",
  );
  await expect(restored.getByLabel("Email", { exact: true })).toHaveValue(
    "alex@example.test",
  );
  expect(mutations).toEqual([]);
  await discardRestoredDraft(pageUnderTest, restored);
});

test("browser Back and Forward restore an unsaved role editor without submitting", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(pageUnderTest);
  const mutations = trackAccessMutations(pageUnderTest);
  await pageUnderTest.goto("/access?view=overview");
  await pageUnderTest
    .getByRole("link", { name: "Permissions", exact: true })
    .click();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=permissions$/);

  await openCreateDialog(pageUnderTest, "role");
  const editor = pageUnderTest.getByRole("dialog", { name: "Create role" });
  await editor.getByLabel("Role name").fill("Shift lead");
  await editor.getByLabel("Description").fill("Coordinates handoffs");
  await editor.getByRole("checkbox", { name: "Read records" }).check();

  await pageUnderTest.goBack();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=overview$/);
  await expect(
    pageUnderTest.getByRole("heading", { name: "Access overview" }),
  ).toBeVisible();
  await pageUnderTest.goForward();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=permissions$/);

  const restored = pageUnderTest.getByRole("dialog", { name: "Create role" });
  await expect(restored).toBeVisible();
  await expect(restored.getByLabel("Role name")).toHaveValue("Shift lead");
  await expect(restored.getByLabel("Description")).toHaveValue(
    "Coordinates handoffs",
  );
  await expect(
    restored.getByRole("checkbox", { name: "Read records" }),
  ).toBeChecked();
  expect(mutations).toEqual([]);
  await discardRestoredDraft(pageUnderTest, restored);
});

test("browser Back and Forward restore an unsaved group editor without submitting", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(
    pageUnderTest,
    () => true,
    () => [],
    () => [person],
  );
  const mutations = trackAccessMutations(pageUnderTest);
  await pageUnderTest.goto("/access?view=overview");
  await pageUnderTest
    .getByRole("link", { name: "Permissions", exact: true })
    .click();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=permissions$/);

  await openCreateDialog(pageUnderTest, "group");
  const editor = pageUnderTest.getByRole("dialog", { name: "Create group" });
  await editor.getByLabel("Group name").fill("Night operations");
  await editor.getByLabel("Description").fill("Overnight handoffs");
  await editor.getByRole("checkbox", { name: /Alex Ops/ }).check();

  await pageUnderTest.goBack();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=overview$/);
  await expect(
    pageUnderTest.getByRole("heading", { name: "Access overview" }),
  ).toBeVisible();
  await pageUnderTest.goForward();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=permissions$/);

  const restored = pageUnderTest.getByRole("dialog", { name: "Create group" });
  await expect(restored).toBeVisible();
  await expect(restored.getByLabel("Group name")).toHaveValue(
    "Night operations",
  );
  await expect(restored.getByLabel("Description")).toHaveValue(
    "Overnight handoffs",
  );
  await expect(
    restored.getByRole("checkbox", { name: /Alex Ops/ }),
  ).toBeChecked();
  expect(mutations).toEqual([]);
  await discardRestoredDraft(pageUnderTest, restored);
});

test("workspace defaults are editable and legacy Access views normalize to current homes", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(pageUnderTest);
  const mutations = trackAccessMutations(pageUnderTest);
  await pageUnderTest.goto("/access?view=overview");
  await expect(
    pageUnderTest.getByRole("heading", { name: "Access overview" }),
  ).toBeVisible();
  const editDefaults = pageUnderTest.getByRole("button", {
    name: "Edit defaults",
  });
  await expect(editDefaults).toBeVisible();
  await editDefaults.click();
  const editor = pageUnderTest.getByRole("dialog", {
    name: "Access defaults",
  });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Invitation expiry days")).toHaveValue("14");
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toBeHidden();

  await pageUnderTest.goto("/access?view=roles");
  await expect(
    pageUnderTest.getByRole("heading", { name: "Permissions", exact: true }),
  ).toBeVisible();
  await pageUnderTest
    .getByRole("button", { name: "More filters", exact: true })
    .click();
  await expect(
    pageUnderTest.getByLabel("Subject type", { exact: true }),
  ).toHaveValue("roles");

  await pageUnderTest.goto("/access?view=groups");
  await expect(
    pageUnderTest.getByRole("heading", { name: "Permissions", exact: true }),
  ).toBeVisible();
  await pageUnderTest
    .getByRole("button", { name: "More filters", exact: true })
    .click();
  await expect(
    pageUnderTest.getByLabel("Subject type", { exact: true }),
  ).toHaveValue("groups");

  await pageUnderTest.goto("/access?view=rules");
  await expect(
    pageUnderTest.getByRole("heading", { name: "Permissions", exact: true }),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByRole("button", {
      name: "Configure Everyone",
      exact: true,
    }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    pageUnderTest.getByRole("heading", {
      name: "Workspace rules",
      exact: true,
    }),
  ).toBeVisible();

  await pageUnderTest.goto("/access?view=simulator");
  await expect(
    pageUnderTest.getByRole("heading", { name: "People & services" }),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByRole("button", { name: "Edit defaults" }),
  ).toHaveCount(0);

  await pageUnderTest.goto("/access?view=reviews");
  await expect(
    pageUnderTest.getByRole("heading", { name: "Access overview" }),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByRole("button", { name: "Edit defaults" }),
  ).toBeVisible();
  expect(mutations).toEqual([]);
});

test("role directory keeps its controls clear and compares baselines across pages", async ({
  page: pageUnderTest,
}) => {
  const additionalRoles = [
    ["00000000-0000-4000-8000-000000000100", "Operator"],
    ["00000000-0000-4000-8000-000000000101", "Viewer"],
    ["00000000-0000-4000-8000-000000000102", "Finance reviewer"],
    ["00000000-0000-4000-8000-000000000103", "Warehouse coordinator"],
  ].map(([id, role]) => ({
    ...roles[0]!,
    id: id!,
    role: role!,
    ...(role === "Warehouse coordinator" ? { permissions: {} } : {}),
    description: `${role} permissions.`,
  }));
  const directoryRoles = [...roles, ...additionalRoles];
  await mockAccessApi(
    pageUnderTest,
    undefined,
    undefined,
    undefined,
    () => directoryRoles,
  );
  await pageUnderTest.setViewportSize({ width: 390, height: 844 });
  await pageUnderTest.goto("/access?view=permissions");
  await expect(
    pageUnderTest.getByRole("heading", { name: "Permissions", exact: true }),
  ).toBeVisible();
  const directory = pageUnderTest.getByRole("table", {
    name: "Permissions directory",
  });
  await expect(
    pageUnderTest.getByRole("searchbox", {
      name: "Search permissions directory",
      exact: true,
    }),
  ).toBeVisible();
  const moreFilters = pageUnderTest.getByRole("button", {
    name: "More filters",
    exact: true,
  });
  await expect(moreFilters).toHaveAttribute("aria-expanded", "false");
  await moreFilters.click();
  await expect(moreFilters).toHaveAttribute("aria-expanded", "true");
  const subjectType = pageUnderTest.getByLabel("Subject type", {
    exact: true,
  });
  await expect(subjectType).toBeVisible();
  await subjectType.selectOption("roles");
  const roleType = pageUnderTest.getByLabel("Role type", { exact: true });
  await expect(roleType).toHaveValue("all");
  await roleType.selectOption("custom");
  await expect(directory).not.toContainText("Administrator");
  await roleType.selectOption("all");
  const sort = pageUnderTest.getByLabel("Sort permissions", { exact: true });
  await expect(sort).toHaveValue("name");
  await sort.selectOption("grants");
  await sort.selectOption("name");
  await expect(
    pageUnderTest.getByRole("button", { name: "Compare roles", exact: true }),
  ).toBeVisible();
  await expect(pageUnderTest.getByText("Showing 1–6 of 6")).toBeVisible();
  await directory
    .getByRole("button", { name: "Configure Administrator", exact: true })
    .click();
  await expect(
    pageUnderTest.getByRole("heading", { name: "Standard permissions" }),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByRole("button", { name: "View role", exact: true }),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByText(/Built-in roles are protected/),
  ).toBeVisible();
  await directory
    .getByRole("button", { name: "Configure Operator", exact: true })
    .click();
  await expect(
    pageUnderTest.getByRole("button", { name: "Edit role", exact: true }),
  ).toBeVisible();

  await pageUnderTest.getByRole("button", { name: "Compare roles" }).click();
  const compareDialog = pageUnderTest.getByRole("dialog", {
    name: "Compare roles",
  });
  await expect(compareDialog).toBeVisible();
  await pageUnderTest
    .getByRole("checkbox", { name: /Compare Administrator$/ })
    .check();
  await pageUnderTest
    .getByRole("navigation", { name: "Role comparison pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await pageUnderTest
    .getByRole("checkbox", {
      name: /Compare Warehouse coordinator$/,
    })
    .check();
  await pageUnderTest
    .getByRole("button", { name: "Compare roles (2)" })
    .click();

  const dialog = pageUnderTest.getByRole("dialog", { name: "Compare roles" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("columnheader", { name: /Administrator/ }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("columnheader", { name: /Warehouse coordinator/ }),
  ).toBeVisible();
  const permissionRow = dialog.getByRole("row", { name: /Read records/ });
  await expect(permissionRow).toContainText("Not granted");
  await expect(permissionRow).toContainText("Granted");
  await expect(
    dialog.getByText(
      "These are standard role permissions. Custom rules can change actual access.",
    ),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "Protected Administrator management access is additional to these data permissions.",
    ),
  ).toBeVisible();
  const matrixRegion = pageUnderTest.getByRole("region", {
    name: "Role permission comparison",
  });
  expect(
    await matrixRegion.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  expect(
    await pageUnderTest.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await pageUnderTest.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    pageUnderTest.getByRole("button", { name: "Compare roles", exact: true }),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByRole("button", {
      name: "More actions for Administrator",
    }),
  ).toBeVisible();
  await pageUnderTest
    .getByRole("button", { name: "More actions for Administrator" })
    .focus();
  await pageUnderTest.keyboard.press("Enter");
  await expect(
    pageUnderTest.getByRole("menuitem", { name: "Duplicate" }),
  ).toBeVisible();
  await pageUnderTest.keyboard.press("Escape");
  expect(
    await pageUnderTest.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("Identity details checks the selected person and service without stale results or writes", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(
    pageUnderTest,
    undefined,
    undefined,
    () => [directoryUsers[0]!, directoryUsers[1]!],
    undefined,
    undefined,
    () => directoryServices,
  );
  const writes: string[] = [];
  const submittedChecks: unknown[] = [];
  pageUnderTest.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (
      request.method() !== "GET" &&
      pathname !== "/api/access/checks" &&
      (pathname === "/api/users" ||
        pathname === "/api/roles" ||
        pathname.startsWith("/api/access/"))
    ) {
      writes.push(`${request.method()} ${pathname}`);
    }
  });
  await pageUnderTest.route("**/api/access/checks", async (route) => {
    const submittedCheck = route.request().postDataJSON() as {
      principal_kind: "user" | "service";
      principal_id: string;
      permission_id: string;
      scope_kind: string;
    };
    submittedChecks.push(submittedCheck);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        principal_kind: submittedCheck.principal_kind,
        principal_id: submittedCheck.principal_id,
        permission_id: submittedCheck.permission_id,
        scope_kind: submittedCheck.scope_kind,
        policy_decision:
          submittedCheck.principal_kind === "service" ||
          submittedCheck.principal_id === directoryUsers[0]!.id
            ? "allow"
            : "deny",
        reason:
          submittedCheck.principal_kind === "user" &&
          submittedCheck.principal_id === directoryUsers[1]!.id
            ? "default_deny"
            : "rule_allow",
        source_rule_id:
          submittedCheck.principal_kind === "user" &&
          submittedCheck.principal_id === directoryUsers[1]!.id
            ? null
            : "00000000-0000-4000-8000-000000000012",
        policy_revision: 3,
        checked_at: timestamp,
        runtime_supported: submittedCheck.principal_kind !== "service",
      }),
    });
  });

  await pageUnderTest.goto("/access?view=identities");

  const preview = pageUnderTest.getByRole("dialog", {
    name: "Access details",
    exact: true,
  });
  const runCheck = async () => {
    await expect(
      preview.getByRole("tab", { name: "Details", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      preview.getByRole("tab", { name: "Check access", exact: true }),
    ).toBeVisible();
    await preview
      .getByRole("tab", { name: "Check access", exact: true })
      .click();
    await expect(
      preview.getByRole("heading", {
        name: /^(Allowed|Denied|Sign-in unavailable)$/,
      }),
    ).toHaveCount(0);
    await expect(preview.getByLabel("Identity", { exact: true })).toHaveCount(
      0,
    );
    await expect(preview.getByLabel("Resource", { exact: true })).toBeVisible();
    await expect(preview.getByLabel("Action", { exact: true })).toBeVisible();
    await preview.getByRole("button", { name: "Check access" }).click();
  };

  await pageUnderTest
    .getByRole("button", { name: "View details for Alex Ops" })
    .click();
  await expect(
    preview.getByRole("heading", { name: "Alex Ops", exact: true }),
  ).toBeVisible();
  await runCheck();
  await expect(
    preview.getByRole("heading", { name: "Allowed", exact: true }),
  ).toBeVisible();
  await expect(
    preview.getByText("An access rule allows this action.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(preview.getByText("Access rule", { exact: true })).toBeVisible();
  await expect(
    preview.getByRole("heading", { name: "Check context", exact: true }),
  ).toBeVisible();
  await expect(
    preview.getByText("Technical details", { exact: true }),
  ).toBeVisible();
  expect(submittedChecks[0]).toEqual({
    principal_kind: "user",
    principal_id: directoryUsers[0]!.id,
    permission_id: "records.read",
    scope_kind: "workspace",
  });

  await preview
    .getByRole("button", { name: "Close access details", exact: true })
    .click();
  await pageUnderTest
    .getByRole("button", { name: "View details for Jamie Chen" })
    .click();
  await expect(
    preview.getByRole("heading", { name: "Jamie Chen", exact: true }),
  ).toBeVisible();
  await runCheck();
  await expect(
    preview.getByRole("heading", { name: "Allowed", exact: true }),
  ).toHaveCount(0);
  await expect(
    preview.getByRole("heading", { name: "Denied", exact: true }),
  ).toBeVisible();
  expect(submittedChecks[1]).toEqual({
    principal_kind: "user",
    principal_id: directoryUsers[1]!.id,
    permission_id: "records.read",
    scope_kind: "workspace",
  });

  await preview
    .getByRole("button", { name: "Close access details", exact: true })
    .click();
  await pageUnderTest
    .getByRole("button", { name: "View details for Weekly summary sync" })
    .click();
  await expect(
    preview.getByRole("heading", { name: "Weekly summary sync", exact: true }),
  ).toBeVisible();
  await runCheck();
  await expect(
    preview.getByRole("heading", { name: "Denied", exact: true }),
  ).toHaveCount(0);
  await expect(
    preview.getByText("Policy permits, but service sign-in is unavailable.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(submittedChecks[2]).toEqual({
    principal_kind: "service",
    principal_id: directoryServices[0]!.id,
    permission_id: "records.read",
    scope_kind: "workspace",
  });

  expect(writes).toEqual([]);
});

test("Permissions directory protects a staged group rule while switching subjects", async ({
  page: pageUnderTest,
}) => {
  const groupWithAlex = { ...group, member_ids: [ids.person] };
  await mockAccessApi(
    pageUnderTest,
    undefined,
    undefined,
    () => [person],
    undefined,
    () => [groupWithAlex],
  );
  const mutations = trackAccessMutations(pageUnderTest);

  await pageUnderTest.goto("/access?view=permissions&type=all");

  await expect(
    pageUnderTest.getByRole("heading", { name: "Permissions", exact: true }),
  ).toBeVisible();
  const navigation = pageUnderTest.getByRole("navigation", {
    name: "Main navigation",
  });
  await expect(
    navigation.getByRole("link", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(
    navigation.getByRole("link", {
      name: "People & services",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    navigation.getByRole("link", { name: "Permissions", exact: true }),
  ).toBeVisible();
  await expect(navigation.getByRole("link")).toHaveCount(3);

  const directory = pageUnderTest.getByRole("table", {
    name: "Permissions directory",
    exact: true,
  });
  await expect(directory).toBeVisible();
  const configureGroup = directory.getByRole("button", {
    name: "Configure Operations",
    exact: true,
  });
  await configureGroup.click();
  await expect(
    pageUnderTest
      .getByRole("list", { name: "Members of Operations" })
      .getByText("Alex Ops", { exact: true }),
  ).toBeVisible();

  const decision = pageUnderTest.getByRole("group", {
    name: "Read records decision",
  });
  await expect(decision).toBeVisible();
  const allow = decision.getByRole("button", { name: "Allow", exact: true });
  await allow.click();
  await expect(allow).toHaveAttribute("aria-pressed", "true");
  await expect(pageUnderTest.getByText("1 staged change")).toBeVisible();

  const configureAlex = directory.getByRole("button", {
    name: "Configure Alex Ops",
    exact: true,
  });
  await configureAlex.click();
  const discardPrompt = pageUnderTest.getByRole("heading", {
    name: "Discard staged changes?",
    exact: true,
  });
  await expect(discardPrompt).toBeVisible();
  await pageUnderTest.getByRole("button", { name: "Keep editing" }).click();
  await expect(discardPrompt).toBeHidden();
  await expect(configureGroup).toHaveAttribute("aria-expanded", "true");
  await expect(allow).toHaveAttribute("aria-pressed", "true");

  await configureAlex.click();
  await expect(discardPrompt).toBeVisible();
  await pageUnderTest
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(configureAlex).toHaveAttribute("aria-expanded", "true");
  expect(mutations).toEqual([]);

  await configureGroup.click();
  await pageUnderTest
    .getByRole("button", { name: "Manage members", exact: true })
    .click();
  const groupEditor = pageUnderTest.getByRole("dialog", {
    name: "Edit Operations",
    exact: true,
  });
  await expect(groupEditor).toBeVisible();
  await groupEditor.getByRole("button", { name: "Cancel" }).click();
  expect(mutations).toEqual([]);
});

test("Permissions directory keeps staged rules through view guards and restores the group", async ({
  page: pageUnderTest,
}) => {
  const extraGroups = Array.from({ length: 6 }, (_, index) => ({
    ...group,
    id: `00000000-0000-4000-8000-${String(index + 30).padStart(12, "0")}`,
    name: `Zulu team ${index}`,
  }));
  const groups = [{ ...group, member_ids: [ids.person] }, ...extraGroups];
  await mockAccessApi(
    pageUnderTest,
    undefined,
    undefined,
    () => [person],
    undefined,
    () => groups,
  );
  const mutations = trackAccessMutations(pageUnderTest);

  await pageUnderTest.goto("/access?view=permissions");
  await pageUnderTest.getByLabel("Rows per page").selectOption("5");
  const configureGroup = pageUnderTest.getByRole("button", {
    name: "Configure Operations",
    exact: true,
  });
  await configureGroup.click();
  const decision = pageUnderTest.getByRole("group", {
    name: "Read records decision",
  });
  const allow = decision.getByRole("button", { name: "Allow", exact: true });
  await allow.click();
  await expect(allow).toHaveAttribute("aria-pressed", "true");

  const moreFilters = pageUnderTest.getByRole("button", {
    name: "More filters",
    exact: true,
  });
  await moreFilters.click();
  const subjectType = pageUnderTest.getByLabel("Subject type", { exact: true });
  await subjectType.selectOption("identities");
  const discardPrompt = pageUnderTest.getByRole("heading", {
    name: "Discard staged rule changes?",
    exact: true,
  });
  await expect(discardPrompt).toBeVisible();
  await pageUnderTest.getByRole("button", { name: "Keep editing" }).click();
  await expect(discardPrompt).toBeHidden();
  await expect(subjectType).toHaveValue("shared");
  await expect(configureGroup).toHaveAttribute("aria-expanded", "true");
  await expect(allow).toHaveAttribute("aria-pressed", "true");

  const sort = pageUnderTest.getByLabel("Sort permissions", { exact: true });
  await sort.selectOption("members");
  await expect(discardPrompt).toBeVisible();
  await pageUnderTest.getByRole("button", { name: "Keep editing" }).click();
  await expect(discardPrompt).toBeHidden();
  await expect(sort).toHaveValue("name");
  await expect(configureGroup).toHaveAttribute("aria-expanded", "true");
  await expect(allow).toHaveAttribute("aria-pressed", "true");

  await pageUnderTest
    .getByRole("navigation", { name: "Permissions directory pages" })
    .getByRole("button", { name: "Go to next page" })
    .click();
  await expect(discardPrompt).toBeVisible();
  await pageUnderTest.getByRole("button", { name: "Keep editing" }).click();
  await expect(discardPrompt).toBeHidden();
  await expect(configureGroup).toBeVisible();
  await expect(allow).toHaveAttribute("aria-pressed", "true");

  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();

  await expect(configureGroup).toHaveAttribute("aria-expanded", "true");
  await expect(
    pageUnderTest
      .getByRole("group", { name: "Read records decision" })
      .getByRole("button", { name: "Allow", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(mutations).toEqual([]);
});

test("Permissions directory defaults to shared subjects while restoring an individual rules draft", async ({
  page: pageUnderTest,
}) => {
  const service = directoryServices[0]!;
  await mockAccessApi(
    pageUnderTest,
    undefined,
    undefined,
    () => [person],
    undefined,
    undefined,
    () => [service],
  );
  const mutations = trackAccessMutations(pageUnderTest);

  await pageUnderTest.goto("/access?view=permissions");
  const directory = pageUnderTest.getByRole("table", {
    name: "Permissions directory",
    exact: true,
  });
  await expect(directory).toContainText("Everyone");
  await expect(directory).toContainText("Member");
  await expect(directory).toContainText("Administrator");
  await expect(directory).toContainText("Operations");
  await expect(
    directory.getByRole("button", { name: "Configure Alex Ops", exact: true }),
  ).toHaveCount(0);
  await expect(
    directory.getByRole("button", {
      name: "Configure Weekly summary sync",
      exact: true,
    }),
  ).toHaveCount(0);

  await pageUnderTest
    .getByRole("button", { name: "More filters", exact: true })
    .click();
  const subjectType = pageUnderTest.getByLabel("Subject type", { exact: true });
  await expect(subjectType).toHaveValue("shared");
  const optionLabels = (
    await subjectType.locator("option").allTextContents()
  ).map((label) => label.trim());
  expect(optionLabels).toContain("Workspace, roles & groups");
  expect(optionLabels).toContain("Roles");
  expect(optionLabels).toContain("Groups");
  expect(optionLabels).toContain("People & services");
  expect(optionLabels).toContain("All subjects");

  await subjectType.selectOption({ label: "People & services" });
  const configureAlex = directory.getByRole("button", {
    name: "Configure Alex Ops",
    exact: true,
  });
  await expect(configureAlex).toBeVisible();
  await expect(
    directory.getByRole("button", {
      name: "Configure Weekly summary sync",
      exact: true,
    }),
  ).toBeVisible();
  await configureAlex.click();
  await expect(
    pageUnderTest.getByRole("heading", {
      name: "Workspace rules",
      exact: true,
    }),
  ).toBeVisible();

  const allow = pageUnderTest
    .getByRole("group", { name: "Read records decision" })
    .getByRole("button", { name: "Allow", exact: true });
  await allow.click();
  await expect(allow).toHaveAttribute("aria-pressed", "true");
  await expect(pageUnderTest.getByText("1 staged change")).toBeVisible();

  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();

  await expect(pageUnderTest).toHaveURL(/\/access\?view=permissions$/);
  await pageUnderTest
    .getByRole("button", { name: "More filters", exact: true })
    .click();
  await expect(subjectType).toHaveValue("shared");
  await expect(
    directory.getByRole("button", { name: "Configure Alex Ops", exact: true }),
  ).toHaveCount(0);
  await expect(
    directory.getByRole("button", {
      name: "Configure Weekly summary sync",
      exact: true,
    }),
  ).toHaveCount(0);
  const restoredSubject = pageUnderTest.getByRole("region", {
    name: "Selected permission subject",
    exact: true,
  });
  await expect(restoredSubject).toContainText("Alex Ops");
  await expect(
    restoredSubject
      .getByRole("group", { name: "Read records decision" })
      .getByRole("button", { name: "Allow", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(mutations).toEqual([]);
});

test("discarding staged rules applies the requested directory subject filter", async ({
  page: pageUnderTest,
}) => {
  const groups = [
    group,
    ...Array.from({ length: 6 }, (_, index) => ({
      ...group,
      id: `00000000-0000-4000-8000-${String(index + 40).padStart(12, "0")}`,
      name: `Zulu team ${index}`,
    })),
  ];
  await mockAccessApi(
    pageUnderTest,
    undefined,
    undefined,
    () => [person],
    undefined,
    () => groups,
  );
  const mutations = trackAccessMutations(pageUnderTest);

  await pageUnderTest.goto("/access?view=permissions");
  await pageUnderTest
    .getByRole("button", { name: "Configure Operations", exact: true })
    .click();
  await pageUnderTest
    .getByRole("group", { name: "Read records decision" })
    .getByRole("button", { name: "Allow", exact: true })
    .click();

  await pageUnderTest
    .getByRole("button", { name: "More filters", exact: true })
    .click();
  const subjectType = pageUnderTest.getByLabel("Subject type", { exact: true });
  await subjectType.selectOption("identities");
  await expect(
    pageUnderTest.getByRole("heading", {
      name: "Discard staged rule changes?",
      exact: true,
    }),
  ).toBeVisible();
  await pageUnderTest
    .getByRole("button", { name: "Discard and continue", exact: true })
    .click();

  await expect(subjectType).toHaveValue("identities");
  await expect(
    pageUnderTest.getByRole("button", {
      name: "Configure Operations",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test("discarding staged rules applies the requested directory page size", async ({
  page: pageUnderTest,
}) => {
  const groups = [
    group,
    ...Array.from({ length: 6 }, (_, index) => ({
      ...group,
      id: `00000000-0000-4000-8000-${String(index + 50).padStart(12, "0")}`,
      name: `Zulu team ${index}`,
    })),
  ];
  await mockAccessApi(
    pageUnderTest,
    undefined,
    undefined,
    () => [person],
    undefined,
    () => groups,
  );
  const mutations = trackAccessMutations(pageUnderTest);

  await pageUnderTest.goto("/access?view=permissions");
  await pageUnderTest
    .getByRole("button", { name: "Configure Operations", exact: true })
    .click();
  await pageUnderTest
    .getByRole("group", { name: "Read records decision" })
    .getByRole("button", { name: "Allow", exact: true })
    .click();

  const pageSize = pageUnderTest.getByLabel("Rows per page", { exact: true });
  await pageSize.selectOption("10");
  await expect(
    pageUnderTest.getByRole("heading", {
      name: "Discard staged rule changes?",
      exact: true,
    }),
  ).toBeVisible();
  await pageUnderTest
    .getByRole("button", { name: "Discard and continue", exact: true })
    .click();

  await expect(pageSize).toHaveValue("10");
  await expect(pageUnderTest.getByText("1 staged change")).not.toBeVisible();
  expect(mutations).toEqual([]);
});

test("legacy Permissions aliases follow sidebar and browser history changes", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(pageUnderTest);

  await pageUnderTest.goto("/access?view=roles");
  await expect(
    pageUnderTest.getByRole("heading", { name: "Permissions", exact: true }),
  ).toBeVisible();
  await pageUnderTest
    .getByRole("button", { name: "More filters", exact: true })
    .click();
  const subjectType = pageUnderTest.getByLabel("Subject type", { exact: true });
  await expect(subjectType).toHaveValue("roles");

  const navigation = pageUnderTest.getByRole("navigation", {
    name: "Main navigation",
  });
  await navigation
    .getByRole("link", { name: "Permissions", exact: true })
    .click();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=permissions$/);
  await expect(subjectType).toHaveValue("shared");
  await pageUnderTest.goBack();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=roles$/);
  await expect(subjectType).toHaveValue("roles");

  await pageUnderTest.goto("/access?view=rules");
  const configureEveryone = pageUnderTest.getByRole("button", {
    name: "Configure Everyone",
    exact: true,
  });
  await expect(configureEveryone).toHaveAttribute("aria-expanded", "true");
  await expect(
    pageUnderTest.getByRole("heading", {
      name: "Workspace rules",
      exact: true,
    }),
  ).toBeVisible();
  await pageUnderTest
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Permissions", exact: true })
    .click();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=permissions$/);
  await expect(configureEveryone).toHaveAttribute("aria-expanded", "false");
  await pageUnderTest.goBack();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=rules$/);
  await expect(configureEveryone).toHaveAttribute("aria-expanded", "true");
  await expect(
    pageUnderTest.getByRole("heading", {
      name: "Workspace rules",
      exact: true,
    }),
  ).toBeVisible();
});
