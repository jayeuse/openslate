import { expect, test } from "@playwright/test";
import {
  initialRoles,
  type Role,
} from "../../../src/components/sample/access/model";
import {
  createCommsConfiguration,
  normalizeCommsConfiguration,
} from "../../../src/components/sample/comms/configuration";
import {
  CATEGORIES,
  CHANNELS,
} from "../../../src/components/sample/comms/model";
import { initialBoards } from "../../../src/components/sample/boards";
import {
  initialDashboards,
  initialReport,
} from "../../../src/components/sample/openview/analytics";
import {
  executeFederatedAccessCommand,
  federatedRoleReferences,
  getFederatedAccess,
  projectFederatedRoleChange,
  writeFederatedDecision,
  type FederatedAccessOwners,
} from "../../../src/components/sample/access/federated-adapters";
import type { AccessControllerSnapshot } from "../../../src/components/sample/access/controller-utils";
import { getAccessHealth } from "../../../src/components/sample/access/controller-utils";
import {
  initialAccessDefaults,
  initialAccessGroups,
  initialAccessTemplates,
} from "../../../src/components/sample/access/policy";
import { initialPeople } from "../../../src/components/sample/access/model";

const customRole: Role = {
  id: "role:dispatch",
  name: "Dispatch",
  builtin: false,
  grants: [],
};

function owners(): FederatedAccessOwners {
  const commsConfiguration = createCommsConfiguration();
  commsConfiguration.channels[CHANNELS[0].id] = {
    settings: {},
    permissions: {},
  };
  return {
    boards: structuredClone(initialBoards),
    announcements: [
      {
        id: "announcement:dispatch",
        title: "Dispatch briefing",
        body: "Review the active route plan.",
        audience: `Role: ${customRole.name}`,
        expires: "",
        pinned: true,
      },
    ],
    savedViews: [
      {
        id: "saved:dispatch",
        name: "Dispatch queue",
        audience: `Role: ${customRole.name}`,
        type: "Table",
        search: "",
        status: "All statuses",
        sort: "title",
        group: "None",
      },
    ],
    dashboards: [
      {
        ...structuredClone(initialDashboards[0]),
        permission: customRole.name,
        widgets: initialDashboards[0].widgets.map((widget) => ({
          ...widget,
          permission: customRole.name,
        })),
      },
    ],
    reportDraft: {
      ...structuredClone(initialReport),
      audience: `Role: ${customRole.name}`,
    },
    reportTemplates: [
      {
        ...structuredClone(initialReport),
        name: "Dispatch",
        audience: `Role: ${customRole.name}`,
      },
    ],
    commsConfiguration,
    commsCategories: structuredClone(CATEGORIES),
    commsChannels: structuredClone(CHANNELS),
  };
}

test("role rename updates every label owner while preserving stable OpenComms role ids", () => {
  const before = owners();
  before.boards[0].roles.push(customRole.name);
  before.boards[0].widgets[0].permission = customRole.name;
  before.commsConfiguration.channels[CHANNELS[0].id].permissions[
    `role:${customRole.id}`
  ] = { post: "allow" };

  expect(federatedRoleReferences(before, customRole)).toEqual(
    expect.arrayContaining([
      "boards-list",
      "boards-announcements",
      "views-saved",
      "views-dashboards",
      "views-report-draft",
      "views-report-templates",
      "comms-configuration",
    ]),
  );
  expect(
    getFederatedAccess(before, [...initialRoles, customRole]).findings.filter(
      (finding) => finding.id.includes(":audience:"),
    ),
  ).toEqual([]);

  const projected = projectFederatedRoleChange(before, customRole, {
    ...customRole,
    name: "Field Dispatch",
  });

  expect(projected.boards[0].roles).toContain("Field Dispatch");
  expect(projected.boards[0].widgets[0].permission).toBe("Field Dispatch");
  expect(projected.announcements[0].audience).toBe("Role: Field Dispatch");
  expect(projected.savedViews[0].audience).toBe("Role: Field Dispatch");
  expect(projected.dashboards[0].permission).toBe("Field Dispatch");
  expect(projected.dashboards[0].widgets[0].permission).toBe("Field Dispatch");
  expect(projected.reportDraft.audience).toBe("Role: Field Dispatch");
  expect(projected.reportTemplates[0].audience).toBe("Role: Field Dispatch");
  expect(
    projected.commsConfiguration.channels[CHANNELS[0].id].permissions,
  ).toHaveProperty(`role:${customRole.id}`);
  expect(
    projected.commsConfiguration.channels[CHANNELS[0].id].permissions,
  ).not.toHaveProperty("role:Field Dispatch");
});

