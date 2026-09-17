import type {
  Department,
  Design,
  Field,
  Module,
  Relationship,
  Rule,
} from "../domain/model";
import { normalizeField } from "../domain/model";
import { decodeStoredSandboxHistory } from "../helpers/stored-history";

export type SandboxCommand =
  | {
      type: "rename-department";
      departmentId: string;
      name: string;
    }
  | {
      type: "update-module";
      moduleId: string;
      patch: Partial<Pick<Module, "name" | "department" | "closed">>;
    }
  | {
      type: "update-field";
      moduleId: string;
      fieldId: string;
      patch: Partial<Omit<Field, "id">>;
    }
  | {
      type: "update-relationship";
      relationshipId: string;
      patch: Partial<Omit<Relationship, "id">>;
    }
  | {
      type: "update-rule";
      ruleId: string;
      patch: Partial<Omit<Rule, "id">>;
    }
  | { type: "set-layout"; layout: NonNullable<Design["layout"]> }
  | { type: "replace-design"; design: Design };

export type SandboxHistoryEntry = {
  command: SandboxCommand;
  before: Design;
  after: Design;
};

export type SandboxHistory = {
  past: SandboxHistoryEntry[];
  present: Design;
  future: SandboxHistoryEntry[];
};

export function createSandboxHistory(present: Design): SandboxHistory {
  return { past: [], present, future: [] };
}

export function applySandboxCommand(
  history: SandboxHistory,
  command: SandboxCommand,
): SandboxHistory {
  const next = reduceSandboxCommand(history.present, command);
  if (
    next === history.present ||
    JSON.stringify(next) === JSON.stringify(history.present)
  )
    return history;
  const entry = { command, before: history.present, after: next };
  return {
    past: [...history.past, entry].slice(-50),
    present: next,
    future: [],
  };
}

function updateById<T extends { id: string }>(
  items: T[],
  id: string,
  patch: Partial<Omit<T, "id">>,
): T[] | null {
  if (!items.some((item) => item.id === id)) return null;
  return items.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

export function reduceSandboxCommand(
  design: Design,
  command: SandboxCommand,
): Design {
  switch (command.type) {
    case "rename-department": {
      const departments = updateById<Department>(
        design.departments,
        command.departmentId,
        { name: command.name.trim() },
      );
      return departments ? { ...design, departments } : design;
    }
    case "update-module": {
      const modules = updateById(
        design.modules,
        command.moduleId,
        command.patch,
      );
      return modules ? { ...design, modules } : design;
    }
    case "update-field": {
      const sandboxModule = design.modules.find(
        (item) => item.id === command.moduleId,
      );
      if (!sandboxModule) return design;
      const fields = updateById(
        sandboxModule.fields,
        command.fieldId,
        command.patch,
      );
      if (!fields) return design;
      const normalizedFields = fields.map((field) =>
        field.id === command.fieldId ? normalizeField(field) : field,
      );
      return {
        ...design,
        modules: design.modules.map((item) =>
          item.id === sandboxModule.id
            ? { ...item, fields: normalizedFields }
            : item,
        ),
      };
    }
    case "update-relationship": {
      const relationships = updateById(
        design.relationships,
        command.relationshipId,
        command.patch,
      );
      return relationships ? { ...design, relationships } : design;
    }
    case "update-rule": {
      const rules = updateById(design.rules, command.ruleId, command.patch);
      return rules ? { ...design, rules } : design;
    }
    case "set-layout":
      return { ...design, layout: command.layout };
    case "replace-design":
      return command.design;
  }
}

export function undoSandboxCommand(history: SandboxHistory): SandboxHistory {
  const entry = history.past.at(-1);
  if (!entry) return history;
  return {
    past: history.past.slice(0, -1),
    present: entry.before,
    future: [entry, ...history.future],
  };
}

export function redoSandboxCommand(history: SandboxHistory): SandboxHistory {
  const entry = history.future[0];
  if (!entry) return history;
  return {
    past: [...history.past, entry].slice(-50),
    present: entry.after,
    future: history.future.slice(1),
  };
}

function replacementEntry(before: Design, after: Design): SandboxHistoryEntry {
  return {
    command: { type: "replace-design", design: after },
    before,
    after,
  };
}

export function normalizeSandboxHistory(
  value: unknown,
  fallback: Design,
): SandboxHistory {
  const stored = decodeStoredSandboxHistory(value);
  if (!stored) return createSandboxHistory(fallback);
  return {
    past: stored.past.map((entry) =>
      replacementEntry(entry.before, entry.after),
    ),
    present: stored.present,
    future: stored.future.map((entry) =>
      replacementEntry(entry.before, entry.after),
    ),
  };
}
