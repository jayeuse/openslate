import { expect, test } from "@playwright/test";

import {
  groupPublicationChanges,
  publicationChangeSummary,
  publicationFieldKey,
} from "../../../src/components/systems/sandbox/components/publish-change-groups";

const changes = (
  count: number,
  kind: "department" | "module" | "field" | "trigger",
  action: "create" | "update" | "close" | "reopen",
) =>
  Array.from(
    { length: count },
    (_, index) =>
      ({ kind, action, sandboxId: `${kind}-${index}`, label: kind }) as const,
  );

// The review says what changes in plain words (F11): a count per kind, and
// the shared action only when it says more than "changes".
test("a review summary counts the changes of each kind", () => {
  expect(publicationChangeSummary(changes(7, "trigger", "update"))).toBe(
    "7 trigger changes",
  );
  expect(
    publicationChangeSummary([
      ...changes(3, "module", "update"),
      ...changes(7, "trigger", "update"),
    ]),
  ).toBe("3 module changes · 7 trigger changes");
  expect(
    publicationChangeSummary([
      ...changes(1, "department", "create"),
      ...changes(1, "module", "update"),
    ]),
  ).toBe("1 department change · 1 module change");
  // Every change shares one action, so the rows drop their chips and the
  // summary says it once.
  expect(
    publicationChangeSummary([
      ...changes(1, "department", "create"),
      ...changes(2, "module", "create"),
    ]),
  ).toBe("1 new department · 2 new modules");
  expect(publicationChangeSummary(changes(2, "field", "close"))).toBe(
    "2 closed fields",
  );
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