test("board and OpenComms decisions round trip through their native owners", () => {
  const roles = [...initialRoles, customRole];
  let current = owners();
  const boardScope = {
    kind: "board" as const,
    id: `board:${current.boards[0].id}`,
  };
  const boardWrite = writeFederatedDecision(current, roles, {
    subject: { kind: "role", id: customRole.id },
    scope: boardScope,
    permissionId: "boards.view",
    decision: "allow",
  });
  expect(boardWrite.ok).toBe(true);
  if (!boardWrite.ok) return;
  current = boardWrite.owners;
  expect(current.boards[0].roles).toContain(customRole.name);

  const commsWrite = writeFederatedDecision(current, roles, {
    subject: { kind: "everyone" },
    scope: {
      kind: "comms-channel",
      id: `comms-channel:${CHANNELS[0].id}`,
    },
    permissionId: "comms.post",
    decision: "deny",
  });
  expect(commsWrite.ok).toBe(true);
  if (!commsWrite.ok) return;
  current = commsWrite.owners;
  expect(
    normalizeCommsConfiguration(current.commsConfiguration).channels[
      CHANNELS[0].id
    ].permissions.everyone.post,
  ).toBe("deny");
  const commsRoleWrite = writeFederatedDecision(current, roles, {
    subject: { kind: "role", id: customRole.id },
    scope: { kind: "workspace", id: "comms-workspace:workspace" },
    permissionId: "comms.manage",
    decision: "allow",
  });
  expect(commsRoleWrite.ok).toBe(true);
  if (!commsRoleWrite.ok) return;
  current = commsRoleWrite.owners;
  const commsCategoryWrite = writeFederatedDecision(current, roles, {
    subject: { kind: "everyone" },
    scope: {
      kind: "comms-category",
      id: `comms-category:${CATEGORIES[0].id}`,
    },
    permissionId: "comms.view",
    decision: "allow",
  });
  expect(commsCategoryWrite.ok).toBe(true);
  if (!commsCategoryWrite.ok) return;
  current = commsCategoryWrite.owners;

  const read = getFederatedAccess(current, roles);
  expect(read.rules).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        subject: { kind: "role", id: customRole.id },
        scope: boardScope,
        permissionId: "boards.view",
        decision: "allow",
      }),
      expect.objectContaining({
        subject: { kind: "everyone" },
        scope: {
          kind: "comms-channel",
          id: `comms-channel:${CHANNELS[0].id}`,
        },
        permissionId: "comms.post",
        decision: "deny",
      }),
      expect.objectContaining({
        subject: { kind: "role", id: customRole.id },
        scope: { kind: "workspace", id: "comms-workspace:workspace" },
        permissionId: "comms.manage",
        decision: "allow",
      }),
      expect.objectContaining({
        subject: { kind: "everyone" },
        scope: {
          kind: "comms-category",
          id: `comms-category:${CATEGORIES[0].id}`,
        },
        permissionId: "comms.view",
        decision: "allow",
      }),
    ]),
  );
});

test("ambiguous and unsupported tuples remain overlays and unknown native references fail closed", () => {
  const current = owners();
  current.boards[0].roles.push("Missing role");
  current.commsConfiguration.channels.missing = {
    settings: {},
    permissions: { everyone: { post: "allow" } },
  };
  const read = getFederatedAccess(current, [...initialRoles, customRole]);
  expect(read.findings.map((finding) => finding.id)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("board-role"),
      expect.stringContaining("comms-scope"),
    ]),
  );

  expect(
    writeFederatedDecision(current, [...initialRoles, customRole], {
      subject: { kind: "group", id: "group:dispatch" },
      scope: { kind: "openview", id: "openview:report-draft" },
      permissionId: "openview.view",
      decision: "allow",
    }),
  ).toMatchObject({ ok: false, classification: "overlay" });
  expect(
    writeFederatedDecision(current, [...initialRoles, customRole], {
      subject: { kind: "everyone" },
      scope: { kind: "comms-channel", id: "comms-channel:missing" },
      permissionId: "comms.post",
      decision: "allow",
    }),
  ).toMatchObject({ ok: false, classification: "invalid" });
});

