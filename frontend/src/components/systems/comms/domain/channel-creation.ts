import type {
  CapabilityDecision,
  ChannelCreationCheck,
} from "../contract/types";

/** A workspace lock on createChannel turns the department-manager default off. */
export function creationLocked(check: ChannelCreationCheck | undefined) {
  return check?.decision.source.kind === "workspace_lock";
}

/** Where createChannel grants reach: the whole workspace, or named categories. */
export interface GrantReach {
  workspace: boolean;
  categoryIds: Set<string>;
}

/**
 * Collects grant reach from createChannel decisions (the workspace creation
 * check, the open conversation's check) and per-category creation checks. A
 * category check allowed under a workspace lock counts for that category only;
 * a department-manager decision is the manager rule, not a grant.
 */
export function grantReach(
  decisions: CapabilityDecision[],
  categoryChecks: { categoryId: string; check: ChannelCreationCheck }[],
): GrantReach {
  const reach: GrantReach = { workspace: false, categoryIds: new Set() };
  const add = (decision: CapabilityDecision, categoryId?: string) => {
    if (!decision.allowed) return;
    const source = decision.source;
    if (source.kind === "group_grant") {
      if (source.scope.kind === "workspace") reach.workspace = true;
      else if (source.scope.kind === "category")
        reach.categoryIds.add(source.scope.id);
    } else if (source.kind === "workspace_lock" && categoryId)
      reach.categoryIds.add(categoryId);
  };
  for (const decision of decisions) add(decision);
  for (const { categoryId, check } of categoryChecks)
    add(check.decision, categoryId);
  return reach;
}

/**
 * Where a non-admin may put a new channel of a department: "any" category of it
 * (or none), only the listed categories, or nowhere (null). A department manager
 * is free in a managed department unless a workspace lock is on; a workspace
 * grant frees every department the viewer holds a role in; a category grant
 * reaches only that category.
 */
export function departmentPlacement(
  departmentId: string,
  rules: {
    admin: boolean;
    locked: boolean;
    managed: Set<string> | "all";
    roles: Set<string>;
    reach: GrantReach;
    categories: { id: string; departmentId: string }[];
  },
): "any" | string[] | null {
  if (rules.admin || rules.managed === "all") return "any";
  if (!rules.locked && rules.managed.has(departmentId)) return "any";
  if (!rules.roles.has(departmentId)) return null;
  if (rules.reach.workspace) return "any";
  const granted = rules.categories
    .filter(
      (category) =>
        category.departmentId === departmentId &&
        rules.reach.categoryIds.has(category.id),
    )
    .map((category) => category.id);
  return granted.length ? granted : null;
}
