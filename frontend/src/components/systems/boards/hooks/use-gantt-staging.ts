"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  kanbanErrorMessage,
  saveCardDates,
} from "../adapters/board-kanban-api";
import { kanbanKeys } from "../adapters/board-kanban-queries";
import type { KanbanCard } from "../adapters/board-kanban-schemas";
import {
  batchPayload,
  discardDraft,
  pruneStaged,
  settleResults,
  stageDraft,
  undoDiscard,
  type CardDates,
  type GanttDraft,
  type StagedDates,
} from "../domain/gantt";
import { cardName } from "../domain/kanban";

export type GanttProblem = { cardId: string; text: string };

/**
 * The Gantt's staged date changes (BR65, BR75): one owner for the set, the
 * set a Discard put aside for Undo, the save, and what each card's result
 * says. Save changes sends every change in one `batch-dates` request;
 * updated cards land in the board's card cache, and a stale or refused card
 * is read again. A failed request keeps every change.
 */
export function useGanttStaging(boardId: string, cards: readonly KanbanCard[]) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<GanttDraft>(() => ({
    staged: new Map(),
    discarded: null,
  }));
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<GanttProblem[]>([]);
  // A failed request, said next to Save changes; the cards stay staged.
  const [failure, setFailure] = useState("");
  // The 101st card waits for a save (a warning, not an error).
  const [full, setFull] = useState(false);
  const [notice, setNotice] = useState("");
  // A card archived elsewhere leaves the set (G8).
  const staged = pruneStaged(draft.staged, cards);
  const current: GanttDraft = { ...draft, staged };

  /** Stages new dates and returns the new set; null when it is full. */
  function stage(card: KanbanCard, to: CardDates): StagedDates | null {
    if (saving) return null;
    const result = stageDraft(current, card, to);
    if (result.refused) {
      setFull(true);
      return null;
    }
    setDraft(result.draft);
    // A new change starts a new round: the last save's results go, and so
    // does the chance to undo a Discard.
    setProblems([]);
    setFailure("");
    setFull(false);
    setNotice("");
    return result.draft.staged;
  }

  function discard() {
    setDraft(discardDraft(current));
    setProblems([]);
    setFailure("");
    setFull(false);
    setNotice("Changes discarded");
  }

  /** Brings the discarded set back and returns it. */
  function undo(): StagedDates {
    const next = undoDiscard(current, cards);
    setDraft(next);
    setNotice("");
    return next.staged;
  }

  async function save() {
    if (saving || staged.size === 0) return;
    const sent = staged;
    setSaving(true);
    setProblems([]);
    setFailure("");
    setFull(false);
    setNotice("");
    try {
      const results = await saveCardDates(boardId, batchPayload(sent));
      const settled = settleResults(sent, results);
      const saved = new Map(settled.updated.map((item) => [item.cardId, item]));
      client.setQueryData<KanbanCard[]>(kanbanKeys.cards(boardId), (list) =>
        list?.map((card) => {
          const item = saved.get(card.id);
          return item
            ? {
                ...card,
                revision: item.revision,
                startOn: item.startOn,
                dueOn: item.dueOn,
              }
            : card;
        }),
      );
      setDraft({ staged: settled.staged, discarded: null });
      const names = new Map(cards.map((card) => [card.id, cardName(card)]));
      setProblems(
        settled.problems.map((problem) => ({
          cardId: problem.cardId,
          text: `${names.get(problem.cardId) ?? "A card"}: ${problem.message}`,
        })),
      );
      if (settled.problems.length > 0)
        // The refused cards show as the server has them now.
        void client.invalidateQueries({ queryKey: kanbanKeys.cards(boardId) });
      const count = settled.updated.length;
      setNotice(
        count === 0
          ? ""
          : count === 1
            ? "Dates saved."
            : `Dates saved for ${count} cards.`,
      );
    } catch (error) {
      setFailure(kanbanErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return {
    staged,
    /** Undo is offered while a discarded set waits and nothing is staged. */
    canUndo: draft.discarded !== null && staged.size === 0,
    saving,
    problems,
    failure,
    full,
    notice,
    stage,
    discard,
    undo,
    save,
  };
}

export type GanttStaging = ReturnType<typeof useGanttStaging>;
