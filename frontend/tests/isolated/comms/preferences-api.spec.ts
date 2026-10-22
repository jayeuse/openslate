import { expect, test } from "@playwright/test";
import * as api from "../../../src/components/systems/comms/adapters/preferences-api";
import { ApiContractError } from "../../../src/lib/api";
import { installFetch } from "../helpers/fake-fetch";

const context = {
  org_id: "00000000-0000-4000-8000-000000000001",
  user_id: "00000000-0000-4000-8000-000000000002",
};
const id = "00000000-0000-4000-8000-000000000003";
const etag = '"preferences-2"';
const personal = {
  density: "comfortable" as const,
  text_size: "medium" as const,
  timestamps: "time" as const,
  group_messages: true,
  avatars: true,
  previews: true,
  send_shortcut: "enter" as const,
  shortcuts: { search: "Alt+F", new_message: "Alt+N" },
  channel_width: 240,
  member_width: 220,
  thread_width: 380,
  notifications: { notification_sound: false },
};
const member = {
  notify: "all",
  mute: { kind: "off" },
  starred: true,
  hidden: false,
  manual_unread: false,
};
const category = { collapsed: true, mute: { kind: "off" as const } };

function calls(signal?: AbortSignal) {
  // Source compatibility only: a legacy validator is ignored, never sent or evaluated.
  const options = { signal, if_match: "not-a-validator" };
  return [
    {
      call: () => api.getPersonalPreferences(context, options),
      method: "GET",
      path: "/api/comms/preferences",
      body: undefined,
      wire: personal,
    },
    {
      call: () => api.setPersonalPreferences(context, personal, options),
      method: "PUT",
      path: "/api/comms/preferences",
      body: personal,
      wire: personal,
    },
    {
      call: () => api.getMemberPreferences(context, id, options),
      method: "GET",
      path: `/api/comms/conversations/${id}/preferences`,
      body: undefined,
      wire: member,
    },
    {
      call: () =>
        api.updateMemberPreferences(context, id, { starred: true }, options),
      method: "PATCH",
      path: `/api/comms/conversations/${id}/preferences`,
      body: { starred: true },
      wire: member,
    },
    {
      call: () => api.getCategoryPreferences(context, id, options),
      method: "GET",
      path: `/api/comms/categories/${id}/preferences`,
      body: undefined,
      wire: category,
    },
    {
      call: () => api.setCategoryPreferences(context, id, category, options),
      method: "PUT",
      path: `/api/comms/categories/${id}/preferences`,
      body: category,
      wire: category,
    },
  ];
}

test("preference transports use current actor paths and never require or send If-Match", async () => {
  const controller = new AbortController();
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "openslate_csrf=preferences-test" },
  });
  try {
    for (const row of calls(controller.signal)) {
      const mock = installFetch(() =>
        Response.json(row.wire, { headers: { ETag: etag } }),
      );
      try {
        await expect(row.call()).resolves.toEqual({ data: row.wire, etag });
        expect(mock.requests).toHaveLength(1);
        const { input, init } = mock.requests[0];
        expect(String(input)).toBe(row.path);
        expect(init?.method).toBe(row.method);
        expect(init?.signal).toBe(controller.signal);
        expect(init?.credentials).toBe("same-origin");
        expect(init?.cache).toBe("no-store");
        const headers = new Headers(init?.headers);
        expect(headers.get("X-Org")).toBe(context.org_id);
        expect(headers.has("If-Match")).toBe(false);
        if (row.body === undefined) expect(init?.body).toBe(undefined);
        else {
          expect(JSON.parse(String(init?.body))).toEqual(row.body);
          expect(headers.get("X-CSRF-Token")).toBe("preferences-test");
        }
      } finally {
        mock.restore();
      }
    }
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("preference response status must be 200, not an invented create", async () => {
  const mock = installFetch(() =>
    Response.json(personal, { status: 201, headers: { ETag: etag } }),
  );
  try {
    await expect(api.getPersonalPreferences(context)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
});

test("preference responses retain strict shapes and required response validators", async () => {
  for (const row of calls()) {
    const invalidResponses: { body: unknown; headers: HeadersInit }[] = [
      { body: row.wire, headers: {} },
      { body: row.wire, headers: { ETag: 'W/"weak"' } },
      {
        body: { ...row.wire, user_id: context.user_id },
        headers: { ETag: etag },
      },
    ];
    for (const bad of invalidResponses) {
      const mock = installFetch(() =>
        Response.json(bad.body, { headers: bad.headers }),
      );
      try {
        await expect(row.call()).rejects.toBeInstanceOf(ApiContractError);
      } finally {
        mock.restore();
      }
    }
  }
});

test("preference request validation rejects invalid context, identity and patch before dispatch", async () => {
  const mock = installFetch(() => Response.json(personal));
  try {
    for (const call of [
      () => api.getPersonalPreferences({ ...context, org_id: "invalid" }),
      () => api.getMemberPreferences(context, "../other"),
      () => api.getCategoryPreferences(context, "invalid"),
      () => api.updateMemberPreferences(context, id, {}),
      () =>
        api.setPersonalPreferences(context, {
          ...personal,
          notifications: { quiet_hours_start: "22:00" },
        }),
      () => api.setCategoryPreferences(context, "invalid", category),
    ])
      await expect(call()).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("preference refusals and cancellation are propagated without a successful fallback", async () => {
  const mock = installFetch(() =>
    Response.json(
      { detail: { code: "comms_unavailable", message: "Unavailable" } },
      { status: 503 },
    ),
  );
  try {
    await expect(
      api.updateMemberPreferences(context, id, { starred: true }),
    ).rejects.toMatchObject({ status: 503, code: "comms_unavailable" });
    expect(mock.requests).toHaveLength(1);
  } finally {
    mock.restore();
  }
  const error = new DOMException("Cancelled", "AbortError");
  const aborted = installFetch(() => Promise.reject(error));
  try {
    await expect(api.getCategoryPreferences(context, id)).rejects.toBe(error);
  } finally {
    aborted.restore();
  }
});
