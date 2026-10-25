"use client";

import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
} from "@dnd-kit/core";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { OpenViewDashboard } from "../adapters/dashboards-api";
import type { OpenViewDataSource } from "../adapters/views-api";
import type { WidgetRead } from "../hooks/use-dashboard-snapshot";
import type { DraftWidget } from "../domain/dashboard-draft";
import {
  freeCells,
  insideGrid,
  moveItem,
  placementFits,
  readingOrder,
  resizeItem,
  sizeOptions,
  snapOffset,
  snapSpan,
  SIZE_RULES,
  type Direction,
  type GridItem,
  type Placement,
  type WidgetKind,
} from "../domain/dashboard-grid";
import {
  DashboardWidgetCard,
  type WidgetCardMode,
} from "./dashboard-widget-card";

/** A preset's empty space: a place and a kind that asks for its chart. */
export type LayoutSpace = {
  key: string;
  kind: WidgetKind;
  placement: Placement;
};

const GAP = 12;
const DIRECTIONS: Direction[] = ["left", "right", "up", "down"];
const ARROWS: Record<string, Direction> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

function area(placement: Placement): CSSProperties {
  return {
    gridColumn: `${placement.column + 1} / span ${placement.columnSpan}`,
    gridRow: `${placement.row + 1} / span ${placement.rowSpan}`,
  };
}

type EditActions = {
  /** A move or resize the grid rules already accepted. */
  onPlace: (key: string, placement: Placement) => void;
  onEditWidget: (key: string) => void;
  onRemoveWidget: (key: string) => void;
  onAddAt: (column: number, row: number) => void;
  onFillSpace: (key: string) => void;
  onRemoveSpace: (key: string) => void;
};

type LayoutProps = {
  label: string;
  dashboard: OpenViewDashboard | null;
  widgets: readonly DraftWidget[];
  spaces: readonly LayoutSpace[];
  kinds: ReadonlyMap<string, WidgetKind>;
  reads: ReadonlyMap<string, WidgetRead>;
  issues: ReadonlyMap<string, string[]>;
  sources: readonly OpenViewDataSource[];
  departmentNames: ReadonlyMap<string, string>;
  refreshSignal: number;
  stacked: boolean;
  view?: {
    onEdit?: (key: string) => void;
    onRemove?: (key: string) => void;
  };
  edit: EditActions | null;
};

/**
 * The 4 × 5 grid (docs/specs/openview-dashboard.md, "The grid"). In view mode
 * it only places the cards; in edit mode (BD7) it shows its lines and an Add
 * in each empty cell, and every card can be dragged by pointer, resized from
 * its corner, or moved and resized from its handle with the arrow keys (BD8).
 * Phones stack the cards in reading order (BD12).
 */
