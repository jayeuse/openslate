import type { Page } from "@playwright/test";
import { expect, test } from "../coverage";
import { installSessionMocks } from "../helpers/administration-fixtures";
import { createCommsConfiguration } from "../../../src/components/sample/comms/configuration";
import { CHANNELS, MESSAGES } from "../../../src/components/sample/comms/model";

const storageKey = "openslate.sample.v1";
async function seed(page: Page, values: Record<string, unknown>) {
  await page.addInitScript(
    ({ key, values }) => {
      if (!sessionStorage.getItem(key))
        sessionStorage.setItem(key, JSON.stringify(values));
    },
    { key: storageKey, values },
  );
}
async function snapshot(page: Page) {
  return page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key) ?? "{}"),
    storageKey,
  );
}
async function populatedSnapshot(page: Page) {
  await expect
    .poll(async () => (await snapshot(page)).commsExamplesLoaded)
    .toBe(true);
  return snapshot(page);
}
async function openTool(page: Page, menu: string, title = menu) {
  await page.getByRole("button", { name: "OpenComms", exact: true }).click();
  await page.getByRole("menuitem", { name: menu, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installSessionMocks(page);
  await page.route("**/bff/**", (route) => route.abort());
});

test("templates apply only selected settings and reject invalid imports without replacing conversations or membership", async ({
  page,
}, testInfo) => {
  const config = createCommsConfiguration();
  config.channels[CHANNELS[0].id] = {
    settings: { defaultMemberIds: ["sample-eli"], slowModeSeconds: 7 },
    permissions: { "role:sample-member": { reply: "allow" } },
  };
  await seed(page, {
    "comms-configuration": config,
    commsMessages: MESSAGES,
    commsChannels: CHANNELS,
  });
  await page.goto("/comms");
  const initial = await populatedSnapshot(page);
  const dialog = await openTool(page, "Templates", "Channel templates");
  await dialog.screenshot({
    path: `/tmp/comms-tools-templates-${testInfo.project.name}.png`,
  });
  await dialog
    .getByRole("combobox", { name: "Template", exact: true })
    .selectOption("announcements");
  await dialog
    .getByLabel("Template name", { exact: true })
    .fill("Dispatch announcements");
  await dialog
    .getByRole("button", { name: "Save template", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("Template saved.");
  await expect
    .poll(
      async () =>
        (await snapshot(page))["comms-configuration"].templates.find(
          (item: { id: string }) => item.id === "announcements",
        ).name,
    )
    .toBe("Dispatch announcements");
  await dialog
    .getByRole("button", { name: "Preview changes", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", { name: "Change preview" }),
  ).toContainText("normal");
  await dialog
    .getByRole("button", { name: "Apply selected settings", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText(
    "Applied selected settings",
  );
  await expect
    .poll(
      async () =>
        (await snapshot(page))["comms-configuration"].channels[CHANNELS[0].id]
          .settings.mode,
    )
    .toBe("announcements");
  let saved = await snapshot(page);
  expect(
    saved["comms-configuration"].channels[CHANNELS[0].id].settings
      .defaultMemberIds,
  ).toEqual(["sample-eli"]);
  expect(
    saved["comms-configuration"].channels[CHANNELS[0].id].settings
      .slowModeSeconds,
  ).toBe(7);
  expect(
    saved["comms-configuration"].channels[CHANNELS[0].id].permissions,
  ).toEqual(config.channels[CHANNELS[0].id].permissions);
  expect(saved.commsMessages).toEqual(initial.commsMessages);
  expect(saved.commsChannels).toEqual(initial.commsChannels);
  await dialog.getByText("Import or export settings", { exact: true }).click();
  await dialog
    .getByRole("textbox", { name: "Settings JSON", exact: true })
    .fill('{"messages":[]}');
  await dialog
    .getByRole("button", { name: "Validate import", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Only settings may be imported",
  );
  saved = await snapshot(page);
  expect(saved.commsMessages).toEqual(initial.commsMessages);
  expect(
    saved["comms-configuration"].channels[CHANNELS[0].id].settings.mode,
  ).toBe("announcements");
  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", {
    name: "Discard changes?",
    exact: true,
  });
  await expect(discard).toBeVisible();
  await discard
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Settings JSON", exact: true }),
  ).toHaveValue('{"messages":[]}');
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await discard
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect((await snapshot(page)).commsMessages).toEqual(initial.commsMessages);
});

test("automation previews enforce system-message policy and require explicit local application", async ({
  page,
}, testInfo) => {
  const config = createCommsConfiguration();
  config.channels[CHANNELS[0].id] = {
    settings: { systemMessages: false },
    permissions: {},
  };
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/bff/") &&
      !["GET", "HEAD"].includes(request.method())
    )
      mutations.push(request.url());
  });
  await seed(page, { "comms-configuration": config, commsMessages: MESSAGES });
  await page.goto("/comms");
  const initial = await populatedSnapshot(page);
  const dialog = await openTool(page, "Automation");
  await dialog.screenshot({
    path: `/tmp/comms-tools-automation-${testInfo.project.name}.png`,
  });
  await dialog
    .getByRole("textbox", { name: "Message template", exact: true })
    .fill("Inspection event: {{title}}");
  await dialog
    .getByRole("button", { name: "Preview automation", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", { name: "Automation preview" }),
  ).toContainText("Inspection event: Replace pump seal");
  expect((await snapshot(page)).commsMessages).toEqual(initial.commsMessages);
  await dialog
    .getByRole("button", { name: "Apply local preview", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "System messages are disabled",
  );
  expect((await snapshot(page)).commsMessages).toEqual(initial.commsMessages);
  await dialog
    .getByRole("combobox", { name: "Destination channel", exact: true })
    .selectOption(CHANNELS[1].id);
  await dialog
    .getByRole("button", { name: "Preview automation", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Apply local preview", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText(
    "Preview applied as a local system message",
  );
  await expect
    .poll(async () => (await snapshot(page)).commsMessages.length)
    .toBe(initial.commsMessages.length + 1);
  const saved = await snapshot(page);
  expect(saved.commsMessages.slice(0, -1)).toEqual(initial.commsMessages);
  const sent = saved.commsMessages.at(-1);
  expect(sent).toMatchObject({
    conversation: CHANNELS[1].id,
    text: "Inspection event: Replace pump seal",
    recordId: "sample-sr-1004",
  });
  expect(mutations).toEqual([]);
});

test("outbox edits, cancels and explicitly sends scheduled messages", async ({
  page,
}) => {
  const config = createCommsConfiguration();
  config.schedules = [
    {
      id: "edit-schedule",
      channelId: CHANNELS[0].id,
      text: "Scheduled inspection",
      sendAt: Date.UTC(2027, 0, 1),
      authorId: "sample-eli",
    },
    {
      id: "cancel-schedule",
      channelId: CHANNELS[0].id,
      text: "Cancel this reminder",
      sendAt: Date.UTC(2027, 0, 1),
      authorId: "sample-eli",
    },
  ];
  await seed(page, { "comms-configuration": config, commsMessages: MESSAGES });
  await page.goto("/comms");
  const initial = await populatedSnapshot(page);
  const dialog = await openTool(page, "Scheduled messages", "Scheduled outbox");
  await dialog.getByRole("button", { name: /Scheduled inspection/ }).click();
  await dialog
    .getByRole("textbox", { name: "Scheduled message", exact: true })
    .fill("Updated inspection reminder");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText(
    "Scheduled message saved locally",
  );
  await dialog
    .getByRole("button", { name: "Preview scheduled message", exact: true })
    .click();
  expect((await snapshot(page)).commsMessages).toEqual(initial.commsMessages);
  await dialog.getByRole("button", { name: "Send Now", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Message sent locally",
  );
  await dialog.getByRole("button", { name: /Cancel this reminder/ }).click();
  await dialog
    .getByRole("button", { name: "Cancel scheduled message", exact: true })
    .click();
  await expect(
    dialog.getByText("No scheduled messages.", { exact: true }),
  ).toBeVisible();
  const saved = await snapshot(page);
  expect(saved["comms-configuration"].schedules).toEqual([]);
  expect(saved.commsMessages).toHaveLength(initial.commsMessages.length + 1);
  expect(saved.commsMessages.slice(0, -1)).toEqual(initial.commsMessages);
  expect(saved.commsMessages.at(-1)).toMatchObject({
    text: "Updated inspection reminder",
    conversation: CHANNELS[0].id,
  });
});

test("retention previews include thread replies without deleting local history", async ({
  page,
}) => {
  const old = [{ ...MESSAGES[0], created: 1 }];
  const replies = [
    {
      id: "old-reply",
      conversation: "old-thread",
      author: "You",
      text: "Keep this old reply",
      created: 1,
      pinned: false,
    },
  ];
  const threads = [
    {
      id: "old-thread",
      conversation: CHANNELS[0].id,
      messageId: old[0].id,
      resolved: false,
      subscribed: true,
      replies,
    },
  ];
  // Retention owns a deliberately initialized two-message history. Other tool
  // workflows exercise the populated defaults, and enrichment is covered separately.
  await seed(page, {
    commsMessages: old,
    commsThreads: threads,
    commsExamplesLoaded: true,
  });
  await page.goto("/comms");
  const dialog = await openTool(page, "Retention", "Retention preview");
  await dialog
    .getByLabel("Retention days (0 keeps everything)", { exact: true })
    .fill("1");
  await expect(dialog.getByRole("status")).toHaveText(
    "2 of 2 messages would be affected.",
  );
  await expect(
    dialog.getByText("Keep this old reply", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const saved = await snapshot(page);
  expect(saved.commsMessages).toEqual(old);
  expect(saved.commsThreads).toEqual(threads);
});

test("history previews show readable changes and restore workspace permission and setting locks", async ({
  page,
}) => {
  const config = createCommsConfiguration();
  config.workspace = {
    settings: { slowModeSeconds: 30 },
    permissions: { everyone: { post: "deny" } },
  };
  config.lockedSettings = ["slowModeSeconds"];
  config.lockedPermissions = ["post"];
  config.history = [
    {
      id: "workspace-history",
      created: 1,
      actorId: "sample-eli",
      label: "Workspace posting policy",
      scope: { kind: "workspace", id: "workspace" },
      before: {
        settings: { slowModeSeconds: 0 },
        permissions: { everyone: { post: "allow" } },
      },
      after: config.workspace,
      beforeLocks: { settings: [], permissions: [] },
      afterLocks: { settings: ["slowModeSeconds"], permissions: ["post"] },
    },
  ];
  await seed(page, { "comms-configuration": config, commsMessages: MESSAGES });
  await page.goto("/comms");
  const initial = await populatedSnapshot(page);
  const dialog = await openTool(page, "History", "Configuration history");
  await dialog.getByText("Before and after", { exact: true }).click();
  await expect(
    dialog.getByText("Everyone · Start new messages", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("Allow → Deny", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "Preview restoration", exact: true })
    .click();
  const preview = dialog.getByRole("region", { name: "Restoration preview" });
  await expect(preview).toContainText("Locked → Unlocked");
  expect(
    (await snapshot(page))["comms-configuration"].lockedPermissions,
  ).toEqual(["post"]);
  await preview
    .getByRole("button", { name: "Confirm restoration", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Configuration restored.",
  );
  const saved = await snapshot(page);
  expect(saved["comms-configuration"].lockedSettings).toEqual([]);
  expect(saved["comms-configuration"].lockedPermissions).toEqual([]);
  expect(saved["comms-configuration"].workspace).toEqual(
    config.history[0].before,
  );
  expect(saved["comms-configuration"].history[0].beforeLocks).toEqual({
    settings: ["slowModeSeconds"],
    permissions: ["post"],
  });
  expect(saved.commsMessages).toEqual(initial.commsMessages);
});

for (const sourceKind of [
  "channel message",
  "thread reply",
  "direct message",
] as const) {
  test(`schedule message creates a staged local entry from a ${sourceKind}`, async ({
    page,
    isMobile,
  }) => {
    const inThread = sourceKind === "thread reply";
    const inDirect = sourceKind === "direct message";
    const conversationId = inDirect ? "sample-dm-alex" : CHANNELS[0].id;
    const source = {
      ...MESSAGES[2],
      id: "schedule-source",
      text: "Schedule this inspection",
      conversation: inThread ? "schedule-thread" : conversationId,
    };
    await seed(page, {
      "comms-configuration": createCommsConfiguration(),
      commsMessages: inThread ? MESSAGES : [...MESSAGES, source],
      commsThreads: inThread
        ? [
            {
              id: "schedule-thread",
              conversation: CHANNELS[0].id,
              messageId: MESSAGES[2].id,
              resolved: false,
              subscribed: false,
              replies: [source],
            },
          ]
        : [],
    });
    const writes: string[] = [];
    page.on("request", (request) => {
      if (
        request.url().includes("/bff/") &&
        !["GET", "HEAD"].includes(request.method())
      )
        writes.push(request.url());
    });
    await page.goto(
      inDirect ? `/comms?conversation=${conversationId}` : "/comms",
    );
    if (isMobile && !inDirect)
      await page
        .getByRole("button", { name: "operations", exact: true })
        .click();
    if (inThread) {
      await page.getByRole("button", { name: "Threads", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Threads", exact: true })
        .getByRole("button", { name: /Workshop is ready/ })
        .click();
    }
    const initial = await populatedSnapshot(page);
    const message = page.getByRole("article").filter({ hasText: source.text });
    if (isMobile)
      await message
        .getByRole("button", { name: "Message actions", exact: true })
        .click();
    else await message.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Schedule message", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Scheduled outbox",
      exact: true,
    });
    await expect(
      dialog.getByLabel("Scheduled message", { exact: true }),
    ).toHaveValue(source.text);
    await dialog
      .getByLabel("Scheduled message", { exact: true })
      .fill("Inspection reminder tomorrow");
    await dialog
      .getByLabel("Scheduled time", { exact: true })
      .fill("2027-01-02T10:30");
    expect((await snapshot(page))["comms-configuration"].schedules).toEqual([]);
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(dialog.getByRole("status")).toContainText(
      "Scheduled message saved locally",
    );
    const saved = await snapshot(page);
    expect(saved["comms-configuration"].schedules).toHaveLength(1);
    expect(saved["comms-configuration"].schedules[0]).toMatchObject({
      channelId: conversationId,
      text: "Inspection reminder tomorrow",
      recordId: source.recordId,
      authorId: "sample-eli",
    });
    expect(saved.commsMessages).toEqual(initial.commsMessages);
    await dialog
      .getByRole("button", { name: "Preview scheduled message", exact: true })
      .click();
    await dialog.getByRole("button", { name: "Send Now", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText(
      "Message sent locally",
    );
    expect((await snapshot(page)).commsMessages.at(-1)).toMatchObject({
      conversation: conversationId,
      text: "Inspection reminder tomorrow",
      recordId: source.recordId,
    });
    expect(writes).toEqual([]);
  });
}

test("scheduled direct messages remain in the outbox while the recipient is blocked", async ({
  page,
}) => {
  const config = createCommsConfiguration();
  config.schedules = [
    {
      id: "blocked-direct-schedule",
      channelId: "sample-dm-alex",
      text: "Blocked recipient reminder",
      sendAt: Date.UTC(2027, 0, 1),
      authorId: "sample-eli",
    },
  ];
  await seed(page, {
    "comms-configuration": config,
    commsMessages: MESSAGES,
    commsDirects: [
      { id: "sample-dm-alex", user: "Alex Lee", read: true, blocked: true },
    ],
  });
  await page.goto("/comms");
  const initial = await populatedSnapshot(page);
  const dialog = await openTool(page, "Scheduled messages", "Scheduled outbox");
  await dialog
    .getByRole("button", { name: /Blocked recipient reminder/ })
    .click();
  await dialog
    .getByRole("button", { name: "Preview scheduled message", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Send Now", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Unblock this conversation before sending",
  );
  const saved = await snapshot(page);
  expect(saved.commsMessages).toEqual(initial.commsMessages);
  expect(saved["comms-configuration"].schedules).toEqual(config.schedules);
});
