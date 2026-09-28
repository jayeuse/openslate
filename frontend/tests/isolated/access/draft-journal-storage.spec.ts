import { expect, test } from "@playwright/test";
import { z } from "zod";

import {
  accessDraftSubmissionNeedsReload,
  beginDraftSubmission,
  clearAccessDraftStorageExcept,
  finishUncertainDraft,
  readDraft,
  writeDraft,
  type AccessDraftStorage,
} from "../../../src/components/systems/access/state/draft-journal-storage";

function memoryStorage(): AccessDraftStorage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

const groupDraft = z.strictObject({ id: z.string(), name: z.string() });
type GroupDraft = z.output<typeof groupDraft>;
const target = (value: GroupDraft) => `group:${value.id}`;
const payload: GroupDraft = { id: "g1", name: "Dispatch" };

function write(user: string, storage: AccessDraftStorage) {
  return writeDraft(user, "group", payload, groupDraft, target, storage);
}
function read(user: string, storage: AccessDraftStorage) {
  return readDraft(user, "group", groupDraft, target, storage);
}

test("Access draft cleanup keeps only the active user and reports blocked storage", () => {
  const storage = memoryStorage();
  expect(write("user-a", storage)).toBe(true);
  expect(write("user-b", storage)).toBe(true);
  expect(write("user-b.extra", storage)).toBe(true);

  expect(clearAccessDraftStorageExcept("user-b", storage)).toBe(true);
  expect(read("user-a", storage).value).toBeNull();
  expect(read("user-b", storage).value).toEqual(payload);
  // A user id that extends another one is a different account.
  expect(read("user-b.extra", storage).value).toBeNull();

  expect(clearAccessDraftStorageExcept(null, storage)).toBe(true);
  expect(read("user-b", storage).value).toBeNull();

  const blocked: AccessDraftStorage = {
    ...storage,
    setItem: () => {
      throw new Error("storage blocked");
    },
  };
  expect(write("user-c", blocked)).toBe(false);
});

test("an uncertain submission stays locked until it is confirmed or its account leaves", () => {
  const storage = memoryStorage();
  const user = "uncertain-group-owner";
  expect(
    beginDraftSubmission(user, "group", payload, groupDraft, target, storage),
  ).toBe(true);
  expect(read(user, storage)).toEqual({ status: "uncertain", value: payload });
  expect(accessDraftSubmissionNeedsReload(user, "group")).toBe(true);

  // The saved values cannot become an editable draft again.
  expect(write(user, storage)).toBe(false);
  // The same document cannot discard its own dispatched submission.
  expect(
    finishUncertainDraft(user, "group", groupDraft, target, storage, false),
  ).toBe(false);

  // Leaving the account releases the document guard with the stored key.
  expect(clearAccessDraftStorageExcept("someone-else", storage)).toBe(true);
  expect(accessDraftSubmissionNeedsReload(user, "group")).toBe(false);
  expect(read(user, storage)).toEqual({ status: "ready", value: null });
});
