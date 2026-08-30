import { randomBytes, randomUUID } from "node:crypto";
import { chmod, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { validateRuntimeNamespace } from "./catalog";
import { ensurePrivateResultsDirectory, safeResultsRoot } from "./paths";

export type RunId = string & { readonly __runId: unique symbol };

export const LIVE_AUTH_REQUIRED_ENV = [
  "LIVE_BASE_URL",
  "LIVE_API_BASE_URL",
  "BACKEND_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "LIVE_ADMIN_EMAIL",
  "LIVE_ADMIN_PASSWORD",
] as const;

export const LIVE_REQUIRED_ENV = [...LIVE_AUTH_REQUIRED_ENV] as const;

export const LIVE_SEED_REQUIRED_ENV = [
  ...LIVE_REQUIRED_ENV,
  "LIVE_RUN_ID",
] as const;

export const LIVE_TEARDOWN_REQUIRED_ENV = [
  ...LIVE_SEED_REQUIRED_ENV,
  "LIVE_TEARDOWN",
  "LIFECYCLE_PURGE_ENABLED",
] as const;

export const LIVE_TEARDOWN_MODE = "domain-purge" as const;

export type LiveEnvironment = Readonly<{
  uiOrigin: string;
  apiOrigin: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  adminEmail: string;
  adminPassword: string;
  namespace: string;
}>;

export type LiveSeedEnvironment = LiveEnvironment &
  Readonly<{
    runId: RunId;
  }>;

export type LiveTeardownEnvironment = LiveSeedEnvironment &
  Readonly<{
    teardownMode: typeof LIVE_TEARDOWN_MODE;
  }>;

export type EnvironmentValues = Readonly<Record<string, string | undefined>>;

export type LiveHarnessOrigins = Readonly<{
  uiOrigin: string;
  apiOrigin: string;
}>;

export class LivePreflightError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_ORIGIN"
      | "INVALID_RUN_ID"
      | "MISSING_ENV"
      | "LIVE_RUN_LOCKED"
      | "INVALID_ENV",
  ) {
    super(message);
    this.name = "LivePreflightError";
  }
}

function isLoopbackIpv4(hostname: string): boolean {
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255,
    ) &&
    octets[0] === "127"
  );
}

