import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  createOpenViewReportSchedule,
  getOpenViewReportSchedule,
  getOpenViewReportScheduleConflict,
  updateOpenViewReportSchedule,
} from "../../../src/components/systems/openview/adapters/report-schedule-api";

const reportId = "00000000-0000-4000-8000-000000000301";
const uppercaseReportId = "ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF";
const lowercaseReportId = uppercaseReportId.toLowerCase();
const otherReportId = "00000000-0000-4000-8000-000000000302";
const scheduleId = "00000000-0000-4000-8000-000000000303";
const timestamp = "2026-09-23T00:00:00Z";
const path = `/api/reports/${reportId}/schedule`;

type CapturedRequest = { input: RequestInfo | URL; init?: RequestInit };

function installFetch(
  responder: (input: RequestInfo | URL, init?: RequestInit) => Response,
) {
  const original = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return Promise.resolve(responder(input, init));
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function wireSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: scheduleId,
    report_id: reportId,
    revision: 1,
    enabled: false,
    cadence: "daily",
    timezone_name: "Asia/Manila",
    local_time: "09:30",
    weekday: null,
    month_day: null,
    next_due_at: null,
    last_run: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

test("reads a private schedule without caching or inferring due time", async () => {
  let lastRun: Record<string, unknown> | null = null;
  const mock = installFetch(() =>
    jsonResponse(wireSchedule({ last_run: lastRun })),
  );
  try {
    await expect(getOpenViewReportSchedule(reportId)).resolves.toEqual({
      id: scheduleId,
      reportId,
      revision: 1,
      enabled: false,
      cadence: "daily",
      timezoneName: "Asia/Manila",
      localTime: "09:30",
      weekday: null,
      monthDay: null,
      nextDueAt: null,
      lastRun: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(String(mock.requests[0]?.input)).toBe(path);
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
    lastRun = { state: "running", finished_at: null, failure_label: null };
    await expect(getOpenViewReportSchedule(reportId)).resolves.toMatchObject({
      lastRun: { state: "running", finishedAt: null, failureLabel: null },
    });
    lastRun = {
      state: "failed",
      finished_at: timestamp,
      failure_label: "Source unavailable",
    };
    await expect(getOpenViewReportSchedule(reportId)).resolves.toMatchObject({
      lastRun: {
        state: "failed",
        finishedAt: timestamp,
        failureLabel: "Source unavailable",
      },
    });
  } finally {
    mock.restore();
  }
});

test("canonicalizes uppercase UUID input before each schedule request and identity check", async () => {
  const canonicalPath = `/api/reports/${lowercaseReportId}/schedule`;
  const responses = [
    jsonResponse(wireSchedule({ report_id: lowercaseReportId })),
    jsonResponse(wireSchedule({ report_id: lowercaseReportId }), 201, {
      Location: canonicalPath,
    }),
    jsonResponse(wireSchedule({ report_id: lowercaseReportId, revision: 2 })),
  ];
  const mock = installFetch(() => responses.shift()!);
  try {
    await expect(
      getOpenViewReportSchedule(uppercaseReportId),
    ).resolves.toMatchObject({
      reportId: lowercaseReportId,
    });
    await expect(
      createOpenViewReportSchedule({
        reportId: uppercaseReportId,
        enabled: false,
        cadence: "daily",
        timezoneName: "UTC",
        localTime: "09:30",
      }),
    ).resolves.toMatchObject({ reportId: lowercaseReportId });
    await expect(
      updateOpenViewReportSchedule({
        reportId: uppercaseReportId,
        revision: 1,
        enabled: false,
      }),
    ).resolves.toMatchObject({ reportId: lowercaseReportId, revision: 2 });
    expect(mock.requests.map((request) => String(request.input))).toEqual([
      canonicalPath,
      canonicalPath,
      canonicalPath,
    ]);
  } finally {
    mock.restore();
  }
});

test("creates an enabled policy with an exact 201 Location and no client due cursor", async () => {
  const mock = installFetch(() =>
    jsonResponse(
      wireSchedule({
        enabled: true,
        cadence: "weekly",
        weekday: 0,
        next_due_at: "2026-09-28T01:30:00Z",
      }),
      201,
      { Location: path },
    ),
  );
  try {
    await expect(
      createOpenViewReportSchedule({
        reportId,
        enabled: true,
        cadence: "weekly",
        timezoneName: "Asia/Manila",
        localTime: "09:30",
        weekday: 0,
      }),
    ).resolves.toMatchObject({
      reportId,
      enabled: true,
      nextDueAt: "2026-09-28T01:30:00Z",
      lastRun: null,
    });
    expect(String(mock.requests[0]?.input)).toBe(path);
    expect(mock.requests[0]?.init?.method).toBe("POST");
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      enabled: true,
      cadence: "weekly",
      timezone_name: "Asia/Manila",
      local_time: "09:30",
      weekday: 0,
    });
  } finally {
    mock.restore();
  }
});

test("allows a disabled policy request without a client audience gate", async () => {
  const mock = installFetch(() =>
    jsonResponse(wireSchedule(), 201, { Location: path }),
  );
  try {
    await expect(
      createOpenViewReportSchedule({
        reportId,
        enabled: false,
        cadence: "daily",
        timezoneName: "Asia/Manila",
        localTime: "09:30",
      }),
    ).resolves.toMatchObject({ enabled: false, nextDueAt: null });
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      enabled: false,
      cadence: "daily",
      timezone_name: "Asia/Manila",
      local_time: "09:30",
    });
  } finally {
    mock.restore();
  }
});

