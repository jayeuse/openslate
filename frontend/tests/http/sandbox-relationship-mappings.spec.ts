import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { migrateSandboxFileV1 } from "../../src/components/systems/sandbox/domain/document";
import {
  initialDesign,
  type Design,
} from "../../src/components/systems/sandbox/domain/model";
import { configuredSandboxDesign } from "../helpers/sandbox-fixtures";

type SandboxOptions = {
  importFailure?: string;
  saveFailure?: string;
  clearTestsFailure?: string;
  discardRefreshFailure?: string;
  discardRefreshDelay?: Promise<void>;
  hasUnpublishedChanges?: boolean;
  publishedHash?: string | null;
  testRuns?: unknown[];
  saveDelay?: Promise<void>;
  publicationDelay?: Promise<void>;
  issues?: Array<{ code: string; message: string; targetId: string | null }>;
  versionMutationDelay?: Promise<void>;
  versions?: Array<Record<string, unknown>>;
};

function configuredDesignWithLegacyMapping(): Design {
  const design = structuredClone(configuredSandboxDesign);
  const relationship = design.relationships[0];
  if (!relationship) throw new Error("configured relationship is unavailable");
  relationship.fieldMappings = [
    {
      sourceFieldId: "sample-field-Request number",
      targetFieldId: "sample-field-Asset tag",
    },
  ];
  return design;
}

function configuredDesignWithOffsetDateTimeBounds(): Design {
  const design = structuredClone(configuredSandboxDesign);
  const field = design.modules[0]?.fields[0];
  if (!field) throw new Error("A configured field is required");
  field.type = "Date/Time";
  field.value = "2025-01-01T01:00:00+02:00";
  field.config = {
    kind: "datetime",
    defaultValue: "2025-01-01T01:00:00+02:00",
    earliest: "2025-01-01T01:00:00+02:00",
    latest: "2025-01-01T00:00:00Z",
  };
  return design;
}

async function openAuthenticatedSandbox(
  page: Page,
  designFixture: Design = configuredSandboxDesign,
  options: SandboxOptions = {},
) {
  let revision = 1;
  let documentReads = 0;
  let documentWrites = 0;
  let versions = options.versions ?? [];
  let document = migrateSandboxFileV1({
    kind: "openslate-sandbox",
    schemaVersion: 1,
    design: structuredClone(designFixture),
  });
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user_id: "00000000-0000-4000-8000-000000000001",
        setup_required: false,
      }),
    });
  });
  await page.route("**/api/sandbox/document", async (route) => {
    if (route.request().method() === "GET") {
      documentReads += 1;
      if (options.discardRefreshDelay && documentReads === 3)
        await options.discardRefreshDelay;
      if (options.discardRefreshFailure && documentReads === 3) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ detail: options.discardRefreshFailure }),
        });
        return;
      }
    }
    if (route.request().method() === "PUT") {
      documentWrites += 1;
      await options.saveDelay;
      if (options.saveFailure) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ detail: options.saveFailure }),
        });
        return;
      }
      const body = route.request().postDataJSON() as {
        document: typeof document;
      };
      document = body.document;
      revision += 1;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        document,
        revision,
        contentHash: "a".repeat(64),
        byteCount: JSON.stringify(document).length,
        issues: options.issues ?? [],
        latestPublishedVersion: null,
        publishedHash: options.publishedHash ?? null,
        hasUnpublishedChanges: options.hasUnpublishedChanges ?? true,
      }),
    });
  });
  await page.route("**/api/sandbox/imports", async (route) => {
    if (options.importFailure) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ detail: options.importFailure }),
      });
      return;
    }
    const body = route.request().postDataJSON() as {
      bundle: typeof document;
    };
    document = body.bundle;
    revision += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        document,
        revision,
        contentHash: "b".repeat(64),
        byteCount: JSON.stringify(document).length,
        issues: [],
        latestPublishedVersion: null,
        publishedHash: options.publishedHash ?? null,
        hasUnpublishedChanges: options.hasUnpublishedChanges ?? true,
      }),
    });
  });
  await page.route("**/api/sandbox/versions?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: versions,
        limit: 50,
        offset: 0,
        count: versions.length,
        total: versions.length,
        hasMore: false,
      }),
    });
  });
  await page.route("**/api/sandbox/versions/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await options.versionMutationDelay;
    const body = route.request().postDataJSON() as { label?: string };
    const current = versions[0];
    if (!current) throw new Error("A checkpoint fixture is required");
    const updated = {
      ...current,
      label: body.label ?? current.label,
      metadataRevision: Number(current.metadataRevision) + 1,
    };
    versions = [updated, ...versions.slice(1)];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...updated, document }),
    });
  });
  await page.route("**/api/sandbox/tests*", async (route) => {
    if (route.request().method() === "DELETE" && options.clearTestsFailure) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: options.clearTestsFailure }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: options.testRuns ?? [],
        limit: 50,
        offset: 0,
        count: 0,
        total: 0,
        hasMore: false,
      }),
    });
  });
  await page.route("**/api/sandbox/automation-runs?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    });
  });
  await page.route("**/api/sandbox/publication-previews", async (route) => {
    await options.publicationDelay;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        previewToken: "sandbox-preview",
        impactDigest: "b".repeat(64),
        documentRevision: revision,
        documentHash: "a".repeat(64),
        expiresAt: "2026-09-22T12:00:00Z",
        changes: [],
        counts: {
          departments: 0,
          modules: 0,
          fields: 0,
          relationships: 0,
          automations: 0,
        },
        warnings: [],
        blockers: [],
      }),
    });
  });
  await page.goto("/sandbox");
  await expect(
    page.getByRole("heading", { name: "Organization builder" }),
  ).toBeVisible();
  return {
    document: () => structuredClone(document),
    documentReads: () => documentReads,
    documentWrites: () => documentWrites,
  };
}

