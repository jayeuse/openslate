import { expect, type Page } from "./test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./openview-event-source";
import type { Design } from "../../../src/components/systems/sandbox/domain/model";
import {
  configuredSandboxDesign,
  sandboxDocumentFromDesign,
} from "../../helpers/sandbox-fixtures";

// The Sandbox fake backend for http specs: one in-memory draft, its version
// history, bindings, Test runs and publication preview, plus the lifecycle,
// export and History helpers that several Sandbox journeys share. Each spec
// still owns its assertions; the fake only answers requests.

type TestRunRequest = {
  moduleId: string;
  values: Record<string, unknown>;
  event: { kind: string };
  triggerIds?: string[];
};

type TestRunEcho = {
  id: string;
  createdAt: string;
  /** Sees each request first; a returned promise holds the reply. */
  onRequest?: (request: TestRunRequest) => void | Promise<void>;
  /** The result values; the submitted values when omitted. */
  resultValues?: (values: Record<string, unknown>) => Record<string, unknown>;
};

export type SandboxOptions = {
  importFailure?: string;
  saveFailure?: string;
  clearTestsFailure?: string;
  discardRefreshFailure?: string;
  discardRefreshDelay?: Promise<void>;
  hasUnpublishedChanges?: boolean;
  publishedHash?: string | null;
  testRuns?: unknown[];
  /** Answers each Test run with a run that echoes the submitted values. */
  testRunEcho?: TestRunEcho;
  /** The draft revision the session starts at. */
  revision?: number;
  saveDelay?: Promise<void>;
  publicationDelay?: Promise<void>;
  issues?: Array<{ code: string; message: string; targetId: string | null }>;
  versionMutationDelay?: Promise<void>;
  versionListDelay?: Promise<void>;
  versionListFailure?: number;
  pruneDelay?: Promise<void>;
  pruneReadbackDelay?: Promise<void>;
  pruneReadbackFailure?: boolean;
  pruneFailure?: { status: number; code: string };
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

export async function openAuthenticatedSandbox(
  page: Page,
  designFixture: Design = configuredSandboxDesign,
  options: SandboxOptions = {},
) {
  await installOpenViewEventSource(page);
  const workspace = { purge_enabled: true as boolean | undefined };
  let workspaceFailure = false;
  await page.route("**/api/workspace", (route) =>
    route.fulfill(
      workspaceFailure
        ? { status: 503, json: { detail: "Workspace unavailable" } }
        : { json: workspace },
    ),
  );
  let revision = options.revision ?? 1;
  let documentReads = 0;
  let documentWrites = 0;
  let versions = options.versions ?? [];
  let pruned = false;
  let pruneReadbackFailure = options.pruneReadbackFailure ?? false;
  const pruneRequests: unknown[] = [];
  const checkpointRequests: unknown[] = [];
  let document = sandboxDocumentFromDesign(designFixture);
  let bindings = options.bindings ?? [];
  let bindingFailure = options.bindingFailure;
  let bindingRevision = options.bindingRevision;
  await page.route("**/api/sandbox/document", async (route) => {
    if (route.request().method() === "GET") {
      documentReads += 1;
      if (pruned) await options.pruneReadbackDelay;
      if (pruned && pruneReadbackFailure)
        return route.fulfill({
          status: 503,
          json: { detail: "Readback unavailable" },
        });
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
    await options.versionListDelay;
    if (pruned) await options.pruneReadbackDelay;
    if (options.versionListFailure || (pruned && pruneReadbackFailure))
      return route.fulfill({
        status: options.versionListFailure ?? 503,
        json: { detail: "History unavailable" },
      });
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    const search = (url.searchParams.get("search") ?? "").toLocaleLowerCase();
    const kind = url.searchParams.get("kind");
    const filtered = versions
      .filter(
        (version) =>
          !version.isDeleted &&
          (!kind || version.kind === kind) &&
          `${version.label} ${version.note ?? ""}`
            .toLocaleLowerCase()
            .includes(search),
      )
      .sort((a, b) => Number(b.sequence) - Number(a.sequence));
    const items = filtered.slice(offset, offset + limit);
    await route.fulfill({
      json: {
        items,
        limit,
        offset,
        count: items.length,
        total: filtered.length,
        hasMore: offset + items.length < filtered.length,
        mutableCount: versions.filter(
          (version) =>
            !version.isDeleted &&
            (version.kind === "checkpoint" || version.kind === "imported"),
        ).length,
        versionCap: 50,
      },
    });
  });
  await page.route("**/api/sandbox/versions/*", async (route) => {
    if (route.request().method() === "GET") {
      const id = new URL(route.request().url()).pathname.split("/").at(-1);
      const version = versions.find(
        (item) => item.id === id && !item.isDeleted,
      );
      return route.fulfill(
        version
          ? { json: { ...version, document } }
          : { status: 404, json: { detail: "Unavailable" } },
      );
    }
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
  await page.route("**/api/sandbox/versions/prune", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON();
    pruneRequests.push(body);
    await options.pruneDelay;
    if (options.pruneFailure) {
      if (options.pruneFailure.code === "stale_revision") revision += 1;
      return route.fulfill({
        status: options.pruneFailure.status,
        json: {
          detail: {
            code: options.pruneFailure.code,
            message: "Private failure canary",
          },
        },
      });
    }
    if (body.expectedRevision !== revision)
      return route.fulfill({
        status: 409,
        json: { detail: { code: "stale_revision", message: "Changed" } },
      });
    const mutable = versions
      .filter((version) => !version.isDeleted && version.kind !== "published")
      .sort((a, b) => Number(a.sequence) - Number(b.sequence));
    const deleted = mutable.slice(0, Math.max(0, mutable.length - 40));
    const deletedIds = new Set(deleted.map((version) => version.id));
    versions = versions.filter((version) => !deletedIds.has(version.id));
    if (deleted.length) revision += 1;
    pruned = true;
    await route.fulfill({
      json: { deletedCount: deleted.length },
    });
  });
  await page.route("**/api/sandbox/versions", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON();
    checkpointRequests.push(body);
    if (
      versions.filter(
        (version) => !version.isDeleted && version.kind !== "published",
      ).length >= 50
    )
      return route.fulfill({
        status: 409,
        json: {
          detail: { code: "version_limit", message: "Private capacity canary" },
        },
      });
    if (body.expectedRevision !== revision)
      return route.fulfill({
        status: 409,
        json: { detail: { code: "stale_revision", message: "Changed" } },
      });
    const sequence =
      Math.max(0, ...versions.map((version) => Number(version.sequence))) + 1;
    const version = {
      ...historyVersionFixture(
        sequence,
        body.label,
        "checkpoint",
        body.note ?? null,
      ),
      sourceDocumentRevision: revision,
      createdAt: "2026-10-01T10:00:00Z",
    };
    versions = [...versions, version];
    revision += 1;
    await route.fulfill({ json: { ...version, document } });
  });
  await page.route("**/api/sandbox/tests*", async (route) => {
    if (route.request().method() === "POST" && options.testRunEcho) {
      const echo = options.testRunEcho;
      const request = route.request().postDataJSON() as TestRunRequest;
      await echo.onRequest?.(request);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: echo.id,
          createdAt: echo.createdAt,
          documentRevision: 1,
          input: { moduleId: request.moduleId, values: request.values },
          event: request.event,
          triggerIds: request.triggerIds ?? null,
          result: {
            values: echo.resultValues?.(request.values) ?? request.values,
            routes: [],
            triggerTraces: [],
            issues: [],
          },
        }),
      });
      return;
    }
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
    page.getByRole("heading", { name: "Sandbox", exact: true }),
  ).toBeVisible();
  return {
    workspace,
    failWorkspaceRead: (failed: boolean) => {
      workspaceFailure = failed;
    },
    refreshWorkspace: () =>
      sendOpenViewEvent(page, "invalidate", { entity: "workspace_profiles" }),
    document: () => structuredClone(document),
    documentReads: () => documentReads,
    documentWrites: () => documentWrites,
    pruneRequests: () => structuredClone(pruneRequests),
    checkpointRequests: () => structuredClone(checkpointRequests),
    versions: () => structuredClone(versions),
    setPruneReadbackFailure: (failed: boolean) => {
      pruneReadbackFailure = failed;
    },
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

export function lifecycleImpactFixture(
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

export function historyVersionFixture(
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

export function capacityVersions(count: number) {
  return [
    ...Array.from({ length: count }, (_, index) => ({
      ...historyVersionFixture(
        index + 1,
        index === 0 ? "Needle checkpoint" : `Owned checkpoint ${index + 1}`,
        index % 2 ? "imported" : "checkpoint",
      ),
      createdAt: "2026-10-01T10:00:00Z",
    })),
    {
      ...historyVersionFixture(100, "Protected publication", "published"),
      createdAt: "2026-10-01T10:00:00Z",
    },
  ];
}

export function historyPagingVersions(count = 28) {
  return Array.from({ length: count }, (_, index) => ({
    ...historyVersionFixture(
      count - index,
      `Saved checkpoint ${count - index}`,
    ),
    createdAt: "2026-09-23T10:00:00Z",
  }));
}

export async function openCheckpointDialog(page: Page) {
  await page
    .getByRole("button", { name: "More Sandbox actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Save checkpoint", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Save checkpoint", exact: true });
}

export type SandboxBinding = NonNullable<SandboxOptions["bindings"]>[number];

/** A live-state binding of one Sandbox item to its live ID. */
export function liveBinding(
  kind: SandboxBinding["kind"],
  sandboxId: string,
  liveId: string,
  options: { parent?: string; deleted?: boolean } = {},
): SandboxBinding {
  return {
    kind,
    sandbox_id: sandboxId,
    parent_sandbox_id: options.parent ?? null,
    live_id: liveId,
    is_deleted: options.deleted ?? false,
  };
}

type LifecycleKind = "department" | "module" | "field";
type LifecycleOperation = "close" | "reopen" | "purge";

/** The `close` or `purge` preview a lifecycle dialog reviews before it confirms. */
export function lifecycleReview(
  kind: LifecycleKind,
  liveId: string,
  operation: "close" | "purge",
  review: {
    token: string;
    confirmationName: string;
    impact?: Record<string, unknown>;
  },
) {
  return {
    impact: {
      ...lifecycleImpactFixture(kind, liveId, operation),
      ...review.impact,
    },
    token: review.token,
    expires_at: "2027-10-01T00:00:00Z",
    confirmation_name: review.confirmationName,
    ...(operation === "purge" ? { last_successful_backup_at: null } : {}),
  };
}

/**
 * What a lifecycle command handler returns: nothing for the confirmed result,
 * an operation ID for a confirmed result that names one, or a refusal.
 */
type LifecycleOutcome =
  void | { operationId: string } | { status: number; json: unknown };

/**
 * Answers the preview and command routes of one live item. A command handler
 * records the request and confirms the live change through the fake before
 * the reply is sent, in that order.
 */
export async function installLifecycleRoutes(
  page: Page,
  target: { kind: LifecycleKind; liveId: string },
  routes: {
    reviews?: Partial<
      Record<
        "close" | "purge",
        () =>
          | ReturnType<typeof lifecycleReview>
          | Promise<ReturnType<typeof lifecycleReview>>
      >
    >;
    commands?: Partial<
      Record<
        LifecycleOperation,
        (body: unknown) => LifecycleOutcome | Promise<LifecycleOutcome>
      >
    >;
  },
): Promise<void> {
  const base = `**/api/${target.kind}s/${target.liveId}`;
  for (const [operation, review] of Object.entries(routes.reviews ?? {}))
    await page.route(`${base}/${operation}/preview`, async (route) =>
      route.fulfill({ json: await review() }),
    );
  for (const [operation, command] of Object.entries(routes.commands ?? {}))
    await page.route(`${base}/${operation}`, async (route) => {
      const outcome = await command(route.request().postDataJSON());
      if (outcome && "status" in outcome)
        return route.fulfill({ status: outcome.status, json: outcome.json });
      await route.fulfill({
        json: {
          impact: lifecycleImpactFixture(
            target.kind,
            target.liveId,
            operation as LifecycleOperation,
          ),
          operation_id: outcome?.operationId ?? null,
        },
      });
    });
}

/** An export attachment holding `versions` as portable snapshots. */
export function exportBundleFixture(
  versions: ReadonlyArray<{
    id: string;
    label: string;
    kind: string;
    createdAt: string;
  }>,
  document = sandboxDocumentFromDesign(configuredSandboxDesign),
) {
  return {
    ...document,
    versions: versions.map((version) => ({
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
    })),
  };
}

/** Opens Import or export from the Sandbox actions menu. */
export async function openImportExport(page: Page) {
  await page
    .getByRole("button", { name: "More Sandbox actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Import or export", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Import or export", exact: true });
}

/** The three History regions: the timeline, the inspected version, and the comparison. */
export function historyRegions(page: Page) {
  return {
    timeline: page.getByRole("region", {
      name: "Version timeline",
      exact: true,
    }),
    inspector: page.getByRole("region", {
      name: "Selected version",
      exact: true,
    }),
    comparison: page.getByRole("region", {
      name: "Version comparison",
      exact: true,
    }),
  };
}
