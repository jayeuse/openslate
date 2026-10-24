import { expect, test } from "@playwright/test";

import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  AuditExportLimitError,
  downloadManageAuditCsv,
  getManageAuditExportPreview,
  manageAuditListPath,
} from "../../../src/components/systems/manage/adapters/audit-api";
import { installFetch } from "../platform/fixtures";

// The audit export reads at most a 10-row preview, refuses more than 10,000
// entries, and saves the server CSV only when the response proves it is that
// file: the CSV media type, the attachment name, no-store, a plain count, and
// the fixed header (a header alone for zero entries). Anything else is refused
// whole, so nothing is downloaded. The http journeys keep the 503 and the
// 409 cap examples with their exact bodies: "Audit CSV failure retains its
// pinned preview and Retry refuses malformed or oversized responses" and
// "Audit Export is disabled with its reason above 10,000 events and exports
// the header after filters narrow to zero".

const userId = "00000000-0000-4000-8000-000000000201";
const filters = {
  search: "  pump  ",
  action: "update",
  entityType: "record",
  performedBy: userId,
  createdAfter: "2026-09-03T16:00:00.000Z",
  createdBefore: "2026-09-10T15:59:59.999Z",
  sortOrder: "desc",
} as const;
const header = '"Date","User","Entity","Action","Target","Before","After"';
const row =
  '"2026-09-12T12:30:00Z","Mara Santos","Record","Update","Pump","No previous values recorded.","Status: active"';
const csvHeaders = {
  "Content-Type": "text/csv;charset=utf-8",
  "Content-Disposition": 'attachment; filename="openslate-audit.csv"',
  "Cache-Control": "no-store",
};

test("the list path carries each filter, the trimmed search and the page", () => {
  expect(manageAuditListPath({ ...filters, limit: 25, offset: 50 })).toBe(
    "/audit-logs?action=update&entity_type=record&performed_by=" +
      userId +
      "&created_after=2026-09-03T16%3A00%3A00.000Z&created_before=2026-09-10T15%3A59%3A59.999Z&search=pump&sort_by=created_at&sort_order=desc&limit=25&offset=50",
  );
});

test("the list path leaves out empty filters and a blank search", () => {
  expect(
    manageAuditListPath({
      search: "   ",
      sortOrder: "asc",
      limit: 10,
      offset: 0,
    }),
  ).toBe("/audit-logs?sort_by=created_at&sort_order=asc&limit=10&offset=0");
});

function auditPage(total: number) {
  return {
    items: [],
    pagination: { limit: 10, offset: 0, count: 0, total, has_more: total > 0 },
  };
}

test("the export preview reads the first 10 entries of the filters", async () => {
  const mock = installFetch(() => Response.json(auditPage(10_000)));
  try {
    const page = await getManageAuditExportPreview(filters);
    expect(page.pagination.total).toBe(10_000);
    expect(String(mock.requests[0]?.input)).toBe(
      "/api/audit-logs?action=update&entity_type=record&performed_by=" +
        userId +
        "&created_after=2026-09-03T16%3A00%3A00.000Z&created_before=2026-09-10T15%3A59%3A59.999Z&search=pump&sort_by=created_at&sort_order=desc&limit=10&offset=0",
    );
  } finally {
    mock.restore();
  }
});

test("the export preview refuses more than 10,000 entries", async () => {
  const mock = installFetch(() => Response.json(auditPage(10_001)));
  try {
    await expect(getManageAuditExportPreview(filters)).rejects.toThrow(
      new AuditExportLimitError(),
    );
  } finally {
    mock.restore();
  }
});

