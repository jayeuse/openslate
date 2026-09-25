import { expect, test } from "@playwright/test";
import { ApiError } from "../../../src/lib/api";

import {
  executeAuthoritativeAccessCommand,
  checkAuthoritativeAccess,
  getAuthoritativeAdminRoleId,
  loadAccessControllerSnapshot,
  loadAllAccessUserSessions,
  mapAuthoritativePermissionCatalog,
  runAuthoritativeAccessCommand,
  type AuthoritativeAccessCommandAdapters,
} from "../../../src/components/systems/access/state/controller";
import type { AuthoritativeAccessSnapshot } from "../../../src/components/systems/access/state/authoritative";
import type {
  AccessCheckRequest,
  AccessCheckResponse,
  AccessCapabilityId,
} from "../../../src/components/systems/access/state/api";

const ids = {
  user: "00000000-0000-4000-8000-000000000001",
  role: "00000000-0000-4000-8000-000000000002",
  group: "00000000-0000-4000-8000-000000000003",
  service: "00000000-0000-4000-8000-000000000004",
  adminRole: "00000000-0000-4000-8000-000000000005",
};
const timestamp = "2026-09-23T00:00:00Z";

function snapshot(): AuthoritativeAccessSnapshot {
  return {
    snapshot: {
      people: [
        {
          id: ids.user,
          name: "Mara Santos",
          email: "mara@example.com",
          role: ids.role,
          active: true,
          accessStatus: "active",
          departments: [],
          primary: "",
          title: "Operations lead",
          activity: [],
          groupIds: [ids.group],
        },
      ],
      roles: [
        {
          id: ids.role,
          name: "member",
          builtin: true,
          grants: ["records.read"],
        },
      ],
      guests: [],
      services: [
        {
          kind: "service",
          id: ids.service,
          name: "Daily export",
          status: "active",
          roleId: ids.role,
          groupIds: [],
          ownerId: ids.user,
          purpose: "Exports daily data",
          expiresAt: "2026-12-23T00:00:00Z",
        },
      ],
      groups: [
        {
          id: ids.group,
          name: "Operations",
          description: "",
          memberIds: [ids.user],
        },
      ],
      rules: [],
      defaults: {
        defaultRoleId: ids.role,
        defaultDepartmentIds: [],
        defaultGroupIds: [ids.group],
        invitationExpiryDays: 7,
        guestDurationDays: 30,
        serviceDurationDays: 90,
        defaultDeny: true,
        requireGuestSponsor: true,
        requireServiceOwner: true,
      },
      templates: [],
      reviews: [],
      deletedIdentities: [],
      sessions: [],
      history: [],
      federatedScopes: [],
    },
    versions: {
      defaults: '"defaults-1"',
      groups: { [ids.group]: '"group-1"' },
      services: { [ids.service]: '"service-1"' },
      policy: '"workspace:1"',
      ruleSubjectKinds: {},
    },
    capabilities: [
      {
        id: "records.read",
        label: "View records",
        description: "View saved records.",
        group: "Records",
      },
    ],
    departments: [],
  };
}

function adapters(
  overrides: Partial<AuthoritativeAccessCommandAdapters> = {},
): AuthoritativeAccessCommandAdapters {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected adapter call");
  };
  return {
    createUser: unexpected,
    updateUser: unexpected,
    deleteUser: unexpected,
    resendInvitation: unexpected,
    revokeInvitation: unexpected,
    revokeSession: unexpected,
    revokeAllSessions: unexpected,
    getRole: unexpected,
    createRole: unexpected,
    updateRole: unexpected,
    deleteRole: unexpected,
    createGroup: unexpected,
    updateGroup: unexpected,
    deleteGroup: unexpected,
    updateDefaults: unexpected,
    createService: unexpected,
    updateService: unexpected,
    deleteService: unexpected,
    previewRules: unexpected,
    applyRules: unexpected,
    ...overrides,
  };
}

