import { randomBytes } from "node:crypto";
import type { Page } from "./test";

export const mfaUserA = "00000000-0000-4000-8000-000000000001";
export const mfaUserB = "00000000-0000-4000-8000-000000000002";
type Factor = {
  id: string;
  factor_type: string;
  status: "verified" | "unverified";
};

export function deferredMfaResponse() {
  let release = () => {};
  let started = () => {};
  return {
    waiting: new Promise<void>((resolve) => {
      release = resolve;
    }),
    begun: new Promise<void>((resolve) => {
      started = resolve;
    }),
    release: () => release(),
    start: () => started(),
  };
}

export async function mockMfa(
  page: Page,
  options: {
    required?: boolean;
    verified?: boolean;
    aal2?: boolean;
    isRequired?: () => boolean;
  } = {},
) {
  const actors = new Map(
    [mfaUserA, mfaUserB].map((id, index) => [
      id,
      {
        id,
        assurance: options.aal2 ? ("aal2" as const) : ("aal1" as const),
        policyRequired: Boolean(options.required),
        factors: options.verified
          ? ([
              {
                id: `00000000-0000-4000-8000-${String(501 + index * 1000).padStart(12, "0")}`,
                factor_type: "totp",
                status: "verified" as const,
              },
            ] as Factor[])
          : ([] as Factor[]),
      },
    ]),
  );
  const state = {
    actors,
    userId: mfaUserA,
    authenticated: true,
    networkDenied: false,
    unavailable: false,
    statusFailure: 0,
    cleanupFailure: 0,
    invalidVerifyAttempts: 0,
    holdEnroll: null as ReturnType<typeof deferredMfaResponse> | null,
    holdVerify: null as ReturnType<typeof deferredMfaResponse> | null,
    holdStatus: null as ReturnType<typeof deferredMfaResponse> | null,
    holdSession: null as ReturnType<typeof deferredMfaResponse> | null,
    calls: [] as { method: string; path: string; userId: string }[],
  };
  const actor = () => {
    const value = actors.get(state.userId);
    if (!value) throw new Error("Unknown synthetic actor");
    return value;
  };
  const statusFor = (userId: string) => {
    const value = actors.get(userId);
    if (!value) throw new Error("Unknown synthetic actor");
    const policyRequired =
      value.policyRequired || Boolean(options.isRequired?.());
    return {
      user_id: userId,
      assurance_level: value.assurance,
      policy_required: policyRequired,
      required_since: null,
      enrollment_deadline: null,
      required:
        policyRequired ||
        value.factors.some((factor) => factor.status === "verified"),
      factors: value.factors.map((factor) => ({ ...factor })),
    };
  };
  await page.addInitScript(() => {
    class FakeEventSource extends EventTarget {
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: FakeEventSource });
  });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        id: state.userId,
        role: "admin",
        access: [],
      },
    }),
  );
  await page.route("**/api/auth/session", async (route) => {
    const userId = state.userId;
    const current = statusFor(userId);
    const hold = state.holdSession;
    state.holdSession = null;
    if (hold) {
      hold.start();
      await hold.waiting;
    }
    const code = !state.authenticated
      ? null
      : state.networkDenied
        ? "ip_not_allowed"
        : current.required &&
            (current.assurance_level === "aal1" ||
              !current.factors.some((factor) => factor.status === "verified"))
          ? "mfa_required"
          : null;
    await route.fulfill({
      status: state.unavailable ? 503 : code ? 403 : 200,
      json: state.unavailable
        ? { detail: "Authentication service unavailable" }
        : code
          ? {
              detail: {
                code,
                message:
                  code === "mfa_required"
                    ? "Complete multi-factor authentication to continue"
                    : "Access from this address is not allowed",
              },
            }
          : state.authenticated
            ? { authenticated: true, user_id: userId, setup_required: false }
            : { authenticated: false },
    });
  });
  await page.route("**/api/auth/refresh", (route) =>
    route.fulfill({ status: 401 }),
  );
  await page.route("**/api/auth/logout", (route) => {
    state.authenticated = false;
    return route.fulfill({ status: 204 });
  });
  await page.route("**/api/auth/mfa", async (route) => {
    const userId = state.userId;
    const current = statusFor(userId);
    state.calls.push({ method: "GET", path: "/auth/mfa", userId });
    const hold = state.holdStatus;
    state.holdStatus = null;
    if (hold) {
      hold.start();
      await hold.waiting;
    }
    await route.fulfill({
      status: !state.authenticated ? 401 : state.statusFailure || 200,
      json: !state.authenticated
        ? { detail: "Not authenticated" }
        : state.statusFailure
          ? { detail: "MFA service unavailable" }
          : current,
    });
  });
  let nextFactor = 601;
  await page.route("**/api/auth/mfa/factors", async (route) => {
    const userId = state.userId;
    const current = actor();
    state.calls.push({ method: "POST", path: "/auth/mfa/factors", userId });
    if (
      current.assurance === "aal1" &&
      current.factors.some((factor) => factor.status === "verified")
    ) {
      await route.fulfill({
        status: 403,
        json: {
          detail: {
            code: "mfa_required",
            message: "Complete multi-factor authentication to continue",
          },
        },
      });
      return;
    }
    const id = `00000000-0000-4000-8000-${String(nextFactor++).padStart(12, "0")}`;
    current.factors.push({ id, factor_type: "totp", status: "unverified" });
    const hold = state.holdEnroll;
    state.holdEnroll = null;
    if (hold) {
      hold.start();
      await hold.waiting;
    }
    const secret = Array.from(
      randomBytes(20),
      (value) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[value & 31],
    ).join("");
    await route.fulfill({
      status: 201,
      json: {
        id,
        totp: {
          qr_code:
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="white"/><rect x="20" y="20" width="160" height="160" fill="black"/></svg>',
          secret,
          uri: `otpauth://totp/Controlled?secret=${secret}`,
        },
      },
    });
  });
  await page.route("**/api/auth/mfa/factors/*/verification", async (route) => {
    const userId = state.userId;
    const current = actor();
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    state.calls.push({
      method: "POST",
      path: `/auth/mfa/factors/${id}/verification`,
      userId,
    });
    const factor = current.factors.find((entry) => entry.id === id);
    const payload: unknown = route.request().postDataJSON();
    if (!factor) {
      await route.fulfill({
        status: 404,
        json: { detail: "MFA factor is unavailable" },
      });
      return;
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("code" in payload) ||
      typeof payload.code !== "string" ||
      !/^\d{6}$/.test(payload.code)
    ) {
      await route.fulfill({ status: 422, json: { detail: "Invalid code" } });
      return;
    }
    if (state.invalidVerifyAttempts > 0) {
      state.invalidVerifyAttempts -= 1;
      await route.fulfill({
        status: 400,
        json: {
          detail: {
            code: "mfa_verification_failed",
            message: "Verification code was not accepted",
          },
        },
      });
      return;
    }
    const hold = state.holdVerify;
    state.holdVerify = null;
    if (hold) {
      hold.start();
      await hold.waiting;
    }
    factor.status = "verified";
    current.assurance = "aal2";
    await route.fulfill({ json: { verified: true, access_token: null } });
  });
  await page.route("**/api/auth/mfa/factors/*", async (route) => {
    const userId = state.userId;
    const current = actor();
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    state.calls.push({
      method: "DELETE",
      path: `/auth/mfa/factors/${id}`,
      userId,
    });
    const factor = current.factors.find((entry) => entry.id === id);
    if (!factor) {
      await route.fulfill({
        status: 404,
        json: { detail: "MFA factor is unavailable" },
      });
      return;
    }
    if (state.cleanupFailure) {
      await route.fulfill({
        status: state.cleanupFailure,
        json: { detail: "MFA service unavailable" },
      });
      return;
    }
    if (
      new URL(route.request().url()).searchParams.get("unverified_only") ===
        "true" &&
      factor.status === "verified"
    ) {
      await route.fulfill({ status: 204 });
      return;
    }
    if (factor.status === "verified" && current.assurance !== "aal2") {
      await route.fulfill({
        status: 403,
        json: {
          detail: {
            code: "mfa_required",
            message: "Complete multi-factor authentication to continue",
          },
        },
      });
      return;
    }
    current.factors = current.factors.filter((entry) => entry.id !== id);
    if (factor.status === "verified") state.authenticated = false;
    await route.fulfill({ status: 204 });
  });
  return state;
}

export async function concealMfaTestCredentials(page: Page) {
  if (page.isClosed()) return;
  await page.addStyleTag({
    content: "[data-mfa-credential] { display: none !important; }",
  });
  await page.evaluate(() => {
    for (const region of document.querySelectorAll("[data-mfa-credential]"))
      region.replaceChildren();
  });
}
