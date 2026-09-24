export type ConflictChoice = "current" | "draft";
export type EditorIntent = "create" | "edit";

export type FieldConflict = {
  id: string;
  label: string;
  current: string;
  draft: string;
};

type DepartmentSelection = {
  departmentIds: readonly string[];
  primaryDepartmentId: string;
};

export function closedDepartmentMemberships(
  selectedIds: readonly string[],
  activeIds: ReadonlySet<string>,
  names: ReadonlyMap<string, string>,
): { id: string; name: string }[] {
  return selectedIds.flatMap((id) =>
    activeIds.has(id)
      ? []
      : [{ id, name: names.get(id) || "Closed department" }],
  );
}

export function updateDepartmentSelection(
  current: DepartmentSelection,
  id: string,
  checked: boolean,
  activeIds: ReadonlySet<string>,
): { departmentIds: string[]; primaryDepartmentId: string } {
  const departmentIds =
    checked && activeIds.has(id)
      ? [...new Set([...current.departmentIds, id])]
      : checked
        ? [...current.departmentIds]
        : current.departmentIds.filter((item) => item !== id);
  const primaryDepartmentId = departmentIds.includes(
    current.primaryDepartmentId,
  )
    ? current.primaryDepartmentId
    : (departmentIds.find((item) => activeIds.has(item)) ?? "");
  return { departmentIds, primaryDepartmentId };
}

export function sameList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

export function hasThreeWayConflict<T>(
  current: T,
  baseline: T,
  draft: T,
  equals: (left: T, right: T) => boolean = Object.is,
): boolean {
  return (
    !equals(current, baseline) &&
    !equals(draft, baseline) &&
    !equals(draft, current)
  );
}

export function changedPatch<T extends object, K extends keyof T>(
  baseline: T,
  draft: T,
  fields: readonly K[],
  equals: (left: T[K], right: T[K]) => boolean = Object.is,
): Partial<Pick<T, K>> {
  const patch: Partial<Pick<T, K>> = {};
  for (const field of fields) {
    if (!equals(baseline[field], draft[field])) patch[field] = draft[field];
  }
  return patch;
}

export function applyPatch<T extends object, P extends Partial<T>>(
  current: T,
  patch: P,
): T & P {
  return { ...current, ...patch };
}

export function resolveThreeWayValue<T>(
  current: T,
  baseline: T,
  draft: T,
  choice: ConflictChoice | undefined,
  equals: (left: T, right: T) => boolean = Object.is,
): T {
  if (equals(draft, baseline)) return current;
  if (
    choice === "current" &&
    hasThreeWayConflict(current, baseline, draft, equals)
  )
    return current;
  return draft;
}