function controllerSnapshot(
  currentOwners: FederatedAccessOwners,
): AccessControllerSnapshot {
  const roles = [...structuredClone(initialRoles), customRole];
  const federated = getFederatedAccess(currentOwners, roles);
  return {
    people: structuredClone(initialPeople),
    roles,
    guests: [],
    services: [],
    groups: structuredClone(initialAccessGroups),
    rules: [...federated.rules],
    defaults: structuredClone(initialAccessDefaults),
    templates: structuredClone(initialAccessTemplates),
    reviews: [],
    deletedIdentities: [],
    sessions: [],
    history: [],
    federatedScopes: federated.scopes,
  };
}

const commandContext = {
  now: "2026-09-12T12:00:00.000Z",
  id: (prefix: string) => `${prefix}:generated`,
};

test("federated command execution atomically projects role rename and blocks referenced deletion", () => {
  const currentOwners = owners();
  currentOwners.boards[0].roles.push(customRole.name);
  const state = controllerSnapshot(currentOwners);
  const renamed = executeFederatedAccessCommand(
    state,
    currentOwners,
    {
      type: "update-role",
      roleId: customRole.id,
      patch: { name: "Field Dispatch" },
    },
    commandContext,
  );
  expect(renamed.ok).toBe(true);
  if (!renamed.ok) return;
  expect(
    renamed.state.roles.find((role) => role.id === customRole.id)?.name,
  ).toBe("Field Dispatch");
  expect(renamed.owners.boards[0].roles).toContain("Field Dispatch");
  expect(renamed.owners.announcements[0].audience).toBe("Role: Field Dispatch");
  expect(renamed.owners.savedViews[0].audience).toBe("Role: Field Dispatch");

  const blocked = executeFederatedAccessCommand(
    state,
    currentOwners,
    { type: "delete-role", roleId: customRole.id },
    commandContext,
  );
  expect(blocked).toEqual({
    ok: false,
    error:
      "Role is still referenced by federated owners and cannot be deleted.",
  });
});

test("native rule writes leave one owner and unsupported overlays remain in access-rules", () => {
  const currentOwners = owners();
  const state = controllerSnapshot(currentOwners);
  const boardRule = {
    id: "rule:board-dispatch",
    subject: { kind: "role" as const, id: customRole.id },
    scope: {
      kind: "board" as const,
      id: `board:${currentOwners.boards[0].id}`,
    },
    permissionId: "boards.view",
    decision: "allow" as const,
  };
  const projected = executeFederatedAccessCommand(
    state,
    currentOwners,
    { type: "upsert-rule", rule: boardRule },
    commandContext,
  );
  expect(projected.ok).toBe(true);
  if (!projected.ok) return;
  expect(projected.owners.boards[0].roles).toContain(customRole.name);
  expect(projected.state.rules).not.toContainEqual(
    expect.objectContaining({ id: boardRule.id }),
  );

  const overlay = executeFederatedAccessCommand(
    projected.state,
    projected.owners,
    {
      type: "upsert-rule",
      rule: {
        id: "rule:openview-group",
        subject: { kind: "group", id: "group:dispatch" },
        scope: { kind: "openview", id: "openview:report-draft" },
        permissionId: "openview.view",
        decision: "allow",
      },
    },
    commandContext,
  );
  expect(overlay.ok).toBe(true);
  if (!overlay.ok) return;
  expect(overlay.state.rules).toContainEqual(
    expect.objectContaining({ id: "rule:openview-group" }),
  );

  const timeBound = executeFederatedAccessCommand(
    projected.state,
    projected.owners,
    {
      type: "upsert-rule",
      rule: {
        ...boardRule,
        id: "rule:scheduled-board",
        startsAt: "2026-09-13T00:00:00.000Z",
      },
    },
    commandContext,
  );
  expect(timeBound.ok).toBe(true);
  if (!timeBound.ok) return;
  expect(timeBound.owners.boards[0].roles).not.toContain(customRole.name);
  expect(timeBound.state.rules).toContainEqual(
    expect.objectContaining({ id: "rule:scheduled-board" }),
  );
});

