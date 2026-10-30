import { expect, heldResponse, test, type Page } from "./helpers/test";
import {
  avatarFileId,
  avatarPng,
  installProfileApi,
} from "./helpers/profile-api";
import { smallTargets } from "./helpers/layout";
import { mockMfa } from "./helpers/mfa";

// Account settings layout and saving (docs/specs/profile-sidebar-relayout.md,
// PD9-PD15, PD36 onward). The rules behind these journeys (the draft count,
// the timezone options, the session words, the two-step word) are owned by
// tests/isolated/shell/account-settings.spec.ts.

test.use({ trace: "off", screenshot: "off", video: "off" });

const stamp = "2026-10-24T09:47:00Z";
const session = (
  id: number,
  userAgent: string,
  ip: string,
  current = false,
) => ({
  id: `00000000-0000-4000-8000-${String(800 + id).padStart(12, "0")}`,
  created_at: stamp,
  refreshed_at: stamp,
  expires_at: "2099-10-01T00:00:00Z",
  user_agent: userAgent,
  ip_address: ip,
  current,
});
const safariMac =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const chromeWindows =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

/** Several sessions, so the settings panel is longer than the viewport. */
async function installSessions(page: Page, count = 3) {
  const sessions = [
    session(1, safariMac, "127.0.0.1", true),
    session(2, chromeWindows, "10.0.4.21"),
    ...Array.from({ length: count - 2 }, (_, index) =>
      session(3 + index, safariMac, `10.0.4.${30 + index}`),
    ),
  ];
  const ended: string[] = [];
  await page.route("**/api/auth/sessions", (route) =>
    route.fulfill({ json: sessions }),
  );
  await page.route("**/api/auth/sessions/*", (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    ended.push(new URL(route.request().url()).pathname.split("/").at(-1)!);
    return route.fulfill({ status: 204, body: "" });
  });
  return { ended };
}

const settingsPanel = (page: Page) =>
  page.getByRole("region", { name: "Settings", exact: true });
const footer = (page: Page) =>
  page.getByRole("group", { name: "Profile actions", exact: true });

