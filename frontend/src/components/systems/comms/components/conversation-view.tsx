"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Hash, MessageSquare } from "lucide-react";
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
import { useCommsHistory } from "../state/use-comms-history";
import { useVisibleCommsRead } from "../state/use-visible-comms-read";
import { useCommsClient } from "../state/client-context";
import type { MessageDraft } from "./message-shared";

export function ConversationView({
  conversation,
  navigation,
  dialogs,
  header,
  startThread,
  startDirect,
  jumpToMessage,
  beginReply,
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
  const { people, messages, threads, bootstrap } = useCommsWorkspaceView();
  const { client } = useCommsClient();
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
  const { selected, messageList, messageId, replyingTo, setReplyingTo } =
    navigation;
  const [editRequest, setEditRequest] = useState<{
    id: string;
    text: string;
  }>();
  useEffect(() => setEditRequest(undefined), [selected]);
  const history = useCommsHistory(selected, messageId, canView, messageList);
  const records = history.records;
  const allMessages = useMemo(
    () => [
      ...new Map(
        [
          ...messages,
          ...threads.flatMap(threadMessages),
          ...history.quotes,
          ...history.messages,
        ].map((message) => [message.id, message]),
      ).values(),
    ],
    [messages, threads, history.quotes, history.messages],
  );
  const summary = bootstrap?.conversations.find(
    (row) => row.conversation.id === selected,
  );
  const [entry, setEntry] = useState<{
    id: string;
    after: number;
    first: number | null;
  }>();
  if (summary && entry?.id !== selected)
    setEntry({
      id: selected,
      after: summary.last_read_seq,
      first: summary.first_unread_seq,
    });
  const channelThreads = canView
    ? threads.filter(
        (item) =>
          (item.conversation ??
            messages.find((message) => message.id === item.messageId)
              ?.conversation) === selected,
      )
    : [];
  const visibleMessages = canView
    ? history.messages.filter(
        (item) =>
          item.conversation === selected &&
          item.text.toLowerCase().includes(navigation.search.toLowerCase()),
      )
    : [];
  const [announcement, announce] = useState("");
  const [delivery, setDelivery] = useState<{
    id: string;
    state: "sending" | "failed";
  }>();
  useVisibleCommsRead(
    messageList,
    summary,
    canView && !navigation.navigating && !history.loading,
    history.page,
  );
  const operations = createCommsMessageOperations({
    run,
    selected,
    viewerId,
    replyingTo,
    setReplyingTo,
    setNotice: reportCommsError,
    announce,
    scrollToLatest: () => {
      navigation.update({ message: null });
      history.latest();
    },
    allMessages,
  });
  const undoQueue = useRef<Promise<unknown>>(Promise.resolve());
  async function deleteWithUndo(id: string) {
    const original = allMessages.find((item) => item.id === id);
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
  async function send(draft: MessageDraft) {
    setDelivery({ id: selected, state: "sending" });
    const error = await operations.sendMessage(draft);
    setDelivery(error ? { id: selected, state: "failed" } : undefined);
    return error;
  }
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
      <div className="min-h-0 flex-1">
        <div
          ref={messageList}
          role="region"
          tabIndex={0}
          aria-label="Messages"
          aria-busy={history.loading ? "true" : "false"}
          className="relative h-full min-w-0 scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain px-2 py-4 sm:px-4"
          onWheel={(event) => {
            if (event.deltaY !== 0) history.pin();
          }}
          onTouchMove={() => history.pin()}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) history.pin();
          }}
          onKeyDown={(event) => {
            if (
              [
                "ArrowUp",
                "ArrowDown",
                "PageUp",
                "PageDown",
                "Home",
                "End",
              ].includes(event.key)
            )
              history.pin();
          }}
          onScroll={(event) => {
            const list = event.currentTarget;
            navigation.setAwayFromLatest(
              list.scrollHeight - list.scrollTop - list.clientHeight > 120,
            );
          }}
        >
          {!canView ? (
            <Alert>This conversation is not available</Alert>
          ) : (
            <MessageTimeline
              header={
                <>
                  {history.error && (
                    <Alert role="alert" variant="destructive">
                      {history.error}
                      <Action onClick={history.retry}>Retry history</Action>
                    </Alert>
                  )}
                  {history.page?.pagination.has_older && (
                    <Action disabled={history.loading} onClick={history.older}>
                      Load older messages
                    </Action>
                  )}
                  {!history.page?.pagination.has_older && (
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
                  )}
                  {visibleMessages.length === 0 && (
                    <Empty>
                      <EmptyDescription>
                        {navigation.search
                          ? "No messages match."
                          : "No messages yet. Start the conversation below."}
                      </EmptyDescription>
                    </Empty>
                  )}
                </>
              }
              key={selected}
              viewportRef={messageList}
              editRequest={editRequest}
              restoreAnchor={history.restore}
              targetId={messageId}
              followLatest={history.followLatest}
              visibleMessages={visibleMessages}
              allMessages={allMessages}
              onOpenRecord={navigation.setRecordId}
              records={records}
              threads={channelThreads}
              highlightedId={navigation.highlightedId}
              readBoundary={entry?.after}
              firstUnread={entry?.first}
              hasOlder={history.page?.pagination.has_older}
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
              footer={
                history.page?.pagination.has_newer && (
                  <Action disabled={history.loading} onClick={history.newer}>
                    Load newer messages
                  </Action>
                )
              }
            />
          )}
        </div>
      </div>
      {entry?.first != null && canView && (
        <Action
          className="mx-auto mb-2"
          size="sm"
          onClick={() => {
            if (!client || entry.first === null) return;
            void client
              .getMessageBySequence(selected, entry.first)
              .then(({ data }) =>
                navigation.navigate(selected, {
                  message: data.id,
                  ...(data.parent_id && data.thread
                    ? { thread: data.thread.id, panel: "thread" }
                    : {}),
                }),
              )
              .catch(() =>
                reportCommsError("The unread message is not available."),
              );
          }}
        >
          Jump to first unread
        </Action>
      )}
      {(navigation.awayFromLatest ||
        history.page?.pagination.has_newer ||
        !!messageId) && (
        <Action
          className="mx-auto mb-2"
          size="sm"
          onClick={() => {
            navigation.update({ message: null });
            history.latest();
            messageList.current?.scrollTo({
              top: messageList.current.scrollHeight,
            });
          }}
        >
          Jump to latest
        </Action>
      )}
      {delivery?.id === selected &&
        (delivery.state === "sending" ? (
          <p role="status" className="px-3 text-xs">
            Sending…
          </p>
        ) : (
          <Alert role="alert" variant="destructive" className="mx-3">
            <span>Not sent</span>
            <Action
              disabled={!canPost || navigation.navigating}
              onClick={() =>
                document
                  .getElementById(`composer-${selected}`)
                  ?.closest("form")
                  ?.requestSubmit()
              }
            >
              Retry message
            </Action>
          </Alert>
        ))}
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
        onSend={send}
        onEditLast={(message) => {
          setEditRequest(message);
          jumpToMessage(message.id);
        }}
        pending={navigation.navigating || isPending(`message:send:${selected}`)}
      />
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}
