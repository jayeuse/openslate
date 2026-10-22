/** Lifecycle store specifications authored before implementation. */
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import type {
  CommsEvent,
  ConnectionState,
} from "@/components/systems/comms/contract/types";
import type { MemorySnapshot } from "../../support/comms-memory/memory/store";
import {
  caught,
  deferred,
  fixture,
  observer,
  otherOrg,
  owner,
  renameCommand,
  topic,
} from "./memory-store-fixture";

for (const cancellation of ["disposed", "aborted"] as const) {
  test(`${cancellation} preparation settles before its dependency and cannot commit late`, async () => {
    const f = fixture();
    const before = structuredClone(f.store.exportSnapshot());
    const tag = f.handle.version(f.key);
    const events: CommsEvent[] = [];
    const notices: MemorySnapshot[] = [];
    f.handle.events.subscribe(observer(events));
    f.store.subscribe(() => {
      notices.push(structuredClone(f.store.exportSnapshot()));
    });
    const controller = new AbortController();
    const entered = deferred<void>();
    const release = deferred<void>();
    const command = renameCommand(f, "Late dependency must not write");
    command.signal = controller.signal;
    command.prepare = () => {
      entered.resolve();
      return release.promise; // Deliberately ignores cancellation, but is a real dependency.
    };
    const pending = f.handle.command(command);
    void pending.catch(() => undefined); // Teardown must not mask a test failure with a second rejection.
    try {
      await entered.promise;
      if (cancellation === "disposed") f.handle.dispose();
      else controller.abort();
      // This must settle while release is STILL CLOSED; no timeout-based racing.
      await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
      expect(f.store.exportSnapshot()).toEqual(before);
      release.resolve();
      // Event-loop checkpoint drains the released promise/commit queue, not an elapsed-time sleep.
      await nextTurn();
      expect(f.store.exportSnapshot()).toEqual(before);
      expect(f.admin.version(f.key)).toBe(tag);
      expect(events).toEqual([]);
      expect(notices).toEqual([]);
      // Disposing one handle never retires another actor in the explicitly shared test world.
      await f.admin.command(renameCommand(f, "Other handle still works", tag));
      expect(topic(f.admin, f.channelId)).toBe("Other handle still works");
    } finally {
      release.resolve();
      f.store.dispose();
    }
  });
}

test("store disposal is terminal and consumes a late preparation rejection without persistence callbacks", async () => {
  const f = fixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  const notices: MemorySnapshot[] = [];
  const events: CommsEvent[] = [];
  f.store.subscribe(() => {
    notices.push(structuredClone(f.store.exportSnapshot()));
  });
  f.handle.events.subscribe(observer(events));
  const command = renameCommand(f, "Disposed store cannot write");
  command.prepare = () => {
    entered.resolve();
    return release.promise;
  };
  const pending = f.handle.command(command);
  void pending.catch(() => undefined);
  try {
    await entered.promise;
    f.store.dispose();
    f.store.dispose();
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    expect(caught(() => f.store.bind(owner))).toMatchObject({
      kind: "cancelled",
    });
    expect(caught(() => f.store.exportSnapshot())).toMatchObject({
      kind: "cancelled",
    });
    expect(caught(() => f.admin.read((state) => state.org_id))).toMatchObject({
      kind: "cancelled",
    });
    release.reject(new Error("Owned dependency rejected after disposal"));
    await nextTurn(); // Playwright must see no unhandled rejection from the discarded preparation.
    expect(notices).toEqual([]);
    expect(events).toEqual([]);
  } finally {
    release.resolve();
    f.store.dispose();
  }
});

