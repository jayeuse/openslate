"use client";
import { RecordPersonCard } from "./live-record-cards";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { GripVertical } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PaginationControls } from "@/components/ui/pagination-controls";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatWorkspaceDate, type WorkspaceRegion } from "@/lib/date-time";
import {
  queryOpenViewGroupedRecords,
  type OpenViewGroupSelector,
} from "../adapters/analytics-api";
import type {
  OpenViewDataSourceField,
  OpenViewQueryDefinition,
  OpenViewRecord,
} from "../adapters/views-api";
import { openViewRecordFieldValue } from "../domain/record-display";
import { selectOptions } from "../domain/record-form";
import type { RecordInspectionPage } from "./live-record-inspector";
import type { PendingRecordMove } from "../domain/record-moves";

const GROUP_PAGE_SIZE = 12;
const RECORD_PAGE_SIZE = 25;

type GroupedPage = Awaited<ReturnType<typeof queryOpenViewGroupedRecords>>;

type MoveTarget = {
  value: string | boolean | null;
  label: string;
  count: number | null;
};

type LiveKanbanProps = {
  region: WorkspaceRegion | undefined;
  moduleId: string;
  definition: OpenViewQueryDefinition;
  refreshKey?: number;
  groupByField: OpenViewDataSourceField;
  fields: readonly OpenViewDataSourceField[];
  primaryFieldId: string | null;
  secondaryFieldId: string | null;
  onOpenRecord: (recordId: string, page: RecordInspectionPage) => void;
  canWrite: boolean;
  movesPending: boolean;
  pendingMoves: ReadonlyMap<string, PendingRecordMove>;
  onMoveRecord: (
    record: OpenViewRecord,
    field: OpenViewDataSourceField,
    value: MoveTarget["value"],
    targetLabel: string,
  ) => void;
};

type RequestSnapshot = {
  key: string;
  page: GroupedPage | null;
  loading: boolean;
  error: string;
};

function selectorForValue(value: string | null): OpenViewGroupSelector {
  return value === null ? { kind: "unspecified" } : { kind: "value", value };
}

function groupKey(group: OpenViewGroupSelector | null): string {
  if (group === null) return "none";
  return group.kind === "unspecified" ? "unspecified" : `value:${group.value}`;
}

function groupLabel(value: string | null, label: string): string {
  if (value === null) return "Unspecified";
  if (value === "") return "Blank value";
  return label;
}

function moveTargetKey(value: MoveTarget["value"]): string {
  return groupKey(selectorForValue(value === null ? null : String(value)));
}

function KanbanLaneButton({
  label,
  value,
  count,
  active,
  canMove,
  onSelect,
}: {
  label: string;
  value: string | null;
  count: number | null;
  active: boolean;
  canMove: boolean;
  onSelect: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `lane:${groupKey(selectorForValue(value))}`,
    disabled: !canMove,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      aria-pressed={active}
      aria-label={`${label}, ${count === null ? "count not loaded" : `${count} records`}`}
      className={cn(
        "focus-visible:ring-ring flex min-h-11 w-full min-w-0 items-center justify-between gap-3 rounded-[var(--radius)] border px-3 py-2 text-left focus-visible:ring-2",
        active
          ? "border-primary bg-primary/5"
          : "bg-background hover:bg-muted/50",
        isOver && "border-primary bg-primary/10 ring-primary ring-2",
      )}
      onClick={onSelect}
    >
      <span className="truncate font-medium">{label}</span>
      <span className="text-muted-foreground shrink-0 text-sm">
        {count ?? "—"}
      </span>
    </button>
  );
}

function valueText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return "—";
}

function dateText(value: string, region: WorkspaceRegion | undefined): string {
  return region ? formatWorkspaceDate(value, region) : "Date unavailable";
}

