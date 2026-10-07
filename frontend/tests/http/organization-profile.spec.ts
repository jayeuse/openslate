import { expect, test, type Page, type Route } from "./helpers/test";

test.use({ trace: "off", screenshot: "off", video: "off" });

const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";
const initialWorkspace = {
  id: "33333333-3333-4333-8333-333333333333",
  display_name: "Profile organization",
  legal_name: "Harbor Services Ltd" as string | null,
  description: "Plain organization description" as string | null,
  contact_email: "contact@example.com" as string | null,
  contact_phone: "+63 555 0100" as string | null,
  postal_address: "Profile Street\nTest City" as string | null,
  logo_file_id: null,
  timezone: "Asia/Manila",
  locale: "en-PH",
  mark: "HS",
  currency: "PHP",
  week_start: "monday",
  business_hours: "09:00–18:00",
  theme: "slate",
  invitation_expiry_days: 7,
  guest_duration_days: 30,
  revision: 4,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  today: "2026-10-06",
  purge_enabled: false,
};
type Workspace = typeof initialWorkspace;
type Api = {
  userId: string;
  role: "admin" | "member" | "guest";
  workspace: Workspace;
  writes: Record<string, unknown>[];
  saveFailure: number;
  onGet: ((route: Route) => Promise<void>) | null;
  onPatch: ((route: Route) => Promise<void>) | null;
  onSession: ((route: Route) => Promise<void>) | null;
};

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function guestBody(workspace: Workspace): Record<string, unknown> {
  const body: Record<string, unknown> = { ...workspace };
  delete body.contact_email;
  delete body.contact_phone;
  delete body.postal_address;
  return body;
}

async function installProfile(page: Page): Promise<Api> {
  const api: Api = {
    userId: userA,
    role: "admin",
    workspace: { ...initialWorkspace },
    writes: [],
    saveFailure: 0,
    onGet: null,
    onPatch: null,
    onSession: null,
  };
  await page.route("**/api/auth/session", (route) =>
    api.onSession
      ? api.onSession(route)
      : route.fulfill({
          json: {
            authenticated: true,
            user_id: api.userId,
            setup_required: false,
          },
        }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { id: api.userId, role: api.role, access: [] } }),
  );
  await page.route("**/api/workspace/appearance", (route) =>
    route.fulfill({ json: { theme: api.workspace.theme } }),
  );
  await page.route("**/api/events", (route) => route.fulfill({ status: 503 }));
  await page.route("**/api/workspace", async (route) => {
    if (route.request().method() === "GET")
      return api.onGet
        ? api.onGet(route)
        : route.fulfill({
            json:
              api.role === "guest" ? guestBody(api.workspace) : api.workspace,
          });
    const patch: Record<string, unknown> = route.request().postDataJSON();
    api.writes.push(patch);
    if (api.onPatch) return api.onPatch(route);
    if (api.saveFailure)
      return route.fulfill({
        status: api.saveFailure,
        json: { detail: "Controlled profile failure" },
      });
    if (patch.revision !== api.workspace.revision)
      return route.fulfill({
        status: 409,
        json: { detail: { code: "stale_revision" } },
      });
    const changed = { ...api.workspace };
    for (const key of [
      "legal_name",
      "description",
      "contact_email",
      "contact_phone",
      "postal_address",
    ] as const) {
      if (!(key in patch)) continue;
      const value = patch[key];
      if (value !== null && typeof value !== "string")
        throw new Error("Expected nullable profile text");
      changed[key] = value === null ? null : value.trim() || null;
    }
    if (changed.contact_email)
      changed.contact_email = changed.contact_email.toLowerCase();
    if (typeof patch.theme === "string") changed.theme = patch.theme;
    api.workspace = { ...changed, revision: changed.revision + 1 };
    await route.fulfill({ json: api.workspace });
  });
  return api;
}

const field = (page: Page, name: string) =>
  page.getByLabel(name, { exact: true });
const save = (page: Page) =>
  page.getByRole("button", { name: "Save settings", exact: true });
const saved = (page: Page) =>
  page.getByText("Organization settings saved.", { exact: true });

