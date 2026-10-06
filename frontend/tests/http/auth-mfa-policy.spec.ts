import { expect, test, type Page } from "./helpers/test";
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
  await page.getByRole("button", { name: "Manage MFA", exact: true }).click();
  return page.getByRole("dialog", { name: "MFA enrollment", exact: true });
}

test("12b: authoritative MFA grace shows its start and deadline while a fresh enforced status uses the existing gate", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-06T12:00:00Z") });
  await mockManageSecurity(page);
  const identity = await mockMfa(page);
  const body = requirementStatus();
  await page.route("**/api/auth/mfa", (route) => route.fulfill({ json: body }));
  const dialog = await openMfa(page);
  await expect(dialog.getByRole("note")).toContainText("grace period");
  await expect(dialog).toContainText("Requirement started");
  await expect(dialog).toContainText("Enrollment deadline");
  await expect(dialog).toContainText("Oct 1, 2026");
  await expect(dialog).toContainText("Oct 8, 2026");
  await expect(dialog).toContainText("UTC");
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
  await page.evaluate(() =>
    window.dispatchEvent(new Event("openslate:session-recheck")),
  );
  const gate = page.getByRole("region", {
    name: "Multi-factor authentication",
    exact: true,
  });
  await expect(
    gate.getByRole("heading", {
      name: "Complete multi-factor authentication",
      exact: true,
    }),
  ).toBeVisible();
  await expect(gate.getByRole("note")).toContainText(
    "MFA enrollment is required now",
  );
  await expect(gate).toContainText("Oct 1, 2026");
  await expect(gate).toContainText("Oct 8, 2026");
  await expect(
    page.getByRole("heading", { level: 1, name: "Security" }),
  ).toHaveCount(0);
});

test("12b: a required account with no recorded episode has immediate enrollment and no invented dates", async ({
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
    name: "Multi-factor authentication",
    exact: true,
  });
  await expect(
    gate.getByRole("heading", {
      name: "Complete multi-factor authentication",
      exact: true,
    }),
  ).toBeVisible();
  await expect(gate.getByRole("note")).toContainText(
    "MFA enrollment is required now",
  );
  await expect(
    gate.getByText("Requirement started", { exact: true }),
  ).toHaveCount(0);
  await expect(
    gate.getByText("Enrollment deadline", { exact: true }),
  ).toHaveCount(0);
  await expect(gate).not.toContainText("grace period");
  await expect(
    gate.getByRole("button", { name: "Set up authenticator", exact: true }),
  ).toBeEnabled();
});

for (const invalid of ["missing policy fact", "naive deadline"] as const) {
  test(`12b: ${invalid} leaves MFA unavailable until a valid fresh Retry`, async ({
    page,
  }) => {
    await mockManageSecurity(page);
    await mockMfa(page);
    let invalidResponse = true;
    await page.route("**/api/auth/mfa", (route) => {
      const body: Record<string, unknown> = requirementStatus();
      if (invalidResponse) {
        if (invalid === "missing policy fact") delete body.policy_required;
        else body.enrollment_deadline = "2026-10-08T08:30:00";
      }
      return route.fulfill({ json: body });
    });
    const dialog = await openMfa(page);
    await expect(dialog.getByRole("alert")).toContainText(
      "could not load your MFA settings",
    );
    await expect(
      dialog.getByRole("button", { name: "Set up authenticator", exact: true }),
    ).toHaveCount(0);
    invalidResponse = false;
    await dialog.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(dialog.getByRole("note")).toContainText("grace period");
    await expect(dialog).toContainText("Oct 8, 2026");
    await expect(
      dialog.getByRole("button", { name: "Set up authenticator", exact: true }),
    ).toBeEnabled();
  });
}
