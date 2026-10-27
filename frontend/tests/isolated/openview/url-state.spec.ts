import { expect, test } from "@playwright/test";
import type { OpenViewDataSourceField } from "../../../src/components/systems/openview/adapters/views-api";
import {
  parseOpenViewUrl,
  serializeOpenViewUrl,
} from "../../../src/components/systems/openview/domain/model";
import {
  emptyDefinition,
  emptyPresentation,
} from "../../../src/components/systems/openview/domain/server-view-draft";
import { decodeTemporaryView } from "../../../src/components/systems/openview/domain/temporary-view";

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

test("a module page's Reports view keeps its report and copy in the address", () => {
  const moduleId = "00000000-0000-4000-8000-000000000103";
  const reportId = "00000000-0000-4000-8000-000000000105";
  const copyId = "00000000-0000-4000-8000-000000000106";
  const address = `/openview?section=views&module=${moduleId}&tab=reports&report=${reportId}&copy=${copyId}`;

  expect(parseOpenViewUrl(address)).toEqual({
    section: "views",
    module: moduleId,
    tab: "reports",
    report: reportId,
    copy: copyId,
    invalid: false,
  });
  expect(serializeOpenViewUrl(parseOpenViewUrl(address))).toBe(address);
  // Records is the page's first view, so it needs no tab.
  expect(
    serializeOpenViewUrl({
      section: "views",
      module: moduleId,
      tab: "records",
    }),
  ).toBe(`/openview?section=views&module=${moduleId}`);
  // A copy needs its report, and both are report ids.
  for (const query of [
    `tab=reports&copy=${copyId}`,
    "tab=reports&report=weekly",
    "tab=elsewhere",
  ])
    expect(
      parseOpenViewUrl(`/openview?section=views&module=${moduleId}&${query}`)
        .invalid,
    ).toBe(true);
});

for (const layout of ["kanban", "calendar", "timeline"]) {
  test(`an old address with the removed ${layout} layout opens Table and keeps its other changes`, () => {
    const moduleId = "00000000-0000-4000-8000-0000000000b1";
    const nameField = "00000000-0000-4000-8000-0000000000c1";
    const dueField = "00000000-0000-4000-8000-0000000000c2";
    const fields: OpenViewDataSourceField[] = [
      {
        id: nameField,
        moduleId,
        name: "Name",
        type: "text",
        required: false,
        position: 0,
        config: {},
      },
      {
        id: dueField,
        moduleId,
        name: "Due",
        type: "date",
        required: false,
        position: 1,
        config: {},
      },
    ];
    const base = {
      name: "All records",
      definition: emptyDefinition(fields),
      presentation: emptyPresentation(fields),
    };
    // The removed layouts' own settings travelled in the same address.
    const changes = Buffer.from(
      JSON.stringify({
        d: { search: "pump" },
        p: {
          layout,
          density: "compact",
          dateFieldId: dueField,
          timelineStartFieldId: dueField,
          timelineEndFieldId: dueField,
          timelineDeadlineFieldId: null,
          timelineProgressFieldId: null,
          dateRange: "quarter",
          scale: "month",
        },
      }),
      "utf8",
    ).toString("base64url");

    expect(decodeTemporaryView(changes, base, fields)).toEqual({
      name: "All records",
      definition: { ...base.definition, search: "pump" },
      presentation: {
        ...base.presentation,
        layout: "table",
        density: "compact",
      },
    });
  });
}
