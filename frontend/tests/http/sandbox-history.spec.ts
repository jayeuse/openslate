import { expect, test } from "./helpers/test";
import {
  historyRegions,
  historyVersionFixture,
  openAuthenticatedSandbox,
} from "./helpers/sandbox-api";
import { configuredSandboxDesign } from "../helpers/sandbox-fixtures";

// Phase 6 of the Sandbox UI/UX pass (docs/specs/sandbox-ui-ux-pass.md):
// HIS-1 to HIS-3.

const longName = "Before restoring the quarterly operations layout";
const versions = [
  historyVersionFixture(3, longName),
  historyVersionFixture(2, "Release snapshot", "published"),
  historyVersionFixture(1, "First draft"),
];

test("version names show in full at 1440", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  await page.goto("/sandbox?section=history");
  const { timeline } = historyRegions(page);
  const row = timeline.getByRole("button", { name: `View ${longName}` });
  await expect(row).toBeVisible();
  const name = row.getByText(longName, { exact: true });
  await expect(name).toBeVisible();
  expect(
    await name.evaluate((element) => ({
      ellipsis: getComputedStyle(element).textOverflow === "ellipsis",
      clipped: element.scrollWidth > element.clientWidth,
    })),
  ).toEqual({ ellipsis: false, clipped: false });
});

test("Compare with opens the comparison with that version preselected", async ({
  page,
}) => {
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  await page.goto("/sandbox?section=history");
  const { timeline, inspector, comparison } = historyRegions(page);
  await timeline.getByRole("button", { name: "View First draft" }).click();
  await inspector
    .getByLabel("Compare with", { exact: true })
    .selectOption({ label: "v2 · Release snapshot" });
  await inspector.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(
    comparison.getByLabel("Compare first version", { exact: true }),
  ).toHaveValue(versions[2]!.id);
  await expect(
    comparison.getByLabel("Compare second version", { exact: true }),
  ).toHaveValue(versions[1]!.id);
  // The comparison replaces the "Ready to compare" hint.
  await expect(comparison.getByText(/^Ready to compare/)).toHaveCount(0);
});

test("on a phone, a compare brings the comparison into view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
  await page.goto("/sandbox?section=history");
  const { timeline, inspector, comparison } = historyRegions(page);
  await timeline.getByRole("button", { name: "View First draft" }).click();
  await inspector.getByRole("button", { name: "Compare", exact: true }).click();
  // The comparison sits under the detail on a phone.
  const heading = comparison.getByRole("heading", { name: "Compare versions" });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
});

test("Delete version sits in Advanced in danger ink", async ({ page }) => {
  await page.addInitScript(() =>
    window.localStorage.setItem("openslate:advanced:sandbox.version", "open"),
  );
  await openAuthenticatedSandbox(page, configuredSandboxDesign, { versions });
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
