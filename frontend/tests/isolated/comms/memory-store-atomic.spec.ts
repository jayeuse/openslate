/** Atomic store specifications authored before implementation. */
import { expect, test } from "@playwright/test";
import type { CommsEvent } from "@/components/systems/comms/contract/types";
import type { MemoryCommand } from "@/components/systems/comms/memory/store";
import {
  deferred,
  fixture,
  observer,
  owner,
  renameCommand,
  structurePublication,
  topic,
} from "./memory-store-fixture";

test("two conditional writers produce one accepted state and one conflict, then the queue continues", async () => {
  const f = fixture();
  const events: CommsEvent[] = [];
  f.handle.events.subscribe(observer(events));
  const originalTag = f.handle.version(f.key);
  const barrier = deferred<void>();
  const first = renameCommand(f, "First competing topic", originalTag);
  const second = renameCommand(f, "Second competing topic", originalTag);
  first.prepare = second.prepare = () => barrier.promise;
  try {
    const left = f.handle.command(first);
    const right = f.admin.command(second);
    barrier.resolve();
    const outcomes = await Promise.allSettled([left, right]);
    const accepted = outcomes.filter((result) => result.status === "fulfilled");
    const refused = outcomes.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatchObject({
      kind: "http",
      failure: {
        status: 412,
        body: { detail: { code: "comms_precondition_failed" } },
      },
    });
    expect(["First competing topic", "Second competing topic"]).toContain(
      topic(f.handle, f.channelId),
    );
    expect(topic(f.handle, f.channelId)).toBe(accepted[0].value.value.topic);
    expect(f.handle.version(f.key)).toBe(accepted[0].value.versions[f.key]);
    expect(f.handle.version(f.key)).not.toBe(originalTag);
    expect(f.store.exportSnapshot().state.resource_versions[f.key]).toBe(1);
    expect(events).toHaveLength(1);
    expect(
      f.handle.read((state) => state.conversations[f.channelId].updated_at),
    ).toBe("2026-10-19T04:00:00.000Z");
    await f.handle.command(renameCommand(f, "Following accepted command"));
    expect(topic(f.handle, f.channelId)).toBe("Following accepted command");
    expect(events).toHaveLength(2);
  } finally {
    barrier.resolve();
    f.store.dispose();
  }
});

for (const failure of ["abort", "throw"] as const) {
  test(`${failure} after staging leaves no state, version or success event`, async () => {
    const f = fixture();
    const snapshot = structuredClone(f.store.exportSnapshot());
    const events: CommsEvent[] = [];
    f.handle.events.subscribe(observer(events));
    const before = topic(f.handle, f.channelId);
    const tag = f.handle.version(f.key);
    const controller = new AbortController();
    const command = renameCommand(f, "Must not commit");
    const apply = command.apply;
    const error = new Error("Owned recipe failure");
    command.signal = controller.signal;
    command.apply = (draft, execution, prepared) => {
      const outcome = apply(draft, execution, prepared);
      if (failure === "throw") throw error;
      controller.abort();
      return outcome;
    };
    try {
      if (failure === "throw")
        await expect(f.handle.command(command)).rejects.toBe(error);
      else
        await expect(f.handle.command(command)).rejects.toMatchObject({
          kind: "cancelled",
        });
      expect(f.store.exportSnapshot()).toEqual(snapshot);
      expect(topic(f.handle, f.channelId)).toBe(before);
      expect(f.handle.version(f.key)).toBe(tag);
      expect(events).toEqual([]);
    } finally {
      f.store.dispose();
    }
  });
}

test("authority is reevaluated after preparation against the current committed world", async () => {
  const f = fixture();
  const events: CommsEvent[] = [];
  f.handle.events.subscribe(observer(events));
  const before = topic(f.handle, f.channelId);
  const barrier = deferred<void>();
  const started = deferred<void>();
  const command = renameCommand(f, "Stale manager must not write");
  command.conditions = []; // Distinguish authority rejection from version conflict.
  command.prepare = () => {
    started.resolve();
    return barrier.promise;
  };
  try {
    const pending = f.handle.command(command);
    await started.promise;
    await f.admin.command({
      authorize(current, execution) {
        if (current.people[execution.context.user_id].role !== "admin")
          throw new Error("Test-owned authority update requires its admin");
      },
      apply(draft) {
        draft.members[f.channelId][owner.user_id].member_role = "member";
        return {
          kind: "commit",
          value: undefined,
          version_keys: [f.key],
          publications: [],
        };
      },
    });
    const afterRevocation = f.handle.version(f.key);
    const afterRevocationSnapshot = structuredClone(f.store.exportSnapshot());
    barrier.resolve();
    await expect(pending).rejects.toMatchObject({
      kind: "http",
      failure: {
        status: 403,
        body: { detail: { code: "comms_capability_denied" } },
      },
    });
    expect(topic(f.handle, f.channelId)).toBe(before);
    expect(f.handle.version(f.key)).toBe(afterRevocation);
    expect(f.store.exportSnapshot()).toEqual(afterRevocationSnapshot);
    expect(events).toEqual([]);
  } finally {
    barrier.resolve();
    f.store.dispose();
  }
});

