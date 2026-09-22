"use client";

import { useRef, useState, type ReactNode, type DragEvent } from "react";

import {
  FIELD_TYPE_META,
  fieldsForModule,
  searchSandboxStructure,
  type SandboxFieldType,
  type SandboxState,
  type UpdateSandboxFieldPatch,
} from "@/lib/sandbox/model";
import {
  ChevronDown,
  ChevronRight,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { SandboxCommandResult } from "@/components/systems/sandbox/state/commands";

type SandboxCommand =
  | void
  | SandboxCommandResult<unknown>
  | PromiseLike<SandboxCommandResult<unknown> | void>;

function commandFailed(
  result: void | SandboxCommandResult<unknown>,
): result is { ok: false; error: string } {
  return result?.ok === false;
}

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
  onRenameDepartment: (departmentId: string, name: string) => SandboxCommand;
  onRenameModule: (moduleId: string, name: string) => SandboxCommand;
  onUpdateField: (
    fieldId: string,
    patch: UpdateSandboxFieldPatch,
  ) => SandboxCommand;
  onUpdateLinkLabel: (linkId: string, label: string) => SandboxCommand;
  onDeleteSelected: (target: SandboxInspectorTarget) => void;
  onAddField: (moduleId: string, type: SandboxFieldType) => void;
  onAddModule: (departmentId: string) => void;
  onAddDepartment: () => void;
  onMoveModule?: (moduleId: string, departmentId: string) => SandboxCommand;
  onSelect: (cellId: string) => void;
  onEdit?: (cellId: string) => void;
  onAddRelationship?: () => void;
  onDuplicate?: (target: SandboxInspectorTarget) => void;
  onToggleLifecycle?: (target: SandboxInspectorTarget) => void;
  pending?: boolean;
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
  onCommit: (id: string, currentValue: string) => SandboxCommand;
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
        onBlur={() => {
          void onCommit(id, value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void onCommit(id, value);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        className="h-11 min-w-0 px-2 text-xs xl:h-8"
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
  onDuplicate,
  onToggleLifecycle,
  pending = false,
}: SandboxInspectorProps) {
  const { selectedCellId } = state;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [editingError, setEditingError] = useState("");
  const committingId = useRef<string | null>(null);
  const [structureQuery, setStructureQuery] = useState("");
  const [openContextMenu, setOpenContextMenu] = useState<string | null>(null);
  const [contextMenuAnchor, setContextMenuAnchor] =
    useState<HTMLElement | null>(null);
  const [collapsedDepartments, setCollapsedDepartments] = useState<Set<string>>(
    () => new Set(),
  );
  const [collapsedModules, setCollapsedModules] = useState<Set<string>>(
    () => new Set(),
  );
  const outlineRef = useRef<HTMLDivElement>(null);

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
  const structureSearch = searchSandboxStructure(state, structureQuery);

  function beginEdit(id: string, value: string): void {
    onSelect(id);
    setEditingId(id);
    setEditingValue(value);
    setEditingError("");
  }

  async function commitEdit(
    id: string,
    currentValue: string,
  ): Promise<SandboxCommandResult<unknown> | void> {
    if (committingId.current === id) return;
    const nextValue = editingValue.trim();
    if (nextValue.length === 0 || nextValue === currentValue) {
      setEditingId(null);
      setEditingError("");
      return;
    }
    committingId.current = id;
    setEditingError("");
    try {
      let result: void | SandboxCommandResult<unknown> = undefined;
      if (state.departments.some((item) => item.id === id)) {
        result = await onRenameDepartment(id, nextValue);
      } else if (state.modules.some((item) => item.id === id)) {
        result = await onRenameModule(id, nextValue);
      } else if (state.fields.some((item) => item.id === id)) {
        result = await onUpdateField(id, { name: nextValue });
      }
      if (commandFailed(result)) {
        setEditingError(result.error);
        return result;
      }
      setEditingId(null);
      setEditingError("");
      return result;
    } finally {
      committingId.current = null;
    }
  }

  function rowContextMenu(
    kind: "department" | "module" | "field",
    id: string,
    name: string,
  ) {
    const closed =
      state.departments.some((item) => item.id === id && item.closed) ||
      state.modules.some((item) => item.id === id && item.closed) ||
      state.fields.some((item) => item.id === id && item.closed);
    return (
      <>
        <ContextMenuGroup>
          <ContextMenuItem
            className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
            disabled={pending}
            onClick={() => beginEdit(id, name)}
          >
            <Pencil aria-hidden="true" />
            Rename {kind}
          </ContextMenuItem>
          {onToggleLifecycle ? (
            <ContextMenuItem
              className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
              disabled={pending}
              onClick={() => void onToggleLifecycle({ kind, id })}
            >
              {closed ? "Reopen" : "Close"} {kind}
            </ContextMenuItem>
          ) : null}
          {onDuplicate ? (
            <ContextMenuItem
              className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
              disabled={pending}
              onClick={() => void onDuplicate({ kind, id })}
            >
              Duplicate {kind}
            </ContextMenuItem>
          ) : null}
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem
            className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
            variant="destructive"
            disabled={pending}
            onClick={() => onDeleteSelected({ kind, id })}
          >
            <Trash2 aria-hidden="true" />
            Delete {kind}
          </ContextMenuItem>
        </ContextMenuGroup>
      </>
    );
  }

  function relationshipActions(id: string, name: string) {
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 xl:size-8"
          aria-label={`Edit relationship ${name}`}
          disabled={pending}
          onClick={() => onEdit?.(id)}
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-destructive size-11 shrink-0 xl:size-8"
          aria-label={`Delete relationship ${name}`}
          disabled={pending}
          onClick={() => onDeleteSelected({ kind: "link", id })}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </Button>
      </>
    );
  }

  function jumpToSelection(): void {
    if (!selectedCellId) return;
    setStructureQuery("");
    const selectedModuleId = sandboxModule?.id ?? selectedFieldModule?.id;
    const selectedDepartmentId =
      department?.id ??
      sandboxModule?.departmentId ??
      selectedFieldModule?.departmentId;
    if (selectedDepartmentId)
      setCollapsedDepartments((current) => {
        const next = new Set(current);
        next.delete(selectedDepartmentId);
        return next;
      });
    if (selectedModuleId)
      setCollapsedModules((current) => {
        const next = new Set(current);
        next.delete(selectedModuleId);
        return next;
      });
    requestAnimationFrame(() => {
      const selected = outlineRef.current?.querySelector<HTMLElement>(
        `[data-outline-id="${CSS.escape(selectedCellId)}"]`,
      );
      selected?.scrollIntoView({ block: "nearest" });
      selected?.focus();
    });
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
        disabled={pending}
        className="text-muted-foreground hover:text-foreground mt-1 h-11 w-full justify-start px-2 text-xs font-normal xl:h-9"
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
    item: { id: string; name: string; closed?: boolean },
    selected: boolean,
  ) {
    const menuId = `${kind}:${item.id}`;
    return (
      <div className="min-w-0">
        {editingId === item.id ? (
          <>
            <OutlineName
              id={item.id}
              value={item.name}
              kind={kind}
              editingId={editingId}
              editingValue={editingValue}
              onBeginEdit={beginEdit}
              onEditingValueChange={setEditingValue}
              onCommit={commitEdit}
              onCancel={() => {
                if (committingId.current !== item.id) {
                  setEditingId(null);
                  setEditingError("");
                }
              }}
            />
            {editingError ? (
              <p className="text-destructive px-2 py-1 text-xs" role="alert">
                {editingError}
              </p>
            ) : null}
          </>
        ) : (
          <ContextMenu
            open={openContextMenu === menuId}
            onOpenChange={(open) => {
              if (open) {
                onSelect(item.id);
                setOpenContextMenu(menuId);
              } else {
                setOpenContextMenu((current) =>
                  current === menuId ? null : current,
                );
                setContextMenuAnchor(null);
              }
            }}
          >
            <ContextMenuTrigger
              render={
                <button
                  type="button"
                  data-testid={`inspector-outline-${kind}-select`}
                  data-outline-id={item.id}
                  aria-current={selected ? "true" : undefined}
                  aria-label={`Select ${kind} ${item.name}`}
                />
              }
              onClick={() => onSelect(item.id)}
              onDoubleClick={() => beginEdit(item.id, item.name)}
              onContextMenu={() => {
                setContextMenuAnchor(null);
                onSelect(item.id);
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "ContextMenu" ||
                  (event.shiftKey && event.key === "F10")
                ) {
                  event.preventDefault();
                  onSelect(item.id);
                  setContextMenuAnchor(event.currentTarget);
                  setOpenContextMenu(menuId);
                }
              }}
              className={`flex min-h-11 w-full min-w-0 items-center gap-1 rounded-[var(--radius)] px-2 text-left text-xs xl:min-h-9 ${kind === "department" ? "font-semibold" : ""} ${selectedClasses(selected)}`}
            >
              <span className="min-w-0 flex-1 truncate" title={item.name}>
                {item.name}
              </span>
              {item.closed ? (
                <Badge variant="secondary" className="text-[10px]">
                  Closed
                </Badge>
              ) : null}
            </ContextMenuTrigger>
            <ContextMenuContent
              data-sandbox-portal
              anchor={contextMenuAnchor ?? undefined}
              aria-label={`Actions for ${kind} ${item.name}`}
              finalFocus={() =>
                outlineRef.current?.querySelector<HTMLElement>(
                  `[data-outline-id="${CSS.escape(item.id)}"]`,
                ) ?? null
              }
            >
              {rowContextMenu(kind, item.id, item.name)}
            </ContextMenuContent>
          </ContextMenu>
        )}
      </div>
    );
  }

  function renderDepartment(
    departmentItem: SandboxState["departments"][number],
  ) {
    const searchResult = structureSearch.departments.get(departmentItem.id);
    if (searchResult === undefined || !searchResult.matches) {
      return null;
    }
    const { modules: departmentModules } = searchResult;
    const query = structureSearch.query;
    const departmentExpanded =
      query.length > 0 || !collapsedDepartments.has(departmentItem.id);
    return (
      <li key={departmentItem.id} data-testid="inspector-outline-department">
        <div className="flex min-w-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 xl:size-8"
            aria-label={`${departmentExpanded ? "Collapse" : "Expand"} department ${departmentItem.name}`}
            aria-expanded={departmentExpanded}
            onClick={() =>
              setCollapsedDepartments((current) => {
                const next = new Set(current);
                if (next.has(departmentItem.id)) next.delete(departmentItem.id);
                else next.add(departmentItem.id);
                return next;
              })
            }
          >
            {departmentExpanded ? (
              <ChevronDown aria-hidden="true" />
            ) : (
              <ChevronRight aria-hidden="true" />
            )}
          </Button>
          <div className="min-w-0 flex-1">
            {itemRow(
              "department",
              departmentItem,
              selectedCellId === departmentItem.id ||
                sandboxModule?.departmentId === departmentItem.id ||
                selectedFieldModule?.departmentId === departmentItem.id,
            )}
          </div>
        </div>
        {departmentExpanded ? (
          <ul className="border-border mt-1 ml-6 flex flex-col gap-2 border-l pl-2">
            {departmentModules.map((moduleItem) => (
              <li key={moduleItem.id} data-testid="inspector-outline-module">
                {(() => {
                  const moduleExpanded =
                    query.length > 0 || !collapsedModules.has(moduleItem.id);
                  const visibleFields =
                    searchResult.fieldsByModule.get(moduleItem.id) ?? [];
                  return (
                    <>
                      <div className="flex min-w-0 items-center gap-0.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-11 shrink-0 xl:size-8"
                          aria-label={`${moduleExpanded ? "Collapse" : "Expand"} module ${moduleItem.name}`}
                          aria-expanded={moduleExpanded}
                          onClick={() =>
                            setCollapsedModules((current) => {
                              const next = new Set(current);
                              if (next.has(moduleItem.id))
                                next.delete(moduleItem.id);
                              else next.add(moduleItem.id);
                              return next;
                            })
                          }
                        >
                          {moduleExpanded ? (
                            <ChevronDown aria-hidden="true" />
                          ) : (
                            <ChevronRight aria-hidden="true" />
                          )}
                        </Button>
                        <div className="min-w-0 flex-1">
                          {itemRow(
                            "module",
                            moduleItem,
                            selectedCellId === moduleItem.id ||
                              field?.moduleId === moduleItem.id,
                          )}
                        </div>
                      </div>
                      {moduleExpanded ? (
                        <ul className="sandbox-field-list border-border mt-1 ml-6 flex flex-col gap-1 border-l pl-2">
                          {visibleFields.map((fieldItem) => (
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
                          ))}
                        </ul>
                      ) : null}
                      {moduleExpanded && !query ? (
                        <div className="ml-8">
                          {addRow("field", moduleItem.id, moduleItem.name)}
                        </div>
                      ) : null}
                    </>
                  );
                })()}
              </li>
            ))}
          </ul>
        ) : null}
        {departmentExpanded && !query ? (
          <div className="ml-6">
            {addRow("module", departmentItem.id, departmentItem.name)}
          </div>
        ) : null}
      </li>
    );
  }

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
        <div ref={outlineRef}>
          <Card data-testid="inspector-outline" className="border-0 p-0">
            <div className="flex flex-col gap-3">
              <div>
                <SectionTitle>Structure</SectionTitle>
                <p className="text-muted-foreground mt-1 text-[11px]">
                  Select an item for settings. Use the visible actions to add,
                  rename, or manage items.
                </p>
              </div>
              <div className="flex min-w-0 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 min-w-0 flex-1 xl:min-h-8"
                  aria-label="Expand all"
                  onClick={() => {
                    setCollapsedDepartments(new Set());
                    setCollapsedModules(new Set());
                  }}
                >
                  Expand all
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 min-w-0 flex-1 xl:min-h-8"
                  aria-label="Collapse all"
                  onClick={() => {
                    setCollapsedDepartments(
                      new Set(state.departments.map((item) => item.id)),
                    );
                    setCollapsedModules(
                      new Set(state.modules.map((item) => item.id)),
                    );
                  }}
                >
                  Collapse all
                </Button>
              </div>
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
                />
                <Input
                  type="search"
                  aria-label="Search structure"
                  placeholder="Search structure"
                  value={structureQuery}
                  onChange={(event) => setStructureQuery(event.target.value)}
                  className="h-11 pl-8 xl:h-9"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 xl:min-h-8"
                disabled={!selectedCellId}
                onClick={jumpToSelection}
              >
                Jump to selection
              </Button>
            </div>

            {state.departments.length > 0 && structureSearch.hasMatches ? (
              <ul className="mt-3 flex flex-col gap-3">
                {state.departments.map(renderDepartment)}
              </ul>
            ) : (
              <Empty className="mt-3 items-start gap-1 border p-3 text-left">
                <EmptyHeader className="items-start">
                  <EmptyDescription className="text-xs">
                    {structureQuery.trim()
                      ? "No structure items match."
                      : "No departments yet. Add one to start your sandbox."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {!structureQuery.trim() ? addRow("department") : null}
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
                        className={`min-h-11 min-w-0 flex-1 truncate rounded px-2 text-left text-xs xl:min-h-9 ${selectedClasses(selectedCellId === item.id)}`}
                        onClick={() => onSelect(item.id)}
                        aria-current={
                          selectedCellId === item.id ? "true" : undefined
                        }
                        aria-label={`Select relationship ${name}`}
                        title={name}
                      >
                        {name}
                      </button>
                      {relationshipActions(item.id, name)}
                    </li>
                  );
                })}
              </ul>
              <Button
                variant="ghost"
                size="sm"
                data-testid="inspector-add-relationship"
                disabled={pending || state.modules.length < 2}
                onClick={onAddRelationship}
                className="text-muted-foreground mt-1 min-h-11 w-full justify-start px-2 text-xs font-normal xl:min-h-9"
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
        </div>
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
                <Badge
                  variant="outline"
                  className="shrink-0 text-[10px] tracking-[0.12em] uppercase"
                >
                  {selectedType}
                </Badge>
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
                <FieldLabel htmlFor="inspector-field-required">
                  Required
                </FieldLabel>
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
                  Select a department, module, field, or relationship on the
                  canvas or in the Structure panel to edit it here.
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
                    <dd className="font-semibold">
                      {state.departments.length}
                    </dd>
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
      ) : null}
    </section>
  );
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
