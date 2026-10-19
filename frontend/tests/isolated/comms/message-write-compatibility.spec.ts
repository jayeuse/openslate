import { expect, test } from "@playwright/test";
import { collect, edit, fixture, id } from "./memory-message-fixture";

// The ordinary message routes are unconditional writes. Versions remain read
// metadata; moderator restore/removal and configuration keep their own guards.
for (const operation of ["edit", "delete"] as const) {
  for (const metadata of ["absent", "stale"] as const) {
    test(`ordinary message ${operation} accepts ${metadata} precondition metadata and returns the committed version`, async () => {
      const f = fixture();
      const { events } = collect(f);
      try {
        const client = f.as();
        const sent = await client.sendMessage(f.channelId, {
          client_key: id(880),
          body: "Before ordinary write",
        });
        const original = await client.getMessage(f.channelId, sent.message.id);
        await f
          .as(f.managerId)
          .setPin(f.channelId, sent.message.id, { pinned: true });
        const before = await client.getMessage(f.channelId, sent.message.id);
        expect(before.etag).not.toBe(original.etag);
        // An old caller may still carry version metadata. It has no authority
        // on these two methods, even when another write advanced the version.
        const options =
          metadata === "absent"
            ? undefined
            : {
                signal: new AbortController().signal,
                if_match: original.etag,
              };
        const pending =
          operation === "edit"
            ? client.editMessage(
                f.channelId,
                sent.message.id,
                edit("After ordinary write"),
                options,
              )
            : client.deleteMessage(f.channelId, sent.message.id, options);
        const result = await pending.catch((error: unknown) => {
          console.info("Ordinary message refusal:", JSON.stringify(error));
          throw error;
        });
        expect(result.etag).not.toBe(before.etag);
        expect(result.data).toMatchObject({
          id: sent.message.id,
          seq: sent.message.seq,
          state: operation === "edit" ? "live" : "deleted",
          ...(operation === "edit" ? { body: "After ordinary write" } : {}),
        });
        expect(await client.getMessage(f.channelId, sent.message.id)).toEqual(
          result,
        );
        expect(events.at(-1)).toMatchObject({
          event: "message",
          payload: {
            conversation_id: f.channelId,
            seq: sent.message.seq,
            kind: operation === "edit" ? "edited" : "deleted",
          },
        });
      } finally {
        f.close();
      }
    });
  }
}
