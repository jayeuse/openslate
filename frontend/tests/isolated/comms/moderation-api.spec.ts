import { expect, test } from "@playwright/test";
import { z } from "zod";
import * as api from "../../../src/components/systems/comms/adapters/moderation-api";
import { ApiContractError } from "../../../src/lib/api";
import { installFetch } from "../helpers/fake-fetch";
import { thread } from "./s18-fixtures";
import {
  calls,
  context,
  org,
  other,
  conversationId,
  messageId,
  reportId,
  revision,
  report,
  resolved,
  conditional,
  etag,
  tombstone,
  live,
  page,
  settings,
  preview,
  purged,
  purgeRequest,
  restrictions,
  reportEtag,
  reportCondition,
} from "./moderation-fixtures";

for (const row of calls())
  test(`moderation transport: ${row.name}`, async () => {
    const signal = new AbortController().signal;
    const call = calls(signal).find(
      (candidate) => candidate.name === row.name,
    )!;
    const mock = installFetch(() =>
      row.status === 204
        ? new Response(null, { status: 204 })
        : Response.json(row.wire, {
            headers: {
              ETag: row.etag ?? etag,
              "Cache-Control": "private, no-store",
            },
          }),
    );
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { cookie: "openslate_csrf=synthetic-csrf" },
    });
    try {
      await expect(call.invoke()).resolves.toEqual(row.expected);
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
        row.conditional ? (row.ifMatch ?? conditional.if_match) : null,
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

test("moderation lists echo requested paging and reject mixed subjects, unredacted removals and inconsistent pages", async () => {
  const request = {
    limit: 1,
    offset: 2,
    sort_by: "updated_at",
    sort_order: "desc",
  } as const;
  for (const row of [
    {
      call: () =>
        api.listMessageRevisions(context, conversationId, messageId, request),
      item: revision,
      bad: { ...revision, message_id: other },
    },
    {
      call: () => api.listReports(context, request),
      item: report,
      bad: { ...report, org_id: other },
    },
    {
      call: () => api.listRemovedMessages(context, conversationId, request),
      item: tombstone,
      bad: { ...tombstone, body: "Removed text" },
    },
  ]) {
    const valid = {
      items: [row.item],
      pagination: { limit: 1, offset: 2, count: 1, total: 3, has_more: false },
    };
    let wire: unknown = valid;
    const mock = installFetch(() => Response.json(wire));
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
        sort_by: "updated_at",
        sort_order: "desc",
      });
      for (const invalid of [
        { ...valid, items: [row.bad] },
        { ...valid, pagination: { ...valid.pagination, limit: 25 } },
        { ...valid, pagination: { ...valid.pagination, count: 0 } },
        { ...valid, pagination: { ...valid.pagination, has_more: true } },
        {
          ...valid,
          items: [row.item, row.item],
          pagination: { ...valid.pagination, count: 2, total: 4 },
        },
      ]) {
        wire = invalid;
        await expect(row.call()).rejects.toBeInstanceOf(ApiContractError);
      }
    } finally {
      mock.restore();
    }
  }
});

