import {
  appearanceUrl,
  authMeBody,
  expect,
  heldResponse,
  test,
  type Page,
  type Route,
} from "./helpers/test";
import { installOpenViewEventSource } from "./helpers/openview-event-source";

test.use({ trace: "off", screenshot: "off", video: "off" });

const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const cacheKey = "openslate-org-theme";
const themes = ["slate", "whiteboard", "triplicate", "stockroom"] as const;
type Theme = (typeof themes)[number];
const initialWorkspace = {
  id: "44444444-4444-4444-8444-444444444444",
  display_name: "Organization theme journey",
  legal_name: null,
  description: null,
  contact_email: null,
  contact_phone: null,
  postal_address: null,
  locale: "en-GB",
  timezone: "UTC",
  logo_file_id: null,
  mark: "TH",
  currency: "PHP",
  week_start: "monday",
  business_hours: "09:00–18:00",
  theme: "slate" as Theme,
  revision: 4,
};
type Workspace = typeof initialWorkspace;
type State = {
  userId: string;
  role: "admin" | "member" | "guest";
  authenticated: boolean;
  workspace: Workspace;
  writes: Record<string, unknown>[];
  appearanceReads: number;
  refreshes: number;
  onAppearance: ((route: Route) => Promise<void>) | null;
  onWorkspace:
    ((route: Route, snapshot: Record<string, unknown>) => Promise<void>) | null;
  onPatch:
    ((route: Route, body: Record<string, unknown>) => Promise<void>) | null;
  onSession: ((route: Route) => Promise<void>) | null;
};

async function installApi(page: Page): Promise<State> {
  await installOpenViewEventSource(page);
  await page.route("**/api/auth/sessions", (route) =>
    route.fulfill({ json: [] }),
  );
  const state: State = {
    userId: userA,
    role: "admin",
    authenticated: true,
    workspace: { ...initialWorkspace },
    writes: [],
    appearanceReads: 0,
    refreshes: 0,
    onAppearance: null,
    onWorkspace: null,
    onPatch: null,
    onSession: null,
  };
  await page.route("**/api/auth/session", (route) =>
    state.onSession
      ? state.onSession(route)
      : route.fulfill({
          json: {
            authenticated: state.authenticated,
            user_id: state.authenticated ? state.userId : null,
            default_organization_blocked: null,
            setup_required: false,
          },
        }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authMeBody({
        id: state.userId,
        role: state.role,
        access: [],
        default_organization_blocked: null,
      }),
    }),
  );
  await page.route("**/api/auth/refresh", (route) => {
    state.refreshes += 1;
    return route.fulfill({ status: 401, json: { detail: "Unauthenticated" } });
  });
  await page.route(appearanceUrl, (route) => {
    state.appearanceReads += 1;
    return state.onAppearance
      ? state.onAppearance(route)
      : route.fulfill({
          headers: { "Cache-Control": "no-store" },
          json: { theme: state.workspace.theme },
        });
  });
  await page.route("**/api/workspace", async (route) => {
    if (route.request().method() === "GET") {
      const snapshot: Record<string, unknown> = { ...state.workspace };
      if (state.role === "guest") {
        delete snapshot.contact_email;
        delete snapshot.contact_phone;
        delete snapshot.postal_address;
      }
      return state.onWorkspace
        ? state.onWorkspace(route, snapshot)
        : route.fulfill({ json: snapshot });
    }
    const body: unknown = route.request().postDataJSON();
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new Error("Expected a workspace command");
    const patch = body as Record<string, unknown>;
    state.writes.push(patch);
    if (state.onPatch) return state.onPatch(route, patch);
    if (patch.revision !== state.workspace.revision)
      return route.fulfill({
        status: 409,
        json: { detail: { code: "stale_revision", message: "stale" } },
      });
    if (!themes.some((theme) => theme === patch.theme))
      throw new Error("Expected an allowed organization look");
    state.workspace = {
      ...state.workspace,
      theme: patch.theme as Theme,
      revision: state.workspace.revision + 1,
    };
    return route.fulfill({ json: state.workspace });
  });
  return state;
}

