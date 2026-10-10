import { expect, test } from "./helpers/test";

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

test("an old temporary-password URL cannot start account setup", async ({
  page,
}) => {
  await page.goto("/auth/setup?temporary=1");
  await expect(page).toHaveURL(/\/auth\/setup$/);
  await expect(page.getByLabel("Temporary password")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "This invitation link is invalid or incomplete." }),
  ).toBeVisible();
});

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
  let releaseOldResponse = () => {};
  let signalOldRequest = () => {};
  const oldResponseReleased = new Promise<void>((resolve) => {
    releaseOldResponse = resolve;
  });
  const oldRequestStarted = new Promise<void>((resolve) => {
    signalOldRequest = resolve;
  });
  const submittedTokens: string[] = [];
  await page.route("**/api/auth/invitations/complete", async (route) => {
    const body = route.request().postDataJSON() as { token_hash: string };
    submittedTokens.push(body.token_hash);
    if (body.token_hash === "old") {
      signalOldRequest();
      await oldResponseReleased;
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
    await oldRequestStarted;
    await page.goto("/auth/setup#token_hash=new&type=invite");
    await expect(page).toHaveURL(/\/auth\/setup$/);
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
    releaseOldResponse();
    await page
      .getByLabel("Password", { exact: true })
      .fill("second password choice");
    await page.getByLabel("Confirm password").fill("second password choice");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/login\?completed=password$/);
    expect(submittedTokens).toEqual(["old", "new"]);
  } finally {
    releaseOldResponse();
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

test("login accepts email and does not send a username field", async ({
  page,
}) => {
  let authenticated = false;
  const requests: unknown[] = [];
  await page.route("**/api/auth/login", async (route) => {
    authenticated = true;
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: { authenticated: true, setup_required: false },
    });
  });
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      json: authenticated
        ? {
            authenticated: true,
            user_id: "2cb24e31-8b78-4ec2-b33a-807a14b1f9e8",
            setup_required: false,
          }
        : { authenticated: false },
    });
  });
  await page.route("**/api/auth/refresh", (route) =>
    route.fulfill({ status: 401, json: { detail: "Unauthenticated" } }),
  );
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      json: {
        id: "2cb24e31-8b78-4ec2-b33a-807a14b1f9e8",
        role: "member",
        access: [],
      },
    });
  });
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("member@example.test");
  await page.getByLabel("Password").fill("a long login password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/openview$/);
  expect(requests).toEqual([
    { email: "member@example.test", password: "a long login password" },
  ]);
});
