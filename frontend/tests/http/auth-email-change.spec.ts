import { expect, test, type Page } from "./helpers/test";
import {
  installProfileApi,
  profileGate,
  profileUserA,
  profileUserB,
} from "./helpers/profile-api";
import { concealMfaTestCredentials, mockMfa } from "./helpers/mfa";
import {
  changedEmail,
  currentEmailProof,
  emailChangeLanding,
  expectNoEmailSecrets,
  fullEmailConfirmation,
  installEmailChangeApi,
  newEmailProof,
  observeEmailSecretExposure,
} from "./helpers/email-change";

// Prepared browser specifications, not an executed red/green claim.
// Cryptography, provider consumption and transaction guarantees are native tests.
test.use({ trace: "off", screenshot: "off", video: "off" });
test.beforeEach(async ({ page }) => {
  await observeEmailSecretExposure(page);
});

async function openEmailRequest(page: Page) {
  await page.goto("/profile#security");
  await page.getByRole("button", { name: "Change email", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Change email",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("New email", { exact: true }).fill(changedEmail);
  await dialog
    .getByLabel("Current password", { exact: true })
    .fill("owned current password");
  return dialog;
}

const confirm = (page: Page) =>
  page.getByRole("button", { name: "Confirm email change", exact: true });
const partial = (page: Page) =>
  page.getByRole("status").filter({ hasText: /other.*email|both.*address/i });
const landingAlert = (page: Page) => page.getByRole("main").getByRole("alert");

test("S24 email request refuses a wrong password without refresh, replay or changed identity", async ({
  page,
}) => {
  await installProfileApi(page);
  const api = await installEmailChangeApi(page);
  api.requestStatus = 401;
  api.requestBody = { detail: "Invalid authentication credentials" };
  const dialog = await openEmailRequest(page);
  await dialog
    .getByRole("button", { name: "Send confirmation emails", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    /password|not.*accepted/i,
  );
  await expect(page).toHaveURL(/\/profile#security$/);
  await expect(dialog.getByLabel("New email", { exact: true })).toHaveValue(
    changedEmail,
  );
  expect(api.requests).toHaveLength(1);
  expect(api.refreshes).toBe(0);
  await expect(
    page.getByText("person@example.test", { exact: true }).first(),
  ).toBeVisible();
});

test("S24 unknown email request outcome stays truthful and never automatically resends", async ({
  page,
}) => {
  await installProfileApi(page);
  const api = await installEmailChangeApi(page);
  api.requestUnknown = true;
  const dialog = await openEmailRequest(page);
  await dialog
    .getByRole("button", { name: "Send confirmation emails", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    /outcome|could not.*confirm|may.*(?:sent|completed)/i,
  );
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(
    page.getByText("person@example.test", { exact: true }).first(),
  ).toBeVisible();
  expect(api.requests).toHaveLength(1);
  expect(api.refreshes).toBe(0);
  await expect(
    page.getByText(/email (?:has been )?changed|emails delivered/i),
  ).toHaveCount(0);
  await expectNoEmailSecrets(page);
});

test("S24 an old account's delayed request cannot publish success into another Profile", async ({
  page,
}) => {
  const profile = await installProfileApi(page);
  const api = await installEmailChangeApi(page);
  const hold = profileGate();
  api.holdRequest = hold;
  const dialog = await openEmailRequest(page);
  try {
    await dialog
      .getByRole("button", { name: "Send confirmation emails", exact: true })
      .click();
    await hold.begun;
    profile.userId = profileUserB;
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "Second person",
    );
    hold.release();
    await expect.poll(() => api.requestResponses).toBe(1);
    await expect(
      page.getByText("second@example.test", { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: /confirmation.*(?:sent|requested)/i }),
    ).toHaveCount(0);
    expect(api.requests).toHaveLength(1);
  } finally {
    hold.release();
  }
});

test("S24 same-account reverification discards a delayed request without leaving the form stuck", async ({
  page,
}) => {
  const profile = await installProfileApi(page);
  const api = await installEmailChangeApi(page);
  const hold = profileGate();
  api.holdRequest = hold;
  const dialog = await openEmailRequest(page);
  try {
    await dialog
      .getByRole("button", { name: "Send confirmation emails", exact: true })
      .click();
    await hold.begun;
    const reads = profile.selfReads.length;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => profile.selfReads.length).toBeGreaterThan(reads);
    await expect(dialog).toBeVisible();
    hold.release();
    await expect.poll(() => api.requestResponses).toBe(1);
    await expect(
      page.getByRole("status").filter({ hasText: /confirmation requested/i }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toBeEnabled();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByRole("button", { name: "Change email", exact: true })
      .click();
    await expect(
      dialog.getByLabel("Current password", { exact: true }),
    ).toHaveValue("");
    expect(api.requests).toHaveLength(1);
  } finally {
    hold.release();
  }
});

for (const first of ["current", "new"] as const) {
  test(`S24 ${first}-address first acknowledgment has no identity/cookie claim; the other link enters protected admission`, async ({
    page,
    context,
  }) => {
    const profile = await installProfileApi(page);
    const api = await installEmailChangeApi(page, { signedOut: true });
    const [firstProof, finalProof] =
      first === "current"
        ? [currentEmailProof, newEmailProof]
        : [newEmailProof, currentEmailProof];
    await page.goto(
      `${emailChangeLanding}#token_hash=${firstProof}&type=email_change`,
    );
    await expect(page).toHaveURL(new RegExp(`${emailChangeLanding}$`));
    await expect(confirm(page)).toBeEnabled();
    expect(api.completions).toEqual([]);
    expect(api.refreshes).toBe(0);
    await expectNoEmailSecrets(page);
    await confirm(page).focus();
    await page.keyboard.press("Enter");
    await expect(partial(page)).toBeVisible();
    expect(
      api.completions.map(({ method, body }) => ({ method, body })),
    ).toEqual([{ method: "POST", body: { token_hash: firstProof } }]);
    expect(
      (await context.cookies()).filter(({ name }) =>
        /^openslate_(access|refresh)$/.test(name),
      ),
    ).toEqual([]);
    await expect(page).toHaveURL(new RegExp(`${emailChangeLanding}$`));
    await expect(
      page.getByText(
        /email (?:has been )?changed\.|you(?:'re| are) signed in/i,
      ),
    ).toHaveCount(0);
    await expectNoEmailSecrets(page);

    api.completeBody = fullEmailConfirmation;
    api.admit = true;
    api.onAdmission = () => {
      profile.people.get(profileUserA)!.email = changedEmail;
    };
    await page.goto(
      `${emailChangeLanding}#token_hash=${finalProof}&type=email_change`,
    );
    await expect(confirm(page)).toBeEnabled();
    expect(api.completions).toHaveLength(1);
    await confirm(page).click();
    await expect(page).toHaveURL(/\/profile(?:#security)?$/);
    await expect(page.getByText(changedEmail, { exact: true })).toBeVisible();
    expect(api.completions.at(-1)?.body).toEqual({ token_hash: finalProof });
    expect(api.refreshes).toBe(0);
    await expectNoEmailSecrets(page);
  });
}

for (const credential of ["access", "refresh"] as const) {
  test(`S24 ${credential} cookie cannot silently replace accounts; confirmation resumes only after explicit logout`, async ({
    page,
    context,
    baseURL,
  }) => {
    if (!baseURL) throw new Error("The HTTP project requires baseURL");
    await installProfileApi(page);
    const api = await installEmailChangeApi(page, { signedOut: true });
    api.authenticated = credential === "access";
    api.completeStatus = 409;
    api.completeBody = {
      detail: {
        code: "signed_out_required",
        message: "Sign out explicitly before confirming this email change.",
      },
    };
    await context.addCookies([
      {
        name: `openslate_${credential}`,
        value: "owned-existing-session",
        url: baseURL,
        httpOnly: true,
      },
      { name: "openslate_csrf", value: "owned-csrf", url: baseURL },
    ]);
    await page.goto(
      `${emailChangeLanding}#token_hash=${currentEmailProof}&type=email_change`,
    );
    if (credential === "refresh") {
      await expect(confirm(page)).toBeEnabled();
      await confirm(page).click();
    }
    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
    expect(api.logouts).toBe(0);
    expect(api.completions).toHaveLength(credential === "refresh" ? 1 : 0);
    expect(api.refreshes).toBe(0);
    await expect(partial(page)).toHaveCount(0);
    await expectNoEmailSecrets(page);
    api.completeStatus = 200;
    api.completeBody = { authenticated: false, confirmation_required: true };
    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(confirm(page)).toBeEnabled();
    expect(api.logouts).toBe(1);
    expect(api.completions).toHaveLength(credential === "refresh" ? 1 : 0);
    await confirm(page).click();
    await expect(partial(page)).toBeVisible();
    expect(api.completions.at(-1)?.headers.cookie ?? "").not.toMatch(
      /openslate_(access|refresh)=/,
    );
    expect(api.completions.at(-1)?.body).toEqual({
      token_hash: currentEmailProof,
    });
  });
}

test("S24 final confirmation enters the incumbent MFA continuation before private Profile", async ({
  page,
}) => {
  const profile = await installProfileApi(page, { session: false, mfa: false });
  const api = await installEmailChangeApi(page, { signedOut: true });
  const mfa = await mockMfa(page, { verified: true });
  mfa.authenticated = false;
  // Restore the incumbent private-self fixture after MFA's compact read.
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: profile.people.get(profileUserA)! }),
  );
  api.completeBody = fullEmailConfirmation;
  api.admit = true;
  api.onAdmission = () => {
    mfa.authenticated = true;
    profile.people.get(profileUserA)!.email = changedEmail;
  };
  try {
    await page.goto(
      `${emailChangeLanding}#token_hash=${newEmailProof}&type=email_change`,
    );
    await expect(confirm(page)).toBeEnabled();
    await confirm(page).click();
    await expect(
      page.getByRole("heading", {
        name: "Verify your authenticator",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Your profile", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(changedEmail, { exact: true })).toHaveCount(0);
    await page.getByLabel("Verification code", { exact: true }).fill("123456");
    await page
      .getByRole("button", { name: "Verify code", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Your profile", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(changedEmail, { exact: true })).toBeVisible();
    expect(api.completions).toHaveLength(1);
    await expectNoEmailSecrets(page);
  } finally {
    await concealMfaTestCredentials(page);
  }
});

test("S24 provider-confirmed local conflict is application-incomplete, not rollback or authentication", async ({
  page,
  context,
}) => {
  const api = await installEmailChangeApi(page, { signedOut: true });
  api.completeStatus = 409;
  api.completeBody = {
    detail: {
      code: "email_change_incomplete",
      message:
        "Email confirmation may have completed at the provider, but application completion is incomplete. Sign in again after any address conflict is resolved.",
    },
  };
  await page.goto(
    `${emailChangeLanding}#token_hash=${newEmailProof}&type=email_change`,
  );
  await confirm(page).click();
  await expect(landingAlert(page)).toContainText(
    /provider|confirmation.*completed/i,
  );
  await expect(landingAlert(page)).toContainText(/conflict|incomplete/i);
  await expect(page.getByRole("link", { name: /sign in/i })).toHaveAttribute(
    "href",
    "/login",
  );
  await expect(page).toHaveURL(new RegExp(`${emailChangeLanding}$`));
  expect(
    (await context.cookies()).filter(({ name }) =>
      /^openslate_(access|refresh)$/.test(name),
    ),
  ).toEqual([]);
  expect(api.completions).toHaveLength(1);
  await expect(
    page.getByText(
      /rolled back|email (?:has been )?changed\.|you(?:'re| are) signed in/i,
    ),
  ).toHaveCount(0);
  await expectNoEmailSecrets(page);
});

for (const [outcome, status] of [
  ["expired", 400],
  ["unauthorized", 401],
  ["unavailable", 503],
] as const) {
  test(`S24 ${outcome} confirmation is not refreshed or automatically replayed and never renders private proof`, async ({
    page,
  }) => {
    const api = await installEmailChangeApi(page, { signedOut: true });
    api.completeStatus = status;
    api.completeBody = { detail: `Private provider detail ${newEmailProof}` };
    await page.goto(
      `${emailChangeLanding}#token_hash=${newEmailProof}&type=email_change`,
    );
    await expect(confirm(page)).toBeEnabled();
    await confirm(page).click();
    await expect(landingAlert(page)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${emailChangeLanding}$`));
    expect(api.completions).toHaveLength(1);
    expect(api.refreshes).toBe(0);
    await expectNoEmailSecrets(page);
  });
}

test("S24 replay of an acknowledged first link cannot count as the other address", async ({
  page,
}) => {
  const api = await installEmailChangeApi(page, { signedOut: true });
  const url = `${emailChangeLanding}#token_hash=${currentEmailProof}&type=email_change`;
  await page.goto(url);
  await confirm(page).click();
  await expect(partial(page)).toBeVisible();
  api.completeStatus = 400;
  api.completeBody = { detail: "Email confirmation is invalid" };
  await page.goto(url);
  await confirm(page).click();
  await expect(landingAlert(page)).toBeVisible();
  await expect(partial(page)).toHaveCount(0);
  expect(api.completions).toHaveLength(2);
  await expect(page).toHaveURL(new RegExp(`${emailChangeLanding}$`));
  await expectNoEmailSecrets(page);
});

for (const [kind, suffix] of [
  ["missing", ""],
  ["wrong-purpose", `#token_hash=${currentEmailProof}&type=recovery`],
  [
    "duplicate",
    `#token_hash=${currentEmailProof}&token_hash=${newEmailProof}&type=email_change`,
  ],
  ["malformed", "#token_hash=not-a-provider-hash&type=email_change"],
] as const) {
  test(`S24 ${kind} email link is scrubbed and cannot issue a confirmation request`, async ({
    page,
  }) => {
    const api = await installEmailChangeApi(page, { signedOut: true });
    await page.goto(`${emailChangeLanding}${suffix}`);
    await expect(page).toHaveURL(new RegExp(`${emailChangeLanding}$`));
    await expect(landingAlert(page)).toBeVisible();
    await expect(confirm(page)).toBeDisabled();
    expect(api.completions).toEqual([]);
    expect(api.refreshes).toBe(0);
    await expectNoEmailSecrets(page);
  });
}

test("S24 a scrubbed link survives in memory only, not a page reload", async ({
  page,
}) => {
  const api = await installEmailChangeApi(page, { signedOut: true });
  await page.goto(
    `${emailChangeLanding}#token_hash=${currentEmailProof}&type=email_change`,
  );
  await expect(page).toHaveURL(new RegExp(`${emailChangeLanding}$`));
  await expect(confirm(page)).toBeEnabled();
  expect(api.completions).toEqual([]);
  await expectNoEmailSecrets(page);
  await page.reload();
  await expect(landingAlert(page)).toBeVisible();
  await expect(confirm(page)).toBeDisabled();
  expect(api.completions).toEqual([]);
  await expectNoEmailSecrets(page);
});

for (const [kind, body] of [
  [
    "non-Boolean",
    {
      authenticated: "false",
      confirmation_required: false,
      setup_required: false,
    },
  ],
  [
    "contradictory",
    { authenticated: true, confirmation_required: true, setup_required: false },
  ],
] as const) {
  test(`S24 a ${kind} partial/full response cannot publish confirmation success`, async ({
    page,
  }) => {
    const api = await installEmailChangeApi(page, { signedOut: true });
    api.completeBody = body;
    await page.goto(
      `${emailChangeLanding}#token_hash=${newEmailProof}&type=email_change`,
    );
    await confirm(page).click();
    await expect(landingAlert(page)).toBeVisible();
    await expect(partial(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${emailChangeLanding}$`));
    expect(api.completions).toHaveLength(1);
    await expectNoEmailSecrets(page);
  });
}

test("S24 a source replaced during confirmation discards the delayed result and waits for the new explicit action", async ({
  page,
}) => {
  const api = await installEmailChangeApi(page, { signedOut: true });
  const hold = profileGate();
  api.holdComplete = hold;
  try {
    await page.goto(
      `${emailChangeLanding}#token_hash=${currentEmailProof}&type=email_change`,
    );
    await confirm(page).click();
    await hold.begun;
    await expect(confirm(page)).toBeDisabled();
    await page.evaluate((proof) => {
      window.location.hash = `token_hash=${proof}&type=email_change`;
    }, newEmailProof);
    await expect(page).toHaveURL(new RegExp(`${emailChangeLanding}$`));
    hold.release();
    await expect.poll(() => api.completeResponses).toBe(1);
    await expect(partial(page)).toHaveCount(0);
    await expect(confirm(page)).toBeEnabled();
    expect(api.completions).toHaveLength(1);
    await confirm(page).click();
    await expect(partial(page)).toBeVisible();
    expect(api.completions.at(-1)?.body).toEqual({ token_hash: newEmailProof });
    await expectNoEmailSecrets(page);
  } finally {
    hold.release();
  }
});

test("S24 email surfaces eight-image acceptance round", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.CAPTURE_S24_EMAIL !== "1",
    "Opt-in rendered email acceptance record",
  );
  const profile = await installProfileApi(page);
  const api = await installEmailChangeApi(page, { signedOut: true });
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    for (const theme of ["light", "dark"] as const) {
      profile.theme = theme;
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      api.authenticated = true;
      const dialog = await openEmailRequest(page);
      await expect(page.locator("html")).toHaveClass(
        theme === "dark" ? /dark/ : /^(?!.*\bdark\b).*$/,
      );
      await expect(
        dialog.getByRole("button", {
          name: "Send confirmation emails",
          exact: true,
        }),
      ).toBeEnabled();
      await page.addStyleTag({
        content: "nextjs-portal { display: none !important; }",
      });
      const profileImage = `s24-email-form-${viewport.width}-${theme}.png`;
      await page.screenshot({
        path: testInfo.outputPath(profileImage),
        mask: [dialog.getByLabel("Current password", { exact: true })],
      });
      await testInfo.attach(profileImage, {
        path: testInfo.outputPath(profileImage),
        contentType: "image/png",
      });
      api.authenticated = false;
      await page.goto(
        `${emailChangeLanding}#token_hash=${currentEmailProof}&type=email_change`,
      );
      await expect(confirm(page)).toBeEnabled();
      await expectNoEmailSecrets(page);
      // Public auth pages have no account theme provider. Set the fixture's
      // root theme directly to inspect the same established semantic tokens.
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
      await page.addStyleTag({
        content: "nextjs-portal { display: none !important; }",
      });
      const landingImage = `s24-email-confirmation-${viewport.width}-${theme}.png`;
      await page.screenshot({
        path: testInfo.outputPath(landingImage),
        fullPage: true,
      });
      await testInfo.attach(landingImage, {
        path: testInfo.outputPath(landingImage),
        contentType: "image/png",
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
  expect(api.requests).toEqual([]);
  expect(api.completions).toEqual([]);
});
