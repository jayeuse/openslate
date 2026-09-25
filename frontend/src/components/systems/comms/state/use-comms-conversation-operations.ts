"use client";

import type { useCommsCommands } from "./runtime";
import type { Dispatch, SetStateAction } from "react";
import { initialPeople, type Person } from "../../access/domain/model";
import type { ThreadChangeOptions } from "../components/message-shared";
import {
  CATEGORIES,
  CHANNELS,
  MESSAGES,
  threadMessages,
  type Category,
  type Channel,
  type Direct,
  type Message,
  type Thread,
} from "../domain/model";
import { INITIAL_DIRECTS } from "./use-comms-workspace";
import {
  resolveCommsPermission,
  resolveCommsSettings,
} from "../domain/configuration";
import {
  COMMS_CONFIGURATION_KEY,
  messageFromCommsError,
  readCommsConfiguration,
  stageCommsConfiguration,
} from "./runtime";

type CommsRun = ReturnType<typeof useCommsCommands>["run"];

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

export function createCommsConversationOperations({
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
}: {
  run: CommsRun;
  selected: string;
  threadId: string;
  viewerId: string;
  select: (id: string) => void;
  setDirectError: (error: string) => void;
  setNotice: (message: string) => void;
  setDmOpen: Dispatch<SetStateAction<boolean>>;
  setThreadId: Dispatch<SetStateAction<string>>;
  setMemberOpen: Dispatch<SetStateAction<boolean>>;
}) {
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

  return { startDirect, startThread, patchThread };
}