test("loads only an authoritative snapshot and never substitutes sample data", async () => {
  const expected = snapshot();
  await expect(
    loadAccessControllerSnapshot(undefined, async () => expected),
  ).resolves.toBe(expected);
  await expect(
    loadAccessControllerSnapshot(undefined, async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow("offline");
});

test("maps person and service simulations to the authoritative user/service API", async () => {
  const current = snapshot();
  const requests: unknown[] = [];
  const check = async (
    request: AccessCheckRequest,
  ): Promise<AccessCheckResponse> => {
    requests.push(request);
    return {
      ...request,
      policy_decision: "deny" as const,
      reason: "default_deny" as const,
      source_rule_id: null,
      policy_revision: 1,
      checked_at: timestamp,
      runtime_supported: request.principal_kind === "user",
    };
  };

  await checkAuthoritativeAccess({
    current,
    identityId: ids.user,
    permissionId: "records.read",
    check,
  });
  await checkAuthoritativeAccess({
    current,
    identityId: ids.service,
    permissionId: "records.read",
    check,
  });

  expect(requests).toEqual([
    {
      principal_kind: "user",
      principal_id: ids.user,
      permission_id: "records.read",
      scope_kind: "workspace",
    },
    {
      principal_kind: "service",
      principal_id: ids.service,
      permission_id: "records.read",
      scope_kind: "workspace",
    },
  ]);
});

test("rejects stale identities and mismatched check confirmations", async () => {
  const current = snapshot();
  let calls = 0;
  const check = async (
    request: AccessCheckRequest,
  ): Promise<AccessCheckResponse> => {
    calls += 1;
    return {
      ...request,
      principal_id: ids.service,
      policy_decision: "deny" as const,
      reason: "default_deny" as const,
      source_rule_id: null,
      policy_revision: 1,
      checked_at: timestamp,
      runtime_supported: true,
    };
  };

  await expect(
    checkAuthoritativeAccess({
      current,
      identityId: "missing-identity",
      permissionId: "records.read",
      check,
    }),
  ).rejects.toThrow("selected identity is no longer available");
  await expect(
    checkAuthoritativeAccess({
      current,
      identityId: ids.user,
      permissionId: "records.read",
      check,
    }),
  ).rejects.toThrow("response did not match the request");
  expect(calls).toBe(1);
});

test("keeps API capability IDs in roles and gives controls authoritative labels", () => {
  const current = snapshot();
  expect(current.snapshot.roles[0]?.grants).toEqual(["records.read"]);
  expect(mapAuthoritativePermissionCatalog(current.capabilities)).toEqual([
    {
      id: "records.read",
      name: "View records",
      product: "Sandbox/core",
    },
  ]);
});

test("duplicating Administrator copies its effective grants into a custom role", async () => {
  const current = snapshot();
  const effectivePermissions = {
    "departments.read": true,
    "departments.write": true,
    "modules.read": true,
    "modules.write": true,
    "fields.read": true,
    "fields.write": true,
    "records.read": true,
    "records.write": true,
    "relationships.read": true,
    "relationships.write": true,
  };
  const effectiveGrants = Object.keys(
    effectivePermissions,
  ) as AccessCapabilityId[];
  current.capabilities = effectiveGrants.map((id) => ({
    id,
    label: `Capability ${id}`,
    description: `Access to ${id}.`,
    group: "Access",
  }));
  current.snapshot.roles.push({
    id: ids.adminRole,
    name: "admin",
    description: "Protected administration.",
    builtin: true,
    grants: effectiveGrants,
  });
  const administrator = {
    id: ids.adminRole,
    role: "admin",
    description: "Protected administration.",
    permissions: {},
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  };
  const created: Parameters<
    AuthoritativeAccessCommandAdapters["createRole"]
  >[0][] = [];

  const result = await executeAuthoritativeAccessCommand(
    current,
    { type: "duplicate-role", roleId: ids.adminRole },
    adapters({
      getRole: async () => administrator,
      createRole: async (request) => {
        created.push(request);
        return {
          ...administrator,
          role: request.role,
          permissions: request.permissions ?? {},
        };
      },
    }),
  );

  expect(result).toEqual({ ok: true, summary: "Role duplicated." });
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    role: "admin copy",
    description: "Protected administration.",
  });
  expect(created[0]?.permissions).toEqual(effectivePermissions);
});

