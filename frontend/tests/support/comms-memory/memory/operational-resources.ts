import * as S from "@/components/systems/comms/contract/schemas";
import type * as C from "@/components/systems/comms/contract/types";
import {
  activePerson,
  conversationAccess,
  eligiblePersonIds,
  notFound,
  policyFailure,
} from "../domain/access";
import { postDenied } from "../domain/posting";
import { invalidInput } from "../domain/settings";
import {
  assertRequestActive,
  createMemoryAvailability,
  type MemoryClientBinding,
} from "./availability";
import type { MemoryFileResources } from "./files";
import {
  messageSendCommand,
  type MemorySendDependencies,
  type MemorySendPresence,
  type MessageSendInput,
} from "./message-transitions";
import type { MemoryCommsState } from "./model";
import { invalidMemoryState } from "./snapshot";
import type {
  MemoryCommand,
  MemoryExecution,
  MemoryHandle,
  MemoryPublication,
  MemoryStore,
} from "./store-types";

export const scheduleKey = (id: string) => `schedule:${id}`;
const cancelled = () =>
  Object.assign(new Error("OpenComms operation cancelled"), {
    kind: "cancelled" as const,
  });

export function requireScheduleAuthor(
  world: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  id: string,
): C.Schedule {
  activePerson(world, context);
  const row = world.schedules[id];
  if (
    !row ||
    row.org_id !== context.org_id ||
    row.author_id !== context.user_id
  )
    return notFound();
  return row;
}

export function assertPendingSchedule(row: C.Schedule) {
  if (row.status === "pending") return;
  policyFailure({
    status: 409,
    body: {
      detail: {
        code:
          row.status === "running"
            ? "comms_schedule_claimed"
            : "comms_conflict",
        message: "Schedule is no longer pending",
      },
    },
  });
}

/** Strip schedule-only fields before passing the unchanged content to the sender. */
export function scheduleSendInput(
  request: C.Schedule["request"],
): MessageSendInput {
  const {
    conversation_id,
    parent_id,
    send_at,
    also_send_to_channel,
    ...content
  } = request;
  void send_at;
  return {
    conversation_id,
    parent_id,
    request: parent_id ? { ...content, also_send_to_channel } : content,
  };
}

type Activity = {
  context: C.CommsContext;
  presence?: { state: "online" | "away"; at: number };
  typing: Readonly<Record<string, number>>;
};
type ActivityRoot = {
  clients: ReadonlyMap<MemoryHandle, Activity>;
  announced: Readonly<Record<string, "online" | "away" | "offline">>;
};

export interface OperationalResources extends MemorySendPresence {
  readonly sendDependencies: MemorySendDependencies;
  sendDependenciesFor(handle: MemoryHandle): MemorySendDependencies;
  pumpDue(options?: C.RequestOptions): Promise<void>;
  expireTransient(options?: C.RequestOptions): Promise<void>;
  typingFor(handle: MemoryHandle, conversationId: string): readonly string[];
  dispose(): void;
  /** Concrete internal operations; only the operational family binds these. */
  presenceFor(
    handle: MemoryHandle,
    request: C.PresenceListRequest,
    options?: C.RequestOptions,
  ): C.PresenceSnapshot;
  heartbeat(
    handle: MemoryHandle,
    request: C.PresenceRequest,
    options?: C.RequestOptions,
  ): Promise<void>;
  typeIn(
    handle: MemoryHandle,
    conversationId: string,
    options?: C.RequestOptions,
  ): Promise<void>;
  dispatch(
    handle: MemoryHandle,
    id: string,
    options: C.ConditionalOptions,
  ): Promise<C.Schedule>;
}

function requireTyping(
  world: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  id: string,
) {
  const access = conversationAccess(world, context, id);
  if (access.level === "none") notFound();
  if (access.level !== "post" && access.level !== "manage") postDenied();
}

