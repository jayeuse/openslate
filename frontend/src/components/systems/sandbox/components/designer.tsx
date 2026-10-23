import { useUserPreferences } from "@/components/theme-provider";
import { SANDBOX_SHORTCUTS } from "@/lib/shortcuts";
import { useStableHandlers } from "@/lib/use-stable-handlers";
import {
  memo,
  useCallback,
  useState,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  SandboxBinding,
  SandboxLifecycleBinding,
  SandboxLifecycleOperation,
} from "../state/lifecycle-api";
import {
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Grid3X3,
  LayoutGrid,
  Link2,
  LocateFixed,
  Magnet,
  Maximize2,
  Pencil,
  Plus,
  RotateCcw,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field as FormField,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@/components/ui/native-select";
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SandboxCanvas,
  type SandboxCanvasApi,
  type SandboxDropKind,
} from "@/components/sandbox/sandbox-canvas";
import { SandboxInspector } from "@/components/sandbox/sandbox-inspector";
import { revealOutlineRow } from "@/components/sandbox/sandbox-inspector-outline";
import {
  canvasBoxes,
  canvasOverlaps,
  deriveFlowNodes,
} from "@/components/sandbox/sandbox-flow-model";
import { SANDBOX_ZOOM } from "@/lib/sandbox/canvas-geometry";
import type { TestTraceStep } from "../domain/test-run-summary";
import type { SandboxDesignTarget as SandboxInspectorTarget } from "../domain/model";
import { arrangedLayout, resetLayout } from "../helpers/designer-layout";
import { duplicateDesignTarget } from "../helpers/designer-duplication";
import {
  compatibleRelationshipMappings,
  deletionImpact,
  fieldDeletionNeedsReview,
  deletionTargetName,
  mappingFieldReference,
  plural,
  pruneRelationshipMappingsForFields,
  relationshipMappingCountForFields,
} from "../helpers/designer-impacts";
import { buildField, FieldRow, FieldSettings } from "./designer-field-settings";
import { RelationshipList, type RelationshipRow } from "./relationship-list";
import { DesignerSummary } from "./designer-summary";
import {
  SandboxDialogHeader,
  sandboxDialogContentClass,
} from "./sandbox-dialog-frame";
import { LifecycleActions, ModuleSettings } from "./designer-properties";
import {
  buildAttentionItems,
  propertiesAdvancedSummary,
  type BuildAttentionIssue,
  type BuildAttentionItem,
} from "../domain/build-summary";
import { AdvancedSection } from "@/components/ui/advanced-section";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { DepartmentMark } from "@/components/sandbox/department-mark";
import type {
  SandboxCanvasLayout,
  SandboxFieldType,
  SandboxState,
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
  fieldTypeLabel,
  canonicalFieldType,
  compactDefaultLayout,
  RELATIONSHIP_KINDS,
  relationshipKind,
  reorder,
  uid,
  type Design,
  type DesignUpdate,
  type FieldTypeName,
  type RelationshipFieldMapping,
} from "../domain/model";
import { SANDBOX_LIMITS } from "../domain/validation";
import type { SandboxValidationIssue } from "../domain/validation-types";
import {
  SandboxCommandError,
  type SandboxCommandResult,
} from "../state/commands";
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

/** Module choices, grouped by department once the design has more than one. */
function GroupedModuleOptions({ design }: { design: Design }) {
  const option = (item: Design["modules"][number]) => (
    <NativeSelectOption key={item.id} value={item.id}>
      {item.name}
    </NativeSelectOption>
  );
  if (design.departments.length < 2) return design.modules.map(option);
  const departmentIds = new Set(design.departments.map((item) => item.id));
  return (
    <>
      {design.departments.map((department) => {
        const modules = design.modules.filter(
          (item) => item.department === department.id,
        );
        return modules.length ? (
          <NativeSelectOptGroup key={department.id} label={department.name}>
            {modules.map(option)}
          </NativeSelectOptGroup>
        ) : null;
      })}
      {design.modules
        .filter((item) => !departmentIds.has(item.department))
        .map(option)}
    </>
  );
}

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

// The Structure outline renders a row for every field, the slowest part of a
// Designer render (about 135 ms for the Harbor sample in the dev build). The
// Designer gives it deferred inputs and stable handlers, so a canvas drop or a
// save never waits for it: React updates it in the background instead.
const StructureOutline = memo(SandboxInspector);

/**
 * True only after `active` has stayed true for `delay` ms, so a fast save does
 * not flash every outline control disabled and back.
 */
function useDelayedFlag(active: boolean, delay: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [active, delay]);
  return shown;
}

// The canvas reports zoom on every wheel step. Only the zoom controls read it,
// so it lives in this small store instead of Designer state: a zoom step then
// re-renders the controls, not the whole designer.
type CanvasZoomStore = {
  get: () => number;
  set: (zoom: number) => void;
  subscribe: (listener: () => void) => () => void;
};

