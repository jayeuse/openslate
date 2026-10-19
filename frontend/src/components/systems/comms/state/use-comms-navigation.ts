"use client";

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type SetStateAction,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  threadMessages,
  type Message,
  type Thread,
} from "../domain/view-model";
import type { CommsPreferences } from "../domain/configuration";

export function useCommsNavigationState(
  firstConversation = "",
  messages: Message[] = [],
  threads: Thread[] = [],
) {
  const router = useRouter();
  const [navigating, startNavigation] = useTransition();
  const query = useSearchParams();
  const messageId = query.get("message") ?? "";
  const linkedMessage = messages.find((message) => message.id === messageId);
  const linkedThread = threads.find(
    (thread) => thread.id === query.get("thread"),
  );
  const selected =
    query.get("conversation") ??
    (query.get("settings") === "permissions" ? query.get("channel") : null) ??
    linkedMessage?.conversation ??
    linkedThread?.conversation ??
    (messageId || query.has("thread") ? "" : firstConversation);
  const threadId =
    query.get("thread") ??
    (linkedMessage?.parentId
      ? threads.find((thread) => thread.messageId === linkedMessage.parentId)
          ?.id
      : "") ??
    "";
  const panel = query.get("panel");
  const memberOpen = panel === "members";
  const membersVisible = panel === null || memberOpen;
  const recordId = panel?.startsWith("record:") ? panel.slice(7) : "";
  const mobileConversation =
    query.has("conversation") || !!messageId || !!threadId;
  function update(patch: Record<string, string | null>, push = false) {
    const next = new URLSearchParams(query.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    const href = next.size ? (`/comms?${next}` as const) : "/comms";
    if (href === `/comms${query.size ? `?${query}` : ""}`) return;
    startNavigation(() =>
      (push ? router.push : router.replace)(href, { scroll: false }),
    );
  }
  function navigate(id: string, detail: Record<string, string | null> = {}) {
    update(
      {
        conversation: id,
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
      message: null,
      panel: id ? "thread" : null,
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
  const [replyingToId, setReplyingToId] = useState("");
  const replyingTo =
    messages.find(
      (message) => message.id === replyingToId && !message.deleted,
    ) ?? null;
  function setReplyingTo(action: SetStateAction<Message | null>) {
    const next = typeof action === "function" ? action(replyingTo) : action;
    setReplyingToId(next?.id ?? "");
  }
  const [highlightedId, setHighlightedId] = useState("");
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const messageList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSearch("");
    setReplyingToId("");
    setHighlightedId(messageId);
    setAwayFromLatest(false);
  }, [selected, messageId]);

  return {
    selected,
    navigating,
    query,
    update,
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
  clockNow,
  allMessages,
  threads,
  canParticipate,
  patchPreferences,
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
    const left = state.selected;
    patchPreferences({
      readAt: {
        ...preferences.readAt,
        // The conversation being left was seen too, including the one that
        // was open on arrival, so it does not come back as unread.
        ...(left && left !== id
          ? { [left]: Math.max(clockNow, latestChannelActivity(left)) }
          : {}),
        [id]: Math.max(clockNow, latestChannelActivity(id)),
      },
    });
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
    if (message)
      state.navigate(message.conversation, {
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
