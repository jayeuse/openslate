import { expect, test } from "../coverage";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";
import { initialSandboxHistory } from "../../../src/components/sample/sandbox/model";

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

const field = (
  id: string,
  name: string,
  type: string,
  config: Record<string, unknown>,
) => ({
  id,
  name,
  type,
  required: false,
  value: "",
  options: "",
  closed: false,
  config,
});

test("preview renders every canonical field type in explicit desktop and mobile modes", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/bff/") && request.method() !== "GET")
      writes.push(request.url());
  });
  const imported = {
    kind: "openslate-sandbox",
    schemaVersion: 1,
    design: {
      departments: [
        { id: "sample-operations", name: "Operations", closed: false },
      ],
      modules: [
        {
          id: "sample-requests",
          department: "sample-operations",
          name: "Service requests",
          closed: false,
          x: 0,
          y: 0,
          fields: [
            field("text", "Text value", "Text", {
              kind: "text",
              defaultValue: "Short text",
              maxLength: 80,
            }),
            field("long", "Long value", "Long text", {
              kind: "long-text",
              defaultValue: "Long text",
            }),
            field("number", "Number value", "Number", {
              kind: "number",
              defaultValue: 2.5,
              min: 0,
              max: 10,
              step: 0.5,
            }),
            field("integer", "Integer value", "Integer", {
              kind: "integer",
              defaultValue: 3,
              min: 0,
              max: 10,
              step: 1,
            }),
            field("date", "Date value", "Date", {
              kind: "date",
              defaultValue: "2026-09-12",
            }),
            field("datetime", "Date time value", "Date/Time", {
              kind: "datetime",
              defaultValue: "2026-09-12T09:30",
            }),
            field("check", "Checkbox value", "Checkbox", {
              kind: "checkbox",
              defaultValue: true,
            }),
            field("select", "Select value", "Select", {
              kind: "select",
              defaultValue: "Open",
              options: ["Open", "Closed"],
            }),
            field("email", "Email value", "Email", {
              kind: "email",
              defaultValue: "sample@example.invalid",
            }),
            field("url", "URL value", "URL", {
              kind: "url",
              defaultValue: "https://example.invalid",
            }),
          ],
        },
      ],
      relationships: [],
      rules: [],
    },
  };
  await page
    .getByRole("button", { name: "Import or export", exact: true })
    .click();
  const portability = page.getByRole("dialog", {
    name: "Sandbox import and export",
  });
  await portability
    .getByLabel("Import sandbox JSON", { exact: true })
    .setInputFiles({
      name: "types.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(imported)),
    });
  await portability
    .getByRole("button", { name: "Replace sandbox", exact: true })
    .click();

  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh Preview", exact: true })
    .click();
  const preview = page.getByRole("region", {
    name: "Workspace preview canvas",
  });
  await expect(page.getByRole("note")).toContainText(
    "Synthetic sample-role preview only. It does not enforce or prove server authorization.",
  );
  await expect(
    preview.getByLabel("Text value", { exact: true }),
  ).toHaveAttribute("type", "text");
  await expect(preview.getByLabel("Long value", { exact: true })).toHaveRole(
    "textbox",
  );
  await expect(
    preview.getByLabel("Long value", { exact: true }),
  ).toHaveJSProperty("tagName", "TEXTAREA");
  await expect(
    preview.getByLabel("Number value", { exact: true }),
  ).toHaveAttribute("type", "number");
  await expect(
    preview.getByLabel("Integer value", { exact: true }),
  ).toHaveAttribute("step", "1");
  await expect(
    preview.getByLabel("Date value", { exact: true }),
  ).toHaveAttribute("type", "date");
  await expect(
    preview.getByLabel("Date time value", { exact: true }),
  ).toHaveAttribute("type", "datetime-local");
  await expect(
    preview.getByRole("checkbox", { name: "Checkbox value", exact: true }),
  ).toBeChecked();
  await expect(preview.getByLabel("Select value", { exact: true })).toHaveValue(
    "Open",
  );
  await expect(
    preview.getByLabel("Email value", { exact: true }),
  ).toHaveAttribute("type", "email");
  await expect(
    preview.getByLabel("URL value", { exact: true }),
  ).toHaveAttribute("type", "url");
  await page
    .getByLabel("Preview layout", { exact: true })
    .selectOption("mobile");
  await expect(preview).toContainText("Mobile layout");
  await page.getByLabel("Preview role", { exact: true }).selectOption("Member");
  await expect(
    preview.getByLabel("Text value", { exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("note")).toBeVisible();
  expect(writes).toEqual([]);
});

