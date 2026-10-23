import { expect, test, defaultSignedInIdentity } from "./helpers/test";
import {
  historyRegions,
  historyVersionFixture,
  openAuthenticatedSandbox,
} from "./helpers/sandbox-api";
import {
  configuredSandboxDesign,
  sandboxDocumentFromDesign,
} from "../helpers/sandbox-fixtures";

// History (docs/specs/sandbox-relayout.md S8, S9, S10): a version list of
// 40px rows grouped by day, with automatic saves folded, and a version detail
// that holds Restore, the facts, Compare (Older, then Newer), and Advanced.

const discardNote = "Saved automatically before discarding draft changes.";
const longName = "Before restoring the quarterly operations layout";

function at(
  sequence: number,
  label: string,
  createdAt: string,
  kind = "checkpoint",
  note: string | null = null,
) {
  return { ...historyVersionFixture(sequence, label, kind, note), createdAt };
}

// Two days, newest first, with 6 automatic saves (4 and 2).
const versions = [
  at(62, "Stock counts module", "2026-10-18T11:40:00Z"),
  at(61, "Before restore", "2026-10-18T11:32:00Z"),
  at(60, "Before discard", "2026-10-18T11:05:00Z", "checkpoint", discardNote),
  {
    ...at(58, "Q4 structure", "2026-10-18T10:05:00Z", "published"),
    note: "Approved by operations.",
    performedBy: defaultSignedInIdentity.id,
  },
  at(57, "Before restore", "2026-10-18T10:01:00Z"),
  at(55, longName, "2026-10-18T09:58:00Z"),
  at(54, "Before discard", "2026-10-18T09:30:00Z", "checkpoint", discardNote),
  at(50, "Initial organization design", "2026-10-18T09:12:00Z", "published"),
  at(49, "Harbor template", "2026-10-18T09:02:00Z", "imported"),
  at(44, "Departments drafted", "2026-10-17T16:31:00Z"),
  at(43, "Before discard", "2026-10-17T16:12:00Z", "checkpoint", discardNote),
  at(42, "Before restore", "2026-10-17T15:00:00Z"),
  at(40, "First modules", "2026-10-17T14:20:00Z"),
  // A person's own checkpoint with a system-like name is not folded.
  at(39, "Before discard", "2026-10-17T13:00:00Z"),
  at(38, "Starter import", "2026-10-17T09:00:00Z", "imported"),
];
const byLabel = (label: string) =>
  versions.find((version) => version.label === label)!;

async function openHistory(
  page: Parameters<typeof openAuthenticatedSandbox>[0],
) {
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  await page.goto("/sandbox?section=history");
  const regions = historyRegions(page);
  await expect(
    regions.timeline.getByRole("button", { name: "View Stock counts module" }),
  ).toBeVisible();
  return regions;
}

test("the version list shows 40px rows with a kind word, grouped by day", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { timeline, inspector } = await openHistory(page);
  await expect(
    timeline.getByRole("heading", { level: 2, name: "Versions", exact: true }),
  ).toBeVisible();
  await expect(timeline).toContainText("15 saved versions");
  await expect(
    timeline.getByText("October 18, 2026", { exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByText("October 17, 2026", { exact: true }),
  ).toBeVisible();
  for (const [label, kind, time, number] of [
    ["Stock counts module", "Checkpoint", "11:40 AM", "v62"],
    ["Q4 structure", "Published", "10:05 AM", "v58"],
    ["Harbor template", "Imported", "9:02 AM", "v49"],
  ]) {
    const row = timeline.getByRole("button", {
      name: `View ${label}`,
      exact: true,
    });
    await expect(row).toContainText(kind!);
    await expect(row).toContainText(time!);
    await expect(row).toContainText(number!);
    expect((await row.boundingBox())!.height).toBeCloseTo(40, 0);
  }
  // A long name stays on one line; the row keeps it as its title and the
  // detail shows it in full.
  const longRow = timeline.getByRole("button", { name: `View ${longName}` });
  const name = longRow.getByText(longName, { exact: true });
  await expect(name).toHaveAttribute("title", longName);
  expect((await longRow.boundingBox())!.height).toBeCloseTo(40, 0);
  await longRow.click();
  await expect(longRow).toHaveAttribute("aria-current", "true");
  await expect(
    inspector.getByRole("heading", { level: 2, name: longName, exact: true }),
  ).toBeVisible();
});

test("quick filters replace the kind select and still filter on the server", async ({
  page,
}) => {
  const kinds: (string | null)[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/sandbox/versions")
      kinds.push(url.searchParams.get("kind"));
  });
  const { timeline } = await openHistory(page);
  await expect(timeline.getByRole("combobox")).toHaveCount(0);
  const filters = timeline.getByRole("group", {
    name: "Filter versions",
    exact: true,
  });
  await expect(filters.getByRole("button", { pressed: true })).toHaveText(
    "All",
  );
  await filters.getByRole("button", { name: "Published", exact: true }).click();
  await expect.poll(() => kinds.at(-1)).toBe("published");
  await expect(
    timeline.getByRole("button", { name: "View Harbor template" }),
  ).toHaveCount(0);
  await expect(
    timeline.getByRole("button", { name: "View Q4 structure" }),
  ).toBeVisible();
  await expect(timeline).toContainText("2 saved versions");

  await filters.getByRole("button", { name: "Imported", exact: true }).click();
  await expect.poll(() => kinds.at(-1)).toBe("imported");
  await expect(
    timeline.getByRole("button", { name: "View Harbor template" }),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: "View Q4 structure" }),
  ).toHaveCount(0);

  // Automatic saves are checkpoints, so they fold under Checkpoints too.
  await filters
    .getByRole("button", { name: "Checkpoints", exact: true })
    .click();
  await expect.poll(() => kinds.at(-1)).toBe("checkpoint");
  await expect(
    timeline.getByText("4 automatic saves hidden", { exact: true }),
  ).toBeVisible();

  // All reuses the cached first page.
  await filters.getByRole("button", { name: "All", exact: true }).click();
  await expect(
    timeline.getByRole("button", { name: "View Harbor template" }),
  ).toBeVisible();
});

