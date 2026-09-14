import { useState, useEffect, useRef } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
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
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Field as FormField,
  FieldError,
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
import { cn } from "@/lib/utils";
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
  type SandboxCanvasLayout,
  type SandboxCanvasViewState,
  type SandboxDropKind,
} from "@/components/sandbox/sandbox-canvas";
import {
  SandboxInspector,
  type SandboxInspectorTarget,
} from "@/components/sandbox/sandbox-inspector";
import type { SandboxFieldType } from "@/lib/sandbox/model";
import {
  canvasFieldId,
  projectDesign,
  sampleField,
  sampleTypes,
  updateProjectedField,
} from "./bridge";

import {
  FIELD_TYPES,
  canonicalFieldType,
  counts,
  compactDefaultLayout,
  normalizeField,
  normalizeRule,
  reorder,
  uid,
  type Design,
  type DesignUpdate,
  type Field,
  type FieldConfig,
  type FieldTypeName,
} from "./model";
import type { SandboxCreateRequest } from "./sandbox-controls";
import {
  SANDBOX_INSPECTOR_PANEL_MAX_WIDTH,
  SANDBOX_INSPECTOR_PANEL_MIN_WIDTH,
  SANDBOX_STRUCTURE_PANEL_MAX_WIDTH,
  SANDBOX_STRUCTURE_PANEL_MIN_WIDTH,
  loadSandboxViewPreferences,
  saveSandboxViewPreferences,
  type DesignerPane,
  type SandboxViewPreferences,
} from "./view-preferences";

type FieldDraft = {
  name: string;
  description: string;
  type: FieldTypeName;
  required: boolean;
  defaultValue: string;
  options: string;
  maxLength: string;
  min: string;
  max: string;
  step: string;
  earliest: string;
  latest: string;
  checked: boolean;
};

function draftForField(field: Field): FieldDraft {
  const normalized = normalizeField(field);
  const config = normalized.config;
  return {
    name: field.name,
    description: field.description ?? "",
    type: normalized.type as FieldTypeName,
    required: field.required,
    defaultValue:
      config.kind === "checkbox"
        ? ""
        : config.defaultValue === null
          ? ""
          : String(config.defaultValue),
    options: config.kind === "select" ? config.options.join(", ") : "",
    maxLength:
      config.kind === "text" ||
      config.kind === "long-text" ||
      config.kind === "email" ||
      config.kind === "url"
        ? String(config.maxLength ?? "")
        : "",
    min:
      config.kind === "number" || config.kind === "integer"
        ? String(config.min ?? "")
        : "",
    max:
      config.kind === "number" || config.kind === "integer"
        ? String(config.max ?? "")
        : "",
    step:
      config.kind === "number" || config.kind === "integer"
        ? String(config.kind === "integer" ? 1 : (config.step ?? ""))
        : "",
    earliest:
      config.kind === "date" || config.kind === "datetime"
        ? (config.earliest ?? "")
        : "",
    latest:
      config.kind === "date" || config.kind === "datetime"
        ? (config.latest ?? "")
        : "",
    checked: config.kind === "checkbox" ? config.defaultValue : false,
  };
}

function optionalNumber(value: string): number | undefined {
  return value.trim() ? Number(value) : undefined;
}

function validDateInput(value: string, type: "Date" | "Date/Time"): boolean {
  if (!value) return true;
  if (type === "Date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value)
    );
  }
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function alignsWithStep(value: number, step: number, base: number): boolean {
  const steps = (value - base) / step;
  const distance = Math.abs(steps - Math.round(steps));
  const tolerance = Math.min(
    1e-7,
    Number.EPSILON * 32 * Math.max(1, Math.abs(steps)),
  );
  return distance <= tolerance;
}

function buildField(field: Field, draft: FieldDraft): Field | string {
  if (!draft.name.trim()) return "Field name is required.";
  const type = draft.type;
  let config: FieldConfig;
  let value = draft.defaultValue;
  let options = "";
  if (["Text", "Long text", "Email", "URL"].includes(type)) {
    const kind =
      type === "Text"
        ? "text"
        : type === "Long text"
          ? "long-text"
          : (type.toLowerCase() as "email" | "url");
    const maxLength = optionalNumber(draft.maxLength);
    if (
      maxLength !== undefined &&
      (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 1_000)
    )
      return "Maximum length must be a whole number between 1 and 1000.";
    if (draft.defaultValue.length > 1_000)
      return "Default value must be 1000 characters or fewer.";
    if (maxLength !== undefined && draft.defaultValue.length > maxLength)
      return "Default value cannot exceed maximum length.";
    if (
      type === "Email" &&
      draft.defaultValue &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.defaultValue)
    )
      return "Enter a valid email address.";
    if (type === "URL" && draft.defaultValue) {
      try {
        const url = new URL(draft.defaultValue);
        if (url.protocol !== "http:" && url.protocol !== "https:")
          return "Enter a valid HTTP or HTTPS URL.";
      } catch {
        return "Enter a valid HTTP or HTTPS URL.";
      }
    }
    config = { kind, defaultValue: draft.defaultValue, maxLength };
  } else if (type === "Number" || type === "Integer") {
    const kind = type === "Number" ? "number" : "integer";
    const defaultValue = draft.defaultValue.trim()
      ? Number(draft.defaultValue)
      : null;
    const min = optionalNumber(draft.min);
    const max = optionalNumber(draft.max);
    const step = kind === "integer" ? 1 : optionalNumber(draft.step);
    if (
      [defaultValue, min, max, step].some(
        (entry) =>
          entry !== null && entry !== undefined && !Number.isFinite(entry),
      )
    )
      return "Number settings must contain valid numbers.";
    if (
      kind === "integer" &&
      [defaultValue, min, max].some(
        (entry) =>
          entry !== null && entry !== undefined && !Number.isInteger(entry),
      )
    )
      return "Integer settings must use whole numbers.";
    if (min !== undefined && max !== undefined && min > max)
      return "Minimum cannot exceed maximum.";
    if (step !== undefined && step <= 0) return "Step must be positive.";
    if (
      defaultValue !== null &&
      ((min !== undefined && defaultValue < min) ||
        (max !== undefined && defaultValue > max))
    )
      return "Default value must be within the minimum and maximum.";
    if (
      defaultValue !== null &&
      step !== undefined &&
      !alignsWithStep(defaultValue, step, min ?? 0)
    )
      return "Default value must align with the configured step.";
    config = { kind, defaultValue, min, max, step };
  } else if (type === "Date" || type === "Date/Time") {
    const kind = type === "Date" ? "date" : "datetime";
    if (
      !validDateInput(draft.defaultValue, type) ||
      !validDateInput(draft.earliest, type) ||
      !validDateInput(draft.latest, type)
    )
      return `${type} settings must contain valid values.`;
    if (draft.earliest && draft.latest && draft.earliest > draft.latest)
      return "Earliest value cannot be after latest value.";
    if (
      draft.defaultValue &&
      ((draft.earliest && draft.defaultValue < draft.earliest) ||
        (draft.latest && draft.defaultValue > draft.latest))
    )
      return "Default value must be within the earliest and latest limits.";
    config = {
      kind,
      defaultValue: draft.defaultValue || null,
      earliest: draft.earliest || undefined,
      latest: draft.latest || undefined,
    };
  } else if (type === "Checkbox") {
    config = { kind: "checkbox", defaultValue: draft.checked };
    value = String(draft.checked);
  } else {
    const rawOptions = draft.options
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (new Set(rawOptions).size !== rawOptions.length)
      return "Select options must be unique.";
    if (rawOptions.length === 0) return "Add at least one select option.";
    if (rawOptions.length > 100)
      return "Select fields support up to 100 options.";
    if (rawOptions.some((option) => option.length > 100))
      return "Each select option must be 100 characters or fewer.";
    const defaultValue = draft.defaultValue.trim();
    if (defaultValue && !rawOptions.includes(defaultValue))
      return "Default value must match a select option.";
    config = {
      kind: "select",
      defaultValue: defaultValue || null,
      options: rawOptions,
    };
    value = defaultValue;
    options = rawOptions.join(", ");
  }
  return {
    ...field,
    name: draft.name.trim(),
    description: draft.description,
    type,
    required: draft.required,
    value,
    options,
    config,
  };
}

