import type {
  SandboxAutomation,
  SandboxAutomationAction,
  SandboxComparisonOperator,
  SandboxDocumentDepartment,
  SandboxDocumentField,
  SandboxDocumentModule,
  SandboxFieldValue,
  SandboxRelationship,
  SandboxDocumentV2,
} from "./document";

export type SandboxOrganizationTemplate = {
  id: string;
  name: string;
  category: string;
  description: string;
  recommendedFor: string[];
  highlights: string[];
  document: SandboxDocumentV2;
  createDocument: () => SandboxDocumentV2;
};

type FieldKind = SandboxDocumentField["type"];
type CustomField = readonly [
  key: string,
  name: string,
  type: FieldKind,
  required?: boolean,
  options?: readonly string[],
];
type ModuleDefinition = readonly [
  id: string,
  departmentId: string,
  name: string,
  fields: readonly CustomField[],
];
type RelationshipDefinition = readonly [
  id: string,
  name: string,
  sourceModuleId: string,
  targetModuleId: string,
  cardinality?: SandboxRelationship["cardinality"],
];
type AutomationActionWithoutId = SandboxAutomationAction extends infer Action
  ? Action extends { id: string }
    ? Omit<Action, "id">
    : never
  : never;
type TemplateDefinition = {
  id: string;
  name: string;
  category: string;
  description: string;
  recommendedFor: string[];
  highlights: string[];
  departments: ReadonlyArray<readonly [id: string, name: string]>;
  modules: readonly ModuleDefinition[];
  relationships: readonly RelationshipDefinition[];
  threshold: {
    moduleId: string;
    fieldKey: string;
    operator: SandboxComparisonOperator;
    value: number;
    name: string;
  };
};

const fieldId = (moduleId: string, key: string) => `${moduleId}-${key}`;

function singularModuleName(name: string): string {
  const compound: Record<string, string> = {
    "Bills of material": "Bill of material",
    "Returns and refunds": "Return and refund",
    "Stores and channels": "Store and channel",
  };
  return compound[name] ?? name.replace(/ies$/, "y").replace(/s$/, "");
}

function field(
  moduleId: string,
  [key, name, type, required = false, selectOptions = []]: CustomField,
): SandboxDocumentField {
  const base = {
    id: fieldId(moduleId, key),
    name,
    type,
    required,
    closed: false,
  };
  switch (type) {
    case "Text":
      return {
        ...base,
        config: { kind: "text", defaultValue: "", maxLength: 200 },
      };
    case "Long text":
      return {
        ...base,
        config: { kind: "long-text", defaultValue: "", maxLength: 1_000 },
      };
    case "Number":
      return {
        ...base,
        config: { kind: "number", defaultValue: null, step: 0.01 },
      };
    case "Integer":
      return {
        ...base,
        config: { kind: "integer", defaultValue: null, step: 1 },
      };
    case "Date":
      return { ...base, config: { kind: "date", defaultValue: null } };
    case "Date/Time":
      return { ...base, config: { kind: "datetime", defaultValue: null } };
    case "Checkbox":
      return { ...base, config: { kind: "checkbox", defaultValue: false } };
    case "Select":
      return {
        ...base,
        config: {
          kind: "select",
          defaultValue: null,
          options: [...selectOptions],
        },
      };
    case "Email":
      return {
        ...base,
        config: { kind: "email", defaultValue: "", maxLength: 254 },
      };
    case "URL":
      return {
        ...base,
        config: { kind: "url", defaultValue: "", maxLength: 1_000 },
      };
  }
}

function buildModule(definition: ModuleDefinition): SandboxDocumentModule {
  const [id, departmentId, name, customFields] = definition;
  return {
    id,
    departmentId,
    name,
    closed: false,
    fields: [
      field(id, ["id", `${singularModuleName(name)} ID`, "Text", true]),
      field(id, [
        "status",
        "Status",
        "Select",
        true,
        ["Draft", "Active", "On hold", "Complete", "Cancelled"],
      ]),
      field(id, ["needs-review", "Needs review", "Checkbox"]),
      ...customFields.map((item) => field(id, item)),
    ],
  };
}

function relationship([
  id,
  name,
  sourceModuleId,
  targetModuleId,
  cardinality = "one-to-many",
]: RelationshipDefinition): SandboxRelationship {
  return {
    id,
    name,
    sourceModuleId,
    targetModuleId,
    cardinality,
    fieldMappings: [],
  };
}

function literal(value: SandboxFieldValue) {
  return { kind: "literal" as const, value };
}

function fieldChangeAutomation(
  id: string,
  name: string,
  moduleId: string,
  action: AutomationActionWithoutId,
  priority: number,
): SandboxAutomation {
  return {
    id,
    name,
    enabled: true,
    priority,
    trigger: {
      kind: "field-changed",
      moduleId,
      fieldId: fieldId(moduleId, "status"),
    },
    conditionGroup: {
      operator: "all",
      conditions: [
        {
          id: `${id}-condition`,
          field: { moduleId, fieldId: fieldId(moduleId, "status") },
          operator: "=",
          value: literal("On hold"),
        },
      ],
    },
    actions: [{ ...action, id: `${id}-action` } as SandboxAutomationAction],
  };
}

