"use client";

import { useQuery } from "@tanstack/react-query";
import type { OpenViewDataSourceField } from "../adapters/views-api";
import { assignableUsersOptions } from "../adapters/openview-queries";
import {
  listOpenViewRecordHistory,
  type OpenViewRecordHistoryEntry,
} from "../adapters/records-api";
import { Button } from "@/components/ui/button";

type RecordHistoryPanelProps = {
  recordId: string;
  moduleId: string;
  departmentId: string;
  fields: readonly OpenViewDataSourceField[];
  /** Changes when the record changes, so the history reads again. */
  version: string;
};

function dataOf(snapshot: Record<string, unknown> | null) {
  const data = snapshot?.data;
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function describe(
  entry: OpenViewRecordHistoryEntry,
  fieldNames: ReadonlyMap<string, string>,
): string {
  if (entry.action === "create") return "Created the record";
  if (entry.action === "delete") return "Deleted the record";
  if (entry.before?.is_deleted === true && entry.after?.is_deleted === false)
    return "Restored the record";
  const before = dataOf(entry.before);
  const after = dataOf(entry.after);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => fieldNames.get(key) ?? "a field that is no longer shown");
  if (changed.length === 0) return "Updated the record";
  return `Changed ${[...new Set(changed)].join(", ")}`;
}

function when(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Time unavailable";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** The History tab: who changed the record, and when. */
export function RecordHistoryPanel({
  recordId,
  moduleId,
  departmentId,
  fields,
  version,
}: RecordHistoryPanelProps) {
  const history = useQuery({
    queryKey: [
      "openview",
      "record-controls",
      "history",
      recordId,
      departmentId,
      version,
    ],
    queryFn: () => listOpenViewRecordHistory({ recordId, departmentId }),
    retry: false,
  });
  const people = useQuery(assignableUsersOptions(moduleId, ""));
  const names = new Map(
    (people.data?.items ?? []).map((person) => [
      person.id,
      person.displayName ?? person.username,
    ]),
  );
  const fieldNames = new Map(fields.map((field) => [field.id, field.name]));

  if (history.isPending)
    return (
      <p role="status" className="text-muted-foreground py-4 text-sm">
        Loading history…
      </p>
    );
  if (history.isError)
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 py-4">
        <p role="alert" className="text-destructive text-sm">
          History could not be loaded.
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => void history.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  if (history.data.length === 0)
    return (
      <p className="text-muted-foreground py-4 text-sm">
        No changes are recorded for this record.
      </p>
    );
  return (
    <ol className="divide-y" aria-label="Record history">
      {history.data.map((entry) => (
        <li key={entry.id} className="flex min-w-0 flex-col gap-1 py-3">
          <p className="text-sm wrap-anywhere">{describe(entry, fieldNames)}</p>
          <p className="text-muted-foreground text-xs">
            {(entry.performedBy && names.get(entry.performedBy)) ??
              entry.actorLabel ??
              "Someone"}{" "}
            · <time dateTime={entry.createdAt}>{when(entry.createdAt)}</time>
          </p>
        </li>
      ))}
    </ol>
  );
}
