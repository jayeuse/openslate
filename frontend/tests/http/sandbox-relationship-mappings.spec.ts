import {
  exitGuarded,
  expect,
  heldResponse,
  settleReact,
  signedInAs,
  test,
  type Page,
} from "./helpers/test";
import { readFile } from "node:fs/promises";
import {
  initialDesign,
  type Design,
} from "../../src/components/systems/sandbox/domain/model";
import { publicationFieldKey } from "../../src/components/systems/sandbox/components/publish-change-groups";
import {
  capacityVersions,
  exportBundleFixture,
  historyPagingVersions,
  historyRegions,
  historyVersionFixture,
  installLifecycleRoutes,
  lifecycleImpactFixture,
  lifecycleReview,
  liveBinding,
  fieldRowTrigger,
  openAuthenticatedSandbox,
  openCheckpointDialog,
  openImportExport,
} from "./helpers/sandbox-api";
import {
  configuredSandboxDesign,
  sandboxDocumentFromDesign,
} from "../helpers/sandbox-fixtures";

// These journeys exercise lifecycle and settings, not disclosure, so they
// start as a viewer who left every Advanced block open. The closed default
// and its memory are covered in sandbox-inspector.spec.ts.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    for (const panel of [
      "module",
      "department",
      "field",
      "test",
      "test-results",
      "version",
    ])
      window.localStorage.setItem(
        `openslate:advanced:sandbox.${panel}`,
        "open",
      );
  });
});

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

