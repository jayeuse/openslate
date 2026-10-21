import {
  expect,
  test,
  signedInAs,
  defaultOrganization,
  expectNoHorizontalScroll,
  type Page,
} from "./helpers/test";
import { profilePreferences } from "./helpers/profile-api";
import { createMemorySeed } from "../support/comms-memory/memory/seed";
import { createMemoryCommsRuntime } from "../support/comms-memory/memory-client";
import { validateMemoryState } from "../support/comms-memory/memory/snapshot";
import { serializeSampleSessionSnapshot } from "../../src/components/systems/shared/runtime/sample-state";
import { workspaceSessionSnapshotStorageKey } from "../../src/components/systems/shared/runtime/workspace-identity";
import { installCommsLiveApi } from "./helpers/comms-live-api";

async function seedDetails(
  page: Page,
  options: {
    long?: boolean;
    deniedRecord?: boolean;
    replyRecord?: boolean;
    crosspostUnread?: boolean;
  } = {},
) {
  const owner = {
    user_id: "00000000-0000-4000-8000-000000000101",
    org_id: defaultOrganization.org_id,
  };
  const role = options.deniedRecord ? "member" : "admin";
  await signedInAs(page, { id: owner.user_id, role });
  const state = createMemorySeed(owner, {
    role,
    display_name: "Details owner",
  });
  const thread = Object.values(state.threads)[0],
    root = state.messages[thread.root_message_id];
  const reply = Object.values(state.messages).find(
    (message) => message.parent_id === root.id,
  )!;
  const record = Object.values(state.records)[0];
  const field = "79000000-0000-4000-8000-000000000001";
  state.fields[field] = {
    id: field,
    org_id: owner.org_id,
    module_id: record.module_id,
  };
  record.fields.push({
    field_id: field,
    label: "Priority",
    display_value: "High",
  });
  state.configuration.workspace = {
    settings: { record_card_fields: [field] },
    capabilities: {
      scope: { kind: "workspace" },
      everyone: {},
      group_grants: [],
    },
  };
  if (options.replyRecord) {
    reply.record_links = root.record_links;
    root.record_links = [];
  }
  if (options.deniedRecord)
    state.people[owner.user_id].readable_module_ids = [];
  if (options.crosspostUnread) {
    reply.also_send_to_channel = true;
    state.users[owner.user_id].last_read_seq[root.conversation_id] = 1;
  }
  if (options.long) {
    for (let seq = 3; seq <= 140; seq++) {
      const id = `79000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`;
      state.messages[id] = {
        ...root,
        id,
        seq,
        client_key: id,
        record_links: [],
        body: `Later message ${seq}. ${"Later conversation context. ".repeat(4)}`,
      };
    }
    state.high_water_seq[root.conversation_id] = 140;
  }
  validateMemoryState(state, owner.org_id);
  const key = workspaceSessionSnapshotStorageKey(owner.user_id, owner.org_id);
  const value = serializeSampleSessionSnapshot(
    owner.user_id,
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
    initial: state,
    key,
    thread: thread.id,
    root: root.id,
    conversation: root.conversation_id,
    record: record.id,
    noah: root.author_id,
    sofia: reply.author_id,
  };
}

/** Serves the seeded details world through the live Comms routes. */
function serveDetails(
  page: Page,
  data: Awaited<ReturnType<typeof seedDetails>>,
) {
  return installCommsLiveApi(page, {
    userId: data.owner.user_id,
    organizationId: data.owner.org_id,
    runtime: createMemoryCommsRuntime({
      owner: data.owner,
      initial: data.initial,
    }),
  });
}

