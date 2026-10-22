import type { Page } from "@playwright/test";
import { expect, test, signedInAs, defaultOrganization } from "./helpers/test";
import { createMemorySeed } from "../support/comms-memory/memory/seed";
import { validateMemoryState } from "../support/comms-memory/memory/snapshot";
import { createMemoryCommsRuntime } from "../support/comms-memory/memory-client";
import { installCommsLiveApi } from "./helpers/comms-live-api";

const ownerId = "00000000-0000-4000-8000-000000000101";
const financeId = "d4500000-0000-4000-8000-000000000001";
const financeDeskId = "d4500000-0000-4000-8000-000000000002";
const ledgerId = "d4500000-0000-4000-8000-000000000003";
const inventoryId = "d4500000-0000-4000-8000-000000000004";

/**
 * The seed's Operations world plus a Finance department, its "Finance desk"
 * category and its "ledger" channel there, and an "Inventory staff" group
 * that holds Sofia Garcia. Nobody but an admin has a Finance role.
 */
async function seedGrants(
  page: Page,
  options: {
    role: "admin" | "member";
    ownerLevel?: "write" | "manage";
    owner?: "Sofia Garcia";
    categoryGrant?: boolean;
    /**
     * A category-level manageChannel grant on Finance desk, not a Finance role.
     * With `categoryGrant`, Inventory staff membership lets the owner read ledger.
     */
    categoryManager?: boolean;
    /** Sofia also holds a role in "Accounts payable", listed after Finance. */
    secondDepartment?: boolean;
  },
) {
  const seeded = { user_id: ownerId, org_id: defaultOrganization.org_id };
  const state = createMemorySeed(seeded, {
    role: options.role,
    display_name: "Access owner",
  });
  const operations = Object.values(state.departments)[0];
  const room = Object.values(state.conversations)[0];
  const people = Object.values(state.people);
  const person = (name: string) =>
    people.find((row) => row.display_name === name)!;
  state.departments[financeId] = {
    id: financeId,
    org_id: seeded.org_id,
    name: "Finance",
  };
  state.groups[inventoryId] = {
    id: inventoryId,
    org_id: seeded.org_id,
    name: "Inventory staff",
  };
  person("Sofia Garcia").group_ids.push(inventoryId);
  if (options.secondDepartment) {
    const payableId = "d4500000-0000-4000-8000-000000000006";
    state.departments[payableId] = {
      id: payableId,
      org_id: seeded.org_id,
      name: "Accounts payable",
    };
    person("Sofia Garcia").department_levels[payableId] = "write";
  }
  const created = room.created_at;
  state.categories[financeDeskId] = {
    id: financeDeskId,
    org_id: seeded.org_id,
    created_at: created,
    updated_at: created,
    name: "Finance desk",
    position: 1,
    department_id: financeId,
  };
  state.conversations[ledgerId] = {
    id: ledgerId,
    org_id: seeded.org_id,
    created_at: created,
    updated_at: created,
    creator_id: ownerId,
    archived_at: null,
    kind: "channel",
    name: "ledger",
    topic: "",
    category_id: financeDeskId,
    position: 1,
    scope: "department",
    department_id: financeId,
  };
  state.members[ledgerId] = {};
  state.high_water_seq[ledgerId] = 0;
  if (options.categoryGrant)
    state.access_grants[`category:${financeDeskId}:group:${inventoryId}`] = {
      org_id: seeded.org_id,
      target: { kind: "category", id: financeDeskId },
      subject: "group",
      subject_id: inventoryId,
      level: "read",
      created_at: created,
      updated_at: created,
    };
  if (options.categoryManager) {
    const helpers = "d4500000-0000-4000-8000-000000000005";
    state.groups[helpers] = {
      id: helpers,
      org_id: seeded.org_id,
      name: "Finance helpers",
    };
    state.people[ownerId].group_ids.push(helpers, inventoryId);
    state.configuration[`category:${financeDeskId}`] = {
      settings: {},
      capabilities: {
        scope: { kind: "category", id: financeDeskId },
        everyone: {},
        group_grants: [{ group_id: helpers, capability: "manageChannel" }],
      },
    };
  }
  if (options.role === "member")
    state.people[ownerId].department_levels = {
      [operations.id]: options.ownerLevel ?? "write",
    };
  // The ledger's creator is the seeded owner; a member owner manages only by role.
  if (options.role === "member")
    state.conversations[ledgerId].creator_id = person("Noah Tan").user_id;
  if (options.owner) person("Noah Tan").role = "admin";
  validateMemoryState(state, seeded.org_id);
  const ownerPerson = options.owner ? person(options.owner) : null;
  const owner = {
    user_id: ownerPerson?.user_id ?? ownerId,
    org_id: seeded.org_id,
  };
  await signedInAs(page, {
    id: owner.user_id,
    role: options.owner ? "member" : options.role,
    access:
      options.role === "member" || options.owner
        ? [
            {
              department_id: operations.id,
              module_id: null,
              level: options.owner ? "write" : (options.ownerLevel ?? "write"),
            },
          ]
        : [],
  });
  const runtime = createMemoryCommsRuntime({ owner, initial: state });
  const api = await installCommsLiveApi(page, {
    userId: owner.user_id,
    runtime,
  });
  return { api, runtime, person, operations };
}

