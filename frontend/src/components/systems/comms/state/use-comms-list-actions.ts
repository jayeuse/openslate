"use client";
import { useCommsClient } from "./client-context";
import { reportCommsDone, reportCommsError } from "./comms-feedback";
import { messageFromCommsError } from "./runtime";
import type { Channel } from "../domain/view-model";

export function useCommsListActions() {
  const { client } = useCommsClient();
  async function moveCategory(id: string, direction: number) {
    try {
      if (!client) throw new Error("Organization is not admitted");
      const rows = (await client.bootstrap()).categories.map(
        (row) => row.category,
      );
      const from = rows.findIndex((row) => row.id === id),
        to = from + direction;
      if (from < 0 || to < 0 || to >= rows.length) return;
      [rows[from], rows[to]] = [rows[to], rows[from]];
      for (const [position, row] of rows.entries()) {
        if (row.position === position) continue;
        const current = await client.getCategory(row.id);
        await client.updateCategory(
          row.id,
          {
            name: current.data.name,
            department_id: current.data.department_id,
            position,
          },
          { if_match: current.etag },
        );
      }
    } catch (error) {
      reportCommsError(
        messageFromCommsError(error, "The category order could not be saved."),
      );
    }
  }
  async function duplicateChannel(channel: Channel) {
    try {
      if (!client) throw new Error("Organization is not admitted");
      const current = await client.getConversation(channel.id);
      await client.duplicateChannel(
        channel.id,
        {
          name: `${channel.name}-copy`,
          category_id: channel.categoryId || null,
        },
        { if_match: current.etag },
      );
    } catch (error) {
      reportCommsError(
        messageFromCommsError(error, "The channel could not be duplicated."),
      );
    }
  }
  async function setChannelArchived(
    target: Pick<Channel, "id" | "name">,
    archived: boolean,
  ) {
    try {
      if (!client) throw new Error("Organization is not admitted");
      const current = await client.getConversation(target.id);
      await (
        archived ? client.archiveConversation : client.restoreConversation
      )(target.id, { if_match: current.etag });
      await client.bootstrap();
    } catch (error) {
      reportCommsError(
        messageFromCommsError(
          error,
          "The channel archive state could not be saved.",
        ),
      );
      return;
    }
    if (!archived) reportCommsDone(`#${target.name} restored.`);
    else
      reportCommsDone(`#${target.name} archived.`, {
        label: "Undo",
        onClick: () => void setChannelArchived(target, false),
      });
  }
  async function toggleDirect(directId: string, field: "read" | "blocked") {
    try {
      if (!client) throw new Error("Organization is not admitted");
      const current = await client.getConversation(directId);
      if (current.data.kind !== "direct") return;
      if (field === "read") {
        const summary = (await client.bootstrap()).conversations.find(
          (row) => row.conversation.id === directId,
        );
        if (!summary) throw new Error("Conversation is unavailable");
        if (summary.preferences.manual_unread || summary.unread_count)
          await client.markRead(directId, {
            last_read_seq: summary.high_water_seq,
          });
        else {
          const preferences = await client.getMemberPreferences(directId);
          await client.updateMemberPreferences(
            directId,
            { manual_unread: true },
            { if_match: preferences.etag },
          );
        }
      } else {
        const recipient = current.data.participant_ids.find(
          (id) => id !== client.context.user_id,
        );
        if (!recipient) throw new Error("Recipient is unavailable");
        const blocks = await client.listDirectBlocks();
        if (blocks.items.some((block) => block.blocked_user_id === recipient))
          await client.unblockDirect(recipient);
        else await client.blockDirect({ blocked_user_id: recipient });
      }
    } catch (error) {
      reportCommsError(
        messageFromCommsError(
          error,
          "The direct conversation could not be updated.",
        ),
      );
    }
  }
  function copyConversation(id: string) {
    const url = new URL("/comms", document.baseURI);
    url.searchParams.set("conversation", id);
    void navigator.clipboard.writeText(url.href).then(
      () => reportCommsDone("Conversation link copied."),
      () => reportCommsError("The browser could not copy the link."),
    );
  }
  return {
    moveCategory,
    duplicateChannel,
    setChannelArchived,
    toggleDirect,
    copyConversation,
  };
}