test("thread focus returns to its older virtualized parent after close", async ({
  page,
}) => {
  const data = await seedDetails(page, { long: true });
  const server = await installCommsLiveApi(page, {
    userId: data.owner.user_id,
    organizationId: data.owner.org_id,
    runtime: createMemoryCommsRuntime({
      owner: data.owner,
      initial: data.initial,
    }),
  });
  try {
    await page.goto("/comms");
    await expect(
      page.getByRole("article").filter({ hasText: "Later message 140." }),
    ).toBeVisible();
    await expect(page.locator(`[id="${data.root}"]`)).toHaveCount(0);
    await page
      .getByRole("button", { name: "Thread: Morning handover", exact: true })
      .click();
    const thread = page.getByRole("region", {
      name: "Thread conversation",
      exact: true,
    });
    await expect(
      thread.getByRole("heading", { name: "Morning handover", exact: true }),
    ).toBeFocused();
    await thread
      .getByRole("button", { name: "Back to messages", exact: true })
      .click();
    await expect(thread).toHaveCount(0);
    await expect(page.locator(`[id="${data.root}"]`)).toBeFocused();
    await expect(page.locator(`[id="${data.root}"]`)).toBeInViewport();
  } finally {
    server.close();
  }
});

test("thread follow copy resolve reopen and also-send use the existing client", async ({
  page,
}) => {
  const data = await seedDetails(page);
  const server = await serveDetails(page, data);
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copiedThread = text;
        },
      },
    }),
  );
  await page.goto(
    `/comms?conversation=${data.conversation}&thread=${data.thread}`,
  );
  const thread = page.getByRole("region", {
    name: "Thread conversation",
    exact: true,
  });
  await thread
    .getByRole("button", { name: "Follow thread", exact: true })
    .click();
  await expect(
    thread.getByRole("button", { name: "Unfollow thread", exact: true }),
  ).toBeVisible();
  await thread
    .getByRole("button", { name: "Copy thread link", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.dataset.copiedThread),
    )
    .toContain(`thread=${data.thread}`);
  await thread
    .getByRole("button", { name: "Resolve thread", exact: true })
    .click();
  const reply = thread.getByRole("textbox", {
    name: "Thread reply",
    exact: true,
  });
  await expect(reply).toBeEnabled();
  await thread
    .getByRole("button", { name: "Reopen thread", exact: true })
    .click();
  await reply.fill("Also visible in the channel");
  await thread
    .getByRole("checkbox", { name: "Also send to channel", exact: true })
    .check();
  await thread.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(reply).toHaveValue("");
  // The draft clears only after the server accepted the reply.
  const posted = Object.values(server.snapshot().messages)
    .filter((message) => message.body === "Also visible in the channel")
    .map(({ parent_id, also_send_to_channel }) => ({
      parent_id,
      also_send_to_channel,
    }));
  expect(posted).toEqual([
    { parent_id: data.root, also_send_to_channel: true },
  ]);
  const inThread = thread
    .getByRole("article")
    .filter({ hasText: "Also visible in the channel" });
  const inChannel = page
    .getByLabel("Messages", { exact: true })
    .getByRole("article")
    .filter({ hasText: "Also visible in the channel" });
  await expect(inThread).toHaveCount(1);
  await expect(inChannel).toHaveCount(1);
  await expect(inChannel).not.toHaveAttribute(
    "id",
    (await inThread.getAttribute("id"))!,
  );
  await inThread.getByRole("button", { name: /^Message actions:/ }).click();
  await expect(
    page.getByRole("menuitem", { name: "Create thread", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(
    thread.getByRole("button", { name: "Unfollow thread", exact: true }),
  ).toBeVisible();
});

test("jump to first unread follows a crossposted reply into its one-level thread", async ({
  page,
}) => {
  const data = await seedDetails(page, { long: true, crosspostUnread: true });
  await installCommsLiveApi(page, {
    userId: data.owner.user_id,
    organizationId: data.owner.org_id,
    runtime: createMemoryCommsRuntime({
      owner: data.owner,
      initial: data.initial,
    }),
  });
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "Jump to first unread", exact: true })
    .click();
  const thread = page.getByRole("region", {
    name: "Thread conversation",
    exact: true,
  });
  const reply = thread.getByRole("article").filter({
    hasText: "Thanks. I will confirm the next update with Riverside.",
  });
  await expect(reply).toBeFocused();
  await expect(reply).toBeInViewport();
});

