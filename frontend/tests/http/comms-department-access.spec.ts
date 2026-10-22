import type { Page } from "@playwright/test";
import {
  expect,
  test,
  signedInAs,
  defaultOrganization,
  heldResponse,
} from "./helpers/test";
import { createMemorySeed } from "../support/comms-memory/memory/seed";
import { validateMemoryState } from "../support/comms-memory/memory/snapshot";
import { createMemoryCommsRuntime } from "../support/comms-memory/memory-client";
import { installCommsLiveApi } from "./helpers/comms-live-api";

const ownerId = "00000000-0000-4000-8000-000000000101";
const financeId = "d4400000-0000-4000-8000-000000000001";
const financeDeskId = "d4400000-0000-4000-8000-000000000002";
const generalId = "d4400000-0000-4000-8000-000000000003";

/**
 * The seed's Operations department channel in "Service delivery", plus a
 * Finance department with its own category and one unbound category. Only
 * `manages` departments are managed by a member owner; an admin manages all.
 */
async function seedDepartments(
  page: Page,
  role: "admin" | "member",
  levels: Record<string, "read" | "write" | "manage"> = {},
  ownerLevel: "write" | "manage" = "manage",
  options: { grant?: "workspace" | "category"; lock?: boolean } = {},
) {
  const owner = { user_id: ownerId, org_id: defaultOrganization.org_id };
  const state = createMemorySeed(owner, {
    role,
    display_name: "Access owner",
  });
  const operations = Object.values(state.departments)[0];
  const serviceDelivery = Object.values(state.categories)[0];
  const room = Object.values(state.conversations)[0];
  state.departments[financeId] = {
    id: financeId,
    org_id: owner.org_id,
    name: "Finance",
  };
  const created = serviceDelivery.created_at;
  state.categories[financeDeskId] = {
    id: financeDeskId,
    org_id: owner.org_id,
    created_at: created,
    updated_at: created,
    name: "Finance desk",
    position: 1,
    department_id: financeId,
  };
  state.categories[generalId] = {
    id: generalId,
    org_id: owner.org_id,
    created_at: created,
    updated_at: created,
    name: "General",
    position: 2,
    department_id: null,
  };
  const people = Object.values(state.people);
  const person = (name: string) =>
    people.find((row) => row.display_name === name)!;
  for (const [name, level] of Object.entries(levels))
    person(name).department_levels = { [operations.id]: level };
  if (role === "member")
    state.people[ownerId].department_levels = { [operations.id]: ownerLevel };
  const grant = options.grant ?? (ownerLevel === "write" ? "workspace" : null);
  if (grant) {
    // A createChannel grant reaches the owner through their group, either for
    // the whole workspace or for the Service delivery category only.
    const group = state.people[ownerId].group_ids[0];
    const scope =
      grant === "workspace"
        ? ({ kind: "workspace" } as const)
        : ({ kind: "category", id: serviceDelivery.id } as const);
    state.configuration[
      grant === "workspace"
        ? "workspace"
        : (`category:${serviceDelivery.id}` as const)
    ] = {
      settings: {},
      capabilities: {
        scope,
        everyone: {},
        group_grants: [{ group_id: group, capability: "createChannel" }],
      },
    };
  }
  if (options.lock) state.capability_locks = ["createChannel"];
  validateMemoryState(state, owner.org_id);
  await signedInAs(page, {
    id: ownerId,
    role,
    access:
      role === "member"
        ? [{ department_id: operations.id, module_id: null, level: ownerLevel }]
        : [],
  });
  const runtime = createMemoryCommsRuntime({ owner, initial: state });
  const api = await installCommsLiveApi(page, { userId: ownerId, runtime });
  return { api, runtime, operations, serviceDelivery, room, person };
}

function channelNamed(
  runtime: ReturnType<typeof createMemoryCommsRuntime>,
  name: string,
) {
  return Object.values(runtime.exportSnapshot().state.conversations).find(
    (row) => row.kind === "channel" && row.name === name,
  );
}

