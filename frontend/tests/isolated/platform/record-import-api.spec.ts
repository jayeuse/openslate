import { expect, test } from "@playwright/test";

import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  importBatches,
  prepareRecordCsv,
  sendImportBatch,
  type CsvRow,
  type ImportEnvelope,
  type ImportRequest,
} from "../../../src/components/systems/platform/adapters/record-import-api";
import type { OpenViewQueryDefinition } from "../../../src/components/systems/openview/adapters/views-schemas";
import { ids, installFetch } from "./fixtures";
import { emptyQuery } from "../../helpers/query-definitions";

// Import sends sequential batches of at most 100 rows and 900 KiB, and trusts
// a batch result only when it confirms exactly the rows it was sent; any other
// result is "unconfirmed" and the import stops without a retry. Export trusts
// only a complete UTF-8 CSV whose first column is the record ID. The http
// journeys keep the user-visible outcome of each class: "CSV preview and import
// use sequential complete batches, typed defaults and row errors", "Import
// ${failure} stops without retry", "Schema drift and oversized UTF-8 rows
// retain the draft without writes" and "Export failures and cancelled late
// replies never produce a download".

const envelope: ImportEnvelope = {
  mode: "preview",
  module_id: ids.module,
  headers: ["Title", "Quantity"],
  mapping: [{ column_index: 0, field_id: ids.field }],
  defaults: {},
  schema_digest: null,
};

function csvRows(count: number, cells = ["Job", "1"]): CsvRow[] {
  return Array.from({ length: count }, (_, index) => ({
    row_number: index + 2,
    cells,
  }));
}

const batchRows: {
  name: string;
  rows: CsvRow[];
  envelope?: ImportEnvelope;
  sizes: number[];
  firstRows: number[];
}[] = [
  {
    name: "205 rows",
    rows: csvRows(205),
    sizes: [100, 100, 5],
    firstRows: [2, 102, 202],
  },
  {
    name: "exactly 100 rows",
    rows: csvRows(100),
    sizes: [100],
    firstRows: [2],
  },
  {
    name: "101 rows",
    rows: csvRows(101),
    sizes: [100, 1],
    firstRows: [2, 102],
  },
  {
    name: "two rows that together exceed 900 KiB",
    rows: [
      { row_number: 2, cells: ["é".repeat(250000), "1"] },
      { row_number: 3, cells: ["é".repeat(250000), "2"] },
    ],
    sizes: [1, 1],
    firstRows: [2, 3],
  },
  { name: "no rows", rows: [], sizes: [], firstRows: [] },
];

for (const row of batchRows)
  test(`import batches split ${row.name}`, () => {
    const batches = importBatches(row.envelope ?? envelope, row.rows);
    expect(batches.map((batch) => batch.rows.length)).toEqual(row.sizes);
    expect(batches.map((batch) => batch.rows[0]?.row_number)).toEqual(
      row.firstRows,
    );
    for (const batch of batches) {
      expect(batch.module_id).toBe(ids.module);
      expect(
        new TextEncoder().encode(JSON.stringify(batch)).byteLength,
      ).toBeLessThanOrEqual(900 * 1024);
    }
  });

test("import batches refuse one row over 900 KiB", () => {
  expect(() =>
    importBatches(envelope, [
      { row_number: 2, cells: ["é".repeat(470000), "1"] },
    ]),
  ).toThrow(
    "Row 2 exceeds the 900 KiB request limit. Reduce this row before previewing.",
  );
});

test("import batches refuse headers, mapping and defaults over 900 KiB", () => {
  expect(() =>
    importBatches(
      { ...envelope, defaults: { [ids.field]: "é".repeat(470000) } },
      csvRows(1),
    ),
  ).toThrow(
    "The import headers, mapping and defaults exceed 900 KiB. Reduce the CSV columns or defaults.",
  );
});

const digest = "a".repeat(64);
const recordId = "50000000-0000-4000-8000-000000000002";
const otherRecordId = "50000000-0000-4000-8000-000000000003";
const rowError = {
  code: "invalid_field_value",
  message: "Integer must be a whole base-10 number",
  field_id: null,
  column_index: 1,
};
const preview: ImportRequest = {
  ...envelope,
  rows: [
    { row_number: 2, cells: ["Pump", "1"] },
    { row_number: 3, cells: ["Valve", "bad"] },
  ],
};
const previewResult = {
  mode: "preview",
  schema_digest: digest,
  rows: [
    {
      row_number: 2,
      status: "valid",
      record_id: null,
      data: { [ids.field]: "Pump" },
      errors: [],
    },
    {
      row_number: 3,
      status: "invalid",
      record_id: null,
      data: {},
      errors: [rowError],
    },
  ],
  valid_count: 1,
  invalid_count: 1,
  created_count: 0,
};
const importing: ImportRequest = {
  ...preview,
  mode: "import",
  schema_digest: digest,
};
const importResult = {
  ...previewResult,
  mode: "import",
  rows: [
    { ...previewResult.rows[0], status: "created", record_id: recordId },
    previewResult.rows[1],
  ],
  created_count: 1,
};
const validRow = previewResult.rows[0];
const invalidRow = previewResult.rows[1];
const createdRow = importResult.rows[0];

