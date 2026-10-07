"use client";

import type { ReactNode } from "react";
import type { OpenViewGroupSelector } from "../adapters/analytics-api";
import type {
  OpenViewDataSourceField,
  OpenViewQueryDefinition,
  OpenViewQueryFieldType,
  OpenViewRecord,
} from "../adapters/views-api";
import type { OpenViewDataSource } from "../adapters/views-api";
import type { OpenViewWindowQueryRequest } from "../adapters/window-api";
import { openViewRecordFieldValue } from "../domain/record-display";
import { RecordDetailsControls } from "./record-details-controls";
import { RecordHistoryPanel } from "./record-history-panel";
import { formatWorkspaceDate, type WorkspaceRegion } from "@/lib/date-time";
import { RecordFilesPanel } from "./record-files-panel";
import { RecordLinksPanel } from "./record-links-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

/** What the signed-in user may do with the record, and what it needs. */
export type RecordControls = {
  moduleId: string;
  departmentId: string;
  /** Every active field of the data source, for editing and history. */
  editableFields: readonly OpenViewDataSourceField[];
  dataSources: readonly OpenViewDataSource[];
  canWrite: boolean;
  canReadHistory: boolean;
  onChanged: (message: string) => void;
  onEditingChange: (editing: boolean) => void;
};

type LiveRecordInspectorProps = {
  region: WorkspaceRegion | undefined;
  actions: ReactNode;
  controls?: RecordControls;
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

function updatedDate(
  value: string,
  region: WorkspaceRegion | undefined,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Date unavailable";
  return region ? formatWorkspaceDate(value, region) : "Date unavailable";
}

export function LiveRecordInspector({
  region,
  actions,
  record,
  recordLoading,
  recordError,
  inspectionLoading,
  inspectionError,
  fields,
  primaryFieldId,
  onRetryRecord,
  controls,
}: LiveRecordInspectorProps) {
  const primaryField =
    fields.find((field) => field.id === primaryFieldId) ?? fields[0];
  const title = record
    ? primaryField
      ? readableValue(openViewRecordFieldValue(record, primaryField))
      : `Record ${record.id.slice(0, 8)}`
    : "";

  const details = record ? (
    fields.length > 0 ? (
      <dl className="divide-y">
        {fields.map((field) => (
          <div
            key={field.id}
            className="grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(8rem,0.8fr)_minmax(0,1.2fr)] sm:gap-4"
          >
            <dt className="text-muted-foreground text-sm">{field.name}</dt>
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
    )
  ) : null;

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
            {record.isDeleted ? (
              <Badge variant="destructive">Deleted</Badge>
            ) : controls?.canWrite ? null : (
              <Badge variant="secondary">Read-only</Badge>
            )}
          </div>
          {controls ? (
            <Tabs defaultValue="details" className="min-w-0 pt-4">
              <TabsList
                aria-label="Record sections"
                className="max-w-full flex-nowrap justify-start overflow-x-auto"
              >
                <TabsTrigger value="details" className="min-h-11 shrink-0">
                  Details
                </TabsTrigger>
                <TabsTrigger value="links" className="min-h-11 shrink-0">
                  Linked records
                </TabsTrigger>
                <TabsTrigger value="files" className="min-h-11 shrink-0">
                  Files
                </TabsTrigger>
                {controls.canReadHistory ? (
                  <TabsTrigger value="history" className="min-h-11 shrink-0">
                    History
                  </TabsTrigger>
                ) : null}
              </TabsList>
              <TabsContent value="details" className="mt-0" keepMounted>
                <RecordDetailsControls
                  key={record.id}
                  record={record}
                  moduleId={controls.moduleId}
                  fields={controls.editableFields}
                  canWrite={controls.canWrite}
                  onChanged={controls.onChanged}
                  onEditingChange={controls.onEditingChange}
                >
                  {details}
                </RecordDetailsControls>
              </TabsContent>
              <TabsContent value="links" className="mt-0">
                <RecordLinksPanel
                  key={record.id}
                  record={record}
                  dataSources={controls.dataSources}
                  canWrite={controls.canWrite}
                  onChanged={controls.onChanged}
                />
              </TabsContent>
              <TabsContent value="files" className="mt-0">
                <RecordFilesPanel
                  key={record.id}
                  record={record}
                  canWrite={controls.canWrite}
                  region={region}
                />
              </TabsContent>
              {controls.canReadHistory ? (
                <TabsContent value="history" className="mt-0">
                  <RecordHistoryPanel
                    region={region}
                    recordId={record.id}
                    moduleId={controls.moduleId}
                    departmentId={controls.departmentId}
                    fields={controls.editableFields}
                    version={`${record.updatedAt}:${String(record.isDeleted)}`}
                  />
                </TabsContent>
              ) : null}
            </Tabs>
          ) : (
            details
          )}
          <p className="text-muted-foreground border-t pt-3 text-sm">
            Updated{" "}
            <time dateTime={record.updatedAt}>
              {updatedDate(record.updatedAt, region)}
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
