import { expect, test } from "@playwright/test";
import { ApiContractError } from "../../../src/lib/api";
import { listDirectCandidates } from "../../../src/components/systems/comms/adapters/direct-candidates-api";
import { installFetch } from "../helpers/fake-fetch";
import { context, other, user } from "./s18-fixtures";

const candidate = {
  user_id: other,
  display_name: "Noah Tan",
  avatar_url: null,
};

test("direct candidate discovery uses the bounded server search contract and explicit organization", async () => {
  const abort = new AbortController();
  const fetch = installFetch(() =>
    Response.json(
      { items: [candidate] },
      { headers: { "Cache-Control": "no-store" } },
    ),
  );
  try {
    await expect(
      listDirectCandidates(
        context,
        { q: "  Noah  " },
        { signal: abort.signal },
      ),
    ).resolves.toEqual({ items: [candidate] });
    expect(String(fetch.requests[0].input)).toBe(
      "/api/comms/direct-candidates?q=Noah&limit=20",
    );
    expect(new Headers(fetch.requests[0].init?.headers).get("X-Org")).toBe(
      context.org_id,
    );
    expect(fetch.requests[0].init?.signal).toBe(abort.signal);
    expect(fetch.requests[0].init?.body).toBeUndefined();
  } finally {
    fetch.restore();
  }
});

test("direct candidate discovery refuses unbounded or private response fields rather than fabricating pagination", async () => {
  for (const body of [
    {
      items: [
        candidate,
        { ...candidate, user_id: "00000000-0000-4000-8000-000000000011" },
      ],
    },
    { items: [{ ...candidate, user_id: user }] },
    { items: [{ ...candidate, email: "private@example.test" }] },
    { items: [candidate], pagination: { total: 999 } },
  ]) {
    const fetch = installFetch(() =>
      Response.json(body, { headers: { "Cache-Control": "no-store" } }),
    );
    try {
      await expect(
        listDirectCandidates(context, { q: "Noah", limit: 1 }),
      ).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      fetch.restore();
    }
  }
});

test("direct candidate discovery rejects empty or oversized queries and unsupported paging before dispatch", async () => {
  const fetch = installFetch(() => {
    throw new Error("Invalid inputs must not dispatch");
  });
  try {
    for (const input of [
      { q: " " },
      { q: "x".repeat(101) },
      { q: "Noah", limit: 0 },
      { q: "Noah", limit: 21 },
      { q: "Noah", offset: 20 },
    ])
      await expect(listDirectCandidates(context, input)).rejects.toThrow();
    expect(fetch.requests).toHaveLength(0);
  } finally {
    fetch.restore();
  }
});
