"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  searchSandboxStructure,
  type SandboxFieldType,
  type SandboxState,
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
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { SandboxCommandResult } from "@/components/systems/sandbox/state/commands";
import type { SandboxInspectorProps } from "./sandbox-inspector-types";
import { SectionTitle } from "./sandbox-inspector-shared";

type OutlineProps = Pick<
  SandboxInspectorProps,
  | "state"
  | "onRenameDepartment"
  | "onRenameModule"
  | "onUpdateField"
  | "onDeleteSelected"
  | "onAddField"
  | "onAddModule"
  | "onAddDepartment"
  | "onSelect"
  | "onEdit"
  | "onAddRelationship"
  | "onDuplicate"
  | "onToggleLifecycle"
  | "lifecycleState"
  | "onPurge"
  | "onEditingChange"
  | "pending"
> & { visible: boolean };

type SandboxCommand =
  | void
  | SandboxCommandResult<unknown>
  | PromiseLike<SandboxCommandResult<unknown> | void>;

function commandFailed(
  result: void | SandboxCommandResult<unknown>,
): result is { ok: false; error: string } {
  return result?.ok === false;
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

export function SandboxInspectorOutline({
  visible,
  state,
  onRenameDepartment,
  onRenameModule,
  onUpdateField,
  onDeleteSelected,
  onAddField,
  onAddModule,
  onAddDepartment,
  onSelect,
  onEdit,
  onAddRelationship,
  onDuplicate,
  onToggleLifecycle,
  lifecycleState,
  onPurge,
  onEditingChange,
  pending = false,
}: OutlineProps) {
  const { selectedCellId } = state;
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => {
    onEditingChange?.(editingId !== null);
  }, [editingId, onEditingChange]);
  useEffect(() => () => onEditingChange?.(false), [onEditingChange]);
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
  const selectedFieldModule =
    field === undefined
      ? undefined
      : state.modules.find((item) => item.id === field.moduleId);
  // With no departments the search is disabled, so a query left over from
  // before must not keep hiding "Add department".
  const activeQuery = state.departments.length ? structureQuery : "";
  const structureSearch = searchSandboxStructure(state, activeQuery);

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
    const live = lifecycleState?.({ kind, id });
    const closed =
      live?.closed ??
      (state.departments.some((item) => item.id === id && item.closed) ||
        state.modules.some((item) => item.id === id && item.closed) ||
        state.fields.some((item) => item.id === id && item.closed));
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
              disabled={
                pending || Boolean(live?.disabled) || editingId !== null
              }
              onClick={() => void onToggleLifecycle({ kind, id })}
            >
              {closed ? "Reopen" : "Close"} {kind}
            </ContextMenuItem>
          ) : null}
          {live?.canPurge && onPurge ? (
            <ContextMenuItem
              className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
              variant="destructive"
              disabled={pending || live.disabled || editingId !== null}
              onClick={() => void onPurge({ kind, id })}
            >
              Permanently delete {kind}
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
        Add {kind}
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
                <Badge variant="secondary" className="text-xs">
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

  return visible ? (
    <div ref={outlineRef}>
      <Card data-testid="inspector-outline" className="border-0 p-0">
        <div className="flex flex-col gap-3">
          <div>
            <SectionTitle>Structure</SectionTitle>
            <p className="text-muted-foreground mt-1 text-xs">
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
              disabled={state.departments.length === 0}
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
              disabled={state.departments.length === 0}
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
              disabled={state.departments.length === 0}
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
        ) : activeQuery.trim() ? (
          <Empty className="mt-3 items-start gap-1 border p-3 text-left">
            <EmptyHeader className="items-start">
              <EmptyDescription className="text-xs">
                No structure items match.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {!activeQuery.trim() ? addRow("department") : null}
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
            Add relationship
          </Button>
          {state.modules.length < 2 ? (
            <p className="text-muted-foreground px-2 text-xs">
              Add two modules to connect them.
            </p>
          ) : null}
        </div>
      </Card>
    </div>
  ) : null;
}