test("an organization template replaces the empty draft only after confirmation", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(page, initialDesign);

  await page.getByRole("button", { name: "More Sandbox actions" }).click();
  await page.getByRole("menuitem", { name: "Start from template" }).click();
  const dialog = page.getByRole("dialog", { name: "Organization templates" });
  await expect(
    dialog.getByRole("button", { name: "Select Inventory & procurement" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Select Inventory & procurement" })
    .click();
  await expect(
    dialog.getByText(/departments.*modules.*fields.*relationships/i),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Use Inventory & procurement" })
    .click();

  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Procurement", { exact: true }).first(),
  ).toBeVisible();
  const document = sandbox.document();
  expect(document.design.departments.length).toBeGreaterThanOrEqual(3);
  expect(document.design.modules.length).toBeGreaterThanOrEqual(6);
  expect(document.automations.length).toBeGreaterThanOrEqual(3);
  expect(document.scenarios).toEqual([]);
});

test("a detailed template remains usable when moving from Automations to Test", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) =>
    pageErrors.push(error.stack ?? error.message),
  );
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await openAuthenticatedSandbox(page, initialDesign);

  await page.getByRole("button", { name: "More Sandbox actions" }).click();
  await page.getByRole("menuitem", { name: "Start from template" }).click();
  await page
    .getByRole("button", { name: "Use Inventory & procurement" })
    .click();
  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Recent activity" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Test", exact: true }).click();

  await expect(
    page.getByRole("heading", {
      name: /Test setup|Workspace data could not be opened/,
    }),
  ).toBeVisible();
  expect({ pageErrors, consoleErrors }).toEqual({
    pageErrors: [],
    consoleErrors: [],
  });
  await expect(
    page.getByRole("heading", { name: "Test setup", exact: true }),
  ).toBeVisible();
});

test("a rejected template replacement stays open with its recoverable error", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, initialDesign, {
    importFailure: "The shared Sandbox changed. Reload it and try again.",
  });

  await page.getByRole("button", { name: "More Sandbox actions" }).click();
  await page.getByRole("menuitem", { name: "Start from template" }).click();
  const dialog = page.getByRole("dialog", { name: "Organization templates" });
  await dialog
    .getByRole("button", { name: "Use Inventory & procurement" })
    .click();

  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText(
    "The shared Sandbox changed. Reload it and try again.",
  );
});

test("an empty Sandbox renders no placeholder entities and can create its first department", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, initialDesign);

  await expect(
    page.getByText(
      "0 departments · 0 modules · 0 fields · 0 relationships · 0 rules",
    ),
  ).toHaveCount(2);
  await expect(page.getByText("Service requests", { exact: true })).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: "Add department" }).click();
  await page.getByLabel("Department name").fill("Finance");
  await page.getByRole("button", { name: "Create department" }).click();

  await expect(
    page.getByText("Finance", { exact: true }).first(),
  ).toBeVisible();
});

test("the Build canvas owns most of a wide screen and one workbench switches Structure and Properties", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuthenticatedSandbox(page);

  const workbench = page.getByRole("complementary", {
    name: "Design workbench",
  });
  const tabs = workbench.getByRole("tablist", { name: "Workbench view" });
  await expect(tabs.getByRole("tab", { name: "Properties" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("complementary", { name: "Design inspector" }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Organization structure" }),
  ).toBeHidden();

  const canvas = await page.getByLabel("Module design canvas").boundingBox();
  const side = await workbench.boundingBox();
  if (!canvas || !side) throw new Error("Build layout is not rendered");
  expect(canvas.width / (canvas.width + side.width)).toBeGreaterThanOrEqual(
    0.65,
  );

  await tabs.getByRole("tab", { name: "Structure" }).click();
  await expect(
    page.getByRole("complementary", { name: "Organization structure" }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Design inspector" }),
  ).toBeHidden();
});

test("fitting a narrow canvas keeps the design readable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const spreadDesign = structuredClone(configuredSandboxDesign);
  spreadDesign.layout = {
    "sample-commercial": { x: 4000, y: 0, width: 600, height: 400 },
  };
  await openAuthenticatedSandbox(page, spreadDesign);

  await page.getByRole("tab", { name: "Canvas" }).click();
  await page.getByRole("button", { name: "Fit canvas" }).click();
  await expect
    .poll(async () =>
      Number.parseInt(
        (await page.getByRole("status", { name: "Canvas zoom" }).innerText()) ??
          "0",
        10,
      ),
    )
    .toBeGreaterThanOrEqual(40);
});

test("an empty Sandbox authors and persists a complete connected organization", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(page, initialDesign);

  await page.getByRole("button", { name: "Add department" }).click();
  await page.getByLabel("Department name").fill("Operations");
  await page.getByRole("button", { name: "Create department" }).click();

  for (const moduleName of ["Inventory", "Suppliers"]) {
    await page.getByRole("button", { name: "Add module", exact: true }).click();
    await page.getByLabel("Module name").fill(moduleName);
    await page.getByRole("button", { name: "Create module" }).click();
  }

  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await page.getByLabel("Field name").fill("Supplier name");
  await page.getByRole("checkbox", { name: "Required field" }).click();
  await page.getByRole("button", { name: "Create field" }).click();

  await page
    .getByRole("tablist", { name: "Workbench view" })
    .getByRole("tab", { name: "Structure" })
    .click();
  await page.getByRole("button", { name: /^Add relationship$/i }).click();
  const relationshipDialog = page.getByRole("dialog", {
    name: "Connect modules",
  });
  await relationshipDialog
    .getByLabel("Relationship name")
    .fill("Supplier inventory coverage");
  await relationshipDialog
    .getByRole("button", { name: "Create relationship" })
    .click();

  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await page.getByRole("button", { name: "New automation" }).click();
  await page.getByLabel("Automation name").fill("Notify inventory intake");
  await page.getByRole("button", { name: "Save automations" }).click();

  const document = sandbox.document();
  expect(document.design.departments).toHaveLength(1);
  expect(document.design.modules).toHaveLength(2);
  expect(document.design.modules.flatMap((item) => item.fields)).toHaveLength(
    1,
  );
  expect(document.design.relationships).toHaveLength(1);
  expect(document.automations).toHaveLength(1);
  expect(document.scenarios).toEqual([]);
});

test("a dirty automation draft protects browser exits", async ({ page }) => {
  await openAuthenticatedSandbox(page);
  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await page.getByLabel("Automation name").fill("Unsaved automation name");

  await expect
    .poll(() =>
      page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    )
    .toBe(true);
});

test("automation editing is locked while its save is pending", async ({
  page,
}) => {
  let releaseSave = () => {};
  const saveDelay = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { saveDelay });
  await page.getByRole("link", { name: "Automations", exact: true }).click();
  const name = page.getByLabel("Automation name");
  await name.fill("Pending automation save");
  await page.getByRole("button", { name: "Save automations" }).click();

  try {
    await expect(name).toBeDisabled();
    await expect(page.getByLabel("Trigger", { exact: true })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Automation options" }),
    ).toBeDisabled();
  } finally {
    releaseSave();
  }
  await expect(name).toBeEnabled();
});

