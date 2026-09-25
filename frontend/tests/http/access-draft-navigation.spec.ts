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
  member_ids: [],
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
        body: JSON.stringify(page([])),
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
  await expect(pageUnderTest).toHaveURL(/\/access\?view=groups$/);
  await pageUnderTest.getByRole("button", { name: "View rules" }).click();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=rules$/);

  const decision = pageUnderTest.getByRole("group", {
    name: "Read records decision",
  });
  await decision.getByRole("button", { name: "Allow" }).click();
  await expect(pageUnderTest.getByText("1 staged change")).toBeVisible();

  await pageUnderTest.getByRole("link", { name: /Sign-in & security/ }).click();
  await expect(
    pageUnderTest.getByRole("heading", {
      name: "Discard unsaved Access changes?",
    }),
  ).toBeVisible();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=rules$/);

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
  await pageUnderTest.goto("/access?view=reviews");
  await pageUnderTest
    .getByRole("button", { name: "Configure defaults" })
    .click();
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
    pageUnderTest.getByRole("button", { name: "Configure defaults" }),
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
  await pageUnderTest
    .getByRole("button", { name: "Configure defaults" })
    .click();
  await expect(pageUnderTest.getByLabel("Invitation expiry days")).toHaveValue(
    "14",
  );
});

test("an accepted reload restores an unsaved role name and description", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(pageUnderTest);
  await pageUnderTest.goto("/access?view=roles");
  await pageUnderTest
    .getByRole("button", { name: "Create role" })
    .first()
    .click();
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

  await pageUnderTest.goto("/access?view=roles");
  await pageUnderTest
    .getByRole("button", { name: "Create role" })
    .first()
    .click();
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

  await pageUnderTest.goto("/access?view=roles");
  await pageUnderTest
    .getByRole("button", { name: "Create role" })
    .first()
    .click();
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
      "Current Access role: Shift lead; 1 baseline grants.",
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

  await pageUnderTest.goto("/access?view=roles");
  await pageUnderTest
    .getByRole("button", { name: "Create role" })
    .first()
    .click();
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

  await pageUnderTest.goto("/access?view=reviews");
  await pageUnderTest
    .getByRole("button", { name: "Configure defaults" })
    .click();
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
  await pageUnderTest
    .getByRole("button", { name: "Configure defaults" })
    .click();
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
  await pageUnderTest.goto("/access?view=groups");
  await pageUnderTest
    .getByRole("button", { name: "Create group" })
    .first()
    .click();
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

  await pageUnderTest.goto("/access?view=groups");
  await pageUnderTest
    .getByRole("button", { name: "Create group" })
    .first()
    .click();
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

  await pageUnderTest.goto("/access?view=groups");
  await pageUnderTest
    .getByRole("button", { name: "Create group" })
    .first()
    .click();
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
  await pageUnderTest.getByRole("button", { name: "Add identity" }).click();
  await pageUnderTest
    .getByRole("menuitem", { name: "Internal identity" })
    .click();
  const editor = pageUnderTest.getByRole("dialog", {
    name: /Add internal identity/,
  });
  await editor.getByLabel("Name", { exact: true }).fill("Alex Ops");
  await editor.getByLabel("Email", { exact: true }).fill("alex@example.test");

  pageUnderTest.once("dialog", (dialog) => dialog.accept());
  await pageUnderTest.reload();

  const restored = pageUnderTest.getByRole("dialog", {
    name: /Add internal identity/,
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
    pageUnderTest.getByRole("dialog", { name: /Add internal identity/ }),
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
  await pageUnderTest.getByRole("button", { name: "Add identity" }).click();
  await pageUnderTest.getByRole("menuitem", { name: "Guest identity" }).click();
  const editor = pageUnderTest.getByRole("dialog", {
    name: /Add guest identity/,
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
    .getByRole("button", { name: /Alex Ops/ })
    .first()
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
  await pageUnderTest.goto("/access?view=groups");
  await pageUnderTest
    .getByRole("button", { name: "Edit", exact: true })
    .first()
    .click();
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
  await pageUnderTest.goto("/access?view=roles");
  await pageUnderTest
    .getByRole("button", { name: /operator/ })
    .first()
    .click();
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
  await pageUnderTest.goto("/access?view=reviews");
  await pageUnderTest
    .getByRole("button", { name: "Configure defaults" })
    .click();
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
  await pageUnderTest.goto("/access?view=rules");
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

  await expect(pageUnderTest).toHaveURL(/\/access\?view=rules$/);
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
  await expect(decision.getByRole("button", { name: "Allow" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("an accepted reload restores the Rules draft without submitting it", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(pageUnderTest);
  await pageUnderTest.goto("/access?view=rules");
  const decision = pageUnderTest.getByRole("group", {
    name: "Read records decision",
  });
  await decision.getByRole("button", { name: "Allow" }).click();
  await pageUnderTest.getByText("Conditions and scope lock").first().click();
  await pageUnderTest
    .getByRole("button", { name: "Lock at this scope" })
    .first()
    .click();
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
  await pageUnderTest.getByText("Conditions and scope lock").first().click();
  await expect(
    pageUnderTest.getByRole("button", { name: "Locked at this scope" }).first(),
  ).toBeVisible();
  await expect(pageUnderTest.getByText("1 staged change")).toBeVisible();
  expect(ruleWrites).toEqual([]);
});

test("browser Back and Forward restore a staged Rules decision", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(pageUnderTest);
  await pageUnderTest.goto("/access?view=groups");
  await pageUnderTest.getByRole("button", { name: "View rules" }).click();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=rules$/);
  const decision = pageUnderTest.getByRole("group", {
    name: "Read records decision",
  });
  await decision.getByRole("button", { name: "Allow" }).click();
  await expect(pageUnderTest.getByText("1 staged change")).toBeVisible();

  await pageUnderTest.goBack();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=groups$/);
  await pageUnderTest.goForward();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=rules$/);
  await expect(decision.getByRole("button", { name: "Allow" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(pageUnderTest.getByText("1 staged change")).toBeVisible();
});

test("a restored Rules draft for a deleted group cannot be submitted", async ({
  page: pageUnderTest,
}) => {
  let groupExists = true;
  await mockAccessApi(pageUnderTest, () => groupExists);
  await pageUnderTest.goto("/access?view=groups");
  await pageUnderTest.getByRole("button", { name: "View rules" }).click();
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
  await pageUnderTest.goto("/access?view=rules");
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

  await pageUnderTest.goto("/access?view=roles");

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

  await pageUnderTest.goto("/access?view=groups");

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
  await pageUnderTest.goto("/access?view=rules");
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

  await pageUnderTest.getByRole("button", { name: "Add identity" }).click();
  await pageUnderTest
    .getByRole("menuitem", { name: "Internal identity" })
    .click();
  const editor = pageUnderTest.getByRole("dialog", {
    name: /Add internal identity/,
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
    name: /Add internal identity/,
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
  await pageUnderTest.getByRole("link", { name: "Roles", exact: true }).click();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=roles$/);

  await pageUnderTest.getByRole("button", { name: "Create role" }).click();
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
  await expect(pageUnderTest).toHaveURL(/\/access\?view=roles$/);

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
    .getByRole("link", { name: "Groups", exact: true })
    .click();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=groups$/);

  await pageUnderTest.getByRole("button", { name: "Create group" }).click();
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
  await expect(pageUnderTest).toHaveURL(/\/access\?view=groups$/);

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

test("browser Back and Forward restore unsaved Access defaults without submitting", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(pageUnderTest);
  const mutations = trackAccessMutations(pageUnderTest);
  await pageUnderTest.goto("/access?view=overview");
  await pageUnderTest
    .getByRole("link", { name: "Access reviews", exact: true })
    .click();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=reviews$/);

  await pageUnderTest
    .getByRole("button", { name: "Configure defaults" })
    .click();
  const editor = pageUnderTest.getByRole("dialog", {
    name: "Access defaults",
  });
  await editor.getByLabel("Invitation expiry days").fill("21");

  await pageUnderTest.goBack();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=overview$/);
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Invitation expiry days")).toHaveValue("21");
  await pageUnderTest.goForward();
  await expect(pageUnderTest).toHaveURL(/\/access\?view=reviews$/);

  const restored = pageUnderTest.getByRole("dialog", {
    name: "Access defaults",
  });
  await expect(restored).toBeVisible();
  await expect(restored.getByLabel("Invitation expiry days")).toHaveValue("21");
  expect(mutations).toEqual([]);
  await discardRestoredDraft(pageUnderTest, restored);
});

test("role advanced options remain keyboard reachable without mobile overflow", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(pageUnderTest);
  await pageUnderTest.setViewportSize({ width: 390, height: 844 });
  await pageUnderTest.goto("/access?view=roles");
  await expect(
    pageUnderTest.getByRole("heading", { name: "Roles" }),
  ).toBeVisible();
  await expect(pageUnderTest.getByLabel("Search roles")).toBeVisible();
  await expect(
    pageUnderTest.getByRole("group", { name: "Filter roles" }),
  ).toBeVisible();

  const moreOptions = pageUnderTest.locator("summary").filter({
    hasText: "More options",
  });
  await moreOptions.focus();
  await pageUnderTest.keyboard.press("Enter");
  await expect(
    pageUnderTest.getByRole("button", { name: "Sort" }),
  ).toBeVisible();
  await pageUnderTest.getByRole("button", { name: "Compare roles" }).click();
  await expect(
    pageUnderTest.getByRole("button", { name: "Cancel compare" }),
  ).toBeVisible();
  await pageUnderTest.getByRole("button", { name: "Cancel compare" }).click();
  expect(
    await pageUnderTest.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("unavailable review and policy launchers stay absent while defaults remain usable", async ({
  page: pageUnderTest,
}) => {
  await mockAccessApi(pageUnderTest);
  await pageUnderTest.goto("/access?view=reviews");
  await expect(
    pageUnderTest.getByRole("heading", { name: "Access reviews" }),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByText("Formal access reviews are not available yet."),
  ).toBeVisible();
  await expect(
    pageUnderTest.getByRole("button", {
      name: /Start access review|Review export|Import policy|View policy history/,
    }),
  ).toHaveCount(0);

  const configure = pageUnderTest.getByRole("button", {
    name: "Configure defaults",
  });
  await configure.focus();
  await pageUnderTest.keyboard.press("Enter");
  await expect(
    pageUnderTest.getByRole("dialog", { name: "Access defaults" }),
  ).toBeVisible();
  await pageUnderTest.keyboard.press("Escape");
  await expect(configure).toBeFocused();
});
