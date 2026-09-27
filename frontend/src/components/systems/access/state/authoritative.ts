import {
  getAccessDefaults,
  getAccessGroup,
  getAccessServiceIdentity,
  listAccessCapabilities,
  listAccessDepartments,
  listAccessGroups,
  listAccessPolicyRules,
  listAccessRoles,
  listAccessServiceIdentities,
  listAccessUsers,
  type AccessCapability,
  type AccessDefaults as ApiAccessDefaults,
  type AccessDepartment,
  type AccessGroup as ApiAccessGroup,
  type AccessPage,
  type AccessPolicyRule,
  type AccessRole,
  type AccessServiceIdentity,
  type AccessUser,
  type AccessVersioned,
} from "./api";
import type { Person, Role } from "../domain/model";
import type {
  AccessDefaults,
  AccessGroup,
  ServiceIdentity,
} from "../domain/policy";
import type {
  AccessControllerSnapshot,
  ManagedGuestIdentity,
  ScopeCatalogEntry,
} from "../domain/controller-utils";

// The API names built-in roles by their keys; people read these names. A Map
// has no inherited keys, so a custom role named "constructor" or "toString"
// is never read as built-in.
const SYSTEM_ROLE_NAMES: ReadonlyMap<string, string> = new Map([
  ["admin", "Administrator"],
  ["member", "Member"],
]);
export const ACCESS_PAGE_LIMIT = 100;
export const ACCESS_PAGE_MAXIMUM = 20;
const VERSION_READ_CONCURRENCY = 8;

export class AuthoritativeAccessLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthoritativeAccessLoadError";
  }
}

type PageRequest = { limit: number; offset: number; signal?: AbortSignal };
type PageReader<Item extends { id: string }> = (
  request: PageRequest,
) => Promise<AccessPage<Item>>;
type DepartmentPageReader = (
  request: PageRequest & { deleted: "include" },
) => Promise<AccessPage<AccessDepartment>>;
type VersionedPageReader<Item extends { id: string }> = (
  request: PageRequest,
) => Promise<AccessVersioned<AccessPage<Item>>>;

export type AuthoritativeAccessVersions = {
  defaults: string;
  groups: Record<string, string>;
  services: Record<string, string>;
  policy: string;
  ruleSubjectKinds: Record<string, AccessPolicyRule["subject_kind"]>;
};

export type AuthoritativeAccessResources = {
  capabilities: AccessCapability[];
  users: AccessUser[];
  roles: AccessRole[];
  departments: AccessDepartment[];
  groups: ApiAccessGroup[];
  defaults: AccessVersioned<ApiAccessDefaults>;
  services: AccessServiceIdentity[];
  rules: AccessPolicyRule[];
  groupEtags: Record<string, string>;
  serviceEtags: Record<string, string>;
  policyEtag: string;
};

export type AuthoritativeAccessSnapshot = {
  snapshot: AccessControllerSnapshot;
  versions: AuthoritativeAccessVersions;
  capabilities: AccessCapability[];
  departments: AccessDepartment[];
};

export type AuthoritativeAccessAdapters = {
  capabilities: (options: {
    signal?: AbortSignal;
  }) => Promise<{ items: AccessCapability[] }>;
  users: PageReader<AccessUser>;
  roles: PageReader<AccessRole>;
  departments: DepartmentPageReader;
  groups: PageReader<ApiAccessGroup>;
  defaults: (options: {
    signal?: AbortSignal;
  }) => Promise<AccessVersioned<ApiAccessDefaults>>;
  services: PageReader<AccessServiceIdentity>;
  group: (
    id: string,
    options: { signal?: AbortSignal },
  ) => Promise<AccessVersioned<ApiAccessGroup>>;
  service: (
    id: string,
    options: { signal?: AbortSignal },
  ) => Promise<AccessVersioned<AccessServiceIdentity>>;
  rules: VersionedPageReader<AccessPolicyRule>;
};

