import { expect, test } from "../coverage";
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

test("rule query navigation reveals and focuses the requested rule", async ({
  page,
}) => {
  await page.goto("/sandbox?rule=sample-urgent");

  const rule = page.getByRole("article", {
    name: "Rule Urgent request alert",
  });
  await expect(
    page.getByRole("heading", { name: "Automation rules" }),
  ).toBeVisible();
  await expect(rule).toBeFocused();
  await expect(rule).toContainText(
    "No sample runs yet. Test this rule in Simulation.",
  );
  await expect(
    page.getByRole("status").filter({
      hasText: "Navigated to automation rule Urgent request alert.",
    }),
  ).toBeVisible();

  await page.goto("/sandbox?rule=missing-rule");
  await expect(
    page.getByRole("heading", { name: "Automation rules" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "The requested automation rule is unavailable." }),
  ).toBeVisible();
});

test("creates and edits a parameterized threshold rule without live writes", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/bff/") && request.method() !== "GET")
      writes.push(request.url());
  });

  await page
    .getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    })
    .click();
  if ((page.viewportSize()?.width ?? 0) < 1280)
    await page
      .getByRole("button", { name: "Inspect selected", exact: true })
      .click();
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await page.getByLabel("Field name", { exact: true }).fill("Capacity");
  await page.getByLabel("Field type", { exact: true }).selectOption("Number");
  await page.getByLabel("Default value", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Create field", exact: true }).click();

  await page.getByRole("tab", { name: "Automation", exact: true }).click();
  await page.getByRole("button", { name: "Create rule", exact: true }).click();
  const editor = page.getByRole("form", { name: "Create automation rule" });
  await editor.getByLabel("Rule name", { exact: true }).fill("Capacity alert");
  await editor.getByLabel("Trigger", { exact: true }).selectOption("threshold");
  await editor
    .getByLabel("Trigger module", { exact: true })
    .selectOption("sample-requests");
  await editor
    .getByLabel("Trigger field", { exact: true })
    .selectOption({ label: "Priority" });
  await editor
    .getByLabel("Threshold operator", { exact: true })
    .selectOption(">=");
  await editor.getByLabel("Threshold value", { exact: true }).fill("8");
  await editor.getByLabel("Condition", { exact: true }).selectOption("always");
  await editor
    .getByLabel("Action", { exact: true })
    .selectOption("notification");
  await editor
    .getByLabel("Notification message", { exact: true })
    .fill("Capacity needs attention");
  await editor.getByRole("button", { name: "Save rule", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Priority must be numeric for a threshold",
  );
  await expect(
    editor.getByLabel("Threshold value", { exact: true }),
  ).toHaveValue("8");
  await expect(
    page.getByRole("article", { name: "Rule Capacity alert" }),
  ).toHaveCount(0);
  await editor
    .getByLabel("Trigger field", { exact: true })
    .selectOption({ label: "Capacity" });
  await editor.getByRole("button", { name: "Save rule", exact: true }).click();

  const rule = page.getByRole("article", { name: "Rule Capacity alert" });
  await expect(rule).toContainText("Capacity >= 8");
  await expect(rule).toContainText("Capacity needs attention");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(rule).toHaveCount(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(rule).toContainText("Capacity >= 8");
  await rule.getByRole("button", { name: "Edit rule", exact: true }).click();
  const edit = page.getByRole("form", { name: "Edit automation rule" });
  await edit.getByLabel("Threshold value", { exact: true }).fill("10");
  await edit
    .getByRole("textbox", { name: "Notification message", exact: true })
    .fill("Capacity limit reached");
  await edit.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(rule).toContainText("Capacity >= 10");
  await expect(rule).toContainText("Capacity limit reached");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(rule).toContainText("Capacity >= 8");
  await expect(rule).toContainText("Capacity needs attention");
  expect(writes).toEqual([]);
});

test("flags closed dependencies and requires confirmation before deleting a rule", async ({
  page,
}) => {
  await page.getByRole("tab", { name: "Automation", exact: true }).click();
  const initialRule = page.getByRole("article", {
    name: "Rule Urgent request alert",
  });
  await initialRule
    .getByRole("button", { name: "Edit rule", exact: true })
    .click();
  const edit = page.getByRole("form", { name: "Edit automation rule" });
  await edit
    .getByLabel("Trigger", { exact: true })
    .selectOption("field-change");
  await edit
    .getByLabel("Trigger module", { exact: true })
    .selectOption("sample-requests");
  await edit
    .getByLabel("Trigger field", { exact: true })
    .selectOption("sample-field-Status");
  await edit.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("article", { name: "Rule Urgent request alert" })
    .getByRole("button", { name: "Test rule", exact: true })
    .click();
  await expect(
    page.getByLabel("Simulation event", { exact: true }),
  ).toHaveValue("field-change");
  await expect(page.getByLabel("Rule selection", { exact: true })).toHaveValue(
    "sample-urgent",
  );

  await page.getByRole("tab", { name: "Designer", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    })
    .click();
  if ((page.viewportSize()?.width ?? 0) < 1280)
    await page
      .getByRole("button", { name: "Inspect selected", exact: true })
      .click();
  await page.getByRole("button", { name: "Close module", exact: true }).click();

  const issues = page.getByRole("region", {
    name: "Sandbox validation issues",
  });
  await expect(issues).toContainText(
    "Urgent request alert references the closed module Service requests",
  );

  await page.getByRole("tab", { name: "Automation", exact: true }).click();
  const deleteRuleButton = page
    .getByRole("article", { name: "Rule Urgent request alert" })
    .getByRole("button", { name: "Delete rule", exact: true });
  await deleteRuleButton.click();
  const dialog = page.getByRole("alertdialog", {
    name: "Delete automation rule",
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(deleteRuleButton).toBeFocused();
  await expect(
    page.getByRole("article", { name: "Rule Urgent request alert" }),
  ).toBeVisible();
  await page
    .getByRole("article", { name: "Rule Urgent request alert" })
    .getByRole("button", { name: "Delete rule", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Delete rule", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "Rule Urgent request alert" }),
  ).toHaveCount(0);
});

test("runs one rule or all enabled rules against a dynamic schema record", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/bff/") && request.method() !== "GET")
      writes.push(request.url());
  });

  await page.getByRole("tab", { name: "Automation", exact: true }).click();
  await page.getByRole("button", { name: "Create rule", exact: true }).click();
  const editor = page.getByRole("form", { name: "Create automation rule" });
  await editor.getByLabel("Rule name", { exact: true }).fill("Start request");
  await editor
    .getByLabel("Trigger", { exact: true })
    .selectOption("new-record");
  await editor
    .getByLabel("Trigger module", { exact: true })
    .selectOption("sample-requests");
  await editor.getByLabel("Condition", { exact: true }).selectOption("always");
  await editor
    .getByLabel("Action", { exact: true })
    .selectOption("update-field");
  await editor
    .getByLabel("Action module", { exact: true })
    .selectOption("sample-requests");
  await editor
    .getByLabel("Action field", { exact: true })
    .selectOption("sample-field-Status");
  await editor
    .getByLabel("Action value", { exact: true })
    .selectOption({ label: "In progress" });
  await editor.getByRole("button", { name: "Save rule", exact: true }).click();

  await page.getByRole("tab", { name: "Simulation", exact: true }).click();
  await page
    .getByLabel("Schema module", { exact: true })
    .selectOption("sample-requests");
  await page
    .getByRole("button", { name: "Load sample records", exact: true })
    .click();
  await expect(
    page.getByLabel("Request number", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("Open");
  await page.getByLabel("Title", { exact: true }).fill("Generator inspection");
  await page
    .getByLabel("Rule selection", { exact: true })
    .selectOption({ label: "Start request" });
  await page
    .getByLabel("Simulation event", { exact: true })
    .selectOption("new-record");
  await page
    .getByRole("button", { name: "Run simulation", exact: true })
    .click();

  const trace = page.getByRole("region", { name: "Execution trace" });
  await expect(
    trace.getByRole("group", { name: "Start request · Matched", exact: true }),
  ).toBeVisible();
  await expect(trace).not.toContainText("Urgent request alert");
  await expect(
    page.getByRole("region", { name: "Before record" }),
  ).toContainText("Status: Open");
  await expect(
    page.getByRole("region", { name: "After record" }),
  ).toContainText("Status: In progress");

  await page
    .getByLabel("Rule selection", { exact: true })
    .selectOption("all-enabled");
  await page
    .getByRole("button", { name: "Run simulation", exact: true })
    .click();
  await expect(
    trace.getByRole("group", { name: "Start request · Matched", exact: true }),
  ).toBeVisible();
  await expect(
    trace.getByRole("group", {
      name: "Urgent request alert · Matched",
      exact: true,
    }),
  ).toBeVisible();
  expect(writes).toEqual([]);
});

test("simulation denies unrelated, read-only, and create-only roles for updates", async ({
  page,
}) => {
  await page.getByRole("tab", { name: "Automation", exact: true }).click();
  await page.getByRole("button", { name: "Create rule", exact: true }).click();
  const editor = page.getByRole("form", { name: "Create automation rule" });
  await editor
    .getByLabel("Rule name", { exact: true })
    .fill("Permission update");
  await editor
    .getByLabel("Trigger", { exact: true })
    .selectOption("new-record");
  await editor.getByLabel("Condition", { exact: true }).selectOption("always");
  await editor
    .getByLabel("Action", { exact: true })
    .selectOption("update-field");
  await editor
    .getByLabel("Action field", { exact: true })
    .selectOption("sample-field-Status");
  await editor
    .getByLabel("Action value", { exact: true })
    .selectOption({ label: "In progress" });
  await editor.getByRole("button", { name: "Save rule", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Rule Permission update" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored = JSON.parse(
          sessionStorage.getItem("openslate.sample.v1") ?? "{}",
        ) as Record<string, { present?: { rules?: Array<{ name?: string }> } }>;
        return stored["sandbox.design"]?.present?.rules?.some(
          (rule) => rule.name === "Permission update",
        );
      }),
    )
    .toBe(true);
  await page.evaluate(() => {
    const key = "openslate.sample.v1";
    const stored = JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<
      string,
      unknown
    >;
    stored["access-roles"] = [
      {
        id: "unrelated-role",
        name: "Unrelated module writer",
        builtin: false,
        grants: [
          "Department · Operations",
          "Module · Equipment",
          "Action · read",
          "Action · update",
        ],
      },
      {
        id: "read-role",
        name: "Read only tester",
        builtin: false,
        grants: [
          "Department · Operations",
          "Module · Service requests",
          "Action · read",
        ],
      },
      {
        id: "create-role",
        name: "Create only tester",
        builtin: false,
        grants: [
          "Department · Operations",
          "Module · Service requests",
          "Action · read",
          "Action · create",
        ],
      },
    ];
    sessionStorage.setItem(key, JSON.stringify(stored));
  });
  await page.reload();
  await page.getByRole("tab", { name: "Simulation", exact: true }).click();
  await page
    .getByRole("button", { name: "Load sample records", exact: true })
    .click();
  await page
    .getByLabel("Rule selection", { exact: true })
    .selectOption({ label: "Permission update" });
  await page
    .getByLabel("Simulation event", { exact: true })
    .selectOption("new-record");

  for (const [role, expected] of [
    ["Unrelated module writer", "cannot read the selected record module"],
    ["Read only tester", "does not have update access"],
    ["Create only tester", "does not have update access"],
  ] as const) {
    await page
      .getByLabel("Simulation role", { exact: true })
      .selectOption(role);
    await page
      .getByRole("button", { name: "Run simulation", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Execution trace" }).getByRole("group", {
        name: "Permission update · Error",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Execution trace" }),
    ).toContainText(expected);
  }
});

test("simulation test users apply their assigned roles and recover after deletion or reset", async ({
  page,
}) => {
  await page.getByRole("tab", { name: "Automation", exact: true }).click();
  await page.getByRole("button", { name: "Create rule", exact: true }).click();
  const editor = page.getByRole("form", { name: "Create automation rule" });
  await editor.getByLabel("Rule name", { exact: true }).fill("User update");
  await editor
    .getByLabel("Action", { exact: true })
    .selectOption("update-field");
  await editor
    .getByLabel("Action field", { exact: true })
    .selectOption("sample-field-Status");
  await editor
    .getByLabel("Action value", { exact: true })
    .selectOption({ label: "In progress" });
  await editor.getByRole("button", { name: "Save rule", exact: true }).click();

  await page.evaluate(() => {
    const key = "openslate.sample.v1";
    const stored = JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<
      string,
      unknown
    >;
    stored["access-roles"] = [
      {
        id: "writer",
        name: "Writer",
        builtin: false,
        grants: [
          "Department · Operations",
          "Module · Service requests",
          "Action · read",
          "Action · update",
        ],
      },
      {
        id: "reader",
        name: "Reader",
        builtin: false,
        grants: [
          "Department · Operations",
          "Module · Service requests",
          "Action · read",
        ],
      },
    ];
    sessionStorage.setItem(key, JSON.stringify(stored));
  });
  await page.reload();
  await page.getByRole("tab", { name: "Simulation", exact: true }).click();
  await page
    .getByLabel("Simulation role", { exact: true })
    .selectOption("Writer");
  await page.getByLabel("Test user name", { exact: true }).fill("Ari Writer");
  await page.getByRole("button", { name: "Create test user" }).click();
  await page
    .getByLabel("Simulation role", { exact: true })
    .selectOption("Reader");
  await page.getByLabel("Test user name", { exact: true }).fill("Remy Reader");
  await page.getByRole("button", { name: "Create test user" }).click();
  await page
    .getByRole("button", { name: "Load sample records", exact: true })
    .click();
  await page
    .getByLabel("Rule selection", { exact: true })
    .selectOption({ label: "User update" });

  const user = page.getByLabel("Test user", { exact: true });
  await user.selectOption({ label: "Ari Writer · Writer" });
  await expect(page.getByText("Running as Ari Writer · Writer")).toBeVisible();
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(
    page
      .getByRole("region", { name: "Execution trace" })
      .getByRole("group", { name: "User update · Matched", exact: true }),
  ).toBeVisible();

  await user.selectOption({ label: "Remy Reader · Reader" });
  await expect(page.getByText("Running as Remy Reader · Reader")).toBeVisible();
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(
    page.getByRole("region", { name: "Execution trace" }),
  ).toContainText("Reader does not have update access");
  await page
    .getByRole("button", { name: "Delete test user Remy Reader" })
    .click();
  await expect(user).toHaveValue("role-only");
  await expect(
    page.getByText("Using role-only simulation · Reader"),
  ).toBeVisible();

  await user.selectOption({ label: "Ari Writer · Writer" });
  await page.getByRole("button", { name: "Reset simulation" }).click();
  await expect(user).toHaveValue("role-only");
  await expect(user.getByRole("option")).toHaveCount(1);
});

test("simulation reports typed field errors without discarding the draft value", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Select module Customers", exact: true })
    .click();
  if ((page.viewportSize()?.width ?? 0) < 1280)
    await page
      .getByRole("button", { name: "Inspect selected", exact: true })
      .click();
  const emailSettings = page.getByRole("region", {
    name: "Email field settings",
    exact: true,
  });
  const showEmailSettings = emailSettings.getByRole("button", {
    name: "Show Email settings",
    exact: true,
  });
  if (await showEmailSettings.isVisible()) await showEmailSettings.click();
  await emailSettings
    .getByRole("combobox", { name: "Email field type", exact: true })
    .selectOption("Email");
  await emailSettings
    .getByRole("button", { name: "Save field changes", exact: true })
    .click();
  await page.getByRole("tab", { name: "Simulation", exact: true }).click();
  await page
    .getByLabel("Schema module", { exact: true })
    .selectOption("sample-customers");
  await page
    .getByRole("button", { name: "Load sample records", exact: true })
    .click();
  const email = page.getByLabel("Email", { exact: true });
  await email.fill("not-an-email");
  await page
    .getByRole("button", { name: "Run simulation", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Execution trace" }),
  ).toContainText("Email must be a valid email address");
  await expect(email).toHaveValue("not-an-email");
});
