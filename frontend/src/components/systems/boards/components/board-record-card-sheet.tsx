"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, FileText, Lock, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  authMeOptions,
  catalogFirstPageOptions,
  dataSourceOptions,
  fieldsFirstPageOptions,
} from "@/components/systems/openview/adapters/openview-queries";
import { openViewLevel } from "@/components/systems/openview/domain/manage-access";
import { useOpenViewDepartmentNames } from "@/components/systems/openview/hooks/use-openview-catalog";
import {
  LiveRecordInspector,
  recordTitle,
  recordUpdatedDate,
} from "@/components/systems/shared/components/record-sheet";
import type { WorkspaceRegion } from "@/lib/date-time";
import { readCardRecord } from "../adapters/board-card-sheet-api";
import { kanbanKeys } from "../adapters/board-kanban-queries";
import type {
  KanbanLabel,
  KanbanRecord,
  KanbanStage,
} from "../adapters/board-kanban-schemas";
import {
  AssigneeRow,
  DateRow,
  LabelsRow,
  StageRow,
  type CardFieldContext,
} from "./board-card-fields";
import type { KanbanPerson } from "./board-kanban-card";

type LiveRecord = Extract<KanbanRecord, { locked: false }>;

/**
 * A record card's sheet (BR64, BR83): the shared OpenView record sheet with
 * one tab first, "On this board", for the card's own stage, dates, labels,
 * assignee and Archive card. Nothing in that tab changes the record (BR79);
 * the record's own tabs, Edit and files are the record's, as in OpenView.
 */
export function RecordCardSheetBody({
  boardId,
  record,
  context,
  stages,
  labels,
  labelMap,
  people,
  region,
  moving,
  copyLink,
  feedback,
  onMove,
  onArchive,
  onClose,
  onEditingChange,
}: {
  boardId: string;
  record: LiveRecord;
  context: CardFieldContext;
  stages: readonly KanbanStage[];
  labels: readonly KanbanLabel[];
  labelMap: ReadonlyMap<string, KanbanLabel>;
  people: ReadonlyMap<string, KanbanPerson>;
  region: WorkspaceRegion;
  moving: boolean;
  copyLink: ReactNode;
  /** The sheet's save announcements and refusals. */
  feedback: ReactNode;
  onMove: (stage: KanbanStage) => void;
  onArchive: () => void;
  onClose: () => void;
  onEditingChange: (editing: boolean) => void;
}) {
  const client = useQueryClient();
  const card = context.sheet.card;
  const recordKey = [...kanbanKeys.card(boardId, card.id), "record"];
  const read = useQuery({
    queryKey: recordKey,
    queryFn: ({ signal }) => readCardRecord(record.recordId, signal),
    staleTime: 0,
  });
  const source = useQuery(dataSourceOptions(record.moduleId));
  const fields = useQuery(fieldsFirstPageOptions(record.moduleId));
  const catalog = useQuery(catalogFirstPageOptions());
  const identity = useQuery(authMeOptions());
  const departmentId = source.data?.departmentId ?? "";
  const departmentName = useOpenViewDepartmentNames(
    departmentId ? [departmentId] : [],
  ).get(departmentId);
  const [editing, setEditing] = useState(false);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const level = departmentId
    ? openViewLevel(identity.data, departmentId, record.moduleId)
    : null;
  const canWriteRecord = level === "write" || level === "manage";
  const canReadHistory =
    departmentId !== "" &&
    openViewLevel(identity.data, departmentId) === "manage";
  const moduleFields = fields.data?.items ?? [];
  const loaded = read.data?.id === record.recordId ? read.data : null;
  const name = loaded
    ? recordTitle(loaded, moduleFields, source.data?.titleFieldId ?? null)
    : record.title;
  const moduleHref =
    `/openview?module=${record.moduleId}&record=${record.recordId}` as Route;

  const onThisBoard = (
    <div className="flex flex-col gap-4">
      {feedback}
      <div>
        <StageRow
          stageId={card.stageId}
          stages={stages}
          canWrite={context.canWrite}
          pending={moving}
          onMove={onMove}
        />
        <DateRow
          label="Card start"
          field="cardStart"
          value={card.startOn}
          context={context}
          onSave={(date) => context.model.save("cardStart", { startOn: date })}
        />
        <DateRow
          label="Card due"
          field="cardDue"
          value={card.dueOn}
          context={context}
          onSave={(date) => context.model.save("cardDue", { dueOn: date })}
        />
        <LabelsRow context={context} labels={labels} labelMap={labelMap} />
        <AssigneeRow context={context} people={people} />
      </div>
      <p className="bg-muted text-muted-foreground flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm">
        <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        Moving this card changes only the board, never the{" "}
        {record.moduleName.toLocaleLowerCase()} record.
      </p>
      {context.canWrite ? (
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 self-start xl:min-h-8"
          onClick={onArchive}
        >
          <Archive aria-hidden="true" data-icon="inline-start" />
          Archive card
        </Button>
      ) : null}
    </div>
  );

  return (
    <>
      <header className="flex shrink-0 flex-wrap items-start gap-x-3 gap-y-1 border-b p-5 pr-3 sm:flex-nowrap">
        <div className="order-2 min-w-0 flex-1 basis-full sm:order-none sm:basis-auto">
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <FileText aria-hidden="true" className="size-3.5" />
            {record.moduleName} · record card
          </p>
          <SheetTitle className="mt-1 text-lg leading-tight font-semibold wrap-anywhere">
            {name}
          </SheetTitle>
          <SheetDescription className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
            {record.status ? (
              <Badge variant="secondary">{record.status.value}</Badge>
            ) : null}
            <span>
              {[record.moduleName, departmentName].filter(Boolean).join(" · ")}
              {loaded ? (
                <>
                  {" · Updated "}
                  <time dateTime={loaded.updatedAt}>
                    {recordUpdatedDate(loaded.updatedAt, region)}
                  </time>
                </>
              ) : null}
            </span>
          </SheetDescription>
        </div>
        <div className="order-1 ml-auto flex shrink-0 items-center gap-1 sm:order-none sm:ml-0">
          {/* Edit and the record menu render here, as in OpenView. */}
          <div ref={setActionsSlot} className="flex items-center gap-1" />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label="Close card"
            disabled={editing}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </header>
      <LiveRecordInspector
        region={region}
        actionsSlot={actionsSlot}
        menuItems={
          <>
            {copyLink}
            <DropdownMenuItem
              className="min-h-11 xl:min-h-8"
              render={<Link href={moduleHref} />}
            >
              Open in {record.moduleName}
            </DropdownMenuItem>
          </>
        }
        record={loaded}
        recordLoading={read.isPending}
        recordError={read.isError ? "The record could not be loaded." : ""}
        inspectionLoading={false}
        inspectionError=""
        fields={moduleFields}
        onRetryRecord={() => void read.refetch()}
        leadingTab={{
          value: "board",
          label: "On this board",
          content: onThisBoard,
        }}
        controls={
          source.data
            ? {
                moduleId: record.moduleId,
                departmentId,
                editableFields: moduleFields,
                fieldsHasMore: fields.data?.pagination.hasMore ?? false,
                dataSources: catalog.data?.items ?? [],
                canWrite: canWriteRecord,
                canReadHistory,
                onChanged: () => {
                  void read.refetch();
                  // The card's summary (name, fields, status) follows.
                  void client.invalidateQueries({
                    queryKey: kanbanKeys.cards(boardId),
                  });
                },
                onEditingChange: (next) => {
                  setEditing(next);
                  onEditingChange(next);
                },
              }
            : undefined
        }
      />
    </>
  );
}
