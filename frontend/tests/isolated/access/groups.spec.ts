import { expect, test } from "@playwright/test";

import {
  accessConflicts,
  accessDraftFromEntries,
  accessSummary,
  detailsConflicts,
  entriesFromAccessDraft,
  filterGroups,
  groupFiltersFromParams,
  groupRows,
  mergeMembers,
  resolveAccess,
  sameAccess,
  sameMembers,
  setDepartmentLevel,
  setModuleLevel,
  summaryLabel,
  type GroupFilters,
} from "../../../src/components/systems/access/helpers/groups";
import type {
  AccessDepartment,
  AccessGroup,
  AccessGroupAccessEntry,
  AccessModule,
} from "../../../src/components/systems/access/state/api-contracts";
import { accessModule, department, group } from "./fixtures";

const inventory = "00000000-0000-4000-8000-0000000000d1";
const finance = "00000000-0000-4000-8000-0000000000d2";
const hr = "00000000-0000-4000-8000-0000000000d3";
const gone = "00000000-0000-4000-8000-0000000000d9";
const prices = "00000000-0000-4000-8000-0000000000e1";
const stock = "00000000-0000-4000-8000-0000000000e2";
const ledger = "00000000-0000-4000-8000-0000000000e3";

const departments = [
  { ...department, id: inventory, department_name: "Inventory" },
  { ...department, id: finance, department_name: "Finance" },
  { ...department, id: hr, department_name: "People" },
] as AccessDepartment[];
const modules = [
  {
    ...accessModule,
    id: prices,
    department_id: inventory,
    module_name: "Prices",
  },
  {
    ...accessModule,
    id: stock,
    department_id: inventory,
    module_name: "Stock",
  },
  {
    ...accessModule,
    id: ledger,
    department_id: finance,
    module_name: "Ledger",
  },
] as AccessModule[];

const entry = (
  department_id: string,
  module_id: string | null,
  level: AccessGroupAccessEntry["level"],
): AccessGroupAccessEntry => ({ department_id, module_id, level });

const sorted = (entries: AccessGroupAccessEntry[]) =>
  [...entries].sort((left, right) =>
    `${left.department_id}:${left.module_id}`.localeCompare(
      `${right.department_id}:${right.module_id}`,
    ),
  );

test.describe("access draft and group_access entries", () => {
  test("a department level and module overrides round-trip without loss", () => {
    const entries = [
      entry(inventory, null, "write"),
      entry(inventory, prices, "read"),
      entry(finance, ledger, "manage"),
      // A department missing from the catalog is kept, so a full
      // replacement never drops it silently.
      entry(gone, null, "read"),
    ];
    const draft = accessDraftFromEntries(entries);
    expect(draft[inventory]).toEqual({
      level: "write",
      modules: { [prices]: "read" },
    });
    expect(draft[finance]).toEqual({
      level: null,
      modules: { [ledger]: "manage" },
    });
    expect(sorted(entriesFromAccessDraft(draft))).toEqual(sorted(entries));
  });

  test("None removes the department row but keeps module overrides", () => {
    let draft = accessDraftFromEntries([
      entry(inventory, null, "write"),
      entry(inventory, prices, "read"),
    ]);
    draft = setDepartmentLevel(draft, inventory, null);
    expect(entriesFromAccessDraft(draft)).toEqual([
      entry(inventory, prices, "read"),
    ]);
    draft = setModuleLevel(draft, inventory, prices, null);
    expect(entriesFromAccessDraft(draft)).toEqual([]);
    expect(draft[inventory]).toBeUndefined();
  });

  test("a module set to the same as its department is an override only when chosen explicitly", () => {
    let draft = accessDraftFromEntries([]);
    draft = setDepartmentLevel(draft, inventory, "read");
    draft = setModuleLevel(draft, inventory, stock, "write");
    expect(sorted(entriesFromAccessDraft(draft))).toEqual(
      sorted([
        entry(inventory, null, "read"),
        entry(inventory, stock, "write"),
      ]),
    );
    // "Same as department" removes the module row: it inherits again.
    draft = setModuleLevel(draft, inventory, stock, null);
    expect(entriesFromAccessDraft(draft)).toEqual([
      entry(inventory, null, "read"),
    ]);
  });

  test("the same access in another order is unchanged", () => {
    expect(
      sameAccess(
        [entry(inventory, null, "read"), entry(finance, null, "write")],
        [entry(finance, null, "write"), entry(inventory, null, "read")],
      ),
    ).toBe(true);
    expect(
      sameAccess(
        [entry(inventory, null, "read")],
        [entry(inventory, null, "write")],
      ),
    ).toBe(false);
  });
});

