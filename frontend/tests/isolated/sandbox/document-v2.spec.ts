import { expect, test } from "@playwright/test";
import {
  exportSandboxDocument,
  migrateSandboxFileV1,
  parseSandboxDocument,
  parseSandboxDocumentForApi,
  type SandboxDocumentV2,
} from "../../../src/components/systems/sandbox/domain/document";
import type { SandboxFileV1 } from "../../../src/components/systems/sandbox/helpers/file-format";
import { parseSandboxFile } from "../../../src/components/systems/sandbox/helpers/file-format";
import { configuredSandboxDesign as initialDesign } from "../../helpers/sandbox-fixtures";

function v1Fixture(): SandboxFileV1 {
  return {
    kind: "openslate-sandbox" as const,
    schemaVersion: 1 as const,
    design: structuredClone(initialDesign),
  };
}

function v2Fixture(): SandboxDocumentV2 {
  return {
    kind: "openslate-sandbox",
    schemaVersion: 2,
    design: {
      departments: [{ id: "ops", name: "Operations", closed: false }],
      modules: [
        {
          id: "requests",
          departmentId: "ops",
          name: "Requests",
          closed: false,
          fields: [
            {
              id: "title",
              name: "Title",
              type: "Text",
              required: true,
              closed: false,
              config: { kind: "text", defaultValue: "" },
            },
            {
              id: "status",
              name: "Status",
              type: "Select",
              required: false,
              closed: false,
              config: {
                kind: "select",
                defaultValue: "Open",
                options: ["Open", "Closed"],
              },
            },
          ],
        },
      ],
      relationships: [],
      layout: {
        ops: { x: 0, y: 0, width: 360, height: 240 },
        requests: { x: 24, y: 48, width: 280, height: 160 },
      },
    },
    automations: [
      {
        id: "notify-open",
        name: "Notify on new request",
        enabled: true,
        priority: 0,
        trigger: { kind: "record-created", moduleId: "requests" },
        conditionGroup: {
          operator: "all",
          conditions: [
            {
              id: "is-open",
              field: { moduleId: "requests", fieldId: "status" },
              operator: "=",
              value: { kind: "literal", value: "Open" },
            },
          ],
        },
        actions: [
          { id: "send", kind: "notification", message: "A request is open" },
          {
            id: "copy-status",
            kind: "set-field",
            target: { moduleId: "requests", fieldId: "status" },
            value: {
              kind: "field-reference",
              moduleId: "requests",
              fieldId: "status",
            },
          },
        ],
      },
    ],
    scenarios: [
      {
        id: "open-request",
        name: "Open request",
        records: [
          {
            id: "request-1",
            moduleId: "requests",
            values: { title: "Printer unavailable", status: "Open" },
          },
        ],
        links: [],
      },
    ],
  };
}

test("v2 sandbox documents serialize canonically without editor or run state", () => {
  const document = v2Fixture();
  const serialized = exportSandboxDocument({
    ...document,
    versions: [
      {
        id: "checkpoint-1",
        label: "Before changes",
        kind: "checkpoint",
        published: false,
        date: "2026-09-20T00:00:00.000Z",
        document: {
          design: document.design,
          automations: document.automations,
          scenarios: document.scenarios,
        },
      },
    ],
  });

  const parsed = parseSandboxDocument(serialized);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error);
  expect(parsed.document).toEqual(JSON.parse(serialized));
  expect(serialized).not.toContain("undo");
  expect(serialized).not.toContain("runs");
  expect(parsed.document.automations[0].actions[1]).toEqual({
    id: "copy-status",
    kind: "set-field",
    target: { moduleId: "requests", fieldId: "status" },
    value: {
      kind: "field-reference",
      moduleId: "requests",
      fieldId: "status",
    },
  });
});

test("v2 accepts compatible text mappings", () => {
  const document = v2Fixture();
  document.design.modules.push({
    id: "triage",
    departmentId: "ops",
    name: "Triage",
    closed: false,
    fields: [
      {
        id: "notes",
        name: "Notes",
        type: "Long text",
        required: false,
        closed: false,
        config: { kind: "long-text", defaultValue: "" },
      },
    ],
  });
  document.design.layout.triage = {
    x: 400,
    y: 48,
    width: 280,
    height: 160,
  };
  document.design.relationships = [
    {
      id: "request-triage",
      name: "Routes to triage",
      sourceModuleId: "requests",
      targetModuleId: "triage",
      cardinality: "one-to-many",
      fieldMappings: [{ sourceFieldId: "title", targetFieldId: "notes" }],
    },
  ];
  document.automations[0].actions.push({
    id: "create-triage",
    kind: "create-record",
    moduleId: "triage",
    values: [{ fieldId: "notes", value: { kind: "literal", value: "Queued" } }],
  });

  expect(parseSandboxDocument(exportSandboxDocument(document))).toEqual({
    ok: true,
    document,
  });
});

