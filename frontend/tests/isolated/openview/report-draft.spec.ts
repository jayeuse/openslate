import { expect, test } from "@playwright/test";
import {
  emptyReportDraft,
  reportDraftFrom,
  reportDraftSignature,
  reportRecipeFromDraft,
} from "../../../src/components/systems/openview/components/report-draft";
import type { OpenViewReport } from "../../../src/components/systems/openview/adapters/reports-api";

const moduleId = "00000000-0000-4000-8000-000000000001";
const textFieldId = "00000000-0000-4000-8000-000000000002";
const selectFieldId = "00000000-0000-4000-8000-000000000003";
const amountFieldId = "00000000-0000-4000-8000-000000000004";
const audienceRoleId = "00000000-0000-4000-8000-000000000007";
const audienceUserId = "00000000-0000-4000-8000-000000000008";

function report(): OpenViewReport {
  return {
    id: "00000000-0000-4000-8000-000000000005",
    ownerId: "00000000-0000-4000-8000-000000000006",
    moduleId,
    name: "Active work",
    subtitle: "Latest records",
    revision: 3,
    recipe: {
      version: 1,
      fields: [{ fieldId: textFieldId, expectedType: "text" }],
      filters: [
        {
          fieldId: selectFieldId,
          expectedType: "select",
          operator: "in",
          value: ["active", "pending"],
        },
        {
          fieldId: amountFieldId,
          expectedType: "number",
          operator: "gte",
          value: 10,
        },
      ],
      logic: "and",
      sorts: [
        { fieldId: amountFieldId, expectedType: "number", direction: "desc" },
      ],
      groupBy: { fieldId: selectFieldId, expectedType: "select" },
      includeRowCount: true,
    },
    audience: { kind: "private", roleId: null, userId: null },
    isDeleted: false,
    createdAt: "2026-09-23T00:00:00Z",
    updatedAt: "2026-09-23T00:00:00Z",
  };
}

test("existing Report recipe remains semantically unchanged after opening its draft", () => {
  const saved = report();
  const draft = reportDraftFrom(saved);
  expect(draft.filters.map((filter) => filter.value)).toEqual([
    "active, pending",
    "10",
  ]);
  expect(reportRecipeFromDraft(draft)).toEqual(saved.recipe);
  expect(reportDraftSignature(draft)).toBe(
    reportDraftSignature(reportDraftFrom(saved)),
  );
});

test("draft validation rejects an empty recipe and unsafe numeric input before a write", () => {
  const empty = emptyReportDraft(moduleId);
  empty.name = "Active work";
  expect(() => reportRecipeFromDraft(empty)).toThrow(
    "Choose at least one Report field",
  );

  const draft = reportDraftFrom(report());
  draft.filters[1]!.value = "not-a-number";
  expect(() => reportRecipeFromDraft(draft)).toThrow(
    "Enter a valid number for each numeric filter",
  );
});

test("editing Report metadata does not rewrite untouched membership values containing commas", () => {
  const saved = report();
  saved.recipe.filters[0]!.value = ["East, Manila", "West"];
  const draft = reportDraftFrom(saved);
  draft.name = "Renamed";
  expect(reportRecipeFromDraft(draft).filters[0]?.value).toEqual([
    "East, Manila",
    "West",
  ]);
});

test("membership filter edits accept quoted choices containing commas", () => {
  const draft = reportDraftFrom(report());
  draft.filters[0]!.value = '"East, Manila", West';
  expect(reportRecipeFromDraft(draft).filters[0]?.value).toEqual([
    "East, Manila",
    "West",
  ]);
});

test("Report drafts default to private and preserve the saved audience in dirty tracking", () => {
  expect(emptyReportDraft(moduleId).audience).toEqual({ kind: "private" });

  const roleReport = report();
  roleReport.audience = {
    kind: "role",
    roleId: audienceRoleId,
    userId: null,
  };
  const draft = reportDraftFrom(roleReport);
  expect(draft.audience).toEqual({ kind: "role", roleId: audienceRoleId });
  const baseline = reportDraftSignature(draft);
  draft.audience = { kind: "user", userId: audienceUserId };
  expect(reportDraftSignature(draft)).not.toBe(baseline);
  expect(reportRecipeFromDraft(draft)).toEqual(roleReport.recipe);

  const userReport = report();
  userReport.audience = {
    kind: "user",
    roleId: null,
    userId: audienceUserId,
  };
  expect(reportDraftFrom(userReport).audience).toEqual({
    kind: "user",
    userId: audienceUserId,
  });
});
