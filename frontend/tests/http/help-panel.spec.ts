import {
  expect,
  heldResponse,
  test,
  type Page,
  type Route,
} from "./helpers/test";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import { wireWorkspace } from "../helpers/wire";

test.use({ trace: "off", screenshot: "off", video: "off" });

const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
// Literal server DTOs, independent of the new Help projection and guide registry.
const fullWorkspace = wireWorkspace({
  id: "00000000-0000-4000-8000-000000000102",
  display_name: "Help fixture workspace",
  legal_name: "Private legal name",
  description: "Private organization description",
  contact_email: "administrator@example.test",
  contact_phone: "+1 555 0142",
  postal_address: "Private postal address",
  locale: "en-PH",
  timezone: "Asia/Manila",
  mark: "HW",
  currency: "PHP",
  revision: 4,
  today: "2026-10-06",
  purge_enabled: false,
});
const guestWorkspace = {
  id: "00000000-0000-4000-8000-000000000102",
  display_name: "Help fixture workspace",
  legal_name: "Private legal name",
  description: "Private organization description",
  logo_file_id: null,
  locale: "en-PH",
  timezone: "Asia/Manila",
  mark: "HW",
  currency: "PHP",
  week_start: "monday",
  business_hours: "09:00–18:00",
  theme: "slate",
  revision: 4,
  today: "2026-10-06",
  purge_enabled: false,
};

async function installHelpApi(page: Page) {
  const api = {
    userId: userA,
    role: "member" as "admin" | "member" | "guest",
    theme: "light" as "light" | "dark",
    shortcuts: true,
    workspace: { ...fullWorkspace } as Record<string, unknown>,
    reads: 0,
    aborts: 0,
    writes: [] as string[],
    onRead: null as ((route: Route) => Promise<void>) | null,
    onPreferences: null as ((route: Route) => Promise<void>) | null,
    onSession: null as ((route: Route) => Promise<void>) | null,
  };
  await page.exposeFunction("noteWorkspaceAbort", () => {
    api.aborts += 1;
  });
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url, location.href).pathname === "/api/workspace")
        init?.signal?.addEventListener(
          "abort",
          () => {
            void (
              window as Window & { noteWorkspaceAbort?: () => Promise<void> }
            ).noteWorkspaceAbort?.();
          },
          { once: true },
        );
      return nativeFetch(input, init);
    };
  });
  await installOpenViewEventSource(page);
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith("/api/") &&
      !["GET", "HEAD"].includes(request.method())
    )
      api.writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.route("**/api/auth/session", (route) =>
    api.onSession
      ? api.onSession(route)
      : route.fulfill({
          json: {
            authenticated: true,
            user_id: api.userId,
            default_organization_blocked: null,
            setup_required: false,
          },
        }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        id: api.userId,
        role: api.role,
        access: [],
        default_organization_blocked: null,
      },
    }),
  );
  await page.route("**/api/users/*/preferences", (route) =>
    api.onPreferences
      ? api.onPreferences(route)
      : route.fulfill({
          json: {
            user_id: api.userId,
            theme: api.theme,
            appearance: {
              motion: "reduce",
              keyboard_shortcuts: api.shortcuts,
              timezone: null,
              date_format: "organization",
              time_format: "organization",
              week_start: "organization",
              start_page: "automatic",
            },
          },
        }),
  );
  await page.route("**/api/workspace", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    api.reads += 1;
    return api.onRead
      ? api.onRead(route)
      : route.fulfill({ json: api.workspace });
  });
  return api;
}

const sheet = (page: Page) =>
  page.getByRole("dialog", { name: "Help", exact: true });
const contact = (page: Page) =>
  sheet(page).getByRole("region", {
    name: "Contact your administrator",
    exact: true,
  });
const shortcuts = (page: Page) =>
  sheet(page).getByRole("region", { name: "Keyboard shortcuts", exact: true });
async function openHelp(page: Page) {
  const trigger = page.getByRole("button", { name: "Help", exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(sheet(page)).toBeVisible();
}
async function visitPlatform(page: Page) {
  await page.goto("/platform");
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", {
      name: "Primary sidebar",
      exact: true,
      includeHidden: true,
    }),
  ).toContainText("Help fixture workspace");
}