test("uses the authoritative administrator role and paginates sessions only on demand", async () => {
  const current = snapshot();
  current.snapshot.roles[0] = {
    ...current.snapshot.roles[0],
    id: "00000000-0000-4000-8000-000000000099",
    name: "admin",
  };
  expect(getAuthoritativeAdminRoleId(current.snapshot)).toBe(
    "00000000-0000-4000-8000-000000000099",
  );
  const sessions = await loadAllAccessUserSessions(
    ids.user,
    async (_userId, options) => {
      const offset = options?.offset ?? 0;
      return {
        items:
          offset === 0
            ? [
                {
                  id: "00000000-0000-4000-8000-000000000010",
                  created_at: timestamp,
                  refreshed_at: timestamp,
                  expires_at: "2026-12-23T00:00:00Z",
                  user_agent: "First device",
                  current: true,
                },
              ]
            : [
                {
                  id: "00000000-0000-4000-8000-000000000011",
                  created_at: timestamp,
                  refreshed_at: timestamp,
                  expires_at: "2026-12-23T00:00:00Z",
                  user_agent: "Second device",
                  current: false,
                },
              ],
        pagination: {
          limit: 100,
          offset,
          count: 1,
          total: 2,
          has_more: offset === 0,
        },
      };
    },
  );
  expect(sessions.map((session) => session.id)).toEqual([
    "00000000-0000-4000-8000-000000000010",
    "00000000-0000-4000-8000-000000000011",
  ]);
});

test("creates an invited identity, reloads after confirmation, and never returns a temporary password", async () => {
  const current = snapshot();
  let request: unknown;
  let reloads = 0;
  const result = await runAuthoritativeAccessCommand({
    current,
    command: {
      type: "create-identity",
      input: {
        kind: "internal",
        name: "Ana Reyes",
        email: "ana.reyes@example.com",
        status: "pending",
        roleId: ids.role,
        groupIds: [ids.group],
        departmentIds: [],
        primaryDepartmentId: "",
        title: "Coordinator",
      },
    },
    adapters: adapters({
      createUser: async (value) => {
        request = value;
        return {
          user: {
            id: "00000000-0000-4000-8000-000000000005",
            email: "ana.reyes@example.com",
            username: "ana-reyes",
            status: "pending",
            role_id: ids.role,
            display_name: "Ana Reyes",
            identity_kind: "internal",
            job_title: "Coordinator",
            sponsor_user_id: null,
            expires_at: null,
            department_ids: [],
            primary_department_id: null,
            invitation_sent_at: timestamp,
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          },
          delivery: "temporary_password",
          temporary_password: "never-return-this-password",
        };
      },
    }),
    reload: async () => {
      reloads += 1;
    },
  });

  expect(result).toEqual({ ok: true, summary: "Invitation created." });
  expect(request).toEqual({
    email: "ana.reyes@example.com",
    username: "ana-reyes",
    role_id: ids.role,
    display_name: "Ana Reyes",
    identity_kind: "internal",
    job_title: "Coordinator",
    department_ids: [],
    primary_department_id: null,
  });
  expect(JSON.stringify(result)).not.toContain("never-return-this-password");
  expect(reloads).toBe(1);
});

test("invites a valid short-local-part email without asking for a username", async () => {
  const usernames: string[] = [];
  const result = await runAuthoritativeAccessCommand({
    current: snapshot(),
    command: {
      type: "create-identity",
      input: {
        kind: "internal",
        name: "Jo Tan",
        email: "jo@example.com",
        status: "pending",
        roleId: ids.role,
        groupIds: [ids.group],
        departmentIds: [],
        primaryDepartmentId: "",
        title: "",
      },
    },
    adapters: adapters({
      createUser: async (request) => {
        usernames.push(request.username);
        return {} as Awaited<
          ReturnType<AuthoritativeAccessCommandAdapters["createUser"]>
        >;
      },
    }),
    reload: async () => {},
  });

  expect(result.ok).toBe(true);
  expect(usernames).toHaveLength(1);
  expect(usernames[0]).toMatch(/^[a-z0-9_-]{3,100}$/);
});

test("recovers from a username collision when two email domains share a local part", async () => {
  const usernames: string[] = [];
  const result = await runAuthoritativeAccessCommand({
    current: snapshot(),
    command: {
      type: "create-identity",
      input: {
        kind: "internal",
        name: "Ana Tan",
        email: "ana@two.example",
        status: "pending",
        roleId: ids.role,
        groupIds: [ids.group],
        departmentIds: [],
        primaryDepartmentId: "",
        title: "",
      },
    },
    adapters: adapters({
      createUser: async (request) => {
        usernames.push(request.username);
        if (usernames.length === 1)
          throw new ApiError(409, "Email or username is already in use");
        return {} as Awaited<
          ReturnType<AuthoritativeAccessCommandAdapters["createUser"]>
        >;
      },
    }),
    reload: async () => {},
  });

  expect(result.ok).toBe(true);
  expect(usernames).toHaveLength(2);
  expect(usernames[0]).not.toBe(usernames[1]);
  expect(usernames[1]).toMatch(/^[a-z0-9_-]{3,100}$/);
});

