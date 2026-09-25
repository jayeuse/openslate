import { expect, test } from "@playwright/test";

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
