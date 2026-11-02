import { expect, test } from "@playwright/test";
import { ApiError } from "../../../src/lib/api";
import {
  commsErrorText,
  messageFromCommsError,
} from "../../../src/components/systems/comms/state/runtime";

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

// S1-C4 and S1-C5 (docs/specs/system-health.md): a Comms failure keeps the
// failed request's reference beside its words; a failure that never reached
// the server has none.
test("a Comms failure keeps its request's reference with its words", () => {
  const id = "019a4c2e-7b1d-7c3e-9f00-4f9c2e1a0b2c";
  // The HTTP client keeps the ApiError instance and adds the typed failure.
  const conflict = Object.assign(
    new ApiError(
      412,
      "private server detail",
      undefined,
      undefined,
      undefined,
      id,
    ),
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
  );
  expect(
    commsErrorText(conflict, "Try again.", "Load the latest version."),
  ).toEqual({ message: "Load the latest version.", reference: id });
  expect(
    commsErrorText(
      Object.assign(new Error("private transport detail"), {
        kind: "network",
      }),
      "The message could not be sent.",
    ),
  ).toEqual({
    message: "The message could not be sent.",
    reference: undefined,
  });
});
