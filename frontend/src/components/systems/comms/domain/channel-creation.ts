import type {
  CapabilityCheck,
  CapabilityDecision,
  ChannelCreationCheck,
} from "../contract/types";

/**
 * Whether a D27 createChannel grant reaches the viewer in any readable channel.
 * A grant creates channels only in departments where the viewer holds a
 * department role, never organization channels (owner decision 2026-10-22).
 */
export function holdsCreateChannelGrant(
  checks: Record<string, CapabilityCheck>,
): boolean {
  return Object.values(checks).some(
    ({ capabilities }) =>
      capabilities.createChannel.allowed &&
      capabilities.createChannel.source.kind === "group_grant",
  );
}

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
 * Collects grant reach from conversation checks and per-category creation
 * checks. A category check allowed under a workspace lock counts for that
 * category only; a department-manager decision is the manager rule, not a grant.
 */
export function grantReach(
  conversationChecks: CapabilityCheck[],
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
  for (const check of conversationChecks) add(check.capabilities.createChannel);
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
