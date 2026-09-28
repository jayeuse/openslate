"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { listAccessGroups } from "@/components/systems/access/state/api";
import {
  readBoardGroups,
  replaceBoardGroups,
  type BoardAccessLevel,
  type BoardGroups,
} from "../adapters/board-management-api";

const LEVELS: { value: BoardAccessLevel; label: string; hint: string }[] = [
  { value: "read", label: "Read", hint: "sees posts, events and widgets" },
  { value: "write", label: "Write", hint: "also adds posts and events" },
  {
    value: "manage",
    label: "Manage",
    hint: "also pins posts, changes widgets and other people's posts",
  },
];

type Entry = BoardGroups["groups"][number];
type GroupChoice = { id: string; name: string };

type Loaded =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: BoardGroups };

function sameEntries(left: Entry[], right: Entry[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.groupId === right[index].groupId &&
        entry.level === right[index].level,
    )
  );
}

function saveError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409)
    return error.code === "group_unavailable"
      ? "A chosen group was removed. Reload the groups and try again."
      : "This Board changed. Reload the groups before you save.";
  if (error instanceof ApiError && error.status === 403)
    return "Only an administrator can change the groups of a Board.";
  return "The groups could not be saved. Try again.";
}

/**
 * The groups of a project Board and their levels. Board managers see them;
 * only administrators change them.
 */