export function validateLoopbackHttpOrigin(value: string): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new LivePreflightError(
      "Live origin must be a trimmed URL",
      "INVALID_ORIGIN",
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LivePreflightError(
      "Live origin must be a valid URL",
      "INVALID_ORIGIN",
    );
  }

  const authority = value.slice("http://".length).split(/[/?#]/, 1)[0] ?? "";
  const explicitPort = authority.match(/:(\d+)$/)?.[1];
  const port = explicitPort ? Number(explicitPort) : 0;
  if (
    url.protocol !== "http:" ||
    !isLoopbackIpv4(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !explicitPort ||
    port < 1 ||
    port > 65535
  ) {
    throw new LivePreflightError(
      "Live origin must be a numeric loopback HTTP origin without credentials, paths, queries, fragments, or redirects",
      "INVALID_ORIGIN",
    );
  }
  return url.origin;
}

export function assertNoRedirect(
  actualUrl: string,
  expectedOrigin: string,
): void {
  const expected = validateLoopbackHttpOrigin(expectedOrigin);
  let actual: URL;
  try {
    actual = new URL(actualUrl);
  } catch {
    throw new LivePreflightError(
      "Live request returned an invalid URL",
      "INVALID_ORIGIN",
    );
  }
  if (actual.origin !== expected) {
    throw new LivePreflightError(
      "Live request redirected away from the validated origin",
      "INVALID_ORIGIN",
    );
  }
}

export function validateRunId(value: string): RunId {
  if (
    !/^run-[a-z0-9][a-z0-9-]{0,94}-[0-9a-f]{32}$/.test(value) ||
    value.length > 128
  ) {
    throw new LivePreflightError(
      "Destructive live run ID must end with a 128-bit lowercase hexadecimal random suffix",
      "INVALID_RUN_ID",
    );
  }
  return value as RunId;
}

export function runtimeNamespaceForRunId(runId: string): string {
  const validatedRunId = validateRunId(runId);
  return validateRuntimeNamespace(`live-${validatedRunId.slice(-24)}`);
}

export function createRunId(now = new Date()): RunId {
  const timestamp = now
    .toISOString()
    .replace(/[-:.]/g, "")
    .replace("T", "t")
    .replace("Z", "z");
  return validateRunId(`run-${timestamp}-${randomBytes(16).toString("hex")}`);
}

export function validateRequiredEnv(
  env: EnvironmentValues = process.env,
  required: readonly string[] = LIVE_REQUIRED_ENV,
): Record<string, string> {
  const missing = required.filter((key) => {
    const value = env[key];
    return value === undefined || value.trim() === "";
  });
  if (missing.length > 0) {
    throw new LivePreflightError(
      `Missing required live environment variables: ${missing.join(", ")}`,
      "MISSING_ENV",
    );
  }

  return Object.fromEntries(required.map((key) => [key, env[key] as string]));
}

export function hasRequiredEnvironment(
  env: EnvironmentValues = process.env,
  required: readonly string[] = LIVE_REQUIRED_ENV,
): boolean {
  return required.every((key) => {
    const value = env[key];
    return value !== undefined && value.trim() !== "";
  });
}

export function getLiveHarnessOrigins(
  env: EnvironmentValues = process.env,
): LiveHarnessOrigins {
  const configured = [
    env.LIVE_BASE_URL,
    env.LIVE_API_BASE_URL,
    env.BACKEND_URL,
  ];
  if (configured.every((value) => value === undefined || value.trim() === "")) {
    return {
      uiOrigin: "http://127.0.0.1:3000",
      apiOrigin: "http://127.0.0.1:8000",
    };
  }
  if (configured.some((value) => value === undefined || value.trim() === "")) {
    throw new LivePreflightError(
      "Live harness requires LIVE_BASE_URL, LIVE_API_BASE_URL, and BACKEND_URL together",
      "MISSING_ENV",
    );
  }
  const uiOrigin = validateLoopbackHttpOrigin(env.LIVE_BASE_URL as string);
  const apiOrigin = validateLoopbackHttpOrigin(env.LIVE_API_BASE_URL as string);
  const backendOrigin = validateLoopbackHttpOrigin(env.BACKEND_URL as string);
  if (backendOrigin !== apiOrigin) {
    throw new LivePreflightError(
      "BACKEND_URL must exactly equal LIVE_API_BASE_URL",
      "INVALID_ENV",
    );
  }
  return { uiOrigin, apiOrigin };
}

export function hasLiveSeedEnvironment(
  env: EnvironmentValues = process.env,
): boolean {
  return hasRequiredEnvironment(
    normalizedEnvironmentValues(env),
    LIVE_SEED_REQUIRED_ENV,
  );
}

export function hasLiveTeardownEnvironment(
  env: EnvironmentValues = process.env,
): boolean {
  return hasRequiredEnvironment(
    normalizedEnvironmentValues(env),
    LIVE_TEARDOWN_REQUIRED_ENV,
  );
}

export function teardownModeFromEnvironment(
  env: EnvironmentValues = process.env,
): typeof LIVE_TEARDOWN_MODE {
  if (env.LIVE_TEARDOWN !== LIVE_TEARDOWN_MODE) {
    throw new LivePreflightError(
      `LIVE_TEARDOWN must be ${LIVE_TEARDOWN_MODE}`,
      "INVALID_ENV",
    );
  }
  return LIVE_TEARDOWN_MODE;
}

export const PUBLISHABLE_KEY_ENV_NAME =
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" as const;
export const PUBLISHABLE_KEY_ENV_NAMES = [
  PUBLISHABLE_KEY_ENV_NAME,
  "SUPABASE_PUBLISHABLE_KEY",
] as const;

export function validatePublishableKeyEnvName(name: string): string {
  if (
    !(PUBLISHABLE_KEY_ENV_NAMES as readonly string[]).includes(name) ||
    /(?:secret|service[_-]?role)/i.test(name)
  ) {
    throw new LivePreflightError(
      "Live auth requires the publishable Supabase key environment name",
      "INVALID_ENV",
    );
  }
  return name;
}

function decodeLegacyJwtPart(value: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function validatePublishableKey(value: string): string {
  const modern = /^sb_publishable_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
  const segments = value.split(".");
  const header =
    segments.length === 3 ? decodeLegacyJwtPart(segments[0] ?? "") : null;
  const payload =
    segments.length === 3 ? decodeLegacyJwtPart(segments[1] ?? "") : null;
  const signature = segments.length === 3 ? segments[2] : undefined;
  const legacy =
    header !== null &&
    payload !== null &&
    typeof signature === "string" &&
    /^[A-Za-z0-9_-]+$/.test(signature) &&
    header.alg === "HS256" &&
    header.typ === "JWT" &&
    Object.keys(header).sort().join(",") === "alg,typ" &&
    payload.role === "anon";

  if (value.trim() !== value || (!modern && !legacy)) {
    throw new LivePreflightError(
      "Live auth requires a publishable Supabase key",
      "INVALID_ENV",
    );
  }
  return value;
}

function normalizedEnvironmentValues(
  env: EnvironmentValues,
): EnvironmentValues {
  return {
    ...env,
    NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_PUBLISHABLE_KEY,
  };
}

export function getLiveEnvironment(
  env: EnvironmentValues = process.env,
  namespace = "live",
): LiveEnvironment {
  const values = validateRequiredEnv(normalizedEnvironmentValues(env));
  validatePublishableKeyEnvName(PUBLISHABLE_KEY_ENV_NAME);
  const adminEmail = values.LIVE_ADMIN_EMAIL;
  const adminPassword = values.LIVE_ADMIN_PASSWORD;
  if (!adminEmail.includes("@") || adminPassword.length < 12) {
    throw new LivePreflightError(
      "Live administrator environment is invalid",
      "INVALID_ENV",
    );
  }
  const uiOrigin = validateLoopbackHttpOrigin(values.LIVE_BASE_URL);
  const apiOrigin = validateLoopbackHttpOrigin(values.LIVE_API_BASE_URL);
  const backendOrigin = validateLoopbackHttpOrigin(values.BACKEND_URL);
  if (backendOrigin !== apiOrigin) {
    throw new LivePreflightError(
      "BACKEND_URL must exactly equal LIVE_API_BASE_URL",
      "INVALID_ENV",
    );
  }
  const supabaseUrl = validateLoopbackHttpOrigin(
    values.NEXT_PUBLIC_SUPABASE_URL,
  );
  return {
    uiOrigin,
    apiOrigin,
    supabaseUrl,
    supabasePublishableKey: validatePublishableKey(
      values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ),
    adminEmail,
    adminPassword,
    namespace: validateRuntimeNamespace(namespace),
  };
}

export function getLiveSeedEnvironment(
  env: EnvironmentValues = process.env,
): LiveSeedEnvironment {
  const values = validateRequiredEnv(
    normalizedEnvironmentValues(env),
    LIVE_SEED_REQUIRED_ENV,
  );
  const runId = validateRunId(values.LIVE_RUN_ID);
  return {
    ...getLiveEnvironment(env, runtimeNamespaceForRunId(runId)),
    runId,
  };
}

export function getLiveTeardownEnvironment(
  env: EnvironmentValues = process.env,
): LiveTeardownEnvironment {
  const values = validateRequiredEnv(
    normalizedEnvironmentValues(env),
    LIVE_TEARDOWN_REQUIRED_ENV,
  );
  const teardownMode = teardownModeFromEnvironment(values);
  if (values.LIFECYCLE_PURGE_ENABLED !== "true") {
    throw new LivePreflightError(
      "LIFECYCLE_PURGE_ENABLED must already be true; teardown will not enable purge",
      "INVALID_ENV",
    );
  }
  const runId = validateRunId(values.LIVE_RUN_ID);
  return {
    ...getLiveEnvironment(env, runtimeNamespaceForRunId(runId)),
    runId,
    teardownMode,
  };
}

export type LiveLock = Readonly<{
  path: string;
  runId: RunId;
  release: () => Promise<void>;
}>;

type LockMarker = Readonly<{ token: string; run_id: RunId; pid: number }>;

export async function acquireLiveLock(
  runId: string,
  resultsRoot = "test-results/live",
): Promise<LiveLock> {
  const validatedRunId = validateRunId(runId);
  const root = safeResultsRoot(resultsRoot);
  await ensurePrivateResultsDirectory(root);
  const lockPath = join(root, ".lock");
  const marker: LockMarker = {
    token: randomUUID(),
    run_id: validatedRunId,
    pid: process.pid,
  };

  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LivePreflightError(
        "A live run is already running",
        "LIVE_RUN_LOCKED",
      );
    }
    throw error;
  }

  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await chmod(lockPath, 0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    path: lockPath,
    runId: validatedRunId,
    release: async () => {
      if (released) return;
      released = true;
      let current: unknown;
      try {
        current = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        return;
      }
      if (
        typeof current === "object" &&
        current !== null &&
        "token" in current &&
        current.token === marker.token
      ) {
        await unlink(lockPath).catch(() => undefined);
      }
    },
  };
}