test("v2 rejects unrelated direct and one-hop automation references", () => {
  const document = v2Fixture();
  for (const id of ["remote", "other"]) {
    document.design.modules.push({
      id,
      departmentId: "ops",
      name: id,
      closed: false,
      fields: [
        {
          id: `${id}-text`,
          name: "Text",
          type: "Text",
          required: false,
          closed: false,
          config: { kind: "text", defaultValue: "" },
        },
      ],
    });
    document.design.layout[id] = { x: 400, y: 48, width: 280, height: 160 };
  }
  document.design.relationships = [
    {
      id: "other-to-remote",
      name: "Other remote",
      sourceModuleId: "other",
      targetModuleId: "remote",
      cardinality: "one-to-many",
      fieldMappings: [],
    },
  ];
  document.automations[0].actions[1] = {
    id: "unrelated-one-hop",
    kind: "set-field",
    target: { moduleId: "requests", fieldId: "title" },
    value: {
      kind: "field-reference",
      moduleId: "remote",
      fieldId: "remote-text",
      relationshipId: "other-to-remote",
    },
  };

  expect(parseSandboxDocument(JSON.stringify(document)).ok).toBe(false);

  const direct = structuredClone(document);
  direct.automations[0].actions[1] = {
    id: "unrelated-direct",
    kind: "set-field",
    target: { moduleId: "remote", fieldId: "remote-text" },
    value: { kind: "literal", value: "x" },
  };
  expect(parseSandboxDocument(JSON.stringify(direct)).ok).toBe(false);
  expect(parseSandboxDocumentForApi(JSON.stringify(direct))).toEqual({
    ok: true,
    document: direct,
  });

  const scheduled = structuredClone(document);
  scheduled.automations[0].trigger = {
    kind: "schedule",
    frequency: "daily",
    time: "09:00",
  };
  expect(parseSandboxDocument(JSON.stringify(scheduled)).ok).toBe(false);
});

test("API document parsing admits repairable graph defects but portable parsing rejects them", () => {
  const document = v2Fixture();
  document.design.departments.push({
    ...document.design.departments[0],
    name: "Duplicate operations",
  });
  document.design.modules[0].departmentId = "missing-department";
  document.design.modules[0].fields.push({
    ...document.design.modules[0].fields[0],
    name: "Duplicate title",
  });
  document.design.relationships = [
    {
      id: "duplicate-relationship",
      name: "One",
      sourceModuleId: "requests",
      targetModuleId: "requests",
      cardinality: "one-to-many",
      fieldMappings: [],
    },
    {
      id: "duplicate-relationship",
      name: "Two",
      sourceModuleId: "requests",
      targetModuleId: "requests",
      cardinality: "one-to-many",
      fieldMappings: [],
    },
  ];
  document.automations.push({ ...document.automations[0] });
  document.scenarios.push({ ...document.scenarios[0] });
  delete document.design.layout.requests;
  document.design.layout.orphan = { x: 0, y: 0, width: 100, height: 100 };

  const text = JSON.stringify(document);
  expect(parseSandboxDocument(text).ok).toBe(false);
  expect(parseSandboxDocumentForApi(text).ok).toBe(true);
});