test("running and clearing tests protect browser exits until each request settles", async ({
  page,
}) => {
  let releaseRun = () => {};
  let releaseClear = () => {};
  let runStarted = false;
  let clearStarted = false;
  const runDelay = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const clearDelay = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  await openAuthenticatedSandbox(page);
  await page.route("**/api/sandbox/tests", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      runStarted = true;
      const request = route.request().postDataJSON() as {
        moduleId: string;
        values: Record<string, unknown>;
        event: { kind: "record-created" };
        automationIds?: string[];
      };
      await runDelay;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: "00000000-0000-4000-8000-000000000008",
          createdAt: "2026-09-22T00:00:00Z",
          documentRevision: 1,
          input: { moduleId: request.moduleId, values: request.values },
          event: request.event,
          automationIds: request.automationIds ?? null,
          result: {
            values: request.values,
            routes: [],
            automationTraces: [],
            issues: [],
          },
        }),
      });
      return;
    }
    if (method === "DELETE") {
      clearStarted = true;
      await clearDelay;
      await route.fulfill({
        contentType: "application/json",
        body: "null",
      });
      return;
    }
    await route.fallback();
  });
  await page.getByRole("link", { name: "Test", exact: true }).click();

  await page.getByRole("button", { name: "Run test" }).click();
  await expect.poll(() => runStarted).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Review & Publish" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "More Sandbox actions" }).click();
  await page.getByRole("menuitem", { name: "Save checkpoint" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Save checkpoint" })
      .getByRole("button", { name: "Save checkpoint" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  releaseRun();
  await expect(
    page.getByRole("heading", { name: "Test result", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Clear results" }).click();
  await expect.poll(() => clearStarted).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    )
    .toBe(true);
  releaseClear();
  await expect(
    page.getByText("Run a test to see the expected outcome here."),
  ).toBeVisible();
});

test("an automation issue opens the automation it identifies", async ({
  page,
}) => {
  const design = structuredClone(configuredSandboxDesign);
  const first = design.rules[0];
  if (!first) throw new Error("configured automation is unavailable");
  design.rules.push({
    ...structuredClone(first),
    id: "sample-follow-up",
    name: "Follow-up request alert",
  });
  await openAuthenticatedSandbox(page, design, {
    issues: [
      {
        code: "automation.invalid",
        message: "Review the follow-up automation",
        targetId: "sample-follow-up",
      },
    ],
  });

  await page
    .getByRole("button", {
      name: "Review: Review the follow-up automation",
    })
    .click();

  await expect(page.getByLabel("Automation name")).toHaveValue(
    "Follow-up request alert",
  );
});

test("designer commands are ignored while a design save is pending", async ({
  page,
}) => {
  let releaseSave = () => {};
  const saveDelay = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredSandboxDesign,
    { saveDelay },
  );

  await page.getByRole("button", { name: "View canvas" }).click();
  await page.getByRole("menuitem", { name: "Auto-arrange" }).click();
  await expect.poll(sandbox.documentWrites).toBe(1);

  try {
    await page.keyboard.press("Control+z");
    await expect.poll(sandbox.documentWrites).toBe(1);
  } finally {
    releaseSave();
  }
});

test("Build undo preserves an automation that was saved afterward", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(page);

  await page.getByRole("button", { name: "View canvas" }).click();
  await page.getByRole("menuitem", { name: "Auto-arrange" }).click();
  await expect(page.getByText("Canvas automatically arranged.")).toBeVisible();

  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await page.getByLabel("Automation name").fill("Saved urgent request alert");
  await page.getByRole("button", { name: "Save automations" }).click();
  await expect(page.getByLabel("Automation name")).toBeEnabled();

  await page.getByRole("link", { name: "Build", exact: true }).click();
  await page.getByRole("button", { name: "Undo" }).click();

  await expect
    .poll(() => sandbox.document().automations[0]?.name)
    .toBe("Saved urgent request alert");
});

test("a pending publication review protects browser exits", async ({
  page,
}) => {
  let releasePreview = () => {};
  const publicationDelay = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  await openAuthenticatedSandbox(page, initialDesign, {
    publicationDelay,
  });

  await expect
    .poll(() =>
      page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    )
    .toBe(false);

  await page.getByRole("button", { name: "Review & Publish" }).click();
  await page.getByRole("button", { name: "Review changes" }).click();

  try {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const event = new Event("beforeunload", { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        }),
      )
      .toBe(true);
  } finally {
    releasePreview();
  }
});

test("history controls are locked while a version mutation is pending", async ({
  page,
}) => {
  let releaseMutation = () => {};
  const versionMutationDelay = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  const checkpoint = {
    id: "00000000-0000-4000-8000-000000000009",
    sequence: 1,
    kind: "checkpoint",
    label: "Before changes",
    note: null,
    sourceDocumentRevision: 1,
    sourceVersionId: null,
    contentHash: "c".repeat(64),
    byteCount: 321,
    metadataRevision: 1,
    createdAt: "2026-09-21T00:00:00Z",
    performedBy: null,
    isDeleted: false,
    deletedAt: null,
  };
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    versionMutationDelay,
    versions: [checkpoint],
  });
  await page.getByRole("link", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: "Edit checkpoint label" }).click();
  const label = page.getByRole("textbox", { name: "Checkpoint label" });
  await label.fill("Updated checkpoint");
  await page.getByRole("button", { name: "Save label" }).click();

  try {
    await expect(label).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Save label" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Cancel label edit" }),
    ).toBeDisabled();
  } finally {
    releaseMutation();
  }
  await expect(
    page.getByText("Checkpoint label updated in shared history."),
  ).toBeVisible();
});

test("legacy relationship mappings can be removed before publishing", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, configuredDesignWithLegacyMapping());
  await expect(
    page.getByRole("button", {
      name: "Edit outgoing relationship Uses equipment",
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Edit outgoing relationship Uses equipment",
    })
    .click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Legacy field mappings")).toBeVisible();
  await dialog.getByRole("button", { name: "Remove mapping" }).click();
  await dialog.getByRole("button", { name: "Save relationship" }).click();
  await expect(dialog).toBeHidden();
  await page
    .getByRole("button", {
      name: "Edit outgoing relationship Uses equipment",
    })
    .click();
  await expect(dialog.getByText("Legacy field mappings")).toHaveCount(0);
});

