import { expect, test } from "@playwright/test";
import { ZodError } from "zod";

import { ApiContractError } from "../../../src/lib/api";
import {
  listManageJobs,
  retryManageJob,
} from "../../../src/components/systems/manage/adapters/jobs-api";
import { installFetch } from "../platform/fixtures";

// Jobs trusts a page only when it describes the request it answers, and a
// retry only when its receipt names the job it retried (a scheduled job) or a
// new backup run (a backup). Anything else is refused whole, so the screen
// reports an unconfirmed outcome instead of success. The http journeys keep
// one example of each class with its exact wire body: "unsafe subject link
// rejects the Jobs response without creating navigation", "scheduled wrong-id
// response never reports retry success or automatically resends" and "backup
// wrong-location receipt stays unresolved and blocks new retry keys".

const jobId = "00000000-0000-4000-8000-000000000001";
const newRunId = "00000000-0000-4000-8000-000000000100";

function jobWire(overrides: Record<string, unknown> = {}) {
  return {
    kind: "report-run",
    id: jobId,
    subject_label: "Weekly Report",
    subject_link: "/openview?section=reports",
    state: "failed",
    scheduled_for: "2026-10-03T00:00:00Z",
    last_attempt_at: "2026-10-03T00:05:00Z",
    next_attempt_at: null,
    attempts: 5,
    failure_code: "attempts_exhausted",
    failure_label: "All attempts have failed",
    can_retry: true,
    ...overrides,
  };
}

function pageWire(
  items: unknown[],
  pagination: Partial<{
    limit: number;
    offset: number;
    count: number;
    total: number;
    has_more: boolean;
  }> = {},
) {
  return {
    items,
    pagination: {
      limit: 10,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
      ...pagination,
    },
  };
}

