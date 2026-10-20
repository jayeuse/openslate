import { expect, test } from "@playwright/test";
import { ApiContractError } from "../../../src/lib/api";
import { installFetch } from "../helpers/fake-fetch";
import { createCommsRealtime } from "../../../src/components/systems/comms/adapters/realtime-client";
import type {
  CommsEvent,
  ConnectionState,
  RuntimeFailure,
} from "../../../src/components/systems/comms/contract/types";

const user = "82000000-0000-4000-8000-000000000001";
const org = "82000000-0000-4000-8000-000000000002";
const room = "82000000-0000-4000-8000-000000000003";
const other = "82000000-0000-4000-8000-000000000004";
const context = { user_id: user, org_id: org };
const prefix = `org:${org}:`;
type Frame = {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  ref: string;
  join_ref?: string;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function token(name = "fixture-realtime-token", conversation = room) {
  return {
    access_token: name,
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    topic_prefix: prefix,
    conversation_topics: [`${prefix}conversation:${conversation}`],
  };
}
function socketHarness() {
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 0;
    url: string;
    protocol = "";
    bufferedAmount = 0;
    binaryType = "arraybuffer";
    frames: Frame[] = [];
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor(address: string | URL) {
      super();
      this.url = String(address);
      sockets.push(this);
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        const event = new Event("open");
        this.onopen?.(event);
        this.dispatchEvent(event);
      });
    }
    send(value: string) {
      const frame = JSON.parse(value) as Frame;
      this.frames.push(frame);
      if (["phx_join", "phx_leave", "heartbeat"].includes(frame.event))
        queueMicrotask(() =>
          this.emit({
            ...frame,
            event: "phx_reply",
            payload: { status: "ok", response: {} },
          }),
        );
    }
    emit(frame: Frame) {
      const event = new MessageEvent("message", {
        data: JSON.stringify(frame),
      });
      this.onmessage?.(event);
      this.dispatchEvent(event);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      const event = Object.assign(new Event("close"), {
        code: 1000,
        reason: "",
        wasClean: true,
      }) as CloseEvent;
      this.onclose?.(event);
      this.dispatchEvent(event);
    }
  }
  const before = ["WebSocket", "location"].map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeSocket,
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL("http://127.0.0.1:3104/comms"),
  });
  return {
    sockets,
    restore() {
      for (const [name, descriptor] of before) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
function observer() {
  const events: CommsEvent[] = [],
    states: ConnectionState[] = [],
    errors: RuntimeFailure[] = [];
  let live = deferred<void>();
  return {
    events,
    states,
    errors,
    get live() {
      return live.promise;
    },
    nextLive() {
      live = deferred<void>();
    },
    value: {
      on_event: (event: CommsEvent) => events.push(event),
      on_connection: (state: ConnectionState) => {
        states.push(state);
        if (state.state === "live") live.resolve();
      },
      on_error: (error: RuntimeFailure) => errors.push(error),
    },
  };
}
function schedule() {
  const timers: { callback: () => void; delay: number; cancelled: boolean }[] =
    [];
  return {
    timers,
    value(callback: () => void, delay: number) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
}
const response = (body: unknown) =>
  Response.json(body, { headers: { "Cache-Control": "no-store" } });

test("Realtime uses the header-injecting same-origin path, private authoritative topics and receive-only frames", async () => {
  const harness = socketHarness(),
    seen = observer(),
    clock = schedule();
  const fetch = installFetch(() => response(token()));
  const connection = createCommsRealtime(context, seen.value, clock.value);
  try {
    await connection.refresh();
    const socket = harness.sockets[0];
    expect(socket.url).toBe(
      "ws://127.0.0.1:3104/realtime/v1/websocket?vsn=1.0.0",
    );
    await seen.live;
    const joins = socket.frames.filter((frame) => frame.event === "phx_join");
    expect(joins.map((frame) => frame.topic).sort()).toEqual(
      [
        `realtime:${prefix}conversation:${room}`,
        `realtime:${prefix}presence`,
        `realtime:${prefix}user:${user}`,
      ].sort(),
    );
    for (const join of joins)
      expect(join.payload).toMatchObject({
        config: { private: true, presence: { enabled: false } },
        access_token: "fixture-realtime-token",
      });
    expect(
      fetch.requests.map((entry) => ({
        path: String(entry.input),
        method: entry.init?.method,
        org: new Headers(entry.init?.headers).get("X-Org"),
        body: entry.init?.body,
      })),
    ).toEqual([
      { path: "/api/realtime/token", method: "POST", org, body: undefined },
    ]);
    const message = {
      topic: `${prefix}conversation:${room}`,
      private: true as const,
      event: "message" as const,
      payload: { conversation_id: room, seq: 1, kind: "created" as const },
    };
    socket.emit({
      topic: `realtime:${message.topic}`,
      event: "broadcast",
      ref: "server1",
      payload: {
        type: "broadcast",
        event: "message",
        payload: { ...message.payload, id: other },
      },
    });
    expect(seen.events).toEqual([message]);
    socket.emit({
      topic: `realtime:${prefix}user:${user}`,
      event: "broadcast",
      ref: "server2",
      payload: {
        type: "broadcast",
        event: "notification",
        payload: { id: other },
      },
    });
    expect(seen.events.at(-1)).toEqual({
      topic: `${prefix}user:${user}`,
      private: true,
      event: "notification",
      payload: { id: other },
    });
    for (const payload of [
      { ...message.payload, body: "Content must not be accepted" },
      { ...message.payload, conversation_id: other },
    ])
      socket.emit({
        topic: `realtime:${message.topic}`,
        event: "broadcast",
        ref: "bad",
        payload: { type: "broadcast", event: "message", payload },
      });
    expect(seen.events).toHaveLength(2);
    expect(seen.errors).toEqual([
      { kind: "invalid_response" },
      { kind: "invalid_response" },
    ]);
    expect(
      socket.frames.filter((frame) =>
        ["broadcast", "presence"].includes(frame.event),
      ),
    ).toEqual([]);
  } finally {
    connection.dispose();
    fetch.restore();
    harness.restore();
  }
});

test("Realtime refresh rotates after four minutes and retired callbacks cannot publish", async () => {
  const harness = socketHarness(),
    seen = observer(),
    clock = schedule();
  let count = 0;
  const fetch = installFetch(() =>
    response(count++ === 0 ? token("fixture-a") : token("fixture-b", other)),
  );
  const connection = createCommsRealtime(context, seen.value, clock.value);
  try {
    await connection.refresh();
    await seen.live;
    expect(clock.timers[0].delay).toBe(240_000);
    const old = harness.sockets[0];
    seen.nextLive();
    clock.timers[0].callback();
    await seen.live;
    expect(old.readyState).toBe(old.CLOSED);
    expect(
      harness.sockets[1].frames
        .filter((frame) => frame.event === "phx_join")
        .map((frame) => frame.topic),
    ).toContain(`realtime:${prefix}conversation:${other}`);
    old.emit({
      topic: `realtime:${prefix}conversation:${room}`,
      event: "broadcast",
      ref: "late",
      payload: {
        type: "broadcast",
        event: "message",
        payload: { conversation_id: room, seq: 1, kind: "created" },
      },
    });
    expect(seen.events).toEqual([]);
    connection.dispose();
    expect(clock.timers.every((timer) => timer.cancelled)).toBe(true);
    clock.timers[1].callback();
    expect(fetch.requests).toHaveLength(2);
  } finally {
    connection.dispose();
    fetch.restore();
    harness.restore();
  }
});

test("Realtime disposal aborts delayed token issuance before any join", async () => {
  const harness = socketHarness(),
    seen = observer(),
    clock = schedule();
  const entered = deferred<void>(),
    held = deferred<Response>();
  const fetch = installFetch(() => {
    entered.resolve();
    return held.promise;
  });
  const connection = createCommsRealtime(context, seen.value, clock.value);
  try {
    const loading = connection.refresh();
    await entered.promise;
    connection.dispose();
    held.resolve(response(token()));
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.sockets).toHaveLength(0);
    expect(seen.states).toEqual([{ state: "connecting" }]);
  } finally {
    connection.dispose();
    fetch.restore();
    harness.restore();
  }
});

test("Realtime disposal during transport retirement cannot start another token request", async () => {
  const harness = socketHarness(),
    seen = observer(),
    clock = schedule();
  const fetch = installFetch(() => response(token()));
  const connection = createCommsRealtime(context, seen.value, clock.value);
  try {
    const loading = connection.refresh();
    await connection.dispose();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch.requests).toHaveLength(0);
    expect(harness.sockets).toHaveLength(0);
  } finally {
    await connection.dispose();
    fetch.restore();
    harness.restore();
  }
});

test("Realtime rejects foreign duplicate expired or content-bearing token responses before joining", async () => {
  const harness = socketHarness(),
    seen = observer(),
    clock = schedule();
  try {
    const good = token();
    for (const bad of [
      { ...good, topic_prefix: `org:${other}:` },
      {
        ...good,
        conversation_topics: [
          `${prefix}conversation:${room}`,
          `${prefix}conversation:${room}`,
        ],
      },
      { ...good, expires_at: "2020-01-01T00:00:00Z" },
      { ...good, messages: ["not allowed"] },
    ]) {
      const fetch = installFetch(() => response(bad));
      const connection = createCommsRealtime(context, seen.value, clock.value);
      try {
        await expect(connection.refresh()).rejects.toBeInstanceOf(
          ApiContractError,
        );
      } finally {
        connection.dispose();
        fetch.restore();
      }
    }
    expect(harness.sockets).toHaveLength(0);
  } finally {
    harness.restore();
  }
});

test("Realtime token admission failures pause for auth or limit without a fabricated connection", async () => {
  const harness = socketHarness();
  try {
    for (const [status, reason] of [
      [403, "authentication"],
      [429, "limit"],
    ] as const) {
      const seen = observer(),
        clock = schedule();
      const fetch = installFetch(() =>
        Response.json(
          { detail: "Unavailable" },
          {
            status,
            headers: { "Cache-Control": "no-store", "Retry-After": "30" },
          },
        ),
      );
      const connection = createCommsRealtime(context, seen.value, clock.value);
      try {
        await expect(connection.refresh()).rejects.toMatchObject({ status });
        expect(seen.states.at(-1)).toEqual({ state: "paused", reason });
      } finally {
        connection.dispose();
        fetch.restore();
      }
    }
    expect(harness.sockets).toHaveLength(0);
  } finally {
    harness.restore();
  }
});
