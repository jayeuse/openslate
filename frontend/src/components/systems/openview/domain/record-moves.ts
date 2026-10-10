import { Temporal } from "@js-temporal/polyfill";
import { datetimeInputToUtc } from "@/lib/date-time";
import type {
  OpenViewDataSourceField,
  OpenViewRecord,
} from "../adapters/views-api";

export type RecordMoveChange = {
  fieldId: string;
  value: string | boolean | null;
};
export type RecordMoveCommand =
  | ({ kind: "single" } & RecordMoveChange)
  | {
      kind: "compound";
      changes: readonly [RecordMoveChange, RecordMoveChange];
    };
export type PendingRecordMove = RecordMoveCommand & {
  original: OpenViewRecord;
  targetLabel: string;
  status?: "stale" | "invalid" | "forbidden";
  error?: string;
};
export type DateMoveProps = {
  canWrite: boolean;
  movesPending: boolean;
  pendingMoves: ReadonlyMap<string, PendingRecordMove>;
  onMoveDates: (
    record: OpenViewRecord,
    command: RecordMoveCommand,
    targetLabel: string,
    fieldIds: readonly string[],
  ) => void;
};

export function recordMoveChanges(
  command: RecordMoveCommand,
): readonly RecordMoveChange[] {
  return command.kind === "single"
    ? [{ fieldId: command.fieldId, value: command.value }]
    : command.changes;
}

export function effectiveMoveRecord(
  record: OpenViewRecord,
  move: PendingRecordMove | undefined,
): OpenViewRecord {
  return move
    ? {
        ...record,
        data: {
          ...record.data,
          ...Object.fromEntries(
            recordMoveChanges(move).map(({ fieldId, value }) => [
              fieldId,
              value,
            ]),
          ),
        },
      }
    : record;
}

function recordInstant(value: string) {
  return Temporal.Instant.from(
    /(?:z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`,
  );
}

/** Compare DATETIME instants without normalizing the record's original data. */
export function sameRecordMoveValue(
  original: unknown,
  value: RecordMoveChange["value"],
  fieldType: OpenViewDataSourceField["type"] | undefined,
): boolean {
  if (fieldType !== "datetime" || original == null || value === null)
    return (original ?? null) === value;
  if (typeof original !== "string" || typeof value !== "string") return false;
  try {
    return (
      Temporal.Instant.compare(
        recordInstant(original),
        recordInstant(value),
      ) === 0
    );
  } catch {
    return false;
  }
}

export function recordMoveDay(
  value: unknown,
  type: "date" | "datetime",
  timezone: string | null,
): string | null {
  try {
    if (typeof value !== "string") return null;
    if (type === "date")
      return Temporal.PlainDate.from(value).toString() === value ? value : null;
    if (!timezone) return null;
    return recordInstant(value)
      .toZonedDateTimeISO(timezone)
      .toPlainDate()
      .toString();
  } catch {
    return null;
  }
}

/** Replace the local date only; never truncate the stored wall-clock precision. */
export function recordMoveLocal(
  value: unknown,
  date: string,
  timezone: string,
): string {
  const day = Temporal.PlainDate.from(date);
  if (day.toString() !== date) throw new Error("Choose a valid calendar date.");
  const local =
    value == null
      ? day.toPlainDateTime()
      : typeof value === "string"
        ? recordInstant(value)
            .toZonedDateTimeISO(timezone)
            .toPlainDateTime()
            .with({ year: day.year, month: day.month, day: day.day })
        : null;
  if (!local)
    throw new Error(
      "This record has no valid schedule time. Repair it in record details.",
    );
  return local.toString();
}

export function moveDateValue(
  value: unknown,
  type: "date" | "datetime",
  date: string,
  timezone: string | null,
  offset?: string,
): string {
  const day = Temporal.PlainDate.from(date);
  if (day.toString() !== date) throw new Error("Choose a valid calendar date.");
  if (type === "date") return day.toString();
  if (!timezone)
    throw new Error("Load the workspace timezone before moving this record.");
  return datetimeInputToUtc(
    recordMoveLocal(value, date, timezone),
    timezone,
    offset,
  );
}

export function shiftMoveDay(date: string, days: number): string {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}
export function moveDayDifference(from: string, to: string): number {
  return Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to)).days;
}

export function validMoveInterval(
  start: unknown,
  startType: "date" | "datetime",
  end: unknown,
  endType: "date" | "datetime",
  timezone: string | null,
): boolean {
  const first = recordMoveDay(start, startType, timezone);
  const last = recordMoveDay(end, endType, timezone);
  if (!first || !last || last < first) return false;
  if (
    startType === "datetime" &&
    endType === "datetime" &&
    typeof start === "string" &&
    typeof end === "string"
  ) {
    try {
      return (
        Temporal.Instant.compare(recordInstant(start), recordInstant(end)) <= 0
      );
    } catch {
      return false;
    }
  }
  return true;
}
