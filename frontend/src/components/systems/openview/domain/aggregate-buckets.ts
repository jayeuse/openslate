import { Temporal } from "@js-temporal/polyfill";
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

function bucketStart(
  value: Temporal.PlainDate,
  bucket: AggregateBucket,
  weekStart: AggregateWeekStart,
) {
  switch (bucket) {
    case "week":
      return value.subtract({
        days: (value.dayOfWeek - 1 + (weekStart === "sunday" ? 1 : 0)) % 7,
      });
    case "month":
      return value.with({ day: 1 });
    case "quarter":
      return value.with({
        month: Math.floor((value.month - 1) / 3) * 3 + 1,
        day: 1,
      });
    case "year":
      return value.with({ month: 1, day: 1 });
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
  const first = Temporal.PlainDate.from(from);
  const end = Temporal.PlainDate.from(to);
  if (
    first.year < 1 ||
    end.year > 9999 ||
    Temporal.PlainDate.compare(end, first) < 0
  )
    throw new RangeError(
      "Date series end must not precede its supported start",
    );
  let current = bucketStart(first, bucket, weekStart);
  const last = bucketStart(end, bucket, weekStart);
  if (current.year < 1)
    throw new RangeError(
      "The calendar bucket starts before the supported date range",
    );
  const keys: string[] = [];
  const stride =
    bucket === "year"
      ? { years: 1 }
      : bucket === "quarter"
        ? { months: 3 }
        : bucket === "month"
          ? { months: 1 }
          : { days: bucket === "week" ? 7 : 1 };
  for (;;) {
    keys.push(current.toString());
    if (keys.length > 366)
      throw new RangeError(
        "Date series must contain at most 366 calendar buckets",
      );
    if (current.equals(last)) return keys;
    current = current.add(stride);
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
