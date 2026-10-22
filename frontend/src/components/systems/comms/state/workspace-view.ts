import type { CommsViewClient as CommsClient } from "../contract/client";
import type * as C from "../contract/types";
import type { Person } from "../../shared/data/sample-people";
import type { SampleRecord } from "../../shared/data/sample-data";
import { loadQuotes, messageView } from "./message-view";
import { BURST, limited } from "./bounded";
import type { ConversationDetail } from "../adapters/conversation-detail";
import {
  type Category,
  type Channel,
  type Direct,
  type Message,
  type Thread,
  type Presence,
} from "../domain/view-model";
import {
  createCommsConfiguration,
  DEFAULT_COMMS_PREFERENCES,
  DEFAULT_COMMS_SETTINGS,
  settingsView,
  type CommsSettings,
} from "../domain/configuration-model";

export async function complete<T>(
  read: (offset: number) => Promise<C.Page<T>>,
) {
  const items: T[] = [];
  for (;;) {
    const page = await read(items.length);
    items.push(...page.items);
    if (!page.pagination.has_more) return items;
    if (!page.items.length)
      throw new Error("Incomplete conversation collection");
  }
}

/** The viewer's display preferences from the personal preferences read. */
function personalPreferences(prefs: C.PersonalPreferences) {
  return {
    ...DEFAULT_COMMS_PREFERENCES,
    density: prefs.density,
    textSize: prefs.text_size,
    timestamps: prefs.timestamps,
    groupMessages: prefs.group_messages,
    avatars: prefs.avatars,
    previews: prefs.previews,
    sendShortcut: prefs.send_shortcut,
    shortcuts: {
      search: prefs.shortcuts.search,
      newMessage: prefs.shortcuts.new_message,
    },
    channelWidth: prefs.channel_width,
    memberWidth: prefs.member_width,
    threadWidth: prefs.thread_width,
    settings: settingsView(prefs.notifications),
  };
}

type LoadedWorkspace = Awaited<ReturnType<typeof loadWorkspace>>;

/**
 * The parts of the workspace that come from the bootstrap alone. They follow
 * the live bootstrap query, so a bootstrap refresh (new counts, a read
 * watermark, a created channel) shows without reading the workspace again.
 */
export function withBootstrap<T extends LoadedWorkspace>(
  workspace: T,
  bootstrap: C.Bootstrap,
) {
  const userId = workspace.client.context.user_id;
  const rows = bootstrap.conversations;
  const categories: Category[] = bootstrap.categories.map(({ category }) => ({
    id: category.id,
    name: category.name,
    departmentId: category.department_id ?? "",
  }));
  const channels: Channel[] = rows.flatMap(({ conversation: room }) =>
    room.kind === "channel"
      ? [
          {
            id: room.id,
            name: room.name,
            description: room.topic,
            categoryId: room.category_id ?? "",
            archived: room.archived_at !== null,
            scope: room.scope,
            departmentId: room.scope === "department" ? room.department_id : "",
          },
        ]
      : [],
  );
  const directs: Direct[] = rows.flatMap((summary) => {
    const room = summary.conversation;
    if (room.kind === "channel") return [];
    return [
      {
        id: room.id,
        user:
          room.kind === "group"
            ? room.name
            : // A participant who left the organization has no name.
              (room.participants.find(
                (participant) => participant.user_id !== userId,
              )?.display_name ?? "Former member"),
        read: summary.unread_count === 0 && !summary.preferences.manual_unread,
        blocked:
          room.kind === "direct" &&
          workspace.blocks.some((block) =>
            room.participant_ids.includes(block.blocked_user_id),
          ),
      },
    ];
  });
  const preferences = {
    ...(workspace.configuration.preferences[userId] ??
      DEFAULT_COMMS_PREFERENCES),
    favorites: rows
      .filter((row) => row.preferences.starred)
      .map((row) => row.conversation.id),
    hiddenChannels: rows
      .filter((row) => row.preferences.hidden)
      .map((row) => row.conversation.id),
    mutedUntil: Object.fromEntries(
      rows.map((row) => [
        row.conversation.id,
        row.preferences.mute.kind === "until"
          ? Date.parse(row.preferences.mute.until)
          : row.preferences.mute.kind === "indefinite"
            ? Number.MAX_SAFE_INTEGER
            : 0,
      ]),
    ),
    readAt: Object.fromEntries(
      rows.map((row) => [
        row.conversation.id,
        row.unread_count || row.preferences.manual_unread
          ? 0
          : Number.MAX_SAFE_INTEGER,
      ]),
    ),
  };
  return {
    ...workspace,
    bootstrap,
    categories,
    channels,
    directs,
    configuration: {
      ...workspace.configuration,
      preferences: {
        ...workspace.configuration.preferences,
        [userId]: preferences,
      },
    },
  };
}