// Every page's guide is a row of isolated/shell/help-guides.spec.ts; this
// journey proves the sheet renders the guide of the open page.
test("Help canonical guide /access has three to six honest task entries", async ({
  page,
}) => {
  const api = await installHelpApi(page);
  api.role = "admin";
  await page.goto("/access");
  await openHelp(page);
  const guide = sheet(page).getByRole("region", {
    name: "This page",
    exact: true,
  });
  await expect(guide).toBeVisible();
  for (const task of [/people/i, /group|access/i])
    await expect(guide).toContainText(task);
  const entries = guide.getByRole("listitem");
  await expect.poll(() => entries.count()).toBeGreaterThanOrEqual(3);
  await expect.poll(() => entries.count()).toBeLessThanOrEqual(6);
  expect(api.writes).toEqual([]);
});

test("Help keyboard opening traps focus and Escape returns to the header without a command", async ({
  page,
}) => {
  const api = await installHelpApi(page);
  await visitPlatform(page);
  const trigger = page.getByRole("button", { name: "Help", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(sheet(page)).toBeVisible();
  await expect
    .poll(() =>
      sheet(page).evaluate((el) => el.contains(document.activeElement)),
    )
    .toBe(true);
  for (let tab = 0; tab < 8; tab += 1) {
    await page.keyboard.press("Tab");
    await expect
      .poll(() =>
        sheet(page).evaluate((el) => el.contains(document.activeElement)),
      )
      .toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Space");
  await expect(sheet(page)).toBeVisible();
  expect(api.writes).toEqual([]);
});

test("Help fits a phone and lists the existing Sandbox Build keys, not a new global or Comms dispatcher", async ({
  page,
}) => {
  const api = await installHelpApi(page);
  api.workspace = {
    ...fullWorkspace,
    contact_email:
      "organization-administrator-with-a-long-contact-name@example.test",
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await visitPlatform(page);
  await openHelp(page);
  for (const text of [
    "Sandbox",
    "Build",
    "?",
    "0",
    "Delete",
    "F2",
    "Undo",
    "Redo",
  ])
    await expect(shortcuts(page)).toContainText(text);
  await expect(shortcuts(page)).not.toContainText(
    /new message|search messages/i,
  );
  await expect(contact(page)).toContainText(
    "organization-administrator-with-a-long-contact-name@example.test",
  );
  const metrics = await sheet(page).evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      width: el.clientWidth,
      contentWidth: el.scrollWidth,
      viewportWidth: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
    };
  });
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.contentWidth).toBeLessThanOrEqual(metrics.width);
  expect(metrics.pageWidth).toBeLessThanOrEqual(metrics.viewportWidth);
  await contact(page).scrollIntoViewIfNeeded();
  await expect(contact(page)).toBeInViewport();
  const profile = shortcuts(page).getByRole("link", { name: /profile/i });
  await profile.scrollIntoViewIfNeeded();
  await expect(profile).toBeInViewport();
  expect((await profile.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const close = sheet(page).getByRole("button", { name: /close/i });
  await close.scrollIntoViewIfNeeded();
  await expect(close).toBeInViewport();
  expect((await close.boundingBox())?.height).toBeGreaterThanOrEqual(44);
});

test("Help off text links to Profile and updates its guide after client navigation", async ({
  page,
}) => {
  const api = await installHelpApi(page);
  api.shortcuts = false;
  await visitPlatform(page);
  await openHelp(page);
  await expect(shortcuts(page)).toContainText(
    "Shortcuts are off. Turn them on in your profile.",
  );
  const profile = shortcuts(page).getByRole("link", { name: /profile/i });
  await expect(profile).toHaveAttribute("href", /^\/profile(?:#look)?$/);
  await profile.click();
  await expect(page).toHaveURL(/\/profile(?:#look)?$/);
  await expect(sheet(page)).toBeHidden();
  await openHelp(page);
  await expect(
    sheet(page).getByRole("region", { name: "This page", exact: true }),
  ).toContainText(/identity|profile/i);
  expect(api.writes).toEqual([]);
});

test("Help pending preferences never claim shortcuts are on or off before confirmation", async ({
  page,
}) => {
  const api = await installHelpApi(page);
  const hold = heldResponse();
  api.onPreferences = async (route) => {
    hold.enter();
    await hold.released;
    await route.fulfill({
      json: {
        user_id: userA,
        theme: "light",
        appearance: { motion: "reduce", keyboard_shortcuts: false },
      },
    });
  };
  try {
    await visitPlatform(page);
    await hold.entered;
    await openHelp(page);
    await expect(shortcuts(page)).toContainText(/loading|confirm/i);
    await expect(shortcuts(page)).not.toContainText("Shortcuts are off.");
    hold.release();
    await expect(shortcuts(page)).toContainText(
      "Shortcuts are off. Turn them on in your profile.",
    );
  } finally {
    hold.release();
  }
});

test("Help failed preferences explain recovery without claiming enabled keys or perpetual loading", async ({
  page,
}) => {
  const api = await installHelpApi(page);
  api.onPreferences = (route) =>
    route.fulfill({
      status: 503,
      json: { detail: "Private preference canary" },
    });
  await visitPlatform(page);
  await openHelp(page);
  await expect(shortcuts(page)).toContainText(/preferences are unavailable/i);
  await expect(shortcuts(page)).not.toContainText(
    /loading|Private preference canary|F2/,
  );
  await expect(shortcuts(page)).toContainText("Undo");
  await expect(
    shortcuts(page).getByRole("link", { name: /profile/i }),
  ).toBeVisible();
  expect(api.writes).toEqual([]);
});

test("Help reads contacts afresh on open without using the branding payload", async ({
  page,
}) => {
  const api = await installHelpApi(page);
  await visitPlatform(page);
  const before = api.reads;
  api.workspace = {
    ...fullWorkspace,
    contact_email: "fresh-contact@example.test",
    contact_phone: "+1 555 0143",
  };
  await openHelp(page);
  await expect(contact(page)).toContainText("fresh-contact@example.test");
  await expect(contact(page)).toContainText("+1 555 0143");
  expect(api.reads).toBeGreaterThan(before);
  await expect(sheet(page)).not.toContainText("administrator@example.test");
  for (const privateText of [
    "Private legal name",
    "Private organization description",
    "Private postal address",
  ])
    await expect(sheet(page)).not.toContainText(privateText);
  expect(api.writes).toEqual([]);
  expect(
    await page.evaluate(() =>
      [...Object.values(localStorage), ...Object.values(sessionStorage)].join(
        " ",
      ),
    ),
  ).not.toContain("fresh-contact@example.test");
});

for (const shape of ["null", "guest"] as const) {
  test(`Help ${shape} contacts distinguish unconfigured from role omission`, async ({
    page,
  }) => {
    const api = await installHelpApi(page);
    api.workspace =
      shape === "guest"
        ? { ...guestWorkspace }
        : { ...fullWorkspace, contact_email: null, contact_phone: null };
    if (shape === "guest") api.role = "guest";
    await visitPlatform(page);
    await openHelp(page);
    await expect(contact(page)).toContainText(
      shape === "guest"
        ? "Contact the person who invited you."
        : /not (?:been )?(?:set|configured)|no .*contact/i,
    );
    await expect(contact(page)).not.toContainText("administrator@example.test");
    await expect(contact(page)).not.toContainText("+1 555 0142");
    await expect(contact(page).getByRole("link")).toHaveCount(0);
    expect(api.writes).toEqual([]);
  });
}

test("Help same-revision guest response replaces member contacts during invalidation", async ({
  page,
}) => {
  const api = await installHelpApi(page);
  await visitPlatform(page);
  await openHelp(page);
  await expect(contact(page)).toContainText("administrator@example.test");
  api.workspace = { ...guestWorkspace };
  await sendOpenViewEvent(page, "invalidate", { entity: "users" });
  await expect(contact(page)).toContainText(
    "Contact the person who invited you.",
  );
  await expect(contact(page)).not.toContainText("administrator@example.test");
  await expect(contact(page)).not.toContainText("+1 555 0142");
  expect(api.writes).toEqual([]);
});

test("Help expired-session 401 keeps the global login handoff and removes private contacts", async ({
  page,
}) => {
  const api = await installHelpApi(page);
  await visitPlatform(page);
  await openHelp(page);
  await expect(contact(page)).toContainText("administrator@example.test");
  await page.keyboard.press("Escape");
  const hold = heldResponse();
  api.onSession = (route) => route.fulfill({ json: { authenticated: false } });
  await page.route("**/api/auth/refresh", (route) =>
    route.fulfill({ status: 401, json: { detail: "Session expired" } }),
  );
  api.onRead = async (route) => {
    hold.enter();
    await hold.released;
    await route.fulfill({
      status: 401,
      json: { detail: "Private failure canary" },
    });
  };
  try {
    await openHelp(page);
    await hold.entered;
    await expect(contact(page)).not.toContainText("administrator@example.test");
    hold.release();
    await expect(page).toHaveURL(/\/login$/);
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(
      "administrator@example.test",
    );
    await expect(page.locator("body")).not.toContainText("+1 555 0142");
    await expect(page.locator("body")).not.toContainText(
      "Private failure canary",
    );
    expect(api.writes).toEqual(["POST /api/auth/refresh"]);
  } finally {
    hold.release();
  }
});

for (const fault of [403, 503, "malformed"] as const) {
  test(`Help contact ${fault} hides cached data and Retry recovers without raw details`, async ({
    page,
  }) => {
    const api = await installHelpApi(page);
    await visitPlatform(page);
    await openHelp(page);
    await expect(contact(page)).toContainText("administrator@example.test");
    await page.keyboard.press("Escape");
    api.onRead = (route) => {
      if (typeof fault === "number")
        return route.fulfill({
          status: fault,
          json: { detail: "Private failure canary" },
        });
      return route.fulfill({
        json: {
          ...fullWorkspace,
          contact_email: { secret: "Private failure canary" },
        },
      });
    };
    await openHelp(page);
    await expect(contact(page).getByRole("alert")).toBeVisible();
    await expect(contact(page)).not.toContainText("administrator@example.test");
    await expect(contact(page)).not.toContainText("+1 555 0142");
    await expect(sheet(page)).not.toContainText("Private failure canary");
    api.onRead = null;
    api.workspace = {
      ...fullWorkspace,
      contact_email: "recovered@example.test",
    };
    await contact(page)
      .getByRole("button", { name: "Retry", exact: true })
      .click();
    await expect(contact(page)).toContainText("recovered@example.test");
    await expect(contact(page).getByRole("alert")).toHaveCount(0);
    expect(api.writes).toEqual([]);
  });
}

test("Help reopens with hidden cached contacts while the fresh read is pending", async ({
  page,
}) => {
  const api = await installHelpApi(page);
  await visitPlatform(page);
  await openHelp(page);
  await expect(contact(page)).toContainText("administrator@example.test");
  await page.keyboard.press("Escape");
  const hold = heldResponse();
  api.onRead = async (route) => {
    hold.enter();
    await hold.released;
    await route.fulfill({
      json: { ...fullWorkspace, contact_email: "new@example.test" },
    });
  };
  try {
    await openHelp(page);
    await hold.entered;
    await expect(contact(page)).toContainText(/loading|checking/i);
    await expect(contact(page)).not.toContainText("administrator@example.test");
    hold.release();
    await expect(contact(page)).toContainText("new@example.test");
    expect(api.writes).toEqual([]);
  } finally {
    hold.release();
  }
});

test("Help opaque workspace invalidation refreshes contacts but never discards a Manage draft", async ({
  page,
}) => {
  const api = await installHelpApi(page);
  api.role = "admin";
  await page.goto("/manage?view=organization");
  await expect(page.getByLabel("Legal name", { exact: true })).toHaveValue(
    "Private legal name",
  );
  await page
    .getByLabel("Legal name", { exact: true })
    .fill("Retained organization draft");
  await openHelp(page);
  await expect(contact(page)).toContainText("administrator@example.test");
  api.workspace = { ...fullWorkspace, contact_email: "updated@example.test" };
  await sendOpenViewEvent(page, "invalidate", { entity: "workspace_profiles" });
  await expect(contact(page)).toContainText("updated@example.test");
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Legal name", { exact: true })).toHaveValue(
    "Retained organization draft",
  );
  expect(api.writes).toEqual([]);
});

test("Help never resurrects a full Manage profile through its higher cached revision", async ({
  page,
}) => {
  const api = await installHelpApi(page);
  api.role = "admin";
  await page.goto("/manage?view=organization");
  await expect(page.getByLabel("Contact email", { exact: true })).toHaveValue(
    "administrator@example.test",
  );
  await page
    .getByRole("link", { name: "Search workspace", exact: true })
    .click();
  await expect(page).toHaveURL(/\/platform$/);
  api.workspace = { ...guestWorkspace, revision: 3 };
  await openHelp(page);
  await expect(contact(page)).toContainText(
    "Contact the person who invited you.",
  );
  await expect(contact(page)).not.toContainText("administrator@example.test");
  expect(api.writes).toEqual([]);
});

test("Help Profile link asks before discarding a Manage draft and resumes only on confirmation", async ({
  page,
}) => {
  const api = await installHelpApi(page);
  api.role = "admin";
  api.shortcuts = false;
  await page.goto("/manage?view=organization");
  await page
    .getByLabel("Legal name", { exact: true })
    .fill("Retained Help navigation draft");
  await openHelp(page);
  await shortcuts(page)
    .getByRole("link", { name: /profile/i })
    .click();
  const guard = page.getByRole("alertdialog", {
    name: "Discard unsaved Manage changes?",
    exact: true,
  });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: /keep editing|cancel/i }).click();
  await expect(page).toHaveURL(/\/manage\?view=organization$/);
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Legal name", { exact: true })).toHaveValue(
    "Retained Help navigation draft",
  );
  await openHelp(page);
  await shortcuts(page)
    .getByRole("link", { name: /profile/i })
    .click();
  await guard.getByRole("button", { name: /discard/i }).click();
  await expect(page).toHaveURL(/\/profile(?:#look)?$/);
  await expect(sheet(page)).toBeHidden();
  expect(api.writes).toEqual([]);
});

for (const boundary of ["close", "account", "curtain"] as const) {
  test(`Help ${boundary} aborts a held read and fences its late private response`, async ({
    page,
  }) => {
    const api = await installHelpApi(page);
    await visitPlatform(page);
    const hold = heldResponse();
    const session = heldResponse();
    const aborts = api.aborts;
    api.onRead = async (route) => {
      hold.enter();
      await hold.released;
      // A cancelled intercepted request may no longer be fulfillable.
      await route
        .fulfill({
          json: {
            ...fullWorkspace,
            contact_email: "late-private@example.test",
          },
        })
        .catch(() => {});
    };
    try {
      await openHelp(page);
      await hold.entered;
      if (boundary === "close") await page.keyboard.press("Escape");
      else {
        if (boundary === "account") {
          api.userId = userB;
          api.role = "guest";
        }
        api.onSession = async (route) => {
          session.enter();
          await session.released;
          await route.fulfill({
            json: {
              authenticated: true,
              user_id: api.userId,
              default_organization_blocked: null,
              setup_required: false,
            },
          });
        };
        await page.evaluate(() =>
          window.dispatchEvent(new Event("openslate:session-recheck")),
        );
        await session.entered;
        await expect(
          page.getByText("Checking your session…", { exact: true }),
        ).toBeVisible();
      }
      await expect.poll(() => api.aborts).toBeGreaterThan(aborts);
      await expect(sheet(page)).toBeHidden();
      hold.release();
      api.onRead = null;
      api.workspace =
        boundary === "account"
          ? { ...guestWorkspace }
          : { ...fullWorkspace, contact_email: "current@example.test" };
      session.release();
      await expect(
        page.getByText("Checking your session…", { exact: true }),
      ).toBeHidden();
      await page.keyboard.press("Escape");
      await openHelp(page);
      await expect(contact(page)).toContainText(
        boundary === "account"
          ? "Contact the person who invited you."
          : "current@example.test",
      );
      await expect(sheet(page)).not.toContainText("late-private@example.test");
      expect(api.writes).toEqual([]);
    } finally {
      hold.release();
      session.release();
    }
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Help long contact fits ${viewport.width}x${viewport.height} in ${theme}`, async ({
      page,
    }) => {
      const api = await installHelpApi(page);
      api.workspace = {
        ...fullWorkspace,
        contact_email:
          "organization-administrator-with-a-long-contact-name@example.test",
      };
      api.theme = theme;
      await page.setViewportSize(viewport);
      await visitPlatform(page);
      await expect(page.locator("html")).toHaveClass(
        theme === "dark" ? /dark/ : /^(?!.*\bdark\b).*$/,
      );
      await openHelp(page);
      for (const text of [
        "Sandbox",
        "Build",
        "?",
        "0",
        "Delete",
        "F2",
        "Undo",
        "Redo",
      ])
        await expect(shortcuts(page)).toContainText(text);
      await expect(shortcuts(page)).not.toContainText(
        /new message|search messages/i,
      );
      await expect(contact(page)).toContainText(
        "organization-administrator-with-a-long-contact-name@example.test",
      );
      const metrics = await sheet(page).evaluate((el) => {
        const bounds = el.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          width: el.clientWidth,
          contentWidth: el.scrollWidth,
          viewportWidth: innerWidth,
          pageWidth: document.documentElement.scrollWidth,
        };
      });
      expect(metrics.left).toBeGreaterThanOrEqual(0);
      expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth);
      expect(metrics.contentWidth).toBeLessThanOrEqual(metrics.width);
      expect(metrics.pageWidth).toBeLessThanOrEqual(metrics.viewportWidth);
      await contact(page).scrollIntoViewIfNeeded();
      await expect(contact(page)).toBeInViewport();
      const profile = shortcuts(page).getByRole("link", { name: /profile/i });
      await profile.scrollIntoViewIfNeeded();
      await expect(profile).toBeInViewport();
      expect((await profile.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await sheet(page)
        .getByRole("button", { name: /close/i })
        .scrollIntoViewIfNeeded();
      await expect(
        sheet(page).getByRole("button", { name: /close/i }),
      ).toBeInViewport();
      expect(
        (
          await sheet(page)
            .getByRole("button", { name: /close/i })
            .boundingBox()
        )?.height,
      ).toBeGreaterThanOrEqual(44);
    });
  }
}