test("forwards authoritative ETags for service and group writes", async () => {
  const current = snapshot();
  const writes: unknown[] = [];
  const service = await executeAuthoritativeAccessCommand(
    current,
    {
      type: "set-identity-status",
      identityId: ids.service,
      status: "disabled",
    },
    adapters({
      updateService: async (id, value) => {
        writes.push([id, value]);
        return {
          data: {
            id,
            name: "Daily export",
            purpose: "Exports daily data",
            owner_id: ids.user,
            role_id: ids.role,
            expires_at: "2026-12-23T00:00:00Z",
            status: "disabled",
            effective_status: "disabled",
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          },
          etag: '"service-2"',
        };
      },
    }),
  );
  const group = await executeAuthoritativeAccessCommand(
    current,
    { type: "set-group-members", groupId: ids.group, memberIds: [] },
    adapters({
      updateGroup: async (id, value) => {
        writes.push([id, value]);
        return {
          data: {
            id,
            name: "Operations",
            description: "",
            revision: 2,
            member_ids: [],
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          },
          etag: '"group-2"',
        };
      },
    }),
  );

  expect(service.ok).toBe(true);
  expect(group.ok).toBe(true);
  expect(writes).toEqual([
    [ids.service, { status: "disabled", etag: '"service-1"' }],
    [ids.group, { member_ids: [], etag: '"group-1"' }],
  ]);
});

test("refreshes Access after a stale group write and leaves the editor draft to review", async () => {
  let reloads = 0;
  const result = await runAuthoritativeAccessCommand({
    current: snapshot(),
    command: {
      type: "update-group",
      groupId: ids.group,
      patch: { name: "Updated Operations" },
    },
    adapters: adapters({
      updateGroup: async () => {
        throw new ApiError(412, "Resource changed");
      },
    }),
    reload: async () => {
      reloads += 1;
    },
  });

  expect(result).toMatchObject({ ok: false });
  if (!result.ok) expect(result.error).toMatch(/changed.*refresh.*draft/i);
  expect(reloads).toBe(1);
});

test("explains how to resolve a group delete blocked by detailed rules", async () => {
  const result = await runAuthoritativeAccessCommand({
    current: snapshot(),
    command: { type: "delete-group", groupId: ids.group },
    adapters: adapters({
      deleteGroup: async () => {
        throw new ApiError(409, "Group has access rules");
      },
    }),
    reload: async () => undefined,
  });

  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error).toMatch(/Detailed rules.*remove or retarget/i);
});

test("explains a denied initial Access read instead of suggesting another generic retry", async () => {
  await expect(
    loadAccessControllerSnapshot(undefined, async () => {
      throw new ApiError(403, "Forbidden");
    }),
  ).rejects.toThrow(/permission/i);
});

test("revokes a named human session without prefetching every session", async () => {
  let request: unknown;
  const result = await executeAuthoritativeAccessCommand(
    snapshot(),
    {
      type: "revoke-session",
      identityId: ids.user,
      sessionId: "00000000-0000-4000-8000-000000000099",
    },
    adapters({
      revokeSession: async (userId, sessionId, options) => {
        request = [userId, sessionId, options];
        return null;
      },
    }),
  );

  expect(result).toEqual({ ok: true, summary: "Session revoked." });
  expect(request).toEqual([
    ids.user,
    "00000000-0000-4000-8000-000000000099",
    { signal: undefined },
  ]);
});

test("revokes a pending invitation and reloads the authoritative directory", async () => {
  const current = snapshot();
  current.snapshot.people[0] = {
    ...current.snapshot.people[0]!,
    active: false,
    accessStatus: "pending",
  };
  const requests: unknown[] = [];
  let reloads = 0;
  const result = await runAuthoritativeAccessCommand({
    current,
    command: { type: "revoke-invite", identityId: ids.user },
    adapters: adapters({
      revokeInvitation: async (userId, options) => {
        requests.push([userId, options]);
        return null;
      },
    }),
    reload: async () => {
      reloads += 1;
    },
  });

  expect(result).toEqual({ ok: true, summary: "Invitation revoked." });
  expect(requests).toEqual([[ids.user, { signal: undefined }]]);
  expect(reloads).toBe(1);
});

