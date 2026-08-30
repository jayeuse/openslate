export const PRIMITIVE_FIELD_TYPES = [
  "text",
  "int",
  "decimal",
  "boolean",
  "datetime",
  "select",
] as const;

export type PrimitiveFieldType = (typeof PRIMITIVE_FIELD_TYPES)[number];
export const RUN_MARKER_FIELD_KEY = "run-marker" as const;

export type PrimitiveFieldConfig = Readonly<{
  options?: readonly string[];
  minimum?: number;
  maximum?: number;
}>;

export type PrimitiveFieldSpec = Readonly<{
  key: string;
  name: string;
  type: PrimitiveFieldType;
  required: boolean;
  order: number;
  config: PrimitiveFieldConfig;
}>;

export type CatalogModule = Readonly<{
  key: string;
  name: string;
  departmentKey: string;
  order: number;
  departmentOrder: number;
  primitiveFields: readonly PrimitiveFieldSpec[];
}>;

export type CatalogDepartment = Readonly<{
  key: string;
  name: string;
  order: number;
  moduleKeys: readonly string[];
  modules: readonly CatalogModule[];
}>;

export type RelationshipDefinition = Readonly<{
  key: string;
  name: string;
  sourceModuleKey: string;
  targetModuleKey: string;
  cardinality: RelationshipCardinality;
  multipleTargets: boolean;
  multipleSources: boolean;
}>;

export type RelationshipCardinality =
  "one-to-one" | "many-to-one" | "one-to-many" | "many-to-many";

export type LiveCatalog = Readonly<{
  departments: readonly CatalogDepartment[];
  modules: readonly CatalogModule[];
  relationships: readonly RelationshipDefinition[];
}>;

export type RuntimeCatalog = LiveCatalog &
  Readonly<{
    namespace: string;
  }>;

export type CatalogCardinality = Readonly<{
  departments: number;
  modules: number;
  primitiveFields: number;
  relationships: number;
}>;

type RawModule = Readonly<{ key: string; name: string }>;
type RawDepartment = Readonly<{
  key: string;
  name: string;
  modules: readonly RawModule[];
}>;

export function withZeroBasedOrder<Item extends object>(
  items: readonly Item[],
): readonly (Item & { order: number })[] {
  return items.map((item, order) => ({ ...item, order }));
}

