"use client";
import { ScrollArea } from "@/components/ui/scroll-area";
import dynamic from "next/dynamic";
import { MembersPanel } from "./ui";
import { RecordPanel } from "./record-panel";
import type { CommsDialogsState } from "./comms-dialogs";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";
import type { NavigationState } from "../state/use-comms-navigation";
import type { CommsConversation } from "../state/use-comms-conversation";
import type { createCommsConversationOperations } from "../state/use-comms-conversation-operations";
import { useCommsCommands } from "../state/runtime";
import { threadMessages, type Thread } from "../domain/view-model";

const ThreadPanel = dynamic(() =>
  import("./thread-panel").then((module) => module.ThreadPanel),
);

export function RightPane({
  navigation,
  conversation,
  dialogs,
  currentThread,
  operations,
  jumpToMessage,
  wide,
}: {
  navigation: NavigationState;
  conversation: CommsConversation;
  dialogs: CommsDialogsState;
  currentThread?: Thread;
  operations: ReturnType<typeof createCommsConversationOperations>;
  jumpToMessage: (id: string) => void;
  wide: boolean;
}) {
  const workspace = useCommsWorkspaceView();
  const { people, roles, messages, threads, records, channels, directs } =
    workspace;
  const { isPending } = useCommsCommands();
  const { selected } = navigation;
  const { canView, canParticipate, check, identity, viewerId } = conversation;
  const allMessages = [...messages, ...threads.flatMap(threadMessages)];
  const record = records.find((item) => item.id === navigation.recordId);
  if (currentThread)
    return (
      <ThreadPanel
        key={currentThread.id}
        thread={currentThread}
        message={allMessages.find(
          (item) => item.id === currentThread.messageId,
        )}
        allMessages={allMessages}
        highlightedId={navigation.highlightedId}
        onJump={jumpToMessage}
        records={records}
        {...identity}
        archived={currentThread.archived}
        canPost={
          !currentThread.archived &&
          canParticipate &&
          (check?.capabilities.reply.allowed ?? false) &&
          !currentThread.locked
        }
        threadName={currentThread.name}
        validateDraft={(draft) =>
          !draft.text.trim() && !draft.files.length && !draft.recordId
            ? "Write a message, attach a file, or link a record."
            : null
        }
        onSettings={(opener) =>
          dialogs.setTools({
            view: "thread",
            threadId: currentThread.id,
            channelId: selected,
            opener,
          })
        }
        onMessageTool={(view, messageId, opener) =>
          dialogs.setTools({ view, messageId, channelId: selected, opener })
        }
        onThread={operations.startThread}
        onDirect={operations.startDirect}
        onClose={() => navigation.setThreadId("")}
        onChange={operations.patchThread}
        pending={
          navigation.navigating ||
          isPending(`thread:update:${currentThread.id}`)
        }
      />
    );
  if (record && canView)
    return (
      <RecordPanel
        key={record.id}
        record={record}
        people={people}
        mentions={messages
          .filter(
            (item) =>
              item.recordId === record.id &&
              (channels.some((channel) => channel.id === item.conversation) ||
                directs.some((direct) => direct.id === item.conversation)),
          )
          .sort((a, b) => b.created - a.created)
          .map((item) => ({
            messageId: item.id,
            conversationName: channels.find(
              (channel) => channel.id === item.conversation,
            )
              ? `#${channels.find((channel) => channel.id === item.conversation)!.name}`
              : (directs.find((direct) => direct.id === item.conversation)
                  ?.user ?? "A conversation"),
            author: item.author,
            text: item.text
              .replace(/\*\*(.+?)\*\*\n/g, "$1: ")
              .replace(/[*_`]/g, ""),
          }))}
        onJump={(id) => {
          const target = messages.find((message) => message.id === id);
          if (target)
            navigation.navigate(target.conversation, {
              message: id,
              panel: wide ? `record:${record.id}` : null,
            });
        }}
        onClose={() => navigation.setRecordId("")}
      />
    );
  const memberIds = new Set(
    canView ? workspace.members[selected]?.map((member) => member.user_id) : [],
  );
  return (
    <ScrollArea className="h-full">
      <MembersPanel
        members={people.filter(
          (person) => person.active && memberIds.has(person.id),
        )}
        roles={roles}
        viewerId={viewerId}
        viewerPresence={workspace.account.presence}
        presence={workspace.presence}
        onClose={() => navigation.setMemberOpen(false)}
        onDirect={operations.startDirect}
      />
    </ScrollArea>
  );
}
