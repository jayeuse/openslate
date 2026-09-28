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

function report(): OpenViewReport {
  return {
    id: "00000000-0000-4000-8000-000000000005",
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

test("Report drafts carry no owner or audience, so dirty tracking follows the recipe only", () => {
  const empty = emptyReportDraft(moduleId);
  expect(empty).not.toHaveProperty("audience");

  const draft = reportDraftFrom(report());
  expect(draft).not.toHaveProperty("audience");
  const baseline = reportDraftSignature(draft);
  draft.subtitle = "Changed";
  expect(reportDraftSignature(draft)).not.toBe(baseline);
});
