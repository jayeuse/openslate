/**
 * Sandbox domain model (frontend-only mock state).
 *
 * Pure data + pure reducers. No backend, no API calls, no X6 imports.
 */

export type SandboxFieldType =
  | "text"
  | "long-text"
  | "int"
  | "decimal"
  | "boolean"
  | "date"
  | "datetime"
  | "select"
  | "email"
  | "url";

export interface SandboxDepartment {
  id: string;
  name: string;
  moduleIds: string[];
  closed?: boolean;
}

export interface SandboxModule {
  id: string;
  departmentId: string;
  name: string;
  fieldIds: string[];
  closed?: boolean;
}

export interface SandboxField {
  id: string;
  moduleId: string;
  name: string;
  type: SandboxFieldType;
  required: boolean;
  description: string;
  closed?: boolean;
}

export interface SandboxLink {
  id: string;
  sourceModuleId: string;
  targetModuleId: string;
  label: string;
  relationshipType?: string;
  direction: "directed";
}

export interface SandboxState {
  departments: SandboxDepartment[];
  modules: SandboxModule[];
  fields: SandboxField[];
  links: SandboxLink[];
  selectedCellId: string | null;
}

export interface SandboxFieldTypeMeta {
  label: string;
  /** Lucide icon component name (resolved by the UI layer). */
  icon: string;
}

export const FIELD_TYPE_META: Record<SandboxFieldType, SandboxFieldTypeMeta> = {
  text: { label: "Text", icon: "Type" },
  "long-text": { label: "Long text", icon: "AlignLeft" },
  int: { label: "Integer", icon: "Hash" },
  decimal: { label: "Decimal", icon: "Calculator" },
  boolean: { label: "Boolean", icon: "ToggleLeft" },
  date: { label: "Date", icon: "Calendar" },
  datetime: { label: "Date/Time", icon: "CalendarClock" },
  select: { label: "Select", icon: "List" },
  email: { label: "Email", icon: "Mail" },
  url: { label: "URL", icon: "Link" },
};

export function createSandboxId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createEmptySandbox(): SandboxState {
  return {
    departments: [],
    modules: [],
    fields: [],
    links: [],
    selectedCellId: null,
  };
}

interface FixtureFieldInput {
  name: string;
  type: SandboxFieldType;
  required?: boolean;
}

function buildFixtureFields(
  moduleId: string,
  inputs: FixtureFieldInput[],
): SandboxField[] {
  return inputs.map((input) => ({
    id: createSandboxId("field"),
    moduleId,
    name: input.name,
    type: input.type,
    required: input.required ?? false,
    description: "",
  }));
}

/**
 * Demo fixture: Inventory (Equipment, Suppliers) + Sales (Orders),
 * with an Equipment -supplied by-> Suppliers link.
 */
export function createSandboxFixture(): SandboxState {
  const inventoryId = createSandboxId("department");
  const salesId = createSandboxId("department");
  const equipmentId = createSandboxId("module");
  const suppliersId = createSandboxId("module");
  const ordersId = createSandboxId("module");

  const equipmentFields = buildFixtureFields(equipmentId, [
    { name: "Name", type: "text", required: true },
    { name: "Quantity", type: "int" },
    { name: "Status", type: "select" },
  ]);
  const supplierFields = buildFixtureFields(suppliersId, [
    { name: "Name", type: "text", required: true },
    { name: "Contact", type: "text" },
  ]);
  const orderFields = buildFixtureFields(ordersId, [
    { name: "Order Number", type: "text", required: true },
    { name: "Customer", type: "text" },
    { name: "Status", type: "select" },
  ]);

  return {
    departments: [
      {
        id: inventoryId,
        name: "Inventory",
        moduleIds: [equipmentId, suppliersId],
      },
      { id: salesId, name: "Sales", moduleIds: [ordersId] },
    ],
    modules: [
      {
        id: equipmentId,
        departmentId: inventoryId,
        name: "Equipment",
        fieldIds: equipmentFields.map((field) => field.id),
      },
      {
        id: suppliersId,
        departmentId: inventoryId,
        name: "Suppliers",
        fieldIds: supplierFields.map((field) => field.id),
      },
      {
        id: ordersId,
        departmentId: salesId,
        name: "Orders",
        fieldIds: orderFields.map((field) => field.id),
      },
    ],
    fields: [...equipmentFields, ...supplierFields, ...orderFields],
    links: [
      {
        id: createSandboxId("link"),
        sourceModuleId: equipmentId,
        targetModuleId: suppliersId,
        label: "supplied by",
        direction: "directed",
      },
    ],
    selectedCellId: null,
  };
}

export function addDepartment(state: SandboxState, name: string): SandboxState {
  return {
    ...state,
    departments: [
      ...state.departments,
      { id: createSandboxId("department"), name, moduleIds: [] },
    ],
  };
}

export function renameDepartment(
  state: SandboxState,
  departmentId: string,
  name: string,
): SandboxState {
  return {
    ...state,
    departments: state.departments.map((department) =>
      department.id === departmentId ? { ...department, name } : department,
    ),
  };
}

