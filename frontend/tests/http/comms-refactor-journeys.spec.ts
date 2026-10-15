import { expect, signedInSession, test } from "./helpers/test";

test.beforeEach(async ({ page }) => {
  await signedInSession(page, "00000000-0000-4000-8000-000000000101");
});

test("Comms keeps separate conversation drafts and clears only a successfully sent message", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/comms");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(message).toBeVisible();
  await message.fill("Operations unsent journey draft");
  await page.getByRole("button", { name: /^workshop(,|$)/ }).click();
  await expect(message).toHaveValue("");
  await message.fill("Workshop retained journey draft");
  await page.getByRole("button", { name: /^operations(,|$)/ }).click();
  await expect(message).toHaveValue("Operations unsent journey draft");
  await page.getByLabel("Messages", { exact: true }).evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(message).toHaveValue("");
  await expect(
    page.getByText("Operations unsent journey draft", { exact: true }),
  ).toBeInViewport();
  expect(pageErrors).toEqual([]);
  const sentMessage = page
    .getByRole("article")
    .filter({ hasText: "Operations unsent journey draft" });
  await sentMessage.getByRole("button", { name: /^Message actions: / }).click();
  await page
    .getByRole("menuitem", { name: "Edit message", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Edit message", exact: true })
    .fill("Edited operations journey message");
  await page.getByRole("button", { name: "Save message", exact: true }).click();
  await expect(
    page.getByText("Edited operations journey message", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^workshop(,|$)/ }).click();
  await expect(message).toHaveValue("Workshop retained journey draft");
  await page.reload();
  await page.getByRole("button", { name: /^workshop(,|$)/ }).click();
  await expect(message).toHaveValue("Workshop retained journey draft");
});

test("Comms preferences keep an editing draft, discard cancelled changes, and persist accepted settings", async ({
  page,
}) => {
  await page.goto("/comms");
  const settings = page.getByRole("dialog", {
    name: "My preferences",
    exact: true,
  });
  const density = settings.getByRole("combobox", {
    name: "Message density",
    exact: true,
  });
  async function openPreferences() {
    await page
      .getByRole("button", { name: "OpenComms menu", exact: true })
      .first()
      .click();
    await page
      .getByRole("menuitem", { name: "My preferences", exact: true })
      .click();
    await settings
      .getByRole("tab", { name: "Appearance", exact: true })
      .click();
  }
  await openPreferences();
  await expect(density).toHaveValue("comfortable");
  await density.selectOption("compact");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  const discard = page.getByRole("alertdialog", {
    name: "Discard changes?",
    exact: true,
  });
  await discard
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(density).toHaveValue("compact");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await discard
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(settings).toBeHidden();
  await openPreferences();
  await expect(density).toHaveValue("comfortable");
  await density.selectOption("compact");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(settings).toBeHidden();
  await openPreferences();
  await expect(density).toHaveValue("compact");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(settings).toBeHidden();
});

test("a deleted message can be put back from the visible Undo notice", async ({
  page,
}) => {
  await page.goto("/comms");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Undo journey message");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const sent = page
    .getByRole("article")
    .filter({ hasText: "Undo journey message" });
  await sent.getByRole("button", { name: /^Message actions: / }).click();
  await page
    .getByRole("menuitem", { name: "Delete message", exact: true })
    .click();
  await expect(sent).toHaveCount(0);
  const notice = page.getByText("Message deleted.", { exact: true });
  await expect(notice).toBeVisible();
  // Undo still restores the message after the person moves on.
  await page.getByRole("button", { name: /^workshop(,|$)/ }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: /^operations(,|$)/ }).click();
  await expect(sent).toHaveCount(1);
  // A used or dismissed notice clears, so the next delete reports again.
  for (const close of ["Undo", "Dismiss notification"]) {
    await sent.getByRole("button", { name: /^Message actions: / }).click();
    await page
      .getByRole("menuitem", { name: "Delete message", exact: true })
      .click();
    await expect(notice).toBeVisible();
    await page.getByRole("button", { name: close, exact: true }).click();
    await expect(notice).toBeHidden();
    if (close === "Undo") await expect(sent).toHaveCount(1);
  }
});

