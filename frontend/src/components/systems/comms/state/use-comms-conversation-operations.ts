"use client";

import type { Dispatch, SetStateAction } from "react";
import type { Message, Thread } from "../domain/view-model";
import { messageFromCommsError, type useCommsCommands } from "./runtime";

export function createCommsConversationOperations({
  run,
  thread,
  select,
  setDirectError,
  setNotice,
  setDmOpen,
  setThreadId,
}: {
  run: ReturnType<typeof useCommsCommands>["run"];
  thread: Thread | undefined;
  select: (id: string) => void;
  setDirectError: (message: string) => void;
  setNotice: (message: string) => void;
  setDmOpen: Dispatch<SetStateAction<boolean>>;
  setThreadId: Dispatch<SetStateAction<string>>;
}) {
  async function startDirect(userId: string) {
    try {
      const result = await run(`direct:${userId}`, (client, signal) =>
        client.findOrCreateDirect({ recipient_id: userId }, { signal }),
      );
      setDirectError("");
      select(result.data.id);
      setDmOpen(false);
    } catch (error) {
      const message = messageFromCommsError(
        error,
        "The direct conversation could not be opened.",
      );
      setDirectError(message);
      setNotice(message);
    }
  }
  async function startThread(message: Message) {
    try {
      const result = await run(
        `thread:create:${message.id}`,
        (client, signal) =>
          client.createThread(message.conversation, message.id, { signal }),
      );
      setThreadId(result.data.id);
    } catch (error) {
      setNotice(
        messageFromCommsError(error, "The thread could not be opened."),
      );
    }
  }
  async function patchThread(
    patch: Partial<Pick<Thread, "resolved" | "subscribed">>,
  ): Promise<string | null> {
    try {
      if (!thread?.conversation) throw new Error("Thread is unavailable");
      await run(`thread:update:${thread.id}`, async (client, signal) => {
        if (patch.resolved !== undefined) {
          const current = await client.getThread(
            thread.conversation,
            thread.messageId,
            { signal },
          );
          await client.updateThread(
            thread.conversation,
            thread.messageId,
            { resolved: patch.resolved },
            { signal, if_match: current.etag },
          );
        }
        if (patch.subscribed !== undefined)
          await client.followThread(
            thread.conversation,
            thread.messageId,
            { followed: patch.subscribed },
            { signal },
          );
      });
      return null;
    } catch (error) {
      const message = messageFromCommsError(
        error,
        "The thread could not be updated.",
      );
      setNotice(message);
      return message;
    }
  }
  return { startDirect, startThread, patchThread };
}
