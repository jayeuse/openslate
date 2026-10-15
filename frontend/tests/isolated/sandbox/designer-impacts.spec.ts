import { expect, test } from "@playwright/test";
import {
  mappingFieldReference,
  pruneRelationshipMappingsForFields,
  relationshipMappingCountForFields,
} from "../../../src/components/systems/sandbox/helpers/designer-impacts";
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
