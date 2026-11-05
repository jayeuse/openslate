import { expect, test } from "@playwright/test";

import { QueryClient } from "@tanstack/react-query";

import { getSystemStatus } from "../../../src/components/systems/manage/adapters/system-status-api";
import { listSystemHealthPeriods } from "../../../src/components/systems/manage/adapters/system-health-periods-api";
import { systemHealthStatusOptions } from "../../../src/components/systems/manage/components/system-health";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import { installFetch } from "../helpers/fake-fetch";

// The status read behind System health (docs/specs/system-health.md, API
// contract S2 and S2-C6): the response it accepts, and why the automatic
// refresh never renews an idle session.

const example = {
  parts: [
    { key: "data", status: "working" },
    { key: "signing_in", status: "working" },
    { key: "files", status: "not_working" },
    { key: "email", status: "set_up" },
  ],
  version: "0.1.0",
  checked_at: "2026-11-02T10:42:05.123456Z",
  organization: null,
  installation: null,
};

// An admin's response: the organization part of S3 (API contract S3).
const adminExample = {
  ...example,
  organization: {
    since: "2026-10-26T10:42:05.123456Z",
    backups: {
      state: "late",
      last_success_at: "2026-10-30T06:00:00Z",
      last_result: "failed",
    },
    failed_jobs: 2,
    failed_sign_ins: 3,
    lockouts: 1,
    storage_used_bytes: 1_234_567_890,
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("the status read accepts the contract's response", async () => {
  const fetchStub = installFetch(() => json(example));
  try {
    expect(await getSystemStatus("background")).toEqual(example);
    expect(String(fetchStub.requests[0].input)).toBe("/api/system/status");
  } finally {
    fetchStub.restore();
  }
});

test("S3-C5: an admin's response carries the organization part, everyone else's carries null", async () => {
  for (const body of [
    adminExample,
    {
      ...adminExample,
      organization: {
        ...adminExample.organization,
        backups: { state: "unknown", last_success_at: null, last_result: null },
        failed_jobs: null,
      },
    },
    example,
  ]) {
    const fetchStub = installFetch(() => json(body));
    try {
      expect(await getSystemStatus("background")).toEqual(body);
    } finally {
      fetchStub.restore();
    }
  }
});

test("S3-C5: an organization part outside the contract is refused", async () => {
  for (const body of [
    // The key is always present, null for non-admins.
    {
      parts: example.parts,
      version: example.version,
      checked_at: example.checked_at,
    },
    {
      ...adminExample,
      organization: { ...adminExample.organization, size_bytes: 10 },
    },
    {
      ...adminExample,
      organization: {
        ...adminExample.organization,
        backups: { ...adminExample.organization.backups, state: "stale" },
      },
    },
    {
      ...adminExample,
      organization: {
        ...adminExample.organization,
        backups: {
          ...adminExample.organization.backups,
          failure_code: "disk_full",
        },
      },
    },
  ]) {
    const fetchStub = installFetch(() => json(body));
    try {
      await expect(getSystemStatus("background")).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      fetchStub.restore();
    }
  }
});

test("a word the page does not know is kept as unknown, not rejected", async () => {
  const fetchStub = installFetch(() =>
    json({
      ...example,
      parts: [
        ...example.parts.slice(0, 3),
        { key: "email", status: "degraded" },
      ],
    }),
  );
  try {
    expect((await getSystemStatus("background")).parts[3]).toEqual({
      key: "email",
      status: "unknown",
    });
  } finally {
    fetchStub.restore();
  }
});

test("a response with fields outside the contract is refused", async () => {
  for (const body of [
    { ...example, database: "ready" },
    { ...example, checked_at: "yesterday" },
    { ...example, parts: [{ key: "smtp", status: "working" }] },
  ]) {
    const fetchStub = installFetch(() => json(body));
    try {
      await expect(getSystemStatus("background")).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      fetchStub.restore();
    }
  }
});

test("opening the page renews a refused session; the refresh after a failed first read does not", async () => {
  // S2-C6: opening the page is the person's action, so its first read
  // refreshes the session instead of waiting on the skeleton for the next
  // poll. Every later read, even after a first read that failed with no
  // result, is the 60-second or focus refresh and never extends an idle
  // session. Reads do not retry on their own, as in the app's client.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const urls = (stub: ReturnType<typeof installFetch>) =>
    stub.requests.map((request) => String(request.input));
  const opening = installFetch(() => json({ detail: "Expired" }, 401));
  try {
    await expect(
      client.fetchQuery(systemHealthStatusOptions()),
    ).rejects.toBeInstanceOf(ApiError);
    expect(urls(opening)).toEqual([
      "/api/system/status",
      "/api/auth/session",
      "/api/auth/refresh",
    ]);
  } finally {
    opening.restore();
  }
  const refresh = installFetch(() => json({ detail: "Expired" }, 401));
  try {
    await expect(
      client.fetchQuery(systemHealthStatusOptions()),
    ).rejects.toBeInstanceOf(ApiError);
    expect(urls(refresh)).toEqual(["/api/system/status"]);
  } finally {
    refresh.restore();
  }
});

test("the automatic refresh does not renew the session; Check again does", async () => {
  const background = installFetch(() => json({ detail: "Expired" }, 401));
  try {
    await expect(getSystemStatus("background")).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(background.requests.map((request) => String(request.input))).toEqual(
      ["/api/system/status"],
    );
  } finally {
    background.restore();
  }
  const person = installFetch(() => json({ detail: "Expired" }, 401));
  try {
    await expect(getSystemStatus("person")).rejects.toBeInstanceOf(ApiError);
    expect(person.requests.map((request) => String(request.input))).toEqual([
      "/api/system/status",
      "/api/auth/session",
      "/api/auth/refresh",
    ]);
  } finally {
    person.restore();
  }
});

// S5 (API contract S5, S6): Slow, Email from real sends, the admin's file
// storage and the installation owner's block 4.

const ownerInstallation = {
  database_bytes: 1_400_000_000,
  database_measured_at: "2026-11-02T10:41:00Z",
  workers: [
    {
      key: "record_triggers",
      state: "running",
      last_seen_at: "2026-11-02T10:41:30Z",
    },
    {
      key: "report_scheduling",
      state: "not_seen",
      last_seen_at: "2026-11-01T23:58:00Z",
    },
    { key: "comms_jobs", state: "never_seen", last_seen_at: null },
    {
      key: "provider_signout",
      state: "running",
      last_seen_at: "2026-11-02T10:40:59Z",
    },
    {
      key: "backup_runner",
      state: "running",
      last_seen_at: "2026-11-02T10:39:00Z",
    },
  ],
};

test("S5-C4, S5-C5: Slow and an Email that works are status words the page knows", async () => {
  const body = {
    ...example,
    parts: [
      { key: "data", status: "slow" },
      { key: "signing_in", status: "working" },
      { key: "files", status: "not_working" },
      { key: "email", status: "working" },
    ],
  };
  const fetchStub = installFetch(() => json(body));
  try {
    expect((await getSystemStatus("background")).parts).toEqual(body.parts);
  } finally {
    fetchStub.restore();
  }
});

test("S5-C6, S5-C7: the owner's installation part and the admin's storage are accepted", async () => {
  for (const body of [
    { ...adminExample, installation: ownerInstallation },
    {
      ...adminExample,
      organization: { ...adminExample.organization, storage_used_bytes: null },
      installation: {
        database_bytes: null,
        database_measured_at: null,
        workers: ownerInstallation.workers,
      },
    },
  ]) {
    const fetchStub = installFetch(() => json(body));
    try {
      expect(await getSystemStatus("background")).toEqual(body);
    } finally {
      fetchStub.restore();
    }
  }
});

test("S5-C6, S5-C7: an installation or storage value outside the contract is refused", async () => {
  for (const body of [
    // The installation key is always present, null for everyone but the owner.
    { ...adminExample, installation: undefined },
    // The storage key is always present in the organization part.
    {
      ...adminExample,
      organization: { ...adminExample.organization, storage_used_bytes: -1 },
    },
    { ...adminExample, installation: { ...ownerInstallation, disk_free: 1 } },
    {
      ...adminExample,
      installation: {
        ...ownerInstallation,
        workers: [{ key: "mailer", state: "running", last_seen_at: null }],
      },
    },
    {
      ...adminExample,
      installation: {
        ...ownerInstallation,
        workers: [{ key: "comms_jobs", state: "stale", last_seen_at: null }],
      },
    },
  ]) {
    const fetchStub = installFetch(() => json(body));
    try {
      await expect(getSystemStatus("background")).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      fetchStub.restore();
    }
  }
  const withoutStorage = structuredClone(adminExample) as {
    organization: Record<string, unknown>;
  };
  delete withoutStorage.organization.storage_used_bytes;
  const fetchStub = installFetch(() =>
    json({ ...withoutStorage, installation: null }),
  );
  try {
    await expect(getSystemStatus("background")).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    fetchStub.restore();
  }
});

// GET /api/system/health-periods (S5-C3): one page of periods, newest first.

const periodsPage = {
  items: [
    {
      part: "email",
      kind: "not_working",
      started_at: "2026-11-02T10:30:00Z",
      ended_at: null,
    },
    {
      part: "files",
      kind: "slow",
      started_at: "2026-11-01T08:00:00Z",
      ended_at: "2026-11-01T08:12:00Z",
    },
  ],
  pagination: { limit: 5, offset: 0, count: 2, total: 2, has_more: false },
  oldest_sample_at: "2026-10-04T00:00:00Z",
};

test("S5-C3: the periods read asks for one page and accepts the contract's page", async () => {
  const fetchStub = installFetch(() => json(periodsPage));
  try {
    expect(
      await listSystemHealthPeriods({ limit: 5, offset: 0 }, "background"),
    ).toEqual(periodsPage);
    expect(String(fetchStub.requests[0].input)).toBe(
      "/api/system/health-periods?limit=5&offset=0",
    );
  } finally {
    fetchStub.restore();
  }
  const older = {
    items: [],
    pagination: { limit: 10, offset: 5, count: 0, total: 5, has_more: false },
    oldest_sample_at: null,
  };
  const olderStub = installFetch(() => json(older));
  try {
    expect(
      await listSystemHealthPeriods({ limit: 10, offset: 5 }, "person"),
    ).toEqual(older);
    expect(String(olderStub.requests[0].input)).toBe(
      "/api/system/health-periods?limit=10&offset=5",
    );
  } finally {
    olderStub.restore();
  }
});

test("S5-C3: a periods page outside the contract is refused", async () => {
  const [ongoing, ended] = periodsPage.items;
  for (const body of [
    { ...periodsPage, items: [{ ...ongoing, kind: "not_set_up" }] },
    { ...periodsPage, items: [{ ...ongoing, part: "database" }] },
    { ...periodsPage, items: [{ ...ended, org_id: "a" }] },
    { ...periodsPage, oldest_sample_at: undefined },
    // The page does not match the request.
    { ...periodsPage, pagination: { ...periodsPage.pagination, offset: 5 } },
    { ...periodsPage, pagination: { ...periodsPage.pagination, count: 3 } },
  ]) {
    const fetchStub = installFetch(() => json(body));
    try {
      await expect(
        listSystemHealthPeriods({ limit: 5, offset: 0 }, "background"),
      ).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      fetchStub.restore();
    }
  }
});

test("S5-C3: the automatic periods refresh does not renew the session; a press does", async () => {
  const urls = (stub: ReturnType<typeof installFetch>) =>
    stub.requests.map((request) => String(request.input));
  const background = installFetch(() => json({ detail: "Expired" }, 401));
  try {
    await expect(
      listSystemHealthPeriods({ limit: 5, offset: 0 }, "background"),
    ).rejects.toBeInstanceOf(ApiError);
    expect(urls(background)).toEqual([
      "/api/system/health-periods?limit=5&offset=0",
    ]);
  } finally {
    background.restore();
  }
  const person = installFetch(() => json({ detail: "Expired" }, 401));
  try {
    await expect(
      listSystemHealthPeriods({ limit: 10, offset: 5 }, "person"),
    ).rejects.toBeInstanceOf(ApiError);
    expect(urls(person)).toEqual([
      "/api/system/health-periods?limit=10&offset=5",
      "/api/auth/session",
      "/api/auth/refresh",
    ]);
  } finally {
    person.restore();
  }
});
