import type { AccessLevel, AuthMe } from "@/lib/auth-api";

const RANK: Record<AccessLevel, number> = { read: 1, write: 2, manage: 3 };

/**
 * The signed-in user's level on a department, or on one of its modules.
 *
 * It mirrors the server rule for the `access` entries of `/auth/me`: an
 * administrator manages everything; a module entry wins over its department
 * entry; a guest is limited to `read`. The server still checks every change,
 * so this only decides which controls to show.
 */
export function openViewLevel(
  me: AuthMe | undefined,
  departmentId: string,
  moduleId?: string,
): AccessLevel | null {
  if (!me) return null;
  if (me.role === "admin") return "manage";
  const department = me.access.find(
    (entry) => entry.departmentId === departmentId && entry.moduleId === null,
  );
  const moduleEntry =
    moduleId === undefined
      ? undefined
      : me.access.find(
          (entry) =>
            entry.departmentId === departmentId && entry.moduleId === moduleId,
        );
  const level = (moduleEntry ?? department)?.level ?? null;
  if (level && me.role === "guest") return "read";
  return level;
}

/** Whether the user may create, change or delete the department's content. */
export function canManageOpenView(
  me: AuthMe | undefined,
  departmentId: string | undefined,
  moduleId?: string,
): boolean {
  if (!departmentId) return false;
  const level = openViewLevel(me, departmentId, moduleId);
  return level !== null && RANK[level] >= RANK.manage;
}

/** Departments where the user may manage Dashboards (department rows only). */
export function managedDepartmentIds(
  me: AuthMe | undefined,
): Set<string> | "all" {
  if (!me) return new Set();
  if (me.role === "admin") return "all";
  if (me.role === "guest") return new Set();
  return new Set(
    me.access
      .filter((entry) => entry.moduleId === null && entry.level === "manage")
      .map((entry) => entry.departmentId),
  );
}
