import {
  rulesPayloadSchema,
  defaultsPayloadSchema,
  rolePayloadSchema,
  groupPayloadSchema,
  identityPayloadSchema,
  rulesTarget,
  editableAccessIdentity,
  editableAccessDefaults,
  type AccessRulesDraft,
  type AccessDefaultsDraft,
  type EditableAccessDefaults,
  type AccessRoleDraft,
  type AccessGroupDraft,
  type AccessIdentityDraft,
} from "./draft-journal-codecs";
import {
  ACCESS_DRAFT_STORAGE_PREFIX,
  accessDraftStorageKey,
  accessDraftSubmissionNeedsReload,
  accessDraftUserStoragePrefix,
  browserStorage,
  clearAccessDraftStorageExcept,
  clearDraftKeys,
  readDraft,
  writeDraft,
  beginDraftSubmission,
  clearDraft,
  finishUncertainDraft,
  type AccessDraftStorage,
  type ReadResult,
} from "./draft-journal-storage";

export {
  ACCESS_DRAFT_STORAGE_PREFIX,
  accessDraftStorageKey,
  accessDraftSubmissionNeedsReload,
  clearAccessDraftStorageExcept,
  editableAccessIdentity,
  editableAccessDefaults,
};
export type {
  AccessDraftStorage,
  AccessRulesDraft,
  AccessDefaultsDraft,
  EditableAccessDefaults,
  AccessRoleDraft,
  AccessGroupDraft,
  AccessIdentityDraft,
};

export function readAccessRulesDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): ReadResult<AccessRulesDraft> {
  return readDraft(
    userId,
    "rules",
    rulesPayloadSchema,
    (value) => rulesTarget(value.selection),
    storage,
  );
}

export function writeAccessRulesDraft(
  userId: string,
  payload: AccessRulesDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return writeDraft(
    userId,
    "rules",
    payload,
    rulesPayloadSchema,
    (value) => rulesTarget(value.selection),
    storage,
  );
}

export function clearAccessRulesDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return clearDraft(
    userId,
    "rules",
    rulesPayloadSchema,
    (value) => rulesTarget(value.selection),
    storage,
  );
}

export function beginAccessRulesDraftSubmission(
  userId: string,
  payload: AccessRulesDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return beginDraftSubmission(
    userId,
    "rules",
    payload,
    rulesPayloadSchema,
    (value) => rulesTarget(value.selection),
    storage,
  );
}

export function completeAccessRulesDraftSubmission(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return finishUncertainDraft(
    userId,
    "rules",
    rulesPayloadSchema,
    (value) => rulesTarget(value.selection),
    storage,
    true,
  );
}

export function discardUncertainAccessRulesDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return finishUncertainDraft(
    userId,
    "rules",
    rulesPayloadSchema,
    (value) => rulesTarget(value.selection),
    storage,
    false,
  );
}

export function readAccessDefaultsDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): ReadResult<AccessDefaultsDraft> {
  return readDraft(
    userId,
    "defaults",
    defaultsPayloadSchema,
    () => "workspace-defaults",
    storage,
  );
}

export function writeAccessDefaultsDraft(
  userId: string,
  payload: AccessDefaultsDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return writeDraft(
    userId,
    "defaults",
    payload,
    defaultsPayloadSchema,
    () => "workspace-defaults",
    storage,
  );
}

export function clearAccessDefaultsDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return clearDraft(
    userId,
    "defaults",
    defaultsPayloadSchema,
    () => "workspace-defaults",
    storage,
  );
}

export function beginAccessDefaultsDraftSubmission(
  userId: string,
  payload: AccessDefaultsDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return beginDraftSubmission(
    userId,
    "defaults",
    payload,
    defaultsPayloadSchema,
    () => "workspace-defaults",
    storage,
  );
}

export function completeAccessDefaultsDraftSubmission(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return finishUncertainDraft(
    userId,
    "defaults",
    defaultsPayloadSchema,
    () => "workspace-defaults",
    storage,
    true,
  );
}

export function discardUncertainAccessDefaultsDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return finishUncertainDraft(
    userId,
    "defaults",
    defaultsPayloadSchema,
    () => "workspace-defaults",
    storage,
    false,
  );
}

export function readAccessRoleDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): ReadResult<AccessRoleDraft> {
  return readDraft(
    userId,
    "role",
    rolePayloadSchema,
    (value) => `${value.intent}:${value.baseline.id}`,
    storage,
  );
}

