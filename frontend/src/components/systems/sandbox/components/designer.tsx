import { useCallback, useState, useEffect, useRef } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Grid3X3,
  Link2,
  LocateFixed,
  Magnet,
  Maximize2,
  Plus,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field as FormField,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SandboxCanvas,
  type SandboxCanvasApi,
  type SandboxCanvasViewState,
  type SandboxDropKind,
} from "@/components/sandbox/sandbox-canvas";
import { SandboxInspector } from "@/components/sandbox/sandbox-inspector";
import { SANDBOX_ZOOM } from "@/lib/sandbox/x6-adapter";
import type { TestTraceStep } from "../domain/test-run-summary";
import type { SandboxDesignTarget as SandboxInspectorTarget } from "../domain/model";
import { arrangedLayout, resetLayout } from "../helpers/designer-layout";
import { duplicateDesignTarget } from "../helpers/designer-duplication";
import {
  compatibleRelationshipMappings,
  deletionImpact,
  deletionTargetName,
  mappingFieldReference,
  plural,
  pruneRelationshipMappingsForFields,
  relationshipMappingCountForFields,
} from "../helpers/designer-impacts";
import {
  buildField,
  FieldDisclosure,
  FieldSettings,
} from "./designer-field-settings";
import type {
  SandboxCanvasLayout,
  SandboxFieldType,
} from "@/lib/sandbox/model";
import {
  canvasFieldId,
  projectDesign,
  projectedField,
  fieldTypeNames,
  updateProjectedField,
} from "../helpers/bridge";

import {
  FIELD_TYPES,
  canonicalFieldType,
  counts,
  compactDefaultLayout,
  reorder,
  uid,
  type Design,
  type DesignUpdate,
  type FieldTypeName,
  type RelationshipFieldMapping,
} from "../domain/model";
import { SANDBOX_LIMITS } from "../domain/validation";
import {
  SandboxCommandError,
  type SandboxCommandResult,
} from "../state/commands";
import type { SandboxCreateRequest } from "./sandbox-controls";
import { EmptyCanvasPanel } from "./empty-canvas-panel";
import {
  SANDBOX_WORKBENCH_MAX_WIDTH,
  SANDBOX_WORKBENCH_MIN_WIDTH,
  loadSandboxViewPreferences,
  saveSandboxViewPreferences,
  type DesignerPane,
  type SandboxViewPreferences,
} from "../helpers/view-preferences";

function ResponsiveDesignerTabPanel({
  wide,
  pane,
  children,
}: {
  wide: boolean;
  pane: DesignerPane;
  children: React.ReactNode;
}) {
  return wide ? (
    <>{children}</>
  ) : (
    <TabsContent value={pane} className="contents">
      {children}
    </TabsContent>
  );
}

type WorkbenchTab = Exclude<DesignerPane, "Canvas">;

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
    ) !== null
  );
}

function updateProjectedFieldOrThrow(
  design: Design,
  id: string,
  patch: Parameters<typeof updateProjectedField>[2],
): Design {
  if (!projectedField(design, id))
    throw new SandboxCommandError(
      "This field was deleted. Keep the field edit open and try again.",
    );
  return updateProjectedField(design, id, patch);
}

