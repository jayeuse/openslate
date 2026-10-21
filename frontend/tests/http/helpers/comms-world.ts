import type { Page } from "@playwright/test";
import { createMemorySeed } from "../../support/comms-memory/memory/seed";
import {
  createMemoryCommsRuntime,
  type MemoryCommsRuntime,
} from "../../support/comms-memory/memory-client";
import type { MemoryCommsState } from "../../support/comms-memory/memory/model";
import { installCommsLiveApi } from "./comms-live-api";
import {
  defaultOrganization,
  defaultSignedInIdentity,
  signedInAs,
} from "./test";

type Role = "admin" | "member" | "guest";
type Instant = number | string | Date;

/**
 * The server time the memory runtime reads. It moves only when the test moves
 * it; `runFor` and `fastForward` move it together with `page.clock`. After
 * `page.clock.install`, page time keeps flowing in real time while the server
 * clock stays fixed between moves, so the two agree only within that drift.
 */
export type CommsTestClock = {
  now(): number;
  set(time: Instant): void;
  advance(ms: number): void;
  /** Advances the server first, then runs the page's timers for `ms`. */
  runFor(ms: number): Promise<void>;
  /** Advances the server first, then jumps the page clock by `ms`. */
  fastForward(ms: number): Promise<void>;
};

const epoch = (time: Instant) => new Date(time).getTime();

/** A server clock for `createMemoryCommsRuntime(seed, { clock: clock.now })`. */
export function createCommsTestClock(
  page: Page,
  start: Instant,
): CommsTestClock {
  let current = epoch(start);
  return {
    now: () => current,
    set(time) {
      current = epoch(time);
    },
    advance(ms) {
      current += ms;
    },
    async runFor(ms) {
      current += ms;
      await page.clock.runFor(ms);
    },
    async fastForward(ms) {
      current += ms;
      await page.clock.fastForward(ms);
    },
  };
}

/** Stable ids of the seeded world, read from the seed itself. */
export type CommsWorldIds = {
  org: string;
  owner: string;
  people: { noah: string; sofia: string; mara: string };
  room: string;
  category: string;
  department: string;
  group: string;
  module: string;
  record: string;
  /** The record link on the root message, for the record detail route. */
  recordReference: string;
  root: string;
  reply: string;
  thread: string;
};

function seededIds(state: MemoryCommsState, owner: string): CommsWorldIds {
  const person = (name: string) => {
    const found = Object.values(state.people).find(
      (row) => row.display_name === name,
    );
    if (!found) throw new Error(`The seed has no person named ${name}`);
    return found.user_id;
  };
  const only = <T>(rows: Record<string, T>) => {
    const values = Object.values(rows);
    if (values.length !== 1) throw new Error("The seed shape changed");
    return values[0];
  };
  const messages = Object.values(state.messages);
  const root = messages.find((row) => row.seq === 1 && !row.parent_id);
  const reply = messages.find((row) => row.parent_id === root?.id);
  if (!root || !reply || !root.record_links[0])
    throw new Error("The seed shape changed");
  return {
    org: state.org_id,
    owner,
    people: {
      noah: person("Noah Tan"),
      sofia: person("Sofia Garcia"),
      mara: person("Mara Santos"),
    },
    room: only(state.conversations).id,
    category: only(state.categories).id,
    department: only(state.departments).id,
    group: only(state.groups).id,
    module: only(state.modules).id,
    record: only(state.records).id,
    recordReference: root.record_links[0].id,
    root: root.id,
    reply: reply.id,
    thread: only(state.threads).id,
  };
}

export type CommsWorldOptions = {
  role?: Role;
  userId?: string;
  organizationId?: string;
  displayName?: string;
  /** Changes the seeded state before the runtime validates and owns it. */
  mutate?: (state: MemoryCommsState, ids: CommsWorldIds) => void;
  /** Starts a driven server clock; it also installs `page.clock` unless `installPage` is false. */
  clock?: Instant | { time: Instant; installPage?: boolean };
  /** Serves `/api/notifications` from the world's notices (default true). */
  notifications?: boolean;
  /**
   * Signs the page in as the world's owner with its role (default: true in
   * `defaultOrganization`, false elsewhere, where the spec owns the session).
   */
  session?: boolean;
  workspaceEvents?: boolean;
};

/**
 * Installs the seeded Comms world for one account in one call: the memory
 * runtime, the live `/api` routes over it, the notifications fixture and,
 * by default, the matching signed-in session. Returns the runtime, the
 * server controls and the seed's ids.
 */
export async function installCommsWorld(
  page: Page,
  options: CommsWorldOptions = {},
) {
  const role = options.role ?? "admin";
  const owner = {
    user_id: options.userId ?? defaultSignedInIdentity.id,
    org_id: options.organizationId ?? defaultOrganization.org_id,
  };
  const initial = createMemorySeed(owner, {
    role,
    display_name: options.displayName ?? "HTTP fixture owner",
  });
  const ids = seededIds(initial, owner.user_id);
  options.mutate?.(initial, ids);
  const clockOption =
    options.clock === undefined
      ? undefined
      : typeof options.clock === "object" && !(options.clock instanceof Date)
        ? options.clock
        : { time: options.clock };
  const clock = clockOption
    ? createCommsTestClock(page, clockOption.time)
    : undefined;
  if (clockOption && clockOption.installPage !== false)
    await page.clock.install({ time: epoch(clockOption.time) });
  const session =
    options.session ?? owner.org_id === defaultOrganization.org_id;
  if (session)
    await signedInAs(
      page,
      { id: owner.user_id, role },
      { organizationId: owner.org_id },
    );
  const runtime: MemoryCommsRuntime = createMemoryCommsRuntime(
    { owner, initial },
    clock ? { clock: clock.now } : {},
  );
  const server = await installCommsLiveApi(page, {
    userId: owner.user_id,
    organizationId: owner.org_id,
    runtime,
    workspaceEvents: options.workspaceEvents,
    notifications: options.notifications ?? true,
    clock: clock?.now,
  });
  return {
    runtime,
    server,
    ids,
    clock,
    snapshot: server.snapshot,
    /** Changes the world role and, when this world owns the session, the shell role too. */
    async setRole(
      next: Role,
      change?: Parameters<typeof server.setRole>[1],
    ): Promise<void> {
      if (session)
        await signedInAs(
          page,
          { id: owner.user_id, role: next },
          { organizationId: owner.org_id },
        );
      server.setRole(next, change);
    },
  };
}

export type CommsWorld = Awaited<ReturnType<typeof installCommsWorld>>;

/**
 * Replaces `current` with a new world (usually another account's): the old
 * world stops and its routes are removed before the new one answers. The
 * page's event stream is kept, so the new world does not install another.
 */
export async function swapCommsWorld(
  page: Page,
  current: CommsWorld,
  options: CommsWorldOptions = {},
): Promise<CommsWorld> {
  await current.server.uninstall();
  return installCommsWorld(page, { workspaceEvents: false, ...options });
}
