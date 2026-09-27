import type { Person, Role } from "../../shared/data/sample-people";
import type { SampleBoard } from "./model";

export const SAMPLE_BOARD_ADMIN_ROLE_ID = "sample-admin";

export type SampleBoardPermission = "view" | "edit" | "manage";

export type SampleBoardAccessInput = {
  people: readonly Person[];
  roles: readonly Role[];
  boards: readonly Pick<SampleBoard, "id" | "visibleRoleIds">[];
  identityId: string;
  /** `null` asks about the organization level, such as creating a board. */
  boardId: string | null;
  permission: SampleBoardPermission;
  now: string;
};

/**
 * Local audience rule for the Boards sample runtime. The Administrator role
 * has every permission on a known board; other active people with a known
 * role can view a board whose visible roles include their role. Everything
 * else is denied.
 */
export function canAccessSampleBoard({
  people,
  roles,
  boards,
  identityId,
  boardId,
  permission,
  now,
}: SampleBoardAccessInput): boolean {
  const person = people.find((item) => item.id === identityId);
  if (!person) return false;
  const status = person.accessStatus ?? (person.active ? "active" : "disabled");
  if (status !== "active") return false;
  if (person.expiresAt) {
    const expiresAt = Date.parse(person.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(now))
      return false;
  }
  if (!roles.some((role) => role.id === person.role)) return false;
  const board =
    boardId === null ? null : boards.find((item) => item.id === boardId);
  if (board === undefined) return false;
  if (person.role === SAMPLE_BOARD_ADMIN_ROLE_ID) return true;
  if (board === null || permission !== "view") return false;
  return board.visibleRoleIds.includes(person.role);
}
