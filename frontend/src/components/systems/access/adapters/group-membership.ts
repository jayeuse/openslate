import { ApiError } from "@/lib/api";

import { mergeMembers, sameMembers } from "../helpers/groups";
import { getAccessGroup, replaceAccessGroupMembers } from "../state/api";

/**
 * Adds one person to a group or removes them, from the person sheet. It
 * takes the same member-merge path as a Members tab save (`mergeMembers`):
 * it reads the group, changes only this person, and sends the result with
 * the group's ETag. When someone changed the group between the read and the
 * write (412), it reads again and merges once more, so neither change is
 * lost. "unchanged" means the group already had the wanted membership.
 */
export async function changeGroupMembership(
  groupId: string,
  personId: string,
  join: boolean,
): Promise<"changed" | "unchanged"> {
  const before = join ? [] : [personId];
  const after = join ? [personId] : [];
  for (let attempt = 0; ; attempt += 1) {
    const fresh = await getAccessGroup(groupId);
    const next = mergeMembers(fresh.data.member_ids, before, after);
    if (sameMembers(next, fresh.data.member_ids)) return "unchanged";
    try {
      await replaceAccessGroupMembers(groupId, {
        member_ids: next,
        etag: fresh.etag,
      });
      return "changed";
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 412 && attempt === 0)
        continue;
      throw caught;
    }
  }
}
