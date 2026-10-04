import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";

export type SmokeRole = "admin" | "manager" | "member" | "guest";

type Identity = Readonly<{ email: string; password: string; name?: string }>;

type SmokeFixture = Readonly<{
  runId: string;
  baseURL: string;
  roles: Readonly<Record<SmokeRole, Identity>>;
}>;

export const SMOKE_ROLES: readonly SmokeRole[] = [
  "admin",
  "manager",
  "member",
  "guest",
];

function isIdentity(value: unknown): value is Identity {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).email === "string" &&
    typeof (value as Record<string, unknown>).password === "string"
  );
}

/** The private fixture the smoke runner writes after seeding Harbor Small. */
export function smokeFixture(): SmokeFixture {
  const location = process.env.OPENSLATE_FULLSTACK_FIXTURE;
  const runId = process.env.OPENSLATE_FULLSTACK_RUN_ID;
  if (!location || !runId) throw new Error("smoke fixture is unavailable");
  const parsed: unknown = JSON.parse(readFileSync(location, "utf8"));
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("smoke fixture is malformed");
  const value = parsed as Record<string, unknown>;
  const roles = value.roles as Record<string, unknown> | undefined;
  if (
    value.runId !== runId ||
    typeof value.baseURL !== "string" ||
    !roles ||
    !SMOKE_ROLES.every((role) => isIdentity(roles[role]))
  )
    throw new Error("smoke fixture does not match this run");
  return parsed as SmokeFixture;
}

/** The signed-in browser state saved once per role by sign-in.setup.ts. */
export function stateFile(role: SmokeRole): string {
  const directory = process.env.OPENSLATE_SMOKE_STATE_DIR;
  if (!directory) throw new Error("OPENSLATE_SMOKE_STATE_DIR is required");
  return join(directory, `${role}.json`);
}

/** Use a role's saved session for every test in the calling file. */
export function asRole(role: SmokeRole) {
  base.use({ storageState: stateFile(role) });
}

export async function openWorkspace(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByLabel("OpenSlate workspace")).toBeVisible();
}

export { base as test, expect };
