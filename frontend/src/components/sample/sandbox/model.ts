import { MODULE_TABLE, moduleTableHeight } from "@/lib/sandbox/x6-adapter";
import type { SandboxCanvasLayout } from "@/components/sandbox/sandbox-canvas";

export type Field = {
  id: string;
  name: string;
  type: string;
  required: boolean;
  value: string;
  options: string;
  closed: boolean;
  description?: string;
};
export type Department = { id: string; name: string; closed: boolean };
export type Module = {
  id: string;
  department: string;
  name: string;
  closed: boolean;
  fields: Field[];
  x: number;
  y: number;
};
export type Relationship = {
  id: string;
  name: string;
  source: string;
  target: string;
  cardinality: string;
};
export type Rule = {
  id: string;
  name: string;
  trigger: string;
  condition: string;
  action: string;
  enabled: boolean;
};
export type DesignUpdate = Design | ((previous: Design) => Design);
export type Design = {
  layout?: SandboxCanvasLayout;
  departments: Department[];
  modules: Module[];
  relationships: Relationship[];
  rules: Rule[];
};
export type Version = {
  id: string;
  label: string;
  design: Design;
  published: boolean;
  date: string;
};
export const uid = () => `sample-${crypto.randomUUID()}`;
const fields = (names: string[]): Field[] =>
  names.map((name, i) => ({
    id: `sample-field-${name}`,
    name,
    type: i === 2 ? "Select" : "Text",
    required: i === 0,
    value: "",
    options: i === 2 ? "Open, In progress, Complete" : "",
    closed: false,
  }));
export const initialDesign: Design = {
  departments: [
    { id: "sample-operations", name: "Operations", closed: false },
    { id: "sample-commercial", name: "Commercial", closed: false },
  ],
  modules: [
    {
      id: "sample-requests",
      department: "sample-operations",
      name: "Service requests",
      closed: false,
      fields: fields(["Request number", "Title", "Status", "Priority"]),
      x: 0,
      y: 0,
    },
    {
      id: "sample-equipment",
      department: "sample-operations",
      name: "Equipment",
      closed: false,
      fields: fields(["Asset tag", "Name", "Status", "Location"]),
      x: 340,
      y: 0,
    },
    {
      id: "sample-customers",
      department: "sample-commercial",
      name: "Customers",
      closed: false,
      fields: fields(["Customer ID", "Name", "Status", "Email"]),
      x: 170,
      y: 360,
    },
  ],
  relationships: [
    {
      id: "sample-uses",
      name: "Uses equipment",
      source: "sample-requests",
      target: "sample-equipment",
      cardinality: "One-to-many",
    },
  ],
  rules: [
    {
      id: "sample-urgent",
      name: "Urgent request alert",
      trigger: "New record",
      condition: "Priority is urgent",
      action: "Send a notification",
      enabled: true,
    },
  ],
};
export const counts = (d: Design) =>
  `${d.departments.length} departments · ${d.modules.length} modules · ${d.modules.reduce((n, m) => n + m.fields.length, 0)} fields · ${d.relationships.length} relationships · ${d.rules.length} rules`;
export function reorder<T>(items: T[], index: number, delta: number): T[] {
  const next = [...items];
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

// The sample starts compact; the standalone editor keeps its own defaults.
export const compactDefaultLayout: SandboxCanvasLayout = {
  "sample-operations": { x: 24, y: 24, width: 656, height: 240 },
  "sample-commercial": { x: 184, y: 296, width: 336, height: 240 },
  "sample-requests": {
    x: 48,
    y: 72,
    width: MODULE_TABLE.width,
    height: moduleTableHeight(initialDesign.modules[0].fields.length),
  },
  "sample-equipment": {
    x: 376,
    y: 72,
    width: MODULE_TABLE.width,
    height: moduleTableHeight(initialDesign.modules[1].fields.length),
  },
  "sample-customers": {
    x: 208,
    y: 344,
    width: MODULE_TABLE.width,
    height: moduleTableHeight(initialDesign.modules[2].fields.length),
  },
};

export function changesFrom(
  previous: Design | undefined,
  next: Design,
): string[] {
  if (!previous) return ["Initial sample publication"];
  const changes: string[] = [];
  const groups = [
    {
      name: "Department",
      before: previous.departments,
      after: next.departments,
    },
    { name: "Module", before: previous.modules, after: next.modules },
    {
      name: "Relationship",
      before: previous.relationships,
      after: next.relationships,
    },
    { name: "Rule", before: previous.rules, after: next.rules },
  ];
  for (const group of groups) {
    for (const item of group.after) {
      const old = group.before.find((entry) => entry.id === item.id);
      if (!old) changes.push(`${group.name} added: ${item.name}`);
      else if (JSON.stringify(old) !== JSON.stringify(item))
        changes.push(`${group.name} updated: ${item.name}`);
    }
    for (const item of group.before)
      if (!group.after.some((entry) => entry.id === item.id))
        changes.push(`${group.name} removed: ${item.name}`);
    if (
      group.before.map((item) => item.id).join() !==
        group.after.map((item) => item.id).join() &&
      group.before.length === group.after.length
    )
      changes.push(`${group.name} order changed`);
  }
  if (
    JSON.stringify(previous.layout ?? compactDefaultLayout) !==
    JSON.stringify(next.layout ?? compactDefaultLayout)
  )
    changes.push("Canvas layout updated");
  return changes.length
    ? changes
    : ["No structural changes since the last publication."];
}

export const initialSandboxHistory: {
  past: Design[];
  present: Design;
  future: Design[];
} = { past: [], present: initialDesign, future: [] };
