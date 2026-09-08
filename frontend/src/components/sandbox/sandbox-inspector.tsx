"use client";

import { useState, type ReactNode, type DragEvent } from "react";

import {
  FIELD_TYPE_META,
  type SandboxFieldType,
  type SandboxState,
  type UpdateSandboxFieldPatch,
} from "@/lib/sandbox/model";
import { Pencil, Trash2 } from "lucide-react";
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
  /** Render the persistent outline, properties, or both for legacy callers. */
  mode?: "combined" | "outline" | "properties";
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
  onEdit?: (cellId: string) => void;
  onAddRelationship?: () => void;
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
      title={`${value} — Double-click to rename`}
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
  mode = "combined",
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
  onEdit,
  onAddRelationship,
}: SandboxInspectorProps) {
  const { selectedCellId } = state;
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
  const showOutline = mode !== "properties";
  const showProperties = mode !== "outline";

  function beginEdit(id: string, value: string): void {
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

  function rowActions(
    kind: SandboxInspectorTargetKind,
    id: string,
    name: string,
  ) {
    const label = kind === "link" ? "relationship" : kind;
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={`Edit ${label} ${name}`}
          onClick={() => onEdit?.(id)}
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-destructive size-8 shrink-0"
          aria-label={`Delete ${label} ${name}`}
          onClick={() => onDeleteSelected({ kind, id })}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </Button>
      </>
    );
  }

  function dragPayload(
    event: DragEvent<HTMLButtonElement>,
    kind: string,
    type?: SandboxFieldType,
  ) {
    event.dataTransfer.setData("application/x-sandbox-kind", kind);
    event.dataTransfer.setData(`application/x-sandbox-kind-${kind}`, kind);
    if (type)
      event.dataTransfer.setData("application/x-sandbox-field-type", type);
    event.dataTransfer.effectAllowed = "copy";
  }

  function addRow(
    kind: "department" | "module" | "field",
    parentId?: string,
    parentName?: string,
  ) {
    return (
      <Button
        variant="ghost"
        size="sm"
        draggable
        data-kind={kind}
        data-testid={
          kind === "department"
            ? "inspector-add-department"
            : `inspector-outline-add-${kind}`
        }
        aria-label={
          parentName ? `Add ${kind} to ${parentName}` : "Add department"
        }
        onDragStart={(event) =>
          dragPayload(event, kind, kind === "field" ? "text" : undefined)
        }
        onClick={() =>
          kind === "department"
            ? onAddDepartment()
            : kind === "module"
              ? onAddModule(parentId!)
              : onAddField(parentId!, "text")
        }
        className="text-muted-foreground hover:text-foreground mt-1 h-9 w-full justify-start px-2 text-xs font-normal"
      >
        Add{" "}
        {kind === "department"
          ? "Department"
          : kind === "module"
            ? "Module"
            : "Field"}
      </Button>
    );
  }

  function itemRow(
    kind: "department" | "module" | "field",
    item: { id: string; name: string },
    selected: boolean,
  ) {
    return (
      <div className="flex min-w-0 items-center gap-0.5">
        {editingId === item.id ? (
          <OutlineName
            id={item.id}
            value={item.name}
            kind={kind}
            editingId={editingId}
            editingValue={editingValue}
            onBeginEdit={beginEdit}
            onEditingValueChange={setEditingValue}
            onCommit={commitEdit}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <button
            type="button"
            data-testid={`inspector-outline-${kind}-select`}
            aria-current={selected ? "true" : undefined}
            aria-label={`Select ${kind} ${item.name}`}
            onClick={() => onSelect(item.id)}
            onDoubleClick={() => beginEdit(item.id, item.name)}
            className={`flex min-h-9 min-w-0 flex-1 items-center gap-1 rounded-[var(--radius)] px-2 text-left text-xs ${kind === "department" ? "font-semibold" : ""} ${selectedClasses(selected)}`}
          >
            {kind !== "field" ? <span aria-hidden="true">▾</span> : null}
            <span className="min-w-0 flex-1 truncate" title={item.name}>
              {item.name}
            </span>
          </button>
        )}
        {rowActions(kind, item.id, item.name)}
      </div>
    );
  }

  function renderDepartment(
    departmentItem: SandboxState["departments"][number],
  ) {
    const departmentModules = departmentItem.moduleIds.flatMap(
      (id) => state.modules.find((item) => item.id === id) ?? [],
    );
    return (
      <li key={departmentItem.id} data-testid="inspector-outline-department">
        {itemRow(
          "department",
          departmentItem,
          selectedCellId === departmentItem.id ||
            sandboxModule?.departmentId === departmentItem.id ||
            selectedFieldModule?.departmentId === departmentItem.id,
        )}
        <ul className="border-border mt-1 ml-2 flex flex-col gap-2 border-l pl-2">
          {departmentModules.map((moduleItem) => (
            <li key={moduleItem.id} data-testid="inspector-outline-module">
              {itemRow(
                "module",
                moduleItem,
                selectedCellId === moduleItem.id ||
                  field?.moduleId === moduleItem.id,
              )}
              <ul className="sandbox-field-list border-border mt-1 ml-2 flex flex-col gap-1 border-l pl-2">
                {fieldsForModule(moduleItem.id, moduleItem.fieldIds).map(
                  (fieldItem) => (
                    <li
                      key={fieldItem.id}
                      data-testid="inspector-outline-field"
                    >
                      {itemRow(
                        "field",
                        fieldItem,
                        selectedCellId === fieldItem.id,
                      )}
                    </li>
                  ),
                )}
              </ul>
              <div className="ml-4">
                {addRow("field", moduleItem.id, moduleItem.name)}
              </div>
            </li>
          ))}
        </ul>
        <div className="ml-2">
          {addRow("module", departmentItem.id, departmentItem.name)}
        </div>
      </li>
    );
  }

  const moduleFields =
    sandboxModule === undefined
      ? []
      : fieldsForModule(sandboxModule.id, sandboxModule.fieldIds);

  const selectedName =
    department?.name ??
    sandboxModule?.name ??
    field?.name ??
    (link === undefined ? undefined : link.label || "Relationship");
  const selectedType =
    department !== undefined
      ? "Department"
      : sandboxModule !== undefined
        ? "Module"
        : field !== undefined
          ? "Field"
          : link !== undefined
            ? "Relationship"
            : undefined;
  const selectedLocation =
    department !== undefined
      ? "Organization root"
      : sandboxModule !== undefined
        ? `Inside ${state.departments.find((item) => item.id === sandboxModule.departmentId)?.name ?? "department"}`
        : field !== undefined
          ? `Inside ${selectedFieldModule?.name ?? "module"}`
          : link !== undefined
            ? "Between two modules"
            : undefined;

  return (
    <section
      aria-label={
        showOutline && showProperties
          ? "Inspector"
          : showOutline
            ? "Structure"
            : "Properties"
      }
      data-testid={
        showOutline && showProperties
          ? "inspector-root"
          : showOutline
            ? "inspector-outline-root"
            : "inspector-properties"
      }
      className="flex flex-col gap-4"
    >
      {showOutline ? (
        <Card data-testid="inspector-outline" className="border-0 p-0">
          <div className="flex flex-col gap-3">
            <div>
              <SectionTitle>Structure</SectionTitle>
              <p className="text-muted-foreground mt-1 text-[11px]">
                Select an item or use Edit for its settings. Double-click a name
                to rename it.
              </p>
            </div>
          </div>

          {state.departments.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-3">
              {state.departments.map(renderDepartment)}
            </ul>
          ) : (
            <p className="text-muted-foreground mt-3 rounded-[var(--radius)] border border-dashed p-3 text-xs">
              No departments yet. Add one to start your sandbox.
            </p>
          )}
          {addRow("department")}
          <div className="border-border mt-4 border-t pt-3">
            <SectionTitle>Relationships</SectionTitle>
            <ul className="mt-2 flex flex-col gap-1">
              {state.links.map((item) => {
                const name =
                  item.label ||
                  `${state.modules.find((m) => m.id === item.sourceModuleId)?.name ?? "Module"} to ${state.modules.find((m) => m.id === item.targetModuleId)?.name ?? "Module"}`;
                return (
                  <li key={item.id} className="flex min-w-0 items-center">
                    <button
                      type="button"
                      className={`min-h-9 min-w-0 flex-1 truncate rounded px-2 text-left text-xs ${selectedClasses(selectedCellId === item.id)}`}
                      onClick={() => onSelect(item.id)}
                      aria-current={
                        selectedCellId === item.id ? "true" : undefined
                      }
                      aria-label={`Select relationship ${name}`}
                      title={name}
                    >
                      {name}
                    </button>
                    {rowActions("link", item.id, name)}
                  </li>
                );
              })}
            </ul>
            <Button
              variant="ghost"
              size="sm"
              data-testid="inspector-add-relationship"
              disabled={state.modules.length < 2}
              onClick={onAddRelationship}
              className="text-muted-foreground mt-1 w-full justify-start px-2 text-xs font-normal"
            >
              Add Relationship
            </Button>
            {state.modules.length < 2 ? (
              <p className="text-muted-foreground px-2 text-[11px]">
                Add two modules to connect them.
              </p>
            ) : null}
          </div>
        </Card>
      ) : null}

      {showProperties ? (
        <div
          data-testid="inspector-selection-details"
          className="flex flex-col gap-3"
        >
          {selectedName === undefined ? (
            <SectionTitle>Selection details</SectionTitle>
          ) : null}

          {selectedName !== undefined ? (
            <div
              data-testid="inspector-selection-summary"
              className="border-border flex flex-col gap-2 border-b pb-5"
            >
              <div className="flex items-center justify-between gap-3">
                <p
                  title={selectedName}
                  className="min-w-0 text-lg font-semibold break-words"
                >
                  {selectedName}
                </p>
                <span className="text-muted-foreground shrink-0 text-[10px] font-medium tracking-[0.12em] uppercase">
                  {selectedType}
                </span>
              </div>
              <p className="text-muted-foreground text-xs">
                {selectedLocation}
              </p>
              <p className="text-muted-foreground text-xs">
                Changes apply to this session.
              </p>
            </div>
          ) : null}

          {department !== undefined ? (
            <div
              data-testid="inspector-department"
              className="flex flex-col gap-3"
            >
              <SectionTitle>Basics</SectionTitle>
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
              <div className="border-border flex items-center justify-between gap-3 border-b pb-3">
                <div>
                  <p className="text-xs font-medium">Contained modules</p>
                  <p
                    data-testid="inspector-dept-count"
                    className="text-muted-foreground mt-0.5 text-xs"
                  >
                    {department.moduleIds.length}{" "}
                    {department.moduleIds.length === 1 ? "module" : "modules"}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="inspector-dept-add-module"
                  onClick={() => onAddModule(department.id)}
                >
                  + Add module
                </Button>
              </div>
              <DestructiveAction
                label="Delete department"
                onClick={() =>
                  onDeleteSelected({ kind: "department", id: department.id })
                }
              />
            </div>
          ) : sandboxModule !== undefined ? (
            <div data-testid="inspector-module" className="flex flex-col gap-3">
              <SectionTitle>Basics</SectionTitle>
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
                <Label htmlFor="inspector-module-dept">Parent department</Label>
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
              <div className="border-border border-t pt-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium">Fields</p>
                    <p
                      data-testid="inspector-module-field-count"
                      className="text-muted-foreground mt-0.5 text-xs"
                    >
                      {moduleFields.length}{" "}
                      {moduleFields.length === 1 ? "field" : "fields"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="inspector-module-add-field"
                    onClick={() => onAddField(sandboxModule.id, "text")}
                  >
                    + Add field
                  </Button>
                </div>
                {moduleFields.length > 0 ? (
                  <ul className="sandbox-field-list flex flex-col gap-1">
                    {moduleFields.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          data-testid="inspector-field-item"
                          aria-label={`Select field ${item.name}`}
                          onClick={() => onSelect(item.id)}
                          className="border-border text-foreground hover:bg-muted flex w-full items-center justify-between gap-2 rounded-[var(--radius)] border px-3 py-2 text-left text-xs"
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
                ) : (
                  <p className="text-muted-foreground rounded-[var(--radius)] border border-dashed p-3 text-xs">
                    No fields yet. Add one to describe this module.
                  </p>
                )}
              </div>
              <DestructiveAction
                label="Delete module"
                onClick={() =>
                  onDeleteSelected({ kind: "module", id: sandboxModule.id })
                }
              />
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
              <div className="border-border border-t pt-3">
                <p className="text-muted-foreground mb-1 text-[10px] font-medium tracking-[0.12em] uppercase">
                  Parent module
                </p>
                <button
                  type="button"
                  className="text-primary hover:text-primary/80 text-left text-xs font-medium underline-offset-2 hover:underline"
                  onClick={() => {
                    if (selectedFieldModule !== undefined) {
                      onSelect(selectedFieldModule.id);
                    }
                  }}
                >
                  {selectedFieldModule?.name ?? "Unknown module"}
                </button>
              </div>
              <DestructiveAction
                label="Delete field"
                onClick={() =>
                  onDeleteSelected({ kind: "field", id: field.id })
                }
              />
            </div>
          ) : link !== undefined ? (
            <div data-testid="inspector-link" className="flex flex-col gap-3">
              <div className="border-border bg-muted/50 flex items-center gap-2 rounded-[var(--radius)] border px-3 py-2 text-xs">
                <span
                  data-testid="inspector-link-from"
                  className="min-w-0 flex-1 truncate"
                >
                  {state.modules.find((item) => item.id === link.sourceModuleId)
                    ?.name ?? "Unknown module"}
                </span>
                <span aria-hidden="true" className="text-muted-foreground">
                  →
                </span>
                <span
                  data-testid="inspector-link-to"
                  className="min-w-0 flex-1 truncate text-right"
                >
                  {state.modules.find((item) => item.id === link.targetModuleId)
                    ?.name ?? "Unknown module"}
                </span>
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
                <Label htmlFor="inspector-link-type">Direction</Label>
                <Select
                  id="inspector-link-type"
                  data-testid="inspector-link-type"
                  aria-label="Relationship type"
                  value={link.relationshipType ?? "directed"}
                  disabled
                  onValueChange={() => undefined}
                >
                  <SelectItem value="directed">
                    Directed · source to target
                  </SelectItem>
                </Select>
              </div>
              <DestructiveAction
                label="Delete relationship"
                onClick={() => onDeleteSelected({ kind: "link", id: link.id })}
              />
            </div>
          ) : (
            <div data-testid="inspector-empty" className="flex flex-col gap-3">
              <p className="text-muted-foreground text-xs">
                Select a department, module, field, or relationship on the
                canvas or in the Structure panel to edit it here.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="inspector-empty-add-department"
                onClick={onAddDepartment}
                className="w-full"
              >
                + Add first department
              </Button>
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
      ) : null}
    </section>
  );
}

function DestructiveAction({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <div className="border-border mt-3 border-t pt-4">
      <p className="text-xs font-medium">
        Remove {label.replace("Delete ", "")}
      </p>
      <Button
        type="button"
        variant="ghost"
        className="text-destructive justify-start px-0"
        size="sm"
        data-testid="inspector-delete"
        onClick={onClick}
      >
        {label}
      </Button>
    </div>
  );
}