async function expectNoBusySandboxRegionsAtReviewSizes(
  page: Page,
  theme: "light" | "dark",
) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    // The original callback checks the applied theme before its busy predicate.
    await expect(page.locator("html")).toHaveClass(
      theme === "dark" ? /dark/ : /^(?!.*dark)/,
    );
    await expect(
      page.locator('[data-slot="loading-region"][aria-busy="true"]'),
    ).toHaveCount(0);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`Sandbox zero busy loading regions in ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.route("**/api/users/*/preferences", (route) =>
        route.fulfill({
          json: {
            user_id: "00000000-0000-4000-8000-000000000001",
            theme,
            appearance: { motion: "reduce", keyboard_shortcuts: true },
          },
        }),
      );
    });

    test("incoming relationship close review", async ({ page }) => {
      const design = configuredDesignWithLegacyMapping();
      const relationship = design.relationships[0]!;
      const liveId = "00000000-0000-4000-8000-000000000561";
      const externalImpacts = [1, 2].map((endpoint) => ({
        edge_id: "00000000-0000-4000-8000-000000000562",
        field_id: liveId,
        external_record_id: `00000000-0000-4000-8000-00000000056${endpoint + 2}`,
        external_record_label: `Retained record ${endpoint}`,
        external_module_id: "00000000-0000-4000-8000-000000000565",
        external_module_name: "Equipment",
        external_department_id: "00000000-0000-4000-8000-000000000566",
        external_department_name: "Operations",
      }));
      await installLifecycleRoutes(
        page,
        { kind: "field", liveId },
        {
          reviews: {
            close: () =>
              lifecycleReview("field", liveId, "close", {
                token: "owned-relationship-close",
                confirmationName: "Live equipment link",
                impact: { external_impacts: externalImpacts },
              }),
          },
        },
      );
      await openAuthenticatedSandbox(page, design, {
        bindings: [liveBinding("relationship", relationship.id, liveId)],
      });
      await page.goto(`/sandbox?module=${relationship.target}`);
      await page
        .getByRole("button", {
          name: `Close relationship ${relationship.name}, incoming`,
          exact: true,
        })
        .click();
      const close = page.getByRole("dialog", {
        name: "Close relationship",
        exact: true,
      });
      await expect(
        close.getByText(
          "1 record link will be closed. Existing records are kept.",
          { exact: true },
        ),
      ).toBeVisible();
      await expectNoBusySandboxRegionsAtReviewSizes(page, theme);
    });

    test("filtered capacity 45 History and checkpoint review", async ({
      page,
    }) => {
      await openAuthenticatedSandbox(page, configuredSandboxDesign, {
        versions: capacityVersions(45),
      });
      await page.getByRole("link", { name: "History", exact: true }).click();
      const { timeline } = historyRegions(page);
      await timeline.getByLabel("Find a version").fill("Needle");
      await expect(timeline).toContainText("1 saved version");
      const text =
        "45 of 50 versions used. Delete the oldest unpublished checkpoints to free space.";
      await expect(timeline.getByText(text, { exact: true })).toBeVisible();
      await expectNoBusySandboxRegionsAtReviewSizes(page, theme);
      const checkpoint = await openCheckpointDialog(page);
      await expect(checkpoint.getByText(text, { exact: true })).toBeVisible();
      await expectNoBusySandboxRegionsAtReviewSizes(page, theme);
    });

    test("filtered 28-version export after the unchecked download", async ({
      page,
    }) => {
      const versions = Array.from({ length: 28 }, (_, index) => ({
        ...historyVersionFixture(
          index + 1,
          index === 0 ? "Needle checkpoint" : `Export version ${index + 1}`,
          index < 20 ? "checkpoint" : "published",
        ),
        createdAt: "2026-10-01T10:00:00Z",
      }));
      const document = sandboxDocumentFromDesign(configuredSandboxDesign);
      const bundle = exportBundleFixture(versions, document);
      await page.route("**/api/sandbox/export?*", (route) =>
        route.fulfill({
          contentType: "application/json",
          headers: {
            "Content-Disposition":
              'attachment; filename="owned-sandbox-history.json"',
          },
          json:
            new URL(route.request().url()).searchParams.get(
              "includeVersions",
            ) === "true"
              ? bundle
              : document,
        }),
      );
      await openAuthenticatedSandbox(page, configuredSandboxDesign, {
        versions,
      });
      await page.getByRole("link", { name: "History", exact: true }).click();
      const { timeline } = historyRegions(page);
      await timeline.getByLabel("Find a version").fill("Needle");
      await expect(timeline).toContainText("1 saved version");
      const dialog = await openImportExport(page);
      const include = dialog.getByRole("checkbox", {
        name: "Include version history",
        exact: true,
      });
      await expect(include).not.toBeChecked();
      await expect(
        dialog.getByText("28 saved versions", { exact: true }),
      ).toBeVisible();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        dialog
          .getByRole("button", { name: "Export JSON", exact: true })
          .click(),
      ]);
      await download.path();
      await include.check();
      await expectNoBusySandboxRegionsAtReviewSizes(page, theme);
    });

    test("51-version export ready and held pending from Build", async ({
      page,
    }) => {
      const versions = capacityVersions(50);
      const bundle = exportBundleFixture(versions);
      const pending = heldResponse();
      await page.route("**/api/sandbox/export?*", async (route) => {
        pending.enter();
        await pending.released;
        await route.fulfill({
          headers: {
            "Content-Disposition":
              'attachment; filename="owned-history-51.json"',
          },
          json: bundle,
        });
      });
      await openAuthenticatedSandbox(page, configuredSandboxDesign, {
        versions,
      });
      const dialog = await openImportExport(page);
      await expect(
        dialog.getByText("51 saved versions", { exact: true }),
      ).toBeVisible();
      await dialog
        .getByRole("checkbox", { name: "Include version history", exact: true })
        .check();
      await expectNoBusySandboxRegionsAtReviewSizes(page, theme);
      try {
        await dialog
          .getByRole("button", { name: "Export JSON", exact: true })
          .click();
        await pending.entered;
        await expect(
          dialog.getByRole("button", { name: "Exporting…", exact: true }),
        ).toBeDisabled();
        await expectNoBusySandboxRegionsAtReviewSizes(page, theme);
        const completedDownload = page.waitForEvent("download");
        pending.release();
        await completedDownload;
      } finally {
        pending.release();
      }
    });
  });
}

test("bound module lifecycle uses the live name and refreshes the saved design", async ({
  page,
}) => {
  const design = structuredClone(configuredSandboxDesign);
  const targetModule = design.modules[0];
  if (!targetModule) throw new Error("A module fixture is required");
  targetModule.name = "Unpublished requests";
  const liveId = "00000000-0000-4000-8000-000000000501";
  const binding = liveBinding("module", targetModule.id, liveId);
  const requests: unknown[] = [];
  let failPostMutationRead = false;
  await installLifecycleRoutes(
    page,
    { kind: "module", liveId },
    {
      reviews: {
        close: () =>
          lifecycleReview("module", liveId, "close", {
            token: "owned-close-review",
            confirmationName: "Requests",
          }),
      },
      commands: {
        close: (body) => {
          requests.push(body);
          const confirmed = sandbox.document();
          const target = confirmed.design.modules.find(
            (item) => item.id === targetModule.id,
          );
          if (!target) throw new Error("The owned module disappeared");
          target.closed = true;
          sandbox.confirmLiveDocument(confirmed);
          sandbox.confirmBindings([{ ...binding, is_deleted: true }]);
          return { operationId: "00000000-0000-4000-8000-000000000502" };
        },
        reopen: () => {
          const confirmed = sandbox.document();
          const target = confirmed.design.modules.find(
            (item) => item.id === targetModule.id,
          );
          if (!target) throw new Error("The owned module disappeared");
          target.closed = false;
          sandbox.confirmLiveDocument(confirmed);
          sandbox.confirmBindings([binding]);
          failPostMutationRead = true;
        },
      },
    },
  );
  const sandbox = await openAuthenticatedSandbox(page, design, {
    bindings: [binding],
  });
  await page.route("**/api/sandbox/document", (route) => {
    if (route.request().method() === "GET" && failPostMutationRead) {
      failPostMutationRead = false;
      return route.fulfill({
        status: 503,
        json: { detail: "Owned live-state refresh unavailable" },
      });
    }
    return route.fallback();
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
  // The refreshed design keeps the draft name and leaves every field open.
  const inspector = page.getByRole("complementary", {
    name: "Design inspector",
  });
  await expect(inspector).toContainText("Unpublished requests");
  for (const field of targetModule.fields)
    await expect(
      inspector
        .getByLabel(`${field.name} field settings`, { exact: true })
        .getByText(field.type, { exact: true }),
    ).toBeVisible();
  // A notice's title is a heading; its text also sits in a live region.
  const confirmedStatus = page.getByRole("heading", {
    name: "Live change confirmed",
    exact: true,
  });
  await expect(confirmedStatus.first()).toBeVisible();
  const confirmedBefore = await confirmedStatus.count();
  async function confirmModuleChange(action: "Close module" | "Reopen module") {
    await page.getByRole("button", { name: action, exact: true }).click();
    const review = page.getByRole("dialog", { name: action, exact: true });
    if (action === "Close module") {
      await review
        .getByLabel("Type the module name", { exact: true })
        .fill("Requests");
      await review
        .getByLabel("Administrator password", { exact: true })
        .fill("owned-test-password");
    }
    await review.getByRole("button", { name: action, exact: true }).click();
    await expect(review).toBeHidden();
  }
  await confirmModuleChange("Reopen module");
  const recoveryError = page.getByRole("alert").filter({
    hasText:
      "The live change was confirmed. Reload live state before making another change.",
  });
  await expect(recoveryError).toBeVisible();
  // The failed refresh adds no success notice (earlier ones may still be
  // fading out).
  await expect
    .soft(async () =>
      expect(await confirmedStatus.count()).toBeLessThanOrEqual(
        confirmedBefore,
      ),
    )
    .toPass();
  await page
    .getByRole("button", { name: "Reload live state", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Close module", exact: true }),
  ).toBeEnabled();
  await expect.soft(recoveryError).toHaveCount(0);
  await confirmModuleChange("Close module");
  await expect(confirmedStatus.first()).toBeVisible();
  await expect.soft(recoveryError).toHaveCount(0);
  expect(sandbox.documentWrites()).toBe(writes);
});

// A 503 reaches the same failed read as this 403 (one error branch for the
// live-state read); the 403 keeps the denial journey.
test("a 403 bindings read never becomes a draft-only lifecycle action", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredSandboxDesign,
    { bindingFailure: 403 },
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
  await page.getByRole("button", { name: "Close module", exact: true }).click();
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
  await installLifecycleRoutes(
    page,
    { kind: "module", liveId },
    {
      reviews: {
        close: async () => {
          await delay;
          return lifecycleReview("module", liveId, "close", {
            token: "late-review",
            confirmationName: "Requests",
          });
        },
      },
    },
  );
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredSandboxDesign,
    {
      bindings: [liveBinding("module", targetModule.id, liveId)],
    },
  );
  await page.getByRole("button", { name: "Close module", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Close module",
    exact: true,
  });
  try {
    await expect(dialog).toBeVisible();
    await expect.poll(() => exitGuarded(page)).toBe(true);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => exitGuarded(page)).toBe(false);
  } finally {
    release();
  }
  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  await expect(page.getByLabel("Trigger name")).toBeVisible();
  await expect(dialog).toBeHidden();
  expect(sandbox.documentWrites()).toBe(0);
});

for (const orientation of ["outgoing", "incoming"] as const) {
  test(`bound ${orientation} relationship uses Field lifecycle and counts unique record links`, async ({
    page,
  }) => {
    const design = configuredDesignWithLegacyMapping();
    const relationship = design.relationships[0]!;
    const liveId = "00000000-0000-4000-8000-000000000561";
    const binding = liveBinding("relationship", relationship.id, liveId);
    const requests: Array<{ operation: string; body: unknown }> = [];
    const externalImpacts = [1, 2].map((endpoint) => ({
      edge_id: "00000000-0000-4000-8000-000000000562",
      field_id: liveId,
      external_record_id: `00000000-0000-4000-8000-00000000056${endpoint + 2}`,
      external_record_label: `Retained record ${endpoint}`,
      external_module_id: "00000000-0000-4000-8000-000000000565",
      external_module_name: "Equipment",
      external_department_id: "00000000-0000-4000-8000-000000000566",
      external_department_name: "Operations",
    }));
    const review = (operation: "close" | "purge") => () =>
      lifecycleReview("field", liveId, operation, {
        token: `owned-relationship-${operation}`,
        confirmationName: "Live equipment link",
        impact: { external_impacts: externalImpacts },
      });
    const confirm =
      (operation: "close" | "reopen" | "purge") => (body: unknown) => {
        requests.push({ operation, body });
        const confirmed = sandbox.document();
        if (operation === "purge")
          confirmed.design.relationships =
            confirmed.design.relationships.filter(
              (item) => item.id !== relationship.id,
            );
        sandbox.confirmLiveDocument(confirmed);
        sandbox.confirmBindings(
          operation === "purge"
            ? []
            : [{ ...binding, is_deleted: operation === "close" }],
        );
      };
    await installLifecycleRoutes(
      page,
      { kind: "field", liveId },
      {
        reviews: { close: review("close"), purge: review("purge") },
        commands: {
          close: confirm("close"),
          reopen: confirm("reopen"),
          purge: confirm("purge"),
        },
      },
    );
    const sandbox = await openAuthenticatedSandbox(page, design, {
      bindings: [binding],
    });
    await page.goto(
      `/sandbox?module=${orientation === "outgoing" ? relationship.source : relationship.target}`,
    );
    const action = (verb: string) =>
      page.getByRole("button", {
        name: `${verb} relationship ${relationship.name}, ${orientation}`,
        exact: true,
      });
    await action("Close").click();
    const close = page.getByRole("dialog", {
      name: "Close relationship",
      exact: true,
    });
    await expect(
      close.getByText(
        "1 record link will be closed. Existing records are kept.",
        { exact: true },
      ),
    ).toBeVisible();
    await close
      .getByLabel("Type the relationship name")
      .fill(relationship.name);
    await close
      .getByLabel("Administrator password")
      .fill("owned-test-password");
    await expect(
      close.getByRole("button", { name: "Close relationship", exact: true }),
    ).toBeDisabled();
    await close
      .getByLabel("Type the relationship name")
      .fill("Live equipment link");
    await close
      .getByRole("button", { name: "Close relationship", exact: true })
      .click();
    await expect(close).toBeHidden();
    await action("Reopen").click();
    await page
      .getByRole("dialog", { name: "Reopen relationship", exact: true })
      .getByRole("button", { name: "Reopen relationship", exact: true })
      .click();
    await expect(action("Close")).toBeVisible();
    await action("Close").click();
    await close
      .getByLabel("Type the relationship name")
      .fill("Live equipment link");
    await close
      .getByLabel("Administrator password")
      .fill("owned-test-password");
    await close
      .getByRole("button", { name: "Close relationship", exact: true })
      .click();
    await expect(close).toBeHidden();
    await action("Permanently delete").click();
    const purge = page.getByRole("dialog", {
      name: "Permanently delete relationship",
      exact: true,
    });
    await purge.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(requests.map((item) => item.operation)).toEqual([
      "close",
      "reopen",
      "close",
    ]);
    await action("Permanently delete").click();
    await purge
      .getByLabel("Type the relationship name")
      .fill("Live equipment link");
    await purge
      .getByLabel("Administrator password")
      .fill("owned-test-password");
    await purge
      .getByRole("button", { name: "Permanently delete", exact: true })
      .click();
    await expect(purge).toBeHidden();
    await expect(action("Close")).toHaveCount(0);
    expect(requests).toEqual([
      {
        operation: "close",
        body: {
          token: "owned-relationship-close",
          confirmation_name: "Live equipment link",
          password: "owned-test-password",
        },
      },
      { operation: "reopen", body: { confirmed: true } },
      {
        operation: "close",
        body: {
          token: "owned-relationship-close",
          confirmation_name: "Live equipment link",
          password: "owned-test-password",
        },
      },
      {
        operation: "purge",
        body: {
          token: "owned-relationship-purge",
          confirmation_name: "Live equipment link",
          password: "owned-test-password",
        },
      },
    ]);
    expect(sandbox.documentWrites()).toBe(0);
    expect(sandbox.document().design.modules).toEqual(
      sandboxDocumentFromDesign(design).design.modules,
    );
  });
}

test("relationship mismatched Field preview refuses confirmation", async ({
  page,
}) => {
  const design = configuredDesignWithLegacyMapping();
  const relationship = design.relationships[0]!;
  const liveId = "00000000-0000-4000-8000-000000000571";
  let commands = 0;
  await installLifecycleRoutes(
    page,
    { kind: "field", liveId },
    {
      // The review names another field than the one the dialog closes.
      reviews: {
        close: () =>
          lifecycleReview(
            "field",
            "00000000-0000-4000-8000-000000000572",
            "close",
            { token: "wrong-target", confirmationName: "Live link" },
          ),
      },
      commands: {
        close: () => {
          commands += 1;
          return { status: 500, json: {} };
        },
      },
    },
  );
  await openAuthenticatedSandbox(page, design, {
    bindings: [liveBinding("relationship", relationship.id, liveId)],
  });
  await page.goto(`/sandbox?module=${relationship.source}`);
  await page
    .getByRole("button", {
      name: `Close relationship ${relationship.name}, outgoing`,
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Close relationship",
    exact: true,
  });
  await expect(dialog.getByRole("alert")).toContainText(
    "This close could not be confirmed. Request a new review and try again.",
  );
  await expect(
    dialog.getByRole("button", { name: "Close relationship", exact: true }),
  ).toBeDisabled();
  expect(commands).toBe(0);
});

test("bound draft deletion explains retained live data while unbound copy remains", async ({
  page,
}) => {
  const design = configuredDesignWithLegacyMapping();
  const relationship = design.relationships[0]!;
  await openAuthenticatedSandbox(page, design, {
    bindings: [
      liveBinding(
        "relationship",
        relationship.id,
        "00000000-0000-4000-8000-000000000581",
      ),
      liveBinding(
        "module",
        relationship.source,
        "00000000-0000-4000-8000-000000000582",
      ),
    ],
  });
  await page.goto(`/sandbox?module=${relationship.source}`);
  await page
    .getByRole("button", {
      name: `Delete relationship ${relationship.name}, outgoing`,
      exact: true,
    })
    .click();
  const deletion = page.getByRole("alertdialog");
  await expect(deletion).toContainText(
    "On publish, the live item closes. Its data is kept.",
  );
  await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("tab", { name: "Structure", exact: true }).click();
  await page
    .getByRole("button", {
      name: `Select module ${design.modules.find((module) => module.id === relationship.source)!.name}`,
      exact: true,
    })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Delete module", exact: true })
    .click();
  await expect(deletion).toContainText(
    "On publish, the live item closes. Its data is kept.",
  );
  await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goto(`/sandbox?module=${relationship.target}`);
  await page.getByRole("tab", { name: "Structure", exact: true }).click();
  await page
    .getByRole("button", {
      name: `Select module ${design.modules.find((module) => module.id === relationship.target)!.name}`,
      exact: true,
    })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Delete module", exact: true })
    .click();
  await expect(deletion).not.toContainText(
    "On publish, the live item closes. Its data is kept.",
  );
  await expect(deletion).toContainText("Undo");
});

test("a failed delete shows its error inside the delete dialog", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    saveFailure: "Sandbox storage is unavailable.",
  });
  // Customers is not the module Build opens on, so the failed local
  // proposal keeps the same designer and its open dialog.
  await page.getByRole("tab", { name: "Structure", exact: true }).click();
  await page
    .getByRole("button", { name: "Select module Customers", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Delete module", exact: true })
    .click();
  const deletion = page.getByRole("alertdialog");
  await deletion
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(deletion.getByRole("alert")).toHaveText(
    "This Sandbox change could not be saved. Try again.",
  );
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
  const binding = liveBinding("field", field.id, liveId, {
    parent: targetModule.id,
  });
  otherField.id = field.id;
  const mapping = design.relationships[0]?.fieldMappings?.[0];
  if (mapping) mapping.targetFieldId = field.id;
  const requests: unknown[] = [];
  await installLifecycleRoutes(
    page,
    { kind: "field", liveId },
    {
      reviews: {
        close: () =>
          lifecycleReview("field", liveId, "close", {
            token: "owned-field-review",
            confirmationName: field.name,
          }),
      },
      commands: {
        close: (body) => {
          requests.push(body);
          const confirmed = sandbox.document();
          const current = confirmed.design.modules
            .find((item) => item.id === targetModule.id)
            ?.fields.find((item) => item.id === field.id);
          if (!current) throw new Error("The owned field disappeared");
          current.closed = true;
          confirmed.design.relationships[0]!.fieldMappings = [];
          sandbox.confirmLiveDocument(confirmed);
          sandbox.confirmBindings([{ ...binding, is_deleted: true }]);
        },
      },
    },
  );
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
  await fieldRowTrigger(settings, field.name).click();
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
  await expect(
    settings.getByRole("button", {
      name: "Permanently delete field",
      exact: true,
    }),
  ).toBeVisible();
  expect(requests).toEqual([
    {
      token: "owned-field-review",
      confirmation_name: field.name,
      password: "owned-test-password",
    },
  ]);
  expect(sandbox.documentWrites()).toBe(0);
  // The refreshed relationship no longer lists the closed field's mapping.
  await page
    .getByRole("button", {
      name: "Edit outgoing relationship Uses equipment",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("dialog").getByText("Legacy field mappings"),
  ).toHaveCount(0);
});

test("bound module purge reviews stale challenges and refreshes removal without a draft write", async ({
  page,
}) => {
  const design = structuredClone(configuredSandboxDesign);
  const targetModule = design.modules[0];
  if (!targetModule) throw new Error("A module fixture is required");
  targetModule.closed = true;
  const liveId = "00000000-0000-4000-8000-000000000531";
  const binding = liveBinding("module", targetModule.id, liveId, {
    deleted: true,
  });
  let attempts = 0;
  await installLifecycleRoutes(
    page,
    { kind: "module", liveId },
    {
      reviews: {
        purge: () =>
          lifecycleReview("module", liveId, "purge", {
            token: "owned-purge-review",
            confirmationName: "Requests",
          }),
      },
      commands: {
        purge: (body) => {
          attempts += 1;
          expect(body).toEqual({
            token: "owned-purge-review",
            confirmation_name: "Requests",
            password: "owned-test-password",
          });
          if (attempts === 1)
            return {
              status: 409,
              json: { detail: { code: "impact_changed", message: "Changed" } },
            };
          const confirmed = sandbox.document();
          confirmed.design.modules = confirmed.design.modules.filter(
            (item) => item.id !== targetModule.id,
          );
          confirmed.design.relationships = [];
          sandbox.confirmLiveDocument(confirmed);
          sandbox.confirmBindings([]);
        },
      },
    },
  );
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
  await expect(dialog.getByText(/Last successful backup/)).toHaveText(
    "Last successful backup: No successful backup recorded.",
  );
  await expect(
    dialog.getByLabel("Administrator password", { exact: true }),
  ).toBeVisible();
  sandbox.workspace.purge_enabled = false;
  await sandbox.refreshWorkspace();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Reopen module", exact: true }),
  ).toBeEnabled();
  expect(attempts).toBe(0);
  sandbox.workspace.purge_enabled = true;
  await sandbox.refreshWorkspace();
  await page
    .getByRole("button", { name: "Permanently delete module", exact: true })
    .click();
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
  await expect(
    page
      .getByRole("region", { name: "Organization canvas" })
      .locator(`[data-sandbox-node="${targetModule.id}"]`),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  expect(sandbox.documentWrites()).toBe(0);
  expect(attempts).toBe(2);
});

for (const state of ["disabled", "unknown", "unavailable"] as const) {
  test(`closed Sandbox items remain reopenable while permanent deletion is ${state}`, async ({
    page,
  }) => {
    const design = structuredClone(configuredSandboxDesign);
    const targetModule = design.modules[0];
    const department = design.departments[0];
    const field = targetModule?.fields[0];
    if (!targetModule || !department || !field)
      throw new Error("A department, module and field are required");
    targetModule.closed = true;
    department.closed = true;
    field.closed = true;
    const sandbox = await openAuthenticatedSandbox(page, design, {
      bindings: [
        liveBinding(
          "department",
          department.id,
          "00000000-0000-4000-8000-000000000551",
          { deleted: true },
        ),
        liveBinding(
          "module",
          targetModule.id,
          "00000000-0000-4000-8000-000000000552",
          { deleted: true },
        ),
        liveBinding("field", field.id, "00000000-0000-4000-8000-000000000553", {
          parent: targetModule.id,
          deleted: true,
        }),
      ],
    });
    sandbox.workspace.purge_enabled = state === "unknown" ? undefined : false;
    sandbox.failWorkspaceRead(state === "unavailable");
    await sandbox.refreshWorkspace();
    await expect(
      page.getByRole("button", { name: "Reopen module", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", {
        name: "Permanently delete module",
        exact: true,
      }),
    ).toHaveCount(0);
    const settings = page.getByLabel(`${field.name} field settings`, {
      exact: true,
    });
    await fieldRowTrigger(settings, field.name).click();
    await expect(
      settings.getByRole("button", { name: "Reopen field", exact: true }),
    ).toBeEnabled();
    await expect(
      settings.getByRole("button", {
        name: "Permanently delete field",
        exact: true,
      }),
    ).toHaveCount(0);
    await page
      .getByRole("tablist", { name: "Workbench view" })
      .getByRole("tab", { name: "Structure" })
      .click();
    for (const [kind, item] of [
      ["department", department],
      ["module", targetModule],
    ] as const) {
      const row = page.getByRole("button", {
        name: `Select ${kind} ${item.name}`,
        exact: true,
      });
      await row.click({ button: "right" });
      await expect(
        page.getByRole("menuitem", { name: `Reopen ${kind}`, exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole("menuitem", {
          name: `Permanently delete ${kind}`,
          exact: true,
        }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    await page
      .getByRole("button", {
        name: `Select department ${department.name}`,
        exact: true,
      })
      .click();
    await page
      .getByRole("tablist", { name: "Workbench view" })
      .getByRole("tab", { name: "Properties" })
      .click();
    await expect(
      page.getByRole("button", { name: "Reopen department", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", {
        name: "Permanently delete department",
        exact: true,
      }),
    ).toHaveCount(0);
    expect(sandbox.documentWrites()).toBe(0);
  });
}

test("a retained saved Chart query blocks bound field purge until repaired", async ({
  page,
}) => {
  const design = structuredClone(configuredSandboxDesign);
  const targetModule = design.modules[0];
  const field = targetModule?.fields[1];
  const department = design.departments.find(
    (item) => item.id === targetModule?.department,
  );
  if (!targetModule || !field || !department)
    throw new Error("A bound primitive field is required");
  field.closed = true;
  const liveId = "00000000-0000-4000-8000-000000000591";
  const chartId = "00000000-0000-4000-8000-000000000592";
  const liveModuleId = "00000000-0000-4000-8000-000000000593";
  const liveDepartmentId = "00000000-0000-4000-8000-000000000594";
  const binding = liveBinding("field", field.id, liveId, {
    parent: targetModule.id,
    deleted: true,
  });
  let retainedReferences = [liveId];
  let reviews = 0;
  const requests: unknown[] = [];
  const detail = `Repair the retained saved Chart 'Retained workload' query before permanently deleting Field '${field.name}'; archiving the Chart keeps its query`;
  await installLifecycleRoutes(
    page,
    { kind: "field", liveId },
    {
      reviews: {
        purge: () => {
          reviews += 1;
          const blocked = retainedReferences.includes(liveId);
          const impact = lifecycleImpactFixture("field", liveId, "purge");
          return lifecycleReview("field", liveId, "purge", {
            token: `owned-chart-review-${reviews}`,
            confirmationName: field.name,
            impact: {
              rows: blocked
                ? [
                    ...impact.rows,
                    {
                      entity_type: "charts",
                      entity_id: chartId,
                      is_deleted: true,
                      deleted_at: "2026-10-01T00:00:00Z",
                      updated_at: "2026-10-01T00:00:00Z",
                      state_fingerprint: "retained-chart-query",
                      byte_count: null,
                    },
                  ]
                : impact.rows,
              blockers: blocked
                ? [
                    {
                      code: "purge_chart_dependency",
                      entity_type: "charts",
                      entity_id: chartId,
                      detail,
                      conflicting_entity_type: "fields",
                      conflicting_entity_id: liveId,
                      field_id: liveId,
                      field_name: field.name,
                      module_id: liveModuleId,
                      module_name: targetModule.name,
                      department_id: liveDepartmentId,
                      department_name: department.name,
                    },
                  ]
                : [],
            },
          });
        },
      },
      commands: {
        purge: (body) => {
          requests.push(body);
          expect(retainedReferences).toEqual([]);
          const document = sandbox.document();
          const current = document.design.modules.find(
            (item) => item.id === targetModule.id,
          );
          if (!current) throw new Error("The owned targetModule disappeared");
          current.fields = current.fields.filter(
            (item) => item.id !== field.id,
          );
          sandbox.confirmLiveDocument(document);
          sandbox.confirmBindings([]);
        },
      },
    },
  );
  const sandbox = await openAuthenticatedSandbox(page, design, {
    bindings: [binding],
  });
  const settings = page.getByLabel(`${field.name} field settings`, {
    exact: true,
  });
  await fieldRowTrigger(settings, field.name).click();
  await settings
    .getByRole("button", { name: "Permanently delete field", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Permanently delete field",
    exact: true,
  });
  await expect(dialog.getByText(detail, { exact: true })).toBeVisible();
  await expect(dialog).toContainText("1 chart");
  await expect(
    dialog.getByRole("button", { name: "Permanently delete", exact: true }),
  ).toBeDisabled();
  expect(requests).toEqual([]);
  expect(sandbox.documentWrites()).toBe(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  // Another operator repairs the retained query; this slice has no Chart editor.
  retainedReferences = [];
  await settings
    .getByRole("button", { name: "Permanently delete field", exact: true })
    .click();
  await expect(dialog.getByText(detail, { exact: true })).toHaveCount(0);
  await dialog
    .getByLabel("Type the field name", { exact: true })
    .fill(field.name);
  await dialog
    .getByLabel("Administrator password", { exact: true })
    .fill("owned-test-password");
  await dialog
    .getByRole("button", { name: "Permanently delete", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(reviews).toBe(2);
  expect(requests).toEqual([
    {
      token: "owned-chart-review-2",
      confirmation_name: field.name,
      password: "owned-test-password",
    },
  ]);
  await expect(settings).toHaveCount(0);
  expect(sandbox.documentWrites()).toBe(0);
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
  const binding = liveBinding("department", department.id, liveId, {
    deleted: true,
  });
  const requests: unknown[] = [];
  await installLifecycleRoutes(
    page,
    { kind: "department", liveId },
    {
      reviews: {
        purge: () =>
          lifecycleReview("department", liveId, "purge", {
            token: "blocked-department-review",
            confirmationName: department.name,
            impact: {
              blockers: [
                {
                  code: "purge_trigger_dependency",
                  entity_type: "record_triggers",
                  entity_id: "00000000-0000-4000-8000-000000000542",
                  detail:
                    "A configured trigger still depends on this department.",
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
          }),
      },
      commands: {
        reopen: (body) => {
          requests.push(body);
          const confirmed = sandbox.document();
          confirmed.design.departments[0]!.closed = false;
          confirmed.design.modules.forEach((targetModule) => {
            if (targetModule.departmentId === department.id)
              targetModule.closed = false;
          });
          sandbox.confirmLiveDocument(confirmed);
          sandbox.confirmBindings([{ ...binding, is_deleted: false }]);
        },
      },
    },
  );
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

  await expect(dialog).toBeHidden();
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
    "This item changed. Refresh it and try again.",
  );
});

test("an empty Sandbox can create Finance as its first department", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, initialDesign);

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

async function dragCanvasNode(
  page: Page,
  node: ReturnType<Page["locator"]>,
  beforeDrop: () => Promise<void> = async () => {},
) {
  const box = (await node
    .locator('[data-sandbox-part="header"]')
    .first()
    .boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 80, y + 48, { steps: 8 });
  await beforeDrop();
  await page.mouse.up();
}

async function canvasPosition(node: ReturnType<Page["locator"]>) {
  const box = (await node.boundingBox())!;
  return { x: Math.round(box.x), y: Math.round(box.y) };
}

test("a dropped module stays where it lands while its layout saves", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let releaseSave = () => {};
  const saveDelay = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredSandboxDesign,
    { saveDelay },
  );
  const canvas = page.getByRole("region", { name: "Organization canvas" });
  const node = canvas.locator('[data-sandbox-node="sample-requests"]');
  const before = await canvasPosition(node);
  const save = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      request.url().endsWith("/api/sandbox/document"),
  );
  try {
    // Record every position the module takes from the drop on.
    await dragCanvasNode(page, node, () =>
      node.evaluate((element) => {
        const seen: string[] = [];
        Object.assign(window, { droppedPositions: seen });
        const region = element.closest('[aria-label="Organization canvas"]')!;
        new MutationObserver(() => {
          const box = element.getBoundingClientRect();
          seen.push(`${Math.round(box.x)},${Math.round(box.y)}`);
        }).observe(region, {
          subtree: true,
          attributes: true,
          attributeFilter: ["transform", "style"],
        });
      }),
    );
    await save;
    await expect.poll(() => canvasPosition(node)).not.toEqual(before);
    const dropped = await canvasPosition(node);
    // The drag-end sync once re-applied the last saved layout, so the module
    // jumped back to its old place before the new layout arrived.
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { droppedPositions: string[] })
            .droppedPositions,
      ),
    ).not.toContain(`${before.x},${before.y}`);
    releaseSave();
    await expect
      .poll(() => sandbox.document().design.layout?.["sample-requests"])
      .toBeDefined();
    expect(await canvasPosition(node)).toEqual(dropped);
  } finally {
    releaseSave();
  }
});

test("a refused layout puts the dropped module back", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    saveFailure: "Sandbox storage is unavailable",
  });
  const canvas = page.getByRole("region", { name: "Organization canvas" });
  const requests = canvas.locator('[data-sandbox-node="sample-requests"]');
  const equipment = canvas.locator('[data-sandbox-node="sample-equipment"]');
  // A failed save keeps that change local and refuses later changes.
  await dragCanvasNode(page, requests);
  await expect(
    page.getByText(
      "Your change was not saved. It remains local until you reapply it successfully.",
    ),
  ).toBeVisible();
  const before = await canvasPosition(equipment);
  await dragCanvasNode(page, equipment);
  await expect(
    page.getByText("A Sandbox change is already being saved.").first(),
  ).toBeVisible();
  // Within 2 px: the selected outline is wider than the idle one.
  await expect
    .poll(async () => {
      const now = await canvasPosition(equipment);
      return Math.abs(now.x - before.x) <= 2 && Math.abs(now.y - before.y) <= 2;
    })
    .toBe(true);
});

test("an empty, never-published Sandbox offers one start and nothing to publish", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, initialDesign);
  const publish = page.getByRole("button", { name: "Review & Publish" });
  const canvas = page.getByLabel("Module design canvas");

  // No placeholder entities: zero counts and no sample module.
  await expect(
    page.getByText(
      "0 departments · 0 modules · 0 fields · 0 relationships · 0 triggers",
    ),
  ).toHaveCount(2);
  await expect(page.getByText("Service requests", { exact: true })).toHaveCount(
    0,
  );

  await expect(page.getByText(/^Nothing to publish yet ·/)).toBeVisible();
  await expect(publish).toBeDisabled();
  await expect(
    canvas.getByRole("heading", { name: "Design your organization" }),
  ).toBeVisible();
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
    page.getByText("Operations", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    canvas.getByRole("heading", { name: "Design your organization" }),
  ).toHaveCount(0);
  await expect(page.getByText(/^Unpublished changes ·/)).toBeVisible();
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

  await expect(page.getByText(/^Published ·/)).toBeVisible();
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
    // A module's panel holds its own fields; new modules start from the
    // department, here through its Structure row.
    await page
      .getByRole("tablist", { name: "Workbench view" })
      .getByRole("tab", { name: "Structure" })
      .click();
    await page
      .getByRole("button", { name: "Add module to Operations", exact: true })
      .click();
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

  await expect.poll(() => exitGuarded(page)).toBe(true);
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
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    testRunEcho: {
      id: "00000000-0000-4000-8000-000000000008",
      createdAt: "2026-09-22T00:00:00Z",
      onRequest: async () => {
        runStarted = true;
        await runDelay;
      },
    },
  });
  await page.route("**/api/sandbox/tests", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    clearStarted = true;
    await clearDelay;
    await route.fulfill({
      contentType: "application/json",
      body: "null",
    });
  });
  await page.getByRole("link", { name: "Test", exact: true }).click();

  await page.getByRole("button", { name: "Run test" }).click();
  await expect.poll(() => runStarted).toBe(true);
  await expect.poll(() => exitGuarded(page)).toBe(true);
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
  await expect.poll(() => exitGuarded(page)).toBe(true);
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
    canvas.locator(`[data-sandbox-edge="${id}"] [data-sandbox-line]`);

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
        relationship: dash(
          '[data-sandbox-edge="sample-uses"] [data-sandbox-line]',
        ),
        handoff: dash(
          '[data-sandbox-edge="sample-billing"] [data-sandbox-line]',
        ),
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

async function openConnectModules(page: Page) {
  await page
    .getByRole("tablist", { name: "Workbench view" })
    .getByRole("tab", { name: "Structure" })
    .click();
  await page.getByRole("button", { name: /^Add relationship$/i }).click();
  return page.getByRole("dialog", { name: "Connect modules" });
}

// A design rule the Designer checks while applying a change is refused with
// its authored reason; it once rejected silently and left the dialog open.
test("a duplicate relationship is refused with its reason and nothing is saved", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(page);
  const dialog = await openConnectModules(page);
  await dialog.getByLabel("Source module").selectOption("sample-requests");
  await dialog.getByLabel("Target module").selectOption("sample-equipment");
  await dialog.getByLabel("Relationship name").fill("Uses equipment again");
  await dialog.getByRole("button", { name: "Create relationship" }).click();
  await expect(
    dialog.getByText("A relationship between these modules already exists."),
  ).toBeVisible();
  expect(sandbox.document().design.relationships).toHaveLength(1);
});

test("a relationship can target a module in another department and publish", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(page, {
    ...configuredSandboxDesign,
    rules: [],
  });
  const published: unknown[] = [];
  await page.route("**/api/sandbox/publications", (route) => {
    published.push(route.request().postDataJSON());
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "00000000-0000-4000-8000-000000000711",
        version: {
          id: "00000000-0000-4000-8000-000000000712",
          sequence: 1,
          kind: "published",
          label: "Published",
        },
        documentRevision: 2,
        documentHash: "b".repeat(64),
        impactDigest: "c".repeat(64),
        publishedAt: "2026-10-04T00:00:00Z",
      }),
    });
  });
  const dialog = await openConnectModules(page);
  const target = dialog.getByLabel("Target module");

  // Each department's modules sit under that department's name.
  await expect(
    target.locator('optgroup[label="Operations"] option'),
  ).toHaveText(["Service requests", "Equipment"]);
  await expect(
    target.locator('optgroup[label="Commercial"] option'),
  ).toHaveText(["Customers"]);
  await dialog.getByLabel("Source module").selectOption("sample-requests");
  await target.selectOption("sample-customers");
  await expect(dialog.getByRole("note")).toHaveText(
    "This relationship connects modules in Operations and Commercial. A person sees each link only when they can read both modules.",
  );
  await dialog.getByLabel("Relationship name").fill("Bills customer");
  await dialog.getByRole("button", { name: "Create relationship" }).click();
  await expect(dialog).toBeHidden();

  await expect
    .poll(() =>
      sandbox
        .document()
        .design.relationships.find((item) => item.name === "Bills customer"),
    )
    .toMatchObject({
      sourceModuleId: "sample-requests",
      targetModuleId: "sample-customers",
    });
  // A link to another department is not an item that needs attention.
  await expect(page.getByText(/need attention/)).toHaveCount(0);

  await page.getByRole("button", { name: "Review & Publish" }).click();
  const review = page.getByRole("dialog", { name: "Review and publish" });
  await review.getByLabel("Your password").fill("local password");
  await review.getByRole("button", { name: "Publish changes" }).click();
  await expect(
    page.getByText("Changes published", { exact: true }),
  ).toBeVisible();
  expect(published).toHaveLength(1);
});

test("leaving Connect modules after choosing another department saves nothing", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(page);
  const writes = sandbox.documentWrites();
  const dialog = await openConnectModules(page);

  await dialog.getByLabel("Target module").selectOption("sample-customers");
  await dialog.getByLabel("Relationship name").fill("Unsaved customer link");
  await expect(dialog.getByRole("note")).toContainText(
    "connects modules in Operations and Commercial.",
  );
  await page.keyboard.press("Escape");

  await expect(dialog).toBeHidden();
  expect(sandbox.documentWrites()).toBe(writes);
  expect(
    sandbox.document().design.relationships.map((item) => item.id),
  ).toEqual(["sample-uses"]);
  const lines = page
    .getByRole("region", { name: "Organization canvas" })
    .locator("[data-sandbox-edge] [data-sandbox-line]");
  await expect(lines).toHaveCount(1);
  await expect(lines).toHaveAttribute("data-sandbox-edge-kind", "relationship");
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
  const published: unknown[] = [];
  await page.route("**/api/sandbox/publications", (route) => {
    published.push(route.request().postDataJSON());
    return route.fulfill({
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
    });
  });
  const title = page.getByRole("heading", {
    level: 1,
    name: "Sandbox",
    exact: true,
  });
  // Opening the Sandbox is not an earned moment.
  await expect(title).not.toHaveAttribute("data-signature");

  await page.getByRole("button", { name: "Review & Publish" }).click();
  const dialog = page.getByRole("dialog", { name: "Review and publish" });
  await dialog.getByLabel("Your password").fill("local password");
  await dialog.getByRole("button", { name: "Publish changes" }).click();

  await expect(
    page.getByText("Changes published", { exact: true }),
  ).toBeVisible();
  await expect(title).toHaveAttribute("data-signature", "play");
  expect(published).toEqual([
    {
      expectedRevision: 1,
      previewToken: "sandbox-preview",
      impactDigest: "b".repeat(64),
      password: "local password",
    },
  ]);
});

test("hovering a module or relationship traces its connections", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuthenticatedSandbox(page);
  const canvas = page.getByRole("region", { name: "Organization canvas" });
  const cell = (id: string) =>
    canvas.locator(`[data-sandbox-node="${id}"], [data-sandbox-edge="${id}"]`);
  await page.getByRole("button", { name: "Fit canvas" }).click();

  await cell("sample-requests").hover();
  await expect(cell("sample-customers")).toHaveAttribute("data-trace", "dim");
  await expect(cell("sample-equipment")).not.toHaveAttribute(
    "data-trace",
    "dim",
  );
  await expect(cell("sample-uses")).toHaveAttribute("data-trace", "on");

  await page.mouse.move(5, 5);
  await expect(canvas.locator('[data-trace="dim"]')).toHaveCount(0);
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

  await expect.poll(() => exitGuarded(page)).toBe(false);

  await page.getByRole("button", { name: "Review & Publish" }).click();

  try {
    await expect.poll(() => exitGuarded(page)).toBe(true);
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
    // The save button shows its pending label while it locks.
    await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await expect(
      page
        .getByRole("form", { name: /^Edit checkpoint label/ })
        .getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
  } finally {
    releaseMutation();
  }
  // The new label shows in place; no notice.
  await expect(
    page.getByRole("heading", { name: "Updated checkpoint" }),
  ).toBeVisible();
});

test("Escape cancels the checkpoint label edit without saving", async ({
  page,
}) => {
  let labelUpdates = 0;
  page.on("request", (request) => {
    if (
      request.method() === "PATCH" &&
      request.url().includes("/api/sandbox/versions/")
    )
      labelUpdates += 1;
  });
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    versions: [historyVersionFixture(1, "Release snapshot 1")],
  });
  await page.getByRole("link", { name: "History", exact: true }).click();
  const { inspector } = historyRegions(page);
  await inspector
    .getByRole("button", { name: "Edit checkpoint label", exact: true })
    .click();
  const label = inspector.getByRole("textbox", { name: "Checkpoint label" });
  await label.fill("Unsaved label");
  await label.press("Escape");
  await expect(label).toHaveCount(0);
  await expect(
    inspector.getByRole("button", {
      name: "Edit checkpoint label",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    inspector.getByRole("heading", { name: "Release snapshot 1" }),
  ).toBeVisible();
  expect(labelUpdates).toBe(0);
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
  await expect(dialog).toHaveAccessibleName("Relationship settings");
  await expect(
    dialog.getByRole("heading", { name: "Create relationship" }),
  ).toHaveCount(0);
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

  await fieldRowTrigger(
    page.getByLabel("Request number field settings"),
    "Request number",
  ).click();
  await page
    .getByLabel("Request number field settings")
    .getByRole("button", { name: "Close field" })
    .click();
  await expect(
    page.getByText(
      "Request number closed. 1 relationship field mapping removed.",
      { exact: true },
    ),
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

  await fieldRowTrigger(
    page.getByLabel("Request number field settings"),
    "Request number",
  ).click();
  // Save appears once the row has an edit; the bounds stay as loaded.
  await page
    .getByLabel("Request number field settings")
    .getByLabel("Request number description")
    .fill("Opened within the bounds");
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
  const saveState = page.locator("[data-sandbox-save-state]");
  await expect(saveState).toHaveText("Not published yet · Saved");

  await page
    .getByRole("tablist", { name: "Workbench view" })
    .getByRole("tab", { name: "Structure" })
    .click();
  await page.getByRole("button", { name: "Add department" }).click();
  await page.getByLabel("Department name").fill("Operations");
  await page.getByRole("button", { name: "Create department" }).click();

  const saveFailure = page
    .getByRole("alert")
    .filter({ hasText: "Your change was not saved." });
  await expect(saveFailure).toBeVisible();
  await expect(saveFailure).toHaveAttribute("data-variant", "destructive");
  await expect(
    page.getByText(
      "Save did not complete: your proposed document is still local.",
    ),
  ).toBeVisible();
  await expect(saveState).toHaveText("Not saved");
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
  await expect(dialog.getByRole("alert")).toContainText(
    "This Sandbox change could not be saved. Try again.",
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
  // The refresh read is parked. Let any early unlock commit and remove the
  // exit listener before sampling, so the check cannot pass by running first.
  await settleReact(page);

  try {
    expect(await exitGuarded(page)).toBe(true);
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

test("the trigger flow preview follows the unsaved rule draft", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(page);
  await page.getByRole("link", { name: "Triggers", exact: true }).click();

  const flow = page.getByRole("region", { name: "Flow preview" });
  // On desktop the flow carries every fact; the summary is for phones.
  await expect(
    page.getByRole("region", { name: "Trigger summary" }),
  ).toHaveCount(0);
  const settings = page.getByRole("region", { name: "Trigger settings" });
  await expect(settings).toBeVisible();
  await expect(flow.getByRole("button", { name: /^When ·/ })).toBeVisible();
  await expect(
    flow.getByRole("button", { name: /^Condition 1\b/ }),
  ).toBeVisible();
  await expect(
    flow.getByRole("button", { name: /^Then · Action 1\b/ }),
  ).toBeVisible();

  const savedTriggers = sandbox.document().triggers;
  await page
    .getByLabel("Condition 1 field")
    .selectOption({ label: "Priority" });
  const conditionValue = settings.getByLabel("Value", { exact: true }).first();
  await conditionValue.fill("Needs immediate review");
  await expect(
    flow.getByRole("button", { name: /^Condition 1\b/ }),
  ).toContainText("Needs immediate review");
  expect(sandbox.document().triggers).toEqual(savedTriggers);

  // All or Any appears only once there are two conditions.
  await expect(page.getByLabel("Condition group operator")).toHaveCount(0);
  await page.getByRole("button", { name: "Add condition" }).click();
  await expect(
    flow.getByRole("button", { name: /^Condition 2\b/ }),
  ).toBeVisible();
  await page.getByLabel("Condition group operator").selectOption("any");
  await expect(flow).toContainText(/any condition/i);
  await page.getByRole("button", { name: "Remove condition" }).last().click();
  await expect(
    flow.getByRole("button", { name: /^Condition 2\b/ }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Add action" }).click();
  await expect(
    flow.getByRole("button", { name: /^Then · Action 2\b/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove action" }).last().click();
  await expect(
    flow.getByRole("button", { name: /^Then · Action 2\b/ }),
  ).toHaveCount(0);

  await page.getByLabel("Event", { exact: true }).selectOption("schedule");
  await expect(flow.getByRole("button", { name: /^When ·/ })).toContainText(
    /schedule/i,
  );
});

test("keyboard activation on a trigger flow node focuses its editor", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page);
  await page.getByRole("link", { name: "Triggers", exact: true }).click();

  const flow = page.getByRole("region", { name: "Flow preview" });
  const condition = page.getByLabel("Condition 1 field");
  const conditionNode = flow.getByRole("button", {
    name: /^Condition 1\b/,
  });
  await conditionNode.focus();
  await page.keyboard.press("Enter");
  await expect(condition).toBeFocused();
});

test("unsaved Service request follow-up trigger draft fits the original viewport and theme matrix", async ({
  page,
}) => {
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
  // Status is a select field, so its values are picked by label.
  const values = settings.getByLabel("Value", { exact: true });
  await values.first().selectOption({ label: "Open" });
  await values.last().selectOption({ label: "In progress" });

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

  await fieldRowTrigger(
    page.getByLabel("Status field settings"),
    "Status",
  ).click();
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
  expect(draftChoiceId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i,
  );
  expect(savedNewChoice.defaultValue).toBe(draftChoiceId);
  expect(
    savedNewChoice.options.find((option) => option.label === "Complete")?.id,
  ).toBe(originalIds.Complete);
  const originalViewport = page.viewportSize();
  const originalScrollY = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    if (viewport.width < 640) {
      const propertiesTab = page.getByRole("tab", {
        name: "Properties",
      });
      await expect(propertiesTab).toHaveCount(1);
      if ((await propertiesTab.getAttribute("aria-selected")) !== "true")
        await propertiesTab.click();
      const showSettings = fieldRowTrigger(
        page.getByLabel("Status field settings"),
        "Status",
      );
      if (await showSettings.isVisible()) await showSettings.click();
    }
  }
  if (originalViewport) await page.setViewportSize(originalViewport);
  await page.evaluate((y) => window.scrollTo(0, y), originalScrollY);
});

test("removing an unsaved selected choice requires an explicit new default", async ({
  page,
}) => {
  const design = structuredClone(configuredSandboxDesign);
  const sandbox = await openAuthenticatedSandbox(page, design);
  await fieldRowTrigger(
    page.getByLabel("Status field settings"),
    "Status",
  ).click();
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
  await settings
    .getByLabel("Status default value")
    .selectOption({ label: "Open" });
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
    .getByLabel("Title field", { exact: true })
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
  const titleSelector = page.getByLabel("Title field", { exact: true });
  await expect(titleSelector).toHaveValue(titleField.id);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);

  const titleSettings = page.getByLabel(`${titleField.name} field settings`);
  await fieldRowTrigger(titleSettings, titleField.name).click();
  const closeField = titleSettings.getByRole("button", {
    name: "Close field",
  });
  await expect(closeField).toBeDisabled();
  await expect(closeField).toHaveAccessibleDescription(
    "This is the module's title field.",
  );

  const originalViewport = page.viewportSize();
  const originalScrollY = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    if (viewport.width < 640) {
      const propertiesTab = page.getByRole("tab", {
        name: "Properties",
      });
      await expect(propertiesTab).toHaveCount(1);
      if ((await propertiesTab.getAttribute("aria-selected")) !== "true")
        await propertiesTab.click();
      const showSettings = fieldRowTrigger(
        page.getByLabel("Title field settings"),
        "Title",
      );
      if (await showSettings.isVisible()) await showSettings.click();
    }
  }
  if (originalViewport) await page.setViewportSize(originalViewport);
  await page.evaluate((y) => window.scrollTo(0, y), originalScrollY);

  await titleSelector.selectOption("");
  await expect.poll(sandbox.documentWrites).toBe(2);
  const showSettings = fieldRowTrigger(titleSettings, "Title");
  if (await showSettings.isVisible()) await showSettings.click();
  await expect(closeField).toBeEnabled();
  await expect(closeField).toHaveAccessibleDescription("");
});

test("a failed record title field change shows its error under the select", async ({
  page,
}) => {
  const titleField = configuredSandboxDesign.modules[0]?.fields.find(
    (field) => field.name === "Title",
  );
  if (!titleField) throw new Error("A module with a title field is required");
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    saveFailure: "Sandbox storage is unavailable.",
  });
  const titleSelector = page.getByLabel("Title field", { exact: true });
  await titleSelector.selectOption(titleField.id);
  await expect(titleSelector).toHaveAttribute("aria-invalid", "true");
  await expect(titleSelector).toHaveAccessibleDescription(
    /^This Sandbox change could not be saved\. Try again\./,
  );
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
  let submitted: Record<string, unknown> | undefined;
  await openAuthenticatedSandbox(page, design, {
    testRunEcho: {
      id: "00000000-0000-4000-8000-000000000041",
      createdAt: "2026-09-25T10:00:00Z",
      onRequest: (request) => {
        submitted = request.values;
      },
    },
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

test("Sandbox Test field search preserves hidden edits in the submitted temporary values", async ({
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
  await openAuthenticatedSandbox(page, design, {
    testRunEcho: {
      id: "00000000-0000-4000-8000-000000000021",
      createdAt: "2026-09-25T10:00:00Z",
      onRequest: (request) => {
        submitted = request.values;
      },
      resultValues: (values) => ({
        ...values,
        "sample-field-Status": "Complete",
      }),
    },
  });
  await page.getByRole("link", { name: "Test", exact: true }).click();
  const setup = page.getByRole("region", { name: "Test setup", exact: true });
  await expect(setup.getByLabel("Find a field")).toBeVisible();
  await expect(setup.getByLabel("Title", { exact: true })).toHaveCount(0);
  await setup.getByLabel("Request number", { exact: true }).fill("TEST-001");
  await setup.getByRole("button", { name: /^All \(/ }).click();
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
  await setup.getByRole("button", { name: /^Relevant \(/ }).click();
  await expect(setup.getByLabel("Title", { exact: true })).toHaveCount(0);
  await setup.getByRole("button", { name: /^Edited \(/ }).click();
  await expect(setup.getByLabel("Title", { exact: true })).toHaveValue(
    "Keep this hidden",
  );
  await setup.getByRole("button", { name: /^Relevant \(/ }).click();
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
  // The Test setup panel resizes by keyboard and keeps typed values, and the
  // Test page fits from 1920 to 390 px without page overflow.
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
  await expect(setup.getByLabel("Request number", { exact: true })).toHaveValue(
    "TEST-001",
  );
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
  }
});

test("Sandbox Test comparisons use saved inputs, preserve typed values, and distinguish missing results", async ({
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
  await comparison.getByRole("button", { name: /^All fields \(/ }).click();
  await expect(comparison.getByRole("row", { name: /Priority/ })).toContainText(
    "No value",
  );
  await page
    .getByRole("region", { name: "Recent test results", exact: true })
    // Rows are named by what they show; the second is the older result.
    .locator("button[aria-pressed]")
    .nth(1)
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
  await comparison.getByRole("button", { name: /^All fields \(/ }).click();
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
  // Small modules show no search; All lists every input.
  await setup.getByRole("button", { name: /^All \(/ }).click();
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

// Which count shows the warning is owned by isolated/sandbox/version-capacity
// and the capacity contract by isolated/sandbox/api ("a version page with ...
// is a contract error"); these two journeys keep the global count and refusal.
test("capacity 45 is global in filtered History and checkpoint dialog", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    versions: capacityVersions(45),
  });
  await page.getByRole("link", { name: "History", exact: true }).click();
  const { timeline } = historyRegions(page);
  await timeline.getByLabel("Find a version").fill("Needle");
  await expect(timeline).toContainText("1 saved version");
  const text =
    "45 of 50 versions used. Delete the oldest unpublished checkpoints to free space.";
  await expect(timeline.getByText(text, { exact: true })).toBeVisible();
  const checkpoint = await openCheckpointDialog(page);
  await expect(checkpoint.getByText(text, { exact: true })).toBeVisible();
});

test("refused capacity is unavailable rather than guessed or usable", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredSandboxDesign,
    {
      versions: capacityVersions(50),
      versionListFailure: 403,
    },
  );
  const checkpoint = await openCheckpointDialog(page);
  await expect(
    checkpoint.getByText(
      "Version capacity is unavailable. Retry before deleting old checkpoints.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    checkpoint.getByRole("button", {
      name: "Delete old checkpoints",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    checkpoint.getByRole("button", { name: "Retry capacity", exact: true }),
  ).toBeEnabled();
  expect(sandbox.pruneRequests()).toEqual([]);
});

test("Save checkpoint can be cancelled without saving", async ({ page }) => {
  const sandbox = await openAuthenticatedSandbox(page);
  const checkpoint = await openCheckpointDialog(page);
  await checkpoint
    .getByLabel("Checkpoint name", { exact: true })
    .fill("Not kept");
  await checkpoint.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(checkpoint).toBeHidden();
  expect(sandbox.checkpointRequests()).toEqual([]);
});

test("prune cancel and pending readback preserve checkpoint input and use refreshed revision", async ({
  page,
}) => {
  let releasePrune!: () => void;
  let releaseReadback!: () => void;
  const pruneDelay = new Promise<void>((resolve) => {
    releasePrune = resolve;
  });
  const readbackDelay = new Promise<void>((resolve) => {
    releaseReadback = resolve;
  });
  const versions = capacityVersions(50);
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredSandboxDesign,
    { versions, revision: 7, pruneDelay, pruneReadbackDelay: readbackDelay },
  );
  const before = sandbox.document();
  const checkpoint = await openCheckpointDialog(page);
  await checkpoint
    .getByLabel("Checkpoint name", { exact: true })
    .fill("Retained authored name");
  await checkpoint.getByLabel("Note (optional)").fill("Retained authored note");
  const prune = checkpoint.getByRole("button", {
    name: "Delete old checkpoints",
    exact: true,
  });
  await expect(prune).toBeVisible();
  await prune.click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Delete old checkpoints?",
    exact: true,
  });
  await expect(confirmation).toContainText("40");
  await expect(confirmation).toContainText(
    "Published versions and the newest version are kept.",
  );
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect(sandbox.pruneRequests()).toEqual([]);
  await prune.click();
  await confirmation
    .getByRole("button", { name: "Delete old checkpoints", exact: true })
    .click();
  await expect
    .poll(() => sandbox.pruneRequests())
    .toEqual([{ expectedRevision: 7 }]);
  await expect(
    confirmation.getByRole("button", { name: "Deleting…", exact: true }),
  ).toBeDisabled();
  releasePrune();
  await expect.poll(() => sandbox.versions().length).toBe(41);
  await expect(
    confirmation.getByRole("button", { name: "Deleting…", exact: true }),
  ).toBeDisabled();
  expect(sandbox.checkpointRequests()).toEqual([]);
  releaseReadback();
  await expect(confirmation).toBeHidden();
  await expect(
    checkpoint.getByRole("button", {
      name: "Delete old checkpoints",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    checkpoint.getByLabel("Checkpoint name", { exact: true }),
  ).toHaveValue("Retained authored name");
  await expect(checkpoint.getByLabel("Note (optional)")).toHaveValue(
    "Retained authored note",
  );
  await checkpoint
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .click();
  await expect(checkpoint).toBeHidden();
  expect(sandbox.checkpointRequests()).toEqual([
    {
      expectedRevision: 8,
      kind: "checkpoint",
      label: "Retained authored name",
      note: "Retained authored note",
    },
  ]);
  expect(sandbox.pruneRequests()).toHaveLength(1);
  expect(sandbox.document()).toEqual(before);
  expect(sandbox.documentWrites()).toBe(0);
  expect(
    sandbox.versions().some((version) => version.id === versions.at(-1)!.id),
  ).toBe(true);
  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Version timeline", exact: true }),
  ).toContainText("42 saved versions");
});

test("filtered History readback completes before prune unlocks commands", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredSandboxDesign,
    { versions: capacityVersions(50), revision: 7 },
  );
  let release!: () => void;
  let readbackStarted = false;
  const delay = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/sandbox/versions?*", async (route) => {
    if (
      sandbox.pruneRequests().length &&
      new URL(route.request().url()).searchParams.get("search") === "Needle"
    ) {
      readbackStarted = true;
      await delay;
    }
    await route.fallback();
  });
  await page.getByRole("link", { name: "History", exact: true }).click();
  const { timeline } = historyRegions(page);
  await timeline.getByLabel("Find a version").fill("Needle");
  await expect(timeline).toContainText("1 saved version");
  await timeline
    .getByRole("button", { name: "Delete old checkpoints", exact: true })
    .click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Delete old checkpoints?",
    exact: true,
  });
  await confirmation
    .getByRole("button", { name: "Delete old checkpoints", exact: true })
    .click();
  try {
    await expect.poll(() => readbackStarted).toBe(true);
    await expect(
      confirmation.getByRole("button", { name: "Deleting…", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(confirmation).toBeHidden();
  await expect(timeline).toContainText("0 saved versions");
  await expect(
    timeline.getByRole("button", {
      name: "Delete old checkpoints",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(sandbox.pruneRequests()).toEqual([{ expectedRevision: 7 }]);
});

// The copy of each failure is owned by isolated/feedback/api-errors and the
// prune reply contract by isolated/sandbox/api; a stale refusal and a failed
// readback after a committed prune keep the recovery journey.
for (const failure of ["stale", "readback"] as const) {
  test(`${failure} prune preserves input and refuses another write until authoritative Retry`, async ({
    page,
  }) => {
    const sandbox = await openAuthenticatedSandbox(
      page,
      configuredSandboxDesign,
      {
        versions: capacityVersions(50),
        revision: 7,
        ...(failure === "stale"
          ? { pruneFailure: { status: 409, code: "stale_revision" } }
          : {}),
        ...(failure === "readback" ? { pruneReadbackFailure: true } : {}),
      },
    );
    const before = sandbox.document();
    const checkpoint = await openCheckpointDialog(page);
    await checkpoint
      .getByLabel("Checkpoint name", { exact: true })
      .fill("Keep this label");
    await checkpoint.getByLabel("Note (optional)").fill("Keep this note");
    await expect(
      checkpoint.getByRole("button", {
        name: "Delete old checkpoints",
        exact: true,
      }),
    ).toBeVisible();
    await checkpoint
      .getByRole("button", { name: "Delete old checkpoints", exact: true })
      .click();
    const confirmation = page.getByRole("alertdialog", {
      name: "Delete old checkpoints?",
      exact: true,
    });
    await confirmation
      .getByRole("button", { name: "Delete old checkpoints", exact: true })
      .click();
    const error =
      failure === "stale"
        ? "This item changed. Refresh it and try again."
        : "This service is temporarily unavailable. Try again.";
    await expect(confirmation.getByRole("alert")).toContainText(error);
    await confirmation
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(
      checkpoint.getByLabel("Checkpoint name", { exact: true }),
    ).toHaveValue("Keep this label");
    await expect(checkpoint.getByLabel("Note (optional)")).toHaveValue(
      "Keep this note",
    );
    await expect(
      checkpoint.getByRole("button", { name: "Save checkpoint", exact: true }),
    ).toBeDisabled();
    expect(sandbox.pruneRequests()).toEqual([{ expectedRevision: 7 }]);
    expect(sandbox.checkpointRequests()).toEqual([]);
    expect(sandbox.document()).toEqual(before);
    await expect(page.getByText("Private failure canary")).toHaveCount(0);
    if (failure === "readback") {
      sandbox.setPruneReadbackFailure(false);
      await checkpoint
        .getByRole("button", { name: "Retry capacity", exact: true })
        .click();
      await expect(
        checkpoint.getByRole("button", {
          name: "Save checkpoint",
          exact: true,
        }),
      ).toBeEnabled();
      await checkpoint
        .getByRole("button", { name: "Save checkpoint", exact: true })
        .click();
      await expect(checkpoint).toBeHidden();
      expect(sandbox.checkpointRequests()).toEqual([
        {
          expectedRevision: 8,
          kind: "checkpoint",
          label: "Keep this label",
          note: "Keep this note",
        },
      ]);
    }
  });
}

test("full history checkpoint reports authored version_limit copy and preserves inputs", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredSandboxDesign,
    { versions: capacityVersions(50) },
  );
  const checkpoint = await openCheckpointDialog(page);
  await checkpoint
    .getByLabel("Checkpoint name", { exact: true })
    .fill("Preserved full-cap label");
  await checkpoint
    .getByLabel("Note (optional)")
    .fill("Preserved full-cap note");
  await checkpoint
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .click();
  await expect(
    checkpoint.getByText(
      "Version history is full. Delete old checkpoints in History.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    checkpoint.getByLabel("Checkpoint name", { exact: true }),
  ).toHaveValue("Preserved full-cap label");
  await expect(checkpoint.getByLabel("Note (optional)")).toHaveValue(
    "Preserved full-cap note",
  );
  expect(sandbox.checkpointRequests()).toHaveLength(1);
  expect(sandbox.documentWrites()).toBe(0);
  await expect(page.getByText("Private capacity canary")).toHaveCount(0);
});

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
  const { timeline, inspector } = historyRegions(page);
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
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    inspector.getByRole("button", { name: "Restore version", exact: true }),
  ).toBeFocused();
  await timeline.getByLabel("Find a version").fill("");
  await timeline.getByLabel("Filter versions").selectOption("published");
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
  await timeline.getByLabel("Filter versions").selectOption("all");
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
  await inspector.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("changing a compared version clears the old comparison", async ({
  page,
}) => {
  const versions = [
    historyVersionFixture(1, "Published structure", "published"),
    historyVersionFixture(2, "Release snapshot 1"),
    historyVersionFixture(3, "Before import"),
  ];
  const before = sandboxDocumentFromDesign(configuredSandboxDesign);
  const after = structuredClone(before);
  after.design.modules[0].name = "Updated requests";
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  await page.route("**/api/sandbox/versions/*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const version = versions.find((item) => item.id === id)!;
    await route.fulfill({
      json: { ...version, document: id === versions[1].id ? after : before },
    });
  });
  await page.getByRole("link", { name: "History", exact: true }).click();
  await page.getByLabel("Compare first version").selectOption(versions[0].id);
  await page.getByLabel("Compare second version").selectOption(versions[1].id);
  await page
    .getByRole("button", { name: "Compare versions", exact: true })
    .click();
  const { comparison } = historyRegions(page);
  await expect(comparison).toContainText("Updated requests");

  await page.getByLabel("Compare second version").selectOption(versions[2].id);
  await expect(comparison).not.toContainText("Updated requests");
  await expect(comparison).toContainText(
    "Ready to compare Published structure (v1) with Before import (v3).",
  );
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
  const { comparison } = historyRegions(page);
  await expect(comparison).toContainText("Updated requests");
  const savedComparison = await comparison.innerText();
  await page
    .getByRole("button", { name: "View Before import", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Selected version", exact: true }),
  ).toContainText("Before import");
  await expect.poll(() => comparison.innerText()).toBe(savedComparison);
  expect(reads).toBe(2);
  // The History workspace fits from 1920 to 390 px with no horizontal page
  // overflow, and wide screens have no vertical page overflow.
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
  }
  for (const view of [
    { width: 1920, height: 1000 },
    { width: 1440, height: 768 },
  ]) {
    await page.setViewportSize(view);
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
  await page.route("**/api/sandbox/versions?*", async (route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    const sorted = [...versions].sort((a, b) => b.sequence - a.sequence);
    const items = sorted.slice(offset, offset + limit);
    await route.fulfill({
      json: {
        items,
        limit,
        offset,
        count: items.length,
        total: sorted.length,
        hasMore: offset + items.length < sorted.length,
        mutableCount: versions.filter((version) => version.kind !== "published")
          .length,
        versionCap: 50,
      },
    });
  });
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
  const { inspector } = historyRegions(page);
  await inspector
    .getByRole("button", { name: "Delete version", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog");
  await dialog
    .getByRole("button", { name: "Delete Disposable checkpoint", exact: true })
    .click();
  await expect.poll(() => deleteAttempts).toBe(1);
  await expect(dialog).toBeVisible();
  const failure = dialog.getByRole("alert");
  await expect(failure).toContainText("could not");
  await expect(failure).toHaveAttribute("data-variant", "destructive");
  await expect(page.getByText("Try deletion again.")).toHaveCount(0);
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
    page
      .getByRole("region", { name: "Status messages", exact: true })
      .getByText("Disposable checkpoint deleted from shared history.", {
        exact: true,
      }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Status messages", exact: true })
      .getByText("Disposable checkpoint deleted from shared history.", {
        exact: true,
      }),
  ).toHaveCount(1);
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
  const { comparison } = historyRegions(page);
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
    outcome.getByText("Draft changed", { exact: true }),
  ).toBeVisible();
  await expect(
    outcome.getByRole("button", { name: "Run again" }),
  ).toBeVisible();
  await expect(outcome.getByRole("listitem")).toHaveCount(1);
  await expect(outcome.getByRole("listitem")).toContainText("(3 times)");

  await outcome.getByRole("button", { name: "Show test on canvas" }).click();
  await expect(page).toHaveURL(/section=build/);
  const canvas = page.getByRole("region", { name: "Organization canvas" });
  const cell = (id: string) =>
    canvas.locator(`[data-sandbox-node="${id}"], [data-sandbox-edge="${id}"]`);
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

test("personal text scaling leaves the canvas key, editor, and geometry unchanged", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuthenticatedSandbox(page);
  const frame = page.getByLabel("Module design canvas");
  await expect(frame.locator("[data-sandbox-body]").first()).toBeVisible();
  await frame.getByText("Key", { exact: true }).click();
  const node = frame.locator('[data-sandbox-node="sample-requests"]');
  await node.locator('[data-sandbox-part="header"]').first().dblclick();
  await expect(
    page.getByRole("textbox", { name: "Canvas name editor" }),
  ).toBeVisible();
  const metrics = async () =>
    page.evaluate(() => {
      const frame = document.querySelector('[data-skin="canvas-frame"]')!;
      const key = frame.querySelector("summary")!;
      const editor = frame.querySelector(
        'input[aria-label="Canvas name editor"]',
      )!;
      const node = frame.querySelector(
        '[data-sandbox-node="sample-requests"]',
      )!;
      const grid = frame.querySelector('[data-testid="sandbox-grid"]')!;
      return {
        keyFont: getComputedStyle(key).fontSize,
        keyHeight: key.getBoundingClientRect().height,
        editorFont: getComputedStyle(editor).fontSize,
        editorHeight: editor.getBoundingClientRect().height,
        editorRadius: getComputedStyle(editor).borderRadius,
        nodeWidth: Math.round(node.getBoundingClientRect().width),
        grid: getComputedStyle(grid).backgroundSize,
        fieldFonts: [
          ...frame.querySelectorAll(
            '[data-sandbox-part="field-name"], [data-sandbox-part="field-type"]',
          ),
        ].map((text) => getComputedStyle(text).fontSize),
      };
    });
  const baseline = await metrics();
  const zoom = await page
    .getByRole("status", { name: "Canvas zoom" })
    .innerText();
  const title = page.getByRole("heading", { name: "Sandbox", exact: true });
  const titleBefore = await title.evaluate((el) =>
    parseFloat(getComputedStyle(el).fontSize),
  );
  // The browser CSS boundary is the real root font size that personal text controls set.
  await page.evaluate(() => {
    const root = document.documentElement;
    root.dataset.textSize = "125";
    root.dataset.density = "spacious";
    root.style.fontSize = "125%";
  });
  await expect
    .poll(() =>
      title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    )
    .toBeGreaterThan(titleBefore);
  expect(await metrics()).toEqual(baseline);
  // A real device-cache event also exercises the provider render boundary.
  const resize = page.getByRole("separator", { name: "Resize sidebar" });
  const priorUnits = Number(await resize.getAttribute("aria-valuenow"));
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
    localStorage.setItem("openslate-text-size", "125");
    localStorage.setItem("openslate-density", "spacious");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "openslate-text-size" }),
    );
  });
  await expect
    .poll(async () => Number(await resize.getAttribute("aria-valuenow")))
    .toBeGreaterThan(priorUnits);
  await expect(
    page.getByRole("textbox", { name: "Canvas name editor" }),
  ).toBeVisible();
  expect(await metrics()).toEqual(baseline);
  await expect(page.getByRole("status", { name: "Canvas zoom" })).toHaveText(
    zoom,
  );
  await page
    .getByRole("textbox", { name: "Canvas name editor" })
    .press("Escape");
  await expect(
    page.getByRole("textbox", { name: "Canvas name editor" }),
  ).toBeHidden();
});

test("empty canvas text and actions stay at their canvas baseline when page text grows", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, initialDesign);
  const heading = page.getByRole("heading", {
    name: "Design your organization",
  });
  await expect(heading).toBeVisible();
  const start = page.getByRole("button", {
    name: "Start from a template",
    exact: true,
  });
  const before = await heading.evaluate((el) => getComputedStyle(el).fontSize);
  const height = await start.evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  await page.evaluate(() => {
    document.documentElement.dataset.textSize = "125";
    document.documentElement.dataset.density = "compact";
    document.documentElement.style.fontSize = "125%";
  });
  await expect(heading).toHaveCSS("font-size", before);
  expect(await start.evaluate((el) => el.getBoundingClientRect().height)).toBe(
    height,
  );
});

test("disabled convenience shortcuts preserve canvas buttons and essential arrow editing", async ({
  page,
}) => {
  await page.route("**/api/users/*/preferences", (route) =>
    route.fulfill({
      json: {
        user_id: "00000000-0000-4000-8000-000000000001",
        theme: "light",
        appearance: { motion: "system", keyboard_shortcuts: false },
      },
    }),
  );
  await openAuthenticatedSandbox(page);
  await page.keyboard.press("?");
  await expect(
    page.getByRole("heading", { name: "Canvas controls", exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const zoom = await page
    .getByRole("status", { name: "Canvas zoom" })
    .innerText();
  await page.keyboard.press("0");
  await expect(page.getByRole("status", { name: "Canvas zoom" })).toHaveText(
    zoom,
  );
  await page.getByRole("button", { name: "Fit canvas", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "Canvas action" }),
  ).toContainText("Canvas");
  const node = page
    .getByRole("region", { name: "Organization canvas" })
    .locator('[data-sandbox-node="sample-requests"]');
  await node.locator('[data-sandbox-part="header"]').first().click();
  const before = await canvasPosition(node);
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () => (await canvasPosition(node)).x)
    .toBeGreaterThan(before.x);
  await page.getByRole("button", { name: "View canvas", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Canvas help", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Canvas controls", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Canvas controls", exact: true }),
  ).toContainText("Convenience shortcuts are off in Appearance");
});

for (const preference of ["off", "pending"] as const) {
  test(`registered shortcuts ${preference} block Delete and F2 without disabling essential controls`, async ({
    page,
  }) => {
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/users/*/preferences", async (route) => {
      if (preference === "pending") await waiting;
      await route.fulfill({
        json: {
          user_id: "00000000-0000-4000-8000-000000000001",
          theme: "light",
          appearance: {
            motion: "reduce",
            keyboard_shortcuts: preference !== "off",
          },
        },
      });
    });
    try {
      const sandbox = await openAuthenticatedSandbox(page);
      const canvas = page.getByRole("region", { name: "Organization canvas" });
      const node = canvas.locator('[data-sandbox-node="sample-requests"]');
      await node.locator('[data-sandbox-part="header"]').first().click();
      await canvas.focus();
      await page.keyboard.press("F2");
      await expect(
        page.getByRole("textbox", { name: "Canvas name editor" }),
      ).toHaveCount(0);
      await page.keyboard.press("Delete");
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await page.keyboard.press("?");
      await expect(
        page.getByRole("heading", { name: "Canvas controls", exact: true }),
      ).toBeHidden();
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      const zoom = await page
        .getByRole("status", { name: "Canvas zoom" })
        .innerText();
      await canvas.focus();
      await page.keyboard.press("0");
      await expect(
        page.getByRole("status", { name: "Canvas zoom" }),
      ).toHaveText(zoom);
      const field = node.getByRole("button", {
        name: "Title, Text, optional",
        exact: true,
      });
      await field.focus();
      await page.keyboard.press("Enter");
      await expect(field).toHaveAttribute("aria-pressed", "true");
      const status = node.getByRole("button", {
        name: "Status, Select, optional",
        exact: true,
      });
      await status.focus();
      await page.keyboard.press("Space");
      await expect(status).toHaveAttribute("aria-pressed", "true");
      expect(sandbox.document().design.modules).toHaveLength(3);
    } finally {
      release();
    }
  });
}

test("registered shortcuts enabled retain real help fit rename and removal review", async ({
  page,
}) => {
  const sandbox = await openAuthenticatedSandbox(page);
  const canvas = page.getByRole("region", { name: "Organization canvas" });
  const node = canvas.locator('[data-sandbox-node="sample-requests"]');
  await node.locator('[data-sandbox-part="header"]').first().click();
  await canvas.focus();
  await page.keyboard.press("?");
  await expect(
    page.getByRole("heading", { name: "Canvas controls", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const zoom = await page
    .getByRole("status", { name: "Canvas zoom" })
    .innerText();
  await canvas.focus();
  await page.keyboard.press("0");
  await expect(
    page.getByRole("status", { name: "Canvas zoom" }),
  ).not.toHaveText(zoom);
  await canvas.focus();
  await page.keyboard.press("F2");
  const editor = page.getByRole("textbox", { name: "Canvas name editor" });
  await expect(editor).toHaveValue("Service requests");
  await editor.fill("Retained rename draft");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  expect(
    sandbox
      .document()
      .design.modules.find((item) => item.id === "sample-requests")?.name,
  ).toBe("Service requests");
  await canvas.focus();
  await page.keyboard.press("Delete");
  const review = page.getByRole("alertdialog");
  await expect(review).toContainText("Service requests");
  await expect(
    review.getByRole("button", { name: "Confirm delete", exact: true }),
  ).toBeVisible();
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(sandbox.document().design.modules).toHaveLength(3);
});

test("registered shortcuts preserve native text editing modal guards and standard undo redo while off", async ({
  page,
}) => {
  await page.route("**/api/users/*/preferences", (route) =>
    route.fulfill({
      json: {
        user_id: "00000000-0000-4000-8000-000000000001",
        theme: "light",
        appearance: { motion: "reduce", keyboard_shortcuts: false },
      },
    }),
  );
  const sandbox = await openAuthenticatedSandbox(page);
  await page.getByRole("button", { name: "View canvas", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Auto-arrange", exact: true })
    .click();
  await expect(
    page.getByText("Canvas automatically arranged.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeEnabled();
  const arranged = structuredClone(sandbox.document().design.layout);
  const canvas = page.getByRole("region", { name: "Organization canvas" });
  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect(
    page.getByRole("button", { name: "Redo", exact: true }),
  ).toBeEnabled();
  await expect
    .poll(() => sandbox.document().design.layout)
    .not.toEqual(arranged);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => sandbox.document().design.layout).toEqual(arranged);
  await page.getByRole("tab", { name: "Structure", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Select module Service requests",
      exact: true,
    })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Delete module", exact: true })
    .click();
  const review = page.getByRole("alertdialog");
  const writes = sandbox.documentWrites();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("?");
  await expect(review).toBeVisible();
  expect(sandbox.documentWrites()).toBe(writes);
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  const name = page.getByLabel("Trigger name", { exact: true });
  await name.fill("Local trigger draft");
  await name.press("End");
  await name.pressSequentially(" with native typing");
  await expect(name).toHaveValue("Local trigger draft with native typing");
  await name.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(name).toHaveValue("Local trigger draft");
  expect(sandbox.documentWrites()).toBe(writes);
});

test("Trigger Studio switch preserves geometry and its 44 pixel hit target with personal display choices", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("openslate-text-size", "125");
    localStorage.setItem("openslate-density", "spacious");
  });
  const sandbox = await openAuthenticatedSandbox(page);
  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Trigger On" });
  await expect(toggle).toBeVisible();
  const track = await toggle.boundingBox();
  const thumb = await toggle
    .locator('[data-slot="switch-thumb"]')
    .boundingBox();
  if (!track || !thumb) throw new Error("Trigger switch geometry missing");
  expect(thumb.height).toBeLessThanOrEqual(track.height);
  const saved = sandbox.document().triggers;
  await page.evaluate(() => {
    localStorage.setItem("openslate-text-size", "100");
    localStorage.setItem("openslate-density", "compact");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "openslate-text-size" }),
    );
  });
  await expect
    .poll(() =>
      page.locator("html").evaluate((el) => getComputedStyle(el).fontSize),
    )
    .toBe("16px");
  await expect
    .poll(async () => {
      const box = await toggle.boundingBox();
      return box ? Math.round(box.height * 10) / 10 : null;
    })
    .toBe(18.4);
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).toBeInViewport();
  const checked = await toggle.getAttribute("aria-checked");
  const box = await toggle.boundingBox();
  if (!box) throw new Error("Trigger switch missing");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 21);
  await expect(toggle).toHaveAttribute(
    "aria-checked",
    checked === "true" ? "false" : "true",
  );
  expect(sandbox.document().triggers).toEqual(saved);
});

test("History pages and server-searches later versions while retaining inspection and comparison targets", async ({
  page,
}) => {
  const versions = Array.from({ length: 28 }, (_, index) => ({
    ...historyVersionFixture(index + 1, `Saved checkpoint ${index + 1}`),
    createdAt: "2026-09-23T10:00:00Z",
  }));
  versions[0] = {
    ...versions[0],
    label: "Older imported migration",
    note: "Migration recovery",
    kind: "imported",
  };
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/sandbox/versions") requests.push(url.search);
  });
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  let selectedReadUnavailable = true;
  await page.route(`**/api/sandbox/versions/${versions[26].id}`, (route) =>
    selectedReadUnavailable
      ? route.fulfill({
          status: 503,
          json: { detail: "Private history canary" },
        })
      : route.fallback(),
  );
  await page.getByRole("link", { name: "History", exact: true }).click();
  const { timeline, inspector } = historyRegions(page);
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 28",
      exact: true,
    }),
  ).toBeVisible();
  expect(requests.length).toBeGreaterThan(0);
  expect(
    requests.every(
      (query) =>
        new URLSearchParams(query).get("limit") === "25" &&
        new URLSearchParams(query).get("offset") === "0",
    ),
  ).toBe(true);
  await timeline
    .getByRole("button", { name: "View Saved checkpoint 27", exact: true })
    .click();
  await page.getByLabel("Compare first version").selectOption(versions[26].id);
  await timeline.getByRole("button", { name: "Next page" }).click();
  await expect(
    timeline.getByRole("button", { name: "Retry versions", exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", {
      name: "View Older imported migration",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    inspector.getByRole("heading", {
      name: "Saved checkpoint 27",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Compare first version")).toHaveValue(
    versions[26].id,
  );
  await expect(timeline).not.toContainText("Private history canary");
  selectedReadUnavailable = false;
  await timeline
    .getByRole("button", { name: "Retry versions", exact: true })
    .click();
  await expect(
    timeline.getByRole("button", { name: "Retry versions", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Compare second version").selectOption(versions[0].id);
  await page
    .getByRole("button", { name: "Compare versions", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Version comparison", exact: true }),
  ).toContainText("Older imported migration");
  await timeline.getByLabel("Find a version").fill("Migration recovery");
  await expect
    .poll(() =>
      requests.some(
        (query) =>
          new URLSearchParams(query).get("search") === "Migration recovery" &&
          new URLSearchParams(query).get("offset") === "0",
      ),
    )
    .toBe(true);
  await expect(
    timeline.getByRole("button", {
      name: "View Older imported migration",
      exact: true,
    }),
  ).toBeVisible();
  await timeline.getByLabel("Filter versions").selectOption("imported");
  await expect
    .poll(() =>
      requests.some(
        (query) => new URLSearchParams(query).get("kind") === "imported",
      ),
    )
    .toBe(true);
  await expect(
    inspector.getByRole("heading", {
      name: "Saved checkpoint 27",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Compare first version")).toHaveValue(
    versions[26].id,
  );
  for (const mode of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.classList.toggle("dark", value === "dark");
    }, mode);
    const originalViewport = page.viewportSize();
    const originalScrollY = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.scrollTo(0, 0));
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      // The kind filter is one compact select that fits its column.
      await expect
        .poll(() =>
          timeline
            .getByLabel("Filter versions")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        )
        .toBe(true);
    }
    if (originalViewport) await page.setViewportSize(originalViewport);
    await page.evaluate((y) => window.scrollTo(0, y), originalScrollY);
  }
});

test("History clears a missing compared version after a transient lookup and never redisplays its old snapshot", async ({
  page,
}) => {
  const versions = Array.from({ length: 28 }, (_, index) => ({
    ...historyVersionFixture(28 - index, `Saved checkpoint ${28 - index}`),
    createdAt: "2026-09-23T10:00:00Z",
  }));
  const unavailableVersion = versions[1];
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  let detailUnavailable = false;
  await page.route(
    `**/api/sandbox/versions/${unavailableVersion.id}`,
    (route) =>
      detailUnavailable
        ? route.fulfill({
            status: 503,
            json: { detail: "Private history canary" },
          })
        : route.fallback(),
  );
  await page.getByRole("link", { name: "History", exact: true }).click();
  const { timeline, comparison } = historyRegions(page);
  const savedComparison = comparison.getByRole("table");
  const unavailableHeading = comparison.getByRole("heading", {
    name: "Saved checkpoint 27",
    exact: true,
  });
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 28",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel("Compare first version")
    .selectOption(unavailableVersion.id);
  await page.getByLabel("Compare second version").selectOption(versions[0].id);
  await page
    .getByRole("button", { name: "Compare versions", exact: true })
    .click();
  await expect(savedComparison).toBeVisible();
  await expect(unavailableHeading).toBeVisible();

  detailUnavailable = true;
  await timeline.getByRole("button", { name: "Next page" }).click();
  await expect(
    timeline.getByRole("button", { name: "Retry versions", exact: true }),
  ).toBeVisible();
  await expect(savedComparison).toBeVisible();
  await expect(unavailableHeading).toBeVisible();
  await expect(page.getByLabel("Compare first version")).toHaveValue(
    unavailableVersion.id,
  );

  // Another actor removed the version. The next authorized read returns404;
  // no real deletion or product mutation is performed by this journey.
  unavailableVersion.isDeleted = true;
  detailUnavailable = false;
  const [missing] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/sandbox/versions/${unavailableVersion.id}` &&
        response.status() === 404,
    ),
    timeline
      .getByRole("button", { name: "Retry versions", exact: true })
      .click(),
  ]);
  expect(missing.status()).toBe(404);
  await expect(savedComparison).toHaveCount(0);
  await expect(unavailableHeading).toHaveCount(0);
  await expect(page.getByLabel("Compare first version")).not.toHaveValue(
    unavailableVersion.id,
  );

  await page.getByLabel("Compare first version").selectOption(versions[26].id);
  await expect(savedComparison).toHaveCount(0);
  await expect(unavailableHeading).toHaveCount(0);
  await page
    .getByRole("button", { name: "Compare versions", exact: true })
    .click();
  await expect(savedComparison).toBeVisible();
  await expect(
    comparison.getByRole("heading", {
      name: "Saved checkpoint 2",
      exact: true,
    }),
  ).toBeVisible();
  await expect(unavailableHeading).toHaveCount(0);
});

