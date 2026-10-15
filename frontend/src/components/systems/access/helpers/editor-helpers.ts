export type ConflictChoice = "current" | "draft";

export type FieldConflict = {
  id: string;
  label: string;
  current: string;
  draft: string;
};

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
