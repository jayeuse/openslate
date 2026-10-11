import { expect, test } from "@playwright/test";
import { ApiContractError } from "../../../src/lib/api";
import type { SandboxDocumentV4 } from "../../../src/components/systems/sandbox/domain/document";
import {
  SANDBOX_REQUEST_BODY_LIMIT_BYTES,
  createSandboxVersion,
  createSandboxPublicationPreview,
  createSandboxTest,
  deleteSandboxVersion,
  encodeSandboxRequestBody,
  exportSandboxBundle,
  getSandboxVersion,
  importSandboxBundle,
  listSandboxTriggerRuns,
  listSandboxTests,
  listSandboxVersions,
  loadSandboxDocument,
  pruneSandboxVersions,
  replaceSandboxDocument,
  restoreSandboxVersion,
  publishSandbox,
  updateSandboxVersion,
} from "../../../src/components/systems/sandbox/state/api";

const versionId = "00000000-0000-4000-8000-000000000001";

const document: SandboxDocumentV4 = {
  kind: "openslate-sandbox",
  schemaVersion: 4,
  design: {
    departments: [{ id: "operations", name: "Operations", closed: false }],
    modules: [
      {
        id: "requests",
        departmentId: "operations",
        name: "Requests",
        closed: false,
        titleFieldId: "title",
        fields: [
          {
            id: "title",
            name: "Title",
            type: "Text",
            required: true,
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
};

const documentResponse = {
  document,
  revision: 7,
  contentHash: "a".repeat(64),
  byteCount: 321,
  issues: [],
  latestPublishedVersion: null,
  publishedHash: null,
  hasUnpublishedChanges: true,
};

const repairableDocument: SandboxDocumentV4 = {
  ...document,
  triggers: [
    {
      id: "notify-missing-module",
      name: "Notify missing module",
      enabled: true,
      priority: 0,
      trigger: { kind: "record-created", moduleId: "missing-module" },
      conditionGroup: { operator: "all", conditions: [] },
      actions: [
        {
          id: "notify",
          kind: "notification",
          message: "This draft needs repair",
        },
      ],
    },
  ],
};

const documentWithVersions: SandboxDocumentV4 = {
  ...document,
  versions: [
    {
      id: "checkpoint-1",
      label: "Before import",
      kind: "checkpoint",
      document: {
        design: document.design,
        triggers: document.triggers,
        scenarios: document.scenarios,
      },
      published: false,
      date: "2026-09-20T00:00:00Z",
    },
  ],
};

const version = {
  id: versionId,
  sequence: 2,
  kind: "checkpoint",
  label: "Before import",
  note: null,
  sourceDocumentRevision: 7,
  sourceVersionId: null,
  contentHash: "b".repeat(64),
  byteCount: 321,
  metadataRevision: 1,
  createdAt: "2026-09-20T00:00:00Z",
  performedBy: null,
  isDeleted: false,
  deletedAt: null,
};

type RecordedRequest = { input: RequestInfo | URL; init?: RequestInit };

function installFetch(
  response: (input: RequestInfo | URL, init?: RequestInit) => Response,
): { requests: RecordedRequest[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return response(input, init);
  };
  return { requests, restore: () => (globalThis.fetch = originalFetch) };
}

test("loads and replaces the revisioned Sandbox document through the same-origin API", async () => {
  const mock = installFetch(() => Response.json(documentResponse));
  try {
    await expect(loadSandboxDocument()).resolves.toEqual(documentResponse);
    await expect(
      replaceSandboxDocument({ expectedRevision: 7, document }),
    ).resolves.toEqual(documentResponse);

    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0]).toMatchObject({ input: "/api/sandbox/document" });
    expect(mock.requests[0].init).toMatchObject({ cache: "no-store" });
    expect(mock.requests[1].init).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 7, document }),
    });
  } finally {
    mock.restore();
  }
});

