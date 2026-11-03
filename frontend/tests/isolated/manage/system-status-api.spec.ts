import { expect, test } from "@playwright/test";

import { QueryClient } from "@tanstack/react-query";

import { getSystemStatus } from "../../../src/components/systems/manage/adapters/system-status-api";
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
      parts: [...example.parts.slice(0, 3), { key: "email", status: "slow" }],
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