test("warning-only local releases list the warning and allow explicit confirmation", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "One desktop release review is sufficient",
  );
  await page
    .getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Connect modules", exact: true })
    .click();
  const relationship = page.getByRole("dialog", { name: "Connect modules" });
  await relationship
    .getByLabel("Relationship name", { exact: true })
    .fill("Requested by customer");
  await relationship
    .getByLabel("Target module", { exact: true })
    .selectOption("sample-customers");
  await relationship
    .getByRole("button", { name: "Create relationship", exact: true })
    .click();

  await page.getByRole("button", { name: "Create local release" }).click();
  const review = page.getByRole("dialog", { name: "Review local release" });
  await expect(review).toContainText("0 errors · 1 warning");
  await expect(review).toContainText(
    "Relationship crosses departments; review access and ownership",
  );
  await expect(
    review.getByRole("button", { name: "Confirm local release" }),
  ).toBeEnabled();
  await review.getByRole("button", { name: "Confirm local release" }).click();
  await expect(
    page.getByRole("article", { name: /Local release 2/ }),
  ).toBeVisible();
});

test("Preview remains a coherent snapshot until it is explicitly refreshed", async ({
  page,
}) => {
  const structure = page.getByRole("complementary", {
    name: "Organization structure",
  });
  await structure
    .getByRole("button", { name: "Select department Operations", exact: true })
    .dblclick();
  const rename = page.getByRole("textbox", {
    name: "Edit department name",
    exact: true,
  });
  await rename.fill("Field operations");
  await rename.press("Enter");
  await page.getByRole("button", { name: "Undo", exact: true }).click();

  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByLabel("Preview role", { exact: true }).selectOption("Member");
  const preview = page.getByRole("region", {
    name: "Workspace preview canvas",
  });
  await expect(
    preview.getByRole("article", { name: "Service requests", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(
    preview.getByRole("article", { name: "Service requests", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Member · Read only", { exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Refresh Preview", exact: true })
    .click();
  await expect(
    preview.getByRole("article", { name: "Service requests", exact: true }),
  ).toHaveCount(0);
});

test("invalid designs report export failures without an uncaught page error", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const history = structuredClone(initialSandboxHistory);
  history.present.modules[0].department = "missing-department";
  await page.addInitScript((value) => {
    sessionStorage.setItem(
      "openslate.sample.v1",
      JSON.stringify({ "sandbox.design": value }),
    );
  }, history);
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Module department does not exist",
      exact: true,
    }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Import or export", exact: true })
    .click();
  const portability = page.getByRole("dialog", {
    name: "Sandbox import and export",
  });
  await portability
    .getByRole("button", { name: "Export JSON", exact: true })
    .click();
  await expect(portability.getByRole("alert")).toContainText(
    "Module department does not exist",
  );
  expect(pageErrors).toEqual([]);
});

test("version actions name their target, restore focus, and undo a deletion in order", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Create checkpoint" }).click();
  const checkpoint = page.getByRole("dialog", { name: "Create checkpoint" });
  await checkpoint.getByLabel("Checkpoint name").fill("Safety checkpoint");
  await checkpoint.getByRole("button", { name: "Save checkpoint" }).click();
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  const card = page.getByRole("article", { name: "Safety checkpoint" });
  const deleteButton = card.getByRole("button", { name: "Delete version" });

  await deleteButton.click();
  let dialog = page.getByRole("alertdialog", {
    name: "Delete Safety checkpoint?",
  });
  await expect(dialog).toContainText(
    "Delete the checkpoint Safety checkpoint from this tab?",
  );
  await dialog.getByRole("button", { name: "Cancel deletion" }).click();
  await expect(deleteButton).toBeFocused();

  await deleteButton.click();
  dialog = page.getByRole("alertdialog", {
    name: "Delete Safety checkpoint?",
  });
  await dialog
    .getByRole("button", { name: "Delete Safety checkpoint" })
    .click();
  await expect(card).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Versions & local release history" }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Undo delete Safety checkpoint" })
    .click();
  await expect(card).toBeVisible();
  const versionLabels = await page
    .locator("article[aria-label] > div:first-child > h3")
    .allTextContents();
  expect(versionLabels[0]).toBe("Safety checkpoint");

  const restoreButton = card.getByRole("button", { name: "Restore version" });
  await restoreButton.click();
  const restore = page.getByRole("alertdialog", {
    name: "Restore Safety checkpoint?",
  });
  await expect(restore).toContainText(
    "Restore the draft from Safety checkpoint?",
  );
  await restore.getByRole("button", { name: "Cancel restore" }).click();
  await expect(restoreButton).toBeFocused();
});