test("automatic saves fold into one row per day, and Show lists them as Automatic", async ({
  page,
}) => {
  const { timeline } = await openHistory(page);
  const automaticRows = timeline.getByRole("button", {
    name: /^View Before (restore|discard), version (61|60|57|54|43|42)$/,
  });
  await expect(automaticRows).toHaveCount(0);
  await expect(
    timeline.getByText("4 automatic saves hidden", { exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByText("2 automatic saves hidden", { exact: true }),
  ).toBeVisible();
  // The person's own "Before discard" stays in the list as a checkpoint.
  const ownCheckpoint = timeline.getByRole("button", {
    name: "View Before discard, version 39",
    exact: true,
  });
  await expect(ownCheckpoint).toContainText("Checkpoint");

  await timeline
    .getByRole("button", { name: "Show automatic saves" })
    .first()
    .click();
  await expect(automaticRows).toHaveCount(6);
  for (const row of await automaticRows.all()) {
    await expect(row).toContainText("Automatic");
    await expect(row).not.toContainText("Checkpoint");
  }
  // Each viewer's choice is remembered, under that viewer's own key.
  await page.reload();
  await expect(automaticRows).toHaveCount(6);
  expect(
    await page.evaluate(
      (key) => window.localStorage.getItem(key),
      `openslate:sandbox.history.automatic-saves:${defaultSignedInIdentity.id}`,
    ),
  ).toBe("shown");
  await timeline
    .getByRole("button", { name: "Hide automatic saves" })
    .first()
    .click();
  await expect(automaticRows).toHaveCount(0);
  await page.reload();
  await expect(
    timeline.getByText("4 automatic saves hidden", { exact: true }),
  ).toBeVisible();
  await expect(automaticRows).toHaveCount(0);
});

test("a search shows the automatic saves it finds, and each opens its detail", async ({
  page,
}) => {
  // Another viewer's choice to list them does not apply to this one.
  await page.addInitScript(() =>
    window.localStorage.setItem(
      "openslate:sandbox.history.automatic-saves:00000000-0000-4000-8000-0000000000ff",
      "shown",
    ),
  );
  const { timeline, inspector } = await openHistory(page);
  await expect(
    timeline.getByText("4 automatic saves hidden", { exact: true }),
  ).toBeVisible();
  await timeline.getByLabel("Find a version").fill("Before restore");
  const restoreRows = timeline.getByRole("button", {
    name: /^View Before restore, version (61|57|42)$/,
  });
  await expect(restoreRows).toHaveCount(3);
  await expect(timeline.getByText(/automatic saves? hidden/)).toHaveCount(0);
  await timeline
    .getByRole("button", { name: "View Before restore, version 42" })
    .click();
  await expect(
    inspector.getByRole("heading", { level: 2, name: "Before restore" }),
  ).toBeVisible();
  await expect(inspector).toContainText("Automatic");
  await expect(inspector).toContainText("v42");
});

test("Compare sits in the version detail, older to newer, with the version before preselected", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const older = byLabel("Harbor template");
  const newer = byLabel("Initial organization design");
  const before = sandboxDocumentFromDesign(configuredSandboxDesign);
  const after = sandboxDocumentFromDesign(configuredSandboxDesign);
  before.design.modules = before.design.modules.slice(1);
  let reads = 0;
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  await page.route("**/api/sandbox/versions/*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    reads++;
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const version = versions.find((item) => item.id === id)!;
    await route.fulfill({
      json: { ...version, document: id === older.id ? before : after },
    });
  });
  await page.goto("/sandbox?section=history");
  const { timeline, inspector } = historyRegions(page);
  const comparison = inspector.getByRole("region", {
    name: "Version comparison",
    exact: true,
  });
  const olderChoice = comparison.getByLabel("Older", { exact: true });
  const newerChoice = comparison.getByLabel("Newer", { exact: true });

  // Each inspected version preselects itself as Newer and the one before it.
  await timeline
    .getByRole("button", { name: "View Stock counts module" })
    .click();
  // v61 is an automatic save; it is still the version before v62.
  await expect(olderChoice).toHaveValue(versions[1]!.id);
  await expect(newerChoice).toHaveValue(versions[0]!.id);
  await timeline
    .getByRole("button", { name: "View Initial organization design" })
    .click();
  await expect(olderChoice).toHaveValue(older.id);
  await expect(newerChoice).toHaveValue(newer.id);
  expect((await olderChoice.boundingBox())!.x).toBeLessThan(
    (await newerChoice.boundingBox())!.x,
  );
  expect(reads).toBe(0);

  await comparison.getByRole("button", { name: "Compare" }).click();
  const result = comparison.getByRole("table", {
    name: "Changes from v49 · Harbor template to v50 · Initial organization design",
    exact: true,
  });
  await expect(result).toBeVisible();
  await expect(result.getByRole("row", { name: /^Modules/ })).toContainText(
    "1 added",
  );
  expect(reads).toBe(2);

  // One entry point: no second Compare in the detail, no Before and After.
  await expect(page.getByLabel("Compare with")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Compare versions" }),
  ).toHaveCount(0);
  await expect(comparison.getByText(/^(Before|After)\b/)).toHaveCount(0);
});