for (const status of [401, 403, 404]) {
  test(`History list ${status} remains refused across cached filters until a later authoritative Retry`, async ({
    page,
  }) => {
    const versions = historyPagingVersions();
    await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
    let refusal: number | null = null;
    let authorizedLists = 0;
    if (status === 401) {
      await page.route("**/api/auth/session", (route) =>
        route.fulfill({
          json:
            refusal === 401
              ? { authenticated: false }
              : {
                  authenticated: true,
                  user_id: "00000000-0000-4000-8000-000000000001",
                  default_organization_blocked: null,
                  setup_required: false,
                },
        }),
      );
      await page.route("**/api/auth/refresh", (route) =>
        route.fulfill({ status: 401, json: { detail: "Unauthenticated" } }),
      );
    }
    await page.route("**/api/sandbox/versions?*", (route) => {
      if (refusal !== null)
        return route.fulfill({
          status: refusal,
          json: { detail: "Private refusal canary" },
        });
      authorizedLists += 1;
      return route.fallback();
    });
    await page.route("**/api/sandbox/versions/*", (route) =>
      refusal !== null && route.request().method() === "GET"
        ? route.fulfill({
            status: refusal,
            json: { detail: "Private refusal canary" },
          })
        : route.fallback(),
    );
    await page.getByRole("link", { name: "History", exact: true }).click();
    const { timeline, inspector, comparison } = historyRegions(page);
    await expect(
      timeline.getByRole("button", {
        name: "View Saved checkpoint 28",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByLabel("Compare first version").selectOption(versions[1].id);
    await page
      .getByLabel("Compare second version")
      .selectOption(versions[0].id);
    await page
      .getByRole("button", { name: "Compare versions", exact: true })
      .click();
    await expect(comparison.getByRole("table")).toBeVisible();
    const authorizedBeforeRefusal = authorizedLists;
    refusal = status;
    const [refused] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/sandbox/versions" &&
          response.status() === status,
      ),
      timeline.getByRole("button", { name: "Next page" }).click(),
    ]);
    expect(refused.status()).toBe(status);
    if (status === 401) {
      await expect(page).toHaveURL(/\/login(?:\?|$)/);
      await expect(
        page.getByRole("heading", { name: "Saved checkpoint 28", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: "Version timeline", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: "Version comparison", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByText("Private refusal canary")).toHaveCount(0);
      return;
    }
    await expect(
      timeline.getByRole("button", { name: "Retry versions", exact: true }),
    ).toBeVisible();
    await timeline.getByLabel("Find a version").fill("Saved checkpoint");
    await timeline.getByLabel("Find a version").fill("");
    await expect(
      timeline.getByRole("button", {
        name: "View Saved checkpoint 28",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      inspector.getByRole("heading", {
        name: "Saved checkpoint 28",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(comparison.getByRole("table")).toHaveCount(0);
    expect(authorizedLists).toBe(authorizedBeforeRefusal);
    await expect(page.getByText("Private refusal canary")).toHaveCount(0);
    refusal = null;
    const [allowed] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/sandbox/versions" &&
          response.status() === 200,
      ),
      timeline
        .getByRole("button", { name: "Retry versions", exact: true })
        .click(),
    ]);
    expect(allowed.status()).toBe(200);
    await expect(
      timeline.getByRole("button", {
        name: "View Saved checkpoint 28",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByLabel("Compare first version")).toHaveValue(
      versions[1].id,
    );
    await expect(page.getByLabel("Compare second version")).toHaveValue(
      versions[0].id,
    );
    await expect(comparison.getByRole("table")).toHaveCount(0);
  });
}

test("History detail 403 cannot be removed by a cached-page transition", async ({
  page,
}) => {
  const versions = historyPagingVersions();
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  let refuseDetail = false;
  let refused = false;
  await page.route("**/api/sandbox/versions?*", (route) =>
    refused
      ? route.fulfill({
          status: 403,
          json: { detail: "Private refusal canary" },
        })
      : route.fallback(),
  );
  await page.route("**/api/sandbox/versions/*", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    if (refused || (refuseDetail && id === versions[1].id)) {
      refused = true;
      return route.fulfill({
        status: 403,
        json: { detail: "Private refusal canary" },
      });
    }
    return route.fallback();
  });
  await page.getByRole("link", { name: "History", exact: true }).click();
  const { timeline, inspector } = historyRegions(page);
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 28",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("Compare first version").selectOption(versions[1].id);
  await page.getByLabel("Compare second version").selectOption(versions[0].id);
  refuseDetail = true;
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith(
          `/versions/${versions[1].id}`,
        ) && response.status() === 403,
    ),
    timeline.getByRole("button", { name: "Next page" }).click(),
  ]);
  expect(response.status()).toBe(403);
  await expect(
    timeline.getByRole("button", { name: "Retry versions", exact: true }),
  ).toBeVisible();
  await timeline.getByLabel("Find a version").fill("Saved checkpoint");
  await timeline.getByLabel("Find a version").fill("");
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 28",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    inspector.getByRole("heading", {
      name: "Saved checkpoint 28",
      exact: true,
    }),
  ).toHaveCount(0);
  refused = false;
  refuseDetail = false;
  await timeline
    .getByRole("button", { name: "Retry versions", exact: true })
    .click();
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 28",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Compare first version")).toHaveValue(
    versions[1].id,
  );
});

