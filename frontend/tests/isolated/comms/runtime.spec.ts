import { expect, test } from "@playwright/test";
import { SampleOperationError } from "../../../src/components/systems/shared/runtime/sample-runtime";
import { messageFromCommsError } from "../../../src/components/systems/comms/state/runtime";

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
