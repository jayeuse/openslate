"use client";
import type { CommsPreferences } from "../domain/configuration";
import { useCommsClient } from "./client-context";
import { wirePreferences } from "./settings-wire";
import { messageFromCommsError } from "./runtime";
import { reportCommsError } from "./comms-feedback";

export function useCommsPreferences(preferences: CommsPreferences) {
  const { client } = useCommsClient();
  return async function patchPreferences(patch: Partial<CommsPreferences>) {
    try {
      if (!client) throw new Error("Organization is not admitted");
      if (
        Object.keys(patch).some(
          (key) =>
            !["favorites", "hiddenChannels", "mutedUntil", "readAt"].includes(
              key,
            ),
        )
      ) {
        const current = await client.getPersonalPreferences();
        await client.setPersonalPreferences(
          wirePreferences({ ...preferences, ...patch }),
          { if_match: current.etag },
        );
      }
      for (const row of (await client.bootstrap()).conversations) {
        const id = row.conversation.id;
        const change = {
          ...(patch.favorites ? { starred: patch.favorites.includes(id) } : {}),
          ...(patch.hiddenChannels
            ? { hidden: patch.hiddenChannels.includes(id) }
            : {}),
          ...(patch.mutedUntil && id in patch.mutedUntil
            ? {
                mute:
                  patch.mutedUntil[id] === Number.MAX_SAFE_INTEGER
                    ? { kind: "indefinite" as const }
                    : patch.mutedUntil[id]
                      ? {
                          kind: "until" as const,
                          until: new Date(patch.mutedUntil[id]).toISOString(),
                        }
                      : { kind: "off" as const },
              }
            : {}),
          ...(patch.readAt?.[id] === 0 ? { manual_unread: true } : {}),
        };
        if (Object.keys(change).length) {
          const current = await client.getMemberPreferences(id);
          await client.updateMemberPreferences(id, change, {
            if_match: current.etag,
          });
        }
        if (patch.readAt?.[id])
          await client.markRead(id, { last_read_seq: row.high_water_seq });
      }
    } catch (error) {
      reportCommsError(
        messageFromCommsError(error, "Preferences could not be saved."),
      );
    }
  };
}