test("History keeps the authorized page and range on new-page 503 but never borrows rows for a new filter", async ({
  page,
}) => {
  const versions = historyPagingVersions();
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  let pageUnavailable = true;
  let releaseFilter: () => void = () => {};
  const filterReply = new Promise<void>((resolve) => {
    releaseFilter = resolve;
  });
  await page.route("**/api/sandbox/versions?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("search") === "No matching version") {
      await filterReply;
      return route.fulfill({
        status: 503,
        json: { detail: "Private page canary" },
      });
    }
    if (pageUnavailable && url.searchParams.get("offset") === "25")
      return route.fulfill({
        status: 503,
        json: { detail: "Private page canary" },
      });
    return route.fallback();
  });
  await page.getByRole("link", { name: "History", exact: true }).click();
  const { timeline, inspector } = historyRegions(page);
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 28",
      exact: true,
    }),
  ).toBeVisible();
  await timeline.getByRole("button", { name: "Next page" }).click();
  await expect(
    timeline.getByRole("button", { name: "Retry versions", exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 28",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    timeline
      .getByRole("navigation", { name: "History pages", exact: true })
      .getByRole("button", { name: "previous page" }),
  ).toBeDisabled();
  await expect(
    inspector.getByRole("heading", {
      name: "Saved checkpoint 28",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    timeline.getByText("No saved versions yet", { exact: true }),
  ).toHaveCount(0);
  pageUnavailable = false;
  await timeline
    .getByRole("button", { name: "Retry versions", exact: true })
    .click();
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 3",
      exact: true,
    }),
  ).toBeVisible();
  const filterResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).searchParams.get("search") ===
        "No matching version" && response.status() === 503,
  );
  await timeline.getByLabel("Find a version").fill("No matching version");
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 3",
      exact: true,
    }),
  ).toHaveCount(0);
  releaseFilter();
  await filterResponse;
  await expect(
    timeline.getByRole("button", { name: "Retry versions", exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 3",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.getByText("Private page canary")).toHaveCount(0);
});

test("History deletion of the sole last-page row selects an available version and resets the displayed range", async ({
  page,
}) => {
  const versions = historyPagingVersions(26);
  const last = versions[25];
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  await page.route(`**/api/sandbox/versions/${last.id}`, (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    versions.splice(
      versions.findIndex((version) => version.id === last.id),
      1,
    );
    return route.fulfill({ status: 204 });
  });
  await page.getByRole("link", { name: "History", exact: true }).click();
  const { timeline, inspector } = historyRegions(page);
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 26",
      exact: true,
    }),
  ).toBeVisible();
  await timeline.getByRole("button", { name: "Next page" }).click();
  await timeline
    .getByRole("button", { name: "View Saved checkpoint 1", exact: true })
    .click();
  await inspector
    .getByRole("button", { name: "Delete version", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete Saved checkpoint 1", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(
    inspector.getByRole("heading", {
      name: "Saved checkpoint 26",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 26",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    timeline
      .getByRole("navigation", { name: "History pages", exact: true })
      .getByRole("button", { name: "previous page" }),
  ).toBeDisabled();
  await expect(
    timeline.getByText("No saved versions yet", { exact: true }),
  ).toHaveCount(0);
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 1",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("History success from an imperative read started before refusal cannot restore protected cached content", async ({
  page,
}) => {
  const versions = historyPagingVersions();
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  let refusing = false;
  let refuseNext = true;
  let releaseList: () => void = () => {};
  let releaseDetails: () => void = () => {};
  let holdDetails = true;
  let startedDetails = 0;
  const listReply = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  const detailReply = new Promise<void>((resolve) => {
    releaseDetails = resolve;
  });
  await page.route("**/api/sandbox/versions?*", async (route) => {
    const url = new URL(route.request().url());
    if (refuseNext && url.searchParams.get("offset") === "25") {
      await listReply;
      refusing = true;
      return route.fulfill({
        status: 403,
        json: { detail: "Private ordered refusal" },
      });
    }
    if (refusing)
      return route.fulfill({
        status: 403,
        json: { detail: "Private ordered refusal" },
      });
    return route.fallback();
  });
  await page.route("**/api/sandbox/versions/*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    if (holdDetails && (id === versions[0].id || id === versions[1].id)) {
      startedDetails += 1;
      await detailReply;
      const version = versions.find((item) => item.id === id);
      return route.fulfill({
        json: {
          ...version,
          document: sandboxDocumentFromDesign(configuredSandboxDesign),
        },
      });
    }
    if (refusing)
      return route.fulfill({
        status: 403,
        json: { detail: "Private ordered refusal" },
      });
    return route.fallback();
  });
  await page.getByRole("link", { name: "History", exact: true }).click();
  const { timeline, comparison } = historyRegions(page);
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 28",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("Compare first version").selectOption(versions[1].id);
  await page.getByLabel("Compare second version").selectOption(versions[0].id);
  const pendingList = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/sandbox/versions" &&
      new URL(request.url()).searchParams.get("offset") === "25",
  );
  await timeline.getByRole("button", { name: "Next page" }).click();
  await pendingList;
  await comparison
    .getByRole("button", { name: "Compare versions", exact: true })
    .click();
  await expect.poll(() => startedDetails).toBe(2);
  const refusal = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/sandbox/versions" &&
      response.status() === 403,
  );
  releaseList();
  await refusal;
  await expect(
    timeline.getByRole("button", { name: "Retry versions", exact: true }),
  ).toBeVisible();
  const completed = [versions[0].id, versions[1].id].map((id) =>
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith(`/versions/${id}`) &&
        response.status() === 200,
    ),
  );
  releaseDetails();
  const responses = await Promise.all(completed);
  await Promise.all(responses.map((response) => response.finished()));
  holdDetails = false;
  // Let the completed promise handlers commit before making another request;
  // a fresh refusal must not conceal an older read's incorrect reauthorization.
  await settleReact(page);
  await expect(
    timeline.getByText("History unavailable. Check your access or retry.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(comparison.getByRole("table")).toHaveCount(0);
  await timeline.getByLabel("Find a version").fill("Saved checkpoint");
  await timeline.getByLabel("Find a version").fill("");
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 28",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(comparison.getByRole("table")).toHaveCount(0);
  refusing = false;
  refuseNext = false;
  await timeline
    .getByRole("button", { name: "Retry versions", exact: true })
    .click();
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 28",
      exact: true,
    }),
  ).toBeVisible();
  await expect(comparison.getByRole("table")).toHaveCount(0);
});

