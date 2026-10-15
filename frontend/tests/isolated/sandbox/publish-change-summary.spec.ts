import { expect, test } from "@playwright/test";

import {
  groupPublicationChanges,
  publicationChangeSummary,
  publicationFieldKey,
} from "../../../src/components/systems/sandbox/components/publish-change-groups";

const change = (kind: "department" | "module", action: "create" | "update") =>
  ({ kind, action, sandboxId: `${kind}-${action}`, label: kind }) as const;

test("a review summary names each kind and, when shared, the one action", () => {
  expect(
    publicationChangeSummary([
      change("department", "create"),
      change("module", "create"),
      { ...change("module", "create"), sandboxId: "second" },
    ]),
  ).toBe("3 changes, all new: 1 department, 2 modules");
  expect(
    publicationChangeSummary([
      change("department", "create"),
      change("module", "update"),
    ]),
  ).toBe("2 changes: 1 department, 1 module");
});

test("the review nests field changes under their module and puts unplaced changes under Other", () => {
  const department = {
    kind: "department",
    action: "create",
    sandboxId: "team-1",
    label: "Team 1",
  } as const;
  const title = {
    kind: "field",
    action: "create",
    sandboxId: publicationFieldKey("requests", "title"),
    label: "Title",
  } as const;
  const requests = {
    kind: "module",
    action: "create",
    sandboxId: "requests",
    label: "Service requests",
  } as const;
  const assetTag = {
    kind: "field",
    action: "update",
    sandboxId: publicationFieldKey("equipment", "asset-tag"),
    label: "Asset tag",
  } as const;
  const removedFromDraft = {
    kind: "field",
    action: "update",
    sandboxId: publicationFieldKey("requests", "removed"),
    label: "Removed field",
  } as const;
  const retired = {
    kind: "field",
    action: "close",
    sandboxId: "retired-field",
    label: "Old notes",
  } as const;
  const relationship = {
    kind: "relationship",
    action: "create",
    sandboxId: "uses",
    label: "Uses equipment",
  } as const;
  const trigger = {
    kind: "trigger",
    action: "update",
    sandboxId: "urgent",
    label: "Urgent alert",
  } as const;
  expect(
    groupPublicationChanges(
      [
        department,
        title,
        requests,
        assetTag,
        removedFromDraft,
        retired,
        relationship,
        trigger,
      ],
      {
        modules: [
          {
            id: "requests",
            name: "Service requests",
            fields: [{ id: "title" }],
          },
          { id: "equipment", name: "Equipment", fields: [{ id: "asset-tag" }] },
        ],
      },
    ),
  ).toEqual({
    departments: [department],
    modules: [
      {
        id: "requests",
        name: "Service requests",
        change: requests,
        fields: [title],
      },
      { id: "equipment", name: "Equipment", fields: [assetTag] },
    ],
    relationships: [relationship],
    triggers: [trigger],
    other: [removedFromDraft, retired],
  });
});
