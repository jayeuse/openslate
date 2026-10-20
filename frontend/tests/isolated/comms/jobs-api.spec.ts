import { expect, test } from "@playwright/test";
import { z } from "zod";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import { installFetch } from "../helpers/fake-fetch";
import {
  calls,
  jobs,
  retention,
  context,
  org,
  user,
  other,
  conversationId,
  jobId,
  etag,
  conditional,
  schedule,
  scheduleInput,
  exportJob,
  exportRequest,
  channelPolicy,
  workspacePolicy,
  retained,
  preview,
  retentionRequest,
  password,
  proof,
  downloadHeaders,
} from "./jobs-fixtures";

for (const row of calls())
  test(`job transport: ${row.name}`, async () => {
    const signal = new AbortController().signal;
    const action = calls(signal).find((item) => item.name === row.name)!;
    const mock = installFetch(() =>
      Response.json(row.wire, {
        status: row.status ?? 200,
        headers: {
          ETag: etag,
          "Cache-Control": "private, no-store",
          ...(row.location ? { Location: row.location } : {}),
        },
      }),
    );
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { cookie: "openslate_csrf=synthetic-csrf" },
    });
    try {
      await expect(action.invoke()).resolves.toEqual(row.expected);
      expect(mock.requests).toHaveLength(1);
      const { input, init } = mock.requests[0];
      const url = new URL(String(input), "http://test.invalid");
      expect(url.pathname).toBe(row.path);
      expect(Object.fromEntries(url.searchParams)).toEqual(row.query ?? {});
      expect(init?.method).toBe(row.method);
      expect(init?.signal).toBe(signal);
      expect(init?.cache).toBe("no-store");
      expect(init?.credentials).toBe("same-origin");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Org")).toBe(org);
      expect(headers.get("If-Match")).toBe(
        row.conditional ? conditional.if_match : null,
      );
      if (row.method !== "GET")
        expect(headers.get("X-CSRF-Token")).toBe("synthetic-csrf");
      if (row.body === undefined) expect(init?.body).toBeUndefined();
      else expect(JSON.parse(String(init?.body))).toEqual(row.body);
    } finally {
      mock.restore();
      if (original) Object.defineProperty(globalThis, "document", original);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });

test("job responses refuse foreign identities, altered acknowledged requests and proof or byte projections", async () => {
  for (const row of [
    {
      call: () => jobs.getSchedule(context, jobId),
      wires: [
        { ...schedule, id: other },
        { ...schedule, org_id: other },
        { ...schedule, password },
      ],
    },
    {
      call: () => jobs.createSchedule(context, scheduleInput),
      status: 201,
      location: `/api/comms/scheduled-messages/${jobId}`,
      wires: [
        { ...schedule, author_id: other },
        {
          ...schedule,
          request: { ...schedule.request, conversation_id: other },
        },
        { ...schedule, request: { ...schedule.request, client_key: user } },
      ],
    },
    {
      call: () =>
        jobs.updateSchedule(context, jobId, scheduleInput, conditional),
      wires: [
        { ...schedule, id: other },
        {
          ...schedule,
          request: { ...schedule.request, body: "Wrong message" },
        },
      ],
    },
    {
      call: () => jobs.sendScheduleNow(context, jobId, conditional),
      wires: [
        { ...schedule, id: other },
        { ...schedule, org_id: other },
      ],
    },
    {
      call: () => jobs.cancelSchedule(context, jobId, conditional),
      wires: [schedule, { ...schedule, status: "cancelled", org_id: other }],
    },
    {
      call: () => jobs.getExport(context, jobId),
      wires: [
        { ...exportJob, id: other },
        { ...exportJob, org_id: other },
        { ...exportJob, bytes: "Private" },
        { ...exportJob, password },
      ],
    },
    {
      call: () => jobs.startExport(context, exportRequest, { password }),
      status: 201,
      location: `/api/comms/exports/${jobId}`,
      wires: [
        { ...exportJob, requested_by: other },
        { ...exportJob, request: { ...exportRequest, reason: undefined } },
        {
          ...exportJob,
          request: { ...exportRequest, conversation_ids: [other] },
        },
      ],
    },
    {
      call: () => retention.getRetention(context, channelPolicy.scope),
      wires: [
        {
          ...retained,
          policy: { ...channelPolicy, scope: { kind: "channel", id: other } },
        },
        { ...retained, effective: { message_days: 30, file_days: 9 } },
        { ...retained, password },
      ],
    },
    {
      call: () => retention.previewRetention(context, channelPolicy, proof),
      wires: [
        { ...preview, preview_digest: "invalid" },
        {
          ...preview,
          policy: { ...channelPolicy, message_days: 7 },
          effective: { message_days: 7, file_days: 7 },
          sources: { message_days: "channel", file_days: "channel" },
        },
      ],
    },
    {
      call: () => retention.updateRetention(context, retentionRequest, proof),
      wires: [
        {
          ...retained,
          policy: { ...channelPolicy, file_days: 0 },
          effective: { message_days: 30, file_days: 0 },
        },
        {
          ...retained,
          policy: { ...channelPolicy, scope: { kind: "workspace" } },
        },
      ],
    },
  ])
    for (const wire of row.wires) {
      const mock = installFetch(() =>
        Response.json(wire, {
          status: row.status ?? 200,
          headers: {
            ETag: etag,
            "Cache-Control": "private, no-store",
            Location: row.location ?? "",
          },
        }),
      );
      try {
        await expect(row.call()).rejects.toBeInstanceOf(ApiContractError);
      } finally {
        mock.restore();
      }
    }
});