const settingsDialog = (page: Page, kind: "Channel" | "Category") =>
  page.getByRole("dialog", { name: `${kind} settings`, exact: true });

async function openChannelAccess(page: Page, channel: string) {
  await page
    .getByRole("button", { name: new RegExp(`^${channel}(,|$)`) })
    .click();
  await expect(
    page.getByRole("heading", { name: channel, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  const dialog = settingsDialog(page, "Channel");
  await dialog.getByRole("tab", { name: "Access", exact: true }).click();
  return dialog;
}

async function openCategoryAccess(page: Page, category: string) {
  await page
    .getByRole("button", { name: `Category actions: ${category}`, exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Category settings", exact: true })
    .click();
  const dialog = settingsDialog(page, "Category");
  await dialog.getByRole("tab", { name: "Access", exact: true }).click();
  return dialog;
}

test("a channel manager gives a person read and post, changes it and removes it; the category's grant stays read-only", async ({
  page,
}) => {
  const { api, runtime, person } = await seedGrants(page, {
    role: "admin",
    categoryGrant: true,
    secondDepartment: true,
  });
  const sofia = person("Sofia Garcia").user_id;
  const sofiaClient = runtime.controls.clientFor(sofia);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  const dialog = await openChannelAccess(page, "ledger");
  await expect(
    dialog.getByRole("region", { name: "Who can use it", exact: true }),
  ).toContainText("This channel belongs to Finance");
  const editor = dialog.getByRole("region", {
    name: "Also has access",
    exact: true,
  });
  const rows = editor.getByRole("listitem");
  // The category's grant comes first and has no controls here.
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Inventory staff");
  await expect(rows.first()).toContainText("From category Finance desk");
  await expect(rows.first()).toContainText("Read");
  await expect(rows.first().getByRole("combobox")).toHaveCount(0);
  await expect(rows.first().getByRole("button")).toHaveCount(0);

  await editor
    .getByRole("button", { name: "Give access", exact: true })
    .click();
  const search = editor.getByRole("combobox", {
    name: "Group or person",
    exact: true,
  });
  await search.click();
  await page
    .getByRole("combobox", { name: "Search group or person", exact: true })
    .fill("a");
  const listbox = page.getByRole("listbox");
  await expect(listbox.getByRole("group", { name: "Groups" })).toContainText(
    "Inventory staff",
  );
  await listbox
    .getByRole("group", { name: "People" })
    .getByRole("option", { name: /^Sofia Garcia/ })
    .click();
  await editor
    .getByRole("radiogroup", { name: "Level", exact: true })
    .getByRole("radio", { name: "Read and post", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Give access", exact: true })
    .click();
  const level = editor.getByRole("combobox", {
    name: "Access for Sofia Garcia",
    exact: true,
  });
  await expect(level).toHaveValue("post");
  await expect(rows).toHaveCount(2);
  // A person's row names their departments instead of "Person".
  const sofiaRow = rows.filter({ hasText: "Sofia Garcia" });
  // In department order, as everywhere else: Operations came first.
  await expect(sofiaRow).toContainText(/Operations.*Accounts payable/);
  await expect(sofiaRow).not.toContainText("Person");
  await expect
    .poll(
      () =>
        runtime.exportSnapshot().state.access_grants[
          `channel:${ledgerId}:user:${sofia}`
        ]?.level,
    )
    .toBe("post");
  // G1: the person now reads and posts the channel.
  expect((await sofiaClient.getCapabilities(ledgerId)).conversation_level).toBe(
    "post",
  );

  // A granted person shows as already having access.
  await editor
    .getByRole("button", { name: "Give access", exact: true })
    .click();
  await search.click();
  await page
    .getByRole("combobox", { name: "Search group or person", exact: true })
    .fill("Sofia");
  await expect(
    page.getByRole("option", { name: /^Sofia Garcia.*Already has access/ }),
  ).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  // A failed change stays on its row, and the select points at the failure.
  api.failNext(/\/access-grants\/user\/[^/]+$/, 500, undefined, "PUT");
  await level.selectOption({ label: "Read" });
  await expect(level).toHaveAccessibleDescription(
    "Access could not be changed. Try again.",
  );
  await expect(level).toHaveValue("post");
  await level.selectOption({ label: "Read" });
  await expect
    .poll(
      () =>
        runtime.exportSnapshot().state.access_grants[
          `channel:${ledgerId}:user:${sofia}`
        ]?.level,
    )
    .toBe("read");
  await expect(level).toHaveValue("read");

  await editor
    .getByRole("button", {
      name: "Remove access for Sofia Garcia",
      exact: true,
    })
    .click();
  await expect(rows).toHaveCount(1);
  await expect
    .poll(() =>
      Object.keys(runtime.exportSnapshot().state.access_grants).sort(),
    )
    .toEqual([`category:${financeDeskId}:group:${inventoryId}`]);
  // Sofia still reads through the category's group grant, and never posts.
  expect((await sofiaClient.getCapabilities(ledgerId)).conversation_level).toBe(
    "read",
  );
});

test("a person given access sees the channel live, posts, and loses it when the grant is removed", async ({
  page,
}) => {
  const { runtime, person } = await seedGrants(page, {
    role: "member",
    owner: "Sofia Garcia",
  });
  const sofia = person("Sofia Garcia").user_id;
  const manager = runtime.controls.clientFor(person("Noah Tan").user_id);
  const target = { kind: "channel", id: ledgerId } as const;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  await expect(
    page.getByRole("heading", { name: "operations", exact: true }),
  ).toBeVisible();
  const ledger = page.getByRole("button", { name: /^ledger(,|$)/ });
  await expect(ledger).toHaveCount(0);
  await manager.setAccessGrant(
    target,
    "user",
    sofia,
    { level: "post" },
    { if_match: (await manager.listAccessGrants(target)).etag },
  );
  await ledger.click();
  await expect(
    page.getByRole("heading", { name: "ledger", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Stock count is ready");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() =>
      Object.values(runtime.exportSnapshot().state.messages)
        .filter((row) => row.conversation_id === ledgerId)
        .map((row) => row.body),
    )
    .toEqual(["Stock count is ready"]);

  await manager.removeAccessGrant(target, "user", sofia, {
    if_match: (await manager.listAccessGrants(target)).etag,
  });
  await expect(
    page.getByText("This conversation is not available.", { exact: true }),
  ).toBeVisible();
  await expect(ledger).toHaveCount(0);
});

test("a category grant reaches its channels, shows read-only on each channel, and ends when a channel moves out", async ({
  page,
}) => {
  const { runtime, person } = await seedGrants(page, { role: "admin" });
  const sofiaClient = runtime.controls.clientFor(
    person("Sofia Garcia").user_id,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  await expect(
    page.getByRole("heading", { name: "operations", exact: true }),
  ).toBeVisible();
  const category = await openCategoryAccess(page, "Finance desk");
  const editor = category.getByRole("region", {
    name: "Also has access",
    exact: true,
  });
  await expect(editor).toContainText(
    "Only people with a role in Finance can use channels in this category.",
  );
  await editor
    .getByRole("button", { name: "Give access", exact: true })
    .click();
  await editor
    .getByRole("combobox", { name: "Group or person", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Search group or person", exact: true })
    .fill("Inventory");
  await page
    .getByRole("group", { name: "Groups" })
    .getByRole("option", { name: /^Inventory staff/ })
    .click();
  // Read is the default level.
  await expect(
    editor.getByRole("radio", { name: "Read", exact: true }),
  ).toBeChecked();
  await editor
    .getByRole("button", { name: "Give access", exact: true })
    .click();
  await expect(
    editor.getByRole("combobox", {
      name: "Access for Inventory staff",
      exact: true,
    }),
  ).toHaveValue("read");
  await expect
    .poll(
      () =>
        runtime.exportSnapshot().state.access_grants[
          `category:${financeDeskId}:group:${inventoryId}`
        ]?.level,
    )
    .toBe("read");
  // G2/G8: a group member reads the category's channel and cannot post.
  expect((await sofiaClient.getCapabilities(ledgerId)).conversation_level).toBe(
    "read",
  );
  await category.getByRole("button", { name: "Cancel", exact: true }).click();

  const channel = await openChannelAccess(page, "ledger");
  const inherited = channel
    .getByRole("region", { name: "Also has access", exact: true })
    .getByRole("listitem");
  await expect(inherited).toHaveCount(1);
  await expect(inherited).toContainText("From category Finance desk");
  await expect(inherited.getByRole("combobox")).toHaveCount(0);
  await channel.getByRole("button", { name: "Cancel", exact: true }).click();

  const current = await runtime.client.getConversation(ledgerId);
  await runtime.client.updateChannel(
    ledgerId,
    { category_id: null },
    { if_match: current.etag },
  );
  await expect(sofiaClient.getConversation(ledgerId)).rejects.toMatchObject({
    failure: { status: 404 },
  });
});

test("only someone who manages a category sees its access editor", async ({
  page,
}) => {
  await seedGrants(page, { role: "member", ownerLevel: "manage" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  await expect(
    page.getByRole("heading", { name: "operations", exact: true }),
  ).toBeVisible();
  const own = await openCategoryAccess(page, "Service delivery");
  await expect(
    own.getByRole("region", { name: "Also has access", exact: true }),
  ).toContainText(
    "Only people with a role in Operations can use channels in this category.",
  );
  await own.getByRole("button", { name: "Cancel", exact: true }).click();
  // G6: a department manager of Operations does not manage Finance desk.
  const other = await openCategoryAccess(page, "Finance desk");
  await expect(
    other.getByRole("region", { name: "Who can use it", exact: true }),
  ).toContainText("Channels in this category belong to Finance");
  await expect(
    other.getByRole("region", { name: "Also has access", exact: true }),
  ).toHaveCount(0);
  await expect(
    other.getByRole("button", { name: "Give access", exact: true }),
  ).toHaveCount(0);
});

test("a category manageChannel holder who is not a Finance manager sees its grants read-only", async ({
  page,
}) => {
  await seedGrants(page, {
    role: "member",
    categoryGrant: true,
    categoryManager: true,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  // Category settings open from a channel the person manages: ledger.
  await page.getByRole("button", { name: /^ledger(,|$)/ }).click();
  await expect(
    page.getByRole("heading", { name: "ledger", exact: true }),
  ).toBeVisible();
  const dialog = await openCategoryAccess(page, "Finance desk");
  const region = dialog.getByRole("region", {
    name: "Also has access",
    exact: true,
  });
  await expect(
    region.getByRole("listitem").filter({ hasText: "Inventory staff" }),
  ).toContainText("Read");
  await expect(region).toContainText(
    "Only an admin or a manager of Finance can change this list.",
  );
  await expect(
    region.getByRole("button", { name: /Give access|Remove access/ }),
  ).toHaveCount(0);
  await expect(
    region.getByRole("combobox", { name: "Access for Inventory staff" }),
  ).toHaveCount(0);
});
