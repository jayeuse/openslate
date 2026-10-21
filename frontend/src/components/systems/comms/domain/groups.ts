import type { Person } from "../../shared/data/sample-people";
import type { Category, Channel, GroupAccessLevel } from "./view-model";

/** Department color index on the Sandbox canvas; 0 is the neutral mark. */
export type GroupTone = 0 | 1 | 2 | 3 | 4;
export interface CommsGroup {
  id: string;
  name: string;
  tone: GroupTone;
  memberIds: string[];
}

/** The rest of the organization, including guests. */
export const EVERYONE_GROUP_ID = "everyone";

export function commsGroup(
  id: string | undefined,
  groups: CommsGroup[],
): CommsGroup | undefined {
  return groups.find((group) => group.id === id);
}

export function groupMembers(groupId: string, people: Person[]): Person[] {
  return people.filter(
    (person) =>
      person.active &&
      (groupId === EVERYONE_GROUP_ID || person.groupIds?.includes(groupId)),
  );
}

/** Who can use a channel: its own choices, or else its category's group. */
export function channelGroupAccess(
  channel: Channel,
  categories: Category[],
): Record<string, GroupAccessLevel> {
  if (channel.groupAccess) return channel.groupAccess;
  const category = categories.find(
    (category) => category.id === channel.categoryId,
  );
  if (category?.groupAccess) return category.groupAccess;
  const groupId = category?.groupId;
  return groupId
    ? { [groupId]: "post", [EVERYONE_GROUP_ID]: "none" }
    : { [EVERYONE_GROUP_ID]: "post" };
}

/** "Visible to Operations and Commercial", or "Visible to everyone". */
export function visibleToLabel(
  access: Record<string, GroupAccessLevel>,
  groups: CommsGroup[],
): string {
  if ((access[EVERYONE_GROUP_ID] ?? "none") !== "none")
    return "Visible to everyone";
  const names = groups
    .filter((group) => (access[group.id] ?? "none") !== "none")
    .map((group) => group.name);
  // Group names load only for managers who open an editor; a group row with
  // access still means the channel is not private.
  if (!names.length)
    return Object.values(access).some((level) => level !== "none")
      ? "Visible to selected groups"
      : "Private conversation";
  return `Visible to ${new Intl.ListFormat("en", { type: "conjunction" }).format(names)}`;
}

/** The mark of the first group that can post, for a channel's header. */
export function channelTone(
  access: Record<string, GroupAccessLevel>,
  groups: CommsGroup[],
): GroupTone {
  if ((access[EVERYONE_GROUP_ID] ?? "none") !== "none") return 0;
  return groups.find((group) => access[group.id] === "post")?.tone ?? 0;
}

/**
 * Where a sample record lives: every sample record is a service request, and
 * its department is its assignee's primary department.
 */
export function recordContext(record: { moduleName?: string } | undefined): {
  module: string;
  group: CommsGroup | undefined;
} {
  return { module: record?.moduleName ?? "Record", group: undefined };
}

/** The short record number people say aloud: "sample-sr-1004" is SR-1004. */
export function recordNumber(recordId: string): string {
  const number = recordId.split("-").pop() ?? recordId;
  return /^\d+$/.test(number) ? `SR-${number}` : recordId;
}
