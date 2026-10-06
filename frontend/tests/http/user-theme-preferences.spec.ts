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
  let organizationTheme = "slate";
  let revision = 1;
  await page.route("**/api/workspace/appearance", (route) =>
    route.fulfill({ json: { theme: organizationTheme } }),
  );
  await page.route("**/api/workspace", (route) => {
    if (route.request().method() === "PATCH") {
      const patch: unknown = route.request().postDataJSON();
      if (
        typeof patch !== "object" ||
        patch === null ||
        !("theme" in patch) ||
        typeof patch.theme !== "string"
      )
        throw new Error("Invalid organization theme command");
      organizationTheme = patch.theme;
      revision += 1;
    }
    return route.fulfill({
      json: {
        id: "44444444-4444-4444-8444-444444444444",
        display_name: "Theme journey",
        legal_name: null,
        description: null,
        ...(role === "guest"
          ? {}
          : { contact_email: null, contact_phone: null, postal_address: null }),
        locale: "en-GB",
        timezone: "UTC",
        mark: "TH",
        currency: "PHP",
        week_start: "monday",
        business_hours: "09:00–18:00",
        theme: organizationTheme,
        revision,
      },
    });
  });
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
  await page.route("**/api/workspace/appearance", (route) =>
    route.fulfill({ json: { theme: "stockroom" } }),
  );

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
    } else
      await route.fulfill({
        json: {
          user_id: userA,
          theme: "dark",
          appearance: { motion: "reduce", keyboard_shortcuts: true },
        },
      });
  });
  try {
    const requested = page.waitForRequest(
      (request) => new URL(request.url()).pathname === preferencePath(userA),
    );
    await page.goto("/settings/appearance");
    await requested;
    await expect(dark(page)).toBeDisabled();
    await expect(
      page.getByText("Loading preferences…", { exact: true }),
    ).toBeVisible();
    gate.release();
    await expect(
      page.getByText("Preferences could not be loaded. Try again.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText("Private upstream diagnostic")).toHaveCount(0);
    const beforeRetry = reads;
    recovered = true;
    await page
      .getByRole("button", { name: "Retry preferences", exact: true })
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
    ).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute(
      "data-motion",
      "reduced",
    );
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
    await route.fulfill({
      json: {
        user_id: userA,
        theme,
        appearance: { motion: "system", keyboard_shortcuts: true },
      },
    });
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
      page.getByText("Saving preferences…", { exact: true }),
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
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("openslate-theme")))
      .toBe("dark");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("openslate-motion")))
      .toBeNull();
    await expect(page.locator("html")).not.toHaveAttribute("data-motion");
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
      await route.fulfill({
        json: {
          user_id: userA,
          theme: "light",
          appearance: { motion: "system", keyboard_shortcuts: true },
        },
      });
    }
  });
  await page.goto("/settings/appearance");
  await expect(light(page)).toBeChecked();
  await dark(page).click();
  await expect(
    page.getByText(
      "Preferences could not be saved. Retry to reload your saved preferences.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(light(page)).toBeChecked();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.getByText("Theme saved.", { exact: true })).toHaveCount(0);
  const beforeRetry = reads;
  await page
    .getByRole("button", { name: "Retry preferences", exact: true })
    .click();
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
        return route.fulfill({
          json: {
            user_id: userA,
            theme: "light",
            appearance: { motion: "system", keyboard_shortcuts: true },
          },
        });
      writes += 1;
      return fault === "identity"
        ? route.fulfill({
            json: {
              user_id: userB,
              theme: "dark",
              appearance: { motion: "system", keyboard_shortcuts: true },
            },
          })
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
      page.getByRole("button", { name: "Retry preferences", exact: true }),
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
        return route.fulfill({
          json: {
            user_id: userB,
            theme: "light",
            appearance: { motion: "system", keyboard_shortcuts: true },
          },
        });
      if (route.request().method() === delayed) {
        oldRequests += 1;
        await gate.promise;
        await route
          .fulfill({
            json: {
              user_id: userA,
              theme: "dark",
              appearance: { motion: "system", keyboard_shortcuts: true },
            },
          })
          .catch(() => {});
        answered.release();
      } else
        await route.fulfill({
          json: {
            user_id: userA,
            theme: "light",
            appearance: { motion: "system", keyboard_shortcuts: true },
          },
        });
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
              appearance: { motion: "system", keyboard_shortcuts: true },
            }
          : {
              user_id: userA,
              theme: "dark",
              appearance: { motion: "system", keyboard_shortcuts: true },
            },
      });
    });
    await page.goto("/settings/appearance");
    await expect(
      page.getByRole("button", { name: "Retry preferences", exact: true }),
    ).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(dark(page)).toBeDisabled();
    if (fault === "identity")
      await expect.poll(() => identity.checks).toBeGreaterThan(1);
    const beforeRetry = reads;
    recovered = true;
    await page
      .getByRole("button", { name: "Retry preferences", exact: true })
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
  let motion = "system";
  const writes: unknown[] = [];
  await page.route(`**${preferencePath(userA)}`, async (route) => {
    if (route.request().method() === "PATCH") {
      const body: unknown = route.request().postDataJSON();
      writes.push(body);
      if (typeof body !== "object" || body === null)
        throw new Error("Invalid preference command");
      if (
        "theme" in body &&
        (body.theme === "light" || body.theme === "dark")
      ) {
        await gate.promise;
        theme = body.theme;
      } else if (
        "appearance" in body &&
        typeof body.appearance === "object" &&
        body.appearance !== null &&
        "motion" in body.appearance &&
        body.appearance.motion === "reduce"
      )
        motion = "reduce";
      else throw new Error("Invalid preference command");
    }
    await route.fulfill({
      json: {
        user_id: userA,
        theme,
        appearance: { motion, keyboard_shortcuts: true },
      },
    });
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
    await page
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(
      page.getByText("Organization settings saved.", { exact: true }),
    ).toBeVisible();
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
    expect(writes).toEqual([
      { appearance: { motion: "reduce" } },
      { theme: "dark" },
    ]);
  } finally {
    gate.release();
  }
});

