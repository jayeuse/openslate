import { expect, test } from "@playwright/test";
import { z } from "zod";
import { ApiContractError } from "../../../src/lib/api";
import type * as C from "../../../src/components/systems/comms/contract/types";
import { installFetch } from "../helpers/fake-fetch";
import {
  configuration as api,
  calls,
  context,
  org,
  other,
  conversationId,
  secondConversation,
  etag,
  conditional,
  id,
  historyId,
  identity,
  templateInput,
  template,
  applyInput,
  applyPreview,
  applied,
  scopes,
  snapshot,
  history,
  restorationPreview,
  restoreInput,
  password,
  proof,
} from "./configuration-fixtures";

for (const row of calls())
  test(`configuration transport: ${row.name}`, async () => {
    const signal = new AbortController().signal;
    const action = calls(signal).find((item) => item.name === row.name)!;
    const mock = installFetch(() =>
      row.status === 204
        ? new Response(null, {
            status: 204,
            headers: { "Cache-Control": "private, no-store" },
          })
        : Response.json(row.wire, {
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

test("configuration replies reject foreign resources, captured scopes and proof-bearing DTOs", async () => {
  const scope = scopes[2];
  for (const row of [
    {
      call: () => api.getTemplate(context, id),
      wires: [
        { ...template, id: other },
        { ...template, org_id: other },
        { ...template, password },
      ],
    },
    {
      call: () => api.createTemplate(context, templateInput),
      status: 201,
      location: `/api/comms/templates/${id}`,
      wires: [{ ...template, org_id: other }],
    },
    {
      call: () => api.saveTemplate(context, id, templateInput, conditional),
      wires: [
        { ...template, id: other },
        { ...template, org_id: other },
      ],
    },
    {
      call: () => api.getConfigurationHistory(context, scope, historyId),
      wires: [
        { ...history(scope), org_id: other },
        { ...history(scope), id: other },
        history(scopes[0]),
        { ...history(scope), before: snapshot(scopes[0]) },
      ],
    },
    {
      call: () =>
        api.previewConfigurationRestore(context, scope, historyId, proof),
      wires: [
        { ...restorationPreview(scope), org_id: other },
        { ...restorationPreview(scope), history_id: other },
        restorationPreview(scopes[0]),
        { ...restorationPreview(scope), after: snapshot(scopes[0]) },
        { ...restorationPreview(scope), preview_digest: "wrong" },
      ],
    },
    {
      call: () => api.restoreConfiguration(context, scope, restoreInput, proof),
      wires: [
        snapshot(scopes[0]),
        { ...snapshot(scope), password },
        { ...snapshot(scope), settings: { retention_days: 7 } },
        { ...snapshot(scope), setting_locks: [] },
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

test("configuration collections preserve offsets and reject mixed scope or inconsistent pages", async () => {
  const request = {
    limit: 1,
    offset: 2,
    sort_by: "updated_at",
    sort_order: "desc",
  } as const;
  for (const row of [
    {
      call: () => api.listTemplates(context, request),
      item: template,
      wrong: { ...template, org_id: other },
    },
    {
      call: () => api.listConfigurationHistory(context, scopes[2], request),
      item: history(scopes[2]),
      wrong: history(scopes[0]),
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
        sort_by: "updated_at",
        sort_order: "desc",
      });
      for (const invalid of [
        { ...valid, items: [row.wrong] },
        { ...valid, pagination: { ...valid.pagination, offset: 0 } },
        { ...valid, pagination: { ...valid.pagination, count: 0 } },
        { ...valid, pagination: { ...valid.pagination, has_more: true } },
      ]) {
        wire = invalid;
        await expect(row.call()).rejects.toBeInstanceOf(ApiContractError);
      }
    } finally {
      mock.restore();
    }
  }
});

test("bulk application binds every target and returned classification to the selection, not client lock rules", async () => {
  for (const row of [
    {
      call: () => api.previewTemplateApply(context, id, applyInput),
      wire: applyPreview,
      bad: [
        { items: [] },
        { items: [applyPreview.items[0], applyPreview.items[0]] },
        {
          items: [
            { ...applyPreview.items[0], conversation_id: secondConversation },
          ],
        },
        {
          items: [
            { ...applyPreview.items[0], skipped_locked_keys: ["locked"] },
          ],
        },
        {
          items: [
            {
              ...applyPreview.items[0],
              capabilities: {
                ...applyPreview.items[0].capabilities,
                skipped_locked: ["reply"],
              },
            },
          ],
        },
      ],
    },
    {
      call: () => api.applyTemplate(context, id, applyInput, conditional),
      wire: applied,
      bad: [
        { items: [] },
        { items: [applied.items[0], applied.items[0]] },
        {
          items: [{ ...applied.items[0], conversation_id: secondConversation }],
        },
        { items: [{ ...applied.items[0], applied_keys: ["locked"] }] },
        {
          items: [
            { ...applied.items[0], applied_keys: ["notification_sound"] },
          ],
        },
        { items: [{ ...applied.items[0], applied_capabilities: ["reply"] }] },
        {
          items: [
            { ...applied.items[0], skipped_locked_capabilities: ["react"] },
          ],
        },
      ],
    },
  ]) {
    let wire: unknown = row.wire;
    const mock = installFetch(() =>
      Response.json(wire, {
        headers: { ETag: etag, "Cache-Control": "private, no-store" },
      }),
    );
    try {
      await row.call();
      for (const invalid of row.bad) {
        wire = invalid;
        await expect(row.call()).rejects.toBeInstanceOf(ApiContractError);
      }
    } finally {
      mock.restore();
    }
  }
  // All selected capabilities may be locked. A setting absent from the template
  // need not be classified as applied; do not manufacture an evaluator here.
  const skipped = {
    items: [
      {
        conversation_id: conversationId,
        applied_keys: [],
        skipped_locked_keys: [],
        applied_capabilities: [],
        skipped_locked_capabilities: ["react"],
      },
    ],
  };
  const mock = installFetch(() =>
    Response.json(skipped, {
      headers: { "Cache-Control": "private, no-store" },
    }),
  );
  try {
    await expect(
      api.applyTemplate(
        context,
        id,
        {
          conversation_ids: [conversationId],
          keys: [],
          capability_keys: ["react"],
        },
        conditional,
      ),
    ).resolves.toEqual(skipped);
  } finally {
    mock.restore();
  }
});

test("template create and save enforce 65536 UTF-8 bytes before normalization without changing read tolerance", async () => {
  // The literal minimal object has 43 ASCII bytes excluding description content.
  const exact = {
    name: "T",
    description: "é".repeat(32746) + "x",
    settings: {},
  };
  for (const action of ["create", "save"] as const) {
    const invoke = (input: C.TemplateImport) =>
      action === "create"
        ? api.createTemplate(context, input)
        : api.saveTemplate(context, id, input, conditional);
    const mock = installFetch(() =>
      Response.json(
        { ...identity, ...exact },
        {
          status: action === "create" ? 201 : 200,
          headers: {
            ETag: etag,
            "Cache-Control": "private, no-store",
            Location: `/api/comms/templates/${id}`,
          },
        },
      ),
    );
    try {
      await expect(invoke(exact)).resolves.toEqual({
        data: { ...identity, ...exact },
        etag,
      });
      expect(
        new TextEncoder().encode(String(mock.requests[0].init?.body))
          .byteLength,
      ).toBe(65536);
      const sent = mock.requests.length;
      for (const input of [
        { ...exact, description: exact.description + "x" },
        { name: " ".repeat(65536) + "T", description: "", settings: {} },
        { ...templateInput, settings: { quiet_hours_start: "23:00" } },
      ])
        await expect(invoke(input)).rejects.toBeInstanceOf(z.ZodError);
      expect(mock.requests).toHaveLength(sent);
    } finally {
      mock.restore();
    }
  }
  const stored = { ...template, settings: { quiet_hours_start: "23:00" } };
  const mock = installFetch(() =>
    Response.json(stored, {
      headers: { ETag: etag, "Cache-Control": "private, no-store" },
    }),
  );
  try {
    await expect(api.getTemplate(context, id)).resolves.toEqual({
      data: stored,
      etag,
    });
  } finally {
    mock.restore();
  }
});

test("configuration writes refuse missing validators, proof and malformed target requests before dispatch", async () => {
  const scope = scopes[2];
  const mock = installFetch(() => Response.json({}));
  try {
    const invalid = [
      () => api.getTemplate(context, "invalid"),
      () => api.listTemplates({ ...context, org_id: "invalid" }),
      () => api.listTemplates(context, { limit: 101 }),
      () =>
        api.getConfigurationHistory(
          context,
          { kind: "channel" } as C.SettingsScope,
          historyId,
        ),
      () => api.getConfigurationHistory(context, scope, "invalid"),
      () =>
        api.previewTemplateApply(context, id, {
          conversation_ids: [conversationId, conversationId],
          keys: ["formatting"],
        }),
      () =>
        api.previewTemplateApply(context, id, {
          conversation_ids: [conversationId],
          keys: [],
        }),
      () =>
        api.createTemplate(context, {
          ...templateInput,
          settings: { retention_days: 7 },
        } as C.TemplateImport),
      () =>
        api.previewConfigurationRestore(
          context,
          scope,
          historyId,
          conditional as typeof proof,
        ),
      () =>
        api.restoreConfiguration(context, scope, restoreInput, {
          ...proof,
          password: "",
        }),
      () =>
        api.restoreConfiguration(
          context,
          scope,
          { ...restoreInput, preview_digest: "invalid" },
          proof,
        ),
      () =>
        api.restoreConfiguration(
          context,
          scope,
          { ...restoreInput, password } as typeof restoreInput,
          proof,
        ),
      ...[{}, { if_match: 'W/"weak"' }, { if_match: "*" }].flatMap(
        (options) => [
          () =>
            api.saveTemplate(
              context,
              id,
              templateInput,
              options as typeof conditional,
            ),
          () =>
            api.applyTemplate(
              context,
              id,
              applyInput,
              options as typeof conditional,
            ),
          () =>
            api.previewConfigurationRestore(context, scope, historyId, {
              ...options,
              password,
            } as typeof proof),
          () =>
            api.restoreConfiguration(context, scope, restoreInput, {
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

test("configuration acknowledgments require exact statuses, validators, private headers and create locations", async () => {
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
      ...(row.status !== 204
        ? [
            {
              status: row.status ?? 200,
              headers: {
                ETag: etag,
                "Cache-Control": "public, no-store",
                Location: row.location ?? "",
              },
            },
          ]
        : []),
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

test("protected configuration refusals and cancellation propagate without replay or fallback reads", async () => {
  for (const status of [403, 404, 409, 412, 428, 503]) {
    const mock = installFetch(() =>
      Response.json(
        { detail: { code: "comms_conflict", message: "Unavailable" } },
        { status },
      ),
    );
    try {
      await expect(
        api.applyTemplate(context, id, applyInput, conditional),
      ).rejects.toMatchObject({ status });
      await expect(
        api.restoreConfiguration(context, scopes[2], restoreInput, proof),
      ).rejects.toMatchObject({ status });
      expect(mock.requests).toHaveLength(2);
    } finally {
      mock.restore();
    }
  }
  const aborted = new DOMException("Cancelled", "AbortError");
  const mock = installFetch(() => Promise.reject(aborted));
  try {
    await expect(
      api.previewConfigurationRestore(context, scopes[2], historyId, proof),
    ).rejects.toBe(aborted);
  } finally {
    mock.restore();
  }
});
