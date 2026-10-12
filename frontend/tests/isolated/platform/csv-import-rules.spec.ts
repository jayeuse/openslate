import { expect, test } from "@playwright/test";

import {
  checkCsvFile,
  importMappingError,
  parseCsvText,
} from "../../../src/components/systems/platform/helpers/csv-import-rules";
import { ids } from "./fixtures";

// A CSV import is checked in the browser before any request: a .csv name up
// to 8 MB, text that parses, a header row, 1 to 10,000 data rows of the
// header's width (numbered from 2, after the header), and a mapping with at
// least one column and each field once. The http journey "CSV input rejects
// invalid UTF-8 and a wrong width while accepting one-column CSV" keeps the
// UTF-8 refusal, one width refusal and the accepted one-column file.

const MB = 1024 * 1024;

for (const row of [
  { name: "data.csv", size: 10, error: null },
  { name: "DATA.CSV", size: 10, error: null },
  { name: "data.csv", size: 8 * MB, error: null },
  {
    name: "data.csv",
    size: 8 * MB + 1,
    error: "CSV files support up to 8 MB.",
  },
  { name: "data.txt", size: 10, error: "Choose a UTF-8 CSV file." },
  { name: "data.csv.txt", size: 10, error: "Choose a UTF-8 CSV file." },
])
  test(`CSV file ${row.name} of ${row.size} bytes is ${row.error ? "refused" : "accepted"}`, () => {
    if (row.error) expect(() => checkCsvFile(row)).toThrow(row.error);
    else expect(() => checkCsvFile(row)).not.toThrow();
  });

const accepted: {
  name: string;
  text: string;
  headers: string[];
  rows: { row_number: number; cells: string[] }[];
}[] = [
  {
    name: "rows are numbered from 2 and the final newline adds no row",
    text: "Title,Quantity\nPump,1\nValve,2\n",
    headers: ["Title", "Quantity"],
    rows: [
      { row_number: 2, cells: ["Pump", "1"] },
      { row_number: 3, cells: ["Valve", "2"] },
    ],
  },
  {
    name: "a file without a final newline",
    text: "Title,Quantity\nPump,1",
    headers: ["Title", "Quantity"],
    rows: [{ row_number: 2, cells: ["Pump", "1"] }],
  },
  {
    name: "a one-column file with Windows line ends",
    text: "Title\r\nPump\r\n",
    headers: ["Title"],
    rows: [{ row_number: 2, cells: ["Pump"] }],
  },
  {
    name: "a final quoted empty cell without a newline is a data row",
    text: 'Title\nPump\n""',
    headers: ["Title"],
    rows: [
      { row_number: 2, cells: ["Pump"] },
      { row_number: 3, cells: [""] },
    ],
  },
  {
    name: "quoted cells keep their commas and line breaks",
    text: 'Title,Notes\n"Pump, main","Line 1\nLine 2"\n',
    headers: ["Title", "Notes"],
    rows: [{ row_number: 2, cells: ["Pump, main", "Line 1\nLine 2"] }],
  },
];

for (const row of accepted)
  test(`CSV text accepted: ${row.name}`, () => {
    expect(parseCsvText(row.text)).toEqual({
      headers: row.headers,
      rows: row.rows,
    });
  });

test("CSV text accepted: exactly 10,000 data rows", () => {
  const parsed = parseCsvText(`Title,Quantity\n${"Pump,1\n".repeat(10000)}`);
  expect(parsed.rows).toHaveLength(10000);
  expect(parsed.rows.at(-1)).toEqual({
    row_number: 10001,
    cells: ["Pump", "1"],
  });
});

for (const row of [
  {
    name: "an unclosed quote",
    text: 'Title,Quantity\n"Pump,1\n',
    error: "The CSV could not be read. Check quotes and delimiters.",
  },
  { name: "an empty file", text: "", error: "The CSV needs a header row." },
  {
    name: "a blank header row",
    text: " , \nPump,1\n",
    error: "The CSV needs a header row.",
  },
  {
    name: "a header without data rows",
    text: "Title,Quantity\n",
    error: "The CSV needs at least one data row.",
  },
  {
    name: "10,001 data rows",
    text: `Title,Quantity\n${"Pump,1\n".repeat(10001)}`,
    error: "CSV imports support up to 10,000 data rows.",
  },
  {
    name: "a first row with an extra cell",
    text: "Title,Quantity\nPump,1,extra",
    error: "Row 2 must have 2 cells, matching the headers.",
  },
  {
    name: "a later row with a missing cell",
    text: "Title,Quantity\nPump,1\nValve\n",
    error: "Row 3 must have 2 cells, matching the headers.",
  },
])
  test(`CSV text refused: ${row.name}`, () => {
    expect(() => parseCsvText(row.text)).toThrow(row.error);
  });

for (const row of [
  {
    name: "no mapped column",
    mapping: [],
    error: "Map at least one CSV column to a field.",
  },
  {
    name: "one field mapped twice",
    mapping: [
      { column_index: 0, field_id: ids.field },
      { column_index: 1, field_id: ids.field },
    ],
    error: "Each field can be mapped only once.",
  },
  {
    name: "two fields",
    mapping: [
      { column_index: 0, field_id: ids.field },
      { column_index: 1, field_id: ids.record },
    ],
    error: null,
  },
  {
    name: "one column mapped to two fields",
    mapping: [
      { column_index: 0, field_id: ids.field },
      { column_index: 0, field_id: ids.record },
    ],
    error: null,
  },
])
  test(`import mapping with ${row.name}`, () => {
    expect(importMappingError(row.mapping)).toBe(row.error);
  });
