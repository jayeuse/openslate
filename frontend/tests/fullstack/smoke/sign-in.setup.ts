import { chromium, expect, type FullConfig } from "@playwright/test";
import { SMOKE_ROLES, smokeFixture, stateFile } from "./smoke-fixture";

/** Sign in once per role and save the session; every smoke test reuses it. */
export default async function signIn(config: FullConfig) {
  const fixture = smokeFixture();
  const baseURL = config.projects[0]?.use.baseURL ?? fixture.baseURL;
  const browser = await chromium.launch();
  try {
    for (const role of SMOKE_ROLES) {
      const identity = fixture.roles[role];
      const context = await browser.newContext({
        baseURL,
        ignoreHTTPSErrors: true,
      });
      const page = await context.newPage();
      await page.goto("/login");
      await page.getByLabel("Email", { exact: true }).fill(identity.email);
      await page.getByLabel("Password").fill(identity.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(
        page.getByRole("link", {
          name: `${fixture.workspaceName} workspace`,
          exact: true,
        }),
      ).toBeVisible();
      await context.storageState({ path: stateFile(role) });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
