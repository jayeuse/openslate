import { ApiContractError, ApiError } from "@/lib/api";
import {
  formatWorkspaceDate,
  formatWorkspaceDateTime,
  type WorkspaceRegion,
} from "@/lib/date-time";
import {
  INACTIVE_DAYS_DEFAULT,
  INACTIVE_DAYS_MIN,
  INACTIVE_DAYS_MAX,
} from "../state/api-contracts";

import type {
  AccessDepartment,
  AccessGroup,
  AccessInvitationSettings,
  AccessLevel,
  AccessModule,
  AccessUser,
  AccessUserAccess,
  AccessUserPatch,
  AccessUserRole,
  AccessUserListOptions,
} from "../state/api-contracts";
import {
  hasThreeWayConflict,
  resolveThreeWayValue,
  type ConflictChoice,
  type FieldConflict,
} from "./editor-helpers";

// Pure rules for the People screens: the directory rows and filters, guest
// expiry, the person editor's draft and patch, and the effective-access view.

export const roleLabels: Record<AccessUserRole, string> = {
  admin: "Administrator",
  member: "Member",
  guest: "Guest",
};

export const levelLabels: Record<AccessLevel, string> = {
  read: "Read",
  write: "Write",
  manage: "Manage",
};

const levelRank: Record<AccessLevel, number> = { read: 1, write: 2, manage: 3 };

/** A guest whose access ends within this many days is flagged. */
export const EXPIRING_SOON_DAYS = 14;
const DAY_MS = 86_400_000;

export function personName(
  user: Pick<AccessUser, "display_name" | "username">,
) {
  return user.display_name?.trim() || user.username;
}

export type PersonStateId =
  "pending" | "active" | "disabled" | "expired" | "deleted";
export type PersonState = {
  id: PersonStateId;
  label: string;
  tone: "success" | "warning" | "secondary" | "outline";
  expiresSoon: boolean;
};

const stateLabels: Record<PersonStateId, string> = {
  pending: "Pending",
  active: "Active",
  disabled: "Disabled",
  expired: "Expired",
  deleted: "Deleted",
};
const stateTones: Record<PersonStateId, PersonState["tone"]> = {
  pending: "warning",
  active: "success",
  disabled: "secondary",
  expired: "outline",
  deleted: "outline",
};

function expiryTime(user: Pick<AccessUser, "expires_at">): number | null {
  if (!user.expires_at) return null;
  const time = Date.parse(user.expires_at);
  return Number.isFinite(time) ? time : null;
}

/** The one status a person shows: deleted and expired win over the stored status. */
export function personState(
  user: Pick<AccessUser, "status" | "is_deleted" | "expires_at">,
  now: number,
): PersonState {
  const expiry = expiryTime(user);
  const id: PersonStateId = user.is_deleted
    ? "deleted"
    : expiry !== null && expiry <= now
      ? "expired"
      : user.status;
  const expiresSoon =
    (id === "active" || id === "pending") &&
    expiry !== null &&
    expiry - now <= EXPIRING_SOON_DAYS * DAY_MS;
  return { id, label: stateLabels[id], tone: stateTones[id], expiresSoon };
}

export type NamedItem = { id: string; name: string };

export type DirectoryRow<User extends AccessUser = AccessUser> = {
  user: User;
  name: string;
  state: PersonState;
  groups: NamedItem[];
  /** Departments reached through the person's groups, by name. */
  departments: NamedItem[];
  /** Administrators reach every department without groups. */
  allDepartments: boolean;
};

function byName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
  });
}

export function groupsOf(
  userId: string,
  groups: readonly AccessGroup[],
): AccessGroup[] {
  return groups
    .filter((group) => group.member_ids.includes(userId))
    .sort((left, right) => byName(left, right));
}

/** Departments a set of groups reaches. Unknown departments are left out. */
export function departmentsOf(
  groups: readonly AccessGroup[],
  departments: readonly AccessDepartment[],
): NamedItem[] {
  const names = new Map(
    departments.map((department) => [
      department.id,
      department.department_name,
    ]),
  );
  const reached = new Map<string, string>();
  for (const group of groups)
    for (const entry of group.access) {
      const name = names.get(entry.department_id);
      if (name !== undefined) reached.set(entry.department_id, name);
    }
  return [...reached].map(([id, name]) => ({ id, name })).sort(byName);
}