const RAW_DEPARTMENTS = [
  {
    key: "human-resources",
    name: "Human Resources",
    modules: [
      { key: "employees", name: "Employees" },
      { key: "job-positions", name: "Job Positions" },
      { key: "departments-directory", name: "Departments Directory" },
      { key: "payroll-records", name: "Payroll Records" },
      { key: "leave-requests", name: "Leave Requests" },
      { key: "performance-reviews", name: "Performance Reviews" },
      { key: "training-programs", name: "Training Programs" },
      { key: "benefits-enrollment", name: "Benefits Enrollment" },
    ],
  },
  {
    key: "finance",
    name: "Finance",
    modules: [
      { key: "budgets", name: "Budgets" },
      { key: "cost-centers", name: "Cost Centers" },
      { key: "financial-accounts", name: "Financial Accounts" },
      { key: "bank-reconciliations", name: "Bank Reconciliations" },
      { key: "investment-records", name: "Investment Records" },
    ],
  },
  {
    key: "accounting",
    name: "Accounting",
    modules: [
      { key: "accounts-payable", name: "Accounts Payable" },
      { key: "accounts-receivable", name: "Accounts Receivable" },
      { key: "expenses", name: "Expenses" },
      { key: "transactions", name: "Transactions" },
      { key: "journal-entries", name: "Journal Entries" },
      { key: "tax-filings", name: "Tax Filings" },
    ],
  },
  {
    key: "inventory",
    name: "Inventory",
    modules: [
      { key: "inventory-catalog", name: "Inventory Catalog" },
      { key: "stock-movements", name: "Stock Movements" },
      { key: "suppliers", name: "Suppliers" },
      { key: "warehouses", name: "Warehouses" },
      { key: "purchase-orders", name: "Purchase Orders" },
      { key: "stock-adjustments", name: "Stock Adjustments" },
    ],
  },
  {
    key: "sales",
    name: "Sales",
    modules: [
      { key: "customers", name: "Customers" },
      { key: "sales-orders", name: "Sales Orders" },
      { key: "quotes", name: "Quotes" },
      { key: "payments", name: "Payments" },
      { key: "sales-territories", name: "Sales Territories" },
      { key: "commission-records", name: "Commission Records" },
    ],
  },
  {
    key: "procurement",
    name: "Procurement",
    modules: [
      { key: "vendors", name: "Vendors" },
      { key: "purchase-requisitions", name: "Purchase Requisitions" },
      { key: "procurement-contracts", name: "Contracts" },
      { key: "vendor-evaluations", name: "Vendor Evaluations" },
    ],
  },
  {
    key: "legal",
    name: "Legal",
    modules: [
      { key: "legal-contracts", name: "Contracts" },
      { key: "compliance-cases", name: "Compliance Cases" },
      { key: "legal-documents", name: "Legal Documents" },
      { key: "disputes", name: "Disputes" },
    ],
  },
  {
    key: "it",
    name: "IT",
    modules: [
      { key: "assets", name: "Assets" },
      { key: "software-licenses", name: "Software Licenses" },
      { key: "support-tickets", name: "Support Tickets" },
      { key: "incident-reports", name: "Incident Reports" },
    ],
  },
  {
    key: "operations",
    name: "Operations",
    modules: [
      { key: "projects", name: "Projects" },
      { key: "tasks", name: "Tasks" },
      { key: "milestones", name: "Milestones" },
      { key: "resource-allocations", name: "Resource Allocations" },
    ],
  },
  {
    key: "marketing",
    name: "Marketing",
    modules: [
      { key: "campaigns", name: "Campaigns" },
      { key: "leads", name: "Leads" },
      { key: "marketing-assets", name: "Marketing Assets" },
      { key: "events", name: "Events" },
    ],
  },
  {
    key: "customer-support",
    name: "Customer Support",
    modules: [
      { key: "tickets", name: "Tickets" },
      { key: "customer-feedback", name: "Customer Feedback" },
      { key: "slas", name: "SLAs" },
    ],
  },
  {
    key: "facilities",
    name: "Facilities",
    modules: [
      { key: "locations", name: "Locations" },
      { key: "maintenance-requests", name: "Maintenance Requests" },
      { key: "equipment", name: "Equipment" },
    ],
  },
] as const satisfies readonly RawDepartment[];

type FieldProfile = Readonly<{
  text: string;
  int: string;
  decimal: string;
  boolean: string;
  datetime: string;
  select: string;
  options: readonly string[];
}>;

const DEFAULT_STATUS_OPTIONS = ["planned", "active", "complete"] as const;

const EXPLICIT_FIELD_PROFILES: Readonly<Record<string, FieldProfile>> = {
  employees: {
    text: "Employee name (run marker)",
    int: "Employee ID",
    decimal: "Salary",
    boolean: "Current employee",
    datetime: "Hire datetime",
    select: "Employment status",
    options: ["candidate", "active", "on-leave", "terminated"],
  },
  "sales-orders": {
    text: "Sales order label (run marker)",
    int: "Sales order number",
    decimal: "Order total",
    boolean: "Order fulfilled",
    datetime: "Order datetime",
    select: "Order status",
    options: ["draft", "confirmed", "shipped", "cancelled"],
  },
  customers: {
    text: "Customer name (run marker)",
    int: "Customer number",
    decimal: "Credit limit",
    boolean: "Active customer",
    datetime: "Customer since",
    select: "Customer status",
    options: ["prospect", "active", "inactive", "churned"],
  },
  "inventory-catalog": {
    text: "Product name (run marker)",
    int: "SKU number",
    decimal: "Unit price",
    boolean: "Listed for sale",
    datetime: "Listed datetime",
    select: "Product status",
    options: ["draft", "active", "discontinued"],
  },
  "stock-movements": {
    text: "Stock movement label (run marker)",
    int: "Movement quantity",
    decimal: "Unit cost",
    boolean: "Inbound movement",
    datetime: "Movement datetime",
    select: "Movement status",
    options: ["planned", "posted", "cancelled"],
  },
  projects: {
    text: "Project name (run marker)",
    int: "Project number",
    decimal: "Project budget",
    boolean: "Active project",
    datetime: "Project start datetime",
    select: "Project status",
    options: ["planned", "active", "on-hold", "complete"],
  },
  tasks: {
    text: "Task title (run marker)",
    int: "Task number",
    decimal: "Estimated hours",
    boolean: "Completed task",
    datetime: "Task due datetime",
    select: "Task status",
    options: ["backlog", "in-progress", "blocked", "done"],
  },
  transactions: {
    text: "Transaction reference (run marker)",
    int: "Transaction number",
    decimal: "Transaction amount",
    boolean: "Reconciled transaction",
    datetime: "Posted datetime",
    select: "Transaction status",
    options: ["pending", "posted", "reconciled", "void"],
  },
  expenses: {
    text: "Expense description (run marker)",
    int: "Expense number",
    decimal: "Expense amount",
    boolean: "Reimbursable expense",
    datetime: "Incurred datetime",
    select: "Expense status",
    options: ["submitted", "approved", "reimbursed", "rejected"],
  },
  tickets: {
    text: "Ticket subject (run marker)",
    int: "Ticket number",
    decimal: "Resolution cost",
    boolean: "Escalated ticket",
    datetime: "Opened datetime",
    select: "Ticket status",
    options: ["open", "pending", "resolved", "closed"],
  },
  "purchase-orders": {
    text: "Purchase order label (run marker)",
    int: "Purchase order number",
    decimal: "Purchase order total",
    boolean: "Approved purchase order",
    datetime: "Requested datetime",
    select: "Purchase order status",
    options: ["draft", "submitted", "approved", "received"],
  },
};

