import { expect, test } from "@playwright/test";

import {
  defaultComparePair,
  isAutomaticSave,
  versionListGroups,
} from "../../../src/components/systems/sandbox/domain/version-history";
import type { SandboxVersion } from "../../../src/components/systems/sandbox/state/api";

// History (docs/specs/sandbox-relayout.md S8, S9): the page infers automatic
// saves from the two labels the system writes, folds them into one row per
// day where they would be, and preselects the version before the selected one
// as Older.

function version(
  sequence: number,
  label: string,
  {
    kind = "checkpoint",
    note = null,
    createdAt = "2026-10-18T10:00:00Z",
  }: {
    kind?: SandboxVersion["kind"];
    note?: string | null;
    createdAt?: string;
  } = {},
): SandboxVersion {
  return {
    id: `v${sequence}`,
    sequence,
    kind,
    label,
    note,
    sourceDocumentRevision: 1,
    sourceVersionId: null,
    contentHash: "c".repeat(64),
    byteCount: 1,
    metadataRevision: 1,
    createdAt,
    performedBy: null,
    isDeleted: false,
    deletedAt: null,
  };
}

const discardNote = "Saved automatically before discarding draft changes.";

test("only the labels the system writes mark a checkpoint as automatic", () => {
  const cases: [SandboxVersion, boolean][] = [
    // The server's checkpoint before a restore.
    [version(1, "Before restore"), true],
    // The server writes it with no note; a person's copy with a note is theirs.
    [
      version(10, "Before restore", { note: "Saved before the Q4 rework" }),
      false,
    ],
    // The page's checkpoint before a discard carries its note.
    [version(2, "Before discard", { note: discardNote }), true],
    // A person's own checkpoint named "Before discard" has no such note.
    [version(3, "Before discard"), false],
    [version(4, "Before discard", { note: "My own note" }), false],
    // Labels must match exactly.
    [version(5, "Before restore of Q4"), false],
    [version(6, "before restore"), false],
    // Only checkpoints are automatic.
    [version(7, "Before restore", { kind: "published" }), false],
    [
      version(8, "Before discard", { kind: "imported", note: discardNote }),
      false,
    ],
    [version(9, "Q4 structure"), false],
  ];
  for (const [item, automatic] of cases)
    expect(isAutomaticSave(item), `${item.label} v${item.sequence}`).toBe(
      automatic,
    );
});

const day = (createdAt: string) => createdAt.slice(0, 10);
const list = [
  version(9, "Stock counts", { createdAt: "2026-10-18T11:40:00Z" }),
  version(8, "Before restore", { createdAt: "2026-10-18T11:30:00Z" }),
  version(7, "Q4 structure", {
    kind: "published",
    createdAt: "2026-10-18T10:05:00Z",
  }),
  version(6, "Before discard", {
    note: discardNote,
    createdAt: "2026-10-18T09:50:00Z",
  }),
  version(5, "Before restore", { createdAt: "2026-10-18T09:40:00Z" }),
  version(4, "Departments drafted", { createdAt: "2026-10-17T16:31:00Z" }),
  version(3, "Before discard", { createdAt: "2026-10-17T16:12:00Z" }),
  version(2, "Before restore", { createdAt: "2026-10-17T14:00:00Z" }),
  version(1, "Harbor template", {
    kind: "imported",
    createdAt: "2026-10-16T09:02:00Z",
  }),
];

function shape(groups: ReturnType<typeof versionListGroups>) {
  return groups.map((group) => [
    group.day,
    group.entries.map((entry) =>
      entry.kind === "version"
        ? `${entry.automatic ? "auto " : ""}v${entry.version.sequence}`
        : `${entry.shown ? "shown" : "hidden"} ${entry.count}`,
    ),
  ]);
}

test("days group the rows, and each day folds its automatic saves where the first one sits", () => {
  expect(
    shape(versionListGroups(list, { showAutomatic: false, dayOf: day })),
  ).toEqual([
    ["2026-10-18", ["v9", "hidden 3", "v7"]],
    // A person's checkpoint named "Before discard" without the note stays.
    ["2026-10-17", ["v4", "v3", "hidden 1"]],
    ["2026-10-16", ["v1"]],
  ]);
});

test("Show keeps the fold row in place and lists every automatic save, marked", () => {
  expect(
    shape(versionListGroups(list, { showAutomatic: true, dayOf: day })),
  ).toEqual([
    ["2026-10-18", ["v9", "shown 3", "auto v8", "v7", "auto v6", "auto v5"]],
    ["2026-10-17", ["v4", "v3", "shown 1", "auto v2"]],
    ["2026-10-16", ["v1"]],
  ]);
});

test("a page of automatic saves only still shows its fold row", () => {
  expect(
    shape(
      versionListGroups([list[1]!, list[4]!], {
        showAutomatic: false,
        dayOf: day,
      }),
    ),
  ).toEqual([["2026-10-18", ["hidden 2"]]]);
  expect(versionListGroups([], { showAutomatic: false, dayOf: day })).toEqual(
    [],
  );
});

test("Compare preselects the version before the selected one as Older and the selected one as Newer", () => {
  // Newest first, as the API returns History; one version is off the page.
  const known = [list[0]!, list[2]!, list[6]!, list[8]!];
  expect(defaultComparePair(known, "v7")).toEqual({
    older: "v3",
    newer: "v7",
  });
  // The closest older version, not the oldest one.
  expect(defaultComparePair(known, "v9")).toEqual({
    older: "v7",
    newer: "v9",
  });
  // The oldest version pairs with the next newer one, still older first.
  expect(defaultComparePair(known, "v1")).toEqual({
    older: "v1",
    newer: "v3",
  });
  // One version, or none selected, leaves nothing to compare against.
  expect(defaultComparePair([list[0]!], "v9")).toEqual({
    older: "v9",
    newer: "v9",
  });
  expect(defaultComparePair(known, "missing")).toEqual({
    older: "",
    newer: "",
  });
});
