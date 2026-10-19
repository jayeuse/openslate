"use client";

import {
  Activity,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ChevronDown,
  Hash,
  MessageSquare,
  Pin,
  Settings2,
  Users,
  Plus,
  ArrowLeft,
  CornerDownRight,
  FolderPlus,
  FolderOpen,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { useVerifiedWorkspaceUserId } from "../shared/runtime/workspace-identity";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
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
import { LoadingRegion } from "@/components/ui/loading-region";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { SampleDataNote } from "./components/sample-data-note";
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
import { messageFromCommsError, useCommsCommands } from "./state/runtime";
import {
  useCommsWorkspace,
  CommsWorkspaceProvider,
} from "./state/use-comms-workspace";
import { useCommsClient } from "./state/client-context";
import { useCommsPanelLayout } from "./state/use-comms-panel-layout";
import { wirePreferences } from "./state/settings-wire";
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
  messageAuthorId,
  threadMessages,
  type Category,
  type Channel,
} from "./domain/view-model";

import {
  DEFAULT_COMMS_PREFERENCES,
  resolveCommsSettings,
  type CommsScope,
  type CommsPreferences,
} from "./domain/configuration";
import { CommsSettingsDialog } from "./components/settings-dialog";
import { CommsToolsDialog } from "./components/tools-dialog";
import {
  ConfirmActionDialog,
  type ConfirmActionRequest,
} from "./components/confirm-action-dialog";
import { reportCommsDone, reportCommsError } from "./state/comms-feedback";
import {
  channelGroupAccess,
  channelTone,
  commsGroup,
  recordContext,
  visibleToLabel,
  type GroupTone,
} from "./domain/groups";
import { GroupMark } from "./components/group-mark";
import { RecordPanel } from "./components/record-panel";

type ToolView =
  | "management"
  | "templates"
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
  | "history"
  | "moderation"
  | "outbox"
  | "retention";

/** Who can use the open channel. Opens its settings for people who may
 *  change them; for everyone else it is plain text. */
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
  if (!onOpen) return <span className={chip}>{body}</span>;
  return (
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
  );
}

/** How many removed messages wait in Moderation; the words are read out,
 *  the number is shown. */
function RecoverableBadge({ count }: { count: number }) {
  return (
    <Badge variant="warning" className="ml-auto">
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">
        {count} removed {count === 1 ? "message" : "messages"} to review
      </span>
    </Badge>
  );
}

/** Everyday items first, in small groups; tools for administrators and
 *  moderators wait behind one Admin tools entry. */
