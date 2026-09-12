import { expect, test } from "../coverage";
import type { Page } from "@playwright/test";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";

test.beforeEach(async ({ page }) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: { detail: "Unavailable" } }),
  );
  await page.route("**/bff/**", async (route) => {
    if (!(await fulfillWorkspaceRequest(route)))
      await route.fulfill({ json: { items: [], has_more: false } });
  });
  await page.goto("/sandbox");
});

async function selectServiceRequests(page: Page) {
  await page
    .getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    })
    .click();
  if ((page.viewportSize()?.width ?? 0) < 1280) {
    await page
      .getByRole("button", { name: "Inspect selected", exact: true })
      .click();
  }
}

test("field drafts reject invalid configuration and commit as one undo step", async ({
  page,
}) => {
  await selectServiceRequests(page);
  const field = page.getByRole("region", { name: "Status field settings" });
  await field
    .getByRole("button", { name: "Show Status settings", exact: true })
    .click();
  const fieldActions = field.getByRole("group", {
    name: "Status field actions",
    exact: true,
  });
  await expect(fieldActions).toBeVisible();
  await expect(
    fieldActions.getByRole("button", {
      name: "Save field changes",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    fieldActions.getByRole("button", { name: "Close field", exact: true }),
  ).toBeVisible();

  await field.getByLabel("Status name", { exact: true }).fill("Workflow state");
  await field
    .getByLabel("Status description", { exact: true })
    .fill("Controls the request workflow");
  await field
    .getByLabel("Status options", { exact: true })
    .fill("Open, Open, Complete");
  await field
    .getByLabel("Status default value", { exact: true })
    .fill("Complete");
  await field
    .getByRole("button", { name: "Save field changes", exact: true })
    .click();

  await expect(field.getByRole("alert")).toContainText(
    "Select options must be unique",
  );
  await expect(field.getByLabel("Status name", { exact: true })).toHaveValue(
    "Workflow state",
  );
  await expect(
    field.getByRole("heading", { name: "Status", exact: true }),
  ).toBeVisible();

  await field
    .getByLabel("Status options", { exact: true })
    .fill("Open, In progress, Complete");
  await field
    .getByRole("button", { name: "Save field changes", exact: true })
    .click();
  const committedField = page.getByRole("region", {
    name: "Workflow state field settings",
  });
  await expect(
    committedField.getByRole("heading", {
      name: "Workflow state",
      exact: true,
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  const restoredField = page.getByRole("region", {
    name: "Status field settings",
  });
  await expect(
    restoredField.getByRole("heading", { name: "Status", exact: true }),
  ).toBeVisible();
  const restoredDisclosure = restoredField.getByRole("button", {
    name: /Status settings$/,
  });
  if ((await restoredDisclosure.getAttribute("aria-expanded")) !== "true")
    await restoredDisclosure.click();
  await expect(
    restoredField.getByLabel("Status description", { exact: true }),
  ).toHaveValue("");
  await expect(
    restoredField.getByLabel("Status options", { exact: true }),
  ).toHaveValue("Open, In progress, Complete");
});

test("relationship settings validate duplicates and expose editable endpoints", async ({
  page,
}) => {
  await selectServiceRequests(page);
  const inspector = page.getByRole("complementary", {
    name: "Design inspector",
  });
  await expect(
    inspector.getByRole("heading", { name: "Outgoing" }),
  ).toBeVisible();
  await expect(inspector).toContainText("Uses equipment");

  await page
    .getByRole("button", { name: "Connect modules", exact: true })
    .click();
  const createDialog = page.getByRole("dialog", { name: "Connect modules" });
  await createDialog
    .getByLabel("Relationship name", { exact: true })
    .fill("Duplicate equipment link");
  await createDialog
    .getByRole("button", { name: "Create relationship", exact: true })
    .click();
  await expect(createDialog.getByRole("alert")).toContainText(
    "A relationship between these modules already exists",
  );

  await createDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  if ((page.viewportSize()?.width ?? 0) < 1280) {
    await page.getByRole("tab", { name: "Structure", exact: true }).click();
  }
  await page
    .getByRole("button", {
      name: "Edit relationship Uses equipment",
      exact: true,
    })
    .click();
  const settings = page.getByRole("dialog", { name: "Relationship settings" });
  await settings
    .getByLabel("Source module", { exact: true })
    .selectOption("sample-customers");
  await settings
    .getByRole("button", { name: "Save relationship", exact: true })
    .click();

  if ((page.viewportSize()?.width ?? 0) < 1280) {
    await page.getByRole("tab", { name: "Structure", exact: true }).click();
  }
  await page
    .getByRole("button", { name: "Select module Equipment", exact: true })
    .click();
  if ((page.viewportSize()?.width ?? 0) < 1280) {
    await page
      .getByRole("button", { name: "Inspect selected", exact: true })
      .click();
  }
  await expect(
    inspector.getByRole("heading", { name: "Incoming" }),
  ).toBeVisible();
  await expect(inspector).toContainText("Customers");
  await inspector
    .getByRole("button", {
      name: "Delete incoming relationship Uses equipment",
      exact: true,
    })
    .click();
  const deleteDialog = page.getByRole("alertdialog", {
    name: "Delete relationship Uses equipment?",
  });
  await expect(deleteDialog).toContainText("Undo restores the complete change");
  await deleteDialog.getByRole("button", { name: "Cancel" }).click();
  await inspector
    .getByRole("button", {
      name: "Edit incoming relationship Uses equipment",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Relationship settings", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Relationship settings", exact: true })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
});

test("ordering is scoped and move and lifecycle states remain visible", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Select module Equipment", exact: true })
    .click();
  if ((page.viewportSize()?.width ?? 0) < 1280) {
    await page
      .getByRole("button", { name: "Inspect selected", exact: true })
      .click();
  }
  await expect(
    page.getByRole("button", { name: "Move module later" }),
  ).toBeDisabled();
  await page
    .getByLabel("Move module to department")
    .selectOption("sample-commercial");
  await page.getByRole("button", { name: "Close module", exact: true }).click();
  if ((page.viewportSize()?.width ?? 0) < 1280) {
    await page.getByRole("tab", { name: "Structure", exact: true }).click();
  }
  await expect(
    page.getByRole("button", { name: "Select module Equipment", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Select module Equipment", exact: true }),
  ).toContainText("Closed");

  await page
    .getByRole("button", { name: "Select department Commercial", exact: true })
    .click();
  if ((page.viewportSize()?.width ?? 0) < 1280) {
    await page
      .getByRole("button", { name: "Inspect selected", exact: true })
      .click();
  }
  await expect(
    page.getByRole("button", { name: "Move department later", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Close department", exact: true })
    .click();
  if ((page.viewportSize()?.width ?? 0) < 1280) {
    await page.getByRole("tab", { name: "Structure", exact: true }).click();
  }
  await expect(
    page.getByRole("button", {
      name: "Select department Commercial",
      exact: true,
    }),
  ).toContainText("Closed");
});

test("mobile selection stays in structure until Inspect selected is used", async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1280, "Mobile contract");
  await page
    .getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Organization structure" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect selected", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Design inspector" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Service requests", exact: true }),
  ).toBeVisible();
});
