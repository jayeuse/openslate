import { expect, test, type Page, type Route } from "./helpers/test";

const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const preferencePath = (user: string) => `/api/users/${user}/preferences`;
test.use({ trace: "off", screenshot: "off", video: "off" });

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function installIdentity(
  page: Page,
  role: "admin" | "member" | "guest" = "admin",
) {
  let user = userA;
  let checks = 0;
  await page.route("**/api/auth/session", (route) => {
    checks += 1;
    return route.fulfill({
      json: { authenticated: true, user_id: user, setup_required: false },
    });
  });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { id: user, role, access: [] } }),
  );
  await page.route("**/api/auth/sessions", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        id: "44444444-4444-4444-8444-444444444444",
        display_name: "Theme journey",
        locale: "en-GB",
        timezone: "UTC",
        mark: "TH",
        currency: "PHP",
        week_start: "monday",
        business_hours: "09:00–18:00",
        revision: 1,
      },
    }),
  );
  return {
    setUser: (next: string) => {
      user = next;
    },
    get checks() {
      return checks;
    },
  };
}

async function openAccount(page: Page) {
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Account settings", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Theme", exact: true }),
  ).toBeVisible();
}

const light = (page: Page) =>
  page.getByRole("radio", { name: "Light", exact: true });
const dark = (page: Page) =>
  page.getByRole("radio", { name: "Dark", exact: true });

test("a cold preference load is disabled, fails visibly, and retries without changing local motion or organization look", async ({
  page,
}) => {
  await installIdentity(page, "guest");
  const gate = deferred();
  let reads = 0;
  let recovered = false;
  await page.addInitScript(() => {
    localStorage.setItem("openslate-motion", "reduced");
    localStorage.setItem("openslate-org-theme", "stockroom");
  });
  await page.route(`**${preferencePath(userA)}`, async (route) => {
    reads += 1;
    if (!recovered) {
      await gate.promise;
      await route.fulfill({
        status: 503,
        json: { detail: "Private upstream diagnostic" },
      });
    } else await route.fulfill({ json: { user_id: userA, theme: "dark" } });
  });
  try {
    const requested = page.waitForRequest(
      (request) => new URL(request.url()).pathname === preferencePath(userA),
    );
    await page.goto("/settings/appearance");
    await requested;
    await expect(dark(page)).toBeDisabled();
    await expect(
      page.getByText("Loading theme…", { exact: true }),
    ).toBeVisible();
    gate.release();
    await expect(
      page.getByText("Theme could not be loaded. Try again.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Private upstream diagnostic")).toHaveCount(0);
    const beforeRetry = reads;
    recovered = true;
    await page
      .getByRole("button", { name: "Retry theme", exact: true })
      .click();
    await expect(dark(page)).toBeChecked();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("html")).toHaveAttribute(
      "data-motion",
      "reduced",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "stockroom",
    );
    expect(reads).toBe(beforeRetry + 1);
    await expect(
      page.getByRole("switch", { name: "Reduce motion" }),
    ).toBeChecked();
    await page.evaluate(() => {
      localStorage.removeItem("openslate-motion");
      window.dispatchEvent(
        new StorageEvent("storage", { key: "openslate-motion" }),
      );
    });
    await expect(
      page.getByRole("switch", { name: "Reduce motion" }),
    ).not.toBeChecked();
    await expect(page.locator("html")).not.toHaveAttribute("data-motion");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "stockroom",
    );
  } finally {
    gate.release();
  }
});

