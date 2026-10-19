import type { CommsClient } from "../contract/client";
import { timeListRequestSchema } from "../contract/schemas";
import { activePerson } from "../domain/access";
import { invalidInput } from "../domain/settings";
import { assertRequestActive, type MemoryClientBinding } from "./availability";
import { compare, page } from "./conversation-structure";
import { projectMessage } from "./message-projections";

export function createActivityRead({
  handle,
}: MemoryClientBinding): Pick<CommsClient, "listActivity"> {
  return {
    async listActivity(request = {}, options) {
      assertRequestActive(options);
      const parsed = timeListRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      return handle.read((world, context) => {
        activePerson(world, context);
        const rows = (world.users[context.user_id]?.notifications ?? []).filter(
          (row) => {
            if (
              row.org_id !== context.org_id ||
              row.subject_id !== row.message_id
            )
              return false;
            try {
              return (
                projectMessage(
                  world,
                  context,
                  row.conversation_id,
                  row.message_id,
                ).state === "live"
              );
            } catch (error) {
              if (
                typeof error === "object" &&
                error !== null &&
                "failure" in error &&
                typeof error.failure === "object" &&
                error.failure !== null &&
                "status" in error.failure &&
                error.failure.status === 404
              )
                return false;
              throw error;
            }
          },
        );
        const timestamp = (row: (typeof rows)[number]) =>
          parsed.data.sort_by === "updated_at"
            ? (row.read_at ?? row.created_at)
            : row.created_at;
        rows.sort(
          (a, b) =>
            (parsed.data.sort_order === "asc" ? 1 : -1) *
            (compare(timestamp(a), timestamp(b)) || compare(a.id, b.id)),
        );
        assertRequestActive(options);
        return page(rows, parsed.data);
      });
    },
  };
}