test("v2 rejects unsafe optional and constrained field-reference assignments", () => {
  const optionalSource = v2Fixture();
  optionalSource.design.modules[0].fields.push({
    id: "optional-text",
    name: "Optional text",
    type: "Text",
    required: false,
    closed: false,
    config: { kind: "text", defaultValue: "" },
  });
  optionalSource.automations[0].actions[1] = {
    id: "optional-source",
    kind: "set-field",
    target: { moduleId: "requests", fieldId: "title" },
    value: {
      kind: "field-reference",
      moduleId: "requests",
      fieldId: "optional-text",
    },
  };
  expect(parseSandboxDocument(JSON.stringify(optionalSource)).ok).toBe(false);

  const numericSource = v2Fixture();
  numericSource.design.modules[0].fields.push(
    {
      id: "source-number",
      name: "Source number",
      type: "Integer",
      required: false,
      closed: false,
      config: { kind: "integer", defaultValue: null, min: 0, max: 10 },
    },
    {
      id: "target-number",
      name: "Target number",
      type: "Number",
      required: false,
      closed: false,
      config: { kind: "number", defaultValue: null, min: 2, max: 8, step: 2 },
    },
  );
  numericSource.automations[0].actions[1] = {
    id: "numeric-source",
    kind: "set-field",
    target: { moduleId: "requests", fieldId: "target-number" },
    value: {
      kind: "field-reference",
      moduleId: "requests",
      fieldId: "source-number",
    },
  };
  expect(parseSandboxDocument(JSON.stringify(numericSource)).ok).toBe(false);

  const dateSource = v2Fixture();
  dateSource.design.modules[0].fields.push(
    {
      id: "source-date",
      name: "Source date",
      type: "Date",
      required: false,
      closed: false,
      config: {
        kind: "date",
        defaultValue: null,
        earliest: "2025-01-01",
        latest: "2027-12-31",
      },
    },
    {
      id: "target-date",
      name: "Target date",
      type: "Date",
      required: false,
      closed: false,
      config: {
        kind: "date",
        defaultValue: null,
        earliest: "2026-01-01",
        latest: "2026-12-31",
      },
    },
  );
  dateSource.automations[0].actions[1] = {
    id: "date-source",
    kind: "set-field",
    target: { moduleId: "requests", fieldId: "target-date" },
    value: {
      kind: "field-reference",
      moduleId: "requests",
      fieldId: "source-date",
    },
  };
  expect(parseSandboxDocument(JSON.stringify(dateSource)).ok).toBe(false);
});

test("v2 validates field defaults and constrained scenario values", () => {
  const variants = [
    (document: SandboxDocumentV2) => {
      document.scenarios[0].records[0].values.title = null;
    },
    (document: SandboxDocumentV2) => {
      document.design.modules[0].fields[0].config = {
        kind: "text",
        defaultValue: "",
        maxLength: 3,
      };
      document.scenarios[0].records[0].values.title = "four";
    },
    (document: SandboxDocumentV2) => {
      document.design.modules[0].fields[0] = {
        ...document.design.modules[0].fields[0],
        type: "Email",
        config: { kind: "email", defaultValue: "" },
      };
      document.scenarios[0].records[0].values.title = "not-an-email";
    },
    (document: SandboxDocumentV2) => {
      document.design.modules[0].fields[0] = {
        ...document.design.modules[0].fields[0],
        type: "Email",
        config: { kind: "email", defaultValue: "not-an-email" },
      };
    },
    (document: SandboxDocumentV2) => {
      document.design.modules[0].fields[0] = {
        ...document.design.modules[0].fields[0],
        type: "Text",
        config: { kind: "text", defaultValue: "x".repeat(1_001) },
      };
    },
    (document: SandboxDocumentV2) => {
      document.design.modules[0].fields[0] = {
        ...document.design.modules[0].fields[0],
        type: "Email",
        config: { kind: "email", defaultValue: "x".repeat(1_001) },
      };
    },
    (document: SandboxDocumentV2) => {
      document.design.modules[0].fields[0] = {
        ...document.design.modules[0].fields[0],
        type: "URL",
        config: { kind: "url", defaultValue: "x".repeat(1_001) },
      };
    },
    (document: SandboxDocumentV2) => {
      document.design.modules[0].fields[0] = {
        ...document.design.modules[0].fields[0],
        type: "Number",
        config: {
          kind: "number",
          defaultValue: null,
          min: 0,
          max: 10,
          step: 2,
        },
      };
      document.scenarios[0].records[0].values.title = 3;
    },
    (document: SandboxDocumentV2) => {
      document.scenarios[0].records[0].values.status = "Missing";
    },
    (document: SandboxDocumentV2) => {
      document.design.modules[0].fields[0] = {
        ...document.design.modules[0].fields[0],
        type: "Date",
        config: {
          kind: "date",
          defaultValue: null,
          earliest: "2026-01-01",
          latest: "2026-12-31",
        },
      };
      document.scenarios[0].records[0].values.title = "2025-12-31";
    },
    (document: SandboxDocumentV2) => {
      document.design.modules[0].fields[0] = {
        ...document.design.modules[0].fields[0],
        type: "Date",
        config: {
          kind: "date",
          defaultValue: null,
          earliest: "2026-13-01",
        },
      };
    },
    (document: SandboxDocumentV2) => {
      document.design.modules[0].fields[0] = {
        ...document.design.modules[0].fields[0],
        type: "Date",
        config: {
          kind: "date",
          defaultValue: null,
          latest: "2026-02-30",
        },
      };
    },
    (document: SandboxDocumentV2) => {
      document.design.modules[0].fields[0] = {
        ...document.design.modules[0].fields[0],
        type: "Date/Time",
        config: {
          kind: "datetime",
          defaultValue: null,
          earliest: "2026-01-01T9:00",
        },
      };
    },
    (document: SandboxDocumentV2) => {
      document.design.modules[0].fields[0] = {
        ...document.design.modules[0].fields[0],
        type: "Date/Time",
        config: {
          kind: "datetime",
          defaultValue: null,
          latest: "2026-01-01T09:60",
        },
      };
    },
    (document: SandboxDocumentV2) => {
      document.design.modules[0].fields[0] = {
        ...document.design.modules[0].fields[0],
        type: "URL",
        config: { kind: "url", defaultValue: "" },
      };
      document.scenarios[0].records[0].values.title = "ftp://example.test";
    },
  ];

  for (const mutate of variants) {
    const document = v2Fixture();
    mutate(document);
    expect(parseSandboxDocument(JSON.stringify(document)).ok).toBe(false);
  }

  const duplicate = v2Fixture();
  duplicate.design.modules.push({
    id: "duplicate-target",
    departmentId: "ops",
    name: "Duplicate target",
    closed: false,
    fields: [
      {
        id: "duplicate-title",
        name: "Title",
        type: "Text",
        required: false,
        closed: false,
        config: { kind: "text", defaultValue: "" },
      },
    ],
  });
  duplicate.design.layout["duplicate-target"] = {
    x: 400,
    y: 48,
    width: 280,
    height: 160,
  };
  duplicate.design.relationships = [
    {
      id: "duplicate-link",
      name: "Duplicate link",
      sourceModuleId: "requests",
      targetModuleId: "duplicate-target",
      cardinality: "many-to-many",
      fieldMappings: [],
    },
  ];
  duplicate.scenarios[0].records.push({
    id: "duplicate-target-1",
    moduleId: "duplicate-target",
    values: { "duplicate-title": "Target" },
  });
  const link = {
    relationshipId: "duplicate-link",
    sourceRecordId: "request-1",
    targetRecordId: "duplicate-target-1",
  };
  duplicate.scenarios[0].links = [link, { ...link }];
  expect(parseSandboxDocument(JSON.stringify(duplicate)).ok).toBe(false);
});

