import { expect, test } from "../coverage";
import type { Locator, Page } from "@playwright/test";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";

type StoredField = {
  id: string;
  type: string;
  required: boolean;
  value: string;
  options: string;
  config?: Record<string, unknown>;
};

type StoredSnapshot = {
  past: unknown[];
  present: {
    modules: Array<{ id: string; fields: StoredField[] }>;
  };
};

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
});

function fieldEditor(page: Page, name: string): Locator {
  return page.getByRole("region", {
    name: `${name} field settings`,
    exact: true,
  });
}

async function openField(page: Page, name: string): Promise<Locator> {
  const editor = fieldEditor(page, name);
  const show = editor.getByRole("button", {
    name: `Show ${name} settings`,
    exact: true,
  });
  if (await show.isVisible()) await show.click();
  return editor;
}

async function storedSnapshot(page: Page): Promise<StoredSnapshot> {
  return page.evaluate(() => {
    const root = JSON.parse(
      sessionStorage.getItem("openslate.sample.v1") ?? "{}",
    ) as Record<string, unknown>;
    return root["sandbox.design"] as StoredSnapshot;
  });
}

async function storedField(
  page: Page,
  moduleId: string,
  fieldId: string,
): Promise<StoredField> {
  const snapshot = await storedSnapshot(page);
  const sandboxModule = snapshot.present.modules.find(
    (item) => item.id === moduleId,
  );
  const field = sandboxModule?.fields.find((item) => item.id === fieldId);
  if (!field) throw new Error(`Stored field ${fieldId} was not found`);
  return field;
}

async function saveAndExpectOneStep(
  page: Page,
  editor: Locator,
  expectedType: string,
): Promise<StoredField> {
  const before = (await storedSnapshot(page)).past.length;
  await editor
    .getByRole("button", { name: "Save field changes", exact: true })
    .click();
  await expect
    .poll(async () => (await storedSnapshot(page)).past.length)
    .toBe(before + 1);
  await expect
    .poll(async () =>
      storedField(page, "sample-requests", "sample-field-Title").then(
        (field) => field.type,
      ),
    )
    .toBe(expectedType);
  return storedField(page, "sample-requests", "sample-field-Title");
}