function thresholdAutomation(
  id: string,
  name: string,
  moduleId: string,
  thresholdFieldId: string,
  operator: SandboxComparisonOperator,
  value: number,
  priority: number,
): SandboxAutomation {
  return {
    id,
    name,
    enabled: true,
    priority,
    trigger: {
      kind: "threshold-crossed",
      moduleId,
      fieldId: thresholdFieldId,
      operator,
      value: literal(value),
    },
    conditionGroup: { operator: "all", conditions: [] },
    actions: [
      {
        id: `${id}-set-status`,
        kind: "set-field",
        target: { moduleId, fieldId: fieldId(moduleId, "needs-review") },
        value: literal(true),
      },
    ],
  };
}

function buildAutomations(
  definition: TemplateDefinition,
  modules: SandboxDocumentModule[],
): SandboxAutomation[] {
  const prefix = definition.id;
  const thresholdModule = modules.find(
    (item) => item.id === definition.threshold.moduleId,
  );
  const thresholdField = thresholdModule?.fields.find(
    (item) =>
      item.id ===
      fieldId(definition.threshold.moduleId, definition.threshold.fieldKey),
  );
  const automations: SandboxAutomation[] = [
    {
      id: `${prefix}-auto-intake`,
      name: `${modules[0]!.name} intake notice`,
      enabled: true,
      priority: 0,
      trigger: {
        kind: "field-changed",
        moduleId: modules[0]!.id,
        fieldId: fieldId(modules[0]!.id, "status"),
      },
      conditionGroup: {
        operator: "all",
        conditions: [
          {
            id: `${prefix}-auto-intake-condition`,
            field: {
              moduleId: modules[0]!.id,
              fieldId: fieldId(modules[0]!.id, "status"),
            },
            operator: "=",
            value: literal("On hold"),
          },
        ],
      },
      actions: [
        {
          id: `${prefix}-auto-intake-status`,
          kind: "set-field",
          target: {
            moduleId: modules[0]!.id,
            fieldId: fieldId(modules[0]!.id, "needs-review"),
          },
          value: literal(true),
        },
      ],
    },
    fieldChangeAutomation(
      `${prefix}-auto-hold`,
      `${modules[1]!.name} hold escalation`,
      modules[1]!.id,
      {
        kind: "set-field",
        target: {
          moduleId: modules[1]!.id,
          fieldId: fieldId(modules[1]!.id, "needs-review"),
        },
        value: literal(true),
      },
      1,
    ),
    fieldChangeAutomation(
      `${prefix}-auto-exception`,
      `${modules[2]!.name} exception alert`,
      modules[2]!.id,
      {
        kind: "set-field",
        target: {
          moduleId: modules[2]!.id,
          fieldId: fieldId(modules[2]!.id, "needs-review"),
        },
        value: literal(true),
      },
      2,
    ),
    {
      id: `${prefix}-auto-weekly-review`,
      name: "Weekly management review",
      enabled: true,
      priority: 4,
      trigger: {
        kind: "schedule",
        moduleId: modules[0]!.id,
        frequency: "weekly",
        time: "08:30",
        weekday: 1,
      },
      conditionGroup: { operator: "all", conditions: [] },
      actions: [
        {
          id: `${prefix}-auto-weekly-review-status`,
          kind: "set-field",
          target: {
            moduleId: modules[0]!.id,
            fieldId: fieldId(modules[0]!.id, "needs-review"),
          },
          value: literal(true),
        },
      ],
    },
  ];
  if (thresholdModule && thresholdField)
    automations.splice(
      3,
      0,
      thresholdAutomation(
        `${prefix}-auto-threshold`,
        definition.threshold.name,
        thresholdModule.id,
        thresholdField.id,
        definition.threshold.operator,
        definition.threshold.value,
        3,
      ),
    );
  return automations;
}

function layoutFor(
  departments: SandboxDocumentDepartment[],
  modules: SandboxDocumentModule[],
): SandboxDocumentV2["design"]["layout"] {
  return Object.fromEntries(
    departments.flatMap((item, departmentIndex) => {
      const children = modules.filter(
        (module) => module.departmentId === item.id,
      );
      const x = departmentIndex * 760;
      return [
        [
          item.id,
          {
            x,
            y: 0,
            width: 700,
            height: 100 + Math.ceil(children.length / 2) * 360,
          },
        ] as const,
        ...children.map(
          (child, childIndex) =>
            [
              child.id,
              {
                x: x + 30 + (childIndex % 2) * 330,
                y: 60 + Math.floor(childIndex / 2) * 360,
                width: 300,
                height: 300,
              },
            ] as const,
        ),
      ];
    }),
  );
}

