import { expect, test } from "@playwright/test";
import { serializeCsv } from "../../../src/lib/csv";

test("shared CSV serialization preserves quoted cells and neutralizes formulas", () => {
  expect(
    serializeCsv([
      ["Name", "Details", "Count"],
      ["José", 'A "quoted" value\nSecond line', 0],
      ["  =SUM(1,2)", "\t+CMD", null],
      ["-4", "@user", undefined],
    ]),
  ).toBe(
    [
      '"Name","Details","Count"',
      '"José","A ""quoted"" value\nSecond line","0"',
      '"\'  =SUM(1,2)","\'\t+CMD",""',
      '"\'-4","\'@user",""',
    ].join("\r\n"),
  );
});