const fullPreference = (
  theme = "light",
  appearance: unknown = { motion: "system", keyboard_shortcuts: true },
) => ({ user_id: userA, theme, appearance });

test("System follows OS color without writes and explicit color stays fixed", async ({
  page,
}) => {
  await installIdentity(page);
  await page.emulateMedia({ colorScheme: "dark" });
  let theme = "system";
  const writes: unknown[] = [];
  await page.route(`**${preferencePath(userA)}`, async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { theme: string };
      writes.push(body);
      theme = body.theme;
    }
    await route.fulfill({ json: fullPreference(theme) });
  });
  await page.goto("/settings/appearance");
  await expect(dark(page)).toBeEnabled();
  await expect(
    page.getByRole("radio", { name: "System", exact: true }),
  ).toBeChecked();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  expect(writes).toEqual([]);
  await dark(page).click();
  await expect(dark(page)).toBeChecked();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(writes).toEqual([{ theme: "dark" }]);
});

for (const malformed of [
  fullPreference("dark", null),
  fullPreference("dark", { motion: "normal", keyboard_shortcuts: true }),
  fullPreference("dark", { motion: "system", keyboard_shortcuts: "false" }),
  fullPreference("dark", { motion: "system" }),
  fullPreference("dark", {
    motion: "system",
    keyboard_shortcuts: true,
    density: "compact",
  }),
  { ...fullPreference("dark"), density: "compact" },
]) {
  test(`strict preferences refuse malformed shape ${JSON.stringify(malformed)}`, async ({
    page,
  }) => {
    await installIdentity(page);
    await page.route(`**${preferencePath(userA)}`, (route) =>
      route.fulfill({ json: malformed }),
    );
    await page.goto("/settings/appearance");
    await expect(dark(page)).toBeDisabled();
    await expect(
      page.getByRole("alert").filter({ hasText: "could not be loaded" }),
    ).toContainText("could not be loaded");
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });
}

