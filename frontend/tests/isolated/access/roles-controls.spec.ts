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

test("role actions and templates use clear, least-privilege guidance", () => {
  expect(source).toContain("Adjust the search or create a role.");
  expect(source).not.toContain(
    "Adjust the search or create a role from a template.",
  );
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
    "const roleColumns",
  );
  expect(createFallback).toContain("controller.state.templates.length");
  expect(createFallback).toContain('id: "draft:new-role"');
  expect(createFallback).toContain("grants: []");
  expect(source.match(/onClick=\{startCreateRole\}/g)).toHaveLength(2);
  expect(source).toContain('role.name.toLowerCase() === "admin"');
  expect(source).toContain('role.name.toLowerCase() === "member"');
});
