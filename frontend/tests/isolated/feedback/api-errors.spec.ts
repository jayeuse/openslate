import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import { apiErrorMessage } from "../../../src/lib/api-errors";
const fallback = "This action could not finish. Try again.";
for (const [status, code, text] of [
  [401, undefined, "Your session expired. Sign in again."],
  [403, undefined, "You do not have permission to perform this action."],
  [404, undefined, "This item is no longer available. Refresh and try again."],
  [409, "stale_revision", "This item changed. Refresh it and try again."],
  [422, undefined, "Check the entered values and try again."],
  [429, undefined, "Too many requests. Wait a moment and try again."],
  [
    503,
    "relationship_busy",
    "Relationships are temporarily unavailable. Refresh and try again.",
  ],
  [
    503,
    "unknown_private_code",
    "This service is temporarily unavailable. Try again.",
  ],
] as const) {
  test(`safe request message for ${status} ${code ?? "status"}`, () => {
    expect(
      apiErrorMessage(
        new ApiError(
          status,
          "Private server detail",
          { internal: "private detail" },
          code,
        ),
        fallback,
      ),
    ).toBe(text);
  });
}
test("network, contract and unknown errors never expose raw details", () => {
  expect(
    apiErrorMessage(new TypeError("Private network endpoint"), fallback),
  ).toBe("Could not connect. Check your connection and try again.");
  expect(apiErrorMessage(new ApiContractError(), fallback)).toBe(
    "The server returned an unexpected response. Refresh and try again.",
  );
  for (const error of [
    new Error("Private implementation detail"),
    new ApiError(500, "Private server detail"),
    { message: "Private detail" },
    null,
  ])
    expect(apiErrorMessage(error, fallback)).toBe(fallback);
});