test("History older off-page metadata cannot restore a target marked missing by a later Compare read", async ({
  page,
}) => {
  const versions = historyPagingVersions();
  const unavailableVersion = versions[1];
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  let holdMetadata = false;
  let targetReads = 0;
  let releaseMetadata: () => void = () => {};
  const metadataReply = new Promise<void>((resolve) => {
    releaseMetadata = resolve;
  });
  const requests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/sandbox/versions")) requests.push(pathname);
  });
  await page.route(
    `**/api/sandbox/versions/${unavailableVersion.id}`,
    async (route) => {
      if (route.request().method() !== "GET" || !holdMetadata)
        return route.fallback();
      targetReads += 1;
      if (targetReads === 1) {
        const savedVersion = structuredClone(unavailableVersion);
        await metadataReply;
        return route.fulfill({
          json: {
            ...savedVersion,
            document: sandboxDocumentFromDesign(configuredSandboxDesign),
          },
        });
      }
      unavailableVersion.isDeleted = true;
      return route.fulfill({
        status: 404,
        json: { detail: "Private missing-version canary" },
      });
    },
  );
  await page.getByRole("link", { name: "History", exact: true }).click();
  const { timeline, inspector, comparison } = historyRegions(page);
  const firstChoice = page.getByLabel("Compare first version");
  const secondChoice = page.getByLabel("Compare second version");
  const missingHeading = inspector.getByRole("heading", {
    name: "Saved checkpoint 27",
    exact: true,
  });
  const missingOption = { name: /Saved checkpoint 27/ };
  await timeline
    .getByRole("button", { name: "View Saved checkpoint 27", exact: true })
    .click();
  await firstChoice.selectOption(unavailableVersion.id);
  await secondChoice.selectOption(versions[0].id);
  await comparison
    .getByRole("button", { name: "Compare versions", exact: true })
    .click();
  await expect(comparison.getByRole("table")).toBeVisible();
  await expect(missingHeading).toBeVisible();

  holdMetadata = true;
  await timeline.getByRole("button", { name: "Next page" }).click();
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 3",
      exact: true,
    }),
  ).toBeVisible();
  await expect.poll(() => targetReads).toBe(1);
  const [missing] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/sandbox/versions/${unavailableVersion.id}` &&
        response.status() === 404,
    ),
    comparison
      .getByRole("button", { name: "Compare versions", exact: true })
      .click(),
  ]);
  await missing.finished();
  await expect(comparison.getByRole("table")).toHaveCount(0);
  await expect(missingHeading).toHaveCount(0);
  await expect(firstChoice.getByRole("option", missingOption)).toHaveCount(0);
  const requestCountAtRefusal = requests.length;

  const completedMetadata = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/sandbox/versions/${unavailableVersion.id}` &&
      response.status() === 200,
  );
  releaseMetadata();
  await (await completedMetadata).finished();
  // Observe the settled older success before any new read can repair or mask it.
  await settleReact(page);
  expect(requests).toHaveLength(requestCountAtRefusal);
  await expect(
    timeline.getByRole("button", {
      name: "View Saved checkpoint 3",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    firstChoice.getByRole("option", { name: /Saved checkpoint 28/ }),
  ).toHaveCount(1);
  await expect(comparison.getByRole("table")).toHaveCount(0);
  await expect.soft(missingHeading).toHaveCount(0);
  await expect
    .soft(firstChoice.getByRole("option", missingOption))
    .toHaveCount(0);
  await expect
    .soft(secondChoice.getByRole("option", missingOption))
    .toHaveCount(0);
  await expect(page.getByText("Private missing-version canary")).toHaveCount(0);
});

