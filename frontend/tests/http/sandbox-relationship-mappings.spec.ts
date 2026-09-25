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
      name: /Test your setup|Workspace data could not be opened/,
    }),
  ).toBeVisible();
  expect({ pageErrors, consoleErrors }).toEqual({
    pageErrors: [],
    consoleErrors: [],
  });
  await expect(
    page.getByRole("heading", { name: "Test your setup" }),
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
  await expect(page.getByText("Test result")).toBeVisible();

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
    page.getByRole("heading", { name: "Test your setup" }),
  ).toBeVisible();
  const clear = page.getByRole("button", { name: "Clear results" });
  await expect(clear).toBeEnabled();
  await clear.click();
  await expect.poll(() => clearRequests).toBe(1);
  await expect(
    page
      .getByRole("region", { name: "Test your setup" })
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
