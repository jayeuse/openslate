import type { CommsViewClient as CommsClient } from "../contract/client";
import type * as C from "../contract/types";
import type { Person } from "../../shared/data/sample-people";
import type { SampleRecord } from "../../shared/data/sample-data";
import type { Message } from "../domain/view-model";
import { BURST, limited } from "./bounded";
import { failureStatus } from "../contract/failure-status";

export function messageView(
  message: C.Message,
  people: ReadonlyMap<string, Person>,
  records: Map<string, SampleRecord>,
): Message {
  const identity = {
    id: message.id,
    conversation: message.conversation_id,
    authorId: message.author_id,
    author: people.get(message.author_id)?.name ?? "Unavailable person",
    created: Date.parse(message.created_at),
    seq: message.seq,
  };
  if (message.state !== "live")
    return {
      ...identity,
      text: "Message removed",
      pinned: false,
      deleted: true,
    };
  for (const reference of message.record_references) {
    if (reference.state !== "available") continue;
    records.set(reference.record_id, {
      id: reference.record_id,
      title: reference.title,
      moduleName: reference.module_name,
      fields: reference.fields.map((field) => ({
        id: field.field_id,
        label: field.label,
        displayValue: field.display_value,
      })),
      customer: "",
      assignee: "",
      dueDate: "",
      status:
        reference.fields.find((field) => field.label === "Status")
          ?.display_value ?? "",
    });
  }
  return {
    ...identity,
    text: message.body,
    edited: message.edited_at !== null,
    linkPreviews: message.link_previews,
    parentId: message.parent_id ?? undefined,
    pinned: message.pinned_at !== null,
    files: message.attachments.map((file) => ({
      id: file.id,
      name: file.filename,
      size: file.size,
      type: file.media_type,
    })),
    recordId: message.record_references.find(
      (record) => record.state === "available",
    )?.record_id,
    replyToId: message.reply_to_id ?? undefined,
    reactions: Object.fromEntries(
      message.reactions.map((reaction) => [reaction.emoji, reaction.user_ids]),
    ),
  };
}

/** Reads the quoted messages that are not loaded yet, all at once. */
export async function loadQuotes(
  client: CommsClient,
  messages: Map<string, C.Message>,
  signal: AbortSignal,
) {
  const wanted = new Map<string, string>();
  for (const message of messages.values())
    if (
      message.state === "live" &&
      message.reply_to_id &&
      !messages.has(message.reply_to_id)
    )
      wanted.set(message.reply_to_id, message.conversation_id);
  const quotes = await limited(
    [...wanted],
    BURST,
    async ([id, conversationId]) => {
      try {
        return (await client.getMessage(conversationId, id, { signal })).data;
      } catch (error) {
        if (failureStatus(error) !== 404) throw error;
        // A purged quote is fine; an unreadable conversation is a refusal.
        await client.getConversation(conversationId, { signal });
        return undefined;
      }
    },
  );
  for (const quote of quotes) if (quote) messages.set(quote.id, quote);
}
