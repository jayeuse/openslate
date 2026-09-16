"use client";

import { useEffect, useRef, useState } from "react";
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
  initialPeople,
  initialRoles,
  type Person,
  type Role,
} from "../access/model";
import { useSampleState } from "../sample-state";
import { INITIAL_RECORDS, type SampleRecord } from "../sample-data";
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
import type { PanelImperativeHandle } from "react-resizable-panels";
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
import {
  Action,
  Avatar,
  MembersPanel,
  ThreadPanel,
  MessageTimeline,
  MessageComposer,
  type MessageDraft,
} from "./ui";
import { ChannelDialog, newChannel } from "./channel-dialog";
import { FloatingList, RowEditMenu, ProfilePopoverProvider } from "./floating";
import { CommsThreadList, type CommsThreadListItem } from "./thread-list";
import {
  CATEGORIES,
  CHANNELS,
  MESSAGES,
  PEOPLE,
  OPEN_PERMISSIONS,
  messageAuthorId,
  threadMessages,
  type Category,
  type Channel,
  type Direct,
  type Message,
  type Thread,
  type RecordThread,
} from "./model";

import { useCommsConfiguration } from "./configuration-state";
import {
  DEFAULT_COMMS_PREFERENCES,
  resolveCommsPermission,
  resolveCommsSettings,
  type CommsScope,
  type CommsPreferences,
} from "./configuration";
import { CommsSettingsDialog } from "./settings-dialog";
import { CommsToolsDialog } from "./tools-dialog";
import {
  validateCommsMessage,
  validateCommsMessageChange,
} from "./message-policy";
import {
  EXAMPLE_PEOPLE,
  EXAMPLE_CATEGORIES,
  EXAMPLE_CHANNELS,
  EXAMPLE_MESSAGES,
  EXAMPLE_THREADS,
  EXAMPLE_DIRECTS,
} from "./examples";

