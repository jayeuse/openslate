import { expect, test } from "@playwright/test";
import * as api from "../../../src/components/systems/comms/adapters/settings-api";
import type * as C from "../../../src/components/systems/comms/contract/types";
import { DEFAULT_SETTINGS } from "../../../src/components/systems/comms/domain/settings";
import { ApiContractError } from "../../../src/lib/api";
import { installFetch } from "../helpers/fake-fetch";

const org = "00000000-0000-4000-8000-000000000001";
const user = "00000000-0000-4000-8000-000000000002";
const id = "00000000-0000-4000-8000-000000000003";
const other = "00000000-0000-4000-8000-000000000004";
const context = { org_id: org, user_id: user };
const etag = '"settings-2"';
const conditional = { if_match: '"settings-1"' };
const scopes = [
  { kind: "workspace" },
  { kind: "category", id },
  { kind: "channel", id },
] as const;
const workspace = scopes[0];
const configuration = (scope: C.SettingsScope) => ({
  scope,
  group_grants: [],
  everyone: {},
});
function settings(scope: C.SettingsScope) {
  return {
    org_id: org,
    scope,
    overrides: { formatting: false },
    effective: { ...DEFAULT_SETTINGS, formatting: false },
    locked_keys: [],
    sources: Object.fromEntries(
      Object.keys(DEFAULT_SETTINGS).map((key) => [key, { kind: "default" }]),
    ),
    metadata: [],
    ...(scope.kind === "workspace" ? { dm_rule: "everyone" } : {}),
  };
}
const nonreader = {
  org_id: org,
  user_id: user,
  conversation_id: id,
  category_id: null,
  membership_role: "admin",
  conversation_level: "none",
  manager_source: null,
  access_source: { kind: "none", reason: "no_access" },
  capabilities: Object.fromEntries(
    [
      "react",
      "reply",
      "createThread",
      "attachFiles",
      "linkRecords",
      "mentionChannel",
      "pin",
      "manageThreads",
      "deleteOthersMessages",
      "moderate",
      "manageChannel",
      "createChannel",
      "manageWorkspace",
    ].map((key) => [
      key,
      { allowed: false, source: { kind: "access", reason: "no_read_access" } },
    ]),
  ),
};
type Call = {
  name: string;
  call: () => Promise<unknown>;
  path: string;
  method: string;
  wire: object;
  body?: object;
  versioned?: boolean;
  expected?: object;
};
function calls(signal?: AbortSignal): Call[] {
  const options = { signal },
    conditions = { ...conditional, signal };
  const scoped = scopes.flatMap((scope): Call[] => {
    const path =
      scope.kind === "workspace"
        ? "/api/comms/settings/workspace"
        : `/api/comms/settings/${scope.kind}/${scope.id}`;
    return [
      {
        name: `get ${scope.kind} settings`,
        call: () => api.getSettings(context, scope, options),
        path,
        method: "GET",
        wire: settings(scope),
        versioned: true,
      },
      {
        name: `update ${scope.kind} settings`,
        call: () =>
          api.updateSettings(context, scope, { formatting: false }, conditions),
        path,
        method: "PATCH",
        body: { formatting: false },
        wire: settings(scope),
        versioned: true,
      },
      {
        name: `reset ${scope.kind} settings`,
        call: () =>
          api.resetSettings(
            context,
            scope,
            { keys: ["formatting"] },
            conditions,
          ),
        path: `${path}/reset`,
        method: "POST",
        body: { keys: ["formatting"] },
        wire: settings(scope),
        versioned: true,
      },
      {
        name: `get ${scope.kind} grants`,
        call: () => api.getCapabilityConfiguration(context, scope, options),
        path: `${path}/capabilities`,
        method: "GET",
        wire: configuration(scope),
        versioned: true,
      },
      {
        name: `set ${scope.kind} grants`,
        call: () =>
          api.setCapabilityConfiguration(
            context,
            configuration(scope),
            conditions,
          ),
        path: `${path}/capabilities`,
        method: "PUT",
        body: configuration(scope),
        wire: configuration(scope),
        versioned: true,
      },
    ];
  });
  return [
    ...scoped,
    {
      name: "settings locks",
      call: () =>
        api.setSettingsLocks(context, { keys: ["formatting"] }, conditions),
      path: "/api/comms/settings/workspace/locks",
      method: "PUT",
      body: { keys: ["formatting"] },
      wire: { ...settings(workspace), locked_keys: ["formatting"] },
      versioned: true,
    },
    {
      name: "get capability locks",
      call: () => api.getCapabilityLocks(context, options),
      path: "/api/comms/settings/workspace/capability-locks",
      method: "GET",
      wire: { capabilities: ["reply"] },
      versioned: true,
    },
    {
      name: "set capability locks",
      call: () =>
        api.setCapabilityLocks(
          context,
          { capabilities: ["reply"] },
          conditions,
        ),
      path: "/api/comms/settings/workspace/capability-locks",
      method: "PUT",
      body: { capabilities: ["reply"] },
      wire: { capabilities: ["reply"] },
      versioned: true,
    },
    {
      name: "D43 own capabilities",
      call: () => api.getCapabilities(context, id, options),
      path: `/api/comms/conversations/${id}/capabilities`,
      method: "GET",
      wire: nonreader,
    },
    {
      name: "inspect person",
      call: () => api.checkPerson(context, id, other, options),
      path: `/api/comms/conversations/${id}/capabilities/${other}`,
      method: "GET",
      wire: { ...nonreader, user_id: other },
    },
    ...[workspace, scopes[1]].map((scope): Call => ({
      name: `${scope.kind} creation check`,
      call: () => api.getChannelCreationCheck(context, scope, options),
      path: `/api/comms/capabilities/channel-creation?scope_kind=${scope.kind}${scope.kind === "category" ? `&category_id=${scope.id}` : ""}`,
      method: "GET",
      wire: {
        ...context,
        scope,
        membership_role: "guest",
        decision: {
          allowed: true,
          source: {
            kind: "group_grant",
            group_id: other,
            group_name: "Shift",
            scope: workspace,
          },
        },
      },
    })),
    {
      name: "get direct policy projection",
      call: () => api.getDirectPolicy(context, options),
      path: "/api/comms/settings/workspace",
      method: "GET",
      wire: settings(workspace),
      expected: { data: { dm_rule: "everyone" }, etag },
    },
    {
      name: "set direct policy projection",
      call: () => api.setDirectPolicy(context, { dm_rule: "none" }, conditions),
      path: "/api/comms/settings/workspace",
      method: "PATCH",
      body: { dm_rule: "none" },
      wire: { ...settings(workspace), dm_rule: "none" },
      expected: { data: { dm_rule: "none" }, etag },
    },
  ];
}