const refusedResults: {
  name: string;
  request: ImportRequest;
  body: unknown;
}[] = [
  {
    name: "a result for another mode",
    request: preview,
    body: { ...previewResult, mode: "import" },
  },
  {
    name: "a result with fewer rows than were sent",
    request: preview,
    body: { ...previewResult, rows: [validRow], invalid_count: 0 },
  },
  {
    name: "a row number that was not sent",
    request: preview,
    body: {
      ...previewResult,
      rows: [validRow, { ...invalidRow, row_number: 4 }],
    },
  },
  {
    name: "an invalid row with a record ID",
    request: preview,
    body: {
      ...previewResult,
      rows: [validRow, { ...invalidRow, record_id: recordId }],
    },
  },
  {
    name: "an invalid row without errors",
    request: preview,
    body: { ...previewResult, rows: [validRow, { ...invalidRow, errors: [] }] },
  },
  {
    name: "a valid row with errors",
    request: preview,
    body: {
      ...previewResult,
      rows: [{ ...validRow, errors: [rowError] }, invalidRow],
    },
  },
  {
    name: "a created row in a preview",
    request: preview,
    body: {
      ...previewResult,
      rows: [{ ...validRow, status: "created" }, invalidRow],
    },
  },
  {
    name: "a preview row with a record ID",
    request: preview,
    body: {
      ...previewResult,
      rows: [{ ...validRow, record_id: recordId }, invalidRow],
    },
  },
  {
    name: "a valid count that differs from the rows",
    request: preview,
    body: { ...previewResult, valid_count: 2 },
  },
  {
    name: "an invalid count that differs from the rows",
    request: preview,
    body: { ...previewResult, invalid_count: 0 },
  },
  {
    name: "an imported row still marked valid",
    request: importing,
    body: {
      ...importResult,
      rows: [{ ...createdRow, status: "valid" }, invalidRow],
    },
  },
  {
    name: "an imported row without a record ID",
    request: importing,
    body: {
      ...importResult,
      rows: [{ ...createdRow, record_id: null }, invalidRow],
    },
  },
  {
    // The one-row import the "Import ${failure} stops without retry"
    // journey sends, answered with a receipt that confirms no record.
    name: "a created count that does not match the imported rows",
    request: {
      ...importing,
      rows: [{ row_number: 2, cells: ["Pump", "1"] }],
    },
    body: {
      ...importResult,
      rows: [createdRow],
      valid_count: 1,
      invalid_count: 0,
      created_count: 0,
    },
  },
  {
    name: "the same record ID twice",
    request: {
      ...importing,
      rows: [
        { row_number: 2, cells: ["Pump", "1"] },
        { row_number: 3, cells: ["Valve", "2"] },
      ],
    },
    body: {
      ...importResult,
      rows: [createdRow, { ...createdRow, row_number: 3 }],
      valid_count: 2,
      invalid_count: 0,
      created_count: 2,
    },
  },
  {
    name: "a schema digest other than the previewed one",
    request: importing,
    body: { ...importResult, schema_digest: "b".repeat(64) },
  },
];