test("archiving a channel asks first and can be undone", async ({ page }) => {
  await page.goto("/comms");
  const row = page.getByRole("button", { name: /^workshop(,|$)/ });
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Archive channel", exact: true })
    .click();
  const confirm = page.getByRole("alertdialog", {
    name: "Archive #workshop?",
  });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toBeHidden();
  await row.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Archive channel", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", { name: "Archive channel", exact: true })
    .click();
  await confirm
    .getByRole("button", { name: "Archive channel", exact: true })
    .click();
  await expect(
    page.getByText("#workshop archived.", { exact: true }),
  ).toBeVisible();
  await row.click();
  await expect(
    page.getByText("This channel is archived. Restore it to post."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
  // Undo reports what it did, not the archive again.
  await expect(
    page.getByText("#workshop restored.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toHaveCount(0);
});

test("blocking a person asks first; unblocking does not", async ({ page }) => {
  await page.goto("/comms");
  await page
    .getByRole("button", { name: /^Morgan Kim/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Block user", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: /^Block / });
  await expect(confirm).toBeVisible();
  await confirm
    .getByRole("button", { name: "Block user", exact: true })
    .click();
  await expect(confirm).toBeHidden();
  await page.getByRole("button", { name: "Unblock user", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Block user", exact: true }),
  ).toBeVisible();
});

test("Reset to default asks first and says nothing is saved yet", async ({
  page,
}) => {
  await page.goto("/comms");
  await page
    .getByRole("button", { name: "OpenComms menu", exact: true })
    .first()
    .click();
  await page
    .getByRole("menuitem", { name: "My preferences", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "My preferences" });
  await settings
    .getByRole("button", { name: "Reset to default", exact: true })
    .click();
  const confirm = page.getByRole("alertdialog", {
    name: "Reset your preferences to default?",
  });
  await expect(confirm).toContainText("Nothing is saved until you select");
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(settings).toBeVisible();
});

test("OpenComms loads its example conversations without showing an error", async ({
  page,
}) => {
  await page.goto("/comms");
  await expect(page.getByText("Team spaces", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-type="error"]')).toHaveCount(0);
});

test("the OpenComms menu keeps everyday items up front and admin tools behind one entry", async ({
  page,
}) => {
  await page.goto("/comms");
  // The page heading is plain text, and the menu is a separate button.
  await expect(
    page.getByRole("heading", { name: "OpenComms", level: 1 }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "OpenComms menu", exact: true })
    .first()
    .click();
  const menu = page.getByRole("menu", { name: "OpenComms menu" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "My preferences",
    "Browse threads",
    "Channel settings",
    "Category settings",
    "New channel",
    "New category",
    "Admin tools",
  ]);
  await menu.getByRole("menuitem", { name: "Admin tools" }).click();
  const tools = page.getByRole("menu", { name: "Admin tools" });
  await expect(tools.getByRole("menuitem")).toHaveText([
    "Moderation",
    "Scheduled messages",
    "Message retention",
    "Workspace settings",
    "Channel templates",
    "Automation",
    "Bulk channel changes",
    "Settings history",
  ]);
  await tools.getByRole("menuitem", { name: "Moderation" }).click();
  await expect(page.getByRole("dialog", { name: "Moderation" })).toBeVisible();
});

test("a channel has one settings dialog, reached the same way from its row and its header", async ({
  page,
}) => {
  await page.goto("/comms");
  const row = page.getByRole("button", { name: /^workshop(,|$)/ });
  await row.click({ button: "right" });
  const rowMenu = page.getByRole("menu", { name: "Channel actions: workshop" });
  await expect(
    rowMenu.getByRole("menuitem", { name: "Channel settings" }),
  ).toHaveCount(1);
  await expect(
    rowMenu.getByRole("menuitem", { name: /^Move to (?!another)/ }),
  ).toHaveCount(0);
  await rowMenu
    .getByRole("menuitem", { name: "Move to another category…" })
    .click();
  const settings = page.getByRole("dialog", { name: "Channel settings" });
  await expect(settings.getByLabel("Category")).toBeVisible();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await row.click();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await expect(
    settings.getByLabel("Channel name", { exact: true }),
  ).toHaveValue("workshop");
});

test("two quick deletes each get their own Undo", async ({ page }) => {
  await page.goto("/comms");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  for (const text of ["First quick delete", "Second quick delete"]) {
    await message.fill(text);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
  }
  const article = (text: string) =>
    page.getByRole("article").filter({ hasText: text });
  for (const text of ["First quick delete", "Second quick delete"]) {
    await article(text)
      .getByRole("button", { name: /^Message actions: / })
      .click();
    await page
      .getByRole("menuitem", { name: "Delete message", exact: true })
      .click();
    await expect(article(text)).toHaveCount(0);
  }
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toHaveCount(2);
  await undo.nth(0).click();
  // The used notice can linger while it closes; click the remaining Undo only.
  await expect(undo).toHaveCount(1);
  await undo.nth(0).click();
  await expect(article("First quick delete")).toHaveCount(1);
  await expect(article("Second quick delete")).toHaveCount(1);
});

test("categories carry their access group, and a channel says who can use it", async ({
  page,
}) => {
  await page.goto("/comms");
  await expect(
    page.getByRole("button", { name: /^Service delivery/ }),
  ).toContainText("Operations");
  await page.getByRole("button", { name: /^dispatch(,|$)/ }).click();
  await expect(
    page.getByRole("button", { name: /^Visible\ to\ Operations \./ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^finance\-desk(,|$)/ }).click();
  await expect(
    page.getByRole("button", {
      name: /^Visible\ to\ Finance\ and\ Commercial \./,
    }),
  ).toBeVisible();
});

test("a linked record opens beside the conversation and gives way to a thread", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  const followed = page.getByRole("list", { name: "Records you follow" });
  await followed.getByRole("button", { name: /Replace pump seal/ }).click();
  const panel = page.getByRole("complementary", { name: "Record" });
  await expect(
    panel.getByRole("heading", { name: "Replace pump seal" }),
  ).toBeVisible();
  await expect(panel).toContainText("Service requests");
  await expect(
    panel.getByRole("link", { name: "Open in OpenView" }),
  ).toHaveAttribute("href", /record=sample-sr-1004/);
  await expect(panel.getByRole("list", { name: "Mentioned in" })).toContainText(
    "#operations",
  );
  // A thread takes the same place.
  await page.getByRole("button", { name: /^Thread: Riverside asked/ }).click();
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "Thread panel" }),
  ).toBeVisible();
  // The record card in the timeline opens the record again.
  await page
    .getByRole("button", { name: /^Open record: .*Replace pump seal/ })
    .first()
    .click();
  await expect(panel).toBeVisible();
});

test("handoffs appear between messages and are not messages", async ({
  page,
}) => {
  await page.goto("/comms");
  const handoff = page.getByRole("note", {
    name: "Handoff from Customer service to Operations",
  });
  await expect(handoff).toBeVisible();
  await expect(handoff).toContainText("SR-1004");
  await expect(
    page.getByRole("article").filter({ hasText: "SR-1004" }),
  ).toHaveCount(0);
});

test("group access in channel settings changes who the channel says it is for", async ({
  page,
}) => {
  await page.goto("/comms");
  await page.getByRole("button", { name: /^dispatch(,|$)/ }).click();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "Channel settings" });
  const access = settings.getByRole("group", { name: "Who can use #dispatch" });
  await expect(access).toContainText("not enforced yet");
  const commercial = access.getByRole("radiogroup", { name: "Commercial" });
  await commercial.getByText("Read", { exact: true }).click();
  await expect(
    commercial.getByRole("radio", { name: "Read", exact: true }),
  ).toBeChecked();
  await expect(access).toContainText("can read");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: /^Visible\ to\ Operations\ and\ Commercial \./,
    }),
  ).toBeVisible();
});