test("accepts IANA aliases while sending a canonical timezone key", async () => {
  const mock = installFetch(() =>
    jsonResponse(wireSchedule({ timezone_name: "America/New_York" }), 201, {
      Location: path,
    }),
  );
  try {
    await expect(
      createOpenViewReportSchedule({
        reportId,
        enabled: false,
        cadence: "daily",
        timezoneName: "US/Eastern",
        localTime: "09:30",
      }),
    ).resolves.toMatchObject({ timezoneName: "America/New_York" });
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toMatchObject({
      timezone_name: "America/New_York",
    });
  } finally {
    mock.restore();
  }
});

test("patches only changed policy fields with the server revision", async () => {
  const mock = installFetch(() =>
    jsonResponse(wireSchedule({ revision: 2, local_time: "10:15" })),
  );
  try {
    await expect(
      updateOpenViewReportSchedule({
        reportId,
        revision: 1,
        localTime: "10:15",
      }),
    ).resolves.toMatchObject({ revision: 2, localTime: "10:15" });
    expect(mock.requests[0]?.init?.method).toBe("PATCH");
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      revision: 1,
      local_time: "10:15",
    });
  } finally {
    mock.restore();
  }
});

test("rejects malformed input before network and never computes eligibility", async () => {
  const mock = installFetch(() => jsonResponse(wireSchedule()));
  try {
    await expect(getOpenViewReportSchedule("invalid")).rejects.toThrow();
    await expect(
      createOpenViewReportSchedule({
        reportId,
        enabled: true,
        cadence: "weekly",
        timezoneName: "Asia/Manila",
        localTime: "09:30",
      }),
    ).rejects.toThrow();
    await expect(
      updateOpenViewReportSchedule({ reportId, revision: 0, enabled: true }),
    ).rejects.toThrow();
    await expect(
      updateOpenViewReportSchedule({ reportId, revision: 1 }),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("rejects non-IANA timezones locally and in untrusted schedule responses", async () => {
  const mock = installFetch(() =>
    jsonResponse(wireSchedule({ timezone_name: "Mars/Olympus" })),
  );
  try {
    await expect(
      createOpenViewReportSchedule({
        reportId,
        enabled: false,
        cadence: "daily",
        timezoneName: "Mars/Olympus",
        localTime: "09:30",
      }),
    ).rejects.toThrow();
    await expect(
      updateOpenViewReportSchedule({
        reportId,
        revision: 1,
        timezoneName: "+08:00",
      }),
    ).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
    await expect(getOpenViewReportSchedule(reportId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
});

test("rejects mismatched, incomplete, or invalid schedule responses", async () => {
  const responses = [
    jsonResponse(wireSchedule({ report_id: otherReportId })),
    jsonResponse(wireSchedule({ enabled: true, next_due_at: null })),
    jsonResponse(wireSchedule({ next_due_at: timestamp })),
    jsonResponse(wireSchedule(), 201, {
      Location: "/api/reports/other/schedule",
    }),
    jsonResponse(wireSchedule(), 200, { Location: path }),
    jsonResponse(wireSchedule({ last_run: undefined })),
    jsonResponse(
      wireSchedule({
        last_run: { state: "waiting", finished_at: null, failure_label: null },
      }),
    ),
    jsonResponse(
      wireSchedule({
        last_run: {
          state: "failed",
          finished_at: "yesterday",
          failure_label: null,
        },
      }),
    ),
    jsonResponse(
      wireSchedule({
        last_run: { state: "failed", finished_at: null, failure_label: 42 },
      }),
    ),
    jsonResponse(
      wireSchedule({
        last_run: {
          state: "failed",
          finished_at: null,
          failure_label: null,
          exception: "private",
        },
      }),
    ),
  ];
  const mock = installFetch(() => responses.shift()!);
  try {
    await expect(getOpenViewReportSchedule(reportId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
    await expect(getOpenViewReportSchedule(reportId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
    await expect(getOpenViewReportSchedule(reportId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
    await expect(
      createOpenViewReportSchedule({
        reportId,
        enabled: false,
        cadence: "daily",
        timezoneName: "Asia/Manila",
        localTime: "09:30",
      }),
    ).rejects.toBeInstanceOf(ApiContractError);
    await expect(
      createOpenViewReportSchedule({
        reportId,
        enabled: false,
        cadence: "daily",
        timezoneName: "Asia/Manila",
        localTime: "09:30",
      }),
    ).rejects.toBeInstanceOf(ApiContractError);
    for (let index = 0; index < 5; index += 1)
      await expect(getOpenViewReportSchedule(reportId)).rejects.toBeInstanceOf(
        ApiContractError,
      );
  } finally {
    mock.restore();
  }
});

test("preserves only safe 409 conflict details and hides untrusted server text", async () => {
  const responses = [
    jsonResponse(
      {
        detail: {
          code: "stale_revision",
          message: "secret",
          current_revision: 3,
        },
      },
      409,
    ),
    jsonResponse(
      { detail: { code: "schedule_ineligible", message: "secret" } },
      409,
    ),
    jsonResponse({ detail: "database secret" }, 500),
  ];
  const mock = installFetch(() => responses.shift()!);
  try {
    let stale: unknown;
    try {
      await updateOpenViewReportSchedule({
        reportId,
        revision: 1,
        enabled: false,
      });
    } catch (error) {
      stale = error;
    }
    expect(stale).toBeInstanceOf(ApiError);
    expect(getOpenViewReportScheduleConflict(stale)).toEqual({
      code: "stale_revision",
      message: "Schedule changed; reload before saving",
      currentRevision: 3,
    });
    expect(JSON.stringify(stale)).not.toContain("secret");

    let ineligible: unknown;
    try {
      await updateOpenViewReportSchedule({
        reportId,
        revision: 1,
        enabled: true,
      });
    } catch (error) {
      ineligible = error;
    }
    expect(getOpenViewReportScheduleConflict(ineligible)).toEqual({
      code: "schedule_ineligible",
      message: "The Report is unavailable for scheduling",
    });
    expect(JSON.stringify(ineligible)).not.toContain("secret");

    await expect(getOpenViewReportSchedule(reportId)).rejects.toMatchObject({
      status: 500,
      message: "Request could not be completed",
    });
  } finally {
    mock.restore();
  }
});
