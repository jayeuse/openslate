"use client";

import { useState, type ReactNode } from "react";

import {
  FIELD_TYPE_META,
  type SandboxFieldType,
  type SandboxState,
  type UpdateSandboxFieldPatch,
} from "@/lib/sandbox/model";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";

export type SandboxInspectorTargetKind =
  "department" | "module" | "field" | "link";

export interface SandboxInspectorTarget {
  kind: SandboxInspectorTargetKind;
  id: string;
}

export interface SandboxInspectorProps {
  state: SandboxState;
  onRenameDepartment: (departmentId: string, name: string) => void;
  onRenameModule: (moduleId: string, name: string) => void;
  onUpdateField: (fieldId: string, patch: UpdateSandboxFieldPatch) => void;
  onUpdateLinkLabel: (linkId: string, label: string) => void;
  onDeleteSelected: (target: SandboxInspectorTarget) => void;
  onAddField: (moduleId: string, type: SandboxFieldType) => void;
  onAddModule: (departmentId: string) => void;
  onAddDepartment: () => void;
  onMoveModule?: (moduleId: string, departmentId: string) => void;
  onSelect: (cellId: string) => void;
}

const FIELD_TYPES = Object.keys(FIELD_TYPE_META) as SandboxFieldType[];

function isSandboxFieldType(value: string): value is SandboxFieldType {
  return (Object.keys(FIELD_TYPE_META) as string[]).includes(value);
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-semibold">{children}</h2>;
}

function selectedClasses(selected: boolean): string {
  return selected
    ? "bg-primary/10 text-foreground ring-primary/50 ring-1"
    : "hover:bg-muted text-foreground";
}

interface OutlineNameProps {
  id: string;
  value: string;
  kind: "department" | "module" | "field";
  editingId: string | null;
  editingValue: string;
  onBeginEdit: (id: string, value: string) => void;
  onEditingValueChange: (value: string) => void;
  onCommit: (id: string, currentValue: string) => void;
  onCancel: () => void;
}

