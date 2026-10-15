import { expect, test } from "@playwright/test";
import {
  moveDateValue,
  moveDayDifference,
  recordMoveDay,
  sameRecordMoveValue,
  shiftMoveDay,
} from "../../../src/components/systems/openview/domain/record-moves";

// The workspace zone of every case: daylight saving starts on 2026-03-08.
const zone = "America/New_York";

for (const current of [
  {
    name: "keeps the workspace wall time and fractional seconds across DST",
    value: "2026-03-07T14:15:30.123456Z",
    day: "2026-03-08",
    moved: "2026-03-08T13:15:30.123456Z",
  },
  {
    name: "starts an undated record at the workspace midnight",
    value: null,
    day: "2026-03-09",
    moved: "2026-03-09T04:00:00Z",
  },
  {
    name: "reads a timezone-free value as UTC and keeps its wall time",
    value: "2026-03-07T01:15:30.123456",
    day: "2026-03-08",
    moved: "2026-03-09T00:15:30.123456Z",
  },
]) {
  test(`a datetime move ${current.name}`, () => {
    expect(moveDateValue(current.value, "datetime", current.day, zone)).toBe(
      current.moved,
    );
  });
}

test("a timezone-free datetime belongs to the workspace day before its UTC midnight", () => {
  expect(recordMoveDay("2026-03-07T01:15:30.123456", "datetime", zone)).toBe(
    "2026-03-06",
  );
});

test("a mixed date and datetime interval shifts both fields by the same days across DST", () => {
  const start = "2026-03-07";
  const end = "2026-03-07T16:20:45.123456Z";
  const days = moveDayDifference(start, "2026-03-08");
  const endDay = recordMoveDay(end, "datetime", zone);
  expect(days).toBe(1);
  expect(endDay).toBe("2026-03-07");
  expect(moveDateValue(start, "date", "2026-03-08", zone)).toBe("2026-03-08");
  expect(
    moveDateValue(end, "datetime", shiftMoveDay(endDay!, days), zone),
  ).toBe("2026-03-08T15:20:45.123456Z");
});

test("returning a timezone-free datetime to its original workspace day is no change", () => {
  const original = "2026-03-07T01:15:30.123456";
  const returned = moveDateValue(original, "datetime", "2026-03-06", zone);
  expect(returned).toBe("2026-03-07T01:15:30.123456Z");
  expect(sameRecordMoveValue(original, returned, "datetime")).toBe(true);
  expect(
    sameRecordMoveValue(original, "2026-03-09T00:15:30.123456Z", "datetime"),
  ).toBe(false);
});
