import type { CommsClient } from "../contract/client";
import type * as C from "../contract/types";
import type { Person } from "../../shared/data/sample-people";
import type { SampleRecord } from "../../shared/data/sample-data";
import type { CommsGroup } from "../domain/groups";
import { loadQuotes, messageView } from "./message-view";
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

export async function loadWorkspace(
  client: CommsClient,
  signal: AbortSignal,
  groups: CommsGroup[],
) {
  const options = { signal };
  const bootstrap = await client.bootstrap(options);
  const config = createCommsConfiguration();
  const [personal, workspaceSettings, threads] = await Promise.all([
    client.getPersonalPreferences(options),
    client.getSettings({ kind: "workspace" }, options),
    Promise.all(
      [false, true].map((archived) =>
        complete((offset) =>
          client.listThreads({ limit: 100, offset, archived }, options),
        ),
      ),
    ).then((pages) => pages.flat()),
  ]);
  config.workspace.settings = settingsView(workspaceSettings.data.overrides);
  config.workspace.capabilities = (
    await client.getCapabilityConfiguration({ kind: "workspace" }, options)
  ).data;
  config.lockedCapabilities = (
    await client.getCapabilityLocks(options)
  ).data.capabilities;
  function resolved(response: C.SettingsResponse) {
    return {
      values: {
        ...DEFAULT_COMMS_SETTINGS,
        ...settingsView(response.effective),
        ...("dm_rule" in response ? { dmRule: response.dm_rule } : {}),
      },
      locked: response.locked_keys.map(
        (key) =>
          key.replace(/_([a-z])/g, (_, letter: string) =>
            letter.toUpperCase(),
          ) as keyof CommsSettings,
      ),
      sources: Object.fromEntries(
        Object.entries(response.sources).map(([key, source]) => [
          key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
          source.kind,
        ]),
      ),
    };
  }
  config.resolved.workspace = resolved(workspaceSettings.data);
  if ("dm_rule" in workspaceSettings.data)
    config.workspace.settings.dmRule = workspaceSettings.data.dm_rule;
  config.lockedSettings = workspaceSettings.data.locked_keys.map(
    (key) =>
      key.replace(/_([a-z])/g, (_, letter: string) =>
        letter.toUpperCase(),
      ) as keyof CommsSettings,
  );
  const categories: Category[] = bootstrap.categories.map(({ category }) => ({
    id: category.id,
    name: category.name,
    groupId: category.default_access.find((row) => row.subject === "group")
      ?.group_id,
    groupAccess: Object.fromEntries(
      category.default_access.map((row) => [
        row.subject === "everyone" ? "everyone" : row.group_id,
        row.level,
      ]),
    ),
  }));
  for (const { category } of bootstrap.categories) {
    const response = await client.getSettings(
      { kind: "category", id: category.id },
      options,
    );
    config.categories[category.id] = {
      settings: settingsView(response.data.overrides),
      capabilities: (
        await client.getCapabilityConfiguration(
          { kind: "category", id: category.id },
          options,
        )
      ).data,
    };
    config.resolved[`category:${category.id}`] = resolved(response.data);
  }
  const people = new Map<string, Person>();
  const channels: Channel[] = [];
  const directs: Direct[] = [];
  const rawMessages = new Map<string, C.Message>();
  const historyPages: Record<string, C.HistoryPage> = {};
  let removedCount = 0;
  const checks: Record<string, C.CapabilityCheck> = {};
  const members: Record<string, C.Member[]> = {};
  const effective: Record<string, C.Settings> = {};
  const records = new Map<string, SampleRecord>();
  const prefs = personal.data;
  const preferences = {
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
    favorites: bootstrap.conversations
      .filter((row) => row.preferences.starred)
      .map((row) => row.conversation.id),
    hiddenChannels: bootstrap.conversations
      .filter((row) => row.preferences.hidden)
      .map((row) => row.conversation.id),
    mutedUntil: Object.fromEntries(
      bootstrap.conversations.map((row) => [
        row.conversation.id,
        row.preferences.mute.kind === "until"
          ? Date.parse(row.preferences.mute.until)
          : row.preferences.mute.kind === "indefinite"
            ? Number.MAX_SAFE_INTEGER
            : 0,
      ]),
    ),
    readAt: Object.fromEntries(
      bootstrap.conversations.map((row) => [
        row.conversation.id,
        row.unread_count || row.preferences.manual_unread
          ? 0
          : Number.MAX_SAFE_INTEGER,
      ]),
    ),
  };
  config.preferences[client.context.user_id] = preferences;
  for (const summary of bootstrap.conversations) {
    const room = summary.conversation;
    const [roomMembers, check, settings] = await Promise.all([
      complete((offset) =>
        client.listMembers(room.id, { limit: 100, offset }, options),
      ),
      client.getCapabilities(room.id, options).catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "failure" in error &&
          typeof error.failure === "object" &&
          error.failure !== null &&
          "status" in error.failure &&
          error.failure.status === 403
        )
          return undefined;
        throw error;
      }),
      client.getSettings(
        room.kind === "channel"
          ? { kind: "channel", id: room.id }
          : { kind: "workspace" },
        options,
      ),
    ]);
    members[room.id] = roomMembers;
    if (check) checks[room.id] = check;
    effective[room.id] = settings.data.effective;
    for (const member of roomMembers)
      people.set(member.user_id, {
        id: member.user_id,
        name: member.display_name,
        email: "",
        active: true,
        role:
          member.user_id === client.context.user_id && check
            ? check.membership_role
            : "conversation-member",
        departments: member.departments.map((department) => department.name),
        primary: member.departments[0]?.name ?? "",
        groupIds: groups
          .filter((group) => group.memberIds.includes(member.user_id))
          .map((group) => group.id),
        title: "",
        activity: [],
      });
    if (room.kind === "channel") {
      channels.push({
        id: room.id,
        name: room.name,
        description: room.topic,
        categoryId: room.category_id ?? "",
        archived: room.archived_at !== null,
        scope: room.scope,
        groupAccess: Object.fromEntries(
          room.scope === "groups"
            ? room.access.map((row) => [
                row.subject === "everyone" ? "everyone" : row.group_id,
                row.level,
              ])
            : room.scope === "organization"
              ? [["everyone", "post"]]
              : [],
        ),
      });
      config.channels[room.id] = {
        settings: settingsView(settings.data.overrides),
        capabilities: (
          await client.getCapabilityConfiguration(
            { kind: "channel", id: room.id },
            options,
          )
        ).data,
      };
    } else
      directs.push({
        id: room.id,
        user:
          room.kind === "group"
            ? room.name
            : (roomMembers.find(
                (member) => member.user_id !== client.context.user_id,
              )?.display_name ?? "Direct conversation"),
        read: summary.unread_count === 0 && !summary.preferences.manual_unread,
        blocked: false,
      });
    config.resolved[room.id] = resolved(settings.data);
    for (const message of await complete((offset) =>
      client.listPins(room.id, { limit: 100, offset }, options),
    ))
      rawMessages.set(message.id, message);
    if (check?.capabilities.moderate.allowed)
      removedCount += (
        await client.listRemovedMessages(room.id, { limit: 1 }, options)
      ).pagination.total;
  }
  for (const thread of threads) {
    const root = await client.getMessage(
      thread.conversation_id,
      thread.root_message_id,
      options,
    );
    rawMessages.set(root.data.id, root.data);
    let before: number | undefined;
    for (;;) {
      const replies = await client.getReplies(
        thread.conversation_id,
        thread.root_message_id,
        { limit: 100, ...(before ? { before_seq: before } : {}) },
        options,
      );
      for (const message of replies.items) rawMessages.set(message.id, message);
      if (!replies.pagination.has_older) break;
      const next = replies.items[0]?.seq;
      if (next === undefined || next === before)
        throw new Error("Incomplete thread history");
      before = next;
    }
  }
  const presence: Presence = {};
  const userIds = [...people.keys()];
  for (let offset = 0; offset < userIds.length; offset += 100) {
    for (const item of (
      await client.getPresence(
        { user_ids: userIds.slice(offset, offset + 100) },
        options,
      )
    ).items)
      presence[item.user_id] = item.state;
  }
  const blocks = await complete((offset) =>
    client.listDirectBlocks({ limit: 100, offset }, options),
  );
  for (const direct of directs) {
    const source = bootstrap.conversations.find(
      (row) => row.conversation.id === direct.id,
    )?.conversation;
    direct.blocked =
      source?.kind === "direct" &&
      blocks.some((block) =>
        source.participant_ids.includes(block.blocked_user_id),
      );
  }
  // These complete metadata consumers must not silently become a timeline page.
  for (const hit of await complete((offset) =>
    client.search({ has: "record", limit: 100, offset }, options),
  )) {
    const message = await client.getMessage(
      hit.conversation_id,
      hit.message_id,
      options,
    );
    rawMessages.set(message.data.id, message.data);
  }
  for (const { conversation } of bootstrap.conversations) {
    const history = await client.getHistory(
      conversation.id,
      { limit: 50 },
      options,
    );
    historyPages[conversation.id] = history;
    for (const message of history.items) rawMessages.set(message.id, message);
  }
  await loadQuotes(client, rawMessages, signal);
  const projected = new Map<string, Message>();
  for (const message of rawMessages.values())
    projected.set(message.id, messageView(message, people, records));
  const displayThreads: Thread[] = threads.map((thread) => ({
    name: thread.name,
    locked: thread.locked,
    archived: thread.archived,
    id: thread.id,
    conversation: thread.conversation_id,
    messageId: thread.root_message_id,
    resolved: thread.resolved,
    subscribed: thread.followed,
    replies: [...rawMessages.values()]
      .filter((message) => message.parent_id === thread.root_message_id)
      .flatMap((message) => projected.get(message.id) ?? []),
  }));
  return {
    presence,
    removedCount,
    historyPages,
    client,
    bootstrap,
    checks,
    members,
    effective,
    personal,
    configuration: config,
    people: [...people.values()],
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
    categories,
    channels,
    directs,
    messages: [...rawMessages.values()]
      .filter(
        (message) =>
          message.parent_id === null ||
          (message.state === "live" && message.also_send_to_channel),
      )
      .flatMap((message) => projected.get(message.id) ?? []),
    threads: displayThreads,
    records: [...records.values()],
    account: { presence: "Offline" },
  };
}
