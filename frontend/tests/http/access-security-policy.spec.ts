import {
  authMeBody,
  defaultOrganization,
  expect,
  expectNoHorizontalScroll,
  heldResponse,
  signedInSession,
  test,
  type Page,
} from "./helpers/test";
import { mockManageSecurity } from "./helpers/manage-security";

// The Security page and the Account policy dialog after the Access pass
// (docs/specs/access-ui-ux-pass.md, Phase 5). The policy rules themselves
// (validation, patch keys, conflicts) stay in access-security.spec.ts and the
// isolated security-settings tables.

const viewerId = "00000000-0000-4000-8000-000000000001";

/** An administrator who does not own the organization or the installation. */
async function signInAsAdministrator(
  page: Page,
  owner: { organization: boolean; installation: boolean },
) {
  // `owner` is the membership's organization-owner flag in /auth/me.
  const organization = {
    ...defaultOrganization,
    role: "admin" as const,
    access: [],
    owner: owner.organization,
  };
  await signedInSession(page, viewerId);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authMeBody({
        id: viewerId,
        role: "admin",
        operator: owner.installation,
        current_organization: organization,
      }),
    }),
  );
  await page.route("**/api/auth/mfa", (route) =>
    route.fulfill({
      json: {
        user_id: viewerId,
        assurance_level: "aal1",
        required: false,
        policy_required: false,
        required_since: null,
        enrollment_deadline: null,
        factors: [],
      },
    }),
  );
}

function policyDialog(page: Page) {
  return page.getByRole("dialog", { name: "Account policy", exact: true });
}

test("the policy dialog shows the common settings and keeps the rare ones in a counted Advanced block", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  Object.assign(state.policy, {
    password_min_length: 13,
    ip_allow_list: ["192.0.2.0/24"],
  });
  await page.goto("/access?view=security");
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = policyDialog(page);
  for (const role of ["administrators", "members", "guests"])
    await expect(
      policy.getByRole("checkbox", {
        name: `Require two-step verification for ${role}`,
        exact: true,
      }),
    ).toBeVisible();
  await expect(
    policy.getByLabel("Days to set up two-step", { exact: true }),
  ).toBeVisible();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toBeVisible();
  // Everything else waits, closed, in one Advanced block that counts what
  // differs from the defaults (a 13-character minimum and one address).
  const advanced = policy.getByRole("button", {
    name: "Advanced · 2 set",
    exact: true,
  });
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  for (const label of [
    "Address or range",
    "Minimum password length",
    "Longest session",
    "Keep session history (days)",
    "Failed attempts before lockout",
  ])
    await expect(policy.getByLabel(label, { exact: true })).toBeHidden();
  // The viewer's own two-step setup lives on the Security page now.
  await expect(
    policy.getByRole("button", { name: /two-step verification/ }),
  ).toHaveCount(0);
  await expect(policy).not.toContainText("Closing keeps your unsaved changes");

  // Footer: Cancel first, Discard only with edits, and the state as a chip.
  const footer = policy.getByRole("group", {
    name: "Policy actions",
    exact: true,
  });
  // innerText leaves out the hidden pending label ("Saving…").
  await expect(footer.getByRole("button")).toHaveText(
    ["Cancel", "Save settings"],
    { useInnerText: true },
  );
  await expect(footer.getByRole("status")).toHaveText("Saved");
  await policy
    .getByLabel("Session timeout", { exact: true })
    .selectOption("30 minutes");
  await expect(footer.getByRole("button")).toHaveText(
    ["Cancel", "Discard changes", "Save settings"],
    { useInnerText: true },
  );
  await expect(footer.getByRole("status")).toHaveText("Unsaved changes");

  // An edit inside Advanced counts while the block is closed.
  await advanced.click();
  await policy
    .getByLabel("Minimum password length", { exact: true })
    .fill("12");
  await policy.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(
    policy.getByRole("button", { name: "Advanced · 1 set", exact: true }),
  ).toBeVisible();

  const write = heldResponse();
  await page.route("**/api/workspace/security", async (route) => {
    if (route.request().method() === "PATCH") {
      write.enter();
      await write.released;
    }
    await route.fallback();
  });
  try {
    await footer.getByRole("button", { name: "Save settings" }).click();
    await write.entered;
    await expect(
      footer.getByRole("button", { name: "Saving…", exact: true }),
    ).toBeDisabled();
  } finally {
    write.release();
  }
  // The result shows inside the dialog, not behind it.
  await expect(footer.getByRole("status")).toHaveText("Account policy saved");
  await expect(
    page
      .getByRole("region", { name: "Security workspace", exact: true })
      .getByText("Account policy saved", { exact: false }),
  ).toHaveCount(0);
  // innerText leaves out the hidden pending label ("Saving…").
  await expect(footer.getByRole("button")).toHaveText(
    ["Cancel", "Save settings"],
    { useInnerText: true },
  );
  expect(state.writes.at(-1)?.body).toEqual({
    revision: 1,
    session_timeout_minutes: 30,
    password_min_length: 12,
  });
});

