import { expect, test } from "@playwright/test";
import {
  initialPeople,
  initialRoles,
} from "../../../src/components/systems/access/domain/model";
import {
  initialAccessDefaults,
  initialAccessGroups,
  initialAccessRules,
  initialAccessTemplates,
} from "../../../src/components/systems/access/domain/policy";
import {
  executeAccessCommand,
  getAccessHealth,
  adaptManageSessions,
  projectManageSessions,
  resolveControllerAccess,
  previewBulkIdentityUpdate,
  type AccessControllerSnapshot,
} from "../../../src/components/systems/access/domain/controller-utils";
import {
  readAccessProjection,
  writeAccessProjection,
} from "../../../src/components/systems/access/state/controller";
import { initialManageSessions } from "../../../src/components/systems/manage/state/sessions";
import { decodeSampleStoredValue } from "../../../src/components/systems/shared/runtime/sample-state";
import {
  decodeDashboards,
  decodeReport,
  decodeReports,
  projectAudienceLookup,
} from "../../../src/components/systems/openview/domain/model";
import {
  initialDashboards,
  initialReport,
} from "../../../src/components/systems/openview/domain/seeds";
import type { SampleDraft } from "../../../src/components/systems/shared/runtime/sample-runtime";

const context = {
  now: "2026-09-12T12:00:00.000Z",
  id: (prefix: string) => `${prefix}:generated`,
};

test("OpenView dashboard storage remains migration-tolerant for Access", () => {
  const legacyDashboards = [
    {
      id: "sample-dashboard-operations",
      name: "Operations pulse",
      permission: "Everyone",
      refresh: "Manual",
      widgets: [],
    },
  ];

  expect(
    decodeSampleStoredValue("views-dashboards", legacyDashboards, null),
  ).toBe(legacyDashboards);
});

test("Access OpenView owner writes survive shared storage decoding and round-trip", () => {
  const projection = readAccessProjection((_key, initial) => initial);
  const sourceDashboard = projection.owners.dashboards[0];
  const role = projection.snapshot.roles[0];
  if (!sourceDashboard || !role) throw new Error("Expected OpenView seeds.");
  const dashboard = structuredClone(sourceDashboard);
  dashboard.id = "sample-dashboard-roundtrip";
  dashboard.name = "Round-trip dashboard";
  dashboard.audience = { kind: "role", id: role.id };
  const reportDraft = structuredClone(projection.owners.reportDraft);
  reportDraft.id = "sample-report-roundtrip";
  reportDraft.name = "Round-trip report";
  reportDraft.audience = { kind: "role", id: role.id };
  const reportTemplate = {
    ...structuredClone(reportDraft),
    id: "sample-report-template-roundtrip",
    name: "Round-trip template",
  };
  const owners = {
    ...projection.owners,
    dashboards: [dashboard],
    reportDraft,
    reportTemplates: [reportTemplate],
  };
  const writes = new Map<string, unknown>();
  const draft = {
    update(key: string, _initial: unknown, value: unknown) {
      writes.set(key, value);
    },
  } as unknown as SampleDraft;

  writeAccessProjection(
    draft,
    projection.snapshot,
    owners,
    projection.manageSessions,
  );

  const lookup = projectAudienceLookup(
    projection.snapshot.roles,
    projection.snapshot.people,
  );
  const storedDashboards = decodeSampleStoredValue(
    "views-dashboards",
    writes.get("views-dashboards"),
    initialDashboards,
  );
  const storedReportDraft = decodeSampleStoredValue(
    "views-report-draft",
    writes.get("views-report-draft"),
    initialReport,
  );

  expect(decodeDashboards(storedDashboards, lookup)).toEqual(owners.dashboards);
  expect(decodeReport(storedReportDraft, lookup)).toEqual(owners.reportDraft);
  const storedReportTemplates = decodeSampleStoredValue(
    "views-report-templates",
    writes.get("views-report-templates"),
    [],
  );
  expect(decodeReports(storedReportTemplates, lookup)).toEqual(
    owners.reportTemplates,
  );
});

function snapshot(): AccessControllerSnapshot {
  return {
    people: structuredClone(initialPeople),
    roles: structuredClone(initialRoles),
    guests: [],
    services: [],
    groups: structuredClone(initialAccessGroups),
    rules: structuredClone(initialAccessRules),
    defaults: structuredClone(initialAccessDefaults),
    templates: structuredClone(initialAccessTemplates),
    reviews: [],
    deletedIdentities: [],
    sessions: [
      {
        id: "session:current",
        identityId: "sample-mara",
        label: "Current browser",
        current: true,
        status: "active",
      },
      {
        id: "session:remote",
        identityId: "sample-mara",
        label: "Remote browser",
        current: false,
        status: "active",
      },
    ],
    history: [],
  };
}

