"use client";
import { useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { DepartmentMark } from "@/components/sandbox/department-mark";
import { cn } from "@/lib/utils";
import { Action } from "../../shared/components/ui";
import { RowEditMenu } from "./floating";
import { GroupMark } from "./group-mark";
import { SampleDataNote } from "./sample-data-note";
import { CommsMenu } from "./comms-menu";
import type { CommsDialogsState } from "./comms-dialogs";
import { newChannel, type Thread } from "../domain/view-model";
import { recordContext } from "../domain/groups";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";
import { useCommsClient } from "../state/client-context";
import type { CommsConversation } from "../state/use-comms-conversation";
import type { NavigationState } from "../state/use-comms-navigation";
import { useCommsListActions } from "../state/use-comms-list-actions";
import {
  muteActive,
  muteDurations,
  useCommsSidebar,
  type SidebarRow,
} from "../state/use-comms-sidebar";
import { ConversationRow } from "./conversation-row";
import { QuickSwitcher } from "./quick-switcher";

export function ConversationList({
  conversation,
  navigation,
  dialogs,
  select,
  openThread,
}: {
  conversation: CommsConversation;
  navigation: NavigationState;
  dialogs: CommsDialogsState;
  select: (id: string) => void;
  openThread: (thread: Thread, conversation: string) => void;
}) {
  const { channels, categories, directs, records, messages } =
    useCommsWorkspaceView();
  const { catalog } = useCommsClient();
  const { channel, menuAccess } = conversation;
  const [search, setSearch] = useState("");
  const { moveCategory } = useCommsListActions();
  const actions = useCommsSidebar();
  const visible = actions.rows.filter(
    (row) =>
      !row.preferences.hidden &&
      row.name.toLowerCase().includes(search.toLowerCase()),
  );
  const starred = visible.filter((row) => row.preferences.starred);
  const row = (item: SidebarRow) => (
    <ConversationRow
      key={item.conversation.id}
      row={item}
      navigation={navigation}
      dialogs={dialogs}
      actions={actions}
      select={select}
      openThread={openThread}
    />
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
      <div className="px-2 pt-2">
        <QuickSwitcher rows={actions.rows} select={select} />
      </div>
      <nav aria-label="OpenComms views" className="grid grid-cols-2 gap-1 px-2">
        {(
          [
            ["inbox", "Inbox"],
            ["activity", "Activity"],
            ["threads", "Threads"],
            ["browse", "Browse channels"],
          ] as const
        ).map(([view, label]) => (
          <Button
            key={view}
            variant={navigation.view === view ? "secondary" : "ghost"}
            className="min-h-11 justify-start px-2 text-xs"
            onClick={() => navigation.showView(view)}
            aria-current={navigation.view === view ? "page" : undefined}
          >
            {label}
          </Button>
        ))}
      </nav>
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
          <section aria-label="Starred" className="mb-3">
            <h2 className="text-muted-foreground px-2 py-2 text-xs font-semibold">
              Starred
            </h2>
            {starred.map(row)}
            {!starred.length && (
              <p className="text-muted-foreground px-2 text-xs">
                Star conversations to find them here.
              </p>
            )}
          </section>
          {!visible.length && (
            <p className="text-muted-foreground px-2 py-3 text-sm">
              {search
                ? "No conversations match."
                : "No conversations yet. Browse channels or start a conversation."}
            </p>
          )}
          {actions.categories.map(({ category, preferences }, index) => {
            const categoryView = categories.find(
              (item) => item.id === category.id,
            )!;
            const departmentIndex = catalog.departments.findIndex(
              (item) => item.id === category.department_id,
            );
            const department = catalog.departments[departmentIndex];
            const items = visible.filter(
              (item) =>
                item.conversation.kind === "channel" &&
                item.conversation.category_id === category.id &&
                !item.preferences.starred,
            );
            return (
              <Collapsible
                key={category.id}
                className="mb-4"
                open={!preferences.collapsed}
                onOpenChange={(open) =>
                  void actions.categoryChange(category.id, { collapsed: !open })
                }
              >
                <RowEditMenu
                  label="Category settings"
                  actionsLabel={`Category actions: ${category.name}`}
                  onEdit={
                    menuAccess.canManageChannel
                      ? (opener) =>
                          dialogs.setEditor({
                            kind: "category",
                            value: categoryView,
                            opener,
                          })
                      : undefined
                  }
                  actions={[
                    {
                      label: preferences.collapsed
                        ? "Expand category"
                        : "Collapse category",
                      onSelect: () =>
                        void actions.categoryChange(category.id, {
                          collapsed: !preferences.collapsed,
                        }),
                    },
                    ...muteDurations.map((duration) => ({
                      label: `Mute category ${duration}`,
                      onSelect: () =>
                        void actions.mute(category.id, duration, "category"),
                    })),
                    ...(preferences.mute.kind !== "off"
                      ? [
                          {
                            label: "Unmute category",
                            onSelect: () =>
                              void actions.categoryChange(category.id, {
                                mute: { kind: "off" },
                              }),
                          },
                        ]
                      : []),
                    ...(menuAccess.canCreate
                      ? [
                          {
                            label: "Create channel in category",
                            onSelect: (opener: HTMLElement) =>
                              dialogs.setEditor({
                                kind: "channel" as const,
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
                            disabled: index === 0,
                            onSelect: () => void moveCategory(category.id, -1),
                          },
                          {
                            label: "Move category down",
                            disabled: index === actions.categories.length - 1,
                            onSelect: () => void moveCategory(category.id, 1),
                          },
                          {
                            label: "Apply template",
                            onSelect: (opener: HTMLElement) =>
                              dialogs.setTools({ view: "templates", opener }),
                          },
                        ]
                      : []),
                  ]}
                >
                  <CollapsibleTrigger
                    render={
                      <Button
                        variant="ghost"
                        className="h-auto min-h-11 w-full justify-start gap-1 py-2 pr-12 pl-1 text-left sm:pr-10"
                      />
                    }
                  >
                    <ChevronDown
                      className={cn(
                        "size-3 shrink-0",
                        preferences.collapsed && "-rotate-90",
                      )}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">
                        {category.name}
                        {muteActive(preferences.mute) ? " · Muted" : ""}
                      </span>
                      {department && (
                        <span className="text-muted-foreground flex items-center gap-1.5 truncate text-xs font-normal">
                          <DepartmentMark departmentIndex={departmentIndex} />
                          {department.name}
                        </span>
                      )}
                    </span>
                  </CollapsibleTrigger>
                </RowEditMenu>
                <CollapsibleContent>
                  {items.map(row)}
                  {!items.length && (
                    <p className="text-muted-foreground px-3 py-2 text-xs">
                      No channels here.
                    </p>
                  )}
                </CollapsibleContent>
              </Collapsible>
            );
          })}
          {visible
            .filter(
              (item) =>
                item.conversation.kind === "channel" &&
                !item.conversation.category_id &&
                !item.preferences.starred,
            )
            .map(row)}
          {menuAccess.canCreate && (
            <Action
              variant="ghost"
              className="text-muted-foreground min-h-11 w-full justify-start"
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
                        variant={
                          navigation.recordId === record.id
                            ? "secondary"
                            : "ghost"
                        }
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
          {visible
            .filter(
              (item) =>
                item.conversation.kind !== "channel" &&
                !item.preferences.starred,
            )
            .map(row)}
          {!visible.some((item) => item.conversation.kind !== "channel") && (
            <p className="text-muted-foreground px-2 text-xs">
              Start a direct or group conversation.
            </p>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
