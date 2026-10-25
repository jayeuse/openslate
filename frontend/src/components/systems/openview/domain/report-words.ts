import {
  formatWorkspaceDateTime,
  type WorkspaceRegion,
} from "@/lib/date-time-display";
import type { OpenViewReportRecipe } from "../adapters/reports-api";

// The words of a module page's Reports view (DC2, DC4, DC11). A report reads
// as one sentence in three steps: what it lists, when it runs, what you keep.
// Pure, so tests/isolated/openview/report-words.spec.ts owns them.

/** The schedule facts the words need (`OpenViewReportSchedule`). */
export type ReportScheduleFacts = {
  enabled: boolean;
  cadence: "daily" | "weekly" | "monthly";
  /** 0 is Monday, as the API counts. */
  weekday: number | null;
  monthDay: number | null;
};

export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st, 31st. */
export function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  const suffix = ["th", "st", "nd", "rd"][day % 10] ?? "th";
  return `${day}${day % 10 > 3 ? "th" : suffix}`;
}

/**
 * A module name inside a sentence: "Sales Orders" reads "sales orders", while
 * acronyms and mixed-case words keep their case ("PO lines", "eBay listings").
 */
export function lowerName(name: string): string {
  return name
    .split(" ")
    .map((word) => (/^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word))
    .join(" ");
}

/** Whether a schedule makes copies on its own. */
export function isScheduled(
  schedule: ReportScheduleFacts | null | undefined,
): schedule is ReportScheduleFacts {
  return Boolean(schedule?.enabled);
}

/**
 * When a report runs, in words: "Every Monday", "Every day", "On the 1st of
 * each month", or "When someone makes a copy" without a running schedule.
 */
export function cadenceWords(
  schedule: ReportScheduleFacts | null | undefined,
): string {
  if (!isScheduled(schedule)) return "When someone makes a copy";
  if (schedule.cadence === "daily") return "Every day";
  if (schedule.cadence === "weekly")
    return `Every ${WEEKDAYS[schedule.weekday ?? 0] ?? "week"}`;
  return `On the ${ordinal(schedule.monthDay ?? 1)} of each month`;
}

/** "Every Monday at 08:00"; the time comes formatted for the viewer. */
export function runsWords(
  schedule: ReportScheduleFacts | null | undefined,
  time: string,
): string {
  const cadence = cadenceWords(schedule);
  return isScheduled(schedule) ? `${cadence} at ${time}` : cadence;
}

/** "No copies yet", "1 copy", "12 copies". */
export function copiesWords(total: number): string {
  if (total === 0) return "No copies yet";
  return `${total} ${total === 1 ? "copy" : "copies"}`;
}

/** A list row's plain line: "Every Monday · 12 copies". */
export function reportListLine(
  schedule: ReportScheduleFacts | null | undefined,
  copies: number,
): string {
  return `${cadenceWords(schedule)} · ${copiesWords(copies)}`;
}

/**
 * What a report lists, as step 1 says it: "All quotes" or "Quotes that match
 * 2 filters", then ", grouped by Status" when it groups.
 */
export function listsWords(
  recipe: Pick<OpenViewReportRecipe, "filters" | "groupBy">,
  moduleName: string,
  fieldName: (fieldId: string) => string | undefined,
): string {
  const records = moduleName.trim() || "records";
  const filters = recipe.filters.length;
  const base = filters
    ? `${records} that match ${filters} ${filters === 1 ? "filter" : "filters"}`
    : `All ${lowerName(records)}`;
  const group = recipe.groupBy ? fieldName(recipe.groupBy.fieldId) : undefined;
  return group ? `${base}, grouped by ${group}` : base;
}

/** Step 1's second line: "8 columns · with the number of rows". */
export function columnsWords(
  recipe: Pick<OpenViewReportRecipe, "fields" | "includeRowCount">,
): string {
  const count = recipe.fields.length;
  const columns = `${count} ${count === 1 ? "column" : "columns"}`;
  return recipe.includeRowCount
    ? `${columns} · with the number of rows`
    : columns;
}

function dateParts(
  value: string,
  region: WorkspaceRegion | undefined,
  options: Omit<Intl.DateTimeFormatOptions, "timeZone">,
): string {
  if (region) return formatWorkspaceDateTime(value, region, options);
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, options).format(date);
}

/** "Mon, Oct 20", in the viewer's display region. */
export function shortDate(
  value: string,
  region: WorkspaceRegion | undefined,
): string {
  return dateParts(value, region, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** "Mon, Oct 20 at 8:00 AM": when a copy was made, or the next one is due. */
export function copyDate(
  value: string,
  region: WorkspaceRegion | undefined,
): string {
  const time = dateParts(value, region, { hour: "numeric", minute: "2-digit" });
  return `${shortDate(value, region)} at ${time}`;
}
