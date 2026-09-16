import type {
  BoardAnnouncement,
  BoardAudience,
  SampleBoard,
} from "../boards/model";
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
import type {
  OpenViewModuleId,
  ReportSchedule,
  ViewConfig,
} from "../openview/model";
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
  boards: FederatedBoard[];
  announcements: FederatedAnnouncement[];
  savedViews: FederatedSavedView[];
  dashboards: FederatedDashboard[];
  reportDraft: FederatedReport;
  reportTemplates: FederatedReport[];
  commsConfiguration: CommsConfiguration;
  commsCategories: Category[];
  commsChannels: Channel[];
};

/**
 * OpenView ownership is local sample state today, so Access has to be able to
 * read both the current typed model and values written by the legacy screen.
 * These intentionally describe the smallest common projection rather than
 * making Access depend on OpenView's presentation components.
 */
/**
 * Boards accepts the typed OpenView audiences plus department audiences. The
 * string arm is retained only so Access can inspect snapshots written by the
 * pre-typed Boards screen.
 */
export type FederatedAudience = BoardAudience | string;

/**
 * These owner projections intentionally accept the pre-model sample shapes.
 * The controller supplies fully decoded Boards values; the compatibility
 * fields keep old snapshots readable while the migration is in progress.
 */
export type FederatedAnnouncement = Omit<
  Partial<BoardAnnouncement>,
  "id" | "title" | "body" | "audience"
> &
  Pick<BoardAnnouncement, "id" | "title" | "body"> & {
    audience: FederatedAudience;
  };

export type FederatedAudienceIdentity = {
  id: string;
  name: string;
  status?: string;
  deleted?: boolean;
};

export type FederatedAudienceRole = Pick<Role, "id" | "name"> & {
  status?: string;
  deleted?: boolean;
};

export type FederatedAudienceDepartment = {
  id: string;
  name: string;
  status?: string;
  deleted?: boolean;
};

export type FederatedAudienceLookup = {
  roles?: readonly FederatedAudienceRole[];
  identities?: readonly FederatedAudienceIdentity[];
  departments?: readonly FederatedAudienceDepartment[];
};

export type FederatedSavedView = {
  id: string;
  name: string;
  audience: FederatedAudience;
  moduleId?: OpenViewModuleId;
  config?: ViewConfig;
  // Legacy view fields are optional so normalized typed views and old stored
  // views can cross the Access boundary without a lossy cast.
  type?: string;
  search?: string;
  status?: string;
  sort?: string;
  group?: string;
};

export type FederatedWidget = {
  id: string;
  type: string;
  size: string;
  refresh?: string;
  pinned?: boolean;
  name?: string;
  moduleId?: OpenViewModuleId;
  audience?: FederatedAudience;
  permission?: string;
  fields?: string[];
  filters?: unknown;
  metric?: string;
  visualization?: string;
};

export type FederatedBoard = {
  id: string;
  name: string;
  department: string;
  widgets: FederatedWidget[];
  visibleRoleIds?: string[];
  roles?: string[];
  permission?: string;
} & Partial<Omit<SampleBoard, "id" | "name" | "department" | "widgets">>;

export type FederatedDashboard = {
  id: string;
  name: string;
  refresh: string;
  widgets: FederatedWidget[];
  audience?: FederatedAudience;
  permission?: string;
};

