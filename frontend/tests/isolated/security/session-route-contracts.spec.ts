import { expect, test } from "@playwright/test";
import { sessionRouteHarness } from "../../helpers/session-route-harness";
import { testSecret } from "../../helpers/test-secret";
const session = {
  access_token: testSecret(),
  refresh_token: testSecret(),
  expires_in: 1800,
  user: { id: "2cb24e31-8b78-4ec2-b33a-807a14b1f9e8" },
};
const accepted = { data: { session }, error: null };
const rejected = {
  data: { session: null },
  error: { message: "private provider detail" },
};
const ambiguous = { data: { session: null }, error: null };
const invalidRefreshError = {
  data: { session: null },
  error: {
    code: "refresh_token_not_found",
    message: "private provider detail",
  },
};
const cookies = {
  openslate_access: testSecret(),
  openslate_refresh: testSecret(),
};
function expectCookies(response: Response, cleared = false) {
  const header = response.headers.get("set-cookie") ?? "";
  expect(header).toContain(
    `openslate_access=${cleared ? ";" : session.access_token}`,
  );
  expect(header).toContain(
    `openslate_refresh=${cleared ? ";" : session.refresh_token}`,
  );
  expect(header).toContain("HttpOnly");
  expect(header).toContain("SameSite=lax");
  expect(header).toContain(cleared ? "Max-Age=0" : "Max-Age=1800");
}
function expectNoCookieMutation(response: Response) {
  expect(response.headers.get("set-cookie")).toBeNull();
}
test("login trims email, sets private cookies, and returns no tokens", async () => {
  const inputs: unknown[] = [];
  const response = await sessionRouteHarness("session/login", {
    signInWithPassword: async (input) => {
      inputs.push(input);
      return accepted;
    },
  }).request({
    body: JSON.stringify({
      email: " operator@example.com ",
      password: "valid-password",
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ authenticated: true });
  expect(inputs).toEqual([
    { email: "operator@example.com", password: "valid-password" },
  ]);
  expectCookies(response);
});
test("login denies foreign origins and invalid inputs before calling Auth", async () => {
  let calls = 0;
  const harness = sessionRouteHarness("session/login", {
    signInWithPassword: async () => {
      calls++;
      return rejected;
    },
  });
  expect(
    (await harness.request({ origin: "https://foreign.invalid" })).status,
  ).toBe(403);
  for (const body of [
    "{",
    '{"email":"bad","password":"x"}',
    '{"email":"operator@example.com","password":"x","admin":true}',
  ])
    expect((await harness.request({ body })).status).toBe(400);
  expect(calls).toBe(0);
});
test("login translates provider rejection and outages to safe responses", async () => {
  for (const offline of [false, true]) {
    const response = await sessionRouteHarness("session/login", {
      signInWithPassword: async () => {
        if (offline) throw new Error("private failure");
        return rejected;
      },
    }).request({
      body: JSON.stringify({ email: "operator@example.com", password: "x" }),
    });
    expect(response.status).toBe(offline ? 503 : 401);
    expect(await response.json()).toEqual({
      detail: offline ? "Unable to sign in" : "Invalid email or password",
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  }
});
test("status renews valid sessions and clears only confirmed invalid or missing sessions", async () => {
  const inputs: unknown[] = [];
  const response = await sessionRouteHarness(
    "session/status",
    {
      refreshSession: async (input) => {
        inputs.push(input);
        return accepted;
      },
    },
    { openslate_refresh: cookies.openslate_refresh },
  ).request();
  expect(inputs).toEqual([{ refresh_token: cookies.openslate_refresh }]);
  expect(await response.json()).toEqual({
    authenticated: true,
    userId: session.user.id,
  });
  expectCookies(response);
  for (const error of [
    invalidRefreshError.error,
    { name: "AuthSessionMissingError", message: "private provider detail" },
  ]) {
    const invalid = await sessionRouteHarness(
      "session/status",
      {
        setSession: async () => ({ data: { session: null }, error }),
      },
      cookies,
    ).request();
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toEqual({ authenticated: false });
    expectCookies(invalid, true);
  }
  const absent = await sessionRouteHarness("session/status", {}).request();
  expect(absent.status).toBe(200);
  expect(await absent.json()).toEqual({ authenticated: false });
  expectCookies(absent, true);
});

test("status preserves cookies for provider outages, ambiguous sessions, and deadlines", async () => {
  for (const mode of ["provider", "ambiguous"] as const) {
    const response = await sessionRouteHarness(
      "session/status",
      {
        setSession: async () =>
          mode === "provider"
            ? Promise.reject(new Error("private provider failure"))
            : ambiguous,
      },
      cookies,
    ).request();
    expect(response.status, mode).toBe(503);
    expect(await response.json(), mode).toEqual({
      detail: "Authentication service unavailable",
    });
    expectNoCookieMutation(response);
  }

  const deadline: { expire: () => void } = {
    expire: () => {
      throw new Error("deadline unavailable");
    },
  };
  const harness = sessionRouteHarness(
    "session/status",
    {
      setSession: async () => {
        deadline.expire();
        return accepted;
      },
    },
    cookies,
  );
  deadline.expire = harness.expire;
  const response = await harness.request();
  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({
    detail: "Authentication service timed out",
  });
  expectNoCookieMutation(response);
});
test("realtime token denies foreign origins and missing refresh credentials", async () => {
  const harness = sessionRouteHarness("session/realtime-token", {});
  expect(
    (await harness.request({ origin: "https://foreign.invalid" })).status,
  ).toBe(403);
  const response = await harness.request();
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ detail: "Authentication required" });
  expectCookies(response, true);
});
test("realtime token returns only the access token and expires rejected sessions", async () => {
  const response = await sessionRouteHarness(
    "session/realtime-token",
    { setSession: async () => accepted },
    cookies,
  ).request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ access_token: session.access_token });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expectCookies(response);
  const denied = await sessionRouteHarness(
    "session/realtime-token",
    { setSession: async () => invalidRefreshError },
    cookies,
  ).request();
  expect(denied.status).toBe(401);
  expect(await denied.json()).toEqual({ detail: "Session expired" });
  expectCookies(denied, true);
});

