"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Hash,
  MessageSquare,
  Pin,
  Settings2,
  Users,
  Plus,
  ArrowLeft,
  CornerDownRight,
  FolderPlus,
  X,
} from "lucide-react";
import {
  useSampleState,
  type SampleTransactionDraft,
} from "../shared/runtime/sample-state";
import { SampleOperationError } from "../shared/runtime/sample-runtime";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
} from "@/components/ui/message-scroller";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
import {
  Avatar,
  MembersPanel,
  ThreadPanel,
  MessageTimeline,
  MessageComposer,
} from "./components/ui";
import { Action } from "../shared/components/ui";
import {
  COMMS_CONFIGURATION_KEY,
  messageFromCommsError,
  readCommsConfiguration,
  stageCommsConfiguration,
} from "./state/runtime";
import {
  INITIAL_DIRECTS,
  useCommsWorkspace,
} from "./state/use-comms-workspace";
import { useCommsPanelLayout } from "./state/use-comms-panel-layout";
import {
  createCommsNavigationActions,
  useCommsNavigationState,
} from "./state/use-comms-navigation";
import { createCommsMessageOperations } from "./state/use-comms-message-operations";
import { createCommsConversationOperations } from "./state/use-comms-conversation-operations";
import { ChannelDialog, newChannel } from "./components/channel-dialog";
import {
  FloatingList,
  RowEditMenu,
  ProfilePopoverProvider,
} from "./components/floating";
import {
  CommsThreadList,
  type CommsThreadListItem,
} from "./components/thread-list";
import {
  CATEGORIES,
  CHANNELS,
  MESSAGES,
  OPEN_PERMISSIONS,
  messageAuthorId,
  threadMessages,
  type Category,
  type Channel,
  type Direct,
  type Message,
  type RecordThread,
} from "./domain/model";

import {
  CommsConfigurationProvider,
  CommsPlatformPreferencesProvider,
} from "./state/configuration-state";
import {
  DEFAULT_COMMS_PREFERENCES,
  resolveCommsPermission,
  resolveCommsSettings,
  type CommsScope,
  type CommsPreferences,
} from "./domain/configuration";
import { CommsSettingsDialog } from "./components/settings-dialog";
import { CommsToolsDialog } from "./components/tools-dialog";

function stageCommsEditor(
  draft: SampleTransactionDraft,
  value: Channel | Category,
  beforeId: string,
): void {
  if ("categoryId" in value)
    draft.update<Channel[]>("commsChannels", CHANNELS, (items) => {
      const next = items.some((item) => item.id === value.id)
        ? items.map((item) => (item.id === value.id ? value : item))
        : [...items, value];
      if (beforeId === "unchanged") return next;
      const reordered = next.filter((item) => item.id !== value.id);
      const at = reordered.findIndex((item) => item.id === beforeId);
      reordered.splice(at < 0 ? reordered.length : at, 0, value);
      return reordered;
    });
  else
    draft.update<Category[]>("commsCategories", CATEGORIES, (items) => {
      const next = items.some((item) => item.id === value.id)
        ? items.map((item) => (item.id === value.id ? value : item))
        : [...items, value];
      if (beforeId === "unchanged") return next;
      const reordered = next.filter((item) => item.id !== value.id);
      const at = reordered.findIndex((item) => item.id === beforeId);
      reordered.splice(at < 0 ? reordered.length : at, 0, value);
      return reordered;
    });
}

type ToolView =
  | "management"
  | "templates"
  | "automation"
  | "history"
  | "moderation"
  | "outbox"
  | "retention"
  | "thread"
  | "message-history"
  | "report";
type Editor = (
  { kind: "channel"; value: Channel } | { kind: "category"; value: Category }
) & { opener: HTMLElement };
type WorkspaceSetting =
  | "create-channel"
  | "edit-channel"
  | "create-category"
  | "edit-category"
  | "threads"
  | "personal"
  | "workspace"
  | "management"
  | "templates"
  | "automation"
  | "history"
  | "moderation"
  | "outbox"
  | "retention";

