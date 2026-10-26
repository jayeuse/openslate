"use client";

import { useSyncExternalStore, type MouseEvent } from "react";
import type {
  OpenViewDataSourceField,
  OpenViewPresentation,
  OpenViewRecord,
} from "../adapters/views-api";
import { Card } from "@/components/ui/card";
import { TablePagination } from "@/components/ui/table-pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatOpenViewFieldValue,
  LiveRecordCards,
  RecordPersonCard,
} from "./live-record-cards";
import { openViewRecordFieldValue } from "../domain/record-display";
import { formatWorkspaceDate, type WorkspaceRegion } from "@/lib/date-time";
import { cn } from "@/lib/utils";
import {
  openRowClassName,
  RowOpenButton,
  tintRowClassName,
} from "@/components/systems/access/components/row-open-button";

const headClassName = "text-muted-foreground h-9 px-4 text-xs font-medium";

type RecordPage = {
  rows: readonly OpenViewRecord[];
  offset: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
};

type ResultsPresentation = Pick<
  OpenViewPresentation,
  "primaryFieldId" | "secondaryFieldId" | "cardSize" | "wrap" | "density"
>;

type LiveRecordResultsProps = {
  region: WorkspaceRegion | undefined;
  page: RecordPage;
  cardLayout: "grid" | "gallery" | null;
  cardFields: readonly OpenViewDataSourceField[];
  tableFields: readonly OpenViewDataSourceField[];
  pinnedFieldId: string | null;
  presentation: ResultsPresentation;
  pending: boolean;
  pageSize: number;
  /** The record open in the sheet, tinted in the list. */
  selectedId: string | null;
  onOpenRecord: (recordId: string) => void;
  onPageIndexChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
};

const NARROW_QUERY = "(max-width: 47.99rem)";

