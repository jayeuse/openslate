import { expect, test } from "@playwright/test";
import { resolveChartLegendLabel } from "../../../src/components/ui/chart";

test("chart legends fall back to the payload label when config keys differ", () => {
  expect(
    resolveChartLegendLabel(undefined, {
      value: "In progress",
      dataKey: "value",
    }),
  ).toBe("In progress");
});
