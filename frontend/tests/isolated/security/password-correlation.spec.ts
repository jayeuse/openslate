import { expect, test } from "@playwright/test";
import {
  accessCanary,
  queryCanary,
  callerCanary,
  passwordCanary,
  passwordRouteHarness,
  refreshCanary,
} from "../../helpers/password-route-harness";

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
        : { detail: "Unable to set password" },
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
  expect(response.status).toBe(400);
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