test("a new version invalidates stale deleted-version recovery", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Create checkpoint" }).click();
  let checkpoint = page.getByRole("dialog", { name: "Create checkpoint" });
  await checkpoint.getByLabel("Checkpoint name").fill("Version seed");
  await checkpoint.getByRole("button", { name: "Save checkpoint" }).click();
  await page.evaluate(() => {
    const key = "openslate.sample.v1";
    const stored = JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<
      string,
      unknown
    >;
    const base = structuredClone(
      (stored["sandbox.versions"] as Array<Record<string, unknown>>)[0],
    );
    stored["sandbox.versions"] = Array.from({ length: 50 }, (_, index) => ({
      ...structuredClone(base),
      id: `checkpoint-${index}`,
      label: `Checkpoint ${index}`,
      published: false,
      date: "Synthetic checkpoint",
    }));
    sessionStorage.setItem(key, JSON.stringify(stored));
  });
  await page.reload();
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  const removed = page.getByRole("article", { name: "Checkpoint 10" });
  await removed.getByRole("button", { name: "Delete version" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete Checkpoint 10?" })
    .getByRole("button", { name: "Delete Checkpoint 10" })
    .click();
  const staleUndo = page.getByRole("button", {
    name: "Undo delete Checkpoint 10",
  });
  await expect(staleUndo).toBeVisible();

  await page.getByRole("button", { name: "Create checkpoint" }).click();
  checkpoint = page.getByRole("dialog", { name: "Create checkpoint" });
  await checkpoint.getByLabel("Checkpoint name").fill("New checkpoint");
  await checkpoint.getByRole("button", { name: "Save checkpoint" }).click();

  await expect(staleUndo).toHaveCount(0);
  await expect(
    page.getByRole("article", { name: "New checkpoint" }),
  ).toBeVisible();
  await expect(removed).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored = JSON.parse(
          sessionStorage.getItem("openslate.sample.v1") ?? "{}",
        ) as Record<string, unknown[]>;
        return stored["sandbox.versions"].length;
      }),
    )
    .toBe(50);
});

test("rollback confirmation stays undoable and caps release history at fifty", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Create local release" }).click();
  await page
    .getByRole("dialog", { name: "Review local release" })
    .getByRole("button", { name: "Confirm local release" })
    .click();
  await page.getByRole("tab", { name: "Designer", exact: true }).click();
  await page.getByRole("button", { name: "Add department" }).click();
  await page.getByLabel("Department name").fill("Rollback marker");
  await page.getByRole("button", { name: "Create department" }).click();
  await page.evaluate(() => {
    const key = "openslate.sample.v1";
    const stored = JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<
      string,
      unknown
    >;
    const initial = structuredClone(
      (stored["sandbox.versions"] as Array<Record<string, unknown>>)[0],
    );
    stored["sandbox.versions"] = Array.from({ length: 50 }, (_, index) => ({
      ...structuredClone(initial),
      id: `release-${index}`,
      label: `Release ${index}`,
      published: true,
      date: "Synthetic release",
    }));
    sessionStorage.setItem(key, JSON.stringify(stored));
  });
  await page.reload();
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  const rollback = page.getByRole("button", {
    name: "Roll back previous local release",
  });
  await rollback.click();
  let dialog = page.getByRole("alertdialog", {
    name: "Roll back to Release 48?",
  });
  await expect(dialog).toContainText(
    "Roll back the draft to Release 48 and create a new local release snapshot?",
  );
  await dialog.getByRole("button", { name: "Cancel rollback" }).click();
  await expect(rollback).toBeFocused();

  await rollback.click();
  dialog = page.getByRole("alertdialog", {
    name: "Roll back to Release 48?",
  });
  await dialog.getByRole("button", { name: "Roll back to Release 48" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored = JSON.parse(
          sessionStorage.getItem("openslate.sample.v1") ?? "{}",
        ) as Record<string, Array<{ label: string }>>;
        const versions = stored["sandbox.versions"];
        return { count: versions.length, last: versions.at(-1)?.label };
      }),
    )
    .toEqual({ count: 50, last: "Rollback to Release 48" });
  await page.getByRole("tab", { name: "Designer", exact: true }).click();
  const marker = page.getByRole("button", {
    name: "Select department Rollback marker",
  });
  await expect(marker).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(marker).toBeVisible();
});