test.describe("access summary", () => {
  test("names each department with its level and counts module overrides", () => {
    const summary = accessSummary(
      [
        entry(inventory, null, "write"),
        entry(inventory, prices, "read"),
        entry(finance, ledger, "manage"),
        entry(gone, null, "read"),
      ],
      departments,
      modules,
    );
    expect(summary.map(summaryLabel)).toEqual([
      "Finance · 1 module",
      "Inventory · Write + 1 module",
      "Unavailable department · Read",
    ]);
    expect(summary[1]?.modules).toEqual([
      { id: prices, name: "Prices", level: "read", levelLabel: "Read" },
    ]);
  });
});

test.describe("group list", () => {
  const base = group as AccessGroup;
  const groups: AccessGroup[] = [
    {
      ...base,
      id: "00000000-0000-4000-8000-0000000000a1",
      name: "Inventory clerks",
      description: "Stock counts",
      member_ids: ["a", "b"],
      access: [entry(inventory, null, "write")],
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      ...base,
      id: "00000000-0000-4000-8000-0000000000a2",
      name: "auditors",
      description: "",
      member_ids: [],
      access: [entry(finance, null, "read")],
      created_at: "2026-03-01T00:00:00Z",
    },
    {
      ...base,
      id: "00000000-0000-4000-8000-0000000000a3",
      name: "New hires",
      description: "Starts empty",
      member_ids: ["c"],
      access: [],
      created_at: "2026-02-01T00:00:00Z",
    },
  ];
  const rows = groupRows(groups, departments, modules);
  const filters: GroupFilters = { query: "", sort: "name", filter: "all" };

  test("sorts by name ignoring case, by members, or newest first", () => {
    expect(filterGroups(rows, filters).map((row) => row.group.name)).toEqual([
      "auditors",
      "Inventory clerks",
      "New hires",
    ]);
    expect(
      filterGroups(rows, { ...filters, sort: "members" }).map(
        (row) => row.group.name,
      ),
    ).toEqual(["Inventory clerks", "New hires", "auditors"]);
    expect(
      filterGroups(rows, { ...filters, sort: "newest" }).map(
        (row) => row.group.name,
      ),
    ).toEqual(["auditors", "New hires", "Inventory clerks"]);
  });

  test("searches name, description and reached departments, and filters gaps", () => {
    const names = (next: Partial<GroupFilters>) =>
      filterGroups(rows, { ...filters, ...next }).map((row) => row.group.name);
    expect(names({ query: "stock" })).toEqual(["Inventory clerks"]);
    expect(names({ query: "finance" })).toEqual(["auditors"]);
    expect(names({ filter: "no-access" })).toEqual(["New hires"]);
    expect(names({ filter: "no-members" })).toEqual(["auditors"]);
  });

  test("reads the gap filter from the URL and ignores unknown values", () => {
    expect(
      groupFiltersFromParams(new URLSearchParams("filter=no-access")).filter,
    ).toBe("no-access");
    expect(
      groupFiltersFromParams(new URLSearchParams("filter=everything")).filter,
    ).toBe("all");
  });
});

test.describe("group save merges", () => {
  test("member changes apply onto a newer member list", () => {
    // Someone else added dee and removed cy; the draft added eve and removed ben.
    expect(
      mergeMembers(["ana", "dee"], ["ana", "ben", "cy"], ["ana", "cy", "eve"]),
    ).toEqual(["ana", "dee", "eve"]);
    expect(sameMembers(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameMembers(["a"], ["a", "b"])).toBe(false);
  });

  test("name and description conflict only when both sides changed them differently", () => {
    const baseline = { name: "Clerks", description: "Old" };
    expect(
      detailsConflicts({ name: "Stock clerks", description: "Old" }, baseline, {
        name: "Inventory clerks",
        description: "New",
      }).map((conflict) => conflict.id),
    ).toEqual(["name"]);
  });

  test("access conflicts are per department or module, and choices resolve them", () => {
    const baseline = [entry(inventory, null, "read")];
    const current = [
      entry(inventory, null, "write"),
      entry(finance, null, "read"),
    ];
    const draft = [
      entry(inventory, null, "manage"),
      entry(inventory, prices, "read"),
    ];
    const conflicts = accessConflicts(
      current,
      baseline,
      draft,
      departments,
      modules,
    );
    expect(conflicts).toEqual([
      {
        id: `${inventory}:*`,
        label: "Inventory",
        current: "Write",
        draft: "Manage",
      },
    ]);
    expect(
      sorted(
        resolveAccess(current, baseline, draft, {
          [`${inventory}:*`]: "current",
        }),
      ),
    ).toEqual(
      sorted([
        entry(inventory, null, "write"),
        entry(inventory, prices, "read"),
        entry(finance, null, "read"),
      ]),
    );
  });
});