test("the CSV download sends the filters without a page", async () => {
  const body = `${header}\r\n${row}`;
  const mock = installFetch(
    () =>
      new Response(body, {
        headers: { ...csvHeaders, "X-Audit-Export-Count": "1" },
      }),
  );
  try {
    const csv = await downloadManageAuditCsv(filters);
    expect(csv.filename).toBe("openslate-audit.csv");
    expect(csv.count).toBe(1);
    expect(await csv.blob.text()).toBe(body);
    expect(String(mock.requests[0]?.input)).toBe(
      "/api/audit-logs/export?action=update&entity_type=record&performed_by=" +
        userId +
        "&created_after=2026-09-03T16%3A00%3A00.000Z&created_before=2026-09-10T15%3A59%3A59.999Z&search=pump&sort_by=created_at&sort_order=desc",
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

const acceptedFiles: {
  name: string;
  body: string;
  headers: Record<string, string>;
  count: number;
}[] = [
  {
    name: "a header-only file for zero entries",
    body: header,
    headers: { ...csvHeaders, "X-Audit-Export-Count": "0" },
    count: 0,
  },
  {
    name: "a media type with spaces and capitals",
    body: `${header}\r\n${row}`,
    headers: {
      ...csvHeaders,
      "Content-Type": "text/csv; charset=UTF-8",
      "X-Audit-Export-Count": "1",
    },
    count: 1,
  },
  {
    name: "the 10,000-entry count",
    body: `${header}\r\n${row}`,
    headers: { ...csvHeaders, "X-Audit-Export-Count": "10000" },
    count: 10_000,
  },
];

for (const file of acceptedFiles)
  test(`the CSV download accepts ${file.name}`, async () => {
    const mock = installFetch(
      () => new Response(file.body, { headers: file.headers }),
    );
    try {
      const csv = await downloadManageAuditCsv(filters);
      expect(csv.count).toBe(file.count);
      expect(await csv.blob.text()).toBe(file.body);
    } finally {
      mock.restore();
    }
  });

// The http journey sent the first two rows (a 10001 count and a text/html
// media type, each with the header as its body).
const refusedFiles: {
  name: string;
  body: string;
  headers: Record<string, string>;
}[] = [
  {
    name: "a count over 10,000",
    body: `${header}\r\n`,
    headers: { ...csvHeaders, "X-Audit-Export-Count": "10001" },
  },
  {
    name: "another media type with a count over 10,000",
    body: `${header}\r\n`,
    headers: {
      ...csvHeaders,
      "Content-Type": "text/html",
      "X-Audit-Export-Count": "10001",
    },
  },
  {
    name: "another media type",
    body: `${header}\r\n${row}`,
    headers: {
      ...csvHeaders,
      "Content-Type": "text/html",
      "X-Audit-Export-Count": "1",
    },
  },
  {
    name: "no count",
    body: `${header}\r\n${row}`,
    headers: csvHeaders,
  },
  {
    name: "a count that is not a number",
    body: `${header}\r\n${row}`,
    headers: { ...csvHeaders, "X-Audit-Export-Count": "one" },
  },
  {
    name: "a count with a leading zero",
    body: `${header}\r\n${row}`,
    headers: { ...csvHeaders, "X-Audit-Export-Count": "01" },
  },
  {
    name: "another file name",
    body: `${header}\r\n${row}`,
    headers: {
      ...csvHeaders,
      "Content-Disposition": 'attachment; filename="audit.csv"',
      "X-Audit-Export-Count": "1",
    },
  },
  {
    name: "a cacheable response",
    body: `${header}\r\n${row}`,
    headers: {
      ...csvHeaders,
      "Cache-Control": "private",
      "X-Audit-Export-Count": "1",
    },
  },
  {
    name: "another header row",
    body: `"Date","User"\r\n${row}`,
    headers: { ...csvHeaders, "X-Audit-Export-Count": "1" },
  },
  {
    name: "rows after a zero count",
    body: `${header}\r\n${row}`,
    headers: { ...csvHeaders, "X-Audit-Export-Count": "0" },
  },
];

for (const file of refusedFiles)
  test(`the CSV download refuses ${file.name}`, async () => {
    const mock = installFetch(
      () => new Response(file.body, { headers: file.headers }),
    );
    try {
      await expect(downloadManageAuditCsv(filters)).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      mock.restore();
    }
  });

test("the CSV download reports the 10,000-entry limit from a 409", async () => {
  const mock = installFetch(() =>
    Response.json(
      {
        detail: {
          code: "audit_export_limit",
          message:
            "Audit exports support up to 10,000 entries. Narrow your filters and try again.",
        },
      },
      { status: 409 },
    ),
  );
  try {
    await expect(downloadManageAuditCsv(filters)).rejects.toThrow(
      new AuditExportLimitError(),
    );
  } finally {
    mock.restore();
  }
});

const failedDownloads: {
  name: string;
  status: number;
  body: unknown;
  code: string | undefined;
}[] = [
  {
    name: "a 503 with a private diagnostic",
    status: 503,
    body: { detail: "Private upstream diagnostic" },
    code: undefined,
  },
  {
    name: "a 409 with another code",
    status: 409,
    body: { detail: { code: "audit_export_busy", message: "Busy" } },
    code: "audit_export_busy",
  },
];

for (const failure of failedDownloads)
  test(`the CSV download keeps ${failure.name} a plain request error`, async () => {
    const mock = installFetch(() =>
      Response.json(failure.body, { status: failure.status }),
    );
    try {
      const error: unknown = await downloadManageAuditCsv(filters).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect(error).not.toBeInstanceOf(AuditExportLimitError);
      expect(error).toMatchObject({
        status: failure.status,
        code: failure.code,
        message: "Request could not be completed",
      });
    } finally {
      mock.restore();
    }
  });
