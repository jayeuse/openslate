"use client";

import {
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import type { Route } from "next";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  MoreHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { serializeCsv } from "@/lib/csv";
import { cn } from "@/lib/utils";
import { moduleHref } from "@/components/department-navigation-model";
import type { OpenViewAggregateSnapshotResult } from "../adapters/analytics-api";
import type {
  OpenViewDashboard,
  OpenViewDashboardChartConfig,
  OpenViewDashboardWidgetConfig,
} from "../adapters/dashboards-api";
import { fieldsFirstPageOptions } from "../adapters/openview-queries";
import type {
  OpenViewDataSource,
  OpenViewDataSourceField,
  OpenViewQueryDefinition,
} from "../adapters/views-api";
import {
  useOpenViewSelectedFields,
  useOpenViewSource,
} from "../hooks/use-openview-catalog";
import {
  savedWidgetUnchanged,
  useDashboardRecordSnapshot,
  type WidgetRead,
} from "../hooks/use-dashboard-snapshot";
import type { DraftWidget } from "../domain/dashboard-draft";
import type {
  Direction,
  GridChange,
  SizeOption,
  WidgetKind,
} from "../domain/dashboard-grid";
import {
  numberValue,
  pageRange,
  rowsForSpan,
  widgetTitle,
} from "../domain/dashboard-widget-text";
import { openViewRecordFieldValue } from "../domain/record-display";
import { encodeTemporaryDefinition } from "../domain/temporary-view";
import { OpenViewChartPreview } from "./chart-preview";
import { RecordPersonCard } from "./live-record-cards";

/** What the card's menu offers in edit mode (BD8): sizes, moves, edit, remove. */
export type EditMenu = {
  sizes: SizeOption[];
  moves: { direction: Direction; change: GridChange }[];
  onSize: (columns: number, rows: number) => void;
  onMove: (direction: Direction) => void;
  onEdit: () => void;
  onRemove: () => void;
};

/** The drag handle and corner handle a card gets in edit mode (BD7). */
export type EditHandles = {
  handleProps: HTMLAttributes<HTMLButtonElement> & {
    ref?: (element: HTMLElement | null) => void;
  };
  onHandleKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onResizeStart: (event: PointerEvent<HTMLSpanElement>) => void;
  /** A press anywhere on the card (but its controls) starts a drag too. */
  onCardPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  dragging: boolean;
  /** The size or move just applied, shown on the card while it is selected. */
  sizeTag: string | null;
};

export type WidgetCardMode =
  | {
      mode: "view";
      /** Edit chart and Remove for managers (BD5); they open edit mode. */
      onEdit?: () => void;
      onRemove?: () => void;
    }
  | { mode: "edit"; menu: EditMenu; handles: EditHandles };

type CardProps = {
  widget: DraftWidget;
  kind: WidgetKind;
  dashboard: OpenViewDashboard | null;
  sources: readonly OpenViewDataSource[];
  departmentNames: ReadonlyMap<string, string>;
  /** The aggregate read; a records widget reads its own pages. */
  read: WidgetRead | null;
  issues: readonly string[];
  /** Phones stack cards at their kind's height (BD12). */
  stacked: boolean;
  style?: CSSProperties;
  modeProps: WidgetCardMode;
  /** Bumped by the header's Refresh, so a records widget reads again. */
  refreshSignal: number;
  /** The builder's preview: it shows the given read and offers no menu. */
  preview?: boolean;
};

export function DashboardWidgetCard(props: CardProps) {
  if (props.widget.widgetType === "records" && !props.preview)
    return <RecordsWidgetCard {...props} />;
  return (
    <WidgetCardFrame
      {...props}
      read={
        props.read ?? {
          snapshot: null,
          loading: false,
          error: "",
          locked: false,
        }
      }
    />
  );
}

function RecordsWidgetCard(props: CardProps) {
  const [page, setPage] = useState(0);
  const pageSize = rowsForSpan(
    props.stacked ? null : (props.widget.placement?.rowSpan ?? null),
  );
  const read = useDashboardRecordSnapshot(
    props.dashboard,
    props.widget,
    true,
    props.modeProps.mode === "edit",
    page,
    pageSize,
  );
  const [signal, setSignal] = useState(props.refreshSignal);
  if (signal !== props.refreshSignal) {
    setSignal(props.refreshSignal);
    read.refresh();
  }
  return (
    <WidgetCardFrame
      {...props}
      read={{
        snapshot: read.snapshot,
        loading: read.loading,
        error: read.error,
        locked: read.locked,
        refresh: read.refresh,
      }}
      paging={{ page, setPage, pageSize }}
    />
  );
}

type Paging = {
  page: number;
  setPage: (page: number) => void;
  pageSize: number;
};

function useWidgetMeta(
  config: OpenViewDashboardWidgetConfig | null,
  sources: readonly OpenViewDataSource[],
  locked: boolean,
) {
  const moduleId = locked ? "" : (config?.query.moduleId ?? "");
  const source = useOpenViewSource(sources, moduleId || null);
  const first = useQuery({
    ...fieldsFirstPageOptions(moduleId),
    enabled: Boolean(moduleId),
  });
  const query = config?.query;
  const ids = query
    ? [
        ...query.definition.columns,
        ...query.definition.filters,
        ...query.definition.sort,
        ...("mode" in query
          ? [
              query.measure,
              query.dateField,
              query.mode === "groups" ? query.dimension : undefined,
            ].filter((reference) => reference !== undefined)
          : []),
      ].map((reference) => reference.fieldId)
    : [];
  const fields = useOpenViewSelectedFields(moduleId, first.data?.items, ids);
  return { source, fields: fields.items };
}

function WidgetCardFrame(
  props: Omit<CardProps, "read"> & { read: WidgetRead; paging?: Paging },
) {
  const { widget, kind, read, modeProps } = props;
  const config = read.snapshot?.data.config ?? widget.config ?? null;
  const { source, fields } = useWidgetMeta(config, props.sources, read.locked);
  const title = read.locked
    ? widgetTitle({
        kind,
        config: null,
        savedName: null,
        moduleName: null,
        fields,
      })
    : widgetTitle({
        kind,
        config,
        savedName: read.snapshot?.data.sourceName ?? null,
        moduleName: source?.name ?? null,
        fields,
      });
  // A source in another department names it in the head (BD4).
  const linked =
    source &&
    props.dashboard &&
    source.departmentId !== props.dashboard.departmentId
      ? (props.departmentNames.get(source.departmentId) ?? null)
      : null;
  const edit = modeProps.mode === "edit" ? modeProps : null;
  const openHref = config ? recordsHref(config) : null;
  const aggregate =
    read.snapshot?.data.kind === "aggregate" ? read.snapshot.data.result : null;
  return (
    <article
      aria-label={title}
      data-slot="card"
      data-widget-kind={kind}
      style={props.style}
      onPointerDown={
        edit?.handles.onCardPointerDown
          ? (event) => {
              if ((event.target as Element).closest("button, a, [data-resize]"))
                return;
              edit.handles.onCardPointerDown?.(event);
            }
          : undefined
      }
      className={cn(
        "bg-card border-card-edge relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border",
        props.stacked && stackedHeight(kind),
        edit && "ring-1 ring-(--rule-strong)",
        edit?.handles.dragging && "z-20 opacity-90 shadow-lg",
        props.issues.length > 0 && "ring-destructive ring-2",
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 pr-1.5 pl-3.5 xl:h-9">
        {edit ? (
          <button
            type="button"
            {...edit.handles.handleProps}
            onKeyDown={edit.handles.onHandleKeyDown}
            aria-label={`Move or resize ${title}`}
            aria-describedby="dashboard-handle-hint"
            className="text-muted-foreground hover:bg-muted focus-visible:ring-ring -ml-2 grid size-11 shrink-0 cursor-grab touch-none place-items-center rounded-sm focus-visible:ring-2 focus-visible:outline-none xl:size-6"
          >
            <GripVertical aria-hidden="true" className="size-4" />
          </button>
        ) : null}
        <h2
          data-slot="card-title"
          className="min-w-0 truncate text-sm font-semibold"
        >
          {title}
        </h2>
        {linked ? (
          <span className="text-muted-foreground shrink-0 text-xs">
            {linked}
          </span>
        ) : null}
        {props.preview ? null : (
          <WidgetMenu
            title={title}
            current={widget.placement}
            edit={edit?.menu ?? null}
            view={
              modeProps.mode === "view"
                ? {
                    openHref: read.locked ? null : openHref,
                    onDownload:
                      aggregate && !read.locked
                        ? () => downloadCsv(aggregate, title, config)
                        : null,
                    onEdit: modeProps.onEdit ?? null,
                    onRemove: modeProps.onRemove ?? null,
                  }
                : null
            }
          />
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-3.5 pb-3">
        {props.issues.length ? (
          <p role="alert" className="text-danger-text mb-1 text-xs">
            {props.issues.join(" ")}
          </p>
        ) : null}
        <WidgetBody
          widget={widget}
          kind={kind}
          read={read}
          unsaved={
            !props.preview && !savedWidgetUnchanged(props.dashboard, widget)
          }
          config={config}
          moduleName={source?.name ?? null}
          fields={fields}
          paging={props.paging}
          openHref={openHref}
        />
      </div>
      {edit?.handles.sizeTag ? (
        <span className="text-action-text bg-action-tint pointer-events-none absolute right-6 bottom-2 rounded-sm px-1.5 py-0.5 text-xs font-medium">
          {edit.handles.sizeTag}
        </span>
      ) : null}
      {edit ? (
        <span
          aria-hidden="true"
          data-resize=""
          onPointerDown={edit.handles.onResizeStart}
          className="absolute right-0 bottom-0 size-5 cursor-nwse-resize touch-none after:absolute after:right-1 after:bottom-1 after:size-2 after:border-r-2 after:border-b-2 after:border-(--ink-muted)"
        />
      ) : null}
    </article>
  );
}

/** Phones: a number and a chart keep their height; a list grows with its rows. */
function stackedHeight(kind: WidgetKind): string {
  if (kind === "number") return "h-32";
  if (kind === "table" || kind === "records") return "";
  return "h-72";
}

function WidgetBody({
  widget,
  kind,
  read,
  unsaved,
  config,
  moduleName,
  fields,
  paging,
  openHref,
}: {
  widget: DraftWidget;
  kind: WidgetKind;
  read: WidgetRead;
  unsaved: boolean;
  config: OpenViewDashboardWidgetConfig | null;
  moduleName: string | null;
  fields: readonly OpenViewDataSourceField[];
  paging?: Paging;
  openHref: string | null;
}) {
  if (read.locked)
    return (
      <div className="text-muted-foreground flex flex-1 flex-col justify-center gap-1 text-sm">
        <LockMark />
        <p className="text-foreground font-medium">
          No access to these records
        </p>
        <p>Ask an administrator for access.</p>
      </div>
    );
  if (read.error && !read.snapshot)
    return (
      <div role="alert" className="mt-auto flex flex-col items-start gap-1">
        <p className="text-danger-text text-sm">{read.error}</p>
        {read.refresh ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 xl:min-h-8"
            onClick={read.refresh}
          >
            Retry
          </Button>
        ) : null}
      </div>
    );
  if (!read.snapshot && unsaved)
    return (
      <p className="text-muted-foreground mt-auto text-sm">
        Shows its records once the layout is saved.
      </p>
    );
  if (!read.snapshot)
    return (
      <LoadingRegion
        loading
        label="Loading this widget…"
        className="mt-1 flex min-h-0 flex-1 flex-col [&>div]:flex-1"
        skeleton={<Skeleton className="h-full min-h-8 w-full" />}
      />
    );
  const data = read.snapshot.data;
  if (data.kind === "records")
    return (
      <RecordsBody
        result={data.result}
        config={config}
        fields={fields}
        paging={paging}
        moduleName={moduleName}
        openHref={openHref}
      />
    );
  const query = config && "mode" in config.query ? config.query : null;
  if (kind === "number") {
    const value = query ? numberValue(data.result, query.aggregation) : null;
    return (
      <div className="mt-auto">
        <p className="font-display text-3xl leading-none font-semibold tracking-tight tabular-nums">
          {value === null ? "—" : value.toLocaleString()}
        </p>
        {numberCaption(moduleName, query) ? (
          <p className="text-muted-foreground mt-1 truncate text-xs">
            {numberCaption(moduleName, query)}
          </p>
        ) : null}
      </div>
    );
  }
  if (kind === "table")
    return (
      <TableBody
        result={data.result}
        valueLabel={
          query?.aggregation === "count"
            ? "Records"
            : (fields.find((field) => field.id === query?.measure?.fieldId)
                ?.name ?? "Value")
        }
        groupLabel={
          fields.find(
            (field) =>
              query?.mode === "groups" && field.id === query.dimension.fieldId,
          )?.name ?? "Group"
        }
        rows={rowsForSpan(widget.placement?.rowSpan ?? null)}
      />
    );
  const chartType =
    config && "chartType" in config
      ? (config as OpenViewDashboardChartConfig).chartType
      : "bar";
  const points = data.result.items.map((item, index) => ({
    key: item.key ?? `none-${index}`,
    label: item.label,
    value:
      item.value === null || !Number.isFinite(Number(item.value))
        ? null
        : Number(item.value),
  }));
  const shown = chartType === "line" ? points : points.slice(0, 12);
  return (
    <div
      role="img"
      aria-label={`${kindLabelFor(chartType)}: ${shown
        .slice(0, 12)
        .map((point) => `${point.label} ${point.value ?? "no value"}`)
        .join(", ")}`}
      className="min-h-0 flex-1"
    >
      <OpenViewChartPreview
        data={shown}
        type={chartType}
        valueLabel={query?.aggregation === "count" ? "Records" : "Value"}
        showLabels={chartType === "bar"}
        showPoints={false}
        showLegend={chartType === "pie"}
        oneColor
        showValueAxis={chartType === "line"}
        pieInnerRadius={36}
        pieOuterRadius={64}
        allowDecimals={query?.aggregation !== "count"}
        className="[&_.recharts-cartesian-axis-tick-value]:fill-muted-foreground h-full min-h-0 w-full"
      />
    </div>
  );
}

function kindLabelFor(chartType: "bar" | "line" | "pie") {
  return chartType === "line"
    ? "Line chart"
    : chartType === "pie"
      ? "Pie chart"
      : "Bar chart";
}

function numberCaption(
  moduleName: string | null,
  query: {
    definition: OpenViewQueryDefinition;
    fromDate?: string;
    toDate?: string;
  } | null,
): string {
  // The title already names the records; the caption adds what narrows them.
  const parts: string[] = [];
  const filters = query?.definition.filters.length ?? 0;
  if (filters) parts.push(filters === 1 ? "1 filter" : `${filters} filters`);
  if (query?.fromDate && query.toDate)
    parts.push(`${query.fromDate} to ${query.toDate}`);
  return parts.length ? [moduleName ?? "Records", ...parts].join(" · ") : "";
}

function TableBody({
  result,
  valueLabel,
  groupLabel,
  rows,
}: {
  result: OpenViewAggregateSnapshotResult;
  valueLabel: string;
  groupLabel: string;
  rows: number;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(result.items.length / rows));
  const current = Math.min(page, pages - 1);
  const offset = current * rows;
  const visible = result.items.slice(offset, offset + rows);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="text-muted-foreground h-7 border-b text-xs">
            <th
              data-slot="table-head"
              scope="col"
              className="truncate text-left font-normal"
            >
              {groupLabel}
            </th>
            <th
              data-slot="table-head"
              scope="col"
              className="w-28 text-right font-normal"
            >
              {valueLabel}
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((item, index) => (
            <tr
              key={`${item.key ?? "none"}-${offset + index}`}
              className="h-8 border-b"
            >
              <td className="truncate">{item.label}</td>
              <td className="text-right tabular-nums">
                {item.value === null ? "—" : String(item.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <CompactPager
        label="Table pages"
        range={pageRange(offset, visible.length, result.items.length)}
        previous={current > 0 ? () => setPage(current - 1) : null}
        next={current < pages - 1 ? () => setPage(current + 1) : null}
      />
    </div>
  );
}

function RecordsBody({
  result,
  config,
  fields,
  paging,
  moduleName,
  openHref,
}: {
  result: Extract<
    NonNullable<WidgetRead["snapshot"]>["data"],
    { kind: "records" }
  >["result"];
  config: OpenViewDashboardWidgetConfig | null;
  fields: readonly OpenViewDataSourceField[];
  paging?: Paging;
  moduleName: string | null;
  openHref: string | null;
}) {
  const columns = (config?.query.definition.columns ?? [])
    .slice(0, 3)
    .map((column, index) => {
      const field = fields.find((candidate) => candidate.id === column.fieldId);
      return {
        id: column.fieldId,
        name: field?.name ?? `Field ${index + 1}`,
        type: field?.type ?? column.expectedType,
      };
    });
  const { pagination } = result;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="text-muted-foreground h-7 border-b text-xs">
            {columns.map((column) => (
              <th
                data-slot="table-head"
                key={column.id}
                scope="col"
                className="truncate text-left font-normal"
              >
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.items.map((record) => (
            <tr key={record.id} className="h-8 border-b">
              {columns.map((column) => (
                <td key={column.id} className="truncate">
                  <RecordPersonCard row={record} field={column}>
                    {displayValue(openViewRecordFieldValue(record, column))}
                  </RecordPersonCard>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <CompactPager
        label="Record pages"
        range={pageRange(pagination.offset, pagination.count, pagination.total)}
        previous={
          paging && paging.page > 0
            ? () => paging.setPage(paging.page - 1)
            : null
        }
        next={
          paging && pagination.hasMore
            ? () => paging.setPage(paging.page + 1)
            : null
        }
        end={
          openHref ? (
            <Link
              href={openHref as Route}
              className="text-action-text inline-flex min-h-11 items-center font-medium xl:min-h-6"
            >
              Open {moduleName ?? "the records"}
            </Link>
          ) : null
        }
      />
    </div>
  );
}

function displayValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(displayValue).join(", ");
  return "—";
}

function CompactPager({
  label,
  range,
  previous,
  next,
  end,
}: {
  label: string;
  range: string;
  previous: (() => void) | null;
  next: (() => void) | null;
  end?: ReactNode;
}) {
  return (
    <nav
      aria-label={label}
      className="text-muted-foreground mt-auto flex items-center gap-1 pt-1.5 text-xs"
    >
      <span className="tabular-nums" aria-live="polite">
        {range}
      </span>
      {previous || next ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 xl:size-6"
            aria-label="Previous rows"
            disabled={!previous}
            onClick={previous ?? undefined}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 xl:size-6"
            aria-label="Next rows"
            disabled={!next}
            onClick={next ?? undefined}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </>
      ) : null}
      {end ? <span className="ml-auto">{end}</span> : null}
    </nav>
  );
}

const MENU_ROW = "min-h-11 xl:min-h-8";
/**
 * A row that cannot be chosen dims only its label: the reason beside it stays
 * in full muted ink, so it keeps its contrast (the menu dims a whole
 * disabled row by default).
 */
const REASON_ROW = "data-disabled:opacity-100";
const DIRECTIONS: Record<Direction, string> = {
  left: "Move left",
  right: "Move right",
  up: "Move up",
  down: "Move down",
};

function WidgetMenu({
  title,
  current,
  edit,
  view,
}: {
  title: string;
  current: { columnSpan: number; rowSpan: number } | null;
  edit: EditMenu | null;
  view: {
    openHref: string | null;
    onDownload: (() => void) | null;
    onEdit: (() => void) | null;
    onRemove: (() => void) | null;
  } | null;
}) {
  if (
    view &&
    !view.openHref &&
    !view.onDownload &&
    !view.onEdit &&
    !view.onRemove
  )
    return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto size-11 shrink-0 xl:size-8"
            aria-label={`${title}, actions`}
          />
        }
      >
        <MoreHorizontal aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="slim-ui min-w-56">
        {edit ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-muted-foreground px-2 pt-1.5 pb-0.5 text-xs font-medium">
                Size
              </DropdownMenuLabel>
              {/* Plain items marked as radios: the menu's radio parts would
                  join the shared menu code every page loads. */}
              {edit.sizes.map((size) => {
                const checked =
                  size.columns === current?.columnSpan &&
                  size.rows === current.rowSpan;
                return (
                  <DropdownMenuItem
                    key={`${size.columns}x${size.rows}`}
                    role="menuitemradio"
                    aria-checked={checked}
                    disabled={!size.allowed}
                    className={cn(MENU_ROW, REASON_ROW)}
                    onClick={() => edit.onSize(size.columns, size.rows)}
                  >
                    <span
                      className={cn(
                        "tabular-nums",
                        !size.allowed && "opacity-50",
                      )}
                    >
                      {size.columns} × {size.rows}
                    </span>
                    {size.allowed ? null : (
                      <span className="text-muted-foreground ml-auto text-xs">
                        {size.reason}
                      </span>
                    )}
                    {checked ? (
                      <Check aria-hidden="true" className="ml-auto" />
                    ) : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            {edit.moves.map(({ direction, change }) => (
              <DropdownMenuItem
                key={direction}
                disabled={!change.ok}
                className={cn(MENU_ROW, REASON_ROW)}
                onClick={() => edit.onMove(direction)}
              >
                <span className={cn(!change.ok && "opacity-50")}>
                  {DIRECTIONS[direction]}
                </span>
                {change.ok ? null : (
                  <span className="text-muted-foreground ml-auto text-xs">
                    {change.reason}
                  </span>
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem className={MENU_ROW} onClick={edit.onEdit}>
              Edit chart…
            </DropdownMenuItem>
            <DropdownMenuItem
              className={MENU_ROW}
              variant="destructive"
              onClick={edit.onRemove}
            >
              Remove from dashboard
            </DropdownMenuItem>
          </>
        ) : view ? (
          <>
            {view.openHref ? (
              <DropdownMenuItem
                className={MENU_ROW}
                render={<Link href={view.openHref as Route} />}
              >
                Open the records
              </DropdownMenuItem>
            ) : null}
            {view.onDownload ? (
              <DropdownMenuItem className={MENU_ROW} onClick={view.onDownload}>
                Download data (CSV)
              </DropdownMenuItem>
            ) : null}
            {view.onEdit || view.onRemove ? <DropdownMenuSeparator /> : null}
            {view.onEdit ? (
              <DropdownMenuItem className={MENU_ROW} onClick={view.onEdit}>
                Edit chart…
              </DropdownMenuItem>
            ) : null}
            {view.onRemove ? (
              <DropdownMenuItem
                className={MENU_ROW}
                variant="destructive"
                onClick={view.onRemove}
              >
                Remove from dashboard
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The module page with the widget's filters (BD5), as temporary changes. */
function recordsHref(config: OpenViewDashboardWidgetConfig): string {
  const definition = config.query.definition;
  const changes = encodeTemporaryDefinition({
    logic: definition.logic,
    filters: definition.filters,
    ...("mode" in config.query
      ? {}
      : {
          sort: definition.sort,
          search: definition.search,
          searchFields: definition.searchFields,
        }),
  });
  const href = moduleHref(config.query.moduleId);
  return changes ? `${href}&changes=${changes}` : href;
}

function downloadCsv(
  result: OpenViewAggregateSnapshotResult,
  title: string,
  config: OpenViewDashboardWidgetConfig | null,
) {
  const dateSeries =
    config !== null &&
    "mode" in config.query &&
    config.query.mode === "date_series";
  const csv = serializeCsv([
    [dateSeries ? "Date" : "Group", "Value", "Record count"],
    ...result.items.map((item) => [item.label, item.value, item.recordCount]),
  ]);
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${title.replace(/[^\w -]+/g, "").trim() || "dashboard-data"}.csv`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * The locked card's lock, drawn here: the shared lucide icon would move into
 * the chunk every cold page loads (tests/http/comms-js-budget.spec.ts).
 */
function LockMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      <rect width="18" height="11" x="3" y="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