test("account motion and shortcut commands are partial and confirmed before preview", async ({
  page,
}) => {
  await installIdentity(page);
  let appearance = { motion: "system", keyboard_shortcuts: true };
  const writes: unknown[] = [];
  const hold = deferred();
  await page.route(`**${preferencePath(userA)}`, async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as {
        appearance: Partial<typeof appearance>;
      };
      writes.push(body);
      await hold.promise;
      appearance = { ...appearance, ...body.appearance };
    }
    await route.fulfill({ json: fullPreference("light", appearance) });
  });
  try {
    await page.goto("/settings/appearance");
    await expect(dark(page)).toBeEnabled();
    await page.getByRole("switch", { name: "Reduce motion" }).click();
    await expect.poll(() => writes.length).toBe(1);
    await expect(
      page.getByRole("switch", { name: "Reduce motion" }),
    ).not.toBeChecked();
    await expect(page.locator("html")).not.toHaveAttribute("data-motion");
    hold.release();
    await expect(
      page.getByRole("switch", { name: "Reduce motion" }),
    ).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute(
      "data-motion",
      "reduced",
    );
    await page.getByRole("switch", { name: "Convenience shortcuts" }).click();
    await expect(
      page.getByRole("switch", { name: "Convenience shortcuts" }),
    ).not.toBeChecked();
    expect(writes).toEqual([
      { appearance: { motion: "reduce" } },
      { appearance: { keyboard_shortcuts: false } },
    ]);
    await page.reload();
    await expect(
      page.getByRole("switch", { name: "Reduce motion" }),
    ).toBeChecked();
    await expect(
      page.getByRole("switch", { name: "Convenience shortcuts" }),
    ).not.toBeChecked();
  } finally {
    hold.release();
  }
});

test("device text and density scale pages without changing account preferences", async ({
  page,
}) => {
  await installIdentity(page);
  await page.addInitScript(() => {
    if (!localStorage.getItem("openslate-text-size"))
      localStorage.setItem("openslate-text-size", "125");
    if (!localStorage.getItem("openslate-density"))
      localStorage.setItem("openslate-density", "spacious");
  });
  let writes = 0;
  await page.route(`**${preferencePath(userA)}`, (route) => {
    if (route.request().method() === "PATCH") writes++;
    return route.fulfill({ json: fullPreference() });
  });
  await page.goto("/settings/appearance");
  await expect(dark(page)).toBeEnabled();
  await expect
    .poll(() =>
      page.locator("html").evaluate((node) => getComputedStyle(node).fontSize),
    )
    .toBe("20px");
  await expect(page.getByRole("combobox", { name: "Text size" })).toHaveValue(
    "125",
  );
  await expect(
    page.getByRole("combobox", { name: "Page spacing" }),
  ).toHaveValue("spacious");
  for (const name of ["Color", "Text and display", "Motion", "Keyboard"])
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Appearance preview" }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Text size" }).selectOption("112.5");
  await page
    .getByRole("combobox", { name: "Page spacing" })
    .selectOption("compact");
  await expect
    .poll(() =>
      page.locator("html").evaluate((node) => getComputedStyle(node).fontSize),
    )
    .toBe("18px");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Text size" })).toHaveValue(
    "112.5",
  );
  await expect(
    page.getByRole("combobox", { name: "Page spacing" }),
  ).toHaveValue("compact");
  expect(writes).toBe(0);
});

test("public prepaint resolves System and device text before hydration including blocked storage", async ({
  page,
}) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    localStorage.setItem("openslate-theme", "system");
    if (!localStorage.getItem("openslate-text-size"))
      localStorage.setItem("openslate-text-size", "125");
    if (!localStorage.getItem("openslate-density"))
      localStorage.setItem("openslate-density", "spacious");
    localStorage.setItem("openslate-org-theme", "whiteboard");
  });
  await page.route("**/_next/**/*.js*", (route) => route.abort());
  await page.goto("/login");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect
    .poll(() =>
      page.locator("html").evaluate((node) => getComputedStyle(node).fontSize),
    )
    .toBe("20px");
  await expect(page.locator("html")).toHaveAttribute(
    "data-density",
    "spacious",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "whiteboard",
  );
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
  });
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect
    .poll(() =>
      page.locator("html").evaluate((node) => getComputedStyle(node).fontSize),
    )
    .toBe("16px");
});