async function seedCache(page: Page, theme: Theme) {
  await page.addInitScript(
    ({ key, value }) => localStorage.setItem(key, value),
    { key: cacheKey, value: theme },
  );
}

const look = (page: Page) =>
  page.getByRole("radiogroup", { name: "Organization look" });
const radio = (page: Page, name: string) =>
  look(page).getByRole("radio", { name: new RegExp(`^${name}`) });
async function choose(page: Page, name: string) {
  await expect(radio(page, name)).toBeEnabled();
  await look(page).locator("label").filter({ hasText: name }).click();
}
/** A reader's saved look: one tile with no other look to choose (MD5). */
const readerLook = (page: Page) =>
  page
    .getByRole("region", { name: "Organization settings", exact: true })
    .getByRole("group", { name: "Look", exact: true });
const save = (page: Page) =>
  page.getByRole("button", { name: "Save settings", exact: true });
const discard = (page: Page) =>
  page.getByRole("button", { name: "Discard changes", exact: true });
const cached = (page: Page) =>
  page.evaluate((key) => localStorage.getItem(key), cacheKey);
// The footer chip confirms a save; no page notice repeats it (Phase 8).
const savedNotice = (page: Page) =>
  page
    .getByRole("group", { name: "Organization actions", exact: true })
    .getByText("Saved", { exact: true });

test("Organization preview stays out of committed cache and Discard restores the saved look", async ({
  page,
}) => {
  const api = await installApi(page);
  await seedCache(page, "slate");
  await page.goto("/manage?view=organization");
  await expect(radio(page, "Slate")).toBeChecked();
  await choose(page, "Stockroom");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "stockroom");
  expect(await cached(page)).toBe("slate");
  expect(api.writes).toEqual([]);
  // The pinned footer reads the same draft as the preview.
  await expect(
    page
      .getByRole("group", { name: "Organization actions", exact: true })
      .getByRole("status"),
  ).toHaveText("1 unsaved change");
  await expect(save(page)).toBeEnabled();
  await discard(page).click();
  await expect(radio(page, "Slate")).toBeChecked();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  await expect(save(page)).toBeDisabled();
  expect(await cached(page)).toBe("slate");
  await page.reload();
  await expect(radio(page, "Slate")).toBeChecked();
});

test("Organization Save persists only its confirmed revision response and survives reload", async ({
  page,
}) => {
  const api = await installApi(page);
  await seedCache(page, "slate");
  const gate = heldResponse();
  api.onPatch = async (route) => {
    await gate.released;
    api.workspace = { ...api.workspace, theme: "stockroom", revision: 5 };
    await route.fulfill({ json: api.workspace });
  };
  try {
    await page.goto("/manage?view=organization");
    await expect(radio(page, "Slate")).toBeChecked();
    await choose(page, "Stockroom");
    await save(page).click();
    await expect.poll(() => api.writes.length).toBe(1);
    expect(await cached(page)).toBe("slate");
    await expect(radio(page, "Whiteboard")).toBeDisabled();
    expect(api.writes).toEqual([{ revision: 4, theme: "stockroom" }]);
    gate.release();
    await expect(savedNotice(page)).toBeVisible();
    expect(await cached(page)).toBe("stockroom");
    await page.reload();
    await expect(radio(page, "Stockroom")).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "stockroom",
    );
    await expect(save(page)).toBeDisabled();
  } finally {
    gate.release();
  }
});

for (const action of ["discard", "save again"] as const) {
  test(`Organization stale Save keeps its preview and ${action} uses the fresh saved baseline`, async ({
    page,
  }) => {
    const api = await installApi(page);
    await seedCache(page, "slate");
    await page.goto("/manage?view=organization");
    await expect(radio(page, "Slate")).toBeChecked();
    await choose(page, "Stockroom");
    api.workspace = { ...api.workspace, theme: "whiteboard", revision: 5 };
    await save(page).click();
    const saveAgain = page.getByRole("button", {
      name: "Save again",
      exact: true,
    });
    await expect(saveAgain).toBeEnabled();
    await expect(radio(page, "Stockroom")).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "stockroom",
    );
    expect(await cached(page)).toBe("whiteboard");
    if (action === "discard") {
      await discard(page).click();
      await expect(radio(page, "Whiteboard")).toBeChecked();
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        "whiteboard",
      );
      expect(api.writes).toEqual([{ revision: 4, theme: "stockroom" }]);
    } else {
      await saveAgain.click();
      await expect(savedNotice(page)).toBeVisible();
      expect(api.writes).toEqual([
        { revision: 4, theme: "stockroom" },
        { revision: 5, theme: "stockroom" },
      ]);
      expect(await cached(page)).toBe("stockroom");
    }
  });
}

