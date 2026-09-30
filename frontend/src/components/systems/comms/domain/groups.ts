import { departments, type Person } from "../../shared/data/sample-people";
import type { Category, Channel, GroupAccessLevel } from "./model";

/** Department color index on the Sandbox canvas; 0 is the neutral mark. */
export type GroupTone = 0 | 1 | 2 | 3 | 4;
export interface CommsGroup {
  id: string;
  name: string;
  tone: GroupTone;
}

/** The rest of the organization, including guests. */
export const EVERYONE_GROUP_ID = "everyone";

/**
 * Sample access groups: the organization's departments, marked with the
 * department colors of the Sandbox canvas. OpenComms shows group access but
 * does not enforce it until it is connected to Access.
 */
export const COMMS_GROUPS: CommsGroup[] = departments.map((name, index) => ({
  id: name,
  name,
  tone: ((index % 4) + 1) as GroupTone,
}));

export function commsGroup(id: string | undefined): CommsGroup | undefined {
  return COMMS_GROUPS.find((group) => group.id === id);
}

export function groupMembers(groupId: string, people: Person[]): Person[] {
  return people.filter(
    (person) =>
      person.active &&
      (groupId === EVERYONE_GROUP_ID || person.departments.includes(groupId)),
  );
}

/** Who can use a channel: its own choices, or else its category's group. */
export function channelGroupAccess(
  channel: Channel,
  categories: Category[],
): Record<string, GroupAccessLevel> {
  if (channel.groupAccess) return channel.groupAccess;
  const groupId = categories.find(
    (category) => category.id === channel.categoryId,
  )?.groupId;
  return groupId
    ? { [groupId]: "post", [EVERYONE_GROUP_ID]: "none" }
    : { [EVERYONE_GROUP_ID]: "post" };
}

/** What one person can do in a channel through their groups. */
export function personGroupAccess(
  person: Person,
  access: Record<string, GroupAccessLevel>,
): GroupAccessLevel {
  const levels = [
    access[EVERYONE_GROUP_ID] ?? "none",
    ...person.departments.map((group) => access[group] ?? "none"),
  ];
  return levels.includes("post")
    ? "post"
    : levels.includes("read")
      ? "read"
      : "none";
}

/** "Visible to Operations and Commercial", or "Visible to everyone". */
export function visibleToLabel(
  access: Record<string, GroupAccessLevel>,
): string {
  if ((access[EVERYONE_GROUP_ID] ?? "none") !== "none")
    return "Visible to everyone";
  const names = COMMS_GROUPS.filter(
    (group) => (access[group.id] ?? "none") !== "none",
  ).map((group) => group.name);
  if (!names.length) return "Visible to administrators only";
  return `Visible to ${new Intl.ListFormat("en", { type: "conjunction" }).format(names)}`;
}

/** The mark of the first group that can post, for a channel's header. */
export function channelTone(
  access: Record<string, GroupAccessLevel>,
): GroupTone {
  if ((access[EVERYONE_GROUP_ID] ?? "none") !== "none") return 0;
  return COMMS_GROUPS.find((group) => access[group.id] === "post")?.tone ?? 0;
}

/**
 * Where a sample record lives: every sample record is a service request, and
 * its department is its assignee's primary department.
 */
export function recordContext(
  record: { assignee: string } | undefined,
  people: Person[],
): { module: string; group: CommsGroup | undefined } {
  const primary = people.find(
    (person) => person.name === record?.assignee,
  )?.primary;
  return { module: "Service requests", group: commsGroup(primary) };
}

/** The short record number people say aloud: "sample-sr-1004" is SR-1004. */
export function recordNumber(recordId: string): string {
  const number = recordId.split("-").pop() ?? recordId;
  return /^\d+$/.test(number) ? `SR-${number}` : recordId;
}
