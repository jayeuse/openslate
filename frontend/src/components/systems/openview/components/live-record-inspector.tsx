"use client";
import {
  formatOpenViewFieldValue,
  RecordPersonCard,
} from "./live-record-cards";

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
  fieldsHasMore?: boolean;
  fieldsLoadingMore?: boolean;
  onLoadMoreFields?: () => void;
  dataSources: readonly OpenViewDataSource[];
  canWrite: boolean;
  canReadHistory: boolean;
  onChanged: (message: string) => void;
  onEditingChange: (editing: boolean) => void;
};

type LiveRecordInspectorProps = {
  region: WorkspaceRegion | undefined;
  /** The sheet header's place for Edit and the record menu. */
  actionsSlot: HTMLElement | null;
  /** Items the record menu always holds (Copy link). */
  menuItems: ReactNode;
  controls?: RecordControls;
  record: OpenViewRecord | null;
  recordLoading: boolean;
  recordError: string;
  inspectionLoading: boolean;
  inspectionError: string;
  fields: readonly OpenViewDataSourceField[];
  onRetryRecord: () => void;
};

function readableValue(value: unknown): string {
  if (typeof value === "string") return value.trim() ? value : "—";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return "—";
}

/** When a record last changed, for the sheet's meta line. */
export function recordUpdatedDate(
  value: string,
  region: WorkspaceRegion | undefined,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Date unavailable";
  return region ? formatWorkspaceDate(value, region) : "Date unavailable";
}

/** A record's name: its primary field, else the view's first field. */
export function recordTitle(
  record: OpenViewRecord,
  fields: readonly OpenViewDataSourceField[],
  primaryFieldId: string | null,
): string {
  const primaryField =
    fields.find((field) => field.id === primaryFieldId) ?? fields[0];
  return primaryField
    ? readableValue(openViewRecordFieldValue(record, primaryField))
    : `Record ${record.id.slice(0, 8)}`;
}

/**
 * The record sheet's body (OD7): the Details, Linked records, Files, and
 * History tabs, with only the open tab scrolling. The sheet header, which
 * the workspace owns, holds the name, Previous and Next, and Close; Edit and
 * the record menu render into it through `actionsSlot`.
 */
export function LiveRecordInspector({
  region,
  actionsSlot,
  menuItems,
  record,
  recordLoading,
  recordError,
  inspectionLoading,
  inspectionError,
  fields,
  onRetryRecord,
  controls,
}: LiveRecordInspectorProps) {
  const details = record ? (
    fields.length > 0 ? (
      <dl className="divide-y">
        {fields.map((field) => (
          <div
            key={field.id}
            className="grid min-w-0 gap-1 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center sm:gap-4"
          >
            <dt className="text-muted-foreground text-sm">{field.name}</dt>
            <dd className="min-w-0 text-sm wrap-anywhere">
              {/* One date format and people in ink, as in the table (OD6). */}
              <RecordPersonCard row={record} field={field} inline>
                {formatOpenViewFieldValue(
                  openViewRecordFieldValue(record, field),
                  field.type,
                  region,
                )}
              </RecordPersonCard>
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

  const status = (
    <>
      {inspectionLoading ? (
        <p role="status" className="text-muted-foreground px-5 pt-3 text-sm">
          Loading adjacent records…
        </p>
      ) : null}
      {inspectionError ? (
        <p role="alert" className="text-destructive px-5 pt-3 text-sm">
          {inspectionError}
        </p>
      ) : null}
    </>
  );
  const panelClassName = "min-h-0 flex-1 overflow-y-auto px-5 py-3";
  return (
    <section
      aria-label="Record details content"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {status}
      {record ? (
        controls ? (
          <Tabs defaultValue="details" className="min-h-0 flex-1 gap-0">
            <div className="shrink-0 border-b px-5 py-3">
              <TabsList
                aria-label="Record sections"
                className="max-w-full flex-nowrap justify-start overflow-x-auto"
              >
                <TabsTrigger
                  value="details"
                  className="min-h-11 shrink-0 xl:min-h-8"
                >
                  Details
                </TabsTrigger>
                <TabsTrigger
                  value="links"
                  className="min-h-11 shrink-0 xl:min-h-8"
                >
                  Linked records
                </TabsTrigger>
                <TabsTrigger
                  value="files"
                  className="min-h-11 shrink-0 xl:min-h-8"
                >
                  Files
                </TabsTrigger>
                {controls.canReadHistory ? (
                  <TabsTrigger
                    value="history"
                    className="min-h-11 shrink-0 xl:min-h-8"
                  >
                    History
                  </TabsTrigger>
                ) : null}
              </TabsList>
            </div>
            <TabsContent value="details" className={panelClassName} keepMounted>
              <RecordDetailsControls
                key={record.id}
                record={record}
                moduleId={controls.moduleId}
                fields={controls.editableFields}
                fieldsHasMore={controls.fieldsHasMore}
                fieldsLoadingMore={controls.fieldsLoadingMore}
                onLoadMoreFields={controls.onLoadMoreFields}
                canWrite={controls.canWrite}
                onChanged={controls.onChanged}
                onEditingChange={controls.onEditingChange}
                actionsSlot={actionsSlot}
                menuItems={menuItems}
              >
                {details}
              </RecordDetailsControls>
            </TabsContent>
            <TabsContent value="links" className={panelClassName}>
              <RecordLinksPanel
                key={record.id}
                record={record}
                dataSources={controls.dataSources}
                canWrite={controls.canWrite}
                onChanged={controls.onChanged}
              />
            </TabsContent>
            <TabsContent value="files" className={panelClassName}>
              <RecordFilesPanel
                key={record.id}
                record={record}
                canWrite={controls.canWrite}
                region={region}
              />
            </TabsContent>
            {controls.canReadHistory ? (
              <TabsContent value="history" className={panelClassName}>
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
          <div className={panelClassName}>{details}</div>
        )
      ) : recordError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
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
        <p role="status" className="text-muted-foreground px-5 py-6 text-sm">
          Loading linked record…
        </p>
      ) : (
        <Empty className="px-5 py-6">
          <EmptyHeader>
            <EmptyTitle>This record is unavailable</EmptyTitle>
            <EmptyDescription>
              The record may have been removed or may not be visible to you.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </section>
  );
}
