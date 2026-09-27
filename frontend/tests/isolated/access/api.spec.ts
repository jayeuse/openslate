import { expect, test } from "@playwright/test";

import { ApiContractError } from "../../../src/lib/api";
import {
  createAccessGroup,
  applyAccessPolicyRuleBatch,
  checkWorkspaceAccess,
  createAccessPolicyRule,
  createAccessRole,
  createAccessServiceIdentity,
  createAccessUser,
  deleteAccessGroup,
  deleteAccessPolicyRule,
  deleteAccessRole,
  deleteAccessServiceIdentity,
  deleteAccessUser,
  getAccessDefaults,
  getAccessGroup,
  getAccessPolicyRule,
  getAccessRole,
  getAccessServiceIdentity,
  getAccessUser,
  listAccessCapabilities,
  listAccessDepartments,
  listAccessGroups,
  listAccessPolicyRules,
  listAccessRoles,
  listAccessServiceIdentities,
  listAccessUsers,
  listAccessUserSessions,
  previewAccessPolicyRuleBatch,
  restoreAccessServiceIdentity,
  restoreAccessRole,
  restoreAccessUser,
  resendAccessInvitation,
  revokeAccessInvitation,
  revokeAccessUserSession,
  revokeAccessUserSessions,
  updateAccessDefaults,
  updateAccessGroup,
  updateAccessPolicyRule,
  updateAccessRole,
  updateAccessServiceIdentity,
  updateAccessUser,
  type AccessDefaultsPatch,
  type AccessCheckResponse,
  type AccessGroupPatch,
  type AccessServiceIdentityPatch,
  type AccessUserPatch,
} from "../../../src/components/systems/access/state/api";

const userId = "00000000-0000-4000-8000-000000000001";
const roleId = "00000000-0000-4000-8000-000000000002";
const departmentId = "00000000-0000-4000-8000-000000000003";
const sessionId = "00000000-0000-4000-8000-000000000004";
const performedBy = "00000000-0000-4000-8000-000000000005";
const groupId = "00000000-0000-4000-8000-000000000006";
const serviceIdentityId = "00000000-0000-4000-8000-000000000007";
const timestamp = "2026-09-22T00:00:00Z";

const pagination = {
  limit: 25,
  offset: 0,
  count: 1,
  total: 1,
  has_more: false,
};
const user = {
  id: userId,
  email: "ana@example.com",
  username: "ana",
  status: "active",
  role_id: roleId,
  display_name: "Ana Santos",
  identity_kind: "internal",
  job_title: "Operations lead",
  sponsor_user_id: null,
  expires_at: null,
  department_ids: [departmentId],
  primary_department_id: departmentId,
  invitation_sent_at: timestamp,
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: null,
  is_deleted: false,
  performed_by: performedBy,
};
const role = {
  id: roleId,
  role: "operator",
  description: "Runs daily operations.",
  permissions: { "records.read": true, "records.write": true },
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: null,
  is_deleted: false,
  performed_by: performedBy,
};
const session = {
  id: sessionId,
  created_at: timestamp,
  refreshed_at: timestamp,
  expires_at: "2026-10-22T00:00:00Z",
  user_agent: "Mozilla/5.0",
  current: false,
};
const group = {
  id: groupId,
  name: "Finance reviewers",
  description: "Can review finance access.",
  revision: 7,
  member_ids: [userId],
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: null,
  is_deleted: false,
  performed_by: performedBy,
};
const defaults = {
  id: "00000000-0000-4000-8000-000000000008",
  default_role_id: roleId,
  group_ids: [groupId],
  department_ids: [departmentId],
  invitation_expiry_days: 14,
  guest_duration_days: 30,
  service_duration_days: 90,
  default_deny: true,
  require_guest_sponsor: true,
  require_service_owner: true,
  revision: 3,
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: null,
  is_deleted: false,
  performed_by: performedBy,
};
const serviceIdentity = {
  id: serviceIdentityId,
  name: "finance-export",
  purpose: "Exports the daily finance file.",
  owner_id: userId,
  role_id: roleId,
  expires_at: "2026-12-22T00:00:00Z",
  status: "active",
  effective_status: "active",
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: null,
  is_deleted: false,
  performed_by: performedBy,
};
const policyRule = {
  id: "00000000-0000-4000-8000-000000000009",
  subject_kind: "user" as const,
  subject_id: userId,
  scope_kind: "workspace" as const,
  scope_id: null,
  permission_id: "records.read" as const,
  decision: "allow" as const,
  starts_at: null,
  ends_at: null,
  locked: false,
  policy_version: 3,
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: null,
  is_deleted: false,
  performed_by: performedBy,
};
const accessCheck: AccessCheckResponse = {
  principal_kind: "user",
  principal_id: userId,
  permission_id: "records.read",
  scope_kind: "workspace",
  policy_decision: "allow",
  reason: "rule_allow",
  source_rule_id: policyRule.id,
  policy_revision: 3,
  checked_at: timestamp,
  runtime_supported: true,
};

