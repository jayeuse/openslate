import type { SandboxVersion } from "../state/api";

// History rules (docs/specs/sandbox-relayout.md S8, S9). No version field
// marks a save as automatic, so the page infers it from the two checkpoints
// the system writes. The rule lives only here; a server field is a listed
// follow-up.

/**
 * A saved time as History shows it ("Oct 18, 2026, 9:12 AM"); Test results
 * use the same words (S26).
 */
export function formatSavedTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** The checkpoint the server saves before it restores a version. */
const RESTORE_CHECKPOINT_LABEL = "Before restore";

/** The checkpoint this page saves before it discards draft changes. */
export const DISCARD_CHECKPOINT = {
  label: "Before discard",
  note: "Saved automatically before discarding draft changes.",
} as const;

/**
 * Whether the system saved this version: the server's "Before restore" with
 * no note, or the page's "Before discard" with its note. A person's own
 * checkpoint with one of those names and another note is theirs.
 */
export function isAutomaticSave(
  version: Pick<SandboxVersion, "kind" | "label" | "note">,
): boolean {
  if (version.kind !== "checkpoint") return false;
  // The server writes its checkpoint with no note.
  if (version.label === RESTORE_CHECKPOINT_LABEL) return version.note === null;
  return (
    version.label === DISCARD_CHECKPOINT.label &&
    version.note === DISCARD_CHECKPOINT.note
  );
}

export type VersionListEntry =
  | { kind: "version"; version: SandboxVersion; automatic: boolean }
  /** The one row per day that hides or shows that day's automatic saves. */
  | { kind: "automatic"; count: number; shown: boolean };

export type VersionDayGroup = { day: string; entries: VersionListEntry[] };

/**
 * The list rows under their day headings, in the given (newest-first) order.
 * Each day's automatic saves fold into one row where the first of them sits;
 * when shown, that row stays in place and the saves follow in order.
 */
export function versionListGroups(
  versions: readonly SandboxVersion[],
  {
    showAutomatic,
    dayOf,
  }: { showAutomatic: boolean; dayOf: (createdAt: string) => string },
): VersionDayGroup[] {
  const groups: { day: string; versions: SandboxVersion[] }[] = [];
  for (const version of versions) {
    const day = dayOf(version.createdAt);
    const current = groups.at(-1);
    if (current?.day === day) current.versions.push(version);
    else groups.push({ day, versions: [version] });
  }
  return groups.map(({ day, versions: dayVersions }) => {
    const count = dayVersions.filter(isAutomaticSave).length;
    const entries: VersionListEntry[] = [];
    let folded = false;
    for (const version of dayVersions) {
      const automatic = isAutomaticSave(version);
      if (automatic && !folded) {
        entries.push({ kind: "automatic", count, shown: showAutomatic });
        folded = true;
      }
      if (!automatic || showAutomatic)
        entries.push({ kind: "version", version, automatic });
    }
    return { day, entries };
  });
}

/**
 * The pair Compare opens with: the version before the selected one as Older
 * and the selected one as Newer. The oldest known version pairs with the
 * next newer one, so Older stays the older of the two.
 */
export function defaultComparePair(
  versions: readonly SandboxVersion[],
  selectedId: string,
): { older: string; newer: string } {
  const selected = versions.find((version) => version.id === selectedId);
  if (!selected) return { older: "", newer: "" };
  let before: SandboxVersion | undefined;
  let after: SandboxVersion | undefined;
  for (const version of versions) {
    if (
      version.sequence < selected.sequence &&
      (!before || version.sequence > before.sequence)
    )
      before = version;
    if (
      version.sequence > selected.sequence &&
      (!after || version.sequence < after.sequence)
    )
      after = version;
  }
  if (before) return { older: before.id, newer: selected.id };
  return { older: selected.id, newer: after?.id ?? selected.id };
}