export function ServerBackedBoardGroups({
  boardId,
  boardActive,
  isAdmin,
  onChanged,
}: {
  boardId: string;
  boardActive: boolean;
  isAdmin: boolean;
  onChanged?: () => void;
}) {
  const id = useId();
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; value: Loaded } | null>(
    null,
  );
  const [draft, setDraft] = useState<Entry[] | null>(null);
  const [choices, setChoices] = useState<GroupChoice[] | null>(null);
  const [adding, setAdding] = useState<{
    groupId: string;
    level: BoardAccessLevel;
  }>({ groupId: "", level: "read" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const key = `${boardId}:${reloadKey}`;

  useEffect(() => {
    let current = true;
    readBoardGroups(boardId).then(
      (data) => {
        if (!current) return;
        setLoaded({ key, value: { status: "ready", data } });
        setDraft(null);
      },
      () => {
        if (!current) return;
        setLoaded({
          key,
          value: { status: "error", error: "The groups could not be loaded." },
        });
      },
    );
    return () => {
      current = false;
    };
  }, [boardId, key]);

  useEffect(() => {
    if (!isAdmin) return;
    const controller = new AbortController();
    listAccessGroups({
      limit: 100,
      sort_by: "name",
      sort_order: "asc",
      signal: controller.signal,
    }).then(
      (page) =>
        setChoices(
          page.items
            .filter((group) => !group.is_deleted)
            .map((group) => ({ id: group.id, name: group.name })),
        ),
      () => {
        if (!controller.signal.aborted) setChoices([]);
      },
    );
    return () => controller.abort();
  }, [isAdmin]);

  const state: Loaded =
    loaded?.key === key ? loaded.value : { status: "loading" };
  const saved = state.status === "ready" ? state.data : null;
  const entries = draft ?? saved?.groups ?? [];
  const dirty = saved !== null && !sameEntries(entries, saved.groups);
  const editable = isAdmin && boardActive && saved !== null;
  const available = (choices ?? []).filter(
    (choice) => !entries.some((entry) => entry.groupId === choice.id),
  );

  function change(next: Entry[]) {
    setDraft(next);
    setNotice(null);
    setError(null);
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const choice = available.find((item) => item.id === adding.groupId);
    if (!choice) return;
    change([
      ...entries,
      { groupId: choice.id, name: choice.name, level: adding.level },
    ]);
    setAdding({ groupId: "", level: "read" });
  }

  async function save() {
    if (!saved || pending || !dirty) return;
    setPending(true);
    setError(null);
    try {
      const result = await replaceBoardGroups(boardId, {
        revision: saved.revision,
        groups: entries.map(({ groupId, level }) => ({ groupId, level })),
      });
      setLoaded({ key, value: { status: "ready", data: result } });
      setDraft(null);
      setNotice("Board groups saved.");
      onChanged?.();
    } catch (failure) {
      setError(saveError(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="border-border space-y-4 border-t pt-5"
    >
      <div>
        <h3 id={`${id}-title`} className="text-sm font-medium">
          Groups
        </h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Members of these groups open this Board. A person in more than one
          group gets the highest level.
        </p>
      </div>
      {state.status === "loading" && (
        <p role="status" className="text-muted-foreground text-sm">
          Loading groups…
        </p>
      )}
      {state.status === "error" && (
        <Alert variant="destructive">
          <p>{state.error}</p>
          <Button
            type="button"
            variant="outline"
            className="mt-3 min-h-11"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            Retry
          </Button>
        </Alert>
      )}
      {saved && (
        <>
          {entries.length === 0 ? (
            <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
              No groups yet. Only administrators open this Board.
            </p>
          ) : (
            <ul aria-label="Board groups" className="divide-border divide-y">
              {entries.map((entry, index) => (
                <li
                  key={entry.groupId}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="min-w-0 flex-1 text-sm font-medium break-words">
                    {entry.name}
                  </span>
                  {editable ? (
                    <div className="flex items-center gap-2">
                      <NativeSelect
                        aria-label={`Level for ${entry.name}`}
                        className="[&_select]:min-h-11"
                        value={entry.level}
                        disabled={pending}
                        onChange={(event) =>
                          change(
                            entries.map((item, position) =>
                              position === index
                                ? {
                                    ...item,
                                    level: event.target
                                      .value as BoardAccessLevel,
                                  }
                                : item,
                            ),
                          )
                        }
                      >
                        {LEVELS.map((level) => (
                          <NativeSelectOption
                            key={level.value}
                            value={level.value}
                          >
                            {level.label}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-h-11"
                        disabled={pending}
                        aria-label={`Remove ${entry.name}`}
                        onClick={() =>
                          change(
                            entries.filter(
                              (item) => item.groupId !== entry.groupId,
                            ),
                          )
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <span className="text-muted-foreground text-sm capitalize">
                      {entry.level}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <form
              onSubmit={add}
              className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <label htmlFor={`${id}-group`} className="text-sm font-medium">
                  Add a group
                </label>
                <NativeSelect
                  id={`${id}-group`}
                  className="w-full [&_select]:min-h-11"
                  value={adding.groupId}
                  disabled={pending || choices === null}
                  onChange={(event) =>
                    setAdding({ ...adding, groupId: event.target.value })
                  }
                >
                  <NativeSelectOption value="">
                    {choices === null
                      ? "Loading groups…"
                      : available.length === 0
                        ? "No other groups"
                        : "Choose a group"}
                  </NativeSelectOption>
                  {available.map((choice) => (
                    <NativeSelectOption key={choice.id} value={choice.id}>
                      {choice.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <label htmlFor={`${id}-level`} className="text-sm font-medium">
                  Level
                </label>
                <NativeSelect
                  id={`${id}-level`}
                  className="w-full [&_select]:min-h-11"
                  value={adding.level}
                  disabled={pending}
                  onChange={(event) =>
                    setAdding({
                      ...adding,
                      level: event.target.value as BoardAccessLevel,
                    })
                  }
                >
                  {LEVELS.map((level) => (
                    <NativeSelectOption key={level.value} value={level.value}>
                      {level.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <Button
                type="submit"
                variant="outline"
                className="min-h-11"
                disabled={pending || !adding.groupId}
              >
                Add group
              </Button>
            </form>
          )}
          {editable && (
            <dl className="text-muted-foreground grid gap-1 text-sm">
              {LEVELS.map((level) => (
                <div key={level.value} className="flex gap-1">
                  <dt className="text-foreground font-medium">
                    {level.label}:
                  </dt>
                  <dd>{level.hint}.</dd>
                </div>
              ))}
            </dl>
          )}
          {!isAdmin && (
            <p className="text-muted-foreground text-sm">
              Only an administrator changes these groups.
            </p>
          )}
          {error && <Alert variant="destructive">{error}</Alert>}
          {notice && (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}
          {editable && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                className="min-h-11"
                disabled={pending || !dirty}
                onClick={() => void save()}
              >
                {pending ? "Saving…" : "Save groups"}
              </Button>
              {dirty && (
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  disabled={pending}
                  onClick={() => change(saved.groups)}
                >
                  Discard changes
                </Button>
              )}
              {error && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={pending}
                  onClick={() => setReloadKey((value) => value + 1)}
                >
                  Reload groups
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
