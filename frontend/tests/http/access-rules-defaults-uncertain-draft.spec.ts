import { expect, test, type Page } from "@playwright/test";

const timestamp = "2026-09-23T00:00:00Z";
const memberRoleId = "00000000-0000-4000-8000-000000000001";
const adminRoleId = "00000000-0000-4000-8000-000000000002";
const defaultsId = "00000000-0000-4000-8000-000000000004";
const roles = [
  {
    id: memberRoleId,
    role: "member",
    description: "Standard workspace access.",
    permissions: { "records.read": true },
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  },
  {
    id: adminRoleId,
    role: "admin",
    description: "Protected administration.",
    permissions: {},
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  },
];
const defaults = {
  id: defaultsId,
  default_role_id: memberRoleId,
  group_ids: [],
  department_ids: [],
  invitation_expiry_days: 14,
  guest_duration_days: 30,
  service_duration_days: 90,
  default_deny: true,
  require_guest_sponsor: true,
  require_service_owner: true,
  revision: 1,
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: null,
  is_deleted: false,
  performed_by: null,
};

function page(items: unknown[]) {
  return {
    items,
    pagination: {
      limit: 100,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  };
}

async function mockAccessApi(
  browserPage: Page,
  options: {
    onDefaultsSave?: () => void;
    onRulesMutation?: () => void;
    currentDefaults?: () => typeof defaults;
    currentRules?: () => unknown[];
  } = {},
) {
  await browserPage.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    let body: unknown;
    let etag: string | undefined;
    if (pathname === "/api/auth/session") {
      body = {
        authenticated: true,
        user_id: "00000000-0000-4000-8000-000000000010",
        setup_required: false,
      };
    } else if (pathname === "/api/access/capabilities") {
      body = {
        items: [
          {
            id: "records.read",
            label: "Read records",
            description: "Read workspace records.",
            group: "Records",
          },
        ],
      };
    } else if (pathname === "/api/users") body = page([]);
    else if (pathname === "/api/roles") body = page(roles);
    else if (pathname === "/api/departments") body = page([]);
    else if (pathname === "/api/access/groups") body = page([]);
    else if (pathname === "/api/access/service-identities") body = page([]);
    else if (pathname === "/api/access/defaults") {
      if (method === "PATCH") options.onDefaultsSave?.();
      body = options.currentDefaults?.() ?? defaults;
      etag = `"defaults-${(body as typeof defaults).revision}"`;
    } else if (pathname === "/api/access/rules") {
      if (method !== "GET") options.onRulesMutation?.();
      body = page(options.currentRules?.() ?? []);
      etag = '"workspace:1"';
    } else if (pathname.startsWith("/api/access/rules/")) {
      if (method !== "GET") options.onRulesMutation?.();
      await route.fulfill({ status: 500, body: "Unexpected policy request" });
      return;
    } else {
      await route.fulfill({ status: 404, body: "Unmocked Access request" });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      headers: etag ? { ETag: etag } : undefined,
      body: JSON.stringify(body),
    });
  });
}

test("Rules blocks a policy request when its draft cannot enter review state", async ({
  page: browserPage,
}) => {
  let mutations = 0;
  await mockAccessApi(browserPage, {
    onRulesMutation: () => {
      mutations += 1;
    },
  });
  await browserPage.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        key.startsWith("openslate.access.draft.v1.") &&
        key.endsWith(".rules") &&
        JSON.parse(value).state === "uncertain"
      )
        throw new Error("Rules safety write blocked");
      return set.call(this, key, value);
    };
  });

  await browserPage.goto("/access?view=rules");
  const decision = browserPage.getByRole("group", {
    name: "Read records decision",
  });
  await decision.getByRole("button", { name: "Allow" }).click();
  await browserPage.getByRole("button", { name: "Review impact" }).click();
  await browserPage
    .getByRole("button", { name: "Apply 1 draft choice" })
    .click();
  await browserPage.getByRole("button", { name: "Confirm and apply" }).click();

  await expect(
    browserPage
      .getByRole("alert")
      .filter({ hasText: /could not protect.*Rules draft/i }),
  ).toBeVisible();
  expect(mutations).toBe(0);
});

test("Rules compares saved choices with current policy after an uncertain request", async ({
  page: browserPage,
}) => {
  let mutations = 0;
  await mockAccessApi(browserPage, {
    onRulesMutation: () => {
      mutations += 1;
    },
  });
  await browserPage.goto("/access?view=rules");
  await browserPage
    .getByRole("group", { name: "Read records decision" })
    .getByRole("button", { name: "Allow" })
    .click();
  await browserPage.getByRole("button", { name: "Review impact" }).click();
  await browserPage
    .getByRole("button", { name: "Apply 1 draft choice" })
    .click();
  await browserPage.getByRole("button", { name: "Confirm and apply" }).click();
  await expect(
    browserPage.getByText(/Rules change may have completed/i),
  ).toBeVisible();
  expect(mutations).toBe(1);

  browserPage.once("dialog", (dialog) => dialog.accept());
  await browserPage.reload();
  await expect(
    browserPage.getByRole("heading", {
      name: "Current policy and saved Rules choices",
    }),
  ).toBeVisible();
  await expect(browserPage.getByText("Current: inherit")).toBeVisible();
  await expect(browserPage.getByText("Saved: allow")).toBeVisible();
  await expect(
    browserPage.getByRole("button", { name: "Review impact" }),
  ).toBeDisabled();
  expect(mutations).toBe(1);
});

