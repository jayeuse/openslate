import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

type Fixture = Readonly<{
  runId: string;
  baseURL: string;
  admin: Readonly<{ email: string; password: string }>;
}>;

function fixture(): Fixture {
  const location = process.env.OPENSLATE_FULLSTACK_FIXTURE;
  const runId = process.env.OPENSLATE_FULLSTACK_RUN_ID;
  if (!location || !runId) throw new Error("full-stack fixture is unavailable");
  const value = JSON.parse(readFileSync(location, "utf8")) as Fixture;
  if (
    value.runId !== runId ||
    value.baseURL !== test.info().project.use.baseURL
  )
    throw new Error("full-stack fixture does not match this gateway run");
  return value;
}

async function applyTemplate(page: Page, name: string) {
  await page.getByRole("button", { name: "More Sandbox actions" }).click();
  await page.getByRole("menuitem", { name: "Start from template" }).click();
  await page.getByRole("button", { name: `Select ${name}` }).click();
  await page.getByRole("button", { name: `Use ${name}` }).click();
  await expect(
    page.getByText(`${name} template applied to the shared Sandbox.`),
  ).toBeVisible();
}

async function publishDraft(page: Page, password: string) {
  await page.getByRole("button", { name: "Review & Publish" }).click();
  const preview = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        "/api/sandbox/publication-previews" &&
      response.request().method() === "POST",
    { timeout: 45_000 },
  );
  await page.getByRole("button", { name: "Review changes" }).click();
  expect((await preview).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Changes" })).toBeVisible();
  await page.getByLabel("Your password").fill(password);
  const published = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/sandbox/publications" &&
      response.request().method() === "POST",
    { timeout: 45_000 },
  );
  await page.getByRole("button", { name: "Publish changes" }).click();
  expect((await published).status()).toBe(201);
  await expect(
    page.getByText("Your changes are now published to the live workspace."),
  ).toBeVisible();
}

test("Sandbox exposes the simplified Build, Automations, Test, and History journey", async ({
  page,
}) => {
  // Six sequential template publications measured 44.97s against the shared 45s default.
  test.setTimeout(90_000);
  const credentials = fixture().admin;
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/openview$/);
  await page.goto("/sandbox?section=designer");

  await expect(
    page.getByRole("heading", { name: "Organization builder" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review & Publish" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Build", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Automations", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Test", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "History", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Create release snapshot")).toHaveCount(0);
  await expect(page.getByText("Simulation", { exact: true })).toHaveCount(0);

  await applyTemplate(page, "Inventory & procurement");
  await publishDraft(page, credentials.password);
  await expect(page.getByText("Published", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Recent activity" }),
  ).toBeVisible();
  await expect(
    page.getByText("No published automation activity yet."),
  ).toBeVisible();

  await page.getByRole("link", { name: "Test", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Test your setup" }),
  ).toBeVisible();
  await expect(
    page.getByText("Nothing is added to your live workspace."),
  ).toBeVisible();
  await page.getByLabel("Supplier ID").fill("SUP-001");
  await page.getByLabel("Status").selectOption({ label: "Active" });
  await page.getByLabel("Legal name").fill("Acceptance Supplier");
  await page.getByLabel("When").selectOption("field-changed");
  await page.getByLabel("Changed field").selectOption({ label: "Status" });
  await page.getByRole("button", { name: "Run test" }).click();
  await expect(
    page.getByRole("heading", { name: "Test result" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Published structure" }),
  ).toBeVisible();

  for (const name of [
    "Finance, accounting & sales",
    "Retail & commerce",
    "Professional services",
    "Field service & maintenance",
    "Light manufacturing",
  ]) {
    await page.getByRole("link", { name: "Build", exact: true }).click();
    await applyTemplate(page, name);
    await publishDraft(page, credentials.password);
  }
});
