"use client";

import { useAppShellNavigation } from "@/components/app-shell";
import { useEffect, useRef, useState } from "react";

import { EmptyBuilder } from "@/components/sandbox/sandbox-empty-state";
import {
  SandboxCanvas,
  type SandboxCanvasApi,
  type SandboxDropKind,
} from "@/components/sandbox/sandbox-canvas";
import {
  SandboxInspector,
  type SandboxInspectorTarget,
} from "@/components/sandbox/sandbox-inspector";
import { SandboxShell } from "@/components/sandbox/sandbox-shell";
import { SandboxToolbar } from "@/components/sandbox/sandbox-toolbar";

import { useSandboxFlow } from "@/components/sandbox/use-sandbox-flow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import type { SandboxFieldType } from "@/lib/sandbox/model";
import { canConnect } from "@/lib/sandbox/rules";

interface DeleteTarget {
  kind: "department" | "module" | "field" | "link";
  id: string;
  name: string;
  childSummary: string | null;
}

interface LinkDialogState {
  sourceModuleId: string;
  targetModuleId: string;
  label: string;
}

function editDialogElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="dialog-edit-item"]',
  );
}

function editNameInput(): HTMLElement | null {
  return (
    editDialogElement()?.querySelector<HTMLElement>('input[id$="-name"]') ??
    null
  );
}

/**
 * OpenSlate Sandbox prototype route.
 *
 * Local-only mock state behind `useSandboxFlow`; no API calls, no backend
 * integration. The X6 graph is owned by `SandboxCanvas`; this page only wires
 * domain intents to the flow actions and renders the shell chrome.
 */
