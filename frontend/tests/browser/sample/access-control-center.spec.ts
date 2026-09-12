import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "../coverage";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";
import { createCommsConfiguration } from "../../../src/components/sample/comms/configuration";

const views = [
  ["overview", "Access overview"],
  ["identities", "Identity directory"],
  ["roles", "Roles"],
  ["groups", "Groups & departments"],
  ["rules", "Access rules"],
  ["simulator", "Access simulator"],
  ["reviews", "Access reviews"],
] as const;

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: { detail: "Unavailable" } }),
  );
  await page.route("**/bff/**", async (route) => {
    if (!(await fulfillWorkspaceRequest(route)))
      await route.fulfill({ json: { items: [], has_more: false } });
  });
});

async function selectView(page: Page, id: string, label: string) {
  if ((page.viewportSize()?.width ?? 0) < 1024)
    await page.getByLabel("Access view", { exact: true }).selectOption(id);
  else await page.getByRole("tab", { name: label, exact: true }).click();
}

async function expectNoAxeViolations(page: Page, include: string = "main") {
  const result = await new AxeBuilder({ page })
    .include(include)
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
}

function recordServiceMutations(page: Page): string[] {
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (/\/bff\/|\/session\//.test(request.url()) && request.method() !== "GET")
      mutations.push(`${request.method()} ${request.url()}`);
  });
  return mutations;
}

async function addIdentity(
  page: Page,
  kind: "internal" | "guest" | "service",
  name: string,
) {
  await page.getByRole("button", { name: "Add identity", exact: true }).click();
  await page
    .getByRole("menuitem", {
      name:
        kind === "internal"
          ? "Internal identity"
          : kind === "guest"
            ? "Guest identity"
            : "Service metadata",
      exact: true,
    })
    .click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Name", { exact: true }).fill(name);
  if (kind !== "service")
    await sheet
      .getByLabel("Email", { exact: true })
      .fill(`${name.toLowerCase().replaceAll(" ", ".")}@example.test`);
  if (kind === "internal")
    await sheet
      .getByLabel("Access expires (optional)", { exact: true })
      .fill("2027-12-31T12:00");
  if (kind === "guest") {
    await sheet
      .getByLabel("Sponsor", { exact: true })
      .selectOption({ index: 1 });
    await sheet
      .getByLabel("Access expires", { exact: true })
      .fill("2027-12-31T12:00");
  }
  if (kind === "service") {
    await sheet.getByLabel("Owner", { exact: true }).selectOption({ index: 1 });
    await sheet
      .getByLabel("Purpose", { exact: true })
      .fill("Acceptance reporting");
    await sheet
      .getByLabel("Access expires", { exact: true })
      .fill("2027-12-31T12:00");
  }
  await sheet
    .getByRole("button", { name: "Add identity", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Review identity changes" })
    .getByRole("button", { name: "Create identity", exact: true })
    .click();
  const search = page.getByLabel("Search identities", { exact: true });
  await search.fill(name);
  await expect(
    page.getByRole("button", { name: `Manage ${name}`, exact: true }),
  ).toBeVisible();
  await search.fill("");
}

test("seven URL-addressable views stay viewport-contained and omit placeholder copy", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.goto("/access?view=overview");
  await expect(
    page.getByRole("heading", { name: "Access", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Local sample access center", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Quick actions", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /Manage security/ }),
  ).toHaveAttribute("href", "/manage?view=security");
  await page.screenshot({
    path: `/tmp/access-control-center-${testInfo.project.name}.png`,
    fullPage: true,
  });

  for (const [id, heading] of views) {
    await selectView(
      page,
      id,
      id === "rules"
        ? "Access rules"
        : heading
            .replace("Identity directory", "Identities")
            .replace("Groups & departments", "Groups")
            .replace("Access simulator", "Simulator")
            .replace("Access reviews", "Reviews")
            .replace("Access overview", "Overview"),
    );
    await expect(page).toHaveURL(new RegExp(`/access\\?view=${id}$`));
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    await expect(page.locator("body")).not.toContainText(/\bsample\b/i);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollHeight <= window.innerHeight + 1,
        ),
      )
      .toBe(true);
    if ((page.viewportSize()?.width ?? 0) >= 1024) {
      await expect
        .poll(() =>
          page.evaluate(() => {
            const panel =
              document.querySelector<HTMLElement>('[role="tabpanel"]');
            return Boolean(
              panel && panel.scrollHeight <= panel.clientHeight + 1,
            );
          }),
        )
        .toBe(true);
    }
  }
  await selectView(page, "rules", "Access rules");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    )
    .toBe(true);
});

