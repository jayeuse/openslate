import {
  expect,
  test,
  signedInAs,
  defaultOrganization,
  expectNoHorizontalScroll,
  type Page,
} from "./helpers/test";
import { profilePreferences } from "./helpers/profile-api";
import { createMemorySeed } from "../../src/components/systems/comms/memory/seed";
import { validateMemoryState } from "../../src/components/systems/comms/memory/snapshot";
import { serializeSampleSessionSnapshot } from "../../src/components/systems/shared/runtime/sample-state";
import { workspaceSessionSnapshotStorageKey } from "../../src/components/systems/shared/runtime/workspace-identity";

async function seedSettings(
  page: Page,
  mode: "admin" | "manager" | "member" = "admin",
  userId = "00000000-0000-4000-8000-000000000101",
) {
  const owner = { user_id: userId, org_id: defaultOrganization.org_id };
  const role = mode === "admin" ? "admin" : "member";
  await signedInAs(page, { id: userId, role });
  const state = createMemorySeed(owner, {
    role,
    display_name: "Settings owner",
  });
  const room = Object.values(state.conversations)[0];
  if (room.kind !== "channel") throw new Error("Expected channel fixture");
  const group = Object.values(state.groups)[0];
  state.conversations[room.id] = {
    ...room,
    scope: "groups",
    access: [{ subject: "everyone", level: "post" }],
  };
  if (mode === "manager")
    state.members[room.id][userId].member_role = "manager";
  state.configuration.workspace = {
    settings: {},
    capabilities: {
      scope: { kind: "workspace" },
      everyone: {},
      group_grants: [{ group_id: group.id, capability: "pin" }],
    },
  };
  validateMemoryState(state, owner.org_id);
  const key = workspaceSessionSnapshotStorageKey(userId, owner.org_id);
  const value = serializeSampleSessionSnapshot(
    userId,
    { "comms-memory-v1": { format: 1, owner, state } },
    owner.org_id,
  );
  await page.addInitScript(
    ({ key, value }) => {
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, value);
    },
    { key, value },
  );
  return {
    owner,
    conversation: room.id,
    category: room.category_id!,
    group: group.id,
    key,
    sofia: Object.values(state.people).find(
      (person) => person.display_name === "Sofia Garcia",
    )!.user_id,
    guest: Object.values(state.people).find(
      (person) => person.role === "guest",
    )!.user_id,
  };
}
const settings = (page: Page) =>
  page.getByRole("dialog", { name: "Channel settings", exact: true });
async function openChannel(page: Page) {
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
}
async function workspaceSettings(page: Page) {
  await page
    .getByRole("button", { name: "OpenComms menu", exact: true })
    .first()
    .click();
  await page
    .getByRole("menuitem", { name: "Admin tools", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Workspace settings", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Workspace settings", exact: true });
}