for (const invalid of ["foreign topic", "content payload"] as const) {
  test(`${invalid} publication refuses the entire staged commit`, async () => {
    const f = fixture();
    const snapshot = structuredClone(f.store.exportSnapshot());
    const events: CommsEvent[] = [];
    f.handle.events.subscribe(observer(events));
    const before = topic(f.handle, f.channelId);
    const tag = f.handle.version(f.key);
    const command = renameCommand(f, "Invalid publication must not commit");
    const apply = command.apply;
    command.apply = (draft, execution, prepared) => {
      const outcome = apply(draft, execution, prepared);
      const publication = structurePublication();
      if (invalid === "foreign topic")
        publication.event.topic =
          "org:72000000-0000-4000-8000-000000000099:user:72000000-0000-4000-8000-000000000002";
      else
        Object.assign(publication.event.payload, {
          body: "This must never be emitted",
        });
      return { ...outcome, kind: "commit", publications: [publication] };
    };
    try {
      await expect(f.handle.command(command)).rejects.toMatchObject({
        kind: "invalid_response",
      });
      expect(f.store.exportSnapshot()).toEqual(snapshot);
      expect(topic(f.handle, f.channelId)).toBe(before);
      expect(f.handle.version(f.key)).toBe(tag);
      expect(events).toEqual([]);
    } finally {
      f.store.dispose();
    }
  });
}

test("missing and malformed preconditions refuse before staging instead of becoming unconditional", async () => {
  const f = fixture();
  const before = structuredClone(f.store.exportSnapshot());
  const events: CommsEvent[] = [];
  f.handle.events.subscribe(observer(events));
  try {
    const missing = renameCommand(f, "Missing guard");
    missing.conditions = [{ key: f.key, if_match: undefined }];
    await expect(f.handle.command(missing)).rejects.toMatchObject({
      kind: "http",
      failure: {
        status: 428,
        body: { detail: { code: "comms_precondition_required" } },
      },
    });
    const malformed = renameCommand(f, "Malformed guard", "not-an-etag");
    await expect(f.handle.command(malformed)).rejects.toMatchObject({
      kind: "http",
      failure: {
        status: 422,
        body: { detail: { code: "comms_invalid_input" } },
      },
    });
    expect(f.store.exportSnapshot()).toEqual(before);
    expect(events).toEqual([]);
  } finally {
    f.store.dispose();
  }
});

test("asynchronous recipe and false unchanged outcome cannot publish staged changes", async () => {
  const f = fixture();
  const snapshot = structuredClone(f.store.exportSnapshot());
  const tag = f.handle.version(f.key);
  const before = topic(f.handle, f.channelId);
  const events: CommsEvent[] = [];
  f.handle.events.subscribe(observer(events));
  try {
    const asyncRecipe = renameCommand(f, "Async staging");
    const apply = asyncRecipe.apply;
    // Deliberately violate the internal callback contract to test its runtime guard.
    asyncRecipe.apply = (async (...args: Parameters<typeof apply>) =>
      apply(...args)) as unknown as MemoryCommand<
      void,
      { topic: string }
    >["apply"];
    await expect(f.handle.command(asyncRecipe)).rejects.toMatchObject({
      kind: "invalid_response",
    });
    const falseNoop = renameCommand(f, "Misdeclared change");
    falseNoop.apply = (draft, execution, prepared) => {
      const value = apply(draft, execution, prepared).value;
      return { kind: "unchanged", value, version_keys: [f.key] };
    };
    await expect(f.handle.command(falseNoop)).rejects.toMatchObject({
      kind: "invalid_response",
    });
    const honestNoop = renameCommand(f, "Unused");
    honestNoop.apply = () => ({
      kind: "unchanged",
      value: { topic: before },
      version_keys: [f.key],
    });
    const replay = await f.handle.command(honestNoop);
    expect(replay.value.topic).toBe(before);
    expect(replay.versions[f.key]).toBe(tag);
    expect(f.store.exportSnapshot()).toEqual(snapshot);
    expect(topic(f.handle, f.channelId)).toBe(before);
    expect(events).toEqual([]);
  } finally {
    f.store.dispose();
  }
});

test("fail-next-commit is one-shot and cannot publish or poison a later command", async () => {
  const f = fixture();
  const events: CommsEvent[] = [];
  f.handle.events.subscribe(observer(events));
  const before = structuredClone(f.store.exportSnapshot());
  try {
    f.store.failNextCommit();
    f.store.failNextCommit(); // One armed fault, not an accumulating failure queue.
    await expect(
      f.handle.command(renameCommand(f, "Injected failure")),
    ).rejects.toMatchObject({
      kind: "http",
      failure: { status: 503, body: { detail: { code: "comms_unavailable" } } },
    });
    expect(f.store.exportSnapshot()).toEqual(before);
    expect(events).toEqual([]);
    await f.handle.command(renameCommand(f, "Accepted after one failure"));
    expect(topic(f.handle, f.channelId)).toBe("Accepted after one failure");
    expect(events).toHaveLength(1);
  } finally {
    f.store.dispose();
  }
});
