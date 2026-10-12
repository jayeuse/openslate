import { expect, recheckSession, test, type Page } from "./helpers/test";
import { ids, mockAccessApi } from "./helpers/access-api";
import { deferredMfaResponse } from "./helpers/mfa";

const operationId = "00000000-0000-4000-8000-000000000911";
const status = (userId = ids.ben) => ({
  user_id: userId,
  verified_factor_count: 1,
  target_eligible: true,
  smtp_configured: true,
});
const recovery = (userId = ids.ben, revoke = false) => ({
  operation_id: operationId,
  user_id: userId,
  email_request: "accepted",
  local_revocation: revoke ? "committed" : "not_requested",
  revoked_sessions: revoke ? 2 : null,
});
async function setup(page: Page) {
  const api = await mockAccessApi(page);
  // A self recovery that signs out everywhere ends the signed-in session, so
  // /login keeps its form instead of sending a live session to its start page.
  let signedOut = false;
  api.on("GET", "/api/auth/session", (route) =>
    signedOut
      ? route.fulfill({ json: { authenticated: false } })
      : Promise.resolve("next" as const),
  );
  for (const userId of [ids.ben, ids.rosa, ids.ana]) {
    api.on("GET", `/api/users/${userId}/security`, (route) =>
      route.fulfill({ json: status(userId) }),
    );
    api.on("POST", `/api/users/${userId}/recovery`, (route, call) => {
      const revoke = Boolean(
        (call.body as { revoke_sessions?: boolean }).revoke_sessions,
      );
      if (revoke && userId === ids.rosa) signedOut = true;
      return route.fulfill({ json: recovery(userId, revoke) });
    });
    api.on("POST", `/api/users/${userId}/mfa/reset`, (route) =>
      route.fulfill({
        json: {
          operation_id: operationId,
          user_id: userId,
          factors_cleared: true,
          local_revocation: "committed",
          revoked_sessions: 2,
        },
      }),
    );
  }
  api.on("GET", "/api/auth/mfa", (route) =>
    route.fulfill({
      json: {
        user_id: ids.rosa,
        assurance_level: "aal2",
        required: false,
        policy_required: false,
        required_since: null,
        enrollment_deadline: null,
        factors: [],
      },
    }),
  );
  return api;
}
async function open(page: Page, userId = ids.ben, name = "Ben Cruz") {
  await page.goto(`/access?view=people&user=${userId}`);
  const sheet = page.getByRole("dialog", { name, exact: true });
  await expect(sheet.getByLabel("Job title")).toBeVisible();
  await sheet.getByRole("tab", { name: "Security", exact: true }).click();
  await expect(
    sheet.getByRole("heading", { name: "Sign-in security" }),
  ).toBeVisible();
  return sheet;
}
async function confirmRecovery(page: Page, revoke = false) {
  await page
    .getByRole("button", {
      name: revoke ? "Send recovery and sign out" : "Send recovery email",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("alertdialog", {
    name: revoke
      ? "Send recovery and sign out everywhere?"
      : "Send recovery email?",
    exact: true,
  });
  await dialog
    .getByRole("button", {
      name: revoke ? "Send and sign out" : "Send email",
      exact: true,
    })
    .click();
}

test("person security is lazy, current and recovery acceptance never claims delivery", async ({
  page,
}) => {
  const api = await setup(page);
  await page.goto(`/access?view=people&user=${ids.ben}`);
  const sheet = page.getByRole("dialog", { name: "Ben Cruz", exact: true });
  await expect(sheet.getByLabel("Job title")).toBeVisible();
  expect(api.sent("GET", `/api/users/${ids.ben}/security`)).toHaveLength(0);
  await sheet.getByRole("tab", { name: "Security", exact: true }).click();
  await expect(
    sheet.getByText("Two-step verification is set up", { exact: true }),
  ).toBeVisible();
  await sheet
    .getByRole("button", { name: "Send recovery email", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog", {
    name: "Send recovery email?",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(api.sent("POST", `/api/users/${ids.ben}/recovery`)).toHaveLength(0);
  await confirmRecovery(page);
  await expect(
    sheet.getByRole("status").filter({
      hasText: /Recovery email sent|Two-step verification reset/,
    }),
  ).toContainText("Recovery email sent to ");
  expect(api.sent("POST", `/api/users/${ids.ben}/recovery`)).toHaveLength(1);
  expect(api.sent("POST", `/api/users/${ids.ben}/recovery`)[0].body).toEqual({
    revoke_sessions: false,
  });
});

test("unavailable and malformed status stay unavailable until a fresh Retry", async ({
  page,
}) => {
  const api = await setup(page);
  let valid = false;
  api.on("GET", `/api/users/${ids.ben}/security`, (route) =>
    route.fulfill({
      status: valid ? 200 : 503,
      json: valid
        ? status()
        : { detail: { message: "Private provider routing detail" } },
    }),
  );
  const sheet = await open(page);
  await expect(sheet.getByRole("alert")).toContainText(
    "Security could not be loaded.",
  );
  await expect(
    sheet.getByText("Two-step verification not set up", { exact: true }),
  ).toHaveCount(0);
  await expect(sheet).not.toContainText("Private provider routing detail");
  valid = true;
  await sheet
    .getByRole("button", { name: "Retry security", exact: true })
    .click();
  await expect(
    sheet.getByText("Two-step verification is set up", { exact: true }),
  ).toBeVisible();
});

for (const refusal of ["smtp", "ineligible", "aal1", "foreign"]) {
  test(`current ${refusal} status gates the affected security actions`, async ({
    page,
  }) => {
    const api = await setup(page);
    if (refusal === "aal1")
      api.on("GET", "/api/auth/mfa", (route) =>
        route.fulfill({
          json: {
            user_id: ids.rosa,
            assurance_level: "aal1",
            required: false,
            policy_required: false,
            required_since: null,
            enrollment_deadline: null,
            factors: [],
          },
        }),
      );
    else
      api.on("GET", `/api/users/${ids.ben}/security`, (route) =>
        route.fulfill({
          json: {
            ...status(),
            smtp_configured: refusal !== "smtp",
            target_eligible: refusal !== "ineligible",
            user_id: refusal === "foreign" ? ids.ana : ids.ben,
          },
        }),
      );
    const sheet = await open(page);
    if (refusal === "foreign") {
      await expect(sheet.getByRole("alert")).toContainText(
        "Security could not be loaded.",
      );
      await expect(
        sheet.getByRole("button", { name: "Send recovery email", exact: true }),
      ).toHaveCount(0);
    } else {
      await expect(
        sheet.getByRole("button", {
          name:
            refusal === "aal1"
              ? "Reset two-step verification"
              : "Send recovery email",
          exact: true,
        }),
      ).toBeDisabled();
      await expect(sheet).toContainText(
        refusal === "smtp"
          ? "Recovery email is not turned on"
          : refusal === "aal1"
            ? "Complete your own two-step verification"
            : "This person is not eligible",
      );
    }
    expect(api.sent("POST", `/api/users/${ids.ben}/recovery`)).toHaveLength(0);
  });
}

test("reset uses its own confirmation and strict empty command", async ({
  page,
}) => {
  const api = await setup(page);
  const sheet = await open(page);
  await sheet
    .getByRole("button", {
      name: "Reset two-step verification",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("alertdialog", {
    name: "Reset two-step verification?",
    exact: true,
  });
  await expect(dialog).toContainText(
    "This removes their authenticator app and signs them out everywhere.",
  );
  await dialog
    .getByRole("button", { name: "Reset two-step verification", exact: true })
    .click();
  await expect(
    sheet.getByRole("status").filter({
      hasText: /Recovery email sent|Two-step verification reset/,
    }),
  ).toContainText(
    "Two-step verification reset. They are signed out everywhere.",
  );
  expect(api.sent("POST", `/api/users/${ids.ben}/mfa/reset`)[0].body).toEqual(
    {},
  );
});

test("pending security blocks close, tab and route while preserving an existing person draft", async ({
  page,
}) => {
  const api = await setup(page);
  const held = deferredMfaResponse();
  api.on("GET", "/api/auth/mfa", (route) =>
    route.fulfill({
      json: {
        user_id: ids.rosa,
        assurance_level: "aal1",
        required: false,
        policy_required: false,
        required_since: null,
        enrollment_deadline: null,
        factors: [],
      },
    }),
  );
  api.on("POST", `/api/users/${ids.ben}/recovery`, async (route) => {
    held.start();
    await held.waiting;
    await route.fulfill({ json: recovery() });
  });
  await page.goto("/access?view=overview");
  await page.getByRole("link", { name: "People", exact: true }).first().click();
  await page
    .getByRole("table", { name: "People" })
    .getByRole("button", { name: "Manage Ben Cruz", exact: true })
    .click();
  const sheet = page.getByRole("dialog", { name: "Ben Cruz", exact: true });
  await sheet.getByLabel("Job title").fill("Retained draft");
  await sheet.getByRole("tab", { name: "Security", exact: true }).click();
  await confirmRecovery(page);
  await held.begun;
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole("tab", { name: "Details", exact: false }).click();
  await expect(
    sheet.getByRole("tab", { name: "Security", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await sheet.getByRole("link", { name: "Security", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/access\\?view=people&user=${ids.ben}`),
  );
  expect(api.sent("POST", `/api/users/${ids.ben}/recovery`)).toHaveLength(1);
  held.release();
  await expect(
    sheet.getByRole("status").filter({
      hasText: /Recovery email sent|Two-step verification reset/,
    }),
  ).toContainText("Recovery email sent");
  await sheet.getByRole("tab", { name: /Details/ }).click();
  await expect(sheet.getByLabel("Job title")).toHaveValue("Retained draft");
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Discard unsaved changes?" }),
  ).toBeVisible();
});

test("partial revocation is truthful and performs session read-back without replay", async ({
  page,
}) => {
  const api = await setup(page);
  const template = api.sessions[0]!;
  const devices = (start: number, label: string) =>
    Array.from({ length: 13 }, (_, index) => ({
      ...template,
      id: `00000000-0000-4000-8000-${String(start + index).padStart(12, "0")}`,
      user_agent: `${label} ${index}`,
    }));
  api.sessions.splice(0, api.sessions.length, ...devices(9000, "Old device"));
  api.on("POST", `/api/users/${ids.ben}/recovery`, (route) => {
    // The old sessions were committed as revoked. New concurrent logins can
    // exist by read-back, and must replace every cached page of old devices.
    api.sessions.splice(
      0,
      api.sessions.length,
      ...devices(10000, "New device"),
    );
    return route.fulfill({
      status: 503,
      json: {
        detail: {
          code: "security_action_incomplete",
          message: "Private diagnostic",
          operation_id: operationId,
          email_request: "unconfirmed",
          local_revocation: "committed",
          factors_cleared: null,
        },
      },
    });
  });
  const sheet = await open(page);
  await sheet.getByRole("tab", { name: "Sessions", exact: true }).click();
  await sheet
    .getByRole("navigation", { name: "Session pages", exact: true })
    .getByRole("button", { name: "Go to next page", exact: true })
    .click();
  await expect(
    sheet.getByRole("list", { name: "Sessions", exact: true }),
  ).toContainText("Old device 12");
  await sheet.getByRole("tab", { name: "Security", exact: true }).click();
  const readsBeforeRecovery = api.sent(
    "GET",
    `/api/users/${ids.ben}/sessions`,
  ).length;
  await confirmRecovery(page, true);
  await expect(sheet.getByRole("alert")).toContainText(
    "Signed out everywhere. We could not confirm the recovery email was sent.",
  );
  await expect(sheet).not.toContainText("Private diagnostic");
  await expect
    .poll(() => api.sent("GET", `/api/users/${ids.ben}/sessions`).length)
    .toBeGreaterThan(readsBeforeRecovery);
  await sheet.getByRole("tab", { name: "Sessions", exact: true }).click();
  await expect(
    sheet.getByRole("list", { name: "Sessions", exact: true }),
  ).toContainText("New device 0");
  await sheet
    .getByRole("navigation", { name: "Session pages", exact: true })
    .getByRole("button", { name: "Go to next page", exact: true })
    .click();
  await expect(
    sheet.getByRole("list", { name: "Sessions", exact: true }),
  ).toContainText("New device 12");
  await expect(
    sheet.getByRole("list", { name: "Sessions", exact: true }),
  ).not.toContainText("Old device");
  expect(api.sent("POST", `/api/users/${ids.ben}/recovery`)).toHaveLength(1);
});

test("a command returning 401 requests session verification without refresh or replay", async ({
  page,
}) => {
  const api = await setup(page);
  const verification = deferredMfaResponse();
  const sheet = await open(page);
  api.on("GET", "/api/auth/session", async (route) => {
    verification.start();
    await verification.waiting;
    await route.fulfill({
      json: { authenticated: true, user_id: ids.rosa, setup_required: false },
    });
  });
  api.on("POST", `/api/users/${ids.ben}/recovery`, (route) =>
    route.fulfill({ status: 401, json: { detail: "Expired" } }),
  );
  await confirmRecovery(page);
  await verification.begun;
  const curtain = page.getByRole("dialog", {
    name: "Session verification",
    exact: true,
  });
  await expect(curtain).toBeVisible();
  expect(api.sent("POST", "/api/auth/refresh")).toHaveLength(0);
  expect(api.sent("POST", `/api/users/${ids.ben}/recovery`)).toHaveLength(1);
  verification.release();
  await expect(curtain).toBeHidden();
  await sheet.getByRole("tab", { name: "Security", exact: true }).click();
  await expect(
    sheet.getByRole("button", { name: "Send recovery email", exact: true }),
  ).toBeEnabled();
  expect(api.sent("POST", `/api/users/${ids.ben}/recovery`)).toHaveLength(1);
});

test("old pending completion behind same-account verification cannot change current controls", async ({
  page,
}) => {
  const api = await setup(page);
  const held = deferredMfaResponse();
  const verification = deferredMfaResponse();
  api.on("POST", `/api/users/${ids.ben}/recovery`, async (route) => {
    held.start();
    await held.waiting;
    await route.fulfill({ json: recovery() });
  });
  const sheet = await open(page);
  await confirmRecovery(page);
  await held.begun;
  api.on("GET", "/api/auth/session", async (route) => {
    verification.start();
    await verification.waiting;
    await route.fulfill({
      json: { authenticated: true, user_id: ids.rosa, setup_required: false },
    });
  });
  await recheckSession(page);
  await verification.begun;
  held.release();
  const curtain = page.getByRole("dialog", {
    name: "Session verification",
    exact: true,
  });
  await expect(curtain).toBeVisible();
  verification.release();
  await expect(curtain).toBeHidden();
  await sheet.getByRole("tab", { name: "Security", exact: true }).click();
  await expect(
    sheet.getByRole("button", { name: "Send recovery email", exact: true }),
  ).toBeEnabled();
  await expect(
    sheet.getByRole("status").filter({ hasText: "Recovery email sent" }),
  ).toHaveCount(0);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toBeHidden();
});

for (const failedFollowup of [false, true]) {
  test(`self committed recovery signs out even when read-back fails=${failedFollowup}`, async ({
    page,
  }) => {
    const api = await setup(page);
    if (failedFollowup)
      api.on("GET", `/api/users/${ids.rosa}/sessions`, (route) =>
        route.fulfill({ status: 503, json: { detail: "Unavailable" } }),
      );
    await open(page, ids.rosa, "Rosa Reyes");
    await confirmRecovery(page, true);
    await expect(page).toHaveURL(/\/login$/);
    expect(api.sent("POST", `/api/users/${ids.rosa}/recovery`)).toHaveLength(1);
  });
}

test("browser Back safely departs and delayed command cannot overwrite its new owner", async ({
  page,
}) => {
  const api = await setup(page);
  const held = deferredMfaResponse();
  api.on("POST", `/api/users/${ids.ben}/recovery`, async (route) => {
    held.start();
    await held.waiting;
    await route.fulfill({ json: recovery() });
  });
  await page.goto("/access?view=overview");
  await page.getByRole("link", { name: "People", exact: true }).first().click();
  await page
    .getByRole("table", { name: "People" })
    .getByRole("button", { name: "Manage Ben Cruz", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Ben Cruz", exact: true })
    .getByRole("tab", { name: "Security", exact: true })
    .click();
  await confirmRecovery(page);
  await held.begun;
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Access overview", exact: true }),
  ).toBeVisible();
  held.release();
  await expect(
    page.getByRole("status").filter({ hasText: "Recovery email sent" }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "People", exact: true }).first().click();
  const sheet = page.getByRole("dialog", { name: "Ben Cruz", exact: true });
  if (await sheet.isVisible())
    await sheet.getByRole("tab", { name: "Security", exact: true }).click();
  else {
    await page
      .getByRole("table", { name: "People" })
      .getByRole("button", { name: "Manage Ben Cruz", exact: true })
      .click();
    await sheet.getByRole("tab", { name: "Security", exact: true }).click();
  }
  await expect(
    sheet.getByRole("button", { name: "Send recovery email", exact: true }),
  ).toBeEnabled();
  expect(api.sent("POST", `/api/users/${ids.ben}/recovery`)).toHaveLength(1);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toBeHidden();
});

test("account replacement clears old pending ownership and cannot display its result", async ({
  page,
}) => {
  const api = await setup(page);
  const held = deferredMfaResponse();
  api.on("POST", `/api/users/${ids.ben}/recovery`, async (route) => {
    held.start();
    await held.waiting;
    await route.fulfill({ json: recovery() });
  });
  const sheet = await open(page);
  await confirmRecovery(page);
  await held.begun;
  api.on("GET", "/api/auth/session", (route) =>
    route.fulfill({
      json: { authenticated: true, user_id: ids.ben, setup_required: false },
    }),
  );
  api.on("GET", "/api/auth/me", (route) =>
    route.fulfill({ json: { id: ids.ben, role: "admin", access: [] } }),
  );
  api.on("GET", "/api/auth/mfa", (route) =>
    route.fulfill({
      json: {
        user_id: ids.ben,
        assurance_level: "aal2",
        required: false,
        policy_required: false,
        required_since: null,
        enrollment_deadline: null,
        factors: [],
      },
    }),
  );
  await recheckSession(page);
  await expect(
    sheet.getByRole("tab", { name: "Details", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  held.release();
  await sheet.getByRole("tab", { name: "Security", exact: true }).click();
  await expect(
    sheet.getByRole("button", { name: "Send recovery email", exact: true }),
  ).toBeEnabled();
  await expect(
    sheet.getByRole("status").filter({ hasText: "Recovery email sent" }),
  ).toHaveCount(0);
  expect(api.sent("POST", `/api/users/${ids.ben}/recovery`)).toHaveLength(1);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toBeHidden();
});

test("known self revocation signs out after a partial email outcome", async ({
  page,
}) => {
  const api = await setup(page);
  api.on("POST", `/api/users/${ids.rosa}/recovery`, (route) => {
    // A committed local revocation ended this session, so the server reports
    // it signed out; /login would otherwise return a live session to work.
    api.on("GET", "/api/auth/session", (session) =>
      session.fulfill({ json: { authenticated: false } }),
    );
    return route.fulfill({
      status: 503,
      json: {
        detail: {
          code: "security_action_incomplete",
          operation_id: operationId,
          email_request: "unconfirmed",
          local_revocation: "committed",
          factors_cleared: null,
          message: "Private diagnostic",
        },
      },
    });
  });
  await open(page, ids.rosa, "Rosa Reyes");
  await confirmRecovery(page, true);
  await expect(page).toHaveURL(/\/login$/);
  expect(api.sent("POST", `/api/users/${ids.rosa}/recovery`)).toHaveLength(1);
});

test("large-text phone panel keeps security actions and confirmation reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("openslate-text-size", "125");
    localStorage.setItem("openslate-density", "spacious");
  });
  await setup(page);
  const sheet = await open(page);
  const reset = sheet.getByRole("button", {
    name: "Reset two-step verification",
    exact: true,
  });
  await reset.scrollIntoViewIfNeeded();
  await expect(reset).toBeInViewport();
  const geometry = await sheet.evaluate((element) => ({
    content: element.scrollWidth,
    width: element.clientWidth,
  }));
  expect(geometry.content).toBeLessThanOrEqual(geometry.width);
  const bounds = await reset.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
  await reset.click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Reset two-step verification?",
    exact: true,
  });
  const cancel = confirmation.getByRole("button", {
    name: "Cancel",
    exact: true,
  });
  await cancel.scrollIntoViewIfNeeded();
  await expect(cancel).toBeInViewport();
  await cancel.click();
  await expect(confirmation).toBeHidden();
});

// Recovery feedback follows the submitted command, including confirmed facts
// from an overall partial result: one sent and one failed outcome. Every
// partial combination is a row of isolated/access/person-security-outcome.spec.ts.
for (const state of [
  {
    name: "recovery committed not_attempted",
    revoke: true,
    email: "not_attempted",
    local: "committed",
  },
  {
    name: "ordinary recovery accepted",
    revoke: false,
    email: "accepted",
    local: "not_requested",
  },
] as const) {
  test(`partial feedback: ${state.name}`, async ({ page }) => {
    const api = await setup(page);
    const path = `/api/users/${ids.ben}/recovery`;
    api.on("POST", path, (route) =>
      route.fulfill({
        status: 503,
        json: {
          detail: {
            code: "security_action_incomplete",
            operation_id: operationId,
            email_request: state.email,
            local_revocation: state.local,
            factors_cleared: null,
            message: "Ignored synthetic diagnostic",
          },
        },
      }),
    );
    const sheet = await open(page);
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === path &&
          response.status() === 503,
      ),
      confirmRecovery(page, state.revoke),
    ]);
    // An accepted email is a success; only a real failure is an alert.
    const sent = state.email === "accepted";
    const outcome = sent
      ? sheet.getByRole("status").filter({ hasText: "Recovery email sent" })
      : sheet.getByRole("alert");
    await expect(outcome).toBeVisible();
    if (sent) await expect(sheet.getByRole("alert")).toHaveCount(0);
    expect(api.sent("POST", path)).toHaveLength(1);
    expect(api.sent("POST", path)[0].body).toEqual({
      revoke_sessions: state.revoke,
    });
    expect(api.sent("POST", `/api/users/${ids.ben}/mfa/reset`)).toHaveLength(0);
    const observed = (await outcome.innerText()).replace(/\s+/g, " ").trim();
    expect.soft(observed).not.toMatch(/authenticator|two-step/i);
    if (sent) expect(observed).toMatch(/Recovery email sent to \S+@\S+\./);
    else if (state.local === "committed")
      expect(observed).toContain(
        "Signed out everywhere. The recovery email did not send. Try again.",
      );
    if (state.local === "committed")
      expect(observed).toMatch(/^Signed out everywhere\./);
    else expect(observed).not.toMatch(/signed out/i);
  });
}
