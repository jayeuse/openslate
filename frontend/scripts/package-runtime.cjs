/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI executed directly by Node and from container exports. */

const { spawnSync } = require("node:child_process");
const {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readdirSync,
  rmSync,
  statSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

function requirePath(path, label) {
  if (!existsSync(path)) throw new Error(`Missing ${label}: ${path}`);
}

function copyDirectory(source, destination) {
  requirePath(source, "runtime directory");
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function rejectSymbolicLinks(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const candidate = join(path, entry.name);
    if (lstatSync(candidate).isSymbolicLink())
      throw new Error(`Runtime contains a symbolic link: ${candidate}`);
    if (entry.isDirectory()) rejectSymbolicLinks(candidate);
  }
}

function stageRuntime({ mode, source, staging }) {
  if (!["native", "container"].includes(mode))
    throw new Error("Runtime mode must be native or container");
  const sourceRoot = resolve(source);
  const stagingRoot = resolve(staging);
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });

  if (mode === "native") {
    requirePath(
      join(sourceRoot, ".next/standalone/server.js"),
      "standalone server",
    );
    copyDirectory(
      join(sourceRoot, ".next/standalone"),
      join(stagingRoot, ".next/standalone"),
    );
  } else {
    requirePath(join(sourceRoot, "server.js"), "container standalone server");
    copyDirectory(sourceRoot, join(stagingRoot, ".next/standalone"));
    rmSync(join(stagingRoot, ".next/standalone/.next/static"), {
      recursive: true,
      force: true,
    });
    rmSync(join(stagingRoot, ".next/standalone/public"), {
      recursive: true,
      force: true,
    });
  }

  copyDirectory(
    join(sourceRoot, ".next/static"),
    join(stagingRoot, ".next/static"),
  );
  const publicDirectory = join(sourceRoot, "public");
  if (existsSync(publicDirectory))
    copyDirectory(publicDirectory, join(stagingRoot, "public"));
  rejectSymbolicLinks(stagingRoot);
}

function packageRuntime({
  mode,
  source,
  output,
  maxBytes = DEFAULT_MAX_BYTES,
}) {
  const staging = mkdtempSync(join(tmpdir(), "openslate-runtime-package-"));
  const destination = resolve(output);
  try {
    stageRuntime({ mode, source, staging });
    mkdirSync(dirname(destination), { recursive: true });
    const archive = spawnSync(
      "tar",
      ["-czf", destination, "-C", staging, "."],
      { stdio: "inherit" },
    );
    if (archive.status !== 0)
      throw new Error(`Runtime archive failed (${archive.status ?? "signal"})`);
    const bytes = statSync(destination).size;
    if (bytes > maxBytes)
      throw new Error(
        `Runtime artifact is ${bytes} bytes; maximum is ${maxBytes} bytes`,
      );
    return { bytes, output: destination };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function parseArguments(argumentsList) {
  const options = { maxBytes: DEFAULT_MAX_BYTES };
  for (const argument of argumentsList) {
    const [name, value] = argument.split("=", 2);
    if (!value) throw new Error(`Expected --name=value: ${argument}`);
    if (name === "--mode") options.mode = value;
    else if (name === "--source") options.source = value;
    else if (name === "--output") options.output = value;
    else if (name === "--max-bytes") options.maxBytes = Number(value);
    else throw new Error(`Unknown runtime package option: ${name}`);
  }
  if (!options.mode || !options.source || !options.output)
    throw new Error("--mode, --source, and --output are required");
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
    throw new Error("--max-bytes must be a positive integer");
  return options;
}

module.exports = { packageRuntime, parseArguments, stageRuntime };

if (require.main === module) {
  try {
    const result = packageRuntime(parseArguments(process.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