test("realtime token preserves cookies for unavailable or timed out refreshes", async () => {
  for (const mode of ["provider", "ambiguous"] as const) {
    const response = await sessionRouteHarness(
      "session/realtime-token",
      {
        setSession: async () =>
          mode === "provider"
            ? Promise.reject(new Error("private provider failure"))
            : rejected,
      },
      cookies,
    ).request();
    expect(response.status, mode).toBe(503);
    expect(await response.json(), mode).toEqual({
      detail: "Authentication service unavailable",
    });
    expectNoCookieMutation(response);
  }

  const deadline: { expire: () => void } = {
    expire: () => {
      throw new Error("deadline unavailable");
    },
  };
  const harness = sessionRouteHarness(
    "session/realtime-token",
    {
      setSession: async () => {
        deadline.expire();
        return accepted;
      },
    },
    cookies,
  );
  deadline.expire = harness.expire;
  const response = await harness.request();
  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({
    detail: "Authentication service timed out",
  });
  expectNoCookieMutation(response);
});
test("logout revokes locally with refresh fallback and clears cookies despite provider failure", async () => {
  for (const mode of [
    "valid",
    "refresh",
    "refresh-only",
    "offline",
    "rejected",
  ] as const) {
    const revoked: unknown[] = [];
    const response = await sessionRouteHarness(
      "session/logout",
      {
        setSession: async () => {
          if (mode === "offline") throw new Error("offline");
          return mode === "valid" ? accepted : rejected;
        },
        refreshSession: async () => (mode === "rejected" ? rejected : accepted),
        signOut: async (input) => {
          revoked.push(input);
          return { error: null };
        },
      },
      mode === "refresh-only"
        ? { openslate_refresh: cookies.openslate_refresh }
        : cookies,
    ).request();
    expect(response.status, mode).toBe(204);
    expectCookies(response, true);
    expect(revoked, mode).toEqual(
      mode === "offline" || mode === "rejected" ? [] : [{ scope: "local" }],
    );
  }
  expect(
    (
      await sessionRouteHarness("session/logout", {}).request({
        origin: "https://foreign.invalid",
      })
    ).status,
  ).toBe(403);
  expectCookies(
    await sessionRouteHarness("session/logout", {}).request(),
    true,
  );
});
test("callback exchanges codes or invitation tokens and ignores external redirect parameters", async () => {
  for (const invite of [false, true]) {
    const inputs: unknown[] = [];
    const response = await sessionRouteHarness("auth/callback", {
      exchangeCodeForSession: async (input) => {
        inputs.push(input);
        return accepted;
      },
      verifyOtp: async (input) => {
        inputs.push(input);
        return accepted;
      },
    }).request({
      query: invite
        ? "?token_hash=invitation&type=invite&next=https://foreign.invalid"
        : "?code=one-use-code&next=https://foreign.invalid",
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://frontend.invalid/auth/setup",
    );
    expect(inputs).toEqual(
      invite
        ? [{ token_hash: "invitation", type: "invite" }]
        : ["one-use-code"],
    );
    expectCookies(response);
  }
});
test("callback rejects ambiguous or unsupported credentials and safely redirects provider failures", async () => {
  for (const query of [
    "",
    "?code=a&token_hash=b",
    "?token_hash=b&type=recovery",
  ]) {
    const response = await sessionRouteHarness("auth/callback", {}).request({
      query,
    });
    expect(response.headers.get("location")).toBe(
      "http://frontend.invalid/login",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  for (const offline of [false, true]) {
    const response = await sessionRouteHarness("auth/callback", {
      exchangeCodeForSession: async () => {
        if (offline) throw new Error("private failure");
        return rejected;
      },
    }).request({ query: "?code=expired" });
    expect(response.headers.get("location")).toBe(
      "http://frontend.invalid/login",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
  }
});