test("blocked device storage still applies text and spacing without claiming persistence", async ({
  page,
}) => {
  await installIdentity(page);
  await page.goto("/settings/appearance");
  await expect(dark(page)).toBeEnabled();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };
  });
  await page.getByRole("combobox", { name: "Text size" }).selectOption("125");
  await page
    .getByRole("combobox", { name: "Page spacing" })
    .selectOption("spacious");
  await expect
    .poll(() =>
      page.locator("html").evaluate((el) => getComputedStyle(el).fontSize),
    )
    .toBe("20px");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Browser storage is unavailable" }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(
      new StorageEvent("storage", { key: "openslate-theme" }),
    ),
  );
  await expect(page.getByRole("combobox", { name: "Text size" })).toHaveValue(
    "125",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-density",
    "spacious",
  );
});

test("Compact spacing respects 1279 and 1280 fine-pointer admission and device storage synchronization", async ({
  page,
}) => {
  await installIdentity(page);
  await page.setViewportSize({ width: 1279, height: 900 });
  await page.goto("/settings/appearance");
  const density = page.getByRole("combobox", { name: "Page spacing" });
  await density.selectOption("compact");
  const padding = () =>
    page
      .locator("#main-content")
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  const baseline = await padding();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(padding).toBeLessThan(baseline);
  await expect(density).toHaveValue("compact");
  const color = await page.locator("html").getAttribute("class");
  await page.evaluate(() => {
    localStorage.setItem("openslate-text-size", "112.5");
    localStorage.setItem("openslate-density", "spacious");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "openslate-text-size" }),
    );
  });
  await expect(page.getByRole("combobox", { name: "Text size" })).toHaveValue(
    "112.5",
  );
  await expect(density).toHaveValue("spacious");
  await expect
    .poll(() =>
      page.locator("html").evaluate((el) => getComputedStyle(el).fontSize),
    )
    .toBe("18px");
  await expect(page.locator("html")).toHaveAttribute("class", color ?? "");
});

