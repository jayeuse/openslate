"use client";
import { RecordPersonCard } from "./live-record-cards";
import { useDisplayRegion } from "@/components/use-display-region";

import { useMemo, useRef, useState } from "react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { GripVertical, ArrowLeftRight } from "lucide-react";
import {
  daysInWindow,
  dateInTimezone,
  formatWindowDate,
  initialDateWindow,
  shiftDate,
  useWindowPage,
  validDateWindow,
  windowPageErrorMessage,
  WindowControls,
  WindowPageNavigation,
  DateMoveActions,
  PendingDateMove,
  type CalendarDateField,
  type LiveWindowBaseProps,
} from "./live-calendar";
import type { OpenViewWindowQueryRequest } from "../adapters/window-api";
import type { OpenViewDataSourceField } from "../adapters/views-api";
import {
  effectiveMoveRecord,
  moveDateValue,
  recordMoveDay,
  shiftMoveDay,
  validMoveInterval,
  type DateMoveProps,
} from "../domain/record-moves";
import { cn } from "@/lib/utils";
import { openViewRecordFieldValue } from "../domain/record-display";
import { formatOpenViewFieldValue } from "./live-record-cards";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

const PAGE_SIZE = 25;

function TimelineTrack({
  recordId,
  title,
  position,
  label,
  disabled,
  children,
}: {
  recordId: string;
  title: string;
  position: ReturnType<typeof intervalPosition>;
  label: string;
  disabled: boolean;
  children?: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `timeline-track:${recordId}`,
    disabled,
  });
  const {
    setNodeRef: setMoveRef,
    attributes: moveAttributes,
    listeners: moveListeners,
    transform: moveTransform,
  } = useDraggable({
    id: `timeline-shift:${recordId}`,
    disabled,
  });
  const {
    setNodeRef: setResizeRef,
    attributes: resizeAttributes,
    listeners: resizeListeners,
    transform: resizeTransform,
  } = useDraggable({
    id: `timeline-end:${recordId}`,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-label={`${title} timeline track`}
      className={cn(
        "relative min-h-11",
        isOver && "ring-primary rounded-[var(--radius)] ring-2",
      )}
    >
      <div
        role="img"
        aria-label={label}
        className="bg-muted absolute inset-x-0 top-4 h-3 overflow-hidden rounded-full"
      >
        {position ? (
          <span
            aria-hidden="true"
            className="bg-primary absolute inset-y-0 rounded-full"
            style={{ left: `${position.left}%`, width: `${position.width}%` }}
          />
        ) : null}
      </div>
      {position && !disabled ? (
        <>
          <Button
            ref={setMoveRef}
            {...moveAttributes}
            {...moveListeners}
            type="button"
            variant="ghost"
            aria-label={`Shift interval: ${title}`}
            className="bg-card/90 absolute top-0 min-h-11 w-11 min-w-11 cursor-grab border p-0"
            style={{
              left: `min(${position.left}%, calc(100% - 92px))`,
              transform: moveTransform
                ? `translateX(${moveTransform.x}px)`
                : undefined,
            }}
          >
            <GripVertical aria-hidden="true" />
          </Button>
          <Button
            ref={setResizeRef}
            {...resizeAttributes}
            {...resizeListeners}
            type="button"
            variant="ghost"
            aria-label={`Resize end: ${title}`}
            className="bg-card/90 absolute top-0 min-h-11 w-11 min-w-11 cursor-ew-resize border p-0"
            style={{
              left: `min(max(calc(${position.left + position.width}% - 44px), calc(${position.left}% + 48px)), calc(100% - 44px))`,
              transform: resizeTransform
                ? `translateX(${resizeTransform.x}px)`
                : undefined,
            }}
          >
            <ArrowLeftRight aria-hidden="true" />
          </Button>
        </>
      ) : null}
      {children}
    </div>
  );
}

type TimelineScope = "window" | "unscheduled";

function progressValue(
  value: unknown,
): { label: string; number: number } | null {
  if (typeof value === "number" && Number.isFinite(value))
    return { label: String(value), number: value };
  if (
    typeof value !== "string" ||
    !/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(value)
  )
    return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? { label: value, number: numeric } : null;
}

