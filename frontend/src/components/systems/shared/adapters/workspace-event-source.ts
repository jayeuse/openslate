import { apiRequest } from "@/lib/api";
import type { WorkspaceInvalidation } from "./invalidation-events";

export type ConnectionFailure = {
  kind: "network" | "authentication" | "limit";
  retryAfter?: number;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const boards = new Set([
  "boards",
  "board_posts",
  "board_events",
  "board_calendar_sources",
]);

export function parseWorkspaceInvalidation(
  type: string,
  data: string,
): WorkspaceInvalidation | null {
  if (type === "resync") return { type };
  if (type !== "invalidate") return null;
  try {
    const value: unknown = JSON.parse(data);
    if (
      !value ||
      typeof value !== "object" ||
      !("entity" in value) ||
      typeof value.entity !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(value.entity)
    )
      return null;
    if (boards.has(value.entity)) {
      if (
        Object.keys(value).some(
          (key) => key !== "entity" && key !== "board_id",
        ) ||
        !("board_id" in value) ||
        typeof value.board_id !== "string" ||
        !uuid.test(value.board_id)
      )
        return null;
      return {
        type: "invalidate",
        entity: value.entity,
        boardId: value.board_id.toLowerCase(),
      };
    }
    if ("board_id" in value) return null;
    if (!("module_id" in value) || value.module_id === undefined)
      return { type: "invalidate", entity: value.entity };
    return typeof value.module_id === "string" && uuid.test(value.module_id)
      ? { type: "invalidate", entity: value.entity, moduleId: value.module_id }
      : null;
  } catch {
    return null;
  }
}

export function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return;
  const seconds = /^\d+$/.test(value.trim())
    ? Number(value)
    : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : undefined;
}

/** One readable fetch stream, so status handling never requires a second probe. */
export function openWorkspaceEventStream(
  org: string,
  receive: (event: WorkspaceInvalidation) => void,
  failed: (failure: ConnectionFailure) => void,
) {
  const controller = new AbortController();
  const done = (async () => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await apiRequest(
        `/events?org=${encodeURIComponent(org)}`,
        {
          headers: { "X-Org": org, Accept: "text/event-stream" },
          cache: "no-store",
          signal: controller.signal,
          refreshOnUnauthorized: false,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        if (!controller.signal.aborted)
          failed({
            kind:
              response.status === 429
                ? "limit"
                : [401, 403].includes(response.status)
                  ? "authentication"
                  : "network",
            retryAfter: retryAfterSeconds(response.headers.get("Retry-After")),
          });
        return;
      }
      if (
        !response.headers
          .get("Content-Type")
          ?.toLowerCase()
          .startsWith("text/event-stream") ||
        !response.body
      )
        throw new Error("Invalid event stream");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "",
        event = "message",
        data: string[] = [],
        eventSize = 0;
      while (!controller.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Event stream ended");
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          eventSize += line.length;
          if (eventSize > 65536)
            throw new Error("Event stream frame exceeded its bound");
          if (!line) {
            const parsed = parseWorkspaceInvalidation(event, data.join("\n"));
            if (parsed && !controller.signal.aborted) receive(parsed);
            event = "message";
            data = [];
            eventSize = 0;
          } else if (line.startsWith("event:"))
            event = line.slice(6).trimStart();
          else if (line.startsWith("data:"))
            data.push(line.slice(5).replace(/^ /, ""));
        }
        if (buffer.length + eventSize > 65536)
          throw new Error("Event stream frame exceeded its bound");
      }
    } catch {
      if (!controller.signal.aborted) failed({ kind: "network" });
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  })();
  return {
    dispose: async () => {
      controller.abort();
      await done;
    },
  };
}