const invalidUserPatch: AccessUserPatch = {
  // @ts-expect-error Sponsor assignments cannot be cleared with null.
  sponsor_user_id: null,
  // @ts-expect-error Department assignments cannot be cleared with null.
  department_ids: null,
};
void invalidUserPatch;

const invalidGroupPatch: AccessGroupPatch = {
  // @ts-expect-error Group fields may be omitted but cannot be null.
  description: null,
};
const invalidDefaultsPatch: AccessDefaultsPatch = {
  // @ts-expect-error Default IDs may be omitted but cannot be null.
  default_role_id: null,
};
const invalidServiceIdentityPatch: AccessServiceIdentityPatch = {
  // @ts-expect-error Service identity fields may be omitted but cannot be null.
  purpose: null,
};
void invalidGroupPatch;
void invalidDefaultsPatch;
void invalidServiceIdentityPatch;

type RecordedRequest = { input: RequestInfo | URL; init?: RequestInit };

test("lists groups and service identities with backend allowlisted query fields", async () => {
  const controller = new AbortController();
  const mock = installFetch((input) =>
    String(input).startsWith("/api/access/groups")
      ? Response.json({ items: [group], pagination })
      : Response.json({ items: [serviceIdentity], pagination }),
  );

  try {
    await expect(
      listAccessGroups({
        limit: 25,
        offset: 10,
        sort_by: "name",
        sort_order: "desc",
        search: "Finance review",
        deleted: "include",
        signal: controller.signal,
      }),
    ).resolves.toEqual({ items: [group], pagination });
    await expect(
      listAccessServiceIdentities({
        sort_by: "expires_at",
        status: "active",
        owner_id: userId,
        role_id: roleId,
      }),
    ).resolves.toEqual({ items: [serviceIdentity], pagination });

    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      "/api/access/groups?limit=25&offset=10&sort_by=name&sort_order=desc&search=Finance+review&deleted=include",
      `/api/access/service-identities?sort_by=expires_at&status=active&owner_id=${userId}&role_id=${roleId}`,
    ]);
    expect(mock.requests[0]?.init).toMatchObject({ cache: "no-store" });
    expect(mock.requests[0]?.init?.signal).toBe(controller.signal);
  } finally {
    mock.restore();
  }
});

test("returns versioned group and defaults reads only when ETags are present", async () => {
  const mock = installFetch((input) => {
    if (String(input).endsWith("/defaults"))
      return Response.json(defaults, { headers: { ETag: '"defaults-3"' } });
    return Response.json(group, { headers: { ETag: '"group-7"' } });
  });

  try {
    await expect(getAccessGroup(groupId)).resolves.toEqual({
      data: group,
      etag: '"group-7"',
    });
    await expect(getAccessDefaults()).resolves.toEqual({
      data: defaults,
      etag: '"defaults-3"',
    });
    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      `/api/access/groups/${groupId}`,
      "/api/access/defaults",
    ]);
    expect(mock.requests[0]?.init).toMatchObject({ cache: "no-store" });
    expect(mock.requests[1]?.init).toMatchObject({ cache: "no-store" });
  } finally {
    mock.restore();
  }

  const missingEtag = installFetch(() => Response.json(group));
  try {
    await expect(getAccessGroup(groupId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    missingEtag.restore();
  }
});

