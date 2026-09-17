import { expect, test } from "@playwright/test";
import { INITIAL_RECORDS } from "../../../src/components/systems/shared/data/sample-data";
import {
  createSampleRuntime,
  type SampleDecoder,
} from "../../../src/components/systems/shared/runtime/sample-runtime";
import { SampleOperationError } from "../../../src/components/systems/shared/runtime/sample-runtime";
import {
  messageFromCommsError,
  stageRecordDiscussion,
} from "../../../src/components/systems/comms/state/runtime";

const decode: SampleDecoder = <T>(_key: string, value: unknown, initial: T) =>
  value === undefined ? initial : (value as T);

test("Comms owns idempotent record discussion staging", async () => {
  const sample = createSampleRuntime(decode, { commsRecordThreads: [] });
  const record = INITIAL_RECORDS[0];
  const first = await sample.execute(
    (draft) => stageRecordDiscussion(draft, record),
    { keys: ["commsRecordThreads"] },
  );
  const second = await sample.execute(
    (draft) => stageRecordDiscussion(draft, record),
    { keys: ["commsRecordThreads"] },
  );

  expect(second).toEqual(first);
  expect(sample.getSnapshot().commsRecordThreads).toEqual([first]);
});

test("Comms keeps transport errors safe while preserving operation copy", () => {
  expect(
    messageFromCommsError(new Error("private transport detail"), "Try again."),
  ).toBe("Try again.");
  expect(
    messageFromCommsError(
      new SampleOperationError(
        "conflict",
        "This change is already being saved.",
      ),
      "Try again.",
    ),
  ).toBe("This change is already being saved.");
});
