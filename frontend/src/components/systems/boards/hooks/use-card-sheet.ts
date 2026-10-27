"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import {
  addChecklistItem,
  deleteChecklistItem,
  orderChecklist,
  readCardSheet,
  saveCardFields,
  updateChecklistItem,
  type CardFieldChanges,
} from "../adapters/board-card-sheet-api";
import type { BoardAttachmentVersions } from "../adapters/board-files-api";
import {
  isStaleKanbanWrite,
  kanbanErrorMessage,
} from "../adapters/board-kanban-api";
import { kanbanKeys } from "../adapters/board-kanban-queries";
import type {
  CardSheet,
  ChecklistItem,
  KanbanCard,
} from "../adapters/board-kanban-schemas";
import { uuid } from "../adapters/board-kanban-schemas";
import { readBoard } from "../adapters/board-management-api";
import { listBoardPostAuthors } from "../adapters/board-post-author-api";
import { authMeOptions } from "@/components/systems/openview/adapters/openview-queries";
import {
  assigneeChoices,
  movedChecklist,
  type AssigneeChoice,
} from "../domain/card-sheet";

/** The words a save announces ("Due saved."), by the field it changed. */
export const CARD_FIELD_WORDS = {
  title: "Title",
  assignee: "Assignee",
  start: "Start",
  due: "Due",
  cardStart: "Card start",
  cardDue: "Card due",
  labels: "Labels",
  description: "Description",
} as const;
export type CardField = keyof typeof CARD_FIELD_WORDS;

export type CardSheetState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "error"; retry: () => void }
  | { kind: "ready"; sheet: CardSheet };

function refused(error: unknown): boolean {
  return (
    error instanceof ApiError && [401, 403, 404, 422].includes(error.status)
  );
}

/**
 * One open card's sheet (BR64): its read, its revisioned field saves, its
 * checklist, and the versions its files and links carry. Saves run one at
 * a time; each announces itself in the sheet, and a stale one says so and
 * reads the card again. A text edit keeps the revision it started from, so
 * another person's change in the meantime is refused, not overwritten.
 */