test("settings reads reject a foreign organization or target scope", async () => {
  for (const wire of [
    { ...settings(workspace), org_id: other },
    settings(scopes[1]),
  ]) {
    const mock = installFetch(() =>
      Response.json(wire, { headers: { ETag: etag } }),
    );
    try {
      await expect(api.getSettings(context, workspace)).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      mock.restore();
    }
  }
});

for (const row of calls())
  test(`settings transport: ${row.name}`, async () => {
    const controller = new AbortController();
    const current = calls(controller.signal).find(
      (value) => value.name === row.name,
    )!;
    const mock = installFetch(() =>
      Response.json(row.wire, { headers: { ETag: etag } }),
    );
    try {
      await expect(current.call()).resolves.toEqual(
        row.expected ?? (row.versioned ? { data: row.wire, etag } : row.wire),
      );
      expect(mock.requests).toHaveLength(1);
      const { input, init } = mock.requests[0];
      expect(String(input)).toBe(row.path);
      expect(init?.method).toBe(row.method);
      expect(init?.signal).toBe(controller.signal);
      expect(init?.credentials).toBe("same-origin");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Org")).toBe(org);
      expect(headers.get("If-Match")).toBe(
        row.method === "GET" ? null : conditional.if_match,
      );
      if (row.body === undefined) expect(init?.body).toBe(undefined);
      else expect(JSON.parse(String(init?.body))).toEqual(row.body);
    } finally {
      mock.restore();
    }
  });