export function Designer({
  initialSelected,
  inspectOnOpen,
  focusTargetId,
  traceTargetId,
  traceSteps,
  onBackToTest,
  design,
  change,
  initializeLayout,
  notify,
  onViewPreferenceChange,
  createRequest,
  onCreateRequestHandled,
  onStartFromTemplate,
  pending,
}: {
  initialSelected: string;
  /** A link asked for one item, so narrow screens open on its Properties. */
  inspectOnOpen: boolean;
  focusTargetId: string | null;
  /** "Show on canvas" asked to light this module's connections. */
  traceTargetId: string | null;
  /** The Test run shown on the canvas, as still steps. */
  traceSteps: TestTraceStep[] | null;
  onBackToTest: () => void;
  design: Design;
  change: (
    d: DesignUpdate,
    commandKey?: string,
  ) => Promise<SandboxCommandResult<Design>>;
  initializeLayout: (layout: SandboxCanvasLayout) => void;
  notify: (s: string) => void;
  onViewPreferenceChange: () => void;
  createRequest: SandboxCreateRequest | null;
  onCreateRequestHandled: (id: number) => void;
  onStartFromTemplate: () => void;
  pending: boolean;
}) {
  const [viewPreferences, setViewPreferences] =
    useState<SandboxViewPreferences>(loadSandboxViewPreferences);
  // Narrow screens open on the canvas, the Sandbox's main surface.
  const [pane, setPane] = useState<DesignerPane>(
    inspectOnOpen ? "Inspector" : "Canvas",
  );
  const [wide, setWide] = useState(false);
  // Wide screens show one workbench beside the canvas. A selection opens
  // Properties; an empty design starts on Structure.
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>(
    initialSelected ? "Inspector" : "Structure",
  );
  function showPane(next: DesignerPane): void {
    setPane(next);
    if (next !== "Canvas") setWorkbenchTab(next);
  }
  const workbenchPanelRef = useRef<PanelImperativeHandle>(null);
  const panelGroupElementRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<SandboxCanvasApi | null>(null);
  const canvasFrameRef = useRef<HTMLDivElement>(null);
  const [canvasView, setCanvasView] = useState<SandboxCanvasViewState>({
    zoom: 1,
    gridVisible: viewPreferences.gridVisible,
    snapEnabled: viewPreferences.snapEnabled,
  });
  const [canvasHelpOpen, setCanvasHelpOpen] = useState(false);
  const [canvasAction, setCanvasAction] = useState("Canvas ready.");
  // A visible note on the canvas: what a pinned trace shows, or that Fit
  // could not show the whole design.
  const [canvasNotice, setCanvasNotice] = useState<"trace" | "partial" | null>(
    traceTargetId ? "trace" : null,
  );
  function fitCanvas(): void {
    const fitted = graphRef.current?.fit() ?? true;
    setCanvasAction(
      fitted
        ? "Canvas fitted."
        : `Canvas at ${Math.round(SANDBOX_ZOOM.fitMin * 100)}%. Part of the design is out of view.`,
    );
    setCanvasNotice((current) =>
      current === "trace" ? current : fitted ? null : "partial",
    );
  }
  const pendingMove = useRef<{ id: string; department: string } | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<SandboxInspectorTarget | null>(null);
  const deleteOpener = useRef<HTMLElement | null>(null);
  const deleteFallbackId = useRef<string | null>(null);
  const viewPreferencesRef = useRef(viewPreferences);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1280px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const patchViewPreferences = (
    patch: Partial<SandboxViewPreferences>,
  ): void => {
    const current = viewPreferencesRef.current;
    const unchanged = Object.entries(patch).every(
      ([key, value]) => current[key as keyof SandboxViewPreferences] === value,
    );
    if (unchanged) return;
    const next = { ...current, ...patch };
    onViewPreferenceChange();
    viewPreferencesRef.current = next;
    setViewPreferences(next);
    saveSandboxViewPreferences(next);
  };
  useEffect(() => {
    patchViewPreferences({
      gridVisible: canvasView.gridVisible,
      snapEnabled: canvasView.snapEnabled,
    });
  }, [canvasView.gridVisible, canvasView.snapEnabled]);
  useEffect(() => {
    if (!wide) return;
    const preferences = viewPreferencesRef.current;
    workbenchPanelRef.current?.resize(
      preferences.workbenchCollapsed ? 48 : preferences.workbenchWidth,
    );
  }, [wide, viewPreferences.workbenchCollapsed]);
  const structureSignature = JSON.stringify([
    design.departments.map((item) => item.id),
    design.modules.map((item) => [
      item.id,
      item.department,
      item.fields.map((field) => field.id),
    ]),
  ]);
  const initializeLayoutRef = useRef(initializeLayout);
  const initializedStructureRef = useRef<string | null>(null);
  useEffect(() => {
    initializeLayoutRef.current = initializeLayout;
  }, [initializeLayout]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (
        graphRef.current &&
        initializedStructureRef.current !== structureSignature
      ) {
        initializedStructureRef.current = structureSignature;
        initializeLayoutRef.current(graphRef.current.getLayout());
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [structureSignature]);
  // The canvas opens on the selected item's department, so the canvas and
  // Properties describe the same thing.
  const selectedRef = useRef(initialSelected);
  const [traceStep, setTraceStep] = useState(0);
  // Field marks for the shown Test step, keyed by canvas field id.
  const traceMarks =
    traceTargetId && traceSteps?.[traceStep]
      ? Object.fromEntries(
          Object.entries(traceSteps[traceStep].marks).map(([id, mark]) => [
            canvasFieldId(traceTargetId, id),
            mark,
          ]),
        )
      : null;
  const traceMarksRef = useRef(traceMarks);
  useEffect(() => {
    traceMarksRef.current = traceMarks;
  });
  const startCanvas = useCallback(() => {
    const focusId = selectedRef.current;
    const trace = traceTargetId !== null && traceTargetId === focusId;
    graphRef.current?.start({ focusId, trace });
    if (trace) graphRef.current?.markFields(traceMarksRef.current);
  }, [traceTargetId]);
  useEffect(() => {
    if (traceSteps) graphRef.current?.markFields(traceMarksRef.current);
  }, [traceStep, traceSteps]);
  useEffect(() => {
    if (wide) return;
    const frame = requestAnimationFrame(() => {
      if (canvasFrameRef.current?.clientWidth) startCanvas();
    });
    return () => cancelAnimationFrame(frame);
  }, [pane, wide, startCanvas]);
  function selectItem(id: string) {
    setSelected(id);
  }
  const [selected, setSelected] = useState(initialSelected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  const [editor, setEditor] = useState("");
  const [editingRelationship, setEditingRelationship] = useState<string | null>(
    null,
  );
  const [name, setName] = useState("");
  const [type, setType] = useState("Text");
  const [required, setRequired] = useState(false);
  const [value, setValue] = useState("");
  const [options, setOptions] = useState("");
  const [target, setTarget] = useState(() => design.modules[1]?.id ?? "");
  const [source, setSource] = useState(() => design.modules[0]?.id ?? "");
  const [cardinality, setCardinality] = useState("One-to-many");
  const [fieldMappings, setFieldMappings] = useState<
    RelationshipFieldMapping[]
  >([]);
  const [relationshipError, setRelationshipError] = useState("");
  const [editorError, setEditorError] = useState("");
  const handledCreateRequest = useRef<number | null>(null);
  const handledFocusTarget = useRef<string | null>(null);
  const selectedField = projectedField(design, selected);
  const selectedRelationship = design.relationships.find(
    (item) => item.id === selected,
  );
  const selectedModule = design.modules.find(
    (m) =>
      m.id ===
      (selectedField?.moduleId ?? selectedRelationship?.source ?? selected),
  );
  useEffect(() => {
    if (!focusTargetId || handledFocusTarget.current === focusTargetId) return;
    handledFocusTarget.current = focusTargetId;
    showPane("Inspector");
    const relationship = design.relationships.find(
      (item) => item.id === focusTargetId,
    );
    if (relationship) {
      setSelected(relationship.id);
      setEditor("relationship");
      setEditingRelationship(relationship.id);
      setName(relationship.name);
      setSource(relationship.source);
      setTarget(relationship.target);
      setCardinality(relationship.cardinality);
      setFieldMappings(relationship.fieldMappings);
      setRelationshipError("");
      setEditorError("");
      return;
    }
    if (
      design.modules.some((item) => item.id === focusTargetId) ||
      design.departments.some((item) => item.id === focusTargetId)
    )
      setSelected(focusTargetId);
  }, [design, focusTargetId]);
  useEffect(() => {
    if (!focusTargetId || pane !== "Inspector") return;
    const focusedField = projectedField(design, focusTargetId);
    const frame = requestAnimationFrame(() => {
      if (focusedField) {
        const fieldName = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            "input[data-sandbox-field-name]",
          ),
        ).find(
          (input) =>
            input.dataset.sandboxFieldName === focusedField.field.id &&
            input.getClientRects().length > 0,
        );
        fieldName?.focus();
        return;
      }
      if (
        design.modules.some((item) => item.id === focusTargetId) ||
        design.departments.some((item) => item.id === focusTargetId)
      )
        document
          .querySelector<HTMLButtonElement>(
            "button[data-sandbox-inspector-primary]",
          )
          ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [design, focusTargetId, pane]);
  useEffect(() => {
    if (
      !createRequest ||
      createRequest.kind === "trigger-rule" ||
      handledCreateRequest.current === createRequest.id
    )
      return;
    handledCreateRequest.current = createRequest.id;

    const requestedField = projectedField(design, selected);
    const requestedRelationship = design.relationships.find(
      (item) => item.id === selected,
    );
    const currentModule = design.modules.find(
      (item) =>
        item.id ===
        (requestedField?.moduleId ?? requestedRelationship?.source ?? selected),
    );
    const currentDepartment =
      design.departments.find(
        (item) => item.id === (currentModule?.department ?? selected),
      ) ?? design.departments[0];
    const parentModule = currentModule ?? design.modules[0];

    setEditingRelationship(null);
    setName("");
    setType("Text");
    setRequired(false);
    setValue("");
    setOptions("");
    setRelationshipError("");
    setEditorError("");
    setFieldMappings([]);
    showPane("Inspector");

    if (createRequest.kind === "department") {
      setEditor("department");
      onCreateRequestHandled(createRequest.id);
      return;
    }
    if (createRequest.kind === "module") {
      if (currentDepartment) setSelected(currentDepartment.id);
      setEditor("module");
      onCreateRequestHandled(createRequest.id);
      return;
    }
    if (createRequest.kind === "field") {
      if (parentModule) setSelected(parentModule.id);
      setEditor("field");
      onCreateRequestHandled(createRequest.id);
      return;
    }

    const sourceId = parentModule?.id ?? "";
    setSelected(sourceId);
    setSource(sourceId);
    setTarget(design.modules.find((item) => item.id !== sourceId)?.id ?? "");
    setEditor("relationship");
    onCreateRequestHandled(createRequest.id);
  }, [createRequest, design, onCreateRequestHandled, selected]);
  const projected = projectDesign(design, selected);
  const keyboardTarget: SandboxInspectorTarget | null = selectedField
    ? { kind: "field", id: selected }
    : selectedRelationship
      ? { kind: "link", id: selected }
      : design.modules.some((item) => item.id === selected)
        ? { kind: "module", id: selected }
        : design.departments.some((item) => item.id === selected)
          ? { kind: "department", id: selected }
          : null;
  useEffect(() => {
    function handleDesignerShortcut(event: KeyboardEvent): void {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableShortcutTarget(event.target) ||
        document.querySelector('[role="dialog"], [role="alertdialog"]')
      )
        return;
      if (event.key === "?") {
        event.preventDefault();
        setCanvasHelpOpen(true);
        setPane("Canvas");
      } else if (event.key === "0") {
        event.preventDefault();
        setPane("Canvas");
        requestAnimationFrame(fitCanvas);
      } else if (event.key === "Delete" && keyboardTarget) {
        event.preventDefault();
        requestDelete(keyboardTarget);
      }
    }
    window.addEventListener("keydown", handleDesignerShortcut);
    return () => window.removeEventListener("keydown", handleDesignerShortcut);
  }, [keyboardTarget]);

  function requestDelete(target: SandboxInspectorTarget): void {
    deleteFallbackId.current = null;
    const activeElement =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const targetName = deletionTargetName(design, target);
    const stableContextTrigger =
      activeElement?.closest('[role="menuitem"]') && targetName
        ? Array.from(
            document.querySelectorAll<HTMLButtonElement>("button"),
          ).find(
            (button) =>
              button.getAttribute("aria-label") ===
              `Select ${target.kind} ${targetName}`,
          )
        : null;
    deleteOpener.current = stableContextTrigger ?? activeElement;
    setDeleteTarget(target);
  }

  async function duplicateTarget(
    target: SandboxInspectorTarget,
  ): Promise<void> {
    if (pending) return;
    const selectedId = { current: "" };
    const result = await change((current) => {
      const duplicated = duplicateDesignTarget(current, target);
      if (!duplicated) return current;
      selectedId.current = duplicated.selected;
      return duplicated.design;
    });
    if (!result.ok || !selectedId.current) return;
    setSelected(selectedId.current);
    notify(
      `${target.kind.charAt(0).toUpperCase()}${target.kind.slice(1)} duplicated. Undo restores the previous design.`,
    );
  }

  async function toggleLifecycle(
    target: SandboxInspectorTarget,
  ): Promise<void> {
    if (pending) return;
    const result = await change((previous) => {
      if (target.kind === "department")
        return {
          ...previous,
          departments: previous.departments.map((item) =>
            item.id === target.id ? { ...item, closed: !item.closed } : item,
          ),
        };
      if (target.kind === "module")
        return {
          ...previous,
          modules: previous.modules.map((item) =>
            item.id === target.id ? { ...item, closed: !item.closed } : item,
          ),
        };
      if (target.kind === "field") {
        const field = projectedField(previous, target.id);
        return field
          ? {
              ...previous,
              modules: previous.modules.map((item) =>
                item.id === field.moduleId
                  ? {
                      ...item,
                      fields: item.fields.map((entry) =>
                        entry.id === field.field.id
                          ? { ...entry, closed: !entry.closed }
                          : entry,
                      ),
                    }
                  : item,
              ),
            }
          : previous;
      }
      return previous;
    });
    if (!result.ok) notify(result.error);
  }
  async function renameDepartment(
    id: string,
    nextName: string,
  ): Promise<SandboxCommandResult<Design>> {
    const result = await change((previous) => {
      if (!previous.departments.some((item) => item.id === id))
        throw new SandboxCommandError(
          "This department was deleted. Keep the edit open and try again.",
        );
      return {
        ...previous,
        departments: previous.departments.map((item) =>
          item.id === id ? { ...item, name: nextName } : item,
        ),
      };
    }, `sandbox.design.department:${id}`);
    if (!result.ok) notify(result.error);
    return result;
  }
  async function renameModule(
    id: string,
    nextName: string,
  ): Promise<SandboxCommandResult<Design>> {
    const result = await change((previous) => {
      if (!previous.modules.some((item) => item.id === id))
        throw new SandboxCommandError(
          "This module was deleted. Keep the edit open and try again.",
        );
      return {
        ...previous,
        modules: previous.modules.map((item) =>
          item.id === id ? { ...item, name: nextName } : item,
        ),
      };
    }, `sandbox.design.module:${id}`);
    if (!result.ok) notify(result.error);
    return result;
  }
  async function moveModule(
    id: string,
    departmentId: string,
  ): Promise<SandboxCommandResult<Design>> {
    const result = await change((previous) => {
      if (!previous.modules.some((item) => item.id === id))
        throw new SandboxCommandError(
          "This module was deleted. Keep the move open and try again.",
        );
      if (!previous.departments.some((item) => item.id === departmentId))
        throw new SandboxCommandError(
          "This department was deleted. Choose another destination.",
        );
      return {
        ...previous,
        modules: previous.modules.map((item) =>
          item.id === id ? { ...item, department: departmentId } : item,
        ),
      };
    }, `sandbox.design.module-parent:${id}`);
    if (!result.ok) notify(result.error);
    return result;
  }
  async function addFromCanvas(
    kind: SandboxDropKind,
    parentId: string | null,
    fieldType: SandboxFieldType = "text",
    position?: { x: number; y: number },
  ): Promise<void> {
    if (pending) return;
    const id = uid();
    const result = await change((previous) => {
      if (kind === "department")
        return {
          ...previous,
          departments: [
            ...previous.departments,
            { id, name: "New department", closed: false },
          ],
        };
      if (kind === "module" && parentId)
        return {
          ...previous,
          modules: [
            ...previous.modules,
            {
              id,
              department: parentId,
              name: "New module",
              closed: false,
              fields: [],
              x: 0,
              y: 0,
            },
          ],
        };
      if (kind === "field" && parentId)
        return {
          ...previous,
          modules: previous.modules.map((item) =>
            item.id === parentId
              ? {
                  ...item,
                  fields: [
                    ...item.fields,
                    {
                      id,
                      name: `${fieldTypeNames[fieldType]} field`,
                      type: fieldTypeNames[fieldType],
                      required: false,
                      value: "",
                      options: "",
                      closed: false,
                    },
                  ],
                }
              : item,
          ),
        };
      return previous;
    });
    if (!result.ok) {
      notify(result.error);
      return;
    }
    setSelected(
      kind === "field" && parentId ? canvasFieldId(parentId, id) : id,
    );
    if (position && kind !== "field") graphRef.current?.placeNode(id, position);
  }
  function connectModules(sourceId: string, targetId: string) {
    setSelected(sourceId);
    open("relationship");
    setSource(sourceId);
    setTarget(targetId);
  }
  function editRelationship(relationshipId: string) {
    const relationship = design.relationships.find(
      (item) => item.id === relationshipId,
    );
    if (!relationship) return;
    setSelected(relationship.id);
    open("relationship");
    setEditingRelationship(relationship.id);
    setName(relationship.name);
    setSource(relationship.source);
    setTarget(relationship.target);
    setCardinality(relationship.cardinality);
    setFieldMappings(relationship.fieldMappings);
  }
  async function removeSelected(): Promise<void> {
    if (!deleteTarget) return;
    if (pending) return;
    const fallbackId =
      deleteTarget.kind === "module"
        ? design.modules.find((item) => item.id === deleteTarget.id)?.department
        : deleteTarget.kind === "field"
          ? projectedField(design, deleteTarget.id)?.moduleId
          : deleteTarget.kind === "link"
            ? design.relationships.find((item) => item.id === deleteTarget.id)
                ?.source
            : design.departments.find((item) => item.id !== deleteTarget.id)
                ?.id;
    deleteFallbackId.current = fallbackId ?? null;
    deleteOpener.current = null;
    const nextFallbackId = { current: "" };
    const removedMappings = { current: 0 };
    const removedFieldName = { current: "" };
    const result = await change((previous) => {
      const field = projectedField(previous, deleteTarget.id);
      if (deleteTarget.kind === "field" && field) {
        nextFallbackId.current = field.moduleId;
        removedFieldName.current = field.field.name;
        const fieldReferences = new Set([
          mappingFieldReference(field.moduleId, field.field.id),
        ]);
        removedMappings.current = relationshipMappingCountForFields(
          previous.relationships,
          fieldReferences,
        );
        return {
          ...previous,
          modules: previous.modules.map((item) =>
            item.id === field.moduleId
              ? {
                  ...item,
                  fields: item.fields.filter(
                    (entry) => entry.id !== field.field.id,
                  ),
                }
              : item,
          ),
          relationships: pruneRelationshipMappingsForFields(
            previous.relationships,
            fieldReferences,
          ),
        };
      }
      if (deleteTarget.kind === "link") {
        const relationship = previous.relationships.find(
          (item) => item.id === deleteTarget.id,
        );
        nextFallbackId.current = relationship?.source ?? "";
        return {
          ...previous,
          relationships: previous.relationships.filter(
            (item) => item.id !== deleteTarget.id,
          ),
        };
      }
      const removed = new Set(
        previous.modules
          .filter((item) =>
            deleteTarget.kind === "department"
              ? item.department === deleteTarget.id
              : item.id === deleteTarget.id,
          )
          .map((item) => item.id),
      );
      nextFallbackId.current =
        deleteTarget.kind === "department"
          ? (previous.departments.find((item) => item.id !== deleteTarget.id)
              ?.id ?? "")
          : (previous.modules.find((item) => item.id !== deleteTarget.id)?.id ??
            "");
      return {
        ...previous,
        departments: previous.departments.filter(
          (item) =>
            deleteTarget.kind !== "department" || item.id !== deleteTarget.id,
        ),
        modules: previous.modules.filter((item) => !removed.has(item.id)),
        relationships: previous.relationships.filter(
          (item) => !removed.has(item.source) && !removed.has(item.target),
        ),
      };
    });
    if (!result.ok) {
      notify(result.error);
      return;
    }
    setDeleteTarget(null);
    setSelected(nextFallbackId.current || fallbackId || "");
    notify(
      removedMappings.current > 0
        ? `${removedFieldName.current} deleted. ${plural(removedMappings.current, "relationship field mapping")} removed. Undo restores the complete change.`
        : "Item deleted from the design. Undo restores it.",
    );
  }
  function deleteFinalFocus(): HTMLElement | null {
    if (deleteOpener.current?.isConnected) return deleteOpener.current;
    const fallbackId = deleteFallbackId.current;
    if (fallbackId) {
      const outlineTarget = document.querySelector<HTMLElement>(
        `[data-outline-id="${CSS.escape(fallbackId)}"]`,
      );
      if (outlineTarget?.getClientRects().length) return outlineTarget;
    }
    const inspectorTarget = document.querySelector<HTMLElement>(
      "button[data-sandbox-inspector-primary]",
    );
    if (inspectorTarget?.getClientRects().length) return inspectorTarget;
    return document.querySelector<HTMLElement>(
      '[aria-label="Organization structure"]',
    );
  }
  const department =
    design.departments.find(
      (d) => d.id === (selectedModule?.department ?? selected),
    ) ?? design.departments[0];
  // Properties shows only what the user selected; `department` keeps its
  // first-department fallback for creation commands.
  const inspectedItem =
    selectedModule ?? design.departments.find((item) => item.id === selected);
  const designIsEmpty =
    design.departments.length === 0 && design.modules.length === 0;
  const atMinZoom = canvasView.zoom <= SANDBOX_ZOOM.min + 0.001;
  const atMaxZoom = canvasView.zoom >= SANDBOX_ZOOM.max - 0.001;
  const currentDeleteImpact = deletionImpact(design, deleteTarget);
  function open(kind: string) {
    setEditor(kind);
    setEditingRelationship(null);
    showPane("Inspector");
    setName(
      kind === "rename" ? (selectedModule?.name ?? department?.name ?? "") : "",
    );
    setType("Text");
    setRequired(false);
    setValue("");
    setOptions("");
    setRelationshipError("");
    setEditorError("");
    setFieldMappings([]);
    setSource(selectedModule?.id ?? design.modules[0]?.id ?? "");
  }
  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (pending || !name.trim()) return;
    const submittedName = name.trim();
    if (editor === "department") {
      const id = uid();
      const result = await change((current) => ({
        ...current,
        departments: [
          ...current.departments,
          { id, name: submittedName, closed: false },
        ],
      }));
      if (!result.ok) {
        setEditorError(result.error);
        return;
      }
      setSelected(id);
      setEditor("");
      setPane("Structure");
      setWorkbenchTab("Inspector");
      notify(`${submittedName} saved in the design.`);
      return;
    }
    if (editor === "module" && department) {
      const id = uid();
      const departmentId = department.id;
      const result = await change((current) => ({
        ...current,
        modules: [
          ...current.modules,
          {
            id,
            name: submittedName,
            department: departmentId,
            closed: false,
            fields: [],
            x: 0,
            y: 0,
          },
        ],
      }));
      if (!result.ok) {
        setEditorError(result.error);
        return;
      }
      setSelected(id);
      setEditor("");
      setPane("Structure");
      setWorkbenchTab("Inspector");
      notify(`${submittedName} saved in the design.`);
      return;
    }
    if (editor === "rename") {
      const moduleId = selectedModule?.id;
      const departmentId = department?.id;
      const result = await change((current) => {
        if (moduleId) {
          if (!current.modules.some((item) => item.id === moduleId))
            throw new SandboxCommandError(
              "This module was deleted. Refresh the designer and try again.",
            );
          return {
            ...current,
            modules: current.modules.map((item) =>
              item.id === moduleId ? { ...item, name: submittedName } : item,
            ),
          };
        }
        if (
          !departmentId ||
          !current.departments.some((item) => item.id === departmentId)
        )
          throw new SandboxCommandError(
            "This department was deleted. Refresh the designer and try again.",
          );
        return {
          ...current,
          departments: current.departments.map((item) =>
            item.id === departmentId ? { ...item, name: submittedName } : item,
          ),
        };
      });
      if (!result.ok) {
        setEditorError(result.error);
        return;
      }
      setEditor("");
      notify(`${submittedName} saved in the design.`);
      return;
    }
    if (editor === "field" && selectedModule) {
      const result = buildField(
        {
          id: uid(),
          name: "",
          type: "Text",
          required: false,
          value: "",
          options: "",
          closed: false,
        },
        {
          name,
          description: "",
          type: (canonicalFieldType(type) ?? "Text") as FieldTypeName,
          required,
          defaultValue: value,
          options,
          maxLength: "",
          min: "",
          max: "",
          step: "",
          earliest: "",
          latest: "",
          checked: value === "true",
        },
      );
      if (typeof result === "string") {
        setEditorError(result);
        return;
      }
      const moduleId = selectedModule.id;
      const saved = await change((current) => {
        if (!current.modules.some((item) => item.id === moduleId))
          throw new SandboxCommandError(
            "This module was deleted. Keep the field draft open and try again.",
          );
        return {
          ...current,
          modules: current.modules.map((item) =>
            item.id === moduleId
              ? { ...item, fields: [...item.fields, result] }
              : item,
          ),
        };
      });
      if (!saved.ok) {
        setEditorError(saved.error);
        return;
      }
      setEditor("");
      notify(`${submittedName} saved in the design.`);
      return;
    }
    if (editor === "relationship" && source && target) {
      if (source === target) {
        setRelationshipError("Source and target modules must be different.");
        return;
      }
      const relationshipId = editingRelationship;
      const saved = await change((previous) => {
        if (
          !previous.modules.some((item) => item.id === source) ||
          !previous.modules.some((item) => item.id === target)
        )
          throw new SandboxCommandError(
            "Choose existing source and target modules.",
          );
        if (
          previous.relationships.some(
            (item) =>
              item.id !== relationshipId &&
              item.source === source &&
              item.target === target,
          )
        )
          throw new SandboxCommandError(
            "A relationship between these modules already exists.",
          );
        if (
          relationshipId &&
          !previous.relationships.some((item) => item.id === relationshipId)
        )
          throw new SandboxCommandError(
            "This relationship was deleted. Keep the editor open and try again.",
          );
        if (fieldMappings.length > SANDBOX_LIMITS.relationshipMappings)
          throw new SandboxCommandError(
            `A relationship can map up to ${SANDBOX_LIMITS.relationshipMappings} fields.`,
          );
        if (
          compatibleRelationshipMappings(
            previous,
            source,
            target,
            fieldMappings,
          ).length !== fieldMappings.length
        )
          throw new SandboxCommandError(
            "Each field mapping must use open, compatible source and target fields without duplicates.",
          );
        return {
          ...previous,
          relationships: relationshipId
            ? previous.relationships.map((item) =>
                item.id === relationshipId
                  ? {
                      ...item,
                      name: submittedName,
                      source,
                      target,
                      cardinality,
                      fieldMappings,
                    }
                  : item,
              )
            : [
                ...previous.relationships,
                {
                  id: uid(),
                  name: submittedName,
                  source,
                  target,
                  cardinality,
                  fieldMappings,
                },
              ],
        };
      });
      if (!saved.ok) {
        setRelationshipError(saved.error);
        return;
      }
      setEditor("");
      notify(`${submittedName} saved in the design.`);
      return;
    }
  }
  function changeRelationshipSource(nextSource: string): void {
    setSource(nextSource);
    setFieldMappings((current) =>
      compatibleRelationshipMappings(design, nextSource, target, current),
    );
    setRelationshipError("");
  }
  function changeRelationshipTarget(nextTarget: string): void {
    setTarget(nextTarget);
    setFieldMappings((current) =>
      compatibleRelationshipMappings(design, source, nextTarget, current),
    );
    setRelationshipError("");
  }
  const editorNameLabel = `${editor === "rename" ? "Item" : editor.charAt(0).toUpperCase() + editor.slice(1)} name`;
  const editorForm = (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <h3 className="font-semibold">
        {editor === "rename" ? "Rename item" : `Create ${editor}`}
      </h3>
      <FieldGroup className="gap-4">
        <FormField>
          <FieldLabel htmlFor="sandbox-editor-name">
            {editorNameLabel}
          </FieldLabel>
          <Input
            id="sandbox-editor-name"
            autoFocus
            required
            disabled={pending}
            maxLength={80}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setEditorError("");
            }}
          />
        </FormField>
        {editor === "field" && (
          <>
            <FormField>
              <FieldLabel htmlFor="sandbox-editor-field-type">
                Field type
              </FieldLabel>
              <NativeSelect
                id="sandbox-editor-field-type"
                className="w-full [&_select]:min-h-10"
                disabled={pending}
                value={type}
                onChange={(e) => {
                  setType(e.target.value);
                  setEditorError("");
                }}
              >
                {FIELD_TYPES.map((entry) => (
                  <NativeSelectOption key={entry.kind} value={entry.name}>
                    {entry.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormField>
            <FormField>
              <FieldLabel htmlFor="sandbox-editor-default-value">
                Default value
              </FieldLabel>
              <Input
                id="sandbox-editor-default-value"
                disabled={pending}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setEditorError("");
                }}
              />
            </FormField>
            {type === "Select" && (
              <FormField>
                <FieldLabel htmlFor="sandbox-editor-select-options">
                  Select options (comma separated)
                </FieldLabel>
                <Input
                  id="sandbox-editor-select-options"
                  required
                  disabled={pending}
                  value={options}
                  onChange={(e) => {
                    setOptions(e.target.value);
                    setEditorError("");
                  }}
                />
              </FormField>
            )}
            <FormField className="min-h-11 flex-row items-center gap-2 xl:min-h-0">
              <Checkbox
                id="sandbox-editor-required"
                disabled={pending}
                checked={required}
                onCheckedChange={setRequired}
              />
              <FieldLabel htmlFor="sandbox-editor-required">
                Required field
              </FieldLabel>
            </FormField>
          </>
        )}
        {editor === "relationship" && (
          <>
            <FormField>
              <FieldLabel htmlFor="sandbox-editor-source-module">
                Source module
              </FieldLabel>
              <NativeSelect
                id="sandbox-editor-source-module"
                className="w-full [&_select]:min-h-10"
                disabled={pending}
                value={source}
                onChange={(e) => changeRelationshipSource(e.target.value)}
              >
                {design.modules.map((m) => (
                  <NativeSelectOption key={m.id} value={m.id}>
                    {m.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormField>
            <FormField>
              <FieldLabel htmlFor="sandbox-editor-target-module">
                Target module
              </FieldLabel>
              <NativeSelect
                id="sandbox-editor-target-module"
                className="w-full [&_select]:min-h-10"
                disabled={pending}
                value={target}
                onChange={(e) => changeRelationshipTarget(e.target.value)}
              >
                {design.modules.map((m) => (
                  <NativeSelectOption key={m.id} value={m.id}>
                    {m.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormField>
            <FormField>
              <FieldLabel htmlFor="sandbox-editor-cardinality">
                Relationship type
              </FieldLabel>
              <NativeSelect
                id="sandbox-editor-cardinality"
                className="w-full [&_select]:min-h-10"
                disabled={pending}
                value={cardinality}
                onChange={(e) => setCardinality(e.target.value)}
              >
                {[
                  ["One-to-one", "Each item has one match"],
                  ["One-to-many", "One item can have many matches"],
                  ["Many-to-many", "Items can have many matches"],
                ].map(([value, label]) => (
                  <NativeSelectOption key={value} value={value}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormField>
            {fieldMappings.length ? (
              <fieldset className="border-border flex flex-col gap-3 rounded-md border p-3">
                <legend className="px-1 text-sm font-medium">
                  Legacy field mappings
                </legend>
                <Alert variant="warning">
                  These imported mappings are not supported for publishing.
                  Remove each mapping before publishing.
                </Alert>
                {fieldMappings.map((mapping, index) => {
                  const sourceName =
                    design.modules
                      .find((item) => item.id === source)
                      ?.fields.find(
                        (field) => field.id === mapping.sourceFieldId,
                      )?.name ?? "Unavailable field";
                  const targetName =
                    design.modules
                      .find((item) => item.id === target)
                      ?.fields.find(
                        (field) => field.id === mapping.targetFieldId,
                      )?.name ?? "Unavailable field";
                  return (
                    <div
                      key={`${mapping.sourceFieldId}-${mapping.targetFieldId}-${index}`}
                      className="flex min-h-11 items-center justify-between gap-3 text-sm"
                    >
                      <span>
                        {sourceName} to {targetName}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={pending}
                        onClick={() =>
                          setFieldMappings((current) =>
                            current.filter(
                              (_, candidateIndex) => candidateIndex !== index,
                            ),
                          )
                        }
                      >
                        Remove mapping
                      </Button>
                    </div>
                  );
                })}
              </fieldset>
            ) : null}
            {design.modules.find((m) => m.id === target)?.department !==
              design.modules.find((m) => m.id === source)?.department && (
              <Alert role="alert" variant="warning">
                Cross-department relationship: review access for both
                departments. This connection belongs to the current design.
              </Alert>
            )}
            {relationshipError ? (
              <Alert role="alert" variant="destructive">
                {relationshipError}
              </Alert>
            ) : null}
          </>
        )}
        {editorError ? (
          <Alert role="alert" variant="destructive">
            {editorError}
          </Alert>
        ) : null}
      </FieldGroup>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {editor === "rename"
            ? "Save name"
            : editingRelationship
              ? "Save relationship"
              : `Create ${editor}`}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setEditor("");
            setEditorError("");
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
  const structurePane = (
    <aside
      tabIndex={-1}
      aria-label="Organization structure"
      className="h-full min-w-0 p-3 [&_section]:w-full [&_section]:min-w-0"
    >
      <SandboxInspector
        mode="outline"
        state={projected}
        onSelect={selectItem}
        onEdit={(id) => {
          selectItem(id);
          const relationship = design.relationships.find(
            (item) => item.id === id,
          );
          if (relationship) editRelationship(id);
          else setEditor("");
        }}
        onRenameDepartment={renameDepartment}
        onRenameModule={renameModule}
        onUpdateField={(id, patch) =>
          change(
            (previous) => updateProjectedFieldOrThrow(previous, id, patch),
            `sandbox.design.field:${id}`,
          )
        }
        onUpdateLinkLabel={(id, label) =>
          change((previous) => {
            if (!previous.relationships.some((item) => item.id === id))
              throw new SandboxCommandError(
                "This relationship was deleted. Keep the edit open and try again.",
              );
            return {
              ...previous,
              relationships: previous.relationships.map((item) =>
                item.id === id ? { ...item, name: label } : item,
              ),
            };
          }, `sandbox.design.link:${id}`)
        }
        onDeleteSelected={requestDelete}
        onDuplicate={duplicateTarget}
        onToggleLifecycle={toggleLifecycle}
        onAddDepartment={() => open("department")}
        onAddModule={(id) => {
          setSelected(id);
          open("module");
        }}
        onAddField={(id, fieldType) => {
          setSelected(id);
          open("field");
          setType(fieldTypeNames[fieldType]);
        }}
        onMoveModule={moveModule}
        pending={pending}
        onAddRelationship={() => {
          setSelected(selectedModule?.id ?? design.modules[0]?.id ?? "");
          open("relationship");
          setTarget(
            design.modules.find(
              (item) =>
                item.id !== (selectedModule?.id ?? design.modules[0]?.id),
            )?.id ?? "",
          );
        }}
      />
      {selected ? (
        <Button
          className="mt-3 w-full xl:hidden"
          variant="secondary"
          onClick={() => {
            showPane("Inspector");
            requestAnimationFrame(() =>
              document
                .querySelector('[aria-label="Design inspector"]')
                ?.scrollIntoView({ block: "start" }),
            );
          }}
        >
          Inspect selected
        </Button>
      ) : null}
    </aside>
  );
  const inspectorPane = (
    <aside
      aria-label="Design inspector"
      className="flex h-full flex-col gap-5 p-5"
    >
      {inspectedItem ? (
        <div className="flex flex-wrap items-center gap-2">
          <h2
            data-slot="section-title"
            className="text-lg font-semibold break-words"
          >
            {inspectedItem.name}
          </h2>
          <Badge variant="outline">
            {selectedModule ? "Module" : "Department"}
          </Badge>
        </div>
      ) : editor && editor !== "relationship" ? null : (
        <div className="flex flex-col gap-2">
          <h2 data-slot="section-title" className="text-lg font-semibold">
            Nothing selected
          </h2>
          <p className="text-muted-foreground text-sm">
            {design.departments.length === 0
              ? "Start with a department. A department groups the work of one team."
              : "Select a department or module on the canvas or in Structure to see and change its settings."}
          </p>
          <dl className="text-muted-foreground grid gap-1 text-sm">
            <div>
              <dt className="text-foreground inline font-medium">Module: </dt>
              <dd className="inline">
                a list of one kind of record, such as orders or customers.
              </dd>
            </div>
            <div>
              <dt className="text-foreground inline font-medium">
                Relationship:{" "}
              </dt>
              <dd className="inline">
                a line that links records in two modules.
              </dd>
            </div>
            <div>
              <dt className="text-foreground inline font-medium">Handoff: </dt>
              <dd className="inline">
                a dashed line, where work passes to another department.
              </dd>
            </div>
          </dl>
          <Button
            variant="outline"
            className="self-start"
            onClick={() => showPane("Structure")}
          >
            Open Structure
          </Button>
        </div>
      )}
      {editor && editor !== "relationship" ? (
        editorForm
      ) : !inspectedItem ? null : (
        <>
          <ButtonGroup
            aria-label={`${selectedModule ? "Module" : "Department"} actions`}
            orientation={wide ? "horizontal" : "vertical"}
            className="w-full [&>button]:flex-1 [&>button]:px-2"
          >
            <Button
              data-sandbox-inspector-primary
              variant="outline"
              disabled={pending}
              onClick={() => open("rename")}
              aria-label={`Rename ${selectedModule ? "module" : "department"}`}
            >
              Rename
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => open("module")}
            >
              Add module
            </Button>
          </ButtonGroup>
          {/* Closing changes what the live workspace accepts, so it sits
              apart from the editing actions and names what it closes. */}
          <Button
            variant="outline"
            className="w-full justify-start"
            disabled={pending}
            aria-describedby="sandbox-lifecycle-note"
            onClick={async () => {
              if (selectedModule) {
                await toggleLifecycle({
                  kind: "module",
                  id: selectedModule.id,
                });
              } else if (department) {
                await toggleLifecycle({
                  kind: "department",
                  id: department.id,
                });
              }
            }}
          >
            {`${(selectedModule ?? department)?.closed ? "Reopen" : "Close"} ${selectedModule ? "module" : "department"}`}
          </Button>
          <p
            id="sandbox-lifecycle-note"
            className="text-muted-foreground -mt-2 text-xs"
          >
            {(selectedModule ?? department)?.closed
              ? "Reopening lets people add new records again."
              : "Stops new records. Keeps existing data. You can reopen it."}
          </p>
          {selectedModule && (
            <>
              <div className="border-border flex flex-col gap-2 border-t pt-4">
                <FormField>
                  <FieldLabel htmlFor="sandbox-move-module-department">
                    Move module to department
                  </FieldLabel>
                  <NativeSelect
                    id="sandbox-move-module-department"
                    className="w-full [&_select]:min-h-10"
                    value={selectedModule.department}
                    onChange={(event) =>
                      moveModule(selectedModule.id, event.target.value)
                    }
                  >
                    {design.departments.map((item) => (
                      <NativeSelectOption key={item.id} value={item.id}>
                        {item.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </FormField>
              </div>
              <div className="border-border flex flex-col gap-3 border-t pt-4">
                <div className="flex items-center justify-between">
                  <h3
                    data-slot="section-title"
                    className="text-sm font-semibold"
                  >
                    Fields
                  </h3>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => open("field")}
                  >
                    <Plus />
                    Add field
                  </Button>
                </div>
                {selectedModule.fields.map((f, i) => (
                  <FieldDisclosure
                    key={f.id}
                    field={f}
                    selected={selectedField?.field.id === f.id}
                  >
                    <FieldSettings
                      field={f}
                      index={i}
                      count={selectedModule.fields.length}
                      onSave={(nextField) =>
                        change((previous) => {
                          const currentModule = previous.modules.find(
                            (item) => item.id === selectedModule.id,
                          );
                          if (!currentModule)
                            throw new SandboxCommandError(
                              "This module was deleted. Keep the field draft open and try again.",
                            );
                          if (
                            !currentModule.fields.some(
                              (item) => item.id === f.id,
                            )
                          )
                            throw new SandboxCommandError(
                              "This field was deleted. Keep the field draft open and try again.",
                            );
                          return {
                            ...previous,
                            modules: previous.modules.map((item) =>
                              item.id === currentModule.id
                                ? {
                                    ...item,
                                    fields: item.fields.map((entry) =>
                                      entry.id === f.id ? nextField : entry,
                                    ),
                                  }
                                : item,
                            ),
                          };
                        })
                      }
                      onMove={(delta) =>
                        change((previous) => {
                          const currentModule = previous.modules.find(
                            (item) => item.id === selectedModule.id,
                          );
                          if (!currentModule) return previous;
                          const currentIndex = currentModule.fields.findIndex(
                            (item) => item.id === f.id,
                          );
                          if (currentIndex < 0) return previous;
                          return {
                            ...previous,
                            modules: previous.modules.map((item) =>
                              item.id === currentModule.id
                                ? {
                                    ...item,
                                    fields: reorder(
                                      item.fields,
                                      currentIndex,
                                      delta,
                                    ),
                                  }
                                : item,
                            ),
                          };
                        })
                      }
                      onLifecycle={async () => {
                        const removedMappings = { current: 0 };
                        const closedFieldName = { current: "" };
                        const result = await change((previous) => {
                          const currentModule = previous.modules.find(
                            (item) => item.id === selectedModule.id,
                          );
                          if (!currentModule) return previous;
                          const currentField = currentModule.fields.find(
                            (item) => item.id === f.id,
                          );
                          if (!currentField) return previous;
                          const closing = !currentField.closed;
                          const fieldReferences = new Set([
                            mappingFieldReference(
                              currentModule.id,
                              currentField.id,
                            ),
                          ]);
                          if (closing) {
                            closedFieldName.current = currentField.name;
                            removedMappings.current =
                              relationshipMappingCountForFields(
                                previous.relationships,
                                fieldReferences,
                              );
                          }
                          return {
                            ...previous,
                            modules: previous.modules.map((item) =>
                              item.id === currentModule.id
                                ? {
                                    ...item,
                                    fields: item.fields.map((entry) =>
                                      entry.id === f.id
                                        ? {
                                            ...entry,
                                            closed: !entry.closed,
                                          }
                                        : entry,
                                    ),
                                  }
                                : item,
                            ),
                            relationships: closing
                              ? pruneRelationshipMappingsForFields(
                                  previous.relationships,
                                  fieldReferences,
                                )
                              : previous.relationships,
                          };
                        });
                        if (result.ok && closedFieldName.current)
                          notify(
                            removedMappings.current > 0
                              ? `${closedFieldName.current} closed. ${plural(removedMappings.current, "relationship field mapping")} removed.`
                              : `${closedFieldName.current} closed.`,
                          );
                        return result;
                      }}
                      pending={pending}
                      autoFocus={
                        focusTargetId === canvasFieldId(selectedModule.id, f.id)
                      }
                    />
                  </FieldDisclosure>
                ))}
              </div>
              <div className="border-border flex flex-col gap-3 border-t pt-4">
                <h3 data-slot="section-title" className="text-sm font-semibold">
                  Relationships
                </h3>
                <Button
                  variant="outline"
                  onClick={() => {
                    open("relationship");
                    setSource(selectedModule.id);
                    setTarget(
                      design.modules.find((m) => m.id !== selectedModule.id)
                        ?.id ?? "",
                    );
                  }}
                  disabled={design.modules.length < 2}
                >
                  <Link2 />
                  Connect modules
                </Button>
                <h4 className="text-xs font-semibold">Outgoing</h4>
                {design.relationships.filter(
                  (r) => r.source === selectedModule.id,
                ).length === 0 ? (
                  <Empty className="flex-none border py-4">
                    <EmptyHeader>
                      <EmptyTitle>No outgoing relationships</EmptyTitle>
                      <EmptyDescription>
                        Connect this module to another module to add one.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : null}
                {design.relationships
                  .filter((r) => r.source === selectedModule.id)
                  .map((r) => (
                    <div
                      key={r.id}
                      className="border-border rounded-md border p-3 text-xs"
                    >
                      <strong>{r.name}</strong>
                      <p className="text-muted-foreground my-2">
                        {r.cardinality} →{" "}
                        {design.modules.find((m) => m.id === r.target)?.name}
                      </p>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit outgoing relationship ${r.name}`}
                        onClick={() => editRelationship(r.id)}
                      >
                        Edit relationship
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete outgoing relationship ${r.name}`}
                        onClick={() =>
                          requestDelete({ kind: "link", id: r.id })
                        }
                      >
                        Delete relationship
                      </Button>
                    </div>
                  ))}
                <h4 className="text-xs font-semibold">Incoming</h4>
                {design.relationships.filter(
                  (r) => r.target === selectedModule.id,
                ).length === 0 ? (
                  <Empty className="flex-none border py-4">
                    <EmptyHeader>
                      <EmptyTitle>No incoming relationships</EmptyTitle>
                      <EmptyDescription>
                        Other modules have not connected to this module yet.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : null}
                {design.relationships
                  .filter((r) => r.target === selectedModule.id)
                  .map((r) => (
                    <div
                      key={r.id}
                      className="border-border rounded-md border p-3 text-xs"
                    >
                      <strong>{r.name}</strong>
                      <p className="text-muted-foreground mt-2">
                        {design.modules.find((m) => m.id === r.source)?.name ??
                          "Missing source"}{" "}
                        → {r.cardinality}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Edit incoming relationship ${r.name}`}
                          onClick={() => editRelationship(r.id)}
                        >
                          Edit relationship
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Delete incoming relationship ${r.name}`}
                          onClick={() =>
                            requestDelete({ kind: "link", id: r.id })
                          }
                        >
                          Delete relationship
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
            </>
          )}
        </>
      )}
      <p className="sr-only">{counts(design)}</p>
    </aside>
  );
  return (
    <Tabs
      className="gap-3 xl:min-h-0 xl:flex-1"
      value={pane}
      onValueChange={(value) => setPane(value as DesignerPane)}
    >
      <nav aria-label="Designer panes" className="xl:hidden">
        <TabsList className="grid w-full grid-cols-3">
          {(["Canvas", "Structure", "Inspector"] satisfies DesignerPane[]).map(
            (tab) => (
              <TabsTrigger key={tab} className="min-h-11" value={tab}>
                {tab === "Inspector" ? "Properties" : tab}
              </TabsTrigger>
            ),
          )}
        </TabsList>
      </nav>
      <ResponsiveDesignerTabPanel wide={wide} pane={pane}>
        <ResizablePanelGroup
          orientation="horizontal"
          elementRef={panelGroupElementRef}
          className="sandbox-ui border-card-edge bg-card shadow-card overflow-hidden rounded-xl border [--canvas-grid-major:var(--rule-strong)] [--canvas-grid:var(--border)] max-xl:h-auto xl:h-full"
          onLayoutChanged={(layout, meta) => {
            if (
              !meta.isUserInteraction ||
              !wide ||
              viewPreferences.workbenchCollapsed
            )
              return;
            const group = panelGroupElementRef.current;
            if (!group) return;
            const separatorWidth = Array.from(group.children).reduce(
              (total, child) =>
                total +
                (child instanceof HTMLElement && child.dataset.separator
                  ? child.getBoundingClientRect().width
                  : 0),
              0,
            );
            const workbenchWidth =
              ((group.clientWidth - separatorWidth) *
                (layout["sandbox-workbench"] ?? 0)) /
              100;
            if (workbenchWidth)
              patchViewPreferences({
                workbenchWidth: Math.round(workbenchWidth),
              });
          }}
        >
          {(wide || pane === "Canvas") && (
            <ResizablePanel
              key="sandbox-canvas"
              id="sandbox-canvas"
              defaultSize={wide ? undefined : "100%"}
              minSize={wide ? "60%" : 0}
              maxSize="100%"
              disabled={!wide}
              groupResizeBehavior="preserve-relative-size"
              onResize={(size, _id, previousSize) => {
                if (
                  size.inPixels <= 0 ||
                  (previousSize !== undefined && previousSize.inPixels > 0)
                )
                  return;
                requestAnimationFrame(startCanvas);
              }}
              className="h-full w-full min-w-0"
            >
              <div className="border-border flex h-full min-h-0 min-w-0 flex-col xl:border-r">
                <div className="flex flex-nowrap items-center justify-between gap-2 border-b px-4 py-1">
                  <span className="text-muted-foreground hidden text-xs font-medium sm:inline">
                    Design canvas
                  </span>
                  <div
                    role="toolbar"
                    aria-label="Canvas view controls"
                    className="flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-x-auto py-1 [&>button]:shrink-0"
                  >
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Zoom out"
                      aria-disabled={atMinZoom}
                      className="size-11 aria-disabled:opacity-50"
                      onClick={() => {
                        if (!atMinZoom) graphRef.current?.zoomOut();
                      }}
                    >
                      <ZoomOut aria-hidden="true" />
                    </Button>
                    <output
                      role="status"
                      aria-label="Canvas zoom"
                      className="text-muted-foreground min-w-12 shrink-0 text-center text-xs tabular-nums"
                    >
                      {Math.round(canvasView.zoom * 100)}%
                    </output>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Zoom in"
                      aria-disabled={atMaxZoom}
                      className="size-11 aria-disabled:opacity-50"
                      onClick={() => {
                        if (!atMaxZoom) graphRef.current?.zoomIn();
                      }}
                    >
                      <ZoomIn aria-hidden="true" />
                    </Button>
                    <Button
                      size="sm"
                      className="min-h-11"
                      variant="outline"
                      aria-label="Fit canvas"
                      onClick={fitCanvas}
                    >
                      <Maximize2 aria-hidden="true" />
                      Fit
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            size="sm"
                            className="min-h-11"
                            variant="ghost"
                            aria-label="View canvas"
                          />
                        }
                      >
                        View
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        data-sandbox-portal
                        align="end"
                        className="min-w-52"
                      >
                        <DropdownMenuItem
                          className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
                          role="menuitemcheckbox"
                          aria-checked={canvasView.gridVisible}
                          onClick={() =>
                            setCanvasView((current) => ({
                              ...current,
                              gridVisible: !current.gridVisible,
                            }))
                          }
                        >
                          <Grid3X3 aria-hidden="true" />
                          Grid
                          <span className="text-muted-foreground ml-auto text-xs">
                            {canvasView.gridVisible ? "On" : "Off"}
                          </span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
                          role="menuitemcheckbox"
                          aria-checked={canvasView.snapEnabled}
                          onClick={() =>
                            setCanvasView((current) => ({
                              ...current,
                              snapEnabled: !current.snapEnabled,
                            }))
                          }
                        >
                          <Magnet aria-hidden="true" />
                          Snap
                          <span className="text-muted-foreground ml-auto text-xs">
                            {canvasView.snapEnabled ? "On" : "Off"}
                          </span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
                          onClick={() => {
                            graphRef.current?.center();
                            setCanvasAction("Canvas centered.");
                          }}
                        >
                          <LocateFixed aria-hidden="true" />
                          Center canvas
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
                          onClick={() => {
                            graphRef.current?.resetZoom();
                            setCanvasAction("Zoom reset.");
                          }}
                        >
                          <RotateCcw aria-hidden="true" />
                          Reset zoom
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
                          onClick={async () => {
                            const result = await change((previous) => ({
                              ...previous,
                              layout: arrangedLayout(previous),
                            }));
                            if (!result.ok) {
                              notify(result.error);
                              return;
                            }
                            setCanvasAction("Canvas automatically arranged.");
                          }}
                        >
                          Auto-arrange
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
                          onClick={async () => {
                            const result = await change((previous) => ({
                              ...previous,
                              layout: resetLayout(previous),
                            }));
                            if (!result.ok) {
                              notify(result.error);
                              return;
                            }
                            setCanvasAction("Canvas layout reset.");
                          }}
                        >
                          Reset layout
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
                          onClick={() => setCanvasHelpOpen((open) => !open)}
                        >
                          <CircleHelp aria-hidden="true" />
                          {canvasHelpOpen ? "Hide help" : "Canvas help"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                <span
                  role="status"
                  aria-label="Canvas action"
                  className="sr-only"
                >
                  {canvasAction}
                </span>
                {canvasHelpOpen ? (
                  <section
                    id="sandbox-canvas-help"
                    aria-labelledby="sandbox-canvas-help-title"
                    className="bg-muted/40 border-b px-4 py-3 text-xs"
                  >
                    <h3
                      data-slot="section-title"
                      id="sandbox-canvas-help-title"
                      className="font-semibold"
                    >
                      Canvas controls
                    </h3>
                    <p className="text-muted-foreground mt-1">
                      Pan by dragging empty space. Drag modules between
                      departments to reparent them, and drag between
                      relationship ports to connect modules. Hold Ctrl or
                      Command while scrolling to zoom. Hold Alt or Option while
                      dragging to place freely. Select a department or module,
                      then use Arrow keys to move it by the snap grid. Hold Alt,
                      or turn Snap off, for 1-unit moves. Field rows do not
                      move. Use F2 to rename a selected item, and arrow keys on
                      a resize handle to resize it.
                    </p>
                    <p className="text-muted-foreground mt-1">
                      Use the visible Undo and Redo controls for design changes.
                      Use Structure for complete keyboard editing.
                    </p>
                    <p className="text-muted-foreground mt-1">
                      Designer shortcuts: press 0 to fit the canvas, ? for this
                      help, and Delete to review removal of the selected item.
                      Shortcuts are paused while editing or while a dialog is
                      open.
                    </p>
                  </section>
                ) : null}
                {canvasNotice ? (
                  <div className="border-border bg-muted flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-1 text-sm">
                    {canvasNotice === "trace" && traceSteps?.[traceStep] ? (
                      <div className="min-w-0 py-1" aria-live="polite">
                        <p>
                          <span className="font-medium">
                            Test of{" "}
                            {design.modules.find(
                              (item) => item.id === traceTargetId,
                            )?.name ?? "the tested module"}
                          </span>
                          {" · "}Step {traceStep + 1} of {traceSteps.length}:{" "}
                          {traceSteps[traceStep].title}
                        </p>
                        <ul className="text-muted-foreground text-xs">
                          {traceSteps[traceStep].lines.map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          Outlined: the field that started the test. Filled:
                          values the test changed.
                        </p>
                      </div>
                    ) : (
                      <span className="min-w-0">
                        {canvasNotice === "trace"
                          ? `Showing ${design.modules.find((item) => item.id === traceTargetId)?.name ?? "the tested module"} and its links from Test.`
                          : "Part of the design is out of view. Drag the canvas to see the rest."}
                      </span>
                    )}
                    <span className="flex flex-wrap gap-1">
                      {canvasNotice === "trace" && traceSteps ? (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="min-h-9"
                            // aria-disabled keeps keyboard focus on the
                            // button at the first and last step.
                            aria-disabled={traceStep === 0}
                            onClick={() => {
                              if (traceStep > 0) setTraceStep(traceStep - 1);
                            }}
                          >
                            Previous step
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="min-h-9"
                            aria-disabled={traceStep >= traceSteps.length - 1}
                            onClick={() => {
                              if (traceStep < traceSteps.length - 1)
                                setTraceStep(traceStep + 1);
                            }}
                          >
                            Next step
                          </Button>
                        </>
                      ) : null}
                      {canvasNotice === "trace" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="min-h-9"
                          onClick={onBackToTest}
                        >
                          Back to result
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="min-h-9"
                        onClick={() => {
                          if (canvasNotice === "trace")
                            graphRef.current?.clearTrace();
                          setCanvasNotice(null);
                        }}
                      >
                        {canvasNotice === "trace" ? "Clear" : "Dismiss"}
                      </Button>
                    </span>
                  </div>
                ) : null}
                <div
                  ref={canvasFrameRef}
                  data-empty={designIsEmpty || undefined}
                  data-skin="canvas-frame"
                  className="relative h-[420px] overflow-hidden xl:h-auto xl:min-h-0 xl:flex-1 data-empty:[&_.sandbox-minimap]:hidden"
                  aria-label="Module design canvas"
                >
                  {designIsEmpty ? (
                    <EmptyCanvasPanel
                      pending={pending}
                      onStartFromTemplate={onStartFromTemplate}
                      onAddDepartment={() => open("department")}
                    />
                  ) : null}
                  <SandboxCanvas
                    onTraceCleared={() =>
                      setCanvasNotice((current) =>
                        current === "trace" ? null : current,
                      )
                    }
                    state={projected}
                    layout={design.layout ?? compactDefaultLayout}
                    graphRef={graphRef}
                    gridVisible={canvasView.gridVisible}
                    snapEnabled={canvasView.snapEnabled}
                    onViewChange={setCanvasView}
                    onSelect={(id) => {
                      setSelected(id ?? "");
                      if (id) setWorkbenchTab("Inspector");
                    }}
                    onRenameDepartment={renameDepartment}
                    onRenameModule={renameModule}
                    onUpdateField={(id, patch) =>
                      change(
                        (previous) =>
                          updateProjectedFieldOrThrow(previous, id, patch),
                        `sandbox.design.field:${id}`,
                      )
                    }
                    pending={pending}
                    onDrop={addFromCanvas}
                    onConnect={connectModules}
                    onMove={(id, parentId) => {
                      if (parentId)
                        pendingMove.current = { id, department: parentId };
                    }}
                    onLayoutChange={async (layout) => {
                      const moved = pendingMove.current;
                      pendingMove.current = null;
                      const result = await change((previous) => {
                        if (moved) {
                          if (
                            !previous.modules.some(
                              (item) => item.id === moved.id,
                            )
                          )
                            throw new SandboxCommandError(
                              "The moved module was deleted. Refresh the designer and try again.",
                            );
                          if (
                            !previous.departments.some(
                              (item) => item.id === moved.department,
                            )
                          )
                            throw new SandboxCommandError(
                              "The destination department was deleted. Choose another destination.",
                            );
                        }
                        return {
                          ...previous,
                          layout,
                          modules: moved
                            ? previous.modules.map((item) =>
                                item.id === moved.id
                                  ? {
                                      ...item,
                                      department: moved.department,
                                    }
                                  : item,
                              )
                            : previous.modules,
                        };
                      }, "sandbox.design.layout");
                      if (!result.ok) notify(result.error);
                    }}
                  />
                </div>
              </div>
            </ResizablePanel>
          )}
          {wide && (
            <ResizableHandle
              withHandle
              aria-label="Resize workbench"
              disabled={viewPreferences.workbenchCollapsed}
            />
          )}
          {(wide || pane !== "Canvas") && (
            <ResizablePanel
              key="sandbox-workbench"
              id="sandbox-workbench"
              panelRef={workbenchPanelRef}
              defaultSize={wide ? viewPreferences.workbenchWidth : "100%"}
              minSize={
                wide
                  ? viewPreferences.workbenchCollapsed
                    ? 48
                    : SANDBOX_WORKBENCH_MIN_WIDTH
                  : 0
              }
              maxSize={
                wide
                  ? viewPreferences.workbenchCollapsed
                    ? 48
                    : SANDBOX_WORKBENCH_MAX_WIDTH
                  : "100%"
              }
              disabled={!wide || viewPreferences.workbenchCollapsed}
              groupResizeBehavior={
                wide ? "preserve-pixel-size" : "preserve-relative-size"
              }
              className="h-full w-full min-w-0"
            >
              {!wide ? (
                pane === "Structure" ? (
                  structurePane
                ) : (
                  inspectorPane
                )
              ) : viewPreferences.workbenchCollapsed ? (
                <div className="flex h-full min-h-0 items-start justify-center pt-2">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Expand workbench"
                    onClick={() =>
                      patchViewPreferences({ workbenchCollapsed: false })
                    }
                  >
                    <ChevronLeft aria-hidden="true" />
                  </Button>
                </div>
              ) : (
                <aside
                  aria-label="Design workbench"
                  className="flex h-full min-h-0 flex-col"
                >
                  <Tabs
                    value={workbenchTab}
                    onValueChange={(value) =>
                      setWorkbenchTab(value as WorkbenchTab)
                    }
                    className="min-h-0 flex-1 gap-0"
                  >
                    <div className="flex items-center gap-2 border-b px-3 py-2">
                      <TabsList
                        aria-label="Workbench view"
                        className="grid flex-1 grid-cols-2"
                      >
                        <TabsTrigger value="Structure">Structure</TabsTrigger>
                        <TabsTrigger value="Inspector">Properties</TabsTrigger>
                      </TabsList>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Collapse workbench"
                        onClick={() =>
                          patchViewPreferences({ workbenchCollapsed: true })
                        }
                      >
                        <ChevronRight aria-hidden="true" />
                      </Button>
                    </div>
                    <TabsContent
                      value="Structure"
                      keepMounted
                      className="min-h-0 flex-1 overflow-y-auto"
                    >
                      {structurePane}
                    </TabsContent>
                    <TabsContent
                      value="Inspector"
                      keepMounted
                      className="min-h-0 flex-1 overflow-y-auto"
                    >
                      {inspectorPane}
                    </TabsContent>
                  </Tabs>
                </aside>
              )}
            </ResizablePanel>
          )}
        </ResizablePanelGroup>
      </ResponsiveDesignerTabPanel>
      <Dialog
        open={editor === "relationship"}
        onOpenChange={(open) => {
          if (!open && !pending) setEditor("");
        }}
      >
        <DialogContent className="max-xl:[&_button]:min-h-11 max-xl:[&_button]:min-w-11 max-xl:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 max-xl:[&_select]:min-h-11">
          <DialogTitle>
            {editingRelationship ? "Relationship settings" : "Connect modules"}
          </DialogTitle>
          {editorForm}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent
          className="max-xl:[&_button]:min-h-11 max-xl:[&_button]:min-w-11 max-xl:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 max-xl:[&_select]:min-h-11"
          finalFocus={deleteFinalFocus}
        >
          <AlertDialogTitle>{currentDeleteImpact?.title}</AlertDialogTitle>
          <AlertDialogDescription className="my-4">
            {currentDeleteImpact?.detail}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={removeSelected}
            >
              Confirm delete
            </Button>
            <AlertDialogCancel
              disabled={pending}
              render={<Button variant="ghost" />}
            >
              Cancel
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Tabs>
  );
}
