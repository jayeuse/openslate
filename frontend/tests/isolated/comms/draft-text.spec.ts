import { expect, test } from "@playwright/test";
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
  const userA = ownedCommsDraftTextId("user-a", composerId);
  const userB = ownedCommsDraftTextId("user-b", composerId);
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
    const userA = ownedCommsDraftTextId("user-a", composerId);
    const userB = ownedCommsDraftTextId("user-b", composerId);
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

  expect(storage.getItem(commsDraftTextKey(id))).toBe("legacy draft");
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
  expect(storage.getItem(commsDraftTextKey("thread-stale-clear"))).toBe(
    "newer draft",
  );
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
