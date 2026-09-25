import {
  completeCollection,
  pageCollection,
  type CompleteCollection,
  type PageResult,
} from "../../shared/helpers/sample-collections";
import type { SampleRecord } from "../../shared/data/sample-data";
import type { PlatformImportRow } from "./model";

export function normalizePlatformImportRows(
  rows: readonly PlatformImportRow[],
) {
  return rows
    .map((row) => ({
      title: row.title.trim(),
      customer: row.customer.trim(),
      assignee: row.assignee.trim() || "Unassigned",
      dueDate: row.dueDate.trim(),
    }))
    .filter((row) => row.title.length > 0);
}

export function pagePlatformSearch<T extends { title: string }>(
  items: readonly T[],
  query: string,
  queryKey: string,
  limit = 8,
): { complete: CompleteCollection<T>; page: PageResult<T> } {
  const normalized = query.trim().toLowerCase();
  const complete = completeCollection(
    items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.title.toLowerCase().includes(normalized))
      .sort(
        (left, right) =>
          left.item.title.localeCompare(right.item.title) ||
          left.index - right.index,
      )
      .map(({ item }) => item),
    queryKey,
  );
  return { complete, page: pageCollection(complete, 0, limit) };
}

export function completePlatformExport(
  records: readonly SampleRecord[],
): CompleteCollection<SampleRecord> {
  return completeCollection(records, "platform:records:export");
}
