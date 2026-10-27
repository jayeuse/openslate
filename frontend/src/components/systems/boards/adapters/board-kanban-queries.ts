import { queryOptions } from "@tanstack/react-query";
import {
  listBoardCards,
  listKanbanLabels,
  listKanbanStages,
} from "./board-kanban-api";

/**
 * The Kanban's three cached reads. Filters never enter a key: the Kanban
 * holds the board's complete card list and filters it in the browser, so a
 * drop always names a place in the stage's whole order.
 */
export const kanbanKeys = {
  board: (boardId: string) => ["boards", "kanban", boardId] as const,
  stages: (boardId: string) => ["boards", "kanban", boardId, "stages"] as const,
  labels: (boardId: string) => ["boards", "kanban", boardId, "labels"] as const,
  cards: (boardId: string) => ["boards", "kanban", boardId, "cards"] as const,
};

export const kanbanStagesOptions = (boardId: string) =>
  queryOptions({
    queryKey: kanbanKeys.stages(boardId),
    queryFn: () => listKanbanStages(boardId),
  });

export const kanbanLabelsOptions = (boardId: string) =>
  queryOptions({
    queryKey: kanbanKeys.labels(boardId),
    queryFn: () => listKanbanLabels(boardId),
  });

export const kanbanCardsOptions = (boardId: string) =>
  queryOptions({
    queryKey: kanbanKeys.cards(boardId),
    queryFn: () => listBoardCards(boardId),
  });
