"use client";

import { createElement, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import type {
  BoardAccessPreview,
  BoardPreviewUser,
} from "../adapters/board-tools-api";
import { useServerBoardAccessPreview } from "../hooks/use-server-board-access-preview";

export function BoardAccessPreviewResult({
  user,
  access,
}: {
  user: BoardPreviewUser;
  access: BoardAccessPreview;
}) {
  return createElement(
    "section",
    { "aria-label": `Board access for ${user.username}`, className: "min-w-0" },
    createElement(
      "h3",
      { className: "font-semibold break-words" },
      "Board-level access for ",
      user.username,
    ),
    createElement(
      "p",
      { className: "text-muted-foreground mt-1 text-sm" },
      access.level === null
        ? "This person cannot open this Board."
        : `Level on this Board: ${access.level}.`,
    ),
    createElement(
      "dl",
      {
        className:
          "border-border mt-4 grid gap-x-4 gap-y-2 border-t pt-4 text-sm sm:grid-cols-[1fr_auto]",
      },
      createElement("dt", null, "Can read posts and events"),
      createElement(
        "dd",
        { className: "font-medium sm:text-right" },
        access.view ? "Yes" : "No",
      ),
      createElement("dt", null, "Can add posts and events"),
      createElement(
        "dd",
        { className: "font-medium sm:text-right" },
        access.edit ? "Yes" : "No",
      ),
      createElement("dt", null, "Can manage posts and events"),
      createElement(
        "dd",
        { className: "font-medium sm:text-right" },
        access.manage ? "Yes" : "No",
      ),
    ),
  );
}

function AccessPreviewForBoard({
  boardId,
  refreshKey,
}: {
  boardId: string;
  refreshKey: number;
}) {
  const model = useServerBoardAccessPreview(boardId, refreshKey);
  const {
    access,
    canPreview,
    users,
    page,
    selected,
    preview,
    search,
    searchInput,
    setSearchInput,
    offset,
    submitSearch,
    chooseUser,
    previousPage,
    nextPage,
    retryAccess,
    retryUsers,
    retryPreview,
  } = model;

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitSearch();
  }

  return (
    <section
      aria-label="Preview Board access"
      className="flex min-w-0 flex-col gap-4"
    >
      <div>
        <h2 data-slot="section-title" className="text-lg font-semibold">
          Preview Board access
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Check a person&apos;s effective Board permissions. This does not act
          as that person.
        </p>
      </div>
      {(!access || access.status === "loading") && (
        <p role="status" className="text-muted-foreground text-sm">
          Checking your Board access…
        </p>
      )}
      {access?.status === "error" && (
        <Alert variant="destructive">
          <p>{access.error}</p>
          <Button
            type="button"
            variant="outline"
            className="mt-3 min-h-11"
            onClick={retryAccess}
          >
            Refresh Board access
          </Button>
        </Alert>
      )}
      {canPreview && (
        <>
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={onSearch}
          >
            <div className="min-w-0 flex-1">
              <label
                htmlFor="board-preview-search"
                className="mb-1 block text-sm font-medium"
              >
                Find a person
              </label>
              <Input
                id="board-preview-search"
                className="min-h-11"
                maxLength={100}
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search active people by username"
              />
            </div>
            <Button type="submit" variant="outline" className="min-h-11">
              Search
            </Button>
          </form>
          {!users || users.status === "loading" ? (
            <p role="status" className="text-muted-foreground text-sm">
              Loading active people…
            </p>
          ) : users.status === "error" ? (
            <Alert variant="destructive">
              <p>{users.error}</p>
              <Button
                type="button"
                variant="outline"
                className="mt-3 min-h-11"
                onClick={retryUsers}
              >
                Retry people
              </Button>
            </Alert>
          ) : page && page.items.length === 0 ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-muted-foreground text-sm">
                {offset > 0
                  ? "No people remain on this page."
                  : search
                    ? "No active people match this search."
                    : "No active people are available for preview."}
              </p>
              {offset > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={previousPage}
                >
                  Previous page
                </Button>
              )}
            </div>
          ) : page ? (
            <>
              <div className="max-w-md">
                <label
                  htmlFor="board-preview-person"
                  className="mb-1 block text-sm font-medium"
                >
                  Person
                </label>
                <NativeSelect
                  className="w-full [&_select]:min-h-11"
                  id="board-preview-person"
                  value={selected?.id ?? ""}
                  onChange={(event) => chooseUser(event.target.value)}
                >
                  <NativeSelectOption value="">
                    Choose a person
                  </NativeSelectOption>
                  {page.items.map((user) => (
                    <NativeSelectOption key={user.id} value={user.id}>
                      {user.username}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              {(page.pagination.total > page.pagination.limit ||
                offset > 0) && (
                <nav
                  aria-label="People pages"
                  className="flex flex-wrap items-center gap-2"
                >
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={offset === 0}
                    onClick={previousPage}
                  >
                    Previous
                  </Button>
                  <span className="text-muted-foreground text-sm">
                    Page {Math.floor(offset / page.pagination.limit) + 1} ·{" "}
                    {page.pagination.total} active people
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={!page.pagination.hasMore}
                    onClick={nextPage}
                  >
                    Next
                  </Button>
                </nav>
              )}
              {!selected && (
                <p className="text-muted-foreground text-sm">
                  Choose a person to see their Board-level access.
                </p>
              )}
              {selected &&
                (preview.status === "idle" || preview.status === "loading") && (
                  <p role="status" className="text-muted-foreground text-sm">
                    Checking {selected.username}&apos;s Board access…
                  </p>
                )}
              {selected && preview.status === "error" && (
                <Alert variant="destructive">
                  <p>{preview.error}</p>
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-3 min-h-11"
                    onClick={retryPreview}
                  >
                    Retry preview
                  </Button>
                </Alert>
              )}
              {selected && preview.data && (
                <BoardAccessPreviewResult
                  user={selected}
                  access={preview.data}
                />
              )}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

export function ServerBackedBoardAccessPreview({
  boardId,
  refreshKey,
}: {
  boardId: string;
  refreshKey: number;
}) {
  return (
    <AccessPreviewForBoard
      key={boardId}
      boardId={boardId}
      refreshKey={refreshKey}
    />
  );
}
