import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

import {
  FRONTEND_ENVIRONMENT_KEYS,
  validatePublicEnvironment,
  validateRuntimeEnvironment,
} from "../src/lib/environment.ts";

const frontendRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(frontendRoot, "..");
const fromProcess = process.argv.slice(2).join(" ") === "--from-process";

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

validateRuntimeEnvironment();
validatePublicEnvironment();
const standalone = existsSync(
  resolve(frontendRoot, ".next/standalone/server.js"),
)
  ? resolve(frontendRoot, ".next/standalone")
  : frontendRoot;
const staticSource = resolve(frontendRoot, ".next/static");
const staticDestination = resolve(standalone, ".next/static");

if (staticSource !== staticDestination) {
  mkdirSync(dirname(staticDestination), { recursive: true });
  cpSync(staticSource, staticDestination, { recursive: true });
}

const publicSource = resolve(frontendRoot, "public");
if (standalone !== frontendRoot && existsSync(publicSource))
  cpSync(publicSource, resolve(standalone, "public"), { recursive: true });

process.chdir(standalone);
await import(pathToFileURL(resolve(standalone, "server.js")).href);
