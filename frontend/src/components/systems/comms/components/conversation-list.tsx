"use client";
import { useState } from "react";
import {
  ChevronDown,
  CornerDownRight,
  Hash,
  Plus,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Action } from "../../shared/components/ui";
import { Avatar } from "./ui";
import { RowEditMenu } from "./floating";
import { GroupMark } from "./group-mark";
import { SampleDataNote } from "./sample-data-note";
import { CommsMenu } from "./comms-menu";
import type { CommsDialogsState } from "./comms-dialogs";
import { newChannel, type Thread } from "../domain/view-model";
import { commsGroup, recordContext } from "../domain/groups";
import {
  resolveCommsSettings,
  type CommsPreferences,
} from "../domain/configuration";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";
import { useCommsClient } from "../state/client-context";
import type { CommsConversation } from "../state/use-comms-conversation";
import type { NavigationState } from "../state/use-comms-navigation";
import { useCommsListActions } from "../state/use-comms-list-actions";

type Props = {
  conversation: CommsConversation;
  navigation: NavigationState;
  dialogs: CommsDialogsState;
  select: (id: string) => void;
  openThread: (thread: Thread, conversation: string) => void;
  patchPreferences: (patch: Partial<CommsPreferences>) => Promise<void>;
  channelUnread: (id: string) => boolean;
  latestChannelActivity: (id: string) => number;
};
export function ConversationList({
  conversation,
  navigation,
  dialogs,
  select,
  openThread,
  patchPreferences,
  channelUnread,
  latestChannelActivity,
}: Props) {
  const {
    channels,
    categories,
    directs,
    records,
    messages,
    threads,
    configuration: config,
  } = useCommsWorkspaceView();
  const { groups } = useCommsClient();
  const { channel, preferences, menuAccess } = conversation;
  const { selected, threadId, recordId } = navigation;
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const {
    moveCategory,
    duplicateChannel,
    setChannelArchived,
    copyConversation,
  } = useCommsListActions();
  const toggleCategory = (id: string) =>
    setCollapsed((items) =>
      items.includes(id) ? items.filter((item) => item !== id) : [...items, id],
    );
  const filtered = channels.filter(
    (item) =>
      !preferences.hiddenChannels.includes(item.id) &&
      item.name.toLowerCase().includes(search.toLowerCase()),
  );
  const followedRecords = [
    ...new Map(
      [...messages]
        .filter(
          (item) =>
            item.recordId &&
            (channels.some((channel) => channel.id === item.conversation) ||
              directs.some((direct) => direct.id === item.conversation)),
        )
        .sort((a, b) => b.created - a.created)
        .map((item) => [item.recordId!, item] as const),
    ).keys(),
  ]
    .flatMap((id) => records.find((record) => record.id === id) ?? [])
    .slice(0, 4);
  return (
    <aside
      id="comms-channels"
      aria-label="Conversations"
      className="bg-muted/25 flex h-full min-h-0 w-full flex-col border-r"
    >
      <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <CommsMenu
          hasChannel={!!channel}
          {...menuAccess}
          onSelect={dialogs.openSetting}
        />
        {menuAccess.canCreate && (
          <Action
            aria-label="Create channel"
            size="icon"
            variant="ghost"
            onClick={(event) =>
              dialogs.setEditor({
                opener: event.currentTarget,
                kind: "channel",
                value: newChannel(categories[0]?.id ?? ""),
              })
            }
          >
            <Plus className="size-4" />
          </Action>
        )}
      </div>
      <SampleDataNote className="border-b px-4 py-2 text-xs">
        Conversations here are examples.
      </SampleDataNote>
      <div className="p-3">
        <Input
          aria-label="Search conversations"
          placeholder="Find a conversation…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 pb-4">
          {categories.map((category, categoryIndex) => (
            <Collapsible
              key={category.id}
              className="mb-4"
              open={!collapsed.includes(category.id)}
              onOpenChange={(open) =>
                setCollapsed((items) =>
                  open
                    ? items.filter((id) => id !== category.id)
                    : [...items, category.id],
                )
              }
            >
              <RowEditMenu
                label="Category settings"
                actionsLabel={`Category actions: ${category.name}`}
                showActions={false}
                actions={[
                  {
                    label: collapsed.includes(category.id)
                      ? "Expand category"
                      : "Collapse category",
                    onSelect: () => toggleCategory(category.id),
                  },
                  {
                    label: "Mute category for 1 hour",
                    onSelect: () =>
                      patchPreferences({
                        mutedUntil: {
                          ...preferences.mutedUntil,
                          ...Object.fromEntries(
                            channels
                              .filter((item) => item.categoryId === category.id)
                              .map((item) => [item.id, Date.now() + 3600000]),
                          ),
                        },
                      }),
                  },
                  ...(menuAccess.canCreate
                    ? [
                        {
                          label: "Create channel in category",
                          onSelect: (opener: HTMLElement) =>
                            dialogs.setEditor({
                              kind: "channel",
                              value: newChannel(category.id),
                              opener,
                            }),
                        },
                      ]
                    : []),
                  ...(menuAccess.canManageChannel
                    ? [
                        {
                          label: "Move category up",
                          disabled: categoryIndex === 0,
                          onSelect: () => moveCategory(category.id, -1),
                        },
                        {
                          label: "Move category down",
                          disabled: categoryIndex === categories.length - 1,
                          onSelect: () => moveCategory(category.id, 1),
                        },
                        {
                          label: "Apply template",
                          onSelect: (opener: HTMLElement) =>
                            dialogs.setTools({ view: "templates", opener }),
                        },
                      ]
                    : []),
                ]}
                onEdit={
                  menuAccess.canManageChannel
                    ? (opener) =>
                        dialogs.setEditor({
                          kind: "category",
                          value: category,
                          opener,
                        })
                    : undefined
                }
              >
                <div className="group flex items-center">
                  <CollapsibleTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto min-h-11 min-w-0 flex-1 justify-start gap-1 px-1 text-left"
                      />
                    }
                  >
                    <ChevronDown
                      className={cn(
                        "size-3 shrink-0",
                        collapsed.includes(category.id) && "-rotate-90",
                      )}
                    />
                    {category.groupId && (
                      <GroupMark
                        tone={commsGroup(category.groupId, groups)?.tone ?? 0}
                        className="ml-0.5"
                      />
                    )}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{category.name}</span>
                      {category.groupId && (
                        <span className="text-muted-foreground truncate text-xs font-normal">
                          {commsGroup(category.groupId, groups)?.name ??
                            "Access"}{" "}
                          group
                        </span>
                      )}
                    </span>
                  </CollapsibleTrigger>
                  {menuAccess.canManageChannel && (
                    <Action
                      size="icon"
                      variant="ghost"
                      aria-label={`Category settings: ${category.name}`}
                      onClick={(event) =>
                        dialogs.setEditor({
                          kind: "category",
                          value: category,
                          opener: event.currentTarget,
                        })
                      }
                    >
                      <Settings2 className="size-3" />
                    </Action>
                  )}
                </div>
              </RowEditMenu>
              <CollapsibleContent>
                {filtered
                  .filter((item) => item.categoryId === category.id)
                  .map((item) => {
                    const favorite = preferences.favorites.includes(item.id),
                      muted =
                        (preferences.mutedUntil[item.id] ?? 0) > Date.now();
                    const branches = threads.filter(
                      (thread) =>
                        thread.conversation === item.id ||
                        (!thread.conversation &&
                          messages.find(
                            (message) => message.id === thread.messageId,
                          )?.conversation === item.id),
                    );
                    return (
                      <div key={item.id}>
                        <RowEditMenu
                          label="Channel settings"
                          actionsLabel={`Channel actions: ${item.name}`}
                          actions={[
                            {
                              label: favorite
                                ? "Remove from favorites"
                                : "Add to favorites",
                              onSelect: () =>
                                patchPreferences({
                                  favorites: favorite
                                    ? preferences.favorites.filter(
                                        (id) => id !== item.id,
                                      )
                                    : [...preferences.favorites, item.id],
                                }),
                            },
                            {
                              label: muted
                                ? "Unmute channel"
                                : "Mute channel for 1 hour",
                              onSelect: () =>
                                patchPreferences({
                                  mutedUntil: {
                                    ...preferences.mutedUntil,
                                    [item.id]: muted ? 0 : Date.now() + 3600000,
                                  },
                                }),
                            },
                            {
                              label: channelUnread(item.id)
                                ? "Mark read"
                                : "Mark unread",
                              onSelect: () =>
                                patchPreferences({
                                  readAt: {
                                    ...preferences.readAt,
                                    [item.id]: channelUnread(item.id)
                                      ? Math.max(
                                          Date.now(),
                                          latestChannelActivity(item.id),
                                        )
                                      : 0,
                                  },
                                }),
                            },
                            {
                              label: "Copy channel link",
                              onSelect: () => copyConversation(item.id),
                            },
                            ...(menuAccess.canManageChannel
                              ? [
                                  {
                                    label: "Move to another category…",
                                    disabled: categories.length < 2,
                                    onSelect: (opener: HTMLElement) =>
                                      dialogs.setEditor({
                                        kind: "channel",
                                        value: item,
                                        opener,
                                      }),
                                  },
                                  {
                                    label: "Duplicate channel",
                                    onSelect: () => void duplicateChannel(item),
                                  },
                                  {
                                    label: item.archived
                                      ? "Restore channel"
                                      : "Archive channel",
                                    onSelect: (opener: HTMLElement) =>
                                      item.archived
                                        ? void setChannelArchived(item, false)
                                        : dialogs.setConfirm({
                                            title: `Archive #${item.name}?`,
                                            description:
                                              "No one can post in an archived channel. Its messages stay readable, and you can restore it at any time.",
                                            confirmLabel: "Archive channel",
                                            onConfirm: () =>
                                              void setChannelArchived(
                                                item,
                                                true,
                                              ),
                                            opener,
                                          }),
                                  },
                                ]
                              : []),
                          ]}
                          onEdit={
                            menuAccess.canManageChannel
                              ? (opener) =>
                                  dialogs.setEditor({
                                    kind: "channel",
                                    value: item,
                                    opener,
                                  })
                              : undefined
                          }
                        >
                          <Button
                            type="button"
                            variant={
                              selected === item.id ? "secondary" : "ghost"
                            }
                            aria-label={[
                              item.name,
                              selected !== item.id && channelUnread(item.id)
                                ? "unread"
                                : "",
                              muted ? "muted" : "",
                              item.archived ? "archived" : "",
                            ]
                              .filter(Boolean)
                              .join(", ")}
                            aria-current={
                              selected === item.id && !threadId
                                ? "page"
                                : undefined
                            }
                            onClick={() => select(item.id)}
                            className={cn(
                              "h-auto min-h-11 w-full justify-start py-2 pr-10 pl-3 text-left",
                              selected !== item.id &&
                                !channelUnread(item.id) &&
                                "text-muted-foreground font-medium",
                            )}
                          >
                            <Hash className="text-muted-foreground size-4 shrink-0" />
                            <span className="truncate">
                              {favorite ? "★ " : ""}
                              {item.name}
                            </span>
                            {muted && (
                              <span className="text-muted-foreground text-xs">
                                Muted
                              </span>
                            )}
                            {selected !== item.id && channelUnread(item.id) && (
                              <span
                                aria-label="Unread"
                                className="bg-foreground ml-auto size-1.5 shrink-0 rounded-full"
                              />
                            )}
                            {item.archived && (
                              <span className="text-muted-foreground ml-auto text-xs">
                                Archived
                              </span>
                            )}
                          </Button>
                        </RowEditMenu>
                        {branches.length > 0 && (
                          <div
                            role="group"
                            aria-label={`Threads in ${item.name}`}
                            className="mb-1 ml-4 flex min-w-0 flex-col"
                          >
                            {branches
                              .filter(
                                (thread) =>
                                  !thread.archived &&
                                  resolveCommsSettings(config, item).values
                                    .threadBranches !== "none" &&
                                  (resolveCommsSettings(config, item).values
                                    .threadBranches !== "followed" ||
                                    thread.subscribed),
                              )
                              .map((thread) => {
                                const title =
                                  thread.name ||
                                  messages.find(
                                    (message) =>
                                      message.id === thread.messageId,
                                  )?.text ||
                                  "Discussion";
                                return (
                                  <Tooltip key={thread.id}>
                                    <TooltipTrigger
                                      render={
                                        <Button
                                          type="button"
                                          variant={
                                            threadId === thread.id
                                              ? "secondary"
                                              : "ghost"
                                          }
                                          size="sm"
                                          aria-label={`Thread: ${title}`}
                                          aria-current={
                                            threadId === thread.id
                                              ? "page"
                                              : undefined
                                          }
                                          onClick={() =>
                                            openThread(thread, item.id)
                                          }
                                          className={cn(
                                            "h-auto min-h-9 min-w-0 justify-start pr-2 pl-0 text-left",
                                            threadId !== thread.id &&
                                              !channelUnread(item.id) &&
                                              "text-muted-foreground font-normal",
                                          )}
                                        />
                                      }
                                    >
                                      <CornerDownRight
                                        aria-hidden="true"
                                        className="text-muted-foreground mt-2 size-4 shrink-0 self-start"
                                      />
                                      <span className="truncate">{title}</span>
                                      {thread.resolved && (
                                        <Badge
                                          variant="secondary"
                                          className="ml-auto shrink-0"
                                        >
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
                  })}
              </CollapsibleContent>
            </Collapsible>
          ))}
          {menuAccess.canCreate && (
            <Action
              variant="ghost"
              className="text-muted-foreground w-full justify-start"
              onClick={(event) =>
                dialogs.setEditor({
                  opener: event.currentTarget,
                  kind: "category",
                  value: { id: "", name: "" },
                })
              }
            >
              <Plus className="size-3" />
              Create category
            </Action>
          )}
          {followedRecords.length > 0 && (
            <section className="mt-5">
              <h2 className="text-muted-foreground px-2 text-xs font-semibold">
                Records you follow
              </h2>
              <ul
                aria-label="Records you follow"
                className="mt-1 flex flex-col"
              >
                {followedRecords.map((record) => {
                  const { module, group } = recordContext(record);
                  return (
                    <li key={record.id}>
                      <Button
                        type="button"
                        variant={recordId === record.id ? "secondary" : "ghost"}
                        className="h-auto min-h-11 w-full justify-start gap-2 px-2 py-1.5 text-left font-normal"
                        onClick={() => navigation.setRecordId(record.id)}
                      >
                        <GroupMark tone={group?.tone ?? 0} />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-sm font-semibold">
                            {record.title}
                          </span>
                          <span className="text-muted-foreground truncate text-xs">
                            {group?.name ?? module} · {record.status}
                          </span>
                        </span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <div className="mt-5 flex items-center justify-between px-2">
            <h2 className="text-muted-foreground text-xs font-semibold">
              Direct messages
            </h2>
            <Action
              size="icon"
              variant="ghost"
              aria-label="Start direct message"
              onClick={() => {
                dialogs.setDirectError("");
                dialogs.setDmOpen(true);
              }}
            >
              <Plus className="size-4" />
            </Action>
          </div>
          {directs
            .filter((item) =>
              item.user.toLowerCase().includes(search.toLowerCase()),
            )
            .map((item) => (
              <Button
                type="button"
                variant={selected === item.id ? "secondary" : "ghost"}
                key={item.id}
                onClick={() => select(item.id)}
                className="h-auto min-h-11 w-full justify-start px-3 text-left"
              >
                <Avatar name={item.user} />
                <span className={cn("truncate", !item.read && "font-semibold")}>
                  {item.user}
                </span>
                {!item.read && (
                  <span
                    aria-label="Unread"
                    className="bg-foreground ml-auto size-1.5 rounded-full"
                  />
                )}
              </Button>
            ))}
        </div>
      </ScrollArea>
    </aside>
  );
}
