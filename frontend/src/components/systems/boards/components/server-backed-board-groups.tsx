"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Alert } from "@/components/ui/alert";
import { SearchSelect } from "@/components/ui/search-select";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Field, FieldLabel } from "@/components/ui/field";
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
import { BoardLevelChip } from "./board-page-header";

/** The level chip's words (D2); the values stay the server's. */
const LEVELS: { value: BoardAccessLevel; label: string; hint: string }[] = [
  { value: "read", label: "Read", hint: "sees posts, events and cards" },
  { value: "write", label: "Post", hint: "also adds posts, events and cards" },
  {
    value: "manage",
    label: "Manager",
    hint: "also edits stages and labels, and pins posts",
  },
];

const control = "min-h-11 xl:min-h-8";
const selectControl = "[&_select]:min-h-11 xl:[&_select]:min-h-8";

type Entry = BoardGroups["groups"][number];
type GroupChoice = { id: string; name: string };

type Loaded =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: BoardGroups };

/** The change being saved; its row shows "Saving…" and only it locks. */
type Saving = { groupId: string; next: Entry[] };
/** The last result, said beside its row (or under the add form). */
type RowResult = { groupId: string; text: string; failed: boolean };
/** A removed group and its place, for Undo. */
type Removed = { entry: Entry; index: number };

function saveError(error: unknown): { text: string; reload: boolean } {
  if (error instanceof ApiError && error.status === 409)
    return error.code === "group_unavailable"
      ? {
          text: "That group was removed. The list is read again.",
          reload: true,
        }
      : { text: "Someone changed this board first.", reload: true };
  if (error instanceof ApiError && error.status === 403)
    return { text: "Only an admin can change these groups.", reload: false };
  return { text: "The groups could not be saved. Try again.", reload: false };
}

