"use client";

import type {
  OpenViewDataSourceField,
  OpenViewRecord,
} from "../adapters/views-api";
import { openViewRecordFieldValue } from "../domain/record-display";
import {
  formatWorkspaceDate,
  formatWorkspaceDateTime,
  type WorkspaceRegion,
} from "@/lib/date-time";

type LiveRecordCardLayout = "grid" | "gallery";

type LiveRecordCardsProps = {
  region: WorkspaceRegion | undefined;
  layout: LiveRecordCardLayout;
  rows: readonly OpenViewRecord[];
  fields: readonly OpenViewDataSourceField[];
  primaryFieldId: string | null;
  secondaryFieldId: string | null;
  cardSize: "comfortable" | "compact";
  wrap: boolean;
  onOpenRecord: (recordId: string) => void;
};

/**
 * One reading of a record field value for OpenView lists, cards and the
 * timeline: dates follow the workspace region, booleans read Yes or No, and an
 * empty value shows the caller's fallback.
 */
export function formatOpenViewFieldValue(
  value: unknown,
  type: OpenViewDataSourceField["type"],
  region: WorkspaceRegion | undefined,
  fallback = "—",
): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : fallback;
  if (typeof value !== "string" || !value.trim()) return fallback;
  if (region && type === "date") return formatWorkspaceDate(value, region);
  if (region && type === "datetime") {
    // Stored datetimes without an offset are UTC, as the calendar reads them.
    const instant = /(?:z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`;
    return formatWorkspaceDateTime(instant, region);
  }
  return value;
}

function recordValue(
  row: OpenViewRecord,
  field: OpenViewDataSourceField,
  region: WorkspaceRegion | undefined,
): string {
  return formatOpenViewFieldValue(
    openViewRecordFieldValue(row, field),
    field.type,
    region,
  );
}

function updatedDate(
  value: string,
  region: WorkspaceRegion | undefined,
): string {
  return region ? formatWorkspaceDate(value, region) : "Date unavailable";
}

export function LiveRecordCards({
  region,
  layout,
  rows,
  fields,
  primaryFieldId,
  secondaryFieldId,
  cardSize,
  wrap,
  onOpenRecord,
}: LiveRecordCardsProps) {
  const primaryField =
    fields.find((field) => field.id === primaryFieldId) ?? fields[0];
  const secondaryField = fields.find(
    (field) => field.id === secondaryFieldId && field.id !== primaryField?.id,
  );
  const detailFields = fields.filter(
    (field) => field.id !== primaryField?.id && field.id !== secondaryField?.id,
  );
  const listName = layout === "grid" ? "Grid records" : "Gallery records";
  const columnsClass =
    layout === "grid"
      ? cardSize === "compact"
        ? "sm:grid-cols-2 xl:grid-cols-4"
        : "sm:grid-cols-2 xl:grid-cols-3"
      : cardSize === "compact"
        ? "sm:grid-cols-2 xl:grid-cols-3"
        : "sm:grid-cols-2";

  return (
    <ul
      aria-label={listName}
      className={`grid grid-cols-1 ${cardSize === "compact" ? "gap-2 p-2" : "gap-3 p-3"} ${columnsClass}`}
    >
      {rows.map((row) => {
        const primaryValue = primaryField
          ? formatOpenViewFieldValue(
              openViewRecordFieldValue(row, primaryField),
              primaryField.type,
              region,
              "Untitled record",
            )
          : "Untitled record";
        return (
          <li key={row.id} className="min-w-0">
            <article
              aria-labelledby={`openview-card-title-${row.id}`}
              className={`bg-background flex h-full min-w-0 flex-col rounded-[var(--radius)] border ${cardSize === "compact" ? "min-h-28 gap-3 p-3" : "min-h-36 gap-4 p-4"} ${layout === "gallery" && cardSize === "comfortable" ? "sm:p-5" : ""}`}
            >
              <header className="min-w-0">
                <h3
                  id={`openview-card-title-${row.id}`}
                  className={
                    layout === "gallery"
                      ? "text-lg font-semibold"
                      : "font-semibold"
                  }
                >
                  <button
                    type="button"
                    aria-label={`Open record: ${primaryValue}`}
                    className="text-primary focus-visible:ring-ring min-h-11 max-w-full min-w-11 text-left underline-offset-4 hover:underline focus-visible:ring-2"
                    onClick={() => onOpenRecord(row.id)}
                  >
                    <span
                      className={
                        wrap
                          ? "block break-words whitespace-normal"
                          : "block truncate"
                      }
                    >
                      {primaryValue}
                    </span>
                  </button>
                </h3>
                {secondaryField ? (
                  <p
                    className={`text-muted-foreground mt-1 text-sm ${wrap ? "break-words" : "truncate whitespace-nowrap"}`}
                  >
                    {secondaryField.name}:{" "}
                    {recordValue(row, secondaryField, region)}
                  </p>
                ) : null}
              </header>
              {detailFields.length > 0 ? (
                <dl
                  className={`grid min-w-0 gap-x-4 gap-y-3 text-sm ${layout === "gallery" ? "sm:grid-cols-2" : "grid-cols-1"}`}
                >
                  {detailFields.map((field) => (
                    <div key={field.id} className="min-w-0">
                      <dt
                        className={
                          wrap
                            ? "text-muted-foreground break-words"
                            : "text-muted-foreground truncate"
                        }
                      >
                        {field.name}
                      </dt>
                      <dd
                        className={
                          wrap ? "break-words" : "truncate whitespace-nowrap"
                        }
                      >
                        {recordValue(row, field, region)}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              <p className="text-muted-foreground mt-auto text-xs">
                Updated{" "}
                <time dateTime={row.updatedAt}>
                  {updatedDate(row.updatedAt, region)}
                </time>
              </p>
            </article>
          </li>
        );
      })}
    </ul>
  );
}