test("closing a mapped field removes its relationship mappings", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, configuredDesignWithLegacyMapping());

  await page
    .getByRole("button", { name: "Show Request number settings" })
    .click();
  await page
    .getByLabel("Request number field settings")
    .getByRole("button", { name: "Close field" })
    .click();
  await expect(
    page.getByRole("status").filter({
      hasText: "Request number closed. 1 relationship field mapping removed.",
    }),
  ).toBeVisible();

  await page
    .getByRole("button", {
      name: "Edit outgoing relationship Uses equipment",
    })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Legacy field mappings")).toHaveCount(0);
});

test("the Designer saves offset Date/Time bounds in chronological order", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredDesignWithOffsetDateTimeBounds(),
  );

  await page
    .getByRole("button", { name: "Show Request number settings" })
    .click();
  await page
    .getByLabel("Request number field settings")
    .getByRole("button", { name: "Save field changes" })
    .click();

  await expect.poll(sandbox.documentWrites).toBe(1);
  await expect(
    page.getByText("Earliest value cannot be after latest value."),
  ).toHaveCount(0);
});

test("a failed structural save remains visibly unsaved until the shared draft is reloaded", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, initialDesign, {
    saveFailure: "Sandbox storage is unavailable.",
    hasUnpublishedChanges: false,
  });
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add department" }).click();
  await page.getByLabel("Department name").fill("Operations");
  await page.getByRole("button", { name: "Create department" }).click();

  await expect(
    page.getByText(
      "Save did not complete: your proposed document is still local.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Draft saved", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review & Publish" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Reapply my draft" }).click();
  await expect(
    page.getByText(
      "Save did not complete: your proposed document is still local.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review & Publish" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Reload shared draft" }).click();
  await expect(
    page.getByText(
      "Save did not complete: your proposed document is still local.",
    ),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review & Publish" }),
  ).toBeEnabled();
});

test("discard refresh failure leaves the dialog open and allows a retry", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(page, initialDesign, {
    discardRefreshFailure: "The shared Sandbox could not be refreshed.",
  });
  await page.route("**/api/sandbox/versions", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "00000000-0000-4000-8000-000000000008",
        sequence: 1,
        kind: "checkpoint",
        label: "Before discard",
        note: null,
        sourceDocumentRevision: 1,
        sourceVersionId: null,
        contentHash: "a".repeat(64),
        byteCount: JSON.stringify(sandbox.document()).length,
        metadataRevision: 1,
        createdAt: "2026-09-21T00:01:00Z",
        performedBy: null,
        isDeleted: false,
        deletedAt: null,
        document: sandbox.document(),
      }),
    });
  });

  await page.getByRole("button", { name: "More Sandbox actions" }).click();
  await page.getByRole("menuitem", { name: "Discard draft changes" }).click();
  const dialog = page.getByRole("dialog", { name: "Discard draft changes?" });
  const discard = dialog.getByRole("button", { name: "Discard draft" });
  await discard.click();
  await expect(dialog.getByRole("status")).toContainText(
    "The shared Sandbox could not be refreshed.",
  );
  await expect(discard).toBeEnabled();

  await discard.click();
  await expect(dialog).toBeHidden();
});

test("discard keeps browser exits guarded throughout its composite request", async ({
  page,
}) => {
  let releaseRefresh = () => {};
  const discardRefreshDelay = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const sandbox = await openAuthenticatedSandbox(page, initialDesign, {
    discardRefreshDelay,
  });
  await page.route("**/api/sandbox/versions", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "00000000-0000-4000-8000-000000000008",
        sequence: 1,
        kind: "checkpoint",
        label: "Before discard",
        note: null,
        sourceDocumentRevision: 1,
        sourceVersionId: null,
        contentHash: "a".repeat(64),
        byteCount: JSON.stringify(sandbox.document()).length,
        metadataRevision: 1,
        createdAt: "2026-09-21T00:01:00Z",
        performedBy: null,
        isDeleted: false,
        deletedAt: null,
        document: sandbox.document(),
      }),
    });
  });

  await page.getByRole("button", { name: "More Sandbox actions" }).click();
  await page.getByRole("menuitem", { name: "Discard draft changes" }).click();
  await page
    .getByRole("dialog", { name: "Discard draft changes?" })
    .getByRole("button", { name: "Discard draft" })
    .click();
  await expect.poll(sandbox.documentReads).toBe(3);
  await page.waitForTimeout(100);

  try {
    expect(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(true);
  } finally {
    releaseRefresh();
  }
  await expect(
    page.getByRole("dialog", { name: "Discard draft changes?" }),
  ).toBeHidden();
});

test("daily Test history with a nullable weekday loads and a failed clear remains retryable", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    testRuns: [
      {
        id: "00000000-0000-4000-8000-000000000007",
        createdAt: "2026-09-21T00:01:00Z",
        documentRevision: 1,
        input: { moduleId: "sample-requests", values: {} },
        event: {
          kind: "schedule",
          frequency: "daily",
          time: "09:00",
          weekday: null,
        },
        automationIds: null,
        result: { values: {}, routes: [], automationTraces: [], issues: [] },
      },
    ],
  });
  let clearRequests = 0;
  await page.route("**/api/sandbox/tests", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    clearRequests += 1;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        detail: "Test results are temporarily unavailable.",
      }),
    });
  });

  await page.goto("/sandbox?section=test");
  await expect(
    page.getByRole("heading", { name: "Test setup", exact: true }),
  ).toBeVisible();
  const clear = page.getByRole("button", { name: "Clear results" });
  await expect(clear).toBeEnabled();
  await clear.click();
  await expect.poll(() => clearRequests).toBe(1);
  await expect(
    page
      .getByRole("region", { name: "Sandbox test", exact: true })
      .getByText("Test results are temporarily unavailable."),
  ).toBeVisible();
  await expect(clear).toBeEnabled();
});

