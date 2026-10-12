import { expect, test } from "@playwright/test";

import {
  sandboxWorkInProgress,
  type SandboxWork,
} from "../../../src/components/systems/sandbox/helpers/work-in-progress";

// Any one of seven Sandbox states holds section navigation, the workspace
// navigation guard and browser exits; with none of them, leaving is free. The
// http journeys keep the browser-exit guard of each state source: a pending
// lifecycle preview, a dirty trigger draft, a running or clearing test, a
// pending publication review and a composite discard.

const idle: SandboxWork = {
  commandBusy: false,
  publicationPending: false,
  testPending: false,
  conflict: false,
  triggerDraftDirty: false,
  triggerDraftPending: false,
  designerDraftDirty: false,
};

test("an idle Sandbox has no work in progress", () => {
  expect(sandboxWorkInProgress(idle)).toBe(false);
});

for (const state of [
  "commandBusy",
  "publicationPending",
  "testPending",
  "conflict",
  "triggerDraftDirty",
  "triggerDraftPending",
  "designerDraftDirty",
] as const)
  test(`${state} alone is work in progress`, () => {
    expect(sandboxWorkInProgress({ ...idle, [state]: true })).toBe(true);
  });
