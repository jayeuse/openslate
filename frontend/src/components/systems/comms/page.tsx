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
  initialPeople,
  initialRoles,
  type Person,
  type Role,
} from "../access/domain/model";
import {
  useSampleRuntime,
  useSampleState,
  type SampleTransactionDraft,
} from "../shared/runtime/sample-state";
import { SampleOperationError } from "../shared/runtime/sample-runtime";
import { useSampleResource } from "../shared/runtime/sample-async";
import { INITIAL_RECORDS, type SampleRecord } from "../shared/data/sample-data";
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
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
import {
  Avatar,
  MembersPanel,
  ThreadPanel,
  MessageTimeline,
  MessageComposer,
  type MessageDraft,
  type ThreadChangeOptions,
} from "./components/ui";
import { Action } from "../shared/components/ui";
import {
  COMMS_CONFIGURATION_KEY,
  messageFromCommsError,
  readCommsConfiguration,
  stageCommsConfiguration,
  useCommsCommands,
} from "./state/runtime";
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
} from "./domain/model";

import {
  CommsConfigurationProvider,
  CommsPlatformPreferencesProvider,
  DEFAULT_PLATFORM_PREFERENCES,
  useCommsConfiguration,
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
import {
  validateCommsMessage,
  validateCommsMessageChange,
} from "./domain/message-policy";
import {
  EXAMPLE_PEOPLE,
  EXAMPLE_CATEGORIES,
  EXAMPLE_CHANNELS,
  EXAMPLE_MESSAGES,
  EXAMPLE_THREADS,
  EXAMPLE_DIRECTS,
} from "./data/examples";

function appendExamples<T extends { id: string }>(
  current: T[],
  examples: T[],
): T[] {
  const existing = new Set(current.map((item) => item.id));
  return [...current, ...examples.filter((item) => !existing.has(item.id))];
}

const COMMS_RESOURCE_KEYS = [
  "comms-configuration",
  "access-people",
  "access-roles",
  "commsCategories",
  "commsChannels",
  "commsMessages",
  "commsThreads",
  "commsDirects",
  "records",
  "commsRecordThreads",
  "platformAccount",
  "platformNotificationPreferences",
] as const;
type SampleAccount = {
  language: string;
  theme: string;
  presence: string;
  passwordChanged: boolean;
  signedOut: boolean;
};
const INITIAL_ACCOUNT: SampleAccount = {
  language: "English",
  theme: "Light",
  presence: "Available",
  passwordChanged: false,
  signedOut: false,
};
const INITIAL_DIRECTS: Direct[] = [
  { id: "sample-dm-alex", user: PEOPLE[0], read: false, blocked: false },
];

function mergeThreadReplies(
  current: Message[],
  base: Message[],
  desired: (Message | string)[],
): (Message | string)[] {
  if (desired.some((reply) => typeof reply === "string")) return desired;
  const desiredMessages = desired.filter(
    (reply): reply is Message => typeof reply !== "string",
  );
  const baseIds = new Set(base.map((reply) => reply.id));
  const desiredById = new Map(
    desiredMessages.map((reply) => [reply.id, reply] as const),
  );
  const next = current
    .filter((reply) => !baseIds.has(reply.id) || desiredById.has(reply.id))
    .map((reply) => desiredById.get(reply.id) ?? reply);
  const present = new Set(
    next
      .filter((reply): reply is Message => typeof reply !== "string")
      .map((reply) => reply.id),
  );
  for (const reply of desiredMessages) {
    if (!present.has(reply.id)) {
      next.push(reply);
      present.add(reply.id);
    }
  }
  return next;
}

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
type MessageSendResult =
  { ok: true; threadId?: string } | { ok: false; error: string };

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
  const [initialConfig] = useCommsConfiguration();
  const runtime = useSampleRuntime();
  const { run, isPending } = useCommsCommands();
  const commsResource = useSampleResource({
    keys: COMMS_RESOURCE_KEYS,
    queryKey: "comms-workspace",
    load: (signal) =>
      runtime.load(
        (draft) => ({
          configuration: readCommsConfiguration(draft),
          people: draft.read<Person[]>("access-people", initialPeople),
          roles: draft.read<Role[]>("access-roles", initialRoles),
          categories: draft.read<Category[]>("commsCategories", CATEGORIES),
          channels: draft.read<Channel[]>("commsChannels", CHANNELS),
          messages: draft.read<Message[]>("commsMessages", MESSAGES),
          threads: draft.read<Thread[]>("commsThreads", []),
          directs: draft.read<Direct[]>("commsDirects", INITIAL_DIRECTS),
          records: draft.read<SampleRecord[]>("records", INITIAL_RECORDS),
          recordThreads: draft.read<RecordThread[]>("commsRecordThreads", []),
          account: draft.read<SampleAccount>(
            "platformAccount",
            INITIAL_ACCOUNT,
          ),
          platformPreferences: draft.read(
            "platformNotificationPreferences",
            DEFAULT_PLATFORM_PREFERENCES,
          ),
        }),
        { keys: COMMS_RESOURCE_KEYS, signal },
      ),
  });
  const workspace = commsResource.data ?? {
    configuration: initialConfig,
    people: initialPeople,
    roles: initialRoles,
    categories: CATEGORIES,
    channels: CHANNELS,
    messages: MESSAGES,
    threads: [] as Thread[],
    directs: INITIAL_DIRECTS,
    records: INITIAL_RECORDS,
    recordThreads: [] as RecordThread[],
    account: INITIAL_ACCOUNT,
    platformPreferences: DEFAULT_PLATFORM_PREFERENCES,
  };
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
  const [examplesLoaded] = useSampleState("commsExamplesLoaded", false);
  const [notice, setNotice] = useState("");
  const guardWorkspaceNavigation = useCallback(() => {
    if (!isPending()) return true;
    setNotice("Finish the current OpenComms change before leaving this page.");
    return false;
  }, [isPending]);
  useWorkspaceNavigationGuard(guardWorkspaceNavigation);
  useEffect(() => {
    if (examplesLoaded) return;
    void run(
      "seed-examples",
      (draft) => {
        if (draft.read("commsExamplesLoaded", false)) return false;
        const currentCategories = draft.read<Category[]>(
          "commsCategories",
          CATEGORIES,
        );
        const currentChannels = draft.read<Channel[]>(
          "commsChannels",
          CHANNELS,
        );
        const currentDirects = draft.read<Direct[]>(
          "commsDirects",
          INITIAL_DIRECTS,
        );
        const currentMessages = draft.read<Message[]>(
          "commsMessages",
          MESSAGES,
        );
        const categoryIds = new Set(
          [...currentCategories, ...EXAMPLE_CATEGORIES].map((item) => item.id),
        );
        const newChannels = EXAMPLE_CHANNELS.filter((item) =>
          categoryIds.has(item.categoryId),
        );
        const conversationIds = new Set(
          [
            ...currentChannels,
            ...newChannels,
            ...currentDirects,
            ...EXAMPLE_DIRECTS,
          ].map((item) => item.id),
        );
        const newMessages = EXAMPLE_MESSAGES.filter((item) =>
          conversationIds.has(item.conversation),
        );
        const messageIds = new Set(
          [...currentMessages, ...newMessages].map((item) => item.id),
        );
        draft.update<Person[]>("access-people", initialPeople, (items) =>
          appendExamples(items, EXAMPLE_PEOPLE),
        );
        draft.update<Category[]>("commsCategories", CATEGORIES, (items) =>
          appendExamples(items, EXAMPLE_CATEGORIES),
        );
        draft.update<Channel[]>("commsChannels", CHANNELS, (items) =>
          appendExamples(items, newChannels),
        );
        draft.update<Direct[]>("commsDirects", INITIAL_DIRECTS, (items) =>
          appendExamples(items, EXAMPLE_DIRECTS),
        );
        draft.update<Message[]>("commsMessages", MESSAGES, (items) =>
          appendExamples(items, newMessages),
        );
        draft.update<Thread[]>("commsThreads", [], (items) =>
          appendExamples(
            items,
            EXAMPLE_THREADS.filter((item) => messageIds.has(item.messageId)),
          ),
        );
        draft.update("commsExamplesLoaded", false, true);
        return true;
      },
      [
        "access-people",
        "commsCategories",
        "commsChannels",
        "commsDirects",
        "commsMessages",
        "commsThreads",
        "commsExamplesLoaded",
      ],
    ).catch((error: unknown) => {
      setNotice(
        messageFromCommsError(error, "Conversations could not be loaded."),
      );
    });
  }, [examplesLoaded, run]);
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
  async function startDirect(name: string) {
    const result = await run(
      `direct:${name}`,
      (draft) => {
        const currentConfig = readCommsConfiguration(draft);
        const currentPeople = draft.read<Person[]>(
          "access-people",
          initialPeople,
        );
        const currentCategories = draft.read<Category[]>(
          "commsCategories",
          CATEGORIES,
        );
        const currentChannels = draft.read<Channel[]>(
          "commsChannels",
          CHANNELS,
        );
        const currentDirects = draft.read<Direct[]>(
          "commsDirects",
          INITIAL_DIRECTS,
        );
        const existing = currentDirects.find((item) => item.user === name);
        if (existing) return { ok: true as const, id: existing.id };
        const currentViewer = currentPeople.find(
          (person) => person.id === viewerId && person.active,
        );
        const target = currentPeople.find(
          (person) => person.name === name && person.active,
        );
        const dmRule = resolveCommsSettings(currentConfig).values.dmRule;
        if (!currentViewer || !target)
          return draft.reject({
            ok: false as const,
            error: "Choose an active person in this workspace.",
          });
        if (dmRule === "none")
          return draft.reject({
            ok: false as const,
            error: "New direct messages are disabled by workspace policy.",
          });
        if (
          dmRule === "shared-channel" &&
          !currentChannels.some((item) =>
            [currentViewer, target].every(
              (person) =>
                resolveCommsPermission(
                  currentConfig,
                  { person, channel: item, categories: currentCategories },
                  "viewChannel",
                ).allowed,
            ),
          )
        )
          return draft.reject({
            ok: false as const,
            error: "New direct messages require a shared channel.",
          });
        const id = `sample-dm-${crypto.randomUUID()}`;
        draft.update<Direct[]>("commsDirects", INITIAL_DIRECTS, (items) => [
          ...items,
          { id, user: name, read: false, blocked: false },
        ]);
        return { ok: true as const, id };
      },
      [
        "commsDirects",
        COMMS_CONFIGURATION_KEY,
        "access-people",
        "commsCategories",
        "commsChannels",
      ],
    ).catch((error: unknown) => ({
      ok: false as const,
      error: messageFromCommsError(
        error,
        "The direct conversation could not be opened.",
      ),
    }));
    if (!result.ok) {
      setDirectError(result.error);
      setNotice(result.error);
      return;
    }
    setDirectError("");
    select(result.id);
    setDmOpen(false);
  }
  async function startThread(message: Message) {
    const result = await run(
      `thread:create:${message.id}`,
      (draft) => {
        const currentConfig = readCommsConfiguration(draft);
        const currentPeople = draft.read<Person[]>(
          "access-people",
          initialPeople,
        );
        const currentCategories = draft.read<Category[]>(
          "commsCategories",
          CATEGORIES,
        );
        const currentChannels = draft.read<Channel[]>(
          "commsChannels",
          CHANNELS,
        );
        const currentMessages = draft.read<Message[]>(
          "commsMessages",
          MESSAGES,
        );
        const currentThreads = draft.read<Thread[]>("commsThreads", []);
        const currentDirect = draft
          .read<Direct[]>("commsDirects", INITIAL_DIRECTS)
          .find((item) => item.id === selected);
        const currentViewer = currentPeople.find(
          (person) => person.id === viewerId && person.active,
        );
        const currentChannel = currentChannels.find(
          (item) => item.id === selected,
        );
        const currentSettings = resolveCommsSettings(
          currentConfig,
          currentChannel,
          currentCategories,
        ).values;
        const access = resolveCommsPermission(
          currentConfig,
          {
            person: currentViewer,
            channel: currentChannel,
            categories: currentCategories,
          },
          "createThread",
        );
        if (
          !currentViewer ||
          (!currentChannel && !currentDirect) ||
          currentChannel?.archived ||
          currentDirect?.blocked ||
          currentSettings.locked ||
          !access.allowed
        )
          return draft.reject({
            ok: false as const,
            error: "You cannot start a thread in this conversation.",
          });
        const parent = [
          ...currentMessages.filter((item) => item.conversation === selected),
          ...currentThreads
            .filter(
              (thread) =>
                (thread.conversation ??
                  currentMessages.find((item) => item.id === thread.messageId)
                    ?.conversation) === selected,
            )
            .flatMap(threadMessages),
        ].find((item) => item.id === message.id);
        if (!parent)
          return draft.reject({
            ok: false as const,
            error: "This message is no longer available.",
          });
        const existing = currentThreads.find(
          (item) => item.messageId === message.id,
        );
        const id = existing?.id ?? `sample-thread-${crypto.randomUUID()}`;
        if (!existing)
          draft.update<Thread[]>("commsThreads", [], (items) => [
            ...items,
            {
              id,
              messageId: message.id,
              conversation: selected,
              resolved: false,
              replies: [],
              subscribed: currentSettings.defaultThreadSubscription,
            },
          ]);
        return { ok: true as const, id };
      },
      [
        "commsThreads",
        "commsMessages",
        "commsDirects",
        COMMS_CONFIGURATION_KEY,
        "access-people",
        "commsCategories",
        "commsChannels",
      ],
    ).catch((error: unknown) => ({
      ok: false as const,
      error: messageFromCommsError(error, "The thread could not be opened."),
    }));
    if (!result.ok) {
      setNotice(result.error);
      return;
    }
    setThreadId(result.id);
    setMemberOpen(false);
  }
  async function patchThread(
    patch: Partial<Thread>,
    options: ThreadChangeOptions = {},
  ): Promise<string | null> {
    const result = await run(
      `thread:update:${threadId}`,
      (draft) => {
        const currentConfig = readCommsConfiguration(draft);
        const currentPeople = draft.read<Person[]>(
          "access-people",
          initialPeople,
        );
        const currentCategories = draft.read<Category[]>(
          "commsCategories",
          CATEGORIES,
        );
        const currentChannels = draft.read<Channel[]>(
          "commsChannels",
          CHANNELS,
        );
        const currentMessages = draft.read<Message[]>(
          "commsMessages",
          MESSAGES,
        );
        const currentThreads = draft.read<Thread[]>("commsThreads", []);
        const currentViewer = currentPeople.find(
          (person) => person.id === viewerId && person.active,
        );
        const currentChannel = currentChannels.find(
          (item) => item.id === selected,
        );
        const currentDirect = draft
          .read<Direct[]>("commsDirects", INITIAL_DIRECTS)
          .find((item) => item.id === selected);
        const currentSettings = resolveCommsSettings(
          currentConfig,
          currentChannel,
          currentCategories,
        ).values;
        const access = resolveCommsPermission(
          currentConfig,
          {
            person: currentViewer,
            channel: currentChannel,
            categories: currentCategories,
          },
          patch.replies || options.archiveMessage || options.historyMessage
            ? "reply"
            : "viewChannel",
        );
        const currentThread = currentThreads.find(
          (item) => item.id === threadId,
        );
        const threadConversation =
          currentThread?.conversation ??
          currentMessages.find((item) => item.id === currentThread?.messageId)
            ?.conversation;
        if (
          !currentViewer ||
          !currentThread ||
          threadConversation !== selected ||
          (!currentChannel && !currentDirect) ||
          currentChannel?.archived ||
          currentDirect?.blocked ||
          currentSettings.locked ||
          !access.allowed
        )
          return draft.reject("This thread is read-only.");
        const nextPatch: Partial<Thread> = { ...patch };
        if (patch.replies && options.replyBase)
          nextPatch.replies = mergeThreadReplies(
            threadMessages(currentThread),
            options.replyBase,
            patch.replies,
          );
        draft.update<Thread[]>("commsThreads", [], (items) =>
          items.map((item) =>
            item.id === threadId ? { ...item, ...nextPatch } : item,
          ),
        );
        if (
          patch.resolved !== undefined ||
          patch.subscribed !== undefined ||
          options.archiveMessage ||
          options.historyMessage
        )
          stageCommsConfiguration(draft, (current) => ({
            ...current,
            ...(patch.resolved !== undefined || patch.subscribed !== undefined
              ? {
                  threadMeta: {
                    ...current.threadMeta,
                    [threadId]: {
                      ...current.threadMeta[threadId],
                      ...(patch.resolved !== undefined
                        ? { resolved: patch.resolved }
                        : {}),
                      ...(patch.subscribed !== undefined
                        ? {
                            followedBy: patch.subscribed ? [viewerId] : [],
                          }
                        : {}),
                    },
                  },
                }
              : {}),
            ...(options.archiveMessage
              ? {
                  tombstones: {
                    ...current.tombstones,
                    [options.archiveMessage.id]: options.archiveMessage,
                  },
                }
              : {}),
            ...(options.historyMessage
              ? {
                  messageHistory: {
                    ...current.messageHistory,
                    [options.historyMessage.id]: [
                      ...(current.messageHistory[options.historyMessage.id] ??
                        []),
                      options.historyMessage,
                    ],
                  },
                }
              : {}),
          }));
        return null;
      },
      [
        "commsThreads",
        "commsMessages",
        "commsDirects",
        COMMS_CONFIGURATION_KEY,
        "access-people",
        "commsCategories",
        "commsChannels",
      ],
    ).catch((error: unknown) =>
      messageFromCommsError(error, "The thread could not be updated."),
    );
    if (result) setNotice(result);
    return result;
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
  async function changeMessage(
    id: string,
    patch: Partial<Message>,
  ): Promise<string | null> {
    const result = await run(
      `message:update:${id}`,
      (draft) => {
        const currentConfig = readCommsConfiguration(draft);
        const currentPeople = draft.read<Person[]>(
          "access-people",
          initialPeople,
        );
        const currentCategories = draft.read<Category[]>(
          "commsCategories",
          CATEGORIES,
        );
        const currentChannels = draft.read<Channel[]>(
          "commsChannels",
          CHANNELS,
        );
        const currentMessages = draft.read<Message[]>(
          "commsMessages",
          MESSAGES,
        );
        const currentViewer = currentPeople.find(
          (person) => person.id === viewerId && person.active,
        );
        const currentChannel = currentChannels.find(
          (item) => item.id === selected,
        );
        const message = currentMessages.find((item) => item.id === id);
        if (!currentViewer || !message)
          return draft.reject("This message is no longer available.");
        const currentSettings = resolveCommsSettings(
          currentConfig,
          currentChannel,
          currentCategories,
        ).values;
        if (
          currentChannel?.archived ||
          currentSettings.locked ||
          !resolveCommsPermission(
            currentConfig,
            {
              person: currentViewer,
              channel: currentChannel,
              categories: currentCategories,
            },
            "viewChannel",
          ).allowed
        )
          return draft.reject("This conversation is read-only.");
        if (patch.text !== undefined) {
          const error = validateCommsMessageChange({
            config: currentConfig,
            person: currentViewer,
            channel: currentChannel,
            categories: currentCategories,
            people: currentPeople,
            message,
            kind: "edit",
          });
          if (error) return draft.reject(error);
        }
        if (
          patch.pinned !== undefined &&
          !resolveCommsPermission(
            currentConfig,
            {
              person: currentViewer,
              channel: currentChannel,
              categories: currentCategories,
            },
            "pin",
          ).allowed
        )
          return draft.reject("You do not have permission to pin messages.");
        if (
          patch.reactions !== undefined &&
          !resolveCommsPermission(
            currentConfig,
            {
              person: currentViewer,
              channel: currentChannel,
              categories: currentCategories,
            },
            "react",
          ).allowed
        )
          return draft.reject(
            "You do not have permission to react to messages.",
          );
        if (patch.text !== undefined)
          stageCommsConfiguration(draft, (current) => ({
            ...current,
            messageHistory: {
              ...current.messageHistory,
              [id]: [...(current.messageHistory[id] ?? []), message],
            },
          }));
        draft.update<Message[]>("commsMessages", MESSAGES, (items) =>
          items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
        );
        return null;
      },
      [
        "commsMessages",
        COMMS_CONFIGURATION_KEY,
        "access-people",
        "commsCategories",
        "commsChannels",
      ],
    ).catch((error: unknown) =>
      messageFromCommsError(error, "The message could not be updated."),
    );
    if (result) setNotice(result);
    return result;
  }
  async function deleteMessage(id: string): Promise<string | null> {
    const result = await run(
      `message:delete:${id}`,
      (draft) => {
        const currentConfig = readCommsConfiguration(draft);
        const currentPeople = draft.read<Person[]>(
          "access-people",
          initialPeople,
        );
        const currentCategories = draft.read<Category[]>(
          "commsCategories",
          CATEGORIES,
        );
        const currentChannels = draft.read<Channel[]>(
          "commsChannels",
          CHANNELS,
        );
        const currentMessages = draft.read<Message[]>(
          "commsMessages",
          MESSAGES,
        );
        const currentViewer = currentPeople.find(
          (person) => person.id === viewerId && person.active,
        );
        const currentChannel = currentChannels.find(
          (item) => item.id === selected,
        );
        const message = currentMessages.find((item) => item.id === id);
        if (!currentViewer || !message)
          return draft.reject("This message is no longer available.");
        const error = validateCommsMessageChange({
          config: currentConfig,
          person: currentViewer,
          channel: currentChannel,
          categories: currentCategories,
          people: currentPeople,
          message,
          kind: "delete",
        });
        if (error) return draft.reject(error);
        stageCommsConfiguration(draft, (current) => ({
          ...current,
          tombstones: { ...current.tombstones, [id]: message },
        }));
        draft.update<Message[]>("commsMessages", MESSAGES, (items) =>
          items.filter((item) => item.id !== id),
        );
        return null;
      },
      [
        "commsMessages",
        COMMS_CONFIGURATION_KEY,
        "access-people",
        "commsCategories",
        "commsChannels",
      ],
    ).catch((error: unknown) =>
      messageFromCommsError(error, "The message could not be deleted."),
    );
    if (result) setNotice(result);
    return result;
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
  async function sendMessage(draft: MessageDraft): Promise<string | null> {
    const replyToId = replyingTo?.id;
    const result: MessageSendResult = await run<MessageSendResult>(
      `message:send:${selected}`,
      (transaction) => {
        const currentConfig = readCommsConfiguration(transaction);
        const currentPeople = transaction.read<Person[]>(
          "access-people",
          initialPeople,
        );
        const currentRoles = transaction.read<Role[]>(
          "access-roles",
          initialRoles,
        );
        const currentCategories = transaction.read<Category[]>(
          "commsCategories",
          CATEGORIES,
        );
        const currentChannels = transaction.read<Channel[]>(
          "commsChannels",
          CHANNELS,
        );
        const currentMessages = transaction.read<Message[]>(
          "commsMessages",
          MESSAGES,
        );
        const currentThreads = transaction.read<Thread[]>("commsThreads", []);
        const currentRecords = transaction.read<SampleRecord[]>(
          "records",
          INITIAL_RECORDS,
        );
        const currentViewer = currentPeople.find(
          (person) => person.id === viewerId && person.active,
        );
        const currentChannel = currentChannels.find(
          (item) => item.id === selected,
        );
        const currentDirect = transaction
          .read<Direct[]>("commsDirects", INITIAL_DIRECTS)
          .find((item) => item.id === selected);
        const currentSettings = resolveCommsSettings(
          currentConfig,
          currentChannel,
          currentCategories,
        ).values;
        const kind = replyToId
          ? "reply"
          : currentChannel && currentSettings.mode === "thread-first"
            ? "thread"
            : "post";
        const currentChannelThreads = currentThreads.filter(
          (thread) =>
            (thread.conversation ??
              currentMessages.find((message) => message.id === thread.messageId)
                ?.conversation) === selected,
        );
        const currentAllMessages = [
          ...currentMessages,
          ...currentThreads.flatMap(threadMessages),
        ];
        const error = validateCommsMessage({
          config: currentConfig,
          person: currentViewer,
          channel: currentChannel,
          categories: currentCategories,
          people: currentPeople,
          roles: currentRoles,
          messages: currentAllMessages.filter(
            (item) =>
              item.conversation === selected ||
              currentChannelThreads.some(
                (thread) => thread.id === item.conversation,
              ),
          ),
          text: draft.text,
          files: draft.files,
          record: currentRecords.find((item) => item.id === draft.recordId),
          now: draft.sentAt,
          kind,
        });
        if (error || !currentViewer || (!currentChannel && !currentDirect))
          return transaction.reject({
            ok: false as const,
            error: error ?? "This conversation is read-only.",
          });
        if (
          replyToId &&
          !currentAllMessages.some((item) => item.id === replyToId)
        )
          return transaction.reject({
            ok: false as const,
            error: "This message is no longer available.",
          });
        const id = `sample-message-${crypto.randomUUID()}`;
        transaction.update<Message[]>("commsMessages", MESSAGES, (items) => [
          ...items,
          {
            id,
            conversation: selected,
            author: currentViewer.name,
            authorId: currentViewer.id,
            text: draft.text.trim() || "Shared a file",
            created: draft.sentAt,
            pinned: false,
            ...(draft.files.length ? { files: draft.files } : {}),
            ...(draft.recordId ? { recordId: draft.recordId } : {}),
            ...(replyToId ? { replyToId } : {}),
          },
        ]);
        let threadId: string | undefined;
        if (kind === "thread") {
          threadId = `sample-thread-${crypto.randomUUID()}`;
          transaction.update<Thread[]>("commsThreads", [], (items) => [
            ...items,
            {
              id: threadId!,
              messageId: id,
              conversation: selected,
              resolved: false,
              replies: [],
              subscribed: currentSettings.defaultThreadSubscription,
            },
          ]);
        }
        return {
          ok: true as const,
          ...(threadId ? { threadId } : {}),
        };
      },
      [
        "commsMessages",
        "commsThreads",
        "commsDirects",
        "records",
        COMMS_CONFIGURATION_KEY,
        "access-people",
        "access-roles",
        "commsCategories",
        "commsChannels",
      ],
    ).catch((error: unknown) => ({
      ok: false as const,
      error: messageFromCommsError(error, "The message could not be sent."),
    }));
    if (!result.ok) {
      setNotice(result.error);
      return result.error;
    }
    if (result.threadId) setThreadId(result.threadId);
    setReplyingTo(null);
    setNotice("Message sent.");
    requestAnimationFrame(() =>
      messageList.current?.scrollTo({ top: messageList.current.scrollHeight }),
    );
    return null;
  }
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