test("new field creation retains invalid typed defaults without changing the design", async ({
  page,
}) => {
  const historyStatus = page.getByText(/Tab-local draft/);
  await expect(historyStatus).toContainText("0 undo steps available");
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await page.getByLabel("Field name", { exact: true }).fill("Invalid amount");
  await page.getByLabel("Field type", { exact: true }).selectOption("Number");
  await page.getByLabel("Default value", { exact: true }).fill("not-a-number");
  await page.getByRole("button", { name: "Create field", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "Create field", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Number settings must contain valid numbers.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(historyStatus).toContainText("0 undo steps available");
});

test("Designer saves all ten canonical field types with their native controls and defaults", async ({
  page,
}) => {
  const editor = await openField(page, "Title");
  const type = page.getByRole("combobox", {
    name: "Title field type",
    exact: true,
  });
  await expect(type.locator("option")).toHaveText([
    "Text",
    "Long text",
    "Number",
    "Integer",
    "Date",
    "Date/Time",
    "Checkbox",
    "Select",
    "Email",
    "URL",
  ]);
  await editor.getByRole("checkbox", { name: "Required", exact: true }).click();

  for (const [fieldType, expectedKind, defaultValue, maximumLength] of [
    ["Text", "text", "Short note", "120"],
    ["Long text", "long-text", "Long note", "1000"],
    ["Email", "email", "operator@example.com", "160"],
    ["URL", "url", "https://example.com/request", "240"],
  ] as const) {
    await type.selectOption(fieldType);
    const defaultInput = editor.getByLabel("Title default value", {
      exact: true,
    });
    await expect(defaultInput).toHaveAttribute("type", "text");
    await defaultInput.fill(defaultValue);
    const maxLength = editor.getByLabel("Title maximum length", {
      exact: true,
    });
    await expect(maxLength).toHaveAttribute("type", "number");
    await expect(maxLength).toHaveAttribute("min", "1");
    await maxLength.fill(maximumLength);
    const saved = await saveAndExpectOneStep(page, editor, fieldType);
    expect(saved.required).toBe(true);
    expect(saved.config).toEqual({
      kind: expectedKind,
      defaultValue,
      maxLength: Number(maximumLength),
    });
  }

  await type.selectOption("Number");
  await expect(editor.getByLabel("Title default value")).toHaveAttribute(
    "type",
    "number",
  );
  await editor.getByLabel("Title default value").fill("12.5");
  await editor.getByLabel("Title minimum").fill("0");
  await editor.getByLabel("Title maximum").fill("100");
  await editor.getByLabel("Title step").fill("0.5");
  expect((await saveAndExpectOneStep(page, editor, "Number")).config).toEqual({
    kind: "number",
    defaultValue: 12.5,
    min: 0,
    max: 100,
    step: 0.5,
  });

  await type.selectOption("Integer");
  await editor.getByLabel("Title default value").fill("12");
  await editor.getByLabel("Title minimum").fill("0");
  await editor.getByLabel("Title maximum").fill("100");
  await expect(editor.getByLabel("Title step")).toBeDisabled();
  await expect(editor.getByLabel("Title step")).toHaveValue("1");
  expect((await saveAndExpectOneStep(page, editor, "Integer")).config).toEqual({
    kind: "integer",
    defaultValue: 12,
    min: 0,
    max: 100,
    step: 1,
  });

  for (const [
    fieldType,
    inputType,
    expectedKind,
    defaultValue,
    earliest,
    latest,
  ] of [
    ["Date", "date", "date", "2026-09-12", "2026-01-01", "2026-12-31"],
    [
      "Date/Time",
      "datetime-local",
      "datetime",
      "2026-09-12T10:30",
      "2026-01-01T00:00",
      "2026-12-31T23:59",
    ],
  ] as const) {
    await type.selectOption(fieldType);
    await expect(editor.getByLabel("Title default value")).toHaveAttribute(
      "type",
      inputType,
    );
    await editor.getByLabel("Title default value").fill(defaultValue);
    await editor.getByLabel("Title earliest").fill(earliest);
    await editor.getByLabel("Title latest").fill(latest);
    expect(
      (await saveAndExpectOneStep(page, editor, fieldType)).config,
    ).toEqual({
      kind: expectedKind,
      defaultValue,
      earliest,
      latest,
    });
  }

  await type.selectOption("Checkbox");
  await expect(
    editor.getByLabel("Title default value", { exact: true }),
  ).toHaveCount(0);
  await editor
    .getByRole("checkbox", { name: "Title default checked", exact: true })
    .click();
  expect((await saveAndExpectOneStep(page, editor, "Checkbox")).config).toEqual(
    { kind: "checkbox", defaultValue: true },
  );

  await type.selectOption("Select");
  await editor.getByLabel("Title options").fill(" Open , Closed ");
  await editor.getByLabel("Title default value").fill(" Closed ");
  expect((await saveAndExpectOneStep(page, editor, "Select")).config).toEqual({
    kind: "select",
    defaultValue: "Closed",
    options: ["Open", "Closed"],
  });
});

test("invalid typed drafts remain visible without creating a history step", async ({
  page,
}) => {
  const editor = await openField(page, "Title");
  const type = page.getByRole("combobox", {
    name: "Title field type",
    exact: true,
  });
  const startingSteps = (await storedSnapshot(page)).past.length;

  await editor.getByLabel("Title maximum length").fill("1001");
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Maximum length must be a whole number between 1 and 1000",
  );
  await expect(editor.getByLabel("Title maximum length")).toHaveValue("1001");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  await type.selectOption("Email");
  await editor.getByLabel("Title default value").fill("not-an-email");
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Enter a valid email address",
  );
  await expect(editor.getByLabel("Title default value")).toHaveValue(
    "not-an-email",
  );
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  await type.selectOption("URL");
  await editor.getByLabel("Title default value").fill("ftp://example.com");
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Enter a valid HTTP or HTTPS URL",
  );
  await expect(editor.getByLabel("Title default value")).toHaveValue(
    "ftp://example.com",
  );
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  await type.selectOption("Number");
  await editor.getByLabel("Title default value").fill("11");
  await editor.getByLabel("Title minimum").fill("1");
  await editor.getByLabel("Title maximum").fill("10");
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Default value must be within the minimum and maximum",
  );
  await expect(editor.getByLabel("Title default value")).toHaveValue("11");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  await type.selectOption("Number");
  await editor.getByLabel("Title step").fill("0");
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Step must be positive",
  );
  await expect(editor.getByLabel("Title step")).toHaveValue("0");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  await type.selectOption("Number");
  await editor.getByLabel("Title default value").fill("1.5");
  await editor.getByLabel("Title step").fill("1");
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Default value must align with the configured step",
  );
  await expect(editor.getByLabel("Title default value")).toHaveValue("1.5");
  await expect(editor.getByLabel("Title step")).toHaveValue("1");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  await type.selectOption("Number");
  await editor.getByLabel("Title minimum").fill("10");
  await editor.getByLabel("Title maximum").fill("2");
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Minimum cannot exceed maximum",
  );
  await expect(editor.getByLabel("Title minimum")).toHaveValue("10");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  await type.selectOption("Integer");
  await editor.getByLabel("Title default value").fill("1.5");
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Integer settings must use whole numbers",
  );
  await expect(editor.getByLabel("Title default value")).toHaveValue("1.5");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  await type.selectOption("Date");
  await editor.getByLabel("Title default value").fill("2027-01-01");
  await editor.getByLabel("Title earliest").fill("2026-01-01");
  await editor.getByLabel("Title latest").fill("2026-12-31");
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Default value must be within the earliest and latest limits",
  );
  await expect(editor.getByLabel("Title default value")).toHaveValue(
    "2027-01-01",
  );
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  await type.selectOption("Date/Time");
  await editor.getByLabel("Title default value").fill("2027-01-01T00:00");
  await editor.getByLabel("Title earliest").fill("2026-01-01T00:00");
  await editor.getByLabel("Title latest").fill("2026-12-31T23:59");
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Default value must be within the earliest and latest limits",
  );
  await expect(editor.getByLabel("Title default value")).toHaveValue(
    "2027-01-01T00:00",
  );
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  await type.selectOption("Select");
  const tooManyOptions = Array.from(
    { length: 101 },
    (_, index) => `Option ${index}`,
  ).join(",");
  await editor.getByLabel("Title options").fill(tooManyOptions);
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Select fields support up to 100 options",
  );
  await expect(editor.getByLabel("Title options")).toHaveValue(tooManyOptions);
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  await type.selectOption("Select");
  const longOption = "x".repeat(101);
  await editor.getByLabel("Title options").fill(longOption);
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Each select option must be 100 characters or fewer",
  );
  await expect(editor.getByLabel("Title options")).toHaveValue(longOption);
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  await type.selectOption("Select");
  await editor.getByLabel("Title options").fill("Open, Open");
  await editor.getByLabel("Title default value").fill("Open");
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Select options must be unique",
  );
  await expect(editor.getByLabel("Title options")).toHaveValue("Open, Open");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  await type.selectOption("Select");
  await editor.getByLabel("Title options").fill("Open, Closed");
  await editor.getByLabel("Title default value").fill("Missing");
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Default value must match a select option",
  );
  await expect(editor.getByLabel("Title default value")).toHaveValue("Missing");

  expect((await storedSnapshot(page)).past).toHaveLength(startingSteps);
  expect(
    await storedField(page, "sample-requests", "sample-field-Title"),
  ).toMatchObject({ type: "Text", required: false, value: "", options: "" });
});