export function directoryRows<User extends AccessUser>(
  users: readonly User[],
  groups: readonly AccessGroup[],
  departments: readonly AccessDepartment[],
  now: number,
): DirectoryRow<User>[] {
  return users.map((user) => {
    const admin = user.role === "admin";
    const memberOf = admin ? [] : groupsOf(user.id, groups);
    return {
      user,
      name: personName(user),
      state: personState(user, now),
      groups: memberOf.map((group) => ({ id: group.id, name: group.name })),
      departments: admin ? [] : departmentsOf(memberOf, departments),
      allDepartments: admin,
    };
  });
}

export type DirectorySort = "name" | "email" | "newest" | "expiry";
/** "ending": active or pending people whose access ends soon. */
export type DirectoryStatusFilter =
  "current" | "all" | "ending" | PersonStateId;
export type DirectoryFilters = {
  query: string;
  role: "all" | AccessUserRole;
  status: DirectoryStatusFilter;
  /** A group id, "none" for people in no group, or "all". */
  groupId: string;
  departmentId: string;
  sort: DirectorySort;
  mfa?: "all" | "without" | "unknown";
  history?: "all" | "no-recorded-sign-in" | "inactive";
  inactiveDays?: number;
};

export const defaultDirectoryFilters: DirectoryFilters = {
  query: "",
  role: "all",
  status: "current",
  groupId: "all",
  departmentId: "all",
  sort: "name",
  mfa: "all",
  history: "all",
  inactiveDays: INACTIVE_DAYS_DEFAULT,
};

const directorySorts: readonly DirectorySort[] = [
  "name",
  "email",
  "newest",
  "expiry",
];
const directoryStatuses: readonly DirectoryStatusFilter[] = [
  "current",
  "all",
  "ending",
  "pending",
  "active",
  "disabled",
  "expired",
  "deleted",
];

function oneOf<T extends string>(
  values: readonly T[],
  value: string | null,
  fallback: T,
): T {
  return values.find((item) => item === value) ?? fallback;
}

/**
 * The directory filters a link asks for (`role`, `status`, `group`,
 * `department`, `sort`). Unknown values keep the default.
 */
export function directoryFiltersFromParams(
  params: URLSearchParams,
): DirectoryFilters {
  const role = params.get("role");
  return {
    ...defaultDirectoryFilters,
    role:
      role === "admin" || role === "member" || role === "guest" ? role : "all",
    status: oneOf(directoryStatuses, params.get("status"), "current"),
    groupId: params.get("group") ?? "all",
    departmentId: params.get("department") ?? "all",
    sort: oneOf(directorySorts, params.get("sort"), "name"),
    mfa: oneOf(
      ["all", "without", "unknown"] as const,
      params.get("mfa"),
      "all",
    ),
    history: oneOf(
      ["all", "no-recorded-sign-in", "inactive"] as const,
      params.get("history"),
      "all",
    ),
    inactiveDays:
      parseInactiveDays(params.get("inactive_days") ?? "") ??
      INACTIVE_DAYS_DEFAULT,
  };
}

/** The status quick filters beside the People search, in order. */
export const quickStatusFilters: readonly {
  label: string;
  status: DirectoryStatusFilter;
}[] = [
  { label: "All", status: "current" },
  { label: "Active", status: "active" },
  { label: "Invited", status: "pending" },
  { label: "Ending soon", status: "ending" },
  { label: "Disabled", status: "disabled" },
];

/** The rare statuses under the strip's More menu, in order. */
export const rareStatusFilters: readonly {
  label: string;
  status: DirectoryStatusFilter;
}[] = [
  { label: "Expired", status: "expired" },
  { label: "Deleted", status: "deleted" },
  { label: "Everyone", status: "all" },
];

/**
 * The URL parameters that keep the directory filters, defaults left out.
 * The inverse of `directoryFiltersFromParams`; the search text stays out.
 */