for (const action of ["create", "edit"] as const)
  test(`schedule ${action} accepts backend UTC and microsecond serialization without weakening request identity`, async () => {
    // Native POST/PUT/GET examples: .agent-runtime/opencomms/s23-submissions/
    // correction-backend-proof/serialized.json. The .1 spelling is additionally
    // proven by opencomms-s23-b1-dto-serialization.log. Expected instants are
    // literals from the producer, never a second normalization implementation.
    const examples = [
      ["2100-01-02T08:00:00+08:00", "2100-01-02T00:00:00Z"],
      ["2100-01-02T09:00:00.123456+08:00", "2100-01-02T01:00:00.123456Z"],
      ["2100-01-03T08:00:00.123456789+08:00", "2100-01-03T00:00:00.123456Z"],
      ["2100-01-03T08:00:00.123456001+08:00", "2100-01-03T00:00:00.123456Z"],
      ["2100-01-04T08:00:00.000001+08:00", "2100-01-04T00:00:00.000001Z"],
      ["2100-01-04T08:00:00.000009+08:00", "2100-01-04T00:00:00.000009Z"],
      ["2100-01-01T12:00:00.1+08:00", "2100-01-01T04:00:00.100000Z"],
      ["2100-01-01T12:00:00.100000+08:00", "2100-01-01T04:00:00.100000Z"],
    ];
    const invoke = (send_at: string) =>
      action === "create"
        ? jobs.createSchedule(context, { ...scheduleInput, send_at })
        : jobs.updateSchedule(
            context,
            jobId,
            { ...scheduleInput, send_at },
            conditional,
          );
    for (const [inputTime, returnedTime] of examples) {
      const wire = {
        ...schedule,
        request: { ...schedule.request, send_at: returnedTime },
      };
      const mock = installFetch(() =>
        Response.json(wire, {
          status: action === "create" ? 201 : 200,
          headers: {
            ETag: etag,
            "Cache-Control": "private, no-store",
            Location: `/api/comms/scheduled-messages/${jobId}`,
          },
        }),
      );
      try {
        await expect(invoke(inputTime)).resolves.toEqual({ data: wire, etag });
        expect(JSON.parse(String(mock.requests[0].init?.body)).send_at).toBe(
          inputTime,
        );
      } finally {
        mock.restore();
      }
    }

    const inputTime = "2100-01-02T09:00:00.123456+08:00";
    for (const changed of [
      // Both adjacent microseconds collapse to the same Date millisecond.
      { send_at: "2100-01-02T01:00:00.123455Z" },
      { send_at: "2100-01-02T01:00:00.123457Z" },
      { send_at: "2100-01-02T01:00:01.123456Z" },
      // A reply must not gain unsupported nonzero sub-microsecond precision.
      { send_at: "2100-01-02T01:00:00.123456001Z" },
      { body: "Different content" },
      { client_key: user },
      { conversation_id: other },
      { parent_id: other },
      { reply_to_id: other },
      { attachment_ids: [other] },
      { record_ids: [other] },
      { mention_user_ids: [other] },
      { mentions_channel: true },
      { mentions_here: true },
      { also_send_to_channel: true },
    ]) {
      const wire = {
        ...schedule,
        request: {
          ...schedule.request,
          send_at: "2100-01-02T01:00:00.123456Z",
          ...changed,
        },
      };
      const mock = installFetch(() =>
        Response.json(wire, {
          status: action === "create" ? 201 : 200,
          headers: {
            ETag: etag,
            "Cache-Control": "private, no-store",
            Location: `/api/comms/scheduled-messages/${jobId}`,
          },
        }),
      );
      try {
        await expect(invoke(inputTime)).rejects.toBeInstanceOf(
          ApiContractError,
        );
      } finally {
        mock.restore();
      }
    }
  });