function titleCase(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function fieldProfileForModule(moduleKey: string): FieldProfile {
  return (
    EXPLICIT_FIELD_PROFILES[moduleKey] ?? {
      text: `${titleCase(moduleKey)} label (run marker)`,
      int: `${titleCase(moduleKey)} number`,
      decimal: `${titleCase(moduleKey)} amount`,
      boolean: `Active ${titleCase(moduleKey).toLowerCase()}`,
      datetime: `${titleCase(moduleKey)} datetime`,
      select: `${titleCase(moduleKey)} status`,
      options: DEFAULT_STATUS_OPTIONS,
    }
  );
}

function primitiveFieldsForModule(
  moduleKey: string,
): readonly PrimitiveFieldSpec[] {
  const profile = fieldProfileForModule(moduleKey);
  const templates: readonly Readonly<{
    key: string;
    name: string;
    type: PrimitiveFieldType;
    config: PrimitiveFieldConfig;
  }>[] = [
    {
      key: RUN_MARKER_FIELD_KEY,
      name: profile.text,
      type: "text",
      config: {},
    },
    { key: "sequence", name: profile.int, type: "int", config: {} },
    { key: "amount", name: profile.decimal, type: "decimal", config: {} },
    { key: "active", name: profile.boolean, type: "boolean", config: {} },
    {
      key: "effective-at",
      name: profile.datetime,
      type: "datetime",
      config: {},
    },
    {
      key: "status",
      name: profile.select,
      type: "select",
      config: { options: profile.options },
    },
  ];
  return templates.map((template, order) => ({
    ...template,
    key: `${moduleKey}.${template.key}`,
    required: template.key === "run-marker",
    order,
  }));
}

const flatRawModules = RAW_DEPARTMENTS.flatMap((department, departmentOrder) =>
  department.modules.map((module, moduleOrder) => ({
    ...module,
    departmentKey: department.key,
    departmentOrder,
    moduleOrder,
  })),
);

const catalogModules: readonly CatalogModule[] = withZeroBasedOrder(
  flatRawModules,
).map((module) => ({
  key: module.key,
  name: module.name,
  departmentKey: module.departmentKey,
  order: module.order,
  departmentOrder: module.moduleOrder,
  primitiveFields: primitiveFieldsForModule(module.key),
}));

const catalogDepartments: readonly CatalogDepartment[] = RAW_DEPARTMENTS.map(
  (department, order) => {
    const modules = catalogModules.filter(
      (module) => module.departmentKey === department.key,
    );
    return {
      key: department.key,
      name: department.name,
      order,
      moduleKeys: modules.map((module) => module.key),
      modules,
    };
  },
);

export const LIVE_RELATIONSHIPS: readonly RelationshipDefinition[] = [
  {
    key: "employee-primary-payroll-record",
    name: "Primary Payroll Record",
    sourceModuleKey: "employees",
    targetModuleKey: "payroll-records",
    cardinality: "one-to-one",
    multipleTargets: false,
    multipleSources: false,
  },
  {
    key: "project-primary-milestone",
    name: "Primary Milestone",
    sourceModuleKey: "projects",
    targetModuleKey: "milestones",
    cardinality: "one-to-one",
    multipleTargets: false,
    multipleSources: false,
  },
  {
    key: "dispute-primary-contract",
    name: "Primary Contract",
    sourceModuleKey: "disputes",
    targetModuleKey: "legal-contracts",
    cardinality: "one-to-one",
    multipleTargets: false,
    multipleSources: false,
  },
  {
    key: "sales-order-customer",
    name: "Customer",
    sourceModuleKey: "sales-orders",
    targetModuleKey: "customers",
    cardinality: "many-to-one",
    multipleTargets: false,
    multipleSources: true,
  },
  {
    key: "budget-cost-center",
    name: "Cost Center",
    sourceModuleKey: "budgets",
    targetModuleKey: "cost-centers",
    cardinality: "many-to-one",
    multipleTargets: false,
    multipleSources: true,
  },
  {
    key: "employee-job-position",
    name: "Job Position",
    sourceModuleKey: "employees",
    targetModuleKey: "job-positions",
    cardinality: "many-to-one",
    multipleTargets: false,
    multipleSources: true,
  },
  {
    key: "employee-manager",
    name: "Manager",
    sourceModuleKey: "employees",
    targetModuleKey: "employees",
    cardinality: "many-to-one",
    multipleTargets: false,
    multipleSources: true,
  },
  {
    key: "department-directory-employees",
    name: "Employees",
    sourceModuleKey: "departments-directory",
    targetModuleKey: "employees",
    cardinality: "one-to-many",
    multipleTargets: true,
    multipleSources: false,
  },
  {
    key: "purchase-order-stock-movements",
    name: "Stock Movements",
    sourceModuleKey: "purchase-orders",
    targetModuleKey: "stock-movements",
    cardinality: "one-to-many",
    multipleTargets: true,
    multipleSources: false,
  },
  {
    key: "project-tasks",
    name: "Tasks",
    sourceModuleKey: "projects",
    targetModuleKey: "tasks",
    cardinality: "one-to-many",
    multipleTargets: true,
    multipleSources: false,
  },
  {
    key: "employee-training-programs",
    name: "Training Programs",
    sourceModuleKey: "employees",
    targetModuleKey: "training-programs",
    cardinality: "many-to-many",
    multipleTargets: true,
    multipleSources: true,
  },
  {
    key: "procurement-contract-vendors",
    name: "Vendors",
    sourceModuleKey: "procurement-contracts",
    targetModuleKey: "vendors",
    cardinality: "many-to-many",
    multipleTargets: true,
    multipleSources: true,
  },
  {
    key: "campaign-leads",
    name: "Leads",
    sourceModuleKey: "campaigns",
    targetModuleKey: "leads",
    cardinality: "many-to-many",
    multipleTargets: true,
    multipleSources: true,
  },
];

export const LIVE_CATALOG: LiveCatalog = {
  departments: catalogDepartments,
  modules: catalogModules,
  relationships: LIVE_RELATIONSHIPS,
};

export function catalogCardinality(
  catalog: LiveCatalog = LIVE_CATALOG,
): CatalogCardinality {
  return {
    departments: catalog.departments.length,
    modules: catalog.modules.length,
    primitiveFields: catalog.modules.reduce(
      (total, module) => total + module.primitiveFields.length,
      0,
    ),
    relationships: catalog.relationships.length,
  };
}

export function relationshipCardinality(
  catalog: LiveCatalog = LIVE_CATALOG,
): Record<RelationshipCardinality, number> {
  const counts: Record<RelationshipCardinality, number> = {
    "one-to-one": 0,
    "many-to-one": 0,
    "one-to-many": 0,
    "many-to-many": 0,
  };
  for (const relationship of catalog.relationships) {
    counts[relationship.cardinality] += 1;
  }
  return counts;
}

export function validateRuntimeNamespace(namespace: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(namespace)) {
    throw new Error(
      "Runtime namespace must be lowercase alphanumeric and hyphenated",
    );
  }
  return namespace;
}