export function directoryParams(filters: DirectoryFilters): [string, string][] {
  const history = filters.history ?? "all";
  const days = filters.inactiveDays ?? INACTIVE_DAYS_DEFAULT;
  const params: [string, string | null][] = [
    ["role", filters.role === "all" ? null : filters.role],
    ["status", filters.status === "current" ? null : filters.status],
    ["group", filters.groupId === "all" ? null : filters.groupId],
    [
      "department",
      filters.departmentId === "all" ? null : filters.departmentId,
    ],
    ["sort", filters.sort === "name" ? null : filters.sort],
    ["mfa", !filters.mfa || filters.mfa === "all" ? null : filters.mfa],
    ["history", history === "all" ? null : history],
    ["inactive_days", history === "inactive" ? String(days) : null],
  ];
  return params.filter((entry): entry is [string, string] => entry[1] !== null);
}

const inactiveFor = (days: number) =>
  `Inactive ${days} ${days === 1 ? "day" : "days"}`;

/** One removable chip for an active Filters filter. */
export type DirectoryFilterChip = {
  key: "role" | "group" | "department" | "mfa" | "history";
  label: string;
  value: string;
  /** The patch that clears this filter only. */
  clear: Partial<DirectoryFilters>;
};

/**
 * The active Filters filters as chips, in the order of the Filters rows.
 * The search and the strip's status are not chips. `names` holds the group
 * and department names once they are read.
 */
export function directoryFilterChips(
  filters: DirectoryFilters,
  names: { group?: string; department?: string },
): DirectoryFilterChip[] {
  const chips: DirectoryFilterChip[] = [];
  if (filters.role !== "all")
    chips.push({
      key: "role",
      label: "Role",
      value: roleLabels[filters.role],
      clear: { role: "all" },
    });
  if (filters.groupId !== "all")
    chips.push({
      key: "group",
      label: "Group",
      value:
        filters.groupId === "none"
          ? "In no group"
          : (names.group ?? "Selected group"),
      clear: { groupId: "all" },
    });
  if (filters.departmentId !== "all")
    chips.push({
      key: "department",
      label: "Department",
      value: names.department ?? "Selected department",
      clear: { departmentId: "all" },
    });
  if (filters.mfa && filters.mfa !== "all")
    chips.push({
      key: "mfa",
      label: "Two-step",
      // The filter finds administrators only, as its select says.
      value:
        filters.mfa === "without"
          ? "Off (administrators)"
          : "Unknown (administrators)",
      clear: { mfa: "all" },
    });
  if (filters.history && filters.history !== "all")
    chips.push({
      key: "history",
      label: "Activity",
      value:
        filters.history === "no-recorded-sign-in"
          ? "No recorded sign-in"
          : inactiveFor(filters.inactiveDays ?? INACTIVE_DAYS_DEFAULT),
      clear: { history: "all" },
    });
  return chips;
}

/** The number on the Filters button: one per chip. */
export function activeFilterCount(filters: DirectoryFilters): number {
  return directoryFilterChips(filters, {}).length;
}

/** Clear all: every Filters filter; the search, status and sort stay. */
export function clearedDirectoryFilters(
  filters: DirectoryFilters,
): DirectoryFilters {
  return {
    ...defaultDirectoryFilters,
    query: filters.query,
    status: filters.status,
    sort: filters.sort,
  };
}

/** Predicates belong to the server, before its total and page window. */
export function directoryRequest(
  filters: DirectoryFilters,
  limit: number,
  offset: number,
): AccessUserListOptions {
  return {
    limit,
    offset,
    search: filters.query.trim() || undefined,
    role: filters.role === "all" ? undefined : filters.role,
    deleted:
      filters.status === "all"
        ? "include"
        : filters.status === "deleted"
          ? "only"
          : "exclude",
    status:
      filters.status === "current" ||
      filters.status === "all" ||
      filters.status === "deleted"
        ? undefined
        : filters.status,
    group_id: filters.groupId === "all" ? undefined : filters.groupId,
    department_id:
      filters.departmentId === "all" ? undefined : filters.departmentId,
    mfa: filters.mfa === "all" ? undefined : filters.mfa,
    history: filters.history === "all" ? undefined : filters.history,
    inactive_days:
      filters.history === "inactive"
        ? (filters.inactiveDays ?? INACTIVE_DAYS_DEFAULT)
        : undefined,
    sort_by:
      filters.sort === "newest"
        ? "created_at"
        : filters.sort === "expiry"
          ? "expires_at"
          : filters.sort,
    sort_order: filters.sort === "newest" ? "desc" : "asc",
  };
}