test("identity mutations preserve the legacy people projection and the last active administrator", () => {
  const blocked = executeAccessCommand(
    snapshot(),
    {
      type: "set-identity-status",
      identityId: "sample-mara",
      status: "disabled",
    },
    context,
  );
  expect(blocked).toEqual({
    ok: false,
    error: "Keep at least one active internal Administrator.",
  });

  const created = executeAccessCommand(
    snapshot(),
    {
      type: "create-identity",
      input: {
        kind: "internal",
        name: "Ana Dela Cruz",
        email: "ana@example.invalid",
        status: "active",
        roleId: "sample-member",
        groupIds: [],
        departmentIds: ["department:operations"],
        primaryDepartmentId: "department:operations",
        title: "Coordinator",
      },
    },
    context,
  );
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(created.state.people.at(-1)).toMatchObject({
    id: "internal:generated",
    name: "Ana Dela Cruz",
    role: "sample-member",
    active: true,
    departments: ["Operations"],
  });
  expect(created.state.history).toHaveLength(1);
});

test("pending internal invitation status survives the people projection and supports resend then revoke", () => {
  const created = executeAccessCommand(
    snapshot(),
    {
      type: "create-identity",
      input: {
        kind: "internal",
        name: "Pending Person",
        email: "pending@example.invalid",
        status: "pending",
        roleId: "sample-member",
        groupIds: [],
        departmentIds: ["department:operations"],
        primaryDepartmentId: "department:operations",
        title: "Coordinator",
      },
    },
    context,
  );
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(created.state.people.at(-1)).toMatchObject({
    active: false,
    accessStatus: "pending",
  });
  expect(
    decodeSampleStoredValue(
      "access-people",
      created.state.people,
      initialPeople,
    ).at(-1)?.accessStatus,
  ).toBe("pending");

  const resent = executeAccessCommand(
    created.state,
    { type: "resend-invite", identityId: "internal:generated" },
    context,
  );
  expect(resent.ok).toBe(true);
  if (!resent.ok) return;
  expect(resent.state.people.at(-1)?.activity).toContain(
    "Invitation resent; no email sent",
  );

  const revoked = executeAccessCommand(
    resent.state,
    { type: "revoke-invite", identityId: "internal:generated" },
    context,
  );
  expect(revoked.ok).toBe(true);
  if (!revoked.ok) return;
  expect(revoked.state.people.at(-1)?.accessStatus).toBe("revoked");
});

test("multi-slice group membership and session revocation fail closed", () => {
  const state = snapshot();
  state.services.push({
    kind: "service",
    id: "service:reporting",
    name: "Reporting",
    status: "active",
    roleId: "sample-member",
    groupIds: [],
    ownerId: "sample-mara",
    purpose: "Reports",
    expiresAt: "2026-12-31T00:00:00.000Z",
  });
  expect(
    executeAccessCommand(
      state,
      {
        type: "set-group-members",
        groupId: "group:dispatch",
        memberIds: ["service:reporting"],
      },
      context,
    ),
  ).toEqual({ ok: false, error: "Services cannot belong to groups." });

  expect(
    executeAccessCommand(
      state,
      {
        type: "revoke-session",
        identityId: "sample-mara",
        sessionId: "session:current",
      },
      context,
    ),
  ).toEqual({ ok: false, error: "The current session cannot be revoked." });

  const revoked = executeAccessCommand(
    state,
    {
      type: "revoke-session",
      identityId: "sample-mara",
      sessionId: "session:remote",
    },
    context,
  );
  expect(revoked.ok).toBe(true);
  if (!revoked.ok) return;
  expect(revoked.state.sessions[1]).toMatchObject({
    status: "revoked",
    revocation: { kind: "manage-sessions" },
  });
});

