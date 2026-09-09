import { testSecret } from "../../helpers/test-secret";
import { expect, test } from "@playwright/test";

import { createBffHarness } from "../../helpers/bff-route-harness";

const rotatedAccess = testSecret();
const rotatedRefresh = testSecret();

const session = {
  access_token: rotatedAccess,
  refresh_token: rotatedRefresh,
  expires_in: 3600,
};
const backendId = "019c0000-0000-7000-8000-000000000001";

for (const failure of ["oversize", "deadline", "transport"] as const) {
  test(`preserves rotated cookies after ${failure} without replaying the mutation`, async () => {
    let attempts = 0;
    let refreshes = 0;
    let providerAvailable = true;
    const harness = createBffHarness({
      refresh: async () => {
        refreshes++;
        if (!providerAvailable) throw new Error("Provider unavailable");
        return { data: { session }, error: null };
      },
      transport: async (_input, init) => {
        attempts++;
        if (
          new Headers(init?.headers).get("authorization") !==
          `Bearer ${session.access_token}`
        )
          return new Response(null, { status: 401 });
        if (attempts > 2) return Response.json({ id: "existing-record" });
        if (failure === "oversize")
          return new Response("large", {
            headers: {
              "content-length": String(8 * 1024 * 1024 + 1),
              "x-request-id": backendId,
            },
          });
        if (failure === "deadline") harness.expire();
        throw new Error("Transport interrupted");
      },
    });

    const response = await harness.request();
    expect(response.status).toBe(failure === "deadline" ? 504 : 502);
    expect(attempts).toBe(2);
    expect(refreshes).toBe(1);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    if (failure === "oversize")
      expect(response.headers.get("x-request-id")).toBe(backendId);
    expect(response.cookies.get("openslate_access")).toMatchObject({
      value: session.access_token,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    expect(response.cookies.get("openslate_refresh")?.value).toBe(
      session.refresh_token,
    );
    expect(harness.logs.join("\n")).not.toContain(session.access_token);
    expect(harness.logs.join("\n")).not.toContain(session.refresh_token);

    harness.applyCookies(response);
    providerAvailable = false;
    const inspection = await harness.request("GET");
    expect(inspection.status).toBe(200);
    expect(await inspection.json()).toEqual({ id: "existing-record" });
    expect(refreshes).toBe(1);
    expect(attempts).toBe(3);
  });
}

test("a final backend authentication rejection clears refreshed cookies", async () => {
  let attempts = 0;
  let refreshes = 0;
  const harness = createBffHarness({
    refresh: async () => {
      refreshes++;
      return { data: { session }, error: null };
    },
    transport: async () => {
      attempts++;
      return Response.json({ detail: "Rejected" }, { status: 401 });
    },
  });
  const response = await harness.request();
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ detail: "Rejected" });
  for (const name of ["openslate_access", "openslate_refresh"])
    expect(response.cookies.get(name)).toMatchObject({ value: "", maxAge: 0 });
  expect(attempts).toBe(2);
  expect(refreshes).toBe(1);
});

test("failed refresh clears credentials and never replays the mutation", async () => {
  let attempts = 0;
  const harness = createBffHarness({
    refresh: async () => ({
      data: { session: null },
      error: new Error("Rejected"),
    }),
    transport: async () => {
      attempts++;
      return new Response(null, { status: 401 });
    },
  });
  const response = await harness.request();
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ detail: "Session expired" });
  expect(response.cookies.get("openslate_access")).toMatchObject({
    value: "",
    maxAge: 0,
  });
  expect(attempts).toBe(1);
});

for (const failure of ["oversize", "deadline"] as const) {
  test(`clears rejected refreshed credentials even when the final 401 body hits ${failure}`, async () => {
    let attempts = 0;
    const harness = createBffHarness({
      refresh: async () => ({ data: { session }, error: null }),
      transport: async () => {
        attempts++;
        if (attempts === 1) return new Response(null, { status: 401 });
        if (failure === "oversize")
          return new Response("large", {
            status: 401,
            headers: { "content-length": String(8 * 1024 * 1024 + 1) },
          });
        return new Response(
          new ReadableStream({
            pull() {
              harness.expire();
            },
          }),
          { status: 401 },
        );
      },
    });
    const response = await harness.request();
    expect(response.status).toBe(failure === "oversize" ? 502 : 504);
    for (const name of ["openslate_access", "openslate_refresh"])
      expect(response.cookies.get(name)).toMatchObject({
        value: "",
        maxAge: 0,
      });
    expect(attempts).toBe(2);
  });
}

test("never persists a session returned alongside a refresh error", async () => {
  let attempts = 0;
  const harness = createBffHarness({
    refresh: async () => ({ data: { session }, error: new Error("Rejected") }),
    transport: async () => {
      attempts++;
      return new Response(null, { status: 401 });
    },
  });
  const response = await harness.request();
  expect(response.status).toBe(401);
  for (const name of ["openslate_access", "openslate_refresh"])
    expect(response.cookies.get(name)).toMatchObject({ value: "", maxAge: 0 });
  expect(attempts).toBe(1);
});

test("log storage failure cannot turn a successful BFF response into an error", async () => {
  const harness = createBffHarness({
    failLogWrites: true,
    refresh: async () => ({ data: { session: null }, error: null }),
    transport: async () => Response.json({ result: "saved" }),
  });
  const response = await harness.request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ result: "saved" });
  expect(response.headers.get("x-request-id")).toBeTruthy();
});
