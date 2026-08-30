import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import {
  createLiveApiClient,
  isLiveRole,
  isLiveUser,
  type LiveApiClient,
  type LiveRole,
  type LiveUser,
} from "./api";
import {
  assertNoRedirect,
  validateRequiredEnv,
  validateLoopbackHttpOrigin,
  type EnvironmentValues,
  type LiveEnvironment,
} from "./preflight";

export type LiveCredentials = Readonly<{
  email: string;
  password: string;
}>;

export type LiveAdminAuth = Readonly<{
  accessToken: string;
  userId: string;
  user: LiveUser;
  role: LiveRole;
  api: LiveApiClient;
}>;

type LiveSupabaseSignInResult = Readonly<{
  data: Readonly<{
    user: Readonly<{ id: string }> | null;
    session: Readonly<{ access_token: string }> | null;
  }>;
  error: unknown;
}>;

type LiveSupabaseClient = Readonly<{
  auth: Readonly<{
    signInWithPassword: (
      credentials: Readonly<{ email: string; password: string }>,
    ) => Promise<LiveSupabaseSignInResult>;
  }>;
}>;

const LIVE_CREDENTIALS_REQUIRED_ENV = [
  "LIVE_ADMIN_EMAIL",
  "LIVE_ADMIN_PASSWORD",
] as const;

export function liveCredentialsFromEnv(
  env: EnvironmentValues = process.env,
): LiveCredentials {
  const values = validateRequiredEnv(env, LIVE_CREDENTIALS_REQUIRED_ENV);
  const email = values.LIVE_ADMIN_EMAIL;
  const password = values.LIVE_ADMIN_PASSWORD;
  if (!email.includes("@") || password.length === 0) {
    throw new Error("Live administrator credentials are invalid");
  }
  return { email, password };
}

function isSupabaseUser(value: unknown): value is Readonly<{ id: string }> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.length > 0
  );
}

function invalidLiveAuth(message: string): Error {
  return new Error(message);
}

async function authenticateLiveAdmin(
  environment: LiveEnvironment,
  supabase: LiveSupabaseClient,
  onSignedIn: () => void,
): Promise<LiveAdminAuth> {
  const result = await supabase.auth.signInWithPassword({
    email: environment.adminEmail,
    password: environment.adminPassword,
  });
  if (
    result.error ||
    !result.data.session ||
    !isSupabaseUser(result.data.user)
  ) {
    throw invalidLiveAuth("Live administrator API sign-in failed");
  }

  onSignedIn();
  const accessToken = result.data.session.access_token;
  const userId = result.data.user.id;
  const api = createLiveApiClient(environment.apiOrigin, accessToken);
  const user = await api.get("/auth/me", undefined, isLiveUser);
  if (user.id !== userId) {
    throw invalidLiveAuth("Live administrator identity changed during sign-in");
  }

  const roles = await api.listAll<LiveRole>(
    "/roles",
    { limit: 100 },
    1000,
    isLiveRole,
  );
  const role = roles.find(
    (candidate) =>
      candidate.id === user.role_id &&
      candidate.role === "admin" &&
      candidate.is_deleted === false,
  );
  if (!role || !isLiveRole(role)) {
    throw invalidLiveAuth(
      "Live administrator does not have the active admin role",
    );
  }

  return { accessToken, userId, user, role, api };
}

export async function signInLiveAdminWithToken<Result>(
  environment: LiveEnvironment,
  operation: (auth: LiveAdminAuth) => Promise<Result>,
): Promise<Result> {
  return withLiveAdminToken(environment, operation);
}

