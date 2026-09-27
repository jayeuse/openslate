import { ApiError } from "@/lib/api";

import type {
  AccessDepartment,
  AccessGroup,
  AccessGroupAccessEntry,
  AccessLevel,
  AccessMemberCandidate,
  AccessModule,
  AccessUser,
} from "../state/api-contracts";
import {
  hasThreeWayConflict,
  resolveThreeWayValue,
  type ConflictChoice,
  type FieldConflict,
} from "./editor-helpers";
import { levelLabels, personName, personState } from "./people";

// Pure rules for the Groups screens: the access editor's draft and its
// group_access entries, summaries, the group list, members, and the
// three-way merges a save uses when the group changed elsewhere.

export const accessLevels = ["read", "write", "manage"] as const;

export function isAccessLevel(value: string): value is AccessLevel {
  return (accessLevels as readonly string[]).includes(value);
}

// The access editor

/**
 * One department of the editor. A null level means no department row; a
 * module key is an explicit module row, and a missing key means the module
 * is the same as its department.
 */
export type DepartmentAccessDraft = {
  level: AccessLevel | null;
  modules: Record<string, AccessLevel>;
};
/** Keyed by department id. Departments with nothing set are absent. */
export type AccessDraft = Record<string, DepartmentAccessDraft>;

export function accessDraftFromEntries(
  entries: readonly AccessGroupAccessEntry[],
): AccessDraft {
  const draft: AccessDraft = {};
  for (const entry of entries) {
    const department = (draft[entry.department_id] ??= {
      level: null,
      modules: {},
    });
    if (entry.module_id === null) department.level = entry.level;
    else department.modules[entry.module_id] = entry.level;
  }
  return draft;
}

export function entriesFromAccessDraft(
  draft: AccessDraft,
): AccessGroupAccessEntry[] {
  const entries: AccessGroupAccessEntry[] = [];
  for (const [department_id, department] of Object.entries(draft)) {
    if (department.level)
      entries.push({ department_id, module_id: null, level: department.level });
    for (const [module_id, level] of Object.entries(department.modules))
      entries.push({ department_id, module_id, level });
  }
  return entries;
}

function withDepartment(
  draft: AccessDraft,
  departmentId: string,
  next: DepartmentAccessDraft,
): AccessDraft {
  const copy = { ...draft };
  if (next.level === null && Object.keys(next.modules).length === 0)
    delete copy[departmentId];
  else copy[departmentId] = next;
  return copy;
}

/** None (null) removes the department row; module overrides stay. */
export function setDepartmentLevel(
  draft: AccessDraft,
  departmentId: string,
  level: AccessLevel | null,
): AccessDraft {
  const current = draft[departmentId] ?? { level: null, modules: {} };
  return withDepartment(draft, departmentId, { ...current, level });
}

/** Null makes the module the same as its department again. */
export function setModuleLevel(
  draft: AccessDraft,
  departmentId: string,
  moduleId: string,
  level: AccessLevel | null,
): AccessDraft {
  const current = draft[departmentId] ?? { level: null, modules: {} };
  const modules = { ...current.modules };
  if (level === null) delete modules[moduleId];
  else modules[moduleId] = level;
  return withDepartment(draft, departmentId, { ...current, modules });
}

export function accessKey(entry: {
  department_id: string;
  module_id: string | null;
}): string {
  return `${entry.department_id}:${entry.module_id ?? "*"}`;
}

function accessMap(
  entries: readonly AccessGroupAccessEntry[],
): Map<string, AccessGroupAccessEntry> {
  return new Map(entries.map((entry) => [accessKey(entry), entry]));
}

export function sameAccess(
  left: readonly AccessGroupAccessEntry[],
  right: readonly AccessGroupAccessEntry[],
): boolean {
  const a = accessMap(left);
  const b = accessMap(right);
  return (
    a.size === b.size &&
    [...a].every(([key, entry]) => b.get(key)?.level === entry.level)
  );
}

// Summaries

export type ModuleSummary = {
  id: string;
  name: string;
  level: AccessLevel;
  levelLabel: string;
};
export type DepartmentSummary = {
  departmentId: string;
  name: string;
  level: AccessLevel | null;
  modules: ModuleSummary[];
};

const compareNames = (left: { name: string }, right: { name: string }) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: "base" });

/** One line per department a group reaches, by department name. */
export function accessSummary(
  entries: readonly AccessGroupAccessEntry[],
  departments: readonly AccessDepartment[],
  modules: readonly AccessModule[],
): DepartmentSummary[] {
  const departmentNames = new Map(
    departments.map((item) => [item.id, item.department_name]),
  );
  const moduleNames = new Map(
    modules.map((item) => [item.id, item.module_name]),
  );
  return Object.entries(accessDraftFromEntries(entries))
    .map(([departmentId, department]) => ({
      departmentId,
      name: departmentNames.get(departmentId) ?? "Unavailable department",
      level: department.level,
      modules: Object.entries(department.modules)
        .map(([id, level]) => ({
          id,
          name: moduleNames.get(id) ?? "Unavailable module",
          level,
          levelLabel: levelLabels[level],
        }))
        .sort(compareNames),
    }))
    .sort(compareNames);
}