/** Settings as the dialogs and resolvers show them, with camel-case keys. */
function resolved(response: C.SettingsResponse) {
  const camel = (key: string) =>
    key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return {
    values: {
      ...DEFAULT_COMMS_SETTINGS,
      ...settingsView(response.effective),
      ...("dm_rule" in response ? { dmRule: response.dm_rule } : {}),
    },
    locked: response.locked_keys.map(
      (key) => camel(key) as keyof CommsSettings,
    ),
    sources: Object.fromEntries(
      Object.entries(response.sources).map(([key, source]) => [
        camel(key),
        source.kind,
      ]),
    ),
  };
}

/**
 * The workspace read that gates the page frame: two short dependent hops,
 * whatever the number of conversations. Per-conversation members, checks,
 * settings and pins are read only for an open conversation
 * (`ConversationDetail`); threads and record links fill in after
 * (`loadWorkspaceMessages`).
 */
export async function loadWorkspace(client: CommsClient, signal: AbortSignal) {
  const options = { signal };
  const [bootstrap, personal, workspaceSettings, workspaceCapabilities] =
    await Promise.all([
      client.bootstrap(options),
      client.getPersonalPreferences(options),
      client.getSettings({ kind: "workspace" }, options),
      client.getCapabilityConfiguration({ kind: "workspace" }, options),
    ]);
  const config = createCommsConfiguration();
  config.workspace.settings = settingsView(workspaceSettings.data.overrides);
  config.workspace.capabilities = workspaceCapabilities.data;
  config.resolved.workspace = resolved(workspaceSettings.data);
  if ("dm_rule" in workspaceSettings.data)
    config.workspace.settings.dmRule = workspaceSettings.data.dm_rule;
  config.lockedSettings = config.resolved.workspace.locked;
  config.preferences[client.context.user_id] = personalPreferences(
    personal.data,
  );
  const [categoryReads, blocks] = await Promise.all([
    limited(bootstrap.categories, BURST / 2, ({ category }) =>
      Promise.all([
        client.getSettings({ kind: "category", id: category.id }, options),
        client.getCapabilityConfiguration(
          { kind: "category", id: category.id },
          options,
        ),
      ]),
    ),
    // A blocked direct must never show as open, so blocks gate the frame.
    bootstrap.conversations.some((row) => row.conversation.kind === "direct")
      ? complete((offset) =>
          client.listDirectBlocks({ limit: 100, offset }, options),
        )
      : Promise.resolve([] as C.DirectBlock[]),
  ]);
  for (const [index, { category }] of bootstrap.categories.entries()) {
    const [response, capabilities] = categoryReads[index];
    config.categories[category.id] = {
      settings: settingsView(response.data.overrides),
      capabilities: capabilities.data,
    };
    config.resolved[`category:${category.id}`] = resolved(response.data);
  }
  return {
    client,
    bootstrap,
    personal,
    workspaceSettings: workspaceSettings.data,
    configuration: config,
    roles: [
      { id: "admin", name: "Administrator", builtin: true, grants: [] },
      { id: "member", name: "Member", builtin: true, grants: [] },
      { id: "guest", name: "Guest", builtin: true, grants: [] },
      {
        id: "conversation-member",
        name: "Conversation member",
        builtin: true,
        grants: [],
      },
    ],
    blocks,
  };
}

/** Thread lists and their root messages (and the roots' quotes). */
export interface WorkspaceThreads {
  rawThreads: C.Thread[];
  roots: C.Message[];
}

/**
 * Both thread lists and their roots. Nothing waits for it. `known` roots are
 * reused (a new thread or reply reads only the roots it lacks); a repair
 * passes none and reads every root again.
 */
export async function loadWorkspaceThreads(
  client: CommsClient,
  signal: AbortSignal,
  known: ReadonlyMap<string, C.Message> = new Map(),
): Promise<WorkspaceThreads> {
  const options = { signal };
  const threads = (
    await Promise.all(
      [false, true].map((archived) =>
        complete((offset) =>
          client.listThreads({ limit: 100, offset, archived }, options),
        ),
      ),
    )
  ).flat();
  const missing = threads.filter(
    (thread) => !known.has(thread.root_message_id),
  );
  const read = await limited(missing, BURST, (thread) =>
    client.getMessage(thread.conversation_id, thread.root_message_id, options),
  );
  const roots = new Map<string, C.Message>();
  for (const thread of threads) {
    const root = known.get(thread.root_message_id);
    if (!root) continue;
    roots.set(root.id, root);
    // A kept root keeps the quote it already showed: no quote read again.
    const quote =
      root.state === "live" && root.reply_to_id
        ? known.get(root.reply_to_id)
        : undefined;
    if (quote) roots.set(quote.id, quote);
  }
  for (const message of read) roots.set(message.data.id, message.data);
  await loadQuotes(client, roots, signal);
  return { rawThreads: threads, roots: [...roots.values()] };
}