for (const storage of ["available", "blocked"] as const)
  test(`a refused address list opens the closed Advanced block and focuses the address field (storage ${storage})`, async ({
    page,
  }) => {
    // Blocked site data makes reading window.localStorage itself throw.
    if (storage === "blocked")
      await page.addInitScript(() => {
        Object.defineProperty(window, "localStorage", {
          get() {
            throw new DOMException("Blocked", "SecurityError");
          },
        });
      });
    const state = await mockManageSecurity(page);
    await page.goto("/access?view=security");
    await page
      .getByRole("button", { name: "Edit policy", exact: true })
      .click();
    const policy = policyDialog(page);
    await policy.getByRole("button", { name: "Advanced", exact: true }).click();
    const address = policy.getByLabel("Address or range", { exact: true });
    await address.fill("192.0.2.0/24");
    await policy
      .getByRole("button", { name: "Add address", exact: true })
      .click();
    const advanced = policy.getByRole("button", { name: /^Advanced/ });
    await advanced.click();
    await expect(advanced).toHaveAccessibleName("Advanced · 1 set");
    await expect(address).toBeHidden();
    state.policyWriteFailure = { status: 409, code: "ip_lockout" };
    await policy.getByRole("button", { name: "Save settings" }).click();
    await expect(advanced).toHaveAttribute("aria-expanded", "true");
    await expect(policy).toContainText(
      "This list blocks your current address. Add your address, then save.",
    );
    await expect(address).toBeFocused();
  });

test("the address list says an empty list allows every address and names the limit only when the list is full", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  state.policy.ip_allow_list = Array.from(
    { length: 99 },
    (_, index) => `198.51.100.${index + 1}`,
  );
  await page.goto("/access?view=security");
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = policyDialog(page);
  await policy.getByRole("button", { name: /^Advanced/ }).click();
  const addresses = policy.getByRole("group", {
    name: "Allowed addresses",
    exact: true,
  });
  await expect(
    addresses.getByText("Empty allows every address.", { exact: true }),
  ).toBeVisible();
  const limit = addresses.getByText(
    "You can add up to 100 addresses or ranges.",
    { exact: true },
  );
  await expect(limit).toHaveCount(0);

  const entry = policy.getByLabel("Address or range", { exact: true });
  await entry.fill("203.0.113.0/24");
  await policy
    .getByRole("button", { name: "Add address", exact: true })
    .click();
  await expect(limit).toBeVisible();
});

