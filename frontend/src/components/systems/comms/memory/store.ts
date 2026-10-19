import { z } from "zod";
import {
  commsContextSchema,
  preconditionSchema,
  realtimeEventSchema,
  realtimeEventSchemaFor,
} from "../contract/schemas";
import type {
  CommsClientError,
  CommsContext,
  ConnectionState,
  EventObserver,
} from "../contract/types";
import { activePerson, policyFailure } from "../domain/access";
import {
  invalidMemoryState as invalidResponse,
  restoreMemorySnapshot,
  validateMemoryState,
} from "./snapshot";
import type {
  MemoryCommand,
  MemoryHandle,
  MemoryPublication,
  MemoryStore,
  MemoryStoreOptions,
} from "./store-types";
export type * from "./store-types";

const cancellation = () =>
  Object.assign(new Error("OpenComms operation cancelled"), {
    kind: "cancelled" as const,
  });
function cancelled(): never {
  throw cancellation();
}
const authentication = (): CommsClientError =>
  Object.assign(new Error("OpenComms authentication required"), {
    kind: "http" as const,
    failure: {
      status: 401 as const,
      body: { detail: "Authentication required" },
    },
  });
function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return invalidResponse();
  }
}
function serialized(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return invalidResponse();
  }
}
function synchronous<T>(value: T): T {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  ) {
    void Promise.resolve(value).catch(() => undefined);
    invalidResponse();
  }
  return value;
}
const publicationsSchema = z.array(
  z.strictObject({
    recipient_ids: z
      .array(z.uuid())
      .refine((ids) => new Set(ids).size === ids.length),
    event: realtimeEventSchema,
  }),
);
const outcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("commit"),
    value: z.unknown(),
    version_keys: z.array(z.string().min(1)),
    publications: publicationsSchema,
    failure_point: z.literal("send").optional(),
  }),
  z.strictObject({
    kind: z.literal("unchanged"),
    value: z.unknown(),
    version_keys: z.array(z.string().min(1)),
  }),
]);
function observe(callback: () => unknown) {
  try {
    void Promise.resolve(callback()).catch(() => undefined);
  } catch {
    /* Commit is already accepted. */
  }
}

