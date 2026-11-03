import {
  auditChanges,
  type AuditChange,
  type AuditFieldKind,
} from "@/components/systems/manage/domain/audit-rules";
import type { WorkspaceRegion } from "@/lib/date-time";

import type { OpenViewRecordHistoryEntry } from "../adapters/records-api";
import type { OpenViewDataSourceField } from "../adapters/views-api";

/**
 * What the History tab shows (docs/specs/system-health.md D10): one sentence
 * per entry, who and when, and the old and new value of each change. For a
 * reader who does not manage the department the server leaves out every
 * field they cannot read; the panel trusts that and drops only a redacted
 * value, which counts as hidden (D10.2). A field whose name has not loaded
 * reads "a field"; only a manager's field missing from the complete list is
 * "a field that is no longer shown".
 */
export type RecordHistoryItem = {
  id: string;
  sentence: string;
  who: string;
  createdAt: string;
  changes: AuditChange[];
};

type HistoryField = Pick<OpenViewDataSourceField, "id" | "name" | "type"> & {
  config: Readonly<Record<string, unknown>>;
};

const RETIRED = "a field that is no longer shown";
const UNNAMED = "a field";
const REDACTED = "[REDACTED]";

type Snapshot = Record<string, unknown> | null;

function dataOf(snapshot: Snapshot): Record<string, unknown> {
  const data = snapshot?.data;
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

const restored = (
  entry: Pick<OpenViewRecordHistoryEntry, "before" | "after">,
) => entry.before?.is_deleted === true && entry.after?.is_deleted === false;

function changedKeys(before: Snapshot, after: Snapshot): string[] {
  const old = dataOf(before);
  const next = dataOf(after);
  return [...new Set([...Object.keys(old), ...Object.keys(next)])].filter(
    (key) => JSON.stringify(old[key]) !== JSON.stringify(next[key]),
  );
}

/** Today's sentence (D10.3, line 1). */
function describe(
  entry: Pick<OpenViewRecordHistoryEntry, "action" | "before" | "after">,
  fieldNames: ReadonlyMap<string, string>,
  missing: string,
): string {
  if (entry.action === "create") return "Created the record";
  if (entry.action === "delete") return "Deleted the record";
  if (restored(entry)) return "Restored the record";
  const changed = changedKeys(entry.before, entry.after).map(
    (key) => fieldNames.get(key) ?? missing,
  );
  if (changed.length === 0) return "Updated the record";
  return `Changed ${[...new Set(changed)].join(", ")}`;
}

/** A snapshot's data without the redacted fields. */
function withoutRedacted(
  snapshot: Snapshot,
  redacted: ReadonlySet<string>,
): Snapshot {
  if (!snapshot) return snapshot;
  const data = Object.fromEntries(
    Object.entries(dataOf(snapshot)).filter(([key]) => !redacted.has(key)),
  );
  return { ...snapshot, data };
}

function fieldKinds(
  fields: readonly HistoryField[],
): ReadonlyMap<string, AuditFieldKind> {
  return new Map(
    fields.map((field) => {
      const options = Array.isArray(field.config.options)
        ? field.config.options
        : [];
      return [
        field.id,
        {
          type: field.type,
          options: new Map(
            options.flatMap((option: unknown) =>
              typeof option === "object" &&
              option !== null &&
              typeof (option as { id?: unknown }).id === "string" &&
              typeof (option as { label?: unknown }).label === "string"
                ? [
                    [
                      (option as { id: string }).id,
                      (option as { label: string }).label,
                    ] as const,
                  ]
                : [],
            ),
          ),
        },
      ];
    }),
  );
}

export function recordHistoryItems(
  entries: readonly OpenViewRecordHistoryEntry[],
  {
    fields,
    fieldsComplete,
    manages,
    region,
  }: {
    fields: readonly HistoryField[];
    /** `fields` holds every active field of the module, not one page. */
    fieldsComplete: boolean;
    /** An admin or manager of the record's department (`managesHistory`). */
    manages: boolean;
    region: WorkspaceRegion | undefined;
  },
): RecordHistoryItem[] {
  const fieldNames = new Map(fields.map((field) => [field.id, field.name]));
  // A key the complete list lacks is retired, which only a manager can be
  // sent; any other missing name has not loaded yet.
  const missing = manages && fieldsComplete ? RETIRED : UNNAMED;
  const missingLabel = missing[0]!.toUpperCase() + missing.slice(1);
  const kinds = { fields: fieldKinds(fields) };
  return entries.flatMap((entry): RecordHistoryItem[] => {
    let { before, after } = entry;
    if (!manages) {
      // A redacted value counts as hidden for a reader (D10.2, item 2).
      const redacted = new Set(
        [...Object.entries(dataOf(before)), ...Object.entries(dataOf(after))]
          .filter(([, value]) => value === REDACTED)
          .map(([key]) => key),
      );
      before = withoutRedacted(before, redacted);
      after = withoutRedacted(after, redacted);
      if (
        entry.action === "update" &&
        !restored(entry) &&
        changedKeys(before, after).length === 0
      )
        return [];
    }
    const shown = { ...entry, before, after };
    // A field without a name reads the same words in its row.
    const names = new Map(fieldNames);
    for (const key of changedKeys(before, after))
      if (!names.has(key)) names.set(key, missingLabel);
    return [
      {
        id: entry.id,
        sentence: describe(shown, fieldNames, missing),
        who: entry.actorName ?? entry.actorLabel ?? "Someone",
        createdAt: entry.createdAt,
        changes:
          entry.action === "update" && !restored(entry)
            ? auditChanges(
                { before: dataOf(before), after: dataOf(after) },
                region,
                names,
                kinds,
              )
            : [],
      },
    ];
  });
}
