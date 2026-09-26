"use client";

import { Fragment, type ReactNode } from "react";
import {
  createPaginatedRowModel,
  rowPaginationFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type PaginationState,
  type RowData,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Workspace desktop tables share one headless model while each feature keeps
 * ownership of its filters, row actions, and mobile presentation.
 */
export const dataTableFeatures = tableFeatures({
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

export type DataTableColumn<TData extends RowData> = ColumnDef<
  typeof dataTableFeatures,
  TData
>;

export type DataTableProps<TData extends RowData> = {
  ariaLabel?: string;
  cellClassName?: string;
  className?: string;
  columns: DataTableColumn<TData>[];
  data: TData[];
  emptyState?: ReactNode;
  getRowId?: (originalRow: TData, index: number) => string;
  pagination?: PaginationState;
  onPaginationChange?: (pagination: PaginationState) => void;
  rowClassName?: (originalRow: TData) => string | undefined;
  renderExpandedRow?: (originalRow: TData) => ReactNode;
  rowState?: (originalRow: TData) => string | undefined;
};

export function DataTable<TData extends RowData>({
  ariaLabel,
  cellClassName,
  className,
  columns,
  data,
  emptyState,
  getRowId,
  pagination,
  onPaginationChange,
  rowClassName,
  rowState,
  renderExpandedRow,
}: DataTableProps<TData>) {
  const table = useTable({
    features: dataTableFeatures,
    columns,
    data,
    // Feature owners reset their controlled page when filters change. Without
    // this, a new array on render resets a user-requested page immediately.
    autoResetPageIndex: false,
    initialState: pagination
      ? undefined
      : { pagination: { pageIndex: 0, pageSize: Infinity } },
    ...(pagination
      ? {
          state: { pagination },
          onPaginationChange: (
            updater:
              PaginationState | ((old: PaginationState) => PaginationState),
          ) => {
            const next =
              typeof updater === "function" ? updater(pagination) : updater;
            onPaginationChange?.(next);
          },
        }
      : {}),
    ...(getRowId ? { getRowId } : {}),
  });
  const rows = table.getRowModel().rows;

  return (
    <Table className={cn(className)} aria-label={ariaLabel}>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <TableHead key={header.id} colSpan={header.colSpan}>
                {header.isPlaceholder ? null : (
                  <table.FlexRender header={header} />
                )}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {rows.length ? (
          rows.map((row) => {
            const expanded = renderExpandedRow?.(row.original);
            return (
              <Fragment key={row.id}>
                <TableRow
                  className={rowClassName?.(row.original)}
                  data-state={rowState?.(row.original)}
                >
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id} className={cellClassName}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
                {expanded != null && (
                  <TableRow>
                    <TableCell
                      colSpan={row.getAllCells().length}
                      className="p-0 whitespace-normal"
                    >
                      {expanded}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })
        ) : (
          <TableRow>
            <TableCell colSpan={Math.max(columns.length, 1)}>
              {emptyState ?? null}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
