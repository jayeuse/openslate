import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const source = readFileSync(
  resolve(
    process.cwd(),
    "src/components/systems/access/components/roles-view.tsx",
  ),
  "utf8",
);

function sourceBetween(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0)
    throw new Error(`Unable to find ${start} through ${end}.`);
  return source.slice(startIndex, endIndex + end.length);
}

test("role comparison is explicitly started and safely cancelled", () => {
  const compareState = sourceBetween(
    "const [compareOpen, setCompareOpen]",
    "const [message, setMessage]",
  );
  const compareActions = sourceBetween(
    '<div className="flex flex-wrap gap-2">',
    "</div>\n      </div>\n\n      <Alert>",
  );
  const compareSelection = sourceBetween('id: "compare",', 'id: "role",');
  const roleColumns = sourceBetween("const roleColumns", 'id: "role",');
  const primaryControls = sourceBetween(
    'FieldLabel htmlFor="role-search"',
    "<details",
  );
  const moreOptions = sourceBetween("<details", "</details>");

  expect(compareState).toContain(
    "const [compareMode, setCompareMode] = useState(false)",
  );
  expect(primaryControls).toContain("Search roles");
  expect(primaryControls).toContain('aria-label="Filter roles"');
  expect(primaryControls).toContain("Built-in");
  expect(primaryControls).toContain("Custom");
  expect(primaryControls).not.toContain("More options");
  expect(moreOptions).toContain("<summary");
  expect(moreOptions).toContain("focus-visible:outline-ring");
  expect(moreOptions).toContain("min-h-11");
  expect(moreOptions).toContain("More options");
  expect(moreOptions).toContain("Sort");
  expect(moreOptions).toContain("onClick={startCompare}");
  expect(compareActions).toContain("Compare roles");
  expect(compareActions).toContain("Cancel compare");
  expect(compareActions).toContain("onClick={cancelCompare}");
  expect(compareActions).toContain("onClick={() => setCompareOpen(true)}");
  expect(compareActions).not.toContain("onClick={startCompare}");
  expect(roleColumns).toMatch(/compareMode\s*\?/);
  expect(compareSelection).toContain("aria-label={`Compare ${role.name}`}");
  expect(compareSelection).toContain("min-h-11");
  expect(compareSelection).toContain("compareIds.length >= 4");
  expect(compareActions).toContain("disabled={compareIds.length < 2}");
  const comparisonDialog = sourceBetween(
    "<Dialog open={compareOpen",
    "</Dialog>",
  );
  expect(comparisonDialog).toContain("permissionNames.get(grant) ?? grant");
  expect(comparisonDialog).toContain("Default deny; no baseline grants.");
  expect(
    sourceBetween("function cancelCompare()", "async function duplicate"),
  ).toContain("setCompareIds([])");
});

test("role actions and templates use clear, least-privilege guidance", () => {
  expect(source).toContain("Adjust the search or create a role.");
  expect(source).not.toContain(
    "Adjust the search or create a role from a template.",
  );
  const desktopActions = sourceBetween('id: "actions",', "],\n    [");
  const mobileActions = sourceBetween("<CardFooter>", "</CardFooter>");
  const templates = sourceBetween(
    "const recommendedTemplateId",
    "</DialogContent>\n      </Dialog>",
  );

  expect(desktopActions).toContain('role.builtin ? "View role" : "Edit role"');
  expect(desktopActions).toContain('variant="outline"');
  expect(desktopActions).toContain("Duplicate");
  expect(mobileActions).toContain('role.builtin ? "View role" : "Edit role"');
  expect(mobileActions).toContain("Duplicate");
  expect(templates).toContain('template.id === "template:viewer"');
  expect(templates).toMatch(/\?\s*"template:viewer"\s*:\s*undefined/);
  expect(templates).not.toContain("template.identityKind");
  expect(templates).not.toContain("template.grants.length");
  expect(templates).toContain("Recommended");
  expect(templates).not.toContain("createRoleFromTemplate(recommended");
  const createFallback = sourceBetween(
    "function startCreateRole()",
    "const roleColumns",
  );
  expect(createFallback).toContain("controller.state.templates.length");
  expect(createFallback).toContain('id: "draft:new-role"');
  expect(createFallback).toContain("grants: []");
  expect(source.match(/onClick=\{startCreateRole\}/g)).toHaveLength(2);
  expect(source).toContain('role.name.toLowerCase() === "admin"');
  expect(source).toContain('role.name.toLowerCase() === "member"');
  expect(source).toContain("permissionNames.get(grant) ?? grant");
});