test("thread settings keep the draft while locked and show archived state independently", async ({
  page,
}) => {
  const data = await seedDetails(page);
  await installCommsLiveApi(page, {
    userId: data.owner.user_id,
    organizationId: data.owner.org_id,
    runtime: createMemoryCommsRuntime({
      owner: data.owner,
      initial: data.initial,
    }),
  });
  await page.goto(
    `/comms?conversation=${data.conversation}&thread=${data.thread}`,
  );
  const thread = page.getByRole("region", {
    name: "Thread conversation",
    exact: true,
  });
  const reply = thread.getByRole("textbox", {
    name: "Thread reply",
    exact: true,
  });
  await reply.fill("Retained while locked");
  await thread
    .getByRole("button", { name: "Thread settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Thread settings",
    exact: true,
  });
  await settings
    .getByLabel("Thread name", { exact: true })
    .fill("Updated handover");
  await settings.getByRole("checkbox", { name: "Locked", exact: true }).check();
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(reply).toBeDisabled();
  await expect(reply).toHaveValue("Retained while locked");
  await expect(thread.getByText("Locked", { exact: true })).toBeVisible();
  await thread
    .getByRole("button", { name: "Thread settings", exact: true })
    .click();
  await settings
    .getByRole("checkbox", { name: "Locked", exact: true })
    .uncheck();
  await settings
    .getByRole("checkbox", { name: "Archived", exact: true })
    .check();
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(thread.getByText("Archived", { exact: true })).toBeVisible();
  await expect(reply).toBeDisabled();
  await thread
    .getByRole("button", { name: "Thread settings", exact: true })
    .click();
  await settings
    .getByRole("checkbox", { name: "Archived", exact: true })
    .uncheck();
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(reply).toBeEnabled();
  await expect(
    thread.getByRole("heading", { name: "Updated handover", exact: true }),
  ).toBeVisible();
});

test("member presence has three named groups and verified person cards stay scoped", async ({
  page,
}) => {
  const server = await installCommsLiveApi(page);
  const noah = server.members.find(
    (member) => member.display_name === "Noah Tan",
  )!;
  const sofia = server.members.find(
    (member) => member.display_name === "Sofia Garcia",
  )!;
  server.setPresence(noah.user_id, "online");
  server.setPresence(sofia.user_id, "away");
  const reads: string[] = [];
  await page.route("**/api/users/*/card", (route) => {
    reads.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 403, json: { detail: "Forbidden" } });
  });
  try {
    await page.goto("/comms?panel=members");
    const members = page.getByRole("region", {
      name: "Members with access",
      exact: true,
    });
    await expect(
      members.getByRole("region", { name: "Online members", exact: true }),
    ).toContainText("Noah Tan");
    await expect(
      members.getByRole("region", { name: "Away members", exact: true }),
    ).toContainText("Sofia Garcia");
    await expect(
      members.getByRole("region", { name: "Offline members", exact: true }),
    ).toContainText("Mara Santos");
    await expect(
      members.getByRole("region", { name: "Away members", exact: true }),
    ).toContainText("Operations · Away");
    await members
      .getByRole("button", { name: "Person card: Noah Tan", exact: true })
      .click();
    await expect(
      page
        .getByRole("dialog", { name: "Person card", exact: true })
        .getByRole("alert"),
    ).toContainText("Person unavailable");
    expect(reads).toEqual([`/api/users/${noah.user_id}/card`]);
  } finally {
    await page.close();
    server.close();
  }
});

test("record detail and recent linked records include thread-only references and authorized fields", async ({
  page,
}) => {
  await serveDetails(page, await seedDetails(page, { replyRecord: true }));
  await page.goto("/comms");
  await page
    .getByRole("list", { name: "Records you follow", exact: true })
    .getByRole("button", { name: /Riverside service visit/ })
    .click();
  const record = page.getByRole("complementary", {
    name: "Record",
    exact: true,
  });
  await expect(record.getByText("Priority", { exact: true })).toBeVisible();
  await expect(record.getByText("High", { exact: true })).toBeVisible();
  await record.getByRole("button", { name: /Thanks. I will confirm/ }).click();
  await expect(
    page.getByRole("region", { name: "Thread conversation", exact: true }),
  ).toBeVisible();
});

