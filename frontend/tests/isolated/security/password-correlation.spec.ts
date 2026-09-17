import { expect, test } from "@playwright/test";
import {
  accessCanary,
  queryCanary,
  callerCanary,
  passwordCanary,
  passwordRouteHarness,
  refreshCanary,
} from "../../helpers/password-route-harness";
import { testSecret } from "../../helpers/test-secret";

const backendId = "01994d22-7871-7000-8000-000000000001";
for (const status of [204, 403]) {
  test(`password acceptance joins backend ID on ${status}`, async () => {
    let forwardedId: string | null = null;
    const harness = passwordRouteHarness(async (_url, init) => {
      forwardedId = new Headers(init?.headers).get("x-request-id");
      return new Response(null, {
        status,
        headers: { "x-request-id": backendId },
      });
    });
    const response = await harness.post();
    expect(response.status).toBe(status === 204 ? 200 : 400);
    expect(await response.json()).toEqual(
      status === 204
        ? { authenticated: true }
        : { detail: "Password set, but account setup could not be completed" },
    );
    expect(response.headers.get("x-request-id")).toBe(backendId);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const events = harness.logs.map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "backend_attempt_completed",
        request_id: forwardedId,
        backend_request_id: backendId,
        status,
      }),
    );
    expect(forwardedId).not.toBe(callerCanary);
    for (const secret of [
      accessCanary,
      refreshCanary,
      passwordCanary,
      queryCanary,
      callerCanary,
    ])
      expect(harness.logs.join("\n")).not.toContain(secret);
  });
}

test("password transport failure keeps a generated frontend ID and safe failure event", async () => {
  const harness = passwordRouteHarness(async () => {
    throw new Error(passwordCanary);
  });
  const response = await harness.post();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    detail:
      "Password setup outcome is uncertain; sign in to confirm before trying again.",
  });
  const id = response.headers.get("x-request-id");
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const events = harness.logs.map((line) => JSON.parse(line));
  expect(events).toContainEqual(
    expect.objectContaining({
      event: "backend_attempt_failed",
      request_id: id,
      reason: "backend_transport_failed",
    }),
  );
  expect(harness.logs.join("\n")).not.toContain(passwordCanary);
});

test("password early rejection uses frontend ID without making backend attempts", async () => {
  let attempts = 0;
  const harness = passwordRouteHarness(async () => {
    attempts++;
    return new Response(null, { status: 204 });
  });
  const response = await harness.post("https://untrusted.invalid");
  expect(response.status).toBe(403);
  expect(attempts).toBe(0);
  expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  expect(harness.logs).toHaveLength(1);
});

test("password backend response without an ID falls back to the frontend ID", async () => {
  const harness = passwordRouteHarness(
    async () => new Response(null, { status: 204 }),
  );
  const response = await harness.post();
  expect(response.status).toBe(200);
  const events = harness.logs.map((line) => JSON.parse(line));
  expect(events[0]).toMatchObject({
    event: "backend_attempt_completed",
    request_id: response.headers.get("x-request-id"),
  });
  expect(events[0]).not.toHaveProperty("backend_request_id");
});

test("password setup clears cookies only for confirmed invalid sessions", async () => {
  let attempts = 0;
  const harness = passwordRouteHarness(
    async () => {
      attempts++;
      return new Response(null, { status: 204 });
    },
    {
      setSession: async () => ({
        data: { session: null },
        error: {
          code: "refresh_token_not_found",
          message: "private provider detail",
        },
      }),
    },
  );
  const response = await harness.post();
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ detail: "Session expired" });
  expect(response.headers.get("set-cookie")).toContain("openslate_access=;");
  expect(response.headers.get("set-cookie")).toContain("openslate_refresh=;");
  expect(attempts).toBe(0);
});

test("password setup treats AuthSessionMissingError as confirmed invalidity", async () => {
  const harness = passwordRouteHarness(
    async () => new Response(null, { status: 204 }),
    {
      setSession: async () => {
        throw {
          name: "AuthSessionMissingError",
          message: "private provider detail",
        };
      },
    },
  );
  const response = await harness.post();
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ detail: "Session expired" });
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
});

test("password setup clears missing session credentials without mutating", async () => {
  let attempts = 0;
  const harness = passwordRouteHarness(
    async () => {
      attempts++;
      return new Response(null, { status: 204 });
    },
    { cookies: { openslate_refresh: null } },
  );
  const response = await harness.post();
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ detail: "Authentication required" });
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(attempts).toBe(0);
});

