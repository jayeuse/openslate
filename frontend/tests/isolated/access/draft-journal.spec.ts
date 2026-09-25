import { expect, test } from "@playwright/test";

import {
  accessDraftSubmissionNeedsReload,
  accessDraftStorageKey,
  beginAccessDefaultsDraftSubmission,
  beginAccessGroupDraftSubmission,
  beginAccessIdentityDraftSubmission,
  beginAccessRoleDraftSubmission,
  beginAccessRulesDraftSubmission,
  clearAccessDraftStorageExcept,
  clearAccessDraftStorageForUser,
  clearAccessDefaultsDraft,
  clearAccessGroupDraft,
  clearAccessIdentityDraft,
  clearAccessRoleDraft,
  clearAccessRulesDraft,
  completeAccessDefaultsDraftSubmission,
  completeAccessGroupDraftSubmission,
  completeAccessIdentityDraftSubmission,
  completeAccessRoleDraftSubmission,
  completeAccessRulesDraftSubmission,
  discardUncertainAccessRoleDraft,
  readAccessDefaultsDraft,
  readAccessGroupDraft,
  readAccessIdentityDraft,
  readAccessRoleDraft,
  readAccessRulesDraft,
  writeAccessDefaultsDraft,
  writeAccessGroupDraft,
  writeAccessIdentityDraft,
  writeAccessRoleDraft,
  writeAccessRulesDraft,
  type AccessDraftStorage,
} from "../../../src/components/systems/access/state/draft-journal";

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

const selection = {
  subject: { kind: "everyone" as const },
  scope: { kind: "workspace" as const, id: "workspace" },
};
const draft = {
  id: "rule:everyone:everyone:workspace:records.read",
  subject: selection.subject,
  scope: selection.scope,
  permissionId: "records.read",
  decision: "allow" as const,
};
const payload = {
  selection,
  drafts: [draft],
  baselines: { "records.read": null },
};

test("Rules drafts are tab-local, user-bound, and explicitly cleared", () => {
  const storage = memoryStorage();
  expect(writeAccessRulesDraft("user-a", payload, storage)).toBe(true);
  expect(readAccessRulesDraft("user-a", storage)).toEqual({
    status: "ready",
    value: payload,
  });
  expect(readAccessRulesDraft("user-b", storage)).toEqual({
    status: "ready",
    value: null,
  });

  expect(clearAccessRulesDraft("user-a", storage)).toBe(true);
  expect(readAccessRulesDraft("user-a", storage).value).toBeNull();
});

test("Rules journal rejects tampered ownership, target, fields, and oversized records", () => {
  const storage = memoryStorage();
  expect(writeAccessRulesDraft("user-a", payload, storage)).toBe(true);
  const key = accessDraftStorageKey("user-a", "rules");
  const record = JSON.parse(storage.getItem(key) ?? "") as Record<
    string,
    unknown
  >;

  for (const tampered of [
    { ...record, userId: "user-b" },
    { ...record, target: "everyone:other" },
    { ...record, version: 2 },
    {
      ...record,
      payload: { ...payload, drafts: [{ ...draft, password: "hidden" }] },
    },
    {
      ...record,
      payload: { ...payload, drafts: [{ ...draft, startsAt: "not-a-date" }] },
    },
    {
      ...record,
      payload: {
        ...payload,
        drafts: [{ ...draft, startsAt: "2026-02-30T12:30:00Z" }],
      },
    },
  ]) {
    storage.setItem(key, JSON.stringify(tampered));
    expect(readAccessRulesDraft("user-a", storage)).toEqual({
      status: "invalid",
      value: null,
    });
  }

  storage.setItem(key, "x".repeat(33_000));
  expect(readAccessRulesDraft("user-a", storage).status).toBe("invalid");

  expect(
    writeAccessRulesDraft(
      "user-a",
      {
        ...payload,
        drafts: [{ ...draft, startsAt: "2026-09-23T12:30:00.000Z" }],
      },
      storage,
    ),
  ).toBe(true);
  expect(readAccessRulesDraft("user-a", storage).status).toBe("ready");
  expect(
    writeAccessRulesDraft(
      "user-a",
      {
        ...payload,
        drafts: [{ ...draft, startsAt: "2026-09-23T12:30:00+08:00" }],
      },
      storage,
    ),
  ).toBe(true);
});