test("conditions and inheritance applied to native rules persist as Access overlays", () => {
  const currentOwners = owners();
  const roles = [...initialRoles, customRole];
  const allowed = writeFederatedDecision(currentOwners, roles, {
    subject: { kind: "role", id: customRole.id },
    scope: {
      kind: "comms-channel",
      id: `comms-channel:${CHANNELS[0].id}`,
    },
    permissionId: "comms.view",
    decision: "allow",
  });
  expect(allowed.ok).toBe(true);
  if (!allowed.ok) return;

  const state = controllerSnapshot(allowed.owners);
  const native = state.rules.find(
    (rule) =>
      rule.id.startsWith("native:comms:") &&
      rule.subject.kind === "role" &&
      rule.subject.id === customRole.id &&
      rule.permissionId === "comms.view",
  );
  expect(native).toBeDefined();
  if (!native) return;

  const scheduled = executeFederatedAccessCommand(
    state,
    allowed.owners,
    {
      type: "upsert-rule",
      rule: { ...native, startsAt: "2026-09-13T00:00:00.000Z" },
    },
    commandContext,
  );
  expect(scheduled.ok).toBe(true);
  if (!scheduled.ok) return;
  expect(scheduled.state.rules).toContainEqual(
    expect.objectContaining({
      subject: native.subject,
      scope: native.scope,
      permissionId: native.permissionId,
      startsAt: "2026-09-13T00:00:00.000Z",
    }),
  );
  expect(scheduled.state.rules).not.toContainEqual(
    expect.objectContaining({ id: native.id }),
  );
  expect(
    normalizeCommsConfiguration(scheduled.owners.commsConfiguration).channels[
      CHANNELS[0].id
    ].permissions[`role:${customRole.id}`]?.viewChannel,
  ).toBeUndefined();

  const boardOwners = owners();
  boardOwners.boards[0].roles.push(customRole.name);
  const boardState = controllerSnapshot(boardOwners);
  const boardNative = boardState.rules.find(
    (rule) =>
      rule.id.startsWith("native:boards:") &&
      rule.subject.kind === "role" &&
      rule.subject.id === customRole.id,
  );
  expect(boardNative).toBeDefined();
  if (!boardNative) return;
  const inherited = executeFederatedAccessCommand(
    boardState,
    boardOwners,
    {
      type: "upsert-rule",
      rule: { ...boardNative, decision: "inherit" },
    },
    commandContext,
  );
  expect(inherited.ok).toBe(true);
  if (!inherited.ok) return;
  expect(inherited.state.rules).toContainEqual(
    expect.objectContaining({
      subject: boardNative.subject,
      scope: boardNative.scope,
      permissionId: boardNative.permissionId,
      decision: "inherit",
    }),
  );
  expect(inherited.owners.boards[0].roles).not.toContain(customRole.name);
});

test("cross-product scope and permission tuples fail closed and surface a health finding", () => {
  const currentOwners = owners();
  const state = controllerSnapshot(currentOwners);
  const incompatibleRule = {
    id: "rule:wrong-product",
    subject: { kind: "role" as const, id: customRole.id },
    scope: {
      kind: "board" as const,
      id: `board:${currentOwners.boards[0].id}`,
    },
    permissionId: "comms.manage",
    decision: "allow" as const,
  };
  expect(
    executeFederatedAccessCommand(
      state,
      currentOwners,
      { type: "upsert-rule", rule: incompatibleRule },
      commandContext,
    ),
  ).toEqual({
    ok: false,
    error: "The rule permission is incompatible with its scope.",
  });

  const unhealthy = {
    ...state,
    rules: [...state.rules, incompatibleRule],
  };
  expect(
    getAccessHealth(unhealthy, commandContext.now).some(
      (finding) =>
        finding.targetId === incompatibleRule.id &&
        finding.kind === "invalid-reference",
    ),
  ).toBe(true);
});
