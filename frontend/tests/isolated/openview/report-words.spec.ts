import { expect, test } from "@playwright/test";
import {
  columnsWords,
  listsWords,
  lowerName,
  reportListLine,
  runsWords,
} from "../../../src/components/systems/openview/domain/report-words";

const statusFieldId = "00000000-0000-4000-8000-000000000003";

test("a report's list line says when it runs and how many copies it keeps", () => {
  const weekly = {
    enabled: true,
    cadence: "weekly",
    weekday: 0,
    monthDay: null,
  } as const;
  const rows: Array<[Parameters<typeof reportListLine>[0], number, string]> = [
    [weekly, 12, "Every Monday · 12 copies"],
    [{ ...weekly, cadence: "daily", weekday: null }, 1, "Every day · 1 copy"],
    [
      { ...weekly, cadence: "monthly", weekday: null, monthDay: 1 },
      7,
      "On the 1st of each month · 7 copies",
    ],
    [
      { ...weekly, cadence: "monthly", weekday: null, monthDay: 22 },
      0,
      "On the 22nd of each month · No copies yet",
    ],
    [
      { ...weekly, cadence: "monthly", weekday: null, monthDay: 11 },
      2,
      "On the 11th of each month · 2 copies",
    ],
    // A paused schedule and no schedule both make copies only by hand.
    [{ ...weekly, enabled: false }, 3, "When someone makes a copy · 3 copies"],
    [null, 3, "When someone makes a copy · 3 copies"],
  ];
  for (const [schedule, copies, line] of rows)
    expect(reportListLine(schedule, copies)).toBe(line);
  expect(runsWords(weekly, "08:00")).toBe("Every Monday at 08:00");
  expect(runsWords(null, "08:00")).toBe("When someone makes a copy");
});

test("step 1 says what a report lists in words", () => {
  const field = (id: string) => (id === statusFieldId ? "Status" : undefined);
  expect(
    listsWords(
      {
        filters: [],
        groupBy: { fieldId: statusFieldId, expectedType: "select" },
      },
      "Quotes",
      field,
    ),
  ).toBe("All quotes, grouped by Status");
  expect(
    listsWords(
      {
        filters: [
          {
            fieldId: statusFieldId,
            expectedType: "select",
            operator: "in",
            value: ["open"],
          },
        ],
        groupBy: null,
      },
      "Quotes",
      field,
    ),
  ).toBe("Quotes that match 1 filter");
  expect(columnsWords({ fields: [], includeRowCount: true })).toBe(
    "0 columns · with the number of rows",
  );
  expect(
    columnsWords({
      fields: [{ fieldId: statusFieldId, expectedType: "select" }],
      includeRowCount: false,
    }),
  ).toBe("1 column");
});

test("a module name in a sentence lowers ordinary words and keeps acronyms", () => {
  expect(lowerName("Sales Orders")).toBe("sales orders");
  expect(lowerName("PO Lines")).toBe("PO lines");
  expect(lowerName("eBay Listings")).toBe("eBay listings");
  expect(
    listsWords({ filters: [], groupBy: null }, "RMA Cases", () => undefined),
  ).toBe("All RMA cases");
});
