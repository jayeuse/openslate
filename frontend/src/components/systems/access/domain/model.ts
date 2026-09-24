import { INITIAL_RECORDS } from "../../shared/data/sample-data";

export type Person = {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  departments: string[];
  primary: string;
  departmentIds?: string[];
  primaryDepartmentId?: string;
  title: string;
  activity: string[];
  accessStatus?: "active" | "pending" | "disabled" | "revoked" | "suspended";
  groupIds?: string[];
  expiresAt?: string;
};
const basePeople: Person[] = [
  {
    id: "sample-mara",
    name: "Mara Santos",
    email: "mara@example.invalid",
    role: "sample-admin",
    active: true,
    departments: ["Operations", "Finance"],
    primary: "Operations",
    title: "Operations director",
    activity: ["Created the organization", "Published dispatch workflow"],
  },
  {
    id: "sample-eli",
    name: "Eli Cruz",
    email: "eli@example.invalid",
    role: "sample-member",
    active: true,
    departments: ["Operations"],
    primary: "Operations",
    title: "Dispatch coordinator",
    activity: ["Updated work order WO-1042"],
  },
  {
    id: "sample-nina",
    name: "Nina Reyes",
    email: "nina@example.invalid",
    role: "sample-member",
    active: false,
    departments: ["Customer service"],
    primary: "Customer service",
    title: "Customer specialist",
    activity: ["Account deactivated"],
  },
];

export const initialPeople: Person[] = [
  ...basePeople,
  ...[...new Set(INITIAL_RECORDS.map((record) => record.assignee))]
    .filter((name) => !basePeople.some((person) => person.name === name))
    .map((name) => ({
      id: `sample-person-${name.toLowerCase().replaceAll(" ", "-")}`,
      name,
      email: `${name.toLowerCase().replaceAll(" ", ".")}@example.invalid`,
      role: "sample-member",
      active: true,
      departments: ["Operations"],
      primary: "Operations",
      title: "Field specialist",
      activity: ["Assigned to service records"],
    })),
];

export type Role = {
  id: string;
  name: string;
  description?: string;
  builtin: boolean;
  grants: string[];
};
export const departments = [
  "Operations",
  "Customer service",
  "Finance",
  "Commercial",
];
export const permissions = [
  "Department · Operations",
  "Department · Customer service",
  "Department · Finance",
  "Department · Commercial",
  "Module · Service requests",
  "Module · Equipment",
  "Module · Customers",
  "Action · create",
  "Action · read",
  "Action · update",
  "Action · close",
  "Action · purge",
  "Board · Organization",
  "Board · Operations",
  "Field · Customer email",
  "Field · Cost",
];
export const initialRoles: Role[] = [
  {
    id: "sample-admin",
    name: "Administrator",
    builtin: true,
    grants: [...permissions],
  },
  {
    id: "sample-member",
    name: "Member",
    builtin: true,
    grants: [
      "Department · Operations",
      "Module · Service requests",
      "Action · read",
      "Board · Operations",
    ],
  },
];