test("a filtered 28-version history exports its complete document and snapshots", async ({
  page,
}, testInfo) => {
  const versions = Array.from({ length: 28 }, (_, index) => ({
    ...historyVersionFixture(
      index + 1,
      index === 0 ? "Needle checkpoint" : `Export version ${index + 1}`,
      index < 20 ? "checkpoint" : "published",
    ),
    createdAt: "2026-10-01T10:00:00Z",
  }));
  const document = sandboxDocumentFromDesign(configuredSandboxDesign);
  const snapshots = versions.map((version) => ({
    id: version.id,
    label: version.label,
    kind: version.kind,
    document: {
      design: document.design,
      triggers: document.triggers,
      scenarios: document.scenarios,
    },
    published: version.kind === "published",
    date: version.createdAt,
  }));
  const exports: string[] = [];
  let writes = 0;
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith("/api/sandbox/") &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())
    )
      writes += 1;
  });
  await page.route("**/api/sandbox/export?*", (route) => {
    const include = new URL(route.request().url()).searchParams.get(
      "includeVersions",
    );
    exports.push(include ?? "missing");
    return route.fulfill({
      contentType: "application/json",
      headers: {
        "Content-Disposition":
          'attachment; filename="owned-sandbox-history.json"',
      },
      json:
        include === "true" ? { ...document, versions: snapshots } : document,
    });
  });
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredSandboxDesign,
    { versions },
  );
  await page.getByRole("link", { name: "History", exact: true }).click();
  const { timeline } = historyRegions(page);
  await timeline.getByLabel("Find a version").fill("Needle");
  await expect(timeline).toContainText("1 saved version");
  const dialog = await openImportExport(page);
  const include = dialog.getByRole("checkbox", {
    name: "Include version history",
    exact: true,
  });
  await expect(include).toBeVisible();
  await expect(include).not.toBeChecked();
  await expect(
    dialog.getByText("28 saved versions", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Imported versions count toward the 50-version limit.", {
      exact: true,
    }),
  ).toBeVisible();
  const [without] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Export JSON", exact: true }).click(),
  ]);
  expect(without.suggestedFilename()).toBe("owned-sandbox-history.json");
  const withoutPath = await without.path();
  if (!withoutPath) throw new Error("A completed download is required");
  const withoutHistory: unknown = JSON.parse(
    await readFile(withoutPath, "utf8"),
  );
  expect(withoutHistory).toEqual(document);
  expect(withoutHistory).not.toHaveProperty("versions");
  await include.check();
  const [withHistory] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Export JSON", exact: true }).click(),
  ]);
  expect(withHistory.suggestedFilename()).toBe("owned-sandbox-history.json");
  const withPath = await withHistory.path();
  if (!withPath) throw new Error("A completed download is required");
  const exported: unknown = JSON.parse(await readFile(withPath, "utf8"));
  expect(exported).toEqual({ ...document, versions: snapshots });
  expect(exported).toHaveProperty("versions", snapshots);
  expect(exports).toEqual(["false", "true"]);
  expect(writes).toBe(0);
  expect(sandbox.documentWrites()).toBe(0);
  expect(sandbox.document()).toEqual(document);
  await testInfo.attach("without-history.json", {
    path: withoutPath,
    contentType: "application/json",
  });
  await testInfo.attach("with-history.json", {
    path: withPath,
    contentType: "application/json",
  });
});

