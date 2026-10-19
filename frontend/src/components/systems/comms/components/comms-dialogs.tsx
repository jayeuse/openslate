"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Action } from "../../shared/components/ui";
import { DirectDialog } from "./direct-dialog";
import {
  ConfirmActionDialog,
  type ConfirmActionRequest,
} from "./confirm-action-dialog";
import { CommsThreadList } from "./thread-list";
import type { ChannelDialog as ChannelEditor } from "./channel-dialog";
import type { CommsSettingsDialog as SettingsEditor } from "./settings-dialog";
import { AdminTools, toolViews, type ToolView } from "./admin-tools";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";
import type { NavigationState } from "../state/use-comms-navigation";
import { newChannel, type Channel, type Category } from "../domain/view-model";
import type { OpenWorkspaceSetting } from "./comms-menu";

const ChannelDialog = dynamic(() =>
  import("./channel-dialog").then((module) => module.ChannelDialog),
);
const CommsSettingsDialog = dynamic(() =>
  import("./settings-dialog").then((module) => module.CommsSettingsDialog),
);
type Editor = (
  { kind: "channel"; value: Channel } | { kind: "category"; value: Category }
) & { opener: HTMLElement };
type Settings = Pick<
  ComponentProps<typeof SettingsEditor>,
  "scope" | "opener" | "initialSubject" | "initialTab"
>;
type Tools = {
  view: ToolView;
  opener: HTMLElement;
  channelId?: string;
  threadId?: string;
  messageId?: string;
};

export function useCommsDialogs(navigation: NavigationState) {
  const { channels, categories } = useCommsWorkspaceView();
  const channel = channels.find((item) => item.id === navigation.selected);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [confirm, setConfirm] = useState<ConfirmActionRequest | null>(null);
  const [dmOpen, setDmOpen] = useState(false);
  const [directError, setDirectError] = useState("");
  const [threadDirectory, setThreadDirectory] = useState<HTMLElement | null>(
    null,
  );
  const [toolOpener, setToolOpener] = useState<HTMLElement | null>(null);
  const directoryOpener = useRef<HTMLElement | null>(null);
  const setTools = (tool: Tools) => {
    setToolOpener(tool.opener);
    navigation.update({
      tool: tool.view,
      ...(tool.messageId ? { message: tool.messageId } : {}),
      ...(tool.threadId ? { thread: tool.threadId } : {}),
    });
  };
  const openSetting: OpenWorkspaceSetting = (setting, opener) => {
    if (setting === "personal" || setting === "workspace") {
      setSettings({
        scope:
          setting === "personal"
            ? "personal"
            : { kind: "workspace", id: "workspace" },
        opener,
      });
    } else if (toolViews.includes(setting as ToolView)) {
      setTools({ view: setting as ToolView, opener, channelId: channel?.id });
    } else if (setting === "threads") {
      directoryOpener.current = opener;
      setThreadDirectory(opener);
    } else {
      const category = categories.find(
        (item) => item.id === channel?.categoryId,
      );
      if (setting === "create-channel")
        setEditor({
          kind: "channel",
          value: newChannel(category?.id ?? categories[0]?.id ?? ""),
          opener,
        });
      else if (setting === "edit-channel" && channel)
        setEditor({ kind: "channel", value: channel, opener });
      else if (setting === "create-category")
        setEditor({ kind: "category", value: { id: "", name: "" }, opener });
      else if (setting === "edit-category" && category)
        setEditor({ kind: "category", value: category, opener });
    }
  };
  return {
    editor,
    setEditor,
    settings,
    setSettings,
    confirm,
    setConfirm,
    dmOpen,
    setDmOpen,
    directError,
    setDirectError,
    threadDirectory,
    setThreadDirectory,
    toolOpener,
    directoryOpener,
    setTools,
    openSetting,
  };
}
export type CommsDialogsState = ReturnType<typeof useCommsDialogs>;

