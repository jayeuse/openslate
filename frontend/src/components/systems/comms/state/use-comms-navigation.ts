"use client";

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type SetStateAction,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useWorkspaceNavigationRequest } from "@/components/workspace-navigation-guard";
import {
  threadMessages,
  type Message,
  type Thread,
} from "../domain/view-model";
import type { CommsPreferences } from "../domain/configuration";
import { useCommsRead } from "./runtime";
import { useCommsClient } from "./client-context";
import type { CommsViewClient as CommsClient } from "../contract/client";

export function useCommsNavigationState(
  firstConversation = "",
  messages: Message[] = [],
  threads: Thread[] = [],
) {
  const router = useRouter();
  const requestNavigation = useWorkspaceNavigationRequest();
  const { client } = useCommsClient();
  const [navigating, startNavigation] = useTransition();
  const query = useSearchParams();
  const view = ["threads", "activity", "inbox", "browse"].includes(
    query.get("view") ?? "",
  )
    ? query.get("view")
    : null;
  const messageId = query.get("message") ?? "";
  const linkedMessage = messages.find((message) => message.id === messageId);
  const linked = useCommsRead(
    `message-target:${messageId}:${!!linkedMessage}`,
    async (client, signal) => {
      if (!messageId || linkedMessage) return null;
      for (const { conversation } of (await client.bootstrap({ signal }))
        .conversations) {
        try {
          return (
            await client.getMessage(conversation.id, messageId, { signal })
          ).data;
        } catch (error) {
          if (!(
            typeof error === "object" &&
            error !== null &&
            "failure" in error &&
            typeof error.failure === "object" &&
            error.failure !== null &&
            "status" in error.failure &&
            error.failure.status === 404
          ))
            throw error;
        }
      }
      return null;
    },
  );
  const linkedThread = threads.find(
    (thread) => thread.id === query.get("thread"),
  );
  const selected =
    query.get("conversation") ??
    (query.get("settings") === "permissions" ? query.get("channel") : null) ??
    linkedMessage?.conversation ??
    linked.data?.conversation_id ??
    linkedThread?.conversation ??
    (messageId || query.has("thread") ? "" : firstConversation);
  const threadId =
    query.get("thread") ??
    (linkedMessage?.parentId
      ? threads.find((thread) => thread.messageId === linkedMessage.parentId)
          ?.id
      : linked.data?.parent_id
        ? linked.data.thread?.id
        : "") ??
    "";
  const panel = query.get("panel");
  const memberOpen = panel === "members";
  const membersVisible = memberOpen;
  const recordId = panel?.startsWith("record:") ? panel.slice(7) : "";
  const mobileConversation =
    query.has("conversation") ||
    !!messageId ||
    !!threadId ||
    !!view ||
    query.has("tool");
  function update(
    patch: Record<string, string | null>,
    push = false,
    confirmed = false,
  ) {
    const next = new URLSearchParams(query.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    const href = next.size ? (`/comms?${next}` as const) : "/comms";
    if (href === `/comms${query.size ? `?${query}` : ""}`) return;
    const resume = () =>
      startNavigation(() =>
        (push ? router.push : router.replace)(href, { scroll: false }),
      );
    if (confirmed || requestNavigation(href, resume)) resume();
  }
  function navigate(id: string, detail: Record<string, string | null> = {}) {
    update(
      {
        conversation: id,
        view: null,
        thread: null,
        message: null,
        panel: null,
        tool: null,
        settings: null,
        channel: null,
        role: null,
        ...detail,
      },
      id !== selected || !query.has("conversation"),
    );
  }
  const setSelected = (id: string) => navigate(id);
  const setThreadId = (action: SetStateAction<string>) => {
    const id = typeof action === "function" ? action(threadId) : action;
    update({
      conversation: selected,
      thread: id,
      message: id
        ? null
        : (threads.find((thread) => thread.id === threadId)?.messageId ?? null),
      panel: id ? "thread" : "none",
    });
  };
  const setMemberOpen = (action: SetStateAction<boolean>) => {
    const open = typeof action === "function" ? action(memberOpen) : action;
    update({
      conversation: selected,
      panel: open ? "members" : "none",
      thread: null,
      message: null,
    });
  };
  const [search, setSearch] = useState("");
  const [reply, setReply] = useState<{
    client: CommsClient;
    message: Message;
  } | null>(null);
  // A quote may come from an older history page, not the workspace's newest 50.
  const replyCandidate =
    reply?.client === client && reply.message.conversation === selected
      ? (messages.find((message) => message.id === reply.message.id) ??
        reply.message)
      : null;
  const replyingTo = replyCandidate?.deleted ? null : replyCandidate;
  function setReplyingTo(action: SetStateAction<Message | null>) {
    const next = typeof action === "function" ? action(replyingTo) : action;
    setReply(client && next ? { client, message: next } : null);
  }
  const [highlightedId, setHighlightedId] = useState("");
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const messageList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSearch("");
    setReply(null);
    setHighlightedId(messageId);
    setAwayFromLatest(false);
  }, [selected, messageId]);

  return {
    selected,
    view,
    showView: (view: string) =>
      update(
        { view, thread: null, message: null, panel: "none", tool: null },
        true,
      ),
    navigating,
    query,
    update,
    closeTool: () => update({ tool: null }, false, true),
    navigate,
    messageId,
    membersVisible,
    recordId,
    setRecordId: (id: string) =>
      update({
        conversation: selected,
        panel: id ? `record:${id}` : null,
        thread: null,
        message: null,
      }),
    setSelected,
    mobileConversation,
    setMobileConversation: (open: boolean) => {
      if (!open)
        update({
          conversation: null,
          view: null,
          thread: null,
          message: null,
          panel: null,
          tool: null,
        });
    },
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
  };
}

