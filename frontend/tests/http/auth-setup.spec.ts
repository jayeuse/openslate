import { expect, test } from "@playwright/test";

test("setup without an invitation link explains how to recover", async ({
  page,
}) => {
  await page.goto("/auth/setup");

  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "This invitation link is invalid or incomplete." }),
  ).toHaveText(
    "This invitation link is invalid or incomplete. Request a new invitation.",
  );
  await expect(
    page.getByRole("link", { name: "Return to sign in" }),
  ).toHaveAttribute("href", "/login");
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
});

test("temporary-password setup remains available without an invitation token", async ({
  page,
}) => {
  await page.goto("/auth/setup?temporary=1");

  await expect(page.getByLabel("Temporary password")).toBeEnabled();
  await expect(page.getByLabel("Password", { exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "This invitation link is invalid or incomplete." }),
  ).toHaveCount(0);
});
