"use client";
import { useState } from "react";
import {
  ArrowLeft,
  Hash,
  MessageSquare,
  Pin,
  Settings2,
  Users,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { Action } from "../../shared/components/ui";
import { CommsMenu } from "./comms-menu";
import { GroupMark } from "./group-mark";
import { FloatingList } from "./floating";
import { CommsThreadList } from "./thread-list";
import {
  channelGroupAccess,
  channelTone,
  visibleToLabel,
  type GroupTone,
} from "../domain/groups";
import { messageAuthorId, threadMessages } from "../domain/view-model";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";
import { useCommsClient } from "../state/client-context";
import type { NavigationState } from "../state/use-comms-navigation";
import type { CommsConversation } from "../state/use-comms-conversation";
import type { CommsDialogsState } from "./comms-dialogs";

function AccessChip({
  label,
  tone,
  onOpen,
}: {
  label: string;
  tone: GroupTone;
  onOpen?: (opener: HTMLElement) => void;
}) {
  const body = (
    <>
      <GroupMark tone={tone} className="size-2" />
      <span className="truncate">{label}</span>
    </>
  );
  const chip =
    "bg-muted text-muted-foreground hidden h-7 max-w-64 shrink-0 items-center gap-1.5 rounded-[var(--radius)] px-2 text-xs shadow-[inset_0_0_0_1px_var(--border)] sm:inline-flex";
  return onOpen ? (
    <button
      type="button"
      onClick={(event) => onOpen(event.currentTarget)}
      className={cn(
        chip,
        "hover:text-foreground focus-visible:outline-ring outline-none focus-visible:outline-2",
      )}
    >
      {body}
      <span className="sr-only">. Change who can use this channel.</span>
    </button>
  ) : (
    <span className={chip}>{body}</span>
  );
}
export function ConversationHeader({
  conversation,
  navigation,
  dialogs,
  wide,
  jumpToMessage,
}: {
  conversation: CommsConversation;
  navigation: NavigationState;
  dialogs: CommsDialogsState;
  wide: boolean;
  jumpToMessage: (id: string) => void;
}) {
  const { people, categories, messages, threads } = useCommsWorkspaceView();
  const { groups } = useCommsClient();
  const { channel, direct, menuAccess, canView } = conversation;
  const { selected, threadId } = navigation;
  const [detailsFor, setDetailsFor] = useState("");
  const [threadFilter, setThreadFilter] = useState<"active" | "inactive">(
    "active",
  );
  const channelThreads = canView
    ? threads.filter(
        (thread) =>
          (thread.conversation ??
            messages.find((message) => message.id === thread.messageId)
              ?.conversation) === selected,
      )
    : [];
  const allMessages = [...messages, ...threads.flatMap(threadMessages)];
  const pinned = canView
    ? [
        ...messages.filter((message) => message.conversation === selected),
        ...channelThreads.flatMap(threadMessages),
      ].filter((message) => message.pinned)
    : [];
  const openChannel = (opener: HTMLElement) => {
    if (channel) dialogs.setEditor({ kind: "channel", value: channel, opener });
  };
  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-2">
      <Action
        className="md:hidden"
        size="icon"
        variant="ghost"
        aria-label="Conversations"
        onClick={() => navigation.setMobileConversation(false)}
      >
        <ArrowLeft className="size-4" />
      </Action>
      {channel ? (
        <Hash className="text-muted-foreground hidden size-5 shrink-0 sm:block" />
      ) : (
        <MessageSquare className="text-muted-foreground size-5 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <h2
          data-slot="section-title"
          className="truncate text-sm font-semibold"
        >
          {channel?.name ?? direct?.user ?? "Choose a conversation"}
        </h2>
        <p className="text-muted-foreground hidden truncate text-xs lg:block">
          {channel?.description ?? "Private conversation"}
        </p>
      </div>
      <Action
        type="button"
        variant="ghost"
        className="sm:hidden"
        aria-expanded={detailsFor === selected}
        aria-controls="comms-details"
        onClick={() => setDetailsFor(detailsFor === selected ? "" : selected)}
      >
        Details
      </Action>
      <div
        id="comms-details"
        className={cn(
          "w-full flex-wrap items-center gap-1.5 sm:contents",
          detailsFor === selected ? "flex" : "hidden",
        )}
      >
        <div className="w-full sm:w-auto md:hidden">
          <CommsMenu
            compact
            hasChannel={!!channel}
            {...menuAccess}
            onSelect={dialogs.openSetting}
          />
          <p className="text-muted-foreground text-xs sm:hidden">
            {channel?.description ?? "Private conversation"}
          </p>
          {channel && (
            <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs sm:hidden">
              <GroupMark
                tone={channelTone(
                  channelGroupAccess(channel, categories),
                  groups,
                )}
                className="size-2"
              />
              <span className="truncate">
                {visibleToLabel(
                  channelGroupAccess(channel, categories),
                  groups,
                )}
              </span>
            </p>
          )}
        </div>
        {channel && (
          <AccessChip
            label={visibleToLabel(
              channelGroupAccess(channel, categories),
              groups,
            )}
            tone={channelTone(channelGroupAccess(channel, categories), groups)}
            onOpen={menuAccess.canManageChannel ? openChannel : undefined}
          />
        )}
        <FloatingList
          label="Threads"
          icon={<MessageSquare className="size-4" />}
        >
          {(close) => (
            <CommsThreadList
              items={channelThreads.map((thread) => ({
                id: thread.id,
                title:
                  allMessages.find((message) => message.id === thread.messageId)
                    ?.text ?? "",
                inactive: thread.resolved,
                metadata: (
                  <>
                    {thread.replyCount ?? thread.replies.length} replies ·{" "}
                    {thread.resolved ? "Resolved" : "Active"}
                  </>
                ),
              }))}
              filter={threadFilter}
              onFilterChange={setThreadFilter}
              onSelect={(item) => {
                close();
                navigation.setThreadId(item.id);
              }}
              emptyDescription={`No ${threadFilter} threads in this conversation.`}
              filterClassName="mb-3"
            />
          )}
        </FloatingList>
        <FloatingList label="Pinned messages" icon={<Pin className="size-4" />}>
          {(close) => (
            <div className="flex flex-col gap-1">
              {pinned.map((message) => (
                <Button
                  type="button"
                  variant="outline"
                  key={message.id}
                  className="h-auto flex-col items-stretch gap-0 p-3 text-left whitespace-normal"
                  onClick={() => {
                    close();
                    jumpToMessage(message.id);
                  }}
                >
                  <span className="mb-1 block text-xs font-medium">
                    {people.find(
                      (person) => person.id === messageAuthorId(message),
                    )?.name ?? message.author}
                  </span>
                  <span className="text-muted-foreground line-clamp-3 text-sm">
                    {message.text}
                  </span>
                </Button>
              ))}
              {!pinned.length && (
                <Empty>
                  <EmptyDescription>No pinned messages yet.</EmptyDescription>
                </Empty>
              )}
            </div>
          )}
        </FloatingList>
        <Action
          variant="ghost"
          size="icon"
          aria-label="Members"
          aria-expanded={
            wide
              ? navigation.membersVisible && !threadId
              : navigation.memberOpen
          }
          onClick={() =>
            navigation.setMemberOpen(
              wide
                ? threadId
                  ? true
                  : !navigation.membersVisible
                : !navigation.memberOpen,
            )
          }
        >
          <Users className="size-4" />
        </Action>
        {channel && menuAccess.canManageChannel && (
          <Action
            variant="ghost"
            size="icon"
            aria-label="Channel settings"
            onClick={(event) => openChannel(event.currentTarget)}
          >
            <Settings2 className="size-4" />
          </Action>
        )}
        <Input
          aria-label="Search messages"
          placeholder="Search messages"
          value={navigation.search}
          onChange={(event) => {
            navigation.setSearch(event.target.value);
            navigation.setHighlightedId("");
          }}
          className="order-last h-9 w-full sm:w-40 lg:w-48"
        />
      </div>
    </header>
  );
}