test("Access draft cleanup keeps only the active user and reports blocked storage", () => {
  const storage = memoryStorage();
  writeAccessRulesDraft("user-a", payload, storage);
  writeAccessRulesDraft("user-b", payload, storage);
  writeAccessRulesDraft("user-b.extra", payload, storage);
  expect(clearAccessDraftStorageExcept("user-b", storage)).toBe(true);
  expect(readAccessRulesDraft("user-a", storage).value).toBeNull();
  expect(readAccessRulesDraft("user-b", storage).value).toEqual(payload);
  expect(readAccessRulesDraft("user-b.extra", storage).value).toBeNull();
  expect(clearAccessDraftStorageForUser("user-b", storage)).toBe(true);
  expect(readAccessRulesDraft("user-b", storage).value).toBeNull();

  writeAccessRulesDraft("user-b", payload, storage);
  writeAccessRulesDraft("user-b.extra", payload, storage);
  expect(clearAccessDraftStorageForUser("user-b", storage)).toBe(true);
  expect(readAccessRulesDraft("user-b", storage).value).toBeNull();
  expect(readAccessRulesDraft("user-b.extra", storage).value).toEqual(payload);

  const blocked: AccessDraftStorage = {
    ...storage,
    setItem: () => {
      throw new Error("storage blocked");
    },
  };
  expect(writeAccessRulesDraft("user-c", payload, blocked)).toBe(false);
});

test("account cleanup releases only current-document guards whose keys were removed", () => {
  const storage = memoryStorage();
  const departingUser = "boundary-guard-departing";
  const activeUser = "boundary-guard-active";
  const roleDraft = {
    intent: "create" as const,
    baseline: {
      id: "draft:new-role",
      name: "",
      description: "",
      builtin: false,
      grants: [],
    },
    values: { name: "Shift lead", description: "", grants: [] },
  };
  expect(beginAccessRulesDraftSubmission(departingUser, payload, storage)).toBe(
    true,
  );
  expect(
    beginAccessRoleDraftSubmission(departingUser, roleDraft, storage),
  ).toBe(true);
  expect(beginAccessRoleDraftSubmission(activeUser, roleDraft, storage)).toBe(
    true,
  );

  const partiallyBlocked: AccessDraftStorage = {
    ...storage,
    removeItem: (key) => {
      if (key === accessDraftStorageKey(departingUser, "role"))
        throw new Error("role removal blocked");
      storage.removeItem(key);
    },
  };
  expect(clearAccessDraftStorageForUser(departingUser, partiallyBlocked)).toBe(
    false,
  );
  expect(accessDraftSubmissionNeedsReload(departingUser, "rules")).toBe(false);
  expect(accessDraftSubmissionNeedsReload(departingUser, "role")).toBe(true);
  expect(accessDraftSubmissionNeedsReload(activeUser, "role")).toBe(true);

  expect(clearAccessDraftStorageExcept(activeUser, storage)).toBe(true);
  expect(accessDraftSubmissionNeedsReload(departingUser, "role")).toBe(false);
  expect(accessDraftSubmissionNeedsReload(activeUser, "role")).toBe(true);
  expect(clearAccessDraftStorageForUser(activeUser, storage)).toBe(true);
  expect(accessDraftSubmissionNeedsReload(activeUser, "role")).toBe(false);
});

test("Defaults journal preserves editable settings and their opening baseline only", () => {
  const storage = memoryStorage();
  const baseline = {
    defaultRoleId: "member-role",
    defaultDepartmentIds: [],
    defaultGroupIds: [],
    invitationExpiryDays: 14,
    guestDurationDays: 30,
    serviceDurationDays: 90,
  };
  const draft = { ...baseline, invitationExpiryDays: 21 };
  expect(writeAccessDefaultsDraft("user-a", { baseline, draft }, storage)).toBe(
    true,
  );
  expect(readAccessDefaultsDraft("user-a", storage)).toEqual({
    status: "ready",
    value: { baseline, draft },
  });
  const key = accessDraftStorageKey("user-a", "defaults");
  const record = JSON.parse(storage.getItem(key) ?? "") as Record<
    string,
    unknown
  >;
  storage.setItem(
    key,
    JSON.stringify({
      ...record,
      payload: { baseline, draft, password: "secret" },
    }),
  );
  expect(readAccessDefaultsDraft("user-a", storage).status).toBe("invalid");
  expect(clearAccessDefaultsDraft("user-a", storage)).toBe(true);
  expect(readAccessDefaultsDraft("user-a", storage).value).toBeNull();
});

