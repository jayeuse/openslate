import Papa from "papaparse";
import type { CsvRow, ImportEnvelope } from "../adapters/record-import-api";

// The CSV import rules that run in the browser before any request. Each
// refusal throws an Error whose message the import form shows.

/** Refuses a file that is not named .csv or is larger than 8 MB. */
export function checkCsvFile(file: { name: string; size: number }): void {
  if (!/\.csv$/i.test(file.name)) throw new Error("Choose a UTF-8 CSV file.");
  if (file.size > 8 * 1024 * 1024)
    throw new Error("CSV files support up to 8 MB.");
}

/** Reads decoded CSV text into its header and numbered data rows. */
export function parseCsvText(text: string): {
  headers: string[];
  rows: CsvRow[];
} {
  const parsed = Papa.parse<string[]>(text, {
    dynamicTyping: false,
    skipEmptyLines: false,
  });
  if (parsed.errors.some((error) => error.code !== "UndetectableDelimiter"))
    throw new Error("The CSV could not be read. Check quotes and delimiters.");
  const cells = parsed.data;
  if (
    /\r?\n$/.test(text) &&
    cells.at(-1)?.length === 1 &&
    cells.at(-1)?.[0] === ""
  )
    cells.pop();
  const headers = cells.shift();
  if (!headers?.length || headers.every((header) => !header.trim()))
    throw new Error("The CSV needs a header row.");
  if (!cells.length) throw new Error("The CSV needs at least one data row.");
  if (cells.length > 10000)
    throw new Error("CSV imports support up to 10,000 data rows.");
  const mismatch = cells.findIndex((row) => row.length !== headers.length);
  if (mismatch !== -1)
    throw new Error(
      `Row ${mismatch + 2} must have ${headers.length} cells, matching the headers.`,
    );
  return {
    headers,
    rows: cells.map((cells, index) => ({ row_number: index + 2, cells })),
  };
}

/** The refusal of a column mapping, or null when it can be previewed. */
export function importMappingError(
  mapping: ImportEnvelope["mapping"],
): string | null {
  if (!mapping.length) return "Map at least one CSV column to a field.";
  const fields = mapping.map((item) => item.field_id);
  if (new Set(fields).size !== fields.length)
    return "Each field can be mapped only once.";
  return null;
}