export default function SandboxPage() {
  const { openNavigation, mobileNavigationOpen } = useAppShellNavigation();
  const { state, actions, helpers } = useSandboxFlow();
  const canvasRef = useRef<SandboxCanvasApi | null>(null);
  const moduleDropPosition = useRef<{ x: number; y: number } | null>(null);

  const [historyState, setHistoryState] = useState({
    canUndo: false,
    canRedo: false,
  });

  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [addModuleOpen, setAddModuleOpen] = useState(false);
  const [modulePickerDept, setModulePickerDept] = useState<string>("");
  const [addFieldType, setAddFieldType] = useState<SandboxFieldType | null>(
    null,
  );
  const [addFieldModule, setAddFieldModule] = useState<string>("");
  const [linkDialog, setLinkDialog] = useState<LinkDialogState | null>(null);

  function addNewDepartment(): void {
    const id = actions.addDepartment("New Department");
    actions.setSelection(id);
  }

  function addNewModuleIn(departmentId: string): void {
    const id = actions.addModule(departmentId, "New Module");
    actions.setSelection(id);
    if (moduleDropPosition.current !== null) {
      canvasRef.current?.placeNode(id, moduleDropPosition.current);
      moduleDropPosition.current = null;
    }
  }

  function inferredDepartmentId(): string | null {
    const selected = helpers.selectedObject;
    if (selected?.kind === "department") {
      return selected.department.id;
    }
    if (selected?.kind === "module") {
      return selected.module.departmentId;
    }
    if (selected?.kind === "field") {
      return (
        state.modules.find((item) => item.id === selected.field.moduleId)
          ?.departmentId ?? null
      );
    }
    return state.departments.length === 1
      ? (state.departments[0]?.id ?? null)
      : null;
  }

  function handleAddFieldTo(moduleId: string, type: SandboxFieldType): void {
    const id = actions.addField(moduleId, type);
    if (id !== null) {
      actions.setSelection(id);
    }
  }

  function handleCanvasDrop(
    kind: SandboxDropKind,
    parentId: string | null,
    fieldType?: SandboxFieldType,
    position?: { x: number; y: number },
  ): void {
    if (kind === "department") {
      const id = actions.addDepartment("New Department");
      actions.setSelection(id);
      if (position) canvasRef.current?.placeNode(id, position);
      return;
    }
    if (kind === "module") {
      moduleDropPosition.current = position ?? null;
      if (parentId !== null) {
        addNewModuleIn(parentId);
        return;
      }
      const inferredDepartment = inferredDepartmentId();
      if (inferredDepartment !== null) {
        addNewModuleIn(inferredDepartment);
      } else if (state.departments.length > 1) {
        setModulePickerDept(state.departments[0].id);
        setAddModuleOpen(true);
      }
      return;
    }
    // Field drop: parent is a module id.
    const type = fieldType ?? "text";
    if (parentId !== null) {
      handleAddFieldTo(parentId, type);
      return;
    }
    setAddFieldModule(state.modules[0]?.id ?? "");
    setAddFieldType(type);
  }

  function openLinkDialog(
    sourceModuleId: string,
    targetModuleId: string,
  ): void {
    setLinkDialog({
      sourceModuleId,
      targetModuleId,
      label: "",
    });
  }

  function confirmLinkDialog(): void {
    if (linkDialog === null) {
      return;
    }
    const { sourceModuleId, targetModuleId, label } = linkDialog;
    if (!canConnect(sourceModuleId, targetModuleId, state).ok) {
      return;
    }
    const id = actions.addLink(sourceModuleId, targetModuleId, label);
    if (id !== null) {
      actions.setSelection(id);
    }
    setLinkDialog(null);
  }

  function startRelationshipFromEmpty(): void {
    const first = state.modules[0];
    const second = state.modules[1];
    if (first === undefined || second === undefined) {
      return;
    }
    openLinkDialog(first.id, second.id);
  }

  function openDeleteConfirmation(target: SandboxInspectorTarget): void {
    if (target.kind === "department") {
      const department = state.departments.find(
        (item) => item.id === target.id,
      );
      if (department === undefined) return;
      const moduleIds = department.moduleIds;
      const fieldCount = state.fields.filter((field) =>
        moduleIds.includes(field.moduleId),
      ).length;
      setDeleteTarget({
        kind: "department",
        id: department.id,
        name: department.name,
        childSummary:
          moduleIds.length === 0
            ? null
            : `${moduleIds.length} ${
                moduleIds.length === 1 ? "module" : "modules"
              }${
                fieldCount > 0
                  ? `, ${fieldCount} ${fieldCount === 1 ? "field" : "fields"}`
                  : ""
              }`,
      });
      return;
    }
    if (target.kind === "module") {
      const sandboxModule = state.modules.find((item) => item.id === target.id);
      if (sandboxModule === undefined) return;
      const count = sandboxModule.fieldIds.length;
      setDeleteTarget({
        kind: "module",
        id: sandboxModule.id,
        name: sandboxModule.name,
        childSummary:
          count === 0 ? null : `${count} ${count === 1 ? "field" : "fields"}`,
      });
      return;
    }
    if (target.kind === "field") {
      const field = state.fields.find((item) => item.id === target.id);
      if (field === undefined) return;
      setDeleteTarget({
        kind: "field",
        id: field.id,
        name: field.name,
        childSummary: null,
      });
      return;
    }
    const link = state.links.find((item) => item.id === target.id);
    if (link === undefined) return;
    setDeleteTarget({
      kind: "link",
      id: link.id,
      name: link.label,
      childSummary: null,
    });
  }

  function confirmDelete(): void {
    if (deleteTarget === null) {
      return;
    }
    if (deleteTarget.kind === "department") {
      actions.deleteDepartment(deleteTarget.id);
    } else if (deleteTarget.kind === "module") {
      actions.deleteModule(deleteTarget.id);
    } else if (deleteTarget.kind === "field") {
      actions.deleteField(deleteTarget.id);
    } else {
      actions.deleteLink(deleteTarget.id);
    }
    actions.setSelection(null);
    setDeleteTarget(null);
  }

  // Undo/redo state is polled from the imperative X6 history — cheap and
  // avoids leaking history events into React state.
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const api = canvasRef.current;
      if (api === null) {
        return;
      }
      setHistoryState((previous) => {
        const next = { canUndo: api.canUndo(), canRedo: api.canRedo() };
        return previous.canUndo === next.canUndo &&
          previous.canRedo === next.canRedo
          ? previous
          : next;
      });
    }, 400);
    return () => window.clearInterval(intervalId);
  }, []);

  // Standard shortcuts: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      const tag =
        event.target instanceof HTMLElement ? event.target.tagName : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return;
      }
      if (event.key.toLowerCase() !== "z") {
        return;
      }
      const api = canvasRef.current;
      if (api === null) {
        return;
      }
      event.preventDefault();
      if (event.shiftKey) {
        api.redo();
      } else {
        api.undo();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const linkVerdict =
    linkDialog === null
      ? null
      : canConnect(linkDialog.sourceModuleId, linkDialog.targetModuleId, state);

  return (
    <>
      <SandboxShell
        onOpenNavigation={openNavigation}
        mobileNavigationOpen={mobileNavigationOpen}
        structure={
          <SandboxInspector
            mode="outline"
            onEdit={(id) => {
              actions.setSelection(id);
              setEditTargetId(id);
            }}
            onAddRelationship={startRelationshipFromEmpty}
            state={state}
            onRenameDepartment={actions.renameDepartment}
            onRenameModule={actions.renameModule}
            onUpdateField={actions.updateField}
            onUpdateLinkLabel={actions.updateLinkLabel}
            onDeleteSelected={openDeleteConfirmation}
            onAddField={handleAddFieldTo}
            onAddModule={addNewModuleIn}
            onAddDepartment={addNewDepartment}
            onMoveModule={actions.moveModule}
            onSelect={(cellId) => actions.setSelection(cellId)}
          />
        }
        canvas={
          <div className="relative h-full w-full">
            <SandboxCanvas
              state={state}
              graphRef={canvasRef}
              onRenameDepartment={actions.renameDepartment}
              onRenameModule={actions.renameModule}
              onUpdateField={actions.updateField}
              onSelect={(cellId) => actions.setSelection(cellId)}
              onDrop={handleCanvasDrop}
              onConnect={(source, target) => openLinkDialog(source, target)}
              onMove={(nodeId, parentId) => {
                if (parentId !== null) {
                  actions.moveModule(nodeId, parentId);
                }
              }}
            />
            {state.departments.length === 0 ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div>
                  <EmptyBuilder onAddDepartment={addNewDepartment} />
                </div>
              </div>
            ) : null}
          </div>
        }
        toolbar={
          <SandboxToolbar
            onZoomIn={() => canvasRef.current?.zoomIn()}
            onZoomOut={() => canvasRef.current?.zoomOut()}
            onFit={() => canvasRef.current?.fit()}
            onCenter={() => canvasRef.current?.center()}
            onUndo={() => canvasRef.current?.undo()}
            onRedo={() => canvasRef.current?.redo()}
            canUndo={historyState.canUndo}
            canRedo={historyState.canRedo}
          />
        }
      />

      <Dialog
        open={editTargetId !== null}
        onOpenChange={(open) => {
          if (!open) setEditTargetId(null);
        }}
      >
        <DialogContent
          className="sandbox-ui"
          data-testid="dialog-edit-item"
          initialFocus={editNameInput}
        >
          <DialogHeader>
            <DialogTitle>Edit item</DialogTitle>
            <DialogDescription>
              Update the settings for this item.
            </DialogDescription>
          </DialogHeader>
          <SandboxInspector
            mode="properties"
            state={{ ...state, selectedCellId: editTargetId }}
            onRenameDepartment={actions.renameDepartment}
            onRenameModule={actions.renameModule}
            onUpdateField={actions.updateField}
            onUpdateLinkLabel={actions.updateLinkLabel}
            onDeleteSelected={(target) => {
              setEditTargetId(null);
              openDeleteConfirmation(target);
            }}
            onAddField={handleAddFieldTo}
            onAddModule={addNewModuleIn}
            onAddDepartment={addNewDepartment}
            onMoveModule={actions.moveModule}
            onSelect={(cellId) => {
              editDialogElement()?.focus({ preventScroll: true });
              actions.setSelection(cellId);
              setEditTargetId(cellId);
              requestAnimationFrame(() => editNameInput()?.focus());
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTargetId(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={addModuleOpen}
        onOpenChange={(open) => {
          setAddModuleOpen(open);
          if (!open) moduleDropPosition.current = null;
        }}
      >
        <DialogContent className="sandbox-ui" data-testid="dialog-add-module">
          <DialogHeader>
            <DialogTitle>Choose a Department</DialogTitle>
            <DialogDescription>
              Pick the department that should contain the new module.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="module-dept-select">Department</Label>
              <Select
                id="module-dept-select"
                data-testid="dialog-module-dept"
                value={modulePickerDept}
                onValueChange={setModulePickerDept}
              >
                {state.departments.map((department) => (
                  <SelectItem key={department.id} value={department.id}>
                    {department.name}
                  </SelectItem>
                ))}
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  moduleDropPosition.current = null;
                  setAddModuleOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="dialog-add-module-confirm"
                disabled={modulePickerDept === ""}
                onClick={() => {
                  addNewModuleIn(modulePickerDept);
                  setAddModuleOpen(false);
                }}
              >
                Add Module
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={addFieldType !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAddFieldType(null);
          }
        }}
      >
        <DialogContent className="sandbox-ui" data-testid="dialog-add-field">
          <DialogHeader>
            <DialogTitle>Choose a Module</DialogTitle>
            <DialogDescription>
              Pick the module that should receive the new field.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="field-module-select">Module</Label>
              <Select
                id="field-module-select"
                data-testid="dialog-field-module"
                value={addFieldModule}
                onValueChange={setAddFieldModule}
              >
                {state.modules.map((sandboxModule) => (
                  <SelectItem key={sandboxModule.id} value={sandboxModule.id}>
                    {sandboxModule.name}
                  </SelectItem>
                ))}
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAddFieldType(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="dialog-add-field-confirm"
                disabled={addFieldModule === "" || addFieldType === null}
                onClick={() => {
                  if (addFieldType !== null) {
                    handleAddFieldTo(addFieldModule, addFieldType);
                  }
                  setAddFieldType(null);
                }}
              >
                Add Field
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
      >
        <AlertDialogContent
          className="sandbox-ui"
          data-testid="dialog-delete-confirm"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.name ?? "this item"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.childSummary !== null &&
              deleteTarget?.childSummary !== undefined
                ? `This contains ${deleteTarget.childSummary}.`
                : "This removes the item from your sandbox."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="dialog-delete-confirm-button"
              onClick={confirmDelete}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={linkDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setLinkDialog(null);
          }
        }}
      >
        {linkDialog !== null ? (
          <DialogContent className="sandbox-ui" data-testid="dialog-link">
            <DialogHeader>
              <DialogTitle>Relationship</DialogTitle>
              <DialogDescription>
                Connect two modules with a labeled relationship.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="link-source">From</Label>
                <Select
                  id="link-source"
                  data-testid="dialog-link-source"
                  value={linkDialog.sourceModuleId}
                  onValueChange={(value) =>
                    setLinkDialog({ ...linkDialog, sourceModuleId: value })
                  }
                >
                  {state.modules.map((sandboxModule) => (
                    <SelectItem key={sandboxModule.id} value={sandboxModule.id}>
                      {sandboxModule.name}
                    </SelectItem>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="link-target">To</Label>
                <Select
                  id="link-target"
                  data-testid="dialog-link-target"
                  value={linkDialog.targetModuleId}
                  onValueChange={(value) =>
                    setLinkDialog({ ...linkDialog, targetModuleId: value })
                  }
                >
                  {state.modules.map((sandboxModule) => (
                    <SelectItem key={sandboxModule.id} value={sandboxModule.id}>
                      {sandboxModule.name}
                    </SelectItem>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="link-label">Label</Label>
                <Input
                  id="link-label"
                  data-testid="dialog-link-label"
                  value={linkDialog.label}
                  placeholder="e.g. supplied by"
                  onChange={(event) =>
                    setLinkDialog({ ...linkDialog, label: event.target.value })
                  }
                />
              </div>
            </div>
            {linkVerdict !== null && !linkVerdict.ok ? (
              <p role="alert" className="text-destructive text-sm">
                {linkVerdict.reason}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setLinkDialog(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="dialog-link-confirm"
                disabled={linkVerdict?.ok !== true}
                onClick={confirmLinkDialog}
              >
                Add Relationship
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