function createCanvasZoomStore(): CanvasZoomStore {
  let zoom = 1;
  const listeners = new Set<() => void>();
  return {
    get: () => zoom,
    set: (next) => {
      if (next === zoom) return;
      zoom = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function CanvasZoomControls({
  zoomStore,
  graphRef,
}: {
  zoomStore: CanvasZoomStore;
  graphRef: RefObject<SandboxCanvasApi | null>;
}) {
  const zoom = useSyncExternalStore(
    zoomStore.subscribe,
    zoomStore.get,
    zoomStore.get,
  );
  const atMinZoom = zoom <= SANDBOX_ZOOM.min + 0.001;
  const atMaxZoom = zoom >= SANDBOX_ZOOM.max - 0.001;
  return (
    <>
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
        {Math.round(zoom * 100)}%
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
    </>
  );
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
  notifyError,
  notifyUndoable,
  onStartFromTemplate,
  pending,
  bindings,
  purgeEnabled,
  onLifecycle,
  onDraftStateChange,
  attention,
  phoneHistory,
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
  /** A done notice (toast). */
  notify: (s: string) => void;
  /** An error notice for a failure with no control to show it beside. */
  notifyError: (s: string) => void;
  /** A done notice whose Undo undoes the last design change. */
  notifyUndoable: (s: string) => void;
  onStartFromTemplate: () => void;
  pending: boolean;
  bindings: readonly SandboxBinding[] | null;
  purgeEnabled: boolean;
  onLifecycle: (
    binding: SandboxLifecycleBinding,
    operation: SandboxLifecycleOperation,
  ) => Promise<SandboxCommandResult<Design>>;
  onDraftStateChange: (dirty: boolean) => void;
  /** What Properties lists as needing attention with nothing selected. */
  attention: {
    /** The draft has changes to publish. */
    unpublished: boolean;
    /** Review & Publish, as the header button offers it. */
    review: { reason: string | null; disabled: boolean; open: () => void };
    /** Publish blockers, worded with the action that opens each. */
    issues: readonly BuildAttentionIssue[];
    onOpenIssue: (issue: SandboxValidationIssue) => void;
    /** Opens Triggers filtered to the triggers that are off. */
    onShowOffTriggers: () => void;
  };
  /** Undo and Redo, which sit in the canvas toolbar below 768px (S13). */
  phoneHistory?: ReactNode;
}) {
  const { keyboardShortcuts, disabled: preferencesDisabled } =
    useUserPreferences();
  const shortcutsEnabled = keyboardShortcuts === true && !preferencesDisabled;
  const [viewPreferences, setViewPreferences] =
    useState<SandboxViewPreferences>(loadSandboxViewPreferences);
  // Narrow screens open on the canvas, the Sandbox's main surface.
  const [pane, setPane] = useState<DesignerPane>(
    inspectOnOpen ? "Inspector" : "Canvas",
  );
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(() => new Set());
  const [outlineEditing, setOutlineEditing] = useState(false);
  const reportFieldDraft = useCallback((id: string, dirty: boolean) => {
    setDirtyFields((current) => {
      if (current.has(id) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const [wide, setWide] = useState(false);
  // Wide screens show one workbench beside the canvas. It opens on
  // Properties: the selected item, or with nothing selected, the summary.
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>("Inspector");
  function showPane(next: DesignerPane): void {
    setPane(next);
    if (next !== "Canvas") setWorkbenchTab(next);
  }
  const workbenchPanelRef = useRef<PanelImperativeHandle>(null);
  const structureRef = useRef<HTMLElement>(null);
  const panelGroupElementRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<SandboxCanvasApi | null>(null);
  const canvasFrameRef = useRef<HTMLDivElement>(null);
  const [canvasView, setCanvasView] = useState({
    gridVisible: viewPreferences.gridVisible,
    snapEnabled: viewPreferences.snapEnabled,
  });
  const [zoomStore] = useState(createCanvasZoomStore);
  const [canvasHelpOpen, setCanvasHelpOpen] = useState(false);
  const [canvasAction, setCanvasAction] = useState("Canvas ready.");
  // A visible note on the canvas: what a pinned trace shows, or that Fit
  // could not show the whole design.
  const [canvasNotice, setCanvasNotice] = useState<"trace" | "partial" | null>(
    traceTargetId ? "trace" : null,
  );
  async function autoArrange(): Promise<void> {
    const result = await change((previous) => ({
      ...previous,
      layout: arrangedLayout(previous),
    }));
    if (!result.ok) {
      notifyError(result.error);
      return;
    }
    setCanvasAction("Canvas automatically arranged.");
  }
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
  const deleteTargetState = deleteTarget;
  const requestDeleteRef = useRef<(target: SandboxInspectorTarget) => void>(
    () => {},
  );
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
  /**
   * A pick in Structure brings its item into view on the canvas beside it: a
   * field shows its module, a relationship its source module. One already
   * in view stays where it is.
   */
  function revealOnCanvas(id: string) {
    if (!wide) return;
    const nodeId =
      projectedField(design, id)?.moduleId ??
      design.relationships.find((item) => item.id === id)?.source ??
      id;
    requestAnimationFrame(() => graphRef.current?.reveal(nodeId));
  }
  const [selected, setSelected] = useState(initialSelected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  // Structure follows the selection (F8). A canvas selection switches the
  // workbench to Properties, so the tree, kept mounted out of sight, scrolls
  // to the item when Structure shows again.
  const structureShown = wide
    ? workbenchTab === "Structure" && !viewPreferences.workbenchCollapsed
    : pane === "Structure";
  useEffect(() => {
    if (!structureShown) return;
    const frame = requestAnimationFrame(() =>
      revealOutlineRow(structureRef.current, selectedRef.current),
    );
    return () => cancelAnimationFrame(frame);
  }, [structureShown]);
  const [editor, setEditor] = useState("");
  const localDraftDirty =
    dirtyFields.size > 0 || outlineEditing || editor !== "";
  useEffect(() => {
    onDraftStateChange(dirtyFields.size > 0 || outlineEditing);
  }, [dirtyFields, outlineEditing, onDraftStateChange]);
  useEffect(() => () => onDraftStateChange(false), [onDraftStateChange]);
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
  const [deleteError, setDeleteError] = useState("");
  const [titleFieldError, setTitleFieldError] = useState<{
    moduleId: string;
    message: string;
  } | null>(null);
  const [moveError, setMoveError] = useState<{
    moduleId: string;
    message: string;
  } | null>(null);
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
  // The canvas re-syncs its whole graph (about 100 ms for the Harbor sample)
  // whenever this object changes, so it changes only when its content does:
  // not for a layout-only save or the server's copy of the same design.
  const projectedJson = useMemo(
    () => JSON.stringify(projectDesign(design, selected)),
    [design, selected],
  );
  const projected = useMemo(
    () => JSON.parse(projectedJson) as SandboxState,
    [projectedJson],
  );
  // Frames or tables that cover each other in the saved layout, as the
  // canvas draws it. Dismiss holds until the layout changes.
  const layout = design.layout ?? compactDefaultLayout;
  const layoutKey = JSON.stringify(layout);
  const overlapping = useMemo(() => {
    const overlaps = canvasOverlaps(
      canvasBoxes(
        deriveFlowNodes({
          state: JSON.parse(projectedJson) as SandboxState,
          previous: [],
          layout,
        }),
      ),
    );
    return overlaps.departments.length > 0 || overlaps.modules.length > 0;
  }, [layout, projectedJson]);
  const [overlapDismissedFor, setOverlapDismissedFor] = useState<string | null>(
    null,
  );
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
        pending ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableShortcutTarget(event.target) ||
        document.querySelector('[role="dialog"], [role="alertdialog"]')
      )
        return;
      if (event.key === SANDBOX_SHORTCUTS.help.key && shortcutsEnabled) {
        event.preventDefault();
        setCanvasHelpOpen(true);
        setPane("Canvas");
      } else if (event.key === SANDBOX_SHORTCUTS.fit.key && shortcutsEnabled) {
        event.preventDefault();
        setPane("Canvas");
        requestAnimationFrame(fitCanvas);
      } else if (
        event.key === SANDBOX_SHORTCUTS.remove.key &&
        shortcutsEnabled &&
        keyboardTarget
      ) {
        event.preventDefault();
        requestDeleteRef.current(keyboardTarget);
      }
    }
    window.addEventListener("keydown", handleDesignerShortcut);
    return () => window.removeEventListener("keydown", handleDesignerShortcut);
  }, [keyboardTarget, shortcutsEnabled, pending]);

  function requestDelete(
    target: SandboxInspectorTarget,
    opener?: HTMLElement | null,
  ): void {
    deleteFallbackId.current = null;
    const activeElement =
      opener ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
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
    setDeleteError("");
    setDeleteTarget(target);
  }

  // The Delete shortcut, registered above, reaches the current handler.
  useEffect(() => {
    requestDeleteRef.current = requestDelete;
  });

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
    notifyUndoable(
      `${target.kind.charAt(0).toUpperCase()}${target.kind.slice(1)} duplicated`,
    );
  }

  async function toggleLifecycle(
    target: SandboxInspectorTarget,
  ): Promise<SandboxCommandResult<Design>> {
    if (pending || bindings === null)
      return {
        ok: false,
        error: "Wait for live state to load before changing this item.",
      };
    const binding = bindingFor(target);
    if (binding) {
      if (localDraftDirty)
        return {
          ok: false,
          error: "Save or cancel your edits before changing live state.",
        };
      return onLifecycle(binding, binding.is_deleted ? "reopen" : "close");
    }
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
    if (!result.ok) notifyError(result.error);
    return result;
  }
  // The Structure outline reads lifecycle state from its deferred inputs; every
  // other caller reads the current ones.
  const currentLifecycleInputs = {
    design,
    bindings,
    pending,
    draftDirty: localDraftDirty,
  };
  function bindingFor(
    target: SandboxInspectorTarget,
    inputs = currentLifecycleInputs,
  ): SandboxLifecycleBinding | undefined {
    const kind = target.kind === "link" ? "relationship" : target.kind;
    const field =
      target.kind === "field"
        ? projectedField(inputs.design, target.id)
        : undefined;
    const id = field?.field.id ?? target.id;
    const parent = field?.moduleId ?? null;
    const binding = inputs.bindings?.find(
      (item) =>
        item.kind === kind &&
        item.sandbox_id === id &&
        item.parent_sandbox_id === parent,
    );
    return binding ? { ...binding, kind } : undefined;
  }
  function lifecycleState(
    target: SandboxInspectorTarget,
    inputs = currentLifecycleInputs,
  ) {
    const binding = bindingFor(target, inputs);
    const draftClosed =
      target.kind === "department"
        ? inputs.design.departments.find((item) => item.id === target.id)
            ?.closed
        : target.kind === "module"
          ? inputs.design.modules.find((item) => item.id === target.id)?.closed
          : projectedField(inputs.design, target.id)?.field.closed;
    return {
      closed: binding?.is_deleted ?? draftClosed ?? false,
      canPurge: purgeEnabled && Boolean(binding?.is_deleted),
      disabled:
        inputs.pending ||
        inputs.bindings === null ||
        Boolean(binding && inputs.draftDirty),
    };
  }
  async function purgeLifecycle(
    target: SandboxInspectorTarget,
  ): Promise<SandboxCommandResult<Design>> {
    const binding = bindingFor(target);
    if (
      !lifecycleState(target).canPurge ||
      lifecycleState(target).disabled ||
      !binding
    )
      return {
        ok: false,
        error:
          "Load the closed live item and save or cancel your edits before reviewing permanent deletion.",
      };
    return onLifecycle(binding, "purge");
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
    if (!result.ok) notifyError(result.error);
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
    if (!result.ok) notifyError(result.error);
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
    setMoveError(result.ok ? null : { moduleId: id, message: result.error });
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
      notifyError(result.error);
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
  /**
   * Deletes the target under review, or `requested` at once when it needs
   * no review (S26). A failed immediate delete opens the review with its
   * error, so it can be retried.
   */
  async function removeSelected(
    requested?: SandboxInspectorTarget,
  ): Promise<void> {
    const deleteTarget = requested ?? deleteTargetState;
    if (!deleteTarget) return;
    if (pending) return;
    const deletedKindLabel =
      deleteTarget.kind === "link"
        ? "Relationship"
        : `${deleteTarget.kind.charAt(0).toUpperCase()}${deleteTarget.kind.slice(1)}`;
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
      setDeleteError(result.error);
      if (requested) setDeleteTarget(requested);
      return;
    }
    setDeleteTarget(null);
    setSelected(nextFallbackId.current || fallbackId || "");
    notifyUndoable(
      removedMappings.current > 0
        ? `${removedFieldName.current} deleted · ${plural(removedMappings.current, "linked field")} removed`
        : `${deletedKindLabel} deleted`,
    );
    // The delete button went with its field; focus lands as the review's
    // close would put it.
    if (requested) requestAnimationFrame(() => deleteFinalFocus()?.focus());
  }
  /**
   * A field that no trigger or linked field uses deletes at once, with Undo,
   * as a trigger does (D5, S26); anything else, or a live field, opens the
   * review first.
   */
  function deleteOrReview(
    target: SandboxInspectorTarget,
    opener?: HTMLElement | null,
  ): void {
    if (
      target.kind === "field" &&
      !bindingFor(target) &&
      !fieldDeletionNeedsReview(design, target.id)
    ) {
      deleteOpener.current = null;
      void removeSelected(target);
      return;
    }
    requestDelete(target, opener);
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
  const shownTitleFieldError =
    titleFieldError && titleFieldError.moduleId === selectedModule?.id
      ? titleFieldError.message
      : "";
  const shownMoveError =
    moveError && moveError.moduleId === selectedModule?.id
      ? moveError.message
      : "";
  const designIsEmpty =
    design.departments.length === 0 && design.modules.length === 0;
  const currentDeleteImpact = deletionImpact(
    design,
    deleteTarget,
    Boolean(deleteTarget && bindingFor(deleteTarget)),
  );
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
      // The new item shows in place (inline feedback).
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
      // The new item shows in place (inline feedback).
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
      // The new item shows in place (inline feedback).
      return;
    }
    if (editor === "field" && selectedModule) {
      const fieldType = (canonicalFieldType(type) ?? "Text") as FieldTypeName;
      const selectOptions =
        fieldType === "Select"
          ? options
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean)
              .map((label) => ({ id: crypto.randomUUID(), label }))
          : undefined;
      const requestedDefault = value.trim();
      const defaultValue =
        fieldType === "Select" && requestedDefault
          ? (selectOptions?.find((option) => option.label === requestedDefault)
              ?.id ?? requestedDefault)
          : value;
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
          type: fieldType,
          required,
          defaultValue,
          options,
          selectOptions,
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
      // The new item shows in place (inline feedback).
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
            "Each linked field must pair two open fields of a matching type, once.",
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
      // The new item shows in place (inline feedback).
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
  const departmentOf = (moduleId: string) => {
    const departmentId = design.modules.find(
      (item) => item.id === moduleId,
    )?.department;
    return design.departments.find((item) => item.id === departmentId);
  };
  const sourceDepartment = departmentOf(source);
  const targetDepartment = departmentOf(target);
  const crossDepartment =
    sourceDepartment !== undefined &&
    targetDepartment !== undefined &&
    sourceDepartment.id !== targetDepartment.id;
  const editorForm = (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {editor === "relationship" ? null : (
        <h3 className="font-semibold">
          {editor === "rename" ? "Rename item" : `Create ${editor}`}
        </h3>
      )}
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
                    {fieldTypeLabel(entry.name)}
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
                  Choices (comma separated)
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
                <GroupedModuleOptions design={design} />
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
                aria-describedby={
                  crossDepartment ? "sandbox-editor-departments" : undefined
                }
                value={target}
                onChange={(e) => changeRelationshipTarget(e.target.value)}
              >
                <GroupedModuleOptions design={design} />
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
                aria-describedby={
                  relationshipKind(cardinality).hint
                    ? "sandbox-editor-cardinality-hint"
                    : undefined
                }
                value={cardinality}
                onChange={(e) => setCardinality(e.target.value)}
              >
                {RELATIONSHIP_KINDS.map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {relationshipKind(value).label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              {relationshipKind(cardinality).hint ? (
                <p
                  id="sandbox-editor-cardinality-hint"
                  className="text-muted-foreground text-xs"
                >
                  {relationshipKind(cardinality).hint}
                </p>
              ) : null}
            </FormField>
            {fieldMappings.length ? (
              <fieldset className="border-border flex flex-col gap-3 rounded-md border p-3">
                <legend className="px-1 text-sm font-medium">
                  Older linked fields
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
            {crossDepartment ? (
              <Alert id="sandbox-editor-departments" role="note">
                Spans {sourceDepartment.name} and {targetDepartment.name}; only
                people who read both see links.
              </Alert>
            ) : null}
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
      {/* In the Connect modules dialog the buttons are its pinned footer. */}
      <div
        className={cn(
          "flex flex-wrap justify-end gap-2",
          editor === "relationship" &&
            "bg-card sticky -bottom-5 z-10 -mx-5 -mb-5 border-t px-5 pt-3 pb-4",
        )}
      >
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => {
            setEditor("");
            setEditorError("");
          }}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          pending={pending}
          pendingLabel={
            editor === "rename" || editingRelationship ? "Saving…" : "Creating…"
          }
        >
          {editor === "rename"
            ? "Save name"
            : editingRelationship
              ? "Save relationship"
              : `Create ${editor}`}
        </Button>
      </div>
    </form>
  );
  // The outline's inputs change only when what it shows changes. A layout-only
  // save keeps the same projection; a save shows as busy only after 300 ms; and
  // while bindings reload, the outline keeps the last loaded ones (its handlers
  // still check the current bindings and refuse until they load).
  const outlineDesign = useDeferredValue(design);
  const outlinePending = useDelayedFlag(pending, 300);
  const outlineDraftDirty = useDeferredValue(localDraftDirty);
  const [outlineBindings, setOutlineBindings] = useState(bindings);
  if (bindings !== null && bindings !== outlineBindings)
    setOutlineBindings(bindings);
  const outlineStateJson = useMemo(
    () => JSON.stringify(projectDesign(outlineDesign, selected)),
    [outlineDesign, selected],
  );
  const outlineState = useMemo(
    () => JSON.parse(outlineStateJson) as SandboxState,
    [outlineStateJson],
  );
  const outlineBindingsJson = useMemo(
    () => JSON.stringify(outlineBindings),
    [outlineBindings],
  );
  // Equal projection JSON means equal closed flags and the same canvas id to
  // module and field mapping; equal bindings JSON means equal lookups. So these
  // keys, not object identity, decide when the lifecycle state changes.
  const outlineLifecycleState = useCallback(
    (target: SandboxInspectorTarget) =>
      lifecycleState(target, {
        design: outlineDesign,
        bindings: outlineBindings,
        pending: outlinePending,
        draftDirty: outlineDraftDirty,
      }),
    [
      outlineStateJson,
      outlineBindingsJson,
      outlinePending,
      outlineDraftDirty,
      purgeEnabled,
    ],
  );
  const outlineHandlers = useStableHandlers({
    onSelect: (id: string) => {
      selectItem(id);
      revealOnCanvas(id);
    },
    onEdit: (id: string) => {
      selectItem(id);
      const relationship = design.relationships.find((item) => item.id === id);
      if (relationship) editRelationship(id);
      else setEditor("");
    },
    onRenameDepartment: renameDepartment,
    onRenameModule: renameModule,
    onUpdateField: (
      id: string,
      patch: Parameters<typeof updateProjectedField>[2],
    ) =>
      change(
        (previous) => updateProjectedFieldOrThrow(previous, id, patch),
        `sandbox.design.field:${id}`,
      ),
    onDeleteSelected: deleteOrReview,
    onDuplicate: duplicateTarget,
    onToggleLifecycle: toggleLifecycle,
    onPurge: purgeLifecycle,
    onEditingChange: setOutlineEditing,
    onAddDepartment: () => open("department"),
    onAddModule: (id: string) => {
      setSelected(id);
      open("module");
    },
    onAddField: (id: string, fieldType: SandboxFieldType) => {
      setSelected(id);
      open("field");
      setType(fieldTypeNames[fieldType]);
    },
    onAddRelationship: () => {
      setSelected(selectedModule?.id ?? design.modules[0]?.id ?? "");
      open("relationship");
      setTarget(
        design.modules.find(
          (item) => item.id !== (selectedModule?.id ?? design.modules[0]?.id),
        )?.id ?? "",
      );
    },
  });
  const structurePane = (
    <aside
      ref={structureRef}
      tabIndex={-1}
      aria-label="Organization structure"
      className="h-full min-w-0 p-3 [&_section]:w-full [&_section]:min-w-0"
    >
      <StructureOutline
        state={outlineState}
        lifecycleState={outlineLifecycleState}
        pending={outlinePending}
        {...outlineHandlers}
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
  // Why a live-state change is unavailable, when it is.
  const lifecycleReason =
    bindings === null
      ? "Live state is still loading."
      : localDraftDirty
        ? "Save or cancel your edits first."
        : null;
  const inspectedKind: "module" | "department" = selectedModule
    ? "module"
    : "department";
  const inspectedTarget = inspectedItem
    ? { kind: inspectedKind, id: inspectedItem.id }
    : null;
  const inspectedLifecycle = inspectedTarget
    ? lifecycleState(inspectedTarget)
    : null;
  const inspectedDepartmentIndex = Math.max(
    0,
    design.departments.findIndex(
      (item) => item.id === (selectedModule?.department ?? inspectedItem?.id),
    ),
  );
  const relationshipRow = (
    id: string,
    name: string,
    direction: RelationshipRow["direction"],
    otherModule: string,
    cardinality: string,
  ): RelationshipRow => {
    const target = { kind: "link" as const, id };
    const state = lifecycleState(target);
    return {
      id,
      name,
      direction,
      otherModule,
      cardinality,
      closed: state.closed,
      lifecycle: bindingFor(target)
        ? {
            closed: state.closed,
            canPurge: state.canPurge,
            disabled: state.disabled,
          }
        : null,
    };
  };
  const relationshipRows: RelationshipRow[] = selectedModule
    ? [
        ...design.relationships
          .filter((r) => r.source === selectedModule.id)
          .map((r) =>
            relationshipRow(
              r.id,
              r.name,
              "outgoing",
              design.modules.find((m) => m.id === r.target)?.name ??
                "Missing module",
              r.cardinality,
            ),
          ),
        ...design.relationships
          .filter((r) => r.target === selectedModule.id)
          .map((r) =>
            relationshipRow(
              r.id,
              r.name,
              "incoming",
              design.modules.find((m) => m.id === r.source)?.name ??
                "Missing source",
              r.cardinality,
            ),
          ),
      ]
    : [];
  // With nothing selected, Properties summarizes the design (S12).
  const attentionItems = buildAttentionItems({
    design,
    unpublished: attention.unpublished,
    overlapping,
    issues: attention.issues,
  });
  function runAttention(item: BuildAttentionItem): void {
    if (item.kind === "unpublished") attention.review.open();
    else if (item.kind === "triggersOff") attention.onShowOffTriggers();
    else if (item.kind === "overlaps") void autoArrange();
    else if (item.kind === "issue" && item.issue)
      attention.onOpenIssue(item.issue);
    else if (item.kind === "emptyModules" && item.target) {
      // Selected, and brought into view on the canvas.
      const moduleId = item.target;
      setSelected(moduleId);
      showPane("Inspector");
      graphRef.current?.reveal(moduleId);
    }
  }
  async function changeTitleField(
    moduleId: string,
    titleFieldId: string | null,
  ): Promise<void> {
    setTitleFieldError(null);
    const result = await change((previous) => {
      if (!previous.modules.some((item) => item.id === moduleId))
        throw new SandboxCommandError(
          "This module was deleted. Keep the title field setting open and try again.",
        );
      return {
        ...previous,
        modules: previous.modules.map((item) =>
          item.id === moduleId ? { ...item, titleFieldId } : item,
        ),
      };
    }, `sandbox.design.module-title:${moduleId}`);
    if (!result.ok) setTitleFieldError({ moduleId, message: result.error });
  }
  const inspectorPane = (
    <aside
      aria-label="Design inspector"
      className="flex h-full flex-col gap-5 p-5"
    >
      {inspectedItem ? (
        <div className="flex items-start gap-2.5">
          <DepartmentMark
            departmentIndex={inspectedDepartmentIndex}
            className="mt-2.5"
          />
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
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
          <Button
            data-sandbox-inspector-primary
            size="icon"
            variant="ghost"
            className="size-11 shrink-0 xl:size-8"
            disabled={pending}
            onClick={() => open("rename")}
            aria-label={`Rename ${inspectedKind}`}
            title="Rename"
          >
            <Pencil aria-hidden="true" />
          </Button>
        </div>
      ) : editor && editor !== "relationship" ? null : (
        <DesignerSummary
          items={attentionItems}
          review={attention.review}
          pending={pending}
          designIsEmpty={designIsEmpty}
          onAction={runAttention}
          onAddDepartment={() => open("department")}
          onStartFromTemplate={onStartFromTemplate}
        />
      )}
      {editor && editor !== "relationship" ? (
        editorForm
      ) : !inspectedItem || !inspectedTarget || !inspectedLifecycle ? null : (
        <>
          {selectedModule ? (
            <>
              <section
                aria-labelledby="sandbox-fields-heading"
                className="flex flex-col gap-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3
                    id="sandbox-fields-heading"
                    data-slot="section-title"
                    className="text-sm font-semibold"
                  >
                    Fields{" "}
                    <span className="text-muted-foreground font-normal">
                      {selectedModule.fields.length}
                    </span>
                  </h3>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="max-xl:min-h-11"
                    onClick={() => open("field")}
                  >
                    <Plus aria-hidden="true" />
                    Add field
                  </Button>
                </div>
                {selectedModule.fields.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No fields yet.
                  </p>
                ) : (
                  <div className="border-border border-y">
                    {selectedModule.fields.map((f, i) => (
                      <FieldRow
                        key={f.id}
                        field={f}
                        selected={selectedField?.field.id === f.id}
                      >
                        <FieldSettings
                          field={f}
                          index={i}
                          count={selectedModule.fields.length}
                          titleFieldId={selectedModule.titleFieldId ?? null}
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
                              const currentIndex =
                                currentModule.fields.findIndex(
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
                            if (bindings === null)
                              return {
                                ok: false,
                                error:
                                  "Load live state before changing this item.",
                              };
                            const target = {
                              kind: "field" as const,
                              id: canvasFieldId(selectedModule.id, f.id),
                            };
                            if (bindingFor(target))
                              return toggleLifecycle(target);
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
                                  ? `${closedFieldName.current} closed. ${plural(removedMappings.current, "linked field")} removed.`
                                  : `${closedFieldName.current} closed.`,
                              );
                            return result;
                          }}
                          pending={pending}
                          lifecycleReason={lifecycleReason}
                          onDelete={() =>
                            deleteOrReview({
                              kind: "field",
                              id: canvasFieldId(selectedModule.id, f.id),
                            })
                          }
                          lifecycleClosed={
                            lifecycleState({
                              kind: "field",
                              id: canvasFieldId(selectedModule.id, f.id),
                            }).closed
                          }
                          lifecycleDisabled={
                            lifecycleState({
                              kind: "field",
                              id: canvasFieldId(selectedModule.id, f.id),
                            }).disabled
                          }
                          draftId={canvasFieldId(selectedModule.id, f.id)}
                          onDraftStateChange={reportFieldDraft}
                          onPurge={
                            lifecycleState({
                              kind: "field",
                              id: canvasFieldId(selectedModule.id, f.id),
                            }).canPurge
                              ? () =>
                                  purgeLifecycle({
                                    kind: "field",
                                    id: canvasFieldId(selectedModule.id, f.id),
                                  })
                              : undefined
                          }
                          autoFocus={
                            focusTargetId ===
                            canvasFieldId(selectedModule.id, f.id)
                          }
                        />
                      </FieldRow>
                    ))}
                  </div>
                )}
              </section>
              <section
                aria-labelledby="sandbox-relationships-heading"
                className="flex flex-col gap-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3
                    id="sandbox-relationships-heading"
                    data-slot="section-title"
                    className="text-sm font-semibold"
                  >
                    Relationships{" "}
                    <span className="text-muted-foreground font-normal">
                      {relationshipRows.length}
                    </span>
                  </h3>
                  <DisabledReason
                    reason={
                      design.modules.length < 2
                        ? "Add a second module first."
                        : null
                    }
                  >
                    <Button
                      size="sm"
                      variant="ghost"
                      className="max-xl:min-h-11"
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
                      <Link2 aria-hidden="true" />
                      Connect modules
                    </Button>
                  </DisabledReason>
                </div>
                <RelationshipList
                  rows={relationshipRows}
                  pending={pending}
                  onEdit={editRelationship}
                  onToggleLifecycle={(id) =>
                    void toggleLifecycle({ kind: "link", id })
                  }
                  onPurge={(id) => void purgeLifecycle({ kind: "link", id })}
                  onDelete={(id, opener) =>
                    requestDelete({ kind: "link", id }, opener)
                  }
                />
              </section>
            </>
          ) : (
            <section
              aria-labelledby="sandbox-modules-heading"
              className="flex flex-col gap-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <h3
                  id="sandbox-modules-heading"
                  data-slot="section-title"
                  className="text-sm font-semibold"
                >
                  Modules{" "}
                  <span className="text-muted-foreground font-normal">
                    {
                      design.modules.filter(
                        (item) => item.department === inspectedItem.id,
                      ).length
                    }
                  </span>
                </h3>
                <Button
                  size="sm"
                  variant="ghost"
                  className="max-xl:min-h-11"
                  disabled={pending}
                  onClick={() => open("module")}
                >
                  <Plus aria-hidden="true" />
                  Add module
                </Button>
              </div>
            </section>
          )}
          <AdvancedSection
            key={inspectedKind}
            storageKey={`sandbox.${inspectedKind}`}
            summary={propertiesAdvancedSummary(
              inspectedKind,
              {
                closed: inspectedLifecycle.closed,
                canPurge: inspectedLifecycle.canPurge,
              },
              { titleField: Boolean(selectedModule?.titleFieldId) },
            )}
          >
            {selectedModule ? (
              <ModuleSettings
                module={selectedModule}
                departments={design.departments}
                pending={pending}
                moveError={shownMoveError}
                titleFieldError={shownTitleFieldError}
                onMove={(departmentId) =>
                  void moveModule(selectedModule.id, departmentId)
                }
                onTitleField={(fieldId) =>
                  void changeTitleField(selectedModule.id, fieldId)
                }
              />
            ) : null}
            <LifecycleActions
              kind={inspectedKind}
              closed={inspectedLifecycle.closed}
              canPurge={inspectedLifecycle.canPurge}
              disabled={inspectedLifecycle.disabled}
              reason={lifecycleReason}
              bound={Boolean(bindingFor(inspectedTarget))}
              pending={pending}
              onToggle={() => void toggleLifecycle(inspectedTarget)}
              onDelete={() => deleteOrReview(inspectedTarget)}
              onPurge={() => void purgeLifecycle(inspectedTarget)}
            />
          </AdvancedSection>
        </>
      )}
    </aside>
  );
  return (
    <Tabs
      className="gap-3 xl:min-h-0 xl:flex-1"
      value={pane}
      onValueChange={(value) => setPane(value as DesignerPane)}
    >
      <nav
        aria-label="Designer panes"
        className="flex items-center gap-2 xl:hidden"
      >
        <TabsList className="grid min-w-0 flex-1 grid-cols-3">
          {(["Canvas", "Structure", "Inspector"] satisfies DesignerPane[]).map(
            (tab) => (
              <TabsTrigger key={tab} className="min-h-11" value={tab}>
                {tab === "Inspector" ? "Properties" : tab}
              </TabsTrigger>
            ),
          )}
        </TabsList>
        {phoneHistory ? (
          // Below 768px the header has no room for Undo and Redo, so they
          // sit beside the pane tabs, on every pane.
          <div className="flex shrink-0 gap-1 md:hidden">{phoneHistory}</div>
        ) : null}
      </nav>
      <ResponsiveDesignerTabPanel wide={wide} pane={pane}>
        <ResizablePanelGroup
          orientation="horizontal"
          elementRef={panelGroupElementRef}
          className="sandbox-ui border-card-edge bg-card shadow-card overflow-hidden rounded-2xl border max-xl:h-auto xl:min-h-0 xl:flex-1"
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
                  {/* The toolbar takes the slim controls from 1280px (S16);
                      the canvas below keeps its own look. */}
                  <div
                    role="toolbar"
                    aria-label="Canvas view controls"
                    className="slim-ui flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1 md:flex-nowrap md:overflow-x-auto [&>button]:shrink-0"
                  >
                    <CanvasZoomControls
                      zoomStore={zoomStore}
                      graphRef={graphRef}
                    />
                    {/* On a phone, Fit and Auto-arrange show only their
                        icons so View stays on screen; the names stay. */}
                    <Button
                      size="sm"
                      className="min-h-11 max-sm:min-w-11 max-sm:px-0"
                      variant="outline"
                      aria-label="Fit canvas"
                      onClick={fitCanvas}
                    >
                      <Maximize2 aria-hidden="true" />
                      <span className="max-sm:sr-only">Fit</span>
                    </Button>
                    <Button
                      size="sm"
                      className="min-h-11 max-sm:min-w-11 max-sm:px-0"
                      variant="outline"
                      disabled={pending}
                      onClick={() => void autoArrange()}
                    >
                      <LayoutGrid aria-hidden="true" />
                      <span className="max-sm:sr-only">Auto-arrange</span>
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
                        className="slim-ui min-w-52"
                      >
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
                          onClick={() => setCanvasHelpOpen((open) => !open)}
                        >
                          <CircleHelp aria-hidden="true" />
                          {canvasHelpOpen ? "Hide help" : "Canvas help"}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                          <DropdownMenuLabel className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
                            Layout
                          </DropdownMenuLabel>
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
                              graphRef.current?.resetZoom();
                              setCanvasAction("Zoom reset.");
                            }}
                          >
                            <RotateCcw aria-hidden="true" />
                            Reset zoom
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
                            onClick={async () => {
                              const result = await change((previous) => ({
                                ...previous,
                                layout: resetLayout(previous),
                              }));
                              if (!result.ok) {
                                notifyError(result.error);
                                return;
                              }
                              setCanvasAction("Canvas layout reset.");
                            }}
                          >
                            <Undo2 aria-hidden="true" />
                            Reset layout
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
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
                      Structure works fully from the keyboard: arrow keys move,
                      Enter selects, F2 renames.
                    </p>
                    <p className="text-muted-foreground mt-1">
                      {keyboardShortcuts === true
                        ? `Designer shortcuts: press ${SANDBOX_SHORTCUTS.fit.key} to fit the canvas and ${SANDBOX_SHORTCUTS.help.key} for this help. `
                        : keyboardShortcuts === false
                          ? "Convenience shortcuts are off in Appearance. Use the Fit and View buttons. "
                          : "Convenience shortcuts are available once your account preferences load. "}
                      {SANDBOX_SHORTCUTS.remove.key} reviews removal of the
                      selected item. Shortcuts ignore text editing and open
                      dialogs.
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
                ) : overlapping && overlapDismissedFor !== layoutKey ? (
                  <div
                    role="status"
                    className="border-border bg-muted flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-1 text-sm"
                  >
                    <span className="min-w-0">
                      Some departments or modules overlap.
                    </span>
                    <span className="flex flex-wrap gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="min-h-9"
                        disabled={pending}
                        onClick={() => void autoArrange()}
                      >
                        Auto-arrange
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="min-h-9"
                        onClick={() => setOverlapDismissedFor(layoutKey)}
                      >
                        Dismiss
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
                    keyboardShortcutsEnabled={shortcutsEnabled}
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
                    onZoomChange={zoomStore.set}
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
                      if (!result.ok) notifyError(result.error);
                      return result;
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
              // Slim controls for Structure and Properties only: the canvas
              // panel and its toolbar keep their own look.
              className="slim-ui h-full w-full min-w-0"
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
                    {/* Rows revealed at the top clear the pinned title and
                        search (S25). */}
                    <TabsContent
                      value="Structure"
                      keepMounted
                      className="relative min-h-0 flex-1 scroll-pt-24 overflow-y-auto"
                    >
                      {structurePane}
                    </TabsContent>
                    <TabsContent
                      value="Inspector"
                      keepMounted
                      className="relative min-h-0 flex-1 overflow-y-auto"
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
        <DialogContent
          className={`${sandboxDialogContentClass} max-xl:[&_button]:min-h-11 max-xl:[&_button]:min-w-11 max-xl:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 max-xl:[&_select]:min-h-11`}
        >
          <SandboxDialogHeader
            title={
              <DialogTitle>
                {editingRelationship
                  ? "Relationship settings"
                  : "Connect modules"}
              </DialogTitle>
            }
            closeLabel={
              editingRelationship
                ? "Close relationship settings"
                : "Close connect modules"
            }
            closeDisabled={pending}
            onClose={() => {
              setEditor("");
              setEditorError("");
            }}
          />
          {editorForm}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (open || pending) return;
          setDeleteTarget(null);
          setDeleteError("");
        }}
      >
        <AlertDialogContent
          className="slim-ui max-xl:[&_button]:min-h-11 max-xl:[&_button]:min-w-11 max-xl:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 max-xl:[&_select]:min-h-11"
          finalFocus={deleteFinalFocus}
        >
          <AlertDialogTitle>{currentDeleteImpact?.title}</AlertDialogTitle>
          <AlertDialogDescription className="my-4">
            {currentDeleteImpact?.detail}
          </AlertDialogDescription>
          {deleteError ? (
            <Alert role="alert" variant="destructive" className="mb-4">
              {deleteError}
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={pending}
              render={<Button variant="outline" />}
            >
              Cancel
            </AlertDialogCancel>
            <Button
              variant="destructive"
              pending={pending}
              pendingLabel="Deleting…"
              onClick={() => void removeSelected()}
            >
              {currentDeleteImpact?.action ?? "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Tabs>
  );
}