test("job pages preserve requested offsets and refuse mixed organization or inconsistent pagination", async () => {
  for (const row of [
    {
      call: () =>
        jobs.listSchedules(context, {
          limit: 1,
          offset: 2,
          sort_order: "desc",
        }),
      item: schedule,
    },
    {
      call: () =>
        jobs.listExports(context, { limit: 1, offset: 2, sort_order: "desc" }),
      item: exportJob,
    },
  ]) {
    const valid = {
      items: [row.item],
      pagination: { limit: 1, offset: 2, count: 1, total: 3, has_more: false },
    };
    let wire: unknown = valid;
    const mock = installFetch(() =>
      Response.json(wire, {
        headers: { "Cache-Control": "private, no-store" },
      }),
    );
    try {
      await expect(row.call()).resolves.toEqual(valid);
      expect(
        Object.fromEntries(
          new URL(String(mock.requests[0].input), "http://test.invalid")
            .searchParams,
        ),
      ).toEqual({
        limit: "1",
        offset: "2",
        sort_by: "created_at",
        sort_order: "desc",
      });
      for (const bad of [
        { ...valid, items: [{ ...row.item, org_id: other }] },
        { ...valid, pagination: { ...valid.pagination, limit: 25 } },
        { ...valid, pagination: { ...valid.pagination, count: 0 } },
        { ...valid, pagination: { ...valid.pagination, has_more: true } },
      ]) {
        wire = bad;
        await expect(row.call()).rejects.toBeInstanceOf(ApiContractError);
      }
    } finally {
      mock.restore();
    }
  }
});

test("job acknowledgements require exact status, private no-store, versions and created resource location", async () => {
  for (const row of calls()) {
    const variants: ResponseInit[] = [
      {
        status: 202,
        headers: {
          ETag: etag,
          "Cache-Control": "private, no-store",
          Location: row.location ?? "",
        },
      },
      {
        status: row.status ?? 200,
        headers: {
          ETag: etag,
          "Cache-Control": "public, no-store",
          Location: row.location ?? "",
        },
      },
      ...(row.versioned
        ? [
            {
              status: row.status ?? 200,
              headers: {
                "Cache-Control": "private, no-store",
                Location: row.location ?? "",
              },
            },
            {
              status: row.status ?? 200,
              headers: {
                ETag: 'W/"weak"',
                "Cache-Control": "private, no-store",
                Location: row.location ?? "",
              },
            },
          ]
        : []),
      ...(row.location
        ? [
            {
              status: row.status,
              headers: {
                ETag: etag,
                "Cache-Control": "private, no-store",
                Location: "/api/comms/wrong",
              },
            },
          ]
        : []),
    ];
    for (const variant of variants) {
      const mock = installFetch(() => Response.json(row.wire, variant));
      try {
        await expect(row.invoke()).rejects.toBeInstanceOf(ApiContractError);
      } finally {
        mock.restore();
      }
    }
  }
});

