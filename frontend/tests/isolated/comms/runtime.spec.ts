import { expect, test } from "@playwright/test";
import { messageFromCommsError } from "../../../src/components/systems/comms/state/runtime";

test("Comms keeps transport errors safe while preserving operation copy", () => {
  expect(
    messageFromCommsError(new Error("private transport detail"), "Try again."),
  ).toBe("Try again.");
  // The live API reports a conflict as a 412; the caller's conflict copy wins.
  expect(
    messageFromCommsError(
      {
        kind: "http",
        failure: {
          status: 412,
          body: {
            detail: {
              code: "comms_precondition_failed",
              message: "private server detail",
            },
          },
        },
      },
      "Try again.",
      "This change is already being saved.",
    ),
  ).toBe("This change is already being saved.");
});

test("Comms names the wait for a rate-limited send instead of generic copy", () => {
  const rateLimited = (retry_after_seconds: number) => ({
    kind: "http",
    failure: {
      status: 429,
      body: {
        detail: {
          code: "comms_rate_limited",
          message: "Wait before sending again",
        },
      },
      retry_after_seconds,
    },
  });
  expect(messageFromCommsError(rateLimited(8), "Try again.")).toBe(
    "Too many attempts. Try again in 8s.",
  );
  // A zero wait still asks for a moment rather than "0s".
  expect(messageFromCommsError(rateLimited(0), "Try again.")).toBe(
    "Too many attempts. Try again in 1s.",
  );
});
