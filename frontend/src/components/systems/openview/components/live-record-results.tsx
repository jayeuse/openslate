"use client";

import type {
  OpenViewDataSourceField,
  OpenViewPresentation,
  OpenViewRecord,
} from "../adapters/views-api";
import { Button } from "@/components/ui/button";
import { LiveRecordCards } from "./live-record-cards";

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
      <div className="overflow-x-auto">
        {cardLayout ? (
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
        ) : (
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                {tableFields.map((field) => (
                  <th
                    key={field.id}
                    scope="col"
                    className={`px-4 py-3 font-medium ${field.id === pinnedFieldId ? "bg-muted/50 sticky left-0 z-20" : ""}`}
                  >
                    {field.name}
                  </th>
                ))}
                <th scope="col" className="px-4 py-3 font-medium">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {page.rows.map((row) => (
                <tr key={row.id}>
                  {tableFields.map((field, index) => (
                    <td
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
                    </td>
                  ))}
                  <td
                    className={`text-muted-foreground px-4 align-top ${presentation.density === "compact" ? "py-1.5" : "py-3"}`}
                  >
                    {new Intl.DateTimeFormat("en", {
                      dateStyle: "medium",
                    }).format(new Date(row.updatedAt))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
        <p aria-live="polite" className="text-muted-foreground text-sm">
          Showing {page.offset + 1}–{page.offset + page.rows.length} of{" "}
          {page.total} {scopeLabel}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={page.offset === 0 || page.loading || pending}
            onClick={onPreviousPage}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!page.hasMore || page.loading || pending}
            onClick={onNextPage}
          >
            Next
          </Button>
        </div>
      </div>
    </section>
  );
}