test("Role and Group journal records are owner-specific and preserve baselines", () => {
  const storage = memoryStorage();
  const role = {
    id: "role-1",
    name: "Operations",
    description: "Opening description",
    builtin: false,
    grants: ["records.read"],
  };
  const group = {
    id: "group-1",
    name: "Operations",
    description: "Opening group",
    memberIds: ["user-1"],
  };
  const roleDraft = {
    intent: "edit" as const,
    baseline: role,
    values: {
      name: "Operations lead",
      description: "Edited",
      grants: ["records.read"],
    },
  };
  const groupDraft = {
    intent: "edit" as const,
    baseline: group,
    values: {
      name: "Night operations",
      description: "Edited",
      memberIds: ["user-1"],
    },
  };
  expect(writeAccessRoleDraft("user-a", roleDraft, storage)).toBe(true);
  expect(writeAccessGroupDraft("user-a", groupDraft, storage)).toBe(true);
  expect(readAccessRoleDraft("user-a", storage).value).toEqual(roleDraft);
  expect(readAccessGroupDraft("user-a", storage).value).toEqual(groupDraft);
  expect(readAccessRoleDraft("user-b", storage).value).toBeNull();

  const key = accessDraftStorageKey("user-a", "role");
  const record = JSON.parse(storage.getItem(key) ?? "") as Record<
    string,
    unknown
  >;
  storage.setItem(
    key,
    JSON.stringify({ ...record, target: "edit:another-role" }),
  );
  expect(readAccessRoleDraft("user-a", storage).status).toBe("invalid");
  expect(clearAccessRoleDraft("user-a", storage)).toBe(true);
  expect(clearAccessGroupDraft("user-a", storage)).toBe(true);
});

test("Identity journal excludes credentials and rejects added confirmation fields", () => {
  const storage = memoryStorage();
  const baseline = {
    kind: "service" as const,
    id: "draft",
    name: "",
    status: "active" as const,
    roleId: "member-role",
    groupIds: [],
    ownerId: "",
    purpose: "",
    expiresAt: "2026-09-23T12:30:00Z",
    credentialState: "not-created" as const,
  };
  const draft = { ...baseline, name: "Automation", purpose: "Night report" };
  expect(
    writeAccessIdentityDraft(
      "user-a",
      { mode: "create", baseline, draft },
      storage,
    ),
  ).toBe(true);
  const key = accessDraftStorageKey("user-a", "identity");
  const raw = storage.getItem(key) ?? "";
  expect(raw).not.toContain("credentialState");
  const restored = readAccessIdentityDraft("user-a", storage);
  expect(restored.status).toBe("ready");
  expect(restored.value?.draft).toMatchObject({
    name: "Automation",
    purpose: "Night report",
  });
  const record = JSON.parse(raw) as Record<string, unknown>;
  storage.setItem(
    key,
    JSON.stringify({
      ...record,
      payload: {
        ...(record.payload as object),
        confirmationName: "Automation",
      },
    }),
  );
  expect(readAccessIdentityDraft("user-a", storage).status).toBe("invalid");
  expect(clearAccessIdentityDraft("user-a", storage)).toBe(true);
});

