import { expect, test } from "../coverage";
import type { Locator, Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { initialPeople } from "../../../src/components/sample/access/model";

async function messageMenu(page: Page, message: Locator, isMobile: boolean) {
  if (isMobile)
    await message
      .getByRole("button", { name: "Message actions", exact: true })
      .click();
  else await message.click({ button: "right" });
}

async function giveCurrentPersonElevatedRole(page: Page) {
  await page.evaluate((seedPeople) => {
    const saved = JSON.parse(
      sessionStorage.getItem("openslate.sample.v1") ?? "{}",
    ) as Record<string, unknown> & { "access-people"?: typeof seedPeople };
    saved["access-people"] = (saved["access-people"] ?? seedPeople).map(
      (person) =>
        person.id === "sample-eli"
          ? { ...person, role: "sample-admin" }
          : person,
    );
    sessionStorage.setItem("openslate.sample.v1", JSON.stringify(saved));
  }, initialPeople);
  await page.reload();
}

import { installSessionMocks } from "../helpers/administration-fixtures";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";
test.beforeEach(async ({ page }) => {
  await installSessionMocks(page);
  await page.route("**/bff/**", async (route) => {
    if (await fulfillWorkspaceRequest(route)) return;
    await route.fulfill({
      json: {
        items: [],
        pagination: {
          offset: 0,
          limit: 100,
          count: 0,
          total: 0,
          has_more: false,
        },
      },
    });
  });
});

test("channel conversations support threads and retain sample messages without live writes", async ({
  page,
  isMobile,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
      /\/bff\/|\/session\//.test(request.url())
    )
      writes.push(request.url());
  });
  await page.goto("/comms");
  if (isMobile)
    await page.getByRole("button", { name: "operations", exact: true }).click();
  await page
    .getByLabel("Message", { exact: true })
    .fill("Sample repair update");
  await page
    .getByLabel("Message", { exact: true })
    .dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(
    page.getByRole("article").filter({ hasText: "Sample repair update" }),
  ).toHaveCount(0);
  await page.getByLabel("Message", { exact: true }).press("Shift+Enter");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Sample repair update\n",
  );
  await expect(
    page.getByRole("article").filter({ hasText: "Sample repair update" }),
  ).toHaveCount(0);
  await page.getByLabel("Message", { exact: true }).press("Enter");
  const message = page
    .getByRole("article")
    .filter({ hasText: "Sample repair update" });
  await expect(message).toBeVisible();
  await messageMenu(page, message, isMobile);
  await page
    .getByRole("menuitem", { name: "Create thread", exact: true })
    .click();
  await page
    .getByLabel("Thread reply", { exact: true })
    .fill("Ready for inspection");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(
    page.getByText("Ready for inspection", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Resolve thread" }).click();
  await expect(
    page
      .getByRole("region", { name: "Thread conversation" })
      .getByText("Resolved", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back to messages", exact: true })
    .click();
  await page.getByRole("button", { name: "Threads", exact: true }).click();
  const threads = page.getByRole("dialog", { name: "Threads", exact: true });
  await threads.getByRole("button", { name: "Inactive", exact: true }).click();
  await threads.getByRole("button", { name: /Sample repair update/ }).click();
  await expect(
    page
      .getByRole("region", { name: "Thread conversation" })
      .getByText("Ready for inspection", { exact: true }),
  ).toBeVisible();
  await page.reload();
  if (isMobile)
    await page.getByRole("button", { name: "operations", exact: true }).click();
  await expect(
    page
      .getByRole("article")
      .getByText("Sample repair update", { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([]);
});

test("sample import validates bad rows and imports only valid mapped examples", async ({
  page,
}) => {
  await page.goto("/platform");
  await page
    .getByRole("button", { name: "Import & export", exact: true })
    .click();
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByText("Row 3: title is required.")).toBeVisible();
  await page
    .getByRole("button", { name: "Import 2 valid sample rows" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "2 sample records imported",
  );
  await page.getByRole("button", { name: "Preview export" }).click();
  await expect(
    page.getByRole("heading", { name: "CSV export preview" }),
  ).toBeVisible();
});

test("channel dialogs stage changes and inherit role access from customizable categories", async ({
  page,
  isMobile,
}) => {
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "Create category", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Category name").fill("Dispatch team");
  await dialog
    .getByRole("tab", { name: "Advanced Permissions", exact: true })
    .click();
  await dialog.getByLabel("View channel", { exact: true }).selectOption("deny");
  await dialog.getByLabel("Permissions for").selectOption("role:sample-member");
  await dialog
    .getByLabel("View channel", { exact: true })
    .selectOption("allow");
  await dialog
    .getByRole("button", { name: "Create category", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  await dialog.getByLabel("Channel name").fill("Field dispatch");
  await dialog
    .getByLabel("Channel topic")
    .fill("Daily dispatch updates\nKeep handover notes here.");
  await dialog
    .getByLabel("Category", { exact: true })
    .selectOption({ label: "Dispatch team" });
  await dialog
    .getByRole("tab", { name: "Advanced Permissions", exact: true })
    .click();
  await expect(dialog.getByLabel("View channel", { exact: true })).toHaveValue(
    "inherit",
  );
  await dialog.getByRole("tab", { name: "Overview", exact: true }).click();
  await expect(dialog.getByLabel("Channel topic")).toHaveValue(
    "Daily dispatch updates\nKeep handover notes here.",
  );
  await dialog
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  if (isMobile)
    await page.getByRole("button", { name: "Members", exact: true }).click();
  const members = page.getByRole("region", { name: "Members with access" });
  await expect(members.getByText("Eli Cruz", { exact: true })).toBeVisible();
  await expect(members.getByText("Mara Santos", { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Close members" }).click();
  await expect(members).not.toBeVisible();
  if (isMobile)
    await page
      .getByRole("button", { name: "Conversations", exact: true })
      .click();
  await page
    .getByRole("button", { name: "Edit category Dispatch team", exact: true })
    .click();
  await dialog
    .getByRole("tab", { name: "Advanced Permissions", exact: true })
    .click();
  await dialog
    .getByLabel("View channel", { exact: true })
    .selectOption("allow");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  if (isMobile)
    await page
      .getByRole("button", { name: "Field dispatch", exact: true })
      .click();
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await expect(members.getByText("Mara Santos", { exact: true })).toBeVisible();
  await expect(members.getByText("Offline").first()).toBeVisible();
  await page.getByRole("button", { name: "Close members" }).click();
  await expect(members).not.toBeVisible();

  await page.getByRole("button", { name: "Channel settings" }).click();
  await dialog.getByLabel("Channel name").fill("Discarded rename");
  await dialog.getByLabel("Channel topic").fill("Discarded topic");
  await dialog
    .getByRole("tab", { name: "Advanced Permissions", exact: true })
    .click();
  await dialog
    .getByLabel("Start new messages", { exact: true })
    .selectOption("deny");
  await dialog.getByRole("tab", { name: "Overview", exact: true }).click();
  await expect(dialog.getByLabel("Channel name")).toHaveValue(
    "Discarded rename",
  );
  await expect(dialog.getByLabel("Channel topic")).toHaveValue(
    "Discarded topic",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Field dispatch", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Channel settings" }).click();
  await expect(dialog.getByLabel("Channel topic")).toHaveValue(
    "Daily dispatch updates\nKeep handover notes here.",
  );
  await dialog
    .getByRole("tab", { name: "Advanced Permissions", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Start new messages", { exact: true }),
  ).toHaveValue("inherit");
  await dialog.getByRole("tab", { name: "Overview", exact: true }).click();
  await dialog.getByLabel("Channel topic").fill("Updated dispatch topic");
  await dialog
    .getByRole("tab", { name: "Advanced Permissions", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("button", { name: "Channel settings" }).click();
  await expect(dialog.getByLabel("Channel topic")).toHaveValue(
    "Updated dispatch topic",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByLabel("Message", { exact: true })
    .fill("Announcement baseline");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "Channel settings" }).click();
  await dialog
    .getByRole("tab", { name: "Advanced Permissions", exact: true })
    .click();
  await dialog
    .getByLabel("Start new messages", { exact: true })
    .selectOption("deny");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
  const announcement = page
    .getByRole("article")
    .filter({ hasText: "Announcement baseline" });
  await messageMenu(page, announcement, isMobile);
  await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
  await page.getByLabel("Message", { exact: true }).fill("Member response");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(
    page.getByRole("article").filter({ hasText: "Member response" }),
  ).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
  await messageMenu(
    page,
    announcement.filter({ hasNotText: "Member response" }),
    isMobile,
  );
  await page
    .getByRole("menuitem", { name: "Create thread", exact: true })
    .click();
  await page
    .getByLabel("Thread reply", { exact: true })
    .fill("Restricted-channel thread response");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Thread conversation" })
      .getByRole("article")
      .filter({ hasText: "Restricted-channel thread response" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back to messages", exact: true })
    .click();
  await page.getByRole("button", { name: "Channel settings" }).click();
  await dialog
    .getByRole("tab", { name: "Advanced Permissions", exact: true })
    .click();
  await dialog
    .getByLabel("Start new messages", { exact: true })
    .selectOption("allow");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await page
    .getByLabel("Message", { exact: true })
    .fill("Please review this job");
  // Exercise the keyboard entry point for the record picker.
  await page.getByRole("button", { name: "Attach record" }).focus();
  await page.getByRole("button", { name: "Attach record" }).press("Enter");
  await page.getByLabel("Attach record link").selectOption("sample-sr-1004");
  await page.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: "handover.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Synthetic handover notes"),
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const message = page
    .getByRole("article")
    .filter({ hasText: "Please review this job" });
  await expect(message.getByRole("link", { name: /OpenView/ })).toHaveAttribute(
    "href",
    "/openview?record=sample-sr-1004",
  );
  await expect(message).toContainText("handover.txt");
  await page.getByRole("button", { name: "Channel settings" }).click();
  await dialog.getByRole("button", { name: "Archive channel" }).click();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
  if (isMobile)
    await page
      .getByRole("button", { name: "Conversations", exact: true })
      .click();
  await expect(
    page.getByRole("button", { name: "Field dispatch", exact: true }),
  ).toBeVisible();
});

test("own direct messages enforce the edit window and blocking while read state remains editable", async ({
  page,
  isMobile,
}) => {
  await page.clock.install();
  await page.goto("/comms");
  await page.getByRole("button", { name: "Start direct message" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Message Morgan Kim", exact: true })
    .click();
  await page.getByLabel("Message", { exact: true }).fill("Fresh dispatch note");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const message = page
    .getByRole("article")
    .filter({ hasText: "Fresh dispatch note" });
  await messageMenu(page, message, isMobile);
  await page
    .getByRole("menuitem", { name: "Edit message", exact: true })
    .click();
  await page
    .getByLabel("Edit message", { exact: true })
    .fill("Revised dispatch note");
  await page.getByRole("button", { name: "Save message" }).click();
  const revised = page
    .getByRole("article")
    .filter({ hasText: "Revised dispatch note" });
  await expect(revised).toBeVisible();
  await page.clock.fastForward(16 * 60 * 1000);
  await messageMenu(page, revised, isMobile);
  await expect(
    page.getByRole("menuitem", { name: "Edit message", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Block user", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Mark read", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Mark unread", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Unblock user" }).click();
  await messageMenu(page, revised, isMobile);
  await page
    .getByRole("menuitem", { name: "Delete message", exact: true })
    .click();
  await expect(
    page.getByText("Revised dispatch note", { exact: true }),
  ).toHaveCount(0);
});

test("record actions connect assignment and conversations and sample account actions never write live", async ({
  page,
  isMobile,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
      /\/bff\/|\/session\//.test(request.url())
    )
      writes.push(request.url());
  });
  await page.goto("/platform");
  await page
    .getByRole("button", { name: "Record actions", exact: true })
    .click();
  await page.getByLabel("Assign record to").selectOption("Alex Lee");
  await page
    .getByRole("button", { name: "Follow record", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Unfollow record", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start chat about record" }).click();
  await page.getByRole("link", { name: "Open record discussion" }).click();
  await page
    .getByRole("button", { name: "Discuss Replace pump seal", exact: true })
    .click();
  await expect(
    page.getByRole("article").getByRole("link", { name: "Replace pump seal" }),
  ).toBeVisible();
  await page.goto("/platform");
  await page
    .getByRole("button", { name: "Record actions", exact: true })
    .click();
  await expect(page.getByLabel("Assign record to")).toHaveValue("Alex Lee");
  await page
    .getByRole("button", { name: "Account & presence", exact: true })
    .click();
  await page.getByRole("button", { name: "Change sample password" }).click();
  await page.getByRole("button", { name: "Confirm sample action" }).click();
  await expect(
    page.getByText(
      "Sample password changed. Your real credentials are unchanged.",
    ),
  ).toBeVisible();
  await expect(page.locator("input[type=password]")).toHaveCount(0);
  expect(writes).toEqual([]);
  if (isMobile)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
});

test("shell destinations and message search deep links open their exact sample targets", async ({
  page,
}) => {
  await page.goto("/platform#account");
  await expect(
    page.getByRole("heading", { name: "Account security" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Notifications", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Notification center" }),
  ).toBeVisible();
  await page.goto(
    "/comms?conversation=sample-dm-alex&message=sample-message-old",
  );
  const message = page
    .getByRole("article")
    .filter({ hasText: "Yesterday’s inspection notes are ready." });
  await expect(message).toBeVisible();
  await expect(message).toBeFocused();
});

test("message context menus enforce ownership and elevated actions and support reactions and replies", async ({
  page,
  isMobile,
}) => {
  await page.goto("/comms");
  if (isMobile)
    await page.getByRole("button", { name: "operations", exact: true }).click();
  const message = page.getByRole("article").filter({
    hasText: "Morning team. Let’s keep today’s inspections moving.",
  });
  if (isMobile)
    await message
      .getByRole("button", { name: "Message actions", exact: true })
      .click();
  else await message.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Add reaction", exact: true }),
  ).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .include('[role="menu"]')
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await expect(
    page.getByRole("menuitem", { name: "Edit message", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Unpin message", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Delete message", exact: true }),
  ).toBeVisible();
  const reactions = page.getByRole("menuitem", {
    name: "Add reaction",
    exact: true,
  });
  if (isMobile) await reactions.click();
  else await reactions.hover();
  await page
    .getByRole("menuitem", { name: "React with 👍", exact: true })
    .click();
  await expect(
    message.getByRole("button", { name: "👍 1", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await message.getByRole("button", { name: "👍 1", exact: true }).click();
  await expect(
    message.getByRole("button", { name: "👍 1", exact: true }),
  ).toHaveCount(0);
  if (isMobile)
    await message
      .getByRole("button", { name: "Message actions", exact: true })
      .click();
  else await message.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
  await expect(
    page.getByText("Replying to Alex Lee", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Message", { exact: true })
    .fill("I will check this shortly");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  const own = page
    .getByRole("article")
    .filter({ hasText: "I will check this shortly" });
  await expect(own).toContainText("Alex Lee");
  if (isMobile)
    await own
      .getByRole("button", { name: "Message actions", exact: true })
      .click();
  else await own.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Edit message", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Delete message", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  if (isMobile)
    await page
      .getByRole("button", { name: "Conversations", exact: true })
      .click();
  await giveCurrentPersonElevatedRole(page);
  if (isMobile)
    await page.getByRole("button", { name: "operations", exact: true }).click();
  await messageMenu(page, own, isMobile);
  await expect(
    page.getByRole("menuitem", { name: "Edit message", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const elevatedTarget = page
    .getByRole("article")
    .filter({ hasText: "Workshop is ready." });
  if (isMobile)
    await elevatedTarget
      .getByRole("button", { name: "Message actions", exact: true })
      .click();
  else await elevatedTarget.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Edit message", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Pin message", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", { name: "Pin message", exact: true })
    .click();
  await page
    .getByLabel("Search messages", { exact: true })
    .fill("no matching messages");
  await page
    .getByRole("button", { name: "Pinned messages", exact: true })
    .click();
  await page.getByRole("button", { name: /Workshop is ready/ }).click();
  await expect(elevatedTarget).toBeFocused();
  await expect(page.getByLabel("Search messages", { exact: true })).toHaveValue(
    "",
  );
  if (isMobile)
    await elevatedTarget
      .getByRole("button", { name: "Message actions", exact: true })
      .click();
  else await elevatedTarget.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Delete message", exact: true })
    .click();
  await expect(elevatedTarget).toHaveCount(0);
  await expect(own).toBeVisible();
});

test("avatar and member profile popovers expose identity and start direct conversations", async ({
  page,
  isMobile,
}) => {
  await page.goto("/comms");
  if (isMobile)
    await page.getByRole("button", { name: "operations", exact: true }).click();
  const message = page.getByRole("article").filter({
    hasText: "Morning team. Let’s keep today’s inspections moving.",
  });
  await message
    .getByRole("button", { name: "View profile for Alex Lee", exact: true })
    .click({ button: "right" });
  const profile = page.getByRole("dialog", {
    name: /^(Alex Lee|Mara Santos|Eli Cruz)$/,
  });
  await expect(profile.getByText("Alex Lee", { exact: true })).toBeVisible();
  await expect(
    profile.getByText("Field specialist", { exact: true }),
  ).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .include('[role="dialog"]')
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await expect(
    page.getByRole("menuitem", { name: "Add reaction", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(profile).toHaveCount(0);
  if (isMobile)
    await page.getByRole("button", { name: "Members", exact: true }).click();
  const members = page.getByRole("region", {
    name: "Members with access",
    exact: true,
  });
  await expect(members.getByRole("heading", { name: /^Online/ })).toBeVisible();
  await expect(
    members.getByRole("heading", { name: /^Offline/ }),
  ).toBeVisible();
  for (const name of ["Mara Santos", "Eli Cruz", "Alex Lee"]) {
    const member = members.getByRole("button", {
      name: `View profile for ${name}`,
      exact: true,
    });
    const bounds = await member.boundingBox();
    expect(bounds).not.toBeNull();
    // On mobile the open profile covers the row label; its right edge stays exposed.
    await member.click({
      button: "right",
      position: { x: bounds!.width - 4, y: 4 },
    });
    await expect(profile).toHaveCount(1);
    await expect(
      profile.getByRole("button", { name: `Message ${name}`, exact: true }),
    ).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(profile).toHaveCount(0);
  await expect(
    members.getByRole("button", {
      name: "View profile for Alex Lee",
      exact: true,
    }),
  ).toBeFocused();
  await members
    .getByRole("button", { name: "View profile for Mara Santos", exact: true })
    .click({ button: "right" });
  await expect(profile).toHaveCount(1);
  await members.getByLabel("Search members", { exact: true }).click();
  await expect(profile).toHaveCount(0);
  await members.getByRole("button", { name: /Mara Santos/ }).click();
  await expect(
    profile.getByText("Administrator", { exact: true }),
  ).toBeVisible();
  await profile
    .getByRole("button", { name: "Message Mara Santos", exact: true })
    .click();
  await expect(profile).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Mara Santos", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("thread chat supports emotes and local files without making upload requests", async ({
  page,
  isMobile,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      !["GET", "HEAD"].includes(request.method()) &&
      /\/(bff|session)\//.test(request.url())
    )
      writes.push(request.url());
  });
  await page.goto("/comms");
  if (isMobile)
    await page.getByRole("button", { name: "operations", exact: true }).click();
  const parent = page
    .getByRole("article")
    .filter({ hasText: "Workshop is ready." });
  await messageMenu(page, parent, isMobile);
  await page
    .getByRole("menuitem", { name: "Create thread", exact: true })
    .click();
  const thread = page.getByRole("region", {
    name: "Thread conversation",
    exact: true,
  });
  await expect(thread).toBeVisible();
  await thread.getByRole("button", { name: "Use emotes", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Common emotes", exact: true })
    .getByRole("button", { name: "Insert 👍", exact: true })
    .click();
  await expect(thread.getByLabel("Thread reply", { exact: true })).toHaveValue(
    /👍/,
  );
  await thread.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: "thread-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Synthetic thread notes"),
  });
  await expect(
    thread.getByRole("button", { name: /Remove.*thread-notes/ }),
  ).toBeVisible();
  await thread.getByRole("button", { name: "Send reply", exact: true }).click();
  const reply = thread
    .getByRole("article")
    .filter({ hasText: "thread-notes.txt" });
  await expect(reply).toBeVisible();
  await expect(reply).toContainText("Eli Cruz");
  await expect(reply).toContainText("👍");
  await expect(
    reply.getByRole("link", { name: "Download thread-notes.txt", exact: true }),
  ).toHaveAttribute("download", "thread-notes.txt");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    reply
      .getByRole("link", { name: "Download thread-notes.txt", exact: true })
      .click(),
  ]);
  expect(download.suggestedFilename()).toBe("thread-notes.txt");
  await expect(thread.getByLabel("Thread reply", { exact: true })).toHaveValue(
    "",
  );
  await thread.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: "file-only.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("File-only reply"),
  });
  await thread.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(
    thread.getByRole("article").filter({ hasText: "file-only.txt" }),
  ).toBeVisible();
  await thread
    .getByRole("button", { name: "Back to messages", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  const settings = page.getByRole("dialog");
  await settings
    .getByRole("tab", { name: "Files & Records", exact: true })
    .click();
  await settings
    .getByRole("switch", { name: "Allow file downloads", exact: true })
    .uncheck();
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await messageMenu(page, parent, isMobile);
  await page
    .getByRole("menuitem", { name: "Create thread", exact: true })
    .click();
  await expect(
    reply.getByRole("link", { name: "Download thread-notes.txt", exact: true }),
  ).toHaveCount(0);
  await expect(
    reply.getByText("Downloads disabled by channel policy.", { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([]);
});

test("pinned thread replies can be found and reopened from the channel pins", async ({
  page,
  isMobile,
}) => {
  await page.goto("/comms");
  await giveCurrentPersonElevatedRole(page);
  if (isMobile)
    await page.getByRole("button", { name: "operations", exact: true }).click();
  const parent = page
    .getByRole("article")
    .filter({ hasText: "Workshop is ready." });
  await messageMenu(page, parent, isMobile);
  await page
    .getByRole("menuitem", { name: "Create thread", exact: true })
    .click();
  const thread = page.getByRole("region", {
    name: "Thread conversation",
    exact: true,
  });
  await thread
    .getByLabel("Thread reply", { exact: true })
    .fill("Approved thread decision");
  await thread.getByRole("button", { name: "Send reply", exact: true }).click();
  const reply = thread
    .getByRole("article")
    .filter({ hasText: "Approved thread decision" });
  await messageMenu(page, reply, isMobile);
  await page
    .getByRole("menuitem", { name: "Pin message", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Back to messages", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Pinned messages", exact: true })
    .click();
  const pin = page
    .getByRole("dialog", { name: "Pinned messages", exact: true })
    .getByRole("button", { name: /Approved thread decision/ });
  await expect(pin).toBeVisible();
  await pin.click();
  await expect(reply).toBeFocused();
});

test("workspace rules control new direct messages independently of the selected channel", async ({
  page,
  isMobile,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "openslate.sample.v1",
      JSON.stringify({
        "comms-configuration": {
          version: 1,
          workspace: { settings: { dmRule: "none" }, permissions: {} },
          channels: {
            "sample-channel-operations": {
              settings: { dmRule: "everyone" },
              permissions: {},
            },
          },
        },
      }),
    ),
  );
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "Start direct message", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "Start direct message",
    exact: true,
  });
  await picker
    .getByRole("button", { name: "Message Drew Shaw", exact: true })
    .click();
  await expect(picker).toBeVisible();
  await expect(
    picker.getByText("New direct messages are disabled by workspace policy.", {
      exact: true,
    }),
  ).toBeVisible();
  await picker.press("Escape");
  await page.getByRole("button", { name: /^Morgan Kim/ }).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
  await page
    .getByLabel("Message", { exact: true })
    .fill("Existing conversations remain available");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page
      .getByRole("article")
      .filter({ hasText: "Existing conversations remain available" }),
  ).toBeVisible();
  if (isMobile)
    await page
      .getByRole("button", { name: "Conversations", exact: true })
      .click();
  await expect(
    page.getByRole("button", { name: "Drew Shaw", exact: true }),
  ).toHaveCount(0);
});

test("channel read actions expose unread state and opening the channel clears it", async ({
  page,
  isMobile,
}) => {
  await page.goto("/comms");
  const channel = page.getByRole("button", { name: "operations", exact: true });
  await channel.click();
  if (isMobile)
    await page
      .getByRole("button", { name: "Conversations", exact: true })
      .click();
  await page
    .getByRole("button", { name: "Channel actions: operations", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Mark unread", exact: true })
    .click();
  await expect(channel.getByLabel("Unread", { exact: true })).toBeVisible();
  await channel.click();
  if (isMobile)
    await page
      .getByRole("button", { name: "Conversations", exact: true })
      .click();
  await expect(channel.getByLabel("Unread", { exact: true })).toHaveCount(0);
});

test("archived threads preserve drafts and remain restorable from the inactive directory", async ({
  page,
  isMobile,
}) => {
  await page.goto("/comms");
  if (isMobile)
    await page.getByRole("button", { name: "operations", exact: true }).click();
  const parent = page
    .getByRole("article")
    .filter({ hasText: "Workshop is ready." });
  await messageMenu(page, parent, isMobile);
  await page
    .getByRole("menuitem", { name: "Create thread", exact: true })
    .click();
  const thread = page.getByRole("region", {
    name: "Thread conversation",
    exact: true,
  });
  await thread
    .getByLabel("Thread reply", { exact: true })
    .fill("Keep this unfinished reply");
  await thread
    .getByRole("button", { name: "Thread settings", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  const settings = page.getByRole("dialog", {
    name: "Thread settings",
    exact: true,
  });
  await settings
    .getByRole("checkbox", { name: "Archived", exact: true })
    .check();
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    thread.getByLabel("Thread reply", { exact: true }),
  ).toBeDisabled();
  await expect(thread.getByLabel("Thread reply", { exact: true })).toHaveValue(
    "Keep this unfinished reply",
  );
  await thread
    .getByRole("button", { name: "Back to messages", exact: true })
    .click();
  await page.getByRole("button", { name: "Threads", exact: true }).click();
  const directory = page.getByRole("dialog", { name: "Threads", exact: true });
  await directory
    .getByRole("button", { name: "Inactive", exact: true })
    .click();
  await directory.getByRole("button", { name: /Workshop is ready/ }).click();
  await thread
    .getByRole("button", { name: "Thread settings", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Thread settings", exact: true })
    .getByRole("checkbox", { name: "Archived", exact: true })
    .uncheck();
  await page
    .getByRole("dialog", { name: "Thread settings", exact: true })
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    thread.getByLabel("Thread reply", { exact: true }),
  ).toBeEnabled();
  await expect(thread.getByLabel("Thread reply", { exact: true })).toHaveValue(
    "Keep this unfinished reply",
  );
});

test("workspace thread-first mode keeps direct messages as ordinary messages", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "openslate.sample.v1",
      JSON.stringify({
        "comms-configuration": {
          version: 1,
          workspace: { settings: { mode: "thread-first" }, permissions: {} },
        },
      }),
    ),
  );
  await page.goto("/comms?conversation=sample-dm-alex");
  await page
    .getByLabel("Message", { exact: true })
    .fill("Direct inspection update");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("article").filter({ hasText: "Direct inspection update" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Thread conversation", exact: true }),
  ).toHaveCount(0);
  const threads = await page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem("openslate.sample.v1") ?? "{}")
        .commsThreads ?? [],
  );
  expect(
    threads.filter(
      (thread: { conversation: string }) =>
        thread.conversation === "sample-dm-alex",
    ),
  ).toEqual([]);
});

test("category order saves end and before positions", async ({ page }) => {
  await page.goto("/comms");
  const categoryButtons = page.getByRole("button", { name: /^Edit category / });
  await page
    .getByRole("button", { name: "Edit category Company", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Category order", { exact: true }).selectOption("");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(categoryButtons.first()).toHaveAccessibleName(
    "Edit category Projects",
  );
  await page
    .getByRole("button", { name: "Edit category Company", exact: true })
    .click();
  await dialog
    .getByLabel("Category order", { exact: true })
    .selectOption("projects");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(categoryButtons.first()).toHaveAccessibleName(
    "Edit category Company",
  );
});

test("full message timestamps include the calendar date", async ({
  page,
  isMobile,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "openslate.sample.v1",
      JSON.stringify({
        "comms-configuration": {
          version: 1,
          preferences: { "sample-eli": { timestamps: "full" } },
        },
      }),
    ),
  );
  await page.goto("/comms");
  if (isMobile)
    await page.getByRole("button", { name: "operations", exact: true }).click();
  const message = page.getByRole("article").filter({
    hasText: "Morning team. Let’s keep today’s inspections moving.",
  });
  await expect(message).toContainText("2026");
});
