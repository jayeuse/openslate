"use client";

import { useEffect, useMemo, useRef } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { authMeOptions } from "@/components/systems/openview/adapters/openview-queries";
import { personCardOptions } from "@/components/profile/adapters/profile-queries";
import { subscribeWorkspaceInvalidations } from "../../shared/adapters/invalidation-events";
import {
  kanbanCardsOptions,
  kanbanKeys,
  kanbanLabelsOptions,
  kanbanStagesOptions,
} from "../adapters/board-kanban-queries";
import type { WeekStart } from "../domain/calendar-dates";
import {
  cardsByStage,
  filterCards,
  sortStageCards,
  swimlanes,
  type KanbanFilters,
} from "../domain/kanban";
import {
  UNGROUPED,
  type KanbanCell,
  type KanbanLane,
} from "../components/board-kanban-board";
import type { KanbanPerson } from "../components/board-kanban-card";

export const kanbanCellKey = (stageId: string, laneId: string) =>
  `${stageId}:${laneId}`;

/**
 * The Kanban's board data: its three cached reads, the live refresh that
 * waits while a card is held, the assignees' names, and the cells the board
 * draws (each stage's cards, filtered and sorted, in each lane).
 */
export function useKanbanBoardData({
  boardId,
  filters,
  today,
  weekStart,
  phone,
}: {
  boardId: string;
  filters: KanbanFilters;
  today: string;
  weekStart: WeekStart;
  phone: boolean;
}) {
  const client = useQueryClient();
  const stagesRead = useQuery(kanbanStagesOptions(boardId));
  const labelsRead = useQuery(kanbanLabelsOptions(boardId));
  const cardsRead = useQuery(kanbanCardsOptions(boardId));
  const identity = useQuery(authMeOptions());

  // ---- Live: another viewer's change reads the board again, after a drag ----
  const holdRef = useRef(false);
  const deferredRef = useRef(false);
  useEffect(
    () =>
      subscribeWorkspaceInvalidations((event) => {
        const ours =
          event.type === "resync" ||
          ((event.entity === "board_stages" ||
            event.entity === "board_cards" ||
            event.entity === "board_labels" ||
            event.entity === "boards") &&
            event.boardId === boardId);
        if (!ours) return;
        if (holdRef.current) deferredRef.current = true;
        else
          void client.invalidateQueries({
            queryKey: kanbanKeys.board(boardId),
          });
      }),
    [boardId, client],
  );
  const hold = (held: boolean) => {
    holdRef.current = held;
    if (!held && deferredRef.current) {
      deferredRef.current = false;
      void client.invalidateQueries({ queryKey: kanbanKeys.board(boardId) });
    }
  };

  // ---- Derived board ----
  const stages = useMemo(() => stagesRead.data ?? [], [stagesRead.data]);
  const labels = useMemo(() => labelsRead.data ?? [], [labelsRead.data]);
  const allCards = useMemo(() => cardsRead.data ?? [], [cardsRead.data]);
  const labelMap = useMemo(
    () => new Map(labels.map((label) => [label.id, label])),
    [labels],
  );
  const byStage = useMemo(() => cardsByStage(allCards), [allCards]);
  const counts = new Map(
    stages.map((stage) => [stage.id, byStage.get(stage.id)?.length ?? 0]),
  );
  const assigneeIds = [
    ...new Set(
      allCards.flatMap((card) => (card.assigneeId ? [card.assigneeId] : [])),
    ),
  ].sort();
  const viewer =
    identity.data && identity.data.role
      ? { id: identity.data.id, role: identity.data.role }
      : null;
  const personReads = useQueries({
    queries: assigneeIds.map((id) => ({
      ...personCardOptions(viewer ?? { id: "", role: "member" }, id),
      enabled: viewer !== null,
    })),
  });
  const people = new Map<string, KanbanPerson>();
  assigneeIds.forEach((id, index) => {
    const data = personReads[index]?.data;
    if (data && data.targetId === id)
      people.set(id, {
        name: data.data.display_name,
        avatarUrl: data.data.avatar_url,
      });
  });
  const peopleList = assigneeIds
    .flatMap((id) => {
      const person = people.get(id);
      return person ? [{ id, ...person }] : [];
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const group = phone ? null : filters.group;
  const filtered = filterCards(allCards, filters, { today, weekStart });
  const lanes: KanbanLane[] | null = group
    ? swimlanes(
        filtered,
        group,
        labels,
        (id) => people.get(id)?.name ?? null,
      ).map(({ id, name }) => ({ id, name }))
    : null;
  const laneOf = new Map<string, string>();
  if (group)
    for (const lane of swimlanes(
      filtered,
      group,
      labels,
      (id) => people.get(id)?.name ?? null,
    ))
      for (const card of lane.cards) laneOf.set(card.id, lane.id);
  const cells = new Map<string, KanbanCell>();
  for (const stage of stages) {
    const visible = sortStageCards(
      filtered.filter((card) => card.stageId === stage.id),
      stage.cardSort,
    );
    for (const laneId of lanes ? lanes.map((lane) => lane.id) : [UNGROUPED])
      cells.set(kanbanCellKey(stage.id, laneId), {
        stageId: stage.id,
        laneId,
        cards: lanes
          ? visible.filter((card) => laneOf.get(card.id) === laneId)
          : visible,
      });
  }

  return {
    stagesRead,
    labelsRead,
    cardsRead,
    stages,
    labels,
    allCards,
    labelMap,
    byStage,
    counts,
    people,
    peopleList,
    lanes,
    laneOf,
    cells,
    hold,
    holdRef,
  };
}
