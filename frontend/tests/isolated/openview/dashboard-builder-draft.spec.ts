import { expect, test } from "@playwright/test";

import {
  fillDraft,
  newKindDraft,
} from "../../../src/components/systems/openview/domain/dashboard-builder-draft";
import { newChartEditorDraft } from "../../../src/components/systems/openview/domain/chart-query";
import type { OpenViewDataSourceField } from "../../../src/components/systems/openview/adapters/views-api";

// docs/specs/openview-dashboard.md, BD10: a new chart groups by a choice,
// never by free text, which would give one bar per record.

const field = (
  id: string,
  name: string,
  type: OpenViewDataSourceField["type"],
): OpenViewDataSourceField =>
  ({
    id,
    moduleId: "contacts",
    name,
    type,
    required: false,
    position: 0,
    config: {},
  }) as OpenViewDataSourceField;

const name = field("name", "Name", "text");
const email = field("email", "Email", "email");
const owner = field("owner", "Owner", "user");
const status = field("status", "Status", "select");
const active = field("active", "Active", "boolean");

test("a new chart groups by a choice first, then a person, then yes or no", () => {
  const groupBy = (fields: OpenViewDataSourceField[]) => {
    const draft = fillDraft(newKindDraft("contacts", "bar", []), fields);
    return draft.mode === "groups" ? draft.dimension?.fieldId : undefined;
  };
  expect(groupBy([name, active, owner, status])).toBe("status");
  expect(groupBy([name, active, owner])).toBe("owner");
  expect(groupBy([email, name, active])).toBe("active");
});

test("with only free-text fields a new chart waits for its Group by", () => {
  const filled = fillDraft(newKindDraft("contacts", "bar", []), [name, email]);
  expect(
    filled.mode === "groups" ? filled.dimension : "not grouped",
  ).toBeNull();
  const fresh = newChartEditorDraft("contacts", [name, email]);
  expect(fresh.mode === "groups" ? fresh.dimension : "not grouped").toBeNull();
  expect(
    newChartEditorDraft("contacts", [name, owner]).mode === "groups"
      ? (
          newChartEditorDraft("contacts", [name, owner]) as {
            dimension: { fieldId: string } | null;
          }
        ).dimension?.fieldId
      : undefined,
  ).toBe("owner");
});

test("a Number, which hides its groups, still takes a free-text field to count by", () => {
  const filled = fillDraft(newKindDraft("contacts", "number", []), [name]);
  expect(filled.mode === "groups" ? filled.dimension?.fieldId : null).toBe(
    "name",
  );
});
