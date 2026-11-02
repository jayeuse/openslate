import { expect, test } from "@playwright/test";

import { ApiError } from "../../../src/lib/api";
import {
  editorFailure,
  emptyState,
} from "../../../src/components/systems/boards/hooks/post-editor-state";
import { transitionAccessPreview } from "../../../src/components/systems/boards/hooks/use-board-check-person";
import { transitionBoardActivity } from "../../../src/components/systems/boards/hooks/use-server-board-activity";
import { transitionCalendarState } from "../../../src/components/systems/boards/hooks/use-server-board-events";
import {
  initialPostAuthorsState,
  postAuthorChoiceFailure,
  postFeedFailure,
  transitionPostAuthors,
  transitionPostFeed,
} from "../../../src/components/systems/boards/hooks/use-server-board-posts";
import { transitionResource } from "../../../src/components/systems/boards/hooks/use-server-boards";

// S1-C4 and D1.6 (docs/specs/system-health.md): a Boards read keeps the failed
// request's reference with its message until the next answer replaces both.

const requestId = "019a4c2e-7b1d-7c3e-9f00-4f9c2e1a0b2c";
const failed = new ApiError(
  500,
  "Private",
  undefined,
  undefined,
  undefined,
  requestId,
);

type Read = { error: string | null; reference?: string };

// Each Boards read state: begin, reject with the failure's reference, then
// answer again. `answer` is the state after the next successful read.
const reads: {
  name: string;
  reject: (reference: string | undefined) => Read;
  answer: (rejected: Read) => Read;
}[] = [
  {
    name: "calendar events",
    reject: (reference) =>
      transitionCalendarState(
        transitionCalendarState(
          { key: null, sequence: 0, data: null, status: "idle", error: null },
          { type: "begin", key: "k", sequence: 1 },
        ),
        {
          type: "reject",
          key: "k",
          sequence: 1,
          error: "Could not refresh this calendar. Try again.",
          reference,
          retain: false,
        },
      ),
    answer: (rejected) =>
      transitionCalendarState(
        { ...(rejected as ReturnType<typeof transitionCalendarState>) },
        { type: "invalidate", key: "k", sequence: 2 },
      ),
  },
  {
    name: "posts",
    reject: (reference) =>
      transitionPostFeed(
        transitionPostFeed(
          { key: null, sequence: 0, data: null, status: "idle", error: null },
          { type: "begin", key: "k", sequence: 1 },
        ),
        {
          type: "reject",
          key: "k",
          sequence: 1,
          ...postFeedFailure(failed),
          reference,
        },
      ),
    answer: (rejected) =>
      transitionPostFeed(rejected as ReturnType<typeof transitionPostFeed>, {
        type: "begin",
        key: "k",
        sequence: 2,
      }),
  },
  {
    name: "post authors",
    reject: (reference) =>
      transitionPostAuthors(
        transitionPostAuthors(initialPostAuthorsState, {
          type: "begin",
          key: "k",
          sequence: 1,
        }),
        {
          type: "reject",
          key: "k",
          sequence: 1,
          ...postAuthorChoiceFailure(failed),
          reference,
        },
      ),
    answer: (rejected) =>
      transitionPostAuthors(
        rejected as ReturnType<typeof transitionPostAuthors>,
        { type: "resolve", key: "k", sequence: 1, data: [] },
      ),
  },
  {
    name: "board list and board",
    reject: (reference) =>
      transitionResource<string[]>(
        transitionResource<string[]>(
          { key: null, sequence: 0, data: null, status: "idle", error: null },
          { type: "begin", key: "k", sequence: 1 },
        ),
        {
          type: "reject",
          key: "k",
          sequence: 1,
          error: "Could not refresh boards. Try again.",
          reference,
          denied: false,
        },
      ),
    answer: (rejected) =>
      transitionResource<string[]>(
        rejected as ReturnType<typeof transitionResource<string[]>>,
        { type: "resolve", key: "k", sequence: 1, data: [] },
      ),
  },
  {
    name: "board activity",
    reject: (reference) =>
      transitionBoardActivity(
        transitionBoardActivity(
          { key: null, sequence: 0, data: null, status: "idle", error: null },
          { type: "begin", key: "k", sequence: 1 },
        ),
        {
          type: "reject",
          key: "k",
          sequence: 1,
          error: "Could not refresh activity. Try again.",
          reference,
          retain: false,
        },
      ),
    answer: (rejected) =>
      transitionBoardActivity(
        rejected as ReturnType<typeof transitionBoardActivity>,
        { type: "begin", key: "k", sequence: 2 },
      ),
  },
  {
    name: "a person's access preview",
    reject: (reference) =>
      transitionAccessPreview(
        transitionAccessPreview(
          { key: null, sequence: 0, data: null, status: "idle", error: null },
          { type: "begin", key: "k", sequence: 1 },
        ),
        {
          type: "reject",
          key: "k",
          sequence: 1,
          error: "This person's access could not be checked.",
          reference,
        },
      ),
    answer: (rejected) =>
      transitionAccessPreview(
        rejected as ReturnType<typeof transitionAccessPreview>,
        { type: "begin", key: "k", sequence: 2 },
      ),
  },
];

for (const read of reads)
  test(`a failed ${read.name} read keeps its reference until the next answer`, () => {
    const rejected = read.reject(requestId);
    expect(rejected.error).not.toBeNull();
    expect(rejected.reference).toBe(requestId);
    const answered = read.answer(rejected);
    expect(answered.error).toBeNull();
    expect(answered.reference).toBeUndefined();
  });

test("the failure helpers keep the request's reference", () => {
  expect(postFeedFailure(failed).reference).toBe(requestId);
  expect(postAuthorChoiceFailure(failed).reference).toBe(requestId);
  expect(postFeedFailure(new TypeError("Failed to fetch")).reference).toBe(
    undefined,
  );
});

test("a failed post request keeps its reference with the words it set", () => {
  const state = emptyState("k", 4);
  const conflict = editorFailure(
    state,
    new ApiError(
      409,
      "Unable to save post",
      undefined,
      undefined,
      undefined,
      requestId,
    ),
  );
  expect(conflict.errorText).toEqual({
    message: conflict.error,
    reference: requestId,
  });
  expect(editorFailure(state, failed).errorText).toEqual({
    message: "Post request failed. Try again.",
    reference: requestId,
  });
});