test("normalizes nullable optional fields emitted by the backend document model", async () => {
  const backendDocument = structuredClone(document) as unknown as {
    design: {
      modules: Array<{
        fields: Array<{
          description: null;
          config: { maxLength: null };
        }>;
      }>;
    };
    triggers: unknown[];
  };
  const field = backendDocument.design.modules[0]!.fields[0]!;
  field.description = null;
  field.config.maxLength = null;
  backendDocument.triggers = [
    {
      id: "notify-open",
      name: "Notify open request",
      enabled: true,
      priority: 0,
      trigger: { kind: "record-created", moduleId: "requests" },
      conditionGroup: {
        operator: "all",
        conditions: [
          {
            id: "is-open",
            field: {
              moduleId: "requests",
              fieldId: "title",
              relationshipId: null,
            },
            operator: "=",
            value: { kind: "literal", value: "Open" },
          },
        ],
      },
      actions: [
        { id: "notify", kind: "notification", message: "Request opened" },
      ],
    },
  ];
  const mock = installFetch(() =>
    Response.json({ ...documentResponse, document: backendDocument }),
  );
  try {
    await expect(loadSandboxDocument()).resolves.toMatchObject({
      document: {
        design: {
          modules: [
            {
              fields: [
                {
                  id: "title",
                  config: { kind: "text", defaultValue: "" },
                },
              ],
            },
          ],
        },
        triggers: [
          {
            conditionGroup: {
              conditions: [
                { field: { moduleId: "requests", fieldId: "title" } },
              ],
            },
          },
        ],
      },
    });
  } finally {
    mock.restore();
  }
});

test("preserves the server stale-revision error when replacement conflicts", async () => {
  const mock = installFetch(() =>
    Response.json(
      { detail: { code: "stale_revision", message: "Document changed" } },
      { status: 409 },
    ),
  );
  try {
    await expect(
      replaceSandboxDocument({ expectedRevision: 7, document }),
    ).rejects.toMatchObject({ status: 409, code: "stale_revision" });
  } finally {
    mock.restore();
  }
});

test("loads repairable drafts with server-reported semantic issues", async () => {
  const response = {
    ...documentResponse,
    document: repairableDocument,
    issues: [
      {
        code: "trigger.trigger_module_missing",
        message: "Trigger trigger module does not exist",
        targetId: "notify-missing-module",
      },
    ],
  };
  const mock = installFetch(() => Response.json(response));
  try {
    await expect(loadSandboxDocument()).resolves.toEqual(response);
  } finally {
    mock.restore();
  }
});

test("sends a note-only clear when version metadata removes the note", async () => {
  const mock = installFetch(() => Response.json({ ...version, document }));
  try {
    await expect(
      updateSandboxVersion({ versionId, expectedRevision: 7, note: null }),
    ).resolves.toMatchObject({ id: versionId });
    expect(mock.requests[0].init?.body).toBe(
      JSON.stringify({ expectedRevision: 7, note: null }),
    );
  } finally {
    mock.restore();
  }
});

test("rejects version metadata labels longer than the canonical 80-character cap", async () => {
  const mock = installFetch(() =>
    Response.json({ ...version, label: "x".repeat(81), document }),
  );
  try {
    await expect(
      createSandboxVersion({
        expectedRevision: 7,
        kind: "checkpoint",
        label: "Before import",
      }),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    mock.restore();
  }
});

function payloadWithEncodedBytes(byteCount: number): { content: string } {
  const empty = JSON.stringify({ content: "" });
  return { content: "x".repeat(byteCount - empty.length) };
}

test("allows a final JSON request body just below 5 MiB and rejects one byte over", () => {
  const below = payloadWithEncodedBytes(SANDBOX_REQUEST_BODY_LIMIT_BYTES - 1);
  const over = payloadWithEncodedBytes(SANDBOX_REQUEST_BODY_LIMIT_BYTES + 1);

  expect(new TextEncoder().encode(JSON.stringify(below))).toHaveLength(
    SANDBOX_REQUEST_BODY_LIMIT_BYTES - 1,
  );
  expect(new TextEncoder().encode(JSON.stringify(over))).toHaveLength(
    SANDBOX_REQUEST_BODY_LIMIT_BYTES + 1,
  );
  expect(() => encodeSandboxRequestBody(below)).not.toThrow();
  expect(() => encodeSandboxRequestBody(over)).toThrow(
    "Sandbox document request exceeds the 5 MiB limit",
  );
});

test("uses documented version and import endpoints with revision payloads", async () => {
  const mock = installFetch((input, init) => {
    const path = String(input);
    if (path.includes("/versions?")) {
      return Response.json({
        items: [version],
        limit: 20,
        offset: 0,
        count: 1,
        total: 1,
        hasMore: false,
        mutableCount: 1,
        versionCap: 50,
      });
    }
    if (path.endsWith(`/versions/${versionId}`) && init?.method === "DELETE")
      return new Response(null, { status: 204 });
    if (path.endsWith(`/versions/${versionId}`))
      return Response.json({ ...version, document });
    if (path.endsWith("/versions") && init?.method === "POST")
      return Response.json({ ...version, document });
    return Response.json(documentResponse);
  });
  try {
    await expect(listSandboxVersions()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: versionId })],
      mutableCount: 1,
      versionCap: 50,
    });
    await expect(getSandboxVersion(versionId)).resolves.toMatchObject({
      document,
    });
    await expect(
      createSandboxVersion({
        expectedRevision: 7,
        kind: "checkpoint",
        label: "Before import",
      }),
    ).resolves.toMatchObject({ id: versionId });
    await expect(
      updateSandboxVersion({
        versionId,
        expectedRevision: 7,
        label: "Renamed checkpoint",
      }),
    ).resolves.toMatchObject({ id: versionId });
    await expect(
      deleteSandboxVersion({ versionId, expectedRevision: 7 }),
    ).resolves.toBeUndefined();
    await expect(
      restoreSandboxVersion({ versionId, expectedRevision: 7 }),
    ).resolves.toEqual(documentResponse);
    await expect(
      importSandboxBundle({ expectedRevision: 7, bundle: document }),
    ).resolves.toEqual(documentResponse);

    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      ["/api/sandbox/versions?limit=20&offset=0", undefined],
      [`/api/sandbox/versions/${versionId}`, undefined],
      ["/api/sandbox/versions", "POST"],
      [`/api/sandbox/versions/${versionId}`, "PATCH"],
      [`/api/sandbox/versions/${versionId}`, "DELETE"],
      [`/api/sandbox/versions/${versionId}/restorations`, "POST"],
      ["/api/sandbox/imports", "POST"],
    ]);
    expect(mock.requests[4].init?.body).toBe(
      JSON.stringify({ expectedRevision: 7 }),
    );
    expect(mock.requests[6].init?.body).toBe(
      JSON.stringify({ expectedRevision: 7, bundle: document }),
    );
  } finally {
    mock.restore();
  }
});