/**
 * Messages that link records (one `has:record` search per load) and their
 * quotes. Nothing waits for it. Messages already held as thread roots are not
 * read again.
 */
export async function loadWorkspaceRecords(
  client: CommsClient,
  signal: AbortSignal,
  held: ReadonlySet<string> = new Set(),
): Promise<C.Message[]> {
  const options = { signal };
  // Records you follow include links made only in thread replies, which no
  // channel history or thread root carries, so every load reads them once.
  const hits = await complete((offset) =>
    client.search({ has: "record", limit: 100, offset }, options),
  );
  const read = await limited(
    hits.filter((hit) => !held.has(hit.message_id)),
    BURST,
    (hit) => client.getMessage(hit.conversation_id, hit.message_id, options),
  );
  const messages = new Map<string, C.Message>();
  for (const message of read) messages.set(message.data.id, message.data);
  await loadQuotes(client, messages, signal);
  return [...messages.values()];
}

/** A person as Comms views show them, from a member row or a name alone. */
export function commsPerson(
  id: string,
  name: string,
  departments: readonly { name: string }[] = [],
  role = "conversation-member",
): Person {
  return {
    id,
    name,
    email: "",
    active: true,
    role,
    departments: departments.map((department) => department.name),
    primary: departments[0]?.name ?? "",
    groupIds: [],
    title: "",
    activity: [],
  };
}

/**
 * Adds the loaded conversation details (the open conversation, and any
 * conversation opened earlier that is still cached): members, people,
 * presence, checks, settings and pins. Messages are projected here, so author
 * names follow every person known so far.
 */
export function withDetails<T extends ReturnType<typeof withBootstrap>>(
  workspace: T,
  details: Readonly<Record<string, ConversationDetail>>,
  presence: Readonly<Presence>,
  threadRead: WorkspaceThreads | undefined,
  recordLinks: readonly C.Message[] | undefined,
  // Names the person cards found for authors no loaded member names.
  authors: ReadonlyMap<string, string> = new Map(),
) {
  const viewerId = workspace.client.context.user_id;
  const config = {
    ...workspace.configuration,
    channels: { ...workspace.configuration.channels },
    resolved: { ...workspace.configuration.resolved },
  };
  const people = new Map<string, Person>();
  const checks: Record<string, C.CapabilityCheck> = {};
  const members: Record<string, C.Member[]> = {};
  const effective: Record<string, C.Settings> = {};
  const raw = new Map(
    [...(threadRead?.roots ?? []), ...(recordLinks ?? [])].map((message) => [
      message.id,
      message,
    ]),
  );
  for (const [id, detail] of Object.entries(details)) {
    members[id] = detail.members;
    if (detail.check) checks[id] = detail.check;
    const settings = detail.settings ?? workspace.workspaceSettings;
    effective[id] = settings.effective;
    config.resolved[id] = resolved(settings);
    if (detail.settings && detail.capabilities)
      config.channels[id] = {
        settings: settingsView(detail.settings.overrides),
        capabilities: detail.capabilities,
      };
    for (const member of detail.members)
      if (!people.has(member.user_id) || member.user_id === viewerId)
        people.set(
          member.user_id,
          commsPerson(
            member.user_id,
            member.display_name,
            member.departments,
            member.user_id === viewerId && detail.check
              ? detail.check.membership_role
              : undefined,
          ),
        );
    for (const message of detail.pins) raw.set(message.id, message);
  }
  // Thread roots and record links name authors outside the open
  // conversation from their person cards; those names do not make people.
  const named = new Map(people);
  for (const [id, name] of authors)
    if (!named.has(id)) named.set(id, commsPerson(id, name));
  const records = new Map<string, SampleRecord>();
  const projected = new Map<string, Message>();
  for (const message of raw.values())
    projected.set(message.id, messageView(message, named, records));
  const threads: Thread[] = (threadRead?.rawThreads ?? []).map((thread) => ({
    name: thread.name,
    locked: thread.locked,
    archived: thread.archived,
    id: thread.id,
    conversation: thread.conversation_id,
    messageId: thread.root_message_id,
    resolved: thread.resolved,
    replyCount: thread.reply_count,
    subscribed: thread.followed,
    replies: [...raw.values()]
      .filter((message) => message.parent_id === thread.root_message_id)
      .flatMap((message) => projected.get(message.id) ?? []),
  }));
  return {
    ...workspace,
    configuration: config,
    presence,
    checks,
    members,
    effective,
    people: [...people.values()],
    messages: [...raw.values()]
      .filter(
        (message) =>
          message.parent_id === null ||
          (message.state === "live" && message.also_send_to_channel),
      )
      .flatMap((message) => projected.get(message.id) ?? []),
    threads,
    records: [...records.values()],
    account: { presence: "Offline" },
  };
}
