import { expect, test } from "@playwright/test";
import {
  mergeProjectedDesign,
  projectSandboxDocument,
} from "../../../src/components/systems/sandbox/domain/document-bridge";
import type { SandboxDocumentV2 } from "../../../src/components/systems/sandbox/domain/document";

function fixture(): SandboxDocumentV2 {
  return {
    kind: "openslate-sandbox",
    schemaVersion: 2,
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
        {
          id: "equipment",
          departmentId: "operations",
          name: "Equipment",
          closed: false,
          fields: [
            {
              id: "asset-tag",
              name: "Asset tag",
              type: "Text",
              required: false,
              closed: false,
              config: { kind: "text", defaultValue: "" },
            },
          ],
        },
      ],
      relationships: [
        {
          id: "uses-equipment",
          name: "Uses equipment",
          sourceModuleId: "requests",
          targetModuleId: "equipment",
          cardinality: "one-to-many",
          fieldMappings: [
            { sourceFieldId: "title", targetFieldId: "asset-tag" },
          ],
        },
      ],
      layout: {
        operations: { x: 20, y: 10, width: 700, height: 320 },
        requests: { x: 48, y: 56, width: 280, height: 160 },
        equipment: { x: 376, y: 56, width: 280, height: 132 },
      },
    },
    automations: [
      {
        id: "rich-automation",
        name: "Escalate an open request",
        enabled: true,
        priority: 4,
        trigger: { kind: "record-created", moduleId: "requests" },
        conditionGroup: {
          operator: "all",
          conditions: [
            {
              id: "status-is-open",
              field: { moduleId: "requests", fieldId: "status" },
              operator: "=",
              value: { kind: "literal", value: "Open" },
            },
            {
              id: "title-is-present",
              field: { moduleId: "requests", fieldId: "title" },
              operator: "!=",
              value: { kind: "literal", value: "" },
            },
          ],
        },
        actions: [
          { id: "notify", kind: "notification", message: "Escalate" },
          {
            id: "copy-title",
            kind: "set-field",
            target: { moduleId: "requests", fieldId: "title" },
            value: {
              kind: "field-reference",
              moduleId: "requests",
              fieldId: "title",
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
    versions: [
      {
        id: "checkpoint-1",
        label: "Initial checkpoint",
        kind: "checkpoint",
        published: false,
        date: "2026-09-20T00:00:00.000Z",
        document: {
          design: {
            departments: [],
            modules: [],
            relationships: [],
            layout: {},
          },
          automations: [],
          scenarios: [],
        },
      },
    ],
  };
}

function documentWithSecondAutomation(): SandboxDocumentV2 {
  const document = fixture();
  document.automations = [
    {
      id: "reference-automation",
      name: "Copy equipment tag",
      enabled: true,
      priority: 0,
      trigger: { kind: "record-created", moduleId: "requests" },
      conditionGroup: {
        operator: "any",
        conditions: [
          {
            id: "status-is-open",
            field: { moduleId: "requests", fieldId: "status" },
            operator: "=",
            value: { kind: "literal", value: "Open" },
          },
        ],
      },
      actions: [
        {
          id: "copy-related-tag",
          kind: "set-field",
          target: { moduleId: "requests", fieldId: "title" },
          value: {
            kind: "field-reference",
            moduleId: "equipment",
            fieldId: "asset-tag",
            relationshipId: "uses-equipment",
          },
        },
        { id: "notify", kind: "notification", message: "Copied tag" },
      ],
    },
    { ...document.automations[0], priority: 1 },
  ];
  return document;
}

test("v2 documents round-trip through the legacy Designer projection", () => {
  const document = fixture();
  const projected = projectSandboxDocument(document);

  expect(projected.modules[0].fields[1]).toMatchObject({
    type: "Select",
    value: "Open",
    options: "Open, Closed",
  });
  expect(projected.relationships[0].fieldMappings).toEqual([
    { sourceFieldId: "title", targetFieldId: "asset-tag" },
  ]);
  expect(projected.layout).toEqual(document.design.layout);
  expect(projected.rules[0].config?.condition).toEqual({
    kind: "field-comparison",
    moduleId: "requests",
    fieldId: "status",
    operator: "=",
    value: "Open",
  });

  expect(mergeProjectedDesign(document, projected, projected)).toEqual(
    document,
  );
});

test("a graph-only edit keeps rich automation steps and scenarios unchanged", () => {
  const document = fixture();
  const projected = projectSandboxDocument(document);
  const next = structuredClone(projected);
  next.modules[0].name = "Service requests";

  const merged = mergeProjectedDesign(document, projected, next);

  expect(merged.design.modules[0].name).toBe("Service requests");
  expect(merged.automations).toEqual(document.automations);
  expect(merged.scenarios).toEqual(document.scenarios);
  expect(merged.versions).toEqual(document.versions);
});

test("editing a projected action retains the full unchanged condition group", () => {
  const document = fixture();
  const projected = projectSandboxDocument(document);
  const next = structuredClone(projected);
  const rule = next.rules[0];
  if (!rule.config || rule.config.action.kind !== "notification")
    throw new Error("fixture must project a notification action");
  rule.config.action.message = "Escalate to Operations";

  const merged = mergeProjectedDesign(document, projected, next);

  expect(merged.automations).toEqual([
    expect.objectContaining({
      id: "rich-automation",
      actions: [
        {
          id: "rich-automation:action",
          kind: "notification",
          message: "Escalate to Operations",
        },
      ],
      conditionGroup: document.automations[0].conditionGroup,
    }),
  ]);
  expect(merged.scenarios).toEqual(document.scenarios);
});

test("rule metadata edits preserve direct relationship references and extra steps", () => {
  const document = documentWithSecondAutomation();
  const projected = projectSandboxDocument(document);
  const next = structuredClone(projected);
  if (
    !next.rules[0].config ||
    next.rules[0].config.action.kind !== "update-field"
  )
    throw new Error("fixture must project an update-field action");
  expect(next.rules[0].config.action.value).toBe(
    "Value from equipment.asset-tag via uses-equipment",
  );
  next.rules[0].name = "Copy the related equipment tag";

  const merged = mergeProjectedDesign(document, projected, next);
  const original = document.automations[0];
  const updated = merged.automations[0];

  expect(updated.name).toBe("Copy the related equipment tag");
  expect(updated.trigger).toEqual(original.trigger);
  expect(updated.conditionGroup).toEqual(original.conditionGroup);
  expect(updated.actions).toEqual(original.actions);
});

test("a condition edit retains the full action list including relationship references", () => {
  const document = documentWithSecondAutomation();
  const projected = projectSandboxDocument(document);
  const next = structuredClone(projected);
  const config = next.rules[0].config;
  if (!config || config.condition.kind !== "field-comparison")
    throw new Error("fixture must project a field comparison");
  config.condition.value = "Closed";

  const merged = mergeProjectedDesign(document, projected, next);
  const updated = merged.automations[0];

  expect(updated.actions).toEqual(document.automations[0].actions);
  expect(updated.conditionGroup).toEqual({
    operator: "all",
    conditions: [
      {
        id: "reference-automation:condition",
        field: { moduleId: "requests", fieldId: "status" },
        operator: "=",
        value: { kind: "literal", value: "Closed" },
      },
    ],
  });
});

test("added token-looking and empty literals remain literal values", () => {
  const document = fixture();
  const projected = projectSandboxDocument(document);
  const next = structuredClone(projected);
  next.rules.push(
    {
      id: "token-literal",
      name: "Keep token literal",
      trigger: "New record",
      condition: "Always",
      action: "Set title",
      enabled: true,
      config: {
        trigger: { kind: "new-record", moduleId: "requests" },
        condition: { kind: "always" },
        action: {
          kind: "update-field",
          moduleId: "requests",
          fieldId: "title",
          value: "{{requests.title}}",
        },
      },
    },
    {
      id: "empty-literal",
      name: "Clear optional status",
      trigger: "New record",
      condition: "Always",
      action: "Set status",
      enabled: true,
      config: {
        trigger: { kind: "new-record", moduleId: "requests" },
        condition: { kind: "always" },
        action: {
          kind: "update-field",
          moduleId: "requests",
          fieldId: "status",
          value: "",
        },
      },
    },
  );

  const merged = mergeProjectedDesign(document, projected, next);
  const byId = new Map(merged.automations.map((item) => [item.id, item]));
  const token = byId.get("token-literal");
  const empty = byId.get("empty-literal");
  if (!token || !empty) throw new Error("added rules must be present");
  if (token.actions[0].kind !== "set-field")
    throw new Error("token action must be a set-field action");
  if (empty.actions[0].kind !== "set-field")
    throw new Error("empty action must be a set-field action");

  expect(token.actions[0].value).toEqual({
    kind: "literal",
    value: "{{requests.title}}",
  });
  expect(empty.actions[0].value).toEqual({ kind: "literal", value: null });
});

test("legacy rule reordering updates priority without flattening automation steps", () => {
  const document = documentWithSecondAutomation();
  const projected = projectSandboxDocument(document);
  expect(projected.rules.map((rule) => rule.id)).toEqual([
    "reference-automation",
    "rich-automation",
  ]);
  const next = { ...projected, rules: [...projected.rules].reverse() };

  const merged = mergeProjectedDesign(document, projected, next);

  expect(merged.automations.map((automation) => automation.id)).toEqual([
    "rich-automation",
    "reference-automation",
  ]);
  expect(merged.automations.map((automation) => automation.priority)).toEqual([
    0, 1,
  ]);
  expect(merged.automations[0].actions).toEqual(
    document.automations[1].actions,
  );
  expect(merged.automations[1].actions).toEqual(
    document.automations[0].actions,
  );
});

test("removing a projected rule removes its canonical automation", () => {
  const document = fixture();
  const projected = projectSandboxDocument(document);
  const next = { ...projected, rules: [] };

  expect(mergeProjectedDesign(document, projected, next).automations).toEqual(
    [],
  );
});
