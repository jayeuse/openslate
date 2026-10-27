/**
 * The Kanban's keyboard move (BR67, WCAG 2.1.1): Space lifts the focused
 * card, the arrows move its place (Up and Down in a stage, Left and Right
 * between stages), Space drops it, and Escape puts it back. Each step
 * returns the sentence the live region speaks. Places count without the
 * lifted card, as the server's `position` does.
 */

/** The stages as the viewer sees them, each with its visible cards in order. */
export type KeyboardLayout = {
  id: string;
  name: string;
  cards: { id: string; name: string }[];
}[];

type Place = { stage: number; slot: number };
export type KeyboardMove =
  | { kind: "idle" }
  | { kind: "lifted"; cardId: string; name: string; from: Place; at: Place };
export const IDLE_MOVE: KeyboardMove = { kind: "idle" };

export type KeyboardAction =
  | { type: "lift"; cardId: string }
  | { type: "up" | "down" | "left" | "right" | "drop" | "cancel" };

export type KeyboardStep = {
  state: KeyboardMove;
  announcement: string | null;
  drop: { cardId: string; stageId: string; slot: number } | null;
};

function places(layout: KeyboardLayout, stage: number, cardId: string) {
  return layout[stage].cards.filter((card) => card.id !== cardId).length;
}

function where(layout: KeyboardLayout, cardId: string, at: Place): string {
  const total = places(layout, at.stage, cardId) + 1;
  return `${layout[at.stage].name}, position ${at.slot + 1} of ${total}.`;
}

export function keyboardStep(
  state: KeyboardMove,
  action: KeyboardAction,
  layout: KeyboardLayout,
): KeyboardStep {
  const still: KeyboardStep = { state, announcement: null, drop: null };
  if (action.type === "lift") {
    if (state.kind !== "idle") return still;
    for (const [stage, column] of layout.entries()) {
      const slot = column.cards.findIndex((card) => card.id === action.cardId);
      if (slot < 0) continue;
      const name = column.cards[slot].name;
      const from = { stage, slot };
      return {
        state: { kind: "lifted", cardId: action.cardId, name, from, at: from },
        announcement: `Lifted ${name}. ${where(layout, action.cardId, from)} Arrow keys move it, Space drops it, Escape cancels.`,
        drop: null,
      };
    }
    return still;
  }
  if (state.kind !== "lifted") return still;
  const { cardId, name, from, at } = state;
  if (action.type === "cancel")
    return {
      state: IDLE_MOVE,
      announcement: `Move cancelled. ${name} stays in ${layout[from.stage].name}.`,
      drop: null,
    };
  if (action.type === "drop") {
    if (at.stage === from.stage && at.slot === from.slot)
      return {
        state: IDLE_MOVE,
        announcement: `Dropped ${name} in its place.`,
        drop: null,
      };
    const total = places(layout, at.stage, cardId) + 1;
    return {
      state: IDLE_MOVE,
      announcement: `Dropped ${name} in ${layout[at.stage].name}, position ${at.slot + 1} of ${total}.`,
      drop: { cardId, stageId: layout[at.stage].id, slot: at.slot },
    };
  }
  let next = at;
  if (action.type === "up") next = { ...at, slot: Math.max(0, at.slot - 1) };
  if (action.type === "down")
    next = {
      ...at,
      slot: Math.min(places(layout, at.stage, cardId), at.slot + 1),
    };
  if (action.type === "left" || action.type === "right") {
    const stage = at.stage + (action.type === "left" ? -1 : 1);
    if (stage >= 0 && stage < layout.length)
      next = {
        stage,
        slot: Math.min(at.slot, places(layout, stage, cardId)),
      };
  }
  return {
    state: { ...state, at: next },
    announcement: where(layout, cardId, next),
    drop: null,
  };
}
