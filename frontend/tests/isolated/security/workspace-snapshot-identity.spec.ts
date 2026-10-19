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
import { accessDraftStorageKey } from "../../../src/components/systems/access/state/draft-journal-storage";
import {
  commsDraftTextKey,
  ownedCommsDraftTextId,
} from "../../../src/components/systems/comms/state/draft-text";

test("workspace snapshots bind all draft parts to the admitted organization in both key and envelope", () => {
  const values = {
    "comms-draft-files-channel": [{ id: "file-a", name: "A.pdf" }],
    "comms-draft-record-channel": "record-a",
    "comms-replying-to": "message-a",
    "comms-draft-text-thread": "A reply",
  };
  const saved = serializeSampleSessionSnapshot("user-a", values, "org-a");
  expect(restoreSampleSessionSnapshot(saved, "user-a", "org-a")).toEqual({
    recovered: false,
    values,
  });
  expect(restoreSampleSessionSnapshot(saved, "user-a", "org-b")).toEqual({
    recovered: false,
    values: {},
  });
  expect(sampleSessionSnapshotStorageKey("user-a", "org-a")).not.toBe(
    sampleSessionSnapshotStorageKey("user-a", "org-b"),
  );
});

test("a user-only snapshot has no provable organization and is not adopted", () => {
  const legacy = JSON.stringify({
    userId: "user-a",
    values: { "comms-draft-files-channel": [{ id: "file-a" }] },
  });
  expect(restoreSampleSessionSnapshot(legacy, "user-a", "org-a")).toEqual({
    recovered: false,
    values: {},
  });
});

test("workspace state reloads only for the same verified account", () => {
  const saved = serializeSampleSessionSnapshot(
    "user-a",
    { "sandbox.design": { changed: true } },
    "org-a",
  );

  expect(restoreSampleSessionSnapshot(saved, "user-a", "org-a")).toEqual({
    recovered: false,
    values: { "sandbox.design": { changed: true } },
  });
});

test("workspace state remains private across account switches in one tab", () => {
  const snapshots = new Map<string, string>();
  snapshots.set(
    sampleSessionSnapshotStorageKey("user-a", "org-a"),
    serializeSampleSessionSnapshot(
      "user-a",
      { "sandbox.design": { changed: true } },
      "org-a",
    ),
  );

  expect(
    restoreSampleSessionSnapshot(
      snapshots.get(sampleSessionSnapshotStorageKey("user-b", "org-a")) ?? null,
      "user-b",
      "org-a",
    ),
  ).toEqual({
    recovered: false,
    values: {},
  });
  expect(
    restoreSampleSessionSnapshot(
      snapshots.get(sampleSessionSnapshotStorageKey("user-a", "org-a")) ?? null,
      "user-a",
      "org-a",
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

  expect(restoreSampleSessionSnapshot(saved, "user-b", "org-a")).toEqual({
    recovered: false,
    values: {},
  });
  expect(restoreSampleSessionSnapshot(null, "user-b", "org-a")).toEqual({
    recovered: false,
    values: {},
  });
});

test("unreadable saved workspace state remains recoverable", () => {
  expect(restoreSampleSessionSnapshot("{", "user-a", "org-a")).toEqual({
    recovered: true,
    values: {},
  });
});

test("session cleanup removes Access drafts without deleting another account's sample state", async () => {
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
    value: { sessionStorage: storage },
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: storage,
  });
  try {
    data.set("openslate.sample.v1", "legacy workspace");
    data.set(
      workspaceSessionSnapshotStorageKey("user-a", "org-a"),
      "A workspace",
    );
    data.set(
      workspaceSessionSnapshotStorageKey("user-b", "org-a"),
      "B workspace",
    );
    data.set(accessDraftStorageKey("user-a", "identity"), "A Access draft");
    data.set(accessDraftStorageKey("user-b", "identity"), "B Access draft");
    data.set(commsDraftTextKey("thread-1"), "legacy draft");
    data.set(
      commsDraftTextKey(ownedCommsDraftTextId("user-a", "thread-1", "org-a")),
      "A draft",
    );
    data.set(
      commsDraftTextKey(ownedCommsDraftTextId("user-b", "thread-1", "org-a")),
      "B draft",
    );

    await clearVerifiedWorkspaceSessionSnapshot("user-a");

    expect(
      data.get(workspaceSessionSnapshotStorageKey("user-a", "org-a")),
    ).toBeUndefined();
    expect(
      data.get(workspaceSessionSnapshotStorageKey("user-b", "org-a")),
    ).toBe("B workspace");
    expect(data.get("openslate.sample.v1")).toBe("legacy workspace");
    expect(
      data.get(accessDraftStorageKey("user-a", "identity")),
    ).toBeUndefined();
    expect(
      data.get(accessDraftStorageKey("user-b", "identity")),
    ).toBeUndefined();
    expect(
      data.get(
        commsDraftTextKey(ownedCommsDraftTextId("user-a", "thread-1", "org-a")),
      ),
    ).toBeUndefined();
    expect(
      data.get(
        commsDraftTextKey(ownedCommsDraftTextId("user-b", "thread-1", "org-a")),
      ),
    ).toBe("B draft");
    expect(data.get(commsDraftTextKey("thread-1"))).toBe("legacy draft");

    data.set(accessDraftStorageKey("user-a", "identity"), "A after reload");
    await clearVerifiedWorkspaceSessionSnapshot(null);
    expect(
      data.get(accessDraftStorageKey("user-a", "identity")),
    ).toBeUndefined();
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalStorage)
      Object.defineProperty(globalThis, "sessionStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
