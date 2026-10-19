"use client";
import { CornerDownRight, Hash, MessageSquare, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { RowEditMenu } from "./floating";
import type { CommsDialogsState } from "./comms-dialogs";
import type { NavigationState } from "../state/use-comms-navigation";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";
import { useCommsListActions } from "../state/use-comms-list-actions";
import {
  countLabel,
  muteDurations,
  rowLabel,
  type SidebarActions,
  type SidebarRow,
} from "../state/use-comms-sidebar";
import { resolveCommsSettings } from "../domain/configuration";
import type { Thread } from "../domain/view-model";

export function ConversationCounts({ row }: { row: SidebarRow }) {
  if (row.mention_count)
    return (
      <Badge
        variant="secondary"
        aria-label={`${countLabel(row.mention_count)} ${row.mention_count === 1 ? "mention" : "mentions"}`}
        className="ml-auto"
      >
        {countLabel(row.mention_count)}
      </Badge>
    );
  if (row.muted || !row.unread_count) return null;
  return (
    <Badge
      variant="secondary"
      aria-label={`${countLabel(row.unread_count)} unread`}
      className="ml-auto"
    >
      {countLabel(row.unread_count)}
    </Badge>
  );
}
export function ConversationRow({
  row,
  navigation,
  dialogs,
  actions,
  select,
  openThread,
}: {
  row: SidebarRow;
  navigation: NavigationState;
  dialogs: CommsDialogsState;
  actions: SidebarActions;
  select: (id: string) => void;
  openThread: (thread: Thread, conversation: string) => void;
}) {
  const { channels, categories, threads, messages, configuration, checks } =
    useCommsWorkspaceView();
  const { duplicateChannel, setChannelArchived, copyConversation } =
    useCommsListActions();
  const id = row.conversation.id;
  const channel = channels.find((item) => item.id === id);
  const manage = checks[id]?.capabilities.manageChannel.allowed ?? false;
  const selected = navigation.selected === id && !navigation.view;
  const label = channel ? "channel" : "conversation";
  const branches = threads.filter(
    (thread) => thread.conversation === id && !thread.archived,
  );
  const branchMode = channel
    ? resolveCommsSettings(configuration, channel).values.threadBranches
    : "none";
  const Icon =
    row.conversation.kind === "channel"
      ? Hash
      : row.conversation.kind === "group"
        ? Users
        : MessageSquare;
  return (
    <div>
      <RowEditMenu
        label="Channel settings"
        actionsLabel={`${channel ? "Channel" : "Conversation"} actions: ${row.name}`}
        onEdit={
          channel && manage
            ? (opener) =>
                dialogs.setEditor({ kind: "channel", value: channel, opener })
            : undefined
        }
        actions={[
          {
            label: row.preferences.starred
              ? "Remove from favorites"
              : "Add to favorites",
            onSelect: () =>
              void actions.change(id, { starred: !row.preferences.starred }),
          },
          ...muteDurations.map((duration) => ({
            label: `Mute ${label} ${duration}`,
            onSelect: () => void actions.mute(id, duration, "conversation"),
          })),
          ...(row.preferences.mute.kind !== "off" ||
          row.preferences.notify === "mute"
            ? [
                {
                  label: `Unmute ${label}`,
                  onSelect: () =>
                    void actions.change(id, {
                      mute: { kind: "off" },
                      notify: "all",
                    }),
                },
              ]
            : []),
          {
            label: row.unread ? "Mark read" : "Mark unread",
            onSelect: () => void actions.mark(row),
          },
          {
            label: channel ? "Copy channel link" : "Copy conversation link",
            onSelect: () => copyConversation(id),
          },
          ...(channel && manage
            ? [
                {
                  label: "Move to another category…",
                  disabled: categories.length < 2,
                  onSelect: (opener: HTMLElement) =>
                    dialogs.setEditor({
                      kind: "channel" as const,
                      value: channel,
                      opener,
                    }),
                },
                {
                  label: "Duplicate channel",
                  onSelect: () => void duplicateChannel(channel),
                },
                {
                  label: channel.archived
                    ? "Restore channel"
                    : "Archive channel",
                  onSelect: (opener: HTMLElement) =>
                    channel.archived
                      ? void setChannelArchived(channel, false)
                      : dialogs.setConfirm({
                          title: `Archive #${channel.name}?`,
                          description:
                            "No one can post in an archived channel. Its messages stay readable, and you can restore it at any time.",
                          confirmLabel: "Archive channel",
                          opener,
                          onConfirm: () =>
                            void setChannelArchived(channel, true),
                        }),
                },
              ]
            : []),
        ]}
      >
        <Button
          type="button"
          variant={selected ? "secondary" : "ghost"}
          aria-label={rowLabel(row)}
          aria-current={selected && !navigation.threadId ? "page" : undefined}
          disabled={actions.isPending(`sidebar:${id}`)}
          onClick={() => select(id)}
          className={cn(
            "h-auto min-h-11 w-full justify-start gap-2 py-2 pr-12 pl-3 text-left sm:pr-10",
            row.unread ? "font-semibold" : "text-muted-foreground font-medium",
          )}
        >
          <Icon className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate">{row.name}</span>
          {row.muted && (
            <span className="text-muted-foreground text-xs">Muted</span>
          )}
          <ConversationCounts row={row} />
          {channel?.archived && (
            <span className="text-muted-foreground ml-auto text-xs">
              Archived
            </span>
          )}
        </Button>
      </RowEditMenu>
      {branchMode !== "none" && (
        <div
          role="group"
          aria-label={`Threads in ${row.name}`}
          className="mb-1 ml-4 flex min-w-0 flex-col"
        >
          {branches
            .filter((thread) => branchMode !== "followed" || thread.subscribed)
            .map((thread) => {
              const title =
                thread.name ||
                messages.find((message) => message.id === thread.messageId)
                  ?.text ||
                "Discussion";
              return (
                <Tooltip key={thread.id}>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant={
                          navigation.threadId === thread.id
                            ? "secondary"
                            : "ghost"
                        }
                        size="sm"
                        aria-label={`Thread: ${title}`}
                        aria-current={
                          navigation.threadId === thread.id ? "page" : undefined
                        }
                        onClick={() => openThread(thread, id)}
                        className="h-auto min-h-11 min-w-0 justify-start pr-2 pl-0 text-left sm:min-h-9"
                      />
                    }
                  >
                    <CornerDownRight
                      aria-hidden="true"
                      className="text-muted-foreground size-4 shrink-0"
                    />
                    <span className="truncate">{title}</span>
                    {thread.resolved && (
                      <Badge variant="secondary" className="ml-auto shrink-0">
                        Resolved
                      </Badge>
                    )}
                  </TooltipTrigger>
                  <TooltipContent>{title}</TooltipContent>
                </Tooltip>
              );
            })}
        </div>
      )}
    </div>
  );
}