test("moderation response binding includes message state and embedded thread context", async () => {
  for (const row of [
    ...[api.removeReportedMessage, api.restoreReportedMessage].map(
      (action) => ({
        call: () => action(context, reportId, conditional),
        wires: [
          { ...report, org_id: other },
          { ...report, id: other },
          resolved,
          { ...report, body: "Private message" },
          { ...report, message: live },
          live,
          tombstone,
        ],
      }),
    ),
    {
      call: () => api.getReport(context, reportId),
      wires: [
        { ...report, id: other },
        { ...report, org_id: other },
        { ...report, message_body: "Private" },
      ],
    },
    {
      call: () => api.resolveReport(context, reportId, conditional),
      wires: [
        report,
        { ...resolved, id: other },
        { ...resolved, org_id: other },
      ],
    },
    {
      call: () =>
        api.removeMessage(context, conversationId, messageId, conditional),
      wires: [
        live,
        { ...tombstone, id: other },
        { ...tombstone, org_id: other },
        { ...tombstone, conversation_id: other },
        { ...tombstone, body: "Private" },
        { ...tombstone, thread: { ...thread, org_id: other } },
      ],
    },
    {
      call: () =>
        api.restoreMessage(context, conversationId, messageId, conditional),
      wires: [
        tombstone,
        { ...live, id: other },
        { ...live, conversation_id: other },
        { ...live, thread: { ...thread, root_message_id: other } },
      ],
    },
    {
      call: () => api.listRemovedMessages(context, conversationId),
      wires: [
        page([live]),
        page([{ ...tombstone, conversation_id: other }]),
        page([{ ...tombstone, thread: { ...thread, conversation_id: other } }]),
      ],
    },
    {
      call: () =>
        api.setPostingRestrictions(
          context,
          conversationId,
          restrictions,
          conditional,
        ),
      wires: [
        { ...settings, org_id: other },
        { ...settings, scope: { kind: "channel", id: other } },
        { ...settings, scope: { kind: "category", id: conversationId } },
      ],
    },
    {
      call: () => api.previewPurge(context, conversationId),
      wires: [
        { ...preview, org_id: other },
        { ...preview, conversation_id: other },
        { ...preview, impact_digest: "wrong" },
        { ...preview, message_count: -1 },
        { ...preview, rows: [tombstone] },
      ],
    },
    {
      call: () => api.purgeConversation(context, conversationId, purgeRequest),
      wires: [
        { ...purged, org_id: other },
        { ...purged, conversation_id: other },
        { ...purged, purged_message_count: -1 },
        { ...purged, password: "Reflected proof" },
      ],
    },
  ])
    for (const wire of row.wires) {
      const mock = installFetch(() =>
        Response.json(wire, {
          headers: { ETag: etag, "Cache-Control": "private, no-store" },
        }),
      );
      try {
        await expect(row.call()).rejects.toBeInstanceOf(ApiContractError);
      } finally {
        mock.restore();
      }
    }
});