export function deleteDepartment(
  state: SandboxState,
  departmentId: string,
): SandboxState {
  const removedModuleIds = new Set(
    state.modules
      .filter((sandboxModule) => sandboxModule.departmentId === departmentId)
      .map((sandboxModule) => sandboxModule.id),
  );
  return {
    ...state,
    departments: state.departments.filter(
      (department) => department.id !== departmentId,
    ),
    modules: state.modules.filter(
      (sandboxModule) => !removedModuleIds.has(sandboxModule.id),
    ),
    fields: state.fields.filter(
      (field) => !removedModuleIds.has(field.moduleId),
    ),
    links: state.links.filter(
      (link) =>
        !removedModuleIds.has(link.sourceModuleId) &&
        !removedModuleIds.has(link.targetModuleId),
    ),
    selectedCellId: null,
  };
}

export function addModule(
  state: SandboxState,
  departmentId: string,
  name: string,
): SandboxState {
  const department = state.departments.find((item) => item.id === departmentId);
  if (department === undefined) {
    return state;
  }
  const sandboxModule: SandboxModule = {
    id: createSandboxId("module"),
    departmentId,
    name,
    fieldIds: [],
  };
  return {
    ...state,
    departments: state.departments.map((item) =>
      item.id === departmentId
        ? { ...item, moduleIds: [...item.moduleIds, sandboxModule.id] }
        : item,
    ),
    modules: [...state.modules, sandboxModule],
  };
}

export function moveModule(
  state: SandboxState,
  moduleId: string,
  targetDepartmentId: string,
): SandboxState {
  const sandboxModule = state.modules.find((item) => item.id === moduleId);
  const target = state.departments.find(
    (item) => item.id === targetDepartmentId,
  );
  if (sandboxModule === undefined || target === undefined) {
    return state;
  }
  if (sandboxModule.departmentId === targetDepartmentId) {
    return state;
  }
  const sourceDepartmentId = sandboxModule.departmentId;
  return {
    ...state,
    departments: state.departments.map((department) => {
      if (department.id === sourceDepartmentId) {
        return {
          ...department,
          moduleIds: department.moduleIds.filter((id) => id !== moduleId),
        };
      }
      if (department.id === targetDepartmentId) {
        return {
          ...department,
          moduleIds: [...department.moduleIds, moduleId],
        };
      }
      return department;
    }),
    modules: state.modules.map((item) =>
      item.id === moduleId
        ? { ...item, departmentId: targetDepartmentId }
        : item,
    ),
  };
}

export interface AddSandboxFieldInput {
  name: string;
  type: SandboxFieldType;
  required?: boolean;
  description?: string;
}

export function addField(
  state: SandboxState,
  moduleId: string,
  input: AddSandboxFieldInput,
): SandboxState {
  const sandboxModule = state.modules.find((item) => item.id === moduleId);
  if (sandboxModule === undefined) {
    return state;
  }
  const field: SandboxField = {
    id: createSandboxId("field"),
    moduleId,
    name: input.name,
    type: input.type,
    required: input.required ?? false,
    description: input.description ?? "",
  };
  return {
    ...state,
    modules: state.modules.map((item) =>
      item.id === moduleId
        ? { ...item, fieldIds: [...item.fieldIds, field.id] }
        : item,
    ),
    fields: [...state.fields, field],
  };
}

export type UpdateSandboxFieldPatch = Partial<
  Pick<SandboxField, "name" | "type" | "required" | "description">
>;

export function updateField(
  state: SandboxState,
  fieldId: string,
  patch: UpdateSandboxFieldPatch,
): SandboxState {
  return {
    ...state,
    fields: state.fields.map((field) =>
      field.id === fieldId ? { ...field, ...patch } : field,
    ),
  };
}

export function deleteField(
  state: SandboxState,
  fieldId: string,
): SandboxState {
  const field = state.fields.find((item) => item.id === fieldId);
  if (field === undefined) {
    return state;
  }
  return {
    ...state,
    modules: state.modules.map((sandboxModule) =>
      sandboxModule.id === field.moduleId
        ? {
            ...sandboxModule,
            fieldIds: sandboxModule.fieldIds.filter((id) => id !== fieldId),
          }
        : sandboxModule,
    ),
    fields: state.fields.filter((item) => item.id !== fieldId),
    selectedCellId:
      state.selectedCellId === fieldId ? null : state.selectedCellId,
  };
}

export function addLink(
  state: SandboxState,
  sourceModuleId: string,
  targetModuleId: string,
  label: string,
  relationshipType?: string,
): SandboxState {
  const link: SandboxLink = {
    id: createSandboxId("link"),
    sourceModuleId,
    targetModuleId,
    label,
    direction: "directed",
    ...(relationshipType === undefined ? {} : { relationshipType }),
  };
  return { ...state, links: [...state.links, link] };
}

export function updateLinkLabel(
  state: SandboxState,
  linkId: string,
  label: string,
): SandboxState {
  return {
    ...state,
    links: state.links.map((link) =>
      link.id === linkId ? { ...link, label } : link,
    ),
  };
}

export function deleteLink(state: SandboxState, linkId: string): SandboxState {
  return {
    ...state,
    links: state.links.filter((link) => link.id !== linkId),
    selectedCellId:
      state.selectedCellId === linkId ? null : state.selectedCellId,
  };
}

export function setSelection(
  state: SandboxState,
  cellId: string | null,
): SandboxState {
  return { ...state, selectedCellId: cellId };
}