test("saved type changes remove stale configuration and one Undo restores it", async ({
  page,
}) => {
  const editor = await openField(page, "Status");
  const type = page.getByRole("combobox", {
    name: "Status field type",
    exact: true,
  });

  const beforeSelect = (await storedSnapshot(page)).past.length;
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect
    .poll(async () => (await storedSnapshot(page)).past.length)
    .toBe(beforeSelect + 1);
  expect(
    (await storedField(page, "sample-requests", "sample-field-Status")).config,
  ).toEqual({
    kind: "select",
    defaultValue: null,
    options: ["Open", "In progress", "Complete"],
  });

  await type.selectOption("Number");
  await editor.getByLabel("Status default value").fill("5");
  await editor.getByLabel("Status minimum").fill("1");
  await editor.getByLabel("Status maximum").fill("10");
  await editor.getByLabel("Status step").fill("0.5");
  const beforeNumber = (await storedSnapshot(page)).past.length;
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect
    .poll(async () => (await storedSnapshot(page)).past.length)
    .toBe(beforeNumber + 1);
  const numberField = await storedField(
    page,
    "sample-requests",
    "sample-field-Status",
  );
  expect(numberField.options).toBe("");
  expect(numberField.config).toEqual({
    kind: "number",
    defaultValue: 5,
    min: 1,
    max: 10,
    step: 0.5,
  });

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(async () =>
      storedField(page, "sample-requests", "sample-field-Status").then(
        (field) => field.type,
      ),
    )
    .toBe("Select");
  expect(
    (await storedField(page, "sample-requests", "sample-field-Status")).config,
  ).toEqual({
    kind: "select",
    defaultValue: null,
    options: ["Open", "In progress", "Complete"],
  });

  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(type).toHaveValue("Number");
  const beforeText = (await storedSnapshot(page)).past.length;
  await type.selectOption("Text");
  await editor.getByLabel("Status default value").fill("Ready");
  await editor.getByRole("button", { name: "Save field changes" }).click();
  await expect
    .poll(async () => (await storedSnapshot(page)).past.length)
    .toBe(beforeText + 1);
  const textField = await storedField(
    page,
    "sample-requests",
    "sample-field-Status",
  );
  expect(textField.config).toEqual({
    kind: "text",
    defaultValue: "Ready",
  });
  expect(textField.options).toBe("");

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(async () =>
      storedField(page, "sample-requests", "sample-field-Status").then(
        (field) => field.type,
      ),
    )
    .toBe("Number");
  expect(
    (await storedField(page, "sample-requests", "sample-field-Status")).config,
  ).toEqual(numberField.config);
});
