import { expect, test } from "@playwright/test";
import { z } from "zod";

import {
  abandonUncertainDrafts,
  accessDraftJournalGeneration,
  accessDraftsHoldUncertainSave,
  accessDraftStorageKey,
  accessDraftSubmissionNeedsReload,
  beginDraftSubmission,
  clearAccessDraftStorageExcept,
  finishUncertainDraft,
  readDraft,
  removeSingleSlotDrafts,
  writeDraft,
  type AccessDraftStorage,
} from "../../../src/components/systems/access/state/draft-journal-storage";
import {
  readGroupDraft,
  writeGroupDraft,
} from "../../../src/components/systems/access/state/group-draft";
import {
  beginPersonSubmission,
  discardPersonDraft,
  personSubmissionNeedsReload,
  readPersonDraft,
  writePersonDraft,
} from "../../../src/components/systems/access/state/person-draft";

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

const personA = "00000000-0000-4000-8000-000000000101";
const personB = "00000000-0000-4000-8000-000000000102";
const details = {
  username: "ana",
  display_name: "Ana",
  job_title: "Clerk",
  role: "member" as const,
  sponsor_user_id: "",
  expires_on: "",
};

test("each person keeps their own draft, and an unanswered save blocks only that person", () => {
  const storage = memoryStorage();
  const user = "journal-owner";
  const draftA = {
    personId: personA,
    baseline: details,
    draft: { ...details, job_title: "Lead" },
  };
  const draftB = {
    personId: personB,
    baseline: details,
    draft: { ...details, display_name: "Bea" },
  };
  expect(writePersonDraft(user, draftA, storage)).toBe(true);
  expect(writePersonDraft(user, draftB, storage)).toBe(true);
  // Editing person B never replaces person A's kept draft.
  expect(readPersonDraft(user, personA, storage)).toEqual({
    status: "ready",
    value: draftA,
  });
  expect(readPersonDraft(user, personB, storage)).toEqual({
    status: "ready",
    value: draftB,
  });

  // A save of A that got no answer locks A, and B stays editable.
  expect(beginPersonSubmission(user, draftA, storage)).toBe(true);
  expect(readPersonDraft(user, personA, storage).status).toBe("uncertain");
  expect(personSubmissionNeedsReload(user, personA)).toBe(true);
  expect(personSubmissionNeedsReload(user, personB)).toBe(false);
  expect(
    writePersonDraft(
      user,
      { ...draftB, draft: { ...details, display_name: "Bianca" } },
      storage,
    ),
  ).toBe(true);
  expect(discardPersonDraft(user, personB, storage)).toBe(true);
  expect(readPersonDraft(user, personB, storage)).toEqual({
    status: "ready",
    value: null,
  });
  expect(readPersonDraft(user, personA, storage).status).toBe("uncertain");

  expect(clearAccessDraftStorageExcept(null, storage)).toBe(true);
});

test("each group keeps its own draft", () => {
  const storage = memoryStorage();
  const user = "group-journal-owner";
  const groupA = "00000000-0000-4000-8000-0000000000a1";
  const groupB = "00000000-0000-4000-8000-0000000000a2";
  const draft = (groupId: string, name: string) => ({
    groupId,
    details: {
      baseline: { name: "Old", description: "" },
      draft: { name, description: "" },
    },
    members: null,
    access: null,
    sending: null,
  });
  expect(writeGroupDraft(user, draft(groupA, "Clerks"), storage)).toBe(true);
  expect(writeGroupDraft(user, draft(groupB, "Readers"), storage)).toBe(true);
  expect(readGroupDraft(user, groupA, storage).value).toEqual(
    draft(groupA, "Clerks"),
  );
  expect(readGroupDraft(user, groupB, storage).value).toEqual(
    draft(groupB, "Readers"),
  );
});