test("Appearance and Account share only confirmed theme saves, preserve route changes and reload", async ({
  page,
}) => {
  await installIdentity(page, "member");
  const gate = deferred();
  let theme = "light";
  const writes: unknown[] = [];
  await page.route(`**${preferencePath(userA)}`, async (route) => {
    if (route.request().method() === "PATCH") {
      const body: unknown = route.request().postDataJSON();
      writes.push(body);
      await gate.promise;
      if (
        typeof body !== "object" ||
        body === null ||
        !("theme" in body) ||
        (body.theme !== "light" && body.theme !== "dark")
      )
        throw new Error("Invalid theme command");
      theme = body.theme;
    }
    await route.fulfill({ json: { user_id: userA, theme } });
  });
  try {
    await page.goto("/settings/appearance");
    await expect(light(page)).toBeChecked();
    const patched = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" &&
        new URL(request.url()).pathname === preferencePath(userA),
    );
    await dark(page).click();
    await patched;
    await expect(light(page)).toBeChecked();
    await expect(dark(page)).toBeDisabled();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await openAccount(page);
    const control = page.getByRole("combobox", { name: "Theme", exact: true });
    await expect(control).toHaveValue("light");
    await expect(control).toBeDisabled();
    await expect(
      page.getByText("Saving theme…", { exact: true }),
    ).toBeVisible();
    gate.release();
    await expect(control).toHaveValue("dark");
    await expect(control).toBeEnabled();
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(writes).toEqual([{ theme: "dark" }]);
    await control.selectOption("light");
    await expect(control).toHaveValue("light");
    await expect(control).toBeEnabled();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await control.selectOption("dark");
    await expect(control).toHaveValue("dark");
    await expect(control).toBeEnabled();
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(writes).toEqual([
      { theme: "dark" },
      { theme: "light" },
      { theme: "dark" },
    ]);
    await page.evaluate(() => {
      localStorage.setItem("openslate-theme", "light");
      localStorage.setItem("openslate-motion", "reduced");
      window.dispatchEvent(
        new StorageEvent("storage", { key: "openslate-theme" }),
      );
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("html")).toHaveAttribute(
      "data-motion",
      "reduced",
    );
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(dark(page)).toBeChecked();
    await page.reload();
    await expect(dark(page)).toBeChecked();
    await expect(page.locator("html")).toHaveClass(/dark/);
  } finally {
    gate.release();
  }
});

test("a failed save retains the confirmed mode and Retry reloads without repeating a mutation", async ({
  page,
}) => {
  await installIdentity(page);
  let writes = 0;
  let reads = 0;
  await page.route(`**${preferencePath(userA)}`, async (route) => {
    if (route.request().method() === "PATCH") {
      writes += 1;
      await route.fulfill({
        status: 503,
        json: { detail: "Private mutation diagnostic" },
      });
    } else {
      reads += 1;
      await route.fulfill({ json: { user_id: userA, theme: "light" } });
    }
  });
  await page.goto("/settings/appearance");
  await expect(light(page)).toBeChecked();
  await dark(page).click();
  await expect(
    page.getByText(
      "Theme could not be saved. Retry to reload your saved preference.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(light(page)).toBeChecked();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.getByText("Theme saved.", { exact: true })).toHaveCount(0);
  const beforeRetry = reads;
  await page.getByRole("button", { name: "Retry theme", exact: true }).click();
  await expect(dark(page)).toBeEnabled();
  expect(writes).toBe(1);
  expect(reads).toBe(beforeRetry + 1);
});

for (const fault of ["identity", "denied", "unauthorized"] as const) {
  test(`a ${fault} save response triggers the existing session check and never applies or resubmits`, async ({
    page,
  }) => {
    const identity = await installIdentity(page);
    let writes = 0;
    await page.route(`**${preferencePath(userA)}`, async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({ json: { user_id: userA, theme: "light" } });
      writes += 1;
      return fault === "identity"
        ? route.fulfill({ json: { user_id: userB, theme: "dark" } })
        : route.fulfill({
            status: fault === "unauthorized" ? 401 : 403,
            json: {
              detail: {
                code: "preferences_owner_mismatch",
                message: "Private mismatch detail",
              },
            },
          });
    });
    await page.goto("/settings/appearance");
    await expect(light(page)).toBeChecked();
    const before = identity.checks;
    await dark(page).click();
    await expect.poll(() => identity.checks).toBeGreaterThan(before);
    await expect(light(page)).toBeChecked();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(
      page.getByRole("button", { name: "Retry theme", exact: true }),
    ).toBeVisible();
    expect(writes).toBe(1);
  });
}

for (const delayed of ["GET", "PATCH"] as const) {
  test(`an old-account ${delayed} settling after account change cannot affect the new theme`, async ({
    page,
  }) => {
    const identity = await installIdentity(page);
    const gate = deferred();
    const answered = deferred();
    let oldRequests = 0;
    await page.route("**/api/users/*/preferences", async (route: Route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === preferencePath(userB))
        return route.fulfill({ json: { user_id: userB, theme: "light" } });
      if (route.request().method() === delayed) {
        oldRequests += 1;
        await gate.promise;
        await route
          .fulfill({ json: { user_id: userA, theme: "dark" } })
          .catch(() => {});
        answered.release();
      } else await route.fulfill({ json: { user_id: userA, theme: "light" } });
    });
    try {
      await page.goto("/settings/appearance");
      if (delayed === "PATCH") {
        await expect(light(page)).toBeChecked();
        const requested = page.waitForRequest(
          (request) => request.method() === "PATCH",
        );
        await dark(page).click();
        await requested;
      } else await expect.poll(() => oldRequests).toBeGreaterThan(0);
      const startedOldRequests = oldRequests;
      identity.setUser(userB);
      const nextRead = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === preferencePath(userB),
      );
      await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
      await nextRead;
      await expect(light(page)).toBeChecked();
      gate.release();
      await answered.promise;
      await openAccount(page);
      await expect(
        page.getByRole("combobox", { name: "Theme", exact: true }),
      ).toHaveValue("light");
      await expect(page.locator("html")).not.toHaveClass(/dark/);
      expect(oldRequests).toBe(startedOldRequests);
      if (delayed === "PATCH") expect(oldRequests).toBe(1);
    } finally {
      gate.release();
    }
  });
}

