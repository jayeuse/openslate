"use client";
import type { Dispatch, SetStateAction } from "react";
import type { CommsClient } from "../contract/client";
import type { MessageDraft } from "../components/message-shared";
import type { Message } from "../domain/view-model";
import { messageFromCommsError, type useCommsCommands } from "./runtime";
type Run = ReturnType<typeof useCommsCommands>["run"];

export async function submitCommsDraft(
  client: CommsClient,
  conversationId: string,
  draft: MessageDraft,
  replyToId: string | null,
  rootId?: string,
  signal?: AbortSignal,
) {
  const request = {
    client_key: draft.clientKey ?? crypto.randomUUID(),
    body: draft.text,
    attachment_ids: draft.files.map((file) => file.id),
    record_ids: draft.recordId ? [draft.recordId] : [],
    mention_user_ids: draft.mentionUserIds ?? [],
    mentions_channel: draft.mentionsChannel ?? false,
    mentions_here: draft.mentionsHere ?? false,
    reply_to_id: replyToId,
  };
  const signals = [signal, draft.signal].filter(
    (value): value is AbortSignal => value !== undefined,
  );
  const options = signals.length ? { signal: AbortSignal.any(signals) } : {};
  try {
    if (draft.scheduleAt)
      return await client.createSchedule(
        {
          conversation_id: conversationId,
          parent_id: rootId ?? null,
          ...request,
          also_send_to_channel: !!rootId && (draft.alsoSendToChannel ?? false),
          send_at: draft.scheduleAt,
        },
        options,
      );
    return await (rootId
      ? client.sendReply(
          conversationId,
          rootId,
          {
            ...request,
            also_send_to_channel: draft.alsoSendToChannel ?? false,
          },
          options,
        )
      : client.sendMessage(conversationId, request, options));
  } catch (error) {
    draft.onFailure?.(error);
    throw error;
  }
}
export function createCommsMessageOperations({
  run,
  selected,
  viewerId,
  replyingTo,
  setReplyingTo,
  setNotice,
  announce,
  scrollToLatest,
  allMessages,
}: {
  run: Run;
  selected: string;
  viewerId: string;
  replyingTo: Message | null;
  setReplyingTo: Dispatch<SetStateAction<Message | null>>;
  setNotice: (message: string) => void;
  announce: (message: string) => void;
  scrollToLatest: () => void;
  allMessages: Message[];
}) {
  async function mutation(
    key: string,
    action: (client: CommsClient, signal: AbortSignal) => Promise<unknown>,
    fallback: string,
  ) {
    try {
      await run(key, action);
      return null;
    } catch (error) {
      const message = messageFromCommsError(error, fallback);
      setNotice(message);
      return message;
    }
  }
  function changeMessage(id: string, patch: Partial<Message>) {
    return mutation(
      `message:update:${id}`,
      async (client, signal) => {
        const roomId =
          allMessages.find((message) => message.id === id)?.conversation ??
          selected;
        const current = await client.getMessage(roomId, id, { signal });
        if (patch.text !== undefined)
          await client.editMessage(
            roomId,
            id,
            {
              body: patch.text,
              mention_user_ids:
                current.data.state === "live"
                  ? current.data.mention_user_ids
                  : [],
              mentions_channel:
                current.data.state === "live" && current.data.mentions_channel,
              mentions_here:
                current.data.state === "live" && current.data.mentions_here,
            },
            { signal },
          );
        if (patch.pinned !== undefined)
          await client.setPin(roomId, id, { pinned: patch.pinned }, { signal });
        if (patch.reactions && current.data.state === "live") {
          const mine = new Set(
            current.data.reactions
              .filter((reaction) => reaction.user_ids.includes(viewerId))
              .map((reaction) => reaction.emoji),
          );
          const desired = new Set(
            Object.entries(patch.reactions)
              .filter(([, users]) => users.includes(viewerId))
              .map(([emoji]) => emoji),
          );
          for (const emoji of new Set([...mine, ...desired]))
            if (mine.has(emoji) !== desired.has(emoji))
              await (
                desired.has(emoji) ? client.addReaction : client.removeReaction
              )(roomId, id, { emoji }, { signal });
        }
      },
      "The message could not be updated.",
    );
  }
  function deleteMessage(id: string) {
    return mutation(
      `message:delete:${id}`,
      async (client, signal) => {
        const roomId =
          allMessages.find((message) => message.id === id)?.conversation ??
          selected;
        await client.deleteMessage(roomId, id, {
          signal,
        });
      },
      "The message could not be deleted.",
    );
  }
  async function undoDelete(original: Message) {
    const error = await mutation(
      `message:undo-delete:${original.id}`,
      async (client, signal) => {
        const current = await client.getMessage(
          original.conversation,
          original.id,
          { signal },
        );
        await client.restoreMessage(original.conversation, original.id, {
          signal,
          if_match: current.etag,
        });
      },
      "The message could not be put back.",
    );
    if (!error) announce("Message put back.");
    return error;
  }
  function validateDraft(draft: MessageDraft) {
    return !draft.text.trim() && !draft.files.length && !draft.recordId
      ? "Write a message, attach a file, or link a record."
      : null;
  }
  async function sendMessage(draft: MessageDraft) {
    const error = await mutation(
      `message:send:${selected}`,
      (client, signal) =>
        submitCommsDraft(
          client,
          selected,
          draft,
          replyingTo?.id ?? null,
          undefined,
          signal,
        ),
      "The message could not be sent. Your draft is still available.",
    );
    if (!error) {
      setReplyingTo(null);
      announce(draft.scheduleAt ? "Message scheduled." : "Message sent.");
      if (!draft.scheduleAt) requestAnimationFrame(() => scrollToLatest());
    }
    return error;
  }
  return {
    changeMessage,
    deleteMessage,
    undoDelete,
    validateDraft,
    sendMessage,
  };
}
