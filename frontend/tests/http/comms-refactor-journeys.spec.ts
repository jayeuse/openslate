import { expect, test } from "./helpers/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: "00000000-0000-4000-8000-000000000101",
        setup_required: false,
      },
    }),
  );
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
  await page.getByRole("button", { name: "workshop", exact: true }).click();
  await expect(message).toHaveValue("");
  await message.fill("Workshop retained journey draft");
  await page.getByRole("button", { name: "operations", exact: true }).click();
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
  await sentMessage
    .getByRole("button", { name: "Message actions", exact: true })
    .click();
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
  await page.getByRole("button", { name: "workshop", exact: true }).click();
  await expect(message).toHaveValue("Workshop retained journey draft");
  await page.reload();
  await page.getByRole("button", { name: "workshop", exact: true }).click();
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
    await page.getByRole("button", { name: "OpenComms", exact: true }).click();
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
  await sent
    .getByRole("button", { name: "Message actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete message", exact: true })
    .click();
  await expect(sent).toHaveCount(0);
  const notice = page.getByText("Message deleted.", { exact: true });
  await expect(notice).toBeVisible();
  // Undo still restores the message after the person moves on.
  await page.getByRole("button", { name: "workshop", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "operations", exact: true }).click();
  await expect(sent).toHaveCount(1);
  // A used or dismissed notice clears, so the next delete reports again.
  for (const close of ["Undo", "Dismiss notification"]) {
    await sent
      .getByRole("button", { name: "Message actions", exact: true })
      .click();
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
  const row = page.getByRole("button", { name: "workshop", exact: true });
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
  await page.getByRole("button", { name: "OpenComms", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "My preferences", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "My preferences" });
  await settings
    .getByRole("button", { name: "Reset to default", exact: true })
    .click();
  const confirm = page.getByRole("alertdialog", {
    name: "Reset My preferences to default?",
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