export async function withLiveAdminToken<Result>(
  environment: LiveEnvironment,
  operation: (auth: LiveAdminAuth) => Promise<Result>,
): Promise<Result> {
  const supabase = createClient(
    environment.supabaseUrl,
    environment.supabasePublishableKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  let signedIn = false;
  try {
    const signedInAuth = await authenticateLiveAdmin(
      environment,
      supabase,
      () => {
        signedIn = true;
      },
    );
    return await operation(signedInAuth);
  } finally {
    if (signedIn) {
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    }
  }
}

export function liveCredentialsFromEnvironment(
  environment: LiveEnvironment,
): LiveCredentials {
  return {
    email: environment.adminEmail,
    password: environment.adminPassword,
  };
}

function expectedUiOrigin(page: Page, configuredOrigin?: string): string {
  if (configuredOrigin) return validateLoopbackHttpOrigin(configuredOrigin);
  if (process.env.LIVE_BASE_URL) {
    return validateLoopbackHttpOrigin(process.env.LIVE_BASE_URL);
  }
  try {
    return new URL(page.url()).origin;
  } catch {
    throw new Error("Live browser page has no validated UI origin");
  }
}

function assertExactPagePath(
  page: Page,
  pathname: string,
  uiOrigin?: string,
): void {
  const expectedOrigin = expectedUiOrigin(page, uiOrigin);
  const current = new URL(page.url());
  if (
    current.origin !== expectedOrigin ||
    current.pathname !== pathname ||
    current.search !== "" ||
    current.hash !== ""
  ) {
    throw new Error(`Live browser navigated away from ${pathname}`);
  }
}

export async function signInLiveAdmin(
  page: Page,
  credentials: LiveCredentials,
  uiOrigin?: string,
): Promise<void> {
  const expectedOrigin = expectedUiOrigin(page, uiOrigin);
  await page.goto("/login");
  assertExactPagePath(page, "/login", expectedOrigin);
  const loginResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.origin === expectedOrigin &&
      url.pathname === "/session/login" &&
      url.search === "" &&
      url.hash === ""
    );
  });
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const response = await loginResponse;
  assertNoRedirect(response.url(), expectedOrigin);
  if (new URL(response.url()).pathname !== "/session/login") {
    throw new Error("Live administrator login response path changed");
  }
  if (!response.ok()) throw new Error("Live administrator sign-in failed");
  await page.waitForURL(
    (url) =>
      url.origin === expectedOrigin &&
      url.pathname === "/workspace" &&
      url.search === "" &&
      url.hash === "",
  );
  assertExactPagePath(page, "/workspace", expectedOrigin);
}

export async function assertLiveSession(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const response = await fetch("/session/status", {
      credentials: "same-origin",
    });
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body, url: response.url };
  });
  assertNoRedirect(result.url, expectedUiOrigin(page));
  if (new URL(result.url).pathname !== "/session/status") {
    throw new Error("Live session status response path changed");
  }
  if (
    result.status !== 200 ||
    typeof result.body !== "object" ||
    result.body === null ||
    !("authenticated" in result.body) ||
    result.body.authenticated !== true
  ) {
    throw new Error("Live administrator session is not authenticated");
  }
}

export async function getLiveActorFromBff(page: Page): Promise<LiveUser> {
  const result = await page.evaluate(async () => {
    const response = await fetch("/bff/auth/me", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body, url: response.url };
  });
  assertNoRedirect(result.url, expectedUiOrigin(page));
  if (new URL(result.url).pathname !== "/bff/auth/me") {
    throw new Error("Live BFF actor response path changed");
  }
  if (result.status !== 200 || !isLiveUser(result.body)) {
    throw new Error("Live BFF actor response is invalid");
  }
  return result.body;
}

export async function assertLiveAdminRoleFromBff(
  page: Page,
  roleId: string,
): Promise<void> {
  const result = await page.evaluate(async (requestedRoleId) => {
    const response = await fetch(
      `/bff/roles/${encodeURIComponent(requestedRoleId)}`,
      {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      },
    );
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body, url: response.url };
  }, roleId);
  assertNoRedirect(result.url, expectedUiOrigin(page));
  if (
    new URL(result.url).pathname !== `/bff/roles/${encodeURIComponent(roleId)}`
  ) {
    throw new Error("Live BFF role response path changed");
  }
  if (
    result.status !== 200 ||
    !isLiveRole(result.body) ||
    result.body.id !== roleId ||
    result.body.role !== "admin" ||
    result.body.is_deleted
  ) {
    throw new Error("Live BFF actor does not have the active admin role");
  }
}

export async function signOutLiveAdmin(
  page: Page,
  uiOrigin?: string,
): Promise<void> {
  const expectedOrigin = expectedUiOrigin(page, uiOrigin);
  const logoutResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.origin === expectedOrigin &&
      url.pathname === "/session/logout" &&
      url.search === "" &&
      url.hash === ""
    );
  });
  await page.evaluate(async () => {
    await fetch("/session/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  });
  const response = await logoutResponse;
  assertNoRedirect(response.url(), expectedOrigin);
  if (new URL(response.url()).pathname !== "/session/logout") {
    throw new Error("Live administrator logout response path changed");
  }
  if (!response.ok() && response.status() !== 204) {
    throw new Error("Live administrator browser sign-out failed");
  }
}
