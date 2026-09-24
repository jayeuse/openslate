import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

function governanceLauncherSource(): string {
  const source = readFileSync(
    resolve(
      process.cwd(),
      "src/components/systems/access/components/governance-dialogs.tsx",
    ),
    "utf8",
  );
  const start = source.indexOf("{showLauncher ? (");
  const end = source.indexOf("\n      ) : (", start);
  if (start < 0 || end < 0)
    throw new Error("Unable to find the Governance launcher branch.");
  return source.slice(start, end);
}

test("Governance keeps defaults and an unavailable notice without deferred launchers", () => {
  const launcher = governanceLauncherSource();
  const normalizedLauncher = launcher.replace(/\s+/g, " ");

  expect(launcher).toContain("<CardTitle>Access defaults</CardTitle>");
  expect(launcher).toContain("Manage default access settings.");
  expect(launcher).toContain("Configure defaults");
  expect(normalizedLauncher).toContain(
    "Importing or exporting policies and restoring policy history are not available yet.",
  );
  expect(launcher).not.toMatch(/portable|restorable/i);

  for (const deferredLauncher of [
    "Policy export",
    "Policy import",
    "Policy history",
    "Review export",
    "Import JSON",
    "View policy history",
  ]) {
    expect(launcher).not.toContain(deferredLauncher);
  }
});
