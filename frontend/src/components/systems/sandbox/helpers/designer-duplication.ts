import { canvasFieldId, projectedField } from "./bridge";
import {
  compactDefaultLayout,
  uid,
  type Design,
  type Field,
  type SandboxDesignTarget,
} from "../domain/model";

function copiedName(name: string, existingNames: readonly string[]): string {
  const names = new Set(existingNames);
  const first = `${name} Copy`;
  if (!names.has(first)) return first;
  let number = 2;
  while (names.has(`${name} Copy ${number}`)) number += 1;
  return `${name} Copy ${number}`;
}

function nextId(usedIds: Set<string>): string {
  let id = uid();
  while (usedIds.has(id)) id = uid();
  usedIds.add(id);
  return id;
}

function clonedField(field: Field, id: string, name = field.name): Field {
  return {
    ...field,
    id,
    name,
    ...(field.config ? { config: structuredClone(field.config) } : {}),
  };
}

export function duplicateDesignTarget(
  design: Design,
  target: SandboxDesignTarget,
): { design: Design; selected: string } | null {
  const usedIds = new Set([
    ...design.departments.map((item) => item.id),
    ...design.modules.map((item) => item.id),
    ...design.modules.flatMap((item) => item.fields.map((field) => field.id)),
    ...design.relationships.map((item) => item.id),
    ...design.rules.map((item) => item.id),
  ]);
  if (target.kind === "department") {
    const source = design.departments.find((item) => item.id === target.id);
    if (!source) return null;
    const departmentId = nextId(usedIds);
    const sourceModules = design.modules.filter(
      (item) => item.department === source.id,
    );
    const copiedModules = sourceModules.map((moduleItem) => ({
      ...moduleItem,
      id: nextId(usedIds),
      department: departmentId,
      fields: moduleItem.fields.map((field) =>
        clonedField(field, nextId(usedIds)),
      ),
    }));
    const moduleIdMap = new Map(
      sourceModules.map((item, index) => [item.id, copiedModules[index].id]),
    );
    const sourceLayout = design.layout ?? compactDefaultLayout;
    const layout = { ...sourceLayout };
    const departmentBox = sourceLayout[source.id];
    if (departmentBox)
      layout[departmentId] = {
        ...departmentBox,
        x: departmentBox.x + 40,
        y: departmentBox.y + 40,
      };
    for (const sourceModule of sourceModules) {
      const copiedModuleId = moduleIdMap.get(sourceModule.id);
      const moduleBox = sourceLayout[sourceModule.id];
      if (copiedModuleId && moduleBox)
        layout[copiedModuleId] = {
          ...moduleBox,
          x: moduleBox.x + 40,
          y: moduleBox.y + 40,
        };
    }
    return {
      design: {
        ...design,
        departments: [
          ...design.departments,
          {
            ...source,
            id: departmentId,
            name: copiedName(
              source.name,
              design.departments.map((item) => item.name),
            ),
          },
        ],
        modules: [...design.modules, ...copiedModules],
        layout,
        // Relationships and rules intentionally remain attached to originals.
        // A structural copy therefore never introduces partial or dangling refs.
      },
      selected: departmentId,
    };
  }
  if (target.kind === "module") {
    const source = design.modules.find((item) => item.id === target.id);
    if (!source) return null;
    const moduleId = nextId(usedIds);
    const copiedModule = {
      ...source,
      id: moduleId,
      name: copiedName(
        source.name,
        design.modules
          .filter((item) => item.department === source.department)
          .map((item) => item.name),
      ),
      fields: source.fields.map((field) => clonedField(field, nextId(usedIds))),
    };
    const sourceLayout = design.layout ?? compactDefaultLayout;
    const sourceBox = sourceLayout[source.id];
    const index = design.modules.findIndex((item) => item.id === source.id);
    return {
      design: {
        ...design,
        modules: [
          ...design.modules.slice(0, index + 1),
          copiedModule,
          ...design.modules.slice(index + 1),
        ],
        ...(sourceBox
          ? {
              layout: {
                ...sourceLayout,
                [moduleId]: {
                  ...sourceBox,
                  x: sourceBox.x + 32,
                  y: sourceBox.y + 32,
                },
              },
            }
          : {}),
      },
      selected: moduleId,
    };
  }
  if (target.kind === "field") {
    const source = projectedField(design, target.id);
    if (!source) return null;
    const sourceModule = design.modules.find(
      (item) => item.id === source.moduleId,
    );
    if (!sourceModule) return null;
    const fieldId = nextId(usedIds);
    const field = clonedField(
      source.field,
      fieldId,
      copiedName(
        source.field.name,
        sourceModule.fields.map((item) => item.name),
      ),
    );
    return {
      design: {
        ...design,
        modules: design.modules.map((item) =>
          item.id === source.moduleId
            ? {
                ...item,
                fields: [
                  ...item.fields.slice(
                    0,
                    item.fields.findIndex(
                      (entry) => entry.id === source.field.id,
                    ) + 1,
                  ),
                  field,
                  ...item.fields.slice(
                    item.fields.findIndex(
                      (entry) => entry.id === source.field.id,
                    ) + 1,
                  ),
                ],
              }
            : item,
        ),
      },
      selected: canvasFieldId(source.moduleId, fieldId),
    };
  }
  return null;
}
