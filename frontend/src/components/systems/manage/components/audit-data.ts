import { serializeCsv } from "@/lib/csv";
import {
  completeCollection,
  pageCollection,
  type CompleteCollection,
} from "../../shared/helpers/page-collections";
import type { ManageActivityEntry } from "../state/model";

export const MANAGE_ACTIVITY_PAGE_SIZE = 5;
const PAGE_SIZE = MANAGE_ACTIVITY_PAGE_SIZE;

export type ActivityOrder = "newest" | "oldest";

export type ActivityFilters = {
  query: string;
  user: string;
  entity: string;
  action: string;
  from: string;
  to: string;
  order: ActivityOrder;
};

export const initialActivityFilters: ActivityFilters = {
  query: "",
  user: "All users",
  entity: "All entities",
  action: "All actions",
  from: "",
  to: "",
  order: "newest",
};

export function uniqueValues(
  entries: readonly ManageActivityEntry[],
  key: keyof ManageActivityEntry,
) {
  return [
    ...new Set(
      entries
        .map((entry) => String(entry[key]))
        .filter((value) => value.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function dateOnly(value: string): string {
  const datePrefix = /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1];
  if (datePrefix) return datePrefix;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString().slice(0, 10)
    : value;
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareDates(left: string, right: string): number {
  const leftTimestamp = timestamp(left);
  const rightTimestamp = timestamp(right);
  if (leftTimestamp !== null && rightTimestamp !== null)
    return leftTimestamp - rightTimestamp;
  if (leftTimestamp !== null) return 1;
  if (rightTimestamp !== null) return -1;
  return left.localeCompare(right);
}

function matchesSearch(entry: ManageActivityEntry, query: string): boolean {
  if (!query) return true;
  return [
    entry.user,
    entry.entity,
    entry.action,
    entry.target,
    entry.before,
    entry.after,
  ].some((value) => value.toLowerCase().includes(query));
}

export function buildActivityCsv(
  entries: readonly ManageActivityEntry[],
): string {
  const header = [
    "Date",
    "User",
    "Entity",
    "Action",
    "Target",
    "Before",
    "After",
    "Source",
  ];
  const rows = entries.map((entry) => [
    entry.date,
    entry.user,
    entry.entity,
    entry.action,
    entry.target,
    entry.before,
    entry.after,
    entry.source === "manage" ? "Your change" : "Preloaded",
  ]);
  return serializeCsv([header, ...rows]);
}

export function queryManageActivity(
  source: CompleteCollection<ManageActivityEntry>,
  filters: ActivityFilters,
  offset: number,
) {
  const normalizedQuery = filters.query.trim().toLowerCase();
  const filtered = source.items.filter(
    (entry) =>
      matchesSearch(entry, normalizedQuery) &&
      (filters.user === "All users" || entry.user === filters.user) &&
      (filters.entity === "All entities" || entry.entity === filters.entity) &&
      (filters.action === "All actions" || entry.action === filters.action) &&
      (!filters.from || dateOnly(entry.date) >= filters.from) &&
      (!filters.to || dateOnly(entry.date) <= filters.to),
  );
  const sorted = [...filtered].sort((left, right) => {
    const dateComparison = compareDates(left.date, right.date);
    if (dateComparison !== 0)
      return filters.order === "newest" ? -dateComparison : dateComparison;
    return left.id.localeCompare(right.id);
  });

  const complete = completeCollection(sorted, JSON.stringify(filters));
  return { complete, page: pageCollection(complete, offset, PAGE_SIZE) };
}