test("Organization profile fields load, save and clear without changing omitted values", async ({
  page,
}) => {
  const api = await installProfile(page);
  await page.goto("/manage?view=organization");
  await expect(
    page.getByRole("group", { name: "Organization profile", exact: true }),
  ).toBeVisible();
  await expect(field(page, "Legal name")).toHaveValue("Harbor Services Ltd");
  await expect(field(page, "Description")).toHaveValue(
    "Plain organization description",
  );
  await expect(field(page, "Contact email")).toHaveValue("contact@example.com");
  await expect(field(page, "Contact phone")).toHaveValue("+63 555 0100");
  await expect(field(page, "Postal address")).toHaveValue(
    "Profile Street\nTest City",
  );
  await field(page, "Legal name").fill("  Updated legal name  ");
  await field(page, "Description").fill("Updated description\nSecond line");
  await field(page, "Contact email").fill(" NEW@EXAMPLE.COM ");
  await field(page, "Contact phone").fill(" +63 555 0200 ");
  await field(page, "Postal address").fill(" New street\nNew city ");
  await save(page).click();
  await expect(saved(page)).toBeVisible();
  expect(api.writes).toEqual([
    {
      revision: 4,
      legal_name: "Updated legal name",
      description: "Updated description\nSecond line",
      contact_email: "NEW@EXAMPLE.COM",
      contact_phone: "+63 555 0200",
      postal_address: "New street\nNew city",
    },
  ]);
  await expect(field(page, "Contact email")).toHaveValue("new@example.com");
  await page.reload();
  await expect(field(page, "Postal address")).toHaveValue(
    "New street\nNew city",
  );
  await field(page, "Contact phone").fill("   ");
  await save(page).click();
  await expect(field(page, "Contact phone")).toHaveValue("");
  expect(api.writes[1]).toEqual({ revision: 5, contact_phone: null });
  expect(api.workspace.description).toBe("Updated description\nSecond line");
  expect(api.workspace.theme).toBe("slate");
  await field(page, "Contact phone").fill("  ");
  await expect(save(page)).toBeDisabled();
});

test("Organization profile Discard keeps saved values and sends no command", async ({
  page,
}) => {
  const api = await installProfile(page);
  await page.goto("/manage?view=organization");
  await field(page, "Description").fill("Unsaved profile description");
  await field(page, "Contact email").fill("unsaved@example.com");
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(field(page, "Description")).toHaveValue(
    "Plain organization description",
  );
  await expect(field(page, "Contact email")).toHaveValue("contact@example.com");
  expect(api.writes).toEqual([]);
  expect(
    await page.evaluate(() =>
      [...Object.values(localStorage), ...Object.values(sessionStorage)].join(
        " ",
      ),
    ),
  ).not.toContain("unsaved@example.com");
});

test("Organization invalid email keeps the draft with a safe linked field error", async ({
  page,
}) => {
  const api = await installProfile(page);
  api.onPatch = (route) =>
    route.fulfill({
      status: 422,
      json: {
        detail: [
          {
            loc: ["body", "contact_email"],
            type: "value_error",
            msg: "Private validator diagnostic",
          },
        ],
      },
    });
  await page.goto("/manage?view=organization");
  const email = field(page, "Contact email");
  await email.fill("invalid address");
  await save(page).click();
  await expect(email).toHaveValue("invalid address");
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("Enter a valid email address.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Private validator diagnostic")).toHaveCount(0);
  expect(api.workspace.contact_email).toBe("contact@example.com");
  api.onPatch = null;
  await email.fill("corrected@example.com");
  await save(page).click();
  await expect(saved(page)).toBeVisible();
  await expect(email).toHaveAttribute("aria-invalid", "false");
});

