import {
  applySandboxCommand,
  createSandboxHistory,
  type SandboxHistory,
} from "./controller";
import {
  mergeProjectedDesign,
  projectSandboxDocument,
} from "../domain/document-bridge";
import type { Design } from "../domain/model";
import type { SandboxDocumentResponse } from "./api";
import type { SandboxPublishedVersion } from "./api";
import type { SandboxValidationIssue } from "../domain/validation";
import type { SandboxDocumentV4 } from "../domain/document";

export type SandboxDocumentSession = {
  document: SandboxDocumentV4;
  projected: Design;
  history: SandboxHistory;
  revision: number;
  issues: SandboxValidationIssue[];
  contentHash: string;
  publishedHash?: string;
  latestPublishedVersion?: SandboxPublishedVersion;
  hasUnpublishedChanges?: boolean;
};

export function openSandboxDocumentSession(
  response: SandboxDocumentResponse,
): SandboxDocumentSession {
  const projected = projectSandboxDocument(response.document);
  return {
    document: response.document,
    projected,
    history: createSandboxHistory(projected),
    revision: response.revision,
    contentHash: response.contentHash,
    ...(response.publishedHash === null
      ? {}
      : { publishedHash: response.publishedHash }),
    ...(response.latestPublishedVersion === null
      ? {}
      : { latestPublishedVersion: response.latestPublishedVersion }),
    ...(response.hasUnpublishedChanges === undefined
      ? {}
      : { hasUnpublishedChanges: response.hasUnpublishedChanges }),
    issues: response.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      ...(issue.targetId === null ? {} : { targetId: issue.targetId }),
      severity: "error" as const,
    })),
  };
}

export function updateSandboxDocumentSession(
  session: SandboxDocumentSession,
  design: Design,
): SandboxDocumentSession {
  const history = applySandboxCommand(session.history, {
    type: "replace-design",
    design,
  });
  return { ...session, history };
}

export function proposedSandboxDocument(
  session: SandboxDocumentSession,
  design: Design = session.history.present,
): SandboxDocumentV4 {
  return mergeProjectedDesign(session.document, session.projected, design);
}

export function synchronizeSandboxHistoryRules(
  history: SandboxHistory,
  confirmed: Design,
): SandboxHistory {
  const withConfirmedRules = (design: Design): Design => ({
    ...design,
    rules: confirmed.rules,
  });
  const synchronizeEntry = (entry: SandboxHistory["past"][number]) => ({
    ...entry,
    before: withConfirmedRules(entry.before),
    after: withConfirmedRules(entry.after),
  });
  return {
    past: history.past.map(synchronizeEntry),
    present: confirmed,
    future: history.future.map(synchronizeEntry),
  };
}

/** Reapplies a preserved local graph draft after the user reloads a 409 response. */
export function reapplySandboxDocumentDraft(
  response: SandboxDocumentResponse,
  preservedDesign: Design,
): SandboxDocumentSession {
  const reloaded = openSandboxDocumentSession(response);
  return updateSandboxDocumentSession(reloaded, preservedDesign);
}

/** Reapplies a complete canonical draft against freshly loaded server metadata. */
export function reapplySandboxDocument(
  response: SandboxDocumentResponse,
  document: SandboxDocumentV4,
): SandboxDocumentSession {
  return openSandboxDocumentSession({ ...response, document });
}

export function syncSandboxDocumentMetadata(
  session: SandboxDocumentSession,
  response: SandboxDocumentResponse,
): SandboxDocumentSession {
  const refreshed = openSandboxDocumentSession(response);
  return JSON.stringify(session.document) === JSON.stringify(response.document)
    ? { ...refreshed, history: session.history }
    : refreshed;
}
