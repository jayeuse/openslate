import { expect, test } from "@playwright/test";

import { classifySessionResponse } from "../../../src/components/app-page";

test("session gate only treats an exact authenticated 200 as valid", () => {
  expect(
    classifySessionResponse({ ok: true, status: 200 }, { authenticated: true }),
  ).toBe("valid");
  expect(
    classifySessionResponse(
      { ok: true, status: 200 },
      { authenticated: false },
    ),
  ).toBe("invalid");
});

test("session gate treats non-contract responses as unavailable", () => {
  for (const response of [
    { ok: false, status: 503 },
    { ok: false, status: 504 },
    { ok: false, status: 401 },
    { ok: true, status: 204 },
  ])
    expect(classifySessionResponse(response, { authenticated: false })).toBe(
      "unavailable",
    );
  expect(classifySessionResponse({ ok: true, status: 200 }, null)).toBe(
    "unavailable",
  );
});