for (const role of ["member", "guest"] as const) {
  test(`Organization ${role} profile is read only with the permitted fields`, async ({
    page,
  }) => {
    const api = await installProfile(page);
    api.role = role;
    await page.goto("/manage?view=organization");
    await expect(field(page, "Legal name")).toHaveValue("Harbor Services Ltd");
    await expect(field(page, "Legal name")).toBeDisabled();
    await expect(field(page, "Description")).toBeDisabled();
    if (role === "guest") {
      await expect(field(page, "Contact email")).toHaveCount(0);
      await expect(field(page, "Contact phone")).toHaveCount(0);
      await expect(field(page, "Postal address")).toHaveCount(0);
    } else {
      await expect(field(page, "Contact email")).toHaveValue(
        "contact@example.com",
      );
      await expect(field(page, "Contact email")).toBeDisabled();
    }
    expect(api.writes).toEqual([]);
  });
}

test("Organization full null profile remains an editable full response", async ({
  page,
}) => {
  const api = await installProfile(page);
  Object.assign(api.workspace, {
    legal_name: null,
    description: null,
    contact_email: null,
    contact_phone: null,
    postal_address: null,
  });
  await page.goto("/manage?view=organization");
  await expect(field(page, "Contact email")).toHaveValue("");
  await expect(field(page, "Contact email")).toBeEnabled();
  await field(page, "Legal name").fill("New nullable profile");
  await save(page).click();
  await expect(saved(page)).toBeVisible();
  expect(api.writes).toEqual([
    { revision: 4, legal_name: "New nullable profile" },
  ]);
});