function moduleCount(count: number): string {
  return `${count} ${count === 1 ? "module" : "modules"}`;
}

/** "Inventory · Write", "Inventory · Write + 1 module", "Finance · 2 modules". */
export function summaryLabel(summary: DepartmentSummary): string {
  const count = summary.modules.length;
  if (!summary.level) return `${summary.name} · ${moduleCount(count)}`;
  const level = `${summary.name} · ${levelLabels[summary.level]}`;
  return count ? `${level} + ${moduleCount(count)}` : level;
}

// The group list

export type GroupRow = {
  group: AccessGroup;
  reach: DepartmentSummary[];
};
export type GroupSort = "name" | "members" | "newest";
export type GroupGapFilter = "all" | "no-access" | "no-members";
export type GroupFilters = {
  query: string;
  sort: GroupSort;
  filter: GroupGapFilter;
};

export const defaultGroupFilters: GroupFilters = {
  query: "",
  sort: "name",
  filter: "all",
};

export function groupRows(
  groups: readonly AccessGroup[],
  departments: readonly AccessDepartment[],
  modules: readonly AccessModule[],
): GroupRow[] {
  return groups.map((group) => ({
    group,
    reach: accessSummary(group.access, departments, modules),
  }));
}

function compareGroups(sort: GroupSort) {
  return (left: GroupRow, right: GroupRow): number => {
    if (sort === "members") {
      const difference =
        right.group.member_ids.length - left.group.member_ids.length;
      if (difference) return difference;
    }
    if (sort === "newest") {
      const difference = right.group.created_at.localeCompare(
        left.group.created_at,
      );
      if (difference) return difference;
    }
    return compareNames(left.group, right.group);
  };
}

/** Filter and sort the complete list; paging happens afterwards. */
export function filterGroups(
  rows: readonly GroupRow[],
  filters: GroupFilters,
): GroupRow[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return rows
    .filter(
      (row) =>
        (filters.filter === "all" ||
          (filters.filter === "no-access"
            ? row.group.access.length === 0
            : row.group.member_ids.length === 0)) &&
        (!query ||
          [
            row.group.name,
            row.group.description,
            ...row.reach.map((item) => item.name),
          ]
            .join("\n")
            .toLocaleLowerCase()
            .includes(query)),
    )
    .sort(compareGroups(filters.sort));
}

/** The gap filter an Overview link asks for; everything else starts at the default. */
export function groupFiltersFromParams(params: URLSearchParams): GroupFilters {
  const filter = params.get("filter");
  return {
    ...defaultGroupFilters,
    filter: filter === "no-access" || filter === "no-members" ? filter : "all",
  };
}

// Members

/** One person who can be a member, from the directory or the candidates route. */
export type MemberOption = {
  id: string;
  name: string;
  email: string;
  role: "member" | "guest";
  /** Why the person cannot be added, when they cannot. */
  blocked: string | null;
  statusLabel: string | null;
};

/** Administrators see the directory: members and guests who are not deleted. */
export function memberOptionsFromUsers(
  users: readonly AccessUser[],
  now: number,
): MemberOption[] {
  return users
    .filter((user) => user.role !== "admin" && !user.is_deleted)
    .map((user) => {
      const state = personState(user, now);
      const blocked =
        state.id === "disabled"
          ? "Disabled"
          : state.id === "expired"
            ? "Access ended"
            : null;
      return {
        id: user.id,
        name: personName(user),
        email: user.email,
        role: user.role === "guest" ? ("guest" as const) : ("member" as const),
        blocked,
        statusLabel: blocked ?? (state.id === "pending" ? "Pending" : null),
      };
    })
    .sort(compareNames);
}

/** Managers see the candidates route, which has no expiry. */
export function memberOptionsFromCandidates(
  candidates: readonly AccessMemberCandidate[],
): MemberOption[] {
  return candidates
    .map((candidate) => {
      const blocked = candidate.status === "disabled" ? "Disabled" : null;
      return {
        id: candidate.id,
        name: personName(candidate),
        email: candidate.email,
        role: candidate.role,
        blocked,
        statusLabel:
          blocked ?? (candidate.status === "pending" ? "Pending" : null),
      };
    })
    .sort(compareNames);
}

export function sameMembers(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const set = new Set(left);
  return set.size === new Set(right).size && right.every((id) => set.has(id));
}

/** Apply the draft's additions and removals onto a newer member list. */
export function mergeMembers(
  current: readonly string[],
  baseline: readonly string[],
  draft: readonly string[],
): string[] {
  const before = new Set(baseline);
  const after = new Set(draft);
  const merged = new Set(current);
  for (const id of before) if (!after.has(id)) merged.delete(id);
  for (const id of after) if (!before.has(id)) merged.add(id);
  return [...merged];
}

export const GROUP_MEMBER_LIMIT = 100;

// Details

export type GroupDetails = { name: string; description: string };

export const groupDetailLabels: Record<keyof GroupDetails, string> = {
  name: "Name",
  description: "Description",
};
const detailFields = ["name", "description"] as const;