test("identity deletion blocks live references and restoration repairs group membership", () => {
  const referenced = snapshot();
  referenced.guests.push({
    kind: "guest",
    id: "guest:dependent",
    name: "Dependent guest",
    email: "dependent@example.invalid",
    status: "active",
    roleId: "sample-member",
    groupIds: [],
    sponsorId: "sample-eli",
    expiresAt: "2026-12-31T00:00:00.000Z",
    invitation: { sentAt: context.now, resendCount: 0 },
  });
  referenced.rules.push({
    id: "rule:eli-records",
    subject: { kind: "identity", id: "sample-eli" },
    scope: { kind: "workspace", id: "workspace" },
    permissionId: "records.read",
    decision: "allow",
  });

  expect(
    executeAccessCommand(
      referenced,
      { type: "delete-identity", identityId: "sample-eli" },
      context,
    ),
  ).toEqual({
    ok: false,
    error:
      "Remove identity policy, sponsor, and owner references before deleting this identity.",
  });

  const restorable = snapshot();
  restorable.people[1].groupIds = ["group:dispatch"];
  restorable.groups[0].memberIds = ["sample-eli"];
  const deleted = executeAccessCommand(
    restorable,
    { type: "delete-identity", identityId: "sample-eli" },
    context,
  );
  expect(deleted.ok).toBe(true);
  if (!deleted.ok) return;
  expect(deleted.state.groups[0].memberIds).not.toContain("sample-eli");

  const restored = executeAccessCommand(
    deleted.state,
    { type: "restore-identity", identityId: "sample-eli" },
    context,
  );
  expect(restored.ok).toBe(true);
  if (!restored.ok) return;
  expect(restored.state.groups[0].memberIds).toContain("sample-eli");
  expect(
    restored.state.people.find((person) => person.id === "sample-eli"),
  ).toMatchObject({ groupIds: ["group:dispatch"] });
});

