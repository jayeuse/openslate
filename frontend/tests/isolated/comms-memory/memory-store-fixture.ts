/** Owned synthetic data and real command recipes for the memory store boundary. */
import type {
  CommsEvent,
  EventObserver,
} from "@/components/systems/comms/contract/types";
import { scopeManagementDecision } from "../../support/comms-memory/domain/capabilities";
import { policyFailure } from "../../support/comms-memory/domain/access";
import { createMemorySeed } from "../../support/comms-memory/memory/seed";
import {
  createMemoryStore,
  type MemoryCommand,
  type MemoryHandle,
  type MemoryPublication,
} from "../../support/comms-memory/memory/store";

export const owner = {
  org_id: "72000000-0000-4000-8000-000000000001",
  user_id: "72000000-0000-4000-8000-000000000002",
};
export const otherOrg = "72000000-0000-4000-8000-000000000003";
export const now = Date.parse("2026-10-19T04:00:00Z");

export function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function initialWorld() {
  const initial = createMemorySeed(owner, {
    role: "member",
    display_name: "Test owner",
  });
  const channel = Object.values(initial.conversations).find(
    (c) => c.kind === "channel",
  );
  if (!channel) throw new Error("Owned fixture needs its seed channel");
  initial.members[channel.id][owner.user_id].member_role = "manager";
  const admin = Object.values(initial.people).find(
    (p) => p.user_id !== owner.user_id,
  );
  if (!admin) throw new Error("Owned fixture needs a second identity");
  admin.role = "admin";
  return { initial, channelId: channel.id, adminId: admin.user_id };
}

export function fixture(snapshot?: unknown, incarnation = 1) {
  const { initial, channelId, adminId } = initialWorld();
  let sequence = 1;
  const store = createMemoryStore({
    owner,
    initial,
    snapshot,
    clock: () => now,
    uuid: () =>
      `72000000-0000-4000-${(0x8000 + incarnation).toString(16)}-${(sequence++).toString(16).padStart(12, "0")}`,
  });
  return {
    initial,
    channelId,
    adminId,
    key: `conversation:${channelId}`,
    store,
    handle: store.bind(owner),
    admin: store.bind({ ...owner, user_id: adminId }),
  };
}
export type Fixture = ReturnType<typeof fixture>;

export function topic(handle: MemoryHandle, channelId: string) {
  return handle.read((state) => {
    const channel = state.conversations[channelId];
    if (channel.kind !== "channel")
      throw new Error("Fixture channel was replaced");
    return channel.topic;
  });
}

export function structurePublication(
  userId = owner.user_id,
): MemoryPublication {
  return {
    recipient_ids: [userId],
    event: {
      event: "structure",
      topic: `org:${owner.org_id}:user:${userId}`,
      private: true,
      payload: {},
    },
  };
}

/** A real command recipe using the frozen core guard, not a mocked store. */
export function renameCommand(
  f: Fixture,
  nextTopic: string,
  ifMatch = f.handle.version(f.key),
): MemoryCommand<void, { topic: string }> {
  return {
    conditions: [{ key: f.key, if_match: ifMatch }],
    authorize(current, execution) {
      const decision = scopeManagementDecision(current, execution.context, {
        kind: "channel",
        id: f.channelId,
      });
      if (!decision.allowed)
        policyFailure({
          status: 403,
          body: {
            detail: {
              code: "comms_capability_denied",
              message: "Capability required",
            },
          },
        });
    },
    apply(draft, execution) {
      const channel = draft.conversations[f.channelId];
      if (channel.kind !== "channel")
        throw new Error("Fixture channel was replaced");
      channel.topic = nextTopic;
      channel.updated_at = new Date(execution.now).toISOString();
      return {
        kind: "commit",
        value: { topic: channel.topic },
        version_keys: [f.key],
        publications: [structurePublication()],
      };
    },
  };
}

export function observer(events: CommsEvent[]): EventObserver {
  return {
    on_event: (event) => {
      events.push(event);
    },
    on_connection: () => {},
    on_error: () => {},
  };
}

export function caught(action: () => unknown): unknown {
  try {
    action();
    return null;
  } catch (error) {
    return error;
  }
}
