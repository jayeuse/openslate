import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

function componentSource(): string {
  return readFileSync(
    resolve(
      process.cwd(),
      "src/components/systems/access/components/rules-view.tsx",
    ),
    "utf8",
  );
}

test("detailed rules show five permissions at a time with plain-language controls", () => {
  const source = componentSource();

  expect(source).toContain("const PAGE_SIZE = 5;");
  expect(source).toContain("Who gets this?");
  expect(source).toContain("Person or service");
  expect(source).toContain(
    "Choose everyone, a role, a group, a person, or a service.",
  );
  expect(source).toContain("Choose who");
  expect(source).toContain("Where does it apply?");
  expect(source).toContain("What can they do?");
  expect(source).toContain(
    '<ToggleGroupItem value="inherit">Use existing access</ToggleGroupItem>',
  );
  expect(source).toMatch(
    /Use existing access follows broader or default access\. A scope lock can\s+still block more specific rules\./,
  );
  expect(source).toContain("function PermissionDetails");
  expect(source).toContain("Technical details");
  expect(source).toContain("Review estimated policy impact");
  expect(source).toMatch(
    /Directory match counts are estimates\. The\s+server checks current policy again before applying/,
  );
  expect(source).toContain("Permission ID:");
  expect(source).toContain("ChevronDown");
  expect(source).toContain("group-open:rotate-180");
  expect(source).toContain("motion-reduce:transition-none");
  expect(source).toContain("!controller.availability.rules");
  expect(source).toMatch(
    /Rules for individual\s+departments are not active yet\./,
  );
  expect(source).toMatch(
    /Service identities can store intended rules but\s+cannot sign in yet\./,
  );
  expect(source).toContain('decision: "inherit",');
});