function CommsMenu({
  compact = false,
  hasChannel,
  onSelect,
}: {
  compact?: boolean;
  hasChannel: boolean;
  onSelect: (setting: WorkspaceSetting, opener: HTMLElement) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const actions = [
    { id: "personal", label: "My preferences", icon: Settings2 },
    { id: "workspace", label: "Workspace settings", icon: Settings2 },
    { id: "management", label: "Channel management", icon: Hash },
    { id: "templates", label: "Templates", icon: FolderPlus },
    { id: "automation", label: "Automation", icon: Settings2 },
    { id: "history", label: "History", icon: MessageSquare },
    { id: "moderation", label: "Moderation", icon: Users },
    { id: "outbox", label: "Scheduled messages", icon: MessageSquare },
    { id: "retention", label: "Retention", icon: Settings2 },
    { id: "create-channel", label: "Create channel", icon: Plus },
    { id: "edit-channel", label: "Edit channel", icon: Settings2 },
    { id: "create-category", label: "Create category", icon: FolderPlus },
    { id: "edit-category", label: "Edit category", icon: Settings2 },
  ] as const;
  return (
    <h1 className={cn("min-w-0", compact && "md:hidden")}>
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={trigger}
          className={cn(
            "hover:bg-muted focus-visible:ring-ring flex min-h-11 items-center gap-2 rounded-md px-2 text-left font-semibold tracking-tight outline-none focus-visible:ring-2",
            compact && "min-h-7 px-0 text-xs",
          )}
        >
          OpenComms <ChevronDown aria-hidden="true" className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-60 max-w-[calc(100vw-32px)] p-1.5"
          aria-label="OpenComms settings"
        >
          <DropdownMenuGroup>
            {actions.map(({ id, label, icon: Icon }) => (
              <DropdownMenuItem
                key={id}
                className="min-h-10"
                disabled={id.startsWith("edit-") && !hasChannel}
                onClick={() => {
                  if (trigger.current) onSelect(id, trigger.current);
                }}
              >
                <Icon aria-hidden="true" /> {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              className="min-h-10"
              onClick={() => {
                if (trigger.current) onSelect("threads", trigger.current);
              }}
            >
              <MessageSquare aria-hidden="true" /> Browse threads
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </h1>
  );
}

export default function SampleComms() {
  const [notice, setNotice] = useState("");
  const { commsResource, workspace, run, isPending } =
    useCommsWorkspace(setNotice);
  const {
    configuration: config,
    people,
    roles,
    categories,
    channels,
    messages,
    threads: storedThreads,
    directs,
    records,
    recordThreads,
    account,
    platformPreferences,
  } = workspace;
  const navigation = useCommsNavigationState();
  const {
    selected,
    setSelected,
    mobileConversation,
    setMobileConversation,
    threadId,
    setThreadId,
    memberOpen,
    setMemberOpen,
    search,
    setSearch,
    replyingTo,
    setReplyingTo,
    highlightedId,
    setHighlightedId,
    awayFromLatest,
    setAwayFromLatest,
    messageList,
  } = navigation;
  const [settingsDialog, setSettingsDialog] = useState<{
    scope: CommsScope | "personal";
    opener: HTMLElement;
    initialSubject?: string;
    initialTab?: string;
  } | null>(null);
  const [toolsDialog, setToolsDialog] = useState<{
    view: ToolView;
    opener: HTMLElement;
    channelId?: string;
    threadId?: string;
    messageId?: string;
  } | null>(null);
  const guardWorkspaceNavigation = useCallback(() => {
    if (!isPending()) return true;
    setNotice("Finish the current OpenComms change before leaving this page.");
    return false;
  }, [isPending]);
  useWorkspaceNavigationGuard(guardWorkspaceNavigation);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [dmOpen, setDmOpen] = useState(false);
  const [directError, setDirectError] = useState("");
  const threadDirectoryOpener = useRef<HTMLElement | null>(null);
  const [threadDirectory, setThreadDirectory] = useState<HTMLElement | null>(
    null,
  );
  const [panelWidths] = useSampleState("commsPanelWidths", {
    channels: 240,
    members: 220,
  });
  const [preferredThreadWidth] = useSampleState("commsThreadWidth", 380);
  const [membersVisible, setMembersVisible] = useState(true);
  const [memberSearch, setMemberSearch] = useState("");
  const [conversationSearch, setConversationSearch] = useState("");
  const [threadFilter, setThreadFilter] = useState<"active" | "inactive">(
    "active",
  );
  const viewerId = "sample-eli";
  const viewer = people.find(
    (person) => person.id === viewerId && person.active,
  );
  const activePeople = people.filter((person) => person.active);
  const channel = channels.find((item) => item.id === selected);
  const direct = directs.find((item) => item.id === selected);
  const preferences = config.preferences[viewerId] ?? {
    ...DEFAULT_COMMS_PREFERENCES,
    channelWidth: panelWidths.channels,
    memberWidth: panelWidths.members,
    threadWidth: preferredThreadWidth,
  };
  const settings = resolveCommsSettings(config, channel, categories).values;
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const threads = storedThreads.map((thread) => {
    const parent = channels.find(
      (item) =>
        item.id ===
        (thread.conversation ??
          messages.find((message) => message.id === thread.messageId)
            ?.conversation),
    );
    const days = resolveCommsSettings(config, parent, categories).values
      .autoArchiveDays;
    const activity = Math.max(
      messages.find((message) => message.id === thread.messageId)?.created ?? 0,
      ...threadMessages(thread).map((message) => message.created),
    );
    const meta = config.threadMeta[thread.id];
    return {
      ...thread,
      resolved:
        Boolean(meta?.archived) ||
        (meta?.resolved ??
          (thread.resolved ||
            Boolean(
              days > 0 && activity && clockNow - activity >= days * 86400000,
            ))),
      subscribed: meta?.followedBy?.includes("sample-eli") ?? thread.subscribed,
    };
  });
  const permission = (action: Parameters<typeof resolveCommsPermission>[2]) =>
    resolveCommsPermission(
      config,
      { person: viewer, channel, categories },
      action,
    ).allowed;
  const canView = permission("viewChannel");
  const canParticipate =
    canView && !channel?.archived && !direct?.blocked && !settings.locked;
  const canPost =
    canParticipate &&
    permission("post") &&
    (settings.mode !== "announcements" || viewerId === "sample-eli");
  const elevated = permission("pin");
  async function patchPreferences(patch: Partial<CommsPreferences>) {
    try {
      await run(
        "preferences",
        (draft) => {
          const current = readCommsConfiguration(draft);
          const currentPreferences = current.preferences[viewerId] ?? {
            ...DEFAULT_COMMS_PREFERENCES,
            channelWidth: panelWidths.channels,
            memberWidth: panelWidths.members,
            threadWidth: preferredThreadWidth,
          };
          stageCommsConfiguration(draft, (value) => ({
            ...value,
            preferences: {
              ...value.preferences,
              [viewerId]: { ...currentPreferences, ...patch },
            },
          }));
        },
        [COMMS_CONFIGURATION_KEY],
      );
    } catch (error) {
      setNotice(
        messageFromCommsError(error, "Preferences could not be saved."),
      );
    }
  }
  const identity = {
    people,
    roles,
    viewerId,
    viewerPresence: account.presence,
    elevated,
    allowDownload: permission("downloadFiles"),
    preferences,
    settings,
  };
  const allMessages = [...messages, ...threads.flatMap(threadMessages)];
  const channelThreads = canView
    ? threads.filter(
        (item) =>
          (item.conversation ??
            messages.find((message) => message.id === item.messageId)
              ?.conversation) === selected,
      )
    : [];
  const pinnedMessages = canView
    ? [
        ...messages.filter((item) => item.conversation === selected),
        ...channelThreads.flatMap(threadMessages),
      ].filter((item) => item.pinned)
    : [];
  const members = activePeople.filter((person) =>
    channel
      ? resolveCommsPermission(
          config,
          { person, channel, categories },
          "viewChannel",
        ).allowed
      : person.name === direct?.user,
  );
  const currentThread = canView
    ? threads.find((item) => item.id === threadId)
    : undefined;
  const {
    container,
    channelsPanel,
    rightPanel,
    desktop,
    wide,
    rightOpen,
    minimumChatWidth,
    channelMaximum,
    channelWidth,
    memberMaximum,
    memberWidth,
    threadMaximum,
    threadWidth,
  } = useCommsPanelLayout({
    preferences,
    hasThread: !!currentThread,
    membersVisible,
  });
  const {
    channelUnread,
    latestChannelActivity,
    select,
    openThread,
    jumpToMessage,
    beginReply,
    scrollToLatest,
  } = createCommsNavigationActions({
    state: navigation,
    preferences,
    clockNow,
    allMessages,
    threads,
    canParticipate,
    patchPreferences,
    setThreadDirectory,
  });
  const { startDirect, startThread, patchThread } =
    createCommsConversationOperations({
      run,
      selected,
      threadId,
      viewerId,
      select,
      setDirectError,
      setNotice,
      setDmOpen,
      setThreadId,
      setMemberOpen,
    });
  const threadMessage = allMessages.find(
    (item) => item.id === currentThread?.messageId,
  );
  const visibleMessages =
    canView && permission("viewHistory")
      ? messages.filter(
          (item) =>
            item.conversation === selected &&
            item.text.toLowerCase().includes(search.toLowerCase()),
        )
      : [];
  const channelThreadItems: CommsThreadListItem[] = channelThreads.map(
    (item) => ({
      id: item.id,
      title:
        allMessages.find((message) => message.id === item.messageId)?.text ??
        "",
      inactive: item.resolved,
      metadata: (
        <>
          {item.replies.length} replies ·{" "}
          {item.resolved ? "Inactive" : "Active"}
        </>
      ),
    }),
  );
  const filteredChannels = channels.filter(
    (item) =>
      viewer &&
      resolveCommsPermission(
        config,
        { person: viewer, channel: item, categories },
        "viewChannel",
      ).allowed &&
      !preferences.hiddenChannels.includes(item.id) &&
      item.name.toLowerCase().includes(conversationSearch.toLowerCase()),
  );
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("message");
    if (id) {
      const target = document.getElementById(id);
      target?.focus();
      target?.scrollIntoView({ block: "center" });
    } else
      messageList.current?.scrollTo({ top: messageList.current.scrollHeight });
  }, [selected, mobileConversation, desktop]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const shortcut = [
        event.altKey ? "Alt" : "",
        event.ctrlKey ? "Ctrl" : "",
        event.metaKey ? "Meta" : "",
        event.shiftKey ? "Shift" : "",
        event.key.length === 1 ? event.key.toUpperCase() : event.key,
      ]
        .filter(Boolean)
        .join("+");
      const action = Object.entries(preferences.shortcuts).find(
        ([, value]) => value.toLowerCase() === shortcut.toLowerCase(),
      )?.[0];
      if (action === "search") {
        event.preventDefault();
        document
          .querySelector<HTMLInputElement>('[aria-label="Search messages"]')
          ?.focus();
      }
      if (action === "newMessage") {
        event.preventDefault();
        document
          .getElementById(`composer-${currentThread?.id ?? selected}`)
          ?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [preferences.shortcuts, currentThread?.id, selected]);
  const initialIntent = useRef(false);
  useEffect(() => {
    if (initialIntent.current) return;
    const query = new URLSearchParams(window.location.search);
    if (query.get("settings") !== "permissions") return;
    initialIntent.current = true;
    const channelId = query.get("channel");
    if (channelId && channels.some((item) => item.id === channelId))
      setSelected(channelId);
    setSettingsDialog({
      scope: channelId
        ? { kind: "channel", id: channelId }
        : { kind: "workspace", id: "workspace" },
      opener: container.current!,
      initialTab: "permissions",
      initialSubject: query.get("role")
        ? `role:${query.get("role")}`
        : "everyone",
    });
  }, [channels]);
  function copyConversation(id: string) {
    void navigator.clipboard
      .writeText(
        `${window.location.origin}/comms?conversation=${encodeURIComponent(id)}`,
      )
      .then(
        () => setNotice("Conversation link copied."),
        () => setNotice("The browser could not copy the link."),
      );
  }
  function openWorkspaceSetting(
    setting: WorkspaceSetting,
    opener: HTMLElement,
  ) {
    if (setting === "personal" || setting === "workspace") {
      if (!config.preferences[viewerId]) patchPreferences({});
      setSettingsDialog({
        scope:
          setting === "personal"
            ? "personal"
            : { kind: "workspace", id: "workspace" },
        opener,
      });
      return;
    }
    if (
      [
        "management",
        "templates",
        "automation",
        "history",
        "moderation",
        "outbox",
        "retention",
      ].includes(setting)
    ) {
      setToolsDialog({
        view: setting as ToolView,
        opener,
        channelId: channel?.id,
      });
      return;
    }
    const category = categories.find((item) => item.id === channel?.categoryId);
    if (setting === "threads") {
      threadDirectoryOpener.current = opener;
      setThreadFilter("active");
      setThreadDirectory(opener);
    } else if (setting === "create-channel")
      setEditor({
        kind: "channel",
        value: newChannel(category?.id ?? categories[0].id),
        opener,
      });
    else if (setting === "edit-channel" && channel)
      setEditor({ kind: "channel", value: channel, opener });
    else if (setting === "create-category")
      setEditor({
        kind: "category",
        value: { id: "", name: "", ...OPEN_PERMISSIONS },
        opener,
      });
    else if (setting === "edit-category" && category)
      setEditor({ kind: "category", value: category, opener });
  }
  const workspaceThreads = threads.flatMap((item) => {
    const message = allMessages.find((entry) => entry.id === item.messageId);
    const conversation = item.conversation ?? message?.conversation;
    const parentChannel = channels.find((entry) => entry.id === conversation);
    if (
      !parentChannel ||
      !viewer ||
      !resolveCommsPermission(
        config,
        { person: viewer, channel: parentChannel, categories },
        "viewChannel",
      ).allowed
    )
      return [];
    return [
      {
        thread: item,
        channel: parentChannel,
        title:
          config.threadMeta[item.id]?.name || message?.text || "Discussion",
      },
    ];
  });
  const workspaceThreadItems: CommsThreadListItem[] = workspaceThreads.map(
    (entry) => ({
      id: entry.thread.id,
      title: entry.title,
      inactive: entry.thread.resolved,
      metadata: (
        <>
          #{entry.channel.name} · {entry.thread.replies.length} replies
        </>
      ),
    }),
  );
  const { changeMessage, deleteMessage, validateDraft, sendMessage } =
    createCommsMessageOperations({
      run,
      selected,
      viewerId,
      replyingTo,
      setThreadId,
      setReplyingTo,
      setNotice,
      scrollToLatest,
      config,
      viewer,
      channel,
      categories,
      people,
      roles,
      allMessages,
      channelThreads,
      records,
    });
  async function moveCategory(id: string, direction: number) {
    try {
      await run(
        `category:move:${id}`,
        (draft) => {
          draft.update<Category[]>("commsCategories", CATEGORIES, (items) => {
            const next = [...items];
            const from = next.findIndex((item) => item.id === id);
            const to = from + direction;
            if (from >= 0 && to >= 0 && to < next.length)
              [next[from], next[to]] = [next[to], next[from]];
            return next;
          });
        },
        ["commsCategories"],
      );
    } catch (error) {
      setNotice(
        messageFromCommsError(error, "The category order could not be saved."),
      );
    }
  }
  async function moveChannelToCategory(channelId: string, categoryId: string) {
    try {
      await run(
        `channel:move:${channelId}`,
        (draft) => {
          draft.update<Channel[]>("commsChannels", CHANNELS, (items) =>
            items.map((item) =>
              item.id === channelId ? { ...item, categoryId } : item,
            ),
          );
        },
        ["commsChannels"],
      );
    } catch (error) {
      setNotice(
        messageFromCommsError(error, "The channel could not be moved."),
      );
    }
  }
  async function duplicateChannel(channel: Channel) {
    try {
      await run(
        `channel:duplicate:${channel.id}`,
        (draft) => {
          const id = `sample-channel-${crypto.randomUUID()}`;
          const copy = {
            ...channel,
            id,
            name: `${channel.name}-copy`,
            archived: false,
          };
          draft.update<Channel[]>("commsChannels", CHANNELS, (items) => [
            ...items,
            copy,
          ]);
          stageCommsConfiguration(draft, (current) => ({
            ...current,
            channels: {
              ...current.channels,
              [id]: current.channels[channel.id] ?? {
                settings: {},
                permissions: {},
              },
            },
          }));
        },
        ["commsChannels", COMMS_CONFIGURATION_KEY],
      );
    } catch (error) {
      setNotice(
        messageFromCommsError(error, "The channel could not be duplicated."),
      );
    }
  }
  async function toggleChannelArchive(channelId: string) {
    try {
      await run(
        `channel:archive:${channelId}`,
        (draft) => {
          draft.update<Channel[]>("commsChannels", CHANNELS, (items) =>
            items.map((item) =>
              item.id === channelId
                ? { ...item, archived: !item.archived }
                : item,
            ),
          );
        },
        ["commsChannels"],
      );
    } catch (error) {
      setNotice(
        messageFromCommsError(
          error,
          "The channel archive state could not be saved.",
        ),
      );
    }
  }
  async function ensureRecordThread(item: RecordThread) {
    try {
      await run(
        `record-thread:${item.id}`,
        (draft) => {
          const currentChannels = draft.read<Channel[]>(
            "commsChannels",
            CHANNELS,
          );
          if (currentChannels.some((entry) => entry.id === item.id)) return;
          const currentCategories = draft.read<Category[]>(
            "commsCategories",
            CATEGORIES,
          );
          const categoryId = currentCategories[0]?.id ?? CATEGORIES[0].id;
          draft.update<Channel[]>("commsChannels", CHANNELS, (items) => [
            ...items,
            {
              ...newChannel(categoryId),
              id: item.id,
              name: item.text,
            },
          ]);
          draft.update<Message[]>("commsMessages", MESSAGES, (items) => [
            ...items,
            {
              id: `${item.id}-opening`,
              conversation: item.id,
              author: "You",
              text: item.text,
              created: Date.now(),
              pinned: false,
              recordId: item.recordId,
            },
          ]);
        },
        ["commsChannels", "commsCategories", "commsMessages"],
      );
      select(item.id);
    } catch (error) {
      setNotice(
        messageFromCommsError(
          error,
          "The record conversation could not be opened.",
        ),
      );
    }
  }
  async function toggleDirect(directId: string, field: "read" | "blocked") {
    try {
      await run(
        `direct:update:${directId}:${field}`,
        (draft) => {
          draft.update<Direct[]>("commsDirects", INITIAL_DIRECTS, (items) =>
            items.map((item) =>
              item.id === directId ? { ...item, [field]: !item[field] } : item,
            ),
          );
        },
        ["commsDirects"],
      );
    } catch (error) {
      setNotice(
        messageFromCommsError(
          error,
          "The direct conversation could not be updated.",
        ),
      );
    }
  }
  async function saveEditor(
    value: Channel | Category,
    beforeId: string,
    transaction?: SampleTransactionDraft,
  ) {
    if (transaction) {
      stageCommsEditor(transaction, value, beforeId);
      return;
    }
    const result = await run(
      `editor:save:${value.id}`,
      (draft) => {
        stageCommsEditor(draft, value, beforeId);
        return null;
      },
      ["commsChannels", "commsCategories"],
    ).catch((error: unknown) =>
      messageFromCommsError(
        error,
        "The conversation settings could not be saved.",
      ),
    );
    if (result) {
      setNotice(result);
      throw new SampleOperationError("conflict", result);
    }
    if ("categoryId" in value && selected !== value.id) select(value.id);
    setEditor(null);
  }
  const membersContent = (
    <MembersPanel
      members={members}
      roles={roles}
      viewerId={viewerId}
      viewerPresence={account.presence}
      onClose={() => {
        setMemberOpen(false);
        setMembersVisible(false);
      }}
      onDirect={startDirect}
    />
  );
  const threadContent = currentThread && (
    <ThreadPanel
      key={currentThread.id}
      thread={currentThread}
      message={threadMessage}
      allMessages={allMessages}
      highlightedId={highlightedId}
      onJump={jumpToMessage}
      records={records}
      {...identity}
      archived={config.threadMeta[currentThread.id]?.archived}
      canPost={
        !config.threadMeta[currentThread.id]?.archived &&
        canParticipate &&
        permission("reply") &&
        !config.threadMeta[currentThread.id]?.locked
      }
      threadName={config.threadMeta[currentThread.id]?.name}
      validateDraft={(draft) => validateDraft(draft, "reply")}
      onSettings={(opener) =>
        setToolsDialog({
          view: "thread",
          threadId: currentThread.id,
          channelId: selected,
          opener,
        })
      }
      onMessageTool={(view, messageId, opener) =>
        setToolsDialog({ view, messageId, channelId: selected, opener })
      }
      onThread={startThread}
      onDirect={startDirect}
      onClose={() => {
        setThreadId("");
        setMembersVisible(true);
      }}
      onChange={patchThread}
      pending={isPending(`thread:update:${currentThread.id}`)}
    />
  );

  if (commsResource.status === "loading" && commsResource.data === undefined)
    return (
      <section
        aria-label="OpenComms"
        className="flex min-h-0 flex-1 items-center justify-center p-6"
      >
        <p role="status" className="text-muted-foreground text-sm">
          Loading conversations…
        </p>
      </section>
    );
  if (commsResource.status === "error" && commsResource.data === undefined)
    return (
      <section
        aria-label="OpenComms"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <Alert role="alert" variant="destructive">
          {commsResource.error}
        </Alert>
        <Action type="button" variant="outline" onClick={commsResource.reload}>
          Try again
        </Action>
      </section>
    );

  return (
    <CommsConfigurationProvider value={config}>
      <CommsPlatformPreferencesProvider value={platformPreferences}>
        <ProfilePopoverProvider>
          <div
            ref={container}
            className="bg-card relative flex min-h-0 flex-1 overflow-hidden"
          >
            {(commsResource.refreshing || commsResource.error) && (
              <div className="bg-background/95 absolute inset-x-0 top-0 z-20 flex items-center gap-2 border-b px-4 py-2 text-xs backdrop-blur">
                <p role="status" className="text-muted-foreground flex-1">
                  {commsResource.refreshing
                    ? "Refreshing conversations…"
                    : `Showing the last saved conversations. ${commsResource.error}`}
                </p>
                {!commsResource.refreshing && (
                  <Action
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={commsResource.reload}
                  >
                    Retry
                  </Action>
                )}
              </div>
            )}
            {settingsDialog && (
              <CommsSettingsDialog
                {...settingsDialog}
                channels={channels}
                categories={categories}
                people={people}
                roles={roles}
                onClose={() => setSettingsDialog(null)}
              />
            )}
            {toolsDialog && (
              <CommsToolsDialog
                {...toolsDialog}
                onClose={() => setToolsDialog(null)}
              />
            )}
            <ResizablePanelGroup
              orientation="horizontal"
              onLayoutChanged={(_, meta) => {
                if (!meta.isUserInteraction) return;
                const channelPixels = channelsPanel.current?.getSize().inPixels;
                const rightPixels = rightPanel.current?.getSize().inPixels;
                patchPreferences({
                  ...(desktop && channelPixels
                    ? { channelWidth: Math.round(channelPixels) }
                    : {}),
                  ...(rightOpen && rightPixels
                    ? currentThread
                      ? { threadWidth: Math.round(rightPixels) }
                      : { memberWidth: Math.round(rightPixels) }
                    : {}),
                });
              }}
            >
              {(desktop || !mobileConversation) && (
                <ResizablePanel
                  id="channels"
                  panelRef={channelsPanel}
                  defaultSize={desktop ? channelWidth : "100%"}
                  minSize={desktop ? 200 : 0}
                  maxSize={desktop ? channelMaximum : "100%"}
                  groupResizeBehavior={
                    desktop ? "preserve-pixel-size" : "preserve-relative-size"
                  }
                >
                  <aside
                    id="comms-channels"
                    aria-label="Conversations"
                    className={cn(
                      "bg-muted/25 flex h-full min-h-0 w-full flex-col border-r",
                    )}
                  >
                    <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
                      <CommsMenu
                        hasChannel={!!channel}
                        onSelect={openWorkspaceSetting}
                      />
                      <Action
                        aria-label="Create channel"
                        size="icon"
                        variant="ghost"
                        onClick={(event) =>
                          setEditor({
                            opener: event.currentTarget,
                            kind: "channel",
                            value: newChannel(categories[0].id),
                          })
                        }
                      >
                        <Plus className="size-4" />
                      </Action>
                    </div>
                    <div className="p-3">
                      <Input
                        aria-label="Search conversations"
                        placeholder="Find a conversation…"
                        value={conversationSearch}
                        onChange={(event) =>
                          setConversationSearch(event.target.value)
                        }
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
                              label="Edit category"
                              actionsLabel={`Category actions: ${category.name}`}
                              showActions={false}
                              actions={[
                                {
                                  label: collapsed.includes(category.id)
                                    ? "Expand category"
                                    : "Collapse category",
                                  onSelect: () =>
                                    setCollapsed((items) =>
                                      items.includes(category.id)
                                        ? items.filter(
                                            (id) => id !== category.id,
                                          )
                                        : [...items, category.id],
                                    ),
                                },
                                {
                                  label: "Mute category for 1 hour",
                                  onSelect: () =>
                                    patchPreferences({
                                      mutedUntil: {
                                        ...preferences.mutedUntil,
                                        ...Object.fromEntries(
                                          channels
                                            .filter(
                                              (item) =>
                                                item.categoryId === category.id,
                                            )
                                            .map((item) => [
                                              item.id,
                                              Date.now() + 3600000,
                                            ]),
                                        ),
                                      },
                                    }),
                                },
                                {
                                  label: "Create channel in category",
                                  onSelect: (opener) =>
                                    setEditor({
                                      kind: "channel",
                                      value: newChannel(category.id),
                                      opener,
                                    }),
                                },
                                {
                                  label: "Category settings",
                                  onSelect: (opener) =>
                                    setSettingsDialog({
                                      scope: {
                                        kind: "category",
                                        id: category.id,
                                      },
                                      opener,
                                    }),
                                },
                                {
                                  label: "Move category up",
                                  disabled: categoryIndex === 0,
                                  onSelect: () => moveCategory(category.id, -1),
                                },
                                {
                                  label: "Move category down",
                                  disabled:
                                    categoryIndex === categories.length - 1,
                                  onSelect: () => moveCategory(category.id, 1),
                                },
                                {
                                  label: "Apply template",
                                  onSelect: (opener) =>
                                    setToolsDialog({
                                      view: "templates",
                                      opener,
                                    }),
                                },
                              ]}
                              onEdit={(opener) =>
                                setEditor({
                                  kind: "category",
                                  value: category,
                                  opener,
                                })
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
                                      collapsed.includes(category.id) &&
                                        "-rotate-90",
                                    )}
                                  />
                                  <span className="truncate">
                                    {category.name}
                                  </span>
                                </CollapsibleTrigger>
                                <Action
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`Edit category ${category.name}`}
                                  onClick={(event) =>
                                    setEditor({
                                      kind: "category",
                                      value: category,
                                      opener: event.currentTarget,
                                    })
                                  }
                                >
                                  <Settings2 className="size-3" />
                                </Action>
                                <Action
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`Move ${category.name} ${categoryIndex ? "up" : "down"}`}
                                  disabled={categories.length < 2}
                                  onClick={() =>
                                    moveCategory(
                                      category.id,
                                      categoryIndex ? -1 : 1,
                                    )
                                  }
                                >
                                  {categoryIndex ? (
                                    <ChevronUp className="size-3" />
                                  ) : (
                                    <ChevronDown className="size-3" />
                                  )}
                                </Action>
                              </div>
                            </RowEditMenu>
                            <CollapsibleContent>
                              {filteredChannels
                                .filter(
                                  (item) => item.categoryId === category.id,
                                )
                                .map((item) => (
                                  <div key={item.id}>
                                    <RowEditMenu
                                      label="Edit channel"
                                      actionsLabel={`Channel actions: ${item.name}`}
                                      actions={[
                                        {
                                          label: preferences.favorites.includes(
                                            item.id,
                                          )
                                            ? "Remove from favorites"
                                            : "Add to favorites",
                                          onSelect: () =>
                                            patchPreferences({
                                              favorites:
                                                preferences.favorites.includes(
                                                  item.id,
                                                )
                                                  ? preferences.favorites.filter(
                                                      (id) => id !== item.id,
                                                    )
                                                  : [
                                                      ...preferences.favorites,
                                                      item.id,
                                                    ],
                                            }),
                                        },
                                        {
                                          label:
                                            (preferences.mutedUntil[item.id] ??
                                              0) > Date.now()
                                              ? "Unmute channel"
                                              : "Mute channel for 1 hour",
                                          onSelect: () =>
                                            patchPreferences({
                                              mutedUntil: {
                                                ...preferences.mutedUntil,
                                                [item.id]:
                                                  (preferences.mutedUntil[
                                                    item.id
                                                  ] ?? 0) > Date.now()
                                                    ? 0
                                                    : Date.now() + 3600000,
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
                                                [item.id]: channelUnread(
                                                  item.id,
                                                )
                                                  ? Math.max(
                                                      Date.now(),
                                                      latestChannelActivity(
                                                        item.id,
                                                      ),
                                                    )
                                                  : 0,
                                              },
                                            }),
                                        },
                                        {
                                          label: "Copy channel link",
                                          onSelect: () =>
                                            copyConversation(item.id),
                                        },
                                        {
                                          label: "Channel settings",
                                          onSelect: (opener) =>
                                            setSettingsDialog({
                                              scope: {
                                                kind: "channel",
                                                id: item.id,
                                              },
                                              opener,
                                            }),
                                        },
                                        ...categories
                                          .filter(
                                            (category) =>
                                              category.id !== item.categoryId,
                                          )
                                          .map((category) => ({
                                            label: `Move to ${category.name}`,
                                            onSelect: () =>
                                              void moveChannelToCategory(
                                                item.id,
                                                category.id,
                                              ),
                                          })),
                                        {
                                          label: "Duplicate channel",
                                          onSelect: () =>
                                            void duplicateChannel(item),
                                        },
                                        {
                                          label: item.archived
                                            ? "Restore channel"
                                            : "Archive channel",
                                          onSelect: () =>
                                            void toggleChannelArchive(item.id),
                                        },
                                      ]}
                                      onEdit={(opener) =>
                                        setEditor({
                                          kind: "channel",
                                          value: item,
                                          opener,
                                        })
                                      }
                                    >
                                      <Button
                                        type="button"
                                        variant={
                                          selected === item.id
                                            ? "secondary"
                                            : "ghost"
                                        }
                                        aria-label={item.name}
                                        aria-current={
                                          selected === item.id && !currentThread
                                            ? "page"
                                            : undefined
                                        }
                                        onClick={() => select(item.id)}
                                        className="h-auto min-h-11 w-full justify-start py-2 pr-10 pl-3 text-left"
                                      >
                                        <Hash className="text-muted-foreground size-4 shrink-0" />
                                        <span className="truncate">
                                          {preferences.favorites.includes(
                                            item.id,
                                          )
                                            ? "★ "
                                            : ""}
                                          {item.name}
                                        </span>
                                        {(preferences.mutedUntil[item.id] ??
                                          0) > Date.now() && (
                                          <span className="text-muted-foreground text-[10px]">
                                            Muted
                                          </span>
                                        )}
                                        {channelUnread(item.id) && (
                                          <span
                                            aria-label="Unread"
                                            className="bg-foreground ml-auto size-1.5 shrink-0 rounded-full"
                                          />
                                        )}
                                        {item.archived && (
                                          <span className="text-muted-foreground ml-auto text-[10px]">
                                            Archived
                                          </span>
                                        )}
                                      </Button>
                                    </RowEditMenu>
                                    {workspaceThreads.some(
                                      (entry) => entry.channel.id === item.id,
                                    ) && (
                                      <div
                                        role="group"
                                        aria-label={`Threads in ${item.name}`}
                                        className="mb-1 ml-4 flex min-w-0 flex-col"
                                      >
                                        {workspaceThreads
                                          .filter(
                                            (entry) =>
                                              entry.channel.id === item.id &&
                                              !config.threadMeta[
                                                entry.thread.id
                                              ]?.archived &&
                                              resolveCommsSettings(
                                                config,
                                                item,
                                                categories,
                                              ).values.threadBranches !==
                                                "none" &&
                                              (resolveCommsSettings(
                                                config,
                                                item,
                                                categories,
                                              ).values.threadBranches !==
                                                "followed" ||
                                                (config.threadMeta[
                                                  entry.thread.id
                                                ]?.followedBy?.includes(
                                                  viewerId,
                                                ) ??
                                                  entry.thread.subscribed)),
                                          )
                                          .map((entry) => (
                                            <Tooltip key={entry.thread.id}>
                                              <TooltipTrigger
                                                render={
                                                  <Button
                                                    type="button"
                                                    variant={
                                                      currentThread?.id ===
                                                      entry.thread.id
                                                        ? "secondary"
                                                        : "ghost"
                                                    }
                                                    size="sm"
                                                    aria-label={`Thread: ${entry.title}`}
                                                    aria-current={
                                                      currentThread?.id ===
                                                      entry.thread.id
                                                        ? "page"
                                                        : undefined
                                                    }
                                                    onClick={() =>
                                                      openThread(
                                                        entry.thread,
                                                        item.id,
                                                      )
                                                    }
                                                    className="h-auto min-h-9 min-w-0 justify-start pr-2 pl-0 text-left"
                                                  />
                                                }
                                              >
                                                <CornerDownRight
                                                  aria-hidden="true"
                                                  className="text-muted-foreground mt-2 size-4 shrink-0 self-start"
                                                />
                                                <span className="truncate">
                                                  {entry.title}
                                                </span>
                                                {entry.thread.resolved && (
                                                  <Badge
                                                    variant="secondary"
                                                    className="ml-auto shrink-0"
                                                  >
                                                    Inactive
                                                  </Badge>
                                                )}
                                              </TooltipTrigger>
                                              <TooltipContent>
                                                {entry.title}
                                              </TooltipContent>
                                            </Tooltip>
                                          ))}
                                      </div>
                                    )}
                                  </div>
                                ))}
                            </CollapsibleContent>
                          </Collapsible>
                        ))}
                        <Action
                          variant="ghost"
                          className="text-muted-foreground w-full justify-start"
                          onClick={(event) =>
                            setEditor({
                              opener: event.currentTarget,
                              kind: "category",
                              value: { id: "", name: "", ...OPEN_PERMISSIONS },
                            })
                          }
                        >
                          <Plus className="size-3" />
                          Create category
                        </Action>
                        <div className="mt-5 flex items-center justify-between px-2">
                          <h2 className="text-muted-foreground text-xs font-semibold">
                            Direct messages
                          </h2>
                          <Action
                            size="icon"
                            variant="ghost"
                            aria-label="Start direct message"
                            onClick={() => {
                              setMemberSearch("");
                              setDirectError("");
                              setDmOpen(true);
                            }}
                          >
                            <Plus className="size-4" />
                          </Action>
                        </div>
                        {directs
                          .filter((item) =>
                            item.user
                              .toLowerCase()
                              .includes(conversationSearch.toLowerCase()),
                          )
                          .map((item) => (
                            <Button
                              type="button"
                              variant={
                                selected === item.id ? "secondary" : "ghost"
                              }
                              key={item.id}
                              onClick={() => select(item.id)}
                              className="h-auto min-h-11 w-full justify-start px-3 text-left"
                            >
                              <Avatar name={item.user} />
                              <span
                                className={cn(
                                  "truncate",
                                  !item.read && "font-semibold",
                                )}
                              >
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
                        {recordThreads.map((item) => (
                          <Action
                            key={item.id}
                            variant="ghost"
                            className="h-auto w-full justify-start text-left whitespace-normal"
                            onClick={() => void ensureRecordThread(item)}
                          >
                            {item.text}
                          </Action>
                        ))}
                      </div>
                    </ScrollArea>
                  </aside>
                </ResizablePanel>
              )}
              {desktop && <ResizableHandle aria-label="Resize channels" />}
              {(desktop || mobileConversation) && (
                <ResizablePanel
                  id="conversation"
                  minSize={desktop ? minimumChatWidth : 0}
                >
                  <section
                    aria-label="Conversation"
                    className={cn("flex h-full min-h-0 min-w-0 flex-col")}
                  >
                    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-2">
                      <Action
                        className="md:hidden"
                        size="icon"
                        variant="ghost"
                        aria-label="Conversations"
                        onClick={() => setMobileConversation(false)}
                      >
                        <ArrowLeft className="size-4" />
                      </Action>
                      {channel ? (
                        <Hash className="text-muted-foreground hidden size-5 shrink-0 sm:block" />
                      ) : (
                        <MessageSquare className="text-muted-foreground size-5 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <CommsMenu
                          compact
                          hasChannel={!!channel}
                          onSelect={openWorkspaceSetting}
                        />
                        <h2 className="truncate text-sm font-semibold">
                          {channel?.name ??
                            direct?.user ??
                            "Choose a conversation"}
                        </h2>
                        <p className="text-muted-foreground hidden truncate text-xs lg:block">
                          {channel?.description ?? "Private conversation"}
                        </p>
                      </div>
                      <FloatingList
                        label="Threads"
                        icon={<MessageSquare className="size-4" />}
                      >
                        {(close) => (
                          <CommsThreadList
                            items={channelThreadItems}
                            filter={threadFilter}
                            onFilterChange={setThreadFilter}
                            onSelect={(item) => {
                              close();
                              setThreadId(item.id);
                              setMemberOpen(false);
                            }}
                            emptyDescription={`No ${threadFilter} threads in this conversation.`}
                            filterClassName="mb-3"
                          />
                        )}
                      </FloatingList>
                      <FloatingList
                        label="Pinned messages"
                        icon={<Pin className="size-4" />}
                      >
                        {(close) => (
                          <div className="flex flex-col gap-1">
                            {pinnedMessages.map((message) => (
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
                                    (person) =>
                                      person.id ===
                                      messageAuthorId(message, people),
                                  )?.name ?? message.author}
                                </span>
                                <span className="text-muted-foreground line-clamp-3 text-sm">
                                  {message.text}
                                </span>
                              </Button>
                            ))}
                            {!pinnedMessages.length && (
                              <Empty>
                                <EmptyDescription>
                                  No pinned messages yet.
                                </EmptyDescription>
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
                          wide ? membersVisible && !currentThread : memberOpen
                        }
                        onClick={() => {
                          if (wide)
                            setMembersVisible(
                              currentThread ? true : !membersVisible,
                            );
                          else setMemberOpen(!memberOpen);
                          setThreadId("");
                        }}
                      >
                        <Users className="size-4" />
                      </Action>
                      {channel && (
                        <Action
                          variant="ghost"
                          size="icon"
                          aria-label="Channel settings"
                          onClick={(event) =>
                            setEditor({
                              kind: "channel",
                              value: channel,
                              opener: event.currentTarget,
                            })
                          }
                        >
                          <Settings2 className="size-4" />
                        </Action>
                      )}
                      <Input
                        aria-label="Search messages"
                        placeholder="Search messages"
                        value={search}
                        onChange={(event) => {
                          setSearch(event.target.value);
                          setHighlightedId("");
                        }}
                        className="order-last h-9 w-full sm:w-40 lg:w-48"
                      />
                    </header>
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
                          onClick={() => void toggleDirect(selected, "blocked")}
                        >
                          {direct.blocked ? "Unblock user" : "Block user"}
                        </Action>
                      </div>
                    )}
                    {settings.pinnedRecordId && (
                      <a
                        className="bg-muted/30 border-b px-4 py-2 text-xs underline"
                        href={`/openview?record=${encodeURIComponent(settings.pinnedRecordId)}`}
                      >
                        Pinned incident ·{" "}
                        {records.find(
                          (record) => record.id === settings.pinnedRecordId,
                        )?.title ?? "View record"}
                      </a>
                    )}
                    <MessageScrollerProvider
                      autoScroll={false}
                      defaultScrollPosition="start"
                    >
                      <MessageScroller className="min-h-0 flex-1">
                        <MessageScrollerViewport
                          ref={messageList}
                          aria-label="Messages"
                          className="px-2 py-4 sm:px-4"
                          onScroll={(event) => {
                            const list = event.currentTarget;
                            setAwayFromLatest(
                              list.scrollHeight -
                                list.scrollTop -
                                list.clientHeight >
                                120,
                            );
                          }}
                        >
                          <MessageScrollerContent className="gap-0">
                            {!canView ? (
                              <Alert>
                                Your role does not have access to this channel.
                                Choose another conversation or update the
                                channel settings.
                              </Alert>
                            ) : (
                              <>
                                <div className="mt-4 mb-8 px-3">
                                  <div className="bg-muted mb-3 flex size-12 items-center justify-center rounded-2xl">
                                    <Hash className="text-muted-foreground size-6" />
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
                                      {search
                                        ? "No messages match."
                                        : "No messages yet. Start the conversation below."}
                                    </EmptyDescription>
                                  </Empty>
                                )}
                                <MessageTimeline
                                  key={selected}
                                  visibleMessages={visibleMessages}
                                  allMessages={allMessages}
                                  records={records}
                                  threads={channelThreads}
                                  highlightedId={highlightedId}
                                  {...identity}
                                  mutable={canParticipate && !isPending()}
                                  onMessageTool={(view, messageId, opener) =>
                                    setToolsDialog({
                                      view,
                                      messageId,
                                      channelId: selected,
                                      opener,
                                    })
                                  }
                                  onChange={changeMessage}
                                  onDelete={deleteMessage}
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
                    {awayFromLatest && (
                      <Action
                        className="mx-auto mb-2"
                        size="sm"
                        onClick={() =>
                          messageList.current?.scrollTo({
                            top: messageList.current.scrollHeight,
                            behavior: "instant",
                          })
                        }
                      >
                        Jump to latest
                      </Action>
                    )}
                    <MessageComposer
                      key={selected}
                      id={selected}
                      preferences={preferences}
                      settings={settings}
                      canPost={replyingTo ? canParticipate : canPost}
                      replyingTo={replyingTo}
                      people={people}
                      onCancelReply={() => setReplyingTo(null)}
                      conversationName={
                        channel
                          ? `#${channel.name}`
                          : (direct?.user ?? "a teammate")
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
                      onSend={sendMessage}
                      pending={isPending(`message:send:${selected}`)}
                    />
                    {notice && <Alert className="sr-only">{notice}</Alert>}
                  </section>
                </ResizablePanel>
              )}
              {rightOpen && (
                <>
                  <ResizableHandle
                    aria-label={
                      currentThread ? "Resize thread" : "Resize members"
                    }
                    onKeyDownCapture={(event) => {
                      if (event.key !== "Home" && event.key !== "End") return;
                      event.preventDefault();
                      event.stopPropagation();
                      const width =
                        event.key === "Home"
                          ? currentThread
                            ? 320
                            : 200
                          : currentThread
                            ? threadMaximum
                            : memberMaximum;
                      rightPanel.current?.resize(width);
                      patchPreferences(
                        currentThread
                          ? { threadWidth: width }
                          : { memberWidth: width },
                      );
                    }}
                  />
                  <ResizablePanel
                    key={currentThread ? "thread" : "members"}
                    id={currentThread ? "thread" : "members"}
                    panelRef={rightPanel}
                    defaultSize={currentThread ? threadWidth : memberWidth}
                    minSize={currentThread ? 320 : 200}
                    maxSize={currentThread ? threadMaximum : memberMaximum}
                    groupResizeBehavior="preserve-pixel-size"
                  >
                    <aside
                      id="comms-members"
                      aria-label={
                        currentThread ? "Thread panel" : "Channel members"
                      }
                      className="bg-muted/15 h-full min-h-0 overflow-hidden border-l"
                    >
                      {currentThread ? (
                        threadContent
                      ) : (
                        <ScrollArea className="h-full">
                          {membersContent}
                        </ScrollArea>
                      )}
                    </aside>
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
            <div className="xl:hidden">
              {!wide &&
                !toolsDialog &&
                !settingsDialog &&
                (memberOpen || currentThread) && (
                  <Dialog
                    open
                    onOpenChange={(open) => {
                      if (!open) {
                        setMemberOpen(false);
                        setThreadId("");
                      }
                    }}
                  >
                    <DialogContent
                      className={
                        currentThread
                          ? "h-[calc(100dvh-24px)] max-h-[calc(100dvh-24px)] max-w-lg overflow-hidden p-0"
                          : "h-[85dvh] max-w-md"
                      }
                    >
                      <DialogTitle className="sr-only">
                        {currentThread ? "Thread" : "Members"}
                      </DialogTitle>
                      <DialogDescription className="sr-only">
                        {currentThread
                          ? "Replies to this message"
                          : "People with access to this conversation"}
                      </DialogDescription>
                      {currentThread ? threadContent : membersContent}
                    </DialogContent>
                  </Dialog>
                )}
            </div>
            <Dialog
              open={!!threadDirectory}
              onOpenChange={(open) => {
                if (!open) setThreadDirectory(null);
              }}
            >
              <DialogContent
                finalFocus={() => threadDirectoryOpener.current}
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
                    onClick={() => setThreadDirectory(null)}
                  >
                    <X className="size-4" />
                  </Action>
                </div>
                <CommsThreadList
                  items={workspaceThreadItems}
                  filter={threadFilter}
                  onFilterChange={setThreadFilter}
                  onSelect={(item) => {
                    const entry = workspaceThreads.find(
                      (candidate) => candidate.thread.id === item.id,
                    );
                    if (entry !== undefined) {
                      openThread(entry.thread, entry.channel.id);
                    }
                  }}
                  emptyDescription={`No ${threadFilter} threads in your channels.`}
                  filterClassName="my-4"
                />
              </DialogContent>
            </Dialog>
            {editor && (
              <ChannelDialog
                key={`${editor.kind}-${editor.value.id}`}
                {...editor}
                roles={roles}
                categories={categories}
                channels={channels}
                existing={editor.kind === "channel" ? channels : categories}
                onClose={() => setEditor(null)}
                onSave={saveEditor}
                onAcceptedChannelSave={select}
              />
            )}

            <Dialog open={dmOpen} onOpenChange={setDmOpen}>
              <DialogContent>
                <DialogTitle>Start direct message</DialogTitle>
                <DialogDescription>
                  Choose someone from your workspace.
                </DialogDescription>
                <div className="mt-4 flex flex-col gap-2">
                  {directError && (
                    <Alert role="alert" variant="destructive">
                      {directError}
                    </Alert>
                  )}
                  <Input
                    aria-label="Find a teammate"
                    placeholder="Search people"
                    value={memberSearch}
                    onChange={(event) => setMemberSearch(event.target.value)}
                  />
                  {activePeople
                    .filter((person) =>
                      person.name
                        .toLowerCase()
                        .includes(memberSearch.toLowerCase()),
                    )
                    .map((person) => (
                      <Action
                        key={person.id}
                        variant="ghost"
                        className="justify-start"
                        onClick={() => startDirect(person.name)}
                      >
                        <Avatar name={person.name} />
                        Message {person.name}
                      </Action>
                    ))}
                  <Action onClick={() => setDmOpen(false)}>Cancel</Action>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </ProfilePopoverProvider>
      </CommsPlatformPreferencesProvider>
    </CommsConfigurationProvider>
  );
}