test("a completed draft cannot replay when removal fails but a tombstone can be written", () => {
  const storage = memoryStorage();
  const roleDraft = {
    intent: "create" as const,
    baseline: {
      id: "draft:new-role",
      name: "",
      description: "",
      builtin: false,
      grants: [],
    },
    values: {
      name: "Shift lead",
      description: "Night shift",
      grants: ["records.read"],
    },
  };
  const defaultsBaseline = {
    defaultRoleId: "member-role",
    defaultDepartmentIds: [],
    defaultGroupIds: [],
    invitationExpiryDays: 14,
    guestDurationDays: 30,
    serviceDurationDays: 90,
  };
  expect(writeAccessRoleDraft("user-a", roleDraft, storage)).toBe(true);
  expect(writeAccessRulesDraft("user-a", payload, storage)).toBe(true);
  expect(
    writeAccessGroupDraft(
      "user-a",
      {
        intent: "create",
        baseline: {
          id: "draft:new-group",
          name: "",
          description: "",
          memberIds: [],
        },
        values: { name: "Shift team", description: "", memberIds: [] },
      },
      storage,
    ),
  ).toBe(true);
  expect(
    writeAccessIdentityDraft(
      "user-a",
      {
        mode: "create",
        baseline: {
          kind: "internal",
          id: "draft",
          name: "",
          status: "active",
          roleId: "member-role",
          groupIds: [],
          email: "",
          departmentIds: [],
          primaryDepartmentId: "",
          title: "",
        },
        draft: {
          kind: "internal",
          id: "draft",
          name: "Shift operator",
          status: "active",
          roleId: "member-role",
          groupIds: [],
          email: "shift@example.test",
          departmentIds: [],
          primaryDepartmentId: "",
          title: "",
        },
      },
      storage,
    ),
  ).toBe(true);
  expect(
    writeAccessDefaultsDraft(
      "user-a",
      {
        baseline: defaultsBaseline,
        draft: { ...defaultsBaseline, invitationExpiryDays: 21 },
      },
      storage,
    ),
  ).toBe(true);
  const removeBlocked: AccessDraftStorage = {
    ...storage,
    removeItem: () => {
      throw new Error("removal blocked");
    },
  };

  expect(clearAccessRoleDraft("user-a", removeBlocked)).toBe(true);
  expect(clearAccessRulesDraft("user-a", removeBlocked)).toBe(true);
  expect(clearAccessGroupDraft("user-a", removeBlocked)).toBe(true);
  expect(clearAccessIdentityDraft("user-a", removeBlocked)).toBe(true);
  expect(clearAccessDefaultsDraft("user-a", removeBlocked)).toBe(true);
  expect(readAccessRoleDraft("user-a", storage)).toEqual({
    status: "ready",
    value: null,
  });
  expect(readAccessRulesDraft("user-a", storage)).toEqual({
    status: "ready",
    value: null,
  });
  expect(readAccessGroupDraft("user-a", storage)).toEqual({
    status: "ready",
    value: null,
  });
  expect(readAccessIdentityDraft("user-a", storage)).toEqual({
    status: "ready",
    value: null,
  });
  expect(readAccessDefaultsDraft("user-a", storage)).toEqual({
    status: "ready",
    value: null,
  });
  expect(
    storage.getItem(accessDraftStorageKey("user-a", "role")),
  ).not.toContain("Shift lead");

  const roleKey = accessDraftStorageKey("user-a", "role");
  const tombstone = JSON.parse(storage.getItem(roleKey) ?? "") as Record<
    string,
    unknown
  >;
  for (const tampered of [
    { ...tombstone, userId: "user-b" },
    { ...tombstone, owner: "group" },
    { ...tombstone, payload: roleDraft },
  ]) {
    storage.setItem(roleKey, JSON.stringify(tampered));
    expect(readAccessRoleDraft("user-a", storage)).toEqual({
      status: "invalid",
      value: null,
    });
  }

  expect(writeAccessRoleDraft("user-a", roleDraft, storage)).toBe(true);
  const fullyBlocked: AccessDraftStorage = {
    ...storage,
    setItem: () => {
      throw new Error("write blocked");
    },
    removeItem: () => {
      throw new Error("removal blocked");
    },
  };
  expect(clearAccessRoleDraft("user-a", fullyBlocked)).toBe(false);
  expect(readAccessRoleDraft("user-a", storage).value).toEqual(roleDraft);
});

test("an uncertain role submission stays readable but cannot become an editable draft", () => {
  const storage = memoryStorage();
  const roleDraft = {
    intent: "create" as const,
    baseline: {
      id: "draft:new-role",
      name: "",
      description: "",
      builtin: false,
      grants: [],
    },
    values: {
      name: "Shift lead",
      description: "Night shift",
      grants: ["records.read"],
    },
  };
  const key = accessDraftStorageKey("user-a", "role");
  storage.setItem(
    key,
    JSON.stringify({
      version: 1,
      userId: "user-a",
      owner: "role",
      target: "create:draft:new-role",
      state: "uncertain",
      payload: roleDraft,
    }),
  );

  expect(readAccessRoleDraft("user-a", storage)).toEqual({
    status: "uncertain",
    value: roleDraft,
  });
  expect(
    writeAccessRoleDraft(
      "user-a",
      { ...roleDraft, values: { ...roleDraft.values, name: "Another role" } },
      storage,
    ),
  ).toBe(false);
  expect(clearAccessRoleDraft("user-a", storage)).toBe(false);
  expect(readAccessRoleDraft("user-a", storage).status).toBe("uncertain");

  const marker = JSON.parse(storage.getItem(key) ?? "") as Record<
    string,
    unknown
  >;
  for (const tampered of [
    { ...marker, userId: "user-b" },
    { ...marker, owner: "group" },
    { ...marker, target: "create:other-role" },
    { ...marker, state: "ready" },
    { ...marker, payload: { ...roleDraft, password: "secret" } },
  ]) {
    storage.setItem(key, JSON.stringify(tampered));
    expect(readAccessRoleDraft("user-a", storage)).toEqual({
      status: "invalid",
      value: null,
    });
  }
});