test("from 1280px the page is still, rows are label-left, and Save profile is the one primary action", async ({
  page,
}) => {
  await installProfileApi(page);
  await installSessions(page, 9);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/settings");
  const phone = page.getByLabel("Phone", { exact: true });
  await expect(phone).toHaveValue("+1 555 0101");
  await expect(
    page.getByRole("heading", { name: "Account settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Your name, sign-in, and personal preferences.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Profile sections" }),
  ).toHaveCount(0);
  // Only the panels scroll; the document fits the viewport.
  expect(
    await page.evaluate(() => [
      document.documentElement.scrollHeight,
      innerHeight,
    ]),
  ).toEqual([720, 720]);
  expect(
    await settingsPanel(page)
      .locator("[data-settings-scroll]")
      .evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  for (const name of ["Identity", "Sign-in", "Appearance", "Regional"])
    await expect(
      settingsPanel(page).getByRole("region", { name, exact: true }),
    ).toBeVisible();
  // The label sits left of its field, on the same 32px line.
  const label = settingsPanel(page).locator("label", { hasText: /^Phone$/ });
  const [labelBox, fieldBox] = await Promise.all([
    label.boundingBox(),
    phone.boundingBox(),
  ]);
  if (!labelBox || !fieldBox) throw new Error("Phone row geometry missing");
  expect(labelBox.x + labelBox.width).toBeLessThan(fieldBox.x);
  expect(
    Math.abs(
      labelBox.y + labelBox.height / 2 - (fieldBox.y + fieldBox.height / 2),
    ),
  ).toBeLessThan(4);
  expect(fieldBox.height).toBe(32);
  // The visible word is the start of the field's name (PD36, PD58).
  await expect(
    settingsPanel(page).locator("label", { hasText: /^Display name$/ }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("main")
      .locator(
        'button[data-variant="default"]:visible, a[data-variant="default"]:visible',
      ),
  ).toHaveText(["Save profile"]);
});

test("the footer says why Save waits, counts unsaved changes, discards, and saves", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  await page.goto("/settings");
  const title = page.getByLabel("Job title", { exact: true });
  await expect(title).toHaveValue("Equipment coordinator");
  const save = footer(page).getByRole("button", {
    name: "Save profile",
    exact: true,
  });
  await expect(save).toBeDisabled();
  await expect(save).toHaveAccessibleDescription("No changes to save.");
  await expect(footer(page).getByRole("status")).toHaveText("Saved");
  await expect(
    footer(page).getByRole("button", { name: "Discard changes" }),
  ).toHaveCount(0);

  await title.fill("Operations lead");
  await page.getByLabel("Phone", { exact: true }).fill("");
  await expect(footer(page).getByRole("status")).toHaveText(
    "2 unsaved changes",
  );
  // The preview card follows the draft.
  await expect(
    page.getByRole("complementary", { name: "Preview", exact: true }),
  ).toContainText("Operations lead");
  await footer(page)
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(title).toHaveValue("Equipment coordinator");
  await expect(page.getByLabel("Phone", { exact: true })).toHaveValue(
    "+1 555 0101",
  );
  await expect(footer(page).getByRole("status")).toHaveText("Saved");
  expect(api.writes).toEqual([]);

  await title.fill("Operations lead");
  await expect(footer(page).getByRole("status")).toHaveText("1 unsaved change");
  await save.click();
  await expect(footer(page).getByRole("status")).toHaveText("Profile saved.");
  await expect(save).toBeDisabled();
  expect(api.writes.map(({ path, body }) => ({ path, body }))).toEqual([
    { path: "/api/auth/me/profile", body: { job_title: "Operations lead" } },
  ]);
});

test("the timezone select lists the organization timezone first and saves each choice at once", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings#regional");
  const timezone = page.getByRole("combobox", {
    name: "Timezone",
    exact: true,
  });
  await expect(timezone).toHaveText("Organization timezone (Asia/Manila)");
  await expect(page.getByRole("textbox", { name: "Timezone" })).toHaveCount(0);
  await timezone.click();
  const options = page.getByRole("listbox").getByRole("option");
  await expect(options.first()).toHaveText(
    "Organization timezone (Asia/Manila)",
  );
  // The open list covers at most 20rem, wherever it opens.
  expect(
    (await page.locator('[data-slot="combobox-popup"]').boundingBox())?.height,
  ).toBeLessThanOrEqual(320);
  // From 1280px the options are slim rows, and the chosen one has a check.
  expect((await options.nth(1).boundingBox())?.height).toBe(32);
  await expect(
    options.first().locator('[data-slot="combobox-item-indicator"] svg'),
  ).toBeVisible();
  await expect(
    options.nth(1).locator('[data-slot="combobox-item-indicator"]'),
  ).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Search timezone", exact: true })
    .fill("Los Angeles");
  await page.getByRole("option", { name: /America\/Los Angeles$/ }).click();
  await expect(timezone).toContainText("America/Los Angeles");
  await expect
    .poll(() => api.writes.map(({ body }) => body))
    .toEqual([{ appearance: { timezone: "America/Los_Angeles" } }]);
  await timezone.click();
  await page
    .getByRole("option", { name: "Organization timezone (Asia/Manila)" })
    .click();
  await expect
    .poll(() => api.writes.map(({ body }) => body))
    .toEqual([
      { appearance: { timezone: "America/Los_Angeles" } },
      { appearance: { timezone: null } },
    ]);
  await expect(page.getByRole("button", { name: "Save timezone" })).toHaveCount(
    0,
  );
});

test("the password dialog is framed, closes by name, and says other devices sign out before the action", async ({
  page,
}) => {
  await installProfileApi(page);
  await page.goto("/settings#security");
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Change password",
    exact: true,
  });
  await expect(dialog.getByLabel("Current password")).toBeVisible();
  await expect(dialog.getByLabel("New password")).toBeVisible();
  // The dialog opens on its first field.
  await expect(dialog.getByLabel("Current password")).toBeFocused();
  const notice = dialog.getByText("Other devices sign out after the change.", {
    exact: true,
  });
  const submit = dialog.getByRole("button", {
    name: "Change password",
    exact: true,
  });
  await expect(notice).toBeVisible();
  expect(
    await notice.evaluate(
      (element, button) =>
        Boolean(
          button &&
          element.compareDocumentPosition(button) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      await submit.elementHandle(),
    ),
  ).toBe(true);
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Close password", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Change password", exact: true }),
  ).toBeFocused();
});

