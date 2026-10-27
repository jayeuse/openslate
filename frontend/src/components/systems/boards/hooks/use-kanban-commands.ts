"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import {
  archiveKanbanCard,
  archiveKanbanStage,
  createKanbanLabel,
  createKanbanStage,
  createObjectiveCard,
  createRecordCard,
  deleteKanbanLabel,
  isStaleKanbanWrite,
  kanbanErrorMessage,
  moveKanbanCard,
  orderKanbanStages,
  restoreKanbanCard,
  setKanbanCardLabels,
  updateKanbanLabel,
  updateKanbanStage,
  type StageChanges,
} from "../adapters/board-kanban-api";
import { kanbanKeys } from "../adapters/board-kanban-queries";
import type {
  ChartColor,
  KanbanCard,
  KanbanLabel,
  KanbanStage,
} from "../adapters/board-kanban-schemas";
import { applyMove, STARTER_STAGES } from "../domain/kanban";

/**
 * Every Kanban change for one board: card moves that save at once with
 * Undo (BR65, the Four Moments Rule), card adds, labels and archive, and
 * the managers' stage and label changes. A move shows at once; only the
 * moving card locks; a refusal puts the board back and reads it again.
 */
export function useKanbanCommands(boardId: string) {
  const client = useQueryClient();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const pendingRef = useRef(new Set<string>());
  const cardsKey = kanbanKeys.cards(boardId);

  const lock = (cardId: string, locked: boolean) => {
    if (locked) pendingRef.current.add(cardId);
    else pendingRef.current.delete(cardId);
    setPending(new Set(pendingRef.current));
  };
  const setCards = (update: (cards: KanbanCard[]) => KanbanCard[]) =>
    client.setQueryData<KanbanCard[]>(cardsKey, (cards) =>
      cards ? update(cards) : cards,
    );
  const replaceCard = (saved: KanbanCard) =>
    setCards((cards) => {
      const others = cards.filter((card) => card.id !== saved.id);
      return saved.archivedAt === null ? [...others, saved] : others;
    });
  const refresh = useCallback(
    () => client.invalidateQueries({ queryKey: kanbanKeys.board(boardId) }),
    [boardId, client],
  );
  const fail = (error: unknown) => {
    toast.add({ title: kanbanErrorMessage(error), type: "error" });
    void refresh();
  };

  /** The place of a card among its stage's other cards, for Undo. */
  const placeOf = (cards: readonly KanbanCard[], card: KanbanCard) =>
    cards
      .filter(
        (item) =>
          item.stageId === card.stageId &&
          item.id !== card.id &&
          item.archivedAt === null,
      )
      .filter(
        (item) =>
          item.rank < card.rank ||
          (item.rank === card.rank && item.id < card.id),
      ).length;

  async function move(
    card: KanbanCard,
    stage: { id: string; name: string },
    position: number | null,
    /** `quiet`: the card's sheet says where it went, so no toast shows. */
    options: { undo?: boolean; quiet?: boolean } = {},
  ): Promise<KanbanCard | null> {
    if (pendingRef.current.has(card.id)) return null;
    const before = client.getQueryData<KanbanCard[]>(cardsKey) ?? [];
    const origin = before.find((item) => item.id === card.id) ?? card;
    const back = { stageId: origin.stageId, position: placeOf(before, origin) };
    lock(card.id, true);
    setCards((cards) => applyMove(cards, card.id, stage.id, position));
    try {
      const saved = await moveKanbanCard(boardId, {
        cardId: card.id,
        revision: origin.revision,
        stageId: stage.id,
        position,
      });
      replaceCard(saved);
      void client.invalidateQueries({ queryKey: kanbanKeys.stages(boardId) });
      if (!options.undo && !options.quiet) {
        const from = client
          .getQueryData<KanbanStage[]>(kanbanKeys.stages(boardId))
          ?.find((item) => item.id === back.stageId);
        toast.add({
          title: `Moved to ${stage.name}`,
          type: "success",
          action: from
            ? {
                label: "Undo",
                onClick: () =>
                  void move(
                    saved,
                    { id: from.id, name: from.name },
                    back.position,
                    {
                      undo: true,
                    },
                  ),
              }
            : undefined,
        });
      }
      return saved;
    } catch (error) {
      client.setQueryData(cardsKey, before);
      if (isStaleKanbanWrite(error)) {
        toast.add({ title: kanbanErrorMessage(error), type: "error" });
        void refresh();
      } else fail(error);
      return null;
    } finally {
      lock(card.id, false);
    }
  }

  async function addObjective(stageId: string, title: string) {
    const card = await createObjectiveCard(boardId, { stageId, title });
    replaceCard(card);
    void client.invalidateQueries({ queryKey: kanbanKeys.stages(boardId) });
    return card;
  }

  async function addRecordCard(input: {
    stageId: string;
    recordId: string;
    startOn: string | null;
    dueOn: string | null;
  }) {
    const card = await createRecordCard(boardId, input);
    replaceCard(card);
    void client.invalidateQueries({ queryKey: kanbanKeys.stages(boardId) });
    return card;
  }

  async function setLabels(card: KanbanCard, labelIds: string[]) {
    if (pendingRef.current.has(card.id)) return;
    lock(card.id, true);
    try {
      replaceCard(await setKanbanCardLabels(boardId, card, labelIds));
    } catch (error) {
      fail(error);
    } finally {
      lock(card.id, false);
    }
  }

  async function archive(card: KanbanCard, name: string) {
    if (pendingRef.current.has(card.id)) return;
    lock(card.id, true);
    try {
      const saved = await archiveKanbanCard(boardId, card);
      replaceCard(saved);
      void client.invalidateQueries({ queryKey: kanbanKeys.stages(boardId) });
      toast.add({
        title: `${name} archived`,
        type: "success",
        action: {
          label: "Undo",
          onClick: () =>
            void restoreKanbanCard(boardId, saved).then(replaceCard, fail),
        },
      });
    } catch (error) {
      fail(error);
    } finally {
      lock(card.id, false);
    }
  }

  // ---- Stages and labels (managers) ----
  const setStages = (stages: KanbanStage[]) =>
    client.setQueryData(kanbanKeys.stages(boardId), stages);
  const upsertStage = (saved: KanbanStage) =>
    client.setQueryData<KanbanStage[]>(kanbanKeys.stages(boardId), (stages) =>
      stages
        ? [...stages.filter((stage) => stage.id !== saved.id), saved].sort(
            (left, right) => left.position - right.position,
          )
        : [saved],
    );

  async function addStage(name: string, color: ChartColor | null = null) {
    upsertStage(await createKanbanStage(boardId, { name, color }));
  }

  /** Three stages in order; a refusal keeps the ones already added. */
  async function addStarterStages() {
    for (const stage of STARTER_STAGES) await addStage(stage.name, stage.color);
  }

  async function changeStage(stage: KanbanStage, changes: StageChanges) {
    try {
      upsertStage(await updateKanbanStage(boardId, stage, changes));
    } catch (error) {
      void refresh();
      throw error;
    }
  }

  async function orderStages(stageIds: string[]) {
    const before = client.getQueryData<KanbanStage[]>(
      kanbanKeys.stages(boardId),
    );
    if (before)
      setStages(
        stageIds.flatMap((id, position) => {
          const stage = before.find((item) => item.id === id);
          return stage ? [{ ...stage, position }] : [];
        }),
      );
    try {
      setStages(await orderKanbanStages(boardId, stageIds));
    } catch (error) {
      if (before) setStages(before);
      fail(error);
    }
  }

  async function archiveStage(
    stage: KanbanStage,
    cards: "move" | "archive",
    targetStageId: string | null,
  ) {
    await archiveKanbanStage(boardId, {
      stageId: stage.id,
      revision: stage.revision,
      cards,
      targetStageId,
    });
    void refresh();
  }

  const upsertLabel = (saved: KanbanLabel) =>
    client.setQueryData<KanbanLabel[]>(kanbanKeys.labels(boardId), (labels) =>
      [...(labels ?? []).filter((label) => label.id !== saved.id), saved].sort(
        (left, right) => left.position - right.position,
      ),
    );

  async function addLabel(name: string, color: ChartColor) {
    upsertLabel(await createKanbanLabel(boardId, { name, color }));
  }
  async function changeLabel(
    label: KanbanLabel,
    changes: Partial<{ name: string; color: ChartColor }>,
  ) {
    upsertLabel(await updateKanbanLabel(boardId, label, changes));
  }
  async function removeLabel(label: KanbanLabel) {
    await deleteKanbanLabel(boardId, label);
    client.setQueryData<KanbanLabel[]>(kanbanKeys.labels(boardId), (labels) =>
      labels?.filter((item) => item.id !== label.id),
    );
    setCards((cards) =>
      cards.map((card) => ({
        ...card,
        labelIds: card.labelIds.filter((id) => id !== label.id),
      })),
    );
  }

  return {
    pending,
    refresh,
    move,
    addObjective,
    addRecordCard,
    setLabels,
    archive,
    addStage,
    addStarterStages,
    changeStage,
    orderStages,
    archiveStage,
    addLabel,
    changeLabel,
    removeLabel,
  };
}

export type KanbanCommands = ReturnType<typeof useKanbanCommands>;