function CommsMenu({
  compact = false,
  hasChannel,
  canManageChannel,
  canCreate,
  canAdminister,
  recoverableCount,
  onSelect,
}: {
  compact?: boolean;
  hasChannel: boolean;
  canManageChannel: boolean;
  canCreate: boolean;
  canAdminister: boolean;
  recoverableCount: number;
  onSelect: (setting: WorkspaceSetting, opener: HTMLElement) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const groups = [
    [
      { id: "personal", label: "My preferences", icon: UserRound },
      { id: "threads", label: "Browse threads", icon: MessageSquare },
    ],
    canManageChannel
      ? [
          { id: "edit-channel", label: "Channel settings", icon: Hash },
          { id: "edit-category", label: "Category settings", icon: FolderOpen },
        ]
      : [],
    canCreate
      ? [
          { id: "create-channel", label: "New channel", icon: Plus },
          { id: "create-category", label: "New category", icon: FolderPlus },
        ]
      : [],
  ].filter((group) => group.length > 0) as {
    id: WorkspaceSetting;
    label: string;
    icon: typeof Hash;
  }[][];
  const adminGroups = [
    {
      label: "Messages and safety",
      tools: [
        { id: "moderation", label: "Moderation" },
        { id: "outbox", label: "Scheduled messages" },
        { id: "retention", label: "Message retention" },
      ],
    },
    {
      label: "Setup",
      tools: [
        { id: "workspace", label: "Workspace settings" },
        { id: "templates", label: "Channel templates" },
        { id: "management", label: "Bulk channel changes" },
        { id: "history", label: "Settings history" },
      ],
    },
  ] as const;
  const select = (id: WorkspaceSetting) => {
    if (trigger.current) onSelect(id, trigger.current);
  };
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-0.5",
        compact && "md:hidden",
      )}
    >
      <h1
        className={cn(
          "truncate pl-2 font-semibold tracking-tight",
          compact && "pl-0 text-xs",
        )}
      >
        OpenComms
      </h1>
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={trigger}
          aria-label="OpenComms menu"
          className={cn(
            "hover:bg-muted focus-visible:ring-ring grid size-11 shrink-0 place-items-center rounded-md outline-none focus-visible:ring-2",
            compact && "size-7",
          )}
        >
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-60 max-w-[calc(100vw-32px)] p-1.5">
          {groups.map((group, index) => (
            <DropdownMenuGroup key={group[0].id}>
              {index > 0 && <DropdownMenuSeparator />}
              {group.map(({ id, label, icon: Icon }) => (
                <DropdownMenuItem
                  key={id}
                  className="min-h-10"
                  disabled={id.startsWith("edit-") && !hasChannel}
                  onClick={() => select(id)}
                >
                  <Icon aria-hidden="true" /> {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ))}
          {canAdminister && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="min-h-10">
                  <ShieldCheck aria-hidden="true" /> Admin tools
                  {recoverableCount > 0 && (
                    <RecoverableBadge count={recoverableCount} />
                  )}
                </DropdownMenuSubTrigger>
                <DropdownMenuContent
                  side="right"
                  sideOffset={6}
                  className="w-56 max-w-[calc(100vw-32px)] p-1.5"
                >
                  {adminGroups.map((group, index) => (
                    <DropdownMenuGroup key={group.label}>
                      {index > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuLabel className="text-muted-foreground px-2 pt-1.5 pb-1 text-xs font-semibold">
                        {group.label}
                      </DropdownMenuLabel>
                      {group.tools.map(({ id, label }) => (
                        <DropdownMenuItem
                          key={id}
                          className="min-h-10"
                          onClick={() => select(id)}
                        >
                          {label}
                          {id === "moderation" && recoverableCount > 0 && (
                            <RecoverableBadge count={recoverableCount} />
                          )}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  ))}
                </DropdownMenuContent>
              </DropdownMenuSub>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const COMMS_SKELETON_CHANNELS = [
  { id: "general", width: "w-32" },
  { id: "updates", width: "w-24" },
  { id: "planning", width: "w-36" },
  { id: "support", width: "w-28" },
  { id: "random", width: "w-20" },
] as const;
const COMMS_SKELETON_MESSAGES = [
  { id: "first", width: "w-3/4" },
  { id: "second", width: "w-1/2" },
  { id: "third", width: "w-2/3" },
  { id: "fourth", width: "w-2/5" },
] as const;
const COMMS_SKELETON_MEMBERS = ["one", "two", "three", "four"] as const;

/**
 * The conversation list, message pane, and (on wide screens) members pane,
 * at the same widths and borders as the resizable layout they stand in for.
 */
function CommsSkeleton({
  channelWidth,
  memberWidth,
  conversationFirst,
  members,
}: {
  channelWidth: number;
  memberWidth: number;
  /** On phones, a linked conversation opens instead of the list. */
  conversationFirst: boolean;
  members: boolean;
}) {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1"
      style={
        {
          "--comms-channel-width": `${channelWidth}px`,
          "--comms-member-width": `${memberWidth}px`,
        } as CSSProperties
      }
    >
      <div
        className={cn(
          "bg-muted/25 min-h-0 w-full shrink-0 flex-col border-r md:flex md:w-(--comms-channel-width)",
          conversationFirst ? "hidden" : "flex",
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="size-9" />
        </div>
        <div className="border-b px-4 py-2">
          <Skeleton className="h-4 w-48 max-w-full" />
        </div>
        <div className="p-3">
          <Skeleton className="h-10 w-full" />
        </div>
        <div className="flex flex-col px-2">
          <div className="flex min-h-11 items-center px-1">
            <Skeleton className="h-4 w-24" />
          </div>
          {COMMS_SKELETON_CHANNELS.map((channel) => (
            <div key={channel.id} className="flex min-h-11 items-center px-2">
              <Skeleton className={cn("h-4", channel.width)} />
            </div>
          ))}
        </div>
      </div>
      <div className="bg-border hidden w-px shrink-0 md:block" />
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col",
          conversationFirst ? "flex" : "hidden md:flex",
        )}
      >
        <div className="flex min-h-14 shrink-0 items-center gap-1.5 border-b px-3 py-2">
          <Skeleton className="size-5" />
          <Skeleton className="h-5 w-40" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden px-2 py-4 sm:px-4">
          {COMMS_SKELETON_MESSAGES.map((message) => (
            <div key={message.id} className="flex gap-3">
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className={cn("h-4", message.width)} />
              </div>
            </div>
          ))}
        </div>
        <div className="shrink-0 border-t p-3">
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
      {members ? (
        <>
          <div className="bg-border hidden w-px shrink-0 xl:block" />
          <div className="bg-muted/15 hidden min-h-0 shrink-0 flex-col gap-4 border-l p-4 xl:flex xl:w-(--comms-member-width)">
            <Skeleton className="h-4 w-24" />
            {COMMS_SKELETON_MEMBERS.map((member) => (
              <div key={member} className="flex items-center gap-3">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <Skeleton className="h-4 w-28" />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export default function SampleComms() {
  // Failures show as a visible notice; results that are already visible
  // (a sent message) are only announced.
  const setNotice = reportCommsError;
  const [announcement, setAnnouncement] = useState("");
  const [confirmRequest, setConfirmRequest] =
    useState<ConfirmActionRequest | null>(null);
  const { commsResource, workspace, client } = useCommsWorkspace();
  const { run, isPending } = useCommsCommands();
  const { groups } = useCommsClient();
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
    account,
  } = workspace;
  const navigation = useCommsNavigationState(channels[0]?.id, [
    ...messages,
    ...storedThreads.flatMap(threadMessages),
  ]);
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
  const [membersVisible, setMembersVisible] = useState(true);
  const [memberSearch, setMemberSearch] = useState("");
  const [conversationSearch, setConversationSearch] = useState("");
  const [threadFilter, setThreadFilter] = useState<"active" | "inactive">(
    "active",
  );
  const viewerId = useVerifiedWorkspaceUserId();
  const activePeople = people.filter((person) => person.active);
  const channel = channels.find((item) => item.id === selected);
  const direct = directs.find((item) => item.id === selected);
  const preferences = config.preferences[viewerId] ?? DEFAULT_COMMS_PREFERENCES;
  const settings = resolveCommsSettings(config, channel).values;
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const threads = storedThreads;
  const check = workspace.checks[selected];
  const canView = !!(channel || direct);
  const canParticipate =
    !!client &&
    canView &&
    !!check &&
    check.membership_role !== "guest" &&
    !channel?.archived &&
    !direct?.blocked &&
    !settings.locked;
  const canPost =
    canParticipate &&
    (check?.conversation_level === "post" ||
      check?.conversation_level === "manage") &&
    // Announcements: the same manager rule the send check uses.
    (settings.mode !== "announcements" || check?.manager_source !== null);
  const elevated = check?.capabilities.pin.allowed ?? false;
  const commsMenuAccess = {
    canManageChannel: check?.capabilities.manageChannel.allowed ?? false,
    canCreate: check?.capabilities.createChannel.allowed ?? false,
    canAdminister:
      check?.capabilities.manageWorkspace.allowed ||
      check?.capabilities.moderate.allowed ||
      false,
    recoverableCount: workspace.removedCount,
  };
  async function patchPreferences(patch: Partial<CommsPreferences>) {
    try {
      if (!client) throw new Error("Organization is not admitted");
      if (
        Object.keys(patch).some(
          (key) =>
            !["favorites", "hiddenChannels", "mutedUntil", "readAt"].includes(
              key,
            ),
        )
      ) {
        const current = await client.getPersonalPreferences();
        await client.setPersonalPreferences(
          wirePreferences({ ...preferences, ...patch }),
          { if_match: current.etag },
        );
      }
      for (const row of (await client.bootstrap()).conversations) {
        const id = row.conversation.id;
        const change = {
          ...(patch.favorites ? { starred: patch.favorites.includes(id) } : {}),
          ...(patch.hiddenChannels
            ? { hidden: patch.hiddenChannels.includes(id) }
            : {}),
          ...(patch.mutedUntil && id in patch.mutedUntil
            ? {
                mute:
                  patch.mutedUntil[id] === Number.MAX_SAFE_INTEGER
                    ? { kind: "indefinite" as const }
                    : patch.mutedUntil[id]
                      ? {
                          kind: "until" as const,
                          until: new Date(patch.mutedUntil[id]).toISOString(),
                        }
                      : { kind: "off" as const },
              }
            : {}),
          ...(patch.readAt?.[id] === 0 ? { manual_unread: true } : {}),
        };
        if (Object.keys(change).length) {
          const current = await client.getMemberPreferences(id);
          await client.updateMemberPreferences(id, change, {
            if_match: current.etag,
          });
        }
        if (patch.readAt?.[id])
          await client.markRead(id, { last_read_seq: row.high_water_seq });
      }
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
    presence: workspace.presence,
    elevated,
    allowDownload: canView && settings.fileDownloads,
    preferences,
    settings,
    capabilities: check?.capabilities,
    membershipRole: check?.membership_role,
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
  // A channel's members are the people its groups let in (shown, not yet
  // enforced), so the list agrees with "Who can use".
  const memberIds = new Set(
    workspace.members[selected]?.map((member) => member.user_id),
  );
  const members = activePeople.filter((person) => memberIds.has(person.id));
  const currentThread = canView
    ? threads.find((item) => item.id === threadId)
    : undefined;
  // A linked record opens in the same place as a thread; a thread wins.
  const [recordId, setRecordId] = useState("");
  const conversationsLoaded = commsResource.hydrated;
  const openRecord = currentThread
    ? undefined
    : records.find((item) => item.id === recordId);
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
    hasThread: !!currentThread || !!openRecord,
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
      thread: currentThread,
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
  const visibleMessages = canView
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
          {item.resolved ? "Resolved" : "Active"}
        </>
      ),
    }),
  );
  const filteredChannels = channels.filter(
    (item) =>
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
    // Runs again once the conversations load, so the first view opens at
    // the latest message instead of the oldest.
  }, [selected, mobileConversation, desktop, conversationsLoaded]);

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
        () => reportCommsDone("Conversation link copied."),
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
        value: newChannel(category?.id ?? categories[0]?.id ?? ""),
        opener,
      });
    else if (setting === "edit-channel" && channel)
      setEditor({ kind: "channel", value: channel, opener });
    else if (setting === "create-category")
      setEditor({
        kind: "category",
        value: { id: "", name: "" },
        opener,
      });
    else if (setting === "edit-category" && category)
      setEditor({ kind: "category", value: category, opener });
  }
  const workspaceThreads = threads.flatMap((item) => {
    const message = allMessages.find((entry) => entry.id === item.messageId);
    const conversation = item.conversation ?? message?.conversation;
    const parentChannel = channels.find((entry) => entry.id === conversation);
    if (!parentChannel) return [];
    return [
      {
        thread: item,
        channel: parentChannel,
        title: item.name || message?.text || "Discussion",
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
  const {
    changeMessage,
    deleteMessage,
    undoDelete,
    validateDraft,
    sendMessage,
  } = createCommsMessageOperations({
    run,
    selected,
    viewerId,
    replyingTo,
    setReplyingTo,
    setNotice,
    announce: setAnnouncement,
    scrollToLatest,
    allMessages,
  });
  async function moveCategory(id: string, direction: number) {
    try {
      if (!client) throw new Error("Organization is not admitted");
      const rows = (await client.bootstrap()).categories.map(
        (row) => row.category,
      );
      const from = rows.findIndex((row) => row.id === id),
        to = from + direction;
      if (from < 0 || to < 0 || to >= rows.length) return;
      [rows[from], rows[to]] = [rows[to], rows[from]];
      for (const [position, row] of rows.entries()) {
        if (row.position === position) continue;
        const current = await client.getCategory(row.id);
        await client.updateCategory(
          row.id,
          {
            name: current.data.name,
            department_id: current.data.department_id,
            default_access: current.data.default_access,
            position,
          },
          { if_match: current.etag },
        );
      }
    } catch (error) {
      setNotice(
        messageFromCommsError(error, "The category order could not be saved."),
      );
    }
  }
  async function duplicateChannel(channel: Channel) {
    try {
      if (!client) throw new Error("Organization is not admitted");
      const current = await client.getConversation(channel.id);
      await client.duplicateChannel(
        channel.id,
        {
          name: `${channel.name}-copy`,
          category_id: channel.categoryId || null,
        },
        { if_match: current.etag },
      );
    } catch (error) {
      setNotice(
        messageFromCommsError(error, "The channel could not be duplicated."),
      );
    }
  }
  /** Deleting shows a notice with Undo, so a slip costs one click. Undos
   *  run one after another: two at once would cancel each other. */
  const undoQueue = useRef<Promise<unknown>>(Promise.resolve());
  async function deleteWithUndo(id: string): Promise<string | null> {
    const original = messages.find((item) => item.id === id);
    const error = await deleteMessage(id);
    if (!error && original && check?.capabilities.deleteOthersMessages.allowed)
      reportCommsDone("Message deleted.", {
        label: "Undo",
        onClick: () => {
          undoQueue.current = undoQueue.current.then(() =>
            undoDelete(original),
          );
        },
      });
    return error;
  }
  function confirmArchive(channel: Channel, opener: HTMLElement) {
    setConfirmRequest({
      title: `Archive #${channel.name}?`,
      description:
        "No one can post in an archived channel. Its messages stay readable, and you can restore it at any time.",
      confirmLabel: "Archive channel",
      onConfirm: () => void setChannelArchived(channel, true),
      opener,
    });
  }
  function confirmBlock(directId: string, name: string, opener: HTMLElement) {
    setConfirmRequest({
      title: `Block ${name}?`,
      description:
        "Neither of you can send messages in this conversation until you unblock them. Earlier messages stay.",
      confirmLabel: "Block user",
      destructive: true,
      onConfirm: () => void toggleDirect(directId, "blocked"),
      opener,
    });
  }
  /** Sets the archive state explicitly, so an Undo created before the
   *  change always goes the right way and reports what it did. */
  async function setChannelArchived(
    target: Pick<Channel, "id" | "name">,
    archived: boolean,
  ) {
    const channelId = target.id;
    try {
      if (!client) throw new Error("Organization is not admitted");
      const current = await client.getConversation(channelId);
      await (
        archived ? client.archiveConversation : client.restoreConversation
      )(channelId, { if_match: current.etag });
      await client.bootstrap();
    } catch (error) {
      setNotice(
        messageFromCommsError(
          error,
          "The channel archive state could not be saved.",
        ),
      );
      return;
    }
    if (!archived) reportCommsDone(`#${target.name} restored.`);
    else
      reportCommsDone(`#${target.name} archived.`, {
        label: "Undo",
        onClick: () => void setChannelArchived(target, false),
      });
  }
  async function toggleDirect(directId: string, field: "read" | "blocked") {
    try {
      if (!client) throw new Error("Organization is not admitted");
      const current = await client.getConversation(directId);
      if (current.data.kind !== "direct") return;
      if (field === "read") {
        const summary = (await client.bootstrap()).conversations.find(
          (row) => row.conversation.id === directId,
        );
        if (!summary) throw new Error("Conversation is unavailable");
        if (summary.preferences.manual_unread || summary.unread_count)
          await client.markRead(directId, {
            last_read_seq: summary.high_water_seq,
          });
        else {
          const preferences = await client.getMemberPreferences(directId);
          await client.updateMemberPreferences(
            directId,
            { manual_unread: true },
            { if_match: preferences.etag },
          );
        }
      } else {
        const recipient = current.data.participant_ids.find(
          (id) => id !== viewerId,
        );
        if (!recipient) throw new Error("Recipient is unavailable");
        const blocks = await client.listDirectBlocks();
        if (blocks.items.some((block) => block.blocked_user_id === recipient))
          await client.unblockDirect(recipient);
        else await client.blockDirect({ blocked_user_id: recipient });
      }
    } catch (error) {
      setNotice(
        messageFromCommsError(
          error,
          "The direct conversation could not be updated.",
        ),
      );
    }
  }
  const membersContent = (
    <MembersPanel
      members={members}
      roles={roles}
      viewerId={viewerId}
      viewerPresence={account.presence}
      presence={workspace.presence}
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
      archived={currentThread.archived}
      canPost={
        !currentThread.archived &&
        canParticipate &&
        (check?.capabilities.reply.allowed ?? false) &&
        !currentThread.locked
      }
      threadName={currentThread.name}
      validateDraft={validateDraft}
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
  function showRecord(id: string) {
    setThreadId("");
    setRecordId(id);
  }
  function conversationName(id: string): string {
    const namedChannel = channels.find((item) => item.id === id);
    if (namedChannel) return `#${namedChannel.name}`;
    return directs.find((item) => item.id === id)?.user ?? "A conversation";
  }
  // Records linked in conversations, most recently mentioned first.
  // Only conversations this person can open feed the record lists.
  const visibleConversation = (id: string) => {
    const target = channels.find((item) => item.id === id);
    if (!target) return directs.some((item) => item.id === id);
    return true;
  };
  const recordMessages = messages.filter(
    (item) => item.recordId && visibleConversation(item.conversation),
  );
  const followedRecords = [
    ...new Map(
      [...recordMessages]
        .sort((a, b) => b.created - a.created)
        .map((item) => [item.recordId!, item] as const),
    ).keys(),
  ]
    .map((id) => records.find((record) => record.id === id))
    .filter((record) => record !== undefined)
    .slice(0, 4);
  const recordContent = openRecord && (
    <RecordPanel
      key={openRecord.id}
      record={openRecord}
      people={people}
      mentions={recordMessages
        .filter((item) => item.recordId === openRecord.id)
        .sort((a, b) => b.created - a.created)
        .map((item) => ({
          messageId: item.id,
          conversationName: conversationName(item.conversation),
          author: item.author,
          // Mentions are a preview; formatting marks are not shown.
          text: item.text
            .replace(/\*\*(.+?)\*\*\n/g, "$1: ")
            .replace(/[*_`]/g, ""),
        }))}
      onJump={(messageId) => {
        // On narrow screens the record covers the timeline; close it first.
        if (!wide) setRecordId("");
        const target = messages.find((item) => item.id === messageId);
        if (target && target.conversation !== selected)
          select(target.conversation);
        requestAnimationFrame(() => jumpToMessage(messageId));
      }}
      onClose={() => setRecordId("")}
    />
  );

  if (commsResource.status === "error" && !commsResource.hydrated)
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
    <CommsWorkspaceProvider value={workspace}>
      <ProfilePopoverProvider>
        <div
          ref={container}
          className="bg-card relative flex min-h-0 flex-1 overflow-hidden"
        >
          <LoadingRegion
            loading={
              commsResource.status === "loading" && !commsResource.hydrated
            }
            label="Loading conversations"
            skeleton={
              <CommsSkeleton
                channelWidth={channelWidth}
                memberWidth={memberWidth}
                conversationFirst={mobileConversation}
                members={membersVisible}
              />
            }
            className="flex min-h-0 min-w-0 flex-1 *:flex *:min-h-0 *:min-w-0 *:flex-1"
          >
            {commsResource.hydrated && !commsResource.data && (
              <div className="bg-card absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 p-6">
                {commsResource.status === "error" ? (
                  <>
                    <Alert role="alert" variant="destructive">
                      {commsResource.error}
                    </Alert>
                    <Action onClick={commsResource.reload}>Try again</Action>
                  </>
                ) : (
                  <p role="status">Verifying conversation access…</p>
                )}
              </div>
            )}
            <Activity mode={commsResource.data ? "visible" : "hidden"}>
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
              <ConfirmActionDialog
                request={confirmRequest}
                onClose={() => setConfirmRequest(null)}
              />
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
                  const channelPixels =
                    channelsPanel.current?.getSize().inPixels;
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
                          {...commsMenuAccess}
                          onSelect={openWorkspaceSetting}
                        />
                        {commsMenuAccess.canCreate && (
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
                        )}
                      </div>
                      <SampleDataNote className="border-b px-4 py-2 text-xs">
                        Conversations here are examples.
                      </SampleDataNote>
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
                                label="Category settings"
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
                                                  item.categoryId ===
                                                  category.id,
                                              )
                                              .map((item) => [
                                                item.id,
                                                Date.now() + 3600000,
                                              ]),
                                          ),
                                        },
                                      }),
                                  },
                                  ...(commsMenuAccess.canCreate
                                    ? [
                                        {
                                          label: "Create channel in category",
                                          onSelect: (opener: HTMLElement) =>
                                            setEditor({
                                              kind: "channel",
                                              value: newChannel(category.id),
                                              opener,
                                            }),
                                        },
                                      ]
                                    : []),
                                  ...(commsMenuAccess.canManageChannel
                                    ? [
                                        {
                                          label: "Move category up",
                                          disabled: categoryIndex === 0,
                                          onSelect: () =>
                                            moveCategory(category.id, -1),
                                        },
                                        {
                                          label: "Move category down",
                                          disabled:
                                            categoryIndex ===
                                            categories.length - 1,
                                          onSelect: () =>
                                            moveCategory(category.id, 1),
                                        },
                                        {
                                          label: "Apply template",
                                          onSelect: (opener: HTMLElement) =>
                                            setToolsDialog({
                                              view: "templates",
                                              opener,
                                            }),
                                        },
                                      ]
                                    : []),
                                ]}
                                onEdit={
                                  commsMenuAccess.canManageChannel
                                    ? (opener) =>
                                        setEditor({
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
                                        collapsed.includes(category.id) &&
                                          "-rotate-90",
                                      )}
                                    />
                                    {category.groupId && (
                                      <GroupMark
                                        tone={
                                          commsGroup(category.groupId, groups)
                                            ?.tone ?? 0
                                        }
                                        className="ml-0.5"
                                      />
                                    )}
                                    <span className="flex min-w-0 flex-col">
                                      <span className="truncate">
                                        {category.name}
                                      </span>
                                      {category.groupId && (
                                        <span className="text-muted-foreground truncate text-xs font-normal">
                                          {commsGroup(category.groupId, groups)
                                            ?.name ?? "Access"}{" "}
                                          group
                                        </span>
                                      )}
                                    </span>
                                  </CollapsibleTrigger>
                                  {commsMenuAccess.canManageChannel && (
                                    <Action
                                      size="icon"
                                      variant="ghost"
                                      aria-label={`Category settings: ${category.name}`}
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
                                  )}
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
                                        label="Channel settings"
                                        actionsLabel={`Channel actions: ${item.name}`}
                                        actions={[
                                          {
                                            label:
                                              preferences.favorites.includes(
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
                                              (preferences.mutedUntil[
                                                item.id
                                              ] ?? 0) > Date.now()
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
                                          ...(commsMenuAccess.canManageChannel
                                            ? [
                                                {
                                                  // The category field is on the
                                                  // settings Overview.
                                                  label:
                                                    "Move to another category…",
                                                  disabled:
                                                    categories.length < 2,
                                                  onSelect: (
                                                    opener: HTMLElement,
                                                  ) =>
                                                    setEditor({
                                                      kind: "channel",
                                                      value: item,
                                                      opener,
                                                    }),
                                                },
                                                {
                                                  label: "Duplicate channel",
                                                  onSelect: () =>
                                                    void duplicateChannel(item),
                                                },
                                                {
                                                  label: item.archived
                                                    ? "Restore channel"
                                                    : "Archive channel",
                                                  onSelect: (
                                                    opener: HTMLElement,
                                                  ) =>
                                                    item.archived
                                                      ? void setChannelArchived(
                                                          item,
                                                          false,
                                                        )
                                                      : confirmArchive(
                                                          item,
                                                          opener,
                                                        ),
                                                },
                                              ]
                                            : []),
                                        ]}
                                        onEdit={
                                          commsMenuAccess.canManageChannel
                                            ? (opener) =>
                                                setEditor({
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
                                            selected === item.id
                                              ? "secondary"
                                              : "ghost"
                                          }
                                          aria-label={[
                                            item.name,
                                            selected !== item.id &&
                                            channelUnread(item.id)
                                              ? "unread"
                                              : "",
                                            (preferences.mutedUntil[item.id] ??
                                              0) > Date.now()
                                              ? "muted"
                                              : "",
                                            item.archived ? "archived" : "",
                                          ]
                                            .filter(Boolean)
                                            .join(", ")}
                                          aria-current={
                                            selected === item.id &&
                                            !currentThread
                                              ? "page"
                                              : undefined
                                          }
                                          onClick={() => select(item.id)}
                                          className={cn(
                                            "h-auto min-h-11 w-full justify-start py-2 pr-10 pl-3 text-left",
                                            // Unread channels stand out; read ones step back.
                                            selected !== item.id &&
                                              !channelUnread(item.id) &&
                                              "text-muted-foreground font-medium",
                                          )}
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
                                            <span className="text-muted-foreground text-xs">
                                              Muted
                                            </span>
                                          )}
                                          {selected !== item.id &&
                                            channelUnread(item.id) && (
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
                                                !entry.thread.archived &&
                                                resolveCommsSettings(
                                                  config,
                                                  item,
                                                ).values.threadBranches !==
                                                  "none" &&
                                                (resolveCommsSettings(
                                                  config,
                                                  item,
                                                ).values.threadBranches !==
                                                  "followed" ||
                                                  entry.thread.subscribed),
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
                                                      className={cn(
                                                        "h-auto min-h-9 min-w-0 justify-start pr-2 pl-0 text-left",
                                                        // Threads step back with a read channel.
                                                        currentThread?.id !==
                                                          entry.thread.id &&
                                                          !channelUnread(
                                                            item.id,
                                                          ) &&
                                                          "text-muted-foreground font-normal",
                                                      )}
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
                                                      Resolved
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
                          {commsMenuAccess.canCreate && (
                            <Action
                              variant="ghost"
                              className="text-muted-foreground w-full justify-start"
                              onClick={(event) =>
                                setEditor({
                                  opener: event.currentTarget,
                                  kind: "category",
                                  value: {
                                    id: "",
                                    name: "",
                                  },
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
                                  const { module, group } =
                                    recordContext(record);
                                  return (
                                    <li key={record.id}>
                                      <Button
                                        type="button"
                                        variant={
                                          openRecord?.id === record.id
                                            ? "secondary"
                                            : "ghost"
                                        }
                                        className="h-auto min-h-11 w-full justify-start gap-2 px-2 py-1.5 text-left font-normal"
                                        onClick={() => showRecord(record.id)}
                                      >
                                        <GroupMark tone={group?.tone ?? 0} />
                                        <span className="flex min-w-0 flex-col">
                                          <span className="truncate text-sm font-semibold">
                                            {record.title}
                                          </span>
                                          <span className="text-muted-foreground truncate text-xs">
                                            {group?.name ?? module} ·{" "}
                                            {record.status}
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
                            {...commsMenuAccess}
                            onSelect={openWorkspaceSetting}
                          />
                          <h2
                            data-slot="section-title"
                            className="truncate text-sm font-semibold"
                          >
                            {channel?.name ??
                              direct?.user ??
                              "Choose a conversation"}
                          </h2>
                          <p className="text-muted-foreground hidden truncate text-xs lg:block">
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
                            tone={channelTone(
                              channelGroupAccess(channel, categories),
                              groups,
                            )}
                            onOpen={
                              commsMenuAccess.canManageChannel
                                ? (opener) =>
                                    setEditor({
                                      kind: "channel",
                                      value: channel,
                                      opener,
                                    })
                                : undefined
                            }
                          />
                        )}
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
                                        person.id === messageAuthorId(message),
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
                        {channel && commsMenuAccess.canManageChannel && (
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
                            onClick={(event) =>
                              direct.blocked
                                ? void toggleDirect(selected, "blocked")
                                : confirmBlock(
                                    selected,
                                    direct.user,
                                    event.currentTarget,
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
                          Pinned record ·{" "}
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
                                  You do not have access to this channel. Choose
                                  another conversation, or ask an administrator
                                  for access.
                                </Alert>
                              ) : (
                                <>
                                  <div className="mt-4 mb-8 px-3">
                                    <div className="bg-muted mb-3 flex size-12 items-center justify-center rounded-2xl">
                                      {channel ? (
                                        <Hash className="text-muted-foreground size-6" />
                                      ) : (
                                        <MessageSquare className="text-muted-foreground size-6" />
                                      )}
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
                                    onOpenRecord={showRecord}
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
                                    onDelete={deleteWithUndo}
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
                        canPost={canPost}
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
                      <p role="status" className="sr-only">
                        {announcement}
                      </p>
                    </section>
                  </ResizablePanel>
                )}
                {rightOpen && (
                  <>
                    <ResizableHandle
                      aria-label={
                        currentThread
                          ? "Resize thread"
                          : openRecord
                            ? "Resize record"
                            : "Resize members"
                      }
                      onKeyDownCapture={(event) => {
                        if (event.key !== "Home" && event.key !== "End") return;
                        event.preventDefault();
                        event.stopPropagation();
                        const width =
                          event.key === "Home"
                            ? currentThread || openRecord
                              ? 320
                              : 200
                            : currentThread || openRecord
                              ? threadMaximum
                              : memberMaximum;
                        rightPanel.current?.resize(width);
                        patchPreferences(
                          currentThread || openRecord
                            ? { threadWidth: width }
                            : { memberWidth: width },
                        );
                      }}
                    />
                    <ResizablePanel
                      key={
                        currentThread
                          ? "thread"
                          : openRecord
                            ? "record"
                            : "members"
                      }
                      id={
                        currentThread
                          ? "thread"
                          : openRecord
                            ? "record"
                            : "members"
                      }
                      panelRef={rightPanel}
                      defaultSize={
                        currentThread || openRecord ? threadWidth : memberWidth
                      }
                      minSize={currentThread || openRecord ? 320 : 200}
                      maxSize={
                        currentThread || openRecord
                          ? threadMaximum
                          : memberMaximum
                      }
                      groupResizeBehavior="preserve-pixel-size"
                    >
                      <aside
                        id="comms-members"
                        aria-label={
                          currentThread
                            ? "Thread panel"
                            : openRecord
                              ? "Record"
                              : "Channel members"
                        }
                        className="bg-muted/15 h-full min-h-0 overflow-hidden border-l"
                      >
                        {currentThread ? (
                          threadContent
                        ) : openRecord ? (
                          recordContent
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
                  (memberOpen || currentThread || openRecord) && (
                    <Dialog
                      open
                      onOpenChange={(open) => {
                        if (!open) {
                          setMemberOpen(false);
                          setThreadId("");
                          setRecordId("");
                        }
                      }}
                    >
                      <DialogContent
                        className={
                          currentThread || openRecord
                            ? "h-[calc(100dvh-24px)] max-h-[calc(100dvh-24px)] max-w-lg overflow-hidden p-0"
                            : "h-[85dvh] max-w-md"
                        }
                      >
                        <DialogTitle className="sr-only">
                          {currentThread
                            ? "Thread"
                            : openRecord
                              ? "Record"
                              : "Members"}
                        </DialogTitle>
                        <DialogDescription className="sr-only">
                          {currentThread
                            ? "Replies to this message"
                            : openRecord
                              ? "A linked record and where it is mentioned"
                              : "People with access to this conversation"}
                        </DialogDescription>
                        {currentThread
                          ? threadContent
                          : openRecord
                            ? recordContent
                            : membersContent}
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
                  people={people}
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
                          onClick={() => startDirect(person.id)}
                        >
                          <Avatar name={person.name} />
                          Message {person.name}
                        </Action>
                      ))}
                    <Action variant="outline" onClick={() => setDmOpen(false)}>
                      Cancel
                    </Action>
                  </div>
                </DialogContent>
              </Dialog>
            </Activity>
          </LoadingRegion>
        </div>
      </ProfilePopoverProvider>
    </CommsWorkspaceProvider>
  );
}
