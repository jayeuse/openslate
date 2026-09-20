import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const frontendRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(frontendRoot, "..");
const arguments_ = process.argv.slice(2);
const command = arguments_.shift();

if (command !== "dev" && command !== "build")
  throw new Error("Expected next dev or next build");

const localEnvironmentFiles =
  command === "build"
    ? readdirSync(frontendRoot).filter(
        (name) => name.startsWith(".env") && name !== ".env.example",
      )
    : [];
if (localEnvironmentFiles.length)
  throw new Error(
    `Frontend-local environment files are not supported for production builds: ${localEnvironmentFiles.join(", ")}`,
  );

function hasOption(argumentsToInspect, longOption, shortOption) {
  return argumentsToInspect.some(
    (argument) =>
      argument === longOption ||
      argument.startsWith(`${longOption}=`) ||
      argument === shortOption ||
      argument.startsWith(`${shortOption}=`) ||
      (argument.startsWith(shortOption) &&
        argument.length > shortOption.length),
  );
}

const developmentEnvironment =
  command === "dev" ? loadDevelopmentEnvironment() : {};
const nextNodeArguments =
  command === "dev" && developmentEnvironment.BACKEND_BIND_HOST === "::1"
    ? ["--dns-result-order=ipv6first"]
    : [];

function loadDevelopmentEnvironment() {
  const names = ["FRONTEND_DEV_PORT", "BACKEND_BIND_HOST", "BACKEND_PORT"];
  const configured = readEnvironmentFile();
  const developmentEnvironment = Object.fromEntries(
    names.map((name) => {
      const value =
        process.env[name] ?? resolveEnvironmentValue(name, configured);
      if (name.endsWith("PORT") && !isValidPort(value))
        throw new Error(`${name} must be a valid port number`);
      if (name === "BACKEND_BIND_HOST" && !value)
        throw new Error(
          "BACKEND_BIND_HOST must be configured for Next development",
        );
      return [name, value];
    }),
  );
  const publicOrigin =
    process.env.PUBLIC_ORIGIN ??
    resolveEnvironmentValue("PUBLIC_ORIGIN", configured);

  return {
    ...developmentEnvironment,
    OPENSLATE_DEV_ORIGIN_HOST: developmentOriginHost(publicOrigin),
  };
}

function readEnvironmentFile() {
  const environmentPath = existsSync(resolve(repositoryRoot, ".env"))
    ? resolve(repositoryRoot, ".env")
    : resolve(repositoryRoot, ".env.example");
  return parseEnv(readFileSync(environmentPath, "utf8"));
}

function resolveEnvironmentValue(name, values, chain = []) {
  if (chain.includes(name))
    throw new Error(`Environment reference cycle includes ${name}`);
  const value = values[name];
  if (value === undefined) return undefined;

  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, reference) => {
    const resolved = resolveEnvironmentValue(reference, values, [
      ...chain,
      name,
    ]);
    if (resolved === undefined)
      throw new Error(`${name} references missing ${reference}`);
    return resolved;
  });
}

function developmentOriginHost(value) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be an absolute HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    !origin.hostname ||
    origin.username ||
    origin.password
  )
    throw new Error("PUBLIC_ORIGIN must be an absolute HTTP(S) URL");
  if (!isPermittedDevelopmentHost(origin.hostname))
    throw new Error("PUBLIC_ORIGIN must use a permitted local or LAN hostname");
  return origin.hostname;
}

function isPermittedDevelopmentHost(hostname) {
  if (hostname === "localhost") return true;
  const address = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  const family = isIP(address);
  if (family === 4) return isPermittedIpv4(address);
  if (family === 6) return isPermittedIpv6(address);
  return false;
}

function isPermittedIpv4(address) {
  const [first, second] = address.split(".").map(Number);
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isPermittedIpv6(address) {
  if (address === "::1") return true;
  const firstSegment = address.split(":", 1)[0];
  const first = Number.parseInt(firstSegment, 16);
  return (
    (first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf)
  );
}

function isValidPort(value) {
  return (
    Boolean(value) &&
    /^\d+$/.test(value) &&
    Number(value) >= 1 &&
    Number(value) <= 65_535
  );
}

const nextArguments = [
  command,
  ...(command === "dev"
    ? [
        ...(hasOption(arguments_, "--hostname", "-H")
          ? []
          : ["--hostname", "127.0.0.1"]),
        ...(hasOption(arguments_, "--port", "-p")
          ? []
          : ["--port", developmentEnvironment.FRONTEND_DEV_PORT]),
      ]
    : []),
  ...arguments_,
];
const inheritedEnvironment = { ...process.env };
delete inheritedEnvironment.PUBLIC_ORIGIN;
const next = spawn(
  process.execPath,
  [
    ...nextNodeArguments,
    resolve(frontendRoot, "node_modules/next/dist/bin/next"),
    ...nextArguments,
  ],
  {
    cwd: frontendRoot,
    env: {
      ...inheritedEnvironment,
      ...developmentEnvironment,
      NODE_ENV: command === "dev" ? "development" : "production",
    },
    stdio: "inherit",
  },
);
next.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
