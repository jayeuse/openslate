import { expect, recheckSession, test, type Page } from "./helpers/test";
import { mockManageSecurity } from "./helpers/manage-security";
import { concealMfaTestCredentials, mockMfa, mfaUserA } from "./helpers/mfa";

test.use({ trace: "off", screenshot: "off", video: "off" });
test.afterEach(async ({ page }) => {
  await concealMfaTestCredentials(page);
});

const requirementStart = "2026-10-01T08:30:00Z";
const enrollmentDeadline = "2026-10-08T08:30:00Z";
function requirementStatus(required = false) {
  return {
    user_id: mfaUserA,
    assurance_level: "aal1",
    required,
    policy_required: true,
    required_since: requirementStart,
    enrollment_deadline: enrollmentDeadline,
    factors: [],
  };
}

async function openMfa(page: Page) {
  await page.goto("/access?view=security");
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await page
    .getByRole("button", { name: "Manage two-step verification", exact: true })
    .click();
  return page.getByRole("dialog", {
    name: "Two-step verification",
    exact: true,
  });
}

test("authoritative MFA grace shows its start and deadline while a fresh enforced status uses the existing gate", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-06T12:00:00Z") });
  await mockManageSecurity(page);
  const identity = await mockMfa(page);
  const body = requirementStatus();
  await page.route("**/api/auth/mfa", (route) => route.fulfill({ json: body }));
  const dialog = await openMfa(page);
  await expect(dialog.getByRole("note")).toContainText(
    "keep using the workspace",
  );
  await expect(dialog).toContainText("Required since");
  await expect(dialog).toContainText("Set up by");
  await expect(dialog).toContainText("Oct 1, 2026");
  await expect(dialog).toContainText("Oct 8, 2026");
  // Workspace-local (Asia/Manila) time; UTC stays in the title only.
  await expect(dialog).toContainText(/4:30\sPM/);
  await expect(dialog).not.toContainText("UTC");
  await expect(
    dialog.getByRole("button", { name: "Set up authenticator", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Security" }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Session verification", exact: true }),
  ).toHaveCount(0);
  body.required = true;
  identity.actors.get(mfaUserA)!.policyRequired = true;
  await recheckSession(page);
  const gate = page.getByRole("region", {
    name: "Two-step verification",
    exact: true,
  });
  await expect(
    gate.getByRole("heading", {
      name: "Complete two-step verification",
      exact: true,
    }),
  ).toBeVisible();
  await expect(gate.getByRole("note")).toContainText(
    "Two-step verification is required now",
  );
  await expect(gate).toContainText("Oct 1, 2026");
  await expect(gate).toContainText("Oct 8, 2026");
  await expect(
    page.getByRole("heading", { level: 1, name: "Security" }),
  ).toHaveCount(0);
});

test("a required account with no recorded episode has immediate enrollment and no invented dates", async ({
  page,
}) => {
  await mockMfa(page, { required: true });
  await page.route("**/api/auth/mfa", (route) =>
    route.fulfill({
      json: {
        ...requirementStatus(true),
        required_since: null,
        enrollment_deadline: null,
      },
    }),
  );
  await page.goto("/platform?section=search");
  const gate = page.getByRole("region", {
    name: "Two-step verification",
    exact: true,
  });
  await expect(
    gate.getByRole("heading", {
      name: "Complete two-step verification",
      exact: true,
    }),
  ).toBeVisible();
  await expect(gate.getByRole("note")).toContainText(
    "Two-step verification is required now",
  );
  await expect(gate.getByText("Required since", { exact: true })).toHaveCount(
    0,
  );
  await expect(gate.getByText("Set up by", { exact: true })).toHaveCount(0);
  await expect(gate).not.toContainText("keep using the workspace");
  await expect(
    gate.getByRole("button", { name: "Set up authenticator", exact: true }),
  ).toBeEnabled();
});

// The other refused status bodies (a deadline or start without an offset, an
// unknown field or level) are rows of tests/isolated/auth/mfa-status.spec.ts.
test("missing policy fact leaves MFA unavailable until a valid fresh Retry", async ({
  page,
}) => {
  await mockManageSecurity(page);
  await mockMfa(page);
  let invalidResponse = true;
  await page.route("**/api/auth/mfa", (route) => {
    const body: Record<string, unknown> = requirementStatus();
    if (invalidResponse) delete body.policy_required;
    return route.fulfill({ json: body });
  });
  const dialog = await openMfa(page);
  await expect(dialog.getByRole("alert")).toContainText(
    "could not load your two-step verification settings",
  );
  await expect(
    dialog.getByRole("button", { name: "Set up authenticator", exact: true }),
  ).toHaveCount(0);
  invalidResponse = false;
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("note")).toContainText(
    "Set up an authenticator app before the date above.",
  );
  await expect(dialog).toContainText("Oct 8, 2026");
  await expect(
    dialog.getByRole("button", { name: "Set up authenticator", exact: true }),
  ).toBeEnabled();
});