/**
 * The groups of a project board and their levels (D1). Each change saves at
 * once with the board revision, as the Access grants list does: add, a level,
 * and Remove, which offers Undo. Board managers see the groups; only admins
 * change them.
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
  const actorId = useVerifiedWorkspaceUserId();
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; value: Loaded } | null>(
    null,
  );
  const [choices, setChoices] = useState<{
    key: string;
    items: GroupChoice[];
    nextOffset: number;
    hasMore: boolean;
  } | null>(null);
  const [groupSearch, setGroupSearch] = useState("");
  const [groupOffset, setGroupOffset] = useState<{
    key: string;
    offset: number;
  } | null>(null);
  const [groupRetry, setGroupRetry] = useState(0);
  const [choicesLoading, setChoicesLoading] = useState(false);
  const [choicesError, setChoicesError] = useState<string | null>(null);
  const [selectedGroupState, setSelectedGroup] = useState<
    (GroupChoice & { scope: string }) | null
  >(null);
  const scopeKey = `${actorId}:${boardId}`;
  const selectedGroup =
    selectedGroupState?.scope === scopeKey ? selectedGroupState : null;
  const choicesKey = JSON.stringify([scopeKey, isAdmin, groupSearch.trim()]);
  const offset = groupOffset?.key === choicesKey ? groupOffset.offset : 0;
  const [adding, setAdding] = useState<{
    groupId: string;
    level: BoardAccessLevel;
  }>({ groupId: "", level: "read" });
  const [saving, setSaving] = useState<Saving | null>(null);
  const savingRef = useRef(false);
  const [result, setResult] = useState<RowResult | null>(null);
  const [removed, setRemoved] = useState<Removed | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  /** Where focus goes once the list has drawn (R5). */
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const levelRefs = useRef(new Map<string, HTMLSelectElement>());
  const key = `${boardId}:${reloadKey}`;
  const addId = `${id}-group`;

  useEffect(() => {
    let current = true;
    readBoardGroups(boardId).then(
      (data) => {
        if (!current) return;
        setLoaded({ key, value: { status: "ready", data } });
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
    setChoicesLoading(true);
    setChoicesError(null);
    const timer = setTimeout(
      () => {
        void listAccessGroups({
          limit: 25,
          offset,
          search: groupSearch.trim() || undefined,
          sort_by: "name",
          sort_order: "asc",
          signal: controller.signal,
        })
          .then((page) => {
            if (controller.signal.aborted) return;
            const items = page.items
              .filter((group) => !group.is_deleted)
              .map((group) => ({ id: group.id, name: group.name }));
            setChoices((current) => ({
              key: choicesKey,
              items:
                offset > 0 && current?.key === choicesKey
                  ? [
                      ...new Map(
                        [...current.items, ...items].map((item) => [
                          item.id,
                          item,
                        ]),
                      ).values(),
                    ]
                  : items,
              nextOffset: page.pagination.offset + page.pagination.count,
              hasMore: page.pagination.has_more,
            }));
            setChoicesLoading(false);
          })
          .catch((failure: unknown) => {
            if (controller.signal.aborted) return;
            if (
              failure instanceof ApiError &&
              [401, 403, 404].includes(failure.status)
            ) {
              setChoices(null);
              setSelectedGroup(null);
              setAdding({ groupId: "", level: "read" });
            }
            setChoicesError("Group choices could not be loaded. Retry.");
            setChoicesLoading(false);
          });
      },
      groupSearch ? 200 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [choicesKey, groupSearch, groupRetry, isAdmin, offset]);

  const state: Loaded =
    loaded?.key === key ? loaded.value : { status: "loading" };
  // A re-read keeps the last list on screen (last good), but nothing saves
  // on its old revision meanwhile.
  const lastGood =
    loaded?.value.status === "ready" && loaded.value.data.boardId === boardId
      ? loaded.value.data
      : null;
  const saved = state.status === "ready" ? state.data : lastGood;
  const rereading = state.status === "loading" && saved !== null;
  // While a change saves, the list shows it; a failure puts the saved back.
  const entries = saving?.next ?? saved?.groups ?? [];

  useEffect(() => {
    if (focusTarget === null) return;
    const target =
      focusTarget === "add"
        ? document.getElementById(addId)
        : levelRefs.current.get(focusTarget);
    if (!target) return;
    target.focus();
    setFocusTarget(null);
  }, [focusTarget, entries, addId]);

  const editable = isAdmin && boardActive && saved !== null;
  const currentChoices = choices?.key === choicesKey ? choices : null;
  const available = (currentChoices?.items ?? []).filter(
    (choice) => !entries.some((entry) => entry.groupId === choice.id),
  );

  /** Sends the whole list with the board revision; one save at a time. */
  async function save(
    next: Entry[],
    groupId: string,
    after: { removed?: Removed; focus?: string },
  ) {
    if (!saved || savingRef.current || rereading) return false;
    savingRef.current = true;
    setSaving({ groupId, next });
    setResult(null);
    setRemoved(null);
    setListError(null);
    try {
      const data = await replaceBoardGroups(boardId, {
        revision: saved.revision,
        groups: next.map((entry) => ({
          groupId: entry.groupId,
          level: entry.level,
        })),
      });
      setLoaded({ key, value: { status: "ready", data } });
      if (after.removed) setRemoved(after.removed);
      else setResult({ groupId, text: "Saved.", failed: false });
      if (after.focus) setFocusTarget(after.focus);
      onChanged?.();
      return true;
    } catch (failure) {
      const { text, reload } = saveError(failure);
      if (reload) {
        // The board moved on: read the groups and the board again.
        setListError(text);
        setReloadKey((value) => value + 1);
        onChanged?.();
      } else setResult({ groupId, text, failed: true });
      return false;
    } finally {
      savingRef.current = false;
      setSaving(null);
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saved) return;
    const choice =
      available.find((item) => item.id === adding.groupId) ??
      (selectedGroup?.id === adding.groupId ? selectedGroup : null);
    if (!choice || entries.some((entry) => entry.groupId === choice.id)) return;
    // Add group turns off once nothing is chosen: focus waits on the picker.
    document.getElementById(addId)?.focus();
    const level = adding.level;
    setAdding({ groupId: "", level: "read" });
    setSelectedGroup(null);
    void save(
      [...saved.groups, { groupId: choice.id, name: choice.name, level }],
      choice.id,
      {},
    );
  }

  function changeLevel(entry: Entry, level: BoardAccessLevel) {
    if (!saved || level === entry.level) return;
    void save(
      saved.groups.map((item) =>
        item.groupId === entry.groupId ? { ...item, level } : item,
      ),
      entry.groupId,
      {},
    );
  }

  function remove(entry: Entry) {
    if (!saved || savingRef.current) return;
    const index = saved.groups.findIndex(
      (item) => item.groupId === entry.groupId,
    );
    // Focus moves before the row goes: the next row, the one before, or
    // the picker when no row is left.
    const neighbour = saved.groups[index + 1] ?? saved.groups[index - 1];
    const target = neighbour
      ? levelRefs.current.get(neighbour.groupId)
      : document.getElementById(addId);
    target?.focus();
    void save(
      saved.groups.filter((item) => item.groupId !== entry.groupId),
      entry.groupId,
      { removed: { entry, index } },
    );
  }

  function undo() {
    if (!saved || !removed) return;
    const next = [...saved.groups];
    next.splice(Math.min(removed.index, next.length), 0, removed.entry);
    void save(next, removed.entry.groupId, { focus: removed.entry.groupId });
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="border-border space-y-4 border-t pt-5"
    >
      <div>
        <h3
          id={`${id}-title`}
          data-slot="section-title"
          className="text-sm font-medium"
        >
          Groups
        </h3>
        <p className="text-muted-foreground mt-1 text-sm">
          A person in several groups gets the highest level.
        </p>
      </div>
      {state.status === "loading" && !rereading && (
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
            className={cn(control, "mt-3")}
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
              No groups yet. Only admins open this board.
            </p>
          ) : (
            <ul aria-label="Board groups" className="divide-border divide-y">
              {entries.map((entry) => {
                const busy = saving?.groupId === entry.groupId;
                const shown = result?.groupId === entry.groupId ? result : null;
                const line = busy
                  ? "Saving…"
                  : shown && !shown.failed
                    ? shown.text
                    : "";
                return (
                  <li
                    key={entry.groupId}
                    aria-busy={busy || undefined}
                    className="flex min-w-0 flex-col gap-1 py-2 xl:py-1"
                  >
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 text-sm break-words">
                        <span className="font-medium">{entry.name}</span>
                        {line ? (
                          <span
                            aria-hidden="true"
                            className="text-muted-foreground"
                          >
                            {" · "}
                          </span>
                        ) : null}
                        {/* Kept mounted, so only its words change. */}
                        <span
                          role="status"
                          className="text-muted-foreground empty:sr-only"
                        >
                          {line}
                        </span>
                      </span>
                      {editable ? (
                        <div className="flex items-center gap-2">
                          <NativeSelect
                            ref={(node) => {
                              if (node)
                                levelRefs.current.set(entry.groupId, node);
                              else levelRefs.current.delete(entry.groupId);
                            }}
                            aria-label={`Level for ${entry.name}`}
                            className={selectControl}
                            value={entry.level}
                            aria-disabled={busy || undefined}
                            // Locked while it saves, but focusable: a
                            // disabled control would drop focus (R5).
                            onChange={(event) =>
                              changeLevel(
                                entry,
                                event.target.value as BoardAccessLevel,
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
                            className={control}
                            aria-disabled={busy || undefined}
                            aria-label={`Remove access for ${entry.name}`}
                            onClick={() => {
                              if (!busy) remove(entry);
                            }}
                          >
                            Remove
                          </Button>
                        </div>
                      ) : (
                        <BoardLevelChip level={entry.level} />
                      )}
                    </div>
                    {shown?.failed ? (
                      <p role="alert" className="text-danger-text text-sm">
                        {shown.text}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {/* The list's own line, kept mounted: a removal with Undo
              (Undo inside a sheet, DESIGN). */}
          <p
            className="text-muted-foreground text-sm empty:sr-only"
            role="status"
          >
            {removed ? (
              <>
                Removed {removed.entry.name} ·{" "}
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(control, "px-2")}
                  onClick={undo}
                >
                  Undo
                </Button>
              </>
            ) : null}
          </p>
          {listError ? (
            <p role="alert" className="text-danger-text text-sm">
              {listError}
            </p>
          ) : null}
          {editable && (
            <form
              onSubmit={add}
              className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end"
            >
              <div className="min-w-0 flex-1">
                <SearchSelect
                  id={addId}
                  label="Add a group"
                  value={adding.groupId}
                  placeholder="Choose a group"
                  popupClassName="slim-ui"
                  options={available.map((choice) => ({
                    value: choice.id,
                    label: choice.name,
                  }))}
                  selectedOption={
                    selectedGroup
                      ? { value: selectedGroup.id, label: selectedGroup.name }
                      : undefined
                  }
                  search={groupSearch}
                  onSearchChange={(value) =>
                    setGroupSearch(value.slice(0, 100))
                  }
                  loading={choicesLoading && offset === 0}
                  loadingMore={choicesLoading && offset > 0}
                  error={choicesError ?? undefined}
                  onRetry={() => setGroupRetry((value) => value + 1)}
                  hasMore={currentChoices?.hasMore}
                  onLoadMore={() => {
                    if (currentChoices?.hasMore && !choicesLoading)
                      setGroupOffset({
                        key: choicesKey,
                        offset: currentChoices.nextOffset,
                      });
                  }}
                  onValueChange={(value) => {
                    const choice =
                      available.find((item) => item.id === value) ??
                      (selectedGroup?.id === value ? selectedGroup : null);
                    if (value && !choice) return;
                    setSelectedGroup(
                      choice ? { ...choice, scope: scopeKey } : null,
                    );
                    setAdding({ ...adding, groupId: value });
                  }}
                />
              </div>
              <Field>
                <FieldLabel htmlFor={`${id}-level`}>Level</FieldLabel>
                <NativeSelect
                  id={`${id}-level`}
                  className={cn("w-full", selectControl)}
                  value={adding.level}
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
              </Field>
              <DisabledReason
                reason={adding.groupId ? null : "Choose a group first."}
                stable
              >
                <Button
                  type="submit"
                  variant="outline"
                  className={control}
                  pending={
                    saving !== null &&
                    !saved.groups.some(
                      (entry) => entry.groupId === saving.groupId,
                    )
                  }
                  pendingLabel="Adding…"
                >
                  Add group
                </Button>
              </DisabledReason>
            </form>
          )}
          {result?.failed &&
          !entries.some((entry) => entry.groupId === result.groupId) ? (
            <p role="alert" className="text-danger-text text-sm">
              {result.text}
            </p>
          ) : null}
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
              Only an admin can change these groups.
            </p>
          )}
        </>
      )}
    </section>
  );
}
