import { expect, test } from "@playwright/test";
import {
  clearVerifiedWorkspaceSessionSnapshot,
  registerWorkspaceSessionClear,
} from "../../../src/components/systems/shared/runtime/workspace-identity";
import {
  clearCommsDraftTextStore,
  commsDraftTextKey,
  COMMS_DRAFT_TEXT_PREFIX,
  createCommsDraftTextStore,
  legacyCommsDraftTextKey,
  ownedCommsDraftTextId,
} from "../../../src/components/systems/comms/state/draft-text";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
  };
}

test("the same composer cannot restore another organization's draft or a swapped envelope", () => {
  const storage = memoryStorage();
  const a = ownedCommsDraftTextId("user-a", "thread", "org-a");
  const b = ownedCommsDraftTextId("user-a", "thread", "org-b");
  const draftA = createCommsDraftTextStore(a, "", storage);
  draftA.setValue("Organization A draft");
  expect(createCommsDraftTextStore(b, "", storage).getSnapshot().value).toBe(
    "",
  );
  storage.setItem(commsDraftTextKey(b), storage.getItem(commsDraftTextKey(a))!);
  expect(createCommsDraftTextStore(b, "", storage).getSnapshot().value).toBe(
    "",
  );
  expect(createCommsDraftTextStore(a, "", storage).getSnapshot().value).toBe(
    "Organization A draft",
  );
});

test("session reset retires captured draft writers as well as pending clears", async () => {
  const memory = memoryStorage();
  let blocked = false;
  const storage = {
    ...memory,
    setItem(key: string, value: string) {
      if (blocked) throw new DOMException("Blocked storage", "SecurityError");
      memory.setItem(key, value);
    },
    removeItem(key: string) {
      if (blocked) throw new DOMException("Blocked storage", "SecurityError");
      memory.removeItem(key);
    },
  };
  const id = ownedCommsDraftTextId("user-a", "thread", "org-a");
  const store = createCommsDraftTextStore(id, "", storage);
  store.setValue("Before cleanup");
  store.reset();
  store.setValue("Late callback");
  store.applyStorageValue(JSON.stringify({ id, value: "Late storage event" }));
  expect(await store.clear()).toBe(false);
  expect(store.getSnapshot().value).toBe("");
  expect(storage.getItem(commsDraftTextKey(id))).toBeNull();
  const next = createCommsDraftTextStore(id, "", storage);
  next.setValue("Newly admitted context");
  expect(next.getSnapshot().value).toBe("Newly admitted context");

  // A captured writer is not reachable through the UI after its owner unmounts.
  // Keep this protection here; the HTTP reset journey owns remount/usability.
  const capturedWriter = next.setValue;
  const uncleared = storage.getItem(commsDraftTextKey(id));
  blocked = true;
  next.reset();
  expect(next.getSnapshot().value).toBe("");
  expect(next.getSnapshot().storageUnavailable).toBe(true);
  expect(storage.getItem(commsDraftTextKey(id))).toBe(uncleared);

  // Recovery of the dependency must not revive the pre-reset owner's authority.
  blocked = false;
  capturedWriter("Late callback after failed removal");
  next.applyStorageValue(JSON.stringify({ id, value: "Late storage event" }));
  expect(await next.clear()).toBe(false);
  expect(next.getSnapshot().value).toBe("");
  expect(next.getSnapshot().storageUnavailable).toBe(true);
  expect(storage.getItem(commsDraftTextKey(id))).toBe(uncleared);
});

// A registered in-memory cleanup listener cannot be made to throw through a
// supported UI action; exercise that boundary without injecting browser modules.
test("a failed workspace cleanup listener reports failure and still clears other listeners and Comms drafts", async () => {
  const memory = memoryStorage();
  const storage = {
    ...memory,
    get length() {
      return memory.data.size;
    },
    key(index: number) {
      return [...memory.data.keys()][index] ?? null;
    },
  };
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { sessionStorage: storage },
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: storage,
  });
  const userId = "listener-cleanup-owner";
  const key = commsDraftTextKey(
    ownedCommsDraftTextId(userId, "composer", "org-a"),
  );
  storage.setItem(key, "Owned draft");
  let otherListenerCleared = false;
  const unregisterFailure = registerWorkspaceSessionClear(userId, () => {
    throw new Error("Owned listener failure");
  });
  const unregisterOther = registerWorkspaceSessionClear(userId, () => {
    otherListenerCleared = true;
  });
  try {
    expect(await clearVerifiedWorkspaceSessionSnapshot(userId)).toBe(false);
    expect(otherListenerCleared).toBe(true);
    expect(storage.getItem(key)).toBeNull();
  } finally {
    unregisterFailure();
    unregisterOther();
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalStorage)
      Object.defineProperty(globalThis, "sessionStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("draft subscribers receive a new snapshot when text changes", () => {
  const storage = memoryStorage();
  const store = createCommsDraftTextStore("thread-immutable", "", storage);
  const before = store.getSnapshot();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });

  store.setValue("new draft");

  expect(notifications).toBe(1);
  expect(store.getSnapshot()).not.toBe(before);
  expect(store.getSnapshot().value).toBe("new draft");
  unsubscribe();
});

