import {
  expect,
  heldResponse,
  settleReact,
  signedOut,
  test,
} from "./helpers/test";

// Account setup and recovery are for signed-out people.
test.beforeEach(async ({ page }) => {
  await signedOut(page);
});

// A setup page without a usable invitation fragment, including an old
// temporary-password URL, cannot start account setup.
for (const entry of ["/auth/setup", "/auth/setup?temporary=1"] as const) {
  test(`setup at ${entry} without an invitation link explains how to recover`, async ({
    page,
  }) => {
    await page.goto(entry);
    await expect(page).toHaveURL(/\/auth\/setup$/);
    const alert = page
      .getByRole("alert")
      .filter({ hasText: "This invitation link is invalid or incomplete." });
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText(
      "This invitation link is invalid or incomplete. Request a new invitation.",
    );
    await expect(
      page.getByRole("link", { name: "Return to sign in" }),
    ).toHaveAttribute("href", "/login");
    await expect(page.getByLabel("Temporary password")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  });
}

test("invitation setup clears the fragment and waits for explicit submission", async ({
  page,
}) => {
  const requests: unknown[] = [];
  await page.route("**/api/auth/invitations/complete", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.goto("/auth/setup#token_hash=invite-proof&type=invite");
  await expect(page).toHaveURL(/\/auth\/setup$/);
  await expect(page.getByLabel("Password", { exact: true })).toBeEnabled();
  expect(requests).toHaveLength(0);

  await page
    .getByLabel("Password", { exact: true })
    .fill("a long invited password");
  await page.getByLabel("Confirm password").fill("a long invited password");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/login\?completed=password$/);
  await expect(
    page.getByRole("status").filter({ hasText: "Password set. Sign in." }),
  ).toBeVisible();
  expect(requests).toEqual([
    { token_hash: "invite-proof", password: "a long invited password" },
  ]);
});

test("a new invitation link clears an expired-link failure before retry", async ({
  page,
}) => {
  const submittedTokens: string[] = [];
  await page.route("**/api/auth/invitations/complete", async (route) => {
    const body = route.request().postDataJSON() as { token_hash: string };
    submittedTokens.push(body.token_hash);
    await route.fulfill({ status: body.token_hash === "expired" ? 401 : 204 });
  });
  await page.goto("/auth/setup#token_hash=expired&type=invite");
  await page
    .getByLabel("Password", { exact: true })
    .fill("first password choice");
  await page.getByLabel("Confirm password").fill("first password choice");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Your invitation session" }),
  ).toContainText("expired");
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();

  await page.goto("/auth/setup#token_hash=fresh&type=invite");
  await expect(page).toHaveURL(/\/auth\/setup$/);
  await expect(
    page.getByRole("alert").filter({ hasText: "Your invitation session" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await page
    .getByLabel("Password", { exact: true })
    .fill("fresh password choice");
  await page.getByLabel("Confirm password").fill("fresh password choice");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/login\?completed=password$/);
  expect(submittedTokens).toEqual(["expired", "fresh"]);
});

test("an old invitation response cannot replace a newer link", async ({
  page,
}) => {
  const oldResponse = heldResponse();
  const submittedTokens: string[] = [];
  await page.route("**/api/auth/invitations/complete", async (route) => {
    const body = route.request().postDataJSON() as { token_hash: string };
    submittedTokens.push(body.token_hash);
    if (body.token_hash === "old") {
      oldResponse.enter();
      await oldResponse.released;
    }
    await route.fulfill({ status: 204 });
  });
  try {
    await page.goto("/auth/setup#token_hash=old&type=invite");
    await page
      .getByLabel("Password", { exact: true })
      .fill("first password choice");
    await page.getByLabel("Confirm password").fill("first password choice");
    await page.getByRole("button", { name: "Continue" }).click();
    await oldResponse.entered;
    await page.goto("/auth/setup#token_hash=new&type=invite");
    await expect(page).toHaveURL(/\/auth\/setup$/);
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
    // Deliver the old response and let React commit whatever it schedules
    // before checking that the newer link still owns the page.
    const oldDelivered = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/auth/invitations/complete") &&
        (response.request().postDataJSON() as { token_hash: string })
          .token_hash === "old",
    );
    oldResponse.release();
    await oldDelivered;
    await settleReact(page, 3);
    await expect(page).toHaveURL(/\/auth\/setup$/);
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    await page
      .getByLabel("Password", { exact: true })
      .fill("second password choice");
    await page.getByLabel("Confirm password").fill("second password choice");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/login\?completed=password$/);
    expect(submittedTokens).toEqual(["old", "new"]);
  } finally {
    oldResponse.release();
  }
});

test("recovery requests email and confirms a fragment only on submission", async ({
  page,
}) => {
  const requests: unknown[] = [];
  await page.route("**/api/auth/recovery/request", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.goto("/auth/recovery");
  await page.getByLabel("Email", { exact: true }).fill("member@example.test");
  await page.getByRole("button", { name: "Request recovery" }).click();
  await expect(page.getByRole("status")).toContainText("recovery instructions");
  expect(requests).toEqual([{ email: "member@example.test" }]);

  const completions: unknown[] = [];
  await page.route("**/api/auth/recovery/complete", async (route) => {
    completions.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.goto("/auth/recovery#token_hash=recovery-proof&type=recovery");
  await expect(page).toHaveURL(/\/auth\/recovery$/);
  await expect(page.getByLabel("New password", { exact: true })).toBeEnabled();
  expect(completions).toHaveLength(0);
  await page
    .getByLabel("New password", { exact: true })
    .fill("a long recovery password");
  await page
    .getByLabel("Confirm new password")
    .fill("a long recovery password");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page).toHaveURL(/\/login\?completed=password$/);
  await expect(
    page.getByRole("status").filter({ hasText: "Password set. Sign in." }),
  ).toBeVisible();
  expect(completions).toEqual([
    { token_hash: "recovery-proof", password: "a long recovery password" },
  ]);
});
