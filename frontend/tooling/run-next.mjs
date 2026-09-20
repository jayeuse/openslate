import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

import {
  FRONTEND_ENVIRONMENT_KEYS,
  validatePublicEnvironment,
  validateRuntimeEnvironment,
} from "../src/lib/environment.ts";

const frontendRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(frontendRoot, "..");
const arguments_ = process.argv.slice(2);
const fromProcess = arguments_.includes("--from-process");
if (fromProcess) arguments_.splice(arguments_.indexOf("--from-process"), 1);
const command = arguments_.shift();

if (command !== "dev" && command !== "build")
  throw new Error("Expected next dev or next build");
if (
  arguments_.some(
    (argument) =>
      argument === "-H" ||
      argument === "--hostname" ||
      argument.startsWith("--hostname=") ||
      /^-H\S/.test(argument) ||
      argument === "-p" ||
      argument === "--port" ||
      argument.startsWith("--port=") ||
      /^-p(?:=|\d)/.test(argument),
  )
)
  throw new Error(
    "HOSTNAME and PORT must be supplied through frontend configuration",
  );

function loadProjection() {
  const projection = parseEnv(
    readFileSync(resolve(frontendRoot, ".env.local"), "utf8"),
  );
  validateRuntimeEnvironment(projection);
  validatePublicEnvironment(projection);
  for (const name of FRONTEND_ENVIRONMENT_KEYS)
    process.env[name] = projection[name];
}

if (!fromProcess) {
  const projection = spawnSync(
    "uv",
    [
      "run",
      "--directory",
      resolve(repositoryRoot, "backend"),
      "python",
      resolve(repositoryRoot, "scripts/environment.py"),
      "frontend",
    ],
    { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
  );
  if (projection.status !== 0)
    throw new Error("Frontend environment projection failed");
  loadProjection();
}

validatePublicEnvironment();
const nextArguments = [
  command,
  ...(command === "dev"
    ? ["--hostname", validateRuntimeEnvironment().hostname]
    : []),
  ...arguments_,
];
const next = spawn(
  process.execPath,
  [resolve(frontendRoot, "node_modules/next/dist/bin/next"), ...nextArguments],
  { cwd: frontendRoot, env: process.env, stdio: "inherit" },
);
next.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
