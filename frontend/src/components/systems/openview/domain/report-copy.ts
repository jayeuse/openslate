import Papa from "papaparse";

// A report copy is stored as CSV (the run API returns no rows), so the
// Reports view shows the copy by reading its CSV (DC5). The server writes the
// headings first, then each record, and with grouping or the row count a line
// whose first cell is "Group: …", "Group total: …" or "Grand total: …" and
// whose other cells are empty.

export type CopyRow = { kind: "row" | "summary"; cells: string[] };
export type ReportCopyTable = {
  headings: string[];
  rows: CopyRow[];
  /** Rows on the page; the CSV keeps every row. */
  shown: number;
  total: number;
};

const SUMMARY = /^(Group|Group total|Grand total): /;

export function copyFromCsv(csv: string, limit: number): ReportCopyTable {
  const parsed = Papa.parse<string[]>(csv.replace(/^﻿/, ""), {
    skipEmptyLines: true,
  });
  const [headings = [], ...lines] = parsed.data;
  const rows = lines.slice(0, limit).map((cells): CopyRow => {
    const summary =
      SUMMARY.test(cells[0] ?? "") && cells.slice(1).every((cell) => !cell);
    return { kind: summary ? "summary" : "row", cells };
  });
  return { headings, rows, shown: rows.length, total: lines.length };
}
