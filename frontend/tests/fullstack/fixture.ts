import { readFileSync, statSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";

const Identity = z.object({
  email: z.string().email(),
  password: z.string(),
  id: z.uuid(),
});
const Fixture = z.object({
  runId: z.string(),
  baseURL: z.literal("http://localhost:3008"),
  authURL: z.literal("http://127.0.0.1:55321"),
  mailURL: z.literal("http://127.0.0.1:55324"),
  admin: Identity,
  member: Identity,
});
const fixturePath = process.env.OPENSLATE_FULLSTACK_FIXTURE!;
if ((statSync(fixturePath).mode & 0o077) !== 0)
  throw new Error("Fixture must be private");
export const fixture = Fixture.parse(
  JSON.parse(readFileSync(fixturePath, "utf8")),
);
if (fixture.runId !== process.env.OPENSLATE_FULLSTACK_RUN_ID)
  throw new Error("Wrong test namespace");

export async function signIn(page: Page, identity: z.infer<typeof Identity>) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(identity.email);
  await page.getByLabel("Password", { exact: true }).fill(identity.password);
  const signedIn = page.waitForResponse((r) =>
    r.url().endsWith("/session/login"),
  );
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  expect((await signedIn).status()).toBe(200);
}
