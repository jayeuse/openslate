import { expect, test } from "@playwright/test";
import type { OpenViewDataSourceField } from "../../../src/components/systems/openview/adapters/views-api";
import {
  emptyDefinition,
  emptyPresentation,
  type SavedDraft,
} from "../../../src/components/systems/openview/domain/server-view-draft";
import {
  decodeTemporaryView,
  encodeTemporaryView,
} from "../../../src/components/systems/openview/domain/temporary-view";

const moduleId = "00000000-0000-4000-8000-0000000000b1";
const nameField = "00000000-0000-4000-8000-0000000000c1";
const stockField = "00000000-0000-4000-8000-0000000000c2";
const otherModuleField = "00000000-0000-4000-8000-0000000000c9";

function field(
  id: string,
  name: string,
  type: OpenViewDataSourceField["type"],
  position: number,
): OpenViewDataSourceField {
  return { id, moduleId, name, type, required: false, position, config: {} };
}

const fields = [
  field(nameField, "Name", "text", 0),
  field(stockField, "Stock", "int", 1),
];
const base: SavedDraft = {
  name: "All products",
  definition: emptyDefinition(fields),
  presentation: emptyPresentation(fields),
};

test("a temporary filter, sort and layout survive the address and restore the same draft", () => {
  const draft: SavedDraft = {
    ...base,
    name: "Typed but unsaved name",
    definition: {
      ...base.definition,
      filters: [
        { fieldId: stockField, expectedType: "int", operator: "lt", value: 5 },
      ],
      sort: [{ fieldId: nameField, expectedType: "text", direction: "desc" }],
      search: "laptop",
    },
    presentation: { ...base.presentation, layout: "grid", density: "compact" },
  };

  const encoded = encodeTemporaryView(base, draft);
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  // Only the changed settings travel; the View name never does.
  const text = Buffer.from(encoded ?? "", "base64url").toString("utf8");
  expect(JSON.parse(text)).toEqual({
    d: {
      filters: draft.definition.filters,
      sort: draft.definition.sort,
      search: "laptop",
    },
    p: { layout: "grid", density: "compact" },
  });

  expect(decodeTemporaryView(encoded ?? "", base, fields)).toEqual({
    ...draft,
    name: base.name,
  });
});

test("a draft equal to its View, or with only unfinished filters, keeps no address value", () => {
  expect(encodeTemporaryView(base, { ...base, name: "Renamed" })).toBeNull();
  const unfinished: SavedDraft = {
    ...base,
    definition: {
      ...base.definition,
      filters: [
        { fieldId: stockField, expectedType: "int", operator: "lt", value: "" },
      ],
    },
  };
  expect(encodeTemporaryView(base, unfinished)).toBeNull();
});

test("a shared address that is malformed or names unknown fields is refused", () => {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

  expect(decodeTemporaryView("not base64!", base, fields)).toBeNull();
  expect(decodeTemporaryView(encode("text"), base, fields)).toBeNull();
  expect(decodeTemporaryView(encode({ x: {} }), base, fields)).toBeNull();
  // A value outside the saved-View schema.
  expect(
    decodeTemporaryView(encode({ p: { layout: "spreadsheet" } }), base, fields),
  ).toBeNull();
  // A field from another module, and a field with the wrong type.
  expect(
    decodeTemporaryView(
      encode({
        d: {
          sort: [
            {
              fieldId: otherModuleField,
              expectedType: "text",
              direction: "asc",
            },
          ],
        },
      }),
      base,
      fields,
    ),
  ).toBeNull();
  expect(
    decodeTemporaryView(
      encode({
        d: {
          filters: [
            {
              fieldId: stockField,
              expectedType: "text",
              operator: "eq",
              value: "x",
            },
          ],
        },
      }),
      base,
      fields,
    ),
  ).toBeNull();
  expect(
    decodeTemporaryView(
      encode({ p: { groupByFieldId: otherModuleField } }),
      base,
      fields,
    ),
  ).toBeNull();
  expect(decodeTemporaryView("a".repeat(7000), base, fields)).toBeNull();
});