test("moderation refuses unexpected success statuses and missing or weak resource versions", async () => {
  for (const row of calls()) {
    const mock = installFetch(() =>
      Response.json(row.status === 204 ? { id: reportId } : row.wire, {
        status: row.status === 204 ? 200 : 202,
        headers: { ETag: etag, "Cache-Control": "private, no-store" },
      }),
    );
    try {
      await expect(row.invoke()).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
  for (const row of calls().filter((item) =>
    [
      "get report",
      "remove message",
      "restore message",
      "restrict posting",
      "remove reported message",
      "restore reported message",
    ].includes(item.name),
  ))
    for (const tag of [null, 'W/"weak"', "unquoted"]) {
      const mock = installFetch(() =>
        Response.json(row.wire, {
          headers: {
            "Cache-Control": "private, no-store",
            ...(tag === null ? {} : { ETag: tag }),
          },
        }),
      );
      try {
        await expect(row.invoke()).rejects.toBeInstanceOf(ApiContractError);
      } finally {
        mock.restore();
      }
    }
});

test("moderation validates exact protected request conditions before dispatch", async () => {
  const mock = installFetch(() => Response.json({}));
  try {
    const invalidCalls = [
      () => api.listReports({ ...context, org_id: "invalid" }),
      () => api.getReport(context, "invalid"),
      () => api.listMessageRevisions(context, conversationId, "invalid"),
      () => api.listRemovedMessages(context, "invalid"),
      () => api.listReports(context, { limit: 101 }),
      () =>
        api.reportMessage(context, conversationId, messageId, { reason: "  " }),
      () =>
        api.reportMessage(context, conversationId, messageId, {
          reason: "Review",
          reporter_id: other,
        } as { reason: string }),
      () =>
        api.setPostingRestrictions(
          context,
          conversationId,
          { user_ids: [other, other], until: null },
          conditional,
        ),
      () => api.previewPurge(context, "invalid"),
      ...["token", "confirmation_name", "password"].map(
        (key) => () =>
          api.purgeConversation(context, conversationId, {
            ...purgeRequest,
            [key]: "",
          }),
      ),
      () =>
        api.purgeConversation(context, conversationId, {
          ...purgeRequest,
          impact_digest: preview.impact_digest,
        } as typeof purgeRequest),
      ...[{}, { if_match: 'W/"weak"' }, { if_match: "unquoted" }].flatMap(
        (option) => [
          () =>
            api.removeMessage(
              context,
              conversationId,
              messageId,
              option as typeof conditional,
            ),
          () =>
            api.restoreMessage(
              context,
              conversationId,
              messageId,
              option as typeof conditional,
            ),
          () =>
            api.resolveReport(context, reportId, option as typeof conditional),
          () =>
            api.removeReportedMessage(
              context,
              reportId,
              option as typeof conditional,
            ),
          () =>
            api.restoreReportedMessage(
              context,
              reportId,
              option as typeof conditional,
            ),
          () =>
            api.setPostingRestrictions(
              context,
              conversationId,
              restrictions,
              option as typeof conditional,
            ),
        ],
      ),
    ];
    for (const invoke of invalidCalls)
      await expect(invoke()).rejects.toBeInstanceOf(z.ZodError);
    expect(mock.requests).toEqual([]);
  } finally {
    mock.restore();
  }
});

test("report-bound actions require private no-store responses and keep compound validators opaque", async () => {
  for (const action of [
    api.removeReportedMessage,
    api.restoreReportedMessage,
  ]) {
    for (const cache of ["private, no-store", "NO-STORE, PRIVATE"]) {
      const mock = installFetch(() =>
        Response.json(report, {
          headers: { ETag: reportEtag, "Cache-Control": cache },
        }),
      );
      try {
        await expect(
          action(context, reportId, { if_match: reportCondition }),
        ).resolves.toEqual({ data: report, etag: reportEtag });
        expect(
          new Headers(mock.requests[0].init?.headers).get("If-Match"),
        ).toBe(reportCondition);
        expect(mock.requests[0].init?.body).toBeUndefined();
      } finally {
        mock.restore();
      }
    }
    for (const cache of [
      null,
      "private",
      "no-store",
      "public, no-store",
      "private, public, no-store",
    ]) {
      const mock = installFetch(() =>
        Response.json(report, {
          headers: {
            ETag: reportEtag,
            ...(cache === null ? {} : { "Cache-Control": cache }),
          },
        }),
      );
      try {
        await expect(
          action(context, reportId, { if_match: reportCondition }),
        ).rejects.toBeInstanceOf(ApiContractError);
      } finally {
        mock.restore();
      }
    }
  }
});

test("report-bound actions validate identity and preserve server refusals without a fallback source read", async () => {
  for (const action of [
    api.removeReportedMessage,
    api.restoreReportedMessage,
  ]) {
    const invalid = installFetch(() => Response.json({}));
    try {
      await expect(
        action(context, "invalid", conditional),
      ).rejects.toBeInstanceOf(z.ZodError);
      await expect(
        action({ ...context, org_id: "invalid" }, reportId, conditional),
      ).rejects.toBeInstanceOf(z.ZodError);
      expect(invalid.requests).toEqual([]);
    } finally {
      invalid.restore();
    }
    for (const status of [403, 404, 409, 412, 428, 503]) {
      const mock = installFetch(() =>
        Response.json({ detail: { message: "Unavailable" } }, { status }),
      );
      try {
        await expect(
          action(context, reportId, { if_match: reportCondition }),
        ).rejects.toMatchObject({ status });
        expect(mock.requests).toHaveLength(1);
      } finally {
        mock.restore();
      }
    }
  }
});

test("empty posting restrictions clear the set and server refusals stay failures without retries", async () => {
  const cleared = {
    ...settings,
    overrides: {},
    effective: { ...settings.effective, restricted_person_ids: [] },
  };
  const mock = installFetch(() =>
    Response.json(cleared, { headers: { ETag: etag } }),
  );
  try {
    await expect(
      api.setPostingRestrictions(
        context,
        conversationId,
        { user_ids: [], until: null },
        conditional,
      ),
    ).resolves.toEqual({ data: cleared, etag });
    expect(JSON.parse(String(mock.requests[0].init?.body))).toEqual({
      user_ids: [],
      until: null,
    });
  } finally {
    mock.restore();
  }
  for (const status of [403, 404, 409, 412, 428, 503]) {
    const failed = installFetch(() =>
      Response.json(
        { detail: { code: "comms_capability_denied", message: "Unavailable" } },
        { status },
      ),
    );
    try {
      await expect(
        api.purgeConversation(context, conversationId, purgeRequest),
      ).rejects.toMatchObject({ status });
      expect(failed.requests).toHaveLength(1);
    } finally {
      failed.restore();
    }
  }
});