test("resends invitations by email without accepting a caller-supplied password", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "openslate_csrf=invitation-token" },
  });
  const mock = installFetch(() =>
    Response.json({
      user,
      delivery: "email",
    }),
  );

  try {
    await expect(resendAccessInvitation(userId)).resolves.toMatchObject({
      user,
      delivery: "email",
    });
    expect(mock.requests).toHaveLength(1);
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/auth/invitations/${userId}/resend`,
    );
    expect(mock.requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({});
    expect(
      new Headers(mock.requests[0]?.init?.headers).get("X-CSRF-Token"),
    ).toBe("invitation-token");
  } finally {
    mock.restore();
    if (originalDocument)
      Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("revokes an invitation through the CSRF-protected invitation route", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "openslate_csrf=revoke-token" },
  });
  const mock = installFetch(() => new Response(null, { status: 204 }));

  try {
    await expect(revokeAccessInvitation(userId)).resolves.toBeNull();
    expect(mock.requests).toHaveLength(1);
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/auth/invitations/${userId}`,
    );
    expect(mock.requests[0]?.init?.method).toBe("DELETE");
    expect(
      new Headers(mock.requests[0]?.init?.headers).get("X-CSRF-Token"),
    ).toBe("revoke-token");
  } finally {
    mock.restore();
    if (originalDocument)
      Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("conditionally creates, updates, and deletes groups and defaults", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "openslate_csrf=conditional-token" },
  });
  const mock = installFetch((input, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (String(input).endsWith("/defaults"))
      return Response.json(defaults, { headers: { ETag: '"defaults-4"' } });
    return Response.json(group, { headers: { ETag: '"group-8"' } });
  });

  try {
    await expect(
      createAccessGroup({
        name: group.name,
        description: group.description,
        member_ids: [userId],
      }),
    ).resolves.toEqual({ data: group, etag: '"group-8"' });
    await expect(
      updateAccessGroup(groupId, { description: "Updated", etag: '"group-7"' }),
    ).resolves.toEqual({ data: group, etag: '"group-8"' });
    await expect(
      deleteAccessGroup(groupId, { etag: '"group-8"' }),
    ).resolves.toBeNull();
    await expect(
      updateAccessDefaults({ guest_duration_days: 45, etag: '"defaults-3"' }),
    ).resolves.toEqual({ data: defaults, etag: '"defaults-4"' });
    await expect(
      updateAccessGroup(groupId, { etag: " " }),
    ).rejects.toBeInstanceOf(ApiContractError);

    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      ["/api/access/groups", "POST"],
      [`/api/access/groups/${groupId}`, "PATCH"],
      [`/api/access/groups/${groupId}`, "DELETE"],
      ["/api/access/defaults", "PATCH"],
    ]);
    expect(JSON.parse(String(mock.requests[1]?.init?.body))).toEqual({
      description: "Updated",
    });
    expect(JSON.parse(String(mock.requests[3]?.init?.body))).toEqual({
      guest_duration_days: 45,
    });
    for (const request of mock.requests) {
      const headers = new Headers(request.init?.headers);
      expect(headers.get("X-CSRF-Token")).toBe("conditional-token");
    }
    expect(new Headers(mock.requests[1]?.init?.headers).get("If-Match")).toBe(
      '"group-7"',
    );
    expect(new Headers(mock.requests[3]?.init?.headers).get("If-Match")).toBe(
      '"defaults-3"',
    );
  } finally {
    mock.restore();
    if (originalDocument)
      Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("uses secret-free strict service-identity contracts with conditional writes", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "openslate_csrf=service-token" },
  });
  const mock = installFetch((input, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json(serviceIdentity, { headers: { ETag: '"service-5"' } });
  });

  try {
    await expect(getAccessServiceIdentity(serviceIdentityId)).resolves.toEqual({
      data: serviceIdentity,
      etag: '"service-5"',
    });
    await expect(
      createAccessServiceIdentity({
        name: serviceIdentity.name,
        purpose: serviceIdentity.purpose,
        owner_id: userId,
        role_id: roleId,
        expires_at: serviceIdentity.expires_at,
      }),
    ).resolves.toEqual({ data: serviceIdentity, etag: '"service-5"' });
    await expect(
      updateAccessServiceIdentity(serviceIdentityId, {
        status: "disabled",
        etag: '"service-4"',
      }),
    ).resolves.toEqual({ data: serviceIdentity, etag: '"service-5"' });
    await expect(
      restoreAccessServiceIdentity(serviceIdentityId, { etag: '"service-5"' }),
    ).resolves.toEqual({ data: serviceIdentity, etag: '"service-5"' });
    await expect(
      deleteAccessServiceIdentity(serviceIdentityId, { etag: '"service-5"' }),
    ).resolves.toBeNull();

    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      [`/api/access/service-identities/${serviceIdentityId}`, undefined],
      ["/api/access/service-identities", "POST"],
      [`/api/access/service-identities/${serviceIdentityId}`, "PATCH"],
      [`/api/access/service-identities/${serviceIdentityId}/restore`, "POST"],
      [`/api/access/service-identities/${serviceIdentityId}`, "DELETE"],
    ]);
    expect(JSON.parse(String(mock.requests[2]?.init?.body))).toEqual({
      status: "disabled",
    });
    expect(new Headers(mock.requests[2]?.init?.headers).get("If-Match")).toBe(
      '"service-4"',
    );
  } finally {
    mock.restore();
    if (originalDocument)
      Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }

  const invalidStatus = installFetch(() =>
    Response.json({
      items: [{ ...serviceIdentity, effective_status: "unknown" }],
      pagination,
    }),
  );
  try {
    await expect(listAccessServiceIdentities()).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    invalidStatus.restore();
  }

  const secretLeakingResponse = installFetch(() =>
    Response.json({
      items: [{ ...serviceIdentity, secret: "must-not-reach-the-client" }],
      pagination,
    }),
  );
  try {
    await expect(listAccessServiceIdentities()).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    secretLeakingResponse.restore();
  }
});