test("thread management and record detail do not broaden read-only source permissions", async ({
  page,
}) => {
  const data = await seedDetails(page, { deniedRecord: true });
  await serveDetails(page, data);
  await page.goto(
    `/comms?conversation=${data.conversation}&thread=${data.thread}`,
  );
  const thread = page.getByRole("region", {
    name: "Thread conversation",
    exact: true,
  });
  await expect(
    thread.getByRole("button", { name: "Thread settings", exact: true }),
  ).toBeDisabled();
  await expect(
    thread.getByRole("button", { name: "Resolve thread", exact: true }),
  ).toBeDisabled();
  await page.goto(
    `/comms?conversation=${data.conversation}&panel=record:${data.record}`,
  );
  await expect(
    page.getByText("Record unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Riverside service visit", { exact: true }),
  ).toHaveCount(0);
});

test("phone record cards keep their title readable with inline context and a separate OpenView action", async ({
  page,
}) => {
  const data = await seedDetails(page);
  await serveDetails(page, data);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/comms?conversation=${data.conversation}`);
  const card = page.getByRole("button", {
    name: /Open record:.*Riverside service visit/,
  });
  const title = card.getByText("Riverside service visit", { exact: true });
  await expect(title).toBeVisible();
  expect(
    await title.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await expect(title).toHaveCSS("white-space", "normal");
  const icon = await card.locator("svg").boundingBox();
  const context = await card
    .getByText("Service requests", { exact: true })
    .boundingBox();
  expect(Math.abs(icon!.y - context!.y)).toBeLessThan(12);
  await expect(
    page.getByRole("link", {
      name: "Open in OpenView: Riverside service visit",
      exact: true,
    }),
  ).toHaveAttribute("href", `/openview?record=${data.record}`);
  await card.click();
  await expect(
    page.getByRole("dialog", { name: "Record", exact: true }),
  ).toBeVisible();
});

test("detail panes retain usable light and dark desktop and phone layouts", async ({
  page,
}, testInfo) => {
  const data = await seedDetails(page);
  await serveDetails(page, data);
  await page.route(`**/api/users/${data.owner.user_id}/preferences`, (route) =>
    route.fulfill({
      json: { ...profilePreferences(data.owner.user_id), theme: "system" },
    }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme });
      for (const panel of ["thread", "members", "record"] as const) {
        await page.goto(
          `/comms?conversation=${data.conversation}&${panel === "thread" ? `thread=${data.thread}` : `panel=${panel === "record" ? `record:${data.record}` : "members"}`}`,
        );
        const region =
          panel === "thread"
            ? page.getByRole("region", {
                name: "Thread conversation",
                exact: true,
              })
            : panel === "members"
              ? page.getByRole("region", {
                  name: "Members with access",
                  exact: true,
                })
              : page.getByRole(width === 390 ? "dialog" : "complementary", {
                  name: "Record",
                  exact: true,
                });
        await expect(region).toBeVisible();
        if (panel === "thread")
          await expect(
            region.getByRole("textbox", { name: "Thread reply", exact: true }),
          ).toBeEnabled();
        if (theme === "dark")
          await expect(page.locator("html")).toHaveClass(/\bdark\b/);
        else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
        await expectNoHorizontalScroll(page);
        const geometry = await region.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            overflow: element.scrollWidth > element.clientWidth + 1,
          };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(width);
        expect(geometry.overflow).toBe(false);
        await page.mouse.move(0, 0);
        await page.screenshot({
          path: testInfo.outputPath(`${panel}-${width}-${theme}.png`),
          animations: "disabled",
        });
        if (panel === "thread") {
          await region
            .getByRole("button", { name: "Back to messages", exact: true })
            .click();
          await expect(page.locator(`[id="${data.root}"]`)).toBeFocused();
        }
      }
    }
  expect(errors).toEqual([]);
});