test("session revocation projects back to the shared manage-sessions source and preserves current sessions", () => {
  const state = snapshot();
  state.sessions = adaptManageSessions(initialManageSessions);
  const result = executeAccessCommand(
    state,
    { type: "revoke-all-sessions", identityId: "sample-mara" },
    context,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(
    projectManageSessions(result.state.sessions, initialManageSessions),
  ).toEqual(initialManageSessions);

  const eliResult = executeAccessCommand(
    state,
    { type: "revoke-all-sessions", identityId: "sample-eli" },
    context,
  );
  expect(eliResult.ok).toBe(true);
  if (!eliResult.ok) return;
  expect(
    projectManageSessions(eliResult.state.sessions, initialManageSessions),
  ).toEqual(
    initialManageSessions.filter(
      (session) => session.personId !== "sample-eli",
    ),
  );
});

test("bulk updates report impact and apply no partial change when they remove the last administrator", () => {
  const state = snapshot();
  const preview = previewBulkIdentityUpdate(state, {
    identityIds: ["sample-mara", "sample-eli"],
    patch: { roleId: "sample-member" },
  });
  expect(preview).toMatchObject({
    ok: false,
    affected: 2,
    blocked: 1,
  });

  const result = executeAccessCommand(
    state,
    {
      type: "bulk-update-identities",
      input: {
        identityIds: ["sample-mara", "sample-eli"],
        patch: { roleId: "sample-member" },
      },
    },
    context,
  );
  expect(result).toEqual({
    ok: false,
    error: "Keep at least one active internal Administrator.",
  });
  expect(state.people.find((person) => person.id === "sample-mara")?.role).toBe(
    "sample-admin",
  );
});

test("bulk add and remove group intent preserves each identity's other memberships and rejects services atomically", () => {
  const state = snapshot();
  state.people[1].groupIds = ["group:finance"];
  const added = executeAccessCommand(
    state,
    {
      type: "bulk-update-identities",
      input: {
        identityIds: ["sample-eli"],
        patch: {},
        addGroupId: "group:dispatch",
      },
    },
    context,
  );
  expect(added.ok).toBe(true);
  if (!added.ok) return;
  expect(added.state.people[1].groupIds).toEqual([
    "group:finance",
    "group:dispatch",
  ]);

  const withService = snapshot();
  withService.services.push({
    kind: "service",
    id: "service:reporting",
    name: "Reporting",
    status: "active",
    roleId: "sample-member",
    groupIds: [],
    ownerId: "sample-mara",
    purpose: "Reports",
    expiresAt: "2026-12-31T00:00:00.000Z",
  });
  const blocked = executeAccessCommand(
    withService,
    {
      type: "bulk-update-identities",
      input: {
        identityIds: ["sample-eli", "service:reporting"],
        patch: {},
        addGroupId: "group:dispatch",
      },
    },
    context,
  );
  expect(blocked).toEqual({
    ok: false,
    error: "One or more identity updates are invalid.",
  });
  expect(withService.people[1].groupIds).toBeUndefined();
});

test("role and rule changes keep legacy grants compatible and protect built-ins", () => {
  const state = snapshot();
  const protectedDelete = executeAccessCommand(
    state,
    { type: "delete-role", roleId: "sample-member" },
    context,
  );
  expect(protectedDelete).toEqual({
    ok: false,
    error: "Built-in roles cannot be deleted.",
  });
  expect(
    executeAccessCommand(
      state,
      {
        type: "update-role",
        roleId: "sample-member",
        patch: { description: "Changed" },
      },
      context,
    ),
  ).toEqual({ ok: false, error: "Built-in roles are immutable." });

  const allowed = executeAccessCommand(
    state,
    {
      type: "upsert-rule",
      rule: {
        id: "rule:member-update",
        subject: { kind: "role", id: "sample-member" },
        scope: { kind: "workspace", id: "workspace" },
        permissionId: "action.update",
        decision: "allow",
      },
    },
    context,
  );
  expect(allowed.ok).toBe(true);
  if (!allowed.ok) return;
  expect(
    allowed.state.roles.find((role) => role.id === "sample-member")?.grants,
  ).toContain("Action · update");
});

test("group metadata and membership save atomically", () => {
  const result = executeAccessCommand(
    snapshot(),
    {
      type: "update-group",
      groupId: "group:dispatch",
      patch: {
        name: "Dispatch team",
        description: "Coordinates dispatch",
        memberIds: ["sample-eli"],
      },
    },
    context,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.state.groups[0]).toMatchObject({
    name: "Dispatch team",
    description: "Coordinates dispatch",
    memberIds: ["sample-eli"],
  });
  expect(
    result.state.people.find((person) => person.id === "sample-eli")?.groupIds,
  ).toContain("group:dispatch");
  expect(result.state.history).toHaveLength(1);
});

test("a staged rule batch persists atomically with one applied restorable history entry", () => {
  const state = snapshot();
  const result = executeAccessCommand(
    state,
    {
      type: "upsert-rules",
      rules: [
        {
          id: "rule:first",
          subject: { kind: "role", id: "sample-member" },
          scope: { kind: "workspace", id: "workspace" },
          permissionId: "action.read",
          decision: "allow",
        },
        {
          id: "rule:second",
          subject: { kind: "role", id: "sample-member" },
          scope: { kind: "workspace", id: "workspace" },
          permissionId: "action.update",
          decision: "deny",
        },
      ],
    },
    context,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.state.rules.map((rule) => rule.id)).toEqual(
    expect.arrayContaining(["rule:first", "rule:second"]),
  );
  expect(result.state.history).toHaveLength(1);
  expect(result.state.history[0]).toMatchObject({
    result: "applied",
    restorable: true,
  });
});

test("resolver uses compatible legacy role grants as an allow baseline", () => {
  const state = snapshot();
  const result = resolveControllerAccess(state, {
    identityId: "sample-eli",
    permissionId: "records.read",
    scopePath: [
      { kind: "workspace", id: "workspace" },
      { kind: "department", id: "department:operations" },
      { kind: "module", id: "module:service-requests" },
    ],
    now: context.now,
  });
  expect(result).toMatchObject({ decision: "allow" });
  expect(result.source?.ruleId).toContain("legacy:sample-member");
});

test("allowed feature actions still fail closed when scoped visibility is denied", () => {
  const state = snapshot();
  state.rules.push({
    id: "rule:workspace-write",
    subject: { kind: "role", id: "sample-member" },
    scope: { kind: "workspace", id: "workspace" },
    permissionId: "records.write",
    decision: "allow",
  });
  const blocked = resolveControllerAccess(state, {
    identityId: "sample-eli",
    permissionId: "records.write",
    scopePath: [{ kind: "workspace", id: "workspace" }],
    now: context.now,
  });
  expect(blocked.decision).toBe("deny");
  expect(blocked.reason).toContain("scope.view");
  expect(blocked.prerequisites).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "required-permission", passed: true }),
      expect.objectContaining({ id: "scope-visibility", passed: false }),
    ]),
  );

  state.rules.push({
    id: "rule:workspace-visible",
    subject: { kind: "role", id: "sample-member" },
    scope: { kind: "workspace", id: "workspace" },
    permissionId: "scope.view",
    decision: "allow",
  });
  const allowed = resolveControllerAccess(state, {
    identityId: "sample-eli",
    permissionId: "records.write",
    scopePath: [{ kind: "workspace", id: "workspace" }],
    now: context.now,
  });
  expect(allowed.decision).toBe("allow");
  expect(allowed.prerequisites).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "required-permission", passed: true }),
      expect.objectContaining({ id: "scope-visibility", passed: true }),
    ]),
  );
});