test("owned Comms drafts restore for their account without crossing accounts", () => {
  const storage = memoryStorage();
  const composerId = "thread-identity";
  const userA = ownedCommsDraftTextId("user-a", composerId, "org-a");
  const userB = ownedCommsDraftTextId("user-b", composerId, "org-a");
  storage.setItem(commsDraftTextKey(composerId), "legacy unowned draft");
  const draftA = createCommsDraftTextStore(userA, "", storage);
  draftA.setValue("A's private draft");

  expect(
    createCommsDraftTextStore(userA, "", storage).getSnapshot().value,
  ).toBe("A's private draft");
  expect(
    createCommsDraftTextStore(userB, "", storage).getSnapshot().value,
  ).toBe("");
  expect(
    createCommsDraftTextStore(userA, "", storage).getSnapshot().value,
  ).toBe("A's private draft");
});

test("owned Comms draft cleanup removes only the active account", () => {
  const data = new Map<string, string>();
  const storage = {
    get length() {
      return data.size;
    },
    key(index: number) {
      return [...data.keys()][index] ?? null;
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
  } as unknown as Storage;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: storage,
  });
  try {
    const composerId = "thread-logout";
    const userA = ownedCommsDraftTextId("user-a", composerId, "org-a");
    const userB = ownedCommsDraftTextId("user-b", composerId, "org-a");
    const legacy = commsDraftTextKey(composerId);
    storage.setItem(commsDraftTextKey(userA), "A's draft");
    storage.setItem(commsDraftTextKey(userB), "B's draft");
    storage.setItem(legacy, "legacy unowned draft");

    clearCommsDraftTextStore("user-a");

    expect(storage.getItem(commsDraftTextKey(userA))).toBeNull();
    expect(storage.getItem(commsDraftTextKey(userB))).toBe("B's draft");
    expect(storage.getItem(legacy)).toBe("legacy unowned draft");
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalStorage)
      Object.defineProperty(globalThis, "sessionStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("legacy text migrates to the dedicated key before cleanup completes", async () => {
  const storage = memoryStorage();
  const id = "thread-migrate";
  const legacyKey = legacyCommsDraftTextKey(id);
  storage.setItem(legacyKey, "legacy draft");
  const store = createCommsDraftTextStore(id, "legacy draft", storage);
  let resolveCleanup!: () => void;
  let markCleanupStarted!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    markCleanupStarted = resolve;
  });
  const cleanupFinished = new Promise<void>((resolve) => {
    resolveCleanup = resolve;
  });

  store.migrate(async () => {
    markCleanupStarted();
    await cleanupFinished;
    storage.removeItem(legacyKey);
  });
  await cleanupStarted;

  expect(JSON.parse(storage.getItem(commsDraftTextKey(id))!).value).toBe(
    "legacy draft",
  );
  expect(store.getSnapshot().value).toBe("legacy draft");
  expect(store.getSnapshot().legacyPending).toBe(true);

  const migrated = new Promise<void>((resolve) => {
    const unsubscribe = store.subscribe(() => {
      if (!store.getSnapshot().legacyPending) {
        unsubscribe();
        resolve();
      }
    });
  });
  resolveCleanup();
  await cleanupFinished;
  await migrated;
  expect(storage.getItem(legacyKey)).toBeNull();
  expect(store.getSnapshot().legacyPending).toBe(false);
});