test("Jobs list asks for server priority order with the default page", async () => {
  const mock = installFetch(() => Response.json(pageWire([jobWire()])));
  try {
    const page = await listManageJobs();
    expect(page.items.map((job) => job.subjectLabel)).toEqual([
      "Weekly Report",
    ]);
    expect(String(mock.requests[0]?.input)).toBe(
      "/api/jobs?sort_by=priority&sort_order=asc&limit=10&offset=0",
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("Jobs list sends the kind, state and page it was given", async () => {
  const mock = installFetch(() =>
    Response.json(pageWire([], { limit: 25, offset: 10, total: 10 })),
  );
  try {
    await listManageJobs({
      kind: "backup",
      state: "failed",
      limit: 25,
      offset: 10,
    });
    expect(String(mock.requests[0]?.input)).toBe(
      "/api/jobs?sort_by=priority&sort_order=asc&kind=backup&state=failed&limit=25&offset=10",
    );
  } finally {
    mock.restore();
  }
});

test("Jobs list keeps a job id in lower case", async () => {
  const mock = installFetch(() =>
    Response.json(
      pageWire([jobWire({ id: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF" })]),
    ),
  );
  try {
    const page = await listManageJobs();
    expect(page.items[0]?.id).toBe("abcdefab-cdef-4abc-8def-abcdefabcdef");
  } finally {
    mock.restore();
  }
});

const safeLinks: { name: string; link: string | null }[] = [
  { name: "no link", link: null },
  { name: "an application path", link: "/openview?section=reports" },
];

for (const row of safeLinks)
  test(`Jobs list accepts ${row.name}`, async () => {
    const mock = installFetch(() =>
      Response.json(pageWire([jobWire({ subject_link: row.link })])),
    );
    try {
      const page = await listManageJobs();
      expect(page.items[0]?.subjectLink).toBe(row.link);
    } finally {
      mock.restore();
    }
  });

// The first row is the body of the http journey.
const refusedPages: { name: string; body: unknown }[] = [
  {
    name: "a protocol-relative subject link",
    body: pageWire([jobWire({ subject_link: "//outside.example/private" })]),
  },
  {
    name: "an absolute subject link",
    body: pageWire([
      jobWire({ subject_link: "https://outside.example/private" }),
    ]),
  },
  {
    name: "a relative subject link",
    body: pageWire([jobWire({ subject_link: "openview?section=reports" })]),
  },
  {
    name: "a subject link with a backslash",
    body: pageWire([jobWire({ subject_link: "/\\outside.example/private" })]),
  },
  {
    name: "a subject link with a space",
    body: pageWire([jobWire({ subject_link: "/openview ?section=reports" })]),
  },
  {
    name: "an unknown job field",
    body: pageWire([{ ...jobWire(), private_note: "Private job detail" }]),
  },
  {
    name: "a page limit that differs from the request",
    body: pageWire([jobWire()], { limit: 25 }),
  },
  {
    name: "a page offset that differs from the request",
    body: pageWire([jobWire()], { offset: 10, total: 11 }),
  },
  {
    name: "a count that differs from the items",
    body: pageWire([jobWire(), jobWire()], { count: 1, total: 1 }),
  },
  {
    name: "a count that differs from the remaining total",
    body: pageWire([jobWire()], { total: 5, has_more: true }),
  },
  {
    name: "a wrong has_more",
    body: pageWire([jobWire()], { has_more: true }),
  },
  {
    name: "the same job twice",
    body: pageWire([jobWire(), jobWire()]),
  },
];

for (const row of refusedPages)
  test(`Jobs list refuses ${row.name}`, async () => {
    const mock = installFetch(() => Response.json(row.body));
    try {
      await expect(listManageJobs()).rejects.toBeInstanceOf(ApiContractError);
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

for (const kind of ["report-run", "post-publish", "event-reminder"])
  test(`${kind} retry accepts a 200 receipt for the same job`, async () => {
    const mock = installFetch(() =>
      Response.json(jobWire({ kind, state: "pending", can_retry: false })),
    );
    try {
      const receipt = await retryManageJob({ kind, id: jobId });
      expect(receipt).toMatchObject({ kind, id: jobId, state: "pending" });
      expect(String(mock.requests[0]?.input)).toBe(
        `/api/jobs/${kind}/${jobId}/retry`,
      );
      expect(mock.requests[0]?.init?.method).toBe("POST");
      expect(
        new Headers(mock.requests[0]?.init?.headers).has("Idempotency-Key"),
      ).toBe(false);
    } finally {
      mock.restore();
    }
  });

test("a scheduled retry sends no idempotency key even when given one", async () => {
  const mock = installFetch(() => Response.json(jobWire()));
  try {
    await retryManageJob({ kind: "report-run", id: jobId }, { key: "key-1" });
    expect(
      new Headers(mock.requests[0]?.init?.headers).has("Idempotency-Key"),
    ).toBe(false);
  } finally {
    mock.restore();
  }
});

// The first two rows are the receipts of the http journey.
const refusedScheduledReceipts: {
  name: string;
  status: number;
  body: unknown;
}[] = [
  {
    name: "another job id",
    status: 200,
    body: jobWire({ id: "00000000-0000-4000-8000-000000000999" }),
  },
  { name: "201 instead of 200", status: 201, body: jobWire() },
  {
    name: "another job kind",
    status: 200,
    body: jobWire({ kind: "post-publish" }),
  },
];

for (const row of refusedScheduledReceipts)
  test(`a scheduled retry refuses a receipt with ${row.name}`, async () => {
    const mock = installFetch(() =>
      Response.json(row.body, { status: row.status }),
    );
    try {
      await expect(
        retryManageJob({ kind: "report-run", id: jobId }),
      ).rejects.toBeInstanceOf(ApiContractError);
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

const backupJob = { kind: "backup", id: jobId };
const backupReceipt = jobWire({
  kind: "backup",
  id: newRunId,
  state: "queued",
  can_retry: false,
});

test("a backup retry sends its key and accepts a 201 receipt for a new run", async () => {
  const mock = installFetch(() =>
    Response.json(backupReceipt, {
      status: 201,
      headers: { Location: `/api/backups?run_id=${newRunId}` },
    }),
  );
  try {
    const receipt = await retryManageJob(backupJob, { key: "retry-key.1:a_b" });
    expect(receipt).toMatchObject({ kind: "backup", id: newRunId });
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/jobs/backup/${jobId}/retry`,
    );
    expect(
      new Headers(mock.requests[0]?.init?.headers).get("Idempotency-Key"),
    ).toBe("retry-key.1:a_b");
  } finally {
    mock.restore();
  }
});

test("a backup retry accepts a 128-character key", async () => {
  const mock = installFetch(() =>
    Response.json(backupReceipt, {
      status: 201,
      headers: { Location: `/api/backups?run_id=${newRunId}` },
    }),
  );
  try {
    await retryManageJob(backupJob, { key: "k".repeat(128) });
    expect(
      new Headers(mock.requests[0]?.init?.headers).get("Idempotency-Key"),
    ).toBe("k".repeat(128));
  } finally {
    mock.restore();
  }
});

// The first three rows are the receipts of the http journey (its kept row is
// the wrong Location).
const refusedBackupReceipts: {
  name: string;
  status: number;
  location: string | null;
  body: unknown;
}[] = [
  {
    name: "a Location for the retried job",
    status: 201,
    location: `/api/backups?run_id=${jobId}`,
    body: backupReceipt,
  },
  {
    name: "the retried job id",
    status: 201,
    location: `/api/backups?run_id=${jobId}`,
    body: { ...backupReceipt, id: jobId },
  },
  {
    name: "200 instead of 201",
    status: 200,
    location: `/api/backups?run_id=${newRunId}`,
    body: backupReceipt,
  },
  {
    name: "no Location",
    status: 201,
    location: null,
    body: backupReceipt,
  },
  {
    name: "another job kind",
    status: 201,
    location: `/api/backups?run_id=${newRunId}`,
    body: { ...backupReceipt, kind: "report-run" },
  },
];

for (const row of refusedBackupReceipts)
  test(`a backup retry refuses a receipt with ${row.name}`, async () => {
    const mock = installFetch(() =>
      Response.json(row.body, {
        status: row.status,
        headers: row.location ? { Location: row.location } : {},
      }),
    );
    try {
      await expect(
        retryManageJob(backupJob, { key: "retry-key" }),
      ).rejects.toBeInstanceOf(ApiContractError);
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

const refusedKeys: { name: string; key: string | undefined }[] = [
  { name: "no key", key: undefined },
  { name: "an empty key", key: "" },
  { name: "a 129-character key", key: "k".repeat(129) },
  { name: "a key with a space", key: "retry key" },
];

for (const row of refusedKeys)
  test(`a backup retry with ${row.name} sends nothing`, async () => {
    const mock = installFetch(() => Response.json(backupReceipt));
    try {
      await expect(
        retryManageJob(backupJob, { key: row.key }),
      ).rejects.toBeInstanceOf(ZodError);
      expect(mock.requests).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });
