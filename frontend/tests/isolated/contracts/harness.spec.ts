import { expect, test } from "@playwright/test";

import { checkContract } from "./openapi-contract";

// The harness itself: each check must fail on the drift it exists to catch.

const GROUP = "/api/access/groups/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const GROUP_KEY = "GET /api/access/groups/{group_id}";

test("a response fixture cannot restore a property the backend no longer declares", async () => {
  const problems = await checkContract(
    {
      name: "fixture with a removed property",
      run: () => fetch(GROUP).then((response) => response.json()),
      responses: { [GROUP_KEY]: { legacy_owner: "removed" } },
    },
    "values",
  );

  expect(problems).toContain(
    `${GROUP_KEY} response fixture response.legacy_owner: not declared by the backend`,
  );
});

test("a response fixture must keep the backend's value types", async () => {
  const problems = await checkContract(
    {
      name: "fixture with a wrong type",
      run: () => fetch(GROUP).then((response) => response.json()),
      responses: { [GROUP_KEY]: { revision: "seven" } },
    },
    "values",
  );

  expect(problems).toContain(
    `${GROUP_KEY} response fixture response.revision: expected integer, got string`,
  );
});

test("a conditional write without If-Match fails where the backend answers 428", async () => {
  const problems = await checkContract(
    {
      name: "group rename without If-Match",
      run: () =>
        fetch(GROUP, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Renamed" }),
        }),
    },
    "values",
  );

  expect(problems).toContain(
    "PATCH /api/access/groups/{group_id} request header if-match: the backend answers 428 without it",
  );
});

test("only the response headers an operation declares are sent", async () => {
  const seen: Record<string, string | null> = {};
  await checkContract(
    {
      name: "declared headers",
      run: async () => {
        seen.group = (await fetch(GROUP)).headers.get("ETag");
        seen.groups = (await fetch("/api/access/groups")).headers.get("ETag");
      },
    },
    "values",
  );

  expect(seen).toEqual({ group: '"contract-1"', groups: null });
});
