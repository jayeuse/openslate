import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";

export type SmokeRole = "admin" | "manager" | "member" | "guest";

type Identity = Readonly<{ email: string; password: string; name?: string }>;

type SmokeFixture = Readonly<{
  runId: string;
  baseURL: string;
  workspaceName: string;
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
  // The runner keeps passwords out of the file; they arrive in this process's environment.
  const passwords: unknown = JSON.parse(
    process.env.OPENSLATE_SMOKE_PASSWORDS ?? "{}",
  );
  const stored = value.roles as Record<string, unknown> | undefined;
  const roles =
    stored && typeof passwords === "object" && passwords !== null
      ? Object.fromEntries(
          Object.entries(stored).map(([role, identity]) => [
            role,
            typeof identity === "object" && identity !== null
              ? {
                  ...identity,
                  password: (passwords as Record<string, unknown>)[role],
                }
              : identity,
          ]),
        )
      : undefined;
  if (
    value.runId !== runId ||
    typeof value.baseURL !== "string" ||
    typeof value.workspaceName !== "string" ||
    value.workspaceName.trim().length === 0 ||
    !roles ||
    !SMOKE_ROLES.every((role) => isIdentity(roles[role]))
  )
    throw new Error("smoke fixture does not match this run");
  return { ...value, roles } as SmokeFixture;
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
  const fixture = smokeFixture();
  await page.goto(path);
  await expect(
    page.getByRole("link", {
      name: `${fixture.workspaceName} workspace`,
      exact: true,
    }),
  ).toBeVisible();
}

export { base as test, expect };
