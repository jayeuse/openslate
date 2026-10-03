import { useRef } from "react";
import {
  Check,
  Link as LinkIcon,
  MessagesSquare,
  Settings2,
  X,
} from "lucide-react";
import type { SampleRecord } from "../../shared/data/sample-data";
import { threadMessages, type Message, type Thread } from "../domain/model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { reportCommsError } from "../state/comms-feedback";

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
  pending = false,
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
  const [replyingTo, setReplyingTo] = useSampleState<Message | null>(
    `comms-thread-reply-${thread.id}`,
    null,
  );
  const list = useRef<HTMLDivElement>(null);
  const replies = threadMessages(thread);
  // Failures show as a visible OpenComms notice (state/comms-feedback.ts).
  const setNotice = reportCommsError;
  async function send(draft: MessageDraft): Promise<string | null> {
    if (!canPost || thread.resolved) return "This thread is read-only.";
    const error = validateDraft?.(draft);
    if (error) return error;
    const person = identity.people.find(
      (item) => item.id === identity.viewerId,
    );
    const result = await onChange({
      replies: [
        ...replies,
        {
          id: `sample-reply-${crypto.randomUUID()}`,
          conversation: thread.id,
          author: person?.name ?? "You",
          authorId: identity.viewerId,
          text: draft.text.trim() || "Shared a file",
          created: draft.sentAt,
          pinned: false,
          files: draft.files,
          recordId: draft.recordId || undefined,
          replyToId: replyingTo?.id,
        },
      ],
    });
    if (result) return result;
    setReplyingTo(null);
    requestAnimationFrame(() =>
      list.current?.scrollTo({ top: list.current.scrollHeight }),
    );
    return null;
  }
  return (
    <section
      role="region"
      aria-label="Thread conversation"
      className="flex h-full min-h-0 flex-col"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b px-4">
        <MessagesSquare className="size-4" />
        <h3
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
          disabled={pending}
        >
          <Settings2 className="size-4" />
        </Action>
        <Action
          size="icon"
          variant="ghost"
          aria-label="Copy thread link"
          onClick={() => {
            void navigator.clipboard.writeText(
              `${window.location.origin}/comms?conversation=${encodeURIComponent(thread.conversation ?? message?.conversation ?? "")}&thread=${encodeURIComponent(thread.id)}`,
            );
          }}
        >
          <LinkIcon className="size-4" />
        </Action>
        <Action
          size="sm"
          variant="ghost"
          disabled={archived || pending}
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
            ? identity.people.find((person) => person.id === "sample-eli")?.name
            : message?.author}
        </p>
        <p className="text-muted-foreground mt-1 line-clamp-3 text-xs leading-5">
          {message?.text}
        </p>
        {thread.resolved && (
          <Badge className="mt-2">{archived ? "Archived" : "Resolved"}</Badge>
        )}
      </div>
      <MessageScrollerProvider autoScroll={false} defaultScrollPosition="start">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport ref={list} aria-label="Thread messages">
            <MessageScrollerContent className="gap-0 pb-4">
              <MessageTimeline
                visibleMessages={replies}
                allMessages={[...allMessages, ...replies]}
                records={records}
                threads={[]}
                highlightedId={highlightedId}
                mutable={canPost && !pending}
                {...identity}
                onMessageTool={onMessageTool}
                onChange={(id, patch) => {
                  const original = replies.find((item) => item.id === id);
                  return onChange(
                    {
                      replies: replies.map((item) =>
                        item.id === id ? { ...item, ...patch } : item,
                      ),
                    },
                    {
                      ...(original && patch.text !== undefined
                        ? { historyMessage: original }
                        : {}),
                      replyBase: replies,
                    },
                  );
                }}
                onDelete={(id) => {
                  const original = replies.find((item) => item.id === id);
                  return onChange(
                    {
                      replies: replies.filter((item) => item.id !== id),
                    },
                    {
                      ...(original ? { archiveMessage: original } : {}),
                      replyBase: replies,
                    },
                  );
                }}
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
      <Collapsible className="text-muted-foreground shrink-0 border-t px-4 py-2 text-xs">
        <CollapsibleTrigger
          render={<Button variant="ghost" size="sm" className="px-0" />}
        >
          Thread notifications
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Toggle
            control="switch"
            label="Notify me of new replies"
            checked={thread.subscribed}
            disabled={pending}
            onCheckedChange={(checked) => {
              void Promise.resolve(onChange({ subscribed: checked })).then(
                (error) => {
                  if (error) setNotice(error);
                },
              );
            }}
          />
        </CollapsibleContent>
      </Collapsible>
      <MessageComposer
        key={thread.id}
        id={thread.id}
        preferences={identity.preferences}
        settings={identity.settings}
        label="Thread reply"
        sendLabel="Send reply"
        canPost={canPost && !thread.resolved}
        conversationName="this thread"
        unavailableReason={
          archived
            ? "This thread is archived. Restore it in thread settings to reply."
            : thread.resolved
              ? "This thread is resolved. Reopen it to reply."
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
