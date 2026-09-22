import type {
  Design,
  Field,
} from "../../src/components/systems/sandbox/domain/model";

function fields(names: string[]): Field[] {
  return names.map((name, index) => ({
    id: `sample-field-${name}`,
    name,
    type: index === 2 ? "Select" : "Text",
    required: index === 0,
    value: "",
    options: index === 2 ? "Open, In progress, Complete" : "",
    closed: false,
  }));
}

export const configuredSandboxDesign: Design = {
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
      fieldMappings: [],
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
