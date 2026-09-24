import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

function simulatorSource(): string {
  return readFileSync(
    resolve(
      process.cwd(),
      "src/components/systems/access/components/simulator-view.tsx",
    ),
    "utf8",
  );
}

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0)
    throw new Error(`Unable to find ${start} through ${end}.`);
  return source.slice(startIndex, endIndex + end.length);
}

function disclosureSource(source: string, label: string): string {
  const labelIndex = source.indexOf(label);
  const startIndex = source.lastIndexOf("<details", labelIndex);
  const endIndex = source.indexOf("</details>", labelIndex);
  if (labelIndex < 0 || startIndex < 0 || endIndex < 0)
    throw new Error(`Unable to find the ${label} disclosure.`);
  return source.slice(startIndex, endIndex + "</details>".length);
}

test("keeps the simple three-control, two-card access check composition", () => {
  const source = simulatorSource();

  expect(source).toContain('htmlFor="simulator-identity"');
  expect(source).toContain('htmlFor="simulator-resource"');
  expect(source).toContain('htmlFor="simulator-action"');
  expect(source).toContain('aria-label="Access check result"');
  expect(source).toContain('aria-label="Access decision explanation"');
  expect(source).toContain("void evaluate()");
});

test("keeps plain-language results primary and discloses technical provenance", () => {
  const source = simulatorSource();
  const primaryResult = sourceBetween(
    source,
    '<Card aria-label="Access check result">',
    '<Card aria-label="Access decision explanation">',
  );
  const technicalDetails = disclosureSource(source, "Technical details");

  expect(primaryResult).toContain("{resultTitle}");
  expect(primaryResult).toContain("reasonDescriptions[result.reason]");
  expect(primaryResult).toContain("{source}");
  expect(primaryResult).not.toContain("result.policy_revision");
  expect(primaryResult).not.toContain("result.source_rule_id");
  expect(primaryResult).not.toContain("result.permission_id");

  expect(technicalDetails).toContain("<summary");
  expect(technicalDetails).toContain("focus-visible:outline-2");
  expect(technicalDetails).toContain("Policy revision");
  expect(technicalDetails).toContain("result.policy_revision");
  expect(technicalDetails).toContain("Source rule ID");
  expect(technicalDetails).toContain("result.source_rule_id");
  expect(technicalDetails).toContain("Action ID");
  expect(technicalDetails).toContain("result.permission_id");
  expect(technicalDetails).toContain("result.checked_at");
  expect(source).toMatch(
    /scopeCatalog\.filter\(\s*\(scope\)\s*=>\s*scope\.kind === "workspace"/,
  );
  expect(source).toContain(
    "Policy permits, but service sign-in is unavailable.",
  );
});

test("uses the authoritative check and never presents a client-generated trace", () => {
  const source = simulatorSource();

  expect(source).toContain("actions.checkAccess");
  expect(source).not.toContain("actions.resolveAccess");
  expect(source).not.toContain("result.trace");
  expect(source).toContain('aria-live="polite"');
  expect(source).toContain("Checking access");
  expect(source).toContain(
    "Policy permits, but service sign-in is unavailable.",
  );
  expect(source).toContain('"Try again"');
  expect(source).toContain("request.signal.aborted");
  expect(source).toContain("generation.current !== requestGeneration");
  expect(source).toContain("error.status === 403");
  expect(source).toContain("error.status === 503");
  expect(source).toContain("source_rule_id");
  expect(source).toContain("policy_revision");
  expect(source).toContain("checked_at");
  expect(source).toContain("reasonDescriptions[result.reason]");
});
