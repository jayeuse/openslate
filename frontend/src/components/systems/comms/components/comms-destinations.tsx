"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { useCommsRead } from "../state/runtime";
import { complete } from "../state/workspace-view";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";
import { useCommsSidebar, rowLabel } from "../state/use-comms-sidebar";
import type { NavigationState } from "../state/use-comms-navigation";
import type { Thread } from "../domain/view-model";
import { ConversationCounts } from "./conversation-row";
import { CommsThreadList } from "./thread-list";

function ActivityView({ navigation }: { navigation: NavigationState }) {
  const { rows } = useCommsSidebar();
  const activity = useCommsRead("activity", (client, signal) =>
    complete((offset) =>
      client.listActivity(
        { limit: 100, offset, sort_order: "desc" },
        { signal },
      ),
    ),
  );
  if (activity.error)
    return (
      <Alert role="alert" variant="destructive">
        {activity.error}
        <Button variant="outline" onClick={activity.reload}>
          Retry
        </Button>
      </Alert>
    );
  if (!activity.data) return <p role="status">Loading activity…</p>;
  const visible = activity.data.filter((notice) =>
    rows.some((row) => row.conversation.id === notice.conversation_id),
  );
  return (
    <div className="flex flex-col gap-2">
      {visible.map((notice) => {
        const label =
          notice.kind === "comms-mention"
            ? "Mention"
            : notice.kind === "comms-direct"
              ? "Direct message"
              : notice.kind === "comms-thread-reply"
                ? "Thread reply"
                : "Keyword match";
        return (
          <Button
            key={notice.id}
            variant="outline"
            className="min-h-11 justify-start"
            onClick={() =>
              navigation.navigate(notice.conversation_id, {
                message: notice.message_id,
              })
            }
          >
            {label} in{" "}
            {
              rows.find((row) => row.conversation.id === notice.conversation_id)
                ?.name
            }
          </Button>
        );
      })}
      {!visible.length && (
        <p className="text-muted-foreground py-4">No activity yet.</p>
      )}
    </div>
  );
}
function BrowseView({ select }: { select: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const { rows, change } = useCommsSidebar();
  const resource = useCommsRead("browse-channels", (client, signal) =>
    complete((offset) =>
      client.listConversations(
        { limit: 100, offset, sort_by: "name" },
        { signal },
      ),
    ),
  );
  const channels = resource.data?.filter(
    (room) =>
      room.kind === "channel" &&
      room.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <Input
        aria-label="Find a channel"
        placeholder="Find a channel…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="mb-4"
      />
      {resource.error ? (
        <Alert role="alert" variant="destructive">
          {resource.error}
          <Button onClick={resource.reload}>Retry</Button>
        </Alert>
      ) : !channels ? (
        <p role="status">Loading channels…</p>
      ) : (
        <div className="flex flex-col gap-2">
          {channels.map((channel) => (
            <div key={channel.id} className="flex gap-2">
              <Button
                variant="outline"
                className="min-h-11 flex-1 justify-start"
                onClick={() => select(channel.id)}
              >
                {channel.kind === "channel" ? channel.name : "Conversation"}
              </Button>
              {rows.find((row) => row.conversation.id === channel.id)
                ?.preferences.hidden && (
                <Button
                  variant="outline"
                  onClick={() => void change(channel.id, { hidden: false })}
                >
                  Show in sidebar
                </Button>
              )}
            </div>
          ))}
          {!channels.length && (
            <p className="text-muted-foreground py-4">No channels match.</p>
          )}
        </div>
      )}
    </>
  );
}
export function CommsDestinations({
  navigation,
  select,
  openThread,
}: {
  navigation: NavigationState;
  select: (id: string) => void;
  openThread: (thread: Thread, id: string) => void;
}) {
  const { rows } = useCommsSidebar();
  const { threads, messages } = useCommsWorkspaceView();
  const [filter, setFilter] = useState<"active" | "inactive">("active");
  const title =
    navigation.view === "inbox"
      ? "Inbox"
      : navigation.view === "activity"
        ? "Activity"
        : navigation.view === "threads"
          ? "Threads"
          : "Browse channels";
  const unread = rows.filter((row) => row.unread);
  return (
    <section aria-label={title} className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-14 items-center gap-3 border-b px-4">
        <Button
          variant="ghost"
          onClick={() => navigation.navigate(navigation.selected)}
        >
          Back to conversation
        </Button>
        <h2 className="font-semibold">{title}</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {navigation.view === "activity" ? (
          <ActivityView navigation={navigation} />
        ) : navigation.view === "browse" ? (
          <BrowseView select={select} />
        ) : navigation.view === "threads" ? (
          <CommsThreadList
            items={threads.map((thread) => ({
              id: thread.id,
              title:
                thread.name ||
                messages.find((message) => message.id === thread.messageId)
                  ?.text ||
                "Discussion",
              inactive: thread.resolved,
              metadata: rows.find(
                (row) => row.conversation.id === thread.conversation,
              )?.name,
            }))}
            filter={filter}
            onFilterChange={setFilter}
            onSelect={(item) => {
              const thread = threads.find((thread) => thread.id === item.id);
              if (thread?.conversation) openThread(thread, thread.conversation);
            }}
            emptyDescription={`No ${filter} threads in your conversations.`}
            filterClassName="mb-4"
          />
        ) : (
          <div className="flex flex-col gap-2">
            {unread.map((row) => (
              <Button
                key={row.conversation.id}
                variant="outline"
                className="min-h-11 justify-start"
                aria-label={rowLabel(row)}
                onClick={() => select(row.conversation.id)}
              >
                {row.name}
                <ConversationCounts row={row} />
              </Button>
            ))}
            {!unread.length && (
              <p className="text-muted-foreground py-4">
                You’re caught up. No unread conversations.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
