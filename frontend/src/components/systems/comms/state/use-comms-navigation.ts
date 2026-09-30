"use client";

import { useRef, useState } from "react";
import {
  CHANNELS,
  threadMessages,
  type Message,
  type Thread,
} from "../domain/model";
import type { CommsPreferences } from "../domain/configuration";

export function useCommsNavigationState() {
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
  const [threadId, setThreadId] = useState(() =>
    typeof window === "undefined"
      ? ""
      : (new URLSearchParams(window.location.search).get("thread") ?? ""),
  );
  const [memberOpen, setMemberOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [highlightedId, setHighlightedId] = useState("");
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const messageList = useRef<HTMLDivElement>(null);

  return {
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
  };
}

type NavigationState = ReturnType<typeof useCommsNavigationState>;

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

  function select(id: string) {
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
    state.setSelected(id);
    state.setMobileConversation(true);
    state.setThreadId("");
    state.setSearch("");
    state.setReplyingTo(null);
    state.setHighlightedId("");
    state.setMemberOpen(false);
    state.setAwayFromLatest(false);
  }

  function openThread(item: Thread, conversation: string) {
    select(conversation);
    state.setThreadId(item.id);
    setThreadDirectory(null);
  }

  function jumpToMessage(id: string) {
    state.setSearch("");
    state.setHighlightedId(id);
    const containingThread = threads.find((item) =>
      threadMessages(item).some((reply) => reply.id === id),
    );
    if (containingThread) state.setThreadId(containingThread.id);
    requestAnimationFrame(() => {
      const target = document.getElementById(id);
      target?.focus();
      target?.scrollIntoView({ block: "center" });
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