export type NavigationState = ReturnType<typeof useCommsNavigationState>;

export function createCommsNavigationActions({
  state,
  preferences,
  allMessages,
  threads,
  canParticipate,
  setThreadDirectory,
}: {
  state: NavigationState;
  preferences: CommsPreferences;
  clockNow: number;
  allMessages: Message[];
  threads: Thread[];
  canParticipate: boolean;
  patchPreferences: (patch: Partial<CommsPreferences>) => Promise<void>;
  setThreadDirectory: (opener: HTMLElement | null) => void;
}) {
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

  function select(id: string, detail?: Record<string, string | null>) {
    state.navigate(id, detail);
    state.setSearch("");
    state.setReplyingTo(null);
    state.setHighlightedId("");
    state.setAwayFromLatest(false);
  }

  function openThread(item: Thread, conversation: string) {
    select(conversation, { thread: item.id, panel: "thread" });
    setThreadDirectory(null);
  }

  function jumpToMessage(id: string) {
    state.setSearch("");
    state.setHighlightedId(id);
    const containingThread = threads.find((item) =>
      threadMessages(item).some((reply) => reply.id === id),
    );
    const message = allMessages.find((item) => item.id === id);
    state.navigate(message?.conversation ?? state.selected, {
      message: id,
      thread: containingThread?.id ?? null,
      panel: containingThread ? "thread" : null,
    });
  }

  function beginReply(message: Message) {
    if (!canParticipate) return;
    state.setReplyingTo(message);
    requestAnimationFrame(() =>
      document.getElementById(`composer-${state.selected}`)?.focus(),
    );
  }

  function scrollToLatest(behavior?: ScrollBehavior) {
    const list = state.messageList.current;
    if (!list) return;
    list.scrollTo({
      top: list.scrollHeight,
      ...(behavior ? { behavior } : {}),
    });
  }

  return {
    latestChannelActivity,
    channelUnread,
    select,
    openThread,
    jumpToMessage,
    beginReply,
    scrollToLatest,
  };
}