test("local release requires a local-only review with issues and optional notes", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Create local release", exact: true })
    .click();
  const review = page.getByRole("dialog", { name: "Review local release" });
  await expect(review).toContainText("No live workspace will be changed");
  await expect(review).toContainText("0 errors · 0 warnings");
  await review
    .getByRole("textbox", { name: "Release note", exact: true })
    .fill("Ready for tab-local review");
  await review
    .getByRole("button", { name: "Cancel release", exact: true })
    .click();
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  await expect(
    page.getByText("Ready for tab-local review", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Create local release", exact: true })
    .click();
  await review
    .getByRole("textbox", { name: "Release note", exact: true })
    .fill("Ready for tab-local review");
  await review
    .getByRole("button", { name: "Confirm local release", exact: true })
    .click();

  const release = page.getByRole("article", { name: /Local release 2/ });
  await expect(release).toContainText("Local release");
  await expect(release).toContainText("Ready for tab-local review");
  await expect(release.getByRole("textbox")).toHaveCount(0);
  await expect(
    release.getByRole("button", { name: "Edit checkpoint label" }),
  ).toHaveCount(0);
});

test("oversized imports are rejected before staging and retain the current design", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Import or export", exact: true })
    .click();
  const portability = page.getByRole("dialog", {
    name: "Sandbox import and export",
  });
  await portability
    .getByLabel("Import sandbox JSON", { exact: true })
    .setInputFiles({
      name: "oversized.json",
      mimeType: "application/json",
      buffer: Buffer.alloc(2 * 1024 * 1024 + 1, "x"),
    });
  await expect(portability.getByRole("alert")).toHaveText(
    "Sandbox file exceeds the 2 MiB limit",
  );
  await expect(
    portability.getByRole("button", { name: "Replace sandbox", exact: true }),
  ).toHaveCount(0);
  await portability.press("Escape");
  await expect(
    page.getByRole("button", { name: "Select department Operations" }),
  ).toBeVisible();
});

test("global history shortcuts use semantic undo and ignore forms and dialogs", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Add department", exact: true })
    .click();
  await page
    .getByLabel("Department name", { exact: true })
    .fill("Shortcut services");
  await page
    .getByRole("button", { name: "Create department", exact: true })
    .click();
  const department = page.getByRole("button", {
    name: "Select department Shortcut services",
  });
  await expect(department).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(department).toHaveCount(0);
  await page.keyboard.press("Control+Shift+z");
  await expect(department).toBeVisible();

  await page.getByRole("button", { name: "Reset design", exact: true }).click();
  const reset = page.getByRole("alertdialog", { name: "Reset design?" });
  await page.keyboard.press("Control+z");
  await reset
    .getByRole("button", { name: "Cancel reset", exact: true })
    .click();
  await expect(department).toBeVisible();

  await page
    .getByRole("button", { name: "Create checkpoint", exact: true })
    .click();
  const checkpoint = page.getByRole("dialog", { name: "Create checkpoint" });
  await checkpoint
    .getByRole("textbox", { name: "Checkpoint name", exact: true })
    .fill("Typing stays local");
  await page.keyboard.press("Control+z");
  await checkpoint.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(department).toBeVisible();
});