test("a non-owner administrator reads the policy as text and sets up their own two-step on the page", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  state.policy.mfa_require_admin = true;
  state.policy.ip_allow_list = ["192.0.2.0/24"];
  await signInAsAdministrator(page, {
    organization: false,
    installation: false,
  });
  await page.goto("/access?view=security");
  const workspace = page.getByRole("region", {
    name: "Security workspace",
    exact: true,
  });
  await expect(workspace).toContainText("Your two-step verification: Off");
  await page.getByRole("button", { name: "View policy", exact: true }).click();
  const policy = policyDialog(page);
  await expect(policy).toContainText(
    "Only the organization owner can change these settings.",
  );
  await policy.getByRole("button", { name: /^Advanced( · \d+ set)?$/ }).click();
  // Values read as text; nothing looks like a control the viewer could use.
  for (const role of ["checkbox", "textbox", "spinbutton", "combobox"] as const)
    await expect(policy.getByRole(role)).toHaveCount(0);
  await expect(policy.getByRole("term")).toHaveText([
    "Two-step verification",
    "Days to set up two-step",
    "Session timeout",
    "Allowed addresses",
    "Minimum password length",
    "Require uppercase and lowercase",
    "Require a number",
    "Longest session",
    "Sessions per person",
    "Keep session history",
    "Keep security events",
    "Failed attempts before lockout",
    "Within",
    "Lock for",
  ]);
  await expect(policy.getByRole("definition")).toHaveText([
    "Required for administrators",
    "0 days",
    "60 minutes",
    "192.0.2.0/24",
    "12",
    "On",
    "Off",
    "Off",
    "Off",
    "365 days",
    "365 days",
    "5",
    "15 minutes",
    "15 minutes",
  ]);
  await expect(
    policy.getByRole("button", { name: "Save settings", exact: true }),
  ).toHaveCount(0);
  // The header × scrolls away on a phone, so the footer has one Close.
  const footer = policy.getByRole("group", {
    name: "Policy actions",
    exact: true,
  });
  await expect(footer.getByRole("button")).toHaveText(["Close"]);
  await footer.getByRole("button", { name: "Close", exact: true }).click();
  await expect(policy).toBeHidden();
  // The viewer's own setup keeps its flow, from the Security page.
  await workspace
    .getByRole("button", { name: "Set up two-step verification", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Two-step verification", exact: true })
      .getByRole("button", { name: "Set up authenticator", exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([]);
});

test("the viewer's own two-step setup is a full target on a phone", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  state.policy.mfa_require_admin = true;
  await signInAsAdministrator(page, {
    organization: false,
    installation: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/access?view=security");
  const workspace = page.getByRole("region", {
    name: "Security workspace",
    exact: true,
  });
  await expect(workspace).toContainText("Your two-step verification: Off");
  const box = await workspace
    .getByRole("button", { name: "Set up two-step verification", exact: true })
    .boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
});

test("an organization owner edits two-step and the address list but reads installation rules as text", async ({
  page,
}) => {
  await mockManageSecurity(page);
  await signInAsAdministrator(page, {
    organization: true,
    installation: false,
  });
  await page.goto("/access?view=security");
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = policyDialog(page);
  await expect(
    policy.getByRole("checkbox", {
      name: "Require two-step verification for members",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    policy.getByLabel("Days to set up two-step", { exact: true }),
  ).toBeEditable();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveCount(0);
  await expect(policy.getByRole("definition").first()).toHaveText("60 minutes");
  await expect(policy).toContainText(
    "Only the installation owner can change password, session, retention, and sign-in rules.",
  );
  await policy.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(
    policy.getByLabel("Address or range", { exact: true }),
  ).toBeEditable();
  await expect(
    policy.getByLabel("Minimum password length", { exact: true }),
  ).toHaveCount(0);
  await expect(
    policy.getByRole("checkbox", {
      name: "Require uppercase and lowercase letters",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("End all remote sessions is danger ink and its confirmation counts the sessions and people", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  // Two more remote sessions for Eli: 8 remote sessions on 6 people.
  for (const [index, browser] of ["Firefox", "Safari"].entries())
    state.sessions.push({
      ...state.sessions[1],
      id: `00000000-0000-4000-8000-00000000020${index}`,
      browser,
      refreshed_at: `2026-10-01T0${index}:00:00Z`,
    });
  await page.goto("/access?view=security");
  await expect(
    page.getByText(/Ending remote sessions signs those devices out/),
  ).toHaveCount(0);
  const endAll = page.getByRole("button", {
    name: "End all remote sessions",
    exact: true,
  });
  const [ink, danger] = await endAll.evaluate((button) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--danger-text)";
    button.append(probe);
    const values = [
      getComputedStyle(button).color,
      getComputedStyle(probe).color,
    ];
    probe.remove();
    return values;
  });
  expect(ink).toBe(danger);
  await endAll.click();
  const confirmation = page.getByRole("alertdialog", {
    name: "End all remote sessions",
    exact: true,
  });
  await expect(confirmation).toContainText(
    "Signs out 8 sessions on 6 people. Your current session stays.",
  );
  const ending = heldResponse();
  await page.route("**/api/auth/admin-sessions", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    ending.enter();
    await ending.released;
    // One remote session started meanwhile, so it is still active after.
    state.sessions = [
      ...state.sessions.filter((session) => session.current),
      { ...state.sessions[3], id: "00000000-0000-4000-8000-000000000299" },
    ];
    await route.fulfill({ status: 204 });
  });
  try {
    await confirmation
      .getByRole("button", {
        name: "End all remote sessions",
        exact: true,
      })
      .click();
    await ending.entered;
    await expect(
      confirmation.getByRole("button", { name: "Ending…", exact: true }),
    ).toBeDisabled();
  } finally {
    ending.release();
  }
  await expect(confirmation).toBeHidden();
  // The result is a notice, not a lasting page alert, and names what the
  // reloaded list still holds.
  await expect(
    page.getByText("Remote sessions ended · 1 still active", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Security workspace", exact: true })
      .getByRole("status")
      .filter({ hasText: "Remote sessions ended" }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("table", { name: "Sessions", exact: true })
      .locator("tbody tr"),
  ).toHaveCount(2);
});

test("End session names the person and device, and its result is a notice outside the policy", async ({
  page,
}) => {
  await mockManageSecurity(page);
  await page.goto("/access?view=security");
  await page
    .getByRole("button", {
      name: "End session for Eli, Mobile Chrome",
      exact: true,
    })
    .click();
  const confirmation = page.getByRole("alertdialog", {
    name: "End session",
    exact: true,
  });
  await expect(confirmation).toContainText(
    "Signs out Eli's Mobile Chrome session. Your current session stays.",
  );
  await confirmation
    .getByRole("button", { name: "End session", exact: true })
    .click();
  await expect(page.getByText("Session ended", { exact: true })).toBeVisible();
  // Each End names its row's device, so the names are unique.
  await expect(
    page.getByRole("button", {
      name: "End session for Rhea, unknown device",
      exact: true,
    }),
  ).toBeVisible();
  // The result never follows into the policy dialog.
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(policyDialog(page).getByText(/Session ended/)).toHaveCount(0);
});

test("Security opens 10 sessions a page with a compact policy line and a description of what it shows", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  for (let index = 0; index < 5; index += 1)
    state.sessions.push({
      ...state.sessions[2],
      id: `00000000-0000-4000-8000-00000000030${index}`,
      user_id: `00000000-0000-4000-8000-00000000004${index}`,
      person_name: `Guest ${index + 1}`,
      refreshed_at: `2026-09-30T0${index}:00:00Z`,
      current: false,
    });
  await page.goto("/access?view=security");
  await expect(
    page.getByText("Account policy and sign-in sessions.", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "Sessions", exact: true })
      .locator("tbody tr"),
  ).toHaveCount(10);
  await expect(page.getByLabel("Rows per page", { exact: true })).toHaveValue(
    "10",
  );
  expect(state.sessionReads[0]?.get("limit")).toBe("10");
  const workspace = page.getByRole("region", {
    name: "Security workspace",
    exact: true,
  });
  await expect(
    workspace.getByText(
      "12-character passwords · Two-step optional · 60-minute timeout",
      { exact: true },
    ),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalScroll(page);
  await expect(
    workspace.getByText(
      "12-character passwords · Two-step optional · 60-minute timeout",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const close = policyDialog(page).getByRole("button", {
    name: "Close account policy",
    exact: true,
  });
  const box = await close.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
});

test("a refused save shows its error and recovery in the fixed footer above the buttons", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await mockManageSecurity(page);
  state.policyWriteFailure = { status: 409, code: "mfa_enrollment_required" };
  await signInAsAdministrator(page, { organization: true, installation: true });
  await page.goto("/access?view=security");
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = policyDialog(page);
  await policy
    .getByRole("checkbox", {
      name: "Require two-step verification for members",
      exact: true,
    })
    .check();
  const footer = policy.getByRole("group", {
    name: "Policy actions",
    exact: true,
  });
  await footer.getByRole("button", { name: "Save settings" }).click();
  const refusal = footer.getByRole("alert");
  await expect(refusal).toContainText(
    "Set up your own two-step verification first.",
  );
  await expect(refusal).toBeInViewport();
  await refusal
    .getByRole("button", { name: "Set up two-step verification", exact: true })
    .click();
  await expect(policy).toBeHidden();
  await expect(
    page.getByRole("dialog", { name: "Two-step verification", exact: true }),
  ).toBeVisible();
});

test("Discard in the policy offers Undo in the footer until the next edit", async ({
  page,
}) => {
  const state = await mockManageSecurity(page);
  await page.goto("/access?view=security");
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = policyDialog(page);
  const footer = policy.getByRole("group", {
    name: "Policy actions",
    exact: true,
  });
  const timeout = policy.getByLabel("Session timeout", { exact: true });
  await timeout.selectOption("30 minutes");
  await footer.getByRole("button", { name: "Discard changes" }).click();
  await expect(timeout).toHaveValue("60 minutes");
  const undo = footer.getByRole("button", { name: "Undo", exact: true });
  await expect(footer.getByRole("status")).toContainText("Changes discarded");
  await expect(undo).toBeFocused();
  // No success alert: the footer says it.
  await expect(policy.getByText("Unsaved changes discarded.")).toHaveCount(0);
  await undo.click();
  await expect(timeout).toHaveValue("30 minutes");
  // Undo removes itself; focus moves to the Discard it brought back.
  await expect(
    footer.getByRole("button", { name: "Discard changes" }),
  ).toBeFocused();
  await expect(footer.getByRole("status")).toHaveText("Unsaved changes");
  // The next edit ends the Undo.
  await footer.getByRole("button", { name: "Discard changes" }).click();
  await timeout.selectOption("8 hours");
  await expect(undo).toHaveCount(0);
  expect(state.writes).toEqual([]);
});