test("a discard that the browser refuses reports that the draft is still kept", () => {
  const storage = memoryStorage();
  const user = "refused-discard";
  const draft = {
    personId: personA,
    baseline: details,
    draft: { ...details, job_title: "Lead" },
  };
  expect(writePersonDraft(user, draft, storage)).toBe(true);
  const refusing: AccessDraftStorage = {
    get length() {
      return storage.length;
    },
    key: (index) => storage.key(index),
    getItem: (key) => storage.getItem(key),
    setItem: () => {
      throw new Error("storage blocked");
    },
    removeItem: () => {
      throw new Error("storage blocked");
    },
  };
  expect(discardPersonDraft(user, personA, refusing)).toBe(false);
  expect(readPersonDraft(user, personA, storage).value).toEqual(draft);
  // Without any storage nothing was kept, so there is nothing to discard.
  expect(discardPersonDraft(user, personA, undefined)).toBe(true);
});

test("a save that may have completed is found after its editor closes and is forgotten only on request", () => {
  const storage = memoryStorage();
  const user = "page-guard-owner";
  const draft = {
    personId: personA,
    baseline: details,
    draft: { ...details, job_title: "Lead" },
  };
  expect(writePersonDraft(user, draft, storage)).toBe(true);
  expect(
    writeDraft("someone-else", "group", payload, groupDraft, target, storage),
  ).toBe(true);
  expect(
    beginDraftSubmission(
      "someone-else",
      "group",
      payload,
      groupDraft,
      target,
      storage,
    ),
  ).toBe(true);
  // Another account's unanswered save is not this account's.
  expect(accessDraftsHoldUncertainSave(user, storage)).toBe(false);

  expect(beginPersonSubmission(user, draft, storage)).toBe(true);
  expect(accessDraftsHoldUncertainSave(user, storage)).toBe(true);
  expect(abandonUncertainDrafts(user, storage)).toBe(true);
  expect(accessDraftsHoldUncertainSave(user, storage)).toBe(false);
  expect(readPersonDraft(user, personA, storage)).toEqual({
    status: "ready",
    value: null,
  });
  expect(personSubmissionNeedsReload(user, personA)).toBe(false);
  expect(accessDraftsHoldUncertainSave("someone-else", storage)).toBe(true);
  expect(clearAccessDraftStorageExcept(null, storage)).toBe(true);
});

test("clearing the journal marks a new generation, so a late save writes nothing back", () => {
  const storage = memoryStorage();
  const before = accessDraftJournalGeneration();
  expect(write("generation-owner", storage)).toBe(true);
  // A verified window return keeps the account's drafts: same generation.
  expect(clearAccessDraftStorageExcept("generation-owner", storage)).toBe(true);
  expect(accessDraftJournalGeneration()).toBe(before);
  // Sign-out or an organization switch clears them: a new generation.
  expect(clearAccessDraftStorageExcept(null, storage)).toBe(true);
  expect(accessDraftJournalGeneration()).not.toBe(before);
});

test("the drafts of the old one-slot journal are removed for this account only", () => {
  const storage = memoryStorage();
  const user = "slot-owner";
  storage.setItem(accessDraftStorageKey(user, "identity"), "old person draft");
  storage.setItem(accessDraftStorageKey(user, "group"), "old group draft");
  storage.setItem(accessDraftStorageKey("other", "identity"), "other draft");
  const draft = {
    personId: personA,
    baseline: details,
    draft: { ...details, job_title: "Lead" },
  };
  expect(writePersonDraft(user, draft, storage)).toBe(true);

  removeSingleSlotDrafts(user, storage);
  expect(storage.getItem(accessDraftStorageKey(user, "identity"))).toBeNull();
  expect(storage.getItem(accessDraftStorageKey(user, "group"))).toBeNull();
  expect(storage.getItem(accessDraftStorageKey("other", "identity"))).toBe(
    "other draft",
  );
  expect(readPersonDraft(user, personA, storage).value).toEqual(draft);
});