test("lowering Everyone keeps what each group can already do", async ({
  page,
}) => {
  await page.goto("/comms");
  await page.getByRole("button", { name: /^operations(,|$)/ }).click();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  const access = page
    .getByRole("dialog", { name: "Channel settings" })
    .getByRole("group", { name: "Who can use #operations" });
  const everyone = access.getByRole("radiogroup", { name: "Everyone" });
  await everyone.getByText("Read", { exact: true }).click();
  await expect(
    access
      .getByRole("radiogroup", { name: "Operations" })
      .getByRole("radio", { name: "Read and post" }),
  ).toBeChecked();
  await expect(access).toContainText(
    "can post here, and everyone else can read.",
  );
});

test("on a phone, a record's mention closes the record and shows the message", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/comms");
  await page.getByRole("button", { name: /^operations(,|$)/ }).click();
  await page
    .getByRole("button", { name: /^Open record: .*Replace pump seal/ })
    .first()
    .click();
  const record = page.getByRole("dialog", { name: "Record" });
  await expect(record).toBeVisible();
  await record
    .getByRole("list", { name: "Mentioned in" })
    .getByRole("button", { name: /#operations · Sofia Garcia/ })
    .click();
  await expect(record).toHaveCount(0);
  await expect(
    page.getByText(
      "Riverside asked for a clear next update time. Can we confirm one before I call back?",
      { exact: true },
    ),
  ).toBeInViewport();
});

test("OpenComms opens at the latest message, with few and meaningful unread marks", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  const list = page.getByLabel("Messages", { exact: true });
  await expect
    .poll(() =>
      list.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(40);
  const conversations = page.getByRole("complementary", {
    name: "Conversations",
  });
  // The open channel counts as read; only a few examples start unread.
  await expect
    .poll(() => conversations.getByLabel("Unread", { exact: true }).count())
    .toBeLessThanOrEqual(8);
  await expect(
    page
      .getByRole("button", { name: /^operations(,|$)/ })
      .getByLabel("Unread", { exact: true }),
  ).toHaveCount(0);
});

test("each message's actions are named for it and fit its author", async ({
  page,
}) => {
  await page.goto("/comms");
  const buttons = page.getByRole("button", { name: /^Message actions: / });
  const names = await buttons.evaluateAll((items) =>
    items.slice(0, 3).map((item) => item.getAttribute("aria-label")),
  );
  expect(new Set(names).size).toBe(names.length);
  // Someone else's message can be reported, not scheduled.
  await page
    .getByRole("article")
    .filter({ hasText: "Two vans are loaded." })
    .getByRole("button", { name: /^Message actions: / })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Report message" }),
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Schedule/ })).toHaveCount(0);
});

