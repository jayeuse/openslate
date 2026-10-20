import { RealtimeClient } from "@supabase/realtime-js";
import { z } from "zod";
import { ApiContractError, ApiError, apiFetchWithMetadata } from "@/lib/api";
import {
  commsContextSchema,
  realtimeEventSchemaFor,
} from "../contract/schemas";
import type { CommsContext, EventObserver } from "../contract/types";
import type { ConnectionFailure } from "../../shared/adapters/workspace-event-source";

const scheduleRefresh = (callback: () => void, milliseconds: number) => {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
};
const broadcastEnvelope = z.strictObject({
  type: z.literal("broadcast"),
  event: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

/** Private receive-only transport; shared coordination owns managed retries. */
export function createCommsRealtime(
  input: CommsContext,
  observer: EventObserver,
  schedule: typeof scheduleRefresh = scheduleRefresh,
  onFailure?: (failure: ConnectionFailure) => void,
) {
  const context = Object.freeze(commsContextSchema.parse(input));
  const prefix = `org:${context.org_id}:`;
  const tokenSchema = z.strictObject({
    access_token: z.string().min(1),
    expires_at: z.iso
      .datetime({ offset: true })
      .refine((value) => Date.parse(value) > Date.now()),
    topic_prefix: z.literal(prefix),
    conversation_topics: z
      .array(z.string())
      .refine((topics) =>
        topics.every(
          (topic, index) =>
            topic.startsWith(`${prefix}conversation:`) &&
            z.uuid().safeParse(topic.slice(`${prefix}conversation:`.length))
              .success &&
            (index === 0 || topics[index - 1] < topic),
        ),
      ),
  });
  const eventSchema = realtimeEventSchemaFor(context);
  let disposed = false,
    generation = 0,
    started = false;
  let issuing: AbortController | undefined;
  let client: RealtimeClient | undefined;
  let cancelRefresh: (() => void) | undefined;
  let retiring: Promise<unknown> = Promise.resolve();
  function retire() {
    cancelRefresh?.();
    cancelRefresh = undefined;
    issuing?.abort();
    issuing = undefined;
    const previous = client;
    client = undefined;
    if (previous) {
      void previous.removeAllChannels().catch(() => {});
      retiring = Promise.all([retiring, previous.disconnect()]);
    }
    return retiring;
  }
  async function refresh() {
    if (disposed) throw new DOMException("Connection retired", "AbortError");
    const current = ++generation;
    await retire();
    if (disposed || current !== generation)
      throw new DOMException("Connection retired", "AbortError");
    const abort = new AbortController();
    issuing = abort;
    const active = () =>
      !disposed && current === generation && !abort.signal.aborted;
    observer.on_connection(
      started
        ? { state: "reconnecting", retry_after_seconds: 1 }
        : { state: "connecting" },
    );
    started = true;
    try {
      const result = await apiFetchWithMetadata(
        "/realtime/token",
        tokenSchema,
        {
          method: "POST",
          headers: { "X-Org": context.org_id },
          cache: "no-store",
          signal: abort.signal,
          ...(onFailure ? { refreshOnUnauthorized: false } : {}),
        },
      );
      abort.signal.throwIfAborted();
      if (!active()) throw new DOMException("Connection retired", "AbortError");
      if (
        result.response.status !== 200 ||
        !result.response.headers.get("Cache-Control")?.includes("no-store")
      )
        throw new ApiContractError();
      const endpoint = new URL("/realtime/v1", globalThis.location.href);
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      // SDK construction requires a nonempty key. This noncredential marker is
      // removed by its documented transport seam; only the gateway injects a key.
      class GatewaySocket extends WebSocket {
        constructor(address: string | URL, protocols?: string | string[]) {
          const target = new URL(address);
          if (
            target.origin !== endpoint.origin ||
            target.pathname !== "/realtime/v1/websocket" ||
            target.searchParams.get("apikey") !== "gateway-header"
          )
            throw new Error("Invalid Realtime transport target");
          target.searchParams.delete("apikey");
          if (
            [...target.searchParams.keys()].some((key) => key !== "vsn") ||
            target.searchParams.get("vsn") !== "1.0.0"
          )
            throw new Error("Invalid Realtime transport parameters");
          super(target, protocols);
        }
      }
      const socket = new RealtimeClient(endpoint.href, {
        transport: GatewaySocket,
        params: { apikey: "gateway-header" },
        vsn: "1.0.0",
      });
      client = socket;
      await socket.setAuth(result.data.access_token);
      if (!active()) throw new DOMException("Connection retired", "AbortError");
      const topics = [
        `${prefix}user:${context.user_id}`,
        `${prefix}presence`,
        ...result.data.conversation_topics,
      ];
      const joined = new Set<string>();
      for (const topic of topics) {
        socket
          .channel(topic, {
            config: {
              private: true,
              presence: { enabled: false },
              broadcast: { ack: false, self: false },
            },
          })
          .on("broadcast", { event: "*" }, (raw: unknown) => {
            if (!active()) return;
            const envelope = broadcastEnvelope.safeParse(raw);
            if (!envelope.success) {
              observer.on_error({ kind: "invalid_response" });
              return;
            }
            let payload = envelope.data.payload;
            // The provider may add its UUID id; notification.id is application data.
            if (envelope.data.event !== "notification" && "id" in payload) {
              const { id, ...rest } = payload;
              if (!z.uuid().safeParse(id).success) {
                observer.on_error({ kind: "invalid_response" });
                return;
              }
              payload = rest;
            }
            const event = eventSchema.safeParse({
              topic,
              private: true,
              event: envelope.data.event,
              payload,
            });
            if (event.success) observer.on_event(event.data);
            else observer.on_error({ kind: "invalid_response" });
          })
          .subscribe((status, error) => {
            if (!active()) return;
            if (status === "SUBSCRIBED") {
              joined.add(topic);
              if (joined.size === topics.length)
                observer.on_connection({ state: "live" });
            } else {
              joined.delete(topic);
              if (onFailure) {
                const message = error?.message ?? "";
                const kind =
                  /^(ChannelRateLimitReached|ConnectionRateLimitReached|ClientJoinRateLimitReached|JoinsRateLimitReached)\b/.test(
                    message,
                  )
                    ? "limit"
                    : /^(InvalidJWTToken|Unauthorized)\b/.test(message)
                      ? "authentication"
                      : "network";
                void retire();
                onFailure({ kind });
                return;
              }
              observer.on_connection({
                state: "reconnecting",
                retry_after_seconds: 1,
              });
            }
          });
      }
      cancelRefresh = schedule(() => {
        if (active()) void refresh().catch(() => {});
      }, 240_000);
    } catch (error) {
      if (!active()) throw new DOMException("Connection retired", "AbortError");
      retire();
      if (onFailure) {
        onFailure({
          kind:
            error instanceof ApiError && error.status === 429
              ? "limit"
              : error instanceof ApiError && [401, 403].includes(error.status)
                ? "authentication"
                : "network",
          ...(error instanceof ApiError && error.retryAfter !== undefined
            ? { retryAfter: error.retryAfter }
            : {}),
        });
        throw error;
      }
      if (error instanceof ApiError && [401, 403, 429].includes(error.status))
        observer.on_connection({
          state: "paused",
          reason: error.status === 429 ? "limit" : "authentication",
        });
      else {
        observer.on_connection({ state: "offline" });
        observer.on_error({
          kind:
            error instanceof ApiContractError ? "invalid_response" : "network",
        });
      }
      throw error;
    }
  }
  return {
    refresh,
    dispose() {
      if (disposed) return retiring;
      disposed = true;
      generation += 1;
      return retire();
    },
  };
}