test("uses strict policy-rule contracts and carries the workspace ETag through preview and apply", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "openslate_csrf=policy-token" },
  });
  const operations = [
    {
      type: "create" as const,
      rule: {
        subject_kind: "user" as const,
        subject_id: userId,
        scope_kind: "workspace" as const,
        scope_id: null,
        permission_id: "records.read" as const,
        decision: "allow" as const,
        starts_at: null,
        ends_at: null,
        locked: false,
      },
    },
  ];
  const preview = {
    base_revision: 3,
    current_revision: 3,
    digest: "a".repeat(64),
    can_apply: true,
    blockers: [],
    counts: { created: 1, updated: 0, deleted: 0, unchanged: 0 },
    affected_principals: 1,
  };
  const mock = installFetch((input, init) => {
    const path = String(input);
    if (path.endsWith("/impact-preview"))
      return Response.json(preview, { headers: { ETag: '"workspace:3"' } });
    if (path.endsWith("/apply"))
      return Response.json(
        {
          base_revision: 3,
          current_revision: 4,
          digest: preview.digest,
          counts: preview.counts,
          affected_principals: 1,
        },
        { headers: { ETag: '"workspace:4"' } },
      );
    if (path.includes("?"))
      return Response.json(
        { items: [policyRule], pagination },
        { headers: { ETag: '"workspace:3"' } },
      );
    if (init?.method === "DELETE")
      return new Response(null, {
        status: 204,
        headers: { ETag: '"workspace:5"' },
      });
    return Response.json(policyRule, { headers: { ETag: '"workspace:3"' } });
  });
  try {
    await expect(
      listAccessPolicyRules({
        subject_kind: "user",
        subject_id: userId,
        scope_kind: "workspace",
        permission_id: "records.read",
        decision: "allow",
        locked: false,
        deleted: "include",
      }),
    ).resolves.toEqual({
      data: { items: [policyRule], pagination },
      etag: '"workspace:3"',
    });
    await expect(getAccessPolicyRule(policyRule.id)).resolves.toEqual({
      data: policyRule,
      etag: '"workspace:3"',
    });
    await expect(createAccessPolicyRule(operations[0].rule)).resolves.toEqual({
      data: policyRule,
      etag: '"workspace:3"',
    });
    await expect(
      updateAccessPolicyRule(policyRule.id, {
        subject_id: null,
        etag: '"workspace:3"',
      }),
    ).resolves.toEqual({ data: policyRule, etag: '"workspace:3"' });
    const previewResult = await previewAccessPolicyRuleBatch({
      base_revision: 3,
      operations,
    });
    await expect(
      applyAccessPolicyRuleBatch({
        base_revision: 3,
        operations,
        digest: previewResult.data.digest,
        etag: previewResult.etag,
      }),
    ).resolves.toMatchObject({
      data: { current_revision: 4, digest: preview.digest },
      etag: '"workspace:4"',
    });
    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      `/api/access/rules?deleted=include&subject_kind=user&subject_id=${userId}&scope_kind=workspace&permission_id=records.read&decision=allow&locked=false`,
      `/api/access/rules/${policyRule.id}`,
      "/api/access/rules",
      `/api/access/rules/${policyRule.id}`,
      "/api/access/rules/impact-preview",
      "/api/access/rules/apply",
    ]);
    const applyRequest = mock.requests[5];
    expect(new Headers(mock.requests[3]?.init?.headers).get("If-Match")).toBe(
      '"workspace:3"',
    );
    expect(JSON.parse(String(applyRequest?.init?.body))).toEqual({
      base_revision: 3,
      operations,
      digest: preview.digest,
    });
    expect(new Headers(applyRequest?.init?.headers).get("If-Match")).toBe(
      '"workspace:3"',
    );
    expect(new Headers(applyRequest?.init?.headers).get("X-CSRF-Token")).toBe(
      "policy-token",
    );
  } finally {
    mock.restore();
    if (originalDocument)
      Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("checks workspace access through the strict CSRF-protected no-store endpoint", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "openslate_csrf=access-check-token" },
  });
  const controller = new AbortController();
  const mock = installFetch(() => Response.json(accessCheck));
  try {
    await expect(
      checkWorkspaceAccess(
        {
          principal_kind: "user",
          principal_id: userId,
          permission_id: "records.read",
          scope_kind: "workspace",
        },
        { signal: controller.signal },
      ),
    ).resolves.toEqual(accessCheck);

    expect(mock.requests).toHaveLength(1);
    expect(String(mock.requests[0]?.input)).toBe("/api/access/checks");
    expect(mock.requests[0]?.init).toMatchObject({
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
    });
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      principal_kind: "user",
      principal_id: userId,
      permission_id: "records.read",
      scope_kind: "workspace",
    });
    expect(
      new Headers(mock.requests[0]?.init?.headers).get("X-CSRF-Token"),
    ).toBe("access-check-token");
  } finally {
    mock.restore();
    if (originalDocument)
      Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("rejects unexpected fields in workspace access check responses", async () => {
  const mock = installFetch(() =>
    Response.json({ ...accessCheck, trace: [{ fabricated: true }] }),
  );
  try {
    await expect(
      checkWorkspaceAccess({
        principal_kind: "user",
        principal_id: userId,
        permission_id: "records.read",
        scope_kind: "workspace",
      }),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    mock.restore();
  }
});

test("rejects malformed policy commands and batch requests before sending them", async () => {
  const mock = installFetch(() => Response.json(policyRule));
  const create = {
    subject_kind: "user",
    subject_id: null,
    scope_kind: "workspace",
    scope_id: null,
    permission_id: "records.read",
    decision: "allow",
    starts_at: null,
    ends_at: null,
    locked: false,
  };
  try {
    expect(() => createAccessPolicyRule(create as never)).toThrow();
    expect(() =>
      updateAccessPolicyRule(policyRule.id, { etag: '"workspace:3"' } as never),
    ).toThrow();
    expect(() =>
      previewAccessPolicyRuleBatch({ base_revision: 3, operations: [] }),
    ).toThrow();
    expect(() =>
      applyAccessPolicyRuleBatch({
        base_revision: 3,
        operations: [{ type: "create", rule: create as never }],
        digest: "not-a-policy-digest",
        etag: '"workspace:3"',
      }),
    ).toThrow();
    expect(mock.requests).toHaveLength(0);
  } finally {
    mock.restore();
  }
});

test("compares rule windows by instant across timezone offsets", async () => {
  const mock = installFetch(() =>
    Response.json(policyRule, { headers: { ETag: '"workspace:3"' } }),
  );
  const valid = {
    subject_kind: "user" as const,
    subject_id: userId,
    scope_kind: "workspace" as const,
    scope_id: null,
    permission_id: "records.read" as const,
    decision: "allow" as const,
    starts_at: "2026-10-01T10:00:00+02:00",
    ends_at: "2026-10-01T09:00:00Z",
    locked: false,
  };

  try {
    await expect(createAccessPolicyRule(valid)).resolves.toMatchObject({
      etag: '"workspace:3"',
    });
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toMatchObject({
      starts_at: "2026-10-01T10:00:00+02:00",
      ends_at: "2026-10-01T09:00:00Z",
    });

    expect(() =>
      createAccessPolicyRule({
        ...valid,
        starts_at: "2026-10-01T09:00:00Z",
        ends_at: "2026-10-01T10:00:00+02:00",
      }),
    ).toThrow();
    expect(mock.requests).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("deletes a policy rule with If-Match and requires the returned revision ETag", async () => {
  const mock = installFetch(
    () =>
      new Response(null, {
        status: 204,
        headers: { ETag: '"workspace:4"' },
      }),
  );
  try {
    await expect(
      deleteAccessPolicyRule(policyRule.id, { etag: '"workspace:3"' }),
    ).resolves.toEqual({ data: null, etag: '"workspace:4"' });
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/access/rules/${policyRule.id}`,
    );
    expect(mock.requests[0]?.init?.method).toBe("DELETE");
    expect(new Headers(mock.requests[0]?.init?.headers).get("If-Match")).toBe(
      '"workspace:3"',
    );
  } finally {
    mock.restore();
  }

  const missingEtag = installFetch(() => new Response(null, { status: 204 }));
  try {
    await expect(
      deleteAccessPolicyRule(policyRule.id, { etag: '"workspace:3"' }),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    missingEtag.restore();
  }
});

function installFetch(
  response: (input: RequestInfo | URL, init?: RequestInit) => Response,
): { requests: RecordedRequest[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return response(input, init);
  };
  return { requests, restore: () => (globalThis.fetch = originalFetch) };
}

test("rejects unexpected fields from the authoritative capability catalog", async () => {
  const mock = installFetch(() =>
    Response.json({
      items: [
        {
          id: "records.read",
          label: "View records",
          description: "View saved records.",
          group: "Records",
          unexpected: true,
        },
      ],
    }),
  );

  try {
    await expect(listAccessCapabilities()).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
});

test("loads capabilities and the standard users page through the same-origin API", async () => {
  const controller = new AbortController();
  const mock = installFetch((input) => {
    const path = String(input);
    if (path === "/api/access/capabilities")
      return Response.json({
        items: [
          {
            id: "records.read",
            label: "View records",
            description: "View saved records.",
            group: "Records",
          },
        ],
      });
    if (path.startsWith("/api/users?"))
      return Response.json({ items: [user], pagination });
    return Response.json(user);
  });

  try {
    await expect(listAccessCapabilities()).resolves.toEqual({
      items: [
        {
          id: "records.read",
          label: "View records",
          description: "View saved records.",
          group: "Records",
        },
      ],
    });
    await expect(
      listAccessUsers({
        limit: 50,
        offset: 10,
        sort_by: "username",
        sort_order: "desc",
        search: "Ana Maria",
        deleted: "include",
        role_id: roleId,
      }),
    ).resolves.toEqual({ items: [user], pagination });
    await expect(
      getAccessUser(userId, { signal: controller.signal }),
    ).resolves.toEqual(user);

    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      "/api/access/capabilities",
      `/api/users?limit=50&offset=10&sort_by=username&sort_order=desc&search=Ana+Maria&deleted=include&role_id=${roleId}`,
      `/api/users/${userId}`,
    ]);
    expect(mock.requests[0]?.init).toMatchObject({ cache: "no-store" });
    expect(mock.requests[2]?.init?.signal).toBe(controller.signal);
  } finally {
    mock.restore();
  }
});

test("accepts nullable invitation-sent timestamps in user responses", async () => {
  const mock = installFetch(() =>
    Response.json({ ...user, invitation_sent_at: null }),
  );

  try {
    await expect(getAccessUser(userId)).resolves.toMatchObject({
      id: userId,
      invitation_sent_at: null,
    });
  } finally {
    mock.restore();
  }
});

test("loads authoritative departments through the strict paginated adapter", async () => {
  const mock = installFetch(() =>
    Response.json({
      items: [
        {
          id: departmentId,
          department_name: "Operations",
          created_at: timestamp,
          updated_at: timestamp,
          deleted_at: null,
          is_deleted: false,
          performed_by: performedBy,
        },
      ],
      pagination,
    }),
  );

  try {
    await expect(
      listAccessDepartments({
        limit: 100,
        offset: 0,
        sort_by: "department_name",
        deleted: "exclude",
      }),
    ).resolves.toMatchObject({
      items: [{ department_name: "Operations" }],
      pagination,
    });
    expect(mock.requests[0]?.input).toBe(
      "/api/departments?limit=100&offset=0&sort_by=department_name&deleted=exclude",
    );
  } finally {
    mock.restore();
  }
});

test("creates, patches, deletes, and restores users while preserving null PATCH fields", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "openslate_csrf=csrf%20token" },
  });
  const controller = new AbortController();
  const mock = installFetch((input, init) => {
    const path = String(input);
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (path.endsWith("/restore")) return Response.json(user);
    if (path === "/api/auth/invitations" && init?.method === "POST")
      return Response.json({
        user,
        delivery: "email",
      });
    return Response.json(user);
  });

  try {
    await expect(
      createAccessUser({
        email: "ana@example.com",
        username: "ana",
        role_id: null,
        display_name: null,
        sponsor_user_id: null,
        expires_at: null,
        department_ids: [departmentId],
      }),
    ).resolves.toMatchObject({
      delivery: "email",
    });
    await expect(
      updateAccessUser(userId, {
        display_name: null,
        job_title: null,
        expires_at: null,
        primary_department_id: null,
        sponsor_user_id: undefined,
        department_ids: undefined,
        signal: controller.signal,
      }),
    ).resolves.toEqual(user);
    await expect(deleteAccessUser(userId)).resolves.toBeNull();
    await expect(restoreAccessUser(userId)).resolves.toEqual(user);

    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      ["/api/auth/invitations", "POST"],
      [`/api/users/${userId}`, "PATCH"],
      [`/api/users/${userId}`, "DELETE"],
      [`/api/users/${userId}/restore`, "POST"],
    ]);
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      email: "ana@example.com",
      username: "ana",
      role_id: null,
      display_name: null,
      sponsor_user_id: null,
      expires_at: null,
      department_ids: [departmentId],
    });
    expect(JSON.parse(String(mock.requests[1]?.init?.body))).toEqual({
      display_name: null,
      job_title: null,
      expires_at: null,
      primary_department_id: null,
    });
    expect(mock.requests[1]?.init?.signal).toBe(controller.signal);
    for (const request of mock.requests) {
      expect(new Headers(request.init?.headers).get("X-CSRF-Token")).toBe(
        "csrf token",
      );
    }
  } finally {
    mock.restore();
    if (originalDocument)
      Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("lists and revokes only the target user's safe session fields", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "openslate_csrf=session-token" },
  });
  const mock = installFetch((_input, init) =>
    init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({ items: [session], pagination }),
  );

  try {
    await expect(
      listAccessUserSessions(userId, {
        limit: 25,
        offset: 25,
        // @ts-expect-error Session lists do not accept lifecycle filters.
        deleted: "exclude",
      }),
    ).resolves.toEqual({ items: [session], pagination });
    await expect(
      revokeAccessUserSession(userId, sessionId),
    ).resolves.toBeNull();
    await expect(revokeAccessUserSessions(userId)).resolves.toBeNull();

    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      [`/api/users/${userId}/sessions?limit=25&offset=25`, undefined],
      [`/api/users/${userId}/sessions/${sessionId}`, "DELETE"],
      [`/api/users/${userId}/sessions`, "DELETE"],
    ]);
    expect(
      new Headers(mock.requests[1]?.init?.headers).get("X-CSRF-Token"),
    ).toBe("session-token");
  } finally {
    mock.restore();
    if (originalDocument)
      Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("lists and mutates roles through strict paginated and detail contracts", async () => {
  const mock = installFetch((input, init) => {
    const path = String(input);
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (path.startsWith("/api/roles?"))
      return Response.json({ items: [role], pagination });
    return Response.json(role);
  });

  try {
    await expect(
      listAccessRoles({
        limit: 25,
        sort_by: "role",
        sort_order: "asc",
        deleted: "only",
      }),
    ).resolves.toEqual({ items: [role], pagination });
    await expect(getAccessRole(roleId)).resolves.toEqual(role);
    await expect(
      createAccessRole({ role: "operator", description: null }),
    ).resolves.toEqual(role);
    await expect(
      updateAccessRole(roleId, { description: null }),
    ).resolves.toEqual(role);
    await expect(deleteAccessRole(roleId)).resolves.toBeNull();
    await expect(restoreAccessRole(roleId)).resolves.toEqual(role);

    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      [
        "/api/roles?limit=25&sort_by=role&sort_order=asc&deleted=only",
        undefined,
      ],
      [`/api/roles/${roleId}`, undefined],
      ["/api/roles", "POST"],
      [`/api/roles/${roleId}`, "PATCH"],
      [`/api/roles/${roleId}`, "DELETE"],
      [`/api/roles/${roleId}/restore`, "POST"],
    ]);
    expect(JSON.parse(String(mock.requests[3]?.init?.body))).toEqual({
      description: null,
    });
  } finally {
    mock.restore();
  }
});

test("rejects camelCase pagination and unrecognized role permissions", async () => {
  const mock = installFetch((input) =>
    String(input).startsWith("/api/users")
      ? Response.json({
          items: [user],
          pagination: { ...pagination, hasMore: false },
        })
      : Response.json({ ...role, permissions: { "unknown.read": true } }),
  );

  try {
    await expect(listAccessUsers()).rejects.toBeInstanceOf(ApiContractError);
    await expect(getAccessRole(roleId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
});
