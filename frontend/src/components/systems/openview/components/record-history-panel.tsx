"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";

import type { OpenViewDataSourceField } from "../adapters/views-api";
import { listOpenViewRecordHistory } from "../adapters/records-api";
import { allFieldsOptions } from "../adapters/openview-queries";
import {
  recordHistoryItems,
  type RecordHistoryItem,
} from "../domain/record-history";
import { Button } from "@/components/ui/button";
import { ErrorReference } from "@/components/ui/error-reference";
import { apiErrorReference } from "@/lib/api-errors";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";

type RecordHistoryPanelProps = {
  region: WorkspaceRegion | undefined;
  recordId: string;
  moduleId: string;
  departmentId: string;
  /** The sheet's fields: every field, or the first page of them. */
  fields: readonly OpenViewDataSourceField[];
  /** `fields` is every active field of the module. */
  fieldsComplete: boolean;
  /** An admin or a manager of the record's department (D10.1). */
  manages: boolean;
  /** Changes when the record changes, so the history reads again. */
  version: string;
};

export type RecordHistoryState =
  | { kind: "loading" }
  | { kind: "error"; reference: string | undefined }
  | { kind: "items"; items: RecordHistoryItem[] };

function when(value: string, region: WorkspaceRegion | undefined): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Time unavailable";
  if (!region) return "Date unavailable";
  return formatWorkspaceDateTime(value, region, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * The History tab, for every person who can open the record (S4-C5): who
 * changed it, when, and each readable change. The layout has no role
 * branch; the server decides which entries and fields arrive (S4-C4).
 */
export function RecordHistoryPanel({
  region,
  recordId,
  moduleId,
  departmentId,
  fields,
  fieldsComplete,
  manages,
  version,
}: RecordHistoryPanelProps) {
  // With only the first page of fields, read every page for the names; until
  // then, or if that read fails, an unnamed field reads "a field".
  const allFields = useQuery({
    ...allFieldsOptions(moduleId),
    enabled: !fieldsComplete && Boolean(moduleId),
  });
  const named = fieldsComplete ? fields : (allFields.data ?? fields);
  const namesComplete = fieldsComplete || allFields.isSuccess;
  const history = useQuery({
    queryKey: [
      "openview",
      "record-controls",
      "history",
      recordId,
      departmentId,
      manages,
      version,
    ],
    queryFn: () =>
      listOpenViewRecordHistory({ recordId, departmentId, manages }),
    retry: false,
  });
  const state: RecordHistoryState = history.isPending
    ? { kind: "loading" }
    : history.isError
      ? { kind: "error", reference: apiErrorReference(history.error) }
      : {
          kind: "items",
          items: recordHistoryItems(history.data, {
            fields: named,
            fieldsComplete: namesComplete,
            manages,
            region,
          }),
        };
  return (
    <RecordHistoryView
      state={state}
      region={region}
      onRetry={() => void history.refetch()}
    />
  );
}

/** The panel for one state (D10.3, D10.4). */
export function RecordHistoryView({
  state,
  region,
  onRetry,
}: {
  state: RecordHistoryState;
  region: WorkspaceRegion | undefined;
  onRetry: () => void;
}) {
  if (state.kind === "loading")
    return (
      <p role="status" className="text-muted-foreground py-4 text-sm">
        Loading history…
      </p>
    );
  if (state.kind === "error")
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 py-4">
        <p role="alert" className="text-destructive text-sm">
          History could not be loaded.
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={onRetry}
        >
          Retry
        </Button>
        <ErrorReference id={state.reference} className="mt-0 basis-full" />
      </div>
    );
  if (state.items.length === 0)
    return (
      <p className="text-muted-foreground py-4 text-sm">
        No changes are recorded for this record.
      </p>
    );
  return (
    <ol className="divide-y" aria-label="Record history">
      {state.items.map((item) => (
        <li key={item.id} className="flex min-w-0 flex-col gap-1 py-3">
          <p className="text-sm wrap-anywhere">{item.sentence}</p>
          <p className="text-muted-foreground text-xs">
            {item.who} ·{" "}
            <time dateTime={item.createdAt}>
              {when(item.createdAt, region)}
            </time>
          </p>
          {item.changes.length ? (
            <ul className="mt-1 flex flex-col gap-1 text-sm">
              {item.changes.map((change) => (
                <li
                  key={change.key}
                  className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5"
                >
                  <span className="text-muted-foreground">{change.label}</span>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 wrap-anywhere">
                    {change.before === null ? (
                      // A reference without a loaded name says what
                      // happened, never its id (MD20).
                      <b className="font-semibold">{change.after}</b>
                    ) : (
                      <>
                        <span
                          className={
                            change.before === "Not set"
                              ? "text-muted-foreground"
                              : "text-muted-foreground line-through"
                          }
                        >
                          {change.before}
                        </span>{" "}
                        <span className="sr-only">to</span>
                        <ArrowRight
                          aria-hidden="true"
                          className="size-3.5 shrink-0"
                        />{" "}
                        <b className="font-semibold">{change.after}</b>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
