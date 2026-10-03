"use client";

import type { useCommsCommands } from "./runtime";
import type { Dispatch, SetStateAction } from "react";
import {
  initialPeople,
  initialRoles,
  type Person,
  type Role,
} from "../../shared/data/sample-people";
import {
  INITIAL_RECORDS,
  type SampleRecord,
} from "../../shared/data/sample-data";
import type { MessageDraft } from "../components/message-shared";
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
  type CommsConfiguration,
} from "../domain/configuration";
import {
  validateCommsMessage,
  validateCommsMessageChange,
} from "../domain/message-policy";
import {
  COMMS_CONFIGURATION_KEY,
  messageFromCommsError,
  readCommsConfiguration,
  stageCommsConfiguration,
} from "./runtime";

type CommsRun = ReturnType<typeof useCommsCommands>["run"];
type MessageSendResult =
  { ok: true; threadId?: string } | { ok: false; error: string };

export function createCommsMessageOperations({
  run,
  selected,
  viewerId,
  replyingTo,
  setThreadId,
  setReplyingTo,
  setNotice,
  announce,
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
}: {
  run: CommsRun;
  selected: string;
  viewerId: string;
  replyingTo: Message | null;
  setThreadId: Dispatch<SetStateAction<string>>;
  setReplyingTo: Dispatch<SetStateAction<Message | null>>;
  /** Reports a failure people must see. */
  setNotice: (message: string) => void;
  /** Tells assistive technology about a result that is already visible. */
  announce: (message: string) => void;
  scrollToLatest: () => void;
  config: CommsConfiguration;
  viewer: Person | undefined;
  channel: Channel | undefined;
  categories: Category[];
  people: Person[];
  roles: Role[];
  allMessages: Message[];
  channelThreads: Thread[];
  records: SampleRecord[];
}) {
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
  /** Puts back a message this person just deleted, in its own channel even
   *  if they have moved on, under the same rule that let them delete it. */
  async function undoDelete(original: Message): Promise<string | null> {
    const result = await run(
      `message:undo-delete:${original.id}`,
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
        const currentViewer = currentPeople.find(
          (person) => person.id === viewerId && person.active,
        );
        if (!currentViewer || !currentConfig.tombstones[original.id])
          return draft.reject("This message can no longer be put back.");
        const error = validateCommsMessageChange({
          config: currentConfig,
          person: currentViewer,
          channel: currentChannels.find(
            (item) => item.id === original.conversation,
          ),
          categories: currentCategories,
          people: currentPeople,
          message: original,
          kind: "delete",
        });
        if (error) return draft.reject(error);
        draft.update<Message[]>("commsMessages", MESSAGES, (items) =>
          [...items.filter((item) => item.id !== original.id), original].sort(
            (a, b) => a.created - b.created,
          ),
        );
        stageCommsConfiguration(draft, (current) => {
          const tombstones = { ...current.tombstones };
          delete tombstones[original.id];
          return { ...current, tombstones };
        });
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
      messageFromCommsError(error, "The message could not be put back."),
    );
    if (result) setNotice(result);
    else announce("Message put back.");
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
    announce("Message sent.");
    requestAnimationFrame(() => scrollToLatest());
    return null;
  }

  return {
    changeMessage,
    deleteMessage,
    undoDelete,
    validateDraft,
    sendMessage,
  };
}