export function DashboardLayout(props: LayoutProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState("");
  const [preview, setPreview] = useState<{
    key: string;
    placement: Placement;
    fits: boolean;
  } | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const items: GridItem[] = [
    ...props.widgets.map((widget) => ({
      key: widget.key,
      placement: widget.placement,
    })),
    ...props.spaces.map((space) => ({
      key: space.key,
      placement: space.placement,
    })),
  ];
  const kindOf = (key: string): WidgetKind => props.kinds.get(key) ?? "bar";

  function cell() {
    const grid = gridRef.current;
    if (!grid) return null;
    const style = getComputedStyle(grid);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    return {
      width: (grid.clientWidth - padX - GAP * 3) / 4,
      height: (grid.scrollHeight - padY - GAP * 4) / 5,
    };
  }

  function apply(
    key: string,
    change: ReturnType<typeof moveItem>,
    done: string,
  ) {
    if (change.ok) {
      props.edit?.onPlace(key, change.placement);
      setAnnouncement(
        `${done}: column ${change.placement.column + 1}, row ${change.placement.row + 1}, ${change.placement.columnSpan} × ${change.placement.rowSpan}.`,
      );
    } else setAnnouncement(`Not changed: ${change.reason}.`);
  }

  function keyboard(key: string, event: KeyboardEvent<HTMLButtonElement>) {
    const direction = ARROWS[event.key];
    if (!direction) return;
    event.preventDefault();
    if (!event.shiftKey) {
      apply(key, moveItem(items, key, direction), "Moved");
      return;
    }
    const placement = items.find((item) => item.key === key)?.placement;
    if (!placement) return;
    const columns =
      placement.columnSpan +
      (direction === "right" ? 1 : direction === "left" ? -1 : 0);
    const rows =
      placement.rowSpan +
      (direction === "down" ? 1 : direction === "up" ? -1 : 0);
    apply(
      key,
      resizeItem(items, key, kindOf(key), { columns, rows }),
      "Resized",
    );
  }

  function dragTarget(key: string, x: number, y: number) {
    const size = cell();
    const placement = items.find((item) => item.key === key)?.placement;
    if (!size || !placement) return null;
    const next = {
      ...placement,
      column: placement.column + snapOffset(x, size.width, GAP),
      row: placement.row + snapOffset(y, size.height, GAP),
    };
    return { key, placement: next, fits: placementFits(items, next, key) };
  }

  function onDragMove(event: DragMoveEvent) {
    setPreview(
      dragTarget(String(event.active.id), event.delta.x, event.delta.y),
    );
  }

  function onDragEnd(event: DragEndEvent) {
    const key = String(event.active.id);
    const target = dragTarget(key, event.delta.x, event.delta.y);
    setPreview(null);
    if (!target) return;
    const current = items.find((item) => item.key === key)?.placement;
    if (
      current &&
      current.column === target.placement.column &&
      current.row === target.placement.row
    )
      return;
    if (target.fits)
      apply(key, { ok: true, placement: target.placement }, "Moved");
    else
      setAnnouncement(
        insideGrid(target.placement)
          ? "Not moved: another widget is there."
          : "Not moved: past the grid edge.",
      );
  }

  function resizeStart(key: string, event: PointerEvent<HTMLSpanElement>) {
    event.stopPropagation();
    event.preventDefault();
    const size = cell();
    const card = event.currentTarget.closest("article");
    const placement = items.find((item) => item.key === key)?.placement;
    if (!size || !card || !placement) return;
    const box = card.getBoundingClientRect();
    const rule = SIZE_RULES[kindOf(key)];
    const target = (clientX: number, clientY: number) => {
      const columns = Math.min(
        rule.maxColumns,
        Math.max(
          rule.minColumns,
          snapSpan(clientX - box.left, size.width, GAP),
        ),
      );
      const rows = Math.min(
        rule.maxRows,
        Math.max(rule.minRows, snapSpan(clientY - box.top, size.height, GAP)),
      );
      const next = { ...placement, columnSpan: columns, rowSpan: rows };
      return { key, placement: next, fits: placementFits(items, next, key) };
    };
    const move = (moveEvent: globalThis.PointerEvent) =>
      setPreview(target(moveEvent.clientX, moveEvent.clientY));
    const end = (endEvent: globalThis.PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setPreview(null);
      if (endEvent.type === "pointercancel") return;
      const next = target(endEvent.clientX, endEvent.clientY).placement;
      if (
        next.columnSpan === placement.columnSpan &&
        next.rowSpan === placement.rowSpan
      )
        return;
      apply(
        key,
        resizeItem(items, key, kindOf(key), {
          columns: next.columnSpan,
          rows: next.rowSpan,
        }),
        "Resized",
      );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  const editing = props.edit !== null && !props.stacked;
  const ordered = props.stacked ? readingOrder(props.widgets) : props.widgets;
  const placed = ordered.filter((widget) => props.stacked || widget.placement);
  const cards = placed.map((widget) => {
    const kind = kindOf(widget.key);
    const common = {
      widget,
      kind,
      dashboard: props.dashboard,
      sources: props.sources,
      departmentNames: props.departmentNames,
      read: props.reads.get(widget.key) ?? null,
      issues: props.issues.get(widget.key) ?? [],
      stacked: props.stacked,
      refreshSignal: props.refreshSignal,
    };
    if (!editing || !props.edit || !widget.placement)
      return (
        <DashboardWidgetCard
          key={widget.key}
          {...common}
          style={
            props.stacked || !widget.placement
              ? undefined
              : area(widget.placement)
          }
          modeProps={{
            mode: "view",
            onEdit: props.view?.onEdit
              ? () => props.view?.onEdit?.(widget.key)
              : undefined,
            onRemove: props.view?.onRemove
              ? () => props.view?.onRemove?.(widget.key)
              : undefined,
          }}
        />
      );
    const edit = props.edit;
    const menu: Extract<WidgetCardMode, { mode: "edit" }>["menu"] = {
      sizes: sizeOptions(items, widget.key, kind),
      moves: DIRECTIONS.map((direction) => ({
        direction,
        change: moveItem(items, widget.key, direction),
      })),
      onSize: (columns, rows) =>
        apply(
          widget.key,
          resizeItem(items, widget.key, kind, { columns, rows }),
          "Resized",
        ),
      onMove: (direction) =>
        apply(widget.key, moveItem(items, widget.key, direction), "Moved"),
      onEdit: () => edit.onEditWidget(widget.key),
      onRemove: () => edit.onRemoveWidget(widget.key),
    };
    return (
      <DraggableCard
        key={widget.key}
        id={widget.key}
        placement={widget.placement}
        active={activeKey === widget.key || preview?.key === widget.key}
        onFocusChange={(focused) =>
          setActiveKey((current) =>
            focused ? widget.key : current === widget.key ? null : current,
          )
        }
        render={(handles) => (
          <DashboardWidgetCard
            {...common}
            style={handles.style}
            modeProps={{
              mode: "edit",
              menu,
              handles: {
                handleProps: handles.handleProps,
                onHandleKeyDown: (event) => keyboard(widget.key, event),
                onResizeStart: (event) => resizeStart(widget.key, event),
                onCardPointerDown: handles.cardPointerDown,
                dragging: handles.dragging,
                sizeTag: handles.active
                  ? `${(preview?.key === widget.key ? preview.placement : widget.placement!).columnSpan} × ${(preview?.key === widget.key ? preview.placement : widget.placement!).rowSpan}`
                  : null,
              },
            }}
          />
        )}
      />
    );
  });

  return (
    <DndContext
      sensors={sensors}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={() => setPreview(null)}
    >
      <div
        ref={gridRef}
        role="region"
        aria-label={props.label}
        data-mode={editing ? "edit" : "view"}
        className={cn(
          props.stacked
            ? "flex flex-col gap-3"
            : "grid min-w-0 grid-cols-4 grid-rows-[repeat(5,7rem)] gap-3 xl:min-h-0 xl:flex-1 xl:grid-rows-[repeat(5,minmax(7rem,1fr))] xl:overflow-auto xl:overscroll-contain",
          editing &&
            "bg-muted/50 rounded-lg bg-[linear-gradient(var(--rule)_1px,transparent_1px),linear-gradient(90deg,var(--rule)_1px,transparent_1px)] p-3",
        )}
      >
        {editing
          ? freeCells(items).map(({ column, row }) => (
              <button
                key={`free-${column}-${row}`}
                type="button"
                style={area({ column, row, columnSpan: 1, rowSpan: 1 })}
                aria-label={`Add a widget at column ${column + 1}, row ${row + 1}`}
                onClick={() => props.edit?.onAddAt(column, row)}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring bg-card flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-dashed border-(--rule-strong) text-sm font-medium hover:border-(--ink-muted) focus-visible:ring-2 focus-visible:outline-none"
              >
                <Plus aria-hidden="true" className="size-4" />
                Add
              </button>
            ))
          : null}
        {editing
          ? props.spaces.map((space) => (
              <div
                key={space.key}
                style={area(space.placement)}
                className="bg-card relative flex min-h-0 items-center justify-center rounded-lg border border-dashed border-(--rule-strong)"
              >
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  onClick={() => props.edit?.onFillSpace(space.key)}
                >
                  <Plus aria-hidden="true" />
                  Add a {SIZE_RULES[space.kind].label}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute top-1 right-1 size-11"
                  aria-label={`Remove this ${SIZE_RULES[space.kind].label} space`}
                  onClick={() => props.edit?.onRemoveSpace(space.key)}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
            ))
          : null}
        {cards}
        {preview ? (
          <div
            aria-hidden="true"
            style={
              insideGrid(preview.placement)
                ? area(preview.placement)
                : undefined
            }
            className={cn(
              "pointer-events-none z-10 rounded-lg border-2",
              preview.fits
                ? "border-primary bg-action-tint/40"
                : "border-destructive bg-danger-tint/40",
              !insideGrid(preview.placement) && "hidden",
            )}
          />
        ) : null}
      </div>
      {editing ? (
        <>
          <p id="dashboard-handle-hint" className="sr-only">
            Arrow keys move the widget one cell. Shift and the arrow keys resize
            it.
          </p>
          <p role="status" aria-live="polite" className="sr-only">
            {announcement}
          </p>
        </>
      ) : null}
    </DndContext>
  );
}

function DraggableCard({
  id,
  placement,
  active,
  onFocusChange,
  render,
}: {
  id: string;
  placement: Placement;
  active: boolean;
  onFocusChange: (focused: boolean) => void;
  render: (handles: {
    style: CSSProperties;
    dragging: boolean;
    active: boolean;
    cardPointerDown?: (event: PointerEvent<HTMLElement>) => void;
    handleProps: Extract<
      WidgetCardMode,
      { mode: "edit" }
    >["handles"]["handleProps"];
  }) => React.ReactNode;
}) {
  const { setNodeRef, setActivatorNodeRef, listeners, transform, isDragging } =
    useDraggable({ id });
  return render({
    style: {
      ...area(placement),
      ...(transform
        ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
        : {}),
    },
    dragging: isDragging,
    active: active || isDragging,
    cardPointerDown: listeners?.onPointerDown as
      ((event: PointerEvent<HTMLElement>) => void) | undefined,
    handleProps: {
      ref: (element: HTMLElement | null) => {
        setActivatorNodeRef(element);
        setNodeRef(element?.closest("article") ?? null);
      },
      onPointerDown: listeners?.onPointerDown as
        ((event: PointerEvent<HTMLButtonElement>) => void) | undefined,
      onFocus: () => onFocusChange(true),
      onBlur: () => onFocusChange(false),
    },
  });
}