function appendExamples<T extends { id: string }>(
  current: T[],
  examples: T[],
): T[] {
  const existing = new Set(current.map((item) => item.id));
  return [...current, ...examples.filter((item) => !existing.has(item.id))];
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
  const [config, setConfig] = useCommsConfiguration();
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
  const [people, setPeople] = useSampleState<Person[]>(
    "access-people",
    initialPeople,
  );
  const [roles] = useSampleState<Role[]>("access-roles", initialRoles);
  const [categories, setCategories] = useSampleState<Category[]>(
    "commsCategories",
    CATEGORIES,
  );
  const [channels, setChannels] = useSampleState<Channel[]>(
    "commsChannels",
    CHANNELS,
  );
  const [messages, setMessages] = useSampleState<Message[]>(
    "commsMessages",
    MESSAGES,
  );
  const [storedThreads, setThreads] = useSampleState<Thread[]>(
    "commsThreads",
    [],
  );
  const [directs, setDirects] = useSampleState<Direct[]>("commsDirects", [
    { id: "sample-dm-alex", user: PEOPLE[0], read: false, blocked: false },
  ]);
  const [records] = useSampleState<SampleRecord[]>("records", INITIAL_RECORDS);
  const [examplesLoaded, setExamplesLoaded] = useSampleState(
    "commsExamplesLoaded",
    false,
  );
  useEffect(() => {
    if (examplesLoaded) return;
    const categoryIds = new Set(
      [...categories, ...EXAMPLE_CATEGORIES].map((item) => item.id),
    );
    const newChannels = EXAMPLE_CHANNELS.filter((item) =>
      categoryIds.has(item.categoryId),
    );
    const conversationIds = new Set(
      [...channels, ...newChannels, ...directs, ...EXAMPLE_DIRECTS].map(
        (item) => item.id,
      ),
    );
    const newMessages = EXAMPLE_MESSAGES.filter((item) =>
      conversationIds.has(item.conversation),
    );
    const messageIds = new Set(
      [...messages, ...newMessages].map((item) => item.id),
    );
    setPeople((items) => appendExamples(items, EXAMPLE_PEOPLE));
    setCategories((items) => appendExamples(items, EXAMPLE_CATEGORIES));
    setChannels((items) => appendExamples(items, newChannels));
    setDirects((items) => appendExamples(items, EXAMPLE_DIRECTS));
    setMessages((items) => appendExamples(items, newMessages));
    setThreads((items) =>
      appendExamples(
        items,
        EXAMPLE_THREADS.filter((item) => messageIds.has(item.messageId)),
      ),
    );
    setExamplesLoaded(true);
  }, [
    examplesLoaded,
    categories,
    channels,
    directs,
    messages,
    setPeople,
    setCategories,
    setChannels,
    setDirects,
    setMessages,
    setThreads,
    setExamplesLoaded,
  ]);
  const [recordThreads] = useSampleState<RecordThread[]>(
    "commsRecordThreads",
    [],
  );
  const [account] = useSampleState("platformAccount", {
    language: "English",
    theme: "Light",
    presence: "Available",
    passwordChanged: false,
    signedOut: false,
  });
  const [selected, setSelected] = useState(() =>
    typeof window === "undefined"
      ? CHANNELS[0].id
      : new URLSearchParams(window.location.search).get("conversation") ||
        CHANNELS[0].id,
  );
  const [mobileConversation, setMobileConversation] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("conversation"),
  );
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [dmOpen, setDmOpen] = useState(false);
  const [directError, setDirectError] = useState("");
  const threadDirectoryOpener = useRef<HTMLElement | null>(null);
  const [threadDirectory, setThreadDirectory] = useState<HTMLElement | null>(
    null,
  );
  const [memberOpen, setMemberOpen] = useState(false);
  const [panelWidths] = useSampleState("commsPanelWidths", {
    channels: 240,
    members: 220,
  });
  const [preferredThreadWidth] = useSampleState("commsThreadWidth", 380);
  const container = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setContainerWidth(entry.contentRect.width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const channelsPanel = useRef<PanelImperativeHandle>(null);
  const rightPanel = useRef<PanelImperativeHandle>(null);
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const [wide, setWide] = useState(false);
  const [membersVisible, setMembersVisible] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1280px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const [memberSearch, setMemberSearch] = useState("");
  const [conversationSearch, setConversationSearch] = useState("");
  const [search, setSearch] = useState("");
  const [threadId, setThreadId] = useState(() =>
    typeof window === "undefined"
      ? ""
      : (new URLSearchParams(window.location.search).get("thread") ?? ""),
  );
  const [threadFilter, setThreadFilter] = useState<"active" | "inactive">(
    "active",
  );
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [highlightedId, setHighlightedId] = useState("");
  const [notice, setNotice] = useState("");
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const messageList = useRef<HTMLDivElement>(null);
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
  function patchPreferences(patch: Partial<CommsPreferences>) {
    setConfig((current) => ({
      ...current,
      preferences: {
        ...current.preferences,
        [viewerId]: {
          ...preferences,
          ...current.preferences[viewerId],
          ...patch,
        },
      },
    }));
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
  const availableWidth = containerWidth || 1200;
  const rightOpen = wide && (!!currentThread || membersVisible);
  const minimumChatWidth = Math.min(360, Math.max(280, availableWidth - 212));
  const channelMaximum = Math.max(
    200,
    Math.min(
      360,
      availableWidth -
        minimumChatWidth -
        (rightOpen ? (currentThread ? 320 : 200) : 0) -
        12,
    ),
  );
  const channelWidth = Math.round(
    Math.max(200, Math.min(channelMaximum, preferences.channelWidth)),
  );
  const memberMaximum = Math.max(
    200,
    Math.min(360, availableWidth - channelWidth - minimumChatWidth - 12),
  );
  const memberWidth = Math.round(
    Math.max(200, Math.min(memberMaximum, preferences.memberWidth)),
  );
  const threadMaximum = Math.max(
    320,
    Math.floor(
      Math.min(560, availableWidth - channelWidth - minimumChatWidth - 12),
    ),
  );
  const threadWidth = Math.round(
    Math.max(320, Math.min(threadMaximum, preferences.threadWidth)),
  );
  useEffect(() => {
    // Panel refs are exposed before the group commits its new layout.
    const frame = requestAnimationFrame(() => {
      if (
        desktop &&
        channelsPanel.current &&
        Math.abs(channelsPanel.current.getSize().inPixels - channelWidth) > 0.5
      )
        channelsPanel.current.resize(channelWidth);
      const width = currentThread ? threadWidth : memberWidth;
      if (
        rightOpen &&
        rightPanel.current &&
        Math.abs(rightPanel.current.getSize().inPixels - width) > 0.5
      )
        rightPanel.current.resize(width);
    });
    return () => cancelAnimationFrame(frame);
  }, [
    desktop,
    rightOpen,
    !!currentThread,
    channelWidth,
    memberWidth,
    threadWidth,
  ]);
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
  function latestChannelActivity(id: string) {
    return Math.max(
      0,
      ...allMessages
        .filter(
          (message) =>
            message.conversation === id ||
            threads.some(
              (thread) =>
                thread.id === message.conversation &&
                thread.conversation === id,
            ),
        )
        .map((message) => message.created),
    );
  }
  function channelUnread(id: string) {
    return (
      preferences.readAt[id] === 0 ||
      latestChannelActivity(id) > (preferences.readAt[id] ?? 0)
    );
  }
  function select(id: string) {
    patchPreferences({
      readAt: {
        ...preferences.readAt,
        [id]: Math.max(clockNow, latestChannelActivity(id)),
      },
    });
    setSelected(id);
    setMobileConversation(true);
    setThreadId("");
    setSearch("");
    setReplyingTo(null);
    setHighlightedId("");
    setMemberOpen(false);
    setAwayFromLatest(false);
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
  function openThread(item: Thread, conversation: string) {
    select(conversation);
    setThreadId(item.id);
    setThreadDirectory(null);
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
  function startDirect(name: string) {
    const existing = directs.find((item) => item.user === name);
    if (existing) {
      select(existing.id);
      setDmOpen(false);
      setDirectError("");
      return;
    }
    const dmRule = resolveCommsSettings(config).values.dmRule;
    if (dmRule === "none") {
      setDirectError("New direct messages are disabled by workspace policy.");
      setNotice("New direct messages are disabled by workspace policy.");
      return;
    }
    if (
      dmRule === "shared-channel" &&
      !channels.some((item) =>
        [viewer, people.find((person) => person.name === name)].every(
          (person) =>
            person &&
            resolveCommsPermission(
              config,
              { person, channel: item, categories },
              "viewChannel",
            ).allowed,
        ),
      )
    ) {
      setDirectError("New direct messages require a shared channel.");
      setNotice("New direct messages require a shared channel.");
      return;
    }
    const id = `sample-dm-${crypto.randomUUID()}`;
    setDirects((items) => [
      ...items,
      { id, user: name, read: false, blocked: false },
    ]);
    setDirectError("");
    select(id);
    setDmOpen(false);
  }
  function startThread(message: Message) {
    if (!canParticipate || !permission("createThread")) return;
    const existing = threads.find((item) => item.messageId === message.id);
    const id = existing?.id ?? `sample-thread-${crypto.randomUUID()}`;
    if (!existing)
      setThreads((items) => [
        ...items,
        {
          id,
          messageId: message.id,
          conversation: selected,
          resolved: false,
          replies: [],
          subscribed: settings.defaultThreadSubscription,
        },
      ]);
    setThreadId(id);
    setMemberOpen(false);
  }
  function patchThread(patch: Partial<Thread>) {
    if (!canParticipate) return;
    if (patch.resolved !== undefined || patch.subscribed !== undefined)
      setConfig((current) => ({
        ...current,
        threadMeta: {
          ...current.threadMeta,
          [threadId]: {
            ...current.threadMeta[threadId],
            ...(patch.resolved !== undefined
              ? { resolved: patch.resolved }
              : {}),
            ...(patch.subscribed !== undefined
              ? { followedBy: patch.subscribed ? [viewerId] : [] }
              : {}),
          },
        },
      }));
    setThreads((items) =>
      items.map((item) =>
        item.id === threadId ? { ...item, ...patch } : item,
      ),
    );
  }
  function jumpToMessage(id: string) {
    setSearch("");
    setHighlightedId(id);
    const containingThread = threads.find((item) =>
      threadMessages(item).some((reply) => reply.id === id),
    );
    if (containingThread) setThreadId(containingThread.id);
    requestAnimationFrame(() => {
      const target = document.getElementById(id);
      target?.focus();
      target?.scrollIntoView({ block: "center" });
    });
  }
  function beginReply(message: Message) {
    if (!canParticipate) return;
    setReplyingTo(message);
    requestAnimationFrame(() =>
      document.getElementById(`composer-${selected}`)?.focus(),
    );
  }
  function changeMessage(id: string, patch: Partial<Message>) {
    const message = messages.find((item) => item.id === id);
    if (!canParticipate || !message) return;
    if (patch.text !== undefined) {
      const error = validateCommsMessageChange({
        config,
        person: viewer,
        channel,
        categories,
        people,
        message,
        kind: "edit",
      });
      if (error) {
        setNotice(error);
        return;
      }
      setConfig((current) => ({
        ...current,
        messageHistory: {
          ...current.messageHistory,
          [id]: [...(current.messageHistory[id] ?? []), message],
        },
      }));
    }
    if (patch.pinned !== undefined && !permission("pin")) return;
    if (patch.reactions !== undefined && !permission("react")) return;
    setMessages((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }
  function deleteMessage(id: string) {
    const message = messages.find((item) => item.id === id);
    if (!message || !canParticipate) return;
    const error = validateCommsMessageChange({
      config,
      person: viewer,
      channel,
      categories,
      people,
      message,
      kind: "delete",
    });
    if (error) {
      setNotice(error);
      return;
    }
    setConfig((current) => ({
      ...current,
      tombstones: { ...current.tombstones, [id]: message },
    }));
    setMessages((items) => items.filter((item) => item.id !== id));
  }
  function validateDraft(
    draft: MessageDraft,
    kind: "post" | "reply" | "thread",
  ) {
    return validateCommsMessage({
      config,
      person: viewer,
      channel,
      categories,
      people,
      roles,
      messages: allMessages.filter(
        (item) =>
          item.conversation === selected ||
          channelThreads.some((thread) => thread.id === item.conversation),
      ),
      text: draft.text,
      files: draft.files,
      record: records.find((item) => item.id === draft.recordId),
      now: draft.sentAt,
      kind,
    });
  }
  function sendMessage(draft: MessageDraft) {
    const { text, files, recordId, sentAt } = draft;
    const kind = replyingTo
      ? "reply"
      : channel && settings.mode === "thread-first"
        ? "thread"
        : "post";
    const error = validateDraft(draft, kind);
    if (error || !viewer || !canParticipate)
      return error ?? "This conversation is read-only.";
    const id = `sample-message-${crypto.randomUUID()}`;
    setMessages((items) => [
      ...items,
      {
        id,
        conversation: selected,
        author: viewer.name,
        authorId: viewer.id,
        text: text.trim() || "Shared a file",
        created: sentAt,
        pinned: false,
        ...(files.length ? { files } : {}),
        ...(recordId ? { recordId } : {}),
        ...(replyingTo ? { replyToId: replyingTo.id } : {}),
      },
    ]);
    if (kind === "thread") {
      const idThread = `sample-thread-${crypto.randomUUID()}`;
      setThreads((items) => [
        ...items,
        {
          id: idThread,
          messageId: id,
          conversation: selected,
          resolved: false,
          replies: [],
          subscribed: settings.defaultThreadSubscription,
        },
      ]);
      setThreadId(idThread);
    }
    setReplyingTo(null);
    setNotice("Message sent.");
    requestAnimationFrame(() =>
      messageList.current?.scrollTo({ top: messageList.current.scrollHeight }),
    );
    return null;
  }
  function moveCategory(id: string, direction: number) {
    setCategories((items) => {
      const next = [...items];
      const from = next.findIndex((item) => item.id === id);
      const to = from + direction;
      if (to >= 0 && to < next.length)
        [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
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
      onArchiveMessage={(message) =>
        setConfig((current) => ({
          ...current,
          tombstones: { ...current.tombstones, [message.id]: message },
        }))
      }
      onMessageHistory={(message) =>
        setConfig((current) => ({
          ...current,
          messageHistory: {
            ...current.messageHistory,
            [message.id]: [
              ...(current.messageHistory[message.id] ?? []),
              message,
            ],
          },
        }))
      }
      onThread={startThread}
      onDirect={startDirect}
      onClose={() => {
        setThreadId("");
        setMembersVisible(true);
      }}
      onChange={patchThread}
    />
  );

  return (
    <ProfilePopoverProvider>
      <div
        ref={container}
        className="bg-card relative flex min-h-0 flex-1 overflow-hidden"
      >
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
                                    ? items.filter((id) => id !== category.id)
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
                                  scope: { kind: "category", id: category.id },
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
                              disabled: categoryIndex === categories.length - 1,
                              onSelect: () => moveCategory(category.id, 1),
                            },
                            {
                              label: "Apply template",
                              onSelect: (opener) =>
                                setToolsDialog({ view: "templates", opener }),
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
                              <span className="truncate">{category.name}</span>
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
                            .filter((item) => item.categoryId === category.id)
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
                                        (preferences.mutedUntil[item.id] ?? 0) >
                                        Date.now()
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
                                            [item.id]: channelUnread(item.id)
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
                                      onSelect: () => copyConversation(item.id),
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
                                          setChannels((items) =>
                                            items.map((channel) =>
                                              channel.id === item.id
                                                ? {
                                                    ...channel,
                                                    categoryId: category.id,
                                                  }
                                                : channel,
                                            ),
                                          ),
                                      })),
                                    {
                                      label: "Duplicate channel",
                                      onSelect: () => {
                                        const id = `sample-channel-${crypto.randomUUID()}`;
                                        setChannels((items) => [
                                          ...items,
                                          {
                                            ...item,
                                            id,
                                            name: `${item.name}-copy`,
                                            archived: false,
                                          },
                                        ]);
                                        setConfig((current) => ({
                                          ...current,
                                          channels: {
                                            ...current.channels,
                                            [id]: current.channels[item.id] ?? {
                                              settings: {},
                                              permissions: {},
                                            },
                                          },
                                        }));
                                      },
                                    },
                                    {
                                      label: item.archived
                                        ? "Restore channel"
                                        : "Archive channel",
                                      onSelect: () =>
                                        setChannels((items) =>
                                          items.map((channel) =>
                                            channel.id === item.id
                                              ? {
                                                  ...channel,
                                                  archived: !channel.archived,
                                                }
                                              : channel,
                                          ),
                                        ),
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
                                      {preferences.favorites.includes(item.id)
                                        ? "★ "
                                        : ""}
                                      {item.name}
                                    </span>
                                    {(preferences.mutedUntil[item.id] ?? 0) >
                                      Date.now() && (
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
                                          !config.threadMeta[entry.thread.id]
                                            ?.archived &&
                                          resolveCommsSettings(
                                            config,
                                            item,
                                            categories,
                                          ).values.threadBranches !== "none" &&
                                          (resolveCommsSettings(
                                            config,
                                            item,
                                            categories,
                                          ).values.threadBranches !==
                                            "followed" ||
                                            (config.threadMeta[
                                              entry.thread.id
                                            ]?.followedBy?.includes(viewerId) ??
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
                          variant={selected === item.id ? "secondary" : "ghost"}
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
                        onClick={() => {
                          if (!channels.some((entry) => entry.id === item.id)) {
                            setChannels((items) => [
                              ...items,
                              {
                                ...newChannel(categories[0].id),
                                id: item.id,
                                name: item.text,
                              },
                            ]);
                            setMessages((items) => [
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
                          }
                          select(item.id);
                        }}
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
                      {channel?.name ?? direct?.user ?? "Choose a conversation"}
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
                      onClick={() =>
                        setDirects((items) =>
                          items.map((item) =>
                            item.id === selected
                              ? { ...item, read: !item.read }
                              : item,
                          ),
                        )
                      }
                    >
                      Mark {direct.read ? "unread" : "read"}
                    </Action>
                    <Action
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setDirects((items) =>
                          items.map((item) =>
                            item.id === selected
                              ? { ...item, blocked: !item.blocked }
                              : item,
                          ),
                        )
                      }
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
                            Choose another conversation or update the channel
                            settings.
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
                              mutable={canParticipate}
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
                />
                {notice && <Alert className="sr-only">{notice}</Alert>}
              </section>
            </ResizablePanel>
          )}
          {rightOpen && (
            <>
              <ResizableHandle
                aria-label={currentThread ? "Resize thread" : "Resize members"}
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
                    <ScrollArea className="h-full">{membersContent}</ScrollArea>
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
            onSave={(value: Channel | Category, beforeId: string) => {
              if ("categoryId" in value) {
                setChannels((items) => {
                  const next = items.some((item) => item.id === value.id)
                    ? items.map((item) => (item.id === value.id ? value : item))
                    : [...items, value];
                  if (beforeId === "unchanged") return next;
                  const reordered = next.filter((item) => item.id !== value.id);
                  const at = reordered.findIndex(
                    (item) => item.id === beforeId,
                  );
                  reordered.splice(at < 0 ? reordered.length : at, 0, value);
                  return reordered;
                });
                if (selected !== value.id) select(value.id);
              } else
                setCategories((items) => {
                  const next = items.some((item) => item.id === value.id)
                    ? items.map((item) => (item.id === value.id ? value : item))
                    : [...items, value];
                  if (beforeId === "unchanged") return next;
                  const reordered = next.filter((item) => item.id !== value.id);
                  const at = reordered.findIndex(
                    (item) => item.id === beforeId,
                  );
                  reordered.splice(at < 0 ? reordered.length : at, 0, value);
                  return reordered;
                });
              setEditor(null);
            }}
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
  );
}