/** One explicit local simulation owner. Never shared through an implicit cache. */
export function createMemoryStore(options: MemoryStoreOptions): MemoryStore {
  const owner = Object.freeze(commsContextSchema.parse(options.owner));
  let initial = validateMemoryState(options.initial, owner.org_id);
  activePerson(initial, owner);
  const restored = restoreMemorySnapshot(owner, initial, options.snapshot);
  let state = restored.state;
  const clock = options.clock ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  let incarnation = uuid();
  let disposed = false;
  let failNext = false;
  let failSend = false;
  let tail: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const handles = new Set<MemoryHandle>();
  const handleControls = new WeakMap<
    MemoryHandle,
    {
      setTokenExpired(expired: boolean): void;
      setConnectionDropped(dropped: boolean): void;
    }
  >();
  const subscribers = new Set<{
    context: CommsContext;
    observer: EventObserver;
    handle: MemoryHandle;
    canDeliver(): boolean;
    unsubscribe(): void;
  }>();
  const assertOpen = () => {
    if (disposed) cancelled();
  };
  const version = (key: string, source = state) =>
    `"${incarnation}:${encodeURIComponent(key)}:${source.resource_versions[key] ?? 0}"`;
  function notify(publications: readonly MemoryPublication[]) {
    const epoch = incarnation;
    const current = () => !disposed && epoch === incarnation;
    for (const listener of [...listeners]) {
      if (!current()) return;
      if (listeners.has(listener)) observe(listener);
    }
    for (const publication of publications) {
      for (const subscription of [...subscribers]) {
        if (!current()) return;
        const person = state.people[subscription.context.user_id];
        if (
          subscribers.has(subscription) &&
          subscription.canDeliver() &&
          person?.active &&
          person.org_id === owner.org_id &&
          publication.recipient_ids.includes(subscription.context.user_id)
        )
          observe(() =>
            subscription.observer.on_event(clone(publication.event)),
          );
      }
    }
  }
  const store: MemoryStore = {
    restoration: restored.restoration,
    bind(input) {
      assertOpen();
      const context = Object.freeze(commsContextSchema.parse(input));
      activePerson(state, context);
      const boundIncarnation = incarnation;
      let closed = false;
      const lifetime = new AbortController();
      let session = new AbortController();
      let dropped = false;
      let connectionRevision = 0;
      const assertCurrent = (requireSession = true) => {
        assertOpen();
        if (closed || boundIncarnation !== incarnation) cancelled();
        if (requireSession && session.signal.aborted) throw authentication();
        activePerson(state, context);
      };
      const connection = (): ConnectionState =>
        session.signal.aborted
          ? { state: "paused", reason: "authentication" }
          : { state: dropped ? "offline" : "live" };
      const publishConnection = (revision: number, expired = false) => {
        for (const subscription of [...subscribers]) {
          if (!handle.isCurrentFor(store) || revision !== connectionRevision)
            return;
          if (subscription.handle !== handle || !subscribers.has(subscription))
            continue;
          observe(() => subscription.observer.on_connection(connection()));
          if (
            expired &&
            revision === connectionRevision &&
            handle.isCurrentFor(store) &&
            subscribers.has(subscription)
          )
            observe(() => subscription.observer.on_error(authentication()));
        }
      };
      const handle: MemoryHandle = {
        context,
        lifetimeSignal: lifetime.signal,
        isCurrentFor(candidate) {
          return (
            candidate === store &&
            !disposed &&
            !closed &&
            boundIncarnation === incarnation
          );
        },
        read(project) {
          assertCurrent();
          const admittedSession = session.signal;
          const result = clone(synchronous(project(clone(state), context)));
          if (admittedSession.aborted) throw authentication();
          assertCurrent();
          return result;
        },
        version(key) {
          assertCurrent();
          return version(key);
        },
        async command<Prepared, Value>(
          command: MemoryCommand<Prepared, Value>,
        ) {
          assertCurrent();
          const conditions = command.conditions?.map((condition) => ({
            ...condition,
          }));
          const finalize = command.finalize;
          const admittedSession = session.signal;
          const signal = AbortSignal.any([
            lifetime.signal,
            ...(command.signal ? [command.signal] : []),
            admittedSession,
          ]);
          let terminal: CommsClientError | undefined;
          // A restored token admits new work, never this invocation's old session.
          const abortFailure = () =>
            (terminal ??=
              admittedSession.aborted &&
              signal.reason === admittedSession.reason
                ? authentication()
                : cancellation());
          const assertOperation = () => {
            if (signal.aborted) throw abortFailure();
            assertCurrent();
          };
          assertOperation();
          let onAbort = () => {};
          const aborted = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(abortFailure());
            signal.addEventListener("abort", onAbort, { once: true });
          });
          const detach = () => signal.removeEventListener("abort", onAbort);
          const work = async () => {
            assertOperation();
            const prepared = await command.prepare?.(signal);
            const commit = () => {
              assertOperation();
              const execution = Object.freeze({
                context,
                now: clock(),
                signal,
                uuid,
              });
              // Optional preparation supplies undefined to a recipe that needs no preparation.
              synchronous(
                command.authorize(
                  clone(state),
                  execution,
                  prepared as Prepared,
                ),
              );
              for (const condition of conditions ?? []) {
                if (condition.if_match === undefined)
                  policyFailure({
                    status: 428,
                    body: {
                      detail: {
                        code: "comms_precondition_required",
                        message: "Version required",
                      },
                    },
                  });
                if (
                  !preconditionSchema.safeParse({
                    if_match: condition.if_match,
                  }).success
                )
                  policyFailure({
                    status: 422,
                    body: {
                      detail: {
                        code: "comms_invalid_input",
                        message: "Invalid version",
                      },
                    },
                  });
                if (condition.if_match !== version(condition.key))
                  policyFailure({
                    status: 412,
                    body: {
                      detail: {
                        code: "comms_precondition_failed",
                        message: "Resource changed",
                      },
                    },
                  });
              }
              const draft = structuredClone(state);
              const outcome = synchronous(
                command.apply(draft, execution, prepared as Prepared),
              );
              const parsedOutcome = outcomeSchema.safeParse(outcome);
              if (!parsedOutcome.success) invalidResponse();
              if (
                draft.version !== state.version ||
                draft.org_id !== state.org_id ||
                serialized(draft.resource_versions) !==
                  serialized(state.resource_versions)
              )
                invalidResponse();
              const value = clone(outcome.value);
              if (
                outcome.kind === "unchanged" &&
                (serialized(draft) !== serialized(state) ||
                  "publications" in outcome)
              )
                invalidResponse();
              const publications =
                parsedOutcome.data.kind === "commit"
                  ? parsedOutcome.data.publications
                  : [];
              for (const publication of publications) {
                // Even an empty audience must not admit a malformed/foreign topic.
                const parts = publication.event.topic.split(":");
                const target = commsContextSchema.safeParse({
                  org_id: owner.org_id,
                  user_id: parts[2] === "user" ? parts[3] : owner.user_id,
                });
                if (
                  !target.success ||
                  !realtimeEventSchemaFor(target.data).safeParse(
                    publication.event,
                  ).success
                )
                  invalidResponse();
                for (const user_id of publication.recipient_ids) {
                  if (
                    draft.people[user_id]?.org_id !== owner.org_id ||
                    !realtimeEventSchemaFor({
                      org_id: owner.org_id,
                      user_id,
                    }).safeParse(publication.event).success
                  )
                    invalidResponse();
                }
              }
              const keys = [...new Set(parsedOutcome.data.version_keys)];
              if (outcome.kind === "commit") {
                draft.resource_versions = {
                  ...state.resource_versions,
                  ...Object.fromEntries(
                    keys.map((key) => [
                      key,
                      (state.resource_versions[key] ?? 0) + 1,
                    ]),
                  ),
                };
              }
              const next =
                outcome.kind === "commit"
                  ? validateMemoryState(draft, owner.org_id)
                  : state;
              const result = {
                value,
                versions: Object.fromEntries(
                  keys.map((key) => [key, version(key, next)]),
                ),
              };
              assertOperation();
              if (outcome.kind === "commit" && failNext) {
                failNext = false;
                policyFailure({
                  status: 503,
                  body: {
                    detail: {
                      code: "comms_unavailable",
                      message: "Unavailable",
                    },
                  },
                });
              }
              if (
                parsedOutcome.data.kind === "commit" &&
                parsedOutcome.data.failure_point === "send" &&
                failSend
              ) {
                failSend = false;
                policyFailure({
                  status: 503,
                  body: {
                    detail: {
                      code: "comms_unavailable",
                      message: "Unavailable",
                    },
                  },
                });
              }
              // No fallible result/graph construction or user callback remains
              // before the single commit point. Later cancellation cannot undo it.
              detach();
              if (outcome.kind === "commit") {
                state = next;
                // Trusted pointer-only installation, never a fallible callback.
                finalize?.();
                notify(publications);
              }
              return result;
            };
            const result = tail.then(commit);
            tail = result.catch(() => undefined);
            return result;
          };
          // race also consumes an ignored preparation's later rejection.
          try {
            return await Promise.race([aborted, work()]);
          } finally {
            detach();
          }
        },
        events: {
          subscribe(observer, request = {}) {
            assertCurrent(false);
            if (request.signal?.aborted) return () => {};
            const unsubscribe = () => {
              subscribers.delete(subscription);
              request.signal?.removeEventListener("abort", unsubscribe);
            };
            const subscription = {
              context,
              observer,
              handle,
              unsubscribe,
              canDeliver: () =>
                handle.isCurrentFor(store) &&
                !session.signal.aborted &&
                !dropped,
            };
            subscribers.add(subscription);
            request.signal?.addEventListener("abort", unsubscribe, {
              once: true,
            });
            observe(() => observer.on_connection(connection()));
            return unsubscribe;
          },
        },
        dispose() {
          if (closed) return;
          closed = true;
          handles.delete(handle);
          handleControls.delete(handle);
          for (const subscription of subscribers)
            if (subscription.handle === handle) subscription.unsubscribe();
          lifetime.abort();
        },
      };
      handles.add(handle);
      handleControls.set(handle, {
        setTokenExpired(expired) {
          assertCurrent(false);
          if (expired === session.signal.aborted) return;
          const revision = ++connectionRevision;
          if (expired) session.abort(authentication());
          else session = new AbortController();
          publishConnection(revision, expired);
        },
        setConnectionDropped(value) {
          assertCurrent(false);
          if (value === dropped) return;
          dropped = value;
          publishConnection(++connectionRevision);
        },
      });
      return handle;
    },
    exportSnapshot() {
      assertOpen();
      return structuredClone({ format: 1, owner, state });
    },
    subscribe(listener) {
      assertOpen();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    updateAdmittedOwner(input, identity) {
      assertOpen();
      const context = commsContextSchema.safeParse(input);
      const parsed = z
        .strictObject({
          role: z.enum(["admin", "member", "guest"]),
          display_name: z.string(),
        })
        .safeParse(identity);
      if (
        !context.success ||
        !parsed.success ||
        context.data.org_id !== owner.org_id ||
        context.data.user_id !== owner.user_id
      )
        return invalidResponse();
      activePerson(state, owner);
      activePerson(initial, owner);
      const current = clone(state);
      const baseline = clone(initial);
      Object.assign(current.people[owner.user_id], parsed.data);
      Object.assign(baseline.people[owner.user_id], parsed.data);
      const next = validateMemoryState(current, owner.org_id);
      const nextInitial = validateMemoryState(baseline, owner.org_id);
      // Identity only: resource versions, incarnation and resource roots stay put.
      state = next;
      initial = nextInitial;
      notify([]);
    },
    reset() {
      assertOpen();
      const nextIncarnation = uuid();
      const next = structuredClone(initial);
      const retired = [...handles];
      incarnation = nextIncarnation;
      state = next;
      // Abort handlers may reenter: new bindings see only the new generation,
      // while every old binding is fenced before any dependency is notified.
      for (const handle of retired) handle.dispose();
      notify([]);
    },
    dispose() {
      disposed = true;
      for (const handle of handles) handle.dispose();
      listeners.clear();
    },
    failNextCommit() {
      assertOpen();
      failNext = true;
    },
    failNextSend() {
      assertOpen();
      failSend = true;
    },
    setTokenExpired(handle, expired) {
      assertOpen();
      const controls = handleControls.get(handle);
      if (!controls) return invalidResponse();
      controls.setTokenExpired(expired);
    },
    setConnectionDropped(handle, dropped) {
      assertOpen();
      const controls = handleControls.get(handle);
      if (!controls) return invalidResponse();
      controls.setConnectionDropped(dropped);
    },
  };
  return store;
}