function scheduleFailure(error: unknown): C.Schedule["failure_code"] {
  if (!error || typeof error !== "object" || !("kind" in error)) throw error;
  if (error.kind === "network") return "unavailable";
  if (error.kind !== "http" || !("failure" in error)) throw error;
  const failure = error.failure;
  if (!failure || typeof failure !== "object" || !("status" in failure))
    throw error;
  switch (failure.status) {
    case 401:
    case 404:
      return "access_lost";
    case 403:
    case 429:
      return "post_denied";
    case 409:
    case 422:
      return "invalid_content";
    case 503:
      return "unavailable";
    default:
      throw error;
  }
}

export function createOperationalResources(
  store: MemoryStore,
  options: {
    files: MemoryFileResources;
    clock: () => number;
    ownerBinding: MemoryClientBinding;
    beforeScheduleSend?: (jobId: string, signal: AbortSignal) => Promise<void>;
  },
): OperationalResources {
  const { files, clock, ownerBinding, beforeScheduleSend } = options;
  function requireHandle(handle: MemoryHandle) {
    if (handle.lifetimeSignal.aborted) throw cancelled();
    if (!handle.isCurrentFor(store)) invalidMemoryState();
  }
  requireHandle(ownerBinding.handle);
  if (files.store !== store) invalidMemoryState();
  files.assertCurrent(store);
  const ownerContext = ownerBinding.handle.context;
  const anchor = store.bind(ownerContext);
  const jobs = new Set<MemoryHandle>();
  const watched = new WeakSet<MemoryHandle>();
  const dependencies = new Map<string, MemorySendDependencies>();
  let activity: ActivityRoot = { clients: new Map(), announced: {} };
  let disposed = false;

  function assertOpen() {
    if (disposed || !anchor.isCurrentFor(store)) throw cancelled();
  }
  function assertHandle(handle: MemoryHandle) {
    assertOpen();
    requireHandle(handle);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    activity = { clients: new Map(), announced: {} };
    dependencies.clear();
    for (const handle of jobs) handle.dispose();
    jobs.clear();
    anchor.dispose();
  }
  anchor.lifetimeSignal.addEventListener("abort", dispose, { once: true });

  function forActor(context: C.CommsContext): MemorySendDependencies {
    assertOpen();
    const key = `${context.org_id}:${context.user_id}`;
    const cached = dependencies.get(key);
    if (cached) return cached;
    const authority = createMemoryAvailability(context).authority;
    const value = Object.freeze({
      store,
      files,
      presence: resources,
      authority,
    });
    dependencies.set(key, value);
    return value;
  }
  function watch(handle: MemoryHandle) {
    if (watched.has(handle)) return;
    watched.add(handle);
    handle.lifetimeSignal.addEventListener(
      "abort",
      () => {
        if (disposed) return;
        const clients = new Map(activity.clients);
        clients.delete(handle);
        activity = { ...activity, clients };
      },
      { once: true, signal: anchor.lifetimeSignal },
    );
  }
  function presenceState(root: ActivityRoot, userId: string, now: number) {
    let latest: Activity["presence"];
    for (const [handle, value] of root.clients) {
      const presence = value.presence;
      if (
        handle.isCurrentFor(store) &&
        value.context.user_id === userId &&
        presence &&
        now - presence.at < 120_000 &&
        (!latest || presence.at >= latest.at)
      )
        latest = presence;
    }
    return latest?.state ?? "offline";
  }
  function presencePublication(
    world: Readonly<MemoryCommsState>,
    userId: string,
    state: "online" | "away" | "offline",
  ): MemoryPublication {
    return {
      recipient_ids: Object.values(world.people)
        .filter((p) => p.active && p.org_id === world.org_id)
        .map((p) => p.user_id),
      event: {
        private: true,
        topic: `org:${world.org_id}:presence`,
        event: "presence",
        payload: { user_id: userId, state },
      },
    };
  }
  function activityCommand(
    handle: MemoryHandle,
    signal: AbortSignal | undefined,
    authorize: (
      world: Readonly<MemoryCommsState>,
      execution: MemoryExecution,
    ) => void,
    stage: (
      world: Readonly<MemoryCommsState>,
      execution: MemoryExecution,
    ) => { next: ActivityRoot; publications: MemoryPublication[] },
  ): MemoryCommand<undefined, void> {
    let next = activity;
    return {
      signal: AbortSignal.any([
        anchor.lifetimeSignal,
        ...(signal ? [signal] : []),
      ]),
      authorize(world, execution) {
        assertHandle(handle);
        authorize(world, execution);
      },
      apply(world, execution) {
        const staged = stage(world, execution);
        next = staged.next;
        return {
          kind: "commit",
          value: undefined,
          version_keys: [],
          publications: staged.publications,
        };
      },
      finalize() {
        activity = next;
        return undefined;
      },
    };
  }

  async function recordFailure(
    job: C.Schedule,
    failure_code: C.Schedule["failure_code"],
    signal: AbortSignal,
  ) {
    assertOpen();
    const failed = await anchor.command({
      signal,
      authorize(world) {
        assertOpen();
        const row = world.schedules[job.id];
        if (
          !row ||
          row.org_id !== job.org_id ||
          row.author_id !== job.author_id
        )
          notFound();
      },
      apply(draft, execution) {
        const row = draft.schedules[job.id];
        if (row.status !== "running")
          return {
            kind: "unchanged",
            value: row,
            version_keys: [scheduleKey(job.id)],
          };
        const done: C.Schedule = {
          ...row,
          status: "failed",
          message_id: null,
          failure_code,
          updated_at: new Date(execution.now).toISOString(),
        };
        draft.schedules[job.id] = done;
        return {
          kind: "commit",
          value: done,
          version_keys: [scheduleKey(job.id)],
          publications: [],
        };
      },
    });
    return failed.value;
  }

  async function complete(job: C.Schedule): Promise<C.Schedule> {
    assertOpen();
    const signal = anchor.lifetimeSignal;
    let handle: MemoryHandle;
    try {
      handle = store.bind({ org_id: job.org_id, user_id: job.author_id });
    } catch (error) {
      return recordFailure(job, scheduleFailure(error), signal);
    }
    jobs.add(handle);
    try {
      const actorDependencies = forActor(handle.context);
      let recipe: ReturnType<typeof messageSendCommand>;
      try {
        const result = await handle.command<void, C.Schedule>({
          signal,
          prepare: beforeScheduleSend
            ? (signal) => beforeScheduleSend(job.id, signal)
            : undefined,
          authorize(world, execution) {
            assertOpen();
            const current = requireScheduleAuthor(
              world,
              execution.context,
              job.id,
            );
            if (current.status !== "running")
              policyFailure({
                status: 409,
                body: {
                  detail: {
                    code: "comms_conflict",
                    message: "Schedule is no longer running",
                  },
                },
              });
            recipe = messageSendCommand(
              scheduleSendInput(current.request),
              actorDependencies,
            );
            recipe.authorize(world, execution, undefined);
          },
          apply(draft, execution) {
            const current = requireScheduleAuthor(
              draft,
              execution.context,
              job.id,
            );
            const sent = recipe.apply(draft, execution, undefined);
            const done: C.Schedule = {
              ...current,
              status: "succeeded",
              message_id: sent.value.message.id,
              failure_code: null,
              updated_at: new Date(execution.now).toISOString(),
            };
            draft.schedules[job.id] = done;
            return {
              kind: "commit",
              value: done,
              version_keys: [...sent.version_keys, scheduleKey(job.id)],
              publications: sent.kind === "commit" ? sent.publications : [],
              ...(sent.kind === "commit" && sent.failure_point
                ? { failure_point: sent.failure_point }
                : {}),
            };
          },
        });
        return result.value;
      } catch (error) {
        const failure_code = scheduleFailure(error);
        return recordFailure(job, failure_code, signal);
      }
    } finally {
      jobs.delete(handle);
      handle.dispose();
    }
  }

  function waitForCompletion(
    work: Promise<C.Schedule>,
    signal: AbortSignal,
  ): Promise<C.Schedule> {
    return new Promise((resolve, reject) => {
      const detach = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        detach();
        reject(cancelled());
      };
      // The accepted job continues independently; always consume its later settlement.
      work.then(
        (value) => {
          detach();
          resolve(value);
        },
        (error: unknown) => {
          detach();
          reject(error);
        },
      );
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function claim(
    handle: MemoryHandle,
    id: string,
    due: boolean,
    request?: C.RequestOptions & { if_match?: string },
  ): Promise<C.Schedule | null> {
    assertHandle(handle);
    const result = await handle.command<undefined, C.Schedule | null>({
      signal: AbortSignal.any([
        anchor.lifetimeSignal,
        ...(request?.signal ? [request.signal] : []),
      ]),
      conditions: due
        ? []
        : [{ key: scheduleKey(id), if_match: request?.if_match }],
      authorize(world, execution) {
        assertOpen();
        if (!due)
          assertPendingSchedule(
            requireScheduleAuthor(world, execution.context, id),
          );
        else if (
          !world.schedules[id] ||
          world.schedules[id].org_id !== execution.context.org_id
        )
          notFound();
      },
      apply(draft, execution) {
        const row = draft.schedules[id];
        if (
          due &&
          (row.status !== "pending" ||
            Date.parse(row.request.send_at) > execution.now)
        )
          return { kind: "unchanged", value: null, version_keys: [] };
        assertPendingSchedule(row);
        const claimed: C.Schedule = {
          ...row,
          status: "running",
          updated_at: new Date(execution.now).toISOString(),
        };
        draft.schedules[id] = claimed;
        return {
          kind: "commit",
          value: claimed,
          version_keys: [scheduleKey(id)],
          publications: [],
        };
      },
    });
    return result.value;
  }

  const resources: OperationalResources = {
    store,
    get sendDependencies() {
      return forActor(ownerContext);
    },
    sendDependenciesFor(handle) {
      assertHandle(handle);
      return forActor(handle.context);
    },
    onlineUserIds(input) {
      assertOpen();
      if (input.store !== store || input.org_id !== ownerContext.org_id)
        invalidMemoryState();
      if (!Number.isFinite(input.now)) invalidInput();
      const world = store.exportSnapshot().state;
      return Object.values(world.people)
        .filter(
          (p) =>
            p.active &&
            p.org_id === input.org_id &&
            presenceState(activity, p.user_id, input.now) === "online",
        )
        .map((p) => p.user_id)
        .sort();
    },
    presenceFor(handle, request, requestOptions) {
      assertHandle(handle);
      assertRequestActive(requestOptions);
      const parsed = S.presenceListRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const now = clock();
      return handle.read((world, context) => {
        const eligible = new Set(eligiblePersonIds(world, context));
        return {
          org_id: context.org_id,
          items: parsed.data.user_ids
            .filter((id) => eligible.has(id))
            .map((user_id) => ({
              user_id,
              state: presenceState(activity, user_id, now),
            })),
        };
      });
    },
    async heartbeat(handle, request, requestOptions) {
      assertHandle(handle);
      const parsed = S.presenceRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      watch(handle);
      await handle.command(
        activityCommand(
          handle,
          requestOptions?.signal,
          (world, execution) => {
            activePerson(world, execution.context);
          },
          (world, execution) => {
            const clients = new Map(activity.clients);
            const previous = clients.get(handle);
            clients.set(handle, {
              context: execution.context,
              typing: previous?.typing ?? {},
              presence: { state: parsed.data.state, at: execution.now },
            });
            const next = { clients, announced: { ...activity.announced } };
            const state = presenceState(
              next,
              execution.context.user_id,
              execution.now,
            );
            const changed =
              (next.announced[execution.context.user_id] ?? "offline") !==
              state;
            next.announced[execution.context.user_id] = state;
            return {
              next,
              publications: changed
                ? [presencePublication(world, execution.context.user_id, state)]
                : [],
            };
          },
        ),
      );
    },
    async typeIn(handle, conversationId, requestOptions) {
      assertHandle(handle);
      watch(handle);
      await handle.command(
        activityCommand(
          handle,
          requestOptions?.signal,
          (world, execution) =>
            requireTyping(world, execution.context, conversationId),
          (world, execution) => {
            const clients = new Map(activity.clients);
            const previous = clients.get(handle);
            clients.set(handle, {
              ...previous,
              context: execution.context,
              typing: { ...previous?.typing, [conversationId]: execution.now },
            });
            return {
              next: { ...activity, clients },
              publications: [
                {
                  recipient_ids: Object.values(world.people)
                    .filter(
                      (p) =>
                        p.active &&
                        p.org_id === world.org_id &&
                        conversationAccess(
                          world,
                          { org_id: world.org_id, user_id: p.user_id },
                          conversationId,
                        ).level !== "none",
                    )
                    .map((p) => p.user_id),
                  event: {
                    private: true,
                    topic: `org:${world.org_id}:conversation:${conversationId}`,
                    event: "typing",
                    payload: {
                      conversation_id: conversationId,
                      user_id: execution.context.user_id,
                    },
                  },
                },
              ],
            };
          },
        ),
      );
    },
    typingFor(handle, conversationId) {
      assertHandle(handle);
      const now = clock();
      return handle.read((world, context) => {
        if (conversationAccess(world, context, conversationId).level === "none")
          notFound();
        const ids = new Set<string>();
        for (const [client, value] of activity.clients) {
          const at = value.typing[conversationId];
          const person = world.people[value.context.user_id];
          if (
            !client.isCurrentFor(store) ||
            !person?.active ||
            at === undefined ||
            now - at >= 15_000
          )
            continue;
          const level = conversationAccess(
            world,
            value.context,
            conversationId,
          ).level;
          if (level === "post" || level === "manage")
            ids.add(value.context.user_id);
        }
        return [...ids].sort();
      });
    },
    async expireTransient(requestOptions) {
      assertOpen();
      await anchor.command(
        activityCommand(
          anchor,
          requestOptions?.signal,
          () => {},
          (world, execution) => {
            const clients = new Map<MemoryHandle, Activity>();
            for (const [handle, value] of activity.clients) {
              if (
                !handle.isCurrentFor(store) ||
                !world.people[value.context.user_id]?.active
              )
                continue;
              const typing = Object.fromEntries(
                Object.entries(value.typing).filter(([id, at]) => {
                  if (execution.now - at >= 15_000 || !world.conversations[id])
                    return false;
                  const level = conversationAccess(
                    world,
                    value.context,
                    id,
                  ).level;
                  return level === "post" || level === "manage";
                }),
              );
              const presence =
                value.presence && execution.now - value.presence.at < 120_000
                  ? value.presence
                  : undefined;
              if (presence || Object.keys(typing).length)
                clients.set(handle, {
                  context: value.context,
                  presence,
                  typing,
                });
            }
            const next = { clients, announced: { ...activity.announced } };
            const publications: MemoryPublication[] = [];
            for (const userId of Object.keys(next.announced)) {
              const state = presenceState(next, userId, execution.now);
              if (state !== next.announced[userId]) {
                next.announced[userId] = state;
                publications.push(presencePublication(world, userId, state));
              }
            }
            return { next, publications };
          },
        ),
      );
    },
    async dispatch(handle, id, request) {
      assertHandle(handle);
      const job = await claim(handle, id, false, request);
      if (!job) return invalidMemoryState();
      return waitForCompletion(
        complete(job),
        AbortSignal.any([
          handle.lifetimeSignal,
          ...(request?.signal ? [request.signal] : []),
        ]),
      );
    },
    async pumpDue(request = {}) {
      assertOpen();
      assertRequestActive(request);
      const due = Object.values(store.exportSnapshot().state.schedules)
        .filter(
          (job) =>
            job.status === "pending" &&
            Date.parse(job.request.send_at) <= clock(),
        )
        .sort(
          (a, b) =>
            a.request.send_at.localeCompare(b.request.send_at) ||
            a.id.localeCompare(b.id),
        );
      for (const row of due) {
        assertOpen();
        assertRequestActive(request);
        // Claiming is resource bookkeeping, not a send under the anchor actor.
        // complete binds the canonical author separately and rechecks all rights.
        const job = await claim(anchor, row.id, true, request);
        if (job)
          await waitForCompletion(
            complete(job),
            AbortSignal.any([
              anchor.lifetimeSignal,
              ...(request.signal ? [request.signal] : []),
            ]),
          );
      }
    },
    dispose,
  };
  dependencies.set(
    `${ownerContext.org_id}:${ownerContext.user_id}`,
    Object.freeze({
      store,
      files,
      presence: resources,
      authority: ownerBinding.authority,
    }),
  );
  return resources;
}