test("using existing access preserves the rule lock and time window", async ({
  page: browserPage,
}) => {
  await mockAccessApi(browserPage, {
    currentRules: () => [
      {
        id: "00000000-0000-4000-8000-000000000030",
        subject_kind: "everyone",
        subject_id: null,
        scope_kind: "workspace",
        scope_id: null,
        permission_id: "records.read",
        decision: "allow",
        starts_at: "2026-09-23T00:00:00Z",
        ends_at: "2026-12-23T00:00:00Z",
        locked: true,
        policy_version: 1,
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
        is_deleted: false,
        performed_by: null,
      },
    ],
  });
  await browserPage.setViewportSize({ width: 390, height: 844 });
  await browserPage.goto("/access?view=rules");

  const starts = browserPage.locator('input[id$="-mobile-starts"]');
  const ends = browserPage.locator('input[id$="-mobile-ends"]');
  const decision = browserPage.getByRole("group", {
    name: "Read records decision",
  });
  await browserPage
    .locator("summary:visible")
    .filter({ hasText: "Conditions and scope lock" })
    .click();
  await starts.fill("2027-02-03T04:05");
  await ends.fill("2027-11-12T13:14");
  await decision.getByRole("button", { name: "Use existing access" }).click();

  await expect(
    decision.getByRole("button", { name: "Use existing access" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(starts).toHaveValue("2027-02-03T04:05");
  await expect(ends).toHaveValue("2027-11-12T13:14");
  await expect(
    browserPage.getByRole("button", { name: "Locked at this scope" }).first(),
  ).toHaveAttribute("aria-pressed", "true");
  const workspaceExplanation = browserPage
    .getByRole("status")
    .filter({ hasText: "Workspace-wide rules apply" });
  await expect(workspaceExplanation).toContainText(
    /Record values.*OpenView or Boards.*Report output/i,
  );
  await expect(workspaceExplanation).toContainText(
    /Board grants and content audiences remain separate/i,
  );
});

test("Defaults remains locked after a save when browser cleanup fails twice", async ({
  page: browserPage,
}) => {
  let saves = 0;
  let currentDefaults = { ...defaults };
  await mockAccessApi(browserPage, {
    onDefaultsSave: () => {
      saves += 1;
      currentDefaults = {
        ...currentDefaults,
        invitation_expiry_days: 21,
        revision: currentDefaults.revision + 1,
      };
    },
    currentDefaults: () => currentDefaults,
  });
  await browserPage.addInitScript(() => {
    const set = Storage.prototype.setItem;
    const remove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        key.startsWith("openslate.access.draft.v1.") &&
        key.endsWith(".defaults") &&
        JSON.parse(value).state === "retired" &&
        !sessionStorage.getItem("allow-defaults-cleanup")
      )
        throw new Error("Defaults retirement blocked");
      return set.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) {
      if (
        key.startsWith("openslate.access.draft.v1.") &&
        key.endsWith(".defaults") &&
        !sessionStorage.getItem("allow-defaults-cleanup")
      )
        throw new Error("Defaults removal blocked");
      return remove.call(this, key);
    };
  });

  await browserPage.goto("/access?view=reviews");
  await browserPage.getByRole("button", { name: "Configure defaults" }).click();
  await browserPage.getByLabel("Invitation expiry days").fill("21");
  await browserPage.getByRole("button", { name: "Save defaults" }).click();
  await expect(browserPage.getByText("Access defaults updated.")).toBeVisible();
  expect(saves).toBe(1);
  await expect(
    browserPage.getByRole("button", {
      name: "Review and discard locked defaults draft",
    }),
  ).toBeDisabled();
  await expect(
    browserPage.getByRole("button", { name: "Reload Access before recovery" }),
  ).toBeVisible();

  browserPage.once("dialog", (dialog) => dialog.accept());
  await browserPage.reload();
  await expect(browserPage.getByLabel("Invitation expiry days")).toHaveValue(
    "21",
  );
  await expect(
    browserPage.getByRole("button", { name: "Save defaults" }),
  ).toBeDisabled();
  await expect(
    browserPage.getByText(/defaults change may have completed/i),
  ).toBeVisible();
  await expect(
    browserPage.getByRole("heading", {
      name: "Current defaults and saved draft",
    }),
  ).toBeVisible();
  await expect(browserPage.getByText("Current: 21 days")).toBeVisible();
  await expect(browserPage.getByText("Saved: 21 days")).toBeVisible();
  expect(saves).toBe(1);

  await browserPage
    .getByRole("button", { name: "Review and discard locked defaults draft" })
    .click();
  const recovery = browserPage.getByRole("alertdialog", {
    name: "Discard uncertain defaults draft?",
  });
  await recovery.getByRole("button", { name: "Discard locked draft" }).click();
  await expect(recovery).not.toBeVisible();
  await expect(
    browserPage.getByText(
      /browser could not clear the uncertain defaults draft/i,
    ),
  ).toBeVisible();
  await expect(
    browserPage.getByRole("button", { name: "Save defaults" }),
  ).toBeDisabled();

  await browserPage.evaluate(() =>
    sessionStorage.setItem("allow-defaults-cleanup", "yes"),
  );
  await browserPage
    .getByRole("button", { name: "Review and discard locked defaults draft" })
    .click();
  await recovery.getByRole("button", { name: "Discard locked draft" }).click();
  await expect(
    browserPage.getByRole("dialog", { name: "Access defaults" }),
  ).not.toBeVisible();
  await browserPage.getByRole("button", { name: "Configure defaults" }).click();
  await expect(
    browserPage.getByRole("button", { name: "Save defaults" }),
  ).toBeEnabled();
  expect(saves).toBe(1);
});