test("settings and capability acknowledgements must match their scope and inspected identity", async () => {
  for (const { call, wire } of [
    {
      call: () =>
        api.updateSettings(
          context,
          scopes[1],
          { formatting: true },
          conditional,
        ),
      wire: settings({ kind: "category", id: other }),
    },
    {
      call: () =>
        api.resetSettings(
          context,
          scopes[2],
          { keys: ["formatting"] },
          conditional,
        ),
      wire: { ...settings(scopes[2]), org_id: other },
    },
    {
      call: () => api.setSettingsLocks(context, { keys: [] }, conditional),
      wire: settings(scopes[1]),
    },
    {
      call: () => api.getCapabilityConfiguration(context, scopes[1]),
      wire: configuration({ kind: "category", id: other }),
    },
    {
      call: () =>
        api.setCapabilityConfiguration(
          context,
          configuration(scopes[2]),
          conditional,
        ),
      wire: configuration(workspace),
    },
    {
      call: () => api.getCapabilities(context, id),
      wire: { ...nonreader, user_id: other },
    },
    {
      call: () => api.checkPerson(context, id, other),
      wire: { ...nonreader, user_id: other, conversation_id: other },
    },
    {
      call: () => api.getChannelCreationCheck(context, scopes[1]),
      wire: {
        ...context,
        scope: { kind: "category", id: other },
        membership_role: "admin",
        decision: { allowed: true, source: { kind: "admin" } },
      },
    },
    {
      call: () => api.getCapabilityLocks(context),
      wire: { capabilities: ["unknown"] },
    },
  ]) {
    const mock = installFetch(() =>
      Response.json(wire, { headers: { ETag: etag } }),
    );
    try {
      await expect(call()).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
});

test("settings transports reject wrong success status, missing validators and malformed responses", async () => {
  for (const row of calls()) {
    const mock = installFetch(() =>
      Response.json(row.wire, { status: 202, headers: { ETag: etag } }),
    );
    try {
      await expect(row.call()).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  }
  for (const wire of [
    { ...settings(workspace), effective: {} },
    { ...settings(workspace), sources: {} },
    { ...settings(workspace), secret: "extra" },
  ]) {
    const mock = installFetch(() =>
      Response.json(wire, { headers: { ETag: etag } }),
    );
    try {
      await expect(api.getSettings(context, workspace)).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      mock.restore();
    }
  }
  const mock = installFetch(() => Response.json({ capabilities: [] }));
  try {
    await expect(
      api.setCapabilityLocks(context, { capabilities: [] }, conditional),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    mock.restore();
  }
});

test("shared settings and grant writes validate requests and require strong preconditions before dispatch", async () => {
  const mock = installFetch(() => Response.json({}));
  try {
    for (const call of [
      () => api.getSettings({ ...context, user_id: "invalid" }, workspace),
      () => api.getSettings(context, { kind: "channel", id: "../outside" }),
      () => api.updateSettings(context, workspace, {}, conditional),
      () => api.resetSettings(context, workspace, { keys: [] }, conditional),
      () =>
        api.setSettingsLocks(
          context,
          { keys: ["formatting", "formatting"] },
          conditional,
        ),
      () =>
        api.setCapabilityConfiguration(
          context,
          {
            scope: workspace,
            everyone: {},
            group_grants: [{ group_id: other, capability: "manageChannel" }],
          },
          conditional,
        ),
      () =>
        api.setCapabilityLocks(
          context,
          { capabilities: ["reply", "reply"] },
          conditional,
        ),
      () =>
        api.updateSettings(
          context,
          workspace,
          { formatting: true },
          { if_match: "" },
        ),
      () =>
        api.resetSettings(
          context,
          workspace,
          { keys: ["formatting"] },
          { if_match: "*" },
        ),
      () =>
        api.setCapabilityConfiguration(context, configuration(workspace), {
          if_match: 'W/"weak"',
        }),
      () => api.setDirectPolicy(context, { dm_rule: "none" }, { if_match: "" }),
      () => api.getCapabilities(context, "invalid"),
      () => api.checkPerson(context, id, "invalid"),
      () =>
        api.getChannelCreationCheck(context, {
          kind: "category",
          id: "invalid",
        }),
    ])
      await expect(call()).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("shared settings propagate stale and missing preconditions without replaying writes", async () => {
  for (const [status, code] of [
    [412, "comms_precondition_failed"],
    [428, "comms_precondition_required"],
  ] as const) {
    const mock = installFetch(() =>
      Response.json(
        { detail: { code, message: "Request refused" } },
        { status },
      ),
    );
    try {
      await expect(
        api.updateSettings(
          context,
          workspace,
          { formatting: false },
          conditional,
        ),
      ).rejects.toMatchObject({ status, code });
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  }
});
