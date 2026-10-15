import { expect, test } from "@playwright/test";
import {
  parseOpenViewUrl,
  serializeOpenViewUrl,
} from "../../../src/components/systems/openview/domain/model";

test("legacy Board record links resolve to Views and reserialize to a canonical OpenView URL", () => {
  const legacyBoardLink = parseOpenViewUrl(
    "/openview?section=records&module=service-requests&record=sample-sr-1005",
  );

  expect(legacyBoardLink).toEqual({
    section: "views",
    module: "service-requests",
    record: "sample-sr-1005",
    invalid: false,
  });
  expect(serializeOpenViewUrl(legacyBoardLink)).toBe(
    "/openview?section=views&module=service-requests&record=sample-sr-1005",
  );
  expect(parseOpenViewUrl("/openview?section=records")).toEqual({
    section: "views",
    module: "service-requests",
    invalid: false,
  });
});

test("URL state only serializes allowlisted identifiers and record links resolve to Views", () => {
  expect(parseOpenViewUrl("/openview?record=sample-sr-1005")).toEqual({
    section: "views",
    module: "service-requests",
    record: "sample-sr-1005",
    invalid: false,
  });
  expect(
    parseOpenViewUrl(
      serializeOpenViewUrl({
        section: "dashboards",
        module: "customers",
        dashboard: "dashboard:customers",
      }),
    ),
  ).toEqual({
    section: "dashboards",
    module: "customers",
    dashboard: "dashboard:customers",
    invalid: false,
  });
  expect(parseOpenViewUrl("?record=../secrets").invalid).toBe(true);
  expect(parseOpenViewUrl("?view=" + "x".repeat(129)).invalid).toBe(true);
  expect(serializeOpenViewUrl({ record: "../secrets" })).toBe("/openview");
});

for (const target of [
  { name: "a malformed Report id", query: "report=invalid" },
  {
    name: "a run without its Report",
    query: "run=00000000-0000-4000-8000-000000000900",
  },
]) {
  test(`${target.name} is an invalid Report link that selects no Report or output`, () => {
    expect(
      parseOpenViewUrl(`/openview?section=reports&${target.query}`),
    ).toEqual({
      section: "reports",
      module: "service-requests",
      invalid: true,
      invalidReportSelection: true,
    });
  });
}
