/** ID21 store specifications authored before implementation. */
import { expect, test } from "@playwright/test";
import type { MemoryCommand } from "../../support/comms-memory/memory/store";
import {
  deferred,
  fixture,
  owner,
  renameCommand,
  structurePublication,
  topic,
} from "./memory-store-fixture";

test("finalize publishes canonical and transient roots before observers and events", async () => {
  const f = fixture();
  let root: readonly string[] = ["retained"];
  let nextRoot = root;
  const observed: { via: string; topic: string; root: readonly string[] }[] =
    [];
  const stop = f.store.subscribe(() => {
    observed.push({
      via: "observer",
      topic: topic(f.handle, f.channelId),
      root: [...root],
    });
  });
  const unsubscribe = f.handle.events.subscribe({
    on_event: () => {
      observed.push({
        via: "event",
        topic: topic(f.handle, f.channelId),
        root: [...root],
      });
    },
    on_connection: () => {},
    on_error: () => {},
  });
  try {
    const rename = renameCommand(f, "Accepted topic");
    const commit: MemoryCommand<void, { topic: string }> = {
      ...rename,
      apply(draft, execution, prepared) {
        const result = rename.apply(draft, execution, prepared);
        nextRoot = [...root, "first"];
        return result;
      },
      // Trusted ID21 finalizers perform only preconstructed-root assignment.
      finalize: (): undefined => {
        root = nextRoot;
      },
    };
    expect((await f.handle.command(commit)).value).toEqual({
      topic: "Accepted topic",
    });
    expect(observed).toEqual([
      { via: "observer", topic: "Accepted topic", root: ["retained", "first"] },
      { via: "event", topic: "Accepted topic", root: ["retained", "first"] },
    ]);

    const beforeTransient = f.store.exportSnapshot();
    const version = f.handle.version(f.key);
    await f.handle.command({
      authorize: rename.authorize,
      apply() {
        nextRoot = [...root, "second"]; // Current committed root, not a prepare-time copy.
        return {
          kind: "commit",
          value: undefined,
          version_keys: [],
          publications: [structurePublication()],
        };
      },
      finalize: (): undefined => {
        root = nextRoot;
      },
    });
    expect(root).toEqual(["retained", "first", "second"]);
    expect(f.store.exportSnapshot()).toEqual(beforeTransient);
    expect(f.handle.version(f.key)).toBe(version);
    expect(observed.slice(2)).toEqual([
      {
        via: "observer",
        topic: "Accepted topic",
        root: ["retained", "first", "second"],
      },
      {
        via: "event",
        topic: "Accepted topic",
        root: ["retained", "first", "second"],
      },
    ]);
  } finally {
    stop();
    unsubscribe();
    f.store.dispose();
  }
});