export function detailsOf(group: AccessGroup): GroupDetails {
  return { name: group.name, description: group.description };
}

export function sameDetails(left: GroupDetails, right: GroupDetails): boolean {
  return detailFields.every((field) => left[field] === right[field]);
}

export function groupNameError(value: string): string | null {
  if (!value.trim()) return "Enter a name.";
  return value.trim().length > 200 ? "Use 200 characters or fewer." : null;
}

export function detailsConflicts(
  current: GroupDetails,
  baseline: GroupDetails,
  draft: GroupDetails,
): FieldConflict[] {
  return detailFields
    .filter((field) =>
      hasThreeWayConflict(current[field], baseline[field], draft[field]),
    )
    .map((field) => ({
      id: field,
      label: groupDetailLabels[field],
      current: current[field],
      draft: draft[field],
    }));
}

export function resolveDetails(
  current: GroupDetails,
  baseline: GroupDetails,
  draft: GroupDetails,
  choices: Record<string, ConflictChoice | undefined>,
): GroupDetails {
  return {
    name: resolveThreeWayValue(
      current.name,
      baseline.name,
      draft.name,
      choices.name,
    ),
    description: resolveThreeWayValue(
      current.description,
      baseline.description,
      draft.description,
      choices.description,
    ),
  };
}

/** The PATCH body for the details that differ from the saved group. */
export function detailsPatch(
  saved: GroupDetails,
  draft: GroupDetails,
): Partial<GroupDetails> {
  const patch: Partial<GroupDetails> = {};
  if (draft.name.trim() !== saved.name) patch.name = draft.name.trim();
  if (draft.description.trim() !== saved.description)
    patch.description = draft.description.trim();
  return patch;
}

// Access conflicts

function levelValue(entry: AccessGroupAccessEntry | undefined): string {
  return entry?.level ?? "";
}

export function accessKeyLabel(
  key: string,
  departments: readonly AccessDepartment[],
  modules: readonly AccessModule[],
): string {
  const [departmentId = "", moduleId = "*"] = key.split(":");
  const department =
    departments.find((item) => item.id === departmentId)?.department_name ??
    "Unavailable department";
  if (moduleId === "*") return department;
  const moduleName =
    modules.find((item) => item.id === moduleId)?.module_name ??
    "Unavailable module";
  return `${department} · ${moduleName}`;
}

/** Departments and modules whose level both sides changed differently. */
export function accessConflicts(
  current: readonly AccessGroupAccessEntry[],
  baseline: readonly AccessGroupAccessEntry[],
  draft: readonly AccessGroupAccessEntry[],
  departments: readonly AccessDepartment[],
  modules: readonly AccessModule[],
): FieldConflict[] {
  const now = accessMap(current);
  const before = accessMap(baseline);
  const after = accessMap(draft);
  const keys = new Set([...now.keys(), ...before.keys(), ...after.keys()]);
  const describe = (key: string, value: string) =>
    isAccessLevel(value)
      ? levelLabels[value]
      : key.endsWith(":*")
        ? "None"
        : "Same as department";
  return [...keys]
    .filter((key) =>
      hasThreeWayConflict(
        levelValue(now.get(key)),
        levelValue(before.get(key)),
        levelValue(after.get(key)),
      ),
    )
    .sort()
    .map((key) => ({
      id: key,
      label: accessKeyLabel(key, departments, modules),
      current: describe(key, levelValue(now.get(key))),
      draft: describe(key, levelValue(after.get(key))),
    }));
}

/** Merge the draft's access onto the saved access, using the chosen side on a conflict. */
export function resolveAccess(
  current: readonly AccessGroupAccessEntry[],
  baseline: readonly AccessGroupAccessEntry[],
  draft: readonly AccessGroupAccessEntry[],
  choices: Record<string, ConflictChoice | undefined>,
): AccessGroupAccessEntry[] {
  const now = accessMap(current);
  const before = accessMap(baseline);
  const after = accessMap(draft);
  const keys = new Set([...now.keys(), ...before.keys(), ...after.keys()]);
  const resolved: AccessGroupAccessEntry[] = [];
  for (const key of keys) {
    const level = resolveThreeWayValue(
      levelValue(now.get(key)),
      levelValue(before.get(key)),
      levelValue(after.get(key)),
      choices[key],
    );
    const source = after.get(key) ?? now.get(key) ?? before.get(key);
    if (source && isAccessLevel(level))
      resolved.push({
        department_id: source.department_id,
        module_id: source.module_id,
        level,
      });
  }
  return resolved;
}

// Command errors

/**
 * Safe copy for a failed Groups command. A 409 carries the backend's short
 * reason ("Group has members"), which is written for people.
 */
export function groupErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 403)
      return "You can no longer change this group. Reload the page to check your access.";
    if (error.status === 404)
      return "This group no longer exists. Close the panel to refresh the list.";
    if (error.status === 409 && typeof error.details === "string")
      return error.details.endsWith(".") ? error.details : `${error.details}.`;
    if (error.status === 412)
      return "This group changed while you were saving. Check it and save again.";
  }
  return fallback;
}