test("retention scope encoding and null resets preserve server inheritance through the protected PUT", async () => {
  const workspace = {
    policy: workspacePolicy,
    effective: { message_days: 30, file_days: 0 },
    sources: { message_days: "workspace", file_days: "workspace" },
  };
  const resetPolicy = { ...channelPolicy, file_days: null };
  const inherited = {
    policy: resetPolicy,
    effective: { message_days: 60, file_days: 0 },
    sources: { message_days: "workspace", file_days: "workspace" },
  };
  const mock = installFetch((_input, init) =>
    Response.json(init?.method === "PUT" ? inherited : workspace, {
      headers: { ETag: etag, "Cache-Control": "private, no-store" },
    }),
  );
  try {
    await expect(
      retention.getRetention(context, workspacePolicy.scope),
    ).resolves.toEqual({ data: workspace, etag });
    expect(String(mock.requests[0].input)).toBe(
      "/api/comms/retention?scope_kind=workspace",
    );
    await expect(
      retention.updateRetention(
        context,
        { ...resetPolicy, preview_digest: preview.preview_digest },
        proof,
      ),
    ).resolves.toEqual({ data: inherited, etag });
    expect(String(mock.requests[1].input)).toBe("/api/comms/retention");
    expect(mock.requests[1].init?.method).toBe("PUT");
    expect(JSON.parse(String(mock.requests[1].init?.body))).toEqual({
      ...resetPolicy,
      preview_digest: preview.preview_digest,
      password,
    });
  } finally {
    mock.restore();
  }
});

test("protected job inputs reject missing or malformed proof, digest and conditional options before dispatch", async () => {
  const mock = installFetch(() => Response.json({}));
  try {
    const invalid = [
      () => jobs.getSchedule(context, "invalid"),
      () => jobs.listExports({ ...context, org_id: "invalid" }),
      () => jobs.createSchedule(context, { ...scheduleInput, body: "" }),
      () => jobs.listSchedules(context, { limit: 101 }),
      () =>
        jobs.startExport(context, {
          ...exportRequest,
          conversation_ids: [conversationId, conversationId],
        }),
      () =>
        jobs.startExport(context, {
          ...exportRequest,
          after: "2026-10-22",
          before: "2026-10-21",
        }),
      () => jobs.startExport(context, exportRequest, { password: "" }),
      () =>
        jobs.startExport(context, {
          ...exportRequest,
          password,
        } as typeof exportRequest),
      () => jobs.downloadExport(context, "invalid"),
      () =>
        retention.getRetention(context, {
          kind: "channel",
        } as typeof channelPolicy.scope),
      () =>
        retention.getRetention(context, {
          kind: "workspace",
          id: conversationId,
        } as typeof workspacePolicy.scope),
      () =>
        retention.getRetention(context, {
          kind: "channel",
          id: conversationId,
          unknown: true,
        } as typeof channelPolicy.scope),
      () =>
        retention.previewRetention(context, channelPolicy, {
          ...proof,
          password: "",
        }),
      () =>
        retention.previewRetention(
          context,
          channelPolicy,
          conditional as typeof proof,
        ),
      () =>
        retention.updateRetention(
          context,
          { ...retentionRequest, preview_digest: "wrong" },
          proof,
        ),
      () =>
        retention.updateRetention(
          context,
          retentionRequest,
          conditional as typeof proof,
        ),
      ...[{}, { if_match: 'W/"weak"' }, { if_match: "*" }].flatMap(
        (options) => [
          () =>
            jobs.updateSchedule(
              context,
              jobId,
              scheduleInput,
              options as typeof conditional,
            ),
          () =>
            jobs.sendScheduleNow(context, jobId, options as typeof conditional),
          () =>
            jobs.cancelSchedule(context, jobId, options as typeof conditional),
          () =>
            retention.previewRetention(context, channelPolicy, {
              ...options,
              password,
            } as typeof proof),
          () =>
            retention.updateRetention(context, retentionRequest, {
              ...options,
              password,
            } as typeof proof),
        ],
      ),
    ];
    for (const invoke of invalid)
      await expect(invoke()).rejects.toBeInstanceOf(z.ZodError);
    expect(mock.requests).toEqual([]);
  } finally {
    mock.restore();
  }
});