test("failed, cancelled and unchanged commands never install a staged root", async () => {
  const f = fixture();
  const originalRoot: readonly string[] = ["committed bytes"];
  let root = originalRoot;
  let stagedRoot = root;
  const notifications: string[] = [];
  const stop = f.store.subscribe(() => {
    notifications.push("observer");
  });
  const unsubscribe = f.handle.events.subscribe({
    on_event: () => {
      notifications.push("event");
    },
    on_connection: () => {},
    on_error: () => {},
  });
  const entered = deferred<void>(),
    release = deferred<void>();
  try {
    const before = f.store.exportSnapshot();
    const rename = renameCommand(f, "Must not commit");
    const candidate: MemoryCommand<void, { topic: string }> = {
      ...rename,
      apply(draft, execution, prepared) {
        const result = rename.apply(draft, execution, prepared);
        stagedRoot = [...root, "must not escape"];
        return result;
      },
      finalize: (): undefined => {
        root = stagedRoot;
      },
    };
    await expect(
      f.handle.command({
        ...candidate,
        apply(draft, execution, prepared) {
          const result = candidate.apply(draft, execution, prepared);
          draft.high_water_seq[f.channelId] = -1; // Real graph validator, no mocked failure.
          return result;
        },
      }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
    expect(root).toBe(originalRoot);

    f.store.failNextCommit();
    await expect(f.handle.command(candidate)).rejects.toMatchObject({
      kind: "http",
      failure: { status: 503, body: { detail: { code: "comms_unavailable" } } },
    });
    expect(root).toBe(originalRoot);

    expect(
      (
        await f.handle.command({
          ...candidate,
          apply() {
            return {
              kind: "unchanged",
              value: { topic: "Read only" },
              version_keys: [],
            };
          },
        })
      ).value,
    ).toEqual({ topic: "Read only" });
    expect(root).toBe(originalRoot);

    const caller = new AbortController();
    const pending = f.handle.command({
      ...candidate,
      signal: caller.signal,
      prepare: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const rejected = expect(pending).rejects.toMatchObject({
      kind: "cancelled",
    });
    await entered.promise;
    caller.abort();
    await rejected; // Must settle while preparation still ignores cancellation.
    expect(f.handle.lifetimeSignal.aborted).toBe(false);
    expect(f.handle.isCurrentFor(f.store)).toBe(true);
    expect(root).toBe(originalRoot);
    release.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve)); // Release checkpoint, not elapsed time.
    expect(root).toBe(originalRoot);
    expect(f.store.exportSnapshot()).toEqual(before);
    expect(notifications).toEqual([]);
  } finally {
    release.resolve();
    stop();
    unsubscribe();
    f.store.dispose();
  }
});

test("handle lifetime is exact-store identity, not authorization, and raw reset/dispose retires it", async () => {
  const f = fixture(),
    other = fixture(undefined, 2); // Same identity and seed; different store objects.
  const sibling = f.store.bind(owner);
  const laterPeer = f.store.bind(owner); // Bind before the administrative deactivation below.
  const lifetime = f.handle.lifetimeSignal;
  try {
    expect(f.handle.lifetimeSignal).toBe(lifetime);
    expect(lifetime.aborted).toBe(false);
    expect(f.handle.isCurrentFor(f.store)).toBe(true);
    expect(f.handle.isCurrentFor(other.store)).toBe(false);
    expect(other.handle.isCurrentFor(f.store)).toBe(false);
    // The accepted real management guard admits a synthetic administrative change.
    // isCurrentFor must not reimplement activePerson or any application policy.
    await f.admin.command({
      authorize: renameCommand(f, "unused").authorize,
      apply(draft) {
        draft.people[owner.user_id].active = false;
        return {
          kind: "commit",
          value: undefined,
          version_keys: [],
          publications: [],
        };
      },
    });
    expect(f.handle.isCurrentFor(f.store)).toBe(true);
    expect(lifetime.aborted).toBe(false);

    f.handle.dispose();
    expect(lifetime.aborted).toBe(true);
    expect(f.handle.isCurrentFor(f.store)).toBe(false);
    expect(sibling.isCurrentFor(f.store)).toBe(true);
    expect(sibling.lifetimeSignal.aborted).toBe(false);
    const duringAbort: {
      current: boolean[];
      owner_active: boolean;
      read_kind: unknown;
    }[] = [];
    const onAdminAbort = () => {
      const current = [
        sibling.isCurrentFor(f.store),
        laterPeer.isCurrentFor(f.store),
      ];
      let readKind: unknown;
      try {
        readKind = laterPeer.read(
          (state) => state.people[owner.user_id].active,
        );
      } catch (error) {
        readKind =
          error && typeof error === "object" && "kind" in error
            ? error.kind
            : error;
      }
      duringAbort.push({
        current,
        owner_active:
          f.store.exportSnapshot().state.people[owner.user_id].active,
        read_kind: readKind,
      });
    };
    // Fixture binds f.handle then f.admin, before sibling/laterPeer. The first
    // handle is already disposed; observe from the still-live earlier admin.
    // Do not depend on laterPeer's individual signal/callback having run yet.
    f.admin.lifetimeSignal.addEventListener("abort", onAdminAbort, {
      once: true,
    });
    try {
      f.store.reset(); // No resource/handle pre-closing; seed reactivates the owner.
    } finally {
      f.admin.lifetimeSignal.removeEventListener("abort", onAdminAbort);
    }
    expect(duringAbort).toEqual([
      { current: [false, false], owner_active: true, read_kind: "cancelled" },
    ]);
    expect(sibling.lifetimeSignal.aborted).toBe(true);
    expect(sibling.isCurrentFor(f.store)).toBe(false);
    expect(f.admin.lifetimeSignal.aborted).toBe(true);
    expect(f.handle.isCurrentFor(f.store)).toBe(false);
    const replacement = f.store.bind(owner);
    expect(replacement.isCurrentFor(f.store)).toBe(true);
    expect(replacement.lifetimeSignal.aborted).toBe(false);
    expect(replacement.lifetimeSignal).not.toBe(lifetime);
    f.store.dispose();
    expect(replacement.isCurrentFor(f.store)).toBe(false);
    expect(replacement.lifetimeSignal.aborted).toBe(true);
    expect(other.handle.isCurrentFor(other.store)).toBe(true);
    expect(other.handle.lifetimeSignal.aborted).toBe(false);
  } finally {
    f.store.dispose();
    other.store.dispose();
  }
});
