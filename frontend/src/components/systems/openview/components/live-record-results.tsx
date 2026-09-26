"use client";

import type {
  OpenViewDataSourceField,
  OpenViewPresentation,
  OpenViewRecord,
} from "../adapters/views-api";
import { PaginationControls } from "@/components/ui/pagination-controls";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LiveRecordCards } from "./live-record-cards";

const PAGE_SIZE = 25;

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
  title: string;
  scopeLabel: string;
  layoutDescription: string;
  page: RecordPage;
  cardLayout: "grid" | "gallery" | null;
  cardFields: readonly OpenViewDataSourceField[];
  tableFields: readonly OpenViewDataSourceField[];
  pinnedFieldId: string | null;
  presentation: ResultsPresentation;
  pending: boolean;
  onOpenRecord: (recordId: string) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
};

function recordValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return "—";
}

export function LiveRecordResults({
  title,
  scopeLabel,
  layoutDescription,
  page,
  cardLayout,
  cardFields,
  tableFields,
  pinnedFieldId,
  presentation,
  pending,
  onOpenRecord,
  onPreviousPage,
  onNextPage,
}: LiveRecordResultsProps) {
  return (
    <section
      className="bg-card min-w-0 overflow-hidden rounded-[var(--radius)] border"
      aria-label="Record results"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="font-medium">{title}</h2>
          <p className="text-muted-foreground text-sm">
            {page.total} {scopeLabel} · live workspace data
          </p>
        </div>
        <p className="text-muted-foreground text-xs">{layoutDescription}</p>
      </div>
      {page.loading ? (
        <p
          role="status"
          className="text-muted-foreground border-b px-4 py-2 text-sm"
        >
          Updating matching records. The last loaded page remains visible.
        </p>
      ) : null}
      {cardLayout ? (
        <div className="overflow-x-auto">
          <LiveRecordCards
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
      ) : (
        <Table className="min-w-[36rem] text-left text-sm">
          <TableHeader className="bg-muted/50 text-muted-foreground">
            <TableRow>
              {tableFields.map((field) => (
                <TableHead
                  key={field.id}
                  scope="col"
                  className={`px-4 py-3 font-medium ${field.id === pinnedFieldId ? "bg-muted/50 sticky left-0 z-20" : ""}`}
                >
                  {field.name}
                </TableHead>
              ))}
              <TableHead scope="col" className="px-4 py-3 font-medium">
                Updated
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y">
            {page.rows.map((row) => (
              <TableRow key={row.id}>
                {tableFields.map((field, index) => (
                  <TableCell
                    key={field.id}
                    className={`max-w-80 px-4 align-top ${presentation.density === "compact" ? "py-1.5" : "py-3"} ${presentation.wrap ? "break-words whitespace-normal" : "whitespace-nowrap"} ${field.id === pinnedFieldId ? "bg-card sticky left-0 z-10" : ""}`}
                  >
                    {index === 0 ? (
                      <button
                        type="button"
                        className="text-primary focus-visible:ring-ring min-h-11 text-left font-medium underline-offset-4 hover:underline focus-visible:ring-2"
                        onClick={() => onOpenRecord(row.id)}
                      >
                        {recordValue(row.data[field.id])}
                      </button>
                    ) : (
                      recordValue(row.data[field.id])
                    )}
                  </TableCell>
                ))}
                <TableCell
                  className={`text-muted-foreground px-4 align-top ${presentation.density === "compact" ? "py-1.5" : "py-3"}`}
                >
                  {new Intl.DateTimeFormat("en", {
                    dateStyle: "medium",
                  }).format(new Date(row.updatedAt))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
        <p aria-live="polite" className="text-muted-foreground text-sm">
          Showing {page.rows.length ? page.offset + 1 : 0}–
          {page.offset + page.rows.length} of {page.total} {scopeLabel}
        </p>
        <PaginationControls
          ariaLabel="Record result pages"
          className="w-auto justify-end"
          pageCount={Math.max(1, Math.ceil(page.total / PAGE_SIZE))}
          pageIndex={Math.floor(page.offset / PAGE_SIZE)}
          onPageIndexChange={(nextPage) => {
            if (page.loading || pending) return;
            if (nextPage < Math.floor(page.offset / PAGE_SIZE))
              onPreviousPage();
            else if (nextPage > Math.floor(page.offset / PAGE_SIZE))
              onNextPage();
          }}
        />
      </div>
    </section>
  );
}