test("export history uses complete global total and downloads both boolean variants", async ({
  page,
}) => {
  // 50 checkpoints and imports at the version limit, plus a publication.
  const versions = capacityVersions(50);
  const document = sandboxDocumentFromDesign(configuredSandboxDesign);
  const bundle = exportBundleFixture(versions, document);
  const exports: string[] = [];
  let writes = 0;
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith("/api/sandbox/") &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())
    )
      writes += 1;
  });
  await page.route("**/api/sandbox/export?*", (route) => {
    const include = new URL(route.request().url()).searchParams.get(
      "includeVersions",
    );
    exports.push(include ?? "missing");
    return route.fulfill({
      contentType: "application/json",
      headers: {
        "Content-Disposition": 'attachment; filename="owned-history-51.json"',
      },
      json: include === "true" ? bundle : document,
    });
  });
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredSandboxDesign,
    { versions },
  );
  await page.getByRole("link", { name: "History", exact: true }).click();
  const { timeline } = historyRegions(page);
  await timeline.getByLabel("Find a version").fill("Needle");
  await expect(timeline).toContainText("1 saved version");
  const dialog = await openImportExport(page);
  const include = dialog.getByRole("checkbox", {
    name: "Include version history",
    exact: true,
  });
  await expect(include).toBeVisible();
  await expect(include).not.toBeChecked();
  await expect(
    dialog.getByText("51 saved versions", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Imported versions count toward the 50-version limit.", {
      exact: true,
    }),
  ).toBeVisible();
  const [without] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Export JSON", exact: true }).click(),
  ]);
  expect(without.suggestedFilename()).toBe("owned-history-51.json");
  const withoutPath = await without.path();
  if (!withoutPath) throw new Error("A completed download is required");
  const withoutHistory: unknown = JSON.parse(
    await readFile(withoutPath, "utf8"),
  );
  expect(withoutHistory).toEqual(document);
  expect(withoutHistory).not.toHaveProperty("versions");
  await include.check();
  const [withHistory] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Export JSON", exact: true }).click(),
  ]);
  expect(withHistory.suggestedFilename()).toBe("owned-history-51.json");
  const withPath = await withHistory.path();
  if (!withPath) throw new Error("A completed download is required");
  const exported: unknown = JSON.parse(await readFile(withPath, "utf8"));
  expect(exported).toEqual(bundle);
  expect(exported).toHaveProperty("versions", bundle.versions);
  expect(exports).toEqual(["false", "true"]);
  expect(writes).toBe(0);
  expect(sandbox.documentWrites()).toBe(0);
  expect(sandbox.document()).toEqual(document);
});