const accessAdapters: AuthoritativeAccessAdapters = {
  capabilities: listAccessCapabilities,
  users: listAccessUsers,
  roles: listAccessRoles,
  departments: listAccessDepartments,
  groups: listAccessGroups,
  defaults: getAccessDefaults,
  services: listAccessServiceIdentities,
  group: getAccessGroup,
  service: getAccessServiceIdentity,
  rules: listAccessPolicyRules,
};

export async function loadAllAccessPages<Item extends { id: string }>(
  read: PageReader<Item>,
  options: { signal?: AbortSignal; maximumPages?: number } = {},
): Promise<Item[]> {
  const maximumPages = options.maximumPages ?? ACCESS_PAGE_MAXIMUM;
  if (!Number.isInteger(maximumPages) || maximumPages < 1) {
    throw new AuthoritativeAccessLoadError("Access page limit is invalid.");
  }
  const seenOffsets = new Set<number>();
  const seenIds = new Set<string>();
  const items: Item[] = [];
  let expectedTotal: number | null = null;
  let offset = 0;

  for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
    throwIfAborted(options.signal);
    if (seenOffsets.has(offset)) {
      throw new AuthoritativeAccessLoadError(
        "Access pagination repeated an offset.",
      );
    }
    seenOffsets.add(offset);
    const page = await read({
      limit: ACCESS_PAGE_LIMIT,
      offset,
      signal: options.signal,
    });
    throwIfAborted(options.signal);
    const pagination = page.pagination;
    if (
      pagination.limit !== ACCESS_PAGE_LIMIT ||
      pagination.offset !== offset ||
      pagination.count !== page.items.length ||
      pagination.count > ACCESS_PAGE_LIMIT ||
      pagination.total < pagination.count
    ) {
      throw new AuthoritativeAccessLoadError(
        "Access pagination response is inconsistent.",
      );
    }
    if (expectedTotal === null) expectedTotal = pagination.total;
    if (pagination.total !== expectedTotal) {
      throw new AuthoritativeAccessLoadError(
        "Access pagination total changed during loading.",
      );
    }
    for (const item of page.items) {
      if (seenIds.has(item.id)) {
        throw new AuthoritativeAccessLoadError(
          "Access pagination repeated an item.",
        );
      }
      seenIds.add(item.id);
      items.push(item);
    }
    const nextOffset = offset + pagination.count;
    if (pagination.has_more !== nextOffset < pagination.total) {
      throw new AuthoritativeAccessLoadError(
        "Access pagination continuation is inconsistent.",
      );
    }
    if (!pagination.has_more) {
      if (nextOffset !== pagination.total) {
        throw new AuthoritativeAccessLoadError(
          "Access pagination ended before its total.",
        );
      }
      return items;
    }
    if (nextOffset <= offset) {
      throw new AuthoritativeAccessLoadError(
        "Access pagination did not progress.",
      );
    }
    offset = nextOffset;
  }
  throw new AuthoritativeAccessLoadError(
    "Access pagination exceeded its safe page limit.",
  );
}

