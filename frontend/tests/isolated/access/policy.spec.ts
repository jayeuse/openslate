import { expect, test } from "@playwright/test";
import {
  initialAccessGroups,
  initialAccessIdentities,
  resolveEffectiveAccess,
  validateAccessIdentity,
  type AccessIdentity,
  type AccessRule,
  type AccessScopeRef,
} from "../../../src/components/systems/access/domain/policy";
import {
  normalizeLegacyGrant,
  projectLegacyGrants,
} from "../../../src/components/systems/access/adapters/adapters";

const now = "2026-09-12T12:00:00.000Z";
const workspace: AccessScopeRef = { kind: "workspace", id: "workspace" };
const department: AccessScopeRef = {
  kind: "department",
  id: "department:operations",
};
const moduleScope: AccessScopeRef = {
  kind: "module",
  id: "module:service-requests",
};

function internal(
  overrides: Partial<Extract<AccessIdentity, { kind: "internal" }>> = {},
): Extract<AccessIdentity, { kind: "internal" }> {
  return {
    kind: "internal",
    id: "person:eli",
    name: "Eli Cruz",
    email: "eli@example.invalid",
    status: "active",
    roleId: "sample-member",
    groupIds: ["group:dispatch"],
    departmentIds: ["department:operations"],
    primaryDepartmentId: "department:operations",
    title: "Dispatcher",
    ...overrides,
  };
}

function rule(
  id: string,
  decision: AccessRule["decision"],
  subject: AccessRule["subject"],
  scope: AccessRule["scope"] = workspace,
  overrides: Partial<AccessRule> = {},
): AccessRule {
  return {
    id,
    subject,
    scope,
    permissionId: "records.read",
    decision,
    ...overrides,
  };
}

function resolve(identity: AccessIdentity, rules: readonly AccessRule[]) {
  return resolveEffectiveAccess({
    identity,
    permissionId: "records.read",
    scopePath: [workspace, department, moduleScope],
    rules,
    groups: initialAccessGroups,
    knownPermissionIds: ["records.read", "records.write"],
    knownScopeIds: [workspace.id, department.id, moduleScope.id],
    knownRoleIds: ["sample-admin", "sample-member"],
    now,
  });
}

test("inactive lifecycle states and expiry deny before administrator privilege", () => {
  for (const status of [
    "pending",
    "disabled",
    "deleted",
    "revoked",
    "suspended",
  ] as const) {
    const result = resolve(internal({ status, roleId: "sample-admin" }), []);
    expect(result.decision, status).toBe("deny");
    expect(result.reason, status).toContain(status);
    expect(result.prerequisites[0]).toEqual({
      id: "identity-lifecycle",
      label: "Identity lifecycle",
      passed: false,
      reason: `Identity is ${status}.`,
    });
  }

  const expired = resolve(
    internal({
      roleId: "sample-admin",
      expiresAt: "2026-09-12T11:59:59.000Z",
    }),
    [],
  );
  expect(expired.decision).toBe("deny");
  expect(expired.prerequisites[1]).toMatchObject({
    id: "identity-expiry",
    passed: false,
    reason: "Identity access is expired.",
  });
  const administrator = resolve(internal({ roleId: "sample-admin" }), []);
  expect(administrator.decision).toBe("allow");
  expect(administrator.prerequisites.map((item) => item.passed)).toEqual([
    true,
    true,
    true,
    true,
    true,
  ]);
});

test("the most specific scope wins, then identity outranks group, role, and everyone", () => {
  const identity = internal();
  const rules = [
    rule("everyone-module", "deny", { kind: "everyone" }, moduleScope),
    rule(
      "role-module",
      "allow",
      {
        kind: "role",
        id: "sample-member",
      },
      moduleScope,
    ),
    rule(
      "group-module",
      "deny",
      {
        kind: "group",
        id: "group:dispatch",
      },
      moduleScope,
    ),
    rule(
      "identity-department",
      "deny",
      {
        kind: "identity",
        id: identity.id,
      },
      department,
    ),
    rule(
      "identity-module",
      "allow",
      {
        kind: "identity",
        id: identity.id,
      },
      moduleScope,
    ),
  ];

  const result = resolve(identity, rules);
  expect(result.decision).toBe("allow");
  expect(result.source?.ruleId).toBe("identity-module");
  expect(result.prerequisites.map((item) => item.id)).toEqual([
    "identity-lifecycle",
    "identity-expiry",
    "known-role",
    "known-permission",
    "known-scope-path",
  ]);
  expect(
    result.trace.find((item) => item.ruleId === "identity-module"),
  ).toMatchObject({
    subject: { kind: "identity", id: identity.id },
    scope: moduleScope,
    scopeSpecificity: 2,
    subjectPriority: 3,
    selected: true,
    reason: "Selected by scope and subject precedence.",
  });
  expect(
    result.trace.find((item) => item.ruleId === "everyone-module"),
  ).toMatchObject({
    selected: false,
    overriddenByRuleId: "identity-module",
    reason: "Overridden by identity-module.",
  });
});

