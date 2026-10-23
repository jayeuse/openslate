import { expect, test } from "@playwright/test";

import {
  discardDraftsIn,
  type RegisteredDraft,
} from "../../../src/components/systems/access/state/draft-registry";

function draft(
  flags: Partial<Omit<RegisteredDraft, "discard">>,
  discarded: string[],
  id: string,
  result: boolean = true,
): readonly [string, RegisteredDraft] {
  return [
    id,
    {
      dirty: false,
      pending: false,
      ...flags,
      discard: () => {
        discarded.push(id);
        return result;
      },
    },
  ];
}

const personSheet = (id: string) =>
  id === "person-editor" || id.startsWith("person-security-");

test("a sheet discards only its own drafts and keeps a hidden policy draft", () => {
  const discarded: string[] = [];
  expect(
    discardDraftsIn(
      [
        draft({ dirty: true }, discarded, "security-policy"),
        draft({ dirty: true }, discarded, "person-editor"),
        draft({}, discarded, "person-security-ben"),
      ],
      personSheet,
    ),
  ).toBe(true);
  expect(discarded).toEqual(["person-editor"]);
});

test("a save in flight in scope holds every discard, and a refused discard is reported", () => {
  const discarded: string[] = [];
  expect(
    discardDraftsIn(
      [
        draft({ dirty: true }, discarded, "person-editor"),
        draft({ pending: true }, discarded, "person-security-ben"),
      ],
      personSheet,
    ),
  ).toBe(false);
  expect(discarded).toEqual([]);

  expect(
    discardDraftsIn(
      [
        draft({ pending: true }, discarded, "security-policy"),
        draft({ dirty: true }, discarded, "person-editor", false),
      ],
      personSheet,
    ),
  ).toBe(false);
  expect(discarded).toEqual(["person-editor"]);
});
