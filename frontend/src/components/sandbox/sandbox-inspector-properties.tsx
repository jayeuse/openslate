"use client";

import {
  FIELD_TYPE_META,
  fieldsForModule,
  type SandboxState,
} from "@/lib/sandbox/model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import type { SandboxInspectorProps } from "./sandbox-inspector-types";
import { SectionTitle } from "./sandbox-inspector-shared";

const FIELD_TYPES = Object.keys(FIELD_TYPE_META) as SandboxFieldType[];

function isSandboxFieldType(value: string): value is SandboxFieldType {
  return (Object.keys(FIELD_TYPE_META) as string[]).includes(value);
}

type SandboxFieldType = SandboxState["fields"][number]["type"];

type PropertiesProps = Pick<
  SandboxInspectorProps,
  | "state"
  | "onRenameDepartment"
  | "onRenameModule"
  | "onUpdateField"
  | "onUpdateLinkLabel"
  | "onDeleteSelected"
  | "onAddField"
  | "onAddModule"
  | "onAddDepartment"
  | "onMoveModule"
  | "onSelect"
  | "pending"
> & { visible: boolean };

export function SandboxInspectorProperties({
  visible,
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
  pending = false,
}: PropertiesProps) {
  const { selectedCellId } = state;
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
  const moduleFields =
    sandboxModule === undefined
      ? []
      : fieldsForModule(sandboxModule.id, sandboxModule.fieldIds, state.fields);

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

  return visible ? (
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
            <Badge
              variant="outline"
              className="shrink-0 text-[10px] tracking-[0.12em] uppercase"
            >
              {selectedType}
            </Badge>
          </div>
          <p className="text-muted-foreground text-xs">{selectedLocation}</p>
          <p className="text-muted-foreground text-xs">
            Changes apply to this session.
          </p>
        </div>
      ) : null}

      {department !== undefined ? (
        <div data-testid="inspector-department" className="flex flex-col gap-3">
          <SectionTitle>Basics</SectionTitle>
          <Field>
            <FieldLabel htmlFor="inspector-dept-name">Name</FieldLabel>
            <Input
              id="inspector-dept-name"
              data-testid="inspector-dept-name"
              value={department.name}
              onChange={(event) =>
                void onRenameDepartment(department.id, event.target.value)
              }
            />
          </Field>
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
              disabled={pending}
              onClick={() => onAddModule(department.id)}
            >
              + Add module
            </Button>
          </div>
          <DestructiveAction
            label="Delete department"
            pending={pending}
            onClick={() =>
              onDeleteSelected({ kind: "department", id: department.id })
            }
          />
        </div>
      ) : sandboxModule !== undefined ? (
        <div data-testid="inspector-module" className="flex flex-col gap-3">
          <SectionTitle>Basics</SectionTitle>
          <Field>
            <FieldLabel htmlFor="inspector-module-name">Name</FieldLabel>
            <Input
              id="inspector-module-name"
              data-testid="inspector-module-name"
              value={sandboxModule.name}
              onChange={(event) =>
                void onRenameModule(sandboxModule.id, event.target.value)
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="inspector-module-dept">
              Parent department
            </FieldLabel>
            <NativeSelect
              id="inspector-module-dept"
              data-testid="inspector-module-dept"
              aria-label="Parent department"
              className="w-full [&_select]:h-11 xl:[&_select]:h-8"
              value={sandboxModule.departmentId}
              disabled={pending || onMoveModule === undefined}
              onChange={(event) =>
                void onMoveModule?.(sandboxModule.id, event.target.value)
              }
            >
              {state.departments.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
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
                disabled={pending}
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
              <Empty className="items-start gap-1 border p-3 text-left">
                <EmptyHeader className="items-start">
                  <EmptyDescription className="text-xs">
                    No fields yet. Add one to describe this module.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
          <DestructiveAction
            label="Delete module"
            pending={pending}
            onClick={() =>
              onDeleteSelected({ kind: "module", id: sandboxModule.id })
            }
          />
        </div>
      ) : field !== undefined ? (
        <div data-testid="inspector-field" className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor="inspector-field-name">Name</FieldLabel>
            <Input
              id="inspector-field-name"
              data-testid="inspector-field-name"
              value={field.name}
              onChange={(event) =>
                void onUpdateField(field.id, { name: event.target.value })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="inspector-field-type">Type</FieldLabel>
            <NativeSelect
              id="inspector-field-type"
              data-testid="inspector-field-type"
              aria-label="Field type"
              className="w-full [&_select]:h-11 xl:[&_select]:h-8"
              value={field.type}
              disabled={pending}
              onChange={(event) => {
                const { value } = event.target;
                if (isSandboxFieldType(value)) {
                  void onUpdateField(field.id, { type: value });
                }
              }}
            >
              {FIELD_TYPES.map((type) => (
                <NativeSelectOption key={type} value={type}>
                  {FIELD_TYPE_META[type].label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field className="min-h-11 min-w-11 flex-row items-center gap-2 xl:min-h-0 xl:min-w-0">
            <Checkbox
              id="inspector-field-required"
              data-testid="inspector-field-required"
              checked={field.required}
              disabled={pending}
              onCheckedChange={(checked) =>
                void onUpdateField(field.id, { required: checked })
              }
            />
            <FieldLabel htmlFor="inspector-field-required">Required</FieldLabel>
          </Field>
          <Field>
            <FieldLabel htmlFor="inspector-field-description">
              Description
            </FieldLabel>
            <Input
              id="inspector-field-description"
              data-testid="inspector-field-description"
              value={field.description}
              placeholder="What is this field for?"
              onChange={(event) =>
                void onUpdateField(field.id, {
                  description: event.target.value,
                })
              }
            />
          </Field>
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
            pending={pending}
            onClick={() => onDeleteSelected({ kind: "field", id: field.id })}
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
          <Field>
            <FieldLabel htmlFor="inspector-link-label">Label</FieldLabel>
            <Input
              id="inspector-link-label"
              data-testid="inspector-link-label"
              value={link.label}
              placeholder="e.g. supplied by"
              onChange={(event) =>
                void onUpdateLinkLabel(link.id, event.target.value)
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="inspector-link-type">Direction</FieldLabel>
            <NativeSelect
              id="inspector-link-type"
              data-testid="inspector-link-type"
              aria-label="Relationship type"
              className="w-full [&_select]:h-11 xl:[&_select]:h-8"
              value={link.relationshipType ?? "directed"}
              disabled
            >
              <NativeSelectOption value="directed">
                Directed · source to target
              </NativeSelectOption>
            </NativeSelect>
          </Field>
          <DestructiveAction
            label="Delete relationship"
            pending={pending}
            onClick={() => onDeleteSelected({ kind: "link", id: link.id })}
          />
        </div>
      ) : (
        <Empty
          data-testid="inspector-empty"
          className="items-stretch gap-3 border-0 p-0 text-left"
        >
          <EmptyHeader className="max-w-none items-start">
            <EmptyTitle>Nothing selected</EmptyTitle>
            <EmptyDescription className="text-xs">
              Select a department, module, field, or relationship on the canvas
              or in the Structure panel to edit it here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="max-w-none items-stretch">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="inspector-empty-add-department"
              disabled={pending}
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
          </EmptyContent>
        </Empty>
      )}
    </div>
  ) : null;
}

function DestructiveAction({
  label,
  onClick,
  pending = false,
}: {
  label: string;
  onClick: () => void;
  pending?: boolean;
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
        disabled={pending}
      >
        {label}
      </Button>
    </div>
  );
}
