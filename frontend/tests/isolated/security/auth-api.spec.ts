import { expect, test } from "@playwright/test";

import {
  completeRecovery,
  completeInvitation,
  getAuthMe,
  getSessionStatus,
  requestRecovery,
  signIn,
  signOut,
} from "../../../src/lib/auth-api";

const userId = "2cb24e31-8b78-4ec2-b33a-807a14b1f9e8";
const roleId = "b4f0b2e8-16da-4d91-aef2-57ff72b19f90";

test("loads only the authenticated user's identity and current role ID", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return Response.json({
      id: userId,
      role_id: roleId,
      role: "member",
      permissions: ["records.read"],
    });
  };
  try {
    await expect(getAuthMe()).resolves.toEqual({ id: userId, roleId });
    expect(requests.map(({ input }) => input)).toEqual(["/api/auth/me"]);
    expect(requests[0]?.init?.cache).toBe("no-store");
    expect(
      new Headers(requests[0]?.init?.headers).get("Authorization"),
    ).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authentication actions use direct FastAPI routes without browser tokens", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    if (input === "/api/auth/session")
      return Response.json({
        authenticated: true,
        user_id: userId,
        setup_required: false,
      });
    if (input === "/api/auth/invitations/complete")
      return new Response(null, { status: 204 });
    if (input === "/api/auth/recovery/request")
      return new Response(null, { status: 204 });
    if (input === "/api/auth/recovery/complete")
      return new Response(null, { status: 204 });
    if (input === "/api/auth/logout")
      return new Response(null, { status: 204 });
    return Response.json({ authenticated: true, setup_required: false });
  };
  try {
    await signIn("operator@example.test", "correct horse battery staple");
    await getSessionStatus();
    await completeInvitation(
      "invitation-token",
      "new correct horse battery staple",
    );
    await requestRecovery("operator@example.test");
    await completeRecovery(
      "recovery-token",
      "new correct horse battery staple",
    );
    await signOut();

    expect(requests.map(({ input }) => input)).toEqual([
      "/api/auth/login",
      "/api/auth/session",
      "/api/auth/invitations/complete",
      "/api/auth/recovery/request",
      "/api/auth/recovery/complete",
      "/api/auth/logout",
    ]);
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      email: "operator@example.test",
      password: "correct horse battery staple",
    });
    expect(JSON.parse(String(requests[2].init?.body))).toEqual({
      token_hash: "invitation-token",
      password: "new correct horse battery staple",
    });
    expect(JSON.parse(String(requests[3].init?.body))).toEqual({
      email: "operator@example.test",
    });
    expect(JSON.parse(String(requests[4].init?.body))).toEqual({
      token_hash: "recovery-token",
      password: "new correct horse battery staple",
    });
    for (const request of requests) {
      const headers = new Headers(request.init?.headers);
      expect(headers.get("Authorization")).toBeNull();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid login does not attempt a refresh", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<RequestInfo | URL> = [];
  globalThis.fetch = async (input) => {
    requests.push(input);
    return Response.json(
      { detail: "Invalid identifier or password" },
      { status: 401 },
    );
  };
  try {
    await expect(
      signIn("operator@example.test", "wrong password"),
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(requests).toEqual(["/api/auth/login"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recovery requests expose no account-specific result to the browser", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return new Response(null, { status: 204 });
  };
  try {
    await expect(
      Promise.all([
        requestRecovery("operator@example.test"),
        requestRecovery("unknown@example.test"),
      ]),
    ).resolves.toEqual([null, null]);
    expect(requests.map(({ input }) => input)).toEqual([
      "/api/auth/recovery/request",
      "/api/auth/recovery/request",
    ]);
    expect(requests.map(({ init }) => JSON.parse(String(init?.body)))).toEqual([
      { email: "operator@example.test" },
      { email: "unknown@example.test" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const status of [400, 422]) {
  test(`recovery completion can retry after a generic ${status} response`, async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
      [];
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      requests.push({ input, init });
      calls += 1;
      return calls === 1
        ? Response.json({ detail: "Rejected" }, { status })
        : new Response(null, { status: 204 });
    };
    try {
      await expect(
        completeRecovery("recovery-token", "valid recovery password"),
      ).rejects.toMatchObject({ status });
      await expect(
        completeRecovery("recovery-token", "valid recovery password"),
      ).resolves.toBeNull();
      expect(requests.map(({ input }) => input)).toEqual([
        "/api/auth/recovery/complete",
        "/api/auth/recovery/complete",
      ]);
      expect(
        requests.map(({ init }) => JSON.parse(String(init?.body))),
      ).toEqual([
        { token_hash: "recovery-token", password: "valid recovery password" },
        { token_hash: "recovery-token", password: "valid recovery password" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("session status refreshes once before declaring an expired access cookie signed out", async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const requests: Array<RequestInfo | URL> = [];
  const locks: string[] = [];
  let statusCalls = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async (
          name: string,
          _options: { mode: "exclusive" },
          callback: () => Promise<unknown>,
        ) => {
          locks.push(name);
          return callback();
        },
      },
    },
  });
  globalThis.fetch = async (input) => {
    requests.push(input);
    if (input === "/api/auth/session") {
      statusCalls += 1;
      return statusCalls <= 2
        ? Response.json({ authenticated: false })
        : Response.json({
            authenticated: true,
            user_id: userId,
            setup_required: false,
          });
    }
    if (input === "/api/auth/refresh")
      return Response.json({ authenticated: true, setup_required: false });
    throw new Error(`Unexpected request: ${String(input)}`);
  };
  try {
    await expect(getSessionStatus()).resolves.toEqual({
      authenticated: true,
      user_id: userId,
      setup_required: false,
    });
    expect(requests).toEqual([
      "/api/auth/session",
      "/api/auth/session",
      "/api/auth/refresh",
      "/api/auth/session",
    ]);
    expect(locks).toEqual(["openslate-auth-refresh"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator)
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("logout rejects a server failure so the shell can retain local state", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ detail: "Unable to sign out" }, { status: 503 });
  try {
    await expect(signOut()).rejects.toMatchObject({
      status: 503,
      message: "Unable to sign out",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