test("identity filters share one surface and pagination changes visible identities", async ({
  page,
}) => {
  await page.goto("/access?view=identities");

  await expect(
    page.getByText("Service identities are metadata only", { exact: true }),
  ).toHaveCount(0);
  const filters = page.getByRole("search", { name: "Identity filters" });
  await expect(filters).toHaveCount(1);
  await expect(filters.getByLabel("Search identities")).toBeVisible();
  await expect(
    filters.getByText("Advanced filters", { exact: true }),
  ).toBeVisible();

  await expect(page.getByLabel(/Page 1 of \d+/)).toBeVisible();
  const firstIdentity = page.getByRole("button", { name: /^Manage / }).first();
  const firstName = await firstIdentity.getAttribute("aria-label");
  await page.getByLabel("Go to next page", { exact: true }).click();
  await expect(page.getByLabel(/Page 2 of \d+/)).toBeVisible();
  await expect(firstIdentity).not.toHaveAttribute(
    "aria-label",
    firstName ?? "",
  );

  await filters.getByLabel("Rows per page", { exact: true }).selectOption("3");
  await expect(page.getByLabel(/Page 1 of \d+/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Manage / })).toHaveCount(3);
});

test("valid and invalid view parameters preserve only valid identity deep links", async ({
  page,
}) => {
  await page.goto("/access?view=roles&user=sample-person-morgan-kim");
  await expect(
    page.getByRole("heading", { name: "Roles", exact: true }),
  ).toBeVisible();
  await selectView(page, "identities", "Identities");
  await expect(page).toHaveURL(/view=identities&user=sample-person-morgan-kim/);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await selectView(page, "roles", "Roles");
  await expect(page).toHaveURL(/\/access\?view=roles$/);

  await page.goto("/access?view=unknown&user=not-a-sample-identity");
  await expect(
    page.getByRole("heading", { name: "Access overview" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/access\?view=unknown$/);
});

test("core governance surfaces expose safeguards and an accessible simulator trace", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("openslate-theme", "dark"),
  );
  await page.goto("/access?view=roles");
  await expect(
    page.getByText("Built-in roles cannot be changed or deleted."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create role", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Compare/ })).toBeDisabled();

  await selectView(page, "groups", "Groups");
  await expect(page.getByText(/non-nested manual groups/)).toBeVisible();
  await page
    .getByRole("tab", { name: "Organization chart", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Department organization chart" }),
  ).toBeVisible();

  await selectView(page, "rules", "Access rules");
  await expect(
    page.getByText(/Changes remain staged until you review their impact/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review impact", exact: true }),
  ).toBeDisabled();

  await selectView(page, "simulator", "Simulator");
  await page
    .getByRole("button", { name: "Evaluate access", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Simulator result" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Evaluation trace" }),
  ).toBeVisible();
  const accessibility = await new AxeBuilder({ page })
    .include("main")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await selectView(page, "reviews", "Reviews");
  const complete = page
    .getByRole("button", { name: "Complete campaign", exact: true })
    .first();
  if (await complete.count()) await expect(complete).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "Governance", exact: true }),
  ).toBeVisible();
});

