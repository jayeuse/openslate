import type { CommsClient } from "@/components/systems/comms/contract/client";
import { memberListRequestSchema } from "@/components/systems/comms/contract/schemas";
import { activePerson, canStartDirect } from "../domain/access";
import { invalidInput } from "../domain/settings";
import { assertRequestActive, type MemoryClientBinding } from "./availability";
import { compare, page } from "./conversation-structure";

export function createDirectCandidateRead({
  handle,
}: MemoryClientBinding): Pick<CommsClient, "listDirectCandidates"> {
  return {
    async listDirectCandidates(request = {}, options) {
      assertRequestActive(options);
      const parsed = memberListRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      return handle.read((world, context) => {
        activePerson(world, context);
        const search = parsed.data.search?.toLocaleLowerCase("en-US") ?? "";
        const rows = Object.values(world.people)
          .filter(
            (person) =>
              canStartDirect(world, context, person.user_id) &&
              person.display_name.toLocaleLowerCase("en-US").includes(search),
          )
          .map(({ user_id, display_name }) => ({ user_id, display_name }))
          .sort(
            (a, b) =>
              (parsed.data.sort_order === "asc" ? 1 : -1) *
              (compare(a.display_name, b.display_name) ||
                compare(a.user_id, b.user_id)),
          );
        assertRequestActive(options);
        return page(rows, parsed.data);
      });
    },
  };
}