test("the email dialog is framed with a named close and Cancel beside its action", async ({
  page,
}) => {
  await installProfileApi(page);
  await page.goto("/settings");
  await expect(
    page.getByText("person@example.test", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Change email", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Change email",
    exact: true,
  });
  await expect(dialog.getByLabel("New email")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Send confirmation emails" }),
  ).toBeVisible();
  // The dialog opens on its first field.
  await expect(dialog.getByLabel("New email")).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Change email", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Change email", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Close email", exact: true })
    .click();
  await expect(dialog).toBeHidden();
});

test("sessions are one-line rows with This device and an End session named for the device", async ({
  page,
}) => {
  await installProfileApi(page);
  const sessions = await installSessions(page);
  await page.goto("/settings#security");
  const list = page.getByRole("list", { name: "Active sessions", exact: true });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  const here = list.getByRole("listitem").filter({ hasText: "This device" });
  await expect(here).toHaveCount(1);
  await expect(here).toContainText("Safari on macOS");
  await expect(here).toContainText("127.0.0.1");
  await list
    .getByRole("button", {
      name: "Session actions, Chrome on Windows",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", {
      name: "End session, Chrome on Windows",
      exact: true,
    })
    .click();
  const confirm = page.getByRole("alertdialog", {
    name: "End the session on Chrome, Windows?",
    exact: true,
  });
  await confirm
    .getByRole("button", { name: "End session", exact: true })
    .click();
  await expect(confirm).toBeHidden();
  expect(sessions.ended).toEqual(["00000000-0000-4000-8000-000000000802"]);
  await expect(
    page.getByRole("button", { name: "Sign out other sessions", exact: true }),
  ).toBeEnabled();
});

test("the two-step status shows On from one read on load", async ({ page }) => {
  const mfa = await mockMfa(page, { verified: true, aal2: true });
  await installProfileApi(page, { session: false, mfa: false });
  await page.goto("/settings#security");
  const row = page
    .getByRole("region", { name: "Sign-in", exact: true })
    .getByRole("group", { name: "Two-step", exact: true });
  await expect(row).toContainText("On");
  await expect(
    row.getByRole("button", {
      name: "Manage two-step verification",
      exact: true,
    }),
  ).toBeEnabled();
  expect(
    mfa.calls.filter(
      ({ method, path }) => method === "GET" && path === "/auth/mfa",
    ),
  ).toHaveLength(1);
  await row
    .getByRole("button", { name: "Manage two-step verification" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Two-step verification",
    exact: true,
  });
  await expect(
    dialog.getByRole("heading", { name: "Authenticator verified" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Close two-step", exact: true })
    .click();
  await expect(dialog).toBeHidden();
});

test("Color is one segmented row of Light, Dark and System", async ({
  page,
}) => {
  await installProfileApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings#look");
  const group = page.getByRole("radiogroup", {
    name: "Color mode",
    exact: true,
  });
  const radios = group.getByRole("radio");
  await expect(radios).toHaveText(["Light", "Dark", "System"]);
  // Measure the three segments in one frame. Three boundingBox() calls are
  // three round trips; a scroll to #look or a layout shift between them moved
  // one segment's viewport top in CI (PR #72, run 40987763554).
  const boxes = await radios.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { y: rect.top, height: rect.height };
    }),
  );
  const tops = boxes.map((box) => Math.round(box?.y ?? -1));
  expect(new Set(tops).size).toBe(1);
  // A slim segment, not a 97×127 tile.
  for (const box of boxes) expect(box?.height).toBeLessThanOrEqual(32);
  await group.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(
    group.getByRole("radio", { name: "Dark", exact: true }),
  ).toBeChecked();
  await expect(page.locator("html")).toHaveClass(/dark/);
  // Arrow keys move the choice, as in any radio group.
  await page.keyboard.press("ArrowRight");
  await expect(
    group.getByRole("radio", { name: "System", exact: true }),
  ).toBeChecked();
});