test("policy imports and history restores change policy configuration only", () => {
  const state = snapshot();
  const text = JSON.stringify({
    version: 1,
    defaults: state.defaults,
    groups: [{ id: "group:new", name: "New group", description: "" }],
    roles: [{ id: "role:new", name: "New role", description: "", grants: [] }],
    rules: [],
    templates: [],
  });
  const imported = executeAccessCommand(
    state,
    { type: "import-policy-bundle", text, mode: "replace" },
    context,
  );
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  expect(imported.state.people).toEqual(state.people);
  expect(imported.state.roles.map((role) => role.id)).toEqual([
    "sample-admin",
    "sample-member",
    "role:new",
  ]);
  expect(imported.state.history.at(-1)?.restorable).toBe(true);
  expect(imported.state.history.at(-1)?.result).toBe("applied");

  const restored = executeAccessCommand(
    imported.state,
    {
      type: "apply-history-restore",
      historyId: imported.state.history.at(-1)?.id ?? "",
    },
    context,
  );
  expect(restored.ok).toBe(true);
  if (!restored.ok) return;
  expect(restored.state.roles).toEqual(state.roles);
  expect(restored.state.people).toEqual(state.people);
  expect(restored.state.history.at(-1)?.result).toBe("restored");
});

test("health reports final-admin risk and detectable equal-priority group conflicts", () => {
  const state = snapshot();
  state.people[1].groupIds = ["group:dispatch", "group:finance"];
  state.groups[0].memberIds = [state.people[1].id];
  state.groups[1].memberIds = [state.people[1].id];
  state.rules.push(
    {
      id: "rule:dispatch-allows",
      subject: { kind: "group", id: "group:dispatch" },
      scope: { kind: "workspace", id: "workspace" },
      permissionId: "records.read",
      decision: "allow",
    },
    {
      id: "rule:finance-denies",
      subject: { kind: "group", id: "group:finance" },
      scope: { kind: "workspace", id: "workspace" },
      permissionId: "records.read",
      decision: "deny",
    },
  );
  const findings = getAccessHealth(state, context.now);
  expect(findings).toContainEqual(
    expect.objectContaining({ kind: "last-admin", severity: "warning" }),
  );
  expect(findings).toContainEqual(
    expect.objectContaining({ kind: "conflict", severity: "warning" }),
  );
});

test("health does not count an expired Administrator as a usable second admin", () => {
  const state = snapshot();
  const durableAdmin = state.people.find(
    (person) => person.role === "sample-admin" && person.active,
  );
  if (!durableAdmin) throw new Error("Expected a seeded Administrator.");
  state.people.push({
    ...structuredClone(durableAdmin),
    id: "expired-second-admin",
    expiresAt: "2000-01-01T00:00:00Z",
  });

  expect(
    getAccessHealth(state, context.now, { adminRoleId: "sample-admin" }),
  ).toContainEqual(
    expect.objectContaining({
      kind: "last-admin",
      title: "Only one active Administrator",
    }),
  );
});

test("sample administrator changes use the operation clock across single and bulk actions", () => {
  const state = snapshot();
  const durableAdmin = state.people.find(
    (person) => person.role === "sample-admin" && person.active,
  );
  if (!durableAdmin) throw new Error("Expected a seeded Administrator.");
  const expiringAdmin = {
    ...structuredClone(durableAdmin),
    id: "expiring-second-admin",
    email: "expiring-second-admin@example.invalid",
    expiresAt: "2026-09-20T00:00:00Z",
  };
  state.people.push(expiringAdmin);

  const demote = executeAccessCommand(
    state,
    {
      type: "update-identity",
      identityId: expiringAdmin.id,
      patch: { roleId: "sample-member" },
    },
    context,
  );
  expect(demote.ok, demote.ok ? "" : demote.error).toBe(true);
  const remove = executeAccessCommand(
    state,
    { type: "delete-identity", identityId: expiringAdmin.id },
    context,
  );
  expect(remove.ok).toBe(true);

  const futureState = snapshot();
  futureState.people.push({
    ...structuredClone(durableAdmin),
    id: "future-expired-admin",
    email: "future-expired-admin@example.invalid",
    expiresAt: "2027-01-01T00:00:00Z",
  });
  const futureContext = { ...context, now: "2030-01-01T00:00:00Z" };
  expect(
    executeAccessCommand(
      futureState,
      {
        type: "update-identity",
        identityId: durableAdmin.id,
        patch: { roleId: "sample-member" },
      },
      futureContext,
    ).ok,
  ).toBe(false);
  expect(
    previewBulkIdentityUpdate(
      futureState,
      {
        identityIds: [durableAdmin.id],
        patch: { roleId: "sample-member" },
      },
      Date.parse(futureContext.now),
    ).ok,
  ).toBe(false);
});

