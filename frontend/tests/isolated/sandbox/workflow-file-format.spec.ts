import { expect, test } from "@playwright/test";
import type { Version } from "../../../src/components/systems/sandbox/domain/model";
import {
  exportSandboxFile,
  parseSandboxFile,
} from "../../../src/components/systems/sandbox/helpers/file-format";
import { configuredSandboxDesign as initialDesign } from "../../helpers/sandbox-fixtures";

function duplicateVersions(): Version[] {
  return ["First", "Second"].map((label) => ({
    id: "duplicate-version",
    label,
    design: structuredClone(initialDesign),
    published: false,
    date: "Synthetic date",
  }));
}

test("sandbox files reject duplicate version IDs on export and import", () => {
  expect(() =>
    exportSandboxFile({
      design: structuredClone(initialDesign),
      versions: duplicateVersions(),
    }),
  ).toThrow("Version IDs must be unique");

  const parsed = parseSandboxFile(
    JSON.stringify({
      kind: "openslate-sandbox",
      schemaVersion: 1,
      design: structuredClone(initialDesign),
      versions: duplicateVersions(),
    }),
  );
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error("Duplicate versions must not be accepted");
  expect(parsed.error).toBe("Version IDs must be unique");
});