export function CommsDialogs({
  state,
  navigation,
  select,
  openThread,
  fallbackOpener,
}: {
  state: CommsDialogsState;
  navigation: NavigationState;
  select: (id: string) => void;
  openThread: (
    thread: ReturnType<typeof useCommsWorkspaceView>["threads"][number],
    id: string,
  ) => void;
  fallbackOpener: React.RefObject<HTMLDivElement | null>;
}) {
  const { channels, categories, people, roles, threads, messages } =
    useCommsWorkspaceView();
  const [threadFilter, setThreadFilter] = useState<"active" | "inactive">(
    "active",
  );
  const [fallback, setFallback] = useState<HTMLElement | null>(null);
  useEffect(() => setFallback(fallbackOpener.current), [fallbackOpener]);
  const tool = navigation.query.get("tool") as ToolView;
  const legacySettings = navigation.query.get("settings") === "permissions";
  const settings =
    state.settings ??
    (legacySettings && fallback
      ? {
          scope: navigation.query.get("channel")
            ? { kind: "channel" as const, id: navigation.query.get("channel")! }
            : { kind: "workspace" as const, id: "workspace" },
          opener: fallback,
          initialTab: "permissions",
          initialSubject: navigation.query.get("role")
            ? `role:${navigation.query.get("role")}`
            : "everyone",
        }
      : null);
  const workspaceThreads = threads.flatMap((thread) => {
    const message = messages.find((item) => item.id === thread.messageId);
    const channel = channels.find(
      (item) => item.id === (thread.conversation ?? message?.conversation),
    );
    return channel
      ? [
          {
            thread,
            channel,
            title: thread.name || message?.text || "Discussion",
          },
        ]
      : [];
  });
  return (
    <>
      <ConfirmActionDialog
        request={state.confirm}
        onClose={() => state.setConfirm(null)}
      />
      {settings && (
        <CommsSettingsDialog
          {...settings}
          channels={channels}
          categories={categories}
          people={people}
          roles={roles}
          onClose={() => {
            state.setSettings(null);
            if (legacySettings)
              navigation.update({ settings: null, channel: null, role: null });
          }}
        />
      )}
      {toolViews.includes(tool) && fallback && (
        <AdminTools
          view={tool}
          opener={state.toolOpener ?? fallback}
          channelId={navigation.selected || undefined}
          threadId={navigation.threadId || undefined}
          messageId={navigation.messageId || undefined}
          onClose={() => navigation.update({ tool: null })}
        />
      )}
      {state.editor && (
        <ChannelDialog
          key={`${state.editor.kind}-${state.editor.value.id}`}
          {...(state.editor as ComponentProps<typeof ChannelEditor>)}
          roles={roles}
          categories={categories}
          channels={channels}
          existing={state.editor.kind === "channel" ? channels : categories}
          onClose={() => state.setEditor(null)}
          people={people}
          onAcceptedChannelSave={select}
        />
      )}
      <Dialog
        open={!!state.threadDirectory}
        onOpenChange={(open) => {
          if (!open) state.setThreadDirectory(null);
        }}
      >
        <DialogContent
          finalFocus={() => state.directoryOpener.current}
          className="max-w-lg"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <DialogTitle>Workspace threads</DialogTitle>
              <DialogDescription>
                Follow discussions across your channels.
              </DialogDescription>
            </div>
            <Action
              size="icon"
              variant="ghost"
              aria-label="Close workspace threads"
              onClick={() => state.setThreadDirectory(null)}
            >
              <X className="size-4" />
            </Action>
          </div>
          <CommsThreadList
            items={workspaceThreads.map(({ thread, channel, title }) => ({
              id: thread.id,
              title,
              inactive: thread.resolved,
              metadata: (
                <>
                  #{channel.name} · {thread.replies.length} replies
                </>
              ),
            }))}
            filter={threadFilter}
            onFilterChange={setThreadFilter}
            onSelect={(item) => {
              const entry = workspaceThreads.find(
                (row) => row.thread.id === item.id,
              );
              if (entry) openThread(entry.thread, entry.channel.id);
            }}
            emptyDescription={`No ${threadFilter} threads in your channels.`}
            filterClassName="my-4"
          />
        </DialogContent>
      </Dialog>
      {state.dmOpen && (
        <DirectDialog onClose={() => state.setDmOpen(false)} select={select} />
      )}
    </>
  );
}