test("Restore is a quiet button in the version head and keeps its confirmation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { timeline, inspector } = await openHistory(page);
  await timeline.getByRole("button", { name: "View Q4 structure" }).click();
  const heading = inspector.getByRole("heading", {
    level: 2,
    name: "Q4 structure",
    exact: true,
  });
  const restore = inspector.getByRole("button", {
    name: "Restore version",
    exact: true,
  });
  const [headingBox, restoreBox, panelBox] = await Promise.all([
    heading.boundingBox(),
    restore.boundingBox(),
    inspector.boundingBox(),
  ]);
  // Beside the title, not a full-width button under the facts.
  expect(Math.abs(restoreBox!.y - headingBox!.y)).toBeLessThan(16);
  expect(restoreBox!.width).toBeLessThan(panelBox!.width / 4);
  // The facts are label-left rows; the viewer's own save says "You".
  await expect(inspector.getByRole("term")).toHaveText(["Saved", "Note"]);
  await expect(inspector.getByRole("definition").first()).toContainText(
    "Oct 18, 2026, 10:05 AM · You",
  );
  await expect(inspector.getByRole("definition").nth(1)).toHaveText(
    "Approved by operations.",
  );

  await restore.click();
  const dialog = page.getByRole("alertdialog", {
    name: "Restore Q4 structure?",
  });
  await expect(dialog).toContainText(
    "Your current draft is saved as a checkpoint first. Live data stays as it is.",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(restore).toBeFocused();
});

test("on a phone, the list opens one version's detail with a back link", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { timeline, inspector } = await openHistory(page);
  await expect(inspector).toBeHidden();
  const row = timeline.getByRole("button", {
    name: "View Initial organization design",
  });
  // Two lines: the label, then the kind, time, and number.
  await expect(row).toContainText("Published · 9:12 AM · v50");
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await row.click();
  await expect(timeline).toBeHidden();
  const heading = inspector.getByRole("heading", {
    level: 2,
    name: "Initial organization design",
  });
  await expect(heading).toBeFocused();

  // A compare brings its result into view under the facts.
  const comparison = inspector.getByRole("region", {
    name: "Version comparison",
  });
  await comparison.getByRole("button", { name: "Compare" }).click();
  await expect(comparison.getByRole("table")).toBeInViewport();
  await expect(
    comparison.getByRole("heading", { name: "Compare", exact: true }),
  ).toBeFocused();

  await inspector.getByRole("button", { name: "Back to Versions" }).click();
  await expect(inspector).toBeHidden();
  await expect(row).toBeFocused();
});

test("Delete version sits in Advanced in danger ink", async ({ page }) => {
  await page.addInitScript(() =>
    window.localStorage.setItem("openslate:advanced:sandbox.version", "open"),
  );
  await openAuthenticatedSandbox(page, configuredSandboxDesign, {
    versions: [
      historyVersionFixture(3, longName),
      historyVersionFixture(2, "Release snapshot", "published"),
      historyVersionFixture(1, "First draft"),
    ],
  });
  await page.goto("/sandbox?section=history");
  const { timeline, inspector } = historyRegions(page);
  await timeline.getByRole("button", { name: "View First draft" }).click();
  const remove = inspector.getByRole("button", {
    name: "Delete version",
    exact: true,
  });
  await expect(remove).toBeVisible();
  const colors = await remove.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--danger-text)";
    element.append(probe);
    const danger = getComputedStyle(probe).color;
    probe.remove();
    return { button: getComputedStyle(element).color, danger };
  });
  expect(colors.button).toBe(colors.danger);

  // A published version is kept, and the button says why.
  await timeline.getByRole("button", { name: "View Release snapshot" }).click();
  await expect(remove).toHaveAttribute("aria-disabled", "true");
  await expect(remove).toHaveAccessibleDescription(
    "Published versions are kept.",
  );
});
