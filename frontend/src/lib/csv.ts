import Papa from "papaparse";

export type CsvValue = string | number | boolean | null | undefined;

/** Keep exported text inert when opened by spreadsheet applications. */
export function serializeCsv(rows: readonly (readonly CsvValue[])[]): string {
  return Papa.unparse(
    rows.map((row) => row.map((value) => String(value ?? ""))),
    {
      quotes: true,
      newline: "\r\n",
      escapeFormulae: /^\s*[=+\-@]/,
    },
  );
}
