import { ApiError } from "@/lib/api";
import { lifecycleErrorMessage } from "@/lib/lifecycle";
import type {
  BoardCreateInput,
  BoardManagementBoard,
  BoardUpdateInput,
} from "../adapters/board-management-api";

/** The rules of a board's Details: drafts, saves, conflicts and denial. */

export type BoardManagementDraft = {
  name: string;
  description: string;
};

export type BoardManagementView = {
  board: BoardManagementBoard | null;
  access: "loading" | "ready" | "denied" | "error";
  canManage: boolean;
  draft: BoardManagementDraft;
  pending: boolean;
  conflict: boolean;
  latestReady?: boolean;
  error: string | null;
  notice: string | null;
};

export const blankDraft: BoardManagementDraft = { name: "", description: "" };

export function draftFromBoard(
  board: BoardManagementBoard,
): BoardManagementDraft {
  return { name: board.name, description: board.description ?? "" };
}

function cleanDescription(value: string): string | null {
  return value.trim() || null;
}

export function validDraft(draft: BoardManagementDraft): boolean {
  return (
    draft.name.trim().length > 0 &&
    draft.name.trim().length <= 200 &&
    draft.description.trim().length <= 240
  );
}

export function boardCreateForDraft(
  draft: BoardManagementDraft,
): BoardCreateInput {
  return {
    name: draft.name.trim(),
    description: cleanDescription(draft.description),
  };
}

/** A department Board takes its name from the department, so only its description changes. */
export function boardUpdateForDraft(
  board: BoardManagementBoard,
  draft: BoardManagementDraft,
): BoardUpdateInput | null {
  const changes: BoardUpdateInput = { revision: board.revision };
  const name = draft.name.trim();
  const description = cleanDescription(draft.description);
  if (board.scope !== "department" && name !== board.name) changes.name = name;
  if (description !== board.description) changes.description = description;
  return Object.keys(changes).length > 1 ? changes : null;
}

export function boardPurgeFailureMessage(
  error: unknown,
  stage: "preview" | "execute",
): string {
  if (
    error instanceof ApiError &&
    (error.code === "purge_disabled" ||
      error.code === "confirmation_name_mismatch")
  )
    return error.message;
  if (stage === "preview")
    return lifecycleErrorMessage(
      error,
      error instanceof ApiError && error.status === 403
        ? "Only an administrator can delete a board forever."
        : "The delete review could not be prepared. Check the board and try again.",
    );
  if (error instanceof ApiError && error.status === 403)
    return lifecycleErrorMessage(
      error,
      "Administrator verification failed. Confirm your password and access, then request a new review.",
    );
  if (error instanceof ApiError && error.status === 409)
    return lifecycleErrorMessage(
      error,
      "The board or its dependencies changed, or the review expired. Request a new review.",
    );
  return lifecycleErrorMessage(
    error,
    "The board was not deleted. Request a new review and try again.",
  );
}

export function rebaseBoardDraft(
  original: BoardManagementBoard,
  latest: BoardManagementBoard,
  draft: BoardManagementDraft,
): BoardManagementDraft {
  return {
    name: draft.name.trim() !== original.name ? draft.name : latest.name,
    description:
      cleanDescription(draft.description) !== original.description
        ? draft.description
        : (latest.description ?? ""),
  };
}

export type BoardManagementRevocation = {
  accessRequest: { current: number };
  actionRequest: { current: number };
  setBoard: (value: null) => void;
  setDraft: (value: BoardManagementDraft) => void;
  setDraftBase: (value: null) => void;
  setAccess: (value: "denied") => void;
  setConflict: (value: false) => void;
  setLatestReady: (value: false) => void;
  setError: (value: null) => void;
  setNotice: (value: null) => void;
  setConfirmation: (value: null) => void;
  setDiscardOpen: (value: false) => void;
  onAccessDenied: () => void;
};

export function revokeBoardManagementState(
  targets: BoardManagementRevocation,
  revokeBoard = true,
): void {
  targets.accessRequest.current += 1;
  targets.actionRequest.current += 1;
  targets.setAccess("denied");
  targets.setBoard(null);
  targets.setDraft(blankDraft);
  targets.setDraftBase(null);
  targets.setConflict(false);
  targets.setLatestReady(false);
  targets.setError(null);
  targets.setNotice(null);
  targets.setConfirmation(null);
  targets.setDiscardOpen(false);
  if (revokeBoard) targets.onAccessDenied();
}
