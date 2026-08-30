import { chmod, lstat, mkdir } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  const root = resolve(absolute, "/");
  const components = absolute.slice(root.length).split("/").filter(Boolean);
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        if (process.platform === "darwin" && current === "/var") continue;
        throw new Error(`Live output path may not contain a symlink: ${path}`);
      }
    } catch (error) {
      if (isMissing(error)) break;
      throw error;
    }
  }
}

export function safeResultsRoot(resultsRoot: string): string {
  if (typeof resultsRoot !== "string" || resultsRoot.trim() === "") {
    throw new Error("Live results root must be a non-empty path");
  }
  const root = resolve(resultsRoot);
  assertNoSymlinkComponents(root);
  return root;
}

export function safeRunDirectory(resultsRoot: string, runId: string): string {
  const root = safeResultsRoot(resultsRoot);
  const runDirectory = resolve(root, runId);
  const pathFromRoot = relative(root, runDirectory);
  if (
    pathFromRoot === "" ||
    pathFromRoot.startsWith(`..${isAbsolute(pathFromRoot) ? "/" : ""}`) ||
    pathFromRoot.includes("/")
  ) {
    throw new Error("Live run directory must remain inside the results root");
  }
  assertNoSymlinkComponents(runDirectory);
  return runDirectory;
}

export async function ensurePrivateResultsDirectory(
  resultsRoot: string,
  runId?: string,
): Promise<string> {
  const root = safeResultsRoot(resultsRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  assertNoSymlinkComponents(root);
  if (runId === undefined) return root;

  const runDirectory = safeRunDirectory(root, runId);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await chmod(runDirectory, 0o700);
  assertNoSymlinkComponents(runDirectory);
  return runDirectory;
}

export async function assertSafeOutputFile(filePath: string): Promise<void> {
  const absolute = resolve(filePath);
  assertNoSymlinkComponents(dirname(absolute));
  try {
    if ((await lstat(absolute)).isSymbolicLink()) {
      throw new Error(`Live output file may not be a symlink: ${filePath}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