test("Account has working theme preferences without language and presence stubs", async ({
  page,
}) => {
  await installIdentity(page);
  await page.goto("/platform?section=account");
  const theme = page.getByRole("combobox", { name: "Theme", exact: true });
  await expect(theme).toBeEnabled();
  await expect(
    page.getByRole("combobox", { name: "Display language", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "My presence", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Team presence", { exact: true })).toHaveCount(0);
  await theme.selectOption("dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByText("Morgan Kim", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Your status:")).toHaveCount(0);
  await expect(page.getByText("Maligayang pagdating")).toHaveCount(0);
});

for (const fault of ["malformed", "identity"] as const) {
  test(`a ${fault} read never applies and can be explicitly retried`, async ({
    page,
  }) => {
    const identity = await installIdentity(page);
    let reads = 0;
    let recovered = false;
    await page.route(`**${preferencePath(userA)}`, (route) => {
      reads += 1;
      return route.fulfill({
        json: !recovered
          ? {
              user_id: fault === "identity" ? userB : userA,
              theme: fault === "malformed" ? "sepia" : "dark",
            }
          : { user_id: userA, theme: "dark" },
      });
    });
    await page.goto("/settings/appearance");
    await expect(
      page.getByRole("button", { name: "Retry theme", exact: true }),
    ).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(dark(page)).toBeDisabled();
    if (fault === "identity")
      await expect.poll(() => identity.checks).toBeGreaterThan(1);
    const beforeRetry = reads;
    recovered = true;
    await page
      .getByRole("button", { name: "Retry theme", exact: true })
      .click();
    await expect(dark(page)).toBeChecked();
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(reads).toBe(beforeRetry + 1);
  });
}

test("confirmed theme saves preserve applied motion and organization look when browser writes are blocked", async ({
  page,
}) => {
  await installIdentity(page);
  const gate = deferred();
  let theme = "light";
  const writes: unknown[] = [];
  await page.route(`**${preferencePath(userA)}`, async (route) => {
    if (route.request().method() === "PATCH") {
      const body: unknown = route.request().postDataJSON();
      writes.push(body);
      await gate.promise;
      if (
        typeof body !== "object" ||
        body === null ||
        !("theme" in body) ||
        (body.theme !== "light" && body.theme !== "dark")
      )
        throw new Error("Invalid theme command");
      theme = body.theme;
    }
    await route.fulfill({ json: { user_id: userA, theme } });
  });
  try {
    await page.goto("/manage?view=organization");
    const look = page.getByRole("radiogroup", { name: "Organization look" });
    await expect(look.getByRole("radio", { name: /^Slate/ })).toBeChecked();
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("Storage writes are blocked", "SecurityError");
      };
    });
    await look.locator("label").filter({ hasText: "Stockroom" }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "stockroom",
    );
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(light(page)).toBeChecked();
    const motion = page.getByRole("switch", { name: "Reduce motion" });
    await motion.click();
    await expect(motion).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute(
      "data-motion",
      "reduced",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "stockroom",
    );
    const patched = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" &&
        new URL(request.url()).pathname === preferencePath(userA),
    );
    await dark(page).click();
    await patched;
    await expect(light(page)).toBeChecked();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(page.locator("html")).toHaveAttribute(
      "data-motion",
      "reduced",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "stockroom",
    );
    gate.release();
    await expect(dark(page)).toBeChecked();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(motion).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute(
      "data-motion",
      "reduced",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "stockroom",
    );
    expect(writes).toEqual([{ theme: "dark" }]);
  } finally {
    gate.release();
  }
});
