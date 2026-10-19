import { useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import {
  Check,
  Link as LinkIcon,
  MessagesSquare,
  Settings2,
  X,
} from "lucide-react";
import type { SampleRecord } from "../../shared/data/sample-data";
import {
  threadMessages,
  type Message,
  type Thread,
} from "../domain/view-model";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { useSampleState } from "../../shared/runtime/sample-state";
import { Action, Toggle } from "../../shared/components/ui";
import { MessageTimeline } from "./message-timeline";
import { MessageComposer } from "./message-composer";
import type {
  CommsAsyncResult,
  MessageDraft,
  ThreadChangeOptions,
  TimelineActions,
  TimelinePeople,
} from "./message-shared";
import { reportCommsDone, reportCommsError } from "../state/comms-feedback";
import { useCommsCommands } from "../state/runtime";
import {
  createCommsMessageOperations,
  submitCommsDraft,
} from "../state/use-comms-message-operations";

export function ThreadPanel({
  thread,
  message,
  allMessages,
  highlightedId,
  onJump,
  records,
  canPost,
  onClose,
  onChange,
  onThread,
  onDirect,
  threadName,
  archived = false,
  validateDraft,
  onSettings,
  onMessageTool,
  pending: parentPending = false,
  ...identity
}: {
  thread: Thread;
  threadName?: string;
  archived?: boolean;
  validateDraft?: (draft: MessageDraft) => string | null;
  onSettings?: (opener: HTMLElement) => void;
  onMessageTool?: TimelineActions["onMessageTool"];
  pending?: boolean;
  message?: Message;
  allMessages: Message[];
  highlightedId: string;
  onJump: (id: string) => void;
  records: SampleRecord[];
  canPost: boolean;
  onClose: () => void;
  onChange: (
    patch: Partial<Thread>,
    options?: ThreadChangeOptions,
  ) => CommsAsyncResult;
  onThread: (message: Message) => void;
  onDirect: (name: string) => void;
} & TimelinePeople) {
  const { run, isPending } = useCommsCommands();
  const pending = parentPending || isPending();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const canManage = identity.capabilities?.manageThreads.allowed ?? false;
  const canResolve =
    canManage ||
    (identity.membershipRole !== undefined &&
      identity.membershipRole !== "guest" &&
      message?.authorId === identity.viewerId);
  const [alsoSend, setAlsoSend] = useSampleState(
    `comms-thread-also-send-${thread.id}`,
    false,
  );
  useLayoutEffect(() => {
    const target = highlightedId
      ? sectionRef.current?.querySelector<HTMLElement>(
          `[id="${CSS.escape(highlightedId)}"]`,
        )
      : null;
    (target ?? headingRef.current)?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center", behavior: "instant" });
  }, [thread.id, highlightedId]);
  const [replyingToId, setReplyingToId] = useSampleState<string>(
    `comms-thread-reply-${thread.id}`,
    "",
  );
  const list = useRef<HTMLDivElement>(null);
  const [editRequest, setEditRequest] = useState<{
    id: string;
    text: string;
  }>();
  const replies = threadMessages(thread);
  const replyingTo =
    [...allMessages, ...replies].find(
      (message) => message.id === replyingToId && !message.deleted,
    ) ?? null;
  function setReplyingTo(action: SetStateAction<Message | null>) {
    const next = typeof action === "function" ? action(replyingTo) : action;
    setReplyingToId(next?.id ?? "");
  }
  // Failures show as a visible OpenComms notice (state/comms-feedback.ts).
  const setNotice = reportCommsError;
  function scrollToLatest() {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }
  function messageOperations() {
    return createCommsMessageOperations({
      run,
      selected: thread.conversation,
      viewerId: identity.viewerId,
      replyingTo,
      setReplyingTo,
      setNotice,
      announce: () => {},
      scrollToLatest,
      allMessages: [...allMessages, ...replies],
    });
  }
  async function send(draft: MessageDraft): Promise<string | null> {
    if (!canPost) return "This thread is read-only.";
    const error = validateDraft?.(draft);
    if (error) return error;
    await run(`reply:${thread.id}`, (client, signal) =>
      submitCommsDraft(
        client,
        thread.conversation,
        draft,
        replyingTo?.id ?? null,
        thread.messageId,
        signal,
      ),
    );
    setReplyingTo(null);
    setAlsoSend(false);
    if (!draft.scheduleAt)
      requestAnimationFrame(() =>
        list.current?.scrollTo({ top: list.current.scrollHeight }),
      );
    return null;
  }
  return (
    <section
      ref={sectionRef}
      role="region"
      aria-label="Thread conversation"
      className="flex h-full min-h-0 flex-col"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b px-4">
        <MessagesSquare className="size-4" />
        <h3
          ref={headingRef}
          tabIndex={-1}
          data-slot="section-title"
          className="min-w-0 flex-1 truncate text-sm font-semibold"
        >
          {threadName || "Thread"}
        </h3>
        <Action
          size="icon"
          variant="ghost"
          aria-label="Thread settings"
          onClick={(event) => onSettings?.(event.currentTarget)}
          disabled={pending || !canManage}
        >
          <Settings2 className="size-4" />
        </Action>
        <Action
          size="icon"
          variant="ghost"
          aria-label="Copy thread link"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                new URL(
                  `/comms?conversation=${encodeURIComponent(thread.conversation ?? message?.conversation ?? "")}&thread=${encodeURIComponent(thread.id)}`,
                  document.baseURI,
                ).href,
              );
              reportCommsDone("Thread link copied.");
            } catch {
              setNotice("The thread link could not be copied. Try again.");
            }
          }}
        >
          <LinkIcon className="size-4" />
        </Action>
        <Action
          size="sm"
          variant="ghost"
          disabled={pending || !canResolve}
          aria-label={thread.resolved ? "Reopen thread" : "Resolve thread"}
          onClick={() => {
            void Promise.resolve(onChange({ resolved: !thread.resolved })).then(
              (error) => {
                if (error) setNotice(error);
              },
            );
          }}
        >
          {thread.resolved ? "Reopen" : <Check className="size-4" />}
        </Action>
        <Action
          variant="ghost"
          size="icon"
          aria-label="Back to messages"
          onClick={onClose}
          disabled={pending}
        >
          <X className="size-4" />
        </Action>
      </header>
      <div className="bg-muted/20 shrink-0 border-b px-4 py-3">
        <p className="text-xs font-medium">
          {message?.author === "You"
            ? identity.people.find((person) => person.id === identity.viewerId)
                ?.name
            : message?.author}
        </p>
        <p className="text-muted-foreground mt-1 line-clamp-3 text-xs leading-5">
          {message?.text}
        </p>
        {thread.resolved && <Badge className="mt-2">Resolved</Badge>}
        {thread.locked && <Badge className="mt-2 ml-1">Locked</Badge>}
        {archived && <Badge className="mt-2 ml-1">Archived</Badge>}
      </div>
      <MessageScrollerProvider autoScroll={false} defaultScrollPosition="start">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport ref={list} aria-label="Thread messages">
            <MessageScrollerContent className="gap-0 pb-4">
              <MessageTimeline
                editRequest={editRequest}
                visibleMessages={replies}
                allMessages={[...allMessages, ...replies]}
                records={records}
                threads={[]}
                highlightedId={highlightedId}
                mutable={canPost && !pending}
                {...identity}
                onMessageTool={onMessageTool}
                onChange={(id, patch) =>
                  messageOperations().changeMessage(id, patch)
                }
                onDelete={(id) => messageOperations().deleteMessage(id)}
                onReply={(item) => {
                  setReplyingTo(item);
                  requestAnimationFrame(() =>
                    document.getElementById(`composer-${thread.id}`)?.focus(),
                  );
                }}
                onThread={onThread}
                onJump={onJump}
                onDirect={onDirect}
              />
              {!replies.length && (
                <Empty className="px-5 py-8">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <MessagesSquare />
                    </EmptyMedia>
                    <EmptyTitle>Keep the details here</EmptyTitle>
                    <EmptyDescription>
                      Replies stay together in this thread.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
      <div className="text-muted-foreground flex shrink-0 flex-wrap items-center gap-2 border-t px-4 py-2 text-xs">
        <Action
          size="sm"
          variant="ghost"
          aria-label={thread.subscribed ? "Unfollow thread" : "Follow thread"}
          aria-pressed={thread.subscribed}
          disabled={pending}
          onClick={() =>
            void Promise.resolve(
              onChange({ subscribed: !thread.subscribed }),
            ).then((error) => {
              if (error) setNotice(error);
            })
          }
        >
          {thread.subscribed ? "Following" : "Follow"}
        </Action>
        <Toggle
          label="Also send to channel"
          checked={alsoSend}
          onCheckedChange={setAlsoSend}
          disabled={!canPost || pending}
        />
      </div>
      <MessageComposer
        alsoSendToChannel={alsoSend}
        rootId={thread.messageId}
        onEditLast={(message) => {
          setEditRequest(message);
          onJump(message.id);
        }}
        key={thread.id}
        id={thread.id}
        conversationId={thread.conversation}
        preferences={identity.preferences}
        settings={identity.settings}
        label="Thread reply"
        sendLabel="Send reply"
        canPost={canPost}
        conversationName="this thread"
        unavailableReason={
          archived
            ? "This thread is archived. Restore it in thread settings to reply."
            : thread.locked
              ? "This thread is locked. Unlock it in thread settings to reply."
              : "Your role cannot post in this thread."
        }
        records={records}
        replyingTo={replyingTo}
        people={identity.people}
        onCancelReply={() => setReplyingTo(null)}
        onSend={send}
        pending={pending}
      />
    </section>
  );
}
