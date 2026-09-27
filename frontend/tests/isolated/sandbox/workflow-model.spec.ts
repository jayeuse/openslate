import { expect, test } from "@playwright/test";
import {
  appendVersion,
  changesFrom,
  counts,
  normalizeField,
  type Design,
  type Version,
} from "../../../src/components/systems/sandbox/domain/model";
import { configuredSandboxDesign as initialDesign } from "../../helpers/sandbox-fixtures";

function fixture(): Design {
  return structuredClone(initialDesign);
}

test("semantic version changes distinguish every supported design category", () => {
  const before = fixture();
  const after = fixture();
  after.departments[0] = {
    ...after.departments[0],
    name: "Field operations",
    closed: true,
  };
  after.departments.push({
    id: "quality",
    name: "Quality",
    closed: false,
  });
  after.modules[0] = {
    ...after.modules[0],
    name: "Requests",
    closed: true,
    fields: [
      {
        ...after.modules[0].fields[1],
        name: "Summary",
        required: true,
        config: { kind: "text", defaultValue: "Draft", maxLength: 120 },
      },
      after.modules[0].fields[0],
      after.modules[0].fields[2],
      { ...after.modules[0].fields[3], closed: true },
      {
        id: "resolution",
        name: "Resolution",
        type: "Long text",
        required: false,
        value: "",
        options: "",
        closed: false,
      },
    ],
  };
  after.modules.splice(1, 1);
  after.relationships[0] = {
    ...after.relationships[0],
    name: "Uses assigned equipment",
  };
  after.rules[0] = { ...after.rules[0], enabled: false };
  after.layout = {
    "sample-requests": { x: 96, y: 72, width: 304, height: 220 },
  };

  expect(changesFrom(before, after)).toEqual([
    "Department changed: Operations → Field operations",
    "Department closed: Field operations",
    "Department added: Quality",
    "Module changed: Service requests → Requests",
    "Module closed: Requests",
    "Field changed: Requests · Title → Summary",
    "Field settings changed: Requests · Summary",
    "Field closed: Requests · Priority",
    "Field added: Requests · Resolution",
    "Field order changed: Requests",
    "Module removed: Equipment",
    "Field removed: Equipment · Asset tag",
    "Field removed: Equipment · Name",
    "Field removed: Equipment · Status",
    "Field removed: Equipment · Location",
    "Relationship changed: Uses assigned equipment",
    "Automation changed: Urgent request alert",
    "Canvas layout changed",
  ]);
});

test("semantic version changes report reopen, removal, and reorder without false positives", () => {
  const before = fixture();
  before.departments[0].closed = true;
  before.modules[0].closed = true;
  before.modules[0].fields[0].closed = true;
  before.rules.push({
    id: "second-rule",
    name: "Second rule",
    trigger: "New record",
    condition: "Always",
    action: "Send a notification",
    enabled: true,
  });
  before.rules.push({
    id: "removed-rule",
    name: "Removed rule",
    trigger: "New record",
    condition: "Always",
    action: "Send a notification",
    enabled: true,
  });
  const after = fixture();
  after.modules[0].fields.splice(1, 1);
  after.relationships = [...after.relationships].reverse();
  after.rules = [
    before.rules[1],
    before.rules[0],
    {
      id: "third-rule",
      name: "Third rule",
      trigger: "New record",
      condition: "Always",
      action: "Send a notification",
      enabled: true,
    },
  ];

  expect(changesFrom(before, after)).toEqual([
    "Department reopened: Operations",
    "Module reopened: Service requests",
    "Field reopened: Service requests · Request number",
    "Field removed: Service requests · Title",
    "Automation added: Third rule",
    "Automation removed: Removed rule",
    "Automation order changed",
  ]);
  expect(changesFrom(after, structuredClone(after))).toEqual([
    "No structural changes since the last publication.",
  ]);
});

test("version appends retain only the newest fifty entries", () => {
  const versions: Version[] = Array.from({ length: 50 }, (_, index) => ({
    id: `version-${index}`,
    label: `Version ${index}`,
    design: fixture(),
    published: false,
    date: "Synthetic",
  }));
  const latest: Version = {
    id: "latest",
    label: "Latest",
    design: fixture(),
    published: true,
    date: "Synthetic",
  };

  expect(appendVersion(versions, latest).map((version) => version.id)).toEqual([
    ...versions.slice(1).map((version) => version.id),
    "latest",
  ]);
});

test("semantic version changes report department and module reorder only once", () => {
  const before = fixture();
  const after = fixture();
  after.departments.reverse();
  after.modules.reverse();

  expect(changesFrom(before, after)).toEqual([
    "Department order changed",
    "Module order changed",
  ]);
});

test("semantic version changes include fields contained by added and removed modules", () => {
  const before = fixture();
  const after = fixture();
  after.modules.splice(1, 1);
  after.modules.push({
    id: "quality-checks",
    department: "sample-operations",
    name: "Quality checks",
    closed: false,
    x: 0,
    y: 0,
    fields: [
      {
        id: "finding",
        name: "Finding",
        type: "Text",
        required: false,
        value: "",
        options: "",
        closed: false,
      },
    ],
  });

  expect(changesFrom(before, after)).toEqual([
    "Module added: Quality checks",
    "Field added: Quality checks · Finding",
    "Module removed: Equipment",
    "Field removed: Equipment · Asset tag",
    "Field removed: Equipment · Name",
    "Field removed: Equipment · Status",
    "Field removed: Equipment · Location",
  ]);
});

test("semantic version changes ignore equivalent normalized field storage", () => {
  const before = fixture();
  const after = fixture();
  after.modules = after.modules.map((sandboxModule) => ({
    ...sandboxModule,
    fields: sandboxModule.fields.map(normalizeField),
  }));

  expect(changesFrom(before, after)).toEqual([
    "No structural changes since the last publication.",
  ]);
});

test("the design summary names automations and counts one of each in the singular", () => {
  const design = fixture();
  expect(counts({ ...design, rules: design.rules.slice(0, 1) })).toMatch(
    / · 1 automation$/,
  );
  expect(
    counts({ departments: [], modules: [], relationships: [], rules: [] }),
  ).toBe(
    "0 departments · 0 modules · 0 fields · 0 relationships · 0 automations",
  );
});
