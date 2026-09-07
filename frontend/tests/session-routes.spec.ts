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
