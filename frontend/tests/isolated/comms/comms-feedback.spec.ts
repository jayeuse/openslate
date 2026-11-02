import { expect, test } from "@playwright/test";

import { toast } from "../../../src/components/ui/toast";
import { reportCommsError } from "../../../src/components/systems/comms/state/comms-feedback";
import { DepartmentsLoadError } from "../../../src/components/systems/comms/components/channel-scope";
import { staticMarkup } from "../sandbox/static-markup";

// S1-C4 (docs/specs/system-health.md): a Comms error toast that shows an API
// error carries that request's reference; a local failure carries none.
test("a Comms error toast carries its request's reference", () => {
  toast.resumeWorkspace();
  const calls: Parameters<typeof toast.add>[0][] = [];
  const original = toast.add;
  toast.add = (options) => {
    calls.push(options);
    return original(options);
  };
  try {
    reportCommsError(
      "The channel could not be archived. Try again.",
      "019a4c2e-7b1d-7c3e-9f00-4f9c2e1a0b2c",
    );
    reportCommsError("The browser could not copy the link.");
    expect(
      calls.map((call) => [call.title, call.type, call.reference]),
    ).toEqual([
      [
        "The channel could not be archived. Try again.",
        "error",
        "019a4c2e-7b1d-7c3e-9f00-4f9c2e1a0b2c",
      ],
      ["The browser could not copy the link.", "error", undefined],
    ]);
  } finally {
    toast.add = original;
    toast.clearWorkspace();
  }
});

// S1-C4, D1.4: the department list that failed to load says so on an error
// line, then "Try again", then its reference as the last part; S1-C5: a
// failure with no request ID shows no reference.
test("a department list that could not load shows an error line with its reference", () => {
  const markup = staticMarkup(DepartmentsLoadError, {
    retry: () => {},
    reference: "019a4c2e-7b1d-7c3e-9f00-4f9c2e1a0b2c",
  }).replace(/ class="[^"]*"/g, "");
  expect(markup).toMatch(
    /<p role="alert">Departments could not be loaded\.<\/p><button[^>]*>Try again<\/button><span data-slot="error-reference">.*1a0b2c/,
  );
  const plain = staticMarkup(DepartmentsLoadError, {
    retry: () => {},
    reference: undefined,
  });
  expect(plain).not.toContain("error-reference");
  expect(plain).toContain("Try again");
});