test("identity and portability boundaries exclude secret material", async ({
  page,
}) => {
  const mutations = recordServiceMutations(page);
  await page.goto("/access?view=identities");
  await expect(
    page.getByRole("button", { name: "Add identity", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add identity", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Service metadata", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Metadata only. Credentials are never displayed or generated.",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel" })
    .click();

  await selectView(page, "reviews", "Reviews");
  await page
    .getByRole("button", { name: "Review export", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    /Identity names[\s\S]*excluded/,
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download/ }).click();
  const download = await downloadPromise;
  const content = await (
    await import("node:fs/promises")
  ).readFile(await download.path(), "utf8");
  expect(content).not.toMatch(/token|secret|credential|morgan kim|@/i);
  const storage = await page.evaluate(
    () => sessionStorage.getItem("openslate.sample.v1") ?? "",
  );
  expect(storage).not.toMatch(
    /access[_-]?token|refresh[_-]?token|client[_-]?secret/i,
  );
  await expect(page.locator("body")).not.toContainText(
    /Bearer\s+[A-Za-z0-9._-]+/,
  );
  expect(mutations).toEqual([]);
});

test("identity creation, invitation, lifecycle, session, and reviewed bulk changes remain guarded", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const mutations = recordServiceMutations(page);
  test.skip(
    (page.viewportSize()?.width ?? 0) < 1024,
    "Dense directory workflow is covered on desktop",
  );
  await page.goto("/access?view=identities");
  await page.getByRole("button", { name: "Add identity", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Internal identity", exact: true })
    .click();
  await expectNoAxeViolations(page, '[role="dialog"]');
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await addIdentity(page, "internal", "Avery Internal");
  await addIdentity(page, "guest", "Bailey Guest");
  await addIdentity(page, "service", "Casey Service");

  await page.getByRole("button", { name: "Manage Bailey Guest" }).click();
  await page
    .getByRole("button", { name: "Resend invitation", exact: true })
    .click();
  await expect(page.getByText(/Resent 1 time/)).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  const identitySearch = page.getByLabel("Search identities", { exact: true });
  await identitySearch.fill("Eli Cruz");
  await page.getByRole("button", { name: "Manage Eli Cruz" }).click();
  await page
    .getByRole("button", {
      name: "Revoke Mobile · Chrome · Quezon City",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", { name: "Review lifecycle impact" })
    .getByRole("button", { name: "Confirm session revocation" })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Revoke Mobile · Chrome · Quezon City",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Disable identity", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Review lifecycle impact" })
    .getByRole("button", { name: "Continue to name confirmation" })
    .click();
  const confirmation = page.getByRole("dialog", { name: "Disable identity?" });
  await confirmation
    .getByLabel("Identity name", { exact: true })
    .fill("Eli Cruz");
  await confirmation
    .getByRole("button", { name: "Disable identity", exact: true })
    .click();
  await identitySearch.fill("");

  await page
    .getByRole("checkbox", { name: "Select Avery Internal", exact: true })
    .first()
    .check();
  await page
    .getByRole("checkbox", { name: "Select Bailey Guest", exact: true })
    .first()
    .check();
  await page
    .getByRole("button", { name: "Review bulk action", exact: true })
    .click();
  const bulk = page.getByRole("alertdialog", {
    name: "Review bulk identity update",
  });
  await bulk.getByLabel("Action", { exact: true }).selectOption("add-group");
  await expect(bulk.getByText("Impact ready", { exact: true })).toBeVisible();
  await bulk.getByRole("button", { name: "Apply to 2", exact: true }).click();
  expect(mutations).toEqual([]);
});

test("role templates, comparison, protected built-ins, and non-nested groups are reviewable", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const mutations = recordServiceMutations(page);
  test.skip(
    (page.viewportSize()?.width ?? 0) < 1024,
    "Dense tables are covered on desktop",
  );
  await page.goto("/access?view=roles");
  await page.getByRole("button", { name: "Create role", exact: true }).click();
  await page.getByRole("button", { name: /^Viewer/ }).click();
  await page.getByLabel("Role name", { exact: true }).fill("Acceptance viewer");
  await page.getByRole("button", { name: "Save role", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "Apply role changes?" })
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(
    page.getByLabel("Compare Acceptance viewer", { exact: true }).first(),
  ).toBeVisible();
  await page.getByLabel("Compare Member", { exact: true }).first().check();
  await page
    .getByLabel("Compare Acceptance viewer", { exact: true })
    .first()
    .check();
  await page.getByRole("button", { name: "Compare 2", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Compare roles" }),
  ).toContainText("Acceptance viewer");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: /^Administrator Built-in/ }).click();
  await expect(
    page.getByText("Protected baseline", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save role" })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await selectView(page, "groups", "Groups");
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  const group = page.getByRole("dialog");
  await group
    .getByLabel("Group name", { exact: true })
    .fill("Acceptance group");
  await expect(group).toContainText("Service identities cannot join groups.");
  await expect(group.getByText(/reporting service/i)).toHaveCount(0);
  await group.getByRole("checkbox", { name: /Morgan Kim/ }).check();
  await group.getByRole("button", { name: "Save group", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "Apply group changes?" })
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /^Acceptance group/ }).first(),
  ).toBeVisible();
  expect(mutations).toEqual([]);
});

test("multiple staged rules persist and simulator proves explicit allow and deny traces", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const mutations = recordServiceMutations(page);
  test.skip(
    (page.viewportSize()?.width ?? 0) < 1024,
    "Dense rule table is covered on desktop",
  );
  await page.goto("/access?view=rules");
  await page.getByLabel("Subject type", { exact: true }).selectOption("role");
  await page
    .getByLabel("Subject", { exact: true })
    .selectOption("sample-member");
  await page.getByLabel("Search permissions").fill("records");
  const decisions = page.getByRole("group", { name: /decision$/ });
  await decisions.nth(0).getByRole("button", { name: "Deny" }).click();
  await page.getByRole("button", { name: "Page 3", exact: true }).click();
  await decisions.nth(0).getByRole("button", { name: "Allow" }).click();
  await expect(
    page.getByText("2 staged changes", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review impact", exact: true })
    .click();
  await expectNoAxeViolations(page, '[role="dialog"]');
  await expect(
    page.getByRole("dialog", { name: "Review policy impact" }),
  ).toContainText("Draft:");
  await page
    .getByRole("button", { name: "Apply 2 draft choices", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm and apply", exact: true })
    .click();
  await page.reload();
  await page.getByLabel("Subject type", { exact: true }).selectOption("role");
  await page
    .getByLabel("Subject", { exact: true })
    .selectOption("sample-member");
  await page.getByLabel("Search permissions").fill("records");
  await expect(
    page
      .getByRole("group", { name: /decision$/ })
      .nth(0)
      .getByRole("button", { name: "Deny" }),
  ).toHaveAttribute("aria-pressed", "true");

  await selectView(page, "simulator", "Simulator");
  await page
    .getByLabel("Identity", { exact: true })
    .selectOption({ label: "Morgan Kim · internal" });
  await page
    .getByLabel("Resource", { exact: true })
    .selectOption({ label: "Workspace · workspace" });
  await page
    .getByLabel("Action", { exact: true })
    .selectOption({ label: "Read records" });
  await page
    .getByRole("button", { name: "Evaluate access", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Simulator result" }),
  ).toContainText(/allow/i);
  await page
    .getByLabel("Action", { exact: true })
    .selectOption({ label: "Create records" });
  await page
    .getByRole("button", { name: "Evaluate access", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Simulator result" }),
  ).toContainText(/deny/i);
  await expect(
    page.getByRole("region", { name: "Evaluation trace" }),
  ).toBeVisible();
  expect(mutations).toEqual([]);
});

test("simulator evaluates OpenComms workspace and category ancestry", async ({
  page,
}) => {
  const configuration = createCommsConfiguration();
  configuration.workspace.permissions["role:sample-member"] = {
    viewChannel: "allow",
  };
  await page.addInitScript((commsConfiguration) => {
    sessionStorage.setItem(
      "openslate.sample.v1",
      JSON.stringify({ "comms-configuration": commsConfiguration }),
    );
  }, configuration);

  await page.goto("/access?view=simulator");
  await page
    .getByLabel("Identity", { exact: true })
    .selectOption({ label: "Morgan Kim · internal" });
  await page
    .getByLabel("Resource", { exact: true })
    .selectOption({ label: "Company · comms-category" });
  await page
    .getByLabel("Action", { exact: true })
    .selectOption({ label: "View channels" });
  await page
    .getByRole("button", { name: "Evaluate access", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Simulator result" }),
  ).toContainText(/allow/i);
  await expect(
    page.getByRole("region", { name: "Evaluation trace" }),
  ).toContainText("comms-workspace:workspace");
});

test("review completion and policy portability require explicit safe previews", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const mutations = recordServiceMutations(page);
  test.skip(
    (page.viewportSize()?.width ?? 0) < 1024,
    "Governance workflow is covered on desktop",
  );
  await page.goto("/access?view=reviews");
  await page
    .getByRole("button", { name: "Create campaign", exact: true })
    .click();
  const create = page.getByRole("dialog", { name: "Create access review" });
  await create
    .getByLabel("Campaign name", { exact: true })
    .fill("Acceptance review");
  await create
    .getByRole("button", { name: "Create campaign", exact: true })
    .click();
  const campaign = page
    .getByRole("heading", { name: "Acceptance review", exact: true })
    .locator("xpath=ancestor::section[1]");
  await expect(
    campaign.getByRole("button", { name: "Complete campaign" }),
  ).toBeDisabled();
  for (const decision of await campaign
    .getByRole("group", { name: /review decision$/ })
    .all())
    await decision.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(
    campaign.getByRole("button", { name: "Complete campaign" }),
  ).toBeEnabled();
  await campaign.getByRole("button", { name: "Complete campaign" }).click();
  await expect(campaign).toContainText("complete");

  await page
    .getByRole("button", { name: "Configure defaults", exact: true })
    .click();
  await page.getByLabel("Invitation expiry days", { exact: true }).fill("14");
  await page
    .getByRole("button", { name: "Save defaults", exact: true })
    .click();
  await expect(page.getByText("Access defaults updated.")).toBeVisible();

  await page.getByRole("button", { name: "Import JSON", exact: true }).click();
  const importDialog = page.getByRole("dialog", {
    name: "Import policy configuration",
  });
  await importDialog
    .getByLabel("Policy JSON", { exact: true })
    .fill('{"version":1,"identity":{"token":"unsafe"}}');
  await importDialog
    .getByRole("button", { name: "Validate and preview" })
    .click();
  await expect(importDialog.getByRole("alert")).toBeVisible();
  const validBundle = {
    version: 1,
    defaults: {
      defaultRoleId: "sample-member",
      defaultDepartmentIds: [],
      defaultGroupIds: [],
      invitationExpiryDays: 14,
      guestDurationDays: 30,
      serviceDurationDays: 90,
      defaultDeny: true,
      requireGuestSponsor: true,
      requireServiceOwner: true,
    },
    groups: [
      {
        id: "group:imported",
        name: "Imported group",
        description: "Acceptance",
      },
    ],
    roles: [],
    rules: [],
    templates: [],
  };
  await importDialog
    .getByLabel("Policy JSON", { exact: true })
    .fill(JSON.stringify(validBundle));
  await importDialog
    .getByRole("button", { name: "Validate and preview" })
    .click();
  await expect(importDialog).toContainText("Validated version 1 bundle");
  await importDialog
    .getByRole("button", { name: "Merge policy", exact: true })
    .click();
  await expect(page.getByText(/Policy configuration merged/)).toBeVisible();

  await page
    .getByRole("button", { name: "View policy history", exact: true })
    .click();
  const activity = page.getByRole("dialog", { name: "Policy history" });
  await activity
    .getByRole("button", { name: "Preview restore", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Preview policy restore" }),
  ).toContainText(
    "Identity records, membership, sessions, and policy history remain unchanged",
  );
  expect(mutations).toEqual([]);
});
