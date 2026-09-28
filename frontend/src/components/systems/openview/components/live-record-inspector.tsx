"use client";

import type { ReactNode } from "react";
import type { OpenViewGroupSelector } from "../adapters/analytics-api";
import type {
  OpenViewDataSourceField,
  OpenViewQueryDefinition,
  OpenViewQueryFieldType,
  OpenViewRecord,
} from "../adapters/views-api";
import type { OpenViewWindowQueryRequest } from "../adapters/window-api";
import { openViewRecordFieldValue } from "../domain/record-display";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

export type RecordInspectionPageSource =
  | {
      kind: "records";
      /** The originating page size; legacy fixed-size callers fall back to 25. */
      limit?: number;
      group: {
        fieldId: string;
        fieldType: OpenViewQueryFieldType;
        selected: OpenViewGroupSelector;
        offset: number;
      } | null;
      returnToPage?: (offset: number) => void;
    }
  | {
      kind: "window";
      request: OpenViewWindowQueryRequest;
      returnToPage: (offset: number) => void;
    };

export type RecordInspectionPage = {
  rows: readonly OpenViewRecord[];
  offset: number;
  total: number;
  source: RecordInspectionPageSource;
};

export type RecordInspectionContext = RecordInspectionPage & {
  key: string;
  recordId: string;
  definition: OpenViewQueryDefinition;
};

type LiveRecordInspectorProps = {
  actions: ReactNode;
  record: OpenViewRecord | null;
  recordLoading: boolean;
  recordError: string;
  inspectionLoading: boolean;
  inspectionError: string;
  fields: readonly OpenViewDataSourceField[];
  primaryFieldId: string | null;
  onRetryRecord: () => void;
};

function readableValue(value: unknown): string {
  if (typeof value === "string") return value.trim() ? value : "—";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return "—";
}

function updatedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Date unavailable";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
}

export function LiveRecordInspector({
  actions,
  record,
  recordLoading,
  recordError,
  inspectionLoading,
  inspectionError,
  fields,
  primaryFieldId,
  onRetryRecord,
}: LiveRecordInspectorProps) {
  const primaryField =
    fields.find((field) => field.id === primaryFieldId) ?? fields[0];
  const title = record
    ? primaryField
      ? readableValue(openViewRecordFieldValue(record, primaryField))
      : `Record ${record.id.slice(0, 8)}`
    : "";

  return (
    <section aria-label="Record details content" className="min-w-0">
      {inspectionLoading ? (
        <p role="status" className="text-muted-foreground py-2 text-sm">
          Loading adjacent records…
        </p>
      ) : null}
      {inspectionError ? (
        <p role="alert" className="text-destructive py-2 text-sm">
          {inspectionError}
        </p>
      ) : null}
      {record ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b py-4">
            <div className="min-w-0">
              <h2 className="text-xl font-semibold wrap-anywhere">{title}</h2>
            </div>
            <Badge variant={record.isDeleted ? "destructive" : "secondary"}>
              {record.isDeleted ? "Deleted" : "Read-only"}
            </Badge>
          </div>
          {fields.length > 0 ? (
            <dl className="divide-y">
              {fields.map((field) => (
                <div
                  key={field.id}
                  className="grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(8rem,0.8fr)_minmax(0,1.2fr)] sm:gap-4"
                >
                  <dt className="text-muted-foreground text-sm">
                    {field.name}
                  </dt>
                  <dd className="min-w-0 text-sm wrap-anywhere">
                    {readableValue(openViewRecordFieldValue(record, field))}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <Empty className="py-6">
              <EmptyHeader>
                <EmptyTitle>No readable fields in this view</EmptyTitle>
                <EmptyDescription>
                  This view does not include any active fields to show for this
                  record.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          <p className="text-muted-foreground border-t pt-3 text-sm">
            Updated{" "}
            <time dateTime={record.updatedAt}>
              {updatedDate(record.updatedAt)}
            </time>
          </p>
        </>
      ) : recordError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 py-4">
          <p role="alert" className="text-destructive text-sm">
            {recordError}
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onRetryRecord}
          >
            Retry linked record
          </Button>
        </div>
      ) : recordLoading ? (
        <p role="status" className="text-muted-foreground py-6 text-sm">
          Loading linked record…
        </p>
      ) : (
        <Empty className="py-6">
          <EmptyHeader>
            <EmptyTitle>This record is unavailable</EmptyTitle>
            <EmptyDescription>
              The record may have been removed or may not be visible to you.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {record ? (
        <div className="flex flex-wrap gap-2 border-t pt-4">{actions}</div>
      ) : null}
    </section>
  );
}
