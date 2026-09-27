import { expect, test } from "@playwright/test";
import {
  openSandboxDocumentSession,
  proposedSandboxDocument,
  reapplySandboxDocument,
  reapplySandboxDocumentDraft,
  syncSandboxDocumentMetadata,
  updateSandboxDocumentSession,
} from "../../../src/components/systems/sandbox/state/document-session";
import type { SandboxDocumentResponse } from "../../../src/components/systems/sandbox/state/api";

function response(revision = 7): SandboxDocumentResponse {
  return {
    revision,
    contentHash: "a".repeat(64),
    byteCount: 256,
    issues: [],
    latestPublishedVersion: null,
    publishedHash: null,
    document: {
      kind: "openslate-sandbox",
      schemaVersion: 3,
      design: {
        departments: [{ id: "operations", name: "Operations", closed: false }],
        modules: [
          {
            id: "requests",
            departmentId: "operations",
            name: "Requests",
            closed: false,
            fields: [
              {
                id: "title",
                name: "Title",
                type: "Text",
                required: false,
                closed: false,
                config: { kind: "text", defaultValue: "" },
              },
            ],
          },
        ],
        relationships: [],
        layout: {
          operations: { x: 0, y: 0, width: 360, height: 240 },
          requests: { x: 24, y: 48, width: 280, height: 160 },
        },
      },
      triggers: [],
      scenarios: [],
    },
  };
}

test("loads a v2 response and prepares a revision-aware structural save", () => {
  const opened = openSandboxDocumentSession(response());
  const changed = updateSandboxDocumentSession(opened, {
    ...opened.history.present,
    modules: opened.history.present.modules.map((item) =>
      item.id === "requests" ? { ...item, name: "Service requests" } : item,
    ),
  });

  expect(changed.history.past).toHaveLength(1);
  expect(proposedSandboxDocument(changed).design.modules[0].name).toBe(
    "Service requests",
  );
});

test("reload and reapply keeps the user draft after a stale-revision conflict", () => {
  const opened = openSandboxDocumentSession(response(7));
  const changed = updateSandboxDocumentSession(opened, {
    ...opened.history.present,
    departments: [
      { ...opened.history.present.departments[0], name: "Field operations" },
    ],
  });
  const reloaded = response(8);
  reloaded.document.design.modules[0].name = "Requests from another editor";

  const reapplied = reapplySandboxDocumentDraft(
    reloaded,
    changed.history.present,
  );

  expect(reapplied.revision).toBe(8);
  expect(reapplied.history.present.departments[0].name).toBe(
    "Field operations",
  );
  expect(reapplied.history.present.modules[0].name).toBe("Requests");
});

test("metadata-only revision sync keeps local undo history", () => {
  const opened = openSandboxDocumentSession(response(7));
  const changed = updateSandboxDocumentSession(opened, {
    ...opened.history.present,
    departments: [
      { ...opened.history.present.departments[0], name: "Field operations" },
    ],
  });
  const synced = syncSandboxDocumentMetadata(changed, response(8));
  expect(synced.revision).toBe(8);
  expect(synced.history).toBe(changed.history);
});

test("whole-document reapply preserves trigger and scenario drafts", () => {
  const current = response(8);
  const proposed = structuredClone(current.document);
  proposed.triggers.push({
    id: "notify",
    name: "Notify",
    enabled: true,
    priority: 0,
    trigger: { kind: "record-created", moduleId: "requests" },
    conditionGroup: { operator: "all", conditions: [] },
    actions: [
      { id: "notify-action", kind: "notification", message: "Created" },
    ],
  });
  proposed.scenarios.push({
    id: "baseline",
    name: "Baseline",
    records: [],
    links: [],
  });

  const reapplied = reapplySandboxDocument(response(9), proposed);

  expect(reapplied.revision).toBe(9);
  expect(reapplied.document.triggers).toEqual(proposed.triggers);
  expect(reapplied.document.scenarios).toEqual(proposed.scenarios);
});