test("groups decide a category, a channel's members, and the Permissions summary", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  await page.getByRole("button", { name: /^dispatch(,|$)/ }).click();
  await expect(
    page.getByRole("complementary", { name: "Channel members" }),
  ).toContainText("Members 14");
  // A category's group is chosen in its settings.
  await page
    .getByRole("button", { name: "Category settings: Service delivery" })
    .click();
  const category = page.getByRole("dialog", { name: "Category settings" });
  await category.getByLabel("Access group").selectOption("Finance");
  await category
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /^Service delivery/ }),
  ).toContainText("Finance group");
  // Permissions start from groups; exceptions are folded away.
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "Channel settings" });
  await settings.getByRole("tab", { name: "Permissions" }).click();
  await expect(
    settings.getByRole("list", { name: "Access by group" }),
  ).toContainText("Finance");
  await expect(
    settings.getByText("Permissions for", { exact: true }),
  ).toBeHidden();
});

test("on a phone, opening a channel from the list shows no error", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/comms");
  await expect(page.getByText("Team spaces", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^dispatch(,|$)/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-type="error"]')).toHaveCount(0);
});

test("a channel row names its state, and leaving a channel marks it read", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/comms");
  await expect(
    page.getByRole("button", { name: "workshop, unread", exact: true }),
  ).toBeVisible();
  // Switching right after load saves once, without a conflict.
  await page.getByRole("button", { name: /^workshop(,|$)/ }).click();
  await page.getByRole("button", { name: /^dispatch(,|$)/ }).click();
  await expect(page.locator('[data-type="error"]')).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "workshop", exact: true }),
  ).toBeVisible();
});