export function validateSameDepartmentRelationships(
  catalog: Pick<LiveCatalog, "modules" | "relationships">,
): true {
  const departmentByModule = new Map(
    catalog.modules.map((module) => [module.key, module.departmentKey]),
  );

  for (const relationship of catalog.relationships) {
    const sourceDepartment = departmentByModule.get(
      relationship.sourceModuleKey,
    );
    const targetDepartment = departmentByModule.get(
      relationship.targetModuleKey,
    );
    if (!sourceDepartment || !targetDepartment) {
      throw new Error(
        `Relationship ${relationship.key} references an unknown module`,
      );
    }
    if (sourceDepartment !== targetDepartment) {
      throw new Error(
        `Relationship ${relationship.key} must target the same department`,
      );
    }
    const cardinality =
      relationship.multipleTargets && relationship.multipleSources
        ? "many-to-many"
        : relationship.multipleTargets
          ? "one-to-many"
          : relationship.multipleSources
            ? "many-to-one"
            : "one-to-one";
    if (relationship.cardinality !== cardinality) {
      throw new Error(
        `Relationship ${relationship.key} has inconsistent cardinality metadata`,
      );
    }
  }
  return true;
}

export function validateCatalog(catalog: LiveCatalog): void {
  if (catalog.departments.length !== 12) {
    throw new Error("Live catalog must contain exactly 12 departments");
  }
  if (catalog.modules.length !== 57) {
    throw new Error("Live catalog must contain exactly 57 modules");
  }
  if (new Set(catalog.modules.map((module) => module.key)).size !== 57) {
    throw new Error("Live catalog module keys must be unique");
  }
  if (catalog.relationships.length !== 13) {
    throw new Error("Live catalog must contain exactly 13 relationships");
  }
  if (
    new Set(catalog.relationships.map((relationship) => relationship.key))
      .size !== 13
  ) {
    throw new Error("Live catalog relationship keys must be unique");
  }
  for (const catalogModule of catalog.modules) {
    if (catalogModule.primitiveFields.length !== PRIMITIVE_FIELD_TYPES.length) {
      throw new Error(
        `Module ${catalogModule.key} must contain exactly six primitive fields`,
      );
    }
    const types = new Set(
      catalogModule.primitiveFields.map((field) => field.type),
    );
    if (
      types.size !== PRIMITIVE_FIELD_TYPES.length ||
      PRIMITIVE_FIELD_TYPES.some((type) => !types.has(type))
    ) {
      throw new Error(
        `Module ${catalogModule.key} is missing a primitive field type`,
      );
    }
    const runMarker = catalogModule.primitiveFields.find(
      (field) => field.key === `${catalogModule.key}.${RUN_MARKER_FIELD_KEY}`,
    );
    if (!runMarker || runMarker.type !== "text" || !runMarker.required) {
      throw new Error(
        `Module ${catalogModule.key} is missing its required run marker`,
      );
    }
  }
  validateSameDepartmentRelationships(catalog);
}

export function createRuntimeCatalog(
  namespace: string,
  catalog: LiveCatalog = LIVE_CATALOG,
): RuntimeCatalog {
  const validatedNamespace = validateRuntimeNamespace(namespace);
  validateCatalog(catalog);
  const modules = catalog.modules.map((module) => ({
    ...module,
    name: `${validatedNamespace} ${module.name}`,
  }));
  const modulesByDepartment = new Map<string, CatalogModule[]>();
  for (const catalogModule of modules) {
    const current = modulesByDepartment.get(catalogModule.departmentKey) ?? [];
    current.push(catalogModule);
    modulesByDepartment.set(catalogModule.departmentKey, current);
  }
  const departments = catalog.departments.map((department) => ({
    ...department,
    name: `${validatedNamespace} ${department.name}`,
    modules: modulesByDepartment.get(department.key) ?? [],
  }));
  return {
    namespace: validatedNamespace,
    departments,
    modules,
    relationships: catalog.relationships.map((relationship) => ({
      ...relationship,
      name: `${validatedNamespace} ${relationship.name}`,
    })),
  };
}

validateCatalog(LIVE_CATALOG);
