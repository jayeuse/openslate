import type { SampleBoard } from "../boards";
import type { Announcement } from "../boards/announcements";
import {
  emptyCommsScope,
  getCommsScope,
  normalizeCommsConfiguration,
  patchCommsScope,
  type CommsConfiguration,
  type CommsPermission,
  type CommsScope,
} from "../comms/configuration";
import type { Category, Channel } from "../comms/model";
import type { Dashboard, Report } from "../openview/analytics";
import type { SavedView } from "../openview";
import type { Role } from "./model";
import {
  executeAccessCommand,
  type AccessCommand,
  type AccessCommandContext,
  type AccessCommandResult,
  type AccessControllerSnapshot,
} from "./controller-utils";
import type {
  AccessDecision,
  AccessRule,
  AccessScopeRef,
  AccessSubjectRef,
} from "./policy";

export type FederatedAccessOwners = {
  boards: SampleBoard[];
  announcements: Announcement[];
  savedViews: SavedView[];
  dashboards: Dashboard[];
  reportDraft: Report;
  reportTemplates: Report[];
  commsConfiguration: CommsConfiguration;
  commsCategories: Category[];
  commsChannels: Channel[];
};

export type FederatedOwnerKey =
  | "boards-list"
  | "boards-announcements"
  | "views-saved"
  | "views-dashboards"
  | "views-report-draft"
  | "views-report-templates"
  | "comms-configuration";

export type FederatedScopeEntry = AccessScopeRef & {
  name: string;
  product: "Boards" | "OpenView" | "OpenComms";
  owner: FederatedOwnerKey;
  mode: "native" | "read-only";
  parentId?: string;
};

export type FederatedAccessFinding = {
  id: string;
  kind: "invalid-reference" | "conflict";
  severity: "critical" | "warning";
  title: string;
  detail: string;
  targetId?: string;
};

export type FederatedDecisionInput = {
  subject: AccessSubjectRef;
  scope: AccessScopeRef;
  permissionId: string;
  decision: AccessDecision;
};

export type FederatedDecisionClassification =
  | { classification: "native"; owner: "boards-list" | "comms-configuration" }
  | { classification: "overlay"; reason: string }
  | { classification: "invalid"; reason: string };

export type FederatedAccessProjection = {
  scopes: FederatedScopeEntry[];
  rules: AccessRule[];
  findings: FederatedAccessFinding[];
};

const commsPermissions = {
  "comms.view": "viewChannel",
  "comms.post": "post",
  "comms.reply": "reply",
  "comms.manage": "manageChannel",
} satisfies Record<string, CommsPermission>;

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function cloneOwners(owners: FederatedAccessOwners): FederatedAccessOwners {
  return structuredClone(owners);
}

function roleByLabel(roles: readonly Role[], label: string): Role | undefined {
  const matches = roles.filter((role) => role.name === label);
  return matches.length === 1 ? matches[0] : undefined;
}

function audienceRoleLabel(audience: string): string {
  return audience.startsWith("Role: ")
    ? audience.slice("Role: ".length)
    : audience;
}

function audienceReferencesRole(audience: string, role: Role): boolean {
  return audienceRoleLabel(audience) === role.name;
}

function replaceAudience(
  value: string,
  previous: string,
  next: string,
): string {
  if (value === previous) return next;
  return value === `Role: ${previous}` ? `Role: ${next}` : value;
}