test("automation flow preview and summary follow the unsaved rule draft", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(page);
  await page.getByRole("link", { name: "Automations", exact: true }).click();

  const flow = page.getByRole("region", { name: "Flow preview" });
  const summary = page.getByRole("region", { name: "Rule summary" });
  const settings = page.getByRole("region", { name: "Rule settings" });
  await expect(settings).toBeVisible();
  await expect(
    flow.getByRole("button", { name: "Edit trigger" }),
  ).toBeVisible();
  await expect(
    flow.getByRole("button", { name: "Edit condition 1" }),
  ).toBeVisible();
  await expect(
    flow.getByRole("button", { name: "Edit action 1" }),
  ).toBeVisible();

  const savedAutomations = sandbox.document().automations;
  await page
    .getByLabel("Condition 1 field")
    .selectOption({ label: "Priority" });
  const conditionValue = settings.getByLabel("Value", { exact: true }).first();
  await settings
    .getByText(/Value options/)
    .first()
    .click();
  await conditionValue.fill("Needs immediate review");
  await expect(
    flow.getByRole("button", { name: "Edit condition 1" }),
  ).toContainText("Needs immediate review");
  await expect(summary).toContainText("Needs immediate review");
  expect(sandbox.document().automations).toEqual(savedAutomations);

  await page.getByLabel("Condition group operator").selectOption("any");
  await expect(flow).toContainText(/any condition/i);
  await expect(summary).toContainText(/any condition/i);

  await page.getByRole("button", { name: "Add condition" }).click();
  await expect(
    flow.getByRole("button", { name: "Edit condition 2" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove condition" }).last().click();
  await expect(
    flow.getByRole("button", { name: "Edit condition 2" }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Add action" }).click();
  await expect(
    flow.getByRole("button", { name: "Edit action 2" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove action" }).last().click();
  await expect(flow.getByRole("button", { name: "Edit action 2" })).toHaveCount(
    0,
  );

  await page.getByLabel("Trigger", { exact: true }).selectOption("schedule");
  await expect(
    flow.getByRole("button", { name: "Edit trigger" }),
  ).toContainText(/schedule/i);
  await expect(summary).toContainText(/schedule/i);
});

test("keyboard activation on an automation flow node focuses its editor", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page);
  await page.getByRole("link", { name: "Automations", exact: true }).click();

  const flow = page.getByRole("region", { name: "Flow preview" });
  const condition = page.getByLabel("Condition 1 field");
  const conditionNode = flow.getByRole("button", {
    name: "Edit condition 1",
  });
  await conditionNode.focus();
  await page.keyboard.press("Enter");
  await expect(condition).toBeFocused();
});

test("Automation Studio layout screenshots can be captured for theme and viewport review", async ({
  page,
}) => {
  test.skip(
    process.env.AUTOMATION_LAYOUT_SCREENSHOTS !== "1",
    "Set AUTOMATION_LAYOUT_SCREENSHOTS=1 to capture layout evidence",
  );

  const screenshotDirectory = resolve(
    "..",
    ".agent-runtime/automations-layout-20260925",
  );
  await mkdir(screenshotDirectory, { recursive: true });
  await openAuthenticatedSandbox(page);
  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Flow preview" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "New automation" }).click();
  await page.getByLabel("Automation name").fill("Service request follow-up");
  await page
    .getByLabel("Trigger", { exact: true })
    .selectOption("field-changed");
  const settings = page.getByRole("region", { name: "Rule settings" });
  await settings
    .getByLabel("Trigger module")
    .selectOption({ label: "Service requests" });
  await settings.getByLabel("Trigger field").selectOption({ label: "Status" });
  await page.getByRole("button", { name: "Add condition" }).click();
  await settings
    .getByLabel("Condition 1 field")
    .selectOption({ label: "Status" });
  await settings.getByLabel("Condition 1 operator").selectOption("=");
  await settings
    .getByLabel("Set field target")
    .first()
    .selectOption({ label: "Status" });
  const values = settings.getByLabel("Value", { exact: true });
  await values.first().fill("Open");
  await values.last().fill("In progress");

  const views = [
    { width: 1440, height: 1080, theme: "light" },
    { width: 1440, height: 1080, theme: "dark" },
    { width: 1920, height: 1200, theme: "light" },
    { width: 1920, height: 1200, theme: "dark" },
    { width: 390, height: 844, theme: "light" },
    { width: 390, height: 844, theme: "dark" },
  ] as const;

  for (const view of views) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
    }, view.theme);
    const widths = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(widths.page).toBeLessThanOrEqual(widths.viewport);
    await page.screenshot({
      path: join(
        screenshotDirectory,
        `automation-${view.width}-${view.theme}.png`,
      ),
      fullPage: true,
      animations: "disabled",
    });
  }
});

test("automation panels resize with their requested minimum widths and remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await openAuthenticatedSandbox(page);
  await page.getByRole("link", { name: "Automations", exact: true }).click();
  const list = page.getByRole("complementary", { name: "Automation list" });
  const settings = page.getByRole("region", { name: "Rule settings" });
  const listHandle = page.getByRole("separator", {
    name: "Resize automation list",
  });
  const settingsHandle = page.getByRole("separator", {
    name: "Resize rule settings",
  });
  await expect(listHandle).toBeVisible();
  const width = async (locator: typeof list) =>
    (await locator.boundingBox())!.width;
  const rem = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  const drag = async (handle: typeof listHandle, distance: number) => {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + distance, box.y + box.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
  };
  const initialListWidth = await width(list);
  await drag(listHandle, 120);
  await expect.poll(() => width(list)).toBeGreaterThan(initialListWidth + 80);
  await drag(listHandle, -1500);
  await expect.poll(() => width(list)).toBeCloseTo(18.2 * rem, 0);
  await drag(settingsHandle, 1500);
  await expect.poll(() => width(settings)).toBeCloseTo(13 * rem, 0);
  await settings
    .getByLabel("Automation name")
    .fill("Narrow settings stay editable");
  await expect(settings.getByLabel("Automation name")).toHaveValue(
    "Narrow settings stay editable",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
  if (process.env.AUTOMATION_LAYOUT_SCREENSHOTS === "1") {
    await page.screenshot({
      path: resolve(
        "..",
        ".agent-runtime/automations-layout-20260925/automation-resized-minimum.png",
      ),
      fullPage: true,
      animations: "disabled",
    });
  }
  const narrowWidth = await width(settings);
  await settingsHandle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => width(settings)).toBeGreaterThan(narrowWidth);
  for (const height of [768, 1000]) {
    await page.setViewportSize({ width: 1440, height });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const root = document.scrollingElement!;
          const main = document.querySelector("main")!;
          return Math.max(
            root.scrollHeight - root.clientHeight,
            main.scrollHeight - main.clientHeight,
          );
        }),
      )
      .toBeLessThanOrEqual(1);
    await expect(
      settings.getByRole("button", { name: "Save automations", exact: true }),
    ).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(settingsHandle).toBeHidden();
  await expect(settings.getByLabel("Automation name")).toHaveValue(
    "Narrow settings stay editable",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
});