test("v2 enforces scenario relationship cardinality", () => {
  const invalidScenarios = ["one-to-one", "one-to-many"] as const;
  for (const cardinality of invalidScenarios) {
    const document = v2Fixture();
    document.design.modules.push({
      id: "target",
      departmentId: "ops",
      name: "Target",
      closed: false,
      fields: [
        {
          id: "target-title",
          name: "Title",
          type: "Text",
          required: false,
          closed: false,
          config: { kind: "text", defaultValue: "" },
        },
      ],
    });
    document.design.layout.target = { x: 400, y: 48, width: 280, height: 160 };
    document.design.relationships = [
      {
        id: "request-target",
        name: "Request target",
        sourceModuleId: "requests",
        targetModuleId: "target",
        cardinality,
        fieldMappings: [],
      },
    ];
    document.scenarios[0].records.push(
      {
        id: "request-2",
        moduleId: "requests",
        values: { title: "Second", status: "Open" },
      },
      {
        id: "target-1",
        moduleId: "target",
        values: { "target-title": "Target" },
      },
      {
        id: "target-2",
        moduleId: "target",
        values: { "target-title": "Target two" },
      },
    );
    document.scenarios[0].links =
      cardinality === "one-to-one"
        ? [
            {
              relationshipId: "request-target",
              sourceRecordId: "request-1",
              targetRecordId: "target-1",
            },
            {
              relationshipId: "request-target",
              sourceRecordId: "request-1",
              targetRecordId: "target-2",
            },
          ]
        : [
            {
              relationshipId: "request-target",
              sourceRecordId: "request-1",
              targetRecordId: "target-1",
            },
            {
              relationshipId: "request-target",
              sourceRecordId: "request-2",
              targetRecordId: "target-1",
            },
          ];
    expect(parseSandboxDocument(JSON.stringify(document)).ok).toBe(false);
  }
});