export async function loadAllVersionedAccessPages<Item extends { id: string }>(
  read: VersionedPageReader<Item>,
  options: { signal?: AbortSignal; maximumPages?: number } = {},
): Promise<AccessVersioned<Item[]>> {
  const maximumPages = options.maximumPages ?? ACCESS_PAGE_MAXIMUM;
  if (!Number.isInteger(maximumPages) || maximumPages < 1)
    throw new AuthoritativeAccessLoadError("Access page limit is invalid.");

  const seenOffsets = new Set<number>();
  const seenIds = new Set<string>();
  const items: Item[] = [];
  let expectedTotal: number | null = null;
  let etag: string | null = null;
  let offset = 0;
  for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
    throwIfAborted(options.signal);
    if (seenOffsets.has(offset))
      throw new AuthoritativeAccessLoadError(
        "Access pagination repeated an offset.",
      );
    seenOffsets.add(offset);
    const versioned = await read({
      limit: ACCESS_PAGE_LIMIT,
      offset,
      signal: options.signal,
    });
    throwIfAborted(options.signal);
    if (!versioned.etag.trim())
      throw new AuthoritativeAccessLoadError(
        "Access policy version is unavailable.",
      );
    if (etag === null) etag = versioned.etag;
    else if (etag !== versioned.etag)
      throw new AuthoritativeAccessLoadError(
        "Access policy changed during pagination. Reload Access and try again.",
      );
    const page = versioned.data;
    const pagination = page.pagination;
    if (
      pagination.limit !== ACCESS_PAGE_LIMIT ||
      pagination.offset !== offset ||
      pagination.count !== page.items.length ||
      pagination.count > ACCESS_PAGE_LIMIT ||
      pagination.total < pagination.count
    )
      throw new AuthoritativeAccessLoadError(
        "Access pagination response is inconsistent.",
      );
    if (expectedTotal === null) expectedTotal = pagination.total;
    if (pagination.total !== expectedTotal)
      throw new AuthoritativeAccessLoadError(
        "Access pagination total changed during loading.",
      );
    for (const item of page.items) {
      if (seenIds.has(item.id))
        throw new AuthoritativeAccessLoadError(
          "Access pagination repeated an item.",
        );
      seenIds.add(item.id);
      items.push(item);
    }
    const nextOffset = offset + pagination.count;
    if (pagination.has_more !== nextOffset < pagination.total)
      throw new AuthoritativeAccessLoadError(
        "Access pagination continuation is inconsistent.",
      );
    if (!pagination.has_more) {
      if (nextOffset !== pagination.total)
        throw new AuthoritativeAccessLoadError(
          "Access pagination ended before its total.",
        );
      return { data: items, etag: etag ?? versioned.etag };
    }
    if (nextOffset <= offset)
      throw new AuthoritativeAccessLoadError(
        "Access pagination did not progress.",
      );
    offset = nextOffset;
  }
  throw new AuthoritativeAccessLoadError(
    "Access pagination exceeded its safe page limit.",
  );
}

export async function loadAuthoritativeAccessSnapshot(
  options: { signal?: AbortSignal } = {},
  adapters: AuthoritativeAccessAdapters = accessAdapters,
): Promise<AuthoritativeAccessSnapshot> {
  const [
    capabilities,
    users,
    roles,
    departments,
    groups,
    defaults,
    services,
    rules,
  ] = await Promise.all([
    adapters.capabilities(options),
    loadAllAccessPages(adapters.users, options),
    loadAllAccessPages(adapters.roles, options),
    loadAllAccessPages(
      (request) => adapters.departments({ ...request, deleted: "include" }),
      options,
    ),
    loadAllAccessPages(adapters.groups, options),
    adapters.defaults(options),
    loadAllAccessPages(adapters.services, options),
    loadAllVersionedAccessPages(adapters.rules, options),
  ]);
  const [groupDetails, serviceDetails] = await Promise.all([
    loadVersionedAccessDetails(groups, adapters.group, options),
    loadVersionedAccessDetails(services, adapters.service, options),
  ]);
  return mapAuthoritativeAccessSnapshot({
    capabilities: capabilities.items,
    users,
    roles,
    departments,
    groups: groupDetails.items,
    defaults,
    services: serviceDetails.items,
    rules: rules.data,
    groupEtags: groupDetails.etags,
    serviceEtags: serviceDetails.etags,
    policyEtag: rules.etag,
  });
}

