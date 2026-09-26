import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const source = readFileSync(
  resolve(
    process.cwd(),
    "src/components/systems/access/components/role-management.tsx",
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

test("role template actions preserve recommendation and blank defaults", () => {
  const templates = sourceBetween(
    "const recommendedTemplateId",
    "</DialogContent>\n      </Dialog>",
  );

  expect(templates).toContain('template.id === "template:viewer"');
  expect(templates).toMatch(/\?\s*"template:viewer"\s*:\s*undefined/);
  expect(templates).not.toContain("template.identityKind");
  expect(templates).not.toContain("template.grants.length");
  expect(templates).toContain("Recommended");
  expect(templates).not.toContain("createRoleFromTemplate(recommended");
  const createFallback = sourceBetween(
    "function startCreateRole()",
    "const controls: RoleManagementControls",
  );
  expect(createFallback).toContain("controller.state.templates.length");
  expect(createFallback).toContain('id: "draft:new-role"');
  expect(createFallback).toContain("grants: []");
  expect(source).toContain("createRole: startCreateRole");
  expect(source).toContain('role.system === "admin"');
  expect(source).toContain('role.system === "member"');
});