export function writeAccessRoleDraft(
  userId: string,
  payload: AccessRoleDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return writeDraft(
    userId,
    "role",
    payload,
    rolePayloadSchema,
    (value) => `${value.intent}:${value.baseline.id}`,
    storage,
  );
}

export function clearAccessRoleDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return clearDraft(
    userId,
    "role",
    rolePayloadSchema,
    (value) => `${value.intent}:${value.baseline.id}`,
    storage,
  );
}

export function beginAccessRoleDraftSubmission(
  userId: string,
  payload: AccessRoleDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return beginDraftSubmission(
    userId,
    "role",
    payload,
    rolePayloadSchema,
    (value) => `${value.intent}:${value.baseline.id}`,
    storage,
  );
}

export function completeAccessRoleDraftSubmission(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return finishUncertainDraft(
    userId,
    "role",
    rolePayloadSchema,
    (value) => `${value.intent}:${value.baseline.id}`,
    storage,
    true,
  );
}

export function discardUncertainAccessRoleDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return finishUncertainDraft(
    userId,
    "role",
    rolePayloadSchema,
    (value) => `${value.intent}:${value.baseline.id}`,
    storage,
    false,
  );
}

export function readAccessGroupDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): ReadResult<AccessGroupDraft> {
  return readDraft(
    userId,
    "group",
    groupPayloadSchema,
    (value) => `${value.intent}:${value.baseline.id}`,
    storage,
  );
}

export function writeAccessGroupDraft(
  userId: string,
  payload: AccessGroupDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return writeDraft(
    userId,
    "group",
    payload,
    groupPayloadSchema,
    (value) => `${value.intent}:${value.baseline.id}`,
    storage,
  );
}

export function clearAccessGroupDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return clearDraft(
    userId,
    "group",
    groupPayloadSchema,
    (value) => `${value.intent}:${value.baseline.id}`,
    storage,
  );
}

export function beginAccessGroupDraftSubmission(
  userId: string,
  payload: AccessGroupDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return beginDraftSubmission(
    userId,
    "group",
    payload,
    groupPayloadSchema,
    (value) => `${value.intent}:${value.baseline.id}`,
    storage,
  );
}

export function completeAccessGroupDraftSubmission(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return finishUncertainDraft(
    userId,
    "group",
    groupPayloadSchema,
    (value) => `${value.intent}:${value.baseline.id}`,
    storage,
    true,
  );
}

export function discardUncertainAccessGroupDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return finishUncertainDraft(
    userId,
    "group",
    groupPayloadSchema,
    (value) => `${value.intent}:${value.baseline.id}`,
    storage,
    false,
  );
}

export function readAccessIdentityDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): ReadResult<AccessIdentityDraft> {
  return readDraft(
    userId,
    "identity",
    identityPayloadSchema,
    (value) => `${value.mode}:${value.baseline.id}`,
    storage,
  );
}

export function writeAccessIdentityDraft(
  userId: string,
  payload: AccessIdentityDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return writeDraft(
    userId,
    "identity",
    {
      mode: payload.mode,
      baseline: editableAccessIdentity(payload.baseline),
      draft: editableAccessIdentity(payload.draft),
    },
    identityPayloadSchema,
    (value) => `${value.mode}:${value.baseline.id}`,
    storage,
  );
}

export function clearAccessIdentityDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return clearDraft(
    userId,
    "identity",
    identityPayloadSchema,
    (value) => `${value.mode}:${value.baseline.id}`,
    storage,
  );
}

export function beginAccessIdentityDraftSubmission(
  userId: string,
  payload: AccessIdentityDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return beginDraftSubmission(
    userId,
    "identity",
    {
      mode: payload.mode,
      baseline: editableAccessIdentity(payload.baseline),
      draft: editableAccessIdentity(payload.draft),
    },
    identityPayloadSchema,
    (value) => `${value.mode}:${value.baseline.id}`,
    storage,
  );
}

export function completeAccessIdentityDraftSubmission(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return finishUncertainDraft(
    userId,
    "identity",
    identityPayloadSchema,
    (value) => `${value.mode}:${value.baseline.id}`,
    storage,
    true,
  );
}

export function discardUncertainAccessIdentityDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return finishUncertainDraft(
    userId,
    "identity",
    identityPayloadSchema,
    (value) => `${value.mode}:${value.baseline.id}`,
    storage,
    false,
  );
}

export function clearAccessDraftStorageForUser(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return clearDraftKeys(
    (key) => key.startsWith(accessDraftUserStoragePrefix(userId)),
    storage,
  );
}
