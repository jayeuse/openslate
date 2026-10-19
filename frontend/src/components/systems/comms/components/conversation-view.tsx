"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Hash, MessageSquare } from "lucide-react";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
} from "@/components/ui/message-scroller";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Alert } from "@/components/ui/alert";
import { Action } from "../../shared/components/ui";
import { MessageTimeline, MessageComposer } from "./ui";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";
import type { NavigationState } from "../state/use-comms-navigation";
import type { CommsConversation } from "../state/use-comms-conversation";
import type { CommsDialogsState } from "./comms-dialogs";
import { useCommsCommands } from "../state/runtime";
import { createCommsMessageOperations } from "../state/use-comms-message-operations";
import { useCommsListActions } from "../state/use-comms-list-actions";
import { reportCommsDone, reportCommsError } from "../state/comms-feedback";
import { threadMessages, type Message } from "../domain/view-model";

export function ConversationView({
  conversation,
  navigation,
  dialogs,
  header,
  startThread,
  startDirect,
  jumpToMessage,
  beginReply,
  scrollToLatest,
  hydrated,
  desktop,
}: {
  conversation: CommsConversation;
  navigation: NavigationState;
  dialogs: CommsDialogsState;
  header: ReactNode;
  startThread: (message: Message) => Promise<void>;
  startDirect: (id: string) => Promise<void>;
  jumpToMessage: (id: string) => void;
  beginReply: (message: Message) => void;
  scrollToLatest: (behavior?: ScrollBehavior) => void;
  hydrated: boolean;
  desktop: boolean;
}) {
  const { people, messages, threads, records } = useCommsWorkspaceView();
  const { run, isPending } = useCommsCommands();
  const { toggleDirect } = useCommsListActions();
  const {
    channel,
    direct,
    preferences,
    settings,
    canView,
    canPost,
    canParticipate,
    check,
    viewerId,
    identity,
  } = conversation;
  const {
    selected,
    messageList,
    mobileConversation,
    messageId,
    replyingTo,
    setReplyingTo,
  } = navigation;
  const allMessages = [...messages, ...threads.flatMap(threadMessages)];
  const channelThreads = canView
    ? threads.filter(
        (item) =>
          (item.conversation ??
            messages.find((message) => message.id === item.messageId)
              ?.conversation) === selected,
      )
    : [];
  const visibleMessages = canView
    ? messages.filter(
        (item) =>
          item.conversation === selected &&
          item.text.toLowerCase().includes(navigation.search.toLowerCase()),
      )
    : [];
  const [announcement, announce] = useState("");
  const operations = createCommsMessageOperations({
    run,
    selected,
    viewerId,
    replyingTo,
    setReplyingTo,
    setNotice: reportCommsError,
    announce,
    scrollToLatest,
    allMessages,
  });
  const undoQueue = useRef<Promise<unknown>>(Promise.resolve());
  async function deleteWithUndo(id: string) {
    const original = messages.find((item) => item.id === id);
    const error = await operations.deleteMessage(id);
    if (!error && original && check?.capabilities.deleteOthersMessages.allowed)
      reportCommsDone("Message deleted.", {
        label: "Undo",
        onClick: () => {
          undoQueue.current = undoQueue.current.then(() =>
            operations.undoDelete(original),
          );
        },
      });
    return error;
  }
  // A route target is applied once it is rendered, not on every workspace refresh.
  const targetAvailable = allMessages.some(
    (message) => message.id === messageId && message.conversation === selected,
  );
  useEffect(() => {
    if (!hydrated) return;
    if (messageId) {
      if (!targetAvailable) return;
      const frame = requestAnimationFrame(() => {
        const target = document.getElementById(messageId);
        target?.focus();
        target?.scrollIntoView({ block: "center" });
      });
      return () => cancelAnimationFrame(frame);
    }
    messageList.current?.scrollTo({ top: messageList.current.scrollHeight });
  }, [
    selected,
    mobileConversation,
    desktop,
    hydrated,
    messageId,
    targetAvailable,
    messageList,
  ]);
  return (
    <section
      aria-label="Conversation"
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      {header}
      {direct && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3">
          <Action
            size="sm"
            variant="ghost"
            onClick={() => void toggleDirect(selected, "read")}
          >
            Mark {direct.read ? "unread" : "read"}
          </Action>
          <Action
            size="sm"
            variant="ghost"
            onClick={(event) =>
              direct.blocked
                ? void toggleDirect(selected, "blocked")
                : dialogs.setConfirm({
                    title: `Block ${direct.user}?`,
                    description:
                      "Neither of you can send messages in this conversation until you unblock them. Earlier messages stay.",
                    confirmLabel: "Block user",
                    destructive: true,
                    onConfirm: () => void toggleDirect(selected, "blocked"),
                    opener: event.currentTarget,
                  })
            }
          >
            {direct.blocked ? "Unblock user" : "Block user"}
          </Action>
        </div>
      )}
      {canView && settings.pinnedRecordId && (
        <a
          className="bg-muted/30 border-b px-4 py-2 text-xs underline"
          href={`/openview?record=${encodeURIComponent(settings.pinnedRecordId)}`}
        >
          Pinned record ·{" "}
          {records.find((record) => record.id === settings.pinnedRecordId)
            ?.title ?? "View record"}
        </a>
      )}
      <MessageScrollerProvider autoScroll={false} defaultScrollPosition="start">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport
            ref={messageList}
            aria-label="Messages"
            className="px-2 py-4 sm:px-4"
            onScroll={(event) => {
              const list = event.currentTarget;
              navigation.setAwayFromLatest(
                list.scrollHeight - list.scrollTop - list.clientHeight > 120,
              );
            }}
          >
            <MessageScrollerContent className="gap-0">
              {!canView ? (
                <Alert>This conversation is not available</Alert>
              ) : (
                <>
                  <div className="mt-4 mb-8 px-3">
                    <div className="bg-muted mb-3 flex size-12 items-center justify-center rounded-2xl">
                      {channel ? (
                        <Hash className="text-muted-foreground size-6" />
                      ) : (
                        <MessageSquare className="text-muted-foreground size-6" />
                      )}
                    </div>
                    <h3 className="text-xl font-semibold tracking-tight">
                      {channel
                        ? `Welcome to #${channel.name}`
                        : `A conversation with ${direct?.user}`}
                    </h3>
                    <p className="text-muted-foreground mt-2 text-sm">
                      {channel?.description ||
                        "This is the beginning of your conversation."}
                    </p>
                  </div>
                  {visibleMessages.length === 0 && (
                    <Empty>
                      <EmptyDescription>
                        {navigation.search
                          ? "No messages match."
                          : "No messages yet. Start the conversation below."}
                      </EmptyDescription>
                    </Empty>
                  )}
                  <MessageTimeline
                    key={selected}
                    visibleMessages={visibleMessages}
                    allMessages={allMessages}
                    onOpenRecord={navigation.setRecordId}
                    records={records}
                    threads={channelThreads}
                    highlightedId={navigation.highlightedId}
                    {...identity}
                    mutable={canParticipate && !isPending()}
                    onMessageTool={(view, messageId, opener) =>
                      dialogs.setTools({
                        view,
                        messageId,
                        channelId: selected,
                        opener,
                      })
                    }
                    onChange={operations.changeMessage}
                    onDelete={deleteWithUndo}
                    onReply={beginReply}
                    onThread={startThread}
                    onJump={jumpToMessage}
                    onDirect={startDirect}
                  />
                </>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
      {navigation.awayFromLatest && (
        <Action
          className="mx-auto mb-2"
          size="sm"
          onClick={() => scrollToLatest("instant")}
        >
          Jump to latest
        </Action>
      )}
      <MessageComposer
        key={selected}
        id={selected}
        preferences={preferences}
        settings={settings}
        canPost={canPost}
        replyingTo={replyingTo}
        people={people}
        onCancelReply={() => setReplyingTo(null)}
        conversationName={
          channel ? `#${channel.name}` : (direct?.user ?? "a teammate")
        }
        unavailableReason={
          direct?.blocked
            ? "Unblock this user to send a message."
            : channel?.archived
              ? "This channel is archived. Restore it to post."
              : settings.locked
                ? "This channel is locked. Unlock it in channel settings to post."
                : "Your role cannot post in this channel."
        }
        records={records}
        onSend={operations.sendMessage}
        pending={navigation.navigating || isPending(`message:send:${selected}`)}
      />
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}
