import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
  apiFetch,
  ApiError,
  ApiContractError,
  getApiFieldErrors,
} from "../../../src/lib/api";
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
    globalThis.fetch = async () =>
      ({ status: 401, ok: false, json: () => body }) as Response;
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