test("settings Advanced is collapsed, counts customized fields, and persists only for its owner and tab", async ({
  page,
}) => {
  await seedSettings(page);
  await page.goto("/comms");
  await openChannel(page);
  const dialog = settings(page);
  await dialog.getByRole("tab", { name: "Messaging", exact: true }).click();
  const advanced = dialog.getByRole("button", { name: /Advanced settings/ });
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await expect(
    dialog.getByLabel("Channel mode", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByLabel("Slow mode (seconds)", { exact: true }),
  ).toBeHidden();
  await advanced.click();
  await dialog.getByLabel("Slow mode (seconds)", { exact: true }).fill("5");
  await expect(advanced).toContainText("1 changed");
  await dialog.getByLabel("Search settings", { exact: true }).fill("slow mode");
  await expect(
    dialog.getByLabel("Slow mode (seconds)", { exact: true }),
  ).toBeVisible();
  await dialog.getByLabel("Search settings", { exact: true }).fill("");
  await dialog
    .getByRole("checkbox", { name: "Modified only", exact: true })
    .check();
  await expect(
    dialog.getByLabel("Slow mode (seconds)", { exact: true }),
  ).toHaveValue("5");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await page.reload();
  await openChannel(page);
  await dialog.getByRole("tab", { name: "Messaging", exact: true }).click();
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  await expect(advanced).toContainText("1 changed");
  await dialog.getByRole("tab", { name: "Threads", exact: true }).click();
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await seedSettings(page, "admin", "00000000-0000-4000-8000-000000000102");
  await page.goto("/comms");
  await openChannel(page);
  await dialog.getByRole("tab", { name: "Messaging", exact: true }).click();
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
});

for (const { label, value, advanced } of [
  { label: "Message density", value: "compact", advanced: false },
  { label: "Timestamps", value: "full", advanced: true },
]) {
  test(`personal global search finds ${label} from Notifications`, async ({
    page,
  }) => {
    await seedSettings(page);
    await page.goto("/comms");
    await page
      .getByRole("button", { name: "OpenComms menu", exact: true })
      .first()
      .click();
    await page
      .getByRole("menuitem", { name: "My preferences", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "My preferences",
      exact: true,
    });
    await dialog
      .getByRole("tab", { name: "Notifications", exact: true })
      .click();
    const field = dialog.getByRole("combobox", { name: label, exact: true });
    const search = dialog.getByRole("searchbox", {
      name: "Search settings",
      exact: true,
    });
    const disclosure = dialog.getByRole("button", {
      name: /Advanced settings/,
    });
    await expect(field).toHaveCount(0);
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await search.fill(label);
    await expect(field).toHaveCount(1);
    await expect(field).toBeVisible();
    await field.selectOption(value);
    if (advanced) await expect(disclosure).toContainText("1 changed");
    await search.fill("Notify me about");
    const notifications = dialog.getByRole("combobox", {
      name: "Notify me about",
      exact: true,
    });
    await expect(notifications).toHaveCount(1);
    await expect(notifications).toBeVisible();
    await search.fill("");
    await expect(field).toHaveCount(0);
    await expect(notifications).toHaveCount(1);
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await dialog.getByRole("tab", { name: "Appearance", exact: true }).click();
    if (advanced) {
      await expect(field).toHaveCount(0);
      await expect(disclosure).toContainText("1 changed");
      await disclosure.click();
    }
    await expect(field).toHaveValue(value);
  });
}

test("workspace locks live in Advanced and keep lower-scope common values locked", async ({
  page,
}) => {
  await seedSettings(page);
  await page.goto("/comms");
  const workspace = await workspaceSettings(page);
  await workspace.getByRole("tab", { name: "Messaging", exact: true }).click();
  await expect(
    workspace.getByLabel("Lock Channel mode for categories and channels", {
      exact: true,
    }),
  ).toBeHidden();
  await workspace
    .getByLabel("Channel mode", { exact: true })
    .selectOption("announcements");
  await workspace.getByRole("button", { name: /Advanced settings/ }).click();
  await workspace
    .getByRole("switch", {
      name: "Lock Channel mode for categories and channels",
      exact: true,
    })
    .check();
  await workspace
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await openChannel(page);
  const dialog = settings(page);
  await dialog.getByRole("tab", { name: "Messaging", exact: true }).click();
  await expect(
    dialog.getByLabel("Channel mode", { exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByLabel("Channel mode", { exact: true })).toHaveValue(
    "announcements",
  );
  await expect(
    dialog.getByText("Locked by workspace", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const again = await workspaceSettings(page);
  await again
    .getByRole("tab", { name: "Posting and history", exact: true })
    .click();
  await again.getByRole("button", { name: /Advanced settings/ }).click();
  await expect(again.getByText(/Lock Lock channel/)).toHaveCount(0);
});

test("a manager edits group access and checks saved granting reasons without losing Advanced or its draft", async ({
  page,
}) => {
  const data = await seedSettings(page, "manager");
  await page.goto("/comms");
  await openChannel(page);
  const dialog = settings(page);
  await dialog.getByRole("tab", { name: "Access", exact: true }).click();
  await dialog
    .getByRole("radiogroup", { name: "Everyone", exact: true })
    .getByText("Read", { exact: true })
    .click();
  await dialog
    .getByRole("radiogroup", { name: "Dispatch team", exact: true })
    .getByText("Read", { exact: true })
    .click();
  const guests = dialog.getByRole("radiogroup", {
    name: "Guests",
    exact: true,
  });
  await expect(
    guests.getByRole("radio", { name: "Read", exact: true }),
  ).toBeChecked();
  await expect(
    guests.getByRole("radio", { name: "Read and post", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: /Advanced settings/ }).click();
  await dialog
    .getByRole("button", { name: "Check one person", exact: true })
    .click();
  const inspector = page.getByRole("dialog", {
    name: "Effective access",
    exact: true,
  });
  await inspector
    .getByLabel("Check access for", { exact: true })
    .selectOption(data.sofia);
  await expect(inspector.getByText(/Dispatch team/)).toBeVisible();
  await inspector
    .getByLabel("Check access for", { exact: true })
    .selectOption(data.guest);
  await expect(
    inspector
      .getByText("Guests are read-only; group grants cannot enable writing.")
      .first(),
  ).toBeVisible();
  await inspector
    .getByRole("button", { name: "Back to settings", exact: true })
    .last()
    .click();
  await expect(
    dialog.getByRole("button", { name: /Advanced settings/ }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    dialog
      .getByRole("radiogroup", { name: "Everyone", exact: true })
      .getByRole("radio", { name: "Read", exact: true }),
  ).toBeChecked();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await openChannel(page);
  await dialog.getByRole("tab", { name: "Access", exact: true }).click();
  await expect(
    dialog
      .getByRole("radiogroup", { name: "Dispatch team", exact: true })
      .getByRole("radio", { name: "Read", exact: true }),
  ).toBeChecked();
});

test("a member has no shared settings controls even through a settings URL", async ({
  page,
}) => {
  const data = await seedSettings(page, "member");
  await page.goto("/comms");
  await expect(
    page.getByRole("button", { name: "Channel settings", exact: true }),
  ).toHaveCount(0);
  await page.goto(`/comms?settings=permissions&channel=${data.conversation}`);
  await expect(
    page.getByText("You cannot manage settings for this scope.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Capabilities for", { exact: true }),
  ).toHaveCount(0);
});

test("create channel validates and focuses its name without a bare hash subtitle", async ({
  page,
}) => {
  await seedSettings(page);
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Create channel",
    exact: true,
  });
  await expect(
    dialog.getByText("Settings for # only.", { exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  const name = dialog.getByLabel("Channel name", { exact: true });
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toBeFocused();
  await expect(name).toHaveAccessibleDescription("Enter a name.");
});

test("settings content comes first with one phone footer in light and dark", async ({
  page,
}, testInfo) => {
  const data = await seedSettings(page);
  await page.route(`**/api/users/${data.owner.user_id}/preferences`, (route) =>
    route.fulfill({
      json: { ...profilePreferences(data.owner.user_id), theme: "system" },
    }),
  );
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`/comms?conversation=${data.conversation}`);
      await openChannel(page);
      const dialog = settings(page);
      await expect(
        dialog.getByLabel("Channel name", { exact: true }),
      ).toBeVisible();
      if (width === 390) {
        expect(
          (await dialog
            .getByLabel("Channel name", { exact: true })
            .boundingBox())!.y,
        ).toBeLessThan(844 * 0.6);
        await expect(
          dialog.getByRole("combobox", {
            name: "Settings section",
            exact: true,
          }),
        ).toBeVisible();
        await expect(dialog.locator("footer")).toHaveCount(1);
      }
      await expectNoHorizontalScroll(page);
      if (theme === "dark")
        await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
      await page.screenshot({
        path: testInfo.outputPath(`settings-${width}-${theme}.png`),
        animations: "disabled",
      });
      if (width === 390)
        await dialog
          .getByLabel("Settings section", { exact: true })
          .selectOption("permissions");
      else
        await dialog.getByRole("tab", { name: "Access", exact: true }).click();
      await expect(
        dialog.getByRole("radiogroup", { name: "Guests", exact: true }),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.screenshot({
        path: testInfo.outputPath(`access-${width}-${theme}.png`),
        animations: "disabled",
      });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page
        .getByRole("button", { name: "OpenComms menu", exact: true })
        .first()
        .click();
      await page
        .getByRole("menuitem", { name: "My preferences", exact: true })
        .click();
      const personal = page.getByRole("dialog", {
        name: "My preferences",
        exact: true,
      });
      const density = personal.getByLabel("Message density", { exact: true });
      await expect(density).toBeVisible();
      if (width === 390)
        expect((await density.boundingBox())!.y).toBeLessThan(844 * 0.6);
      await expectNoHorizontalScroll(page);
      await page.screenshot({
        path: testInfo.outputPath(`personal-${width}-${theme}.png`),
        animations: "disabled",
      });
    }
});
