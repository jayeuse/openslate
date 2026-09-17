import { expect, test } from "@playwright/test";

import {
  restoreSampleSessionSnapshot,
  sampleSessionSnapshotStorageKey,
  serializeSampleSessionSnapshot,
} from "../../../src/components/systems/shared/runtime/sample-state";
import {
  clearVerifiedWorkspaceSessionSnapshot,
  workspaceSessionSnapshotStorageKey,
} from "../../../src/components/systems/shared/runtime/workspace-identity";
import {
  commsDraftTextKey,
  ownedCommsDraftTextId,
} from "../../../src/components/systems/comms/state/draft-text";

test("workspace state reloads only for the same verified account", () => {
  const saved = serializeSampleSessionSnapshot("user-a", {
    "sandbox.design": { changed: true },
  });

  expect(restoreSampleSessionSnapshot(saved, "user-a")).toEqual({
    recovered: false,
    values: { "sandbox.design": { changed: true } },
  });
});

test("workspace state remains private across account switches in one tab", () => {
  const snapshots = new Map<string, string>();
  snapshots.set(
    sampleSessionSnapshotStorageKey("user-a"),
    serializeSampleSessionSnapshot("user-a", {
      "sandbox.design": { changed: true },
    }),
  );

  expect(
    restoreSampleSessionSnapshot(
      snapshots.get(sampleSessionSnapshotStorageKey("user-b")) ?? null,
      "user-b",
    ),
  ).toEqual({
    recovered: false,
    values: {},
  });
  expect(
    restoreSampleSessionSnapshot(
      snapshots.get(sampleSessionSnapshotStorageKey("user-a")) ?? null,
      "user-a",
    ),
  ).toEqual({
    recovered: false,
    values: { "sandbox.design": { changed: true } },
  });
});

test("legacy or unowned workspace state is not restored", () => {
  const saved = JSON.stringify({
    "sandbox.design": { changed: true },
  });

  expect(restoreSampleSessionSnapshot(saved, "user-b")).toEqual({
    recovered: false,
    values: {},
  });
  expect(restoreSampleSessionSnapshot(null, "user-b")).toEqual({
    recovered: false,
    values: {},
  });
});

test("unreadable saved workspace state remains recoverable", () => {
  expect(restoreSampleSessionSnapshot("{", "user-a")).toEqual({
    recovered: true,
    values: {},
  });
});

test("shell-only cleanup removes only the verified account's workspace state", async () => {
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
    data.set("openslate.sample.v1", "legacy workspace");
    data.set(workspaceSessionSnapshotStorageKey("user-a"), "A workspace");
    data.set(workspaceSessionSnapshotStorageKey("user-b"), "B workspace");
    data.set(commsDraftTextKey("thread-1"), "legacy draft");
    data.set(
      commsDraftTextKey(ownedCommsDraftTextId("user-a", "thread-1")),
      "A draft",
    );
    data.set(
      commsDraftTextKey(ownedCommsDraftTextId("user-b", "thread-1")),
      "B draft",
    );

    await clearVerifiedWorkspaceSessionSnapshot("user-a");

    expect(
      data.get(workspaceSessionSnapshotStorageKey("user-a")),
    ).toBeUndefined();
    expect(data.get(workspaceSessionSnapshotStorageKey("user-b"))).toBe(
      "B workspace",
    );
    expect(data.get("openslate.sample.v1")).toBe("legacy workspace");
    expect(
      data.get(commsDraftTextKey(ownedCommsDraftTextId("user-a", "thread-1"))),
    ).toBeUndefined();
    expect(
      data.get(commsDraftTextKey(ownedCommsDraftTextId("user-b", "thread-1"))),
    ).toBe("B draft");
    expect(data.get(commsDraftTextKey("thread-1"))).toBe("legacy draft");
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalStorage)
      Object.defineProperty(globalThis, "sessionStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
