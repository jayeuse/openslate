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
  MAX_STAGED,
  batchPayload,
  pruneStaged,
  settleResults,
  stageDates,
  type CardDates,
  type StagedDates,
} from "../domain/gantt";
import { cardName } from "../domain/kanban";

export type GanttProblem = { cardId: string | null; text: string };

/**
 * The Gantt's staged date changes (BR65, BR75): one owner for the set, the
 * save, and what each card's result says. Save changes sends every change
 * in one `batch-dates` request; updated cards land in the board's card
 * cache, and a stale or refused card is read again. A failed request keeps
 * every change.
 */
export function useGanttStaging(boardId: string, cards: readonly KanbanCard[]) {
  const client = useQueryClient();
  const [raw, setRaw] = useState<StagedDates>(() => new Map());
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<GanttProblem[]>([]);
  const [notice, setNotice] = useState("");
  // A card archived elsewhere leaves the set (G8).
  const staged = pruneStaged(raw, cards);

  /** Stages new dates and returns the new set; null when it is full. */
  function stage(card: KanbanCard, to: CardDates): StagedDates | null {
    if (saving) return null;
    const result = stageDates(staged, card, to);
    if (result.refused) {
      setProblems([
        {
          cardId: null,
          text: `Save these changes first: one save holds ${MAX_STAGED} cards.`,
        },
      ]);
      return null;
    }
    setRaw(result.staged);
    // A new change starts a new round: the last save's results go.
    setProblems([]);
    setNotice("");
    return result.staged;
  }

  function discard() {
    setRaw(new Map());
    setProblems([]);
    setNotice("Changes discarded.");
  }

  async function save() {
    if (saving || staged.size === 0) return;
    const sent = staged;
    setSaving(true);
    setProblems([]);
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
      setRaw(settled.staged);
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
      setProblems([{ cardId: null, text: kanbanErrorMessage(error) }]);
    } finally {
      setSaving(false);
    }
  }

  return { staged, saving, problems, notice, stage, discard, save };
}

export type GanttStaging = ReturnType<typeof useGanttStaging>;
