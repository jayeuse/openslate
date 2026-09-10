type Environment = Readonly<Record<string, string | undefined>>;

type RuntimeEnvironment = Readonly<{
  backendUrl: string;
  supabaseServerUrl: string;
  logDir: string;
  requestBodyLimitBytes: number;
  responseBodyLimitBytes: number;
  requestDeadlineMilliseconds: number;
  port: number;
  hostname: string;
}>;

type PublicEnvironment = Readonly<{
  supabaseUrl: string;
  supabasePublishableKey: string;
  lifecyclePurgeEnabled: boolean;
}>;

export const FRONTEND_ENVIRONMENT_KEYS = [
  "BACKEND_URL",
  "SUPABASE_SERVER_URL",
  "LOG_DIR",
  "BFF_REQUEST_BODY_LIMIT_BYTES",
  "BFF_RESPONSE_BODY_LIMIT_BYTES",
  "BFF_REQUEST_DEADLINE_MS",
  "PORT",
  "HOSTNAME",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED",
] as const;

function requiredString(environment: Environment, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} is required`);
  return value;
}

function requiredHttpUrl(environment: Environment, name: string): string {
  const value = requiredString(environment, name);
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin`);
  }
}

function requiredPositiveInteger(
  environment: Environment,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = requiredString(environment, name);
  if (!/^\d+$/.test(value))
    throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function requiredBoolean(environment: Environment, name: string): boolean {
  const value = requiredString(environment, name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function requiredAbsolutePath(environment: Environment, name: string): string {
  const value = requiredString(environment, name);
  if (!value.startsWith("/"))
    throw new Error(`${name} must be an absolute path`);
  return value;
}

export function validateRuntimeEnvironment(
  environment: Environment = process.env,
): RuntimeEnvironment {
  return {
    backendUrl: requiredHttpUrl(environment, "BACKEND_URL"),
    supabaseServerUrl: requiredHttpUrl(environment, "SUPABASE_SERVER_URL"),
    logDir: requiredAbsolutePath(environment, "LOG_DIR"),
    requestBodyLimitBytes: requiredPositiveInteger(
      environment,
      "BFF_REQUEST_BODY_LIMIT_BYTES",
    ),
    responseBodyLimitBytes: requiredPositiveInteger(
      environment,
      "BFF_RESPONSE_BODY_LIMIT_BYTES",
    ),
    requestDeadlineMilliseconds: requiredPositiveInteger(
      environment,
      "BFF_REQUEST_DEADLINE_MS",
    ),
    port: requiredPositiveInteger(environment, "PORT", 65_535),
    hostname: requiredString(environment, "HOSTNAME"),
  };
}

export function validatePublicEnvironment(
  environment: Environment = process.env,
): PublicEnvironment {
  return {
    supabaseUrl: requiredHttpUrl(environment, "NEXT_PUBLIC_SUPABASE_URL"),
    supabasePublishableKey: requiredString(
      environment,
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    ),
    lifecyclePurgeEnabled: requiredBoolean(
      environment,
      "NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED",
    ),
  };
}

// Keep direct references so Next can inline these public values for browser code.
export function currentPublicEnvironment(): PublicEnvironment {
  return validatePublicEnvironment({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED:
      process.env.NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED,
  });
}

export function requiredLogDirectory(environment: Environment = process.env) {
  return requiredAbsolutePath(environment, "LOG_DIR");
}
