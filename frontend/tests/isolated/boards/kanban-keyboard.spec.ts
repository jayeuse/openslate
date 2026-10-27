import { expect, test } from "@playwright/test";
import {
  IDLE_MOVE,
  keyboardStep,
  type KeyboardLayout,
} from "../../../src/components/systems/boards/domain/kanban-keyboard";

const layout: KeyboardLayout = [
  {
    id: "todo",
    name: "To do",
    cards: [
      { id: "crew", name: "Book the expo booth crew" },
      { id: "call", name: "Call back Pacific Rim" },
      { id: "gifts", name: "Order expo giveaways" },
    ],
  },
  {
    id: "doing",
    name: "In progress",
    cards: [{ id: "terms", name: "Renewal terms" }],
  },
  { id: "done", name: "Done", cards: [] },
];

test("Space lifts, arrows move, Space drops in another stage", () => {
  const lifted = keyboardStep(
    IDLE_MOVE,
    { type: "lift", cardId: "crew" },
    layout,
  );
  expect(lifted.announcement).toBe(
    "Lifted Book the expo booth crew. To do, position 1 of 3. Arrow keys move it, Space drops it, Escape cancels.",
  );
  expect(lifted.drop).toBeNull();
  const down = keyboardStep(lifted.state, { type: "down" }, layout);
  expect(down.announcement).toBe("To do, position 2 of 3.");
  const right = keyboardStep(down.state, { type: "right" }, layout);
  // Two places in In progress: above or below Renewal terms.
  expect(right.announcement).toBe("In progress, position 2 of 2.");
  const farther = keyboardStep(right.state, { type: "right" }, layout);
  expect(farther.announcement).toBe("Done, position 1 of 1.");
  const back = keyboardStep(farther.state, { type: "left" }, layout);
  const up = keyboardStep(back.state, { type: "up" }, layout);
  // Left kept the top place, so Up is at the stage's edge.
  expect(up.announcement).toBe("Top of In progress.");
  const dropped = keyboardStep(up.state, { type: "drop" }, layout);
  expect(dropped.announcement).toBe(
    "Dropped Book the expo booth crew in In progress, position 1 of 2.",
  );
  expect(dropped.drop).toEqual({ cardId: "crew", stageId: "doing", slot: 0 });
  expect(dropped.state).toEqual(IDLE_MOVE);
});

test("moves stop at the ends, and the first and last stages", () => {
  let step = keyboardStep(IDLE_MOVE, { type: "lift", cardId: "gifts" }, layout);
  step = keyboardStep(step.state, { type: "down" }, layout);
  expect(step.announcement).toBe("End of To do.");
  step = keyboardStep(step.state, { type: "left" }, layout);
  expect(step.announcement).toBe("To do, position 3 of 3.");
  // Into a shorter stage, the place is kept within its cards.
  step = keyboardStep(step.state, { type: "right" }, layout);
  expect(step.announcement).toBe("In progress, position 2 of 2.");
});

test("Escape cancels, and a drop at the start place moves nothing", () => {
  const lifted = keyboardStep(
    IDLE_MOVE,
    { type: "lift", cardId: "call" },
    layout,
  );
  const moved = keyboardStep(lifted.state, { type: "right" }, layout);
  const cancelled = keyboardStep(moved.state, { type: "cancel" }, layout);
  expect(cancelled.announcement).toBe(
    "Move cancelled. Call back Pacific Rim stays in To do.",
  );
  expect(cancelled.drop).toBeNull();
  expect(cancelled.state).toEqual(IDLE_MOVE);

  const again = keyboardStep(
    IDLE_MOVE,
    { type: "lift", cardId: "call" },
    layout,
  );
  const there = keyboardStep(again.state, { type: "down" }, layout);
  const home = keyboardStep(there.state, { type: "up" }, layout);
  const dropped = keyboardStep(home.state, { type: "drop" }, layout);
  expect(dropped.announcement).toBe(
    "Dropped Call back Pacific Rim in its place.",
  );
  expect(dropped.drop).toBeNull();
});

test("arrows do nothing until a card is lifted, and an unknown card does not lift", () => {
  expect(keyboardStep(IDLE_MOVE, { type: "down" }, layout)).toEqual({
    state: IDLE_MOVE,
    announcement: null,
    drop: null,
  });
  expect(
    keyboardStep(IDLE_MOVE, { type: "lift", cardId: "gone" }, layout),
  ).toEqual({ state: IDLE_MOVE, announcement: null, drop: null });
});

test("at the edge of a stage a move says so and stays put", () => {
  const lifted = keyboardStep(
    IDLE_MOVE,
    { type: "lift", cardId: "crew" },
    layout,
  );
  const top = keyboardStep(lifted.state, { type: "up" }, layout);
  expect(top.announcement).toBe("Top of To do.");
  expect(top.state).toEqual(lifted.state);
  const bottom = keyboardStep(
    keyboardStep(
      keyboardStep(lifted.state, { type: "down" }, layout).state,
      { type: "down" },
      layout,
    ).state,
    { type: "down" },
    layout,
  );
  expect(bottom.announcement).toBe("End of To do.");
  // An empty stage has one place, which is both its top and its end.
  const done = keyboardStep(
    keyboardStep(
      keyboardStep(lifted.state, { type: "right" }, layout).state,
      { type: "right" },
      layout,
    ).state,
    { type: "down" },
    layout,
  );
  expect(done.announcement).toBe("End of Done.");
});