test("reset retires old handles and ETags and never republishes late old-generation content", async () => {
  const f = fixture();
  const seed = structuredClone(f.store.exportSnapshot());
  await f.handle.command(renameCommand(f, "Saved before reset"));
  const oldTag = f.handle.version(f.key);
  const publications: MemorySnapshot[] = [];
  const oldEvents: CommsEvent[] = [];
  f.store.subscribe(() => {
    publications.push(structuredClone(f.store.exportSnapshot()));
  });
  f.handle.events.subscribe(observer(oldEvents));
  const entered = deferred<void>();
  const release = deferred<void>();
  const command = renameCommand(f, "Old generation resurrection", oldTag);
  command.prepare = () => {
    entered.resolve();
    return release.promise;
  };
  const pending = f.handle.command(command);
  void pending.catch(() => undefined);
  try {
    await entered.promise;
    f.store.reset();
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    const current = f.store.bind(owner);
    const newTag = current.version(f.key);
    expect(newTag).not.toBe(oldTag);
    expect(f.store.exportSnapshot()).toEqual(seed);
    expect(publications).toEqual([seed]);
    expect(caught(() => f.handle.read((state) => state.org_id))).toMatchObject({
      kind: "cancelled",
    });
    await expect(f.handle.command(command)).rejects.toMatchObject({
      kind: "cancelled",
    });
    await expect(
      current.command(renameCommand(f, "Stale precondition", oldTag)),
    ).rejects.toMatchObject({ kind: "http", failure: { status: 412 } });
    release.resolve();
    await nextTurn();
    expect(f.store.exportSnapshot()).toEqual(seed);
    expect(current.version(f.key)).toBe(newTag);
    expect(publications).toEqual([seed]);
    expect(oldEvents).toEqual([]);
    const newEvents: CommsEvent[] = [];
    current.events.subscribe(observer(newEvents));
    await current.command(renameCommand(f, "New generation accepted", newTag));
    expect(topic(current, f.channelId)).toBe("New generation accepted");
    expect(newEvents).toHaveLength(1);
    expect(oldEvents).toEqual([]);
    expect(publications).toHaveLength(2);

    // ID31 updates only the admitted owner's live identity and future reset seed.
    const beforeAdmission = f.store.exportSnapshot();
    const admittedTag = current.version(f.key);
    f.store.updateAdmittedOwner(owner, {
      role: "guest",
      display_name: "Readmitted test owner",
    });
    expect(current.isCurrentFor(f.store)).toBe(true);
    expect(current.version(f.key)).toBe(admittedTag);
    expect(current.read((state) => state.people[owner.user_id])).toEqual({
      ...beforeAdmission.state.people[owner.user_id],
      role: "guest",
      display_name: "Readmitted test owner",
    });
    f.store.reset();
    const admitted = f.store.bind(owner);
    expect(admitted.read((state) => state.people[owner.user_id])).toMatchObject(
      {
        user_id: owner.user_id,
        org_id: owner.org_id,
        role: "guest",
        display_name: "Readmitted test owner",
        active: true,
      },
    );
    expect(f.store.exportSnapshot()).toEqual({
      ...seed,
      state: {
        ...seed.state,
        people: {
          ...seed.state.people,
          [owner.user_id]: {
            ...seed.state.people[owner.user_id],
            role: "guest",
            display_name: "Readmitted test owner",
          },
        },
      },
    });
  } finally {
    release.resolve();
    f.store.dispose();
  }
});

test("throwing and rejecting observers cannot undo a commit or starve healthy observers", async () => {
  const f = fixture();
  const seenTopics: string[] = [];
  const seenTags: string[] = [];
  const events: CommsEvent[] = [];
  f.store.subscribe(() => {
    throw new Error("Owned persistence-listener failure");
  });
  f.store.subscribe(() =>
    Promise.reject(new Error("Owned async listener failure")),
  );
  f.store.subscribe(() => {
    seenTopics.push(topic(f.handle, f.channelId));
  });
  f.handle.events.subscribe({
    ...observer([]),
    on_event: () => {
      throw new Error("Owned event observer failure");
    },
  });
  f.handle.events.subscribe({
    ...observer([]),
    on_event: () =>
      Promise.reject(new Error("Owned async event observer failure")),
  });
  f.handle.events.subscribe({
    ...observer(events),
    on_event: (event) => {
      events.push(event);
      seenTopics.push(topic(f.handle, f.channelId));
      seenTags.push(f.handle.version(f.key));
    },
  });
  try {
    const accepted = await f.handle.command(
      renameCommand(f, "Accepted before callbacks"),
    );
    await nextTurn(); // An escaped rejected callback is a runner failure, never globally suppressed.
    expect(accepted.value.topic).toBe("Accepted before callbacks");
    expect(topic(f.handle, f.channelId)).toBe("Accepted before callbacks");
    expect(seenTopics).toEqual([
      "Accepted before callbacks",
      "Accepted before callbacks",
    ]);
    expect(seenTags).toEqual([accepted.versions[f.key]]);
    expect(events).toHaveLength(1);
  } finally {
    f.store.dispose();
  }
});

