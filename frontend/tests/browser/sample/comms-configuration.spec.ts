import { expect, test } from "../coverage";
import { installSessionMocks } from "../helpers/administration-fixtures";
import AxeBuilder from "@axe-core/playwright";
import {
  CHANNELS,
  MESSAGES,
  type Thread,
} from "../../../src/components/sample/comms/model";
import { INITIAL_RECORDS } from "../../../src/components/sample/sample-data";
import { createCommsConfiguration } from "../../../src/components/sample/comms/configuration";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installSessionMocks(page);
  await page.route("**/bff/**", (route) => route.abort());
});

test("settings modals retain one size while navigating and changing controls", async ({
  page,
}, testInfo) => {
  await page.goto("/comms");
  async function open(name: string) {
    await page.getByRole("button", { name: "OpenComms", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
    return page.getByRole("dialog");
  }
  const workspace = await open("Workspace settings");
  const baseline = await workspace.boundingBox();
  for (const name of [
    "Messaging",
    "Threads",
    "Members",
    "Notifications",
    "Overview",
  ]) {
    await workspace.getByRole("tab", { name, exact: true }).click();
    await expect
      .poll(async () => (await workspace.boundingBox())!.height)
      .toBe(baseline!.height);
    await expect
      .poll(async () => (await workspace.boundingBox())!.width)
      .toBe(baseline!.width);
  }
  await workspace.getByRole("button", { name: "Cancel", exact: true }).click();
  const personal = await open("My preferences");
  await personal.getByRole("tab", { name: "Shortcuts", exact: true }).click();
  await expect
    .poll(async () => (await personal.boundingBox())!.height)
    .toBe(baseline!.height);
  await personal
    .getByRole("combobox", { name: "Send shortcut", exact: true })
    .selectOption("ctrl-enter");
  await expect
    .poll(async () => (await personal.boundingBox())!.height)
    .toBe(baseline!.height);
  await expect(
    personal.getByRole("button", { name: "Reset to default", exact: true }),
  ).toHaveCount(1);
  await expect(
    personal.getByRole("button", { name: "Reset to default", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: `/tmp/comms-consistent-settings-${testInfo.project.name}.png`,
  });
  await personal
    .getByRole("button", { name: "Reset to default", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(personal).toBeVisible();
  await personal
    .getByRole("combobox", { name: "Send shortcut", exact: true })
    .selectOption("ctrl-enter");
  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", {
    name: "Discard changes?",
    exact: true,
  });
  await expect(discard).toBeVisible();
  expect((await discard.boundingBox())!.height).toBeLessThan(
    baseline!.height / 2,
  );
  await expect(
    discard.getByRole("button", { name: "Keep editing", exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: `/tmp/comms-small-discard-${testInfo.project.name}.png`,
  });
  await page.keyboard.press("Escape");
  await expect(discard).not.toBeVisible();
  await expect(
    personal.getByRole("combobox", { name: "Send shortcut", exact: true }),
  ).toHaveValue("ctrl-enter");
  await page.keyboard.press("Escape");
  await expect(discard).toBeVisible();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await open("Templates");
  await expect
    .poll(async () => (await page.getByRole("dialog").boundingBox())!.height)
    .toBe(baseline!.height);
});

test("central Access rules project a role decision into the native OpenComms channel owner", async ({
  page,
}) => {
  await page.goto("/access?view=rules");
  await page.getByLabel("Subject type", { exact: true }).selectOption("role");
  await page
    .getByLabel("Subject", { exact: true })
    .selectOption("sample-member");
  await page
    .getByLabel("Scope type", { exact: true })
    .selectOption("comms-channel");
  await page
    .getByLabel("Resource scope", { exact: true })
    .selectOption({ label: "operations" });
  await page.getByLabel("Search permissions").fill("Reply in threads");
  await page
    .getByRole("group", { name: "Reply in threads decision", exact: true })
    .getByRole("button", { name: "Deny", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Review impact", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply 1 draft choice", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm and apply", exact: true })
    .click();

  await page.goto("/comms");
  await page
    .getByRole("button", { name: "Channel actions: operations", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Channel settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("tab", { name: "Advanced Permissions", exact: true })
    .click();
  await dialog
    .getByLabel("Permissions for", { exact: true })
    .selectOption("role:sample-member");
  await expect(
    dialog.getByLabel("Reply to messages", { exact: true }),
  ).toHaveValue("deny");
});

test("local join requests can be accepted and appear in the membership preview", async ({
  page,
}) => {
  await page.goto("/comms");
  await page.getByRole("button", { name: "OpenComms", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Channel management", exact: true })
    .click();
  const management = page.getByRole("dialog", {
    name: "Channel management",
    exact: true,
  });
  await management
    .getByRole("combobox", { name: "Membership action", exact: true })
    .selectOption("request");
  await management
    .getByRole("combobox", { name: "Invite person", exact: true })
    .selectOption("sample-person-morgan-kim");
  await management
    .getByRole("button", { name: "Create local join requests", exact: true })
    .click();
  await expect(management).toContainText("request · pending");
  await management.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(management).toContainText("request · accepted");
  await management.getByRole("button", { name: "Close", exact: true }).click();
  await page.goto(
    "/comms?settings=permissions&channel=sample-channel-operations",
  );
  const settings = page.getByRole("dialog");
  await settings.getByRole("tab", { name: "Members", exact: true }).click();
  await settings
    .getByRole("combobox", { name: "Preview membership for", exact: true })
    .selectOption("sample-person-morgan-kim");
  await expect(
    settings.getByRole("region", { name: "Membership preview" }),
  ).toContainText("An accepted local membership record exists.");
});

test("message edits keep originals and moderation can resolve reports and recover content", async ({
  page,
  isMobile,
}) => {
  await page.goto("/comms");
  if (isMobile)
    await page.getByRole("button", { name: "operations", exact: true }).click();
  await page
    .getByLabel("Message", { exact: true })
    .fill("Original inspection report");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  const article = page.getByRole("article").filter({
    hasText: /Original inspection report|Corrected inspection report/,
  });
  await article
    .getByRole("button", { name: "Message actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Edit message", exact: true })
    .click();
  await page
    .getByLabel("Edit message", { exact: true })
    .fill("Corrected inspection report");
  await page.getByRole("button", { name: "Save message", exact: true }).click();
  await article
    .getByRole("button", { name: "Message actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Edit history", exact: true })
    .click();
  const history = page.getByRole("dialog", {
    name: "Message history",
    exact: true,
  });
  await expect(history).toContainText("Original inspection report");
  await expect(history).toContainText("Corrected inspection report");
  await history.getByRole("button", { name: "Close", exact: true }).click();
  await article
    .getByRole("button", { name: "Message actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Report message", exact: true })
    .click();
  const report = page.getByRole("dialog", {
    name: "Report message",
    exact: true,
  });
  await report
    .getByRole("textbox", { name: "Reason", exact: true })
    .fill("Review inspection wording");
  await report
    .getByRole("button", { name: "Submit report", exact: true })
    .click();
  await page.getByRole("button", { name: "OpenComms", exact: true }).click();
  await page.getByRole("menuitem", { name: "Moderation", exact: true }).click();
  const moderation = page.getByRole("dialog", {
    name: "Moderation",
    exact: true,
  });
  const queued = moderation
    .getByRole("article")
    .filter({ hasText: "Review inspection wording" });
  await queued
    .getByRole("button", { name: "Resolve report", exact: true })
    .click();
  await expect(queued).toContainText("resolved");
  await queued
    .getByRole("button", { name: "Remove message recoverably", exact: true })
    .click();
  await moderation
    .getByRole("button", { name: "Restore message", exact: true })
    .click();
  await moderation.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    article.getByText("Corrected inspection report", { exact: true }),
  ).toBeVisible();
  const saved = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("openslate.sample.v1")!),
  );
  expect(Object.keys(saved["comms-configuration"].tombstones)).toHaveLength(0);
  expect(
    Object.values(saved["comms-configuration"].messageHistory).flat(),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: "Original inspection report" }),
    ]),
  );
});

test("resetting all channel settings stages inherited defaults until saved", async ({
  page,
}) => {
  const config = createCommsConfiguration();
  config.workspace.settings.slowModeSeconds = 20;
  config.channels[CHANNELS[0].id] = {
    settings: { slowModeSeconds: 5, editWindowMinutes: 30 },
    permissions: { everyone: { react: "deny" } },
  };
  await page.addInitScript(
    (configuration) =>
      sessionStorage.setItem(
        "openslate.sample.v1",
        JSON.stringify({ "comms-configuration": configuration }),
      ),
    config,
  );
  await page.goto(
    "/comms?settings=permissions&channel=sample-channel-operations",
  );
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Messaging", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /Reset/ })).toHaveCount(1);
  await dialog
    .getByRole("button", { name: "Reset to default", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Slow mode (seconds)", { exact: true }),
  ).toHaveValue("20");
  await expect(
    dialog.getByLabel("Edit window (minutes)", { exact: true }),
  ).toHaveValue("15");
  await dialog
    .getByRole("tab", { name: "Advanced Permissions", exact: true })
    .click();
  await expect(dialog.getByLabel("Add reactions", { exact: true })).toHaveValue(
    "inherit",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  const cancelled = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("openslate.sample.v1")!),
  );
  expect(cancelled["comms-configuration"].channels[CHANNELS[0].id]).toEqual(
    config.channels[CHANNELS[0].id],
  );

  await page.goto(
    "/comms?settings=permissions&channel=sample-channel-operations",
  );
  await dialog
    .getByRole("button", { name: "Reset to default", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  const saved = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("openslate.sample.v1")!),
  );
  expect(
    saved["comms-configuration"].channels[CHANNELS[0].id].settings,
  ).toEqual({});
  expect(
    saved["comms-configuration"].channels[CHANNELS[0].id].permissions.everyone
      .react,
  ).toBe("inherit");
  expect(saved["comms-configuration"].workspace.settings.slowModeSeconds).toBe(
    20,
  );
});

test("membership preview evaluates joining and defaults without changing permission or membership", async ({
  page,
}) => {
  await page.goto(
    "/comms?settings=permissions&channel=sample-channel-operations",
  );
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Members", exact: true }).click();
  await dialog
    .getByLabel("Preview membership for", { exact: true })
    .selectOption("sample-person-morgan-kim");
  await dialog
    .getByLabel("Channel joining", { exact: true })
    .selectOption("request");
  const preview = dialog.getByRole("region", { name: "Membership preview" });
  await expect(preview).toContainText(
    "Can request to join; approval is required.",
  );
  await dialog
    .getByLabel("Channel joining", { exact: true })
    .selectOption("invite");
  await expect(preview).toContainText(
    "An invitation is required before joining.",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  const snapshot = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("openslate.sample.v1")!),
  );
  expect(snapshot["comms-configuration"]?.invites ?? []).toEqual([]);
});

test("sample examples augment saved conversations without replacing records threads or drafts", async ({
  page,
}) => {
  const customChannel = {
    ...CHANNELS[0],
    id: "saved-custom-channel",
    name: "saved-team",
    system: false,
  };
  const customMessage = {
    ...MESSAGES[0],
    id: "saved-custom-message",
    conversation: customChannel.id,
    text: "Saved custom conversation",
  };
  const thread: Thread = {
    id: "saved-custom-thread",
    messageId: customMessage.id,
    conversation: customChannel.id,
    resolved: false,
    subscribed: true,
    replies: ["Saved legacy thread reply"],
  };
  const record = {
    ...INITIAL_RECORDS[0],
    id: "saved-custom-record",
    title: "Saved custom service request",
  };
  const snapshot = {
    commsChannels: [...CHANNELS, customChannel],
    commsMessages: [...MESSAGES, customMessage],
    commsThreads: [thread],
    records: [...INITIAL_RECORDS, record],
    [`comms-draft-text-${customChannel.id}`]: "Saved custom draft",
  };
  await page.addInitScript((data) => {
    if (!sessionStorage.getItem("openslate.sample.v1"))
      sessionStorage.setItem("openslate.sample.v1", JSON.stringify(data));
  }, snapshot);
  await page.goto(`/comms?conversation=${customChannel.id}`);
  await expect(
    page.getByRole("article").getByText(customMessage.text, { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Saved custom draft",
  );
  await page.getByRole("button", { name: "OpenComms", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Workspace settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Search settings", { exact: true }).fill("slow mode");
  await dialog.getByLabel("Slow mode (seconds)", { exact: true }).fill("10");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("article").getByText(customMessage.text, { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Saved custom draft",
  );
  const saved = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("openslate.sample.v1")!),
  );
  expect(saved.commsChannels).toEqual(
    expect.arrayContaining(snapshot.commsChannels),
  );
  expect(saved.commsMessages).toEqual(
    expect.arrayContaining(snapshot.commsMessages),
  );
  expect(saved.commsThreads).toEqual(
    expect.arrayContaining(snapshot.commsThreads),
  );
  expect(saved.records).toEqual(snapshot.records);
  expect(
    saved.commsChannels.filter(
      (item: { id: string }) => item.id === "sample-channel-team-wins",
    ),
  ).toHaveLength(1);
  expect(
    saved["access-people"].filter(
      (item: { id: string }) => item.id === "sample-person-sofia-garcia",
    ),
  ).toHaveLength(1);
  await page.goto("/comms");
  await page.getByRole("button", { name: "team-wins", exact: true }).click();
  await expect(page.getByRole("article").first()).toBeVisible();
});

test("settings dialog is accessible in dark mode with reachable scrolling actions", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("openslate-theme", "dark"),
  );
  await page.goto("/comms");
  const opener = page.getByRole("button", { name: "OpenComms", exact: true });
  await opener.click();
  await page
    .getByRole("menuitem", { name: "Workspace settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Notifications", exact: true }).click();
  const result = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
  await expect(
    dialog.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeInViewport();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeInViewport();
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `/tmp/comms-settings-${testInfo.project.name}.png`,
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("permission inspector uses the draft and workspace locks survive returning to settings", async ({
  page,
}) => {
  await page.goto("/comms");
  await page.getByRole("button", { name: "OpenComms", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Workspace settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Workspace settings",
    exact: true,
  });
  await settings
    .getByRole("tab", { name: "Advanced Permissions", exact: true })
    .click();
  await settings
    .getByLabel("Permissions for", { exact: true })
    .selectOption("person:sample-person-morgan-kim");
  await settings
    .getByLabel("Start new messages", { exact: true })
    .selectOption("deny");
  await settings
    .getByRole("switch", {
      name: "Lock Start new messages for categories and channels",
      exact: true,
    })
    .check();
  await settings
    .getByRole("button", { name: "Inspect effective access", exact: true })
    .click();
  const inspector = page.getByRole("dialog", {
    name: "Effective access",
    exact: true,
  });
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await inspector
    .getByLabel("Inspect person", { exact: true })
    .selectOption("sample-person-morgan-kim");
  const posting = inspector
    .getByRole("heading", { name: "Start new messages", exact: true })
    .locator("..")
    .locator("..");
  await expect(posting).toContainText("Denied");
  await inspector
    .getByLabel("Inspect person", { exact: true })
    .selectOption("sample-eli");
  await expect(posting).toContainText("Allowed");
  await inspector
    .getByRole("button", { name: "Back to settings", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await settings
    .getByLabel("Permissions for", { exact: true })
    .selectOption("person:sample-person-morgan-kim");
  await expect(
    settings.getByLabel("Start new messages", { exact: true }),
  ).toHaveValue("deny");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await page.goto(
    "/comms?settings=permissions&role=sample-member&channel=sample-channel-operations",
  );
  const channel = page.getByRole("dialog");
  await expect(
    channel.getByLabel("Permissions for", { exact: true }),
  ).toHaveValue("role:sample-member");
  await expect(
    channel.getByLabel("Start new messages", { exact: true }),
  ).toBeDisabled();
  await channel.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("personal send shortcut and shared notification preference affect behavior", async ({
  page,
  isMobile,
}) => {
  await page.goto("/comms");
  if (isMobile)
    await page.getByRole("button", { name: "operations", exact: true }).click();
  await page.getByRole("button", { name: "OpenComms", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "My preferences", exact: true })
    .click();
  const preferences = page.getByRole("dialog", {
    name: "My preferences",
    exact: true,
  });
  await preferences
    .getByRole("tab", { name: "Shortcuts", exact: true })
    .click();
  await preferences
    .getByLabel("Send shortcut", { exact: true })
    .selectOption("ctrl-enter");
  await preferences
    .getByRole("tab", { name: "Notifications", exact: true })
    .click();
  await preferences
    .getByRole("switch", { name: "Thread reply notifications", exact: true })
    .uncheck();
  await preferences
    .getByRole("button", { name: "Preview notification", exact: true })
    .click();
  await expect(
    preferences.getByRole("region", { name: "Notification preview" }),
  ).toContainText("off");
  await preferences
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("Shortcut acceptance message");
  await composer.press("Enter");
  await expect(composer).toHaveValue("Shortcut acceptance message\n");
  await composer.press("Control+Enter");
  await expect(composer).toHaveValue("");
  await expect(
    page.getByText("Shortcut acceptance message", { exact: true }),
  ).toBeVisible();
  await page.goto("/platform#notifications");
  await expect(
    page.getByRole("switch", {
      name: "Thread reply notifications",
      exact: true,
    }),
  ).not.toBeChecked();
});

test("workspace configuration preserves drafts and saves local messaging settings", async ({
  page,
  isMobile,
}) => {
  await page.goto("/comms");
  if (isMobile)
    await page.getByRole("button", { name: "operations", exact: true }).click();
  await page
    .getByLabel("Message", { exact: true })
    .fill("Unsent inspection notes");
  await page.getByRole("button", { name: "OpenComms", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Workspace settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Workspace settings",
    exact: true,
  });
  await dialog.getByRole("tab", { name: "Messaging", exact: true }).click();
  await dialog.getByLabel("Slow mode (seconds)", { exact: true }).fill("15");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("alertdialog", { name: "Discard changes?", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(
    dialog.getByLabel("Slow mode (seconds)", { exact: true }),
  ).toHaveValue("15");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Unsent inspection notes",
  );
  await page.getByRole("button", { name: "OpenComms", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Workspace settings", exact: true })
    .click();
  await dialog.getByRole("tab", { name: "Messaging", exact: true }).click();
  await expect(
    dialog.getByLabel("Slow mode (seconds)", { exact: true }),
  ).toHaveValue("15");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("panel width sliders support keyboard adjustment and preserve saved values", async ({
  page,
}) => {
  await page.goto("/comms");
  await page.getByRole("button", { name: "OpenComms", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "My preferences", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "My preferences",
    exact: true,
  });
  await dialog
    .getByRole("tab", { name: "Navigation & panels", exact: true })
    .click();
  const channels = dialog.getByRole("slider", {
    name: "Channel panel width (pixels)",
    exact: true,
  });
  const members = dialog.getByRole("slider", {
    name: "Member panel width (pixels)",
    exact: true,
  });
  const thread = dialog.getByRole("slider", {
    name: "Thread panel width (pixels)",
    exact: true,
  });
  await expect
    .poll(
      async () =>
        (
          await dialog
            .locator('[data-slot="slider-track"]')
            .first()
            .boundingBox()
        )?.height ?? 0,
    )
    .toBeGreaterThan(0);
  await expect(channels).toHaveAttribute("min", "200");
  await expect(channels).toHaveAttribute("max", "360");
  await channels.focus();
  await channels.press("Home");
  await channels.press("ArrowRight");
  await members.focus();
  await members.press("End");
  await thread.focus();
  await thread.press("End");
  await thread.press("ArrowLeft");
  await expect(channels).toHaveAttribute("aria-valuenow", "210");
  await expect(members).toHaveAttribute("aria-valuenow", "360");
  await expect(thread).toHaveAttribute("aria-valuenow", "550");
  await expect(
    dialog.getByRole("region", { name: "Panel layout preview" }),
  ).toContainText("Channels: 210px · Members: 360px · Thread: 550px");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  if (test.info().project.name !== "mobile-chromium") {
    await expect
      .poll(async () =>
        Math.round(
          (await page
            .getByRole("complementary", { name: "Conversations", exact: true })
            .boundingBox())!.width,
        ),
      )
      .toBe(210);
    await expect
      .poll(async () =>
        Math.round(
          (await page
            .getByRole("complementary", {
              name: "Channel members",
              exact: true,
            })
            .boundingBox())!.width,
        ),
      )
      .toBe(360);
  }
  await page.getByRole("button", { name: "OpenComms", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "My preferences", exact: true })
    .click();
  await dialog
    .getByRole("tab", { name: "Navigation & panels", exact: true })
    .click();
  await expect(channels).toHaveAttribute("aria-valuenow", "210");
  await expect(members).toHaveAttribute("aria-valuenow", "360");
  await expect(thread).toHaveAttribute("aria-valuenow", "550");
  await page.screenshot({ path: test.info().outputPath("panel-sliders.png") });
});
