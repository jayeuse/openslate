import { expect, test } from "./helpers/test";
import { ids, mockAccessApi } from "./helpers/access-api";

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`S08 Access catalog search fits ${width}px ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const api = await mockAccessApi(page);
      api.on("GET", `/api/users/${ids.rosa}/preferences`, (route) =>
        route.fulfill({
          json: {
            user_id: ids.rosa,
            theme,
            appearance: { motion: "reduce", keyboard_shortcuts: true },
          },
        }),
      );
      await page.goto(`/access?view=groups&group=${ids.readers}&tab=access`);
      const sheet = page.getByRole("dialog", {
        name: "Finance readers",
        exact: true,
      });
      await expect(
        sheet.getByRole("searchbox", {
          name: "Search departments",
          exact: true,
        }),
      ).toBeVisible();
      await sheet
        .getByRole("button", { name: "Modules in Inventory", exact: true })
        .click();
      const search = sheet.getByRole("searchbox", {
        name: "Search modules in Inventory",
        exact: true,
      });
      await search.fill("Prices");
      await expect(
        sheet.getByLabel("Prices level", { exact: true }),
      ).toBeVisible();
      if (theme === "dark")
        await expect(page.locator("html")).toHaveClass(/dark/);
      else await expect(page.locator("html")).not.toHaveClass(/dark/);
      expect(
        await sheet.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`access-catalog-${width}-${theme}.png`),
        fullPage: true,
      });
      expect(api.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
    });
  }
