import { expect, test, type Page } from "./helpers/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  initialDesign,
  type Design,
} from "../../src/components/systems/sandbox/domain/model";
import { publicationFieldKey } from "../../src/components/systems/sandbox/components/publish-change-groups";
import { captureOpenViewReview } from "./helpers/openview-review-capture";
import {
  configuredSandboxDesign,
  sandboxDocumentFromDesign,
} from "../helpers/sandbox-fixtures";

type SandboxOptions = {
  importFailure?: string;
  saveFailure?: string;
  clearTestsFailure?: string;
  discardRefreshFailure?: string;
  discardRefreshDelay?: Promise<void>;
  hasUnpublishedChanges?: boolean;
  publishedHash?: string | null;
  testRuns?: unknown[];
  /** The draft revision the session starts at. */
  revision?: number;
  saveDelay?: Promise<void>;
  publicationDelay?: Promise<void>;
  issues?: Array<{ code: string; message: string; targetId: string | null }>;
  versionMutationDelay?: Promise<void>;
  versions?: Array<Record<string, unknown>>;
  previewChanges?: Array<Record<string, string>>;
  bindings?: Array<{
    kind: "department" | "module" | "field" | "relationship" | "trigger";
    sandbox_id: string;
    parent_sandbox_id: string | null;
    live_id: string;
    is_deleted: boolean;
  }>;
  bindingFailure?: number;
  bindingRevision?: number;
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
  let revision = options.revision ?? 1;
  let documentReads = 0;
  let documentWrites = 0;
  let versions = options.versions ?? [];
  let document = sandboxDocumentFromDesign(designFixture);
  let bindings = options.bindings ?? [];
  let bindingFailure = options.bindingFailure;
  let bindingRevision = options.bindingRevision;
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
  await page.route("**/api/sandbox/bindings", async (route) => {
    await route.fulfill({
      status: bindingFailure ?? 200,
      json: bindingFailure
        ? { detail: "Live state is unavailable" }
        : { document_revision: bindingRevision ?? revision, items: bindings },
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
  await page.route("**/api/sandbox/trigger-runs?*", async (route) => {
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
        changes: options.previewChanges ?? [],
        counts: {
          departments: 0,
          modules: 0,
          fields: 0,
          relationships: 0,
          triggers: 0,
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
    confirmLiveDocument: (next: typeof document) => {
      document = structuredClone(next);
      revision += 1;
    },
    confirmBindings: (next: typeof bindings) => {
      bindings = structuredClone(next);
      bindingFailure = undefined;
      bindingRevision = undefined;
    },
  };
}

function lifecycleImpactFixture(
  kind: "department" | "module" | "field",
  id: string,
  operation: "close" | "reopen" | "purge",
) {
  return {
    target_type: kind,
    target_id: id,
    operation,
    actor_id: "00000000-0000-4000-8000-000000000001",
    rows: [
      {
        entity_type: `${kind}s`,
        entity_id: id,
        is_deleted: operation !== "close",
        deleted_at: operation === "close" ? null : "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
        state_fingerprint: "owned-live-state",
      },
    ],
    external_impacts: [],
    key_strips: [],
    blockers: [],
    impact_digest: "d".repeat(64),
  };
}

test("bound module lifecycle uses the live name and refreshes the saved design", async ({
  page,
}) => {
  const design = structuredClone(configuredSandboxDesign);
  const targetModule = design.modules[0];
  if (!targetModule) throw new Error("A module fixture is required");
  targetModule.name = "Unpublished requests";
  const liveId = "00000000-0000-4000-8000-000000000501";
  const binding = {
    kind: "module" as const,
    sandbox_id: targetModule.id,
    parent_sandbox_id: null,
    live_id: liveId,
    is_deleted: false,
  };
  const requests: unknown[] = [];
  await page.route(`**/api/modules/${liveId}/close/preview`, (route) =>
    route.fulfill({
      json: {
        impact: lifecycleImpactFixture("module", liveId, "close"),
        token: "owned-close-review",
        expires_at: "2027-10-01T00:00:00Z",
        confirmation_name: "Requests",
      },
    }),
  );
  await page.route(`**/api/modules/${liveId}/close`, async (route) => {
    requests.push(route.request().postDataJSON());
    const confirmed = sandbox.document();
    const target = confirmed.design.modules.find(
      (item) => item.id === targetModule.id,
    );
    if (!target) throw new Error("The owned module disappeared");
    target.closed = true;
    sandbox.confirmLiveDocument(confirmed);
    sandbox.confirmBindings([{ ...binding, is_deleted: true }]);
    await route.fulfill({
      json: {
        impact: lifecycleImpactFixture("module", liveId, "close"),
        operation_id: "00000000-0000-4000-8000-000000000502",
      },
    });
  });
  const sandbox = await openAuthenticatedSandbox(page, design, {
    bindings: [binding],
  });
  await page.getByRole("button", { name: "View canvas" }).click();
  await page.getByRole("menuitem", { name: "Auto-arrange" }).click();
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeEnabled();
  const writes = sandbox.documentWrites();
  await page.getByRole("button", { name: "Close module", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Close module",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel("Type the module name", { exact: true })
    .fill(targetModule.name);
  await dialog
    .getByLabel("Administrator password", { exact: true })
    .fill("owned-test-password");
  await expect(
    dialog.getByRole("button", { name: "Close module", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(requests).toEqual([]);
  await page.getByRole("button", { name: "Close module", exact: true }).click();
  await expect(
    dialog.getByLabel("Type the module name", { exact: true }),
  ).toHaveValue("");
  await expect(
    dialog.getByLabel("Administrator password", { exact: true }),
  ).toHaveValue("");
  await dialog
    .getByLabel("Type the module name", { exact: true })
    .fill("Requests");
  await dialog
    .getByLabel("Administrator password", { exact: true })
    .fill("owned-test-password");
  await dialog
    .getByRole("button", { name: "Close module", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Reopen module", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  expect(requests).toEqual([
    {
      token: "owned-close-review",
      confirmation_name: "Requests",
      password: "owned-test-password",
    },
  ]);
  expect(sandbox.documentWrites()).toBe(writes);
  expect(
    sandbox
      .document()
      .design.modules.find((item) => item.id === targetModule.id)?.name,
  ).toBe("Unpublished requests");
  expect(
    sandbox
      .document()
      .design.modules.find((item) => item.id === targetModule.id)
      ?.fields.every((field) => !field.closed),
  ).toBe(true);
});

for (const status of [403, 503]) {
  test(`a ${status} bindings read never becomes a draft-only lifecycle action`, async ({
    page,
  }) => {
    const sandbox = await openAuthenticatedSandbox(
      page,
      configuredSandboxDesign,
      { bindingFailure: status },
    );
    await expect(
      page.getByRole("alert").filter({ hasText: "Live state" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Close module", exact: true }),
    ).toBeDisabled();
    expect(sandbox.documentWrites()).toBe(0);
    sandbox.confirmBindings([]);
    await page
      .getByRole("button", { name: "Retry live state", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Close module", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Close module", exact: true })
      .click();
    await expect.poll(sandbox.documentWrites).toBe(1);
    await expect(
      page.getByRole("button", { name: "Reopen module", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Permanently delete module",
        exact: true,
      }),
    ).toHaveCount(0);
  });
}

test("mismatched binding revisions require a confirmed reload before lifecycle editing", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredSandboxDesign,
    { bindingRevision: 99 },
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "Live state" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close module", exact: true }),
  ).toBeDisabled();
  expect(sandbox.documentWrites()).toBe(0);
  sandbox.confirmBindings([]);
  await page
    .getByRole("button", { name: "Reload live state", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Close module", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Close module", exact: true }).click();
  await expect.poll(sandbox.documentWrites).toBe(1);
});

test("cancelling a pending lifecycle preview ignores its late response and protects exits", async ({
  page,
}) => {
  const targetModule = configuredSandboxDesign.modules[0];
  if (!targetModule) throw new Error("A module fixture is required");
  const liveId = "00000000-0000-4000-8000-000000000511";
  let release = () => {};
  const delay = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/modules/${liveId}/close/preview`, async (route) => {
    await delay;
    await route.fulfill({
      json: {
        impact: lifecycleImpactFixture("module", liveId, "close"),
        token: "late-review",
        expires_at: "2027-10-01T00:00:00Z",
        confirmation_name: "Requests",
      },
    });
  });
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredSandboxDesign,
    {
      bindings: [
        {
          kind: "module",
          sandbox_id: targetModule.id,
          parent_sandbox_id: null,
          live_id: liveId,
          is_deleted: false,
        },
      ],
    },
  );
  await page.getByRole("button", { name: "Close module", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Close module",
    exact: true,
  });
  const exitGuarded = () =>
    page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  try {
    await expect(dialog).toBeVisible();
    await expect.poll(exitGuarded).toBe(true);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(exitGuarded).toBe(false);
  } finally {
    release();
  }
  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  await expect(page.getByLabel("Trigger name")).toBeVisible();
  await expect(dialog).toBeHidden();
  expect(sandbox.documentWrites()).toBe(0);
});

test("bound field lifecycle resolves its parent and preserves dirty settings", async ({
  page,
}) => {
  const design = configuredDesignWithLegacyMapping();
  const targetModule = design.modules[0];
  const otherModule = design.modules[1];
  const field = targetModule?.fields[0];
  const otherField = otherModule?.fields[0];
  if (!targetModule || !otherModule || !field || !otherField)
    throw new Error("Two field owners are required");
  const liveId = "00000000-0000-4000-8000-000000000521";
  const binding = {
    kind: "field" as const,
    sandbox_id: field.id,
    parent_sandbox_id: targetModule.id,
    live_id: liveId,
    is_deleted: false,
  };
  otherField.id = field.id;
  const mapping = design.relationships[0]?.fieldMappings?.[0];
  if (mapping) mapping.targetFieldId = field.id;
  const requests: unknown[] = [];
  await page.route(`**/api/fields/${liveId}/close/preview`, (route) =>
    route.fulfill({
      json: {
        impact: lifecycleImpactFixture("field", liveId, "close"),
        token: "owned-field-review",
        expires_at: "2027-10-01T00:00:00Z",
        confirmation_name: field.name,
      },
    }),
  );
  await page.route(`**/api/fields/${liveId}/close`, async (route) => {
    requests.push(route.request().postDataJSON());
    const confirmed = sandbox.document();
    const current = confirmed.design.modules
      .find((item) => item.id === targetModule.id)
      ?.fields.find((item) => item.id === field.id);
    if (!current) throw new Error("The owned field disappeared");
    current.closed = true;
    confirmed.design.relationships[0]!.fieldMappings = [];
    sandbox.confirmLiveDocument(confirmed);
    sandbox.confirmBindings([{ ...binding, is_deleted: true }]);
    await route.fulfill({
      json: {
        impact: lifecycleImpactFixture("field", liveId, "close"),
        operation_id: null,
      },
    });
  });
  const sandbox = await openAuthenticatedSandbox(page, design, {
    bindings: [
      {
        ...binding,
        parent_sandbox_id: otherModule.id,
        live_id: "00000000-0000-4000-8000-000000000522",
        is_deleted: true,
      },
      binding,
    ],
  });
  const settings = page.getByLabel(`${field.name} field settings`, {
    exact: true,
  });
  await settings
    .getByRole("button", { name: `Show ${field.name} settings`, exact: true })
    .click();
  await settings
    .getByLabel(`${field.name} name`, { exact: true })
    .fill("Unsaved field name");
  await expect(
    settings.getByRole("button", { name: "Close field", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByLabel(`${field.name} name`, { exact: true }),
  ).toHaveValue("Unsaved field name");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await settings
    .getByRole("button", { name: "Close field", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Close field", exact: true });
  await dialog
    .getByLabel("Type the field name", { exact: true })
    .fill(field.name);
  await dialog
    .getByLabel("Administrator password", { exact: true })
    .fill("owned-test-password");
  await dialog
    .getByRole("button", { name: "Close field", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    settings.getByRole("button", { name: "Reopen field", exact: true }),
  ).toBeVisible();
  expect(requests).toEqual([
    {
      token: "owned-field-review",
      confirmation_name: field.name,
      password: "owned-test-password",
    },
  ]);
  expect(sandbox.documentWrites()).toBe(0);
  expect(sandbox.document().design.relationships[0]?.fieldMappings).toEqual([]);
});

test("bound module purge reviews stale challenges and refreshes removal without a draft write", async ({
  page,
}) => {
  const design = structuredClone(configuredSandboxDesign);
  const targetModule = design.modules[0];
  if (!targetModule) throw new Error("A module fixture is required");
  targetModule.closed = true;
  const liveId = "00000000-0000-4000-8000-000000000531";
  const binding = {
    kind: "module" as const,
    sandbox_id: targetModule.id,
    parent_sandbox_id: null,
    live_id: liveId,
    is_deleted: true,
  };
  let attempts = 0;
  await page.route(`**/api/modules/${liveId}/purge/preview`, (route) =>
    route.fulfill({
      json: {
        impact: lifecycleImpactFixture("module", liveId, "purge"),
        token: "owned-purge-review",
        expires_at: "2027-10-01T00:00:00Z",
        confirmation_name: "Requests",
      },
    }),
  );
  await page.route(`**/api/modules/${liveId}/purge`, async (route) => {
    attempts += 1;
    expect(route.request().postDataJSON()).toEqual({
      token: "owned-purge-review",
      confirmation_name: "Requests",
      password: "owned-test-password",
    });
    if (attempts === 1)
      return route.fulfill({
        status: 409,
        json: { detail: { code: "impact_changed", message: "Changed" } },
      });
    const confirmed = sandbox.document();
    confirmed.design.modules = confirmed.design.modules.filter(
      (item) => item.id !== targetModule.id,
    );
    confirmed.design.relationships = [];
    sandbox.confirmLiveDocument(confirmed);
    sandbox.confirmBindings([]);
    await route.fulfill({
      json: {
        impact: lifecycleImpactFixture("module", liveId, "purge"),
        operation_id: null,
      },
    });
  });
  const sandbox = await openAuthenticatedSandbox(page, design, {
    bindings: [binding],
  });
  await page
    .getByRole("button", { name: "Permanently delete module", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Permanently delete module",
    exact: true,
  });
  await dialog
    .getByLabel("Type the module name", { exact: true })
    .fill("Requests");
  await dialog
    .getByLabel("Administrator password", { exact: true })
    .fill("owned-test-password");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(attempts).toBe(0);
  await page
    .getByRole("button", { name: "Permanently delete module", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Administrator password", { exact: true }),
  ).toHaveValue("");
  await dialog
    .getByLabel("Type the module name", { exact: true })
    .fill("Requests");
  await dialog
    .getByLabel("Administrator password", { exact: true })
    .fill("owned-test-password");
  await dialog
    .getByRole("button", { name: "Permanently delete", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("changed");
  await dialog
    .getByRole("button", { name: "Review again", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Type the module name", { exact: true }),
  ).toHaveValue("");
  await expect(
    dialog.getByLabel("Administrator password", { exact: true }),
  ).toHaveValue("");
  await dialog
    .getByLabel("Type the module name", { exact: true })
    .fill("Requests");
  await dialog
    .getByLabel("Administrator password", { exact: true })
    .fill("owned-test-password");
  await dialog
    .getByRole("button", { name: "Permanently delete", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() =>
      sandbox
        .document()
        .design.modules.some((item) => item.id === targetModule.id),
    )
    .toBe(false);
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  expect(sandbox.documentWrites()).toBe(0);
  expect(attempts).toBe(2);
});

test("the bound department outline reviews blockers and reopens with explicit confirmation", async ({
  page,
}) => {
  const design = structuredClone(configuredSandboxDesign);
  const department = design.departments[0];
  if (!department) throw new Error("A department fixture is required");
  department.closed = true;
  design.modules.forEach((targetModule) => {
    if (targetModule.department === department.id) targetModule.closed = true;
  });
  const liveId = "00000000-0000-4000-8000-000000000541";
  const binding = {
    kind: "department" as const,
    sandbox_id: department.id,
    parent_sandbox_id: null,
    live_id: liveId,
    is_deleted: true,
  };
  const requests: unknown[] = [];
  await page.route(`**/api/departments/${liveId}/purge/preview`, (route) =>
    route.fulfill({
      json: {
        impact: {
          ...lifecycleImpactFixture("department", liveId, "purge"),
          blockers: [
            {
              code: "purge_trigger_dependency",
              entity_type: "record_triggers",
              entity_id: "00000000-0000-4000-8000-000000000542",
              detail: "A configured trigger still depends on this department.",
              conflicting_entity_type: null,
              conflicting_entity_id: null,
              field_id: null,
              field_name: null,
              module_id: null,
              module_name: null,
              department_id: liveId,
              department_name: department.name,
            },
          ],
        },
        token: "blocked-department-review",
        expires_at: "2027-10-01T00:00:00Z",
        confirmation_name: department.name,
      },
    }),
  );
  await page.route(`**/api/departments/${liveId}/reopen`, async (route) => {
    requests.push(route.request().postDataJSON());
    const confirmed = sandbox.document();
    confirmed.design.departments[0]!.closed = false;
    confirmed.design.modules.forEach((targetModule) => {
      if (targetModule.departmentId === department.id)
        targetModule.closed = false;
    });
    sandbox.confirmLiveDocument(confirmed);
    sandbox.confirmBindings([{ ...binding, is_deleted: false }]);
    await route.fulfill({
      json: {
        impact: lifecycleImpactFixture("department", liveId, "reopen"),
        operation_id: null,
      },
    });
  });
  const sandbox = await openAuthenticatedSandbox(page, design, {
    bindings: [binding],
  });
  await page
    .getByRole("tablist", { name: "Workbench view" })
    .getByRole("tab", { name: "Structure" })
    .click();
  const row = page.getByRole("button", {
    name: `Select department ${department.name}`,
    exact: true,
  });
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", {
      name: "Permanently delete department",
      exact: true,
    })
    .click();
  const purge = page.getByRole("dialog", {
    name: "Permanently delete department",
    exact: true,
  });
  await expect(purge).toContainText(
    "A configured trigger still depends on this department.",
  );
  await expect(
    purge.getByRole("button", { name: "Permanently delete", exact: true }),
  ).toBeDisabled();
  await purge.getByRole("button", { name: "Cancel", exact: true }).click();
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Reopen department", exact: true })
    .click();
  const reopen = page.getByRole("dialog", {
    name: "Reopen department",
    exact: true,
  });
  await reopen
    .getByRole("button", { name: "Reopen department", exact: true })
    .click();
  await expect(reopen).toBeHidden();
  await row.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Close department", exact: true }),
  ).toBeVisible();
  expect(requests).toEqual([{ confirmed: true }]);
  expect(sandbox.documentWrites()).toBe(0);
});

test("an organization template replaces the empty draft only after confirmation", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(page, initialDesign);

  await page.getByRole("button", { name: "More Sandbox actions" }).click();
  await page.getByRole("menuitem", { name: "Start from a template" }).click();
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

  // Applying parses the whole template and renders it on the Build canvas
  // before the dialog closes; on a 2-CPU runner under `next dev` that alone
  // can take most of the default 5s.
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(
    page.getByText("Procurement", { exact: true }).first(),
  ).toBeVisible();
  const document = sandbox.document();
  expect(document.design.departments.length).toBeGreaterThanOrEqual(3);
  expect(document.design.modules.length).toBeGreaterThanOrEqual(6);
  expect(document.triggers.length).toBeGreaterThanOrEqual(3);
  expect(document.scenarios).toEqual([]);
});

test("a detailed template remains usable when moving from Triggers to Test", async ({
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
  await page.getByRole("menuitem", { name: "Start from a template" }).click();
  await page
    .getByRole("button", { name: "Use Inventory & procurement" })
    .click();
  await page.getByRole("link", { name: "Triggers", exact: true }).click();
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
  await page.getByRole("menuitem", { name: "Start from a template" }).click();
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
      "0 departments · 0 modules · 0 fields · 0 relationships · 0 triggers",
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

test("an empty trigger list explains how to start and offers no save", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, initialDesign);
  await page.getByRole("link", { name: "Triggers", exact: true }).click();

  const settings = page.getByRole("region", { name: "Trigger settings" });
  await expect(settings).toContainText(
    "Select or create a trigger to edit its settings.",
  );
  await expect(
    settings.getByRole("button", { name: "Save triggers" }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Discard changes" }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "New trigger" }).click();
  await expect(
    settings.getByRole("button", { name: "Save triggers" }),
  ).toBeEnabled();
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

test("the canvas zoom range keeps a spread design legible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const spreadDesign = structuredClone(configuredSandboxDesign);
  spreadDesign.layout = {
    "sample-commercial": { x: 4000, y: 0, width: 600, height: 400 },
  };
  await openAuthenticatedSandbox(page, spreadDesign);
  const zoom = async () =>
    Number.parseInt(
      await page.getByRole("status", { name: "Canvas zoom" }).innerText(),
      10,
    );

  await page.getByRole("tab", { name: "Canvas" }).click();
  await page.getByRole("button", { name: "Fit canvas" }).click();
  await expect.poll(zoom).toBe(50);

  await expect(page.getByRole("button", { name: "Zoom out" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.getByRole("status", { name: "Canvas action" })).toHaveText(
    "Canvas at 50%. Part of the design is out of view.",
  );
});

test("an empty, never-published Sandbox offers one start and nothing to publish", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, initialDesign);
  const publish = page.getByRole("button", { name: "Review & Publish" });
  const canvas = page.getByLabel("Module design canvas");

  await expect(
    page.getByText("Nothing to publish yet", { exact: true }),
  ).toBeVisible();
  await expect(publish).toBeDisabled();
  await expect(
    canvas.getByRole("heading", { name: "Design your organization" }),
  ).toBeVisible();
  await expect(page.getByText("No departments yet")).toHaveCount(0);
  await expect(
    page.getByRole("searchbox", { name: "Search structure" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "More Sandbox actions" }).click();
  for (const name of ["Save checkpoint", "Discard draft changes"])
    await expect(page.getByRole("menuitem", { name })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  await page.keyboard.press("Escape");

  await canvas.getByRole("button", { name: "Start from a template" }).click();
  const templates = page.getByRole("dialog", {
    name: "Organization templates",
  });
  await expect(templates).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(templates).toBeHidden();

  await canvas
    .getByRole("button", { name: "Add your first department" })
    .click();
  await expect(page.getByLabel("Department name")).toBeFocused();
  await page.getByLabel("Department name").fill("Operations");
  await page.getByRole("button", { name: "Create department" }).click();

  await expect(
    canvas.getByRole("heading", { name: "Design your organization" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Unpublished changes", { exact: true }),
  ).toBeVisible();
  await expect(publish).toBeEnabled();
});

test("emptying the design clears a leftover Structure search", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, initialDesign);
  await page.getByRole("button", { name: "Add department" }).click();
  await page.getByLabel("Department name").fill("Operations");
  await page.getByRole("button", { name: "Create department" }).click();
  await page
    .getByRole("tablist", { name: "Workbench view" })
    .getByRole("tab", { name: "Structure" })
    .click();
  const search = page.getByRole("searchbox", { name: "Search structure" });
  await search.fill("no such item");
  await expect(page.getByText("No structure items match.")).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();

  await expect(search).toBeDisabled();
  await expect(page.getByText("No structure items match.")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add department" }),
  ).toBeVisible();
});

test("a published Sandbox with no new changes has nothing to publish", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    publishedHash: "a".repeat(64),
    hasUnpublishedChanges: false,
  });

  await expect(page.getByText("Published", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review & Publish" }),
  ).toBeDisabled();
});

test("a phone opens the Sandbox on the canvas", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAuthenticatedSandbox(page);

  await expect(page.getByRole("tab", { name: "Canvas" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByLabel("Module design canvas")).toBeVisible();
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

  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  await page.getByRole("button", { name: "New trigger" }).click();
  await page.getByLabel("Trigger name").fill("Notify inventory intake");
  await page.getByRole("button", { name: "Save triggers" }).click();

  const document = sandbox.document();
  expect(document.design.departments).toHaveLength(1);
  expect(document.design.modules).toHaveLength(2);
  expect(document.design.modules.flatMap((item) => item.fields)).toHaveLength(
    1,
  );
  expect(document.design.relationships).toHaveLength(1);
  expect(document.triggers).toHaveLength(1);
  expect(document.scenarios).toEqual([]);
});

test("creating a Select field saves a typed default as its choice ID", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(
    page,
    structuredClone(configuredSandboxDesign),
  );
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Field name", exact: true })
    .fill("Review stage");
  await page.getByLabel("Field type", { exact: true }).selectOption("Select");
  await page
    .getByLabel("Select options (comma separated)", { exact: true })
    .fill("Open, On hold");
  await page.getByLabel("Default value", { exact: true }).fill("Open");
  await page.getByRole("button", { name: "Create field" }).click();
  await expect.poll(sandbox.documentWrites).toBe(1);

  const created = sandbox
    .document()
    .design.modules.flatMap((item) => item.fields)
    .find((field) => field.name === "Review stage");
  expect(created?.config.kind).toBe("select");
  if (created?.config.kind !== "select")
    throw new Error("The saved Select field is required");
  expect(created.config.options.map((option) => option.label)).toEqual([
    "Open",
    "On hold",
  ]);
  const openId = created.config.options.find(
    (option) => option.label === "Open",
  )?.id;
  expect(openId).toBeTruthy();
  expect(created.config.defaultValue).toBe(openId);
  expect(created.config.options[1]?.id).not.toBe(openId);
});

test("a dirty trigger draft protects browser exits", async ({ page }) => {
  await openAuthenticatedSandbox(page);
  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  await page.getByLabel("Trigger name").fill("Unsaved trigger name");

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

test("trigger editing is locked while its save is pending", async ({
  page,
}) => {
  let releaseSave = () => {};
  const saveDelay = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { saveDelay });
  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  const name = page.getByLabel("Trigger name");
  await name.fill("Pending trigger save");
  await page.getByRole("button", { name: "Save triggers" }).click();

  try {
    await expect(name).toBeDisabled();
    await expect(page.getByLabel("Event", { exact: true })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Trigger options" }),
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
        triggerIds?: string[];
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
          triggerIds: request.triggerIds ?? null,
          result: {
            values: request.values,
            routes: [],
            triggerTraces: [],
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

test("a trigger issue opens the trigger it identifies", async ({ page }) => {
  const design = structuredClone(configuredSandboxDesign);
  const first = design.rules[0];
  if (!first) throw new Error("configured trigger is unavailable");
  design.rules.push({
    ...structuredClone(first),
    id: "sample-follow-up",
    name: "Follow-up request alert",
  });
  await openAuthenticatedSandbox(page, design, {
    issues: [
      {
        code: "trigger.invalid",
        message: "Review the follow-up trigger",
        targetId: "sample-follow-up",
      },
    ],
  });

  await page
    .getByRole("button", {
      name: "Review: Review the follow-up trigger",
    })
    .click();

  await expect(page.getByLabel("Trigger name")).toHaveValue(
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

test("Build undo preserves a trigger that was saved afterward", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(page);

  await page.getByRole("button", { name: "View canvas" }).click();
  await page.getByRole("menuitem", { name: "Auto-arrange" }).click();
  await expect(page.getByText("Canvas automatically arranged.")).toBeVisible();

  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  await page.getByLabel("Trigger name").fill("Saved urgent request alert");
  await page.getByRole("button", { name: "Save triggers" }).click();
  await expect(page.getByLabel("Trigger name")).toBeEnabled();

  await page.getByRole("link", { name: "Build", exact: true }).click();
  await page.getByRole("button", { name: "Undo" }).click();

  await expect
    .poll(() => sandbox.document().triggers[0]?.name)
    .toBe("Saved urgent request alert");
});

test("the publish review groups changes and keeps Publish in reach", async ({
  page,
}) => {
  const change = (
    kind: string,
    action: string,
    sandboxId: string,
    label: string,
  ) => ({ kind, action, sandboxId, label });
  await openAuthenticatedSandbox(
    page,
    { ...configuredSandboxDesign, rules: [] },
    {
      previewChanges: [
        ...Array.from({ length: 6 }, (_, index) =>
          change("department", "create", `dept-${index}`, `Team ${index + 1}`),
        ),
        change("module", "create", "sample-requests", "Service requests"),
        ...["Request number", "Title", "Status", "Priority"].map((name) =>
          change(
            "field",
            "create",
            publicationFieldKey("sample-requests", `sample-field-${name}`),
            name,
          ),
        ),
        change(
          "field",
          "update",
          publicationFieldKey("sample-equipment", "sample-field-Asset tag"),
          "Asset tag",
        ),
        change("field", "close", "retired-field", "Old notes"),
        change("relationship", "create", "sample-uses", "Uses equipment"),
      ],
    },
  );

  await page.getByRole("button", { name: "Review & Publish" }).click();
  const dialog = page.getByRole("dialog", { name: "Review and publish" });
  await expect(dialog.getByRole("heading", { name: "Changes" })).toBeVisible();
  await expect(
    dialog.getByText(
      "14 changes: 6 departments, 1 module, 6 fields, 1 relationship",
    ),
  ).toBeVisible();

  const departments = dialog.getByRole("region", { name: "Departments" });
  await expect(departments.getByRole("listitem")).toHaveCount(5);
  await departments
    .getByRole("button", { name: "Show all 6 departments" })
    .click();
  await expect(departments.getByRole("listitem")).toHaveCount(6);

  const modules = dialog.getByRole("region", { name: "Modules" });
  await expect(
    modules.getByRole("list", { name: "Fields in Service requests" }),
  ).toHaveCount(0);
  await modules
    .getByRole("button", { name: "Show 4 fields in Service requests" })
    .click();
  await modules
    .getByRole("button", { name: "Show 1 field in Equipment" })
    .click();
  await expect(
    modules
      .getByRole("list", { name: "Fields in Service requests" })
      .getByRole("listitem"),
  ).toHaveCount(4);
  const assetTag = modules
    .getByRole("list", { name: "Fields in Equipment" })
    .getByRole("listitem");
  await expect(assetTag).toHaveText(/Changed\s*Asset tag/);
  await expect(
    dialog.getByRole("region", { name: "Other", exact: true }),
  ).toContainText("Old notes");
  await expect(
    dialog.getByRole("region", { name: "Relationships" }),
  ).toContainText("Uses equipment");

  await expect(dialog.getByLabel("Your password")).toBeInViewport();
  await expect(
    dialog.getByRole("button", { name: "Publish changes" }),
  ).toBeInViewport();
});

test("a line to another department is drawn as a handoff", async ({ page }) => {
  const design = structuredClone(configuredSandboxDesign);
  design.relationships.push({
    id: "sample-billing",
    name: "Bills customer",
    source: "sample-requests",
    target: "sample-customers",
    cardinality: "One-to-many",
    fieldMappings: [],
  });
  await openAuthenticatedSandbox(page, design);
  const canvas = page.getByRole("region", { name: "Organization canvas" });
  const line = (id: string) =>
    canvas.locator(`.x6-cell[data-cell-id="${id}"] [data-sandbox-line]`);

  await expect(line("sample-uses")).toHaveAttribute(
    "data-sandbox-edge-kind",
    "relationship",
  );
  await expect(line("sample-billing")).toHaveAttribute(
    "data-sandbox-edge-kind",
    "handoff",
  );
  await page.getByText("Key", { exact: true }).click();
  await expect(page.getByRole("list", { name: "Canvas key" })).toContainText(
    "Handoff to another department",
  );

  // Every look keeps the two line kinds apart, on the canvas and in the key.
  for (const theme of ["slate", "whiteboard", "triplicate", "stockroom"]) {
    const dashes = await page.evaluate((id) => {
      if (id === "slate") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = id;
      const dash = (selector: string) =>
        getComputedStyle(document.querySelector(selector)!).strokeDasharray;
      return {
        relationship: dash('[data-cell-id="sample-uses"] [data-sandbox-line]'),
        handoff: dash('[data-cell-id="sample-billing"] [data-sandbox-line]'),
        keyRelationship: dash(
          '[data-sandbox-line="key"][data-sandbox-edge-kind="relationship"]',
        ),
        keyHandoff: dash(
          '[data-sandbox-line="key"][data-sandbox-edge-kind="handoff"]',
        ),
      };
    }, theme);
    // The dash means a link: relationships are dashed, handoffs are solid.
    expect(dashes.relationship, theme).not.toBe("none");
    expect(dashes.handoff, theme).toBe("none");
    expect(dashes.keyRelationship, theme).toBe(dashes.relationship);
    expect(dashes.keyHandoff, theme).toBe(dashes.handoff);
  }
});

test("a rejected password is reported beside Publish, not above the list", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, {
    ...configuredSandboxDesign,
    rules: [],
  });
  await page.route("**/api/sandbox/publications", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        detail: { code: "invalid_password", message: "Invalid password." },
      }),
    }),
  );
  await page.getByRole("button", { name: "Review & Publish" }).click();
  const dialog = page.getByRole("dialog", { name: "Review and publish" });
  const password = dialog.getByLabel("Your password");
  await expect(
    dialog.getByText("Enter your password to publish."),
  ).toBeVisible();

  await password.fill("not the password");
  await dialog.getByRole("button", { name: "Publish changes" }).click();

  const message = dialog.getByRole("alert").filter({
    hasText: "That password was not accepted.",
  });
  await expect(message).toBeInViewport();
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(password).toHaveAccessibleDescription(
    /That password was not accepted/,
  );
});

test("a successful Publish plays the look's title signature once", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, {
    ...configuredSandboxDesign,
    rules: [],
  });
  await page.route("**/api/sandbox/publications", (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "00000000-0000-4000-8000-000000000701",
        version: {
          id: "00000000-0000-4000-8000-000000000702",
          sequence: 1,
          kind: "published",
          label: "Published",
        },
        documentRevision: 1,
        documentHash: "b".repeat(64),
        impactDigest: "c".repeat(64),
        publishedAt: "2026-09-27T00:00:00Z",
      }),
    }),
  );
  const title = page.getByRole("heading", {
    level: 1,
    name: "Organization builder",
  });
  // Opening the Sandbox is not an earned moment.
  await expect(title).not.toHaveAttribute("data-signature");

  await page.getByRole("button", { name: "Review & Publish" }).click();
  const dialog = page.getByRole("dialog", { name: "Review and publish" });
  await dialog.getByLabel("Your password").fill("local password");
  await dialog.getByRole("button", { name: "Publish changes" }).click();

  await expect(
    page.getByText("Your changes are now published to the live workspace."),
  ).toBeVisible();
  await expect(title).toHaveAttribute("data-signature", "play");
});

test("hovering a module or relationship traces its connections", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuthenticatedSandbox(page);
  const canvas = page.getByRole("region", { name: "Organization canvas" });
  const cell = (id: string) => canvas.locator(`.x6-cell[data-cell-id="${id}"]`);
  await page.getByRole("button", { name: "Fit canvas" }).click();

  await cell("sample-requests").hover();
  await expect(cell("sample-customers")).toHaveAttribute("data-trace", "dim");
  await expect(cell("sample-equipment")).not.toHaveAttribute(
    "data-trace",
    "dim",
  );
  await expect(cell("sample-uses")).toHaveAttribute("data-trace", "on");

  await page.mouse.move(5, 5);
  await expect(canvas.locator('.x6-cell[data-trace="dim"]')).toHaveCount(0);
});

test("a pending publication review protects browser exits", async ({
  page,
}) => {
  let releasePreview = () => {};
  const publicationDelay = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  await openAuthenticatedSandbox(
    page,
    {
      ...initialDesign,
      departments: [{ id: "operations", name: "Operations", closed: false }],
    },
    { publicationDelay },
  );

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
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    saveFailure: "Sandbox storage is unavailable.",
    hasUnpublishedChanges: false,
  });
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();

  await page
    .getByRole("tablist", { name: "Workbench view" })
    .getByRole("tab", { name: "Structure" })
    .click();
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
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredSandboxDesign,
    {
      discardRefreshFailure: "The shared Sandbox could not be refreshed.",
    },
  );
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
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredSandboxDesign,
    {
      discardRefreshDelay,
    },
  );
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
        triggerIds: null,
        result: { values: {}, routes: [], triggerTraces: [], issues: [] },
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

test("trigger flow preview and summary follow the unsaved rule draft", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(page);
  await page.getByRole("link", { name: "Triggers", exact: true }).click();

  const flow = page.getByRole("region", { name: "Flow preview" });
  const summary = page.getByRole("region", { name: "Trigger summary" });
  const settings = page.getByRole("region", { name: "Trigger settings" });
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

  const savedTriggers = sandbox.document().triggers;
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
  expect(sandbox.document().triggers).toEqual(savedTriggers);

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

  await page.getByLabel("Event", { exact: true }).selectOption("schedule");
  await expect(
    flow.getByRole("button", { name: "Edit trigger" }),
  ).toContainText(/schedule/i);
  await expect(summary).toContainText(/schedule/i);
});

test("keyboard activation on a trigger flow node focuses its editor", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page);
  await page.getByRole("link", { name: "Triggers", exact: true }).click();

  const flow = page.getByRole("region", { name: "Flow preview" });
  const condition = page.getByLabel("Condition 1 field");
  const conditionNode = flow.getByRole("button", {
    name: "Edit condition 1",
  });
  await conditionNode.focus();
  await page.keyboard.press("Enter");
  await expect(condition).toBeFocused();
});

test("Trigger Studio layout screenshots can be captured for theme and viewport review", async ({
  page,
}) => {
  test.skip(
    process.env.TRIGGER_LAYOUT_SCREENSHOTS !== "1",
    "Set TRIGGER_LAYOUT_SCREENSHOTS=1 to capture layout evidence",
  );

  const screenshotDirectory = resolve(
    "..",
    ".agent-runtime/triggers-layout-20260925",
  );
  await mkdir(screenshotDirectory, { recursive: true });
  await openAuthenticatedSandbox(page);
  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Flow preview" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "New trigger" }).click();
  await page.getByLabel("Trigger name").fill("Service request follow-up");
  await page.getByLabel("Event", { exact: true }).selectOption("field-changed");
  const settings = page.getByRole("region", { name: "Trigger settings" });
  await settings
    .getByLabel("Event module")
    .selectOption({ label: "Service requests" });
  await settings.getByLabel("Event field").selectOption({ label: "Status" });
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
        `trigger-${view.width}-${view.theme}.png`,
      ),
      fullPage: true,
      animations: "disabled",
    });
  }
});

test("trigger panels resize with their requested minimum widths and remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await openAuthenticatedSandbox(page);
  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  const list = page.getByRole("complementary", { name: "Trigger list" });
  const settings = page.getByRole("region", { name: "Trigger settings" });
  const listHandle = page.getByRole("separator", {
    name: "Resize trigger list",
  });
  const settingsHandle = page.getByRole("separator", {
    name: "Resize trigger settings",
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
    .getByLabel("Trigger name")
    .fill("Narrow settings stay editable");
  await expect(settings.getByLabel("Trigger name")).toHaveValue(
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
  if (process.env.TRIGGER_LAYOUT_SCREENSHOTS === "1") {
    await page.screenshot({
      path: resolve(
        "..",
        ".agent-runtime/triggers-layout-20260925/trigger-resized-minimum.png",
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
      settings.getByRole("button", { name: "Save triggers", exact: true }),
    ).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(settingsHandle).toBeHidden();
  await expect(settings.getByLabel("Trigger name")).toHaveValue(
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

test("editing select choices preserves IDs, even when a label matches the default ID", async ({
  page,
}) => {
  const design = structuredClone(configuredSandboxDesign);
  const statusField = design.modules[0]?.fields.find(
    (field) => field.name === "Status",
  );
  if (!statusField) throw new Error("The Status select field is required");
  statusField.value = "Open";
  const sandbox = await openAuthenticatedSandbox(page, design);
  const readStatusField = () => {
    const raw: unknown = JSON.parse(JSON.stringify(sandbox.document()));
    const document = raw as {
      design: {
        modules: Array<{
          fields: Array<{
            name: string;
            config: {
              kind: string;
              defaultValue: unknown;
              options: Array<{ id: string; label: string }>;
            };
          }>;
        }>;
      };
    };
    const field = document.design.modules
      .flatMap((module) => module.fields)
      .find((candidate) => candidate.name === "Status");
    if (!field || field.config.kind !== "select")
      throw new Error("The saved Status select field is required");
    return field.config;
  };
  const before = readStatusField();
  const originalIds = Object.fromEntries(
    before.options.map((option) => [option.label, option.id]),
  );
  const openId = originalIds.Open;
  expect(openId).toBeTruthy();
  expect(before.defaultValue).toBe(openId);
  const idShapedLabel = openId;

  await page.getByRole("button", { name: "Show Status settings" }).click();
  const settings = page.getByLabel("Status field settings");
  await settings
    .getByLabel("Status options")
    .fill(`${idShapedLabel}, Open, In progress, Complete`);
  await settings.getByRole("button", { name: "Save field changes" }).click();
  await expect.poll(sandbox.documentWrites).toBe(1);

  const inserted = readStatusField();
  expect(inserted.options.find((option) => option.label === "Open")?.id).toBe(
    originalIds.Open,
  );
  expect(
    inserted.options.find((option) => option.label === "In progress")?.id,
  ).toBe(originalIds["In progress"]);
  expect(
    inserted.options.find((option) => option.label === "Complete")?.id,
  ).toBe(originalIds.Complete);
  const insertedId = inserted.options.find(
    (option) => option.label === idShapedLabel,
  )?.id;
  expect(insertedId).toBeTruthy();
  expect(Object.values(originalIds)).not.toContain(insertedId);
  expect(inserted.defaultValue).toBe(openId);

  await settings
    .getByLabel("Status options")
    .fill(`Complete, ${idShapedLabel}, Open, In progress`);
  await settings.getByRole("button", { name: "Save field changes" }).click();
  await expect.poll(sandbox.documentWrites).toBe(2);
  const reordered = readStatusField();
  expect(reordered.options.map((option) => [option.label, option.id])).toEqual([
    ["Complete", originalIds.Complete],
    [idShapedLabel, insertedId],
    ["Open", openId],
    ["In progress", originalIds["In progress"]],
  ]);

  await settings
    .getByLabel("Status options")
    .fill(`Complete, ${idShapedLabel}, Active, In progress`);
  await settings.getByRole("button", { name: "Save field changes" }).click();
  await expect.poll(sandbox.documentWrites).toBe(3);

  const after = readStatusField();
  expect(after.options.find((option) => option.label === "Active")?.id).toBe(
    openId,
  );
  expect(after.defaultValue).toBe(openId);

  await settings
    .getByLabel("Status options")
    .fill(`Complete, ${idShapedLabel}, In progress`);
  await settings.getByRole("button", { name: "Save field changes" }).click();
  await expect(
    settings.getByText("Default value must match a select option."),
  ).toBeVisible();
  expect(sandbox.documentWrites()).toBe(3);
  await settings.getByLabel("Status default value").selectOption("");
  await settings.getByRole("button", { name: "Save field changes" }).click();
  await expect.poll(sandbox.documentWrites).toBe(4);
  expect(readStatusField().defaultValue).toBeNull();

  const optionsInput = settings.getByLabel("Status options");
  const defaultInput = settings.getByLabel("Status default value");
  await optionsInput.fill(
    `Complete, ${idShapedLabel}, In progress, Draft choice`,
  );
  await defaultInput.selectOption({ label: "Draft choice" });
  await optionsInput.fill(
    `Draft choice, Complete, ${idShapedLabel}, In progress`,
  );
  await settings.getByRole("button", { name: "Save field changes" }).click();
  await expect.poll(sandbox.documentWrites).toBe(5);
  const savedNewChoice = readStatusField();
  const draftChoiceId = savedNewChoice.options.find(
    (option) => option.label === "Draft choice",
  )?.id;
  expect(draftChoiceId).toBeTruthy();
  expect(savedNewChoice.defaultValue).toBe(draftChoiceId);
  expect(
    savedNewChoice.options.find((option) => option.label === "Complete")?.id,
  ).toBe(originalIds.Complete);
  await captureOpenViewReview(page, "sandbox-stable-select-choice", {
    beforeScreenshot: async (capturePage, viewport) => {
      if (viewport.width < 640) {
        const propertiesTab = capturePage.getByRole("tab", {
          name: "Properties",
        });
        await expect(propertiesTab).toHaveCount(1);
        if ((await propertiesTab.getAttribute("aria-selected")) !== "true")
          await propertiesTab.click();
        const showSettings = capturePage
          .getByLabel("Status field settings")
          .getByRole("button", { name: "Show Status settings", exact: true });
        if (await showSettings.isVisible()) await showSettings.click();
      }
    },
  });
});

test("removing an unsaved selected choice requires an explicit new default", async ({
  page,
}) => {
  const design = structuredClone(configuredSandboxDesign);
  const sandbox = await openAuthenticatedSandbox(page, design);
  await page.getByRole("button", { name: "Show Status settings" }).click();
  const settings = page.getByLabel("Status field settings");
  const optionsInput = settings.getByLabel("Status options");
  await optionsInput.fill("Temporary, Open, In progress, Complete");
  await settings
    .getByLabel("Status default value")
    .selectOption({ label: "Temporary" });
  await optionsInput.fill("Open, In progress, Complete");
  await settings.getByRole("button", { name: "Save field changes" }).click();
  await expect(
    settings.getByText("Default value must match a select option."),
  ).toBeVisible();
  expect(sandbox.documentWrites()).toBe(0);
  await settings.getByLabel("Status default value").selectOption("");
  await settings.getByRole("button", { name: "Save field changes" }).click();
  await expect.poll(sandbox.documentWrites).toBe(1);
});

test("the Designer saves a module record title field in the current v4 draft", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const design = structuredClone(configuredSandboxDesign);
  const targetModule = design.modules[0];
  const titleField = targetModule?.fields.find(
    (field) => field.name === "Title",
  );
  if (!targetModule || !titleField)
    throw new Error("A module with a title field is required");
  const sandbox = await openAuthenticatedSandbox(page, design);

  await page
    .getByLabel("Record title field", { exact: true })
    .selectOption(titleField.id);
  await expect.poll(sandbox.documentWrites).toBe(1);

  const raw: unknown = JSON.parse(JSON.stringify(sandbox.document()));
  const document = raw as {
    design: { modules: Array<{ id: string; titleFieldId: string | null }> };
  };
  expect(
    document.design.modules.find((item) => item.id === targetModule.id)
      ?.titleFieldId,
  ).toBe(titleField.id);
  const titleSelector = page.getByLabel("Record title field", { exact: true });
  await expect(titleSelector).toHaveValue(titleField.id);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);

  const titleSettings = page.getByLabel(`${titleField.name} field settings`);
  await titleSettings
    .getByRole("button", { name: `Show ${titleField.name} settings` })
    .click();
  const closeField = titleSettings.getByRole("button", {
    name: "Close field",
  });
  await expect(
    titleSettings.getByText(/selected as the record title/i),
  ).toBeVisible();
  await expect(closeField).toBeDisabled();
  await captureOpenViewReview(page, "sandbox-selected-record-title", {
    beforeScreenshot: async (capturePage, viewport) => {
      if (viewport.width < 640) {
        const propertiesTab = capturePage.getByRole("tab", {
          name: "Properties",
        });
        await expect(propertiesTab).toHaveCount(1);
        if ((await propertiesTab.getAttribute("aria-selected")) !== "true")
          await propertiesTab.click();
        const showSettings = capturePage
          .getByLabel("Title field settings")
          .getByRole("button", { name: "Show Title settings", exact: true });
        if (await showSettings.isVisible()) await showSettings.click();
      }
    },
  });

  await titleSelector.selectOption("");
  await expect.poll(sandbox.documentWrites).toBe(2);
  await expect(
    titleSettings.getByText(/selected as the record title/i),
  ).toHaveCount(0);
  const showSettings = titleSettings.getByRole("button", {
    name: "Show Title settings",
    exact: true,
  });
  if (await showSettings.isVisible()) await showSettings.click();
  await expect(closeField).toBeEnabled();
});

test("Sandbox Test treats User values as simulated UUIDs without live eligibility lookup", async ({
  page,
}) => {
  const design = structuredClone(configuredSandboxDesign);
  const targetModule = design.modules[0];
  if (!targetModule) throw new Error("A test module is required");
  targetModule.fields.push({
    id: "sandbox-assignee",
    name: "Assigned user",
    type: "User",
    required: true,
    value: "",
    options: "",
    closed: false,
  });
  const requestPaths: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      path === "/api/users/00000000-0000-4000-8000-000000000001/preferences" &&
      request.method() === "GET"
    )
      return;
    requestPaths.push(path);
  });
  await openAuthenticatedSandbox(page, design);
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/sandbox/tests", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const input = route.request().postDataJSON() as {
      moduleId: string;
      values: Record<string, unknown>;
      event: { kind: string };
    };
    submitted = input.values;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "00000000-0000-4000-8000-000000000041",
        createdAt: "2026-09-25T10:00:00Z",
        documentRevision: 1,
        input: { moduleId: input.moduleId, values: input.values },
        event: input.event,
        triggerIds: null,
        result: {
          values: input.values,
          routes: [],
          triggerTraces: [],
          issues: [],
        },
      }),
    });
  });
  await page.getByRole("link", { name: "Test", exact: true }).click();
  const setup = page.getByRole("region", { name: "Test setup", exact: true });
  await expect(
    setup.getByText(/simulat(?:ed|ion).*UUID|UUID.*simulat(?:ed|ion)/i),
  ).toBeVisible();
  await expect(
    setup.getByText(
      /eligibility.*(?:not|never).*(?:check|verify)|(?:does not|never).*(?:check|verify).*eligibility/i,
    ),
  ).toBeVisible();

  const simulatedUserId = "00000000-0000-4000-8000-000000000042";
  await setup
    .getByLabel("Assigned user", { exact: true })
    .fill(simulatedUserId);
  await captureOpenViewReview(page, "sandbox-simulated-user-input");
  await setup.getByRole("button", { name: "Run test", exact: true }).click();
  await expect
    .poll(() => submitted?.["sandbox-assignee"])
    .toBe(simulatedUserId);
  expect(
    requestPaths.filter((path) =>
      /\/api\/(?:users(?:\/|$)|modules\/[^/]+\/assignable-users(?:\/|$))/.test(
        path,
      ),
    ),
  ).toEqual([]);
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
        triggerIds: null,
        result: {
          values: { ...request.values, "sample-field-Status": "Complete" },
          triggerTraces: [],
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
    triggerIds: null,
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
          triggerTraces: [],
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
          triggerTraces: [
            {
              triggerId: "sample-urgent",
              label: "Review request",
              outcome: "Applied",
            },
            {
              triggerId: "sample-urgent",
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
    "No value",
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
  const before = sandboxDocumentFromDesign(configuredSandboxDesign);
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
  const before = sandboxDocumentFromDesign(configuredSandboxDesign);
  const after = structuredClone(before);
  after.design.modules = [];
  after.design.departments = [];
  after.design.relationships = [];
  after.triggers = [];
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

test("a Test result from an older draft says so and can show its module on the canvas", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const repeated = {
    code: "trigger_invalid",
    message: "A set field action has an invalid value.",
    targetId: null,
  };
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    revision: 2,
    testRuns: [
      {
        id: "00000000-0000-4000-8000-000000000009",
        createdAt: "2026-09-21T00:01:00Z",
        documentRevision: 1,
        input: { moduleId: "sample-requests", values: {} },
        event: { kind: "record-created" },
        triggerIds: null,
        result: {
          values: {},
          routes: [],
          triggerTraces: [],
          issues: [repeated, repeated, repeated],
        },
      },
    ],
  });
  await page.goto("/sandbox?section=test");
  const outcome = page.getByRole("region", { name: "Test outcome" });
  await expect(
    outcome.getByText("This result is from an older draft."),
  ).toBeVisible();
  await expect(
    outcome.getByRole("button", { name: "Run again" }),
  ).toBeVisible();
  await expect(outcome.getByRole("listitem")).toHaveCount(1);
  await expect(outcome.getByRole("listitem")).toContainText("(3 times)");

  await outcome.getByRole("button", { name: "Show test on canvas" }).click();
  await expect(page).toHaveURL(/section=build/);
  const canvas = page.getByRole("region", { name: "Organization canvas" });
  const cell = (id: string) => canvas.locator(`.x6-cell[data-cell-id="${id}"]`);
  await expect(cell("sample-requests")).toHaveAttribute("data-trace", "on");
  await expect(cell("sample-uses")).toHaveAttribute("data-trace", "on");
  await expect(cell("sample-requests")).toBeInViewport();
  await expect(
    page.getByRole("complementary", { name: "Design inspector" }),
  ).toContainText("Service requests");
});

test("a Test run plays out on the canvas in three still steps", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    testRuns: [
      {
        id: "00000000-0000-4000-8000-000000000010",
        createdAt: "2026-09-21T00:02:00Z",
        documentRevision: 1,
        input: {
          moduleId: "sample-requests",
          values: { "sample-field-Status": "Open" },
        },
        event: { kind: "field-changed", fieldId: "sample-field-Status" },
        triggerIds: null,
        result: {
          values: {
            "sample-field-Status": "Open",
            "sample-field-Priority": "High",
          },
          routes: [],
          triggerTraces: [],
          issues: [],
        },
      },
    ],
  });
  await page.goto("/sandbox?section=test");
  await page
    .getByRole("region", { name: "Test outcome" })
    .getByRole("button", { name: "Show test on canvas" })
    .click();

  const canvas = page.getByRole("region", { name: "Organization canvas" });
  const row = (field: string) =>
    canvas.locator(
      `[data-field-id="sandbox-field:sample-requests:${encodeURIComponent(`sample-field-${field}`)}"]`,
    );
  await expect(page.getByText("Step 1 of 3: What happened")).toBeVisible();
  await expect(page.getByText("Status changes", { exact: true })).toBeVisible();
  await expect(row("Status")).toHaveAttribute("data-test-mark", "trigger");
  await expect(row("Priority")).not.toHaveAttribute("data-test-mark");

  await page.getByRole("button", { name: "Next step" }).click();
  await expect(page.getByText("Step 2 of 3: Triggers")).toBeVisible();
  await page.getByRole("button", { name: "Next step" }).click();
  await expect(page.getByText("Step 3 of 3: Result")).toBeVisible();
  await expect(page.getByText("Priority: Not provided → High")).toBeVisible();
  await expect(row("Priority")).toHaveAttribute("data-test-mark", "changed");
  await expect(page.getByRole("button", { name: "Next step" })).toBeDisabled();

  await page.getByRole("button", { name: "Clear" }).click();
  await expect(row("Status")).not.toHaveAttribute("data-test-mark");
  await expect(page.getByText("Step 3 of 3: Result")).toBeHidden();
});