test("export start does not infer private source authority and never persists proof in its job", async () => {
  const mock = installFetch(() =>
    Response.json(exportJob, {
      status: 201,
      headers: {
        Location: `/api/comms/exports/${jobId}`,
        "Cache-Control": "private, no-store",
      },
    }),
  );
  try {
    await expect(jobs.startExport(context, exportRequest)).resolves.toEqual(
      exportJob,
    );
    expect(mock.requests).toHaveLength(1);
    expect(JSON.parse(String(mock.requests[0].init?.body))).toEqual(
      exportRequest,
    );
  } finally {
    mock.restore();
  }
});

test("job refusals and aborted schedule waits do not issue cancellation, retries or replacement sends", async () => {
  for (const status of [403, 404, 409, 412, 428, 503]) {
    const mock = installFetch(() =>
      Response.json(
        { detail: { code: "comms_conflict", message: "Unavailable" } },
        { status },
      ),
    );
    try {
      await expect(
        jobs.sendScheduleNow(context, jobId, conditional),
      ).rejects.toMatchObject({ status });
      await expect(
        retention.updateRetention(context, retentionRequest, proof),
      ).rejects.toMatchObject({ status });
      expect(mock.requests).toHaveLength(2);
    } finally {
      mock.restore();
    }
  }
  const controller = new AbortController();
  const cancelled = new DOMException("Cancelled", "AbortError");
  const mock = installFetch((_input, init) => {
    if (init?.method === "POST") {
      controller.abort(cancelled);
      return Promise.reject(cancelled);
    }
    return Response.json(
      { ...schedule, status: "running" },
      { headers: { ETag: etag, "Cache-Control": "private, no-store" } },
    );
  });
  try {
    await expect(
      jobs.sendScheduleNow(context, jobId, {
        ...conditional,
        signal: controller.signal,
      }),
    ).rejects.toBe(cancelled);
    await expect(jobs.getSchedule(context, jobId)).resolves.toEqual({
      data: { ...schedule, status: "running" },
      etag,
    });
    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      [`/api/comms/scheduled-messages/${jobId}/send`, "POST"],
      [`/api/comms/scheduled-messages/${jobId}`, "GET"],
    ]);
  } finally {
    mock.restore();
  }
});

test("export binary preserves real format, safe ASCII or RFC5987 filename and bytes without download proof", async () => {
  for (const row of [
    {
      disposition: 'attachment; filename="commas; report.csv"',
      type: "text/csv",
      filename: "commas; report.csv",
    },
    {
      disposition: "attachment; filename=report.csv",
      type: "text/csv; charset=UTF-8",
      filename: "report.csv",
    },
    {
      disposition: "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.xlsx",
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: "résumé.xlsx",
    },
    {
      disposition:
        "attachment; filename=\"resume.csv\"; filename*=UTF-8''r%C3%A9sum%C3%A9.csv",
      type: "text/csv; charset=utf-8",
      filename: "résumé.csv",
    },
  ]) {
    const signal = new AbortController().signal;
    const mock = installFetch(
      () =>
        new Response("hello", {
          headers: {
            ...downloadHeaders,
            "Content-Disposition": row.disposition,
            "Content-Type": row.type,
          },
        }),
    );
    try {
      const result = await jobs.downloadExport(context, jobId, {
        signal,
        password,
      } as { signal: AbortSignal });
      expect(result.filename).toBe(row.filename);
      expect(result.media_type).toBe(row.type);
      expect(await result.bytes.text()).toBe("hello");
      const { input, init } = mock.requests[0];
      expect(String(input)).toBe(`/api/comms/exports/${jobId}/content`);
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(init?.redirect).toBe("error");
      expect(init?.cache).toBe("no-store");
      expect(init?.signal).toBe(signal);
      expect(new Headers(init?.headers).get("X-Org")).toBe(org);
      expect(new Headers(init?.headers).has("If-Match")).toBe(false);
    } finally {
      mock.restore();
    }
  }
});