function intervalPosition(
  startValue: unknown,
  startField: CalendarDateField,
  endValue: unknown,
  endField: CalendarDateField,
  fromDate: string,
  toDate: string,
  timezone: string | null,
) {
  const startDay = dateInTimezone(startValue, startField.type, timezone);
  const endDay = dateInTimezone(endValue, endField.type, timezone);
  if (!startDay || !endDay || endDay < startDay) return null;

  const start = Date.parse(`${fromDate}T00:00:00.000Z`);
  const end = Date.parse(`${toDate}T00:00:00.000Z`);
  const taskStart = Date.parse(`${startDay}T00:00:00.000Z`);
  const taskEnd = Date.parse(`${endDay}T00:00:00.000Z`);
  const clippedStart = Math.max(start, taskStart);
  const clippedEnd = Math.min(end, taskEnd);
  if (clippedStart > clippedEnd) return null;
  const days = daysInWindow(fromDate, toDate);
  const left = (clippedStart - start) / 86_400_000;
  const width = (clippedEnd - clippedStart) / 86_400_000 + 1;
  return {
    left: (left / days) * 100,
    width: (width / days) * 100,
    startDay,
    endDay,
  };
}

export function LiveTimeline({
  region: workspaceRegion,
  moduleId,
  definition,
  dateRange,
  refreshKey = 0,
  startField,
  endField,
  deadlineField,
  progressField,
  titleField,
  detailFields,
  onOpenRecord,
  canWrite,
  movesPending,
  pendingMoves,
  onMoveDates,
}: LiveWindowBaseProps &
  DateMoveProps & {
    startField: CalendarDateField;
    endField: CalendarDateField;
    deadlineField: CalendarDateField | undefined;
    progressField: OpenViewDataSourceField | undefined;
    titleField: OpenViewDataSourceField | undefined;
    detailFields: readonly OpenViewDataSourceField[];
  }) {
  const [windowDates, setWindowDates] = useState(() =>
    initialDateWindow(dateRange),
  );
  const [scope, setScope] = useState<TimelineScope>("window");
  const [retry, setRetry] = useState(0);
  const [pagePosition, setPagePosition] = useState({ key: "", offset: 0 });
  const baseKey = JSON.stringify([
    moduleId,
    definition,
    startField.id,
    endField.id,
    deadlineField?.id,
    progressField?.id,
    scope,
    ...(scope === "window" ? [windowDates.start, windowDates.end] : []),
  ]);
  const offset = pagePosition.key === baseKey ? pagePosition.offset : 0;
  const request = useMemo<OpenViewWindowQueryRequest | null>(() => {
    if (
      !moduleId ||
      (scope === "window" &&
        !validDateWindow(windowDates.start, windowDates.end))
    )
      return null;
    const startFieldReference = {
      fieldId: startField.id,
      expectedType: startField.type,
    };
    const endFieldReference = {
      fieldId: endField.id,
      expectedType: endField.type,
    };
    if (scope === "window")
      return {
        moduleId,
        definition,
        mode: "timeline",
        scope: "window",
        startField: startFieldReference,
        endField: endFieldReference,
        fromDate: windowDates.start,
        toDate: windowDates.end,
        limit: PAGE_SIZE,
        offset,
      };
    return {
      moduleId,
      definition,
      mode: "timeline",
      scope: "unscheduled",
      startField: startFieldReference,
      endField: endFieldReference,
      limit: PAGE_SIZE,
      offset,
    };
  }, [
    definition,
    endField.id,
    endField.type,
    moduleId,
    offset,
    scope,
    startField.id,
    startField.type,
    windowDates.end,
    windowDates.start,
  ]);
  const { result, loading, error } = useWindowPage(request, retry + refreshKey);
  const region = useDisplayRegion(workspaceRegion);
  const timezone = result?.timezone ?? null;
  const windowRegion = useDisplayRegion(
    workspaceRegion
      ? { ...workspaceRegion, timezone: timezone ?? workspaceRegion.timezone }
      : undefined,
  );
  const moveTimezone =
    timezone ??
    (startField.type === "date" && endField.type === "date"
      ? (workspaceRegion?.timezone ?? null)
      : null);
  const canMove =
    canWrite &&
    !loading &&
    !error &&
    Boolean(result) &&
    Boolean(workspaceRegion);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
  );
  const startedDrag = useRef<string | null>(null);
  const dragStamp = JSON.stringify([
    baseKey,
    offset,
    refreshKey,
    timezone,
    workspaceRegion,
    canMove,
    movesPending,
  ]);
  const [moveError, setMoveError] = useState("");
  const openRow = (recordId: string) => {
    if (!request || !result) return;
    onOpenRecord(recordId, {
      rows: result.items,
      offset: result.pagination.offset,
      total: result.pagination.total,
      source: {
        kind: "window",
        request,
        returnToPage: (nextOffset) =>
          setPagePosition({ key: baseKey, offset: nextOffset }),
      },
    });
  };
  const changeScope = (next: TimelineScope) => {
    setScope(next);
    setPagePosition({ key: "", offset: 0 });
  };
  const shiftWindow = (direction: -1 | 1) => {
    const span = daysInWindow(windowDates.start, windowDates.end);
    setWindowDates((current) => ({
      start: shiftDate(current.start, direction * span),
      end: shiftDate(current.end, direction * span),
    }));
    setPagePosition({ key: "", offset: 0 });
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={() => {
        startedDrag.current = dragStamp;
        setMoveError("");
      }}
      onDragCancel={() => {
        startedDrag.current = null;
      }}
      onDragEnd={({ active, over, delta }) => {
        const valid = startedDrag.current === dragStamp;
        startedDrag.current = null;
        if (!valid || !canMove || movesPending || scope !== "window" || !over)
          return;
        const id = String(active.id);
        const resize = id.startsWith("timeline-end:");
        const rowId = id.slice(
          resize ? "timeline-end:".length : "timeline-shift:".length,
        );
        if (over.id !== `timeline-track:${rowId}`) return;
        const width = over.rect.width;
        if (typeof width !== "number" || width <= 0) return;
        const days = Math.round(
          (delta.x / width) * daysInWindow(windowDates.start, windowDates.end),
        );
        if (!days) return;
        const row = result?.items.find((record) => record.id === rowId);
        if (!row || row.isDeleted) return;
        const effective = effectiveMoveRecord(row, pendingMoves.get(row.id));
        if (
          !validMoveInterval(
            effective.data[startField.id],
            startField.type,
            effective.data[endField.id],
            endField.type,
            moveTimezone,
          )
        )
          return;
        try {
          const startDay = recordMoveDay(
            effective.data[startField.id],
            startField.type,
            moveTimezone,
          )!;
          const endDay = recordMoveDay(
            effective.data[endField.id],
            endField.type,
            moveTimezone,
          )!;
          const nextStart = resize ? startDay : shiftMoveDay(startDay, days);
          const nextEnd = shiftMoveDay(endDay, days);
          const end = moveDateValue(
            effective.data[endField.id],
            endField.type,
            nextEnd,
            moveTimezone,
          );
          const start = resize
            ? effective.data[startField.id]
            : moveDateValue(
                effective.data[startField.id],
                startField.type,
                nextStart,
                moveTimezone,
              );
          if (
            !validMoveInterval(
              start,
              startField.type,
              end,
              endField.type,
              moveTimezone,
            )
          )
            throw new Error("End date must be on or after the start date.");
          onMoveDates(
            row,
            resize
              ? { kind: "single", fieldId: endField.id, value: end }
              : {
                  kind: "compound",
                  changes: [
                    { fieldId: startField.id, value: start as string },
                    { fieldId: endField.id, value: end },
                  ],
                },
            `${nextStart} – ${nextEnd}`,
            [startField.id, endField.id],
          );
        } catch (caught) {
          setMoveError(
            `${caught instanceof Error ? caught.message : "This interval cannot be moved."} Use Move to… to choose the date and UTC offset.`,
          );
        }
      }}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Drag horizontally to shift the interval or resize its end. Keyboard users can use Move to. Escape cancels. Save changes applies unsaved moves.",
        },
      }}
    >
      <Card
        className="min-w-0 self-auto overflow-hidden"
        aria-label="Timeline records"
      >
        <header data-slot="card-header" className="border-b px-4 py-3">
          <h2 data-slot="section-title" className="font-medium">
            Timeline · {startField.name} through {endField.name}
          </h2>
          <p className="text-muted-foreground text-sm">
            Complete selected intervals are clipped to the visible window. Dates
            follow the workspace calendar.
            {timezone ? ` Workspace timezone: ${timezone}` : ""}
          </p>
        </header>
        {moveError ? (
          <Alert role="alert" variant="destructive" className="m-4">
            {moveError}
          </Alert>
        ) : null}
        <WindowControls
          startDate={windowDates.start}
          endDate={windowDates.end}
          scope={scope}
          unscheduledScope="unscheduled"
          windowLabel="Scheduled intervals"
          undatedLabel="Unscheduled records"
          onStartDateChange={(start) => {
            setWindowDates((current) => ({ ...current, start }));
            setPagePosition({ key: "", offset: 0 });
          }}
          onEndDateChange={(end) => {
            setWindowDates((current) => ({ ...current, end }));
            setPagePosition({ key: "", offset: 0 });
          }}
          onScopeChange={(next) => {
            if (next === "window" || next === "unscheduled") changeScope(next);
          }}
          onShiftWindow={shiftWindow}
          timezone={timezone}
          locale={region?.locale}
        />
        {loading && result ? (
          <p
            role="status"
            className="text-muted-foreground border-b px-4 py-2 text-sm"
          >
            Updating timeline records.{" "}
            {result.pagination.offset === offset
              ? "The last loaded page remains visible."
              : `Showing previous page ${result.pagination.offset + 1}–${result.pagination.offset + result.pagination.count}.`}
          </p>
        ) : null}
        {error ? (
          <Alert
            role="alert"
            variant="destructive"
            className="m-4 flex flex-wrap items-center justify-between gap-3"
          >
            <p>{windowPageErrorMessage(error, result, offset)}</p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry timeline records
            </Button>
          </Alert>
        ) : null}
        {request && loading && !result ? (
          <p
            role="status"
            className="text-muted-foreground px-4 py-12 text-center"
          >
            Loading timeline records…
          </p>
        ) : null}
        {request && error && !result ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Timeline records could not be loaded</EmptyTitle>
              <EmptyDescription>{error}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {!request ? (
          <p role="note" className="text-muted-foreground px-4 py-8 text-sm">
            Select a valid window of up to 366 days to load Timeline records.
          </p>
        ) : null}
        {result && result.items.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>
                {scope === "window"
                  ? "No scheduled intervals in this window"
                  : "No unscheduled records"}
              </EmptyTitle>
              <EmptyDescription>
                {scope === "window"
                  ? "Try another date window or check the separate unscheduled records."
                  : "Records without a complete interval appear here."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {result && result.items.length > 0 ? (
          <ul aria-label="Timeline intervals" className="divide-y">
            {result.items.map((row) => {
              const title = titleField
                ? formatOpenViewFieldValue(
                    openViewRecordFieldValue(row, titleField),
                    titleField.type,
                    region,
                    `Record ${row.id.slice(0, 8)}`,
                  )
                : `Record ${row.id.slice(0, 8)}`;
              const startValue = row.data[startField.id];
              const endValue = row.data[endField.id];
              const pending = pendingMoves.get(row.id);
              const effective = effectiveMoveRecord(row, pending);
              const position =
                scope === "window"
                  ? intervalPosition(
                      effective.data[startField.id],
                      startField,
                      effective.data[endField.id],
                      endField,
                      windowDates.start,
                      windowDates.end,
                      timezone,
                    )
                  : null;
              const progress = progressField
                ? progressValue(row.data[progressField.id])
                : null;
              const numericProgress = progress?.number ?? null;
              return (
                <li key={row.id} className="min-w-0 p-4">
                  <article
                    className={cn(
                      "grid min-w-0 gap-3 md:grid-cols-[minmax(12rem,1fr)_minmax(16rem,2fr)]",
                      pending &&
                        "bg-muted/50 rounded-[var(--radius)] border border-dashed p-3",
                      pending?.error && "border-destructive",
                    )}
                  >
                    <div className="min-w-0">
                      <h3 className="font-medium">
                        <button
                          type="button"
                          className="text-primary focus-visible:ring-ring min-h-11 min-w-11 text-left underline-offset-4 hover:underline focus-visible:ring-2"
                          aria-label={`Open record: ${title}`}
                          onClick={() => {
                            if (!request || !result) return;
                            onOpenRecord(row.id, {
                              rows: result.items,
                              offset: result.pagination.offset,
                              total: result.pagination.total,
                              source: {
                                kind: "window",
                                request,
                                returnToPage: (nextOffset) =>
                                  setPagePosition({
                                    key: baseKey,
                                    offset: nextOffset,
                                  }),
                              },
                            });
                          }}
                        >
                          {titleField?.type === "user" ? "Open record" : title}
                        </button>
                      </h3>
                      {titleField?.type === "user" ? (
                        <RecordPersonCard row={row} field={titleField}>
                          {title}
                        </RecordPersonCard>
                      ) : null}
                      {scope === "window" ? (
                        <p className="text-muted-foreground text-sm">
                          {formatWindowDate(
                            startValue,
                            startField.type,
                            timezone,
                            region?.locale,
                            windowRegion,
                          )}
                          {" – "}
                          {formatWindowDate(
                            endValue,
                            endField.type,
                            timezone,
                            region?.locale,
                            windowRegion,
                          )}
                        </p>
                      ) : (
                        <p className="text-muted-foreground text-sm">
                          This record has no complete start/end interval.
                        </p>
                      )}
                      {deadlineField && row.data[deadlineField.id] != null ? (
                        <p className="text-muted-foreground text-sm">
                          Deadline:{" "}
                          {formatWindowDate(
                            row.data[deadlineField.id],
                            deadlineField.type,
                            timezone,
                            region?.locale,
                            windowRegion,
                          )}
                        </p>
                      ) : null}
                      {progressField && numericProgress !== null ? (
                        <div className="mt-1 flex items-center gap-2">
                          <span className="text-muted-foreground text-sm">
                            Progress: {progress?.label}%
                          </span>
                          <div
                            role="progressbar"
                            aria-label={`${title} progress`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.max(
                              0,
                              Math.min(100, numericProgress),
                            )}
                            className="bg-muted h-2 w-24 overflow-hidden rounded-full"
                          >
                            <div
                              className="bg-primary h-full rounded-full"
                              style={{
                                width: `${Math.max(0, Math.min(100, numericProgress))}%`,
                              }}
                            />
                          </div>
                        </div>
                      ) : null}
                      {detailFields.map((field) => (
                        <p
                          key={field.id}
                          className="text-muted-foreground text-sm"
                        >
                          {field.name}:{" "}
                          <RecordPersonCard row={row} field={field}>
                            {formatOpenViewFieldValue(
                              openViewRecordFieldValue(row, field),
                              field.type,
                              region,
                            )}
                          </RecordPersonCard>
                        </p>
                      ))}
                      {canMove ? (
                        <DateMoveActions
                          key={JSON.stringify([
                            startField.id,
                            endField.id,
                            timezone,
                            baseKey,
                          ])}
                          row={row}
                          title={title}
                          startField={startField}
                          endField={endField}
                          timezone={moveTimezone}
                          pending={pending}
                          disabled={movesPending}
                          onMoveDates={onMoveDates}
                        />
                      ) : null}
                      <PendingDateMove
                        pending={pending}
                        onReview={() => openRow(row.id)}
                      />
                    </div>
                    {scope === "window" ? (
                      <div className="flex min-w-0 flex-col justify-center gap-2">
                        <div className="text-muted-foreground flex justify-between text-xs">
                          <span>
                            {formatWindowDate(
                              windowDates.start,
                              "date",
                              timezone,
                              region?.locale,
                              windowRegion,
                            )}
                          </span>
                          <span>
                            {formatWindowDate(
                              windowDates.end,
                              "date",
                              timezone,
                              region?.locale,
                              windowRegion,
                            )}
                          </span>
                        </div>
                        <TimelineTrack
                          recordId={row.id}
                          title={title}
                          position={position}
                          disabled={
                            !canMove ||
                            movesPending ||
                            row.isDeleted ||
                            !validMoveInterval(
                              effective.data[startField.id],
                              startField.type,
                              effective.data[endField.id],
                              endField.type,
                              moveTimezone,
                            )
                          }
                          label={
                            position
                              ? `${title} interval, ${formatWindowDate(startValue, startField.type, timezone, region?.locale, windowRegion)} to ${formatWindowDate(endValue, endField.type, timezone, region?.locale, windowRegion)}`
                              : `${title} interval dates unavailable`
                          }
                        />
                      </div>
                    ) : null}
                  </article>
                </li>
              );
            })}
          </ul>
        ) : null}
        {result ? (
          <WindowPageNavigation
            result={result}
            loading={loading}
            onOffsetChange={(nextOffset) =>
              setPagePosition({ key: baseKey, offset: nextOffset })
            }
          />
        ) : null}
      </Card>
    </DndContext>
  );
}
