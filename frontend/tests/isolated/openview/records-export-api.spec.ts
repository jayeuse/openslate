import { expect, test } from "@playwright/test";
import { ApiContractError } from "../../../src/lib/api";
import {
  exportOpenViewRecords,
  type RecordsExportOptions,
} from "../../../src/components/systems/openview/adapters/records-export-api";

const moduleId = "00000000-0000-4000-8000-000000000401";
const viewId = "00000000-0000-4000-8000-000000000402";
const csv = "Equipment name\r\nCompressor\r\n";
const attachmentHeaders = {
  "Content-Disposition":
    'attachment; filename="Equipment-register-2026-09-20.csv"',
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

type Reply = {
  status?: number;
  body?: string | Uint8Array<ArrayBuffer>;
  contentType?: string;
  headers?: Record<string, string>;
};

const options: RecordsExportOptions = {
  moduleId,
  viewId,
  definition: {
    version: 1,
    logic: "and",
    columns: [],
    filters: [],
    sort: [],
    deleted: "exclude",
    search: null,
    searchFields: [],
  },
  includeRecordId: true,
  format: "csv",
};

function exportWith(reply: Reply) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(reply.body ?? csv, {
        status: reply.status ?? 200,
        headers: {
          "Content-Type": reply.contentType ?? "text/csv; charset=utf-8",
          ...(reply.headers ?? attachmentHeaders),
        },
      }),
    )) as typeof fetch;
  return exportOpenViewRecords(options, new AbortController().signal).finally(
    () => {
      globalThis.fetch = original;
    },
  );
}

test("a complete CSV export reply is returned as an attachment", async () => {
  const file = await exportWith({});
  expect(file.filename).toBe("Equipment-register-2026-09-20.csv");
  expect(await file.blob.text()).toBe(csv);
});

// The http journey keeps "wrong MIME" for the dialog's Retry; every reply
// below is refused by the adapter before any file reaches the browser.
for (const invalid of [
  { name: "wrong status", reply: { status: 201 } },
  { name: "wrong MIME", reply: { contentType: "text/html" } },
  {
    name: "missing attachment",
    reply: {
      headers: { ...attachmentHeaders, "Content-Disposition": "inline" },
    },
  },
  {
    name: "unsafe filename",
    reply: {
      headers: {
        ...attachmentHeaders,
        "Content-Disposition": 'attachment; filename="../private.csv"',
      },
    },
  },
  {
    name: "wrong extension",
    reply: {
      headers: {
        ...attachmentHeaders,
        "Content-Disposition": 'attachment; filename="records.xlsx"',
      },
    },
  },
  {
    name: "cacheable response",
    reply: { headers: { ...attachmentHeaders, "Cache-Control": "public" } },
  },
  {
    name: "sniffable response",
    reply: {
      headers: { ...attachmentHeaders, "X-Content-Type-Options": "sniff" },
    },
  },
  {
    name: "oversized bytes",
    reply: { body: new Uint8Array(8 * 1024 * 1024 + 1).fill(65) },
  },
] satisfies { name: string; reply: Reply }[]) {
  test(`an export reply with ${invalid.name} is refused as a contract error`, async () => {
    await expect(exportWith(invalid.reply)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  });
}