function OutlineName({
  id,
  value,
  kind,
  editingId,
  editingValue,
  onBeginEdit,
  onEditingValueChange,
  onCommit,
  onCancel,
}: OutlineNameProps) {
  if (editingId === id) {
    return (
      <Input
        autoFocus
        data-testid={`inspector-outline-${kind}-name`}
        value={editingValue}
        aria-label={`Edit ${kind} name`}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onEditingValueChange(event.target.value)}
        onBlur={() => onCommit(id, value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onCommit(id, value);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        className="h-8 min-w-0 px-2 text-xs"
      />
    );
  }

  return (
    <span
      className="min-w-0 flex-1 truncate"
      onDoubleClick={(event) => {
        event.stopPropagation();
        onBeginEdit(id, value);
      }}
      title="Double-click to rename"
    >
      {value}
    </span>
  );
}

/**
 * Persistent structure inspector. The hierarchy remains mounted as selection
 * changes, while the detail section keeps the existing edit controls.
 */
export function SandboxInspector({
  state,
  onRenameDepartment,
  onRenameModule,
  onUpdateField,
  onUpdateLinkLabel,
  onDeleteSelected,
  onAddField,
  onAddModule,
  onAddDepartment,
  onMoveModule,
  onSelect,
}: SandboxInspectorProps) {
  const { selectedCellId, currentStage } = state;
  const isReadOnly = currentStage === "automation";
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  const department = state.departments.find(
    (item) => item.id === selectedCellId,
  );
  const sandboxModule = state.modules.find(
    (item) => item.id === selectedCellId,
  );
  const field = state.fields.find((item) => item.id === selectedCellId);
  const link = state.links.find((item) => item.id === selectedCellId);
  const selectedFieldModule =
    field === undefined
      ? undefined
      : state.modules.find((item) => item.id === field.moduleId);

  function beginEdit(id: string, value: string): void {
    if (isReadOnly) {
      return;
    }
    onSelect(id);
    setEditingId(id);
    setEditingValue(value);
  }

  function commitEdit(id: string, currentValue: string): void {
    const nextValue = editingValue.trim();
    if (nextValue.length > 0 && nextValue !== currentValue) {
      if (id.startsWith("department-")) {
        onRenameDepartment(id, nextValue);
      } else if (id.startsWith("module-")) {
        onRenameModule(id, nextValue);
      } else if (id.startsWith("field-")) {
        onUpdateField(id, { name: nextValue });
      }
    }
    setEditingId(null);
  }

  function fieldsForModule(moduleId: string, fieldIds: string[]) {
    return fieldIds.flatMap((fieldId) => {
      const match = state.fields.find(
        (item) => item.id === fieldId && item.moduleId === moduleId,
      );
      return match === undefined ? [] : [match];
    });
  }

  function renderDepartment(
    departmentItem: SandboxState["departments"][number],
  ) {
    const departmentModules = departmentItem.moduleIds.flatMap((moduleId) => {
      const match = state.modules.find((item) => item.id === moduleId);
      return match === undefined ? [] : [match];
    });
    const isSelected =
      selectedCellId === departmentItem.id ||
      sandboxModule?.departmentId === departmentItem.id ||
      selectedFieldModule?.departmentId === departmentItem.id;

    return (
      <li key={departmentItem.id} data-testid="inspector-outline-department">
        <div className="flex items-center gap-1">
          {editingId === departmentItem.id ? (
            <div className="min-w-0 flex-1">
              <OutlineName
                id={departmentItem.id}
                value={departmentItem.name}
                kind="department"
                editingId={editingId}
                editingValue={editingValue}
                onBeginEdit={beginEdit}
                onEditingValueChange={setEditingValue}
                onCommit={commitEdit}
                onCancel={() => setEditingId(null)}
              />
            </div>
          ) : (
            <button
              type="button"
              data-testid="inspector-outline-department-select"
              aria-current={isSelected ? "true" : undefined}
              aria-label={`Select department ${departmentItem.name}`}
              onClick={() => onSelect(departmentItem.id)}
              onDoubleClick={() =>
                beginEdit(departmentItem.id, departmentItem.name)
              }
              className={`flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-[var(--radius)] px-2 py-1.5 text-left text-xs font-semibold transition ${selectedClasses(isSelected)}`}
            >
              <span aria-hidden="true" className="text-primary text-[10px]">
                ▾
              </span>
              <span className="min-w-0 flex-1 truncate">
                {departmentItem.name}
              </span>
              <span className="text-muted-foreground shrink-0">
                {departmentModules.length}
              </span>
            </button>
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            data-testid="inspector-outline-add-module"
            aria-label={`Add module to ${departmentItem.name}`}
            disabled={isReadOnly}
            onClick={() => onAddModule(departmentItem.id)}
            className="size-8 shrink-0"
          >
            +
          </Button>
        </div>

        {departmentModules.length > 0 ? (
          <ul className="border-border ml-3 flex flex-col gap-1 border-l pl-2">
            {departmentModules.map((moduleItem) => {
              const moduleFields = fieldsForModule(
                moduleItem.id,
                moduleItem.fieldIds,
              );
              const moduleSelected =
                selectedCellId === moduleItem.id ||
                field?.moduleId === moduleItem.id;

              return (
                <li key={moduleItem.id} data-testid="inspector-outline-module">
                  <div className="flex items-center gap-1">
                    {editingId === moduleItem.id ? (
                      <div className="min-w-0 flex-1">
                        <OutlineName
                          id={moduleItem.id}
                          value={moduleItem.name}
                          kind="module"
                          editingId={editingId}
                          editingValue={editingValue}
                          onBeginEdit={beginEdit}
                          onEditingValueChange={setEditingValue}
                          onCommit={commitEdit}
                          onCancel={() => setEditingId(null)}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-testid="inspector-outline-module-select"
                        aria-current={moduleSelected ? "true" : undefined}
                        aria-label={`Select module ${moduleItem.name}`}
                        onClick={() => onSelect(moduleItem.id)}
                        onDoubleClick={() =>
                          beginEdit(moduleItem.id, moduleItem.name)
                        }
                        className={`flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-[var(--radius)] px-2 py-1.5 text-left text-xs transition ${selectedClasses(moduleSelected)}`}
                      >
                        <span
                          aria-hidden="true"
                          className="text-muted-foreground text-[10px]"
                        >
                          ▾
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {moduleItem.name}
                        </span>
                        <span className="text-muted-foreground shrink-0">
                          {moduleFields.length}
                        </span>
                      </button>
                    )}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      data-testid="inspector-outline-add-field"
                      aria-label={`Add field to ${moduleItem.name}`}
                      disabled={isReadOnly}
                      onClick={() => onAddField(moduleItem.id, "text")}
                      className="size-8 shrink-0"
                    >
                      +
                    </Button>
                  </div>

                  {moduleFields.length > 0 ? (
                    <ul className="border-border ml-3 flex flex-col gap-0.5 border-l pl-2">
                      {moduleFields.map((fieldItem) => {
                        const fieldSelected = selectedCellId === fieldItem.id;
                        return (
                          <li
                            key={fieldItem.id}
                            data-testid="inspector-outline-field"
                          >
                            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_6rem] items-center gap-1">
                              {editingId === fieldItem.id ? (
                                <div className="min-w-0 flex-1">
                                  <OutlineName
                                    id={fieldItem.id}
                                    value={fieldItem.name}
                                    kind="field"
                                    editingId={editingId}
                                    editingValue={editingValue}
                                    onBeginEdit={beginEdit}
                                    onEditingValueChange={setEditingValue}
                                    onCommit={commitEdit}
                                    onCancel={() => setEditingId(null)}
                                  />
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  data-testid="inspector-outline-field-select"
                                  aria-current={
                                    fieldSelected ? "true" : undefined
                                  }
                                  aria-label={`Select field ${fieldItem.name}`}
                                  onClick={() => onSelect(fieldItem.id)}
                                  onDoubleClick={() =>
                                    beginEdit(fieldItem.id, fieldItem.name)
                                  }
                                  className={`flex min-h-8 min-w-0 flex-1 items-center rounded-[var(--radius)] px-2 py-1 text-left text-xs transition ${selectedClasses(fieldSelected)}`}
                                >
                                  <span className="min-w-0 flex-1 truncate">
                                    {fieldItem.name}
                                  </span>
                                </button>
                              )}
                              <Select
                                size="sm"
                                value={fieldItem.type}
                                aria-label={`Change type for field ${fieldItem.name}`}
                                data-testid="inspector-outline-field-type"
                                disabled={isReadOnly}
                                onClick={(event) => event.stopPropagation()}
                                onValueChange={(value) => {
                                  if (isSandboxFieldType(value)) {
                                    onSelect(fieldItem.id);
                                    onUpdateField(fieldItem.id, {
                                      type: value,
                                    });
                                  }
                                }}
                                className="max-w-none"
                              >
                                {FIELD_TYPES.map((type) => (
                                  <SelectItem key={type} value={type}>
                                    {FIELD_TYPE_META[type].label}
                                  </SelectItem>
                                ))}
                              </Select>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </li>
    );
  }

  const moduleFields =
    sandboxModule === undefined
      ? []
      : fieldsForModule(sandboxModule.id, sandboxModule.fieldIds);

  return (
    <section
      aria-label="Inspector"
      data-testid="inspector-root"
      className="flex flex-col gap-4"
    >
      <Card data-testid="inspector-outline" className="p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <SectionTitle>Structure</SectionTitle>
            <p className="text-muted-foreground mt-1 text-[11px]">
              Select an item to edit it. Double-click a name to rename it.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="inspector-add-department"
            disabled={isReadOnly}
            onClick={onAddDepartment}
            className="whitespace-nowrap"
          >
            + Department
          </Button>
        </div>

        {state.departments.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1">
            {state.departments.map(renderDepartment)}
          </ul>
        ) : (
          <p className="text-muted-foreground mt-3 rounded-[var(--radius)] border border-dashed p-3 text-xs">
            No departments yet. Add one to start your sandbox.
          </p>
        )}
      </Card>

      {currentStage === "automation" ? (
        <Card
          data-testid="inspector-automation-preview"
          className="border-dashed p-4"
        >
          <p className="text-sm font-semibold">
            Automation Preview — not available yet
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            Workflows arrive later. This read-only preview shows the shape.
          </p>
          <dl className="mt-3 flex flex-col gap-2 text-xs">
            <div className="border-border bg-muted rounded-[var(--radius)] border px-3 py-2">
              <dt className="font-semibold">When</dt>
              <dd className="text-muted-foreground">
                A record is created in Orders
              </dd>
            </div>
            <div className="border-border bg-muted rounded-[var(--radius)] border px-3 py-2">
              <dt className="font-semibold">If</dt>
              <dd className="text-muted-foreground">Status is “Pending”</dd>
            </div>
            <div className="border-border bg-muted rounded-[var(--radius)] border px-3 py-2">
              <dt className="font-semibold">Then</dt>
              <dd className="text-muted-foreground">
                Notify the Sales department
              </dd>
            </div>
          </dl>
        </Card>
      ) : null}

      <div
        data-testid="inspector-selection-details"
        className="flex flex-col gap-3"
      >
        <SectionTitle>
          {department === undefined &&
          sandboxModule === undefined &&
          field === undefined &&
          link === undefined
            ? "Selection details"
            : "Selected item"}
        </SectionTitle>

        {currentStage === "automation" ? null : department !== undefined ? (
          <div
            data-testid="inspector-department"
            className="flex flex-col gap-3"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inspector-dept-name">Name</Label>
              <Input
                id="inspector-dept-name"
                data-testid="inspector-dept-name"
                value={department.name}
                onChange={(event) =>
                  onRenameDepartment(department.id, event.target.value)
                }
              />
            </div>
            <p
              data-testid="inspector-dept-count"
              className="text-muted-foreground text-xs"
            >
              {department.moduleIds.length}{" "}
              {department.moduleIds.length === 1 ? "module" : "modules"}
            </p>
            <Button
              type="button"
              variant="ghost"
              className="text-destructive mt-2 justify-start"
              size="sm"
              data-testid="inspector-delete"
              onClick={() =>
                onDeleteSelected({ kind: "department", id: department.id })
              }
            >
              Delete department
            </Button>
          </div>
        ) : sandboxModule !== undefined ? (
          <div data-testid="inspector-module" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inspector-module-name">Name</Label>
              <Input
                id="inspector-module-name"
                data-testid="inspector-module-name"
                value={sandboxModule.name}
                onChange={(event) =>
                  onRenameModule(sandboxModule.id, event.target.value)
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inspector-module-dept">Department</Label>
              <Select
                id="inspector-module-dept"
                data-testid="inspector-module-dept"
                aria-label="Parent department"
                value={sandboxModule.departmentId}
                disabled={onMoveModule === undefined}
                onValueChange={(value) =>
                  onMoveModule?.(sandboxModule.id, value)
                }
              >
                {state.departments.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </Select>
            </div>
            <p
              data-testid="inspector-module-field-count"
              className="text-muted-foreground text-xs"
            >
              {moduleFields.length}{" "}
              {moduleFields.length === 1 ? "field" : "fields"}
            </p>
            {moduleFields.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {moduleFields.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      data-testid="inspector-field-item"
                      aria-label={`Select field ${item.name}`}
                      onClick={() => onSelect(item.id)}
                      className="border-border text-foreground hover:bg-muted flex w-full items-center justify-between gap-2 border-b px-1 py-3 text-left text-xs"
                    >
                      <span className="font-medium">{item.name}</span>
                      <span className="text-muted-foreground">
                        {FIELD_TYPE_META[item.type].label}
                        {item.required ? " · required" : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="inspector-module-add-field"
              onClick={() => onAddField(sandboxModule.id, "text")}
            >
              + Add Field
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="text-destructive mt-2 justify-start"
              size="sm"
              data-testid="inspector-delete"
              onClick={() =>
                onDeleteSelected({ kind: "module", id: sandboxModule.id })
              }
            >
              Delete module
            </Button>
          </div>
        ) : field !== undefined ? (
          <div data-testid="inspector-field" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inspector-field-name">Name</Label>
              <Input
                id="inspector-field-name"
                data-testid="inspector-field-name"
                value={field.name}
                onChange={(event) =>
                  onUpdateField(field.id, { name: event.target.value })
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inspector-field-type">Type</Label>
              <Select
                id="inspector-field-type"
                data-testid="inspector-field-type"
                aria-label="Field type"
                value={field.type}
                onValueChange={(value) => {
                  if (isSandboxFieldType(value)) {
                    onUpdateField(field.id, { type: value });
                  }
                }}
              >
                {FIELD_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {FIELD_TYPE_META[type].label}
                  </SelectItem>
                ))}
              </Select>
            </div>
            <label
              htmlFor="inspector-field-required"
              className="flex items-center gap-2 text-sm"
            >
              <input
                id="inspector-field-required"
                data-testid="inspector-field-required"
                type="checkbox"
                checked={field.required}
                onChange={(event) =>
                  onUpdateField(field.id, { required: event.target.checked })
                }
                className="size-4 accent-[var(--primary)]"
              />
              Required
            </label>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inspector-field-description">Description</Label>
              <Input
                id="inspector-field-description"
                data-testid="inspector-field-description"
                value={field.description}
                placeholder="What is this field for?"
                onChange={(event) =>
                  onUpdateField(field.id, { description: event.target.value })
                }
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              className="text-destructive mt-2 justify-start"
              size="sm"
              data-testid="inspector-delete"
              onClick={() => onDeleteSelected({ kind: "field", id: field.id })}
            >
              Delete field
            </Button>
          </div>
        ) : link !== undefined ? (
          <div data-testid="inspector-link" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inspector-link-from">From</Label>
              <Input
                id="inspector-link-from"
                data-testid="inspector-link-from"
                readOnly
                value={
                  state.modules.find((item) => item.id === link.sourceModuleId)
                    ?.name ?? "Unknown module"
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inspector-link-to">To</Label>
              <Input
                id="inspector-link-to"
                data-testid="inspector-link-to"
                readOnly
                value={
                  state.modules.find((item) => item.id === link.targetModuleId)
                    ?.name ?? "Unknown module"
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inspector-link-label">Label</Label>
              <Input
                id="inspector-link-label"
                data-testid="inspector-link-label"
                value={link.label}
                placeholder="e.g. supplied by"
                onChange={(event) =>
                  onUpdateLinkLabel(link.id, event.target.value)
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inspector-link-type">Type</Label>
              <Select
                id="inspector-link-type"
                data-testid="inspector-link-type"
                aria-label="Relationship type"
                value={link.relationshipType ?? "directed"}
                disabled
                onValueChange={() => undefined}
              >
                <SelectItem value="directed">Directed</SelectItem>
              </Select>
            </div>
            <Button
              type="button"
              variant="ghost"
              className="text-destructive mt-2 justify-start"
              size="sm"
              data-testid="inspector-delete"
              onClick={() => onDeleteSelected({ kind: "link", id: link.id })}
            >
              Delete relationship
            </Button>
          </div>
        ) : (
          <div data-testid="inspector-empty" className="flex flex-col gap-3">
            <p className="text-muted-foreground text-xs">
              Select a department, module, field, or relationship on the canvas
              or in the structure list to edit it here.
            </p>
            <dl className="border-border bg-muted grid grid-cols-2 gap-2 rounded-[var(--radius)] border p-3 text-xs">
              <div>
                <dt className="text-muted-foreground">Departments</dt>
                <dd className="font-semibold">{state.departments.length}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Modules</dt>
                <dd className="font-semibold">{state.modules.length}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Fields</dt>
                <dd className="font-semibold">{state.fields.length}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Relationships</dt>
                <dd className="font-semibold">{state.links.length}</dd>
              </div>
            </dl>
          </div>
        )}
      </div>
    </section>
  );
}