test("Organization failed Save retains draft without committing it and retries after readback", async ({
  page,
}) => {
  const api = await installApi(page);
  await seedCache(page, "slate");
  api.onPatch = (route) =>
    route.fulfill({ status: 503, json: { detail: "Unavailable" } });
  await page.goto("/manage?view=organization");
  await expect(radio(page, "Slate")).toBeChecked();
  await choose(page, "Stockroom");
  await save(page).click();
  await expect(
    page.getByText("The settings could not be saved. Try again.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(radio(page, "Stockroom")).toBeChecked();
  expect(await cached(page)).toBe("slate");
  api.onPatch = null;
  await save(page).click();
  await expect(savedNotice(page)).toBeVisible();
  expect(await cached(page)).toBe("stockroom");
  expect(api.writes).toEqual([
    { revision: 4, theme: "stockroom" },
    { revision: 4, theme: "stockroom" },
  ]);
});

test("Organization dirty leave guard keeps preview until an accepted transition", async ({
  page,
}) => {
  await installApi(page);
  await seedCache(page, "slate");
  await page.goto("/manage?view=organization");
  await expect(radio(page, "Slate")).toBeChecked();
  await choose(page, "Stockroom");
  const leave = page.getByRole("link", { name: /People and groups/ });
  await leave.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Discard unsaved Manage changes?");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "stockroom");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(/\/manage\?view=organization/);
  await expect(radio(page, "Stockroom")).toBeChecked();
  await leave.click();
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  await expect(page).toHaveURL(/\/access/);
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  expect(await cached(page)).toBe("slate");
});

test("Organization cached look paints the first frame and public read reconciles login", async ({
  page,
}) => {
  const api = await installApi(page);
  api.authenticated = false;
  api.workspace.theme = "whiteboard";
  const gate = heldResponse();
  api.onAppearance = async (route) => {
    await gate.released;
    await route.fulfill({
      headers: { "Cache-Control": "no-store" },
      json: { theme: "whiteboard" },
    });
  };
  await page.addInitScript(
    ({ key }) => {
      localStorage.setItem(key, "stockroom");
      requestAnimationFrame(() => {
        document.documentElement.dataset.firstFrameOrganizationTheme =
          document.documentElement.dataset.theme ?? "slate";
      });
    },
    { key: cacheKey },
  );
  try {
    await page.goto("/login");
    await expect.poll(() => api.appearanceReads).toBeGreaterThan(0);
    await expect(page.locator("html")).toHaveAttribute(
      "data-first-frame-organization-theme",
      "stockroom",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "stockroom",
    );
    await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
    gate.release();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "whiteboard",
    );
    expect(await cached(page)).toBe("whiteboard");
    // The public entry checks for an existing session; appearance adds no refresh.
    expect(api.refreshes).toBe(1);
  } finally {
    gate.release();
  }
});

for (const fault of ["unavailable", "unauthorized", "malformed"] as const) {
  test(`Organization public ${fault} keeps the valid cached look without auth refresh`, async ({
    page,
  }) => {
    const api = await installApi(page);
    api.authenticated = false;
    await seedCache(page, "stockroom");
    api.onAppearance = (route) =>
      route.fulfill({
        status:
          fault === "unavailable" ? 503 : fault === "unauthorized" ? 401 : 200,
        json:
          fault === "malformed"
            ? { theme: "sepia" }
            : { detail: "Unavailable" },
      });
    await page.goto("/login");
    await expect.poll(() => api.appearanceReads).toBeGreaterThan(0);
    await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "stockroom",
    );
    expect(await cached(page)).toBe("stockroom");
    expect(api.refreshes).toBe(1);
  });
}

