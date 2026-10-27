"use client";

import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  searchSandboxStructure,
  type SandboxFieldType,
  type SandboxState,
} from "@/lib/sandbox/model";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  LocateFixed,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

/**
 * An icon button that says what it does on hover and focus (F13); its
 * accessible name is the same words.
 */
function NamedIconButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 xl:size-9"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Scrolls a tree row into its panel without moving focus, so Structure shows
 * the item selected elsewhere (the canvas, a link). A hidden panel (another
 * workbench tab) has no layout, so the row waits until the panel shows.
 */
export function revealOutlineRow(
  root: HTMLElement | null,
  id: string | null,
): void {
  if (root === null || !id) return;
  const row = root.querySelector<HTMLElement>(
    `[data-outline-id="${CSS.escape(id)}"]`,
  );
  if (row?.getClientRects().length) row.scrollIntoView({ block: "nearest" });
}

/** The tree key of an "Add module" or "Add field" item. */
function addKey(kind: "module" | "field", parentId: string): string {
  return `add:${kind}:${parentId}`;
}

// Hover and selected tint from the look's ink, as in the trigger and
// version lists. Only the selected row is current; its ancestors stay plain.
function selectedClasses(selected: boolean): string {
  return selected
    ? "text-foreground bg-[color-mix(in_oklab,var(--ink)_14%,transparent)]"
    : "text-foreground hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]";
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
  const treeRef = useRef<HTMLUListElement>(null);
  // The tree is one Tab stop (roving tabindex): the item focused last, else
  // the selected item, else the first.
  const [activeKey, setActiveKey] = useState<string | null>(null);

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
  const query = structureSearch.query;
  const departmentOpen = (id: string) =>
    query.length > 0 || !collapsedDepartments.has(id);
  const moduleOpen = (id: string) =>
    query.length > 0 || !collapsedModules.has(id);
  // The visible tree items in screen order, for the tab stop.
  const treeKeys: string[] = [];
  for (const departmentItem of state.departments) {
    const result = structureSearch.departments.get(departmentItem.id);
    if (!result?.matches) continue;
    treeKeys.push(departmentItem.id);
    if (!departmentOpen(departmentItem.id)) continue;
    for (const moduleItem of result.modules) {
      treeKeys.push(moduleItem.id);
      if (!moduleOpen(moduleItem.id)) continue;
      for (const fieldItem of result.fieldsByModule.get(moduleItem.id) ?? [])
        treeKeys.push(fieldItem.id);
      if (!query) treeKeys.push(addKey("field", moduleItem.id));
    }
    if (!query) treeKeys.push(addKey("module", departmentItem.id));
  }
  const tabKey =
    activeKey !== null && treeKeys.includes(activeKey)
      ? activeKey
      : selectedCellId && treeKeys.includes(selectedCellId)
        ? selectedCellId
        : treeKeys[0];

  function toggleOpen(id: string): void {
    const setter = state.departments.some((item) => item.id === id)
      ? setCollapsedDepartments
      : setCollapsedModules;
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function itemName(id: string): string {
    return (
      state.departments.find((item) => item.id === id)?.name ??
      state.modules.find((item) => item.id === id)?.name ??
      state.fields.find((item) => item.id === id)?.name ??
      ""
    );
  }

  /** The WAI-ARIA tree keys: arrows, Home, End, Enter, F2, and type-ahead. */
  function onTreeKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea")) return;
    const item = target.closest<HTMLElement>('[role="treeitem"]');
    const tree = treeRef.current;
    if (!item || !tree) return;
    const items = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const index = items.indexOf(item);
    const level = Number(item.getAttribute("aria-level"));
    const expanded = item.getAttribute("aria-expanded");
    const key = item.dataset.outlineId ?? "";
    const focus = (next: HTMLElement | undefined) => {
      event.preventDefault();
      next?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        return focus(items[index + 1]);
      case "ArrowUp":
        return focus(items[index - 1]);
      case "Home":
        return focus(items[0]);
      case "End":
        return focus(items.at(-1));
      case "ArrowRight":
        if (expanded === "false") {
          event.preventDefault();
          toggleOpen(key);
        } else if (expanded === "true") focus(items[index + 1]);
        return;
      case "ArrowLeft":
        if (expanded === "true") {
          event.preventDefault();
          toggleOpen(key);
          return;
        }
        return focus(
          items
            .slice(0, index)
            .findLast(
              (other) => Number(other.getAttribute("aria-level")) < level,
            ),
        );
      case "Enter":
      case " ":
        event.preventDefault();
        item.click();
        return;
      case "F2":
        if (key.startsWith("add:") || pending) return;
        event.preventDefault();
        beginEdit(key, itemName(key));
        return;
    }
    if (
      event.key.length === 1 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const letter = event.key.toLowerCase();
      const match = [...items.slice(index + 1), ...items.slice(0, index)].find(
        (other) =>
          !other.dataset.outlineId?.startsWith("add:") &&
          (other.getAttribute("aria-label") ?? "")
            .toLowerCase()
            .startsWith(letter),
      );
      if (match) focus(match);
    }
  }

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
              Delete {kind} forever
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

  // Structure follows the selection (F8): an item selected elsewhere opens
  // the branches above it here and scrolls into view. Focus stays where it
  // is, and a branch the person closes again stays closed.
  const followDepartmentId =
    sandboxModule?.departmentId ?? selectedFieldModule?.departmentId ?? null;
  const followModuleId = selectedFieldModule?.id ?? null;
  useEffect(() => {
    if (followDepartmentId)
      setCollapsedDepartments((current) => {
        if (!current.has(followDepartmentId)) return current;
        const next = new Set(current);
        next.delete(followDepartmentId);
        return next;
      });
    if (followModuleId)
      setCollapsedModules((current) => {
        if (!current.has(followModuleId)) return current;
        const next = new Set(current);
        next.delete(followModuleId);
        return next;
      });
    const frame = requestAnimationFrame(() =>
      revealOutlineRow(outlineRef.current, selectedCellId),
    );
    return () => cancelAnimationFrame(frame);
  }, [selectedCellId, followDepartmentId, followModuleId]);

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
    event: DragEvent<HTMLElement>,
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
    if (kind !== "department" && parentId) {
      const key = addKey(kind, parentId);
      const activate = () => {
        if (pending) return;
        if (kind === "module") onAddModule(parentId);
        else onAddField(parentId, "text");
      };
      return (
        <li role="none">
          <div
            role="treeitem"
            aria-level={kind === "module" ? 2 : 3}
            aria-label={`Add ${kind} to ${parentName}`}
            aria-disabled={pending || undefined}
            aria-selected={false}
            tabIndex={key === tabKey ? 0 : -1}
            data-outline-id={key}
            data-kind={kind}
            data-testid={`inspector-outline-add-${kind}`}
            draggable={!pending}
            onDragStart={(event) =>
              dragPayload(event, kind, kind === "field" ? "text" : undefined)
            }
            onClick={activate}
            className="text-muted-foreground hover:text-foreground focus-visible:outline-ring flex min-h-11 w-full cursor-pointer items-center rounded-[var(--radius)] px-2 text-xs outline-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid aria-disabled:cursor-not-allowed aria-disabled:opacity-50 max-xl:pl-5 xl:min-h-9"
          >
            Add {kind}
          </div>
        </li>
      );
    }
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
    tree: { level: number; expanded?: boolean; groupId?: string },
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
                <div
                  role="treeitem"
                  data-testid={`inspector-outline-${kind}-select`}
                  data-outline-id={item.id}
                  aria-level={tree.level}
                  aria-expanded={tree.expanded}
                  aria-owns={tree.expanded ? tree.groupId : undefined}
                  aria-selected={selected}
                  aria-label={item.name}
                  aria-describedby={
                    item.closed ? `outline-closed-${item.id}` : undefined
                  }
                  tabIndex={item.id === tabKey ? 0 : -1}
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
              className={`focus-visible:outline-ring flex min-h-11 w-full min-w-0 cursor-default items-center gap-1 rounded-[var(--radius)] px-2 text-left text-xs outline-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid xl:min-h-9 ${kind === "department" ? "font-semibold" : ""} ${kind === "field" ? "max-xl:pl-5" : ""} ${selectedClasses(selected)}`}
            >
              <span className="min-w-0 flex-1 truncate" title={item.name}>
                {item.name}
              </span>
              {item.closed ? (
                <Badge
                  id={`outline-closed-${item.id}`}
                  variant="secondary"
                  className="text-xs"
                >
                  Closed
                </Badge>
              ) : null}
            </ContextMenuTrigger>
            <ContextMenuContent
              data-sandbox-portal
              className="slim-ui"
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

  /** The chevron is for the pointer; the keyboard uses Right and Left. */
  function chevron(id: string, open: boolean) {
    return (
      <span
        aria-hidden="true"
        className="text-muted-foreground hover:text-foreground flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius)] xl:size-8 [&_svg]:size-4"
        onClick={() => toggleOpen(id)}
      >
        {open ? <ChevronDown /> : <ChevronRight />}
      </span>
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
    const departmentExpanded = departmentOpen(departmentItem.id);
    const departmentGroup = `outline-group-${departmentItem.id}`;
    return (
      <li
        key={departmentItem.id}
        role="none"
        data-testid="inspector-outline-department"
      >
        <div className="flex min-w-0 items-center gap-0.5">
          {chevron(departmentItem.id, departmentExpanded)}
          <div className="min-w-0 flex-1">
            {itemRow(
              "department",
              departmentItem,
              selectedCellId === departmentItem.id,
              {
                level: 1,
                expanded: departmentExpanded,
                groupId: departmentGroup,
              },
            )}
          </div>
        </div>
        {departmentExpanded ? (
          <ul
            id={departmentGroup}
            role="group"
            className="border-border mt-1 ml-6 flex flex-col gap-2 border-l pl-2"
          >
            {departmentModules.map((moduleItem) => {
              const moduleExpanded = moduleOpen(moduleItem.id);
              const visibleFields =
                searchResult.fieldsByModule.get(moduleItem.id) ?? [];
              const moduleGroup = `outline-group-${moduleItem.id}`;
              return (
                <li
                  key={moduleItem.id}
                  role="none"
                  data-testid="inspector-outline-module"
                >
                  <div className="flex min-w-0 items-center gap-0.5">
                    {chevron(moduleItem.id, moduleExpanded)}
                    <div className="min-w-0 flex-1">
                      {itemRow(
                        "module",
                        moduleItem,
                        selectedCellId === moduleItem.id,
                        {
                          level: 2,
                          expanded: moduleExpanded,
                          groupId: moduleGroup,
                        },
                      )}
                    </div>
                  </div>
                  {moduleExpanded ? (
                    <ul
                      id={moduleGroup}
                      role="group"
                      className="sandbox-field-list border-border mt-1 ml-6 flex flex-col gap-1 border-l pl-2"
                    >
                      {visibleFields.map((fieldItem) => (
                        <li
                          key={fieldItem.id}
                          role="none"
                          data-testid="inspector-outline-field"
                        >
                          {itemRow(
                            "field",
                            fieldItem,
                            selectedCellId === fieldItem.id,
                            { level: 3 },
                          )}
                        </li>
                      ))}
                      {!query
                        ? addRow("field", moduleItem.id, moduleItem.name)
                        : null}
                    </ul>
                  ) : null}
                </li>
              );
            })}
            {!query
              ? addRow("module", departmentItem.id, departmentItem.name)
              : null}
          </ul>
        ) : null}
      </li>
    );
  }

  return visible ? (
    <div ref={outlineRef}>
      <Card data-testid="inspector-outline" className="border-0 p-0">
        {/* From 1280px the workbench panel scrolls the tree; the title and
            search stay pinned above it, so following a selection never
            leaves the search half out of view (S25). */}
        <div className="xl:bg-card flex flex-col gap-3 xl:sticky xl:top-0 xl:z-10 xl:-mx-3 xl:-mt-3 xl:px-3 xl:pt-3 xl:pb-2">
          <SectionTitle>Structure</SectionTitle>
          <div className="flex min-w-0 items-center gap-1">
            <div className="relative min-w-0 flex-1">
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
            {/* One toggle: it offers whichever of expand or collapse applies. */}
            {collapsedDepartments.size === 0 && collapsedModules.size === 0 ? (
              <NamedIconButton
                label="Collapse all"
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
                <ChevronsDownUp aria-hidden="true" />
              </NamedIconButton>
            ) : (
              <NamedIconButton
                label="Expand all"
                disabled={state.departments.length === 0}
                onClick={() => {
                  setCollapsedDepartments(new Set());
                  setCollapsedModules(new Set());
                }}
              >
                <ChevronsUpDown aria-hidden="true" />
              </NamedIconButton>
            )}
            {selectedCellId ? (
              <NamedIconButton
                label="Jump to selection"
                onClick={jumpToSelection}
              >
                <LocateFixed aria-hidden="true" />
              </NamedIconButton>
            ) : (
              <DisabledReason reason="Select an item first.">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0 xl:size-9"
                  aria-label="Jump to selection"
                  disabled
                >
                  <LocateFixed aria-hidden="true" />
                </Button>
              </DisabledReason>
            )}
          </div>
        </div>

        {state.departments.length > 0 && structureSearch.hasMatches ? (
          <ul
            ref={treeRef}
            role="tree"
            aria-label="Structure"
            className="mt-3 flex flex-col gap-3"
            onKeyDown={onTreeKeyDown}
            onFocus={(event) => {
              const key = (event.target as HTMLElement).closest<HTMLElement>(
                '[role="treeitem"]',
              )?.dataset.outlineId;
              if (key) setActiveKey(key);
            }}
          >
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
