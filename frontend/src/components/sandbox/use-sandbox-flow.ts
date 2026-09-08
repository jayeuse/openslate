"use client";

import { useState } from "react";

import {
  addDepartment as addDepartmentReducer,
  addField as addFieldReducer,
  addLink as addLinkReducer,
  addModule as addModuleReducer,
  createEmptySandbox,
  deleteDepartment as deleteDepartmentReducer,
  deleteField as deleteFieldReducer,
  deleteLink as deleteLinkReducer,
  FIELD_TYPE_META,
  moveModule as moveModuleReducer,
  renameDepartment as renameDepartmentReducer,
  setSelection as setSelectionReducer,
  updateField as updateFieldReducer,
  updateLinkLabel as updateLinkLabelReducer,
  type SandboxDepartment,
  type SandboxField,
  type SandboxFieldType,
  type SandboxLink,
  type SandboxModule,
  type SandboxState,
  type UpdateSandboxFieldPatch,
} from "@/lib/sandbox/model";

export type SelectedSandboxObject =
  | { kind: "department"; department: SandboxDepartment }
  | { kind: "module"; module: SandboxModule }
  | { kind: "field"; field: SandboxField }
  | { kind: "link"; link: SandboxLink };

export interface SandboxFlowActions {
  /** Adds a department and returns its id. */
  addDepartment: (name?: string) => string;
  renameDepartment: (departmentId: string, name: string) => void;
  deleteDepartment: (departmentId: string) => void;
  /** Adds a module inside a department and returns its id. */
  addModule: (departmentId: string, name?: string) => string;
  renameModule: (moduleId: string, name: string) => void;
  deleteModule: (moduleId: string) => void;
  moveModule: (moduleId: string, targetDepartmentId: string) => void;
  addField: (moduleId: string, type: SandboxFieldType) => string | null;
  updateField: (fieldId: string, patch: UpdateSandboxFieldPatch) => void;
  deleteField: (fieldId: string) => void;
  /** Adds a link and returns its id, or null when the connection is invalid. */
  addLink: (
    sourceModuleId: string,
    targetModuleId: string,
    label?: string,
  ) => string | null;
  updateLinkLabel: (linkId: string, label: string) => void;
  deleteLink: (linkId: string) => void;
  setSelection: (cellId: string | null) => void;
}

export interface SandboxFlowHelpers {
  selectedObject: SelectedSandboxObject | null;
}

export interface SandboxFlow {
  state: SandboxState;
  actions: SandboxFlowActions;
  helpers: SandboxFlowHelpers;
}

function resolveSelection(state: SandboxState): SelectedSandboxObject | null {
  const { selectedCellId } = state;
  if (selectedCellId === null) {
    return null;
  }
  const department = state.departments.find(
    (item) => item.id === selectedCellId,
  );
  if (department !== undefined) {
    return { kind: "department", department };
  }
  const sandboxModule = state.modules.find(
    (item) => item.id === selectedCellId,
  );
  if (sandboxModule !== undefined) {
    return { kind: "module", module: sandboxModule };
  }
  const field = state.fields.find((item) => item.id === selectedCellId);
  if (field !== undefined) {
    return { kind: "field", field };
  }
  const link = state.links.find((item) => item.id === selectedCellId);
  if (link !== undefined) {
    return { kind: "link", link };
  }
  return null;
}

/**
 * Local-only sandbox state. Starts empty; every action delegates to the
 * pure reducers in `lib/sandbox/model` except `renameModule`/`deleteModule`,
 * which the model does not provide and are applied here as pure updates.
 */
export function useSandboxFlow(): SandboxFlow {
  const [state, setState] = useState<SandboxState>(createEmptySandbox);

  const actions: SandboxFlowActions = {
    addDepartment: (name?: string) => {
      const next = addDepartmentReducer(
        state,
        name ?? `Department ${state.departments.length + 1}`,
      );
      setState(next);
      return next.departments[next.departments.length - 1]?.id ?? "";
    },
    renameDepartment: (departmentId: string, name: string) => {
      setState((previous) =>
        renameDepartmentReducer(previous, departmentId, name),
      );
    },
    deleteDepartment: (departmentId: string) => {
      setState((previous) => deleteDepartmentReducer(previous, departmentId));
    },
    addModule: (departmentId: string, name?: string) => {
      const next = addModuleReducer(
        state,
        departmentId,
        name ?? `Module ${state.modules.length + 1}`,
      );
      setState(next);
      return next.modules[next.modules.length - 1]?.id ?? "";
    },
    renameModule: (moduleId: string, name: string) => {
      setState((previous) => ({
        ...previous,
        modules: previous.modules.map((item) =>
          item.id === moduleId ? { ...item, name } : item,
        ),
      }));
    },
    deleteModule: (moduleId: string) => {
      setState((previous) => {
        const target = previous.modules.find((item) => item.id === moduleId);
        if (target === undefined) {
          return previous;
        }
        const removedFieldIds = new Set(target.fieldIds);
        return {
          ...previous,
          departments: previous.departments.map((department) =>
            department.id === target.departmentId
              ? {
                  ...department,
                  moduleIds: department.moduleIds.filter(
                    (id) => id !== moduleId,
                  ),
                }
              : department,
          ),
          modules: previous.modules.filter((item) => item.id !== moduleId),
          fields: previous.fields.filter(
            (field) => !removedFieldIds.has(field.id),
          ),
          links: previous.links.filter(
            (link) =>
              link.sourceModuleId !== moduleId &&
              link.targetModuleId !== moduleId,
          ),
          selectedCellId:
            previous.selectedCellId === moduleId ||
            (previous.selectedCellId !== null &&
              removedFieldIds.has(previous.selectedCellId))
              ? null
              : previous.links.some(
                    (link) =>
                      link.id === previous.selectedCellId &&
                      (link.sourceModuleId === moduleId ||
                        link.targetModuleId === moduleId),
                  )
                ? null
                : previous.selectedCellId,
        };
      });
    },
    moveModule: (moduleId: string, targetDepartmentId: string) => {
      setState((previous) =>
        moveModuleReducer(previous, moduleId, targetDepartmentId),
      );
    },
    addField: (moduleId: string, type: SandboxFieldType) => {
      const count = state.fields.filter(
        (field) => field.moduleId === moduleId,
      ).length;
      const next = addFieldReducer(state, moduleId, {
        name: `${FIELD_TYPE_META[type].label} ${count + 1}`,
        type,
      });
      setState(next);
      return next.fields[next.fields.length - 1]?.id ?? null;
    },
    updateField: (fieldId: string, patch: UpdateSandboxFieldPatch) => {
      setState((previous) => updateFieldReducer(previous, fieldId, patch));
    },
    deleteField: (fieldId: string) => {
      setState((previous) => deleteFieldReducer(previous, fieldId));
    },
    addLink: (
      sourceModuleId: string,
      targetModuleId: string,
      label?: string,
    ) => {
      const next = addLinkReducer(
        state,
        sourceModuleId,
        targetModuleId,
        label ?? "",
      );
      setState(next);
      return next.links[next.links.length - 1]?.id ?? null;
    },
    updateLinkLabel: (linkId: string, label: string) => {
      setState((previous) => updateLinkLabelReducer(previous, linkId, label));
    },
    deleteLink: (linkId: string) => {
      setState((previous) => deleteLinkReducer(previous, linkId));
    },
    setSelection: (cellId: string | null) => {
      setState((previous) => setSelectionReducer(previous, cellId));
    },
  };

  return {
    state,
    actions,
    helpers: {
      selectedObject: resolveSelection(state),
    },
  };
}