export function projectFederatedRoleChange(
  owners: FederatedAccessOwners,
  previous: Role,
  next: Role,
): FederatedAccessOwners {
  if (previous.name === next.name) return cloneOwners(owners);
  const projected = cloneOwners(owners);
  projected.boards = projected.boards.map((board) => ({
    ...board,
    roles: board.roles.map((role) =>
      replaceAudience(role, previous.name, next.name),
    ),
    widgets: board.widgets.map((widget) => ({
      ...widget,
      permission: replaceAudience(widget.permission, previous.name, next.name),
    })),
  }));
  projected.announcements = projected.announcements.map((announcement) => ({
    ...announcement,
    audience: replaceAudience(announcement.audience, previous.name, next.name),
  }));
  projected.savedViews = projected.savedViews.map((view) => ({
    ...view,
    audience: replaceAudience(view.audience, previous.name, next.name),
  }));
  projected.dashboards = projected.dashboards.map((dashboard) => ({
    ...dashboard,
    permission: replaceAudience(dashboard.permission, previous.name, next.name),
    widgets: dashboard.widgets.map((widget) => ({
      ...widget,
      permission: replaceAudience(widget.permission, previous.name, next.name),
    })),
  }));
  projected.reportDraft = {
    ...projected.reportDraft,
    audience: replaceAudience(
      projected.reportDraft.audience,
      previous.name,
      next.name,
    ),
  };
  projected.reportTemplates = projected.reportTemplates.map((report) => ({
    ...report,
    audience: replaceAudience(report.audience, previous.name, next.name),
  }));
  // OpenComms subjects are stable `role:<id>` keys and intentionally do not
  // participate in label projection.
  return projected;
}

export function federatedRoleReferences(
  owners: FederatedAccessOwners,
  role: Role,
): FederatedOwnerKey[] {
  const references = new Set<FederatedOwnerKey>();
  if (
    owners.boards.some(
      (board) =>
        board.roles.includes(role.name) ||
        board.widgets.some((widget) => widget.permission === role.name),
    )
  )
    references.add("boards-list");
  if (
    owners.announcements.some((announcement) =>
      audienceReferencesRole(announcement.audience, role),
    )
  )
    references.add("boards-announcements");
  if (
    owners.savedViews.some((view) =>
      audienceReferencesRole(view.audience, role),
    )
  )
    references.add("views-saved");
  if (
    owners.dashboards.some(
      (dashboard) =>
        dashboard.permission === role.name ||
        dashboard.widgets.some((widget) => widget.permission === role.name),
    )
  )
    references.add("views-dashboards");
  if (audienceReferencesRole(owners.reportDraft.audience, role))
    references.add("views-report-draft");
  if (
    owners.reportTemplates.some((report) =>
      audienceReferencesRole(report.audience, role),
    )
  )
    references.add("views-report-templates");
  const subject = `role:${role.id}`;
  const config = normalizeCommsConfiguration(owners.commsConfiguration);
  if (
    [
      config.workspace,
      ...Object.values(config.categories),
      ...Object.values(config.channels),
    ].some((scope) => Object.hasOwn(scope.permissions, subject))
  )
    references.add("comms-configuration");
  return [...references];
}