// Row words

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

/** The later of a person's recorded sign-in and recorded activity. */
export function lastSeenAt(person: {
  last_active_at: string | null;
  last_sign_in_at: string | null;
}): string | null {
  const { last_active_at: active, last_sign_in_at: signIn } = person;
  if (!active || !signIn) return active ?? signIn;
  return Date.parse(active) >= Date.parse(signIn) ? active : signIn;
}

/**
 * Relative last activity ("3 hours ago"). No record says so; it never
 * claims that a person has not signed in.
 */
export function lastActiveLabel(value: string | null, now: number): string {
  const time = value === null ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(time)) return "Not recorded";
  const seconds = Math.max(0, (now - time) / 1000);
  if (seconds < 60) return "Just now";
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86_400],
    ["week", 604_800],
    ["month", 2_629_800],
    ["year", 31_557_600],
  ];
  const limits = [3600, 86_400, 604_800, 2_629_800, 31_557_600, Infinity];
  const index = limits.findIndex((limit) => seconds < limit);
  const [unit, size] = steps[index]!;
  return capitalize(relative.format(-Math.round(seconds / size), unit));
}

/** The whole days left before a guest's access ends. */
export function endsInLabel(expiresAt: string, now: number): string {
  const left = Date.parse(expiresAt) - now;
  if (left < DAY_MS) return "Ends today";
  const days = Math.ceil(left / DAY_MS);
  return `Ends in ${days} ${days === 1 ? "day" : "days"}`;
}

// Guest expiry

/** The applied inactivity period, distinct from an incomplete input draft. */
export function parseInactiveDays(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const days = Number(value.trim());
  return days >= INACTIVE_DAYS_MIN && days <= INACTIVE_DAYS_MAX ? days : null;
}

export function inactiveDaysError(value: string): string | null {
  if (!value.trim()) return "Enter the number of days.";
  return parseInactiveDays(value) === null
    ? `Enter a whole number from ${INACTIVE_DAYS_MIN} to ${INACTIVE_DAYS_MAX}.`
    : null;
}

export const GUEST_DAYS_MIN = 1;
export const GUEST_DAYS_MAX = 365;

/** The invitation form's starting value: the workspace's guest duration. */
export function defaultGuestDays(
  settings: Pick<AccessInvitationSettings, "guest_duration_days"> | undefined,
): string {
  return settings ? String(settings.guest_duration_days) : "";
}

function guestDays(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const days = Number(value.trim());
  return days >= GUEST_DAYS_MIN && days <= GUEST_DAYS_MAX ? days : null;
}

export function guestDaysError(value: string): string | null {
  if (!value.trim()) return "Enter the number of days.";
  return guestDays(value) === null
    ? `Enter a whole number from ${GUEST_DAYS_MIN} to ${GUEST_DAYS_MAX}.`
    : null;
}

/** The expiry sent with a guest invitation: now plus the chosen days. */
export function guestExpiryFromDays(value: string, now: Date): string | null {
  const days = guestDays(value);
  return days === null
    ? null
    : new Date(now.valueOf() + days * DAY_MS).toISOString();
}

/** `YYYY-MM-DD` of an instant in local time, for a date input. */
export function dateInputValue(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The end of a local calendar day, so a chosen day is still in the future. */
export function endOfDateInput(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    23,
    59,
    59,
  );
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

export function formatDate(
  value: string | null,
  region?: WorkspaceRegion,
): string {
  if (!value) return "None";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "Unavailable";
  if (region) return formatWorkspaceDate(value, region);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    date,
  );
}

