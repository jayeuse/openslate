import { test as base } from "../coverage";
import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

const targetsFile = process.env.SCANNER_COVERAGE_TARGETS_FILE;
const targets: unknown = targetsFile
  ? JSON.parse(readFileSync(targetsFile, "utf8"))
  : [
      "src/components/files/",
      "workspace-logo-settings.tsx",
      "src/lib/files.ts",
    ];
if (
  !Array.isArray(targets) ||
  targets.length === 0 ||
  targets.some((target) => typeof target !== "string" || target.length === 0)
)
  throw new Error("Coverage capture requires source targets");

export const test = base.extend<{ scannerCoverage: void }>({
  scannerCoverage: [
    async ({ page, browserName }, use, testInfo) => {
      const enabled =
        process.env.SCANNER_COVERAGE === "1" && browserName === "chromium";
      if (enabled)
        await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await use();
      if (enabled) {
        const entries = await page.coverage.stopJSCoverage();
        const captured = await Promise.all(
          entries
            .filter((entry) =>
              targets.some((target: string) => entry.source?.includes(target)),
            )
            .map(async (entry) => {
              const reference = entry.source?.match(
                /^\s*\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/m,
              )?.[1];
              // Inline RSC/bootstrap scripts can mention source paths without
              // containing that module's executable code. Webpack's outer eval
              // wrappers also have no own mapping; V8 reports the mapped modules
              // separately. The converter still requires every requested target.
              if (!reference) return null;
              if (reference.startsWith("data:")) {
                const comma = reference.indexOf(",");
                const encoded = reference.slice(comma + 1);
                const source = reference.slice(0, comma).endsWith(";base64")
                  ? Buffer.from(encoded, "base64").toString("utf8")
                  : decodeURIComponent(encoded);
                return { ...entry, sourceMap: JSON.parse(source) };
              }
              const response = await page.request.get(
                new URL(reference, entry.url).href,
              );
              if (!response.ok())
                throw new Error(`Cannot read source map for ${entry.url}`);
              return { ...entry, sourceMap: await response.json() };
            }),
        );
        await writeFile(
          testInfo.outputPath("scanner-v8.json"),
          JSON.stringify(captured.filter((entry) => entry !== null)),
        );
      }
    },
    { auto: true },
  ],
});