test("an admin creates an organization channel, and a category that cannot hold it is reset with a note", async ({
  page,
}) => {
  const { api, runtime, operations, serviceDelivery } = await seedDepartments(
    page,
    "admin",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Create channel",
    exact: true,
  });
  const scope = dialog.getByRole("radiogroup", {
    name: "Who can use this channel",
    exact: true,
  });
  const organization = scope.getByRole("radio", { name: /^Organization/ });
  await expect(organization).toBeChecked();
  await expect(organization).toHaveAccessibleName("Organization");
  await expect(organization).toHaveAccessibleDescription(
    "Everyone in the organization can post. Guests can read.",
  );
  await expect(
    dialog.getByRole("combobox", { name: "Department", exact: true }),
  ).toHaveCount(0);
  const category = dialog.getByLabel("Category", { exact: true });
  await expect(category.getByRole("option")).toHaveText([
    "No category",
    "General",
  ]);
  await scope.getByRole("radio", { name: /^Department/ }).click();
  const department = dialog.getByRole("combobox", {
    name: "Department",
    exact: true,
  });
  await expect(department.getByRole("option")).toHaveText([
    "Choose a department",
    "Operations",
    "Finance",
  ]);
  await department.selectOption({ label: "Operations" });
  await expect(category.getByRole("option")).toHaveText([
    "No category",
    "Service delivery",
  ]);
  await category.selectOption({ label: "Service delivery" });
  await organization.click();
  await expect(category).toHaveValue("");
  await expect(
    dialog.getByText("Service delivery is for Operations channels only.", {
      exact: true,
    }),
  ).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "Channel name", exact: true })
    .fill("announcements");
  const bootstrapReads = () =>
    api.requests.filter(
      (request) => request.method === "GET" && request.path === "/bootstrap",
    ).length;
  const readsBefore = bootstrapReads();
  const tokensBefore = api.tokenRequests();
  await dialog
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  // The accepted save opens the new channel after one coalesced read: its own
  // structure and grants events add no bootstrap read and no Realtime reconnect.
  await expect(
    page.getByRole("heading", { name: "announcements", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/[?&]conversation=/);
  expect(bootstrapReads() - readsBefore).toBe(1);
  expect(api.tokenRequests()).toBe(tokensBefore);
  await expect
    .poll(() => channelNamed(runtime, "announcements"))
    .toMatchObject({ scope: "organization", category_id: null });
  expect(channelNamed(runtime, "announcements")).not.toHaveProperty(
    "department_id",
  );
  expect(serviceDelivery.department_id).toBe(operations.id);
  await expect(
    page.getByRole("button", {
      name: /^Organization\s?\. Open channel settings\./,
    }),
  ).toBeVisible();
  const settings = page.getByRole("dialog", {
    name: "Channel settings",
    exact: true,
  });
  // Department roles decide only department channels, so only they link there.
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await settings.getByRole("tab", { name: "Access", exact: true }).click();
  await expect(
    settings.getByText("This channel is open to the whole organization.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    settings.getByRole("link", { name: /^Change department roles/ }),
  ).toHaveCount(0);
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(settings).toBeHidden();
  await page.getByRole("button", { name: /^operations(,|$)/ }).click();
  await expect(
    page.getByRole("heading", { name: "operations", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await settings.getByRole("tab", { name: "Access", exact: true }).click();
  await expect(
    settings.getByRole("link", {
      name: "Change department roles in Access → Groups",
      exact: true,
    }),
  ).toHaveAttribute("href", "/access?view=groups");
});

test("an admin creates a category for one department or for none", async ({
  page,
}) => {
  const { runtime } = await seedDepartments(page, "admin");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "Create category", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Create category",
    exact: true,
  });
  const department = dialog.getByRole("combobox", {
    name: "Department",
    exact: true,
  });
  await expect(department.getByRole("option")).toHaveText([
    "No department",
    "Operations",
    "Finance",
  ]);
  await expect(department).toHaveValue("");
  await department.selectOption({ label: "Finance" });
  await dialog
    .getByRole("textbox", { name: "Category name", exact: true })
    .fill("Payroll");
  await dialog
    .getByRole("button", { name: "Create category", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(
      () =>
        Object.values(runtime.exportSnapshot().state.categories).find(
          (row) => row.name === "Payroll",
        )?.department_id,
    )
    .toBe(financeId);
  // The empty department category shows in the sidebar with its department.
  await expect(
    page.getByRole("button", {
      name: "Category actions: Payroll",
      exact: true,
    }),
  ).toBeVisible();
});

test("a department manager creates a channel only in a department they manage, in that department's categories", async ({
  page,
}) => {
  const { runtime, operations, serviceDelivery } = await seedDepartments(
    page,
    "member",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Create channel",
    exact: true,
  });
  const scope = dialog.getByRole("radiogroup", {
    name: "Who can use this channel",
    exact: true,
  });
  const organization = scope.getByRole("radio", { name: /^Organization/ });
  await expect(organization).toHaveAttribute("aria-disabled", "true");
  await expect(organization).not.toBeChecked();
  // The visible reason is the description: announced once, present once.
  await expect(organization).toHaveAccessibleDescription(
    "Everyone in the organization can post. Guests can read. Only admins can create organization channels.",
  );
  await expect(
    dialog.getByText("Only admins can create organization channels.", {
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    scope
      .getByRole("paragraph")
      .filter({ hasText: "Only admins can create organization channels." }),
  ).toBeVisible();
  await expect(scope.getByRole("radio", { name: /^Department/ })).toBeChecked();
  const department = dialog.getByRole("combobox", {
    name: "Department",
    exact: true,
  });
  await expect(department.getByRole("option")).toHaveText(["Operations"]);
  await expect(department).toHaveValue(operations.id);
  const category = dialog.getByLabel("Category", { exact: true });
  await expect(category.getByRole("option")).toHaveText([
    "No category",
    "Service delivery",
  ]);
  await category.selectOption({ label: "Service delivery" });
  await dialog
    .getByRole("textbox", { name: "Channel name", exact: true })
    .fill("handovers");
  await dialog
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => channelNamed(runtime, "handovers"))
    .toMatchObject({
      scope: "department",
      department_id: operations.id,
      category_id: serviceDelivery.id,
    });
  // From a category of a department they do not manage, the dialog resets the
  // category and says why.
  await page
    .getByRole("button", {
      name: "Category actions: Finance desk",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Create channel in category", exact: true })
    .click();
  await expect(
    dialog.getByRole("combobox", { name: "Department", exact: true }),
  ).toHaveValue(operations.id);
  await expect(category).toHaveValue("");
  await expect(
    dialog.getByText("Finance desk is for Finance channels only.", {
      exact: true,
    }),
  ).toBeVisible();
});

test("a workspace lock on createChannel turns the department-manager default off", async ({
  page,
}) => {
  await seedDepartments(page, "member", {}, "manage", { lock: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  await expect(
    page.getByRole("heading", { name: "operations", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create channel", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "OpenComms menu", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("menuitem", { name: "New channel", exact: true }),
  ).toHaveCount(0);
});

test("a category createChannel grant offers only that category's department and that category", async ({
  page,
}) => {
  const { runtime, operations, serviceDelivery } = await seedDepartments(
    page,
    "member",
    {},
    "write",
    { grant: "category" },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Create channel",
    exact: true,
  });
  const department = dialog.getByRole("combobox", {
    name: "Department",
    exact: true,
  });
  await expect(department.getByRole("option")).toHaveText(["Operations"]);
  const category = dialog.getByLabel("Category", { exact: true });
  // No "No category": the grant reaches only its category.
  await expect(category.getByRole("option")).toHaveText(["Service delivery"]);
  await expect(category).toHaveValue(serviceDelivery.id);
  await dialog
    .getByRole("textbox", { name: "Channel name", exact: true })
    .fill("intake");
  await dialog
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => channelNamed(runtime, "intake"))
    .toMatchObject({
      scope: "department",
      department_id: operations.id,
      category_id: serviceDelivery.id,
    });
});

test("a createChannel grant offers only departments where the member holds a role, never the organization", async ({
  page,
}) => {
  const { runtime, operations } = await seedDepartments(
    page,
    "member",
    {},
    "write",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Create channel",
    exact: true,
  });
  const scope = dialog.getByRole("radiogroup", {
    name: "Who can use this channel",
    exact: true,
  });
  await expect(
    scope.getByRole("radio", { name: /^Organization/ }),
  ).toHaveAttribute("aria-disabled", "true");
  const department = dialog.getByRole("combobox", {
    name: "Department",
    exact: true,
  });
  await expect(department.getByRole("option")).toHaveText(["Operations"]);
  await dialog
    .getByRole("textbox", { name: "Channel name", exact: true })
    .fill("field-notes");
  await dialog
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => channelNamed(runtime, "field-notes"))
    .toMatchObject({
      scope: "department",
      department_id: operations.id,
      category_id: null,
    });
});

test("the member panel and the Members tab show each reader's level, and only role changes the contract allows", async ({
  page,
}) => {
  const { runtime, room, person } = await seedDepartments(page, "admin", {
    "Sofia Garcia": "write",
    "Mara Santos": "write",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  await page.getByRole("button", { name: "Members", exact: true }).click();
  const panel = page.getByRole("region", {
    name: "Members with access",
    exact: true,
  });
  await expect(panel.getByRole("heading", { name: /^Members/ })).toHaveText(
    "Members 4",
  );
  // Owner (admin) and Noah (creator) manage; Sofia posts; Mara is a guest.
  await expect(panel.getByText("Manager", { exact: true })).toHaveCount(2);
  await expect(panel.getByText("Post", { exact: true })).toHaveCount(1);
  await expect(panel.getByText("Read", { exact: true })).toHaveCount(1);
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Channel settings",
    exact: true,
  });
  await settings.getByRole("tab", { name: "Members", exact: true }).click();
  const readers = settings.getByRole("list", {
    name: "People who can use this channel",
    exact: true,
  });
  await expect(readers.getByRole("listitem")).toHaveCount(4);
  await expect(
    readers.getByRole("listitem").filter({ hasText: "Sofia Garcia" }),
  ).toContainText("Post");
  const managers = settings.getByRole("region", {
    name: "Channel managers",
    exact: true,
  });
  const chosen = managers.getByLabel("Person", { exact: true });
  await chosen.selectOption({ label: "Noah Tan" });
  await expect(
    managers.getByText("Created this channel, so manages it.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    managers.getByLabel("Channel role", { exact: true }),
  ).toHaveCount(0);
  await chosen.selectOption({ label: "Mara Santos" });
  await expect(
    managers.getByText("Guests can only read.", { exact: true }),
  ).toBeVisible();
  await expect(
    managers.getByLabel("Channel role", { exact: true }),
  ).toHaveCount(0);
  await chosen.selectOption({ label: "Sofia Garcia" });
  await managers
    .getByLabel("Channel role", { exact: true })
    .selectOption({ label: "Manager" });
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(settings).toBeHidden();
  const sofia = person("Sofia Garcia").user_id;
  await expect
    .poll(
      () => runtime.exportSnapshot().state.members[room.id][sofia]?.member_role,
    )
    .toBe("manager");
});

test("the Members tab says while members load, and when no one can use the channel", async ({
  page,
}) => {
  await seedDepartments(page, "admin");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  const open = page.getByRole("button", {
    name: "Channel settings",
    exact: true,
  });
  await expect(open).toBeVisible();
  const read = heldResponse();
  try {
    // The tab's full read (100 a page) waits, then answers with no one.
    await page.route(
      "**/api/comms/conversations/*/members?**",
      async (route) => {
        if (!route.request().url().includes("limit=100"))
          return route.fallback();
        read.enter();
        await read.released;
        return route.fulfill({
          json: {
            items: [],
            pagination: {
              limit: 100,
              offset: 0,
              count: 0,
              total: 0,
              has_more: false,
            },
          },
        });
      },
    );
    await open.click();
    const settings = page.getByRole("dialog", {
      name: "Channel settings",
      exact: true,
    });
    await settings.getByRole("tab", { name: "Members", exact: true }).click();
    await read.entered;
    await expect(
      settings.getByRole("status").filter({ hasText: "Loading members…" }),
    ).toBeVisible();
    read.release();
    await expect(
      settings.getByText("No one can use this channel yet.", { exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole("list", {
        name: "People who can use this channel",
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    read.release();
  }
});