function resolveBoard(
  owners: FederatedAccessOwners,
  scope: AccessScopeRef,
): SampleBoard | undefined {
  if (scope.kind !== "board" || !scope.id.startsWith("board:")) return;
  const matches = owners.boards.filter(
    (board) => `board:${board.id}` === scope.id,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveCommsScope(
  owners: FederatedAccessOwners,
  scope: AccessScopeRef,
): CommsScope | undefined {
  if (scope.kind === "workspace" && scope.id === "comms-workspace:workspace")
    return { kind: "workspace", id: "workspace" };
  if (
    scope.kind === "comms-category" &&
    scope.id.startsWith("comms-category:")
  ) {
    const id = scope.id.slice("comms-category:".length);
    if (
      owners.commsCategories.filter((category) => category.id === id).length ===
      1
    )
      return { kind: "category", id };
  }
  if (scope.kind === "comms-channel" && scope.id.startsWith("comms-channel:")) {
    const id = scope.id.slice("comms-channel:".length);
    if (
      owners.commsChannels.filter((channel) => channel.id === id).length === 1
    )
      return { kind: "channel", id };
  }
}

export function classifyFederatedDecision(
  owners: FederatedAccessOwners,
  roles: readonly Role[],
  input: FederatedDecisionInput,
): FederatedDecisionClassification {
  const subjectRoleId =
    input.subject.kind === "role" ? input.subject.id : undefined;
  const board = resolveBoard(owners, input.scope);
  if (input.scope.kind === "board") {
    if (!board)
      return input.scope.id.startsWith("board:sample-board-")
        ? {
            classification: "invalid",
            reason: "The board scope is unknown.",
          }
        : {
            classification: "overlay",
            reason:
              "This board scope is owned by the Access legacy projection.",
          };
    if (
      input.permissionId === "boards.view" &&
      subjectRoleId !== undefined &&
      roles.some((role) => role.id === subjectRoleId) &&
      input.decision !== "inherit"
    )
      return { classification: "native", owner: "boards-list" };
    return {
      classification: "overlay",
      reason:
        "This board tuple is not faithfully represented by the board visibility list.",
    };
  }

  const commsScope = resolveCommsScope(owners, input.scope);
  if (
    input.scope.id.startsWith("comms-") ||
    input.scope.kind === "comms-category" ||
    input.scope.kind === "comms-channel"
  ) {
    if (!commsScope)
      return input.scope.id.endsWith(":all")
        ? {
            classification: "overlay",
            reason: "Aggregate OpenComms scopes remain Access overlays.",
          }
        : {
            classification: "invalid",
            reason: "The OpenComms scope is unknown.",
          };
    if (!(input.permissionId in commsPermissions))
      return {
        classification: "overlay",
        reason: "The OpenComms permission has no faithful native mapping.",
      };
    if (
      input.subject.kind !== "everyone" &&
      !(
        subjectRoleId !== undefined &&
        roles.some((role) => role.id === subjectRoleId)
      )
    )
      return {
        classification: "overlay",
        reason:
          "OpenComms native overrides support everyone and known roles only.",
      };
    return { classification: "native", owner: "comms-configuration" };
  }

  return {
    classification: "overlay",
    reason:
      "This tuple remains an Access overlay because its owner is read-only or not federated.",
  };
}

export function classifyFederatedRule(
  owners: FederatedAccessOwners,
  roles: readonly Role[],
  rule: AccessRule,
): FederatedDecisionClassification {
  if (rule.startsAt || rule.endsAt || rule.locked)
    return {
      classification: "overlay",
      reason:
        "Time-bound and locked decisions remain Access overlays because native owners cannot represent their constraints.",
    };
  return classifyFederatedDecision(owners, roles, rule);
}

export function writeFederatedDecision(
  owners: FederatedAccessOwners,
  roles: readonly Role[],
  input: FederatedDecisionInput,
):
  | {
      ok: true;
      classification: "native";
      owner: "boards-list" | "comms-configuration";
      owners: FederatedAccessOwners;
    }
  | {
      ok: false;
      classification: "overlay" | "invalid";
      reason: string;
    } {
  const classification = classifyFederatedDecision(owners, roles, input);
  if (classification.classification !== "native")
    return { ok: false, ...classification };
  const projected = cloneOwners(owners);
  if (classification.owner === "boards-list") {
    const role = roles.find(
      (candidate) =>
        input.subject.kind === "role" && candidate.id === input.subject.id,
    );
    const board = resolveBoard(projected, input.scope);
    if (!role || !board)
      return {
        ok: false,
        classification: "invalid",
        reason: "The board role or scope is unknown.",
      };
    board.roles =
      input.decision === "allow"
        ? [...new Set([...board.roles, role.name])]
        : board.roles.filter((label) => label !== role.name);
  } else {
    const scope = resolveCommsScope(projected, input.scope);
    if (!scope)
      return {
        ok: false,
        classification: "invalid",
        reason: "The OpenComms scope is unknown.",
      };
    const config = normalizeCommsConfiguration(projected.commsConfiguration);
    const current = getCommsScope(config, scope);
    const subject =
      input.subject.kind === "everyone"
        ? "everyone"
        : `role:${input.subject.id}`;
    const permission =
      commsPermissions[input.permissionId as keyof typeof commsPermissions];
    const permissions = structuredClone(current.permissions);
    const values = { ...(permissions[subject] ?? {}) };
    if (input.decision === "inherit") delete values[permission];
    else values[permission] = input.decision;
    if (Object.keys(values).length) permissions[subject] = values;
    else delete permissions[subject];
    projected.commsConfiguration = patchCommsScope(config, scope, {
      ...emptyCommsScope(),
      ...current,
      permissions,
    });
  }
  return { ok: true, ...classification, owners: projected };
}

function addUnknownAudienceFinding(
  findings: FederatedAccessFinding[],
  roles: readonly Role[],
  owner: FederatedOwnerKey,
  targetId: string,
  audience: string,
): void {
  if (
    audience === "Everyone" ||
    audience === "Only me" ||
    roleByLabel(roles, audienceRoleLabel(audience))
  )
    return;
  findings.push({
    id: `federated:${owner}:audience:${targetId}`,
    kind: "invalid-reference",
    severity: "critical",
    title: "Federated audience is unknown",
    detail: `${owner} references the unknown or ambiguous role label ${audience}.`,
    targetId,
  });
}

export function getFederatedAccess(
  owners: FederatedAccessOwners,
  roles: readonly Role[],
): FederatedAccessProjection {
  const scopes: FederatedScopeEntry[] = [];
  const rules: AccessRule[] = [];
  const findings: FederatedAccessFinding[] = [];

  for (const board of owners.boards) {
    const scope: AccessScopeRef = { kind: "board", id: `board:${board.id}` };
    scopes.push({
      ...scope,
      name: board.name,
      product: "Boards",
      owner: "boards-list",
      mode: "native",
      parentId: "workspace",
    });
    for (const label of board.roles) {
      const role = roleByLabel(roles, label);
      if (!role) {
        findings.push({
          id: `federated:board-role:${board.id}:${slug(label)}`,
          kind: "invalid-reference",
          severity: "critical",
          title: "Board role reference is unknown",
          detail: `${board.name} references the unknown or ambiguous role label ${label}.`,
          targetId: board.id,
        });
        continue;
      }
      rules.push({
        id: `native:boards:${board.id}:role:${role.id}:boards.view`,
        subject: { kind: "role", id: role.id },
        scope,
        permissionId: "boards.view",
        decision: "allow",
      });
    }
    for (const widget of board.widgets) {
      scopes.push({
        kind: "openview",
        id: `openview:board-widget:${board.id}:${widget.id}`,
        name: `${board.name} · ${widget.type}`,
        product: "OpenView",
        owner: "boards-list",
        mode: "read-only",
        parentId: "workspace",
      });
      addUnknownAudienceFinding(
        findings,
        roles,
        "boards-list",
        widget.id,
        widget.permission,
      );
    }
  }

  for (const view of owners.savedViews) {
    scopes.push({
      kind: "openview",
      id: `openview:saved-view:${view.id}`,
      name: view.name,
      product: "OpenView",
      owner: "views-saved",
      mode: "read-only",
      parentId: "workspace",
    });
    addUnknownAudienceFinding(
      findings,
      roles,
      "views-saved",
      view.id,
      view.audience,
    );
  }
  for (const dashboard of owners.dashboards) {
    scopes.push({
      kind: "openview",
      id: `openview:dashboard:${dashboard.id}`,
      name: dashboard.name,
      product: "OpenView",
      owner: "views-dashboards",
      mode: "read-only",
      parentId: "workspace",
    });
    addUnknownAudienceFinding(
      findings,
      roles,
      "views-dashboards",
      dashboard.id,
      dashboard.permission,
    );
    for (const widget of dashboard.widgets) {
      scopes.push({
        kind: "openview",
        id: `openview:dashboard-widget:${dashboard.id}:${widget.id}`,
        name: `${dashboard.name} · ${widget.type}`,
        product: "OpenView",
        owner: "views-dashboards",
        mode: "read-only",
        parentId: "workspace",
      });
      addUnknownAudienceFinding(
        findings,
        roles,
        "views-dashboards",
        widget.id,
        widget.permission,
      );
    }
  }
  scopes.push({
    kind: "openview",
    id: "openview:report-draft",
    name: owners.reportDraft.name,
    product: "OpenView",
    owner: "views-report-draft",
    mode: "read-only",
    parentId: "workspace",
  });
  addUnknownAudienceFinding(
    findings,
    roles,
    "views-report-draft",
    "report-draft",
    owners.reportDraft.audience,
  );
  const reportScopeIds = owners.reportTemplates.map((report) =>
    slug(report.name),
  );
  const reportedAmbiguousTemplates = new Set<string>();
  for (const report of owners.reportTemplates) {
    const id = slug(report.name);
    if (
      !id ||
      reportScopeIds.filter((candidate) => candidate === id).length !== 1
    ) {
      if (!reportedAmbiguousTemplates.has(id)) {
        reportedAmbiguousTemplates.add(id);
        findings.push({
          id: `federated:report-template:ambiguous:${id || "empty"}`,
          kind: "conflict",
          severity: "critical",
          title: "Report template scope is ambiguous",
          detail:
            "Report template names must be unique to expose stable Access scopes.",
          targetId: report.name,
        });
      }
      continue;
    }
    scopes.push({
      kind: "openview",
      id: `openview:report-template:${id}`,
      name: report.name,
      product: "OpenView",
      owner: "views-report-templates",
      mode: "read-only",
      parentId: "workspace",
    });
    addUnknownAudienceFinding(
      findings,
      roles,
      "views-report-templates",
      id,
      report.audience,
    );
  }

  scopes.push({
    kind: "workspace",
    id: "comms-workspace:workspace",
    name: "OpenComms workspace",
    product: "OpenComms",
    owner: "comms-configuration",
    mode: "native",
  });
  for (const category of owners.commsCategories)
    scopes.push({
      kind: "comms-category",
      id: `comms-category:${category.id}`,
      name: category.name,
      product: "OpenComms",
      owner: "comms-configuration",
      mode: "native",
      parentId: "comms-workspace:workspace",
    });
  for (const channel of owners.commsChannels)
    scopes.push({
      kind: "comms-channel",
      id: `comms-channel:${channel.id}`,
      name: channel.name,
      product: "OpenComms",
      owner: "comms-configuration",
      mode: "native",
      parentId: `comms-category:${channel.categoryId}`,
    });

  const config = normalizeCommsConfiguration(owners.commsConfiguration);
  const knownCategoryIds = new Set(
    owners.commsCategories.map((item) => item.id),
  );
  const knownChannelIds = new Set(owners.commsChannels.map((item) => item.id));
  const commsScopes: [
    AccessScopeRef,
    Record<string, Partial<Record<CommsPermission, AccessDecision>>>,
  ][] = [
    [
      { kind: "workspace", id: "comms-workspace:workspace" },
      config.workspace.permissions,
    ],
  ];
  for (const [id, value] of Object.entries(config.categories)) {
    if (!knownCategoryIds.has(id)) {
      findings.push({
        id: `federated:comms-scope:category:${id}`,
        kind: "invalid-reference",
        severity: "critical",
        title: "OpenComms category scope is unknown",
        detail: `comms-configuration references missing category ${id}.`,
        targetId: id,
      });
      continue;
    }
    commsScopes.push([
      { kind: "comms-category", id: `comms-category:${id}` },
      value.permissions,
    ]);
  }
  for (const [id, value] of Object.entries(config.channels)) {
    if (!knownChannelIds.has(id)) {
      findings.push({
        id: `federated:comms-scope:channel:${id}`,
        kind: "invalid-reference",
        severity: "critical",
        title: "OpenComms channel scope is unknown",
        detail: `comms-configuration references missing channel ${id}.`,
        targetId: id,
      });
      continue;
    }
    commsScopes.push([
      { kind: "comms-channel", id: `comms-channel:${id}` },
      value.permissions,
    ]);
  }
  const accessPermissionByComms = Object.fromEntries(
    Object.entries(commsPermissions).map(([access, comms]) => [comms, access]),
  ) as Partial<Record<CommsPermission, string>>;
  for (const [scope, permissions] of commsScopes)
    for (const [subjectKey, decisions] of Object.entries(permissions)) {
      const subject: AccessSubjectRef | undefined =
        subjectKey === "everyone"
          ? { kind: "everyone" }
          : subjectKey.startsWith("role:")
            ? { kind: "role", id: subjectKey.slice("role:".length) }
            : undefined;
      if (!subject) continue;
      if (
        subject.kind === "role" &&
        !roles.some((role) => role.id === subject.id)
      ) {
        findings.push({
          id: `federated:comms-role:${subject.id}`,
          kind: "invalid-reference",
          severity: "critical",
          title: "OpenComms role reference is unknown",
          detail: `comms-configuration references missing role ${subject.id}.`,
          targetId: subject.id,
        });
        continue;
      }
      for (const [permission, decision] of Object.entries(decisions)) {
        const permissionId =
          accessPermissionByComms[permission as CommsPermission];
        if (!permissionId || (decision !== "allow" && decision !== "deny"))
          continue;
        rules.push({
          id: `native:comms:${scope.id}:${subjectKey}:${permissionId}`,
          subject,
          scope,
          permissionId,
          decision,
        });
      }
    }

  return { scopes, rules, findings };
}

export type FederatedAccessCommandResult =
  | (Extract<AccessCommandResult, { ok: true }> & {
      owners: FederatedAccessOwners;
    })
  | Extract<AccessCommandResult, { ok: false }>;

function sameTuple(left: AccessRule, right: AccessRule): boolean {
  return (
    left.subject.kind === right.subject.kind &&
    (left.subject.kind === "everyone" ||
      (right.subject.kind !== "everyone" &&
        left.subject.id === right.subject.id)) &&
    left.scope.kind === right.scope.kind &&
    left.scope.id === right.scope.id &&
    left.permissionId === right.permissionId
  );
}

function clearNativeRule(
  owners: FederatedAccessOwners,
  roles: readonly Role[],
  rule: AccessRule,
): FederatedAccessOwners | null {
  const classification = classifyFederatedDecision(owners, roles, rule);
  if (classification.classification !== "native") return null;
  const cleared = writeFederatedDecision(owners, roles, {
    ...rule,
    decision: classification.owner === "boards-list" ? "deny" : "inherit",
  });
  return cleared.ok ? cleared.owners : null;
}

export function executeFederatedAccessCommand(
  current: AccessControllerSnapshot,
  currentOwners: FederatedAccessOwners,
  command: AccessCommand,
  context: AccessCommandContext,
): FederatedAccessCommandResult {
  if (command.type === "delete-role") {
    const role = current.roles.find((item) => item.id === command.roleId);
    if (role && federatedRoleReferences(currentOwners, role).length)
      return {
        ok: false,
        error:
          "Role is still referenced by federated owners and cannot be deleted.",
      };
  }

  const result = executeAccessCommand(current, command, context);
  if (!result.ok) return result;
  for (const previous of current.roles)
    if (
      !result.state.roles.some((role) => role.id === previous.id) &&
      federatedRoleReferences(currentOwners, previous).length
    )
      return {
        ok: false,
        error:
          "Role is still referenced by federated owners and cannot be deleted.",
      };
  let owners = cloneOwners(currentOwners);
  const replacesRules =
    (command.type === "import-policy-bundle" && command.mode === "replace") ||
    command.type === "apply-history-restore";
  if (replacesRules) {
    for (const rule of current.rules.filter((item) =>
      item.id.startsWith("native:"),
    )) {
      const cleared = clearNativeRule(owners, current.roles, rule);
      if (!cleared)
        return {
          ok: false,
          error:
            "The existing native access rule could not be replaced safely.",
        };
      owners = cleared;
    }
  }
  for (const previous of current.roles) {
    const next = result.state.roles.find((role) => role.id === previous.id);
    if (!next) continue;
    if (previous.name !== next.name)
      owners = projectFederatedRoleChange(owners, previous, next);
  }

  result.state.rules = result.state.rules.map((rule) => {
    if (!rule.id.startsWith("native:")) return rule;
    const classification = classifyFederatedRule(
      owners,
      result.state.roles,
      rule,
    );
    if (classification.classification !== "overlay") return rule;
    return {
      ...rule,
      id: context.id(`rule-overlay:${rule.id}`),
    };
  });

  const upsertedRules =
    command.type === "upsert-rule"
      ? [command.rule]
      : command.type === "upsert-rules"
        ? command.rules
        : [];
  for (const rule of upsertedRules) {
    const previous = current.rules.find((item) => item.id === rule.id);
    if (previous?.id.startsWith("native:") && !sameTuple(previous, rule)) {
      const cleared = clearNativeRule(owners, result.state.roles, previous);
      if (!cleared)
        return {
          ok: false,
          error: "The previous native rule could not be projected safely.",
        };
      owners = cleared;
    }
  }
  if (command.type === "delete-rule") {
    const previous = current.rules.find((rule) => rule.id === command.ruleId);
    if (previous?.id.startsWith("native:")) {
      const cleared = clearNativeRule(owners, result.state.roles, previous);
      if (!cleared)
        return {
          ok: false,
          error: "The native rule could not be removed safely.",
        };
      owners = cleared;
    }
  }

  const overlays: AccessRule[] = [];
  const overlayNativeTuples = result.state.rules.filter((rule) => {
    if (rule.id.startsWith("native:")) return false;
    const classification = classifyFederatedRule(
      owners,
      result.state.roles,
      rule,
    );
    if (classification.classification !== "overlay") return false;
    return (
      classifyFederatedDecision(owners, result.state.roles, {
        ...rule,
        decision: rule.decision === "inherit" ? "deny" : rule.decision,
      }).classification === "native"
    );
  });
  for (const overlay of overlayNativeTuples) {
    const cleared = clearNativeRule(owners, result.state.roles, {
      ...overlay,
      decision: overlay.decision === "inherit" ? "allow" : overlay.decision,
    });
    if (!cleared)
      return {
        ok: false,
        error: "The native access tuple could not be cleared for its overlay.",
      };
    owners = cleared;
  }

  for (const rule of result.state.rules) {
    const classification = classifyFederatedRule(
      owners,
      result.state.roles,
      rule,
    );
    if (classification.classification === "overlay") {
      if (!rule.id.startsWith("native:")) overlays.push(rule);
      continue;
    }
    if (classification.classification === "native") {
      if (overlayNativeTuples.some((overlay) => sameTuple(overlay, rule)))
        continue;
      const written = writeFederatedDecision(owners, result.state.roles, rule);
      if (!written.ok)
        return {
          ok: false,
          error: "The native access decision could not be projected safely.",
        };
      owners = written.owners;
      continue;
    }
    if (
      classification.classification === "invalid" &&
      rule.id.startsWith("native:")
    )
      return {
        ok: false,
        error: classification.reason,
      };
    if (!rule.id.startsWith("native:")) overlays.push(rule);
  }

  return {
    ...result,
    state: { ...result.state, rules: overlays },
    owners,
  };
}
