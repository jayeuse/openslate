import { expect, test } from "@playwright/test";

import { ApiContractError } from "../../../src/lib/api";
import { listLibraryFiles } from "../../../src/components/systems/platform/adapters/library-files-api";
import {
  ids,
  installFetch,
  libraryFileWire,
  pagination,
  timestamp,
} from "./fixtures";

// A Library page that breaks the department contract is refused whole, so the
// Files screen shows its invalid-response alert and never renders a foreign
// file, a foreign creator label or a page it cannot trust. The http journey
// "Library files: department list contract violations reveal no foreign data
// and retry safely" keeps the foreign-department page with its alert and Retry.

const first = libraryFileWire();
const second = libraryFileWire({
  id: ids.otherFile,
  creator_id: ids.otherUser,
});
const labels = { [ids.user]: "Mara Santos" };

type Request = Parameters<typeof listLibraryFiles>[1];
type Row = { name: string; request?: Request; body: Record<string, unknown> };

// Only the transferred rows use the original HTTP journey's 23-byte files.
const transferredFirst = libraryFileWire({
  expected_size: 23,
  actual_size: 23,
});
const transferredSecond = {
  ...transferredFirst,
  id: ids.otherFile,
  creator_id: ids.otherUser,
  created_at: "2026-10-02T08:00:00Z",
};

// The first six rows are the pages the list journey used to send, unchanged:
// the journey shows two active files (one labelled creator) at limit 25.
const refused: Row[] = [
  {
    name: "a foreign department file in place of the page",
    body: {
      items: [
        {
          ...transferredFirst,
          filename: "Foreign private file.pdf",
          department_id: ids.otherDepartment,
        },
      ],
      pagination: pagination(2),
      creator_labels: labels,
      storage_used_bytes: 69,
    },
  },
  {
    name: "a record attachment in place of the page",
    body: {
      items: [
        {
          ...transferredFirst,
          filename: "Foreign private file.pdf",
          purpose: "record_attachment",
          record_id: "62000000-0000-4000-8000-000000000001",
        },
      ],
      pagination: pagination(2),
      creator_labels: labels,
      storage_used_bytes: 69,
    },
  },
  {
    name: "a creator label for a person with no file on the page",
    body: {
      items: [transferredFirst, transferredSecond],
      pagination: pagination(2),
      creator_labels: {
        ...labels,
        "63000000-0000-4000-8000-000000000999": "Private unrelated person",
      },
      storage_used_bytes: 69,
    },
  },
  {
    name: "a count above both the rows and the total",
    body: {
      items: [transferredFirst, transferredSecond],
      pagination: { ...pagination(2), count: 3 },
      creator_labels: labels,
      storage_used_bytes: 69,
    },
  },
  {
    name: "a flipped has_more",
    body: {
      items: [transferredFirst, transferredSecond],
      pagination: { ...pagination(2), has_more: true },
      creator_labels: labels,
      storage_used_bytes: 69,
    },
  },
  {
    name: "the same file twice",
    body: {
      items: [transferredFirst, transferredFirst],
      pagination: pagination(2),
      creator_labels: labels,
      storage_used_bytes: 69,
    },
  },
  {
    name: "a file from another department",
    body: {
      items: [{ ...first, department_id: ids.otherDepartment }],
      pagination: pagination(1),
      creator_labels: labels,
      storage_used_bytes: 24,
    },
  },
  {
    name: "a file with another purpose",
    body: {
      items: [{ ...first, purpose: "record_attachment" }],
      pagination: pagination(1),
      creator_labels: labels,
      storage_used_bytes: 24,
    },
  },
  {
    name: "a file attached to a record",
    body: {
      items: [{ ...first, record_id: ids.record }],
      pagination: pagination(1),
      creator_labels: labels,
      storage_used_bytes: 24,
    },
  },
  {
    name: "a count that differs from the rows",
    body: {
      items: [first, second],
      pagination: pagination(3),
      creator_labels: labels,
      storage_used_bytes: 72,
    },
  },
  {
    name: "a total below the rows on the page",
    body: {
      items: [first],
      pagination: { ...pagination(1), total: 0 },
      creator_labels: labels,
      storage_used_bytes: 24,
    },
  },
  {
    name: "more rows than the requested limit",
    request: { limit: 1 },
    body: {
      items: [first, second],
      pagination: pagination(2, { limit: 1 }),
      creator_labels: labels,
      storage_used_bytes: 72,
    },
  },
  {
    name: "has_more on an empty page",
    body: {
      items: [],
      pagination: { ...pagination(0), total: 1, has_more: true },
      creator_labels: {},
      storage_used_bytes: 24,
    },
  },
  {
    name: "a limit that does not echo the request",
    body: {
      items: [first],
      pagination: pagination(1, { limit: 100 }),
      creator_labels: labels,
      storage_used_bytes: 24,
    },
  },
  {
    name: "an offset that does not echo the request",
    body: {
      items: [first],
      pagination: pagination(1, { offset: 25 }),
      creator_labels: labels,
      storage_used_bytes: 24,
    },
  },
  {
    name: "an archived file in the active list",
    body: {
      items: [{ ...first, is_deleted: true }],
      pagination: pagination(1),
      creator_labels: labels,
      storage_used_bytes: 24,
    },
  },
  {
    name: "an active file in the archived list",
    request: { deleted: "only" },
    body: {
      items: [first],
      pagination: pagination(1),
      creator_labels: labels,
      storage_used_bytes: 24,
    },
  },
  {
    name: "a ready file without a media type",
    body: {
      items: [{ ...first, media_type: null }],
      pagination: pagination(1),
      creator_labels: labels,
      storage_used_bytes: 24,
    },
  },
  {
    name: "a ready file whose stored size differs from its declared size",
    body: {
      items: [{ ...first, actual_size: 23 }],
      pagination: pagination(1),
      creator_labels: labels,
      storage_used_bytes: 23,
    },
  },
];

