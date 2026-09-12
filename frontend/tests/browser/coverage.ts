import { test as base, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export { expect };
export type { Page, Request, Route, Locator } from "@playwright/test";
export const test = base.extend<{ executableCoverage: void }>({
  executableCoverage: [
    async ({ page, browserName }, use, testInfo) => {
      if (process.env.FRONTEND_COVERAGE !== "1") return use();
      if (browserName !== "chromium")
        throw new Error("Coverage requires Chromium");
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await use();
      const entries = (await page.coverage.stopJSCoverage()).filter(
        (entry) =>
          /\/src\/.*\.tsx?(?:\?|$)/.test(entry.url) &&
          !entry.url.includes("node_modules") &&
          !entry.url.startsWith("about:"),
      );
      const directory = process.env.FRONTEND_COVERAGE_BROWSER_DIR;
      if (!directory) throw new Error("Missing browser capture directory");
      await mkdir(directory, { recursive: true });
      const compactEntries = [];
      for (const entry of entries) {
        const source = entry.source;
        if (typeof source !== "string")
          throw new Error(`Missing browser source: ${entry.url}`);
        const sourceHash = createHash("sha256").update(source).digest("hex");
        const sourcePath = join(directory, `source-${sourceHash}.json`);
        try {
          await writeFile(sourcePath, JSON.stringify({ sourceHash, source }), {
            flag: "wx",
          });
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          ))
            throw error;
        }
        const compactEntry = { ...entry, sourceHash } as Record<
          string,
          unknown
        >;
        delete compactEntry.source;
        compactEntries.push(compactEntry);
      }
      await writeFile(
        join(directory, `${randomUUID()}.json`),
        JSON.stringify({
          testId: testInfo.testId,
          status: testInfo.status,
          entries: compactEntries,
        }),
      );
    },
    { auto: true },
  ],
});