test("reviews require an active Administrator reviewer and block completion while decisions are pending", () => {
  const state = snapshot();
  const input = {
    name: "Quarterly review",
    reviewerId: "sample-eli",
    subjectKind: "role" as const,
    subjectId: "sample-member",
    targetIds: ["sample-eli"],
  };
  expect(
    executeAccessCommand(
      state,
      { type: "create-review-campaign", input },
      context,
    ),
  ).toEqual({
    ok: false,
    error: "Reviews require an active internal Administrator reviewer.",
  });

  const created = executeAccessCommand(
    state,
    {
      type: "create-review-campaign",
      input: { ...input, reviewerId: "sample-mara" },
    },
    context,
  );
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(
    executeAccessCommand(
      created.state,
      { type: "complete-review", reviewId: "review:generated" },
      context,
    ),
  ).toEqual({
    ok: false,
    error: "Resolve every pending decision before completing the review.",
  });
});

test("health findings cover absent admins, expiry, empty access sets, and invalid references", () => {
  const state = snapshot();
  state.people[0].active = false;
  state.roles.push({
    id: "role:empty",
    name: "Empty",
    builtin: false,
    grants: [],
  });
  state.groups.push({
    id: "group:empty",
    name: "Empty",
    description: "",
    memberIds: [],
  });
  state.guests.push({
    kind: "guest",
    id: "guest:expired",
    name: "Expired",
    email: "expired@example.invalid",
    status: "pending",
    roleId: "role:missing",
    groupIds: ["group:missing"],
    sponsorId: "sample-eli",
    expiresAt: "2026-09-01T00:00:00.000Z",
    invitation: { sentAt: "2026-08-25T00:00:00.000Z", resendCount: 0 },
  });
  state.roles[1].grants.push("Unknown grant");

  const kinds = new Set(
    getAccessHealth(state, context.now).map((finding) => finding.kind),
  );
  expect(kinds).toEqual(
    new Set(["last-admin", "expiry", "empty", "invalid-reference"]),
  );
});

test("history remains bounded to the newest 100 local entries", () => {
  let state = snapshot();
  for (let index = 0; index < 105; index += 1) {
    const result = executeAccessCommand(
      state,
      {
        type: "update-defaults",
        patch: { invitationExpiryDays: index + 1 },
      },
      { ...context, id: (prefix) => `${prefix}:${index}` },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    state = result.state;
  }
  expect(state.history).toHaveLength(100);
  expect(state.history[0].id).toBe("history:5");
  expect(state.history.at(-1)?.id).toBe("history:104");
});

test("role and group saves reject a changed reviewed baseline without altering current state", () => {
  const state = snapshot();
  const role = {
    ...state.roles[1],
    id: "role:editable",
    name: "Editable",
    builtin: false,
  };
  state.roles.push(role);
  const roleCommand = {
    type: "update-role" as const,
    roleId: role.id,
    patch: { name: "Submitted role" },
    expected: structuredClone(role),
  };
  role.description = "Changed after review";
  const beforeRole = structuredClone(state);
  const roleResult = executeAccessCommand(state, roleCommand, context);
  expect(roleResult.ok).toBe(false);
  expect(state).toEqual(beforeRole);

  const group = state.groups[0];
  const groupCommand = {
    type: "update-group" as const,
    groupId: group.id,
    patch: { name: "Submitted group" },
    expected: structuredClone(group),
  };
  group.description = "Changed after review";
  const beforeGroup = structuredClone(state);
  const groupResult = executeAccessCommand(state, groupCommand, context);
  expect(groupResult.ok).toBe(false);
  expect(state).toEqual(beforeGroup);
});
