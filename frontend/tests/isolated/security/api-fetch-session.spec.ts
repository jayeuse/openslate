import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
  apiFetch,
  apiFetchWithMetadata,
  ApiError,
  ApiContractError,
  getApiFieldErrors,
  getSessionConnection,
  subscribeSessionConnection,
} from "../../../src/lib/api";

test("parses a strict response while preserving its ETag metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ id: "record-1" }, { headers: { ETag: '"record-7"' } });
  try {
    const result = await apiFetchWithMetadata(
      "/records/one",
      z.strictObject({ id: z.string() }),
    );
    expect(result.data).toEqual({ id: "record-1" });
    expect(result.etag).toBe('"record-7"');
    expect(result.response.headers.get("ETag")).toBe('"record-7"');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses the same-origin API path and includes the CSRF cookie for mutations", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "openslate_csrf=csrf%20value; other=ignored" },
  });
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return Response.json({ id: "record-1" });
  };
  try {
    await expect(
      apiFetch("/records/one", z.object({ id: z.string() }), {
        method: "PATCH",
        body: JSON.stringify({ title: "Changed" }),
      }),
    ).resolves.toEqual({ id: "record-1" });
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toBe("/api/records/one");
    expect(new Headers(requests[0].init?.headers).get("X-CSRF-Token")).toBe(
      "csrf value",
    );
    expect(requests[0].init?.credentials).toBe("same-origin");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument)
      Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("retries a rejected API request once after a successful refresh", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "openslate_csrf=csrf-token" },
  });
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    if (requests.length === 1) return new Response(null, { status: 401 });
    if (requests.length === 2) return new Response(null, { status: 204 });
    return Response.json({ id: "record-1" });
  };
  try {
    await expect(
      apiFetch("/records/one", z.object({ id: z.string() }), {
        method: "DELETE",
      }),
    ).resolves.toEqual({ id: "record-1" });
    expect(requests.map(({ input }) => input)).toEqual([
      "/api/records/one",
      "/api/auth/session",
      "/api/auth/refresh",
      "/api/records/one",
    ]);
    expect(requests[2].init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
    });
    expect(new Headers(requests[2].init?.headers).get("X-CSRF-Token")).toBe(
      "csrf-token",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument)
      Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("concurrent rejected requests share one refresh before each retries once", async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const requests: Array<RequestInfo | URL> = [];
  const attempts = new Map<string, number>();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });
  globalThis.fetch = async (input) => {
    requests.push(input);
    const path = String(input);
    if (path === "/api/auth/session")
      return Response.json({ authenticated: false });
    if (path === "/api/auth/refresh")
      return Response.json({ authenticated: true, setup_required: false });
    const attempt = (attempts.get(path) ?? 0) + 1;
    attempts.set(path, attempt);
    return attempt === 1
      ? new Response(null, { status: 401 })
      : Response.json({ id: path });
  };
  try {
    await expect(
      Promise.all([
        apiFetch("/records/one", z.object({ id: z.string() })),
        apiFetch("/records/two", z.object({ id: z.string() })),
      ]),
    ).resolves.toEqual([
      { id: "/api/records/one" },
      { id: "/api/records/two" },
    ]);
    expect(
      requests.filter((path) => path === "/api/auth/refresh"),
    ).toHaveLength(1);
    expect(attempts).toEqual(
      new Map([
        ["/api/records/one", 2],
        ["/api/records/two", 2],
      ]),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator)
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("keeps the original API failure readable when refresh is rejected", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const location = { href: "/openview" };
  const requests: Array<RequestInfo | URL> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location },
  });
  globalThis.fetch = async (input) => {
    requests.push(input);
    return requests.length === 1
      ? Response.json({ detail: "Session expired" }, { status: 401 })
      : Response.json({ detail: "Session expired" }, { status: 401 });
  };
  try {
    await expect(apiFetch("/records/one", z.object({}))).rejects.toMatchObject({
      status: 401,
      message: "Session expired",
    });
    expect(requests).toEqual([
      "/api/records/one",
      "/api/auth/session",
      "/api/auth/refresh",
    ]);
    expect(location.href).toBe("/login");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("an unavailable refresh retries quietly and keeps the user signed in", async () => {
  // Live seven-pack run: a short Auth outage answered the refresh with 503, and the
  // browser treated it as signed out. The server now keeps the session for a retry.
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const location = { href: "/openview" };
  const requests: Array<RequestInfo | URL> = [];
  const states: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location },
  });
  const stop = subscribeSessionConnection(() =>
    states.push(getSessionConnection()),
  );
  let refreshes = 0;
  globalThis.fetch = async (input) => {
    requests.push(input);
    if (input === "/api/auth/session")
      return Response.json({ authenticated: false });
    if (input === "/api/auth/refresh")
      return ++refreshes === 1
        ? new Response(null, { status: 503, headers: { "Retry-After": "1" } })
        : new Response(null, { status: 204 });
    return requests.length === 1
      ? new Response(null, { status: 401 })
      : Response.json({ id: "record-1" });
  };
  try {
    await expect(
      apiFetch("/records/one", z.object({ id: z.string() })),
    ).resolves.toEqual({ id: "record-1" });
    expect(requests).toEqual([
      "/api/records/one",
      "/api/auth/session",
      "/api/auth/refresh",
      "/api/auth/session",
      "/api/auth/refresh",
      "/api/records/one",
    ]);
    expect(location.href).toBe("/openview");
    expect(states).toEqual(["reconnecting", "connected"]);
  } finally {
    stop();
    globalThis.fetch = originalFetch;
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("does not navigate or refresh when an auth request opts out of refresh", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const location = { href: "/auth/recovery" };
  const requests: Array<RequestInfo | URL> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location },
  });
  globalThis.fetch = async (input) => {
    requests.push(input);
    return Response.json(
      { detail: "Invalid authentication credentials" },
      { status: 401 },
    );
  };
  try {
    await expect(
      apiFetch("/auth/login", z.object({}), {
        method: "POST",
        refreshOnUnauthorized: false,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(requests).toEqual(["/api/auth/login"]);
    expect(location.href).toBe("/auth/recovery");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
for (const aborted of [true, false]) {
  test(`${aborted ? "does not navigate for an aborted" : "navigates for a current"} 401 after its body resolves`, async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    const location = { href: "/protected" };
    const controller = new AbortController();
    let release!: (body: unknown) => void;
    const body = new Promise((resolve) => {
      release = resolve;
    });
    const response = new Response(null, { status: 401 });
    response.json = () => body;
    globalThis.fetch = async () => response;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location },
    });
    try {
      const result = apiFetch("/auth/me", z.object({}), {
        signal: controller.signal,
      });
      if (aborted) controller.abort();
      release({ detail: "Expired" });
      await expect(result).rejects.toBeInstanceOf(ApiError);
      expect(location.href).toBe(aborted ? "/protected" : "/login");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow)
        Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
}

test("aborting while a response body is read preserves the abort error", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let rejectBody!: (error: unknown) => void;
  const body = new Promise<unknown>((_, reject) => {
    rejectBody = reject;
  });
  globalThis.fetch = async () =>
    ({ status: 200, ok: true, json: () => body }) as Response;
  try {
    const result = apiFetch("/records/one", z.object({}), {
      signal: controller.signal,
    });
    controller.abort();
    const abortError = new DOMException(
      "The operation was aborted.",
      "AbortError",
    );
    rejectBody(abortError);
    await expect(result).rejects.toBe(abortError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transport failures remain the original rejected error", async () => {
  const originalFetch = globalThis.fetch;
  const transportError = new Error("network details");
  globalThis.fetch = async () => {
    throw transportError;
  };
  try {
    await expect(apiFetch("/records/one", z.object({}))).rejects.toBe(
      transportError,
    );
    globalThis.fetch = async () =>
      Object.assign(new Response(null, { status: 200 }), {
        json: async () => {
          throw transportError;
        },
      });
    await expect(apiFetch("/records/one", z.object({}))).rejects.toBe(
      transportError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("field validation normalizes supported messages and drops malformed entries", () => {
  expect(
    getApiFieldErrors(
      new ApiError(422, "Invalid", {
        errors: {
          title: "Required",
          amount: [
            "Too small",
            { message: "Must be positive" },
            null,
            4,
            { message: 9 },
          ],
          ignored: null,
        },
      }),
    ),
  ).toEqual({ title: ["Required"], amount: ["Too small", "Must be positive"] });
  expect(
    getApiFieldErrors(
      new ApiError(422, "Invalid", {
        errors: [
          { field_id: "title", message: "Required" },
          { field_id: "title", message: "Must be unique" },
          { field_id: 12, message: "Invalid" },
          null,
        ],
      }),
    ),
  ).toEqual({ title: ["Required", "Must be unique"] });
  expect(getApiFieldErrors(new Error("Transport failure"))).toEqual({});
  expect(
    getApiFieldErrors(new ApiError(422, "Invalid", { errors: null })),
  ).toEqual({});
});

test("valid successful JSON is parsed through the caller-provided schema", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: "record-1" });
  try {
    const result = await apiFetch("/records/one", z.object({ id: z.string() }));
    expect(result).toEqual({ id: "record-1" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("successful JSON that fails the schema becomes a safe contract error", async () => {
  const originalFetch = globalThis.fetch;
  const privatePayload = {
    id: "private-record-id",
    owner_email: "owner@example.com",
  };
  globalThis.fetch = async () => Response.json(privatePayload);
  try {
    const error = await apiFetch(
      "/records/one",
      z.object({ id: z.number() }),
    ).catch((rejection: unknown) => rejection);
    expect(error).toBeInstanceOf(ApiContractError);
    expect(error).toMatchObject({
      name: "ApiContractError",
      message: "The server returned an invalid response",
    });
    expect(error).not.toHaveProperty("details");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed successful JSON becomes a safe contract error without exposing the body", async () => {
  const originalFetch = globalThis.fetch;
  const privateBody = "private upstream stack trace";
  globalThis.fetch = async () => new Response(privateBody, { status: 200 });
  try {
    const error = await apiFetch("/records/one", z.object({})).catch(
      (rejection: unknown) => rejection,
    );
    expect(error).toMatchObject({
      name: "ApiContractError",
      message: "The server returned an invalid response",
    });
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error)
      expect(error.message).not.toContain(privateBody);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("204 requires a schema that explicitly accepts null", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    await expect(apiFetch("/records/one", z.object({}))).rejects.toBeInstanceOf(
      ApiContractError,
    );
    await expect(apiFetch("/records/one", z.null())).resolves.toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API errors preserve structured validation and safely handle non-JSON upstream failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json(
        {
          detail: {
            message: "Close parent first",
            code: "close_required",
            blockers: ["child"],
          },
        },
        { status: 409 },
      );
    await expect(apiFetch("/records/one", z.object({}))).rejects.toMatchObject({
      status: 409,
      message: "Close parent first",
      code: "close_required",
      details: { blockers: ["child"] },
    });
    globalThis.fetch = async () =>
      new Response("<html>private proxy failure</html>", { status: 502 });
    await expect(apiFetch("/records/one", z.object({}))).rejects.toMatchObject({
      status: 502,
      message: "Request could not be completed",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