function subscribeNarrow(onChange: () => void) {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * True below the md breakpoint, where records are two-line rows. One layout
 * renders at a time, so no record is in the page twice; the first render
 * assumes a wide screen.
 */
export function useNarrowScreen(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

/** A cell's click opens the record, unless it hit a control of its own. */
function opensRecord(event: MouseEvent<HTMLElement>): boolean {
  return !(event.target as Element).closest("button, a, [role=button]");
}

export function LiveRecordResults({
  region,
  page,
  cardLayout,
  cardFields,
  tableFields,
  pinnedFieldId,
  presentation,
  pending,
  pageSize,
  selectedId,
  onOpenRecord,
  onPageIndexChange,
  onPageSizeChange,
}: LiveRecordResultsProps) {
  const narrow = useNarrowScreen();
  const cellValue = (row: OpenViewRecord, field: OpenViewDataSourceField) =>
    formatOpenViewFieldValue(
      openViewRecordFieldValue(row, field),
      field.type,
      region,
    );
  return (
    // The panel fills the page; only its rows scroll and the pager stays at
    // the bottom (OD6). The page header counts the records and reports a
    // refresh, so nothing here shifts while a page loads.
    <Card
      className="access-fill flex min-w-0 flex-col self-auto overflow-hidden"
      aria-label="Record results"
    >
      {cardLayout ? (
        <div className="min-h-0 overflow-x-auto xl:flex-1 xl:overflow-y-auto xl:overscroll-contain">
          <LiveRecordCards
            region={region}
            layout={cardLayout}
            rows={page.rows}
            fields={cardFields}
            primaryFieldId={presentation.primaryFieldId}
            secondaryFieldId={presentation.secondaryFieldId}
            cardSize={presentation.cardSize}
            wrap={presentation.wrap}
            onOpenRecord={onOpenRecord}
          />
        </div>
      ) : narrow ? (
        // Phones: a two-line row per record, its name, then the next two
        // filled fields (DESIGN.md, Access phone rows).
        <ul aria-label="Records" className="divide-border divide-y">
          {page.rows.map((row) => {
            const [first, ...rest] = tableFields;
            const title = first ? cellValue(row, first) : "Open record";
            const details = rest
              .map((field) => cellValue(row, field))
              .filter((value) => value && value !== "—")
              .slice(0, 2)
              .join(" · ");
            return (
              <li
                key={row.id}
                data-record-id={row.id}
                data-state={row.id === selectedId ? "selected" : undefined}
                className={cn(
                  openRowClassName,
                  tintRowClassName,
                  "flex min-h-14 items-center px-4 py-1.5",
                )}
              >
                {/* The name names the button; the second line describes it. */}
                <RowOpenButton
                  title={title}
                  subtitle={details || undefined}
                  label={
                    first?.type === "user" ? `Open record: ${title}` : title
                  }
                  onOpen={() => onOpenRecord(row.id)}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="access-fill access-scroll-table">
          <Table className="min-w-[36rem] text-left text-sm">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {tableFields.map((field) => (
                  <TableHead
                    key={field.id}
                    scope="col"
                    className={cn(
                      headClassName,
                      field.id === pinnedFieldId &&
                        "bg-card sticky left-0 z-20",
                    )}
                  >
                    {field.name}
                  </TableHead>
                ))}
                <TableHead scope="col" className={headClassName}>
                  Updated
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.rows.map((row) => (
                // OD6: one line per record; the whole row opens it.
                // A pinned cell is sticky, which keeps the open button's
                // overlay inside it, so the row opens the record itself.
                <TableRow
                  key={row.id}
                  data-record-id={row.id}
                  data-state={row.id === selectedId ? "selected" : undefined}
                  className={cn(
                    openRowClassName,
                    tintRowClassName,
                    "group",
                    presentation.density === "compact"
                      ? "h-11 xl:h-8"
                      : "h-11 xl:h-10",
                  )}
                  onClick={(event) => {
                    if (opensRecord(event)) onOpenRecord(row.id);
                  }}
                >
                  {tableFields.map((field, index) => {
                    const value = cellValue(row, field);
                    return (
                      <TableCell
                        key={field.id}
                        className={cn(
                          "max-w-80 overflow-hidden px-4 align-middle xl:max-w-60",
                          presentation.wrap
                            ? cn(
                                "break-words whitespace-normal",
                                presentation.density === "compact"
                                  ? "py-1.5"
                                  : "py-2.5",
                              )
                            : "py-0 whitespace-nowrap",
                          field.id === pinnedFieldId &&
                            "bg-card sticky left-0 z-10 group-hover:bg-[color-mix(in_oklab,var(--ink)_6%,var(--card))] group-data-[state=selected]:bg-[color-mix(in_oklab,var(--ink)_14%,var(--card))]",
                        )}
                      >
                        {index === 0 ? (
                          <span className="flex min-w-0 items-center gap-2">
                            <RowOpenButton
                              title={
                                field.type === "user" ? "Open record" : value
                              }
                              label={
                                field.type === "user"
                                  ? `Open record: ${value}`
                                  : undefined
                              }
                              inline
                              onOpen={() => onOpenRecord(row.id)}
                            />
                            {field.type === "user" ? (
                              <RecordPersonCard row={row} field={field} inline>
                                {value}
                              </RecordPersonCard>
                            ) : null}
                          </span>
                        ) : (
                          <RecordPersonCard row={row} field={field} inline>
                            <span className="block truncate">{value}</span>
                          </RecordPersonCard>
                        )}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-muted-foreground px-4 py-0 align-middle whitespace-nowrap">
                    {region
                      ? formatWorkspaceDate(row.updatedAt, region)
                      : "Date unavailable"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <TablePagination
        ariaLabel="Record result pages"
        total={page.total}
        offset={page.offset}
        rowCount={page.rows.length}
        pageSize={pageSize}
        onPageIndexChange={onPageIndexChange}
        onPageSizeChange={onPageSizeChange}
        disabled={page.loading || pending}
      />
    </Card>
  );
}