test("allows resending a revoked invitation and refreshes its status", async () => {
  const current = snapshot();
  current.snapshot.people[0] = {
    ...current.snapshot.people[0]!,
    active: false,
    accessStatus: "revoked",
  };
  const requests: unknown[] = [];
  let reloads = 0;
  const result = await runAuthoritativeAccessCommand({
    current,
    command: { type: "resend-invite", identityId: ids.user },
    adapters: adapters({
      resendInvitation: async (userId, options) => {
        requests.push([userId, options]);
        return {
          user: {
            id: ids.user,
            email: "mara@example.com",
            username: "mara",
            status: "pending",
            role_id: ids.role,
            display_name: "Mara Santos",
            identity_kind: "internal",
            job_title: "Operations lead",
            sponsor_user_id: null,
            expires_at: null,
            department_ids: [],
            primary_department_id: null,
            invitation_sent_at: timestamp,
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
            is_deleted: false,
            performed_by: null,
          },
          delivery: "email",
          temporary_password: null,
        };
      },
    }),
    reload: async () => {
      reloads += 1;
    },
  });

  expect(result).toEqual({
    ok: true,
    summary: "Invitation resent by email.",
  });
  expect(requests).toEqual([[ids.user, { signal: undefined }]]);
  expect(reloads).toBe(1);
});

test("does not revoke an invitation that is already revoked", async () => {
  const current = snapshot();
  current.snapshot.people[0] = {
    ...current.snapshot.people[0]!,
    active: false,
    accessStatus: "revoked",
  };
  const result = await executeAuthoritativeAccessCommand(
    current,
    { type: "revoke-invite", identityId: ids.user },
    adapters(),
  );

  expect(result).toEqual({
    ok: false,
    error: "Only pending invitations can be revoked.",
  });
});

test("previews the exact ordered policy operations, then applies with its digest and reloads only after success", async () => {
  const current = snapshot();
  const rule = {
    id: "rule:draft",
    subject: { kind: "identity" as const, id: ids.user },
    scope: { kind: "workspace" as const, id: "workspace" },
    permissionId: "records.read",
    decision: "allow" as const,
  };
  const calls: unknown[] = [];
  let reloads = 0;
  const result = await runAuthoritativeAccessCommand({
    current,
    command: { type: "upsert-rules", rules: [rule] },
    adapters: adapters({
      previewRules: async (request) => {
        calls.push(["preview", request]);
        return {
          data: {
            base_revision: 1,
            current_revision: 1,
            digest: "b".repeat(64),
            can_apply: true,
            blockers: [],
            counts: { created: 1, updated: 0, deleted: 0, unchanged: 0 },
            affected_principals: 1,
          },
          etag: '"workspace:1"',
        };
      },
      applyRules: async (request) => {
        calls.push(["apply", request]);
        return {
          data: {
            base_revision: 1,
            current_revision: 2,
            digest: "b".repeat(64),
            counts: { created: 1, updated: 0, deleted: 0, unchanged: 0 },
            affected_principals: 2,
          },
          etag: '"workspace:2"',
        };
      },
    }),
    reload: async () => {
      reloads += 1;
    },
  });

  expect(result).toEqual({ ok: true, summary: "Policy rules applied." });
  expect(calls).toEqual([
    [
      "preview",
      {
        base_revision: 1,
        operations: [
          {
            type: "create",
            rule: {
              subject_kind: "user",
              subject_id: ids.user,
              scope_kind: "workspace",
              scope_id: null,
              permission_id: "records.read",
              decision: "allow",
              starts_at: null,
              ends_at: null,
              locked: false,
            },
          },
        ],
        signal: undefined,
      },
    ],
    [
      "apply",
      {
        base_revision: 1,
        operations: [
          {
            type: "create",
            rule: {
              subject_kind: "user",
              subject_id: ids.user,
              scope_kind: "workspace",
              scope_id: null,
              permission_id: "records.read",
              decision: "allow",
              starts_at: null,
              ends_at: null,
              locked: false,
            },
          },
        ],
        digest: "b".repeat(64),
        etag: '"workspace:1"',
        signal: undefined,
      },
    ],
  ]);
  expect(reloads).toBe(1);
});