test("export binaries reject wrong statuses unsafe metadata and length mismatches", async () => {
  for (const patch of [
    { "Content-Type": "text/html" },
    { "Content-Type": "text/csv; charset=latin1" },
    { "Content-Disposition": 'inline; filename="report.csv"' },
    { "Content-Disposition": 'attachment; filename="../report.csv"' },
    { "Content-Disposition": 'attachment; filename="report.xlsx"' },
    { "Content-Disposition": "attachment; filename*=UTF-8''bad%00.csv" },
    { "Content-Disposition": "attachment; filename*=UTF-8''bad%7F.csv" },
    { "Content-Disposition": "attachment; filename*=UTF-8''%ZZ.csv" },
    {
      "Content-Disposition":
        "attachment; filename=\"../bad.csv\"; filename*=UTF-8''good.csv",
    },
    { "Cache-Control": "public, no-store" },
    { "Cache-Control": "private" },
    { "Cache-Control": "no-store" },
    { "X-Content-Type-Options": "" },
    { "Content-Length": "4" },
    { "Content-Length": "6" },
    { "Content-Length": "NaN" },
    { "Content-Length": String(8 * 1024 * 1024 + 1) },
  ]) {
    const mock = installFetch(
      () =>
        new Response("hello", { headers: { ...downloadHeaders, ...patch } }),
    );
    try {
      await expect(jobs.downloadExport(context, jobId)).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      mock.restore();
    }
  }
  const mock = installFetch(
    () => new Response("hello", { status: 206, headers: downloadHeaders }),
  );
  try {
    await expect(jobs.downloadExport(context, jobId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
});

test("export download accepts exactly 8 MiB and cancels oversize or aborted streams without truncating", async () => {
  const exact = new Uint8Array(8 * 1024 * 1024);
  const valid = installFetch(
    () =>
      new Response(exact, {
        headers: {
          ...downloadHeaders,
          "Content-Length": String(exact.byteLength),
        },
      }),
  );
  try {
    expect((await jobs.downloadExport(context, jobId)).bytes.size).toBe(
      8 * 1024 * 1024,
    );
  } finally {
    valid.restore();
  }
  for (const abort of [false, true]) {
    let cancelled = false;
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull(target) {
        if (abort)
          controller.abort(new DOMException("Cancelled", "AbortError"));
        target.enqueue(new Uint8Array(abort ? 1 : 8 * 1024 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers = new Headers(downloadHeaders);
    headers.delete("Content-Length");
    const mock = installFetch(() => new Response(stream, { headers }));
    try {
      await expect(
        jobs.downloadExport(context, jobId, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(abort ? DOMException : ApiContractError);
      expect(cancelled).toBe(true);
    } finally {
      mock.restore();
    }
  }
});

test("binary dependency and cancellation errors stay errors and never expose private server detail", async () => {
  for (const status of [403, 404, 409, 503]) {
    const mock = installFetch(() =>
      Response.json(
        {
          detail: {
            code: "comms_not_found",
            message: "Private source message",
          },
        },
        { status },
      ),
    );
    try {
      const failure = jobs.downloadExport(context, jobId);
      await expect(failure).rejects.toMatchObject({
        status,
        message: "Export could not be downloaded.",
      });
      await expect(failure).rejects.toBeInstanceOf(ApiError);
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  }
  const aborted = new DOMException("Cancelled", "AbortError");
  const mock = installFetch(() => Promise.reject(aborted));
  try {
    await expect(jobs.downloadExport(context, jobId)).rejects.toBe(aborted);
  } finally {
    mock.restore();
  }
});