test("export count loads without guessing or enabling a premature export", async ({
  page,
}) => {
  let release!: () => void;
  const delay = new Promise<void>((resolve) => {
    release = resolve;
  });
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    versions: capacityVersions(1),
    versionListDelay: delay,
  });
  const dialog = await openImportExport(page);
  try {
    await expect(
      dialog.getByText("Loading version count…", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Export JSON", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByText("0 saved versions", { exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
  }
  await expect(
    dialog.getByText("2 saved versions", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Export JSON", exact: true }),
  ).toBeEnabled();
});

test("export count failure stays unavailable until an authoritative Retry", async ({
  page,
}) => {
  const options = {
    versions: capacityVersions(1),
    versionListFailure: 503 as number | undefined,
  };
  await openAuthenticatedSandbox(page, configuredSandboxDesign, options);
  const dialog = await openImportExport(page);
  await expect(
    dialog.getByText("Version count is unavailable.", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("0 saved versions", { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Export JSON", exact: true }),
  ).toBeDisabled();
  options.versionListFailure = undefined;
  await dialog
    .getByRole("button", { name: "Retry version count", exact: true })
    .click();
  await expect(
    dialog.getByText("2 saved versions", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Export JSON", exact: true }),
  ).toBeEnabled();
});

// A reply that is not a Sandbox document is refused by exportSandboxBundle
// (isolated/sandbox/api "rejects an invalid export attachment") and reaches
// the same catch as this 503.
test("unavailable export keeps history selection and produces no download", async ({
  page,
}) => {
  let downloads = 0;
  const requests: string[] = [];
  page.on("download", () => {
    downloads += 1;
  });
  await page.route("**/api/sandbox/export?*", (route) => {
    requests.push(
      new URL(route.request().url()).searchParams.get("includeVersions") ??
        "missing",
    );
    return route.fulfill({
      status: 503,
      json: { detail: "Private export canary" },
    });
  });
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredSandboxDesign,
    { versions: capacityVersions(1) },
  );
  const dialog = await openImportExport(page);
  const include = dialog.getByRole("checkbox", {
    name: "Include version history",
    exact: true,
  });
  await expect(include).toBeVisible();
  await include.check();
  await dialog
    .getByRole("button", { name: "Export JSON", exact: true })
    .click();
  await expect(
    dialog.getByText("Export could not be completed. Try again.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(include).toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "Export JSON", exact: true }),
  ).toBeEnabled();
  expect(downloads).toBe(0);
  expect(requests).toEqual(["true"]);
  expect(sandbox.documentWrites()).toBe(0);
  await expect(page.getByText("Private export canary")).toHaveCount(0);
});

test("pending export is single and cancellation refuses its late download", async ({
  page,
}) => {
  let release!: () => void;
  let finished = false;
  let requests = 0;
  let downloads = 0;
  const delay = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bundle = exportBundleFixture(capacityVersions(1));
  page.on("download", () => {
    downloads += 1;
  });
  await page.route("**/api/sandbox/export?*", async (route) => {
    requests += 1;
    await delay;
    await route.fulfill({ json: bundle });
    finished = true;
  });
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    versions: capacityVersions(1),
  });
  const dialog = await openImportExport(page);
  const include = dialog.getByRole("checkbox", {
    name: "Include version history",
    exact: true,
  });
  await expect(include).toBeVisible();
  await include.check();
  await dialog
    .getByRole("button", { name: "Export JSON", exact: true })
    .click();
  try {
    await expect.poll(() => requests).toBe(1);
    await expect(
      dialog.getByRole("button", { name: "Exporting…", exact: true }),
    ).toBeDisabled();
    await expect(include).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
  } finally {
    release();
  }
  await expect.poll(() => finished).toBe(true);
  await settleReact(page, 1);
  expect(downloads).toBe(0);
  expect(requests).toBe(1);
  await openImportExport(page);
  await expect(include).toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "Export JSON", exact: true }),
  ).toBeEnabled();
});

for (const transition of ["unmount", "account"] as const) {
  test(`export ignores a late result after ${transition} transition`, async ({
    page,
  }) => {
    let release!: () => void;
    let finished = false;
    let started = false;
    let downloads = 0;
    const delay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bundle = exportBundleFixture(capacityVersions(1));
    page.on("download", () => {
      downloads += 1;
    });
    await page.route("**/api/sandbox/export?*", async (route) => {
      started = true;
      await delay;
      await route.fulfill({ json: bundle });
      finished = true;
    });
    await openAuthenticatedSandbox(page, configuredSandboxDesign, {
      versions: capacityVersions(1),
    });
    if (transition === "unmount") {
      await page
        .getByRole("link", { name: "Search workspace", exact: true })
        .click();
      await expect(page).toHaveURL(/\/platform/);
      await page.getByRole("link", { name: "Build", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Sandbox", exact: true }),
      ).toBeVisible();
    }
    const dialog = await openImportExport(page);
    await expect(
      dialog.getByRole("checkbox", {
        name: "Include version history",
        exact: true,
      }),
    ).toBeVisible();
    await dialog
      .getByRole("checkbox", { name: "Include version history", exact: true })
      .check();
    await dialog
      .getByRole("button", { name: "Export JSON", exact: true })
      .click();
    try {
      await expect.poll(() => started).toBe(true);
      if (transition === "unmount") {
        await page.goBack();
        await expect(page).toHaveURL(/\/platform/);
      } else {
        const userB = "00000000-0000-4000-8000-000000000002";
        await signedInAs(page, { id: userB, role: "admin" });
        await page.evaluate(() =>
          window.dispatchEvent(new FocusEvent("focus")),
        );
        await expect(dialog).toBeHidden();
        await openImportExport(page);
        await expect(
          dialog.getByRole("checkbox", {
            name: "Include version history",
            exact: true,
          }),
        ).not.toBeChecked();
      }
    } finally {
      release();
    }
    await expect.poll(() => finished).toBe(true);
    await settleReact(page, 1);
    expect(downloads).toBe(0);
  });
}

test("import admission still refuses more than 50 snapshots before any write", async ({
  page,
}) => {
  const versions = capacityVersions(50);
  const bundle = exportBundleFixture(versions);
  let imports = 0;
  await page.route("**/api/sandbox/imports", (route) => {
    imports += 1;
    return route.fulfill({ status: 500, json: {} });
  });
  const sandbox = await openAuthenticatedSandbox(
    page,
    configuredSandboxDesign,
    { versions },
  );
  const dialog = await openImportExport(page);
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByRole("button", { name: "Choose JSON", exact: true }).click(),
  ]);
  await chooser.setFiles({
    name: "owned-history-51.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(bundle)),
  });
  await expect(
    dialog.getByText("Version limit exceeded", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Import draft", exact: true }),
  ).toHaveCount(0);
  expect(imports).toBe(0);
  expect(sandbox.documentWrites()).toBe(0);
});