export function formatDateTime(
  value: string,
  region?: WorkspaceRegion,
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "Unavailable";
  if (region) return formatWorkspaceDateTime(value, region);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

// The person editor

/** The editable details of a person, as form values. */
export type PersonDraft = {
  username: string;
  display_name: string;
  job_title: string;
  role: AccessUserRole;
  sponsor_user_id: string;
  expires_on: string;
};
export type PersonDraftField = keyof PersonDraft;

export const personFieldLabels: Record<PersonDraftField, string> = {
  username: "Username",
  display_name: "Name",
  job_title: "Job title",
  role: "Role",
  sponsor_user_id: "Sponsor",
  expires_on: "Access ends",
};
const personFields = Object.keys(personFieldLabels) as PersonDraftField[];

export function draftFromUser(user: AccessUser): PersonDraft {
  return {
    username: user.username,
    display_name: user.display_name ?? "",
    job_title: user.job_title ?? "",
    role: user.role,
    sponsor_user_id: user.sponsor_user_id ?? "",
    expires_on: dateInputValue(user.expires_at),
  };
}

export function samePersonDraft(left: PersonDraft, right: PersonDraft) {
  return personFields.every((field) => left[field] === right[field]);
}

function optionalText(value: string): string | null {
  return value.trim() ? value.trim() : null;
}

/** The PATCH body for the fields that differ from `baseline`. */
export function personPatch(
  baseline: PersonDraft,
  draft: PersonDraft,
): AccessUserPatch {
  const patch: AccessUserPatch = {};
  const changed = (field: PersonDraftField) => baseline[field] !== draft[field];
  if (changed("username")) patch.username = draft.username.trim();
  if (changed("display_name"))
    patch.display_name = optionalText(draft.display_name);
  if (changed("job_title")) patch.job_title = optionalText(draft.job_title);
  if (changed("role") && draft.role !== "guest" && baseline.role !== "guest")
    patch.role = draft.role;
  if (draft.role === "guest") {
    if (changed("sponsor_user_id") && draft.sponsor_user_id)
      patch.sponsor_user_id = draft.sponsor_user_id;
    if (changed("expires_on")) {
      const expiresAt = endOfDateInput(draft.expires_on);
      if (expiresAt) patch.expires_at = expiresAt;
    }
  }
  return patch;
}

/** Fields where the saved person and the draft both moved away from the baseline. */
export function personConflicts(
  current: PersonDraft,
  baseline: PersonDraft,
  draft: PersonDraft,
  describe: (field: PersonDraftField, value: string) => string = (_, value) =>
    value,
): FieldConflict[] {
  return personFields
    .filter((field) =>
      hasThreeWayConflict(current[field], baseline[field], draft[field]),
    )
    .map((field) => ({
      id: field,
      label: personFieldLabels[field],
      current: describe(field, current[field]),
      draft: describe(field, draft[field]),
    }));
}

/** Merge the draft onto the saved person, using the chosen side on a conflict. */
export function resolvePersonDraft(
  current: PersonDraft,
  baseline: PersonDraft,
  draft: PersonDraft,
  choices: Record<string, ConflictChoice | undefined>,
): PersonDraft {
  const resolved = { ...current };
  for (const field of personFields) {
    const value = resolveThreeWayValue(
      current[field],
      baseline[field],
      draft[field],
      choices[field],
    );
    Object.assign(resolved, { [field]: value });
  }
  return resolved;
}

// Effective access

export type AccessSource = {
  groupId: string;
  name: string;
  level: AccessLevel;
  levelLabel: string;
};
export type AccessRow = {
  key: string;
  departmentId: string;
  departmentName: string;
  /** Null for an entry that covers the whole department. */
  moduleName: string | null;
  level: AccessLevel;
  levelLabel: string;
  sources: AccessSource[];
  /** A guest whose groups give more than the read limit. */
  capped: boolean;
};
export type AccessPresentation =
  | { kind: "full"; inactive: boolean }
  | {
      kind: "entries";
      inactive: boolean;
      guestCapped: boolean;
      rows: AccessRow[];
    };

export function presentAccess(
  access: AccessUserAccess,
  user: Pick<AccessUser, "status" | "is_deleted" | "expires_at">,
  departments: readonly AccessDepartment[],
  modules: readonly AccessModule[],
  now: number,
): AccessPresentation {
  const inactive = personState(user, now).id !== "active";
  if (access.unrestricted || access.role === "admin")
    return { kind: "full", inactive };
  const departmentNames = new Map(
    departments.map((department) => [
      department.id,
      department.department_name,
    ]),
  );
  const moduleNames = new Map(
    modules.map((module) => [module.id, module.module_name]),
  );
  const rows = access.entries.map((entry): AccessRow => {
    const sources = entry.groups
      .map((group) => ({
        groupId: group.group_id,
        name: group.name,
        level: group.level,
        levelLabel: levelLabels[group.level],
      }))
      .sort(byName);
    return {
      key: `${entry.department_id}:${entry.module_id ?? "*"}`,
      departmentId: entry.department_id,
      departmentName:
        departmentNames.get(entry.department_id) ?? "Unavailable department",
      moduleName:
        entry.module_id === null
          ? null
          : (moduleNames.get(entry.module_id) ?? "Unavailable module"),
      level: entry.level,
      levelLabel: levelLabels[entry.level],
      sources,
      capped:
        access.role === "guest" &&
        sources.some(
          (source) => levelRank[source.level] > levelRank[entry.level],
        ),
    };
  });
  rows.sort(
    (left, right) =>
      left.departmentName.localeCompare(right.departmentName, undefined, {
        sensitivity: "base",
      }) ||
      (left.moduleName === null ? -1 : 0) -
        (right.moduleName === null ? -1 : 0) ||
      (left.moduleName ?? "").localeCompare(right.moduleName ?? ""),
  );
  return {
    kind: "entries",
    inactive,
    guestCapped: rows.some((row) => row.capped),
    rows,
  };
}

// Command errors

/**
 * Safe copy for a failed People command. A 409 carries the backend's short
 * reason ("A guest keeps the guest role; invite a member instead"), which is
 * written for people; every other failure gets fixed copy.
 */
export function peopleErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 403)
      return "Only administrators can change people. Reload the page to check your access.";
    if (error.status === 404)
      return "This person no longer exists. Close the panel to refresh the list.";
    if (error.status === 409 && typeof error.details === "string")
      return error.details.endsWith(".") ? error.details : `${error.details}.`;
  }
  return fallback;
}