test("on a phone each switch row is a 44px target that toggles its switch", async ({
  page,
}) => {
  await installProfileApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings#look");
  for (const name of ["Reduce motion", "Use shortcuts"]) {
    const toggle = page.getByRole("switch", { name, exact: true });
    await expect(toggle).toBeEnabled();
    const checked = await toggle.isChecked();
    const label = page.locator("label", { hasText: new RegExp(`^${name}$`) });
    const box = await label.boundingBox();
    if (!box) throw new Error(`${name} row missing`);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await label.click();
    await expect(toggle).toBeChecked({ checked: !checked });
  }
});

test("the preview shows how others see you with a link to your profile", async ({
  page,
}) => {
  await installProfileApi(page);
  await page.goto("/settings");
  const preview = page.getByRole("complementary", {
    name: "Preview",
    exact: true,
  });
  await expect(preview).toContainText("Maya Chen");
  await expect(
    preview.getByRole("link", { name: "View your profile", exact: true }),
  ).toHaveAttribute("href", "/profile");
  await expect(preview.getByText("Amount", { exact: true })).toBeVisible();
  await expect(
    preview.getByRole("region", { name: "Appearance preview", exact: true }),
  ).toContainText("Equipment request");
});

test("without an organization Account settings keeps both panes beside each other from 1280px", async ({
  page,
}) => {
  await installProfileApi(page, { role: null });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Maya Chen",
  );
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toHaveCount(0);
  const [panel, preview] = await Promise.all([
    settingsPanel(page).boundingBox(),
    page.getByRole("complementary", { name: "Preview" }).boundingBox(),
  ]);
  if (!panel || !preview) throw new Error("Pane geometry missing");
  expect(preview.x).toBeGreaterThanOrEqual(panel.x + panel.width);
  expect(Math.abs(preview.y - panel.y)).toBeLessThan(2);
  expect(panel.width).toBeGreaterThanOrEqual(800);
  // The frame widens to 75rem (1200px at 100% text) to hold both panes.
  await expect(
    page.getByRole("link", { name: "Your organizations" }).locator(".."),
  ).toHaveCSS("max-width", "1200px");
  await expect(
    page.getByRole("combobox", { name: "Timezone", exact: true }),
  ).toHaveText("Organization timezone");
});

test("the settings panel has at most 60 helper words", async ({ page }) => {
  await installProfileApi(page);
  await installSessions(page);
  await page.goto("/settings");
  await expect(page.getByLabel("Phone", { exact: true })).toHaveValue(
    "+1 555 0101",
  );
  await expect(
    page.getByRole("switch", { name: "Reduce motion" }),
  ).toBeEnabled();
  // EXIT-3 method: the visible text of every <p> in the settings panel, plus
  // each description that a control in it names with aria-describedby.
  const words = await settingsPanel(page).evaluate((panel) => {
    const texts = new Set<Element>();
    for (const element of panel.querySelectorAll("p"))
      if (element.checkVisibility()) texts.add(element);
    for (const control of panel.querySelectorAll("[aria-describedby]"))
      for (const id of control.getAttribute("aria-describedby")!.split(/\s+/)) {
        const description = document.getElementById(id);
        if (description) texts.add(description);
      }
    return [...texts]
      .map((element) => element.textContent ?? "")
      .join(" ")
      .split(/\s+/)
      .filter(Boolean).length;
  });
  expect(words).toBeLessThanOrEqual(60);
});

const documentSize = (page: Page) =>
  page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.scrollHeight,
  ]);