for (const row of refusedResults)
  test(`import batch result refuses ${row.name}`, async () => {
    const mock = installFetch(() => Response.json(row.body));
    try {
      await expect(sendImportBatch(row.request)).rejects.toBeInstanceOf(
        ApiContractError,
      );
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

test("import batch result accepts a preview with one invalid row", async () => {
  const mock = installFetch(() => Response.json(previewResult));
  try {
    await expect(sendImportBatch(preview)).resolves.toEqual(previewResult);
    expect(String(mock.requests[0]?.input)).toBe("/api/records/import");
    expect(mock.requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual(preview);
  } finally {
    mock.restore();
  }
});

test("import batch result accepts an import that confirms each created record", async () => {
  const mock = installFetch(() =>
    Response.json({
      ...importResult,
      rows: [
        createdRow,
        { ...createdRow, row_number: 3, record_id: otherRecordId },
      ],
      valid_count: 2,
      invalid_count: 0,
      created_count: 2,
    }),
  );
  try {
    const result = await sendImportBatch({
      ...importing,
      rows: [
        { row_number: 2, cells: ["Pump", "1"] },
        { row_number: 3, cells: ["Valve", "2"] },
      ],
    });
    expect(result.rows.map((row) => row.record_id)).toEqual([
      recordId,
      otherRecordId,
    ]);
    expect(result.created_count).toBe(2);
  } finally {
    mock.restore();
  }
});

const definition: OpenViewQueryDefinition = emptyQuery({
  columns: [{ fieldId: ids.field, expectedType: "text" }],
  search: "",
});
const csvType = { "Content-Type": "text/csv; charset=utf-8" };
const exportRecord = "50000000-0000-4000-8000-000000000001";

function exportCsv(body: BodyInit, headers: HeadersInit = csvType) {
  return installFetch(() => new Response(body, { headers }));
}

test("record export previews the first ten rows and counts the complete file", async () => {
  const lines = Array.from(
    { length: 13 },
    (_, index) =>
      `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")},Job ${index + 1}\r\n`,
  );
  const text = `Record ID,Title\r\n${lines.join("")}`;
  const mock = exportCsv(text);
  try {
    const csv = await prepareRecordCsv(
      ids.module,
      definition,
      new AbortController().signal,
    );
    expect(csv.headers).toEqual(["Record ID", "Title"]);
    expect(csv.count).toBe(13);
    expect(csv.rows).toHaveLength(10);
    expect(csv.rows[0]).toEqual([exportRecord, "Job 1"]);
    expect(csv.rows[9]).toEqual([
      "50000000-0000-4000-8000-000000000010",
      "Job 10",
    ]);
    expect(await csv.blob.text()).toBe(text);
  } finally {
    mock.restore();
  }
});

const refusedCsv: { name: string; body: BodyInit; headers?: HeadersInit }[] = [
  {
    name: "a response that is not CSV",
    body: `Record ID,Title\r\n${exportRecord},Pump\r\n`,
    headers: { "Content-Type": "application/json" },
  },
  {
    name: "a file over 8 MB",
    body: `Record ID,Title\r\n${exportRecord},${"A".repeat(8 * 1024 * 1024)}\r\n`,
  },
  {
    name: "bytes that are not UTF-8",
    body: new Uint8Array([
      ...new TextEncoder().encode(`Record ID,Title\r\n${exportRecord},`),
      255,
      13,
      10,
    ]),
  },
  {
    name: "a first header other than Record ID",
    body: `ID,Title\r\n${exportRecord},Pump\r\n`,
  },
  {
    name: "a first cell that is not a record ID",
    body: "Record ID,Title\r\nnot-a-record,Pump\r\n",
  },
  {
    name: "a row with another width",
    body: `Record ID,Title\r\n${exportRecord},Pump,extra\r\n`,
  },
  {
    name: "more than 10,000 rows",
    body: `Record ID,Title\r\n${`${exportRecord},Pump\r\n`.repeat(10001)}`,
  },
  {
    name: "an unclosed quote",
    body: `Record ID,Title\r\n${exportRecord},"Pump\r\n`,
  },
];

for (const row of refusedCsv)
  test(`record export refuses ${row.name}`, async () => {
    const mock = exportCsv(row.body, row.headers);
    try {
      await expect(
        prepareRecordCsv(ids.module, definition, new AbortController().signal),
      ).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  });

const exportFailures: {
  name: string;
  status: number;
  detail: unknown;
  message: string;
  code: string | undefined;
}[] = [
  {
    name: "an export limit names the narrower-view fix",
    status: 422,
    detail: {
      code: "export_limit_exceeded",
      message: "Export exceeds 10,000 rows or 8 MiB; narrow the filters",
    },
    message:
      "Export exceeds 10,000 rows or 8 MB; choose a narrower saved view.",
    code: "export_limit_exceeded",
  },
  {
    name: "any other refusal shows only a safe retry message",
    status: 403,
    detail: "Administrator permission required",
    message: "The export could not be prepared. Try again.",
    code: undefined,
  },
];

for (const row of exportFailures)
  test(`record export failure: ${row.name}`, async () => {
    const mock = installFetch(() =>
      Response.json({ detail: row.detail }, { status: row.status }),
    );
    try {
      const failure = await prepareRecordCsv(
        ids.module,
        definition,
        new AbortController().signal,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toMatchObject({
        status: row.status,
        message: row.message,
        code: row.code,
      });
    } finally {
      mock.restore();
    }
  });
