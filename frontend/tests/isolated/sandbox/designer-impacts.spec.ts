import { expect, test } from "@playwright/test";
import {
  fieldDeletionNeedsReview,
  mappingFieldReference,
  pruneRelationshipMappingsForFields,
  relationshipMappingCountForFields,
} from "../../../src/components/systems/sandbox/helpers/designer-impacts";
import { configuredSandboxDesign } from "../../helpers/sandbox-fixtures";
import type { Relationship } from "../../../src/components/systems/sandbox/domain/model";

// Closing or deleting a field removes every relationship field mapping that
// names it at either end, and the status message counts them.

const uses: Relationship = {
  id: "uses",
  name: "Uses equipment",
  source: "requests",
  target: "equipment",
  cardinality: "One-to-many",
  fieldMappings: [
    { sourceFieldId: "request-number", targetFieldId: "asset-tag" },
    { sourceFieldId: "request-title", targetFieldId: "asset-name" },
  ],
};
const lists: Relationship = {
  id: "lists",
  name: "Lists customers",
  source: "equipment",
  target: "customers",
  cardinality: "One-to-many",
  fieldMappings: [{ sourceFieldId: "asset-tag", targetFieldId: "customer-id" }],
};

for (const row of [
  {
    name: "a source field removes its mapping",
    field: ["requests", "request-number"],
    count: 1,
    remaining: [
      [{ sourceFieldId: "request-title", targetFieldId: "asset-name" }],
      [{ sourceFieldId: "asset-tag", targetFieldId: "customer-id" }],
    ],
  },
  {
    name: "a field that is a target in one relationship and a source in another removes both",
    field: ["equipment", "asset-tag"],
    count: 2,
    remaining: [
      [{ sourceFieldId: "request-title", targetFieldId: "asset-name" }],
      [],
    ],
  },
  {
    name: "a field with the same ID in another module removes nothing",
    field: ["customers", "request-number"],
    count: 0,
    remaining: [uses.fieldMappings, lists.fieldMappings],
  },
] as const) {
  test(`relationship mappings: ${row.name}`, () => {
    const fields = new Set([mappingFieldReference(row.field[0], row.field[1])]);
    expect(relationshipMappingCountForFields([uses, lists], fields)).toBe(
      row.count,
    );
    expect(pruneRelationshipMappingsForFields([uses, lists], fields)).toEqual([
      { ...uses, fieldMappings: row.remaining[0] },
      { ...lists, fieldMappings: row.remaining[1] },
    ]);
  });
}

// S26: a field deletes at once with Undo unless a trigger step or a linked
// field uses it; then the review shows what the delete affects.
for (const row of [
  {
    name: "a field nothing uses deletes at once",
    field: "sandbox-field:sample-customers:sample-field-Email",
    review: false,
  },
  {
    name: "a field a trigger condition uses needs review",
    field: "sandbox-field:sample-requests:sample-field-Priority",
    review: true,
  },
  {
    name: "a field a relationship links needs review",
    field: "sandbox-field:sample-requests:sample-field-Title",
    review: true,
  },
]) {
  test(`field delete review: ${row.name}`, () => {
    const design = structuredClone(configuredSandboxDesign);
    design.relationships[0]!.fieldMappings = [
      {
        sourceFieldId: "sample-field-Title",
        targetFieldId: "sample-field-Name",
      },
    ];
    expect(fieldDeletionNeedsReview(design, row.field)).toBe(row.review);
  });
}