test("Organization older public read cannot replace a confirmed Save", async ({
  page,
}) => {
  const api = await installApi(page);
  await seedCache(page, "slate");
  const gate = heldResponse();
  const answered = heldResponse();
  api.onAppearance = async (route) => {
    await gate.released;
    await route.fulfill({ json: { theme: "whiteboard" } }).catch(() => {});
    answered.release();
  };
  try {
    await page.goto("/manage?view=organization");
    await expect.poll(() => api.appearanceReads).toBeGreaterThan(0);
    await expect(radio(page, "Slate")).toBeChecked();
    await choose(page, "Stockroom");
    await save(page).click();
    await expect(savedNotice(page)).toBeVisible();
    gate.release();
    await answered.released;
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "stockroom",
    );
    expect(await cached(page)).toBe("stockroom");
  } finally {
    gate.release();
  }
});

for (const result of ["success", "failure"] as const) {
  test(`Organization old-account Save ${result} cannot affect a new preview or cache`, async ({
    page,
  }) => {
    const api = await installApi(page);
    await seedCache(page, "slate");
    const gate = heldResponse();
    const answered = heldResponse();
    api.onPatch = async (route) => {
      await gate.released;
      if (result === "success")
        api.workspace = { ...api.workspace, theme: "stockroom", revision: 5 };
      await route
        .fulfill({
          status: result === "success" ? 200 : 503,
          json:
            result === "success" ? api.workspace : { detail: "Unavailable" },
        })
        .catch(() => {});
      answered.release();
    };
    try {
      await page.goto("/manage?view=organization");
      await expect(radio(page, "Slate")).toBeChecked();
      await choose(page, "Stockroom");
      await save(page).click();
      await expect.poll(() => api.writes.length).toBe(1);
      api.userId = userB;
      const nextAccount = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          `/api/users/${userB}/preferences`,
      );
      await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
      await nextAccount;
      await expect(radio(page, "Slate")).toBeChecked();
      await choose(page, "Triplicate");
      gate.release();
      await answered.released;
      await expect(radio(page, "Triplicate")).toBeChecked();
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        "triplicate",
      );
      expect(await cached(page)).toBe("slate");
      await expect(savedNotice(page)).toBeHidden();
      await expect(save(page)).toBeEnabled();
    } finally {
      gate.release();
    }
  });
}

test("Organization preview survives personal storage events and Save when storage writes fail", async ({
  page,
}) => {
  const api = await installApi(page);
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error("Storage unavailable");
    };
  });
  await page.goto("/manage?view=organization");
  await choose(page, "Stockroom");
  await page.evaluate(() =>
    window.dispatchEvent(
      new StorageEvent("storage", { key: "openslate-theme" }),
    ),
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "stockroom");
  await save(page).click();
  await expect(savedNotice(page)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "stockroom");
  expect(api.writes).toEqual([{ revision: 4, theme: "stockroom" }]);
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Account settings", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page.getByRole("radiogroup", { name: "Color mode", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "stockroom");
});

test("Organization accepted Manage tab transition suspends the preview and returning resumes the draft", async ({
  page,
}) => {
  await installApi(page);
  await page.route("**/api/audit-logs/options", (route) =>
    route.fulfill({ json: { entity_types: [], actors: [] } }),
  );
  await page.route("**/api/audit-logs?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({
      json: {
        items: [],
        pagination: {
          limit: Number(params.get("limit") ?? 10),
          offset: Number(params.get("offset") ?? 0),
          count: 0,
          total: 0,
          has_more: false,
        },
      },
    });
  });
  await seedCache(page, "slate");
  await page.goto("/manage?view=organization");
  await choose(page, "Stockroom");
  await page.getByRole("link", { name: "Audit", exact: true }).click();
  await expect(page).toHaveURL(/view=audit/);
  await expect(
    page.getByText("No audit entries match these filters", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(radio(page, "Stockroom")).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "stockroom");
  expect(await cached(page)).toBe("slate");
});