test("equal-priority group conflicts deny", () => {
  const identity = internal({ groupIds: ["group:dispatch", "group:finance"] });
  const result = resolve(identity, [
    rule(
      "dispatch-allows",
      "allow",
      {
        kind: "group",
        id: "group:dispatch",
      },
      moduleScope,
    ),
    rule(
      "finance-denies",
      "deny",
      {
        kind: "group",
        id: "group:finance",
      },
      moduleScope,
    ),
  ]);

  expect(result.decision).toBe("deny");
  expect(result.reason).toContain("group conflict");
});

test("a locked ancestor decision wins over a more-specific descendant", () => {
  const identity = internal();
  const result = resolve(identity, [
    rule("workspace-lock", "deny", { kind: "everyone" }, workspace, {
      locked: true,
    }),
    rule(
      "module-allow",
      "allow",
      {
        kind: "identity",
        id: identity.id,
      },
      moduleScope,
    ),
  ]);

  expect(result.decision).toBe("deny");
  expect(result.source).toMatchObject({
    ruleId: "workspace-lock",
    locked: true,
  });
  expect(
    result.trace.find((item) => item.ruleId === "module-allow"),
  ).toMatchObject({
    scopeSpecificity: 2,
    selected: false,
    overriddenByRuleId: "workspace-lock",
    reason: "Overridden by locked ancestor workspace-lock.",
  });
});

test("inherit and out-of-window rules remain in the trace but do not decide", () => {
  const identity = internal();
  const result = resolve(identity, [
    rule(
      "inherits",
      "inherit",
      { kind: "identity", id: identity.id },
      moduleScope,
    ),
    rule(
      "expired",
      "allow",
      { kind: "identity", id: identity.id },
      moduleScope,
      {
        endsAt: "2026-09-12T11:59:59.000Z",
      },
    ),
    rule(
      "future",
      "allow",
      { kind: "identity", id: identity.id },
      moduleScope,
      {
        startsAt: "2026-09-12T12:00:01.000Z",
      },
    ),
  ]);

  expect(result.decision).toBe("deny");
  expect(result.reason).toContain("default deny");
  expect(result.trace.map((entry) => entry.outcome)).toEqual([
    "inherit",
    "expired",
    "not-started",
  ]);
});

test("rules on known sibling scopes are ignored without invalidating the policy", () => {
  const sibling = { kind: "department" as const, id: "department:finance" };
  const identity = internal();
  const result = resolveEffectiveAccess({
    identity,
    permissionId: "records.read",
    scopePath: [workspace, department],
    rules: [
      rule("workspace-allow", "allow", { kind: "role", id: "sample-member" }),
      rule(
        "sibling-deny",
        "deny",
        { kind: "role", id: "sample-member" },
        sibling,
      ),
    ],
    groups: initialAccessGroups,
    knownPermissionIds: ["records.read"],
    knownScopeIds: [workspace.id, department.id, sibling.id],
    knownRoleIds: ["sample-member"],
    now,
  });

  expect(result.decision).toBe("allow");
  expect(result.invalid).toBeUndefined();
  expect(result.trace).toContainEqual(
    expect.objectContaining({
      ruleId: "sibling-deny",
      outcome: "not-applicable",
    }),
  );
});