test("unsubscribe, subscription abort and handle disposal detach only their own event observers", async () => {
  const f = fixture();
  const removed: CommsEvent[] = [];
  const aborted: CommsEvent[] = [];
  const disposed: CommsEvent[] = [];
  const live: CommsEvent[] = [];
  const connections: ConnectionState[] = [];
  const controller = new AbortController();
  const anotherHandle = f.store.bind(owner);
  const unsubscribe = f.handle.events.subscribe(observer(removed));
  f.handle.events.subscribe(observer(aborted), { signal: controller.signal });
  anotherHandle.events.subscribe(observer(disposed));
  f.handle.events.subscribe({
    ...observer(live),
    on_connection: (connection) => {
      connections.push(connection);
    },
  });
  try {
    unsubscribe();
    unsubscribe();
    controller.abort();
    anotherHandle.dispose();
    await f.handle.command(renameCommand(f, "Only current observers"));
    expect(connections).toContainEqual({ state: "live" });
    expect(live).toHaveLength(1);
    expect(removed).toEqual([]);
    expect(aborted).toEqual([]);
    expect(disposed).toEqual([]);
  } finally {
    f.store.dispose();
  }
});

test("reset inside an observer keeps the accepted result but stops old-generation deliveries", async () => {
  const f = fixture();
  const seed = structuredClone(f.store.exportSnapshot());
  const laterEvents: CommsEvent[] = [];
  f.handle.events.subscribe({
    ...observer([]),
    on_event: () => {
      f.store.reset();
    },
  });
  f.handle.events.subscribe(observer(laterEvents));
  try {
    const accepted = await f.handle.command(
      renameCommand(f, "Accepted before observer reset"),
    );
    expect(accepted.value.topic).toBe("Accepted before observer reset");
    expect(laterEvents).toEqual([]);
    expect(f.store.exportSnapshot()).toEqual(seed);
    expect(caught(() => f.handle.version(f.key))).toMatchObject({
      kind: "cancelled",
    });
  } finally {
    f.store.dispose();
  }
});

test("context is copied at binding and foreign or newly inactive identities cannot read or write", async () => {
  const f = fixture();
  const events: CommsEvent[] = [];
  f.handle.events.subscribe(observer(events));
  const suppliedContext = { ...owner };
  const bound = f.store.bind(suppliedContext);
  try {
    suppliedContext.org_id = otherOrg;
    suppliedContext.user_id = f.adminId;
    caught(() => Object.assign(bound.context, suppliedContext)); // A frozen copy may refuse mutation.
    expect(bound.context).toEqual(owner);
    expect(bound.read((_state, context) => context)).toEqual(owner);
    expect(caught(() => f.store.bind(suppliedContext))).toMatchObject({
      kind: "http",
      failure: { status: 404, body: { detail: { code: "comms_not_found" } } },
    });
    const deniedCommand = renameCommand(f, "Inactive identity must not write");
    await f.admin.command({
      authorize(current, execution) {
        if (current.people[execution.context.user_id].role !== "admin")
          throw new Error(
            "Owned identity update requires the fixture administrator",
          );
      },
      apply(draft) {
        draft.people[owner.user_id].active = false;
        return {
          kind: "commit",
          value: undefined,
          version_keys: [`person:${owner.user_id}`],
          publications: [],
        };
      },
    });
    const afterDeactivation = structuredClone(f.store.exportSnapshot());
    expect(caught(() => bound.read((state) => state.messages))).toMatchObject({
      kind: "http",
      failure: { status: 404 },
    });
    expect(caught(() => f.store.bind(owner))).toMatchObject({
      kind: "http",
      failure: { status: 404 },
    });
    await expect(bound.command(deniedCommand)).rejects.toMatchObject({
      kind: "http",
      failure: { status: 404 },
    });
    expect(f.store.exportSnapshot()).toEqual(afterDeactivation);
    expect(events).toEqual([]);
  } finally {
    f.store.dispose();
  }
});