function buildTemplate(
  definition: TemplateDefinition,
): SandboxOrganizationTemplate {
  const departments = definition.departments.map(([id, name]) => ({
    id,
    name,
    closed: false,
  }));
  const modules = definition.modules.map(buildModule);
  const relationships = definition.relationships.map(relationship);
  const document: SandboxDocumentV2 = {
    kind: "openslate-sandbox",
    schemaVersion: 2,
    design: {
      departments,
      modules,
      relationships,
      layout: layoutFor(departments, modules),
    },
    automations: buildAutomations(definition, modules),
    scenarios: [],
  };
  return {
    id: definition.id,
    name: definition.name,
    category: definition.category,
    description: definition.description,
    recommendedFor: [...definition.recommendedFor],
    highlights: [...definition.highlights],
    document,
    createDocument: () => structuredClone(document),
  };
}

const definitions: TemplateDefinition[] = [
  {
    id: "inventory-procurement",
    name: "Inventory & procurement",
    category: "Supply chain",
    description:
      "A purchasing, receiving, warehouse, stock-level, and movement baseline for businesses that buy, store, issue, or resell physical goods.",
    recommendedFor: [
      "Distributors and wholesalers",
      "Retail stockrooms",
      "Service-parts operations",
    ],
    highlights: [
      "Supplier-to-receipt traceability",
      "Per-warehouse stock control",
      "Reorder and approval automations",
    ],
    departments: [
      ["inv-procurement", "Procurement"],
      ["inv-inventory", "Inventory & warehousing"],
      ["inv-finance", "Finance controls"],
    ],
    modules: [
      [
        "inv-suppliers",
        "inv-procurement",
        "Suppliers",
        [
          ["legal-name", "Legal name", "Text", true],
          ["purchasing-email", "Purchasing email", "Email"],
          ["lead-time", "Lead time days", "Integer"],
          [
            "payment-terms",
            "Payment terms",
            "Select",
            false,
            ["Cash", "Net 15", "Net 30", "Net 60"],
          ],
        ],
      ],
      [
        "inv-purchase-orders",
        "inv-procurement",
        "Purchase orders",
        [
          ["supplier-reference", "Supplier reference", "Text", true],
          ["order-date", "Order date", "Date", true],
          ["expected-date", "Expected delivery", "Date"],
          ["order-total", "Order total", "Number", true],
        ],
      ],
      [
        "inv-products",
        "inv-inventory",
        "Products",
        [
          ["product-name", "Product name", "Text", true],
          [
            "category",
            "Category",
            "Select",
            true,
            ["Raw material", "Finished good", "Consumable", "Spare part"],
          ],
          ["unit-cost", "Standard unit cost", "Number"],
          ["reorder-point", "Default reorder point", "Integer"],
        ],
      ],
      [
        "inv-warehouses",
        "inv-inventory",
        "Warehouses",
        [
          ["warehouse-name", "Warehouse name", "Text", true],
          ["location", "Address or zone", "Long text"],
          ["manager-email", "Manager email", "Email"],
          ["capacity", "Capacity units", "Integer"],
        ],
      ],
      [
        "inv-stock-levels",
        "inv-inventory",
        "Stock levels",
        [
          ["product-reference", "Product reference", "Text", true],
          ["warehouse-reference", "Warehouse reference", "Text", true],
          ["on-hand", "Quantity on hand", "Integer", true],
          ["reserved", "Quantity reserved", "Integer"],
        ],
      ],
      [
        "inv-goods-receipts",
        "inv-inventory",
        "Goods receipts",
        [
          ["po-reference", "Purchase order reference", "Text", true],
          ["received-at", "Received at", "Date/Time", true],
          ["quantity", "Quantity received", "Integer", true],
          ["receiving-notes", "Receiving notes", "Long text"],
        ],
      ],
      [
        "inv-stock-movements",
        "inv-inventory",
        "Stock movements",
        [
          ["product-reference", "Product reference", "Text", true],
          ["warehouse-reference", "Warehouse reference", "Text", true],
          [
            "movement-type",
            "Movement type",
            "Select",
            true,
            ["Receipt", "Issue", "Transfer", "Adjustment"],
          ],
          ["quantity", "Quantity", "Integer", true],
        ],
      ],
      [
        "inv-supplier-invoices",
        "inv-finance",
        "Supplier invoices",
        [
          ["supplier-reference", "Supplier reference", "Text", true],
          ["po-reference", "Purchase order reference", "Text", true],
          ["invoice-date", "Invoice date", "Date", true],
          ["invoice-total", "Invoice total", "Number", true],
        ],
      ],
    ],
    relationships: [
      [
        "inv-rel-supplier-orders",
        "Supplier purchase orders",
        "inv-suppliers",
        "inv-purchase-orders",
      ],
      [
        "inv-rel-product-stock",
        "Product stock levels",
        "inv-products",
        "inv-stock-levels",
      ],
      [
        "inv-rel-warehouse-stock",
        "Warehouse stock levels",
        "inv-warehouses",
        "inv-stock-levels",
      ],
      [
        "inv-rel-product-movements",
        "Product stock movements",
        "inv-products",
        "inv-stock-movements",
      ],
      [
        "inv-rel-warehouse-movements",
        "Warehouse stock movements",
        "inv-warehouses",
        "inv-stock-movements",
      ],
    ],
    threshold: {
      moduleId: "inv-stock-levels",
      fieldKey: "on-hand",
      operator: "<=",
      value: 10,
      name: "Low-stock replenishment review",
    },
  },
  {
    id: "finance-accounting-sales",
    name: "Finance, accounting & sales",
    category: "Revenue operations",
    description:
      "An integrated lead-to-cash and accounting-close baseline connecting customers, commercial activity, billing, collections, expenses, and journals.",
    recommendedFor: [
      "B2B service companies",
      "Trading businesses",
      "Growing owner-managed companies",
    ],
    highlights: [
      "Customer-to-payment traceability",
      "Expense and journal review",
      "Commercial exception workflows",
    ],
    departments: [
      ["fas-sales", "Sales"],
      ["fas-finance", "Finance"],
      ["fas-accounting", "Accounting"],
      ["fas-management", "Management reporting"],
    ],
    modules: [
      [
        "fas-customers",
        "fas-sales",
        "Customers",
        [
          ["legal-name", "Legal name", "Text", true],
          [
            "segment",
            "Customer segment",
            "Select",
            true,
            ["SMB", "Mid-market", "Enterprise", "Public sector"],
          ],
          ["billing-email", "Billing email", "Email"],
          ["credit-limit", "Credit limit", "Number"],
        ],
      ],
      [
        "fas-opportunities",
        "fas-sales",
        "Opportunities",
        [
          ["customer-reference", "Customer reference", "Text", true],
          [
            "stage",
            "Sales stage",
            "Select",
            true,
            ["Discovery", "Proposal", "Negotiation", "Won", "Lost"],
          ],
          ["expected-value", "Expected value", "Number", true],
          ["expected-close", "Expected close date", "Date"],
        ],
      ],
      [
        "fas-orders",
        "fas-sales",
        "Sales orders",
        [
          ["customer-reference", "Customer reference", "Text", true],
          ["order-date", "Order date", "Date", true],
          ["order-total", "Order total", "Number", true],
          ["sales-owner", "Sales owner email", "Email"],
        ],
      ],
      [
        "fas-invoices",
        "fas-finance",
        "Invoices",
        [
          ["order-reference", "Sales order reference", "Text", true],
          ["issue-date", "Issue date", "Date", true],
          ["due-date", "Due date", "Date", true],
          ["balance-due", "Balance due", "Number", true],
        ],
      ],
      [
        "fas-payments",
        "fas-finance",
        "Payments",
        [
          ["invoice-reference", "Invoice reference", "Text", true],
          ["received-date", "Received date", "Date", true],
          ["amount-received", "Amount received", "Number", true],
          [
            "payment-method",
            "Payment method",
            "Select",
            true,
            ["Bank transfer", "Card", "Cash", "Check", "Wallet"],
          ],
        ],
      ],
      [
        "fas-expenses",
        "fas-accounting",
        "Expenses",
        [
          ["vendor", "Vendor", "Text", true],
          ["expense-date", "Expense date", "Date", true],
          [
            "category",
            "Expense category",
            "Select",
            true,
            ["Payroll", "Rent", "Utilities", "Travel", "Supplies", "Other"],
          ],
          ["gross-amount", "Gross amount", "Number", true],
        ],
      ],
      [
        "fas-journals",
        "fas-accounting",
        "Journal entries",
        [
          ["source-reference", "Source reference", "Text", true],
          ["posting-date", "Posting date", "Date", true],
          ["debit", "Debit", "Number", true],
          ["credit", "Credit", "Number", true],
        ],
      ],
      [
        "fas-management-reports",
        "fas-management",
        "Management reports",
        [
          ["period-start", "Period start", "Date", true],
          ["period-end", "Period end", "Date", true],
          ["reported-revenue", "Reported revenue", "Number", true],
          ["reported-expenses", "Reported expenses", "Number", true],
        ],
      ],
    ],
    relationships: [
      [
        "fas-rel-customer-opportunities",
        "Customer opportunities",
        "fas-customers",
        "fas-opportunities",
      ],
      [
        "fas-rel-customer-orders",
        "Customer sales orders",
        "fas-customers",
        "fas-orders",
      ],
      [
        "fas-rel-opportunity-orders",
        "Opportunity sales orders",
        "fas-opportunities",
        "fas-orders",
      ],
      [
        "fas-rel-invoice-payments",
        "Invoice payments",
        "fas-invoices",
        "fas-payments",
      ],
      [
        "fas-rel-expense-journals",
        "Expense journal entries",
        "fas-expenses",
        "fas-journals",
      ],
    ],
    threshold: {
      moduleId: "fas-invoices",
      fieldKey: "balance-due",
      operator: ">=",
      value: 10_000,
      name: "High-value receivable review",
    },
  },
  {
    id: "retail-commerce",
    name: "Retail & commerce",
    category: "Omnichannel retail",
    description:
      "A catalog-to-order baseline for stores and online sellers, including customer orders, line items, fulfillment, shipments, returns, and service exceptions.",
    recommendedFor: [
      "Multi-branch retailers",
      "Online sellers",
      "Specialty shops and franchises",
    ],
    highlights: [
      "Order and line-item structure",
      "Shipment and return visibility",
      "Store and customer-service handoffs",
    ],
    departments: [
      ["ret-merch", "Merchandising"],
      ["ret-commerce", "Commerce"],
      ["ret-fulfillment", "Fulfillment"],
      ["ret-care", "Customer care"],
    ],
    modules: [
      [
        "ret-products",
        "ret-merch",
        "Products",
        [
          ["product-name", "Product name", "Text", true],
          [
            "category",
            "Category",
            "Select",
            true,
            ["Apparel", "Home", "Electronics", "Food", "Other"],
          ],
          ["selling-price", "Selling price", "Number", true],
          ["taxable", "Taxable", "Checkbox"],
        ],
      ],
      [
        "ret-stores",
        "ret-commerce",
        "Stores and channels",
        [
          ["channel-name", "Store or channel name", "Text", true],
          [
            "channel-type",
            "Channel type",
            "Select",
            true,
            ["Physical store", "Web store", "Marketplace", "Social commerce"],
          ],
          ["manager-email", "Manager email", "Email"],
          ["location", "Location", "Long text"],
        ],
      ],
      [
        "ret-customers",
        "ret-commerce",
        "Customers",
        [
          ["customer-name", "Customer name", "Text", true],
          ["email", "Email", "Email"],
          ["mobile", "Mobile number", "Text"],
          [
            "loyalty-tier",
            "Loyalty tier",
            "Select",
            false,
            ["Standard", "Silver", "Gold", "VIP"],
          ],
        ],
      ],
      [
        "ret-orders",
        "ret-commerce",
        "Orders",
        [
          ["customer-reference", "Customer reference", "Text", true],
          ["channel-reference", "Store or channel reference", "Text", true],
          ["ordered-at", "Ordered at", "Date/Time", true],
          ["order-total", "Order total", "Number", true],
        ],
      ],
      [
        "ret-order-lines",
        "ret-commerce",
        "Order lines",
        [
          ["order-reference", "Order reference", "Text", true],
          ["product-reference", "Product reference", "Text", true],
          ["quantity", "Quantity", "Integer", true],
          ["line-total", "Line total", "Number", true],
        ],
      ],
      [
        "ret-shipments",
        "ret-fulfillment",
        "Shipments",
        [
          ["order-reference", "Order reference", "Text", true],
          ["carrier", "Carrier", "Text"],
          ["tracking-url", "Tracking URL", "URL"],
          ["shipped-at", "Shipped at", "Date/Time"],
        ],
      ],
      [
        "ret-returns",
        "ret-care",
        "Returns and refunds",
        [
          ["order-reference", "Order reference", "Text", true],
          [
            "reason",
            "Return reason",
            "Select",
            true,
            [
              "Damaged",
              "Wrong item",
              "Changed mind",
              "Not as described",
              "Other",
            ],
          ],
          ["refund-amount", "Refund amount", "Number"],
          ["resolution-notes", "Resolution notes", "Long text"],
        ],
      ],
    ],
    relationships: [
      [
        "ret-rel-customer-orders",
        "Customer orders",
        "ret-customers",
        "ret-orders",
      ],
      ["ret-rel-store-orders", "Store orders", "ret-stores", "ret-orders"],
      [
        "ret-rel-order-lines",
        "Order line items",
        "ret-orders",
        "ret-order-lines",
      ],
      [
        "ret-rel-customer-stores",
        "Customer preferred stores",
        "ret-customers",
        "ret-stores",
      ],
      [
        "ret-rel-store-lines",
        "Store order line items",
        "ret-stores",
        "ret-order-lines",
      ],
    ],
    threshold: {
      moduleId: "ret-orders",
      fieldKey: "order-total",
      operator: ">=",
      value: 10_000,
      name: "High-value order verification",
    },
  },
  {
    id: "professional-services",
    name: "Professional services",
    category: "Project delivery",
    description:
      "A client-to-cash model for consultancies, agencies, and contractors managing engagements, project delivery, tasks, time, expenses, and invoices.",
    recommendedFor: [
      "Consulting firms",
      "Creative and digital agencies",
      "Engineering and contracting teams",
    ],
    highlights: [
      "Engagement and project hierarchy",
      "Time and expense capture",
      "Delivery-to-billing handoff",
    ],
    departments: [
      ["ps-growth", "Business development"],
      ["ps-delivery", "Client delivery"],
      ["ps-finance", "Finance"],
      ["ps-people", "People operations"],
    ],
    modules: [
      [
        "ps-clients",
        "ps-growth",
        "Clients",
        [
          ["client-name", "Client name", "Text", true],
          ["industry", "Industry", "Text"],
          ["primary-contact", "Primary contact email", "Email"],
          [
            "billing-terms",
            "Billing terms",
            "Select",
            false,
            ["Fixed fee", "Time and materials", "Retainer", "Milestone"],
          ],
        ],
      ],
      [
        "ps-engagements",
        "ps-growth",
        "Engagements",
        [
          ["client-reference", "Client reference", "Text", true],
          ["engagement-lead", "Engagement lead email", "Email"],
          ["contract-value", "Contract value", "Number", true],
          ["start-date", "Start date", "Date"],
        ],
      ],
      [
        "ps-proposals",
        "ps-growth",
        "Proposals",
        [
          ["client-reference", "Client reference", "Text", true],
          ["engagement-reference", "Engagement reference", "Text"],
          ["proposal-date", "Proposal date", "Date", true],
          ["proposed-value", "Proposed value", "Number", true],
        ],
      ],
      [
        "ps-projects",
        "ps-delivery",
        "Projects",
        [
          ["engagement-reference", "Engagement reference", "Text", true],
          ["project-manager", "Project manager email", "Email"],
          ["budget", "Project budget", "Number"],
          ["target-end", "Target end date", "Date"],
        ],
      ],
      [
        "ps-tasks",
        "ps-delivery",
        "Project tasks",
        [
          ["project-reference", "Project reference", "Text", true],
          ["assignee", "Assignee email", "Email"],
          ["due-date", "Due date", "Date"],
          ["estimated-hours", "Estimated hours", "Number"],
        ],
      ],
      [
        "ps-time",
        "ps-people",
        "Time entries",
        [
          ["project-reference", "Project reference", "Text", true],
          ["consultant", "Consultant email", "Email", true],
          ["work-date", "Work date", "Date", true],
          ["billable-hours", "Billable hours", "Number", true],
        ],
      ],
      [
        "ps-expenses",
        "ps-finance",
        "Project expenses",
        [
          ["project-reference", "Project reference", "Text", true],
          ["expense-date", "Expense date", "Date", true],
          [
            "expense-category",
            "Expense category",
            "Select",
            true,
            ["Travel", "Meals", "Materials", "Software", "Other"],
          ],
          ["amount", "Amount", "Number", true],
        ],
      ],
      [
        "ps-invoices",
        "ps-finance",
        "Client invoices",
        [
          ["project-reference", "Project reference", "Text", true],
          ["invoice-date", "Invoice date", "Date", true],
          ["due-date", "Due date", "Date", true],
          ["invoice-total", "Invoice total", "Number", true],
        ],
      ],
    ],
    relationships: [
      [
        "ps-rel-client-engagements",
        "Client engagements",
        "ps-clients",
        "ps-engagements",
      ],
      [
        "ps-rel-client-proposals",
        "Client proposals",
        "ps-clients",
        "ps-proposals",
      ],
      [
        "ps-rel-engagement-proposals",
        "Engagement proposals",
        "ps-engagements",
        "ps-proposals",
      ],
      ["ps-rel-project-tasks", "Project tasks", "ps-projects", "ps-tasks"],
      [
        "ps-rel-expense-invoices",
        "Expenses billed on invoices",
        "ps-expenses",
        "ps-invoices",
      ],
    ],
    threshold: {
      moduleId: "ps-projects",
      fieldKey: "budget",
      operator: ">=",
      value: 100_000,
      name: "Large-project governance review",
    },
  },
  {
    id: "field-service-maintenance",
    name: "Field service & maintenance",
    category: "Service operations",
    description:
      "An end-to-end service baseline for installed assets, work dispatch, technicians, inspections, parts consumption, completion, and customer billing.",
    recommendedFor: [
      "Equipment maintenance providers",
      "Facilities teams",
      "Repair and installation businesses",
    ],
    highlights: [
      "Customer asset history",
      "Work-order dispatch and inspection",
      "Parts usage and service billing",
    ],
    departments: [
      ["fsm-desk", "Service desk"],
      ["fsm-field", "Field operations"],
      ["fsm-parts", "Parts and logistics"],
      ["fsm-finance", "Service finance"],
    ],
    modules: [
      [
        "fsm-customers",
        "fsm-desk",
        "Customers",
        [
          ["customer-name", "Customer name", "Text", true],
          ["service-email", "Service email", "Email"],
          [
            "service-level",
            "Service level",
            "Select",
            true,
            ["Standard", "Priority", "24x7", "Warranty"],
          ],
          ["service-address", "Service address", "Long text"],
        ],
      ],
      [
        "fsm-assets",
        "fsm-desk",
        "Installed assets",
        [
          ["customer-reference", "Customer reference", "Text", true],
          ["asset-type", "Asset type", "Text", true],
          ["serial-number", "Serial number", "Text", true],
          ["warranty-end", "Warranty end date", "Date"],
        ],
      ],
      [
        "fsm-work-orders",
        "fsm-field",
        "Work orders",
        [
          ["asset-reference", "Asset reference", "Text", true],
          [
            "priority",
            "Priority",
            "Select",
            true,
            ["Low", "Normal", "High", "Emergency"],
          ],
          ["scheduled-at", "Scheduled at", "Date/Time"],
          ["problem-description", "Problem description", "Long text", true],
        ],
      ],
      [
        "fsm-technicians",
        "fsm-field",
        "Technicians",
        [
          ["technician-name", "Technician name", "Text", true],
          ["email", "Email", "Email", true],
          [
            "skill-group",
            "Skill group",
            "Select",
            true,
            ["Electrical", "Mechanical", "HVAC", "IT", "General"],
          ],
          ["available", "Available", "Checkbox"],
        ],
      ],
      [
        "fsm-inspections",
        "fsm-field",
        "Inspections",
        [
          ["work-order-reference", "Work order reference", "Text", true],
          ["inspected-at", "Inspected at", "Date/Time", true],
          [
            "result",
            "Inspection result",
            "Select",
            true,
            ["Pass", "Pass with observations", "Fail"],
          ],
          ["findings", "Findings", "Long text"],
        ],
      ],
      [
        "fsm-parts-usage",
        "fsm-parts",
        "Parts usage",
        [
          ["work-order-reference", "Work order reference", "Text", true],
          ["part-number", "Part number", "Text", true],
          ["quantity", "Quantity used", "Integer", true],
          ["unit-cost", "Unit cost", "Number"],
        ],
      ],
      [
        "fsm-parts-catalog",
        "fsm-parts",
        "Parts catalog",
        [
          ["part-number", "Part number", "Text", true],
          ["part-name", "Part name", "Text", true],
          ["quantity-on-hand", "Quantity on hand", "Integer"],
          ["reorder-point", "Reorder point", "Integer"],
        ],
      ],
      [
        "fsm-invoices",
        "fsm-finance",
        "Service invoices",
        [
          ["work-order-reference", "Work order reference", "Text", true],
          ["invoice-date", "Invoice date", "Date", true],
          ["labor-amount", "Labor amount", "Number"],
          ["parts-amount", "Parts amount", "Number"],
        ],
      ],
      [
        "fsm-payments",
        "fsm-finance",
        "Service payments",
        [
          ["invoice-reference", "Invoice reference", "Text", true],
          ["received-date", "Received date", "Date", true],
          ["amount-received", "Amount received", "Number", true],
          ["payment-reference", "Payment reference", "Text"],
        ],
      ],
    ],
    relationships: [
      [
        "fsm-rel-customer-assets",
        "Customer assets",
        "fsm-customers",
        "fsm-assets",
      ],
      [
        "fsm-rel-tech-work",
        "Technician work orders",
        "fsm-technicians",
        "fsm-work-orders",
      ],
      [
        "fsm-rel-work-inspections",
        "Work order inspections",
        "fsm-work-orders",
        "fsm-inspections",
      ],
      [
        "fsm-rel-catalog-usage",
        "Catalog parts usage",
        "fsm-parts-catalog",
        "fsm-parts-usage",
      ],
      [
        "fsm-rel-invoice-payments",
        "Service invoice payments",
        "fsm-invoices",
        "fsm-payments",
      ],
    ],
    threshold: {
      moduleId: "fsm-invoices",
      fieldKey: "labor-amount",
      operator: ">=",
      value: 25_000,
      name: "High-value service invoice review",
    },
  },
  {
    id: "light-manufacturing",
    name: "Light manufacturing",
    category: "Production operations",
    description:
      "A production baseline connecting product definitions, bills of material, production orders, work centers, material issues, quality, and finished receipts.",
    recommendedFor: [
      "Fabricators and assemblers",
      "Food and consumer-goods producers",
      "Small-batch manufacturers",
    ],
    highlights: [
      "Plan-to-produce traceability",
      "Material and work-center control",
      "Quality and finished-goods handoff",
    ],
    departments: [
      ["mfg-planning", "Production planning"],
      ["mfg-production", "Production"],
      ["mfg-quality", "Quality assurance"],
      ["mfg-warehouse", "Warehouse"],
    ],
    modules: [
      [
        "mfg-products",
        "mfg-planning",
        "Products",
        [
          ["product-name", "Product name", "Text", true],
          ["product-family", "Product family", "Text"],
          ["standard-cost", "Standard cost", "Number"],
          ["make-to-order", "Make to order", "Checkbox"],
        ],
      ],
      [
        "mfg-boms",
        "mfg-planning",
        "Bills of material",
        [
          ["product-reference", "Product reference", "Text", true],
          ["revision", "Revision", "Text", true],
          ["component-count", "Component count", "Integer"],
          ["effective-date", "Effective date", "Date"],
        ],
      ],
      [
        "mfg-routings",
        "mfg-planning",
        "Production routings",
        [
          ["product-reference", "Product reference", "Text", true],
          ["routing-version", "Routing version", "Text", true],
          ["operation-count", "Operation count", "Integer"],
          ["effective-date", "Effective date", "Date"],
        ],
      ],
      [
        "mfg-orders",
        "mfg-production",
        "Production orders",
        [
          ["product-reference", "Product reference", "Text", true],
          ["planned-quantity", "Planned quantity", "Integer", true],
          ["planned-start", "Planned start", "Date", true],
          ["planned-finish", "Planned finish", "Date", true],
        ],
      ],
      [
        "mfg-centers",
        "mfg-production",
        "Work centers",
        [
          ["work-center-name", "Work center name", "Text", true],
          ["capacity-hours", "Daily capacity hours", "Number"],
          ["supervisor-email", "Supervisor email", "Email"],
          ["available", "Available", "Checkbox"],
        ],
      ],
      [
        "mfg-runs",
        "mfg-production",
        "Production runs",
        [
          ["order-reference", "Production order reference", "Text", true],
          ["started-at", "Started at", "Date/Time"],
          ["completed-at", "Completed at", "Date/Time"],
          ["quantity-completed", "Quantity completed", "Integer"],
        ],
      ],
      [
        "mfg-issues",
        "mfg-warehouse",
        "Material issues",
        [
          ["production-order", "Production order reference", "Text", true],
          ["material-code", "Material code", "Text", true],
          ["quantity-issued", "Quantity issued", "Number", true],
          ["issued-at", "Issued at", "Date/Time", true],
        ],
      ],
      [
        "mfg-inspections",
        "mfg-quality",
        "Quality inspections",
        [
          ["production-order", "Production order reference", "Text", true],
          [
            "inspection-stage",
            "Inspection stage",
            "Select",
            true,
            ["Incoming", "In process", "Final"],
          ],
          [
            "result",
            "Result",
            "Select",
            true,
            ["Pass", "Conditional pass", "Fail"],
          ],
          ["defect-count", "Defect count", "Integer"],
        ],
      ],
      [
        "mfg-receipts",
        "mfg-warehouse",
        "Finished goods receipts",
        [
          ["production-order", "Production order reference", "Text", true],
          ["quantity-received", "Quantity received", "Integer", true],
          ["received-at", "Received at", "Date/Time", true],
          ["warehouse-location", "Warehouse location", "Text"],
        ],
      ],
      [
        "mfg-stock-lots",
        "mfg-warehouse",
        "Stock lots",
        [
          ["lot-number", "Lot number", "Text", true],
          ["material-code", "Material or product code", "Text", true],
          ["quantity-on-hand", "Quantity on hand", "Number"],
          ["received-date", "Received date", "Date"],
        ],
      ],
    ],
    relationships: [
      [
        "mfg-rel-product-boms",
        "Product bills of material",
        "mfg-products",
        "mfg-boms",
      ],
      [
        "mfg-rel-product-routings",
        "Product routings",
        "mfg-products",
        "mfg-routings",
      ],
      [
        "mfg-rel-center-orders",
        "Work center production orders",
        "mfg-centers",
        "mfg-orders",
      ],
      ["mfg-rel-order-runs", "Production order runs", "mfg-orders", "mfg-runs"],
      [
        "mfg-rel-lot-issues",
        "Stock lot material issues",
        "mfg-stock-lots",
        "mfg-issues",
      ],
      [
        "mfg-rel-lot-receipts",
        "Stock lot finished receipts",
        "mfg-stock-lots",
        "mfg-receipts",
      ],
    ],
    threshold: {
      moduleId: "mfg-inspections",
      fieldKey: "defect-count",
      operator: ">=",
      value: 5,
      name: "Quality defect escalation",
    },
  },
];

export const SANDBOX_ORGANIZATION_TEMPLATES = definitions.map(buildTemplate);

export function sandboxTemplateStats(template: SandboxOrganizationTemplate) {
  return {
    departments: template.document.design.departments.length,
    modules: template.document.design.modules.length,
    fields: template.document.design.modules.reduce(
      (total, item) => total + item.fields.length,
      0,
    ),
    relationships: template.document.design.relationships.length,
    automations: template.document.automations.length,
  };
}