test("password setup preserves cookies and stops before mutation when auth is unavailable", async () => {
  let attempts = 0;
  const harness = passwordRouteHarness(
    async () => {
      attempts++;
      return new Response(null, { status: 204 });
    },
    {
      setSession: async () => {
        throw new Error("private provider failure");
      },
    },
  );
  const response = await harness.post();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    detail: "Authentication service unavailable",
  });
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(attempts).toBe(0);
});

test("password setup reports an auth timeout without clearing cookies or mutating", async () => {
  let attempts = 0;
  const deadline: { expire: () => void } = {
    expire: () => {
      throw new Error("deadline unavailable");
    },
  };
  const harness = passwordRouteHarness(
    async () => {
      attempts++;
      return new Response(null, { status: 204 });
    },
    {
      setSession: async () => {
        deadline.expire();
        return {
          data: {
            session: {
              access_token: accessCanary,
              refresh_token: refreshCanary,
              expires_in: 3600,
            },
          },
          error: null,
        };
      },
    },
  );
  deadline.expire = harness.expire;
  const response = await harness.post();
  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({
    detail: "Authentication service timed out",
  });
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(attempts).toBe(0);
});

test("password body-read timeout is a safe pre-mutation 504", async () => {
  let updates = 0;
  let attempts = 0;
  const harness = passwordRouteHarness(
    async () => {
      attempts++;
      return new Response(null, { status: 204 });
    },
    {
      expireDuringBodyRead: true,
      updateUser: async () => {
        updates++;
        return { error: null };
      },
    },
  );
  const response = await harness.post();
  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({
    detail: "Authentication service timed out",
  });
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(updates).toBe(0);
  expect(attempts).toBe(0);
});

test("password update transport failure is uncertain and retains the rotated session", async () => {
  let updates = 0;
  let attempts = 0;
  const rotatedAccess = testSecret();
  const rotatedRefresh = testSecret();
  const harness = passwordRouteHarness(
    async () => {
      attempts++;
      return new Response(null, { status: 204 });
    },
    {
      setSession: async () => ({
        data: {
          session: {
            access_token: rotatedAccess,
            refresh_token: rotatedRefresh,
            expires_in: 3600,
          },
        },
        error: null,
      }),
      updateUser: async () => {
        updates++;
        throw new Error("private update transport failure");
      },
    },
  );
  const response = await harness.post();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    detail:
      "Password update outcome is uncertain; sign in to confirm before trying again.",
  });
  expect(response.headers.get("set-cookie")).toContain(
    `openslate_access=${rotatedAccess}`,
  );
  expect(response.headers.get("set-cookie")).toContain(
    `openslate_refresh=${rotatedRefresh}`,
  );
  expect(updates).toBe(1);
  expect(attempts).toBe(0);
});

test("password update provider error is unavailable and retains the rotated session", async () => {
  let attempts = 0;
  const harness = passwordRouteHarness(
    async () => {
      attempts++;
      return new Response(null, { status: 204 });
    },
    {
      updateUser: async () => ({
        error: { name: "AuthRetryableFetchError", message: "private detail" },
      }),
    },
  );
  const response = await harness.post();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    detail:
      "Password update outcome is uncertain; sign in to confirm before trying again.",
  });
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(attempts).toBe(0);
});

test("password setup never retries invitation acceptance after a rejected response", async () => {
  let attempts = 0;
  const harness = passwordRouteHarness(async () => {
    attempts++;
    return new Response(null, { status: 403 });
  });
  const response = await harness.post();
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    detail: "Password set, but account setup could not be completed",
  });
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(attempts).toBe(1);
});

test("password policy rejection preserves the session and permits corrected input", async () => {
  for (const code of ["weak_password", "same_password"]) {
    let attempts = 0;
    const harness = passwordRouteHarness(
      async () => {
        attempts++;
        return new Response(null, { status: 204 });
      },
      {
        updateUser: async () => ({
          error: { code, status: 422, message: "private policy detail" },
        }),
      },
    );
    const response = await harness.post();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ detail: "Unable to set password" });
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).not.toContain("Max-Age=0");
    expect(attempts).toBe(0);
  }
});
