"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { useCommsClient } from "../state/client-context";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";

/** Local, short-lived hints from the already-authorized shared subscription. */
export function TypingIndicator({
  conversationId,
  enabled,
}: {
  conversationId: string;
  enabled: boolean;
}) {
  const { client, scope } = useCommsClient();
  const workspace = useCommsWorkspaceView();
  const { invalidateTypingRead, isTypingReadCurrent } = workspace;
  const region = useRef<HTMLParagraphElement>(null);
  const [actors, setActors] = useState<{
    client: typeof client;
    conversationId: string;
    ids: string[];
  }>();
  const members = workspace.members[conversationId];
  const memberIds = members
    ?.map((member) => member.user_id)
    .sort()
    .join(",");
  useLayoutEffect(() => {
    setActors(undefined);
    if (
      !enabled ||
      !client ||
      !scope ||
      scope.signal.aborted ||
      workspace.client !== client ||
      !memberIds
    )
      return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const allowed = new Set(memberIds.split(","));
    const publish = () =>
      setActors({ client, conversationId, ids: [...timers.keys()] });
    const clear = () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      publish();
    };
    const visible = () =>
      document.visibilityState === "visible" &&
      !!region.current?.getClientRects().length &&
      getComputedStyle(region.current).visibility === "visible";
    const visibility = () => {
      if (!visible()) clear();
    };
    const stop = client.events.subscribe({
      on_event(event) {
        if (
          event.event === "grants" ||
          event.event === "structure" ||
          (event.event === "membership" &&
            event.payload.conversation_id === conversationId)
        ) {
          invalidateTypingRead();
          clear();
          return;
        }
        if (
          event.event !== "typing" ||
          !isTypingReadCurrent() ||
          !visible() ||
          scope.isRefused("bootstrap") ||
          scope.isRefused(conversationId) ||
          event.payload.conversation_id !== conversationId ||
          event.topic !==
            `org:${client.context.org_id}:conversation:${conversationId}` ||
          event.payload.user_id === client.context.user_id ||
          !allowed.has(event.payload.user_id)
        )
          return;
        const id = event.payload.user_id;
        clearTimeout(timers.get(id));
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id);
            publish();
          }, 15_000),
        );
        publish();
      },
      on_connection(state) {
        if (state.state !== "live") clear();
      },
      on_error() {
        clear();
      },
    });
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", visibility);
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [
    client,
    scope,
    enabled,
    conversationId,
    workspace.client,
    memberIds,
    invalidateTypingRead,
    isTypingReadCurrent,
  ]);
  const names =
    enabled &&
    actors?.client === client &&
    actors.conversationId === conversationId
      ? actors.ids.flatMap(
          (id) =>
            members?.find((member) => member.user_id === id)?.display_name ??
            [],
        )
      : [];
  return (
    <p
      ref={region}
      role="status"
      aria-label="Typing activity"
      aria-live="polite"
      aria-atomic="true"
      className="text-muted-foreground min-h-5 shrink-0 px-3 text-xs"
    >
      {names.length > 0 && (
        <>
          <bdi>{names.join(", ")}</bdi>
          {names.length === 1 ? " is typing" : " are typing"}
          <span
            aria-hidden="true"
            aria-label="Typing dots"
            className="ml-1 inline-block animate-pulse motion-reduce:animate-none"
          >
            …
          </span>
        </>
      )}
    </p>
  );
}