export function mapAuthoritativeAccessSnapshot(
  resources: AuthoritativeAccessResources,
): AuthoritativeAccessSnapshot {
  const departmentNames = new Map(
    resources.departments.map((department) => [
      department.id,
      department.department_name,
    ]),
  );
  const groupIdsByUser = new Map<string, string[]>();
  const groups = resources.groups
    .filter((group) => !group.is_deleted)
    .map((group) => {
      for (const userId of group.member_ids) {
        const current = groupIdsByUser.get(userId) ?? [];
        current.push(group.id);
        groupIdsByUser.set(userId, current);
      }
      return {
        id: group.id,
        name: group.name,
        description: group.description,
        memberIds: [...group.member_ids],
      } satisfies AccessGroup;
    });
  const people: Person[] = [];
  const guests: ManagedGuestIdentity[] = [];
  for (const user of resources.users) {
    if (user.is_deleted) continue;
    const status =
      user.status === "pending" && user.invitation_sent_at === null
        ? "revoked"
        : user.status;
    const groupIds = [...(groupIdsByUser.get(user.id) ?? [])];
    if (user.identity_kind === "guest") {
      guests.push({
        kind: "guest",
        id: user.id,
        name: user.display_name ?? user.username,
        email: user.email,
        status,
        roleId: user.role_id,
        groupIds,
        sponsorId: requiredValue(user.sponsor_user_id, "Guest sponsor"),
        expiresAt: requiredValue(user.expires_at, "Guest expiry"),
        invitation: { sentAt: user.invitation_sent_at ?? "", resendCount: 0 },
      });
      continue;
    }
    people.push({
      id: user.id,
      name: user.display_name ?? user.username,
      email: user.email,
      role: user.role_id,
      active: status === "active",
      accessStatus: status,
      departments: user.department_ids.map((id) =>
        departmentName(departmentNames, id),
      ),
      primary: user.primary_department_id
        ? departmentName(departmentNames, user.primary_department_id)
        : "",
      departmentIds: [...user.department_ids],
      primaryDepartmentId: user.primary_department_id ?? "",
      title: user.job_title ?? "",
      activity: [],
      groupIds,
      ...(user.expires_at ? { expiresAt: user.expires_at } : {}),
    });
  }
  const roles = resources.roles
    .filter((role) => !role.is_deleted)
    .map((role) => ({
      id: role.id,
      name: SYSTEM_ROLE_NAMES.get(role.role) ?? role.role,
      ...(SYSTEM_ROLE_NAMES.has(role.role)
        ? { system: role.role as "admin" | "member" }
        : {}),
      ...(role.description ? { description: role.description } : {}),
      builtin: SYSTEM_ROLE_NAMES.has(role.role),
      grants:
        role.role === "admin"
          ? resources.capabilities.map((capability) => capability.id)
          : Object.entries(role.permissions)
              .filter(([, granted]) => granted)
              .map(([id]) => id),
    })) satisfies Role[];
  const services = resources.services
    .filter((service) => !service.is_deleted)
    .map((service): ServiceIdentity => ({
      kind: "service",
      id: service.id,
      name: service.name,
      status: service.status,
      effectiveStatus: service.effective_status,
      roleId: service.role_id,
      groupIds: [],
      ownerId: service.owner_id,
      purpose: service.purpose,
      expiresAt: service.expires_at,
    }));
  const rules = resources.rules
    .filter((rule) => !rule.is_deleted)
    .map((rule) => mapAccessPolicyRule(rule));
  const snapshot: AccessControllerSnapshot = {
    people,
    roles,
    guests,
    services,
    groups,
    rules,
    defaults: mapDefaults(resources.defaults.data),
    templates: [],
    reviews: [],
    deletedIdentities: [],
    sessions: [],
    history: [],
    federatedScopes: [],
  };
  return {
    snapshot,
    versions: {
      defaults: resources.defaults.etag,
      groups: { ...resources.groupEtags },
      services: { ...resources.serviceEtags },
      policy: resources.policyEtag,
      ruleSubjectKinds: Object.fromEntries(
        resources.rules.map((rule) => [rule.id, rule.subject_kind]),
      ),
    },
    capabilities: resources.capabilities.map((capability) => ({
      ...capability,
    })),
    departments: resources.departments
      .filter((department) => !department.is_deleted)
      .map((department) => ({ ...department })),
  };
}

