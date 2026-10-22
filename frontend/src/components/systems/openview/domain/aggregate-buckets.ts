import { z } from "zod";

export const aggregateBucketSchema = z.enum([
  "day",
  "week",
  "month",
  "quarter",
  "year",
]);
export type AggregateBucket = z.infer<typeof aggregateBucketSchema>;
export type AggregateWeekStart = "monday" | "sunday";

// Plain proleptic Gregorian dates. These checks run inside synchronous schema
// refinements on the shell's first load, so they use integer day numbers
// instead of loading a Temporal polyfill.
type CalendarDate = { year: number; month: number; day: number };

function daysInMonth(year: number, month: number) {
  if (month === 2)
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseCalendarDate(value: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError("Expected a YYYY-MM-DD calendar date");
  const [year, month, day] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month))
    throw new RangeError("Expected an existing calendar date");
  return { year, month, day };
}

/** Days since 1970-01-01 (Hinnant's days_from_civil). */
function dayNumber({ year, month, day }: CalendarDate) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

function fromDayNumber(value: number): CalendarDate {
  const shifted = value + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  return {
    year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0),
    month,
    day: dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1,
  };
}

/** ISO weekday: Monday is 1 and Sunday is 7. */
function isoWeekday(date: CalendarDate) {
  return ((((dayNumber(date) + 3) % 7) + 7) % 7) + 1;
}

function addMonths(date: CalendarDate, months: number): CalendarDate {
  const total = date.year * 12 + date.month - 1 + months;
  return { year: Math.floor(total / 12), month: (total % 12) + 1, day: 1 };
}

function formatCalendarDate({ year, month, day }: CalendarDate) {
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

function bucketStart(
  value: CalendarDate,
  bucket: AggregateBucket,
  weekStart: AggregateWeekStart,
): CalendarDate {
  switch (bucket) {
    case "week":
      return fromDayNumber(
        dayNumber(value) -
          ((isoWeekday(value) - 1 + (weekStart === "sunday" ? 1 : 0)) % 7),
      );
    case "month":
      return { ...value, day: 1 };
    case "quarter":
      return {
        year: value.year,
        month: Math.floor((value.month - 1) / 3) * 3 + 1,
        day: 1,
      };
    case "year":
      return { year: value.year, month: 1, day: 1 };
    default:
      return value;
  }
}

/** Exact bounded ISO calendar keys, including the partial first/last buckets. */
export function aggregateBucketKeys(
  from: string,
  to: string,
  bucket: AggregateBucket = "day",
  weekStart: AggregateWeekStart = "monday",
): string[] {
  const first = parseCalendarDate(from);
  const end = parseCalendarDate(to);
  if (first.year < 1 || end.year > 9999 || dayNumber(end) < dayNumber(first))
    throw new RangeError(
      "Date series end must not precede its supported start",
    );
  let current = bucketStart(first, bucket, weekStart);
  const last = formatCalendarDate(bucketStart(end, bucket, weekStart));
  if (current.year < 1)
    throw new RangeError(
      "The calendar bucket starts before the supported date range",
    );
  const keys: string[] = [];
  for (;;) {
    const key = formatCalendarDate(current);
    keys.push(key);
    if (keys.length > 366)
      throw new RangeError(
        "Date series must contain at most 366 calendar buckets",
      );
    if (key === last) return keys;
    current =
      bucket === "year"
        ? addMonths(current, 12)
        : bucket === "quarter"
          ? addMonths(current, 3)
          : bucket === "month"
            ? addMonths(current, 1)
            : fromDayNumber(dayNumber(current) + (bucket === "week" ? 7 : 1));
  }
}

/** Stored/request admission has no workspace I/O; actual weekly reads check its anchor. */
export function validAggregateBucketWindow(
  from: string,
  to: string,
  bucket: AggregateBucket = "day",
): boolean {
  for (const weekStart of bucket === "week"
    ? (["monday", "sunday"] as const)
    : (["monday"] as const)) {
    try {
      aggregateBucketKeys(from, to, bucket, weekStart);
      return true;
    } catch {
      /* Try the other legal anchor only for weekly schema admission. */
    }
  }
  return false;
}
