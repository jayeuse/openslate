type Environment = Readonly<Record<string, string | undefined>>;

type RuntimeEnvironment = Readonly<{
  port: number;
  hostname: string;
}>;

type PublicEnvironment = Readonly<{
  lifecyclePurgeEnabled: boolean;
}>;

type Rewrite = Readonly<{
  source: string;
  destination: string;
}>;

export const FRONTEND_ENVIRONMENT_KEYS = [
  "BACKEND_URL",
  "PORT",
  "HOSTNAME",
  "NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED",
] as const;

function requiredString(environment: Environment, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} is required`);
  return value;
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

function requiredHttpOrigin(environment: Environment, name: string): string {
  const value = requiredString(environment, name);
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
}

export function developmentApiRewrites(
  environment: Environment = process.env,
): Rewrite[] {
  if (environment.NODE_ENV !== "development") return [];
  const backendOrigin = requiredHttpOrigin(environment, "BACKEND_URL");
  return [
    {
      source: "/api/:path*",
      destination: `${backendOrigin}/api/:path*`,
    },
  ];
}

export function validateRuntimeEnvironment(
  environment: Environment = process.env,
): RuntimeEnvironment {
  return {
    port: requiredPositiveInteger(environment, "PORT", 65_535),
    hostname: requiredString(environment, "HOSTNAME"),
  };
}

export function validatePublicEnvironment(
  environment: Environment = process.env,
): PublicEnvironment {
  return {
    lifecyclePurgeEnabled: requiredBoolean(
      environment,
      "NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED",
    ),
  };
}