test("Test field search preserves hidden edits in the submitted temporary values", async ({
  page,
}) => {
  let submitted: Record<string, unknown> | undefined;
  const design = structuredClone(configuredSandboxDesign);
  design.rules = [];
  for (let index = 1; index <= 24; index++) {
    design.modules[0].fields.push({
      id: `extra-${index}`,
      name: `Extra field ${index}`,
      type: "Text",
      required: false,
      value: "",
      options: "",
      closed: false,
    });
  }
  await openAuthenticatedSandbox(page, design);
  await page.route("**/api/sandbox/tests", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const request = route.request().postDataJSON() as {
      moduleId: string;
      values: Record<string, string | number | boolean | null>;
      event: { kind: string };
    };
    submitted = request.values;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "00000000-0000-4000-8000-000000000021",
        createdAt: "2026-09-25T10:00:00Z",
        documentRevision: 1,
        input: { moduleId: request.moduleId, values: request.values },
        event: request.event,
        automationIds: null,
        result: {
          values: { ...request.values, "sample-field-Status": "Complete" },
          automationTraces: [],
          routes: [],
          issues: [],
        },
      }),
    });
  });
  await page.getByRole("link", { name: "Test", exact: true }).click();
  const setup = page.getByRole("region", { name: "Test setup", exact: true });
  await expect(setup.getByLabel("Find a field")).toBeVisible();
  await expect(setup.getByLabel("Title", { exact: true })).toHaveCount(0);
  await setup.getByLabel("Request number", { exact: true }).fill("TEST-001");
  await setup
    .getByRole("button", { name: "All input fields", exact: true })
    .click();
  await expect(setup.getByLabel("Extra field 24", { exact: true })).toHaveCount(
    0,
  );
  await setup
    .getByRole("button", { name: "Show more fields", exact: true })
    .click();
  await setup
    .getByRole("button", { name: "Show more fields", exact: true })
    .click();
  await setup
    .getByLabel("Extra field 24", { exact: true })
    .fill("Retained beyond first page");
  await setup.getByLabel("Find a field").fill("Title");
  await setup.getByLabel("Title", { exact: true }).fill("Keep this hidden");
  await setup.getByLabel("Find a field").fill("");
  await setup
    .getByRole("button", { name: "Relevant fields", exact: true })
    .click();
  await expect(setup.getByLabel("Title", { exact: true })).toHaveCount(0);
  await setup
    .getByRole("button", { name: "Edited fields", exact: true })
    .click();
  await expect(setup.getByLabel("Title", { exact: true })).toHaveValue(
    "Keep this hidden",
  );
  await setup
    .getByRole("button", { name: "Relevant fields", exact: true })
    .click();
  await setup.getByRole("button", { name: "Run test", exact: true }).click();
  await expect
    .poll(() => submitted?.["sample-field-Title"])
    .toBe("Keep this hidden");
  expect(submitted?.["extra-24"]).toBe("Retained beyond first page");
  await expect(
    page
      .getByRole("region", { name: "Field comparison", exact: true })
      .getByRole("row", { name: /Status/ }),
  ).toContainText("Complete");
  await setup.getByLabel("Find a field").fill("Status");
  await setup.getByLabel("Status", { exact: true }).selectOption("Open");
  await expect(
    page
      .getByRole("region", { name: "Field comparison", exact: true })
      .getByRole("row", { name: /Status/ }),
  ).toContainText("Complete");
  if (process.env.SANDBOX_TEST_SCREENSHOTS) {
    const output = resolve(process.env.SANDBOX_TEST_SCREENSHOTS);
    await mkdir(output, { recursive: true });
    await setup.getByLabel("Find a field").fill("");
    await page.setViewportSize({ width: 1920, height: 1000 });
    const handle = page.getByRole("separator", { name: "Resize test setup" });
    await expect(handle).toBeVisible();
    const beforeWidth = (await setup.boundingBox())!.width;
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => (await setup.boundingBox())!.width)
      .toBeGreaterThan(beforeWidth);
    await expect(
      setup.getByLabel("Request number", { exact: true }),
    ).toHaveValue("TEST-001");
    await page.keyboard.press("ArrowLeft");
    for (const height of [768, 1000]) {
      await page.setViewportSize({ width: 1440, height });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const root = document.scrollingElement!;
            const main = document.querySelector("main")!;
            return Math.max(
              root.scrollHeight - root.clientHeight,
              main.scrollHeight - main.clientHeight,
            );
          }),
        )
        .toBeLessThanOrEqual(1);
    }
    for (const width of [1920, 1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        )
        .toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (value) =>
            document.documentElement.classList.toggle("dark", value === "dark"),
          theme,
        );
        await page.screenshot({
          path: join(output, `test-workbench-${width}-${theme}.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
    }
  }
});

test("Test comparisons use saved inputs, preserve typed values, and distinguish missing results", async ({
  page,
}) => {
  const design = structuredClone(configuredSandboxDesign);
  const testModule = design.modules[0];
  const priority = testModule.fields.find(
    (field) => field.name === "Priority",
  )!;
  priority.type = "Number";
  priority.config = { kind: "number", defaultValue: 0 };
  testModule.fields.push({
    id: "review-field",
    options: "",
    name: "Needs review",
    type: "Checkbox",
    required: false,
    closed: false,
    value: "false",
    config: { kind: "checkbox", defaultValue: false },
  });
  const base = {
    documentRevision: 1,
    event: { kind: "record-created" },
    automationIds: null,
  };
  await openAuthenticatedSandbox(page, design, {
    testRuns: [
      {
        ...base,
        id: "00000000-0000-4000-8000-000000000032",
        createdAt: "2026-09-25T10:01:00Z",
        input: {
          moduleId: testModule.id,
          values: { "sample-field-Priority": "bad", "review-field": false },
        },
        result: {
          values: { "review-field": false },
          automationTraces: [],
          routes: [],
          issues: [
            {
              code: "value_invalid",
              message: "Priority must be a number.",
              targetId: "sample-field-Priority",
            },
          ],
        },
      },
      {
        ...base,
        id: "00000000-0000-4000-8000-000000000031",
        createdAt: "2026-09-25T10:00:00Z",
        input: {
          moduleId: testModule.id,
          values: {
            "sample-field-Priority": 0,
            "review-field": false,
            "sample-field-Title": null,
          },
        },
        result: {
          values: {
            "sample-field-Priority": 0,
            "review-field": true,
            "sample-field-Title": null,
          },
          automationTraces: [
            {
              automationId: "sample-urgent",
              label: "Review request",
              outcome: "Applied",
            },
            {
              automationId: "sample-urgent",
              label: "Review request",
              outcome: "No changes",
            },
          ],
          routes: [],
          issues: [],
        },
      },
    ],
  });
  await page.getByRole("link", { name: "Test", exact: true }).click();
  const comparison = page.getByRole("region", {
    name: "Field comparison",
    exact: true,
  });
  await page
    .getByRole("button", { name: "Show Priority input", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Test setup", exact: true })
      .getByLabel("Priority", { exact: true }),
  ).toBeFocused();
  await expect(comparison).toBeVisible();
  await comparison
    .getByRole("button", { name: "All result fields", exact: true })
    .click();
  await expect(comparison.getByRole("row", { name: /Priority/ })).toContainText(
    "Not returned",
  );
  await page
    .getByRole("region", { name: "Recent test results", exact: true })
    .getByRole("button", { name: "View test 2", exact: true })
    .click();
  await expect(
    comparison.getByRole("row", { name: /Needs review/ }),
  ).toContainText("No");
  await expect(
    comparison.getByRole("row", { name: /Needs review/ }),
  ).toContainText("Yes");
  await expect(comparison.getByRole("row", { name: /Priority/ })).toHaveCount(
    0,
  );
  await comparison
    .getByRole("button", { name: "All result fields", exact: true })
    .click();
  await expect(
    comparison
      .getByRole("row", { name: /Priority/ })
      .getByRole("cell", { name: "0", exact: true }),
  ).toHaveCount(2);
  await expect(
    comparison
      .getByRole("row", { name: /Title/ })
      .getByRole("cell", { name: "No value", exact: true }),
  ).toHaveCount(2);
  const setup = page.getByRole("region", { name: "Test setup", exact: true });
  await setup.getByLabel("Find a field").fill("Priority");
  await setup.getByLabel("Priority", { exact: true }).fill("42");
  await expect(
    comparison
      .getByRole("row", { name: /Priority/ })
      .getByRole("cell", { name: "0", exact: true }),
  ).toHaveCount(2);
  await setup
    .getByLabel("Module", { exact: true })
    .selectOption("sample-equipment");
  await expect(
    comparison.getByRole("row", { name: /Needs review/ }),
  ).toContainText("Yes");
});

function historyVersionFixture(
  index: number,
  label: string,
  kind = "checkpoint",
  note: string | null = null,
) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    sequence: index,
    kind,
    label,
    note,
    sourceDocumentRevision: 1,
    sourceVersionId: null,
    contentHash: "c".repeat(64),
    byteCount: 321,
    metadataRevision: 1,
    createdAt: `2026-09-${20 + index}T10:00:00Z`,
    performedBy: null,
    isDeleted: false,
    deletedAt: null,
  };
}

test("History timeline filters preserve the selected action target and published protections", async ({
  page,
}) => {
  const versions = [
    historyVersionFixture(1, "Published structure", "published"),
    historyVersionFixture(
      2,
      "Release snapshot 1",
      "checkpoint",
      "Supplier setup",
    ),
    historyVersionFixture(3, "Before import"),
  ];
  // API history is returned newest first.
  versions.sort((a, b) => b.sequence - a.sequence);
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  await page.getByRole("link", { name: "History", exact: true }).click();
  const timeline = page.getByRole("region", {
    name: "Version timeline",
    exact: true,
  });
  const inspector = page.getByRole("region", {
    name: "Selected version",
    exact: true,
  });
  await expect(
    inspector.getByRole("heading", { name: "Before import", exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: /^View / }).first(),
  ).toHaveAccessibleName("View Before import");
  await timeline
    .getByRole("button", { name: "View Release snapshot 1", exact: true })
    .click();
  await expect(
    inspector.getByRole("heading", { name: "Release snapshot 1", exact: true }),
  ).toBeVisible();
  await timeline.getByLabel("Find a version").fill("Supplier");
  await expect(
    timeline.getByRole("button", {
      name: "View Release snapshot 1",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: "View Before import", exact: true }),
  ).toHaveCount(0);
  await timeline.getByLabel("Find a version").fill("no matching version");
  await expect(
    inspector.getByRole("heading", { name: "Release snapshot 1", exact: true }),
  ).toBeVisible();
  await inspector
    .getByRole("button", { name: "Restore version", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Restore Release snapshot 1?",
  );
  await page
    .getByRole("button", { name: "Cancel restore", exact: true })
    .click();
  await expect(
    inspector.getByRole("button", { name: "Restore version", exact: true }),
  ).toBeFocused();
  await timeline.getByLabel("Find a version").fill("");
  await timeline
    .getByRole("button", { name: "Published versions", exact: true })
    .click();
  await expect(
    timeline.getByRole("button", { name: "View Before import", exact: true }),
  ).toHaveCount(0);
  await timeline
    .getByRole("button", { name: "View Published structure", exact: true })
    .click();
  await expect(
    inspector.getByRole("button", { name: "Delete version", exact: true }),
  ).toBeDisabled();
  await expect(
    inspector.getByRole("button", {
      name: "Edit checkpoint label",
      exact: true,
    }),
  ).toHaveCount(0);
  await timeline
    .getByRole("button", { name: "All versions", exact: true })
    .click();
  await timeline
    .getByRole("button", { name: "View Release snapshot 1", exact: true })
    .click();
  await inspector
    .getByRole("button", { name: "Edit checkpoint label", exact: true })
    .click();
  await inspector
    .getByLabel("Checkpoint label", { exact: true })
    .fill("Unsaved label");
  await expect(
    timeline.getByRole("button", { name: "View Before import", exact: true }),
  ).toBeDisabled();
  await inspector
    .getByRole("button", { name: "Cancel label edit", exact: true })
    .click();
});

test("History comparison stays tied to compared versions while inspecting another timeline entry", async ({
  page,
}) => {
  const versions = [
    historyVersionFixture(1, "Published structure", "published"),
    historyVersionFixture(
      2,
      "Release snapshot 1",
      "checkpoint",
      "Supplier setup",
    ),
    historyVersionFixture(3, "Before import"),
  ];
  const before = migrateSandboxFileV1({
    kind: "openslate-sandbox",
    schemaVersion: 1,
    design: structuredClone(configuredSandboxDesign),
  });
  const after = structuredClone(before);
  after.design.modules[0].name = "Updated requests";
  let reads = 0;
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  await page.route("**/api/sandbox/versions/*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    reads++;
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const version = versions.find((item) => item.id === id)!;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...version,
        document: id === versions[1].id ? after : before,
      }),
    });
  });
  await page.getByRole("link", { name: "History", exact: true }).click();
  await page.getByLabel("Compare first version").selectOption(versions[0].id);
  await page.getByLabel("Compare second version").selectOption(versions[1].id);
  expect(reads).toBe(0);
  await page
    .getByRole("button", { name: "Compare versions", exact: true })
    .click();
  const comparison = page.getByRole("region", {
    name: "Version comparison",
    exact: true,
  });
  await expect(comparison).toContainText("Updated requests");
  const savedComparison = await comparison.innerText();
  await page
    .getByRole("button", { name: "View Before import", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Selected version", exact: true }),
  ).toContainText("Before import");
  expect(await comparison.innerText()).toBe(savedComparison);
  expect(reads).toBe(2);
  if (process.env.HISTORY_LAYOUT_SCREENSHOTS) {
    const output = resolve(process.env.HISTORY_LAYOUT_SCREENSHOTS);
    await mkdir(output, { recursive: true });
    await page
      .getByRole("button", { name: "View Release snapshot 1", exact: true })
      .click();
    for (const view of [
      { width: 1920, height: 1000 },
      { width: 1440, height: 768 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(view);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
      if (view.width >= 1440) {
        await expect
          .poll(() =>
            page.evaluate(() => {
              const root = document.scrollingElement!;
              const main = document.querySelector("main")!;
              return Math.max(
                root.scrollHeight - root.clientHeight,
                main.scrollHeight - main.clientHeight,
              );
            }),
          )
          .toBeLessThanOrEqual(1);
      }
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => {
          document.documentElement.classList.toggle("dark", value === "dark");
          window.scrollTo(0, 0);
        }, theme);
        await page.screenshot({
          path: join(output, `history-${view.width}-${theme}.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
    }
  }
});

