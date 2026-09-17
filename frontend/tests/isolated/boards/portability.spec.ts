import { expect, test } from "@playwright/test";
import { parseBoardConfiguration } from "../../../src/components/systems/boards/adapters/portability";

const configuration = {
  name: "Dispatch",
  description: "Daily handoffs",
  department: "Operations",
  defaultSection: "overview",
  widgets: [
    {
      name: "Requests",
      type: "records",
      moduleId: "service-requests",
      size: "half",
      pinned: false,
      refresh: "manual",
      fields: ["title"],
      filters: { logic: "and", clauses: [] },
      metric: "count",
      visualization: "bar",
    },
  ],
};
const bundle = (value: unknown) =>
  JSON.stringify({ version: 1, kind: "openslate-board", configuration: value });

test("a configuration imports its layout without accepting access or content", () => {
  const result = parseBoardConfiguration(bundle(configuration));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.configuration).toEqual(configuration);
  expect(
    parseBoardConfiguration(
      bundle({ ...configuration, visibleRoleIds: ["sample-member"] }),
    ).ok,
  ).toBe(false);
});

test("unknown sources, field references and oversized bundles are rejected before import", () => {
  expect(
    parseBoardConfiguration(
      bundle({
        ...configuration,
        widgets: [{ ...configuration.widgets[0], moduleId: "foreign" }],
      }),
    ).ok,
  ).toBe(false);
  expect(
    parseBoardConfiguration(
      bundle({
        ...configuration,
        widgets: [{ ...configuration.widgets[0], fields: ["password"] }],
      }),
    ).ok,
  ).toBe(false);
  expect(parseBoardConfiguration(" ".repeat(1024 * 1024 + 1)).ok).toBe(false);
  expect(parseBoardConfiguration("{broken").ok).toBe(false);
});