/** True when a request failed before the server answered it. */
export function isUnansweredRequest(error: unknown): boolean {
  return !(error instanceof ApiError) && !(error instanceof ApiContractError);
}

/** A username suggestion from an email address. */
export function usernameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  return local
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100)
    .toLowerCase();
}

export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,100}$/;
export const usernameHint =
  "3 to 100 letters, numbers, hyphens, or underscores.";

export function usernameError(value: string): string | null {
  if (!value.trim()) return "Enter a username.";
  return USERNAME_PATTERN.test(value.trim()) ? null : `Use ${usernameHint}`;
}

export function emailError(value: string): string | null {
  const email = value.trim();
  if (!email) return "Enter an email address.";
  return /^[^\s@]+@[^\s@]+$/.test(email) && email.length <= 320
    ? null
    : "Enter a valid email address.";
}

/** Active, non-guest people who can sponsor a guest. */
export function sponsorOptions(users: readonly AccessUser[], now: number) {
  return users
    .filter(
      (user) => user.role !== "guest" && personState(user, now).id === "active",
    )
    .map((user) => ({ value: user.id, label: personName(user) }))
    .sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" }),
    );
}

/**
 * After an invitation that got no answer, the pending person it made for
 * this email address, if any. Email addresses compare without case.
 */
export function invitationMadeByLostInvite<
  Person extends Pick<AccessUser, "email" | "status" | "is_deleted">,
>(people: readonly Person[], email: string): Person | null {
  const wanted = email.trim().toLowerCase();
  return (
    people.find(
      (person) =>
        !person.is_deleted &&
        person.status === "pending" &&
        person.email.trim().toLowerCase() === wanted,
    ) ?? null
  );
}
