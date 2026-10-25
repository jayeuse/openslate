import { expect, test } from "@playwright/test";
import { copyFromCsv } from "../../../src/components/systems/openview/domain/report-copy";

test("a copy's CSV reads as headings, rows and group lines, capped for the page", () => {
  const csv =
    "﻿Quote,Status\r\n" +
    "Group: Open,\r\n" +
    'Q-1042,"Open, sent"\r\n' +
    "Q-1043,Open\r\n" +
    "Group total: 2,\r\n" +
    "Grand total: 2,\r\n";

  expect(copyFromCsv(csv, 500)).toEqual({
    headings: ["Quote", "Status"],
    rows: [
      { kind: "summary", cells: ["Group: Open", ""] },
      { kind: "row", cells: ["Q-1042", "Open, sent"] },
      { kind: "row", cells: ["Q-1043", "Open"] },
      { kind: "summary", cells: ["Group total: 2", ""] },
      { kind: "summary", cells: ["Grand total: 2", ""] },
    ],
    shown: 5,
    total: 5,
  });
  // The page shows the first rows; the CSV keeps them all.
  expect(copyFromCsv(csv, 2)).toMatchObject({ shown: 2, total: 5 });
  // A record whose first column reads like a group line is still a record.
  expect(copyFromCsv("Name,Status\r\nGroup: A,Open\r\n", 10).rows).toEqual([
    { kind: "row", cells: ["Group: A", "Open"] },
  ]);
});
