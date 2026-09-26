"use client";

import type {
  OpenViewAnalyticsPagination,
  OpenViewGroupSelector,
} from "../adapters/analytics-api";
import { Button } from "@/components/ui/button";
import { TablePagination } from "@/components/ui/table-pagination";

type GroupOption = {
  key: string;
  label: string;
  count: number;
  selected: boolean;
  selector: OpenViewGroupSelector;
};

type LiveGroupedResultsProps = {
  fieldName: string;
  range: string;
  loading: boolean;
  error: string;
  hasPage: boolean;
  groups: readonly GroupOption[];
  pagination: Pick<
    OpenViewAnalyticsPagination,
    "offset" | "hasMore" | "limit" | "total"
  > | null;
  selectedGroup: OpenViewGroupSelector | null;
  pending: boolean;
  onRetry: () => void;
  onSelectGroup: (group: OpenViewGroupSelector) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
};

export function LiveGroupedResults({
  fieldName,
  range,
  loading,
  error,
  hasPage,
  groups,
  pagination,
  selectedGroup,
  pending,
  onRetry,
  onSelectGroup,
  onPreviousPage,
  onNextPage,
}: LiveGroupedResultsProps) {
  return (
    <section
      aria-label="Grouping results"
      className="bg-card min-w-0 overflow-hidden rounded-[var(--radius)] border"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="font-medium">Groups by {fieldName}</h2>
          <p className="text-muted-foreground text-sm">
            Counts include all matching records. Only the selected group’s page
            of records is loaded.
          </p>
        </div>
        <p aria-live="polite" className="text-muted-foreground text-sm">
          {loading ? "Loading groups…" : range}
        </p>
      </div>

      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <p role="alert">{error}</p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={loading || pending}
            onClick={onRetry}
          >
            {selectedGroup ? "Retry group records" : "Retry groups"}
          </Button>
        </div>
      ) : null}

      {loading && !hasPage ? (
        <p
          role="status"
          className="text-muted-foreground px-4 py-8 text-center"
        >
          Loading groups…
        </p>
      ) : groups.length ? (
        <ul
          aria-label="View groups"
          className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {groups.map((group) => (
            <li key={group.key} className="min-w-0">
              <button
                type="button"
                aria-pressed={group.selected}
                aria-label={`${group.label}, ${group.count} records`}
                className={`focus-visible:ring-ring flex min-h-11 w-full min-w-0 items-center justify-between gap-3 rounded-[var(--radius)] border px-3 py-2 text-left focus-visible:ring-2 ${group.selected ? "border-primary bg-primary/5" : "bg-background hover:bg-muted/50"}`}
                disabled={pending}
                onClick={() => onSelectGroup(group.selector)}
              >
                <span className="truncate font-medium">{group.label}</span>
                <span className="text-muted-foreground shrink-0 text-sm">
                  {group.count}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : hasPage ? (
        <p className="text-muted-foreground px-4 py-8 text-center">
          No groups match this view.
        </p>
      ) : null}

      {pagination ? (
        <TablePagination
          ariaLabel="Group result pages"
          total={pagination.total}
          offset={pagination.offset}
          rowCount={groups.length}
          pageSize={pagination.limit}
          onPageIndexChange={(nextPage) => {
            const pageIndex = Math.floor(pagination.offset / pagination.limit);
            if (loading || error || pending) return;
            if (nextPage < pageIndex) onPreviousPage();
            else if (nextPage > pageIndex) onNextPage();
          }}
          disabled={loading || Boolean(error) || pending}
        />
      ) : null}
    </section>
  );
}