for (const fault of [
  "partial",
  "wrong type",
  "guest shape for admin",
] as const) {
  test(`Organization malformed contact ${fault} is unavailable rather than a writable guest`, async ({
    page,
  }) => {
    const api = await installProfile(page);
    api.onGet = (route) => {
      const body = guestBody(api.workspace);
      if (fault === "partial") body.contact_email = "partial@example.com";
      if (fault === "wrong type")
        Object.assign(body, {
          contact_email: "valid@example.com",
          contact_phone: 42,
          postal_address: null,
        });
      return route.fulfill({ json: body });
    };
    await page.goto("/manage?view=organization");
    await expect(
      page.getByText("The organization settings could not be loaded.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(field(page, "Contact email")).toHaveCount(0);
    // A guest-shaped body makes the form read-only, which hides Save.
    if (fault === "guest shape for admin")
      await expect(save(page)).toHaveCount(0);
    else await expect(save(page)).toBeDisabled();
    api.onGet = (route) =>
      route.fulfill({
        json: { ...api.workspace, unrelated_metadata: { accepted: true } },
      });
    await page
      .getByRole("button", { name: "Retry organization settings", exact: true })
      .click();
    await expect(field(page, "Contact email")).toHaveValue(
      "contact@example.com",
    );
  });
}

test("Organization malformed full PATCH keeps its draft until explicit readback", async ({
  page,
}) => {
  const api = await installProfile(page);
  api.onPatch = (route) => route.fulfill({ json: guestBody(api.workspace) });
  await page.goto("/manage?view=organization");
  await field(page, "Description").fill("Uncertain description");
  await save(page).click();
  await expect(
    page.getByText("The settings could not be saved. Try again.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(field(page, "Description")).toHaveValue("Uncertain description");
  await expect(saved(page)).toHaveCount(0);
  expect(api.workspace.description).toBe("Plain organization description");
  api.onPatch = null;
  await save(page).click();
  await expect(saved(page)).toBeVisible();
  expect(api.writes).toHaveLength(2);
  expect(api.workspace.description).toBe("Uncertain description");
});

test("Organization stale and failed profile saves preserve the draft and current revision", async ({
  page,
}) => {
  const api = await installProfile(page);
  await page.goto("/manage?view=organization");
  await field(page, "Legal name").fill("Retained legal draft");
  api.workspace = {
    ...api.workspace,
    revision: 5,
    description: "New server description",
  };
  await save(page).click();
  await expect(field(page, "Legal name")).toHaveValue("Retained legal draft");
  await expect(field(page, "Description")).toHaveValue(
    "New server description",
  );
  api.saveFailure = 503;
  await page.getByRole("button", { name: "Save again", exact: true }).click();
  await expect(field(page, "Legal name")).toHaveValue("Retained legal draft");
  await expect(saved(page)).toHaveCount(0);
  api.saveFailure = 0;
  await page.getByRole("button", { name: "Save again", exact: true }).click();
  await expect(saved(page)).toBeVisible();
  expect(api.writes.map((patch) => patch.revision)).toEqual([4, 5, 5]);
});

test("Organization pending profile save blocks duplicate commands and navigation", async ({
  page,
}) => {
  const api = await installProfile(page);
  const pending = gate();
  api.onPatch = async (route) => {
    await pending.promise;
    api.workspace = {
      ...api.workspace,
      legal_name: "Pending legal name",
      revision: 5,
    };
    await route.fulfill({ json: api.workspace });
  };
  try {
    await page.goto("/manage?view=organization");
    await field(page, "Legal name").fill("Pending legal name");
    await save(page).click();
    await expect(save(page)).toBeDisabled();
    await expect(field(page, "Contact email")).toBeDisabled();
    await page.getByRole("link", { name: "Organization", exact: true }).click();
    await expect(page).toHaveURL(/\/manage\?view=organization$/);
    expect(api.writes).toHaveLength(1);
    pending.release();
    await expect(saved(page)).toBeVisible();
  } finally {
    pending.release();
  }
});

test("Organization same-account privacy curtain removes contacts and restores its draft", async ({
  page,
}) => {
  const api = await installProfile(page);
  const session = gate();
  try {
    await page.goto("/manage?view=organization");
    await field(page, "Contact email").fill("retained@example.com");
    api.onSession = async (route) => {
      await session.promise;
      await route.fulfill({
        json: { authenticated: true, user_id: userA, setup_required: false },
      });
    };
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    await expect(
      page.getByText("Checking your session…", { exact: true }),
    ).toBeVisible();
    await expect(field(page, "Contact email")).toHaveCount(0);
    session.release();
    await expect(field(page, "Contact email")).toHaveValue(
      "retained@example.com",
    );
    expect(api.writes).toEqual([]);
  } finally {
    session.release();
  }
});

for (const delayed of ["GET", "PATCH"] as const) {
  test(`Organization late ${delayed} cannot expose the previous account's contacts to a guest`, async ({
    page,
  }) => {
    const api = await installProfile(page);
    const pending = gate();
    const started = gate();
    const old = { ...api.workspace };
    if (delayed === "GET") {
      let first = true;
      api.onGet = async (route) => {
        if (first) {
          first = false;
          started.release();
          await pending.promise;
          await route.fulfill({ json: old }).catch(() => {});
        } else await route.fulfill({ json: guestBody(api.workspace) });
      };
    } else
      api.onPatch = async (route) => {
        started.release();
        await pending.promise;
        await route
          .fulfill({
            json: { ...old, description: "Late accepted change", revision: 5 },
          })
          .catch(() => {});
      };
    try {
      await page.goto("/manage?view=organization");
      if (delayed === "PATCH") {
        await field(page, "Description").fill("Late accepted change");
        await save(page).click();
      }
      await started.promise;
      api.userId = userB;
      api.role = "guest";
      api.workspace = { ...api.workspace, legal_name: "Guest legal name" };
      await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
      await expect(field(page, "Legal name")).toHaveValue("Guest legal name");
      pending.release();
      await expect(field(page, "Contact email")).toHaveCount(0);
      await expect(field(page, "Contact phone")).toHaveCount(0);
      await expect(field(page, "Postal address")).toHaveCount(0);
      await expect(saved(page)).toHaveCount(0);
      const values = await page
        .locator("input,textarea")
        .evaluateAll((elements) =>
          elements.map((element) => (element as HTMLInputElement).value),
        );
      expect(values).not.toContain("contact@example.com");
    } finally {
      pending.release();
    }
  });
}

test("Organization profile long text reflows on phone and labelled controls remain reachable", async ({
  page,
}) => {
  const api = await installProfile(page);
  api.workspace.postal_address = "Long profile address ".repeat(70);
  await page.addInitScript(() =>
    localStorage.setItem("openslate-text-size", "125"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/manage?view=organization");
  const address = field(page, "Postal address");
  await address.scrollIntoViewIfNeeded();
  await expect(address).toBeInViewport();
  await address.focus();
  await expect(address).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
