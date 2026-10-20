"use client";
import { z } from "zod";
import { refreshBrowserSession } from "@/lib/api";
import { getAuthMe, requestSessionRecheck } from "@/lib/auth-api";
import { currentOrganizationId } from "@/lib/organization-context";
import {
  commsContextSchema,
  connectionStateSchema,
  realtimeEventSchemaFor,
} from "../../comms/contract/schemas";
import {
  heartbeatPresenceResponseSchemaFor,
  type HttpHeartbeatResponse,
} from "../../comms/adapters/presence-contract";
import type {
  CommsContext,
  ConnectionState,
  EventObserver,
} from "../../comms/contract/types";
import type { WorkspaceInvalidation } from "./invalidation-events";
import {
  openWorkspaceEventStream,
  parseWorkspaceInvalidation,
  type ConnectionFailure,
} from "./workspace-event-source";

type SseListener = {
  event: (event: WorkspaceInvalidation) => void;
  connected?: () => void;
  admitted: boolean;
};
type RealtimeListener = {
  observer: EventObserver;
  heartbeat: (value: HttpHeartbeatResponse) => void;
};
type Slot = {
  state: ConnectionState;
  stop?: () => Promise<unknown> | void;
  retry?: ReturnType<typeof setTimeout>;
  stable?: ReturnType<typeof setTimeout>;
  failures: number;
  serial: number;
  failed: boolean;
  authRetried: boolean;
  opening: boolean;
  closing: Promise<unknown>;
};
type Ownership = { isLeader: boolean; mode: "shared" | "per-tab" };
const stateSchema = z.strictObject({
  sse: connectionStateSchema,
  realtime: connectionStateSchema,
});
const envelope = z.strictObject({
  version: z.literal(1),
  user: z.uuid(),
  org: z.uuid(),
  from: z.uuid(),
  type: z.enum([
    "hello",
    "leader",
    "state",
    "sse",
    "realtime",
    "heartbeat",
    "interest",
    "activity",
    "leave",
  ]),
  epoch: z.string(),
  request: z.string().optional(),
  to: z.string().optional(),
  payload: z.unknown().optional(),
});
const activitySchema = z.strictObject({
  at: z.number().finite().nonnegative(),
  visible: z.boolean(),
});
const interestSchema = z.strictObject({
  sse: z.boolean(),
  realtime: z.boolean(),
});
const slot = (): Slot => ({
  state: { state: "connecting" },
  failures: 0,
  serial: 0,
  failed: false,
  authRetried: false,
  opening: false,
  closing: Promise.resolve(),
});
let current: ReturnType<typeof createSet> | null = null;
function nonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const text = [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

function createSet(context: CommsContext) {
  const key = `openslate-connections:v1:${context.user_id}:${context.org_id}`;
  const locks =
    typeof navigator.locks?.request === "function" ? navigator.locks : null;
  const mode = locks ? ("shared" as const) : ("per-tab" as const);
  const bus = locks ? new BroadcastChannel(key) : null;
  const tab = nonce();
  const sse = slot(),
    realtime = slot();
  const sseListeners = new Set<SseListener>(),
    realtimeListeners = new Set<RealtimeListener>();
  const ownershipListeners = new Set<(state: Ownership) => void>();
  const peers = new Map<string, z.infer<typeof interestSchema>>();
  const events = realtimeEventSchemaFor(context),
    heartbeatSchema = heartbeatPresenceResponseSchemaFor(context);
  let alive = true,
    paused = true,
    leader = false,
    requesting = false;
  let epoch = "",
    remoteEpoch = "",
    hello = "";
  let leaseAbort: AbortController | undefined,
    release: (() => void) | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatAbort: AbortController | undefined;
  let lastInput = Date.now(),
    lastVisible = Date.now();
  let localSse: ConnectionState = { state: "connecting" },
    localRealtime: ConnectionState = { state: "connecting" };
  const active = () =>
    alive && !paused && currentOrganizationId() === context.org_id;
  const owned = () => active() && leader;
  const wanted = () =>
    realtimeListeners.size > 0 ||
    [...peers.values()].some((peer) => peer.realtime);
  const sseWanted = () =>
    sseListeners.size > 0 || [...peers.values()].some((peer) => peer.sse);
  const interest = () =>
    post("interest", {
      sse: sseListeners.size > 0,
      realtime: realtimeListeners.size > 0,
    });
  function post(
    type: z.infer<typeof envelope>["type"],
    payload?: unknown,
    extra: { to?: string; request?: string } = {},
  ) {
    if (alive)
      bus?.postMessage({
        version: 1,
        user: context.user_id,
        org: context.org_id,
        from: tab,
        type,
        epoch,
        ...extra,
        ...(payload === undefined ? {} : { payload }),
      });
  }
  function ownership() {
    for (const listener of ownershipListeners)
      listener({ isLeader: owned(), mode });
  }
  function combined(): ConnectionState {
    const values = [localSse, localRealtime];
    return (
      values.find((state) => state.state === "paused") ??
      values.find((state) => state.state === "reconnecting") ??
      (values.every((state) => state.state === "live")
        ? { state: "live" }
        : { state: "connecting" })
    );
  }
  function states(next: { sse: ConnectionState; realtime: ConnectionState }) {
    if (!active()) return;
    const previous = localSse;
    localSse = next.sse;
    localRealtime = next.realtime;
    if (previous.state !== localSse.state) {
      for (const listener of sseListeners) {
        if (localSse.state === "live" && !listener.admitted) {
          listener.admitted = true;
          listener.connected?.();
        } else if (
          localSse.state === "live" ||
          ["paused", "reconnecting", "offline"].includes(localSse.state)
        )
          listener.event({ type: "resync" });
      }
    }
    for (const listener of realtimeListeners)
      listener.observer.on_connection(combined());
  }
  function publish() {
    const value = { sse: sse.state, realtime: realtime.state };
    states(value);
    post("state", value);
  }
  function live(part: Slot) {
    if (part.state.state !== "live") {
      clearTimeout(part.stable);
      part.stable = setTimeout(() => {
        if (owned() && part.state.state === "live") {
          part.failures = 0;
          part.authRetried = false;
        }
      }, 60_000);
    }
    part.state = { state: "live" };
    publish();
  }
  async function stop(part: Slot) {
    part.serial += 1;
    clearTimeout(part.retry);
    clearTimeout(part.stable);
    part.retry = undefined;
    part.opening = false;
    const dispose = part.stop;
    part.stop = undefined;
    part.closing = Promise.all([part.closing, dispose?.()]);
    await part.closing;
  }
  function later(part: Slot, milliseconds: number, connect: () => void) {
    const until = Date.now() + milliseconds;
    const tick = () => {
      if (!owned()) return;
      const left = until - Date.now();
      if (left > 0) part.retry = setTimeout(tick, Math.min(left, 2147483647));
      else {
        part.retry = undefined;
        part.failed = false;
        connect();
      }
    };
    part.retry = setTimeout(tick, Math.min(milliseconds, 2147483647));
  }
  async function failure(
    part: Slot,
    reason: ConnectionFailure,
    connect: () => void,
  ) {
    if (!owned() || part.failed) return;
    part.failed = true;
    part.failures += 1;
    const attemptEpoch = epoch;
    // Publish loss immediately; awaiting a close handshake must not report Live.
    const delay =
      reason.kind === "limit"
        ? (reason.retryAfter ?? 60) * 1000
        : Math.max(
            1000,
            Math.floor(
              Math.random() *
                Math.min(60_000, 1000 * 2 ** Math.min(part.failures - 1, 6)),
            ),
          );
    part.state =
      reason.kind === "authentication"
        ? { state: "paused", reason: "authentication" }
        : reason.kind === "limit"
          ? { state: "paused", reason: "limit" }
          : {
              state: "reconnecting",
              retry_after_seconds: Math.ceil(delay / 1000),
            };
    publish();
    await stop(part);
    if (!owned() || epoch !== attemptEpoch) return;
    if (reason.kind === "authentication") {
      if (part.authRetried) return;
      part.authRetried = true;
      const result = await refreshBrowserSession();
      if (!owned() || epoch !== attemptEpoch) return;
      if (result !== "current" && result !== "refreshed") {
        if (result === "rejected") requestSessionRecheck();
        return;
      }
      try {
        const account = await getAuthMe(leaseAbort?.signal);
        if (!owned() || epoch !== attemptEpoch) return;
        if (
          account.id !== context.user_id ||
          account.currentOrganization?.orgId !== context.org_id
        ) {
          requestSessionRecheck();
          return;
        }
        connect();
      } catch {
        /* A fresh verified admission or explicit refresh may try again. */
      }
      return;
    }
    later(part, delay, connect);
  }
  async function connectSse() {
    if (!owned() || !sseWanted()) return;
    sse.opening = true;
    sse.failed = false;
    const serial = ++sse.serial;
    const valid = () => owned() && sseWanted() && sse.serial === serial;
    sse.state = sse.failures
      ? { state: "reconnecting", retry_after_seconds: 1 }
      : { state: "connecting" };
    publish();
    await sse.closing;
    if (!valid()) return;
    const stream = openWorkspaceEventStream(
      context.org_id,
      (event) => {
        if (!valid()) return;
        if (event.type === "resync" && sse.state.state !== "live") live(sse);
        else {
          for (const listener of sseListeners) listener.event(event);
          post("sse", event);
        }
      },
      (reason) => {
        if (valid()) void failure(sse, reason, connectSse);
      },
    );
    sse.stop = stream.dispose;
    sse.opening = false;
  }
  async function connectRealtime() {
    if (!owned() || !wanted()) return;
    realtime.opening = true;
    realtime.failed = false;
    const serial = ++realtime.serial;
    const valid = () => owned() && wanted() && realtime.serial === serial;
    realtime.state = realtime.failures
      ? { state: "reconnecting", retry_after_seconds: 1 }
      : { state: "connecting" };
    publish();
    try {
      await realtime.closing;
      if (!valid()) return;
      const { createCommsRealtime } =
        await import("../../comms/adapters/realtime-client");
      if (!valid()) return;
      const stream = createCommsRealtime(
        context,
        {
          on_event(event) {
            if (valid()) {
              for (const listener of realtimeListeners)
                listener.observer.on_event(event);
              post("realtime", event);
            }
          },
          on_connection(state) {
            if (!valid()) return;
            if (state.state === "live") live(realtime);
            else {
              realtime.state =
                state.state === "connecting" && realtime.failures > 0
                  ? { state: "reconnecting", retry_after_seconds: 1 }
                  : state;
              publish();
            }
          },
          on_error(error) {
            if (valid())
              for (const listener of realtimeListeners)
                listener.observer.on_error(error);
          },
        },
        undefined,
        (reason) => {
          if (valid())
            void failure(realtime, reason, () => {
              void connectRealtime();
            });
        },
      );
      realtime.stop = stream.dispose;
      realtime.opening = false;
      await stream.refresh().catch(() => {});
    } catch {
      if (valid())
        void failure(realtime, { kind: "network" }, () => {
          void connectRealtime();
        });
    }
  }
  async function heartbeat() {
    if (!owned() || !wanted() || heartbeatAbort) return;
    post("activity", {
      at: lastInput,
      visible: document.visibilityState === "visible",
    });
    const controller = new AbortController();
    heartbeatAbort = controller;
    const ticket = epoch;
    try {
      const { heartbeatPresence } =
        await import("../../comms/adapters/presence-api");
      if (!owned() || epoch !== ticket || controller.signal.aborted) return;
      if (document.visibilityState === "visible") lastVisible = Date.now();
      const away =
        Date.now() - lastInput >= 600_000 ||
        Date.now() - lastVisible >= 600_000;
      // Unknown baselines deliberately repair every follower: a leader's fetched
      // cursor is not evidence that a follower received the same messages.
      const receipt = await heartbeatPresence(
        context,
        { state: away ? "away" : "online", known_sequences: [] },
        { signal: controller.signal },
      );
      if (!owned() || epoch !== ticket || controller.signal.aborted) return;
      for (const listener of realtimeListeners) listener.heartbeat(receipt);
      post("heartbeat", receipt);
    } catch {
      /* The next leader heartbeat retries; no history cursor advances. */
    } finally {
      if (heartbeatAbort === controller) heartbeatAbort = undefined;
    }
  }
  function desired() {
    if (!owned()) return;
    if (sseWanted()) {
      if (!sse.stop && !sse.opening && !sse.retry && !sse.failed)
        void connectSse();
    } else if (sse.stop || sse.opening) {
      void stop(sse);
      sse.state = { state: "connecting" };
      publish();
    }
    if (wanted()) {
      if (
        !realtime.stop &&
        !realtime.opening &&
        !realtime.retry &&
        !realtime.failed
      )
        void connectRealtime();
      if (!heartbeatTimer) {
        void heartbeat();
        heartbeatTimer = setInterval(() => {
          void heartbeat();
        }, 60_000);
      }
    } else {
      if (realtime.stop || realtime.opening) {
        void stop(realtime);
        realtime.failed = false;
        realtime.state = { state: "connecting" };
      }
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      heartbeatAbort?.abort();
      heartbeatAbort = undefined;
    }
  }
  function helloLeader() {
    hello = nonce();
    post("hello", undefined, { request: hello });
    interest();
  }
  if (bus)
    bus.onmessage = ({ data }) => {
      const checked = envelope.safeParse(data);
      if (!active() || !checked.success) return;
      const message = checked.data;
      if (
        message.user !== context.user_id ||
        message.org !== context.org_id ||
        message.from === tab
      )
        return;
      if (message.type === "hello" && owned()) {
        post(
          "state",
          { sse: sse.state, realtime: realtime.state },
          { to: message.from, request: message.request },
        );
        return;
      }
      if (message.type === "leader" && !leader) {
        remoteEpoch = "";
        helloLeader();
        return;
      }
      if (message.type === "interest" && owned()) {
        const value = interestSchema.safeParse(message.payload);
        if (!value.success) return;
        if (value.data.sse || value.data.realtime)
          peers.set(message.from, value.data);
        else peers.delete(message.from);
        desired();
        return;
      }
      if (message.type === "leave" && owned()) {
        peers.delete(message.from);
        desired();
        return;
      }
      if (message.type === "activity") {
        const activity = activitySchema.safeParse(message.payload);
        if (activity.success) {
          lastInput = Math.max(
            lastInput,
            Math.min(Date.now(), activity.data.at),
          );
          if (activity.data.visible) lastVisible = Date.now();
        }
        if (!leader && message.epoch === remoteEpoch)
          post("activity", {
            at: lastInput,
            visible: document.visibilityState === "visible",
          });
        return;
      }
      if (leader) return;
      if (message.type === "state") {
        if (message.to === tab && message.request === hello)
          remoteEpoch = message.epoch;
        else if (message.to || message.epoch !== remoteEpoch || !remoteEpoch)
          return;
        const value = stateSchema.safeParse(message.payload);
        if (value.success) states(value.data);
      } else if (remoteEpoch && message.epoch === remoteEpoch) {
        if (message.type === "realtime") {
          const event = events.safeParse(message.payload);
          if (event.success)
            for (const listener of realtimeListeners)
              listener.observer.on_event(event.data);
        }
        if (message.type === "heartbeat") {
          const receipt = heartbeatSchema.safeParse(message.payload);
          if (receipt.success)
            for (const listener of realtimeListeners)
              listener.heartbeat(receipt.data);
        }
        if (message.type === "sse") {
          const raw = message.payload;
          if (!raw || typeof raw !== "object" || !("type" in raw)) return;
          const normalized = raw as WorkspaceInvalidation;
          const event =
            normalized.type === "resync"
              ? { type: "resync" as const }
              : parseWorkspaceInvalidation(
                  "invalidate",
                  JSON.stringify({
                    entity: normalized.entity,
                    ...(normalized.moduleId
                      ? { module_id: normalized.moduleId }
                      : {}),
                    ...(normalized.boardId
                      ? { board_id: normalized.boardId }
                      : {}),
                  }),
                );
          if (event) for (const listener of sseListeners) listener.event(event);
        }
      }
    };
  async function ownLease() {
    if (!active()) return;
    leader = true;
    epoch = nonce();
    remoteEpoch = "";
    peers.clear();
    ownership();
    post("leader");
    sse.authRetried = realtime.authRetried = false;
    sse.failed = realtime.failed = false;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    desired();
    await released;
    leader = false;
    ownership();
    heartbeatAbort?.abort();
    heartbeatAbort = undefined;
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    await Promise.all([stop(sse), stop(realtime)]);
    release = undefined;
  }
  function acquire() {
    if (!active() || requesting) return;
    requesting = true;
    leaseAbort = new AbortController();
    const pending = locks
      ? locks.request(
          key,
          { mode: "exclusive", signal: leaseAbort.signal },
          ownLease,
        )
      : ownLease();
    let refused = false;
    void pending
      .catch((error: unknown) => {
        if (
          active() &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          refused = true;
          sse.state = realtime.state = { state: "offline" };
          publish();
        }
      })
      .finally(() => {
        requesting = false;
        if (active() && !refused) acquire();
      });
    helloLeader();
  }
  const activity = (event?: Event) => {
    if (!active() || (event && !event.isTrusted)) return;
    lastInput = Date.now();
    if (document.visibilityState === "visible") lastVisible = Date.now();
    post("activity", {
      at: lastInput,
      visible: document.visibilityState === "visible",
    });
  };
  const visibility = () => {
    if (!active()) return;
    if (document.visibilityState === "visible") {
      lastVisible = Date.now();
      helloLeader();
    }
    post("activity", {
      at: lastInput,
      visible: document.visibilityState === "visible",
    });
  };
  for (const name of ["pointerdown", "keydown", "input", "wheel", "touchstart"])
    document.addEventListener(name, activity, { passive: true });
  document.addEventListener("visibilitychange", visibility);
  const dispose = () => {
    if (!alive) return;
    post("leave");
    alive = false;
    paused = true;
    ownership();
    leaseAbort?.abort();
    release?.();
    bus?.close();
    for (const name of [
      "pointerdown",
      "keydown",
      "input",
      "wheel",
      "touchstart",
    ])
      document.removeEventListener(name, activity);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", dispose);
    sseListeners.clear();
    realtimeListeners.clear();
    ownershipListeners.clear();
  };
  window.addEventListener("pagehide", dispose);
  return {
    context,
    dispose,
    pause(value: boolean) {
      if (paused === value || !alive) return;
      paused = value;
      ownership();
      if (paused) {
        post("interest", { sse: false, realtime: false });
        leaseAbort?.abort();
        release?.();
      } else {
        localSse = { state: "connecting" };
        localRealtime = { state: "connecting" };
        acquire();
      }
    },
    available: () => active() && localSse.state === "live",
    ownership: () => ({ isLeader: owned(), mode }),
    subscribeOwnership(listener: (state: Ownership) => void) {
      ownershipListeners.add(listener);
      listener({ isLeader: owned(), mode });
      return () => {
        ownershipListeners.delete(listener);
      };
    },
    subscribeSse(event: SseListener["event"], connected?: () => void) {
      const listener = { event, connected, admitted: false };
      sseListeners.add(listener);
      interest();
      desired();
      if (active() && localSse.state === "live")
        queueMicrotask(() => {
          if (active() && sseListeners.has(listener)) {
            listener.admitted = true;
            connected?.();
          }
        });
      return () => {
        sseListeners.delete(listener);
        interest();
        desired();
      };
    },
    subscribeRealtime(
      observer: EventObserver,
      receiveHeartbeat: RealtimeListener["heartbeat"],
    ) {
      const listener = { observer, heartbeat: receiveHeartbeat };
      realtimeListeners.add(listener);
      observer.on_connection(combined());
      interest();
      desired();
      return () => {
        realtimeListeners.delete(listener);
        interest();
        desired();
      };
    },
  };
}

export function bindWorkspaceConnections(
  user: string | null,
  org: string | null,
) {
  current?.dispose();
  current = null;
  if (!user || !org) return () => {};
  const scope = createSet(
    commsContextSchema.parse({ user_id: user, org_id: org }),
  );
  current = scope;
  return () => {
    scope.dispose();
    if (current === scope) current = null;
  };
}
export function pauseWorkspaceConnections(paused: boolean) {
  current?.pause(paused);
}
export function subscribeSharedInvalidations(
  event: SseListener["event"],
  connected?: () => void,
) {
  return current?.subscribeSse(event, connected) ?? (() => {});
}
export function workspaceConnectionAvailable() {
  return current?.available() ?? false;
}
export function subscribeSharedRealtime(
  context: CommsContext,
  observer: EventObserver,
  heartbeat: RealtimeListener["heartbeat"],
) {
  if (
    !current ||
    current.context.user_id !== context.user_id ||
    current.context.org_id !== context.org_id
  )
    throw new Error("Connection identity is not admitted");
  return current.subscribeRealtime(observer, heartbeat);
}
/** Ownership only; S29 still owns desktop/sound emission and server permissions. */
export function subscribeWorkspaceConnectionOwnership(
  context: CommsContext,
  listener: (state: Ownership) => void,
) {
  if (
    !current ||
    current.context.user_id !== context.user_id ||
    current.context.org_id !== context.org_id
  ) {
    listener({ isLeader: false, mode: "shared" });
    return () => {};
  }
  return current.subscribeOwnership(listener);
}
