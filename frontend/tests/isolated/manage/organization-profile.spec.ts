import { expect, test } from "@playwright/test";

import {
  profileHasValues,
  profileSummary,
} from "../../../src/components/systems/manage/state/organization-profile";
import { unsavedChangesLabel } from "../../../src/lib/unsaved-changes";

// The closed Profile block on Manage › Organization names what it holds and
// marks each field with a value "(set)" (the Advanced Last Rule, DESIGN.md),
// so nothing changes out of sight. The footer chip counts the edits.

test("the closed Profile block names its fields and marks set ones", () => {
  expect(
    profileSummary(
      {
        legalName: "Harbor Services Ltd",
        description: "  ",
        contactEmail: "contact@example.com",
        contactPhone: "",
        postalAddress: "",
      },
      true,
    ),
  ).toBe(
    "Legal name (set), Description, Contact email (set), Contact phone, Postal address",
  );
  // A profile read without contacts (a guest's) names only what it holds.
  expect(
    profileSummary({ legalName: "", description: "Field services" }, false),
  ).toBe("Legal name, Description (set)");
});

test("a profile has values only when a shown field holds text", () => {
  expect(
    profileHasValues(
      { legalName: " ", description: "", contactEmail: "a@example.com" },
      false,
    ),
  ).toBe(false);
  expect(
    profileHasValues(
      { legalName: " ", description: "", contactEmail: "a@example.com" },
      true,
    ),
  ).toBe(true);
});

test("the footer chip counts unsaved changes in words", () => {
  expect(unsavedChangesLabel(1)).toBe("1 unsaved change");
  expect(unsavedChangesLabel(3)).toBe("3 unsaved changes");
});