test("submission preparation verifies its same-key uncertain record before mutation", () => {
  const storage = memoryStorage();
  const roleDraft = {
    intent: "create" as const,
    baseline: {
      id: "draft:new-role",
      name: "",
      description: "",
      builtin: false,
      grants: [],
    },
    values: { name: "Shift lead", description: "", grants: [] },
  };
  expect(writeAccessRoleDraft("user-a", roleDraft, storage)).toBe(true);

  const writeBlocked: AccessDraftStorage = {
    ...storage,
    setItem: () => {
      throw new Error("write blocked");
    },
  };
  expect(
    beginAccessRoleDraftSubmission("user-a", roleDraft, writeBlocked),
  ).toBe(false);
  expect(readAccessRoleDraft("user-a", storage).status).toBe("ready");

  const ignoredWrite: AccessDraftStorage = {
    ...storage,
    setItem: () => {},
  };
  expect(
    beginAccessRoleDraftSubmission("user-a", roleDraft, ignoredWrite),
  ).toBe(false);
  expect(readAccessRoleDraft("user-a", storage).status).toBe("ready");

  expect(beginAccessRoleDraftSubmission("user-a", roleDraft, storage)).toBe(
    true,
  );
  expect(readAccessRoleDraft("user-a", storage)).toEqual({
    status: "uncertain",
    value: roleDraft,
  });
  expect(beginAccessRoleDraftSubmission("user-a", roleDraft, storage)).toBe(
    false,
  );

  const fullyBlocked: AccessDraftStorage = {
    ...storage,
    setItem: () => {
      throw new Error("write blocked");
    },
    removeItem: () => {
      throw new Error("removal blocked");
    },
  };
  expect(completeAccessRoleDraftSubmission("user-a", fullyBlocked)).toBe(false);
  expect(discardUncertainAccessRoleDraft("user-a", fullyBlocked)).toBe(false);
  expect(readAccessRoleDraft("user-a", storage).status).toBe("uncertain");

  expect(discardUncertainAccessRoleDraft("user-a", storage)).toBe(false);
  expect(completeAccessRoleDraftSubmission("user-a", storage)).toBe(true);
  expect(readAccessRoleDraft("user-a", storage)).toEqual({
    status: "ready",
    value: null,
  });
  expect(completeAccessRoleDraftSubmission("user-a", storage)).toBe(false);

  expect(beginAccessRoleDraftSubmission("user-a", roleDraft, storage)).toBe(
    true,
  );
  const removeBlocked: AccessDraftStorage = {
    ...storage,
    removeItem: () => {
      throw new Error("removal blocked");
    },
  };
  expect(completeAccessRoleDraftSubmission("user-a", removeBlocked)).toBe(true);
  expect(readAccessRoleDraft("user-a", storage)).toEqual({
    status: "ready",
    value: null,
  });
});

test("same-document remount cannot discard a dispatched uncertain role submission", () => {
  const storage = memoryStorage();
  const userId = "same-document-user";
  const roleDraft = {
    intent: "create" as const,
    baseline: {
      id: "draft:new-role",
      name: "",
      description: "",
      builtin: false,
      grants: [],
    },
    values: { name: "Shift lead", description: "", grants: [] },
  };

  expect(beginAccessRoleDraftSubmission(userId, roleDraft, storage)).toBe(true);
  expect(discardUncertainAccessRoleDraft(userId, storage)).toBe(false);
  expect(readAccessRoleDraft(userId, storage).status).toBe("uncertain");
  expect(accessDraftSubmissionNeedsReload(userId, "role")).toBe(true);
  expect(accessDraftSubmissionNeedsReload(userId, "group")).toBe(false);

  const fullyBlocked: AccessDraftStorage = {
    ...storage,
    setItem: () => {
      throw new Error("write blocked");
    },
    removeItem: () => {
      throw new Error("removal blocked");
    },
  };
  expect(completeAccessRoleDraftSubmission(userId, fullyBlocked)).toBe(false);
  expect(accessDraftSubmissionNeedsReload(userId, "role")).toBe(true);

  expect(completeAccessRoleDraftSubmission(userId, storage)).toBe(true);
  expect(accessDraftSubmissionNeedsReload(userId, "role")).toBe(false);
});

