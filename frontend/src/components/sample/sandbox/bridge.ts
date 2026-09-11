import type {
  SandboxFieldType,
  SandboxState,
  UpdateSandboxFieldPatch,
} from "@/lib/sandbox/model";
import type { Design, Field } from "./model";

export const canvasFieldId = (moduleId: string, fieldId: string) =>
  `sample-field:${encodeURIComponent(moduleId)}:${encodeURIComponent(fieldId)}`;
export function sampleField(design: Design, projectedId: string) {
  for (const item of design.modules) {
    const field = item.fields.find(
      (entry) => canvasFieldId(item.id, entry.id) === projectedId,
    );
    if (field) return { moduleId: item.id, field };
  }
  return undefined;
}
export const sampleTypes: Record<SandboxFieldType, string> = {
  text: "Text",
  int: "Integer",
  decimal: "Number",
  boolean: "Checkbox",
  date: "Date",
  datetime: "Date time",
  select: "Select",
};
function canvasType(type: string): SandboxFieldType {
  if (type === "Integer") return "int";
  if (type === "Number" || type === "Decimal") return "decimal";
  if (type === "Checkbox") return "boolean";
  if (type === "Date") return "date";
  if (type === "Date time") return "datetime";
  if (type === "Select") return "select";
  return "text";
}
export function projectDesign(
  design: Design,
  selectedCellId: string | null,
): SandboxState {
  return {
    selectedCellId,
    departments: design.departments.map((item) => ({
      id: item.id,
      name: item.name,
      moduleIds: design.modules
        .filter((module) => module.department === item.id)
        .map((module) => module.id),
    })),
    modules: design.modules.map((item) => ({
      id: item.id,
      name: item.name,
      departmentId: item.department,
      fieldIds: item.fields.map((field) => canvasFieldId(item.id, field.id)),
    })),
    fields: design.modules.flatMap((item) =>
      item.fields.map((field) => ({
        id: canvasFieldId(item.id, field.id),
        moduleId: item.id,
        name: field.name,
        type: canvasType(field.type),
        required: field.required,
        description: field.description ?? "",
      })),
    ),
    links: design.relationships.map((item) => ({
      id: item.id,
      sourceModuleId: item.source,
      targetModuleId: item.target,
      label: item.name,
      relationshipType: item.cardinality,
      direction: "directed",
    })),
  };
}
export function updateProjectedField(
  design: Design,
  id: string,
  patch: UpdateSandboxFieldPatch,
): Design {
  const target = sampleField(design, id);
  if (!target) return design;
  const metadata: Partial<Field> = {};
  if (patch.name !== undefined) metadata.name = patch.name;
  if (patch.required !== undefined) metadata.required = patch.required;
  if (patch.description !== undefined) metadata.description = patch.description;
  if (patch.type !== undefined && patch.type !== canvasType(target.field.type))
    metadata.type = sampleTypes[patch.type];
  return {
    ...design,
    modules: design.modules.map((item) =>
      item.id === target.moduleId
        ? {
            ...item,
            fields: item.fields.map((field) =>
              field.id === target.field.id ? { ...field, ...metadata } : field,
            ),
          }
        : item,
    ),
  };
}