for (const row of refused)
  test(`library file page refuses ${row.name}`, async () => {
    const mock = installFetch(() => Response.json(row.body));
    try {
      await expect(
        listLibraryFiles(ids.department, row.request),
      ).rejects.toBeInstanceOf(ApiContractError);
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

test("library file page reads one department's documents without a cache", async () => {
  const mock = installFetch(() =>
    Response.json({
      items: [first, second],
      pagination: pagination(2),
      creator_labels: labels,
      storage_used_bytes: 72,
    }),
  );
  try {
    await expect(listLibraryFiles(ids.department)).resolves.toEqual({
      items: [
        {
          id: ids.file,
          creatorId: ids.user,
          filename: "Safety guide.pdf",
          mediaType: "application/pdf",
          expectedSize: 24,
          actualSize: 24,
          state: "ready",
          failureCode: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          departmentId: ids.department,
          isDeleted: false,
        },
        {
          id: ids.otherFile,
          creatorId: ids.otherUser,
          filename: "Safety guide.pdf",
          mediaType: "application/pdf",
          expectedSize: 24,
          actualSize: 24,
          state: "ready",
          failureCode: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          departmentId: ids.department,
          isDeleted: false,
        },
      ],
      pagination: { limit: 25, offset: 0, count: 2, total: 2, hasMore: false },
      creatorLabels: labels,
      storageUsedBytes: 72,
    });
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/files?purpose=library_document&department_id=${ids.department}&limit=25&offset=0&sort_by=created_at&sort_order=desc&deleted=exclude`,
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("library file page sends a trimmed server search with its sort", async () => {
  const mock = installFetch(() =>
    Response.json({
      items: [],
      pagination: pagination(0),
      creator_labels: {},
      storage_used_bytes: 0,
    }),
  );
  try {
    await listLibraryFiles(ids.department, {
      search: "  pump  ",
      sortBy: "name",
      sortOrder: "asc",
      deleted: "include",
    });
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/files?purpose=library_document&department_id=${ids.department}&limit=25&offset=0&sort_by=name&sort_order=asc&deleted=include&search=pump`,
    );
  } finally {
    mock.restore();
  }
});

test("library file page accepts an empty terminal page after concurrent removal", async () => {
  // Files were removed after page one was read: the total is now below the
  // requested offset, and the empty page is the true end of the list.
  const mock = installFetch(() =>
    Response.json({
      items: [],
      pagination: {
        limit: 25,
        offset: 25,
        count: 0,
        total: 20,
        has_more: false,
      },
      creator_labels: {},
      storage_used_bytes: 0,
    }),
  );
  try {
    const page = await listLibraryFiles(ids.department, { offset: 25 });
    expect(page.items).toEqual([]);
    expect(page.pagination).toEqual({
      limit: 25,
      offset: 25,
      count: 0,
      total: 20,
      hasMore: false,
    });
  } finally {
    mock.restore();
  }
});

test("library file page refuses a page size over 100 before a request", async () => {
  const mock = installFetch(() => Response.json({}));
  try {
    await expect(
      listLibraryFiles(ids.department, { limit: 101 }),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});