test("an uncertain marker from a previous document can be explicitly discarded", () => {
  const storage = memoryStorage();
  const userId = "previous-document-user";
  const roleDraft = {
    intent: "create" as const,
    baseline: {
      id: "draft:new-role",
      name: "",
      description: "",
      builtin: false,
      grants: [],
    },
    values: { name: "Shift lead", description: "", grants: [] },
  };
  storage.setItem(
    accessDraftStorageKey(userId, "role"),
    JSON.stringify({
      version: 1,
      userId,
      owner: "role",
      target: "create:draft:new-role",
      state: "uncertain",
      payload: roleDraft,
    }),
  );

  expect(accessDraftSubmissionNeedsReload(userId, "role")).toBe(false);
  expect(discardUncertainAccessRoleDraft(userId, storage)).toBe(true);
  expect(readAccessRoleDraft(userId, storage)).toEqual({
    status: "ready",
    value: null,
  });
});

test("all Access owners preserve validated payloads during uncertain submission", () => {
  const storage = memoryStorage();
  const defaultsBaseline = {
    defaultRoleId: "member-role",
    defaultDepartmentIds: [],
    defaultGroupIds: [],
    invitationExpiryDays: 14,
    guestDurationDays: 30,
    serviceDurationDays: 90,
  };
  const defaults = {
    baseline: defaultsBaseline,
    draft: { ...defaultsBaseline, invitationExpiryDays: 21 },
  };
  const role = {
    intent: "create" as const,
    baseline: {
      id: "draft:new-role",
      name: "",
      description: "",
      builtin: false,
      grants: [],
    },
    values: { name: "Shift lead", description: "", grants: [] },
  };
  const group = {
    intent: "create" as const,
    baseline: {
      id: "draft:new-group",
      name: "",
      description: "",
      memberIds: [],
    },
    values: { name: "Shift team", description: "", memberIds: [] },
  };
  const identityBaseline = {
    kind: "internal" as const,
    id: "draft",
    name: "",
    status: "active" as const,
    roleId: "member-role",
    groupIds: [],
    email: "",
    departmentIds: [],
    primaryDepartmentId: "",
    title: "",
  };
  const identity = {
    mode: "create" as const,
    baseline: identityBaseline,
    draft: { ...identityBaseline, name: "Shift operator" },
  };

  expect(beginAccessRulesDraftSubmission("user-a", payload, storage)).toBe(
    true,
  );
  expect(beginAccessDefaultsDraftSubmission("user-a", defaults, storage)).toBe(
    true,
  );
  expect(beginAccessRoleDraftSubmission("user-a", role, storage)).toBe(true);
  expect(beginAccessGroupDraftSubmission("user-a", group, storage)).toBe(true);
  expect(beginAccessIdentityDraftSubmission("user-a", identity, storage)).toBe(
    true,
  );

  expect(readAccessRulesDraft("user-a", storage)).toEqual({
    status: "uncertain",
    value: payload,
  });
  expect(readAccessDefaultsDraft("user-a", storage)).toEqual({
    status: "uncertain",
    value: defaults,
  });
  expect(readAccessRoleDraft("user-a", storage)).toEqual({
    status: "uncertain",
    value: role,
  });
  expect(readAccessGroupDraft("user-a", storage)).toEqual({
    status: "uncertain",
    value: group,
  });
  expect(readAccessIdentityDraft("user-a", storage)).toEqual({
    status: "uncertain",
    value: identity,
  });

  expect(
    storage.getItem(accessDraftStorageKey("user-a", "identity")),
  ).not.toContain("credentialState");

  expect(completeAccessRulesDraftSubmission("user-a", storage)).toBe(true);
  expect(completeAccessDefaultsDraftSubmission("user-a", storage)).toBe(true);
  expect(completeAccessRoleDraftSubmission("user-a", storage)).toBe(true);
  expect(completeAccessGroupDraftSubmission("user-a", storage)).toBe(true);
  expect(completeAccessIdentityDraftSubmission("user-a", storage)).toBe(true);
  for (const read of [
    readAccessRulesDraft,
    readAccessDefaultsDraft,
    readAccessRoleDraft,
    readAccessGroupDraft,
    readAccessIdentityDraft,
  ]) {
    expect(read("user-a", storage)).toEqual({ status: "ready", value: null });
  }
});
