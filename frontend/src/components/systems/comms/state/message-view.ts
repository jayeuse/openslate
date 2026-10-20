import type { CommsViewClient as CommsClient } from "../contract/client";
import type * as C from "../contract/types";
import type { Person } from "../../shared/data/sample-people";
import type { SampleRecord } from "../../shared/data/sample-data";
import type { Message } from "../domain/view-model";

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

export async function loadQuotes(
  client: CommsClient,
  messages: Map<string, C.Message>,
  signal: AbortSignal,
) {
  for (const message of [...messages.values()]) {
    if (
      message.state !== "live" ||
      !message.reply_to_id ||
      messages.has(message.reply_to_id)
    )
      continue;
    try {
      const quote = await client.getMessage(
        message.conversation_id,
        message.reply_to_id,
        { signal },
      );
      messages.set(quote.data.id, quote.data);
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "failure" in error &&
        typeof error.failure === "object" &&
        error.failure !== null &&
        "status" in error.failure &&
        error.failure.status === 404
      ))
        throw error;
      await client.getConversation(message.conversation_id, { signal });
    }
  }
}
