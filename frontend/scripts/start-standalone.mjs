import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const standalone = resolve(root, ".next/standalone");
const staticSource = resolve(root, ".next/static");
const staticDestination = resolve(standalone, ".next/static");

mkdirSync(dirname(staticDestination), { recursive: true });
cpSync(staticSource, staticDestination, { recursive: true });

const publicSource = resolve(root, "public");
if (existsSync(publicSource)) {
  cpSync(publicSource, resolve(standalone, "public"), { recursive: true });
}

process.env.LOG_DIR = resolve(root, process.env.LOG_DIR || "logs");
process.chdir(standalone);
await import(pathToFileURL(resolve(standalone, "server.js")).href);