test("Organization failed stale refresh blocks Save until an explicit Retry", async ({
  page,
}) => {
  const api = await installApi(page);
  await seedCache(page, "slate");
  await page.goto("/manage?view=organization");
  await choose(page, "Stockroom");
  api.workspace = { ...api.workspace, theme: "whiteboard", revision: 5 };
  api.onWorkspace = (route) =>
    route.fulfill({ status: 503, json: { detail: "Unavailable" } });
  await save(page).click();
  await expect(
    page.getByText(
      "Organization settings changed, but the latest values could not be loaded. Retry before saving again.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(save(page)).toBeDisabled();
  expect(api.writes).toEqual([{ revision: 4, theme: "stockroom" }]);
  api.onWorkspace = null;
  await page
    .getByRole("button", { name: "Retry organization settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Save again", exact: true }).click();
  await expect(savedNotice(page)).toBeVisible();
  expect(api.writes).toEqual([
    { revision: 4, theme: "stockroom" },
    { revision: 5, theme: "stockroom" },
  ]);
});

test("Organization verified role loss removes the preview and disallows a theme command", async ({
  page,
}) => {
  const api = await installApi(page);
  await seedCache(page, "slate");
  await page.goto("/manage?view=organization");
  await choose(page, "Stockroom");
  await page
    .getByRole("textbox", { name: "Organization name" })
    .fill("Unsaved draft name");
  api.role = "member";
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await expect(look(page)).toHaveCount(0);
  // The reader sees the saved settings, never the draft left behind.
  await expect(
    page
      .getByRole("region", { name: "Organization settings", exact: true })
      .locator('dt:text-is("Name") + dd'),
  ).toHaveText("Organization theme journey");
  await expect(page.getByText("Unsaved draft name")).toHaveCount(0);
  await expect(
    readerLook(page).getByText("Slate", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  expect(await cached(page)).toBe("slate");
  expect(api.writes).toEqual([]);
});

test("Organization keeps a trusted background role refresh interactive and a return reads the role again", async ({
  page,
}) => {
  const api = await installApi(page);
  await seedCache(page, "slate");
  await page.goto("/manage?view=organization");
  await choose(page, "Stockroom");
  const oldRead = heldResponse();
  const freshRead = heldResponse();
  const oldAnswered = heldResponse();
  let reads = 0;
  await page.route("**/api/auth/me", async (route) => {
    const old = ++reads === 1;
    await (old ? oldRead : freshRead).released;
    await route
      .fulfill({
        json: authMeBody({
          id: userA,
          role: old ? "admin" : "member",
          access: [],
          default_organization_blocked: null,
        }),
      })
      .catch(() => {});
    if (old) oldAnswered.release();
  });
  await page.route(
    /\/api\/(views\/data-sources|reports(\/shared-runs)?)\?/,
    (route) => {
      const params = new URL(route.request().url()).searchParams;
      return route.fulfill({
        json: {
          items: [],
          pagination: {
            limit: Number(params.get("limit") ?? 25),
            offset: Number(params.get("offset") ?? 0),
            count: 0,
            total: 0,
            has_more: false,
          },
        },
      });
    },
  );
  try {
    const navigation = page.getByRole("navigation", {
      name: "Main navigation",
    });
    await navigation
      .getByRole("button", { name: "OpenView", exact: true })
      .click();
    await expect(radio(page, "Stockroom")).toBeEnabled();
    // Keyboard focus retains navigation intent while the sidebar moves. The
    // controlled clock makes the cached identity stale and advances its existing
    // intent timer; no pointer-leave cancellation or real-time wait is involved.
    await page.clock.install();
    await page.clock.fastForward(60_000);
    const reports = navigation.getByRole("link", {
      name: "Reports",
      exact: true,
    });
    await reports.focus();
    await expect(reports).toBeFocused();
    await expect
      .poll(async () => {
        await page.clock.runFor(125);
        return reads;
      })
      .toBe(1);
    await expect(radio(page, "Stockroom")).toBeEnabled();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "stockroom",
    );
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    oldRead.release();
    await oldAnswered.released;
    await expect.poll(() => reads).toBeGreaterThan(1);
    freshRead.release();
    await expect(look(page)).toHaveCount(0);
    await expect(
      readerLook(page).getByText("Slate", { exact: true }),
    ).toBeVisible();
    expect(api.writes).toEqual([]);
  } finally {
    oldRead.release();
    freshRead.release();
  }
});
