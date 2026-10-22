"use client";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useCommsClient } from "./client-context";

/**
 * Reads one conversation's members, check, settings and pins while it is
 * shown. The workspace view merges every cached detail, so callers read the
 * result there; this hook only decides that the read runs.
 */
export function useConversationDetail(id: string | undefined, enabled = true) {
  const { scope, client, bootstrap } = useCommsClient();
  const room = id
    ? bootstrap?.conversations.find((row) => row.conversation.id === id)
        ?.conversation
    : undefined;
  return useQuery({
    ...(scope && client && room
      ? scope.detailOptions(room.id, room.kind === "channel", client)
      : {
          queryKey: ["comms-unadmitted", "detail", id ?? ""] as const,
          queryFn: skipToken,
        }),
    enabled: enabled && !!scope && !!client && !!room,
  });
}

/**
 * Reads the open conversation's members' presence after its detail lands.
 * Nothing waits for it; presence dots fill in when it arrives.
 */
export function useConversationPresence(id: string | undefined) {
  const { scope, client } = useCommsClient();
  const detail = useConversationDetail(id, false);
  const members = detail.data?.members;
  return useQuery({
    ...(scope && client && id && members
      ? scope.presenceOptions(
          id,
          detail.dataUpdatedAt,
          members.map((member) => member.user_id),
          client,
        )
      : {
          queryKey: ["comms-unadmitted", "presence", id ?? ""] as const,
          queryFn: skipToken,
        }),
    enabled: !!scope && !!client && !!id && !!members,
  });
}
