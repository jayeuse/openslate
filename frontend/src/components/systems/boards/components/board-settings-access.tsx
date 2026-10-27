"use client";

import { useId } from "react";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/search-select";
import type { BoardManagementBoard } from "../adapters/board-management-api";
import {
  boardAccessSummary,
  checkPersonResult,
} from "../domain/board-settings";
import { useBoardCheckPerson } from "../hooks/use-board-check-person";
import { BoardLevelChip } from "./board-page-header";
import { ServerBackedBoardGroups } from "./server-backed-board-groups";

const control = "min-h-11 xl:min-h-8";
const ACCESS_GROUPS_HREF = "/access?view=groups";
const linkClass =
  "text-action-text focus-visible:outline-ring rounded-sm underline underline-offset-4 focus-visible:outline-2";

/** The Read-only summaries `dl`: who, then what they can do. */
function AccessSummary({
  board,
  isAdmin,
}: {
  board: BoardManagementBoard;
  isAdmin: boolean;
}) {
  const rows = boardAccessSummary(board);
  const moduleOnly = `Write on some ${board.name} modules`;
  return (
    <dl className="bg-muted grid max-w-prose grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg px-3 py-2.5 text-sm">
      {rows.map((row) => (
        <div key={row.who} className="contents">
          <dt className="font-medium break-words">{row.who}</dt>
          <dd className="text-muted-foreground">
            {row.can}
            {/* Module-only write reads here; posting needs a department row
                (BR34). Only an admin can give it, in the one place the
                link under the summary names. */}
            {isAdmin &&
            board.scope === "department" &&
            row.who === moduleOnly ? (
              <span className="mt-0.5 block">
                Give this group a department-level Write row.
              </span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Check a person (BR28): one search, then their level here and why. */
function CheckPerson({
  board,
  refreshKey,
}: {
  board: BoardManagementBoard;
  refreshKey: number;
}) {
  const id = useId();
  const check = useBoardCheckPerson(board.id, refreshKey);
  const result =
    check.preview.status === "ready" && check.preview.data
      ? check.preview.data
      : null;
  const shown = result ? checkPersonResult(board, result) : null;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 border-t pt-5"
    >
      <h3
        id={`${id}-title`}
        data-slot="section-title"
        className="text-sm font-medium"
      >
        Check a person
      </h3>
      {check.denied ? (
        <p className="text-muted-foreground text-sm">
          Check a person is unavailable.
        </p>
      ) : (
        <>
          <div className="max-w-md">
            <SearchSelect
              id={`${id}-person`}
              label="Person"
              popupClassName="slim-ui"
              value={check.selected?.id ?? ""}
              placeholder="Choose a person"
              searchPlaceholder="Search people"
              emptyMessage={
                check.search.trim() ? "No people match." : "No people yet."
              }
              options={check.options.map((user) => ({
                value: user.id,
                label: user.displayName,
                // The username tells two people of one name apart.
                ...(user.displayName === user.username
                  ? {}
                  : { description: user.username }),
              }))}
              selectedOption={
                check.selected
                  ? {
                      value: check.selected.id,
                      label: check.selected.displayName,
                    }
                  : undefined
              }
              search={check.search}
              onSearchChange={check.setSearch}
              loading={check.loading}
              loadingMore={check.loadingMore}
              error={check.error ?? undefined}
              onRetry={check.retryList}
              hasMore={check.hasMore}
              onLoadMore={check.loadMore}
              onValueChange={check.choose}
            />
          </div>
          {/* Kept mounted, so only its words change and each is heard. */}
          <p
            role="status"
            className="text-muted-foreground text-sm empty:sr-only"
          >
            {check.selected && check.preview.status === "loading"
              ? `Checking ${check.selected.displayName}…`
              : ""}
          </p>
          {check.selected && check.preview.status === "error" ? (
            <Alert
              variant="destructive"
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <span>{check.preview.error}</span>
              <Button
                type="button"
                variant="outline"
                className={control}
                onClick={check.retryPreview}
              >
                Retry
              </Button>
            </Alert>
          ) : null}
          {check.selected && result && shown ? (
            <dl
              aria-label={`${check.selected.displayName} on this board`}
              className="bg-muted grid max-w-prose grid-cols-[minmax(0,auto)_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 rounded-lg px-3 py-2.5 text-sm"
            >
              <dt className="font-medium">Level</dt>
              <dd>
                {result.level ? (
                  <BoardLevelChip level={result.level} />
                ) : (
                  <span className="text-muted-foreground">No access</span>
                )}
              </dd>
              {shown.abilities ? (
                <>
                  <dt className="font-medium">Access</dt>
                  <dd className="text-muted-foreground">{shown.abilities}</dd>
                </>
              ) : null}
              {shown.reason ? (
                <>
                  <dt className="font-medium">Why</dt>
                  <dd className="text-muted-foreground">{shown.reason}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * Board settings › Access (BR28): who reads, posts and manages, as read-only
 * text; a project board's groups one per row (administrators change them);
 * then Check a person.
 */
export function BoardSettingsAccess({
  board,
  isAdmin,
  refreshKey,
  onGroupsChanged,
}: {
  board: BoardManagementBoard;
  isAdmin: boolean;
  refreshKey: number;
  onGroupsChanged: () => void;
}) {
  return (
    <section aria-label="Board access" className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-2">
        <AccessSummary board={board} isAdmin={isAdmin} />
        {board.scope === "department" ? (
          isAdmin ? (
            <p className="text-muted-foreground text-sm">
              <Link href={ACCESS_GROUPS_HREF} className={linkClass}>
                Change department roles in Access › Groups
              </Link>
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">
              Only an admin can change {board.name} roles.
            </p>
          )
        ) : null}
      </div>
      {board.scope === "project" ? (
        <ServerBackedBoardGroups
          key={`groups:${board.id}`}
          boardId={board.id}
          boardActive={board.status === "active"}
          isAdmin={isAdmin}
          onChanged={onGroupsChanged}
        />
      ) : null}
      <CheckPerson key={board.id} board={board} refreshKey={refreshKey} />
    </section>
  );
}
