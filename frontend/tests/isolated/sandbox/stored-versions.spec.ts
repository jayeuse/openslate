import { expect, test } from "@playwright/test";
import {
  initialDesign,
  type Design,
  type Version,
} from "../../../src/components/sample/sandbox/model";
import { decodeStoredSandboxVersions } from "../../../src/components/sample/sandbox/stored-history";
import { decodeSampleStoredValue } from "../../../src/components/sample/sample-state";

function version(overrides: Partial<Version> = {}): Version {
  return {
    id: "version-1",
    label: "Checkpoint 1",
    design: structuredClone(initialDesign),
    published: false,
    date: "Synthetic date",
    ...overrides,
  };
}

test("stored versions decode exact bounded snapshots and preserve semantic design issues", () => {
  const invalid = structuredClone(initialDesign);
  invalid.modules[0].department = "missing-department";
  invalid.relationships.push({
    ...invalid.relationships[0],
    id: "semantic-duplicate",
  });
  const stored = [
    version({
      design: invalid,
      note: "Review before restoring",
    }),
  ];

  expect(decodeStoredSandboxVersions(stored)).toEqual(stored);
  expect(decodeSampleStoredValue("sandbox.versions", stored, [])).toEqual(
    stored,
  );
});

test("stored versions reject unknown version and nested design properties atomically", () => {
  const withUnknownVersion = {
    ...version(),
    unexpected: true,
  };
  const nested = structuredClone(initialDesign) as Design & {
    modules: Array<Design["modules"][number] & { unexpected?: boolean }>;
  };
  nested.modules[0].unexpected = true;

  for (const stored of [
    [version(), withUnknownVersion],
    [version(), version({ id: "version-2", design: nested })],
  ]) {
    expect(decodeStoredSandboxVersions(stored)).toBeNull();
    const fallback = [version({ id: "fallback" })];
    expect(decodeSampleStoredValue("sandbox.versions", stored, fallback)).toBe(
      fallback,
    );
  }
});

test("stored versions reject duplicate IDs and more than fifty entries atomically", () => {
  expect(
    decodeStoredSandboxVersions([
      version(),
      version({ label: "Duplicate", date: "Later" }),
    ]),
  ).toBeNull();
  expect(
    decodeStoredSandboxVersions(
      Array.from({ length: 51 }, (_, index) =>
        version({ id: `version-${index}`, label: `Checkpoint ${index}` }),
      ),
    ),
  ).toBeNull();
});

test("stored versions enforce bounded ID label date and note strings", () => {
  const cases: Version[] = [
    version({ id: "x".repeat(1_001) }),
    version({ label: "x".repeat(81) }),
    version({ date: "x".repeat(1_001) }),
    version({ note: "x".repeat(501) }),
  ];

  for (const invalid of cases) {
    expect(decodeStoredSandboxVersions([invalid])).toBeNull();
  }
  expect(
    decodeStoredSandboxVersions([
      version({
        id: "x".repeat(1_000),
        label: "x".repeat(80),
        date: "x".repeat(1_000),
        note: "x".repeat(500),
      }),
    ]),
  ).not.toBeNull();
});

test("stored versions enforce existing nested entity layout rule and field-config caps", () => {
  const tooManyDepartments = structuredClone(initialDesign);
  tooManyDepartments.departments = Array.from({ length: 101 }, (_, index) => ({
    id: `department-${index}`,
    name: `Department ${index}`,
    closed: false,
  }));
  const unsafeLayout = structuredClone(initialDesign);
  unsafeLayout.layout = {
    node: { x: 100_001, y: 0, width: 100, height: 100 },
  };
  const unknownRuleConfig = structuredClone(initialDesign);
  (
    unknownRuleConfig.rules[0] as unknown as {
      config: unknown;
    }
  ).config = {
    trigger: { kind: "new-record", moduleId: "sample-requests" },
    condition: { kind: "always", unexpected: true },
    action: { kind: "notification", message: "Notify" },
  };
  const excessiveOptions = structuredClone(initialDesign);
  excessiveOptions.modules[0].fields[0].config = {
    kind: "select",
    defaultValue: null,
    options: Array.from({ length: 101 }, (_, index) => `Option ${index}`),
  };

  for (const design of [
    tooManyDepartments,
    unsafeLayout,
    unknownRuleConfig,
    excessiveOptions,
  ]) {
    expect(decodeStoredSandboxVersions([version({ design })])).toBeNull();
  }
});
