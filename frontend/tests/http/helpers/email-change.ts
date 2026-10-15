import { expect, type Page } from "./test";
import { profileGate, profileUserA } from "./profile-api";

export const currentEmailProof = "c".repeat(56);
export const newEmailProof = "d".repeat(56);
export const changedEmail = "changed@example.test";
export const emailChangeLanding = "/auth/email-change";
export const partialEmailConfirmation = {
  authenticated: false,
  confirmation_required: true,
};
export const fullEmailConfirmation = {
  authenticated: true,
  confirmation_required: false,
  setup_required: false,
};

// Only the new email commands are mocked here. Private Profile and MFA reads
// remain in their incumbent fixtures; this is not provider/DB acceptance proof.
export async function installEmailChangeApi(
  page: Page,
  options: { signedOut?: boolean } = {},
) {
  const state = {
    authenticated: !options.signedOut,
    requestStatus: 200,
    requestBody: { confirmation_required: true } as unknown,
    requestUnknown: false,
    completeStatus: 200,
    completeBody: partialEmailConfirmation as unknown,
    admit: false,
    onAdmission: () => {},
    holdRequest: null as ReturnType<typeof profileGate> | null,
    holdComplete: null as ReturnType<typeof profileGate> | null,
    requests: [] as {
      method: string;
      body: unknown;
      headers: Record<string, string>;
    }[],
    completions: [] as {
      method: string;
      body: unknown;
      headers: Record<string, string>;
    }[],
    requestResponses: 0,
    completeResponses: 0,
    refreshes: 0,
    logouts: 0,
  };
  if (options.signedOut) {
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        json: state.authenticated
          ? {
              authenticated: true,
              user_id: profileUserA,
              setup_required: false,
            }
          : { authenticated: false },
      }),
    );
    await page.route("**/api/auth/me", (route) =>
      state.authenticated
        ? route.fallback()
        : route.fulfill({ status: 401, json: { detail: "Not authenticated" } }),
    );
  }
  // A successful refresh would make apiRequest's default 401 replay observable.
  await page.route("**/api/auth/refresh", (route) => {
    state.refreshes += 1;
    return route.fulfill({ status: 200, json: { authenticated: true } });
  });
  await page.route("**/api/auth/logout", async (route) => {
    state.logouts += 1;
    state.authenticated = false;
    await page.context().clearCookies();
    await route.fulfill({ status: 204 });
  });
  // Only POST requests an email change. Another method gets 405, so a caller
  // sees the failure on the page; tests assert the recorded method.
  await page.route("**/api/auth/me/email", async (route) => {
    state.requests.push({
      method: route.request().method(),
      body: route.request().postDataJSON(),
      headers: route.request().headers(),
    });
    if (route.request().method() !== "POST") {
      await route.fulfill({
        status: 405,
        json: { detail: "Method not allowed" },
      });
      return;
    }
    const { requestStatus, requestBody, requestUnknown, holdRequest } = state;
    state.holdRequest = null;
    if (holdRequest) {
      holdRequest.start();
      await holdRequest.waiting;
    }
    if (requestUnknown) await route.abort("failed").catch(() => {});
    else
      await route
        .fulfill({ status: requestStatus, json: requestBody })
        .catch(() => {});
    state.requestResponses += 1;
  });
  await page.route("**/api/auth/email/complete", async (route) => {
    state.completions.push({
      method: route.request().method(),
      body: route.request().postDataJSON(),
      headers: route.request().headers(),
    });
    const { completeStatus, completeBody, admit, holdComplete } = state;
    state.holdComplete = null;
    if (holdComplete) {
      holdComplete.start();
      await holdComplete.waiting;
    }
    if (admit) {
      state.authenticated = true;
      state.onAdmission();
    }
    await route
      .fulfill({
        status: completeStatus,
        json: completeBody,
        headers: admit
          ? {
              "set-cookie":
                "openslate_access=owned-http-session; Path=/; HttpOnly; SameSite=Lax",
            }
          : {},
      })
      .catch(() => {});
    state.completeResponses += 1;
  });
  return state;
}

export async function observeEmailSecretExposure(page: Page) {
  await page.addInitScript(() => {
    const state = { exposed: false };
    Object.assign(window, { openslateEmailSecrets: state });
    const send = window.fetch.bind(window);
    window.fetch = (...args) => {
      const target = args[0];
      const url = target instanceof Request ? target.url : String(target);
      if (url.includes("/api/")) {
        state.exposed ||= /token_hash|c{56}|d{56}/.test(
          window.location.href + url,
        );
        for (const store of [localStorage, sessionStorage])
          state.exposed ||= Object.values(store).some(
            (value) =>
              typeof value === "string" &&
              /token_hash|c{56}|d{56}|owned current password/.test(value),
          );
      }
      return send(...args);
    };
  });
}

export async function expectNoEmailSecrets(page: Page) {
  const safe = await page.evaluate(() => {
    const state = (
      window as unknown as { openslateEmailSecrets: { exposed: boolean } }
    ).openslateEmailSecrets;
    const values = [
      window.location.href,
      document.body.innerHTML,
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
    ];
    return (
      !state.exposed &&
      values.every(
        (value) =>
          typeof value !== "string" || !/token_hash|c{56}|d{56}/.test(value),
      )
    );
  });
  expect(safe).toBe(true);
}