test("accepted clear keeps newer text that arrived while legacy cleanup was pending", async () => {
  const storage = memoryStorage();
  const store = createCommsDraftTextStore("thread-stale-clear", "", storage);
  store.setValue("submitted draft");
  const submittedRevision = store.getSnapshot().revision;
  let resolveCleanup!: () => void;
  let markCleanupStarted!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    markCleanupStarted = resolve;
  });
  const cleanupFinished = new Promise<void>((resolve) => {
    resolveCleanup = resolve;
  });

  const clear = store.clear(submittedRevision, async () => {
    markCleanupStarted();
    await cleanupFinished;
  });
  await cleanupStarted;
  store.setValue("newer draft");
  resolveCleanup();

  expect(await clear).toBe(false);
  expect(store.getSnapshot().value).toBe("newer draft");
  expect(
    JSON.parse(storage.getItem(commsDraftTextKey("thread-stale-clear"))!).value,
  ).toBe("newer draft");
});

test("canceled legacy migration cannot update an old composer entry", async () => {
  const storage = memoryStorage();
  const id = "thread-key-change";
  const store = createCommsDraftTextStore(id, "legacy draft", storage);
  let resolveCleanup!: () => void;
  let markCleanupStarted!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    markCleanupStarted = resolve;
  });
  const cleanupFinished = new Promise<void>((resolve) => {
    resolveCleanup = resolve;
  });

  const cancelMigration = store.migrate(async () => {
    markCleanupStarted();
    await cleanupFinished;
  });
  await cleanupStarted;
  cancelMigration();
  resolveCleanup();
  await cleanupFinished;
  await Promise.resolve();
  await Promise.resolve();

  expect(store.getSnapshot().legacyPending).toBe(true);
  expect(store.getSnapshot().value).toBe("legacy draft");
});

test("reset invalidates an in-flight clear without resurrecting its storage key", async () => {
  const storage = memoryStorage();
  const id = "thread-reset-clear";
  const store = createCommsDraftTextStore(id, "", storage);
  store.setValue("submitted draft");
  const submittedRevision = store.getSnapshot().revision;
  let resolveCleanup!: () => void;
  let markCleanupStarted!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    markCleanupStarted = resolve;
  });
  const cleanupFinished = new Promise<void>((resolve) => {
    resolveCleanup = resolve;
  });

  const clear = store.clear(submittedRevision, async () => {
    markCleanupStarted();
    await cleanupFinished;
  });
  await cleanupStarted;
  store.reset();
  expect(storage.getItem(commsDraftTextKey(id))).toBeNull();
  resolveCleanup();

  expect(await clear).toBe(false);
  expect(store.getSnapshot().value).toBe("");
  expect(storage.getItem(commsDraftTextKey(id))).toBeNull();
});

test("Comms draft keys encode composer ids and reset cleanup clears dedicated values", () => {
  const data = new Map<string, string>();
  const storage = {
    get length() {
      return data.size;
    },
    key(index: number) {
      return [...data.keys()][index] ?? null;
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
  } as unknown as Storage;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: storage,
  });
  try {
    const dedicated = commsDraftTextKey("thread/42?reply");
    expect(dedicated).toBe(`${COMMS_DRAFT_TEXT_PREFIX}thread%2F42%3Freply`);
    expect(legacyCommsDraftTextKey("thread/42?reply")).toBe(
      "comms-draft-text-thread/42?reply",
    );
    storage.setItem(dedicated, "keep this draft");
    storage.setItem(`${COMMS_DRAFT_TEXT_PREFIX}other`, "another draft");
    clearCommsDraftTextStore();
    expect(storage.length).toBe(0);
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalStorage)
      Object.defineProperty(globalThis, "sessionStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("blocked sessionStorage access retains legacy text and reports unavailable persistence", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() {
      throw new DOMException("Blocked storage", "SecurityError");
    },
  });
  try {
    const store = createCommsDraftTextStore("blocked-browser", "legacy draft");
    let cleaned = false;
    store.migrate(() => {
      cleaned = true;
    });
    await Promise.resolve();
    expect(store.getSnapshot().storageUnavailable).toBe(true);
    expect(store.getSnapshot().value).toBe("legacy draft");
    expect(store.getSnapshot().legacyPending).toBe(true);
    expect(cleaned).toBe(false);
    store.setValue("retained in memory");
    expect(store.getSnapshot().value).toBe("retained in memory");
    expect(store.getSnapshot().storageUnavailable).toBe(true);
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalStorage)
      Object.defineProperty(globalThis, "sessionStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