test.describe("coarse pointer device spacing", () => {
  test.use({ hasTouch: true });
  test("stored Compact renders Default on a wide touch screen", async ({
    page,
  }) => {
    await installIdentity(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings/appearance");
    const density = page.getByRole("combobox", { name: "Page spacing" });
    const padding = () =>
      page
        .locator("#main-content")
        .evaluate((el) => getComputedStyle(el).paddingLeft);
    const before = await padding();
    await density.selectOption("compact");
    expect(await padding()).toBe(before);
    await expect(density).toHaveValue("compact");
    await expect(
      page.getByText(/Compact applies on wide screens/),
    ).toBeVisible();
  });
});

test("forced colors and increased contrast keep focus and borders visible at Larger text", async ({
  page,
}) => {
  await installIdentity(page);
  await page.goto("/settings/appearance");
  const select = page.getByRole("combobox", { name: "Text size" });
  await select.selectOption("125");
  await page.emulateMedia({ forcedColors: "active" });
  await select.focus();
  const forced = await select.evaluate((el) => ({
    width: getComputedStyle(el).outlineWidth,
    style: getComputedStyle(el).outlineStyle,
    border: getComputedStyle(el).borderTopColor,
  }));
  expect(forced.width).not.toBe("0px");
  expect(forced.style).not.toBe("none");
  expect(forced.border).not.toBe("transparent");
  await page.emulateMedia({ forcedColors: "none", contrast: "more" });
  const colors = await select.evaluate((el) => ({
    border: getComputedStyle(el).borderTopColor,
    ink: getComputedStyle(el).color,
  }));
  expect(colors.border).toBe(colors.ink);
  expect((await select.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test("Retry keeps account controls locked until its authoritative read completes", async ({
  page,
}) => {
  await installIdentity(page);
  const hold = deferred();
  const started = deferred();
  let failed = false;
  let writes = 0;
  await page.route(`**${preferencePath(userA)}`, async (route) => {
    if (route.request().method() === "PATCH") {
      writes++;
      failed = true;
      return route.fulfill({
        status: 503,
        json: { detail: "Private persistence failure" },
      });
    }
    if (failed) {
      started.release();
      await hold.promise;
    }
    return route.fulfill({ json: fullPreference(failed ? "dark" : "light") });
  });
  try {
    await page.goto("/settings/appearance");
    await expect(light(page)).toBeChecked();
    await dark(page).click();
    await page
      .getByRole("button", { name: "Retry preferences", exact: true })
      .click();
    await started.promise;
    await expect(
      page.getByRole("button", { name: "Retry preferences", exact: true }),
    ).toBeHidden();
    await expect(dark(page)).toBeDisabled();
    await expect(
      page.getByRole("switch", { name: "Reduce motion" }),
    ).toBeDisabled();
    await expect(light(page)).toBeChecked();
    expect(writes).toBe(1);
    hold.release();
    await expect(dark(page)).toBeChecked();
    await expect(dark(page)).toBeEnabled();
    expect(writes).toBe(1);
  } finally {
    hold.release();
  }
});

test("a write completing behind the session curtain waits for a fresh verified read", async ({
  page,
}) => {
  await installIdentity(page);
  const verification = deferred();
  const write = deferred();
  const writing = deferred();
  const fresh = deferred();
  const freshRequested = deferred();
  let holdVerification = false;
  let completed = false;
  let writes = 0;
  await page.route("**/api/auth/session", async (route) => {
    if (holdVerification) await verification.promise;
    return route.fulfill({
      json: { authenticated: true, user_id: userA, setup_required: false },
    });
  });
  await page.route(`**${preferencePath(userA)}`, async (route) => {
    if (route.request().method() === "PATCH") {
      writes++;
      writing.release();
      await write.promise;
      completed = true;
    } else if (completed) {
      freshRequested.release();
      await fresh.promise;
    }
    await route.fulfill({ json: fullPreference(completed ? "dark" : "light") });
  });
  try {
    await page.goto("/settings/appearance");
    await expect(light(page)).toBeChecked();
    await dark(page).click();
    await writing.promise;
    holdVerification = true;
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    await expect(
      page.getByText("Checking your session…", { exact: true }),
    ).toBeVisible();
    const returned = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === preferencePath(userA) &&
        response.request().method() === "PATCH",
    );
    write.release();
    await returned;
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    verification.release();
    await freshRequested.promise;
    await expect(
      page.getByText("Checking your session…", { exact: true }),
    ).toBeHidden();
    await expect(dark(page)).toBeDisabled();
    await expect(light(page)).toBeChecked();
    fresh.release();
    await expect(dark(page)).toBeChecked();
    await expect(dark(page)).toBeEnabled();
    expect(writes).toBe(1);
  } finally {
    verification.release();
    write.release();
    fresh.release();
  }
});

test("appearance switches keep their thumbs inside the track and a 44 pixel hit area at density extremes", async ({
  page,
}) => {
  await installIdentity(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings/appearance");
  await page.getByRole("combobox", { name: "Text size" }).selectOption("125");
  await page
    .getByRole("combobox", { name: "Page spacing" })
    .selectOption("spacious");
  const toggle = page.getByRole("switch", { name: "Convenience shortcuts" });
  await expect(toggle).toBeEnabled();
  const track = await toggle.boundingBox();
  const thumb = await toggle
    .locator('[data-slot="switch-thumb"]')
    .boundingBox();
  if (!track || !thumb) throw new Error("Switch geometry missing");
  expect(thumb.height).toBeLessThanOrEqual(track.height);
  await page.getByRole("combobox", { name: "Text size" }).selectOption("100");
  await page
    .getByRole("combobox", { name: "Page spacing" })
    .selectOption("compact");
  const box = await toggle.boundingBox();
  if (!box) throw new Error("Switch hit target missing");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 21);
  await expect(toggle).not.toBeChecked();
});

test("an ordinary preference GET completing behind the curtain requires a fresh verified read", async ({
  page,
}) => {
  await installIdentity(page);
  const verification = deferred();
  const ordinary = deferred();
  const fresh = deferred();
  let holdVerification = false;
  let reads = 0;
  let writes = 0;
  let phase: "bootstrap" | "ordinary" | "fresh" = "bootstrap";
  await page.route("**/api/auth/session", async (route) => {
    if (holdVerification) await verification.promise;
    return route.fulfill({
      json: { authenticated: true, user_id: userA, setup_required: false },
    });
  });
  await page.route(`**${preferencePath(userA)}`, async (route) => {
    if (route.request().method() !== "GET") {
      writes += 1;
      return route.fulfill({ status: 405 });
    }
    reads += 1;
    const requestPhase = phase;
    if (requestPhase === "ordinary") await ordinary.promise;
    if (requestPhase === "fresh") await fresh.promise;
    return route.fulfill({
      json: fullPreference(requestPhase === "ordinary" ? "dark" : "light"),
    });
  });
  try {
    // Finish bootstrap before admitting either held request.
    await page.goto("/settings/appearance");
    await expect(light(page)).toBeChecked();
    await expect(dark(page)).toBeEnabled();
    const bootstrapReads = reads;
    phase = "ordinary";
    await page.evaluate(() =>
      window.dispatchEvent(
        new StorageEvent("storage", { key: "openslate-theme" }),
      ),
    );
    await expect.poll(() => reads).toBe(bootstrapReads + 1);
    holdVerification = true;
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    const curtain = page.getByText("Checking your session…", { exact: true });
    await expect(curtain).toBeVisible();
    const returned = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === preferencePath(userA) &&
        response.request().method() === "GET",
    );
    ordinary.release();
    const response = await returned;
    await response.finished();
    await expect(curtain).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    phase = "fresh";
    verification.release();
    await expect(curtain).toBeHidden();
    // The prospective post-verification GET is held: resuming must not admit account commands.
    await expect.poll(() => reads).toBe(bootstrapReads + 2);
    await expect(dark(page)).toBeDisabled();
    await expect(light(page)).toBeChecked();
    await expect(
      page.getByRole("switch", { name: "Reduce motion" }),
    ).toBeDisabled();
    fresh.release();
    await expect(light(page)).toBeChecked();
    await expect(dark(page)).toBeEnabled();
    expect(writes).toBe(0);
  } finally {
    verification.release();
    ordinary.release();
    fresh.release();
  }
});

test("More contrast preserves the enabled unchecked Dark Slate switch cue", async ({
  page,
}) => {
  await installIdentity(page);
  await page.route(`**${preferencePath(userA)}`, (route) =>
    route.fulfill({
      json: fullPreference("dark"),
    }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("openslate-text-size", "125");
    localStorage.setItem("openslate-density", "spacious");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/appearance");
  const toggle = page.getByRole("switch", {
    name: "Reduce motion",
    exact: true,
  });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await expect(page.locator("html")).toHaveClass(/dark/);
  for (const contrast of ["no-preference", "more"] as const) {
    await page.emulateMedia({ contrast });
    await page
      .getByRole("combobox", { name: "Page spacing", exact: true })
      .focus();
    await page.keyboard.press("Tab");
    await expect(toggle).toBeFocused();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    await expect
      .poll(() =>
        toggle.evaluate(
          (element) => element.getAnimations({ subtree: true }).length,
        ),
      )
      .toBe(0);
    const ratio = await toggle.evaluate((element) => {
      const thumb = element.querySelector('[data-slot="switch-thumb"]');
      const card = element.closest('[data-slot="card"]');
      if (!thumb || !card)
        throw new Error("Rendered switch colors unavailable");
      const trackCss = getComputedStyle(element).backgroundColor;
      const thumbCss = getComputedStyle(thumb).backgroundColor;
      const adjacentCss = getComputedStyle(card).backgroundColor;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Browser color composition unavailable");
      const pixel = (background: string, foreground: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = background;
        context.fillRect(0, 0, 1, 1);
        context.fillStyle = foreground;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const trackRgb = pixel(adjacentCss, trackCss);
      const thumbRgb = pixel(`rgb(${trackRgb.join(" ")})`, thumbCss);
      const luminance = (rgb: number[]) =>
        rgb
          .map((value) => value / 255)
          .map((value) =>
            value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
          )
          .reduce(
            (sum, value, index) =>
              sum + value * [0.2126, 0.7152, 0.0722][index],
            0,
          );
      const track = luminance(trackRgb);
      const foreground = luminance(thumbRgb);
      return (
        (Math.max(track, foreground) + 0.05) /
        (Math.min(track, foreground) + 0.05)
      );
    });
    expect(
      ratio,
      `${contrast} unchecked thumb/track cue`,
    ).toBeGreaterThanOrEqual(3);
  }
});