export function useCardSheet({
  boardId,
  cardId,
  listed,
}: {
  boardId: string;
  cardId: string | null;
  /** The card as the board drew it, when it did. */
  listed: KanbanCard | null;
}) {
  const client = useQueryClient();
  // A malformed id is unavailable at once: no read, no Retry (BF-6).
  const locked =
    listed?.record?.locked === true ||
    (cardId !== null && !uuid.safeParse(cardId).success);
  const key = kanbanKeys.card(boardId, cardId ?? "");
  const read = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => readCardSheet(boardId, cardId ?? "", signal),
    enabled: cardId !== null && !locked,
    staleTime: 0,
  });
  const sheet = read.data?.card.id === cardId ? read.data : null;
  const state: CardSheetState =
    cardId === null || locked
      ? { kind: "unavailable" }
      : sheet && sheet.card.record?.locked !== true && !sheet.card.archivedAt
        ? { kind: "ready", sheet }
        : sheet || (read.isError && refused(read.error))
          ? { kind: "unavailable" }
          : read.isError
            ? { kind: "error", retry: () => void read.refetch() }
            : { kind: "loading" };

  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // Another card's words never show on this one.
  const [shownFor, setShownFor] = useState(cardId);
  if (shownFor !== cardId) {
    setShownFor(cardId);
    setNotice("");
    setProblem(null);
  }
  const [saving, setSaving] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // This viewer's own saves: the revision each started from, and the one it
  // made. A text edit that began before them still holds.
  // Keyed by card and revision, so one card's saves never move another's.
  const ownBumps = useRef(new Map<string, number>());
  const bumpKey = (revision: number) => `${cardId ?? ""}:${revision}`;

  const latest = () => client.getQueryData<CardSheet>(key);
  const advance = (revision: number) => {
    let current = revision;
    for (
      let step = 0;
      step < 100 && ownBumps.current.has(bumpKey(current));
      step += 1
    )
      current = ownBumps.current.get(bumpKey(current)) ?? current;
    return current;
  };
  const settle = (next: CardSheet) => {
    client.setQueryData(key, next);
    client.setQueryData<KanbanCard[]>(kanbanKeys.cards(boardId), (cards) => {
      if (!cards) return cards;
      const others = cards.filter((card) => card.id !== next.card.id);
      return next.card.archivedAt === null ? [...others, next.card] : others;
    });
  };
  const reread = async () => {
    const next = await client.fetchQuery({
      queryKey: key,
      queryFn: ({ signal }) => readCardSheet(boardId, cardId ?? "", signal),
      staleTime: 0,
    });
    settle(next);
    return next;
  };
  const fail = (error: unknown) => {
    setNotice("");
    setProblem(kanbanErrorMessage(error));
    if (isStaleKanbanWrite(error) || refused(error)) {
      void client.invalidateQueries({ queryKey: key });
      void client.invalidateQueries({ queryKey: kanbanKeys.cards(boardId) });
    }
  };
  function enqueue<T>(lock: string, work: () => Promise<T>): Promise<T | null> {
    const run = queue.current.then(async () => {
      setSaving(lock);
      setProblem(null);
      try {
        return await work();
      } catch (error) {
        fail(error);
        return null;
      } finally {
        setSaving(null);
      }
    });
    queue.current = run.catch(() => undefined);
    return run;
  }

  /**
   * Save card fields. `startRevision` is the revision a text edit began
   * from; a pick (a select, a date, a label) saves on the latest.
   */
  function save(
    field: CardField,
    changes: CardFieldChanges,
    startRevision?: number,
  ): Promise<boolean> {
    return enqueue(field, async () => {
      const current = latest();
      if (!current || cardId === null) return false;
      const revision =
        startRevision === undefined
          ? current.card.revision
          : advance(startRevision);
      const next = await saveCardFields(
        boardId,
        { id: cardId, revision },
        changes,
      );
      ownBumps.current.set(bumpKey(revision), next.card.revision);
      settle(next);
      setNotice(`${CARD_FIELD_WORDS[field]} saved.`);
      return true;
    }).then((done) => done === true);
  }

  /** A checklist change, then the card again for its count (BR67 "3/5"). */
  function checklistWork(
    lock: string,
    words: string,
    work: () => Promise<unknown>,
  ): Promise<boolean> {
    return enqueue(lock, async () => {
      await work();
      await reread();
      setNotice(words);
      return true;
    }).then((done) => done === true);
  }
  const checklist = {
    add: (text: string) =>
      checklistWork("checklist:new", "Checklist item added.", () =>
        addChecklistItem(boardId, cardId ?? "", text),
      ),
    tick: (item: ChecklistItem, done: boolean) =>
      checklistWork(
        `checklist:${item.id}`,
        done ? `${item.text} done.` : `${item.text} reopened.`,
        () => updateChecklistItem(boardId, item, { done }),
      ),
    rename: (item: ChecklistItem, text: string) =>
      checklistWork(`checklist:${item.id}`, "Checklist item renamed.", () =>
        updateChecklistItem(boardId, item, { text }),
      ),
    remove: (item: ChecklistItem) =>
      checklistWork(`checklist:${item.id}`, `${item.text} removed.`, () =>
        deleteChecklistItem(boardId, item),
      ),
    move: (
      items: readonly ChecklistItem[],
      item: ChecklistItem,
      offset: -1 | 1,
    ) => {
      const ids = movedChecklist(items, item.id, offset);
      if (!ids) return Promise.resolve(false);
      return checklistWork(
        `checklist:${item.id}`,
        `${item.text} moved ${offset < 0 ? "up" : "down"}.`,
        () => orderChecklist(boardId, cardId ?? "", ids),
      );
    },
  };

  /** After a move from the sheet: say where it went and read the card. */
  const moved = (stageName: string) => {
    setProblem(null);
    setNotice(`Moved to ${stageName}.`);
    void client.invalidateQueries({ queryKey: key });
  };

  // ---- Files and linked records: the board's and the card's revisions ----
  const boardRevision = useQuery({
    queryKey: kanbanKeys.boardRevision(boardId),
    queryFn: async () => (await readBoard(boardId)).revision,
    staleTime: 0,
    enabled: false,
  });
  const versions: BoardAttachmentVersions | null =
    boardRevision.data !== undefined && sheet
      ? {
          boardRevision: boardRevision.data,
          contentRevision: sheet.card.revision,
        }
      : null;
  /** Read both revisions now (the Files or Linked records tab opened). */
  const loadVersions = () => void boardRevision.refetch();
  /**
   * A file or link change bumps both revisions (Recorded during P0): read
   * the card and the board again, so the next save carries them.
   */
  async function refreshVersions(): Promise<BoardAttachmentVersions> {
    const before = latest()?.card.revision;
    const [next, board] = await Promise.all([
      readCardSheet(boardId, cardId ?? ""),
      readBoard(boardId),
    ]);
    if (before !== undefined && next.card.revision === before + 1)
      ownBumps.current.set(bumpKey(before), next.card.revision);
    settle(next);
    client.setQueryData(kanbanKeys.boardRevision(boardId), board.revision);
    return {
      boardRevision: board.revision,
      contentRevision: next.card.revision,
    };
  }

  return {
    state,
    notice,
    problem,
    saving,
    save,
    checklist,
    moved,
    versions,
    loadVersions,
    refreshVersions,
    clearFeedback: () => {
      setNotice("");
      setProblem(null);
    },
  };
}

export type CardSheetModel = ReturnType<typeof useCardSheet>;

/**
 * Who a writer can pick as a card's assignee: the viewer, the people
 * assigned on the board, and its post authors (see `assigneeChoices`).
 */
export function useAssigneeChoices({
  boardId,
  enabled,
  assigned,
}: {
  boardId: string;
  enabled: boolean;
  assigned: readonly AssigneeChoice[];
}): AssigneeChoice[] {
  const identity = useQuery(authMeOptions());
  const authors = useQuery({
    queryKey: kanbanKeys.authors(boardId),
    queryFn: ({ signal }) =>
      listBoardPostAuthors(boardId, { limit: 100, signal }),
    enabled,
  });
  if (!enabled) return [];
  const me = identity.data;
  return assigneeChoices({
    viewer: me ? { id: me.id, name: me.displayName || me.username } : null,
    assigned,
    authors: (authors.data?.items ?? []).map((author) => ({
      id: author.id,
      name: author.label,
    })),
  });
}