test("versions compare semantic changes and reject an invalid restore atomically", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Add department", exact: true })
    .click();
  await page
    .getByLabel("Department name", { exact: true })
    .fill("Field services");
  await page
    .getByRole("button", { name: "Create department", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create checkpoint", exact: true })
    .click();
  const checkpoint = page.getByRole("dialog", { name: "Create checkpoint" });
  await checkpoint
    .getByLabel("Checkpoint name", { exact: true })
    .fill("Field services draft");
  await checkpoint
    .getByLabel("Checkpoint note", { exact: true })
    .fill("Added the dispatch department");
  await checkpoint
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .click();
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  const card = page.getByRole("article", { name: "Field services draft" });
  await expect(card).toContainText("Checkpoint");
  await expect(card).toContainText("Added the dispatch department");
  await expect(card.getByRole("textbox")).toHaveCount(0);
  await card
    .getByRole("button", { name: "Edit checkpoint label", exact: true })
    .click();
  const labelEditor = card.getByRole("form", {
    name: "Edit checkpoint label Field services draft",
  });
  await labelEditor
    .getByRole("textbox", { name: "Checkpoint label", exact: true })
    .fill("   ");
  await labelEditor
    .getByRole("button", { name: "Save label", exact: true })
    .click();
  await expect(labelEditor.getByRole("alert")).toHaveText(
    "Checkpoint label is required",
  );
  await expect(
    labelEditor.getByRole("textbox", { name: "Checkpoint label", exact: true }),
  ).toHaveValue("   ");
  await labelEditor
    .getByRole("button", { name: "Cancel label edit", exact: true })
    .click();
  await expect(card).toContainText("Field services draft");

  await page
    .getByRole("combobox", { name: "Compare first version", exact: true })
    .selectOption({ label: "Starting structure" });
  await page
    .getByRole("combobox", { name: "Compare second version", exact: true })
    .selectOption({ label: "Field services draft" });
  await page.getByRole("button", { name: "Compare versions" }).click();
  const comparison = page.getByRole("region", { name: "Version comparison" });
  await expect(comparison).toContainText("Department added: Field services");

  await card
    .getByRole("button", { name: "Edit checkpoint label", exact: true })
    .click();
  await card
    .getByRole("textbox", { name: "Checkpoint label", exact: true })
    .fill("Field services ready");
  await card.getByRole("button", { name: "Save label", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Field services ready" }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Field services ready" }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Designer", exact: true }).click();
  await page
    .getByRole("button", { name: "Add department", exact: true })
    .click();
  await page
    .getByLabel("Department name", { exact: true })
    .fill("Temporary planning");
  await page
    .getByRole("button", { name: "Create department", exact: true })
    .click();
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  await page
    .getByRole("article", { name: "Field services ready" })
    .getByRole("button", { name: "Restore version", exact: true })
    .click();
  let restore = page.getByRole("alertdialog", {
    name: "Restore Field services ready?",
  });
  await restore
    .getByRole("button", { name: "Restore Field services ready", exact: true })
    .click();
  await page.getByRole("tab", { name: "Designer", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Select department Temporary planning" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Select department Temporary planning" }),
  ).toBeVisible();

  await page.evaluate(() => {
    const key = "openslate.sample.v1";
    const stored = JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<
      string,
      unknown
    >;
    const versions = structuredClone(stored["sandbox.versions"]) as Array<{
      id: string;
      label: string;
      design: {
        modules: Array<{ department: string }>;
      };
      published: boolean;
      date: string;
    }>;
    const invalid = structuredClone(versions.at(-1)!);
    invalid.id = "invalid-version";
    invalid.label = "Invalid stored snapshot";
    invalid.design.modules[0].department = "missing-department";
    invalid.published = false;
    invalid.date = "Synthetic corruption";
    versions.push(invalid);
    stored["sandbox.versions"] = versions;
    sessionStorage.setItem(key, JSON.stringify(stored));
  });
  await page.reload();
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  await page
    .getByRole("article", { name: "Invalid stored snapshot" })
    .getByRole("button", { name: "Restore version", exact: true })
    .click();
  restore = page.getByRole("alertdialog", {
    name: "Restore Invalid stored snapshot?",
  });
  await restore
    .getByRole("button", {
      name: "Restore Invalid stored snapshot",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Snapshot could not be restored", { exact: false }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Designer", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Select department Temporary planning" }),
  ).toBeVisible();
});