test("a service rule stays a service subject when an existing rule is edited", async () => {
  const current = snapshot();
  const ruleId = "00000000-0000-4000-8000-000000000099";
  current.snapshot.rules = [
    {
      id: ruleId,
      subject: { kind: "identity", id: ids.service },
      scope: { kind: "workspace", id: "workspace" },
      permissionId: "records.read",
      decision: "deny",
    },
  ];
  current.versions.ruleSubjectKinds[ruleId] = "service";
  let operations: unknown;

  const result = await runAuthoritativeAccessCommand({
    current,
    command: {
      type: "upsert-rule",
      rule: { ...current.snapshot.rules[0], decision: "allow" },
    },
    adapters: adapters({
      previewRules: async (request) => {
        operations = request.operations;
        return {
          data: {
            base_revision: 1,
            current_revision: 1,
            digest: "d".repeat(64),
            can_apply: true,
            blockers: [],
            counts: { created: 0, updated: 1, deleted: 0, unchanged: 0 },
            affected_principals: 1,
          },
          etag: '"workspace:1"',
        };
      },
      applyRules: async () => ({
        data: {
          base_revision: 1,
          current_revision: 2,
          digest: "d".repeat(64),
          counts: { created: 0, updated: 1, deleted: 0, unchanged: 0 },
          affected_principals: 1,
        },
        etag: '"workspace:2"',
      }),
    }),
    reload: async () => {},
  });

  expect(result).toEqual({ ok: true, summary: "Policy rules applied." });
  expect(operations).toMatchObject([
    {
      type: "update",
      rule_id: ruleId,
      patch: { subject_kind: "service", subject_id: ids.service },
    },
  ]);
});

test("policy preview must match the loaded base revision before apply", async () => {
  let applies = 0;
  let reloads = 0;
  const result = await runAuthoritativeAccessCommand({
    current: snapshot(),
    command: {
      type: "upsert-rule",
      rule: {
        id: "rule:draft",
        subject: { kind: "identity", id: ids.user },
        scope: { kind: "workspace", id: "workspace" },
        permissionId: "records.read",
        decision: "allow",
      },
    },
    adapters: adapters({
      previewRules: async () => ({
        data: {
          base_revision: 1,
          current_revision: 2,
          digest: "e".repeat(64),
          can_apply: true,
          blockers: [],
          counts: { created: 1, updated: 0, deleted: 0, unchanged: 0 },
          affected_principals: 1,
        },
        etag: '"workspace:2"',
      }),
      applyRules: async () => {
        applies += 1;
        throw new Error("stale preview must not apply");
      },
    }),
    reload: async () => {
      reloads += 1;
    },
  });

  expect(result).toEqual({
    ok: false,
    error: "Policy changed during review. Reload Access and try again.",
  });
  expect(applies).toBe(0);
  expect(reloads).toBe(0);
});

test("inconsistent apply confirmation refreshes state and asks for review", async () => {
  let reloads = 0;
  const result = await runAuthoritativeAccessCommand({
    current: snapshot(),
    command: {
      type: "upsert-rule",
      rule: {
        id: "rule:draft",
        subject: { kind: "identity", id: ids.user },
        scope: { kind: "workspace", id: "workspace" },
        permissionId: "records.read",
        decision: "allow",
      },
    },
    adapters: adapters({
      previewRules: async () => ({
        data: {
          base_revision: 1,
          current_revision: 1,
          digest: "f".repeat(64),
          can_apply: true,
          blockers: [],
          counts: { created: 1, updated: 0, deleted: 0, unchanged: 0 },
          affected_principals: 1,
        },
        etag: '"workspace:1"',
      }),
      applyRules: async () => ({
        data: {
          base_revision: 1,
          current_revision: 5,
          digest: "f".repeat(64),
          counts: { created: 1, updated: 0, deleted: 0, unchanged: 0 },
          affected_principals: 1,
        },
        etag: '"workspace:5"',
      }),
    }),
    reload: async () => {
      reloads += 1;
    },
  });

  expect(result).toEqual({
    ok: false,
    error:
      "Policy response could not be verified. Access was refreshed; review the current rules before trying again.",
  });
  expect(reloads).toBe(1);
});