test("Sandbox history requests only a bounded server-search page", async () => {
  const mock = installFetch(() =>
    Response.json({
      items: [version],
      limit: 20,
      offset: 20,
      count: 1,
      total: 60,
      hasMore: true,
      mutableCount: 45,
      versionCap: 50,
    }),
  );
  try {
    await expect(
      listSandboxVersions({
        limit: 20,
        offset: 20,
        search: " migration ",
        kind: "imported",
      }),
    ).resolves.toMatchObject({
      items: [version],
      total: 60,
      hasMore: true,
      mutableCount: 45,
      versionCap: 50,
    });
    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      "/api/sandbox/versions?limit=20&offset=20&search=migration&kind=imported",
    ]);
  } finally {
    mock.restore();
  }
});

test("Sandbox history rejects invalid search and kind before transport", async () => {
  const mock = installFetch(() => Response.json(null));
  try {
    for (const options of [
      { search: "x".repeat(101) },
      { kind: "invalid" },
      { limit: 101 },
      { offset: -1 },
    ])
      await expect(async () =>
        listSandboxVersions(
          options as Parameters<typeof listSandboxVersions>[0],
        ),
      ).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

// Capacity is never guessed: a page without a whole-number count or with
// another cap is refused, and the History and checkpoint screens then show
// "Version capacity is unavailable" (http "refused capacity is unavailable
// rather than guessed or usable" keeps that screen).
for (const capacity of [
  { name: "no capacity", fields: {} },
  { name: "a text count", fields: { mutableCount: "50", versionCap: 50 } },
  { name: "another cap", fields: { mutableCount: 45, versionCap: 49 } },
]) {
  test(`a version page with ${capacity.name} is a contract error`, async () => {
    const mock = installFetch(() =>
      Response.json({
        items: [version],
        limit: 20,
        offset: 0,
        count: 1,
        total: 1,
        hasMore: false,
        ...capacity.fields,
      }),
    );
    try {
      await expect(listSandboxVersions({ limit: 20 })).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      mock.restore();
    }
  });
}

test("pruning old versions sends the draft revision and refuses a deleted count that is not a number", async () => {
  const replies = [{ deletedCount: 10 }, { deletedCount: "10" }];
  const mock = installFetch(() => Response.json(replies.shift()));
  try {
    await expect(
      pruneSandboxVersions({ expectedRevision: 7 }),
    ).resolves.toEqual({ deletedCount: 10 });
    await expect(
      pruneSandboxVersions({ expectedRevision: 8 }),
    ).rejects.toBeInstanceOf(ApiContractError);
    expect(
      mock.requests.map(({ input, init }) => [
        String(input),
        init?.method,
        init?.body,
      ]),
    ).toEqual([
      [
        "/api/sandbox/versions/prune",
        "POST",
        JSON.stringify({ expectedRevision: 7 }),
      ],
      [
        "/api/sandbox/versions/prune",
        "POST",
        JSON.stringify({ expectedRevision: 8 }),
      ],
    ]);
  } finally {
    mock.restore();
  }
});

test("rejects malformed JSON responses instead of accepting an unchecked server shape", async () => {
  const mock = installFetch(() =>
    Response.json({ ...documentResponse, unexpected: true }),
  );
  try {
    await expect(loadSandboxDocument()).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
});

test("downloads exports through apiRequest and validates the attached JSON document", async () => {
  const mock = installFetch(
    () =>
      new Response(JSON.stringify(document), {
        headers: {
          "Content-Disposition":
            'attachment; filename="openslate-sandbox.json"',
          "Content-Type": "application/json",
        },
      }),
  );
  try {
    await expect(
      exportSandboxBundle({ includeVersions: false }),
    ).resolves.toEqual({
      document,
      filename: "openslate-sandbox.json",
    });
    expect(mock.requests[0]).toMatchObject({
      input: "/api/sandbox/export?includeVersions=false",
      init: { cache: "no-store" },
    });
  } finally {
    mock.restore();
  }
});

test("round-trips an export attachment that includes portable history", async () => {
  const mock = installFetch(
    () =>
      new Response(JSON.stringify(documentWithVersions), {
        headers: {
          "Content-Disposition":
            'attachment; filename="openslate-sandbox.json"',
          "Content-Type": "application/json",
        },
      }),
  );
  try {
    await expect(
      exportSandboxBundle({ includeVersions: true }),
    ).resolves.toEqual({
      document: documentWithVersions,
      filename: "openslate-sandbox.json",
    });
    expect(mock.requests[0].input).toBe(
      "/api/sandbox/export?includeVersions=true",
    );
  } finally {
    mock.restore();
  }
});

test("rejects an invalid export attachment", async () => {
  const mock = installFetch(() => new Response('{"kind":"not-sandbox"}'));
  try {
    await expect(exportSandboxBundle()).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
});

test("uses the review and publish contract with a durable idempotency key", async () => {
  const preview = {
    previewToken: "temporary-review-token",
    impactDigest: "b".repeat(64),
    documentRevision: 7,
    documentHash: "a".repeat(64),
    expiresAt: "2026-09-21T00:05:00Z",
    changes: [
      {
        kind: "module",
        action: "create",
        sandboxId: "requests",
        label: "Requests",
      },
    ],
    counts: {
      departments: 0,
      modules: 1,
      fields: 0,
      relationships: 0,
      triggers: 0,
    },
    warnings: [],
    blockers: [],
  };
  const mock = installFetch((input) =>
    String(input).endsWith("publication-previews")
      ? Response.json(preview)
      : Response.json({
          id: "00000000-0000-4000-8000-000000000002",
          version: {
            id: versionId,
            sequence: 1,
            kind: "published",
            label: "Published 1",
          },
          documentRevision: 7,
          documentHash: "a".repeat(64),
          impactDigest: "b".repeat(64),
          publishedAt: "2026-09-21T00:01:00Z",
        }),
  );
  try {
    await expect(
      createSandboxPublicationPreview({ expectedRevision: 7 }),
    ).resolves.toEqual(preview);
    await expect(
      publishSandbox({
        expectedRevision: 7,
        previewToken: preview.previewToken,
        impactDigest: preview.impactDigest,
        password: "password",
        note: "Ready",
        idempotencyKey: "publish-1",
      }),
    ).resolves.toMatchObject({ version: { id: versionId } });
    expect(mock.requests[0]).toMatchObject({
      input: "/api/sandbox/publication-previews",
      init: { method: "POST", body: JSON.stringify({ expectedRevision: 7 }) },
    });
    expect(mock.requests[1]).toMatchObject({
      input: "/api/sandbox/publications",
      init: {
        method: "POST",
        body: JSON.stringify({
          expectedRevision: 7,
          previewToken: preview.previewToken,
          impactDigest: preview.impactDigest,
          password: "password",
          note: "Ready",
        }),
      },
    });
    expect(
      new Headers(mock.requests[1].init?.headers).get("Idempotency-Key"),
    ).toBe("publish-1");
  } finally {
    mock.restore();
  }
});

test("normalizes a publication blocker without a target from the backend", async () => {
  const preview = {
    previewToken: "temporary-review-token",
    impactDigest: "b".repeat(64),
    documentRevision: 7,
    documentHash: "a".repeat(64),
    expiresAt: "2026-09-21T00:05:00Z",
    changes: [],
    counts: {
      departments: 0,
      modules: 0,
      fields: 0,
      relationships: 0,
      triggers: 0,
    },
    warnings: [],
    blockers: [
      {
        code: "empty_document",
        message: "Add at least one module before publishing.",
        targetId: null,
      },
    ],
  };
  const mock = installFetch(() => Response.json(preview));
  try {
    await expect(
      createSandboxPublicationPreview({ expectedRevision: 7 }),
    ).resolves.toMatchObject({
      blockers: [
        {
          code: "empty_document",
          message: "Add at least one module before publishing.",
        },
      ],
    });
  } finally {
    mock.restore();
  }
});

test("sends temporary Test inputs to the test endpoint without changing the Sandbox document", async () => {
  const run = {
    id: "00000000-0000-4000-8000-000000000003",
    createdAt: "2026-09-21T00:01:00Z",
    documentRevision: 7,
    input: { moduleId: "requests", values: { title: "Check pump" } },
    event: { kind: "field-changed", fieldId: "title" },
    triggerIds: ["set-status"],
    result: {
      values: { title: "Check pump" },
      routes: [],
      triggerTraces: [],
      issues: [],
    },
  };
  const mock = installFetch(() => Response.json(run));
  try {
    await expect(
      createSandboxTest({
        expectedRevision: 7,
        moduleId: "requests",
        values: { title: "Check pump" },
        event: { kind: "field-changed", fieldId: "title" },
        triggerIds: ["set-status"],
      }),
    ).resolves.toEqual(run);
    expect(mock.requests[0].input).toBe("/api/sandbox/tests");
    expect(mock.requests[0].init?.body).toBe(
      JSON.stringify({
        expectedRevision: 7,
        moduleId: "requests",
        values: { title: "Check pump" },
        event: { kind: "field-changed", fieldId: "title" },
        triggerIds: ["set-status"],
      }),
    );
    expect(document).not.toHaveProperty("testInput");
  } finally {
    mock.restore();
  }
});

test("accepts a daily Test response where the backend serializes weekday as null", async () => {
  const run = {
    id: "00000000-0000-4000-8000-000000000006",
    createdAt: "2026-09-21T00:01:00Z",
    documentRevision: 7,
    input: { moduleId: "requests", values: { title: "Check pump" } },
    event: {
      kind: "schedule",
      frequency: "daily",
      time: "09:00",
      weekday: null,
    },
    triggerIds: null,
    result: {
      values: { title: "Check pump" },
      routes: [],
      triggerTraces: [],
      issues: [],
    },
  };
  const mock = installFetch(() => Response.json({ items: [run] }));
  try {
    await expect(listSandboxTests()).resolves.toEqual({
      items: [
        {
          ...run,
          event: { kind: "schedule", frequency: "daily", time: "09:00" },
        },
      ],
    });
  } finally {
    mock.restore();
  }
});

test("loads bounded recent published trigger activity", async () => {
  const run = {
    id: "00000000-0000-4000-8000-000000000004",
    createdAt: "2026-09-21T00:02:00Z",
    triggerId: "00000000-0000-4000-8000-000000000005",
    triggerName: "Set request status",
    eventKind: "field-changed",
    state: "succeeded",
    details: { actionsApplied: 1, recordsMatched: 1 },
    attempts: 1,
  };
  const mock = installFetch(() =>
    Response.json({
      items: [run],
      limit: 20,
      offset: 0,
      count: 1,
      total: 1,
      hasMore: false,
    }),
  );
  try {
    await expect(listSandboxTriggerRuns()).resolves.toEqual({
      items: [run],
      limit: 20,
      offset: 0,
      count: 1,
      total: 1,
      hasMore: false,
    });
    expect(mock.requests[0]).toMatchObject({
      input: "/api/sandbox/trigger-runs?limit=20&offset=0",
      init: { cache: "no-store" },
    });
    expect(() => listSandboxTriggerRuns({ limit: 51 })).toThrow(
      "Trigger run limit must be between 1 and 50",
    );
  } finally {
    mock.restore();
  }
});
