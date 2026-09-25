import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

function reviewsViewSource(): string {
  return readFileSync(
    resolve(
      process.cwd(),
      "src/components/systems/access/components/reviews-view.tsx",
    ),
    "utf8",
  );
}

test("unavailable Access reviews explain the current state without dead-end actions", () => {
  const source = reviewsViewSource();
  const unavailableBranch = sourceBetween(
    source,
    "if (!controller.availability.reviews)",
    "\n  }\n\n  return (",
  );

  expect(source).toContain("Access reviews");
  expect(unavailableBranch).toContain('role="status"');
  expect(unavailableBranch).toContain(
    "Formal access reviews are not available yet.",
  );
  expect(unavailableBranch).toMatch(
    /People &amp; services, Roles, Groups, and\s+Detailed rules/,
  );
  expect(unavailableBranch).not.toContain("Start access review");
  expect(unavailableBranch).not.toContain("Create access review");
  expect(unavailableBranch).not.toContain("Needs changes");
  expect(unavailableBranch).not.toContain("Finish review");
});

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0)
    throw new Error(`Unable to find ${start} through ${end}.`);
  return source.slice(startIndex, endIndex + end.length);
}
