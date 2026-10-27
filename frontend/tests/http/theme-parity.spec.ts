import {
  appearanceUrl,
  expect,
  signedInAs,
  test,
  type Page,
} from "./helpers/test";
import { seedTimeline } from "./helpers/comms-timeline-fixture";
import {
  installKanbanApi,
  kanbanHref,
  stageIds,
  wireCard,
} from "./helpers/board-kanban-api";

async function signIn(page: Page) {
  await signedInAs(page, {
    id: "00000000-0000-4000-8000-000000000101",
    role: "admin",
  });
  // Organization reads the server workspace; without an answer the panel moves
  // between loading and error, so two looks could be captured in different states.
  let theme = "slate";
  let revision = 4;
  await page.route(appearanceUrl, (route) =>
    route.fulfill({ json: { theme } }),
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
      theme = patch.theme;
      revision += 1;
    }
    return route.fulfill({
      json: {
        id: "00000000-0000-4000-8000-000000000077",
        display_name: "Riverside Services",
        legal_name: null,
        description: null,
        contact_email: null,
        contact_phone: null,
        postal_address: null,
        logo_file_id: null,
        timezone: "Asia/Manila",
        locale: "en-PH",
        mark: "RS",
        currency: "PHP",
        week_start: "monday",
        business_hours: "09:00–18:00",
        theme,
        invitation_expiry_days: 7,
        guest_duration_days: 30,
        revision,
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T00:00:00Z",
        today: "2026-09-01",
      },
    });
  });
  return (value: string) => {
    theme = value;
  };
}

// Themes change look only. Compare the persistent shell and page, excluding
// Next's changing script payloads and the session curtain outside the shell.
// The Access entry appears only after `/api/auth/me` answers with the default
// administrator, so wait for it before each snapshot to compare settled shells.
async function snapshot(page: Page) {
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: /^Access/ }),
  ).toBeVisible();
  const capture = () =>
    page.evaluate(() => {
      const shell = document.querySelector(".app-shell");
      if (!shell) throw new Error("Workspace shell is unavailable");
      return {
        elements: shell.querySelectorAll("*").length,
        text: shell.textContent,
      };
    });
  // Comms may refetch its conversations right after the first paint, and the
  // "Refreshing conversations…" status then covers the connection strip for a
  // moment. Capture a shell with no refresh in flight so looks compare settled.
  let settled = await capture();
  await expect
    .poll(async () => {
      settled = await capture();
      return settled.text?.includes("Refreshing conversations…");
    })
    .toBe(false);
  return settled;
}

const THEMES = [
  { name: "Whiteboard", id: "whiteboard", font: /Atkinson/ },
  { name: "Triplicate", id: "triplicate", font: /Archivo/ },
  { name: "Stockroom", id: "stockroom", font: /Archivo/ },
] as const;

test("Comms keeps the same words and structure across organization looks", async ({
  page,
}) => {
  await seedTimeline(page, 2);
  const setTheme = await signIn(page);
  await page.goto("/comms");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("article")).toHaveCount(2);
  const slate = await snapshot(page);
  for (const look of THEMES) {
    setTheme(look.id);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", look.id);
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole("article")).toHaveCount(2);
    expect(await snapshot(page), look.id).toEqual(slate);
    expect(
      await page.evaluate(() => getComputedStyle(document.body).fontFamily),
    ).toMatch(look.font);
  }
});

test("each organization look keeps the same words and structure", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/manage?view=organization");
  const look = page.getByRole("radiogroup", { name: "Organization look" });
  await expect(look.getByRole("radio", { name: /^Slate/ })).toBeChecked();
  const save = page.getByRole("button", { name: "Save settings", exact: true });
  await expect(look.getByRole("radio", { name: /^Whiteboard/ })).toBeEnabled();
  await look.locator("label").filter({ hasText: "Whiteboard" }).click();
  await save.click();
  await expect(
    page
      .getByRole("group", { name: "Organization actions", exact: true })
      .getByText("Saved", { exact: true }),
  ).toBeVisible();
  await look.locator("label").filter({ hasText: "Slate" }).click();
  await save.click();
  await expect(
    page
      .getByRole("group", { name: "Organization actions", exact: true })
      .getByText("Saved", { exact: true }),
  ).toBeVisible();
  const slate = await snapshot(page);

  for (const theme of THEMES) {
    // People click the tile; the radio inside it is visually hidden.
    await look.locator("label").filter({ hasText: theme.name }).click();
    await expect(
      look.getByRole("radio", { name: new RegExp(`^${theme.name}`) }),
    ).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.id);
    await save.click();
    await expect(
      page
        .getByRole("group", { name: "Organization actions", exact: true })
        .getByText("Saved", { exact: true }),
    ).toBeVisible();
    expect(await snapshot(page), theme.id).toEqual(slate);
    const bodyFont = await page.evaluate(
      () => getComputedStyle(document.body).fontFamily,
    );
    expect(bodyFont, theme.id).toMatch(theme.font);
  }

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "stockroom");
  await expect(look.getByRole("radio", { name: /^Stockroom/ })).toBeChecked();

  await look.locator("label").filter({ hasText: "Slate" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
});

test("the board Kanban keeps its words and structure across looks, framed as the canvas, at the person's text size", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installKanbanApi(page, {
    level: "write",
    cards: [wireCard("Book the expo booth crew", stageIds.todo, 1024)],
  });
  let theme = "slate";
  await page.route(appearanceUrl, (route) =>
    route.fulfill({ json: { theme } }),
  );
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        display_name: "OpenSlate",
        mark: "OS",
        logo_file_id: null,
        revision: 1,
        today: "2026-09-25",
        week_start: "monday",
        locale: "en-US",
        timezone: "UTC",
        purge_enabled: true,
        theme,
      },
    }),
  );
  // A person who reads at 125% keeps that size on the board (BR66).
  await page.addInitScript(() =>
    window.localStorage.setItem("openslate-text-size", "125"),
  );
  const surface = page.locator('[data-skin="board-surface"]');
  const looks = async () => {
    await expect(
      page.getByRole("button", {
        name: "Card actions for Book the expo booth crew",
      }),
    ).toBeVisible();
    return surface.evaluate((node) => {
      // A canvas frame beside it, to compare the look's frame.
      const canvas = document.createElement("div");
      canvas.dataset.skin = "canvas-frame";
      canvas.style.position = "relative";
      document.body.append(canvas);
      const frame = (element: Element) =>
        getComputedStyle(element, "::after").boxShadow;
      const result = {
        frame: frame(node),
        canvasFrame: frame(canvas),
        textSize: getComputedStyle(node).fontSize,
        pageTextSize: getComputedStyle(document.body).fontSize,
        canvasTextSize: getComputedStyle(canvas).fontSize,
        elements: node.querySelectorAll("*").length,
        text: node.textContent,
      };
      canvas.remove();
      return result;
    });
  };
  await page.goto(kanbanHref());
  const slate = await looks();
  expect(slate.frame).toBe("none");
  expect(slate.textSize).toBe(slate.pageTextSize);
  expect(slate.textSize).not.toBe(slate.canvasTextSize);
  for (const look of THEMES) {
    theme = look.id;
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", look.id);
    const current = await looks();
    expect(current.frame, look.id).not.toBe("none");
    expect(current.frame, look.id).toBe(current.canvasFrame);
    expect(current.textSize, look.id).toBe(current.pageTextSize);
    expect({ elements: current.elements, text: current.text }, look.id).toEqual(
      { elements: slate.elements, text: slate.text },
    );
  }
});