export function mapAuthoritativeScopeCatalog(): ScopeCatalogEntry[] {
  return [
    {
      kind: "workspace",
      id: "workspace",
      name: "Workspace",
      product: "Sandbox/core",
    },
  ];
}

function mapDefaults(defaults: ApiAccessDefaults): AccessDefaults {
  if (
    defaults.is_deleted ||
    defaults.default_deny !== true ||
    defaults.require_guest_sponsor !== true ||
    defaults.require_service_owner !== true
  ) {
    throw new AuthoritativeAccessLoadError(
      "Access defaults are not protected.",
    );
  }
  return {
    defaultRoleId: defaults.default_role_id,
    defaultDepartmentIds: [...defaults.department_ids],
    defaultGroupIds: [...defaults.group_ids],
    invitationExpiryDays: defaults.invitation_expiry_days,
    guestDurationDays: defaults.guest_duration_days,
    serviceDurationDays: defaults.service_duration_days,
    defaultDeny: true,
    requireGuestSponsor: true,
    requireServiceOwner: true,
  };
}

function mapAccessPolicyRule(
  rule: AccessPolicyRule,
): import("../domain/policy").AccessRule {
  const subject =
    rule.subject_kind === "everyone"
      ? { kind: "everyone" as const }
      : rule.subject_kind === "role" || rule.subject_kind === "group"
        ? {
            kind: rule.subject_kind,
            id: requiredValue(rule.subject_id, "Rule subject"),
          }
        : {
            kind: "identity" as const,
            id: requiredValue(rule.subject_id, "Rule subject"),
          };
  const scope =
    rule.scope_kind === "workspace"
      ? { kind: "workspace" as const, id: "workspace" }
      : {
          kind: rule.scope_kind,
          id: requiredValue(rule.scope_id, "Rule scope"),
        };
  return {
    id: rule.id,
    subject,
    scope,
    permissionId: rule.permission_id,
    decision: rule.decision,
    locked: rule.locked,
    ...(rule.starts_at ? { startsAt: rule.starts_at } : {}),
    ...(rule.ends_at ? { endsAt: rule.ends_at } : {}),
  };
}

export async function loadVersionedAccessDetails<Item extends { id: string }>(
  items: readonly Item[],
  read: (
    id: string,
    options: { signal?: AbortSignal },
  ) => Promise<AccessVersioned<Item>>,
  options: { signal?: AbortSignal } = {},
): Promise<{ items: Item[]; etags: Record<string, string> }> {
  const result: Item[] = [];
  const etags: Record<string, string> = {};
  for (let index = 0; index < items.length; index += VERSION_READ_CONCURRENCY) {
    throwIfAborted(options.signal);
    const batch = items.slice(index, index + VERSION_READ_CONCURRENCY);
    const versions = await Promise.all(
      batch.map((item) =>
        read(item.id, { signal: options.signal }).then((version) => ({
          item,
          version,
        })),
      ),
    );
    throwIfAborted(options.signal);
    for (const { item, version } of versions) {
      if (
        version.data.id !== item.id ||
        typeof version.etag !== "string" ||
        !version.etag.trim()
      ) {
        throw new AuthoritativeAccessLoadError(
          "Access resource detail is inconsistent.",
        );
      }
      result.push(version.data);
      etags[item.id] = version.etag;
    }
  }
  return { items: result, etags };
}

function departmentName(names: Map<string, string>, id: string): string {
  const name = names.get(id);
  if (!name)
    throw new AuthoritativeAccessLoadError("Access department is unavailable.");
  return name;
}

function requiredValue(value: string | null, label: string): string {
  if (value === null)
    throw new AuthoritativeAccessLoadError(`${label} is unavailable.`);
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException("The operation was aborted.", "AbortError");
}