function KanbanMemberCards({
  region,
  rows,
  fields,
  primaryFieldId,
  secondaryFieldId,
  listLabel = "Kanban lane records",
  onOpenRecord,
  pendingMoves,
  moveTargets,
  showMoveControls,
  movesPending,
  onMoveRecord,
}: {
  rows: readonly OpenViewRecord[];
  region: WorkspaceRegion | undefined;
  fields: readonly OpenViewDataSourceField[];
  primaryFieldId: string | null;
  secondaryFieldId: string | null;
  listLabel?: string;
  onOpenRecord: (recordId: string) => void;
  pendingMoves: ReadonlyMap<string, PendingRecordMove>;
  moveTargets: readonly MoveTarget[];
  showMoveControls: boolean;
  movesPending: boolean;
  onMoveRecord: (record: OpenViewRecord, target: MoveTarget) => void;
}) {
  const primaryField =
    fields.find((field) => field.id === primaryFieldId) ?? fields[0];
  const secondaryField = fields.find(
    (field) => field.id === secondaryFieldId && field.id !== primaryField?.id,
  );
  const detailFields = fields.filter(
    (field) => field.id !== primaryField?.id && field.id !== secondaryField?.id,
  );

  return (
    <ul
      aria-label={listLabel}
      className="grid min-w-0 grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3"
    >
      {rows.map((row) => {
        const title = primaryField
          ? valueText(openViewRecordFieldValue(row, primaryField))
          : "Untitled record";
        return (
          <li key={row.id} className="min-w-0">
            <KanbanCard
              row={row}
              title={title}
              pending={pendingMoves.get(row.id)}
              moveTargets={moveTargets}
              showMoveControls={showMoveControls}
              movesPending={movesPending}
              onMoveRecord={onMoveRecord}
              onOpenRecord={() => onOpenRecord(row.id)}
            >
              <header className="min-w-0">
                <h3 className="font-semibold">
                  <button
                    type="button"
                    aria-label={`Open record: ${title}`}
                    className="text-primary focus-visible:ring-ring min-h-11 max-w-full min-w-11 text-left underline-offset-4 hover:underline focus-visible:ring-2"
                    onClick={() => onOpenRecord(row.id)}
                  >
                    <span className="block truncate">
                      {primaryField?.type === "user" ? "Open record" : title}
                    </span>
                  </button>
                </h3>
                {primaryField?.type === "user" ? (
                  <RecordPersonCard row={row} field={primaryField}>
                    {title}
                  </RecordPersonCard>
                ) : null}
                {secondaryField ? (
                  <p className="text-muted-foreground mt-1 text-sm break-words">
                    {secondaryField.name}:{" "}
                    <RecordPersonCard row={row} field={secondaryField}>
                      {valueText(openViewRecordFieldValue(row, secondaryField))}
                    </RecordPersonCard>
                  </p>
                ) : null}
              </header>
              {detailFields.length ? (
                <dl className="grid min-w-0 gap-3 text-sm">
                  {detailFields.map((field) => (
                    <div key={field.id} className="min-w-0">
                      <dt className="text-muted-foreground truncate">
                        {field.name}
                      </dt>
                      <dd className="break-words">
                        <RecordPersonCard row={row} field={field}>
                          {valueText(openViewRecordFieldValue(row, field))}
                        </RecordPersonCard>
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              <p className="text-muted-foreground mt-auto text-xs">
                Updated{" "}
                <time dateTime={row.updatedAt}>
                  {dateText(row.updatedAt, region)}
                </time>
              </p>
            </KanbanCard>
          </li>
        );
      })}
    </ul>
  );
}

function KanbanCard({
  row,
  title,
  pending,
  moveTargets,
  showMoveControls,
  movesPending,
  onMoveRecord,
  onOpenRecord,
  children,
}: {
  row: OpenViewRecord;
  title: string;
  pending: PendingRecordMove | undefined;
  moveTargets: readonly MoveTarget[];
  showMoveControls: boolean;
  movesPending: boolean;
  onMoveRecord: (record: OpenViewRecord, target: MoveTarget) => void;
  onOpenRecord: () => void;
  children: React.ReactNode;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    isDragging,
    transform,
  } = useDraggable({
    id: row.id,
    disabled: !showMoveControls || movesPending || row.isDeleted,
  });
  const errorId = `kanban-move-error-${row.id}`;
  return (
    <article
      ref={setNodeRef}
      className={cn(
        "relative flex h-full min-w-0 flex-col gap-3 rounded-[var(--radius)] border p-4",
        pending ? "bg-muted/50 border-dashed" : "bg-background",
        pending?.error && "border-destructive",
        isDragging && "z-50 shadow-lg",
      )}
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
          : undefined
      }
    >
      {children}
      {pending ? (
        <div className="text-sm">
          <p className="text-muted-foreground">
            Unsaved move to {pending.targetLabel}
          </p>
          {pending.error ? (
            <p id={errorId} className="text-destructive mt-1">
              {pending.error}
            </p>
          ) : null}
          {pending.status === "stale" ? (
            <Button
              type="button"
              variant="outline"
              className="mt-2 min-h-11"
              disabled={movesPending}
              onClick={onOpenRecord}
            >
              Review latest
            </Button>
          ) : null}
        </div>
      ) : null}
      {showMoveControls && !row.isDeleted ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button
            ref={setActivatorNodeRef}
            type="button"
            variant="ghost"
            className="min-h-11 min-w-11 cursor-grab touch-none active:cursor-grabbing"
            {...attributes}
            {...listeners}
            aria-label={`Drag record: ${title}`}
            aria-describedby={
              pending?.error
                ? `${attributes["aria-describedby"]} ${errorId}`
                : attributes["aria-describedby"]
            }
            disabled={movesPending}
          >
            <GripVertical aria-hidden="true" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={movesPending}
                  aria-describedby={pending?.error ? errorId : undefined}
                >
                  Move to…
                </Button>
              }
            />
            <DropdownMenuContent className="max-h-80 overflow-y-auto">
              {moveTargets.map((target) => (
                <DropdownMenuItem
                  key={moveTargetKey(target.value)}
                  className="min-h-11"
                  onClick={() => onMoveRecord(row, target)}
                >
                  {target.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </article>
  );
}

export function LiveKanban({
  region,
  moduleId,
  definition,
  refreshKey = 0,
  groupByField,
  fields,
  primaryFieldId,
  secondaryFieldId,
  onOpenRecord,
  canWrite,
  movesPending,
  pendingMoves,
  onMoveRecord,
}: LiveKanbanProps) {
  const groupByFieldId = groupByField.id;
  const groupByFieldType = groupByField.type;
  const [groupOffset, setGroupOffset] = useState(0);
  const [selectedGroup, setSelectedGroup] =
    useState<OpenViewGroupSelector | null>(null);
  const [recordOffset, setRecordOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const requestSequence = useRef(0);
  const lastGoodPage = useRef<GroupedPage | null>(null);
  const requestKey = useMemo(
    () =>
      JSON.stringify({
        moduleId,
        definition,
        groupByFieldId,
        groupByFieldType,
        groupOffset,
        selectedGroup: groupKey(selectedGroup),
        recordOffset,
        retry,
        refreshKey,
      }),
    [
      definition,
      groupByFieldId,
      groupByFieldType,
      groupOffset,
      moduleId,
      recordOffset,
      refreshKey,
      retry,
      selectedGroup,
    ],
  );
  const [snapshot, setSnapshot] = useState<RequestSnapshot | null>(null);

  useEffect(() => {
    const request = ++requestSequence.current;
    setSnapshot({ key: requestKey, page: null, loading: true, error: "" });
    void queryOpenViewGroupedRecords({
      moduleId,
      definition,
      groupBy: { fieldId: groupByFieldId, expectedType: groupByFieldType },
      limit: RECORD_PAGE_SIZE,
      offset: recordOffset,
      groupLimit: GROUP_PAGE_SIZE,
      groupOffset,
      selectedGroup,
    })
      .then((page) => {
        if (request !== requestSequence.current) return;
        lastGoodPage.current = page;
        setSnapshot({ key: requestKey, page, loading: false, error: "" });
      })
      .catch((error: unknown) => {
        if (request !== requestSequence.current) return;
        const denied =
          error instanceof ApiError && [401, 403].includes(error.status);
        if (denied) lastGoodPage.current = null;
        setSnapshot({
          key: requestKey,
          page: denied ? null : lastGoodPage.current,
          loading: false,
          error: denied
            ? "You no longer have access to these records. Sign in or ask for access, then retry."
            : apiErrorMessage(error, "Kanban lanes could not be loaded."),
        });
      });
    return () => {
      requestSequence.current += 1;
    };
  }, [
    definition,
    groupByFieldId,
    groupByFieldType,
    groupOffset,
    moduleId,
    recordOffset,
    refreshKey,
    requestKey,
    selectedGroup,
  ]);

  const currentSnapshot = snapshot?.key === requestKey ? snapshot : null;
  const page = currentSnapshot?.page ?? null;
  const groups = page?.groups ?? [];
  const groupPagination = page?.groupPagination;
  const selectedGroupKey = groupKey(selectedGroup);
  const memberPage =
    page && groupKey(page.selectedGroup) === selectedGroupKey ? page : null;
  const recordPagination = memberPage?.pagination;
  const groupStart =
    groupPagination && groupPagination.count > 0
      ? groupPagination.offset + 1
      : 0;
  const groupEnd = groupPagination
    ? groupPagination.offset + groupPagination.count
    : 0;
  const recordStart =
    recordPagination && recordPagination.count > 0
      ? recordPagination.offset + 1
      : 0;
  const recordEnd = recordPagination
    ? recordPagination.offset + recordPagination.count
    : 0;
  const groupRange = groupPagination
    ? groupPagination.total === 0
      ? "No lanes"
      : `Lanes ${groupStart}–${groupEnd} of ${groupPagination.total}`
    : "Lane page unavailable";
  const recordRange = recordPagination
    ? recordPagination.total === 0
      ? "No records in this lane."
      : `Showing ${recordStart}–${recordEnd} of ${recordPagination.total} records`
    : selectedGroup
      ? "Lane records unavailable."
      : "Select a lane to load its records.";
  const selectedGroupDetails = groups.find(
    (group) => groupKey(selectorForValue(group.value)) === selectedGroupKey,
  );
  const loading = currentSnapshot === null || currentSnapshot.loading;
  const requestError = currentSnapshot?.error ?? "";
  const editableLane = ["select", "user", "boolean"].includes(groupByFieldType);
  const showMoveControls = canWrite && editableLane && page !== null;
  const canMove = showMoveControls && !movesPending;
  const configuredTargets: Array<Pick<MoveTarget, "value" | "label">> =
    groupByFieldType === "select"
      ? selectOptions(groupByField).map((option) => ({
          value: option.id,
          label: option.label,
        }))
      : groupByFieldType === "boolean"
        ? [
            { value: false, label: "No" },
            { value: true, label: "Yes" },
          ]
        : groups
            .filter((group) => group.value !== null)
            .map((group) => ({ value: group.value, label: group.label }));
  const moveTargets: MoveTarget[] = [
    ...configuredTargets,
    { value: null, label: "Unspecified" },
  ].map((target) => ({
    ...target,
    count:
      groups.find(
        (group) => moveTargetKey(group.value) === moveTargetKey(target.value),
      )?.count ??
      (groupPagination?.offset === 0 && !groupPagination.hasMore ? 0 : null),
  }));
  const additionalTargets = moveTargets.filter(
    (target) =>
      !groups.some(
        (group) => moveTargetKey(group.value) === moveTargetKey(target.value),
      ),
  );
  const keyboardLane = useRef<string | null>(null);
  const keyboardCoordinates: KeyboardCoordinateGetter = (
    event,
    { currentCoordinates, context },
  ) => {
    const direction = ["ArrowRight", "ArrowDown"].includes(event.code)
      ? 1
      : ["ArrowLeft", "ArrowUp"].includes(event.code)
        ? -1
        : 0;
    if (!direction || !context.collisionRect) return;
    const enabled = moveTargets
      .map((target) => `lane:${moveTargetKey(target.value)}`)
      .filter((target) => {
        const container = context.droppableContainers.get(target);
        return (
          container && !container.disabled && context.droppableRects.has(target)
        );
      });
    if (enabled.length === 0) return;
    const current = Math.max(0, enabled.indexOf(keyboardLane.current ?? ""));
    const next =
      enabled[(current + direction + enabled.length) % enabled.length];
    const rect = context.droppableRects.get(next);
    if (!rect) return;
    keyboardLane.current = next;
    return {
      x:
        currentCoordinates.x +
        rect.left +
        rect.width / 2 -
        context.collisionRect.left -
        context.collisionRect.width / 2,
      y:
        currentCoordinates.y +
        rect.top +
        rect.height / 2 -
        context.collisionRect.top -
        context.collisionRect.height / 2,
    };
  };
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: keyboardCoordinates,
      scrollBehavior: "auto",
    }),
  );
  const recordTitle = (recordId: string | number) => {
    const row =
      memberPage?.items.find((record) => record.id === recordId) ??
      pendingMoves.get(String(recordId))?.original;
    const field =
      fields.find((candidate) => candidate.id === primaryFieldId) ?? fields[0];
    return row && field
      ? valueText(openViewRecordFieldValue(row, field))
      : "record";
  };
  const targetForId = (targetId: string | number | undefined) =>
    moveTargets.find(
      (target) => `lane:${moveTargetKey(target.value)}` === targetId,
    );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={(args) =>
        args.pointerCoordinates ? pointerWithin(args) : closestCenter(args)
      }
      onDragStart={({ active }) => {
        const row = memberPage?.items.find((record) => record.id === active.id);
        const value = row?.data[groupByFieldId];
        keyboardLane.current = `lane:${moveTargetKey(typeof value === "string" || typeof value === "boolean" ? value : null)}`;
      }}
      onDragEnd={({ active, over }) => {
        keyboardLane.current = null;
        if (!canMove || !over) return;
        const record = memberPage?.items.find((row) => row.id === active.id);
        const target = targetForId(over.id);
        if (record && target)
          onMoveRecord(record, groupByField, target.value, target.label);
      }}
      onDragCancel={() => {
        keyboardLane.current = null;
      }}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Press Space or Enter to pick up a record. Use the arrow keys to choose a lane, then Space or Enter to drop. Escape cancels. You can also use the Move to menu. Save changes applies your moves.",
        },
        announcements: {
          onDragStart: ({ active }) =>
            `Picked up ${recordTitle(active.id)}. Choose a lane.`,
          onDragOver: ({ active, over }) =>
            over
              ? `${recordTitle(active.id)} is over ${targetForId(over.id)?.label ?? "a lane"}.`
              : "No lane selected.",
          onDragEnd: ({ active, over }) =>
            over
              ? `Dropped ${recordTitle(active.id)} on ${targetForId(over.id)?.label ?? "a lane"}. Review your unsaved moves before saving.`
              : "Move cancelled.",
          onDragCancel: () => "Move cancelled.",
        },
      }}
    >
      <Card
        aria-label="Kanban results"
        className="min-w-0 self-auto overflow-hidden"
      >
        <div
          data-slot="card-header"
          className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3"
        >
          <div>
            <h2 data-slot="section-title" className="font-medium">
              Kanban lanes
            </h2>
            <p className="text-muted-foreground text-sm">
              Lane counts are from the server. Records load only for the
              selected lane.
              {showMoveControls
                ? " Drag a card to a lane or use Move to…. Save changes applies the moves."
                : ""}
            </p>
          </div>
          <p aria-live="polite" className="text-muted-foreground text-sm">
            {loading
              ? "Loading lanes…"
              : groupPagination
                ? groupRange
                : "Lanes unavailable"}
          </p>
        </div>

        {requestError ? (
          <Alert
            variant="destructive"
            className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3"
          >
            <p>
              {requestError} The last successful page remains visible when
              available.
            </p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setRetry((value) => value + 1)}
            >
              {selectedGroup ? "Retry lane records" : "Retry lanes"}
            </Button>
          </Alert>
        ) : null}

        {loading && groups.length === 0 ? (
          <p
            role="status"
            className="text-muted-foreground px-4 py-8 text-center"
          >
            Loading lanes…
          </p>
        ) : groups.length === 0 ? (
          <p
            role={requestError ? "status" : undefined}
            className="text-muted-foreground px-4 py-8 text-center"
          >
            {requestError
              ? "Lane results are unavailable until the request succeeds."
              : "No lanes match this view."}
          </p>
        ) : (
          <ul
            aria-label="Kanban lanes"
            className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          >
            {groups.map((group) => {
              const selector = selectorForValue(group.value);
              const label = groupLabel(group.value, group.label);
              const active = groupKey(selector) === selectedGroupKey;
              return (
                <li key={groupKey(selector)} className="min-w-0">
                  <KanbanLaneButton
                    label={label}
                    value={group.value}
                    count={group.count}
                    active={active}
                    canMove={
                      canMove &&
                      moveTargets.some(
                        (target) =>
                          moveTargetKey(target.value) === groupKey(selector),
                      )
                    }
                    onSelect={() => {
                      setSelectedGroup(selector);
                      setRecordOffset(0);
                    }}
                  />
                </li>
              );
            })}
          </ul>
        )}
        {showMoveControls && additionalTargets.length > 0 ? (
          <section
            aria-label="Additional move targets"
            className="border-t p-3"
          >
            <p className="text-muted-foreground mb-2 text-sm">
              Other move targets. Counts not on this page show “—”.
            </p>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {additionalTargets.map((target) => (
                <li key={moveTargetKey(target.value)} className="min-w-0">
                  <KanbanLaneButton
                    label={target.label}
                    value={target.value === null ? null : String(target.value)}
                    count={target.count}
                    active={moveTargetKey(target.value) === selectedGroupKey}
                    canMove={canMove}
                    onSelect={() => {
                      setSelectedGroup(
                        selectorForValue(
                          target.value === null ? null : String(target.value),
                        ),
                      );
                      setRecordOffset(0);
                    }}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
          <p aria-live="polite" className="text-muted-foreground text-sm">
            {groupRange}
          </p>
          {!loading && !requestError && groupPagination ? (
            <PaginationControls
              ariaLabel="Kanban lane pages"
              className="w-auto justify-end"
              pageCount={Math.max(
                1,
                Math.ceil(groupPagination.total / groupPagination.limit),
              )}
              pageIndex={Math.floor(
                groupPagination.offset / groupPagination.limit,
              )}
              onPageIndexChange={(nextPage) => {
                const pageIndex = Math.floor(
                  groupPagination.offset / groupPagination.limit,
                );
                if (nextPage === pageIndex) return;
                setGroupOffset(nextPage * groupPagination.limit);
                setSelectedGroup(null);
                setRecordOffset(0);
              }}
            />
          ) : null}
        </div>

        {selectedGroup ? (
          <section
            aria-label={`${selectedGroupDetails ? groupLabel(selectedGroupDetails.value, selectedGroupDetails.label) : "Selected"} lane records`}
            className="border-t"
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
              <div>
                <h2 data-slot="section-title" className="font-medium">
                  {selectedGroupDetails
                    ? groupLabel(
                        selectedGroupDetails.value,
                        selectedGroupDetails.label,
                      )
                    : "Selected lane"}
                </h2>
                <p className="text-muted-foreground text-sm">
                  {selectedGroupDetails?.count ?? recordPagination?.total ?? 0}{" "}
                  records in this lane
                </p>
              </div>
              <p aria-live="polite" className="text-muted-foreground text-sm">
                {loading
                  ? "Loading lane records…"
                  : recordPagination
                    ? recordRange
                    : "Lane records unavailable"}
              </p>
            </div>

            {requestError && !memberPage ? (
              <p
                role="status"
                className="text-muted-foreground px-4 py-8 text-center"
              >
                Lane records could not be loaded. Use the retry action above.
              </p>
            ) : (
              <>
                {requestError ? (
                  <p role="status" className="text-muted-foreground px-4 py-3">
                    Showing the last successfully loaded page for this lane.
                  </p>
                ) : null}
                {loading ? (
                  <p
                    role="status"
                    className="text-muted-foreground px-4 py-8 text-center"
                  >
                    Loading selected lane records…
                  </p>
                ) : memberPage?.items.length ? (
                  <KanbanMemberCards
                    region={region}
                    rows={memberPage.items}
                    fields={fields}
                    primaryFieldId={primaryFieldId}
                    secondaryFieldId={secondaryFieldId}
                    pendingMoves={pendingMoves}
                    moveTargets={moveTargets}
                    showMoveControls={showMoveControls}
                    movesPending={movesPending}
                    onMoveRecord={(record, target) =>
                      onMoveRecord(
                        record,
                        groupByField,
                        target.value,
                        target.label,
                      )
                    }
                    onOpenRecord={(recordId) => {
                      if (!recordPagination || !selectedGroup) return;
                      onOpenRecord(recordId, {
                        rows: memberPage.items,
                        offset: recordPagination.offset,
                        total: recordPagination.total,
                        source: {
                          kind: "records",
                          group: {
                            fieldId: groupByFieldId,
                            fieldType: groupByFieldType,
                            selected: selectedGroup,
                            offset: groupOffset,
                          },
                          returnToPage: setRecordOffset,
                        },
                      });
                    }}
                  />
                ) : (
                  <p className="text-muted-foreground px-4 py-8 text-center">
                    No records in this lane.
                  </p>
                )}
              </>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
              <p aria-live="polite" className="text-muted-foreground text-sm">
                {recordRange}
              </p>
              {!loading && !requestError && recordPagination ? (
                <PaginationControls
                  ariaLabel="Kanban lane record pages"
                  className="w-auto justify-end"
                  pageCount={Math.max(
                    1,
                    Math.ceil(recordPagination.total / recordPagination.limit),
                  )}
                  pageIndex={Math.floor(
                    recordPagination.offset / recordPagination.limit,
                  )}
                  onPageIndexChange={(nextPage) => {
                    setRecordOffset(nextPage * recordPagination.limit);
                  }}
                />
              ) : null}
            </div>
          </section>
        ) : null}
      </Card>
    </DndContext>
  );
}