test("an invalid apply ETag refreshes state and asks for review", async () => {
  let reloads = 0;
  const result = await runAuthoritativeAccessCommand({
    current: snapshot(),
    command: {
      type: "upsert-rule",
      rule: {
        id: "rule:draft",
        subject: { kind: "identity", id: ids.user },
        scope: { kind: "workspace", id: "workspace" },
        permissionId: "records.read",
        decision: "allow",
      },
    },
    adapters: adapters({
      previewRules: async () => ({
        data: {
          base_revision: 1,
          current_revision: 1,
          digest: "g".repeat(64),
          can_apply: true,
          blockers: [],
          counts: { created: 1, updated: 0, deleted: 0, unchanged: 0 },
          affected_principals: 1,
        },
        etag: '"workspace:1"',
      }),
      applyRules: async () => ({
        data: {
          base_revision: 1,
          current_revision: 2,
          digest: "g".repeat(64),
          counts: { created: 1, updated: 0, deleted: 0, unchanged: 0 },
          affected_principals: 1,
        },
        etag: '"workspace:unknown"',
      }),
    }),
    reload: async () => {
      reloads += 1;
    },
  });

  expect(result).toEqual({
    ok: false,
    error:
      "Policy response could not be verified. Access was refreshed; review the current rules before trying again.",
  });
  expect(reloads).toBe(1);
});

test("an ambiguous apply response refreshes state and asks for review", async () => {
  let reloads = 0;
  const result = await runAuthoritativeAccessCommand({
    current: snapshot(),
    command: {
      type: "upsert-rule",
      rule: {
        id: "rule:draft",
        subject: { kind: "identity", id: ids.user },
        scope: { kind: "workspace", id: "workspace" },
        permissionId: "records.read",
        decision: "allow",
      },
    },
    adapters: adapters({
      previewRules: async () => ({
        data: {
          base_revision: 1,
          current_revision: 1,
          digest: "h".repeat(64),
          can_apply: true,
          blockers: [],
          counts: { created: 1, updated: 0, deleted: 0, unchanged: 0 },
          affected_principals: 1,
        },
        etag: '"workspace:1"',
      }),
      applyRules: async () => {
        throw new Error("connection closed before response");
      },
    }),
    reload: async () => {
      reloads += 1;
    },
  });

  expect(result).toEqual({
    ok: false,
    error:
      "Policy change could not be confirmed. Access was refreshed; review the current rules before trying again.",
  });
  expect(reloads).toBe(1);
});

test("failed or unsupported commands do not reload or mutate the snapshot", async () => {
  const current = snapshot();
  const before = structuredClone(current);
  let reloads = 0;
  const failed = await runAuthoritativeAccessCommand({
    current,
    command: {
      type: "update-identity",
      identityId: ids.user,
      patch: { email: "changed@example.com" },
    },
    adapters: adapters(),
    reload: async () => {
      reloads += 1;
    },
  });
  const unsupported = await runAuthoritativeAccessCommand({
    current,
    command: { type: "delete-rule", ruleId: "rule-1" },
    adapters: adapters(),
    reload: async () => {
      reloads += 1;
    },
  });

  expect(failed).toEqual({
    ok: false,
    error: "Email changes are not available yet.",
  });
  expect(unsupported).toEqual({
    ok: false,
    error: "Rule is unavailable. Reload Access and try again.",
  });
  expect(reloads).toBe(0);
  expect(current).toEqual(before);
});

test("policy blockers prevent apply and reload without writing sample state", async () => {
  const current = snapshot();
  const before = structuredClone(current);
  let applies = 0;
  let reloads = 0;
  const result = await runAuthoritativeAccessCommand({
    current,
    command: {
      type: "upsert-rule",
      rule: {
        id: "rule:draft",
        subject: { kind: "identity", id: ids.service },
        scope: { kind: "workspace", id: "workspace" },
        permissionId: "records.read",
        decision: "deny",
      },
    },
    adapters: adapters({
      previewRules: async () => ({
        data: {
          base_revision: 1,
          current_revision: 1,
          digest: "c".repeat(64),
          can_apply: false,
          blockers: [
            {
              operation_index: 0,
              code: "protected_admin",
              message: "Protected administrator access cannot be changed.",
              rule_id: null,
            },
          ],
          counts: { created: 0, updated: 0, deleted: 0, unchanged: 0 },
          affected_principals: 0,
        },
        etag: '"workspace:1"',
      }),
      applyRules: async () => {
        applies += 1;
        throw new Error("apply must not run");
      },
    }),
    reload: async () => {
      reloads += 1;
    },
  });

  expect(result).toEqual({
    ok: false,
    error: "Protected administrator access cannot be changed.",
  });
  expect(applies).toBe(0);
  expect(reloads).toBe(0);
  expect(current).toEqual(before);
});
