import { expect, test } from "@playwright/test";

test("BFF denies invitation acceptance for every HTTP method", async ({
  request,
  baseURL,
}) => {
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

  for (const method of methods) {
    const response = await request.fetch("/bff/auth/invitations/accept", {
      method,
      headers: { Origin: baseURL ?? "http://localhost:3000" },
    });

    expect(response.status(), method).toBe(403);
    expect(response.headers()["set-cookie"], method).toBeUndefined();
    if (method !== "HEAD") {
      const body = await response.text();
      expect(body, method).not.toContain("auth/invitations/accept");
      expect(body, method).toContain('"detail":"Forbidden"');
    }
  }
});

test("BFF rejects oversized declared request bodies with its own diagnostic ID", async ({
  request,
  baseURL,
}) => {
  const response = await request.post("/bff/modules", {
    data: "x".repeat(1024 * 1024 + 1),
    headers: {
      Origin: baseURL ?? "http://localhost:3000",
      "X-Request-ID": "caller-controlled-id",
    },
  });

  expect(response.status()).toBe(413);
  expect(response.headers()["x-request-id"]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(response.headers()["x-request-id"]).not.toBe("caller-controlled-id");
  await expect(response.json()).resolves.toEqual({
    detail: "Request or upstream response is too large",
  });
});

test("session login rejects oversized JSON before calling Auth", async ({
  request,
  baseURL,
}) => {
  const response = await request.post("/session/login", {
    data: { password: "x".repeat(1024 * 1024 + 1) },
    headers: { Origin: baseURL ?? "http://localhost:3000" },
  });

  expect(response.status()).toBe(413);
  expect(response.headers()["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(response.json()).resolves.toEqual({
    detail: "Request is too large",
  });
});