test("Account settings does not scroll the document at 1440×900 and 1920×1080 either", async ({
  page,
}) => {
  await installProfileApi(page);
  await installSessions(page, 9);
  for (const [width, height] of [
    [1440, 900],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto("/settings");
    await expect(page.getByLabel("Phone", { exact: true })).toHaveValue(
      "+1 555 0101",
    );
    expect(await documentSize(page), `${width}×${height}`).toEqual([
      width,
      height,
    ]);
  }
});

test("on a phone every target in the settings panel, its footer, the preview and the session menu is at least 44px", async ({
  page,
}) => {
  await installProfileApi(page);
  await installSessions(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  const phone = page.getByLabel("Phone", { exact: true });
  await expect(phone).toHaveValue("+1 555 0101");
  await expect(
    page.getByRole("switch", { name: "Reduce motion" }),
  ).toBeEnabled();
  await expect(
    settingsPanel(page).getByRole("button", {
      name: "Session actions, Chrome on Windows",
      exact: true,
    }),
  ).toBeVisible();
  // With a change, so the footer also shows Discard changes.
  await phone.fill("+1 555 0102");
  await expect(
    footer(page).getByRole("button", { name: "Discard changes" }),
  ).toBeVisible();
  expect(
    await smallTargets(page.locator("#main-content"), '[role="radio"]'),
  ).toEqual([]);
  await settingsPanel(page)
    .getByRole("button", {
      name: "Session actions, Chrome on Windows",
      exact: true,
    })
    .click();
  const menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitem", { name: "End session, Chrome on Windows" }),
  ).toBeVisible();
  expect(await smallTargets(menu, '[role="menuitem"]')).toEqual([]);
});

test("on a phone Account settings is one column, and the pinned footer never covers a focused row", async ({
  page,
}) => {
  await installProfileApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await expect(page.getByLabel("Phone", { exact: true })).toHaveValue(
    "+1 555 0101",
  );
  const bar = footer(page);
  // Pinned to the bottom of the viewport while the panel scrolls past.
  const pinned = (await bar.boundingBox())!;
  expect(Math.round(pinned.y + pinned.height)).toBe(844);
  const [panel, preview] = await Promise.all([
    settingsPanel(page).boundingBox(),
    page.getByRole("complementary", { name: "Preview" }).boundingBox(),
  ]);
  expect(preview!.x).toBe(panel!.x);
  expect(preview!.y).toBeGreaterThanOrEqual(panel!.y + panel!.height);
  // Focus moves to the last row of the panel; the footer leaves it in view.
  const weekStarts = settingsPanel(page).getByRole("combobox", {
    name: "Week starts",
  });
  await weekStarts.focus();
  const [row, cover] = await Promise.all([
    weekStarts.boundingBox(),
    bar.boundingBox(),
  ]);
  expect(row!.y + row!.height).toBeLessThanOrEqual(cover!.y);
  expect((await documentSize(page))[0]).toBe(390);
  // 16px text, so iOS Safari does not zoom the page when a field takes focus.
  for (const name of [
    "Display name",
    "Job title",
    "Phone",
    "Bio",
    "Text size",
    "Page spacing",
    "Start page after sign-in",
    "Date format",
    "Time format",
    "Week starts",
  ])
    await expect(page.getByLabel(name, { exact: true }), name).toHaveCSS(
      "font-size",
      "16px",
    );
  await page.getByRole("combobox", { name: "Timezone", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Search timezone", exact: true }),
  ).toHaveCSS("font-size", "16px");
});

test("on a phone the framed dialogs fill the width inside the 16px gutter and keep their footers in view", async ({
  page,
}) => {
  await installProfileApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await expect(page.getByLabel("Phone", { exact: true })).toHaveValue(
    "+1 555 0101",
  );
  for (const [opener, title, action, close] of [
    ["Change password", "Change password", "Change password", "Close password"],
    ["Change email", "Change email", "Send confirmation emails", "Close email"],
  ]) {
    await page.getByRole("button", { name: opener, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect([Math.round(box.x), Math.round(box.width)], title).toEqual([
      16, 358,
    ]);
    const button = dialog.getByRole("button", { name: action, exact: true });
    await expect(button).toBeInViewport({ ratio: 1 });
    expect(await smallTargets(dialog)).toEqual([]);
    await dialog.getByRole("button", { name: close, exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
});

test("without an organization Account settings is still at 1280×720 and one column at 390", async ({
  page,
}) => {
  await installProfileApi(page, { role: null });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/settings");
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Maya Chen",
  );
  expect(await documentSize(page)).toEqual([1280, 720]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { level: 1, name: "Account settings" }),
  ).toBeVisible();
  expect((await documentSize(page))[0]).toBe(390);
  const [panel, preview] = await Promise.all([
    settingsPanel(page).boundingBox(),
    page.getByRole("complementary", { name: "Preview" }).boundingBox(),
  ]);
  expect(preview!.y).toBeGreaterThanOrEqual(panel!.y + panel!.height);
  expect(await smallTargets(page.locator("main"), '[role="radio"]')).toEqual(
    [],
  );
});

test("Sign out other sessions says why it waits when no other device is signed in", async ({
  page,
}) => {
  await installProfileApi(page);
  await page.route("**/api/auth/sessions", (route) =>
    route.fulfill({ json: [session(1, safariMac, "127.0.0.1", true)] }),
  );
  await page.goto("/settings#security");
  await expect(
    settingsPanel(page)
      .getByRole("list", { name: "Active sessions", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(1);
  const others = settingsPanel(page).getByRole("button", {
    name: "Sign out other sessions",
    exact: true,
  });
  await expect(others).toHaveAttribute("aria-disabled", "true");
  await expect(others).toHaveAccessibleDescription("No other sessions.");
  // It stays focusable, so a keyboard user reaches the reason; it does nothing.
  await others.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("ending a session names the device and reads Ending… while it runs", async ({
  page,
}) => {
  await installProfileApi(page);
  await installSessions(page);
  const hold = heldResponse();
  await page.route("**/api/auth/sessions/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    hold.enter();
    await hold.released;
    await route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/settings#security");
  await settingsPanel(page)
    .getByRole("button", {
      name: "Session actions, Chrome on Windows",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", {
      name: "End session, Chrome on Windows",
      exact: true,
    })
    .click();
  const confirm = page.getByRole("alertdialog", {
    name: "End the session on Chrome, Windows?",
    exact: true,
  });
  await expect(confirm).toContainText("That device signs out.");
  await confirm
    .getByRole("button", { name: "End session", exact: true })
    .click();
  await hold.entered;
  await expect(
    confirm.getByRole("button", { name: "Ending…", exact: true }),
  ).toBeDisabled();
  hold.release();
  await expect(confirm).toBeHidden();
});

test("the photo saves at once, with its own status words beside it", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  const hold = heldResponse();
  api.holdUpload = hold;
  await page.goto("/settings");
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Maya Chen",
  );
  const identity = settingsPanel(page).getByRole("region", {
    name: "Identity",
    exact: true,
  });
  await page.getByLabel("Upload photo", { exact: true }).setInputFiles({
    name: "portrait.png",
    mimeType: "image/png",
    buffer: avatarPng,
  });
  await hold.entered;
  await expect(
    identity.getByRole("button", { name: "Uploading…", exact: true }),
  ).toBeDisabled();
  await expect(identity.getByRole("status")).toHaveText("Uploading…");
  hold.release();
  await expect(identity.getByRole("status")).toHaveText("Photo saved");
  // The photo is not a draft field, so the Save profile chip stays at rest.
  await expect(footer(page).getByRole("status")).toHaveText("Saved");
  expect(api.writes.at(-1)?.body).toEqual({ avatar_file_id: avatarFileId });
  await identity
    .getByRole("button", { name: "Remove photo", exact: true })
    .click();
  await expect(identity.getByRole("status")).toHaveText("Photo removed");
  await expect(footer(page).getByRole("status")).toHaveText("Saved");
});

test("the Appearance status says nothing at rest and Saved after a change", async ({
  page,
}) => {
  await installProfileApi(page);
  await page.goto("/settings#look");
  const appearance = settingsPanel(page).getByRole("region", {
    name: "Appearance",
    exact: true,
  });
  const motion = appearance.getByRole("switch", { name: "Reduce motion" });
  await expect(motion).toBeEnabled();
  await expect(appearance.getByText("Saved", { exact: true })).toHaveCount(0);
  await motion.click();
  await expect(appearance.getByRole("status")).toHaveText("Saved");
});

test("Start page lists only the sections this account can open, and keeps a hidden saved one readable", async ({
  page,
}) => {
  const api = await installProfileApi(page, { role: "member" });
  api.appearance.start_page = "sandbox";
  await page.goto("/settings#look");
  const start = page.getByRole("combobox", {
    name: "Start page after sign-in",
    exact: true,
  });
  await expect(start).toBeEnabled();
  await expect(start).toHaveValue("sandbox");
  await expect(start.getByRole("option")).toHaveText([
    "Automatic",
    "Sandbox (not available)",
    "Boards",
    "OpenComms",
    "OpenView",
    "Manage",
    "Platform",
  ]);
  await expect(
    start.getByRole("option", { name: "Sandbox (not available)" }),
  ).toBeDisabled();
});