export type FederatedReport = {
  id?: string;
  name: string;
  audience: FederatedAudience;
  fields: string[];
  subtitle?: string;
  moduleId?: OpenViewModuleId;
  filters?: unknown;
  sorts?: unknown;
  grouping: string | null;
  totals: boolean;
  schedule: ReportSchedule | string;
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

function roleByLabel(
  roles: readonly FederatedAudienceRole[],
  label: string,
): FederatedAudienceRole | undefined {
  const matches = roles.filter(
    (role) => role.name === label && !isDeletedRole(role),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function roleById(
  roles: readonly FederatedAudienceRole[],
  id: string,
): FederatedAudienceRole | undefined {
  const matches = roles.filter(
    (role) => role.id === id && !isDeletedRole(role),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function isDeletedRole(role: FederatedAudienceRole): boolean {
  const candidate = role as FederatedAudienceRole & {
    deleted?: boolean;
    status?: string;
  };
  return (
    candidate.deleted === true ||
    ["deleted", "disabled", "revoked", "suspended"].includes(
      candidate.status ?? "",
    )
  );
}

function isDeletedDepartment(department: FederatedAudienceDepartment): boolean {
  return (
    department.deleted === true ||
    ["deleted", "disabled", "revoked", "suspended"].includes(
      department.status ?? "",
    )
  );
}

function audienceRoleLabel(audience: unknown): string | undefined {
  if (typeof audience !== "string") return;
  return audience.startsWith("Role: ")
    ? audience.slice("Role: ".length)
    : audience;
}

function audienceReferencesRole(audience: unknown, role: Role): boolean {
  if (
    typeof audience === "object" &&
    audience !== null &&
    "kind" in audience &&
    audience.kind === "role"
  ) {
    return "id" in audience && audience.id === role.id;
  }
  return audienceRoleLabel(audience) === role.name;
}

function replaceAudience(value: string, previous: string, next: string): string;
function replaceAudience(
  value: BoardAudience,
  previous: string,
  next: string,
): BoardAudience;
function replaceAudience(
  value: FederatedAudience,
  previous: string,
  next: string,
): FederatedAudience;
function replaceAudience(
  value: FederatedAudience,
  previous: string,
  next: string,
): FederatedAudience {
  if (typeof value !== "string") return value;
  if (value === previous) return next;
  return value === `Role: ${previous}` ? `Role: ${next}` : value;
}

function ownerAudience(value: {
  audience?: unknown;
  permission?: unknown;
}): unknown {
  return value.audience !== undefined ? value.audience : value.permission;
}

type TypedAudience = Exclude<FederatedAudience, string>;

function isAudienceRef(value: unknown): value is TypedAudience {
  if (typeof value !== "object" || value === null || !("kind" in value))
    return false;
  if (value.kind === "everyone" || value.kind === "department")
    return (
      value.kind === "everyone" ||
      ("id" in value &&
        typeof value.id === "string" &&
        value.id.trim().length > 0)
    );
  if (value.kind === "private") {
    if (!("unresolved" in value) || value.unresolved === undefined) return true;
    return (
      typeof value.unresolved === "object" &&
      value.unresolved !== null &&
      "kind" in value.unresolved &&
      (value.unresolved.kind === "role" ||
        value.unresolved.kind === "identity") &&
      "id" in value.unresolved &&
      typeof value.unresolved.id === "string" &&
      value.unresolved.id.trim().length > 0
    );
  }
  return (
    (value.kind === "role" || value.kind === "identity") &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.trim().length > 0
  );
}

type ResolvedAudience = {
  valid: boolean;
  label: string;
  ref: TypedAudience;
};

function isDeletedIdentity(identity: FederatedAudienceIdentity): boolean {
  return (
    identity.deleted === true ||
    identity.status === "deleted" ||
    identity.status === "revoked"
  );
}

function unresolvedAudience(
  label: string,
  kind: "role" | "identity" | "other",
): ResolvedAudience {
  return {
    valid: false,
    label,
    ref:
      kind === "role"
        ? { kind: "role", id: "unresolved" }
        : kind === "identity"
          ? { kind: "identity", id: "unresolved" }
          : { kind: "private" },
  };
}

function resolveAudience(
  raw: unknown,
  lookup: FederatedAudienceLookup,
): ResolvedAudience {
  const knownRoles = lookup.roles ?? [];
  if (isAudienceRef(raw)) {
    if (raw.kind === "private" && raw.unresolved)
      return unresolvedAudience(
        `${raw.unresolved.kind === "role" ? "Role" : "User"}: Unresolved (${raw.unresolved.id})`,
        raw.unresolved.kind,
      );
    if (raw.kind === "private")
      return { valid: true, label: "Only me", ref: raw };
    if (raw.kind === "everyone")
      return { valid: true, label: "Everyone", ref: raw };
    if (raw.kind === "department") {
      const department = lookup.departments?.find(
        (candidate) =>
          candidate.id === raw.id && !isDeletedDepartment(candidate),
      );
      return department
        ? {
            valid: true,
            label: `Department: ${department.name}`,
            ref: raw,
          }
        : unresolvedAudience(`Department: Unresolved (${raw.id})`, "other");
    }
    if (raw.kind === "role") {
      const role = roleById(knownRoles, raw.id);
      return role
        ? { valid: true, label: `Role: ${role.name}`, ref: raw }
        : unresolvedAudience(`Role: Unresolved (${raw.id})`, "role");
    }
    const identity = lookup.identities?.find(
      (candidate) => candidate.id === raw.id,
    );
    if (!identity)
      return unresolvedAudience(`User: Unresolved (${raw.id})`, "identity");
    if (isDeletedIdentity(identity))
      return unresolvedAudience(`User: ${identity.name} (deleted)`, "identity");
    return { valid: true, label: `User: ${identity.name}`, ref: raw };
  }

  if (raw === "Everyone")
    return { valid: true, label: "Everyone", ref: { kind: "everyone" } };
  if (raw === "Only me" || raw === "Private")
    return { valid: true, label: "Only me", ref: { kind: "private" } };
  if (typeof raw !== "string")
    return unresolvedAudience("Unresolved audience", "other");

  if (raw.startsWith("User: ")) {
    const identityLabel = raw.slice("User: ".length);
    const identities = lookup.identities?.filter(
      (identity) => identity.name === identityLabel,
    );
    const identity = identities?.length === 1 ? identities[0] : undefined;
    if (identity && !isDeletedIdentity(identity))
      return {
        valid: true,
        label: `User: ${identity.name}`,
        ref: { kind: "identity", id: identity.id },
      };
    return unresolvedAudience(
      `User: Unresolved (${identityLabel})`,
      "identity",
    );
  }
  if (raw.startsWith("Department: ")) {
    const departmentLabel = raw.slice("Department: ".length);
    const departments = lookup.departments?.filter(
      (candidate) =>
        candidate.name === departmentLabel && !isDeletedDepartment(candidate),
    );
    const department = departments?.length === 1 ? departments[0] : undefined;
    return department
      ? {
          valid: true,
          label: `Department: ${department.name}`,
          ref: { kind: "department", id: department.id },
        }
      : unresolvedAudience(
          `Department: Unresolved (${departmentLabel})`,
          "other",
        );
  }
  const roleLabel = audienceRoleLabel(raw);
  if (roleLabel !== undefined) {
    const role = roleByLabel(knownRoles, roleLabel);
    if (role)
      return {
        valid: true,
        label: `Role: ${role.name}`,
        ref: { kind: "role", id: role.id },
      };
    return unresolvedAudience(`Role: Unresolved (${roleLabel})`, "role");
  }
  return unresolvedAudience(`Unresolved audience (${raw})`, "other");
}

type BoardVisibilityCompat = FederatedBoard & {
  /** Canonical role ids introduced by the typed Boards model. */
  visibleRoleIds?: unknown;
  /** Legacy display labels retained for old sample snapshots. */
  roles?: unknown;
};

type BoardVisibilityState = {
  present: boolean;
  ids: string[];
  malformed: boolean;
};

function boardVisibility(board: FederatedBoard): BoardVisibilityState {
  const value: BoardVisibilityCompat = board;
  if (!Object.hasOwn(value, "visibleRoleIds"))
    return { present: false, ids: [], malformed: false };
  if (!Array.isArray(value.visibleRoleIds))
    return { present: true, ids: [], malformed: true };
  const ids = value.visibleRoleIds.filter(
    (roleId): roleId is string =>
      typeof roleId === "string" && roleId.trim().length > 0,
  );
  return {
    present: true,
    ids: [...new Set(ids)],
    malformed: ids.length !== value.visibleRoleIds.length,
  };
}

function legacyBoardRoles(board: FederatedBoard): string[] {
  const value: BoardVisibilityCompat = board;
  if (!Array.isArray(value.roles)) return [];
  return value.roles.filter((role): role is string => typeof role === "string");
}

function setCanonicalBoardRoles(
  board: FederatedBoard,
  ids: readonly string[],
): void {
  const value: FederatedBoard = board;
  value.visibleRoleIds = [...new Set(ids)];
}

function setLegacyBoardRoles(
  board: FederatedBoard,
  roles: readonly string[],
): void {
  const value: FederatedBoard = board;
  value.roles = [...new Set(roles)];
}

function canonicalWidgetAudienceIsPresent(widget: {
  audience?: unknown;
}): boolean {
  return widget.audience !== undefined;
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
    ...(boardVisibility(board).present
      ? {}
      : {
          roles: legacyBoardRoles(board).map((role) =>
            replaceAudience(role, previous.name, next.name),
          ),
        }),
    widgets: board.widgets.map((widget) =>
      canonicalWidgetAudienceIsPresent(widget)
        ? { ...widget }
        : {
            ...widget,
            ...(typeof widget.permission === "string"
              ? {
                  permission: replaceAudience(
                    widget.permission,
                    previous.name,
                    next.name,
                  ),
                }
              : {}),
          },
    ),
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
    ...(typeof dashboard.permission === "string" &&
    !canonicalWidgetAudienceIsPresent(dashboard)
      ? {
          permission: replaceAudience(
            dashboard.permission,
            previous.name,
            next.name,
          ),
        }
      : {}),
    ...(typeof dashboard.audience === "string"
      ? {
          audience: replaceAudience(
            dashboard.audience,
            previous.name,
            next.name,
          ),
        }
      : {}),
    widgets: dashboard.widgets.map((widget) => ({
      ...widget,
      ...(typeof widget.permission === "string" &&
      !canonicalWidgetAudienceIsPresent(widget)
        ? {
            permission: replaceAudience(
              widget.permission,
              previous.name,
              next.name,
            ),
          }
        : {}),
      ...(typeof widget.audience === "string"
        ? {
            audience: replaceAudience(
              widget.audience,
              previous.name,
              next.name,
            ),
          }
        : {}),
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
    owners.boards.some((board) => {
      const visibility = boardVisibility(board);
      const boardRoleReference = visibility.present
        ? visibility.ids.includes(role.id)
        : legacyBoardRoles(board).some((audience) =>
            audienceReferencesRole(audience, role),
          );
      return (
        boardRoleReference ||
        board.widgets.some((widget) =>
          audienceReferencesRole(ownerAudience(widget), role),
        )
      );
    })
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
        audienceReferencesRole(ownerAudience(dashboard), role) ||
        dashboard.widgets.some((widget) =>
          audienceReferencesRole(ownerAudience(widget), role),
        ),
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
): FederatedBoard | undefined {
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
      roleById(roles, subjectRoleId) !== undefined &&
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
        roleById(roles, subjectRoleId) !== undefined
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
    const role =
      input.subject.kind === "role"
        ? roleById(roles, input.subject.id)
        : undefined;
    const board = resolveBoard(projected, input.scope);
    if (!role || !board)
      return {
        ok: false,
        classification: "invalid",
        reason: "The board role or scope is unknown.",
      };
    const visibility = boardVisibility(board);
    if (visibility.present) {
      setCanonicalBoardRoles(
        board,
        input.decision === "allow"
          ? [...visibility.ids, role.id]
          : visibility.ids.filter((roleId) => roleId !== role.id),
      );
    } else {
      const legacyRoles = legacyBoardRoles(board);
      setLegacyBoardRoles(
        board,
        input.decision === "allow"
          ? [...legacyRoles, role.name]
          : legacyRoles.filter((label) => label !== role.name),
      );
    }
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
  lookup: FederatedAudienceLookup,
  owner: FederatedOwnerKey,
  targetId: string,
  audience: unknown,
): void {
  const resolved = resolveAudience(audience, lookup);
  if (resolved.valid) return;
  findings.push({
    id: `federated:${owner}:audience:${targetId}`,
    kind: "invalid-reference",
    severity: "critical",
    title: "Federated audience is unknown",
    detail: `${owner} references ${resolved.label}; the audience is treated as private and has no writable authority.`,
    targetId,
  });
}

function reportScopeId(report: FederatedReport): string {
  const stableId = report.id?.trim();
  return stableId || slug(report.name);
}

function audienceLookup(
  roles: readonly Role[] | FederatedAudienceLookup,
  identities: readonly FederatedAudienceIdentity[] | undefined,
): FederatedAudienceLookup {
  if (Array.isArray(roles)) return { roles, identities };
  const lookup = roles as FederatedAudienceLookup;
  return {
    roles: lookup.roles ?? [],
    identities: lookup.identities,
    departments: lookup.departments,
  };
}

export function getFederatedAccess(
  owners: FederatedAccessOwners,
  roles: readonly Role[] | FederatedAudienceLookup,
  identities?: readonly FederatedAudienceIdentity[],
): FederatedAccessProjection {
  const lookup = audienceLookup(roles, identities);
  const knownRoles = lookup.roles ?? [];
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
    const visibility = boardVisibility(board);
    if (visibility.malformed) {
      findings.push({
        id: `federated:board-role:${board.id}:malformed`,
        kind: "invalid-reference",
        severity: "critical",
        title: "Board role references are malformed",
        detail:
          `${board.name} has an invalid canonical role-id list. ` +
          "The board is treated as having no role grants.",
        targetId: board.id,
      });
    }
    if (visibility.present) {
      for (const roleId of visibility.ids) {
        const role = roleById(knownRoles, roleId);
        if (!role) {
          findings.push({
            id: `federated:board-role:${board.id}:${slug(roleId)}`,
            kind: "invalid-reference",
            severity: "critical",
            title: "Board role reference is unknown",
            detail: `${board.name} references the unknown or deleted role id ${roleId}.`,
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
    } else {
      for (const label of legacyBoardRoles(board)) {
        const role = roleByLabel(knownRoles, label);
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
        lookup,
        "boards-list",
        widget.id,
        ownerAudience(widget),
      );
    }
  }

  for (const announcement of owners.announcements)
    addUnknownAudienceFinding(
      findings,
      lookup,
      "boards-announcements",
      announcement.id,
      announcement.audience,
    );

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
      lookup,
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
      lookup,
      "views-dashboards",
      dashboard.id,
      ownerAudience(dashboard),
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
        lookup,
        "views-dashboards",
        widget.id,
        ownerAudience(widget),
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
    lookup,
    "views-report-draft",
    "report-draft",
    owners.reportDraft.audience,
  );
  const reportScopeIds = owners.reportTemplates.map(reportScopeId);
  const reportedAmbiguousTemplates = new Set<string>();
  for (const report of owners.reportTemplates) {
    const id = reportScopeId(report);
    if (
      !id ||
      reportScopeIds.filter((candidate) => candidate === id).length !== 1
    ) {
      const findingId = id || "empty";
      if (!reportedAmbiguousTemplates.has(findingId)) {
        reportedAmbiguousTemplates.add(findingId);
        findings.push({
          id: `federated:report-template:ambiguous:${findingId}`,
          kind: "conflict",
          severity: "critical",
          title: "Report template scope is ambiguous",
          detail:
            "Report template ids must be unique to expose stable Access scopes.",
          targetId: report.id ?? report.name,
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
      lookup,
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
        roleById(knownRoles, subject.id) === undefined
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
