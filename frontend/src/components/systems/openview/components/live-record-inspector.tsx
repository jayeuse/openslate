"use client";

import type { ReactNode } from "react";
import type {
  OpenViewDataSourceField,
  OpenViewPresentation,
  OpenViewRecord,
} from "../adapters/views-api";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { LiveRecordCards } from "./live-record-cards";

type InspectorPresentation = Pick<
  OpenViewPresentation,
  "primaryFieldId" | "secondaryFieldId" | "cardSize" | "wrap"
>;

type LiveRecordInspectorProps = {
  actions: ReactNode;
  record: OpenViewRecord | null;
  recordLoading: boolean;
  recordError: string;
  inspectionLoading: boolean;
  inspectionError: string;
  fields: readonly OpenViewDataSourceField[];
  presentation: InspectorPresentation;
  onOpenRecord: (recordId: string) => void;
  onRetryRecord: () => void;
};

export function LiveRecordInspector({
  actions,
  record,
  recordLoading,
  recordError,
  inspectionLoading,
  inspectionError,
  fields,
  presentation,
  onOpenRecord,
  onRetryRecord,
}: LiveRecordInspectorProps) {
  return (
    <section
      aria-label="Linked record"
      className="bg-card min-w-0 overflow-hidden rounded-[var(--radius)] border"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <h2 className="font-medium">Linked record</h2>
        {actions}
      </div>
      {inspectionLoading ? (
        <p role="status" className="text-muted-foreground px-4 py-2 text-sm">
          Loading adjacent records…
        </p>
      ) : null}
      {inspectionError ? (
        <p role="alert" className="text-destructive px-4 py-2 text-sm">
          {inspectionError}
        </p>
      ) : null}
      {record ? (
        <LiveRecordCards
          layout="gallery"
          rows={[record]}
          fields={fields}
          primaryFieldId={presentation.primaryFieldId}
          secondaryFieldId={presentation.secondaryFieldId}
          cardSize={presentation.cardSize}
          wrap={presentation.wrap}
          onOpenRecord={onOpenRecord}
        />
      ) : recordError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
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
        <p role="status" className="text-muted-foreground px-4 py-6 text-sm">
          Loading linked record…
        </p>
      ) : (
        <Empty>
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