function FieldSettings({
  field,
  index,
  count,
  onSave,
  onMove,
  onLifecycle,
  autoFocus = false,
}: {
  field: Field;
  index: number;
  count: number;
  onSave: (field: Field) => void;
  onMove: (delta: number) => void;
  onLifecycle: () => void;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(() => draftForField(field));
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(draftForField(field));
    setError("");
  }, [field]);
  const update = <K extends keyof FieldDraft>(key: K, value: FieldDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setError("");
  };
  const prefix = field.name;
  const controlId = (suffix: string) => `sandbox-field-${field.id}-${suffix}`;
  return (
    <FieldGroup className="mt-3 gap-3">
      <FormField>
        <FieldLabel htmlFor={controlId("name")}>{prefix} name</FieldLabel>
        <Input
          id={controlId("name")}
          autoFocus={autoFocus}
          data-sandbox-field-name={field.id}
          value={draft.name}
          maxLength={80}
          onChange={(event) => update("name", event.target.value)}
        />
      </FormField>
      <FormField>
        <FieldLabel htmlFor={controlId("description")}>
          {prefix} description
        </FieldLabel>
        <Input
          id={controlId("description")}
          value={draft.description}
          maxLength={1000}
          onChange={(event) => update("description", event.target.value)}
        />
      </FormField>
      <FormField>
        <FieldLabel htmlFor={controlId("type")}>{prefix} field type</FieldLabel>
        <NativeSelect
          id={controlId("type")}
          className="w-full [&_select]:min-h-10"
          value={draft.type}
          onChange={(event) =>
            update("type", event.target.value as FieldTypeName)
          }
        >
          {FIELD_TYPES.map((entry) => (
            <NativeSelectOption key={entry.kind} value={entry.name}>
              {entry.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </FormField>
      {draft.type === "Checkbox" ? (
        <FormField className="min-h-11 flex-row items-center gap-2 xl:min-h-0">
          <Checkbox
            id={controlId("default-checked")}
            checked={draft.checked}
            onCheckedChange={(checked) => update("checked", checked)}
          />
          <FieldLabel htmlFor={controlId("default-checked")}>
            {prefix} default checked
          </FieldLabel>
        </FormField>
      ) : (
        <FormField>
          <FieldLabel htmlFor={controlId("default-value")}>
            {prefix} default value
          </FieldLabel>
          <Input
            id={controlId("default-value")}
            type={
              draft.type === "Date"
                ? "date"
                : draft.type === "Date/Time"
                  ? "datetime-local"
                  : draft.type === "Number" || draft.type === "Integer"
                    ? "number"
                    : "text"
            }
            value={draft.defaultValue}
            onChange={(event) => update("defaultValue", event.target.value)}
          />
        </FormField>
      )}
      {["Text", "Long text", "Email", "URL"].includes(draft.type) ? (
        <FormField>
          <FieldLabel htmlFor={controlId("maximum-length")}>
            {prefix} maximum length
          </FieldLabel>
          <Input
            id={controlId("maximum-length")}
            type="number"
            min="1"
            value={draft.maxLength}
            onChange={(event) => update("maxLength", event.target.value)}
          />
        </FormField>
      ) : null}
      {draft.type === "Number" || draft.type === "Integer" ? (
        <FieldGroup className="grid grid-cols-2 gap-2">
          <FormField>
            <FieldLabel htmlFor={controlId("minimum")}>
              {prefix} minimum
            </FieldLabel>
            <Input
              id={controlId("minimum")}
              type="number"
              value={draft.min}
              onChange={(event) => update("min", event.target.value)}
            />
          </FormField>
          <FormField>
            <FieldLabel htmlFor={controlId("maximum")}>
              {prefix} maximum
            </FieldLabel>
            <Input
              id={controlId("maximum")}
              type="number"
              value={draft.max}
              onChange={(event) => update("max", event.target.value)}
            />
          </FormField>
          <FormField data-disabled={draft.type === "Integer" || undefined}>
            <FieldLabel htmlFor={controlId("step")}>{prefix} step</FieldLabel>
            <Input
              id={controlId("step")}
              type="number"
              value={draft.type === "Integer" ? "1" : draft.step}
              disabled={draft.type === "Integer"}
              onChange={(event) => update("step", event.target.value)}
            />
          </FormField>
        </FieldGroup>
      ) : null}
      {draft.type === "Date" || draft.type === "Date/Time" ? (
        <FieldGroup className="grid grid-cols-2 gap-2">
          <FormField>
            <FieldLabel htmlFor={controlId("earliest")}>
              {prefix} earliest
            </FieldLabel>
            <Input
              id={controlId("earliest")}
              type={draft.type === "Date" ? "date" : "datetime-local"}
              value={draft.earliest}
              onChange={(event) => update("earliest", event.target.value)}
            />
          </FormField>
          <FormField>
            <FieldLabel htmlFor={controlId("latest")}>
              {prefix} latest
            </FieldLabel>
            <Input
              id={controlId("latest")}
              type={draft.type === "Date" ? "date" : "datetime-local"}
              value={draft.latest}
              onChange={(event) => update("latest", event.target.value)}
            />
          </FormField>
        </FieldGroup>
      ) : null}
      {draft.type === "Select" ? (
        <FormField>
          <FieldLabel htmlFor={controlId("options")}>
            {prefix} options
          </FieldLabel>
          <Input
            id={controlId("options")}
            value={draft.options}
            onChange={(event) => update("options", event.target.value)}
          />
        </FormField>
      ) : null}
      <FormField className="min-h-11 flex-row items-center gap-2 xl:min-h-0">
        <Checkbox
          id={controlId("required")}
          checked={draft.required}
          onCheckedChange={(checked) => update("required", checked)}
        />
        <FieldLabel htmlFor={controlId("required")}>Required</FieldLabel>
      </FormField>
      <FormField data-invalid={Boolean(error) || undefined}>
        <FieldError className="text-xs">{error}</FieldError>
      </FormField>
      <ButtonGroup
        aria-label={`${field.name} field actions`}
        className="w-full flex-wrap justify-between"
      >
        <ButtonGroup aria-label={`${field.name} save actions`}>
          <Button
            size="sm"
            onClick={() => {
              const result = buildField(field, draft);
              if (typeof result === "string") setError(result);
              else onSave(result);
            }}
          >
            Save field changes
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDraft(draftForField(field));
              setError("");
            }}
          >
            Cancel
          </Button>
        </ButtonGroup>
        <ButtonGroup
          aria-label={`${field.name} ordering and lifecycle actions`}
        >
          <Button
            size="icon"
            variant="outline"
            aria-label={`Move ${field.name} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button
            size="icon"
            variant="outline"
            aria-label={`Move ${field.name} down`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown aria-hidden="true" />
          </Button>
          <Button variant="outline" size="sm" onClick={onLifecycle}>
            {field.closed ? "Reopen" : "Close"} field
          </Button>
        </ButtonGroup>
      </ButtonGroup>
    </FieldGroup>
  );
}

function FieldDisclosure({
  field,
  selected,
  children,
}: {
  field: Field;
  selected: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(selected);

  useEffect(() => {
    if (selected) setOpen(true);
  }, [selected]);

  return (
    <Collapsible className="group" open={open} onOpenChange={setOpen}>
      <Card aria-label={`${field.name} field settings`} className="w-full">
        <CardHeader className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 p-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-sm">{field.name}</CardTitle>
            <CardDescription className="mt-1">
              <Badge variant={field.closed ? "outline" : "secondary"}>
                {field.closed ? "Closed" : field.type}
              </Badge>
            </CardDescription>
          </div>
          <CollapsibleTrigger
            aria-label={`${open ? "Hide" : "Show"} ${field.name} settings`}
            render={<Button size="icon" variant="ghost" />}
          >
            <ChevronDown
              aria-hidden="true"
              className="transition-transform group-data-open:rotate-180 motion-reduce:transition-none"
            />
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="border-t p-3">{children}</CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

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

function arrangedLayout(design: Design): SandboxCanvasLayout {
  const current = design.layout ?? compactDefaultLayout;
  const layout: SandboxCanvasLayout = {};
  let departmentY = 24;
  for (const department of design.departments) {
    const modules = design.modules.filter(
      (item) => item.department === department.id,
    );
    const rowHeights: number[] = [];
    modules.forEach((moduleItem, index) => {
      const row = Math.floor(index / 2);
      rowHeights[row] = Math.max(
        rowHeights[row] ?? 0,
        current[moduleItem.id]?.height ?? 176,
      );
    });
    const rowOffsets = rowHeights.map((_, row) =>
      rowHeights
        .slice(0, row)
        .reduce((total, height) => total + height + 28, 0),
    );
    const departmentHeight = Math.max(
      176,
      76 +
        rowHeights.reduce((total, height) => total + height, 0) +
        Math.max(0, rowHeights.length - 1) * 28,
    );
    layout[department.id] = {
      x: 24,
      y: departmentY,
      width: 680,
      height: departmentHeight,
    };
    modules.forEach((moduleItem, index) => {
      const existing = current[moduleItem.id];
      layout[moduleItem.id] = {
        x: 48 + (index % 2) * 328,
        y: departmentY + 48 + rowOffsets[Math.floor(index / 2)],
        width: existing?.width ?? 304,
        height: existing?.height ?? 176,
      };
    });
    departmentY += departmentHeight + 32;
  }
  return layout;
}

function resetLayout(design: Design): SandboxCanvasLayout {
  const arranged = arrangedLayout(design);
  return Object.fromEntries(
    Object.keys(arranged).map((id) => [
      id,
      compactDefaultLayout[id] ?? arranged[id],
    ]),
  );
}

function copiedName(name: string, existingNames: readonly string[]): string {
  const names = new Set(existingNames);
  const first = `${name} Copy`;
  if (!names.has(first)) return first;
  let number = 2;
  while (names.has(`${name} Copy ${number}`)) number += 1;
  return `${name} Copy ${number}`;
}

function nextId(usedIds: Set<string>): string {
  let id = uid();
  while (usedIds.has(id)) id = uid();
  usedIds.add(id);
  return id;
}

function clonedField(field: Field, id: string, name = field.name): Field {
  return {
    ...field,
    id,
    name,
    ...(field.config ? { config: structuredClone(field.config) } : {}),
  };
}

function duplicateDesignTarget(
  design: Design,
  target: SandboxInspectorTarget,
): { design: Design; selected: string } | null {
  const usedIds = new Set([
    ...design.departments.map((item) => item.id),
    ...design.modules.map((item) => item.id),
    ...design.modules.flatMap((item) => item.fields.map((field) => field.id)),
    ...design.relationships.map((item) => item.id),
    ...design.rules.map((item) => item.id),
  ]);
  if (target.kind === "department") {
    const source = design.departments.find((item) => item.id === target.id);
    if (!source) return null;
    const departmentId = nextId(usedIds);
    const sourceModules = design.modules.filter(
      (item) => item.department === source.id,
    );
    const copiedModules = sourceModules.map((moduleItem) => ({
      ...moduleItem,
      id: nextId(usedIds),
      department: departmentId,
      fields: moduleItem.fields.map((field) =>
        clonedField(field, nextId(usedIds)),
      ),
    }));
    const moduleIdMap = new Map(
      sourceModules.map((item, index) => [item.id, copiedModules[index].id]),
    );
    const sourceLayout = design.layout ?? compactDefaultLayout;
    const layout = { ...sourceLayout };
    const departmentBox = sourceLayout[source.id];
    if (departmentBox)
      layout[departmentId] = {
        ...departmentBox,
        x: departmentBox.x + 40,
        y: departmentBox.y + 40,
      };
    for (const sourceModule of sourceModules) {
      const copiedModuleId = moduleIdMap.get(sourceModule.id);
      const moduleBox = sourceLayout[sourceModule.id];
      if (copiedModuleId && moduleBox)
        layout[copiedModuleId] = {
          ...moduleBox,
          x: moduleBox.x + 40,
          y: moduleBox.y + 40,
        };
    }
    return {
      design: {
        ...design,
        departments: [
          ...design.departments,
          {
            ...source,
            id: departmentId,
            name: copiedName(
              source.name,
              design.departments.map((item) => item.name),
            ),
          },
        ],
        modules: [...design.modules, ...copiedModules],
        layout,
        // Relationships and rules intentionally remain attached to originals.
        // A structural copy therefore never introduces partial or dangling refs.
      },
      selected: departmentId,
    };
  }
  if (target.kind === "module") {
    const source = design.modules.find((item) => item.id === target.id);
    if (!source) return null;
    const moduleId = nextId(usedIds);
    const copiedModule = {
      ...source,
      id: moduleId,
      name: copiedName(
        source.name,
        design.modules
          .filter((item) => item.department === source.department)
          .map((item) => item.name),
      ),
      fields: source.fields.map((field) => clonedField(field, nextId(usedIds))),
    };
    const sourceLayout = design.layout ?? compactDefaultLayout;
    const sourceBox = sourceLayout[source.id];
    const index = design.modules.findIndex((item) => item.id === source.id);
    return {
      design: {
        ...design,
        modules: [
          ...design.modules.slice(0, index + 1),
          copiedModule,
          ...design.modules.slice(index + 1),
        ],
        ...(sourceBox
          ? {
              layout: {
                ...sourceLayout,
                [moduleId]: {
                  ...sourceBox,
                  x: sourceBox.x + 32,
                  y: sourceBox.y + 32,
                },
              },
            }
          : {}),
      },
      selected: moduleId,
    };
  }
  if (target.kind === "field") {
    const source = sampleField(design, target.id);
    if (!source) return null;
    const sourceModule = design.modules.find(
      (item) => item.id === source.moduleId,
    );
    if (!sourceModule) return null;
    const fieldId = nextId(usedIds);
    const field = clonedField(
      source.field,
      fieldId,
      copiedName(
        source.field.name,
        sourceModule.fields.map((item) => item.name),
      ),
    );
    return {
      design: {
        ...design,
        modules: design.modules.map((item) =>
          item.id === source.moduleId
            ? {
                ...item,
                fields: [
                  ...item.fields.slice(
                    0,
                    item.fields.findIndex(
                      (entry) => entry.id === source.field.id,
                    ) + 1,
                  ),
                  field,
                  ...item.fields.slice(
                    item.fields.findIndex(
                      (entry) => entry.id === source.field.id,
                    ) + 1,
                  ),
                ],
              }
            : item,
        ),
      },
      selected: canvasFieldId(source.moduleId, fieldId),
    };
  }
  return null;
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
    ) !== null
  );
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function joinedImpact(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

function affectedRuleReferences(
  design: Design,
  moduleIds: ReadonlySet<string>,
  fieldTargets: ReadonlySet<string>,
): number {
  let count = 0;
  for (const rule of design.rules) {
    const { config } = normalizeRule(rule, design);
    if (
      config.trigger.kind !== "schedule" &&
      (moduleIds.has(config.trigger.moduleId) ||
        ("fieldId" in config.trigger &&
          fieldTargets.has(
            canvasFieldId(config.trigger.moduleId, config.trigger.fieldId),
          )))
    )
      count += 1;
    if (
      config.condition.kind === "field-comparison" &&
      (moduleIds.has(config.condition.moduleId) ||
        fieldTargets.has(
          canvasFieldId(config.condition.moduleId, config.condition.fieldId),
        ))
    )
      count += 1;
    if (
      (config.action.kind === "create-record" ||
        config.action.kind === "update-field") &&
      (moduleIds.has(config.action.moduleId) ||
        fieldTargets.has(
          canvasFieldId(config.action.moduleId, config.action.fieldId),
        ))
    )
      count += 1;
  }
  return count;
}

function deletionImpact(
  design: Design,
  target: SandboxInspectorTarget | null,
): { title: string; detail: string } | null {
  if (!target) return null;
  if (target.kind === "link") {
    const relationship = design.relationships.find(
      (item) => item.id === target.id,
    );
    const name = relationship?.name || "Unnamed relationship";
    return {
      title: `Delete relationship ${name}?`,
      detail: `Deleting relationship “${name}” removes that exact relationship from both connected modules. Undo restores the complete change.`,
    };
  }
  if (target.kind === "field") {
    const match = sampleField(design, target.id);
    const name = match?.field.name ?? "Unknown field";
    const ruleReferences = affectedRuleReferences(
      design,
      new Set(),
      new Set(match ? [canvasFieldId(match.moduleId, match.field.id)] : []),
    );
    return {
      title: `Delete field ${name}?`,
      detail: `Deleting field “${name}” removes it from its module and invalidates ${plural(ruleReferences, "automation rule reference")}. Automation rules are retained and may become invalid. Undo restores the complete change.`,
    };
  }
  const moduleIds = new Set(
    design.modules
      .filter((item) =>
        target.kind === "department"
          ? item.department === target.id
          : item.id === target.id,
      )
      .map((item) => item.id),
  );
  const modules = design.modules.filter((item) => moduleIds.has(item.id));
  const fieldCount = modules.reduce(
    (total, item) => total + item.fields.length,
    0,
  );
  const fieldTargets = new Set(
    modules.flatMap((item) =>
      item.fields.map((field) => canvasFieldId(item.id, field.id)),
    ),
  );
  const relationships = design.relationships.filter(
    (item) => moduleIds.has(item.source) || moduleIds.has(item.target),
  ).length;
  const ruleReferences = affectedRuleReferences(
    design,
    moduleIds,
    fieldTargets,
  );
  const entity =
    target.kind === "department"
      ? design.departments.find((item) => item.id === target.id)
      : design.modules.find((item) => item.id === target.id);
  const name = entity?.name ?? `Unknown ${target.kind}`;
  const parts = [
    ...(target.kind === "department" ? [plural(modules.length, "module")] : []),
    plural(fieldCount, "field"),
    plural(relationships, "relationship"),
    plural(ruleReferences, "automation rule reference"),
  ];
  return {
    title: `Delete ${target.kind} ${name}?`,
    detail: `Deleting ${target.kind} “${name}” removes ${joinedImpact(parts)}. Automation rules are retained and may become invalid. Undo restores the complete change.`,
  };
}

function deletionTargetName(
  design: Design,
  target: SandboxInspectorTarget,
): string | null {
  if (target.kind === "department")
    return (
      design.departments.find((item) => item.id === target.id)?.name ?? null
    );
  if (target.kind === "module")
    return design.modules.find((item) => item.id === target.id)?.name ?? null;
  if (target.kind === "field")
    return sampleField(design, target.id)?.field.name ?? null;
  return (
    design.relationships.find((item) => item.id === target.id)?.name ?? null
  );
}

export function Designer({
  initialSelected,
  focusTargetId,
  design,
  change,
  initializeLayout,
  notify,
  onViewPreferenceChange,
  createRequest,
  onCreateRequestHandled,
}: {
  initialSelected: string;
  focusTargetId: string | null;
  design: Design;
  change: (d: DesignUpdate) => void;
  initializeLayout: (layout: SandboxCanvasLayout) => void;
  notify: (s: string) => void;
  onViewPreferenceChange: () => void;
  createRequest: SandboxCreateRequest | null;
  onCreateRequestHandled: (id: number) => void;
}) {
  const [viewPreferences, setViewPreferences] =
    useState<SandboxViewPreferences>(loadSandboxViewPreferences);
  const [pane, setPane] = useState<DesignerPane>(viewPreferences.mobilePane);
  const [wide, setWide] = useState(false);
  const structurePanelRef = useRef<PanelImperativeHandle>(null);
  const inspectorPanelRef = useRef<PanelImperativeHandle>(null);
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
      mobilePane: pane,
    });
  }, [canvasView.gridVisible, canvasView.snapEnabled, pane]);
  useEffect(() => {
    if (!wide) return;
    const preferences = viewPreferencesRef.current;
    structurePanelRef.current?.resize(
      preferences.structureCollapsed ? 48 : preferences.structureWidth,
    );
    inspectorPanelRef.current?.resize(
      preferences.inspectorCollapsed ? 48 : preferences.inspectorWidth,
    );
  }, [
    wide,
    viewPreferences.inspectorCollapsed,
    viewPreferences.structureCollapsed,
  ]);
  const structureSignature = JSON.stringify([
    design.departments.map((item) => item.id),
    design.modules.map((item) => [
      item.id,
      item.department,
      item.fields.map((field) => field.id),
    ]),
  ]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (graphRef.current) initializeLayout(graphRef.current.getLayout());
    });
    return () => cancelAnimationFrame(frame);
  }, [structureSignature, initializeLayout]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (canvasFrameRef.current?.clientWidth) graphRef.current?.fit();
    });
    return () => cancelAnimationFrame(frame);
  }, [pane]);
  function selectItem(id: string) {
    setSelected(id);
  }
  const [selected, setSelected] = useState(initialSelected);
  const [editor, setEditor] = useState("");
  const [editingRelationship, setEditingRelationship] = useState<string | null>(
    null,
  );
  const [name, setName] = useState("");
  const [type, setType] = useState("Text");
  const [required, setRequired] = useState(false);
  const [value, setValue] = useState("");
  const [options, setOptions] = useState("");
  const [target, setTarget] = useState("sample-equipment");
  const [source, setSource] = useState("sample-requests");
  const [cardinality, setCardinality] = useState("One-to-many");
  const [relationshipError, setRelationshipError] = useState("");
  const [editorError, setEditorError] = useState("");
  const handledCreateRequest = useRef<number | null>(null);
  const handledFocusTarget = useRef<string | null>(null);
  const selectedField = sampleField(design, selected);
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
    setPane("Inspector");
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
    const focusedField = sampleField(design, focusTargetId);
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
      createRequest.kind === "automation-rule" ||
      handledCreateRequest.current === createRequest.id
    )
      return;
    handledCreateRequest.current = createRequest.id;

    const requestedField = sampleField(design, selected);
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
    setPane("Inspector");

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
        requestAnimationFrame(() => graphRef.current?.fit());
        setCanvasAction("Canvas fitted.");
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

  function duplicateTarget(target: SandboxInspectorTarget): void {
    const result = duplicateDesignTarget(design, target);
    if (!result) return;
    change(result.design);
    setSelected(result.selected);
    notify(
      `${target.kind.charAt(0).toUpperCase()}${target.kind.slice(1)} duplicated. Undo restores the previous design.`,
    );
  }

  function toggleLifecycle(target: SandboxInspectorTarget): void {
    change((previous) => {
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
        const field = sampleField(previous, target.id);
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
  }
  function renameDepartment(id: string, nextName: string) {
    change((previous) => ({
      ...previous,
      departments: previous.departments.map((item) =>
        item.id === id ? { ...item, name: nextName } : item,
      ),
    }));
  }
  function renameModule(id: string, nextName: string) {
    change((previous) => ({
      ...previous,
      modules: previous.modules.map((item) =>
        item.id === id ? { ...item, name: nextName } : item,
      ),
    }));
  }
  function moveModule(id: string, departmentId: string) {
    change((previous) => ({
      ...previous,
      modules: previous.modules.map((item) =>
        item.id === id ? { ...item, department: departmentId } : item,
      ),
    }));
  }
  function addFromCanvas(
    kind: SandboxDropKind,
    parentId: string | null,
    fieldType: SandboxFieldType = "text",
    position?: { x: number; y: number },
  ) {
    const id = uid();
    if (kind === "department")
      change((previous) => ({
        ...previous,
        departments: [
          ...previous.departments,
          { id, name: "New department", closed: false },
        ],
      }));
    if (kind === "module" && parentId)
      change((previous) => ({
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
      }));
    if (kind === "field" && parentId)
      change((previous) => ({
        ...previous,
        modules: previous.modules.map((item) =>
          item.id === parentId
            ? {
                ...item,
                fields: [
                  ...item.fields,
                  {
                    id,
                    name: `${sampleTypes[fieldType]} field`,
                    type: sampleTypes[fieldType],
                    required: false,
                    value: "",
                    options: "",
                    closed: false,
                  },
                ],
              }
            : item,
        ),
      }));
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
  }
  function removeSelected() {
    if (!deleteTarget) return;
    const fallbackId =
      deleteTarget.kind === "module"
        ? design.modules.find((item) => item.id === deleteTarget.id)?.department
        : deleteTarget.kind === "field"
          ? sampleField(design, deleteTarget.id)?.moduleId
          : deleteTarget.kind === "link"
            ? design.relationships.find((item) => item.id === deleteTarget.id)
                ?.source
            : design.departments.find((item) => item.id !== deleteTarget.id)
                ?.id;
    deleteFallbackId.current = fallbackId ?? null;
    deleteOpener.current = null;
    change((previous) => {
      const field = sampleField(previous, deleteTarget.id);
      if (deleteTarget.kind === "field" && field)
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
        };
      if (deleteTarget.kind === "link")
        return {
          ...previous,
          relationships: previous.relationships.filter(
            (item) => item.id !== deleteTarget.id,
          ),
        };
      const removed = new Set(
        previous.modules
          .filter((item) =>
            deleteTarget.kind === "department"
              ? item.department === deleteTarget.id
              : item.id === deleteTarget.id,
          )
          .map((item) => item.id),
      );
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
    setDeleteTarget(null);
    setSelected(fallbackId ?? "");
    notify("Item deleted from sample design. Undo restores it.");
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
  const currentDeleteImpact = deletionImpact(design, deleteTarget);
  function open(kind: string) {
    setEditor(kind);
    setEditingRelationship(null);
    setPane("Inspector");
    setName(
      kind === "rename" ? (selectedModule?.name ?? department?.name ?? "") : "",
    );
    setType("Text");
    setRequired(false);
    setValue("");
    setOptions("");
    setRelationshipError("");
    setEditorError("");
    setSource(selectedModule?.id ?? design.modules[0]?.id ?? "");
  }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (editor === "department") {
      const id = uid();
      change({
        ...design,
        departments: [
          ...design.departments,
          { id, name: name.trim(), closed: false },
        ],
      });
      setSelected(id);
    }
    if (editor === "module" && department) {
      const id = uid();
      change({
        ...design,
        modules: [
          ...design.modules,
          {
            id,
            name: name.trim(),
            department: department.id,
            closed: false,
            fields: [],
            x: 0,
            y: 0,
          },
        ],
      });
      setSelected(id);
    }
    if (editor === "rename")
      change(
        selectedModule
          ? {
              ...design,
              modules: design.modules.map((m) =>
                m.id === selectedModule.id ? { ...m, name: name.trim() } : m,
              ),
            }
          : {
              ...design,
              departments: design.departments.map((d) =>
                d.id === department?.id ? { ...d, name: name.trim() } : d,
              ),
            },
      );
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
      change({
        ...design,
        modules: design.modules.map((m) =>
          m.id === selectedModule.id
            ? { ...m, fields: [...m.fields, result] }
            : m,
        ),
      });
    }
    if (editor === "relationship" && source && target) {
      if (source === target) {
        setRelationshipError("Source and target modules must be different.");
        return;
      }
      if (
        !design.modules.some((item) => item.id === source) ||
        !design.modules.some((item) => item.id === target)
      ) {
        setRelationshipError("Choose existing source and target modules.");
        return;
      }
      if (
        design.relationships.some(
          (item) =>
            item.id !== editingRelationship &&
            item.source === source &&
            item.target === target,
        )
      ) {
        setRelationshipError(
          "A relationship between these modules already exists.",
        );
        return;
      }
      change((previous) => ({
        ...previous,
        relationships: editingRelationship
          ? previous.relationships.map((item) =>
              item.id === editingRelationship
                ? { ...item, name: name.trim(), source, target, cardinality }
                : item,
            )
          : [
              ...previous.relationships,
              {
                id: uid(),
                name: name.trim(),
                source,
                target,
                cardinality,
              },
            ],
      }));
    }
    setEditor("");
    if (editor === "department" || editor === "module") setPane("Structure");
    notify(`${name.trim()} saved in the sample design.`);
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
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setRelationshipError("");
                }}
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
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setRelationshipError("");
                }}
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
                Cardinality
              </FieldLabel>
              <NativeSelect
                id="sandbox-editor-cardinality"
                className="w-full [&_select]:min-h-10"
                value={cardinality}
                onChange={(e) => setCardinality(e.target.value)}
              >
                {["One-to-one", "One-to-many", "Many-to-many"].map((c) => (
                  <NativeSelectOption key={c} value={c}>
                    {c}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormField>
            {design.modules.find((m) => m.id === target)?.department !==
              design.modules.find((m) => m.id === source)?.department && (
              <Alert role="alert" variant="warning">
                Cross-department relationship: review access for both
                departments. This is a sample connection.
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
        <Button type="submit">
          {editor === "rename"
            ? "Save name"
            : editingRelationship
              ? "Save relationship"
              : `Create ${editor}`}
        </Button>
        <Button
          type="button"
          variant="ghost"
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
  return (
    <Tabs
      className="gap-3 xl:min-h-0 xl:flex-1"
      value={pane}
      onValueChange={(value) => setPane(value as DesignerPane)}
    >
      <nav aria-label="Designer panes" className="xl:hidden">
        <TabsList className="grid w-full grid-cols-3">
          {(["Structure", "Canvas", "Inspector"] satisfies DesignerPane[]).map(
            (tab) => (
              <TabsTrigger key={tab} className="min-h-11" value={tab}>
                {tab}
              </TabsTrigger>
            ),
          )}
        </TabsList>
      </nav>
      <ResponsiveDesignerTabPanel wide={wide} pane={pane}>
        <ResizablePanelGroup
          orientation="horizontal"
          elementRef={panelGroupElementRef}
          className="sandbox-ui border-border bg-card overflow-hidden rounded-xl border [--canvas-grid-major:var(--input)] [--canvas-grid:var(--border)] max-xl:h-auto xl:h-full"
          onLayoutChanged={(layout, meta) => {
            if (!meta.isUserInteraction || !wide) return;
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
            const availableWidth = group.clientWidth - separatorWidth;
            const structureWidth =
              (availableWidth * (layout["sandbox-structure"] ?? 0)) / 100;
            const inspectorWidth =
              (availableWidth * (layout["sandbox-inspector"] ?? 0)) / 100;
            patchViewPreferences({
              ...(!viewPreferences.structureCollapsed && structureWidth
                ? { structureWidth: Math.round(structureWidth) }
                : {}),
              ...(!viewPreferences.inspectorCollapsed && inspectorWidth
                ? { inspectorWidth: Math.round(inspectorWidth) }
                : {}),
            });
          }}
        >
          {(wide || pane === "Structure") && (
            <ResizablePanel
              key="sandbox-structure"
              id="sandbox-structure"
              panelRef={structurePanelRef}
              defaultSize={wide ? viewPreferences.structureWidth : "100%"}
              minSize={
                wide
                  ? viewPreferences.structureCollapsed
                    ? 48
                    : SANDBOX_STRUCTURE_PANEL_MIN_WIDTH
                  : 0
              }
              maxSize={
                wide
                  ? viewPreferences.structureCollapsed
                    ? 48
                    : SANDBOX_STRUCTURE_PANEL_MAX_WIDTH
                  : "100%"
              }
              disabled={!wide || viewPreferences.structureCollapsed}
              groupResizeBehavior={
                wide ? "preserve-pixel-size" : "preserve-relative-size"
              }
              className="h-full w-full min-w-0"
            >
              {viewPreferences.structureCollapsed ? (
                <div className="hidden h-full min-h-0 items-start justify-center border-r pt-2 xl:flex">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Expand structure"
                    onClick={() => {
                      patchViewPreferences({ structureCollapsed: false });
                    }}
                  >
                    <span aria-hidden="true">›</span>
                  </Button>
                </div>
              ) : null}
              <aside
                tabIndex={-1}
                aria-label="Organization structure"
                className={cn(
                  "border-border h-full min-w-0 p-3 xl:min-h-0 xl:overflow-y-auto xl:border-r [&_section]:w-full [&_section]:min-w-0",
                  viewPreferences.structureCollapsed && "xl:hidden",
                )}
              >
                <div className="mb-2 hidden justify-end xl:flex">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Collapse structure"
                    onClick={() => {
                      patchViewPreferences({ structureCollapsed: true });
                    }}
                  >
                    Collapse
                  </Button>
                </div>
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
                    change((previous) =>
                      updateProjectedField(previous, id, patch),
                    )
                  }
                  onUpdateLinkLabel={(id, label) =>
                    change((previous) => ({
                      ...previous,
                      relationships: previous.relationships.map((item) =>
                        item.id === id ? { ...item, name: label } : item,
                      ),
                    }))
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
                    setType(sampleTypes[fieldType]);
                  }}
                  onMoveModule={moveModule}
                  onAddRelationship={() => {
                    setSelected(
                      selectedModule?.id ?? design.modules[0]?.id ?? "",
                    );
                    open("relationship");
                    setTarget(
                      design.modules.find(
                        (item) =>
                          item.id !==
                          (selectedModule?.id ?? design.modules[0]?.id),
                      )?.id ?? "",
                    );
                  }}
                />
                {selected ? (
                  <Button
                    className="mt-3 w-full xl:hidden"
                    variant="secondary"
                    onClick={() => {
                      setPane("Inspector");
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
            </ResizablePanel>
          )}
          {wide && (
            <ResizableHandle
              withHandle
              aria-label="Resize structure"
              disabled={viewPreferences.structureCollapsed}
            />
          )}
          {(wide || pane === "Canvas") && (
            <ResizablePanel
              key="sandbox-canvas"
              id="sandbox-canvas"
              defaultSize={wide ? undefined : "100%"}
              minSize={wide ? 200 : 0}
              maxSize="100%"
              disabled={!wide}
              groupResizeBehavior="preserve-relative-size"
              onResize={(size, _id, previousSize) => {
                if (
                  size.inPixels <= 0 ||
                  (previousSize !== undefined && previousSize.inPixels > 0)
                )
                  return;
                requestAnimationFrame(() => graphRef.current?.fit());
              }}
              className="h-full w-full min-w-0"
            >
              <div className="border-border flex h-full min-h-0 min-w-0 flex-col xl:border-r">
                <div className="flex flex-nowrap items-center justify-between gap-2 border-b px-4 py-2">
                  <span className="text-muted-foreground text-xs">
                    DESIGN CANVAS
                  </span>
                  <div
                    role="toolbar"
                    aria-label="Canvas view controls"
                    className="flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-x-auto [&>button]:shrink-0"
                  >
                    <Button
                      size="icon"
                      className="size-11"
                      variant="ghost"
                      aria-label="Zoom out"
                      onClick={() => graphRef.current?.zoomOut()}
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
                      className="size-11"
                      variant="ghost"
                      aria-label="Zoom in"
                      onClick={() => graphRef.current?.zoomIn()}
                    >
                      <ZoomIn aria-hidden="true" />
                    </Button>
                    <Button
                      size="sm"
                      className="min-h-11"
                      variant="outline"
                      aria-label="Fit canvas"
                      onClick={() => {
                        graphRef.current?.fit();
                        setCanvasAction("Canvas fitted.");
                      }}
                    >
                      <Maximize2 aria-hidden="true" />
                      Fit
                    </Button>
                    <Button
                      size="sm"
                      className="min-h-11"
                      variant="outline"
                      aria-label="Center canvas"
                      onClick={() => {
                        graphRef.current?.center();
                        setCanvasAction("Canvas centered.");
                      }}
                    >
                      <LocateFixed aria-hidden="true" />
                      Center
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
                          onClick={() => {
                            change((previous) => ({
                              ...previous,
                              layout: arrangedLayout(previous),
                            }));
                            setCanvasAction("Canvas automatically arranged.");
                          }}
                        >
                          Auto-arrange
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
                          onClick={() => {
                            change((previous) => ({
                              ...previous,
                              layout: resetLayout(previous),
                            }));
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
                <div
                  ref={canvasFrameRef}
                  className="h-[420px] overflow-hidden xl:h-auto xl:min-h-0 xl:flex-1"
                  aria-label="Module design canvas"
                >
                  <SandboxCanvas
                    state={projected}
                    layout={design.layout ?? compactDefaultLayout}
                    graphRef={graphRef}
                    gridVisible={canvasView.gridVisible}
                    snapEnabled={canvasView.snapEnabled}
                    onViewChange={setCanvasView}
                    onSelect={(id) => setSelected(id ?? "")}
                    onRenameDepartment={renameDepartment}
                    onRenameModule={renameModule}
                    onUpdateField={(id, patch) =>
                      change((previous) =>
                        updateProjectedField(previous, id, patch),
                      )
                    }
                    onDrop={addFromCanvas}
                    onConnect={connectModules}
                    onMove={(id, parentId) => {
                      if (parentId)
                        pendingMove.current = { id, department: parentId };
                    }}
                    onLayoutChange={(layout) => {
                      const moved = pendingMove.current;
                      pendingMove.current = null;
                      change((previous) => ({
                        ...previous,
                        layout,
                        modules: moved
                          ? previous.modules.map((item) =>
                              item.id === moved.id
                                ? { ...item, department: moved.department }
                                : item,
                            )
                          : previous.modules,
                      }));
                    }}
                  />
                </div>
              </div>
            </ResizablePanel>
          )}
          {wide && (
            <ResizableHandle
              withHandle
              aria-label="Resize inspector"
              disabled={viewPreferences.inspectorCollapsed}
            />
          )}
          {(wide || pane === "Inspector") && (
            <ResizablePanel
              key="sandbox-inspector"
              id="sandbox-inspector"
              panelRef={inspectorPanelRef}
              defaultSize={wide ? viewPreferences.inspectorWidth : "100%"}
              minSize={
                wide
                  ? viewPreferences.inspectorCollapsed
                    ? 48
                    : SANDBOX_INSPECTOR_PANEL_MIN_WIDTH
                  : 0
              }
              maxSize={
                wide
                  ? viewPreferences.inspectorCollapsed
                    ? 48
                    : SANDBOX_INSPECTOR_PANEL_MAX_WIDTH
                  : "100%"
              }
              disabled={!wide || viewPreferences.inspectorCollapsed}
              groupResizeBehavior={
                wide ? "preserve-pixel-size" : "preserve-relative-size"
              }
              className="h-full w-full min-w-0"
            >
              {viewPreferences.inspectorCollapsed ? (
                <div className="hidden h-full min-h-0 items-start justify-center pt-2 xl:flex">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Expand inspector"
                    onClick={() => {
                      patchViewPreferences({ inspectorCollapsed: false });
                    }}
                  >
                    <span aria-hidden="true">‹</span>
                  </Button>
                </div>
              ) : null}
              <aside
                aria-label="Design inspector"
                className={cn(
                  "flex h-full flex-col gap-5 p-5 xl:min-h-0 xl:overflow-y-auto",
                  viewPreferences.inspectorCollapsed && "xl:hidden",
                )}
              >
                <div className="hidden justify-end xl:flex">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Collapse inspector"
                    onClick={() => {
                      patchViewPreferences({ inspectorCollapsed: true });
                    }}
                  >
                    Collapse
                  </Button>
                </div>
                <Button
                  className="xl:hidden"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPane("Structure")}
                >
                  Back to structure
                </Button>
                <div>
                  <p className="text-muted-foreground text-xs">
                    {selectedModule ? "MODULE" : "DEPARTMENT"}
                  </p>
                  <h2 className="mt-1 text-lg font-semibold">
                    {selectedModule?.name ??
                      department?.name ??
                      "Start your structure"}
                  </h2>
                </div>
                {editor && editor !== "relationship" ? (
                  editorForm
                ) : (
                  <>
                    <ButtonGroup
                      aria-label={`${selectedModule ? "Module" : "Department"} actions`}
                      orientation={wide ? "horizontal" : "vertical"}
                      className="w-full [&>button]:flex-1"
                    >
                      <Button
                        data-sandbox-inspector-primary
                        variant="outline"
                        onClick={() => open("rename")}
                      >
                        Rename {selectedModule ? "module" : "department"}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          if (selectedModule)
                            change({
                              ...design,
                              modules: design.modules.map((m) =>
                                m.id === selectedModule.id
                                  ? { ...m, closed: !m.closed }
                                  : m,
                              ),
                            });
                          else if (department)
                            change({
                              ...design,
                              departments: design.departments.map((d) =>
                                d.id === department.id
                                  ? { ...d, closed: !d.closed }
                                  : d,
                              ),
                            });
                        }}
                      >
                        {(selectedModule ?? department)?.closed
                          ? "Reopen"
                          : "Close"}{" "}
                        {selectedModule ? "module" : "department"}
                      </Button>
                      <Button variant="outline" onClick={() => open("module")}>
                        Add module
                      </Button>
                    </ButtonGroup>
                    {!selectedModule && department ? (
                      <div className="border-border flex flex-col gap-2 border-t pt-4">
                        <h3 className="text-xs font-semibold uppercase">
                          Department order
                        </h3>
                        <ButtonGroup aria-label="Department order">
                          {(() => {
                            const index = design.departments.findIndex(
                              (item) => item.id === department.id,
                            );
                            return (
                              <>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  aria-label="Move department earlier"
                                  disabled={index === 0}
                                  onClick={() =>
                                    change((previous) => ({
                                      ...previous,
                                      departments: reorder(
                                        previous.departments,
                                        index,
                                        -1,
                                      ),
                                    }))
                                  }
                                >
                                  Earlier
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  aria-label="Move department later"
                                  disabled={
                                    index === design.departments.length - 1
                                  }
                                  onClick={() =>
                                    change((previous) => ({
                                      ...previous,
                                      departments: reorder(
                                        previous.departments,
                                        index,
                                        1,
                                      ),
                                    }))
                                  }
                                >
                                  Later
                                </Button>
                              </>
                            );
                          })()}
                        </ButtonGroup>
                      </div>
                    ) : null}
                    {selectedModule && (
                      <>
                        <div className="border-border flex flex-col gap-2 border-t pt-4">
                          <h3 className="text-xs font-semibold uppercase">
                            Module order
                          </h3>
                          <ButtonGroup aria-label="Module order">
                            {(() => {
                              const siblings = design.modules.filter(
                                (item) =>
                                  item.department === selectedModule.department,
                              );
                              const scopedIndex = siblings.findIndex(
                                (item) => item.id === selectedModule.id,
                              );
                              const move = (delta: number) => {
                                const reordered = reorder(
                                  siblings,
                                  scopedIndex,
                                  delta,
                                );
                                change((previous) => {
                                  let cursor = 0;
                                  return {
                                    ...previous,
                                    modules: previous.modules.map((item) =>
                                      item.department ===
                                      selectedModule.department
                                        ? reordered[cursor++]
                                        : item,
                                    ),
                                  };
                                });
                              };
                              return (
                                <>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label="Move module earlier"
                                    disabled={scopedIndex === 0}
                                    onClick={() => move(-1)}
                                  >
                                    Earlier
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label="Move module later"
                                    disabled={
                                      scopedIndex === siblings.length - 1
                                    }
                                    onClick={() => move(1)}
                                  >
                                    Later
                                  </Button>
                                </>
                              );
                            })()}
                          </ButtonGroup>
                          <FormField>
                            <FieldLabel htmlFor="sandbox-move-module-department">
                              Move module to department
                            </FieldLabel>
                            <NativeSelect
                              id="sandbox-move-module-department"
                              className="w-full [&_select]:min-h-10"
                              value={selectedModule.department}
                              onChange={(event) =>
                                moveModule(
                                  selectedModule.id,
                                  event.target.value,
                                )
                              }
                            >
                              {design.departments.map((item) => (
                                <NativeSelectOption
                                  key={item.id}
                                  value={item.id}
                                >
                                  {item.name}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                          </FormField>
                        </div>
                        <div className="border-border flex flex-col gap-3 border-t pt-4">
                          <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold">Fields</h3>
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
                                  change((previous) => ({
                                    ...previous,
                                    modules: previous.modules.map((item) =>
                                      item.id === selectedModule.id
                                        ? {
                                            ...item,
                                            fields: item.fields.map((entry) =>
                                              entry.id === f.id
                                                ? nextField
                                                : entry,
                                            ),
                                          }
                                        : item,
                                    ),
                                  }))
                                }
                                onMove={(delta) =>
                                  change((previous) => ({
                                    ...previous,
                                    modules: previous.modules.map((item) =>
                                      item.id === selectedModule.id
                                        ? {
                                            ...item,
                                            fields: reorder(
                                              item.fields,
                                              i,
                                              delta,
                                            ),
                                          }
                                        : item,
                                    ),
                                  }))
                                }
                                onLifecycle={() =>
                                  change((previous) => ({
                                    ...previous,
                                    modules: previous.modules.map((item) =>
                                      item.id === selectedModule.id
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
                                  }))
                                }
                                autoFocus={
                                  focusTargetId ===
                                  canvasFieldId(selectedModule.id, f.id)
                                }
                              />
                            </FieldDisclosure>
                          ))}
                        </div>
                        <div className="border-border flex flex-col gap-3 border-t pt-4">
                          <h3 className="text-sm font-semibold">
                            Relationships
                          </h3>
                          <Button
                            variant="outline"
                            onClick={() => {
                              open("relationship");
                              setSource(selectedModule.id);
                              setTarget(
                                design.modules.find(
                                  (m) => m.id !== selectedModule.id,
                                )?.id ?? "",
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
                                <EmptyTitle>
                                  No outgoing relationships
                                </EmptyTitle>
                                <EmptyDescription>
                                  Connect this module to another module to add
                                  one.
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
                                  {
                                    design.modules.find(
                                      (m) => m.id === r.target,
                                    )?.name
                                  }
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
                                <EmptyTitle>
                                  No incoming relationships
                                </EmptyTitle>
                                <EmptyDescription>
                                  Other modules have not connected to this
                                  module yet.
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
                                  {design.modules.find((m) => m.id === r.source)
                                    ?.name ?? "Missing source"}{" "}
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
            </ResizablePanel>
          )}
        </ResizablePanelGroup>
      </ResponsiveDesignerTabPanel>
      <Dialog
        open={editor === "relationship"}
        onOpenChange={(open) => {
          if (!open) setEditor("");
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
          if (!open) setDeleteTarget(null);
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
            <Button variant="destructive" onClick={removeSelected}>
              Confirm delete
            </Button>
            <AlertDialogCancel render={<Button variant="ghost" />}>
              Cancel
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Tabs>
  );
}