test("unknown permissions, scopes, subjects, and absent grants fail closed", () => {
  const identity = internal();
  expect(resolve(identity, []).decision).toBe("deny");

  const unknownPermission = resolveEffectiveAccess({
    identity,
    permissionId: "records.purge",
    scopePath: [workspace],
    rules: [],
    groups: initialAccessGroups,
    knownPermissionIds: ["records.read"],
    knownScopeIds: [workspace.id],
    knownRoleIds: ["sample-member"],
    now,
  });
  expect(unknownPermission).toMatchObject({ decision: "deny", invalid: true });
  expect(unknownPermission.prerequisites[3]).toMatchObject({
    id: "known-permission",
    passed: false,
    reason: "Permission records.purge is unknown.",
  });
  expect(
    resolveEffectiveAccess({
      identity: internal({ roleId: "sample-admin" }),
      permissionId: "records.purge",
      scopePath: [workspace],
      rules: [],
      groups: initialAccessGroups,
      knownPermissionIds: ["records.read"],
      knownScopeIds: [workspace.id],
      knownRoleIds: ["sample-admin", "sample-member"],
      now,
    }),
  ).toMatchObject({ decision: "deny", invalid: true });

  const unknownSubject = resolve(identity, [
    rule("ghost-role", "allow", { kind: "role", id: "role:ghost" }),
  ]);
  expect(unknownSubject).toMatchObject({ decision: "deny", invalid: true });
});

test("write permission remains independent from read permission", () => {
  const identity = internal();
  const write = resolveEffectiveAccess({
    identity,
    permissionId: "records.write",
    scopePath: [workspace],
    rules: [
      {
        ...rule("read-only", "allow", { kind: "identity", id: identity.id }),
        permissionId: "records.read",
      },
    ],
    groups: initialAccessGroups,
    knownPermissionIds: ["records.read", "records.write"],
    knownScopeIds: [workspace.id],
    knownRoleIds: ["sample-member"],
    now,
  });
  expect(write.decision).toBe("deny");
});

test("guest and service constraints reject privileged or unsafe identities", () => {
  const guest: AccessIdentity = {
    kind: "guest",
    id: "guest:vendor",
    name: "Vendor guest",
    email: "",
    status: "active",
    roleId: "sample-admin",
    groupIds: [],
    sponsorId: "",
    expiresAt: "",
  };
  expect(validateAccessIdentity(guest).issues).toEqual(
    expect.arrayContaining([
      "Guests require an internal sponsor.",
      "Guests require an email.",
      "Guests require an expiry.",
      "Guests cannot be administrators.",
    ]),
  );

  const service: AccessIdentity = {
    kind: "service",
    id: "service:sync",
    name: "Sync service",
    status: "active",
    roleId: "sample-admin",
    groupIds: ["group:dispatch"],
    ownerId: "",
    purpose: "",
    expiresAt: "",
    credentialState: "not-created",
  };
  expect(validateAccessIdentity(service).issues).toEqual(
    expect.arrayContaining([
      "Services require an internal owner.",
      "Services require a purpose.",
      "Services require an expiry.",
      "Services cannot be administrators.",
      "Services cannot belong to groups.",
    ]),
  );
  expect(JSON.stringify(initialAccessIdentities)).not.toMatch(
    /token|secret|password|apiKey/i,
  );
});

test("legacy department, module, action, board, and field grants normalize and project", () => {
  const grants = [
    "Department · Operations",
    "Module · Service requests",
    "Action · read",
    "Board · Operations",
    "Field · Customer email",
  ];
  expect(grants.map(normalizeLegacyGrant)).toEqual([
    {
      legacyGrant: grants[0],
      scope: { kind: "department", id: "department:operations" },
      permissionId: "scope.view",
    },
    {
      legacyGrant: grants[1],
      scope: { kind: "module", id: "module:service-requests" },
      permissionId: "scope.view",
    },
    {
      legacyGrant: grants[2],
      scope: { kind: "workspace", id: "workspace" },
      permissionId: "action.read",
    },
    {
      legacyGrant: grants[3],
      scope: { kind: "board", id: "board:operations" },
      permissionId: "boards.view",
    },
    {
      legacyGrant: grants[4],
      scope: { kind: "field", id: "field:customer-email" },
      permissionId: "scope.view",
    },
  ]);
  expect(projectLegacyGrants(grants.map(normalizeLegacyGrant))).toEqual(grants);
  expect(normalizeLegacyGrant("Unknown · unsafe")).toBeNull();
});