test("v2 validates nested version documents and grants v1 its portable byte limit", () => {
  const invalidVersion = v2Fixture();
  invalidVersion.versions = [
    {
      id: "bad-version",
      label: "Bad version",
      kind: "checkpoint",
      published: false,
      date: "2026-09-20T00:00:00.000Z",
      document: {
        design: invalidVersion.design,
        automations: [
          {
            ...invalidVersion.automations[0],
            trigger: { kind: "record-created", moduleId: "missing" },
          },
        ],
        scenarios: invalidVersion.scenarios,
      },
    },
  ];
  expect(parseSandboxDocument(JSON.stringify(invalidVersion)).ok).toBe(false);

  const legacy = v1Fixture();
  legacy.design.modules[0].fields.push(
    ...Array.from({ length: 2_100 }, (_, index) => ({
      id: `multibyte-${index}`,
      name: `Multibyte ${index}`,
      type: "Text",
      required: false,
      value: "",
      options: "",
      closed: false,
      description: "😀".repeat(250),
    })),
  );
  const text = JSON.stringify(legacy);
  expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(
    2 * 1024 * 1024,
  );
  expect(parseSandboxFile(text).ok).toBe(false);
  expect(parseSandboxDocument(text).ok).toBe(true);
});

test("v2 portable history accepts the published kind emitted by the backend", () => {
  const document = v2Fixture();
  document.versions = [
    {
      id: "published-version",
      label: "Published structure",
      kind: "published",
      published: true,
      date: "2026-09-20T00:00:00.000Z",
      document: {
        design: document.design,
        automations: document.automations,
        scenarios: document.scenarios,
      },
    },
  ];

  expect(parseSandboxDocument(exportSandboxDocument(document))).toEqual({
    ok: true,
    document,
  });
});

test("v1 designs migrate to v2 fields, graph layout, and typed automations", () => {
  const legacy = v1Fixture();
  legacy.design.relationships[0].fieldMappings = [
    {
      sourceFieldId: "sample-field-Title",
      targetFieldId: "sample-field-Name",
    },
  ];
  legacy.versions = [
    {
      id: "legacy-checkpoint",
      label: "Mapped legacy checkpoint",
      design: structuredClone(legacy.design),
      published: false,
      date: "2026-09-20T00:00:00.000Z",
    },
  ];
  const migrated = migrateSandboxFileV1(legacy);
  const parsedLegacy = parseSandboxDocument(JSON.stringify(legacy));

  expect(migrated.schemaVersion).toBe(2);
  expect(parsedLegacy).toEqual({ ok: true, document: migrated });
  expect(migrated.design.modules[0]).toEqual(
    expect.objectContaining({
      id: "sample-requests",
      departmentId: "sample-operations",
      fields: expect.arrayContaining([
        expect.objectContaining({
          id: "sample-field-Request number",
          config: { kind: "text", defaultValue: "" },
        }),
      ]),
    }),
  );
  expect(migrated.design.modules[0]).not.toHaveProperty("x");
  expect(migrated.design.modules[0].fields[0]).not.toHaveProperty("value");
  expect(migrated.design.layout["sample-requests"]).toBeDefined();
  expect(migrated.design.relationships[0].fieldMappings).toEqual(
    legacy.design.relationships[0].fieldMappings,
  );
  expect(
    migrated.versions?.[0].document.design.relationships[0].fieldMappings,
  ).toEqual(legacy.design.relationships[0].fieldMappings);
  expect(migrated.automations[0]).toEqual(
    expect.objectContaining({
      trigger: { kind: "record-created", moduleId: "sample-requests" },
      conditionGroup: expect.objectContaining({ operator: "all" }),
    }),
  );
  expect(migrated.scenarios).toEqual([]);
});

test("v2 parser fails closed for future versions, broken references, incompatible mappings, and runtime state", () => {
  const document = v2Fixture();
  const relationshipDocument = structuredClone(document);
  relationshipDocument.design.relationships = [
    {
      id: "bad-mapping",
      name: "Bad mapping",
      sourceModuleId: "requests",
      targetModuleId: "requests",
      cardinality: "one-to-many",
      fieldMappings: [{ sourceFieldId: "title", targetFieldId: "status" }],
    },
  ];
  relationshipDocument.scenarios[0].links = [
    {
      relationshipId: "missing",
      sourceRecordId: "request-1",
      targetRecordId: "request-1",
    },
  ];

  for (const value of [
    { ...document, schemaVersion: 3 },
    {
      ...document,
      automations: [
        {
          ...document.automations[0],
          trigger: { kind: "record-created", moduleId: "missing" },
        },
      ],
    },
    relationshipDocument,
    { ...document, runs: [] },
  ]) {
    const result = parseSandboxDocument(JSON.stringify(value));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Invalid documents must be rejected");
  }
});
