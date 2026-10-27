"use client";

import { useId, type ReactNode } from "react";
import type { WorkspaceRegion } from "@/lib/date-time";
import { AdvancedSection } from "@/components/ui/advanced-section";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LifecyclePurgeReview } from "@/components/systems/shared/lifecycle-purge-review";
import type { BoardPurgePreview } from "../adapters/board-management-api";
import {
  boardUpdateForDraft,
  validDraft,
  type BoardManagementDraft,
  type BoardManagementView,
} from "../domain/board-details";

const control = "min-h-11 xl:min-h-8";

/**
 * One label-left row of Details (DESIGN "Slim controls"): a 128px muted label
 * column and the value on the right, stacked on phones.
 */
function Row({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  const labelClass = "text-muted-foreground text-sm sm:pt-2.5 xl:pt-1.5";
  return (
    <div className="grid min-w-0 gap-1.5 py-1.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
      {htmlFor ? (
        <label htmlFor={htmlFor} className={labelClass}>
          {label}
        </label>
      ) : (
        <span className={labelClass}>{label}</span>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** What the viewer cannot change here is text on the sunken block. */
function ReadOnlyValue({
  children,
  note,
}: {
  children: ReactNode;
  note?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="bg-muted min-h-10 rounded-lg px-3 py-2.5 text-sm break-words xl:min-h-8 xl:py-1.5">
        {children}
      </p>
      {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
    </div>
  );
}

type DisplayProps = {
  view: BoardManagementView;
  isAdmin?: boolean;
  purgeEnabled?: boolean;
  onChange?: (draft: BoardManagementDraft) => void;
  onSave?: () => void;
  onRefreshLatest?: () => void;
  onRetryWithDraft?: () => void;
  onUseLatest?: () => void;
  onArchive?: () => void;
  onRestore?: () => void;
  onBeginPurge?: () => void;
  purgePreviewLoading?: boolean;
  purgeReviewAgain?: boolean;
  purgePreview?: BoardPurgePreview | null;
  region?: WorkspaceRegion;
  purgeConfirmationName?: string;
  purgePassword?: string;
  onChangePurgeConfirmationName?: (value: string) => void;
  onChangePurgePassword?: (value: string) => void;
  onCancelPurge?: () => void;
  onConfirmPurge?: () => void;
  onRetryAccess?: () => void;
  /** Unattached files, for administrators; the first block of Advanced. */
  files?: ReactNode;
};

/**
 * Board settings › Details (BR27): label-left Name and Description, Save
 * changes only with a change, then Advanced last with the files and the
 * board's lifecycle. Archive asks once; Restore is neutral and acts at once.
 */
export function ServerBoardManagementDisplay({
  view,
  isAdmin = false,
  purgeEnabled = false,
  onChange = () => undefined,
  onSave = () => undefined,
  onRefreshLatest = () => undefined,
  onRetryWithDraft = () => undefined,
  onUseLatest = () => undefined,
  onArchive = () => undefined,
  onRestore = () => undefined,
  onBeginPurge = () => undefined,
  purgePreviewLoading = false,
  purgeReviewAgain = false,
  purgePreview = null,
  region,
  purgeConfirmationName = "",
  purgePassword = "",
  onChangePurgeConfirmationName = () => undefined,
  onChangePurgePassword = () => undefined,
  onCancelPurge = () => undefined,
  onConfirmPurge = () => undefined,
  onRetryAccess = () => undefined,
  files = null,
}: DisplayProps) {
  const id = useId();
  const board = view.board;
  if (view.access !== "ready" || !view.canManage || !board) {
    const loading = view.access === "loading";
    const failed = view.access === "error";
    return (
      <section aria-label="Board details" className="flex flex-col gap-3">
        {loading ? (
          <p role="status" className="text-muted-foreground text-sm">
            Checking your access to this board…
          </p>
        ) : (
          // Only a failed read is an error; a manager check is a fact.
          <Alert variant={failed ? "destructive" : "default"}>
            {failed
              ? "Board settings could not be loaded. Try again."
              : "You cannot manage this board."}
          </Alert>
        )}
        {failed ? (
          <Button
            type="button"
            variant="outline"
            className={`${control} self-start`}
            onClick={onRetryAccess}
          >
            Retry
          </Button>
        ) : null}
      </section>
    );
  }

  const archived = board.status === "archived";
  const project = board.scope === "project";
  const nameFixed = board.scope === "department";
  const dirty = boardUpdateForDraft(board, view.draft) !== null;
  const canSave =
    !archived &&
    !view.pending &&
    !view.conflict &&
    validDraft(view.draft) &&
    dirty;
  const showPurge = archived && isAdmin && purgeEnabled;
  const lifecycleError = view.lifecycleError ?? null;
  // A result line beside an action; kept mounted so only its words change.
  const lifecycleStatus = (
    <p role="status" data-lifecycle-status="" className="text-sm empty:sr-only">
      {view.lifecycleNotice ?? ""}
    </p>
  );
  const errorBeside = (action: "lifecycle" | "purge") =>
    lifecycleError?.action === action ? (
      <Alert variant="destructive">{lifecycleError.message}</Alert>
    ) : null;
  const advancedParts = [
    files ? "Files" : null,
    project && !archived ? "Archive" : null,
    archived ? "Restore" : null,
    showPurge ? "Delete forever" : null,
  ].filter((part): part is string => part !== null);

  return (
    <section aria-label="Board details" className="flex min-w-0 flex-col gap-5">
      {view.error ? <Alert variant="destructive">{view.error}</Alert> : null}
      {/* Kept mounted, so only its words change and each is heard. */}
      <p role="status" className="text-sm empty:sr-only">
        {view.notice ?? ""}
      </p>
      {view.conflict ? (
        <Alert variant="destructive">
          <div className="flex flex-col gap-3">
            <p>
              <span className="block font-medium">
                Someone changed this board first.
              </span>
              Your changes are kept. Review the latest before you save.
            </p>
            {view.latestReady ? (
              <div className="flex flex-col gap-1">
                <p>{`Latest name: ${board.name} · ${board.status}.`}</p>
                <p>{`Latest description: ${board.description || "None"}.`}</p>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className={control}
                disabled={view.pending}
                onClick={onRefreshLatest}
              >
                Refresh board
              </Button>
              {view.latestReady ? (
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  disabled={view.pending}
                  onClick={onUseLatest}
                >
                  Use latest values
                </Button>
              ) : null}
              {view.latestReady && board.status === "active" ? (
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  disabled={view.pending}
                  onClick={onRetryWithDraft}
                >
                  Retry with my draft
                </Button>
              ) : null}
            </div>
          </div>
        </Alert>
      ) : null}

      {archived ? (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-sm">
            Archived boards are read-only.
          </p>
          <Row label="Name">
            <ReadOnlyValue>{board.name}</ReadOnlyValue>
          </Row>
          <Row label="Description">
            <ReadOnlyValue>{board.description || "—"}</ReadOnlyValue>
          </Row>
        </div>
      ) : (
        <form
          className="flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          {nameFixed ? (
            <Row label="Name">
              <ReadOnlyValue note="Named after its department">
                {board.name}
              </ReadOnlyValue>
            </Row>
          ) : (
            <Row label="Name" htmlFor={`${id}-name`}>
              <Input
                id={`${id}-name`}
                value={view.draft.name}
                maxLength={200}
                required
                disabled={view.pending}
                className="h-11"
                onChange={(event) =>
                  onChange({ ...view.draft, name: event.target.value })
                }
              />
            </Row>
          )}
          <Row label="Description" htmlFor={`${id}-description`}>
            <Textarea
              id={`${id}-description`}
              value={view.draft.description}
              maxLength={240}
              disabled={view.pending}
              onChange={(event) =>
                onChange({ ...view.draft, description: event.target.value })
              }
            />
          </Row>
          <div className="flex flex-wrap items-center gap-2 pt-2 sm:pl-36">
            <Button
              type="submit"
              className={control}
              disabled={!canSave}
              aria-describedby={dirty ? undefined : `${id}-save-reason`}
            >
              {view.pending ? "Saving…" : "Save changes"}
            </Button>
            {dirty && !view.conflict ? (
              <Button
                type="button"
                variant="ghost"
                className={control}
                disabled={view.pending}
                onClick={onUseLatest}
              >
                Discard changes
              </Button>
            ) : null}
            {dirty ? null : (
              <span
                id={`${id}-save-reason`}
                className="text-muted-foreground text-sm"
              >
                No changes to save.
              </span>
            )}
          </div>
        </form>
      )}

      <AdvancedSection
        storageKey="boards:settings:details"
        summary={advancedParts.length ? advancedParts.join(", ") : undefined}
        // An error inside opens the block, so the action that failed shows.
        forceOpen={lifecycleError !== null}
      >
        {files}
        {board.scope === "company" ? null : board.scope === "department" &&
          !archived ? (
          <p className="text-muted-foreground text-sm">
            Archives when {board.name} closes.
          </p>
        ) : archived ? (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-sm">
              People with access can post again.
            </p>
            <Button
              type="button"
              variant="outline"
              className={`${control} self-start`}
              data-lifecycle-action=""
              // Locked while it runs but focusable: the board's Archive
              // button takes this one's place, and focus stays on it (R5).
              aria-disabled={view.pending || undefined}
              disabled={view.conflict}
              onClick={() => {
                if (!view.pending) onRestore();
              }}
            >
              Restore board
            </Button>
            {lifecycleStatus}
            {errorBeside("lifecycle")}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-sm">
              People who can read it now still can; nobody can post.
            </p>
            <Button
              type="button"
              variant="outline"
              className={`${control} self-start`}
              data-lifecycle-action=""
              // Locked while a save runs but focusable: after Restore this
              // button takes Restore's place and focus moves to it (R5).
              aria-disabled={view.pending || undefined}
              disabled={view.conflict || dirty}
              aria-describedby={dirty ? `${id}-archive-reason` : undefined}
              onClick={() => {
                if (!view.pending) onArchive();
              }}
            >
              Archive board
            </Button>
            {dirty ? (
              <p
                id={`${id}-archive-reason`}
                className="text-muted-foreground text-sm"
              >
                Save or discard changes before archiving.
              </p>
            ) : null}
            {lifecycleStatus}
            {errorBeside("lifecycle")}
          </div>
        )}
        {showPurge ? (
          <div className="border-border flex flex-col gap-3 border-t pt-4">
            <p className="text-muted-foreground text-sm">
              Removes the board and its content. This cannot be undone.
            </p>
            {/* The first step only opens the review: quiet danger. The
                final "Delete board forever" keeps the fill. */}
            <Button
              type="button"
              variant="outline"
              className={`${control} border-danger-rule text-danger-text self-start`}
              disabled={view.pending || view.conflict || purgePreviewLoading}
              onClick={onBeginPurge}
            >
              {purgePreviewLoading
                ? "Preparing review…"
                : purgeReviewAgain
                  ? "Review again"
                  : "Delete forever"}
            </Button>
            {errorBeside("purge")}
            {purgePreview ? (
              <div className="border-border flex flex-col gap-4 rounded-lg border p-4">
                <LifecyclePurgeReview preview={purgePreview} region={region} />
                {purgePreview.impact.blockers.length > 0 ? null : (
                  <form
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      onConfirmPurge();
                    }}
                  >
                    <p className="text-sm" role="status">
                      Type the exact board name and enter your administrator
                      password to continue.
                    </p>
                    <p className="text-sm">
                      <span>Board name: </span>
                      <code className="break-all">
                        {purgePreview.confirmation_name}
                      </code>
                    </p>
                    <div className="flex flex-col gap-2">
                      <label
                        htmlFor={`${id}-purge-confirmation`}
                        className="text-sm font-medium"
                      >
                        Type the board name
                      </label>
                      <Input
                        id={`${id}-purge-confirmation`}
                        value={purgeConfirmationName}
                        autoComplete="off"
                        disabled={view.pending}
                        className="h-11"
                        onChange={(event) =>
                          onChangePurgeConfirmationName(event.target.value)
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <label
                        htmlFor={`${id}-purge-password`}
                        className="text-sm font-medium"
                      >
                        Administrator password
                      </label>
                      <Input
                        id={`${id}-purge-password`}
                        type="password"
                        value={purgePassword}
                        autoComplete="current-password"
                        disabled={view.pending}
                        className="h-11"
                        onChange={(event) =>
                          onChangePurgePassword(event.target.value)
                        }
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="submit"
                        variant="destructive"
                        className={control}
                        disabled={
                          view.pending ||
                          purgeConfirmationName !==
                            purgePreview.confirmation_name ||
                          purgePassword.length === 0
                        }
                      >
                        {view.pending ? "Deleting…" : "Delete board forever"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className={control}
                        disabled={view.pending}
                        onClick={onCancelPurge}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </AdvancedSection>
    </section>
  );
}