test("History deletion failure retains its target and successful deletion selects an available version", async ({
  page,
}) => {
  const published = historyVersionFixture(
    1,
    "Published structure",
    "published",
  );
  const checkpoint = historyVersionFixture(2, "Disposable checkpoint");
  let versions = [published, checkpoint];
  let deleteAttempts = 0;
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  await page.route("**/api/sandbox/versions?*", async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: versions,
        limit: 50,
        offset: 0,
        count: versions.length,
        total: versions.length,
        hasMore: false,
      }),
    }),
  );
  await page.route("**/api/sandbox/versions/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    expect(new URL(route.request().url()).pathname).toContain(checkpoint.id);
    deleteAttempts++;
    if (deleteAttempts === 1)
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Try deletion again." }),
      });
    versions = [published];
    return route.fulfill({ status: 204 });
  });
  await page.getByRole("link", { name: "History", exact: true }).click();
  await page
    .getByRole("button", { name: "View Disposable checkpoint", exact: true })
    .click();
  const inspector = page.getByRole("region", {
    name: "Selected version",
    exact: true,
  });
  await inspector
    .getByRole("button", { name: "Delete version", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog");
  await dialog
    .getByRole("button", { name: "Delete Disposable checkpoint", exact: true })
    .click();
  await expect.poll(() => deleteAttempts).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: "Delete Disposable checkpoint",
      exact: true,
    }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Delete Disposable checkpoint", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", {
      name: "View Disposable checkpoint",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    inspector.getByRole("heading", {
      name: "Published structure",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    inspector.getByRole("button", { name: "Delete version", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "History", exact: true }),
  ).toBeFocused();
});

test("History change groups keep large comparisons scannable without hiding access to any entry", async ({
  page,
}) => {
  const first = historyVersionFixture(1, "Full setup", "published");
  const second = historyVersionFixture(2, "Empty checkpoint");
  const before = migrateSandboxFileV1({
    kind: "openslate-sandbox",
    schemaVersion: 1,
    design: structuredClone(configuredSandboxDesign),
  });
  const after = structuredClone(before);
  after.design.modules = [];
  after.design.departments = [];
  after.design.relationships = [];
  after.automations = [];
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    versions: [second, first],
  });
  await page.route("**/api/sandbox/versions/*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const isFirst = new URL(route.request().url()).pathname.endsWith(first.id);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...(isFirst ? first : second),
        document: isFirst ? before : after,
      }),
    });
  });
  await page.getByRole("link", { name: "History", exact: true }).click();
  await page.getByLabel("Compare first version").selectOption(first.id);
  await page.getByLabel("Compare second version").selectOption(second.id);
  await page
    .getByRole("button", { name: "Compare versions", exact: true })
    .click();
  const comparison = page.getByRole("region", {
    name: "Version comparison",
    exact: true,
  });
  const fields = comparison.getByRole("button", {
    name: "Fields, 12 change entries",
    exact: true,
  });
  await expect(fields).toBeVisible();
  await expect(
    comparison.getByText("Field removed: Service requests · Request number", {
      exact: true,
    }),
  ).toBeHidden();
  await fields.click();
  await expect(
    comparison.getByText("Field removed: Service requests · Request number", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    comparison.getByText("Field removed: Customers · Email", { exact: true }),
  ).toBeVisible();
  await expect(comparison.getByRole("row", { name: /Fields/ })).toContainText(
    "12",
  );
  await fields.click();
  await expect(
    comparison.getByText("Field removed: Customers · Email", { exact: true }),
  ).toBeHidden();
  if (process.env.HISTORY_LAYOUT_SCREENSHOTS) {
    const output = resolve(process.env.HISTORY_LAYOUT_SCREENSHOTS);
    await mkdir(output, { recursive: true });
    for (const width of [1920, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => {
        document.documentElement.classList.add("dark");
        window.scrollTo(0, 0);
      });
      await comparison.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({
        path: join(output, `history-change-review-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
  }
});
